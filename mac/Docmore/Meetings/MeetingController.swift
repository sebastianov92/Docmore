import AppKit
import SwiftUI

/// One recording at a time: start, show the floating panel, stop, transcribe
/// on the device, queue the transcript for the server and tell the page when
/// the notes are in.
@MainActor
final class MeetingController: ObservableObject {
    static let shared = MeetingController()

    enum Phase: Equatable {
        case idle
        case recording
        /// Stopped; the model downloads or the audio is being transcribed.
        case finishing
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var level: Float = 0
    @Published private(set) var liveText = ""
    @Published private(set) var notices: [String] = []
    @Published private(set) var statusLine = ""
    @Published private(set) var progress: Double?
    @Published private(set) var queued = 0

    let engine: MeetingEngine
    private var target: MeetingDestination?
    private var startedAt: Date?
    private var ticker: Timer?
    private var panel: NSPanel?
    private var flushing = false
    private var recovering = false
    private var services: Services { .shared }

    private init() {
        engine = MeetingEngineFactory.make()
        engine.onDelivered = { [weak self] job in
            self?.delivered(job)
        }
    }

    var isRecording: Bool { phase == .recording }

    /// What `meeting.state` answers and what the `meeting.state` event carries.
    var statePayload: [String: Any] {
        ["recording": isRecording, "elapsed": Int(elapsed.rounded()), "queued": queued]
    }

    // MARK: Start and stop

    func start(profileId: String, pageId: String?, spaceId: String?, title: String?) async throws {
        guard engine.isAvailable else { throw MeetingEngineError(message: engine.unavailableReason) }
        guard phase == .idle else { throw MeetingEngineError(message: L("A recording is already under way")) }
        guard let profile = services.profiles.profile(id: profileId) else {
            throw MeetingEngineError(message: L("This account needs to sign in again"))
        }
        let settings = services.settings
        guard settings.meetingMicrophone || settings.meetingSystemAudio else {
            throw MeetingEngineError(message: L("Turn on the microphone or the system audio in Settings > Meetings"))
        }
        // a recording with no page goes to the workspace's default space
        target = MeetingDestination(
            profileId: profileId,
            pageId: pageId,
            spaceId: pageId == nil ? (spaceId ?? profile.defaultSpaceId) : spaceId,
            title: title
        )
        liveText = ""
        notices = []
        statusLine = ""
        progress = nil
        level = 0
        elapsed = 0

        // the destination is written next to the audio, so a recording that
        // could not be finished (a crash, no model yet) is finished later
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyyMMdd-HHmmss"
        let fileName = "meeting-\(stamp.string(from: Date())).wav"
        if let target { writeSidecar(for: fileName, target: target) }

        let warnings: [String]
        do {
            warnings = try await startCapture(fileName: fileName, settings: settings)
        } catch {
            removeSidecar(for: fileName)
            self.target = nil
            throw error
        }
        notices = warnings
        if !engine.isDownloaded(settings.meetingModel) {
            notices.append(L("The transcript appears when the recording ends: the model is still downloading."))
            prepareModelInBackground(settings.meetingModel)
        }
        phase = .recording
        startedAt = Date()
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        showPanel()
        announceState()
    }

    private func startCapture(fileName: String, settings: AppSettings) async throws -> [String] {
        try await engine.startRecording(
            fileName: fileName,
            microphone: settings.meetingMicrophone,
            systemAudio: settings.meetingSystemAudio,
            modelId: settings.meetingModel,
            language: settings.meetingLanguage,
            onLevel: { [weak self] value in
                Task { @MainActor in self?.level = value }
            },
            onLiveText: { [weak self] text in
                Task { @MainActor in self?.appendLive(text) }
            },
            onFailure: { [weak self] message in
                Task { @MainActor in
                    guard let self, self.phase == .recording else { return }
                    self.notices.append(message)
                    // what was written is kept: finish with it
                    await self.stop()
                }
            }
        )
    }

    // MARK: Recordings waiting to be finished

    private struct Sidecar: Codable {
        var profileId: String
        var pageId: String?
        var spaceId: String?
        var title: String?
    }

    private func sidecarURL(for fileName: String) -> URL {
        engine.recordingsDirectory.appendingPathComponent(fileName + ".json")
    }

    private func writeSidecar(for fileName: String, target: MeetingDestination) {
        let sidecar = Sidecar(profileId: target.profileId, pageId: target.pageId, spaceId: target.spaceId, title: target.title)
        if let data = try? JSONEncoder().encode(sidecar) {
            try? AtomicFile.write(data, to: sidecarURL(for: fileName))
        }
    }

    private func removeSidecar(for fileName: String) {
        try? FileManager.default.removeItem(at: sidecarURL(for: fileName))
    }

    /// Recordings whose transcript never reached the queue: the app quit or
    /// crashed, or the model could not be downloaded at the time. Called at
    /// launch and when a server becomes reachable.
    func finishInterruptedRecordings() {
        guard engine.isAvailable, phase == .idle, !recovering else { return }
        let directory = engine.recordingsDirectory
        let sidecars = ((try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasSuffix(".wav.json") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        guard !sidecars.isEmpty else { return }
        recovering = true
        Task { @MainActor in
            defer { recovering = false }
            for sidecarFile in sidecars {
                guard phase == .idle else { return }
                let audio = sidecarFile.deletingPathExtension()
                guard FileManager.default.fileExists(atPath: audio.path),
                      let data = try? Data(contentsOf: sidecarFile),
                      let sidecar = try? JSONDecoder().decode(Sidecar.self, from: data),
                      services.profiles.profile(id: sidecar.profileId) != nil else {
                    // nothing to finish: the audio or its account is gone
                    try? FileManager.default.removeItem(at: sidecarFile)
                    continue
                }
                engine.repairRecording(at: audio)
                let target = MeetingDestination(profileId: sidecar.profileId, pageId: sidecar.pageId, spaceId: sidecar.spaceId, title: sidecar.title)
                do {
                    let result = try await finish(file: audio, target: target, keepAudio: true)
                    try? FileManager.default.removeItem(at: sidecarFile)
                    if result.jobId == nil { try? FileManager.default.removeItem(at: audio) }
                } catch {
                    // still not possible (no model, for example): next time
                    statusLine = ""
                    progress = nil
                    return
                }
            }
            statusLine = ""
        }
    }

    private func tick() {
        guard phase == .recording, let startedAt else { return }
        let before = Int(elapsed)
        elapsed = Date().timeIntervalSince(startedAt)
        if Int(elapsed) != before { announceState() }
    }

    private func appendLive(_ text: String) {
        let piece = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !piece.isEmpty else { return }
        liveText = liveText.isEmpty ? piece : liveText + " " + piece
    }

    private func prepareModelInBackground(_ modelId: String) {
        Task { @MainActor in
            try? await engine.download(modelId) { _ in }
        }
    }

    /// Stops the recording and carries it through to the queue.
    func stop() async {
        guard phase == .recording, let target else { return }
        phase = .finishing
        ticker?.invalidate()
        ticker = nil
        level = 0
        statusLine = L("Saving the recording")
        announceState()
        var recorded: URL?
        do {
            let recording = try await engine.stopRecording()
            recorded = recording.fileURL
            notices.append(contentsOf: recording.warnings.filter { !notices.contains($0) })
            let title = target.title ?? defaultTitle()
            let finalTarget = MeetingDestination(profileId: target.profileId, pageId: target.pageId, spaceId: target.spaceId, title: title)
            // the title chosen now is what a later attempt uses too
            writeSidecar(for: recording.fileURL.lastPathComponent, target: finalTarget)
            let result = try await finish(file: recording.fileURL, target: finalTarget, keepAudio: true)
            removeSidecar(for: recording.fileURL.lastPathComponent)
            if result.jobId == nil { try? FileManager.default.removeItem(at: recording.fileURL) }
        } catch {
            // with the audio on disk nothing is lost: it is finished later
            services.notifications.post(
                title: recorded == nil ? L("The meeting could not be saved") : L("The recording is kept on this Mac"),
                body: recorded == nil ? error.localizedDescription : L("It will be transcribed and sent later: %@", error.localizedDescription),
                profileId: target.profileId,
                path: nil,
                kind: recorded == nil ? "meeting-failed" : "meeting-kept"
            )
        }
        self.target = nil
        phase = .idle
        statusLine = ""
        progress = nil
        closePanel()
        await refreshQueued()
        announceState()
    }

    private func defaultTitle() -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return L("Meeting %@", formatter.string(from: startedAt ?? Date()))
    }

    /// Model, transcription, queue. Shared by a real recording and by the
    /// automation endpoint that feeds a WAV.
    @discardableResult
    private func finish(file: URL, target: MeetingDestination, keepAudio: Bool, modelOverride: String? = nil) async throws -> (jobId: String?, transcript: MeetingTranscriptData) {
        let settings = services.settings
        let modelId = modelOverride ?? settings.meetingModel
        if !engine.isDownloaded(modelId) {
            statusLine = L("Downloading the transcription model")
            progress = 0
            try await engine.download(modelId) { [weak self] fraction in
                Task { @MainActor in self?.progress = fraction }
            }
        }
        statusLine = L("Transcribing on this Mac")
        progress = 0
        let transcript = try await engine.transcribe(file: file, modelId: modelId, language: settings.meetingLanguage) { [weak self] fraction in
            Task { @MainActor in self?.progress = fraction }
        }
        progress = nil
        guard !transcript.isEmpty else {
            services.notifications.post(
                title: L("Nothing to write down"),
                body: L("The recording had no speech, so no notes were made."),
                profileId: target.profileId,
                path: nil,
                kind: "meeting-empty"
            )
            return (nil, transcript)
        }
        statusLine = L("Sending the transcript")
        let jobId = try await engine.enqueue(target: target, transcript: transcript, audio: keepAudio ? file : nil)
        await refreshQueued()
        flushQueue()
        return (jobId, transcript)
    }

    // MARK: Queue

    func resumePendingJobs() {
        Task { @MainActor in
            await refreshQueued()
            flushQueue()
            finishInterruptedRecordings()
        }
    }

    /// Sends waiting transcripts. Called after a recording, at launch and
    /// whenever a server becomes reachable.
    func flushQueue() {
        guard engine.isAvailable, !flushing else { return }
        flushing = true
        Task { @MainActor in
            await engine.flush()
            flushing = false
            await refreshQueued()
            announceState()
        }
    }

    func settle() async {
        for _ in 0..<600 where flushing {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    private func refreshQueued() async {
        queued = await engine.jobs().filter { $0.state != "sent" }.count
    }

    func accountRemoved(_ profileId: String) {
        if target?.profileId == profileId, phase == .recording {
            Task { @MainActor in
                await engine.cancelRecording()
                phase = .idle
                closePanel()
            }
        }
        Task { @MainActor in
            await engine.removeJobs(profileId: profileId)
            await refreshQueued()
        }
    }

    /// The server took the transcript and is writing the notes.
    private func delivered(_ job: MeetingJobInfo) {
        Task { @MainActor in
            await refreshQueued()
            announceState()
            guard let session = services.session(for: job.profileId) else { return }
            var pageId = job.pageId
            var failure: String?
            if let meetingId = job.meetingId {
                let outcome = await waitForNotes(meetingId: meetingId, session: session)
                pageId = outcome.pageId ?? pageId
                if outcome.status == "failed" { failure = outcome.error ?? "" }
            }
            if let failure {
                services.notifications.post(
                    title: L("The meeting notes could not be written"),
                    body: failure.isEmpty ? (job.title ?? "") : failure,
                    profileId: job.profileId,
                    path: pageId.map { "/p/\($0)" },
                    kind: "meeting-failed"
                )
                return
            }
            var payload: [String: Any] = [:]
            if let pageId { payload["pageId"] = pageId }
            session.emit("meeting.done", payload)
            services.notifications.post(
                title: L("Meeting notes are ready"),
                body: job.title ?? L("The notes of your meeting are on the page."),
                profileId: job.profileId,
                path: pageId.map { "/p/\($0)" },
                kind: "meeting-done"
            )
        }
    }

    /// The notes are written by a model on the server: wait for them (a few
    /// minutes at most) so `meeting.done` means the page has changed, and to
    /// learn which page got them when the server had to create one.
    private func waitForNotes(meetingId: String, session: ProfileSession) async -> (status: String, pageId: String?, error: String?) {
        var last: (status: String, pageId: String?, error: String?) = ("", nil, nil)
        for _ in 0..<120 {
            if let answer = try? await session.api.json("POST", "/api/ai/meetings/status", ["meetingId": meetingId], timeout: 15),
               let object = answer as? [String: Any] {
                last = (object["status"] as? String ?? "", object["pageId"] as? String, object["error"] as? String)
                if last.status == "done" || last.status == "failed" { return last }
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
        return last
    }

    private func announceState() {
        for session in services.liveSessions {
            session.emit("meeting.state", statePayload)
        }
    }

    // MARK: Menu

    /// Account > Record Meeting / Stop Recording.
    func toggleFromMenu() {
        if isRecording {
            Task { @MainActor in await stop() }
        } else {
            startFromMenu()
        }
    }

    /// Lets the page choose where the notes go (the open page, or its space)
    /// when a page is up; otherwise records for the active account.
    func startFromMenu() {
        guard phase == .idle else { return }
        if let front = AppCoordinator.shared.frontBrowser, front.pageLoaded {
            front.sendCommand("record-meeting")
            return
        }
        guard let profile = AppCoordinator.shared.activeProfile else { return }
        Task { @MainActor in
            do {
                try await start(profileId: profile.id, pageId: nil, spaceId: profile.defaultSpaceId, title: nil)
            } catch {
                let alert = NSAlert()
                alert.alertStyle = .warning
                alert.messageText = L("The recording could not start")
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: L("OK"))
                alert.runModal()
            }
        }
    }

    // MARK: Panel

    private func showPanel() {
        if panel == nil {
            let created = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 340, height: 220),
                styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel, .utilityWindow],
                backing: .buffered,
                defer: false
            )
            created.title = L("Recording")
            created.titleVisibility = .hidden
            created.titlebarAppearsTransparent = true
            created.isFloatingPanel = true
            created.level = .floating
            created.hidesOnDeactivate = false
            created.isReleasedWhenClosed = false
            created.isMovableByWindowBackground = true
            created.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            created.tabbingMode = .disallowed
            created.contentViewController = NSHostingController(rootView: MeetingPanelView(controller: self))
            created.setContentSize(NSSize(width: 340, height: 220))
            if let screen = NSScreen.main {
                let frame = screen.visibleFrame
                created.setFrameOrigin(NSPoint(x: frame.maxX - 360, y: frame.maxY - 240))
            }
            panel = created
        }
        panel?.orderFrontRegardless()
    }

    private func closePanel() {
        panel?.orderOut(nil)
    }

    var isPanelVisible: Bool { panel?.isVisible ?? false }

    // MARK: Automation

    #if DEBUG
    /// Shows the panel with made-up values, so a scripted run can look at it
    /// without a microphone. Nothing is recorded.
    func previewPanel(_ show: Bool) {
        guard show else {
            phase = .idle
            elapsed = 0
            level = 0
            liveText = ""
            notices = []
            closePanel()
            return
        }
        guard phase == .idle else { return }
        phase = .recording
        elapsed = 75
        level = 0.55
        liveText = "Welcome everyone to the weekly sync. First, the deploy of the new homepage is done and live."
        notices = []
        showPanel()
    }
    #endif

    /// Pushes a WAV through the same path a recording takes after Stop:
    /// model, transcription on the device, queue, send.
    func processFile(path: String, target: MeetingDestination, model: String?) async throws -> [String: Any] {
        guard engine.isAvailable else { throw MeetingEngineError(message: engine.unavailableReason) }
        let file = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: file.path) else {
            throw MeetingEngineError(message: "no such file: \(path)")
        }
        let result = try await finish(file: file, target: target, keepAudio: false, modelOverride: model)
        statusLine = ""
        await settle()
        var answer: [String: Any] = [
            "transcript": result.transcript.text,
            "language": result.transcript.language ?? "",
            "durationSeconds": result.transcript.durationSeconds,
            "segments": result.transcript.segments.count,
            "jobs": await engine.jobs().map(\.json),
        ]
        if let jobId = result.jobId { answer["jobId"] = jobId }
        return answer
    }
}

/// The floating panel shown while a meeting is recorded.
struct MeetingPanelView: View {
    @ObservedObject var controller: MeetingController

    private var clock: String {
        let total = Int(controller.elapsed)
        return String(format: "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(controller.phase == .recording ? Color.red : Color.secondary)
                    .frame(width: 10, height: 10)
                Text(controller.phase == .recording ? L("Recording") : controller.statusLine)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Text(clock)
                    .font(.system(.title3, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            if controller.phase == .recording {
                LevelMeter(level: controller.level)
                    .frame(height: 8)
            } else if let progress = controller.progress {
                ProgressView(value: progress)
            } else {
                ProgressView().controlSize(.small)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    Text(controller.liveText.isEmpty ? L("What is said appears here.") : controller.liveText)
                        .font(.callout)
                        .foregroundStyle(controller.liveText.isEmpty ? .tertiary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .id("live")
                }
                .onChange(of: controller.liveText) { _, _ in
                    proxy.scrollTo("live", anchor: .bottom)
                }
            }
            .frame(maxHeight: .infinity)
            ForEach(controller.notices, id: \.self) { notice in
                Label(notice, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                Task { await controller.stop() }
            } label: {
                Label(L("Stop"), systemImage: "stop.fill")
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
            }
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(controller.phase != .recording)
        }
        .padding(.horizontal, 14)
        .padding(.top, 26)
        .padding(.bottom, 14)
        .frame(width: 340, height: 220)
    }
}

/// Input level as a bar, 0...1.
struct LevelMeter: View {
    let level: Float

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.10))
                Capsule()
                    .fill(level > 0.9 ? Color.red : Color.green)
                    .frame(width: max(4, geometry.size.width * CGFloat(min(1, max(0, level)))))
                    .animation(.linear(duration: 0.1), value: level)
            }
        }
    }
}
