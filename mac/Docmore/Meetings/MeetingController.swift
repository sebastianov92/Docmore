import AppKit
import SwiftUI

/// Level and clock of a recording. They change many times a second, so they
/// live apart from the controller: only the meter and the clock redraw.
@MainActor
final class MeetingMeter: ObservableObject {
    @Published var levels = MeetingLevels.silent
    @Published var elapsed: TimeInterval = 0
}

/// One recording at a time: ask what kind of meeting it is, start, show the
/// floating panel with the speakers and the list of agreements and tasks,
/// keep the server's copy of the meeting while it runs, stop, transcribe on
/// the device, queue the transcript for the server and tell the page when
/// the notes are in.
@MainActor
final class MeetingController: ObservableObject {
    static let shared = MeetingController()

    enum Phase: Equatable {
        case idle
        /// The panel asks what kind of meeting this is.
        case choosing
        case recording
        /// Stopped; the model downloads or the audio is being transcribed.
        case finishing
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var mode: MeetingMode = .virtual
    /// The labelled transcript, the speakers and the list, as shown.
    @Published private(set) var live = MeetingLiveState(mode: .virtual)
    @Published private(set) var turns: [MeetingTurn] = []
    @Published private(set) var listStatus: MeetingLiveSync.ListStatus = .building
    /// False while the meeting is not live on the server: nothing to edit.
    @Published private(set) var canEditList = false
    @Published private(set) var notices: [String] = []
    @Published private(set) var statusLine = ""
    @Published private(set) var progress: Double?
    @Published private(set) var queued = 0

    // The chooser
    @Published private(set) var preselectedMode: MeetingMode = .virtual
    /// The kind whose capture is starting (a card was clicked).
    @Published private(set) var startingMode: MeetingMode?
    @Published private(set) var chooserError: String?

    // What is open in the panel. Kept here so the automation server can open
    // the same editors a click opens.
    @Published var renamingSpeakerId: String?
    @Published var editingItemId: String?
    @Published var addingItem = false
    @Published var transcriptCollapsed = false
    @Published var listCollapsed = false
    @Published var confirmingDiscard = false

    let meter = MeetingMeter()
    let engine: MeetingEngine
    /// The engine of the recording under way when it is not the app's own
    /// (a scripted meeting of a DEBUG build).
    private var recordingEngine: MeetingEngine?
    private var activeEngine: MeetingEngine { recordingEngine ?? engine }

    private var target: MeetingDestination?
    private var pendingTarget: MeetingDestination?
    private var choiceTaken = false
    private var sync: MeetingLiveSync?
    private var sidecar: MeetingSidecar?
    private var audioURL: URL?
    private var feed: AsyncStream<MeetingLiveUpdate>.Continuation?
    private var feedTask: Task<Void, Never>?
    private var startedAt: Date?
    private var ticker: Timer?
    private var panel: MeetingPanel?
    private var flushing = false
    private var recovering = false
    private var services: Services { .shared }

    #if DEBUG
    /// Set by the automation server: the next recording plays this script.
    var scriptForNextRecording: ScriptedMeetingEngine.Options?
    /// Set by the automation server: the next recording takes its audio
    /// from this file, through the real engine.
    var replayForNextRecording: MeetingReplay?
    private var previewing = false
    #endif

    /// The transcripts the server took in this run, newest last (for the
    /// automation server: which meeting a job became).
    private(set) var deliveries: [MeetingJobInfo] = []

    /// The language of the app's own interface ("es", "en"): the server
    /// writes default labels, owners and headings in it.
    static var interfaceLocale: String {
        Bundle.main.preferredLocalizations.first ?? "en"
    }

    private init() {
        engine = MeetingEngineFactory.make()
        engine.onDelivered = { [weak self] job in
            self?.delivered(job)
        }
    }

    var isRecording: Bool { phase == .recording }

    /// What `meeting.state` answers and what the `meeting.state` event carries.
    var statePayload: [String: Any] {
        var payload: [String: Any] = [
            "recording": isRecording,
            "elapsed": Int(meter.elapsed.rounded()),
            "queued": queued,
            "choosing": phase == .choosing,
        ]
        if phase == .recording || phase == .finishing { payload["mode"] = mode.rawValue }
        return payload
    }

    // MARK: Start

    /// Starts a recording for an account. With a `mode` it starts at once
    /// (the web client or a test already knows the kind); without one the
    /// panel opens on the chooser and this returns while the person picks.
    func start(profileId: String, pageId: String?, spaceId: String?, title: String?, mode: MeetingMode? = nil) async throws {
        guard engine.isAvailable else { throw MeetingEngineError(message: engine.unavailableReason) }
        if phase == .choosing, mode == nil {
            // asked again while the chooser is up: bring it forward
            showPanel(activate: true)
            return
        }
        guard phase == .idle || phase == .choosing, startingMode == nil else {
            throw MeetingEngineError(message: L("A recording is already under way"))
        }
        guard let profile = services.profiles.profile(id: profileId) else {
            throw MeetingEngineError(message: L("This account needs to sign in again"))
        }
        // a recording with no page goes to the workspace's default space
        let destination = MeetingDestination(
            profileId: profileId,
            pageId: pageId,
            spaceId: pageId == nil ? (spaceId ?? profile.defaultSpaceId) : spaceId,
            title: title
        )
        if let mode {
            try await begin(destination, mode: mode)
            pendingTarget = nil
            return
        }
        pendingTarget = destination
        preselectedMode = services.settings.meetingMode
        chooserError = nil
        phase = .choosing
        showPanel(activate: true)
        announceState()
    }

    /// A card of the chooser was clicked: that kind is remembered for next
    /// time and the recording starts.
    func choose(_ mode: MeetingMode) {
        guard phase == .choosing, startingMode == nil, !choiceTaken, let destination = pendingTarget else { return }
        // a second click while the first one is being acted on does nothing
        choiceTaken = true
        preselectedMode = mode
        services.settings.meetingMode = mode
        SettingsModel.shared.meetingMode = mode
        chooserError = nil
        Task { @MainActor in
            defer { choiceTaken = false }
            do {
                try await begin(destination, mode: mode)
                pendingTarget = nil
            } catch {
                // the chooser stays, so the person can fix it and try again
                chooserError = error.localizedDescription
            }
        }
    }

    func cancelChoice() {
        guard phase == .choosing, startingMode == nil else { return }
        pendingTarget = nil
        chooserError = nil
        #if DEBUG
        scriptForNextRecording = nil
        replayForNextRecording = nil
        #endif
        phase = .idle
        closePanel()
        announceState()
    }

    private func defaultTitle(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return L("Meeting %@", formatter.string(from: date))
    }

    private func begin(_ destination: MeetingDestination, mode: MeetingMode) async throws {
        guard startingMode == nil else { throw MeetingEngineError(message: L("A recording is already under way")) }
        startingMode = mode
        defer { startingMode = nil }
        let settings = services.settings
        var target = destination
        if (target.title ?? "").trimmingCharacters(in: .whitespaces).isEmpty { target.title = defaultTitle(Date()) }
        var replay: MeetingReplay?
        #if DEBUG
        if let options = scriptForNextRecording {
            recordingEngine = ScriptedMeetingEngine(base: engine, options: options)
            scriptForNextRecording = nil
        }
        replay = replayForNextRecording
        replayForNextRecording = nil
        #endif
        let recorder = activeEngine

        // where the notes go, the kind of meeting and later the live meeting
        // and the names are written next to the audio, so a recording that
        // could not be finished (a crash, no model yet) is finished later
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyyMMdd-HHmmss"
        let fileName = "meeting-\(stamp.string(from: Date())).wav"
        let audio = recorder.recordingsDirectory.appendingPathComponent(fileName)
        let written = MeetingSidecar(profileId: target.profileId, pageId: target.pageId, spaceId: target.spaceId, title: target.title, mode: mode)
        written.write(forAudio: audio)
        audioURL = audio

        // what the engine reports is taken in the order it was said
        let (updates, feed) = AsyncStream.makeStream(of: MeetingLiveUpdate.self)
        let warnings: [String]
        do {
            warnings = try await recorder.startRecording(
                MeetingRecordingRequest(fileName: fileName, mode: mode, modelId: settings.meetingModel, language: settings.meetingLanguage, replay: replay),
                onLevel: { [weak self] levels in
                    Task { @MainActor in self?.meter.levels = levels }
                },
                onLive: { update in
                    feed.yield(update)
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
        } catch {
            feed.finish()
            MeetingSidecar.remove(forAudio: audio)
            audioURL = nil
            recordingEngine = nil
            throw error
        }

        self.target = target
        self.mode = mode
        sidecar = written
        self.feed = feed
        notices = warnings
        statusLine = ""
        progress = nil
        meter.levels = .silent
        meter.elapsed = 0
        closeEditors()
        let made = makeSync(target: target, mode: mode)
        sync = made
        live = made?.state ?? MeetingLiveState(mode: mode)
        turns = []
        listStatus = made?.listStatus ?? .atEnd
        canEditList = false
        feedTask = Task { @MainActor [weak self] in
            for await update in updates { self?.ingest(update) }
        }
        if !recorder.isDownloaded(settings.meetingModel) {
            notices.append(L("The transcript appears when the recording ends: the model is still downloading."))
            prepareModelInBackground(settings.meetingModel)
        }
        if recorder.speakerModel != nil, !recorder.isSpeakerModelDownloaded {
            // never fetched while a meeting is recorded: it downloads after Stop
            notices.append(L("Who said what appears when the recording ends: the speaker model is not on this Mac yet."))
        }
        phase = .recording
        startedAt = Date()
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        showPanel(activate: false)
        announceState()
        pumpSync()
    }

    // MARK: The live meeting on the server

    private func makeSync(target: MeetingDestination, mode: MeetingMode) -> MeetingLiveSync? {
        guard let session = services.session(for: target.profileId) else { return nil }
        let language = services.settings.meetingLanguage
        let made = MeetingLiveSync(
            mode: mode,
            target: MeetingLiveSync.Target(
                pageId: target.pageId,
                spaceId: target.spaceId,
                title: target.title,
                language: language == "auto" || language.isEmpty ? nil : language,
                locale: Self.interfaceLocale
            ),
            transport: MeetingServerTransport(api: session.api)
        )
        made.isOffline = { [weak session] in
            guard let session else { return true }
            if NetworkOverride.shared.forcedUnreachable { return true }
            // "Work Offline": an open page says it is offline while its
            // server answers. Nothing is sent until the person turns it off.
            let state = session.syncState
            return state.reported && !state.online && session.reachability.reachable && !session.openWebViews.isEmpty
        }
        made.elapsed = { [weak self] in self?.meter.elapsed ?? 0 }
        made.onChange = { [weak self] in self?.refreshLive() }
        made.onMeetingId = { [weak self] id in
            self?.updateSidecar { $0.meetingId = id }
        }
        made.onItemRenamed = { [weak self] provisional, id in
            if self?.editingItemId == provisional { self?.editingItemId = id }
        }
        return made
    }

    private func ingest(_ update: MeetingLiveUpdate) {
        guard let sync, phase == .recording || phase == .finishing else { return }
        let before = sync.state.speakers
        sync.ingest(update)
        if sync.state.speakers != before {
            updateSidecar { $0.speakers = sync.state.speakers }
        }
    }

    private func refreshLive() {
        guard let sync else { return }
        if live != sync.state {
            live = sync.state
            turns = live.turns
        }
        if listStatus != sync.listStatus { listStatus = sync.listStatus }
        if canEditList != sync.canEditList { canEditList = sync.canEditList }
    }

    private func pumpSync() {
        guard let sync else { return }
        Task { @MainActor in await sync.pump() }
    }

    private func updateSidecar(_ change: (inout MeetingSidecar) -> Void) {
        guard var current = sidecar, let audioURL else { return }
        change(&current)
        guard current != sidecar else { return }
        sidecar = current
        current.write(forAudio: audioURL)
    }

    // MARK: What the person does in the panel

    /// The name typed for a voice: on every line at once, in the file next
    /// to the audio, and on its way to the server.
    func rename(speakerId: String, to name: String?) {
        renamingSpeakerId = nil
        if let sync {
            sync.rename(speakerId: speakerId, to: name)
            // the engine carries it too: through a voice merged into another,
            // into the final transcript, and past a crash
            activeEngine.setSpeakerName(MeetingSpeaker.cleanName(name), for: speakerId)
            updateSidecar { $0.speakers = sync.state.speakers }
            pumpSync()
            return
        }
        #if DEBUG
        if previewing, live.rename(speakerId: speakerId, to: name) { turns = live.turns }
        #endif
    }

    /// An edit of the list made by hand. Returns false when there was
    /// nothing to do.
    @discardableResult
    func editItem(_ op: MeetingItemOp) -> Bool {
        if let sync {
            guard sync.edit(op) != nil else { return false }
            pumpSync()
            return true
        }
        #if DEBUG
        if previewing { return live.enqueue(op) != nil }
        #endif
        return false
    }

    func closeEditors() {
        renamingSpeakerId = nil
        editingItemId = nil
        addingItem = false
        confirmingDiscard = false
    }

    /// Escape in the panel.
    func escapePressed() {
        if phase == .choosing {
            cancelChoice()
        } else {
            closeEditors()
        }
    }

    // MARK: Recordings waiting to be finished

    /// Recordings whose transcript never reached the queue: the app quit or
    /// crashed, or the model could not be downloaded at the time. Called at
    /// launch and when a server becomes reachable.
    func finishInterruptedRecordings() {
        guard engine.isAvailable, phase == .idle, startingMode == nil, !recovering else { return }
        let sidecars = MeetingSidecar.all(in: engine.recordingsDirectory)
        guard !sidecars.isEmpty else { return }
        recovering = true
        Task { @MainActor in
            defer { recovering = false }
            for sidecarFile in sidecars {
                guard phase == .idle, startingMode == nil else { return }
                let audio = MeetingSidecar.audio(forSidecar: sidecarFile)
                // the recording being started right now is not an interrupted one
                if audio == audioURL { continue }
                guard FileManager.default.fileExists(atPath: audio.path),
                      let kept = MeetingSidecar.read(forAudio: audio),
                      services.profiles.profile(id: kept.profileId) != nil else {
                    // nothing to finish: the audio or its account is gone
                    try? FileManager.default.removeItem(at: sidecarFile)
                    continue
                }
                engine.repairRecording(at: audio)
                let target = MeetingDestination(profileId: kept.profileId, pageId: kept.pageId, spaceId: kept.spaceId, title: kept.title)
                do {
                    // the kind, the live meeting and the names typed before
                    // the interruption travel with the transcript
                    let result = try await finish(file: audio, target: target, mode: kept.mode, knownSpeakers: kept.speakers, engine: engine, keepAudio: true) { speakers in
                        MeetingDelivery(meetingId: kept.meetingId, mode: kept.mode, speakers: kept.named(speakers), locale: Self.interfaceLocale)
                    }
                    MeetingSidecar.remove(forAudio: audio)
                    if result.jobId == nil {
                        engine.removeRecording(at: audio)
                        await discardLiveMeeting(kept)
                    }
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

    /// A recording with nothing said leaves no notes: its live meeting goes too.
    private func discardLiveMeeting(_ kept: MeetingSidecar) async {
        guard let meetingId = kept.meetingId, let session = services.session(for: kept.profileId),
              let body = try? JSONSerialization.data(withJSONObject: ["meetingId": meetingId]) else { return }
        _ = try? await MeetingServerTransport(api: session.api).post(
            "live/discard", body: body, timeout: 15, idempotencyKey: "live-discard-" + meetingId
        )
    }

    private func tick() {
        guard phase == .recording, let startedAt else { return }
        let before = Int(meter.elapsed)
        meter.elapsed = Date().timeIntervalSince(startedAt)
        if Int(meter.elapsed) != before { announceState() }
        pumpSync()
    }

    private func prepareModelInBackground(_ modelId: String) {
        Task { @MainActor in
            try? await engine.download(modelId) { _ in }
        }
    }

    // MARK: Stop

    /// Stops the recording and carries it through to the queue.
    func stop() async {
        guard phase == .recording, let target else { return }
        phase = .finishing
        ticker?.invalidate()
        ticker = nil
        meter.levels = .silent
        confirmingDiscard = false
        statusLine = L("Saving the recording")
        announceState()
        let recorder = activeEngine
        let sync = self.sync
        let mode = self.mode
        // no more text goes to the live meeting: the transcript carries all
        // of it. Edits of the list still do, until the transcript is queued.
        sync?.stopUpdates()
        var recorded: URL?
        do {
            let recording = try await recorder.stopRecording()
            feed?.finish()
            recorded = recording.fileURL
            notices.append(contentsOf: recording.warnings.filter { !notices.contains($0) })
            let result = try await finish(
                file: recording.fileURL, target: target, mode: mode,
                knownSpeakers: sync?.state.speakers ?? [], engine: recorder, keepAudio: true
            ) { speakers in
                // the edits made by hand reach the server before the
                // transcript that ends the live meeting
                await sync?.flushEdits()
                sync?.close()
                return MeetingDelivery(
                    meetingId: sync?.meetingId, mode: mode,
                    speakers: sync?.state.named(speakers) ?? speakers, locale: Self.interfaceLocale
                )
            }
            // from here on nothing writes next to the audio again
            sidecar = nil
            MeetingSidecar.remove(forAudio: recording.fileURL)
            if result.jobId == nil {
                // nothing was said: no notes, and no live meeting left behind
                recorder.removeRecording(at: recording.fileURL)
                await sync?.discard()
            }
        } catch {
            sync?.close()
            // with the audio on disk nothing is lost: it is finished later
            services.notifications.post(
                title: recorded == nil ? L("The meeting could not be saved") : L("The recording is kept on this Mac"),
                body: recorded == nil ? error.localizedDescription : L("It will be transcribed and sent later: %@", error.localizedDescription),
                profileId: target.profileId,
                path: nil,
                kind: recorded == nil ? "meeting-failed" : "meeting-kept"
            )
        }
        await endRecording()
    }

    /// Throws the recording away: no file, no notes, no live meeting.
    func discardRecording() async {
        guard phase == .recording, target != nil else { return }
        phase = .finishing
        ticker?.invalidate()
        ticker = nil
        meter.levels = .silent
        statusLine = L("Discarding the recording")
        announceState()
        let recorder = activeEngine
        await recorder.cancelRecording()
        feed?.finish()
        sidecar = nil
        if let audioURL {
            MeetingSidecar.remove(forAudio: audioURL)
            recorder.removeRecording(at: audioURL)
        }
        await sync?.discard()
        await endRecording()
    }

    private func endRecording() async {
        target = nil
        sync = nil
        sidecar = nil
        audioURL = nil
        recordingEngine = nil
        feed = nil
        feedTask?.cancel()
        feedTask = nil
        phase = .idle
        statusLine = ""
        progress = nil
        closeEditors()
        closePanel()
        await refreshQueued()
        announceState()
    }

    /// Model, transcription, queue. Shared by a real recording, a recording
    /// finished later and the automation endpoint that feeds a WAV.
    /// `delivery` is asked right before the transcript is queued, with the
    /// speakers the transcript has.
    @discardableResult
    private func finish(
        file: URL,
        target: MeetingDestination,
        mode: MeetingMode,
        knownSpeakers: [MeetingSpeaker],
        engine: MeetingEngine,
        keepAudio: Bool,
        modelOverride: String? = nil,
        delivery: @MainActor ([MeetingSpeaker]) async -> MeetingDelivery
    ) async throws -> (jobId: String?, transcript: MeetingTranscriptData) {
        let settings = services.settings
        let modelId = modelOverride ?? settings.meetingModel
        if !engine.isDownloaded(modelId) {
            statusLine = L("Downloading the transcription model")
            progress = 0
            try await engine.download(modelId) { [weak self] fraction in
                Task { @MainActor in self?.progress = fraction }
            }
        }
        if engine.speakerModel != nil, !engine.isSpeakerModelDownloaded {
            statusLine = L("Downloading the speaker identification model")
            progress = 0
            // without it the transcript still comes, with no speakers
            try? await engine.downloadSpeakerModel { [weak self] fraction in
                Task { @MainActor in self?.progress = fraction }
            }
        }
        statusLine = L("Transcribing on this Mac")
        progress = 0
        let transcript = try await engine.transcribe(
            file: file, mode: mode, modelId: modelId, language: settings.meetingLanguage, knownSpeakers: knownSpeakers
        ) { [weak self] fraction in
            Task { @MainActor in self?.progress = fraction }
        }
        progress = nil
        if !transcript.notes.isEmpty {
            // what the engine has to say about this recording (its texts are English)
            services.notifications.post(
                title: L("About this recording"),
                body: transcript.notes.joined(separator: " "),
                profileId: target.profileId,
                path: nil,
                kind: "meeting-note"
            )
        }
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
        let meeting = await delivery(transcript.speakers)
        let jobId = try await engine.enqueue(target: target, transcript: transcript, meeting: meeting, audio: keepAudio ? file : nil)
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
        if pendingTarget?.profileId == profileId, phase == .choosing {
            cancelChoice()
        }
        if target?.profileId == profileId, phase == .recording {
            Task { @MainActor in
                phase = .finishing
                ticker?.invalidate()
                ticker = nil
                await activeEngine.cancelRecording()
                feed?.finish()
                // the sign-in is gone with the account: nothing to tell the server
                sync?.close()
                sidecar = nil
                if let audioURL { MeetingSidecar.remove(forAudio: audioURL) }
                await endRecording()
            }
        }
        Task { @MainActor in
            await engine.removeJobs(profileId: profileId)
            await refreshQueued()
        }
    }

    /// The server took the transcript and is writing the notes.
    private func delivered(_ job: MeetingJobInfo) {
        deliveries.append(job)
        if deliveries.count > 50 { deliveries.removeFirst(deliveries.count - 50) }
        Task { @MainActor in
            await refreshQueued()
            announceState()
            guard let session = services.session(for: job.profileId) else { return }
            var pageId = job.pageId
            var failure: String?
            var remark: String?
            if let meetingId = job.meetingId {
                let outcome = await waitForNotes(meetingId: meetingId, session: session)
                pageId = outcome.pageId ?? pageId
                if outcome.status == "failed" {
                    failure = outcome.error ?? ""
                } else if outcome.status == "done", let error = outcome.error, !error.isEmpty {
                    // written all the same (transcript and list), with something missing: the server says what
                    remark = error
                }
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
            if let meetingId = job.meetingId, !meetingId.isEmpty { payload["meetingId"] = meetingId }
            session.emit("meeting.done", payload)
            services.notifications.post(
                title: L("Meeting notes are ready"),
                body: remark ?? job.title ?? L("The notes of your meeting are on the page."),
                profileId: job.profileId,
                path: pageId.map { "/p/\($0)" },
                kind: "meeting-done"
            )
        }
    }

    /// The notes are written by a model on the server: wait for them so
    /// `meeting.done` means the page has changed, and to learn which page
    /// got them when the server had to create one. The server gives its
    /// model ten minutes and then writes the notes without a summary, so
    /// the wait is a little longer than that.
    private func waitForNotes(meetingId: String, session: ProfileSession) async -> (status: String, pageId: String?, error: String?) {
        var last: (status: String, pageId: String?, error: String?) = ("", nil, nil)
        for _ in 0..<260 {
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
    /// when a page is up; otherwise records for the active account. Either
    /// way the panel opens on the chooser.
    func startFromMenu() {
        if phase == .choosing {
            showPanel(activate: true)
            return
        }
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

    static let panelDefaultSize = NSSize(width: 440, height: 640)
    static let panelMinimumSize = NSSize(width: 360, height: 440)
    /// The chooser is a smaller, fixed window: two cards side by side.
    static let chooserSize = NSSize(width: 460, height: 400)

    private var panelShowsChooser = false

    private func showPanel(activate: Bool) {
        let wasVisible = panel?.isVisible ?? false
        if panel == nil {
            let created = MeetingPanel(
                contentRect: NSRect(origin: .zero, size: Self.panelDefaultSize),
                styleMask: [.titled, .resizable, .fullSizeContentView, .nonactivatingPanel, .utilityWindow],
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
            created.onEscape = { [weak self] in self?.escapePressed() }
            let hosting = NSHostingView(rootView: MeetingPanelView(controller: self))
            // the window decides the size, the content adapts to it
            hosting.sizingOptions = []
            created.contentView = hosting
            panel = created
        }
        layoutPanel(from: wasVisible ? panel?.frame : nil, animated: wasVisible)
        if activate {
            panel?.makeKeyAndOrderFront(nil)
        } else {
            panel?.orderFrontRegardless()
        }
    }

    /// Where the meeting panel goes: where the person left it, else the top
    /// right corner of the main screen.
    private func livePanelFrame(_ panel: NSPanel) -> NSRect {
        let saved = NSRectFromString(services.settings.meetingPanelFrame)
        if saved.width >= Self.panelMinimumSize.width, saved.height >= Self.panelMinimumSize.height,
           NSScreen.screens.contains(where: { $0.visibleFrame.intersects(saved) }) {
            return saved
        }
        var frame = panel.frameRect(forContentRect: NSRect(origin: .zero, size: Self.panelDefaultSize))
        if let screen = NSScreen.main {
            let visible = screen.visibleFrame
            frame.origin = NSPoint(x: visible.maxX - frame.width - 20, y: visible.maxY - frame.height - 20)
        }
        return frame
    }

    /// Sizes the panel for what it shows: the small fixed chooser, or the
    /// resizable meeting panel. Both keep the same top right corner, also
    /// when the person moved the chooser before picking (`current`).
    private func layoutPanel(from current: NSRect?, animated: Bool) {
        guard let panel else { return }
        let chooser = phase == .choosing
        var frame = livePanelFrame(panel)
        if chooser {
            panel.styleMask.remove(.resizable)
            panel.minimumContentSize = Self.chooserSize
            let size = panel.frameRect(forContentRect: NSRect(origin: .zero, size: Self.chooserSize)).size
            frame = NSRect(x: frame.maxX - size.width, y: frame.maxY - size.height, width: size.width, height: size.height)
        } else {
            panel.styleMask.insert(.resizable)
            panel.minimumContentSize = Self.panelMinimumSize
        }
        if let current, panelShowsChooser != chooser || chooser {
            frame.origin = NSPoint(x: current.maxX - frame.width, y: current.maxY - frame.height)
        } else if let current {
            frame = current
        }
        if let visible = (panel.screen ?? NSScreen.main)?.visibleFrame, frame.width <= visible.width, frame.height <= visible.height {
            frame.origin.x = min(max(frame.origin.x, visible.minX), visible.maxX - frame.width)
            frame.origin.y = min(max(frame.origin.y, visible.minY), visible.maxY - frame.height)
        }
        panelShowsChooser = chooser
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(button)?.isHidden = true
        }
        if panel.frame != frame {
            panel.setFrame(frame, display: true, animate: animated)
        }
    }

    private func closePanel() {
        guard let panel, panel.isVisible else { return }
        // where the person left the meeting panel is where it opens next time
        if !panelShowsChooser {
            services.settings.meetingPanelFrame = NSStringFromRect(panel.frame)
        }
        panel.orderOut(nil)
    }

    var isPanelVisible: Bool { panel?.isVisible ?? false }

    /// The panel takes typing (a name, an entry of the list).
    func focusPanel() {
        panel?.makeKey()
    }

    /// Pushes a WAV through the same path a recording takes after Stop:
    /// model, transcription on the device, queue, send.
    /// The kind is the one given, else the one the file itself tells (two
    /// channels are a virtual meeting). `names` are names for its speakers,
    /// by id, as if typed in the panel.
    func processFile(
        path: String, target: MeetingDestination, model: String?,
        mode: MeetingMode? = nil, names: [String: String] = [:]
    ) async throws -> [String: Any] {
        guard engine.isAvailable else { throw MeetingEngineError(message: engine.unavailableReason) }
        let file = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: file.path) else {
            throw MeetingEngineError(message: "no such file: \(path)")
        }
        let kind = mode ?? engine.recordedMode(of: file) ?? .inPerson
        var delivered: [MeetingSpeaker] = []
        let result = try await finish(
            file: file, target: target, mode: kind, knownSpeakers: [], engine: engine, keepAudio: false, modelOverride: model
        ) { speakers in
            delivered = speakers.map { speaker in
                var copy = speaker
                if let name = MeetingSpeaker.cleanName(names[speaker.id]) { copy.name = name }
                return copy
            }
            return MeetingDelivery(meetingId: nil, mode: kind, speakers: delivered, locale: Self.interfaceLocale)
        }
        statusLine = ""
        await settle()
        let transcript = result.transcript
        var answer: [String: Any] = [
            "transcript": transcript.text,
            "language": transcript.language ?? "",
            "durationSeconds": transcript.durationSeconds,
            "segments": transcript.segments.count,
            "mode": kind.rawValue,
            "speakers": (delivered.isEmpty ? transcript.speakers : delivered).map { speaker -> [String: Any] in
                ["id": speaker.id, "number": speaker.number, "side": speaker.side?.rawValue ?? "", "name": speaker.name ?? ""]
            },
            "lines": transcript.segments.map { segment -> [String: Any] in
                ["start": segment.start, "end": segment.end, "speaker": segment.speaker ?? "", "side": segment.side?.rawValue ?? "", "text": segment.text]
            },
            "notes": transcript.notes,
            "droppedEchoes": transcript.droppedEchoes,
            "jobs": await engine.jobs().map(\.json),
        ]
        if let jobId = result.jobId { answer["jobId"] = jobId }
        return answer
    }
}

// MARK: The line under the list

extension MeetingLiveSync.ListStatus {
    /// What the quiet line says, at `now`.
    func text(now: Date = Date()) -> String {
        switch self {
        case .building:
            return L("Building the list")
        case .atEnd:
            return L("The list is put together when the meeting ends")
        case .updated(let date):
            let seconds = max(0, Int(now.timeIntervalSince(date)))
            if seconds < 5 { return L("Updated just now") }
            if seconds < 90 { return L("Updated %lld s ago", seconds) }
            return L("Updated %lld min ago", seconds / 60)
        }
    }

    var name: String {
        switch self {
        case .building: return "building"
        case .atEnd: return "atEnd"
        case .updated: return "updated"
        }
    }
}

// MARK: Automation

#if DEBUG
extension MeetingController {
    /// Shows the panel on a made-up meeting, so a scripted run can look at
    /// every state of it without a microphone or a server: several speakers
    /// on both sides, a named one, an entry the model changed, a cancelled
    /// one, one edited by hand. Nothing is recorded and nothing is sent; the
    /// editors work on the made-up state.
    func previewPanel(_ show: Bool, mode: MeetingMode = .virtual, language: String = "es", long: Bool = false, status: String = "updated") {
        guard show else {
            guard previewing else { return }
            previewing = false
            phase = .idle
            statusLine = ""
            progress = nil
            meter.elapsed = 0
            meter.levels = .silent
            notices = []
            closeEditors()
            closePanel()
            return
        }
        guard phase == .idle || previewing else { return }
        previewing = true
        self.mode = mode
        let spanish = language != "en"
        func speaker(_ index: Int) -> MeetingSpeaker {
            let remote = index >= 2
            return MeetingSpeaker(
                id: mode == .virtual ? (remote ? "remote-\(index - 1)" : "room-\(index + 1)") : "voice-\(index + 1)",
                number: [1, 3, 2, 4][index],
                side: mode == .virtual ? (remote ? .remote : .room) : nil
            )
        }
        let voices = [speaker(0), speaker(2), speaker(1), speaker(3)]
        var lines: [(Int, String)] = spanish
            ? [
                (0, "Buenos días a todos, empezamos la revisión semanal del lanzamiento."),
                (2, "Por mi parte, la página de precios ya está lista para revisión."),
                (1, "Perfecto. Entonces acordamos lanzar el viernes 28 de noviembre."),
                (3, "Yo preparo las notas de la versión antes del jueves."),
                (2, "Una cosa: el viernes es feriado en Chile, mejor movemos el lanzamiento al lunes."),
                (0, "De acuerdo, entonces lanzamos el lunes 1 de diciembre y no el viernes."),
                (3, "Y cancelamos la demo interna del miércoles, ya no hace falta."),
            ]
            : [
                (0, "Good morning everyone, let's start the weekly review of the launch."),
                (2, "On my side, the pricing page is ready for review."),
                (1, "Great. Then we agree to launch on Friday, November 28."),
                (3, "I will write the release notes before Thursday."),
                (2, "One thing: Friday is a holiday in Chile, we had better move the launch to Monday."),
                (0, "Agreed, then we launch on Monday, December 1, and not on Friday."),
                (3, "And we cancel Wednesday's internal demo, it is no longer needed."),
            ]
        if long {
            lines.append((1, spanish
                ? "Antes de cerrar quiero dejar constancia, con todo el detalle posible, de que la migración de la base de datos de clientes se hará por etapas, empezando por las cuentas de prueba, siguiendo con las cuentas internas y terminando con los clientes de pago, y de que en cada etapa vamos a comparar los totales de registros, los importes facturados y las fechas de alta contra el sistema anterior antes de dar el siguiente paso."
                : "Before we close I want it on record, in as much detail as possible, that the migration of the customer database will be done in stages, starting with the test accounts, then the internal accounts and finally the paying customers, and that at every stage we will compare record totals, invoiced amounts and sign-up dates against the old system before taking the next step."))
            lines.append((3, "cliente_facturacion_migracion_etapa_tres_verificacion_importes_2026_11_28_definitivo"))
        }
        var state = MeetingLiveState(mode: mode)
        let segments = lines.enumerated().map { index, line -> MeetingSegment in
            let voice = speaker(line.0)
            return MeetingSegment(start: 2 + Double(index) * 9, end: 8 + Double(index) * 9, text: line.1, speaker: voice.id, side: voice.side)
        }
        state.apply(MeetingLiveUpdate(fromIndex: 0, segments: segments, speakers: voices.sorted { $0.number < $1.number }))
        state.rename(speakerId: speaker(0).id, to: "Ana")
        state.rename(speakerId: speaker(1).id, to: long ? "Luis Fernando Echeverría de la Torre y Villavicencio" : "Luis")
        let agreed = spanish ? "Lanzar el lunes 1 de diciembre" : "Launch on Monday, December 1"
        let agreedBefore = spanish ? "Lanzar el viernes 28 de noviembre" : "Launch on Friday, November 28"
        let notes = spanish ? "Preparar las notas de la versión" : "Write the release notes"
        let demo = spanish ? "Demo interna del miércoles" : "Internal demo on Wednesday"
        let docs = spanish ? "Actualizar la documentación de la API" : "Update the API documentation"
        var items = [
            MeetingItem(
                id: "i1", kind: .agreement, text: agreed, at: 47, updatedBy: "ai",
                history: [MeetingItem.Version(text: agreedBefore, at: 20, by: "ai")]
            ),
            MeetingItem(
                id: "i2", kind: .task, text: notes, owner: mode == .virtual ? MeetingSpeaker(id: "x", number: 4, side: .remote).label : MeetingSpeaker(id: "x", number: 4).label,
                due: spanish ? "jueves" : "Thursday", at: 29, updatedBy: "ai"
            ),
            MeetingItem(id: "i3", kind: .agreement, text: demo, status: .cancelled, at: 56, updatedBy: "ai", history: [MeetingItem.Version(text: demo, at: 12, by: "ai")]),
            MeetingItem(
                id: "i4", kind: .task, text: docs, owner: long ? "Luis Fernando Echeverría de la Torre y Villavicencio" : "Luis",
                due: spanish ? "esta semana" : "this week", locked: true, at: 38, updatedBy: "user",
                history: [MeetingItem.Version(text: docs, owner: nil, due: nil, at: 30, by: "ai")]
            ),
        ]
        if long {
            items.append(MeetingItem(
                id: "i5", kind: .task,
                text: spanish
                    ? "Comparar en cada etapa de la migración los totales de registros, los importes facturados y las fechas de alta contra el sistema anterior antes de dar el siguiente paso"
                    : "Compare record totals, invoiced amounts and sign-up dates against the old system at every stage of the migration before taking the next step",
                owner: "Ana", due: spanish ? "antes de cada etapa, sin excepción" : "before every stage, no exceptions", at: 70, updatedBy: "ai"
            ))
        }
        state.applyServer(items: items, revision: 4)
        live = state
        turns = state.turns
        canEditList = status != "atEnd"
        switch status {
        case "building": listStatus = .building
        case "atEnd": listStatus = .atEnd
        default: listStatus = .updated(Date().addingTimeInterval(-12))
        }
        notices = []
        statusLine = ""
        progress = nil
        closeEditors()
        phase = .recording
        if status == "finishing" {
            // after Stop: the longest status the header has to hold
            phase = .finishing
            statusLine = L("Downloading the speaker identification model")
            progress = 0.4
        }
        meter.elapsed = 75
        meter.levels = MeetingLevels(room: 0.55, remote: mode == .virtual ? 0.3 : nil)
        showPanel(activate: false)
    }

    /// The chooser alone, with nothing behind it (a click would not record).
    func previewChooser(_ show: Bool, preselected: MeetingMode? = nil, error: String? = nil) {
        guard show else {
            guard previewing, phase == .choosing else { return }
            previewing = false
            phase = .idle
            closePanel()
            return
        }
        guard phase == .idle || previewing else { return }
        previewing = true
        preselectedMode = preselected ?? services.settings.meetingMode
        chooserError = error
        phase = .choosing
        showPanel(activate: false)
    }

    var isPreviewing: Bool { previewing }

    /// The panel's window, for snapshots and for trying sizes.
    var panelForAutomation: NSPanel? { panel }

    /// Sizes the panel the way a drag of its corner would: the size asked
    /// goes through the same limit (`windowWillResize`), so less than the
    /// minimum is refused. Answers the size it ended with.
    func resizePanel(width: CGFloat, height: CGFloat) -> NSSize {
        guard let panel else { return .zero }
        let asked = panel.frameRect(forContentRect: NSRect(x: 0, y: 0, width: width, height: height)).size
        let allowed = panel.windowWillResize(panel, to: asked)
        var frame = panel.frame
        frame.origin.y += frame.height - allowed.height
        frame.origin.x += frame.width - allowed.width
        frame.size = allowed
        panel.setFrame(frame, display: true)
        return panel.contentView?.frame.size ?? .zero
    }

    func setPanelAppearance(_ name: String?) {
        switch name {
        case "light": panel?.appearance = NSAppearance(named: .aqua)
        case "dark": panel?.appearance = NSAppearance(named: .darkAqua)
        default: panel?.appearance = nil
        }
    }

    /// Plays the rest of a scripted meeting at once.
    func advanceScript() {
        (recordingEngine as? ScriptedMeetingEngine)?.advance()
    }

    /// Makes the calls that are due without waiting for their turn.
    func syncNow() async {
        await sync?.pump(force: true)
        refreshLive()
    }

    /// Everything a scripted check wants to know about the meeting.
    var automationState: [String: Any] {
        let state = sync?.state ?? live
        var answer: [String: Any] = statePayload
        answer["phase"] = String(describing: phase)
        answer["mode"] = mode.rawValue
        answer["preselected"] = preselectedMode.rawValue
        answer["defaultMode"] = services.settings.meetingMode.rawValue
        answer["chooserError"] = chooserError ?? ""
        answer["panelVisible"] = isPanelVisible
        if let panel {
            let size = panel.contentView?.frame.size ?? .zero
            answer["panel"] = [
                "width": size.width, "height": size.height,
                "minWidth": panel.minimumContentSize.width, "minHeight": panel.minimumContentSize.height,
                "resizable": panel.styleMask.contains(.resizable), "key": panel.isKeyWindow,
                "windowNumber": panel.windowNumber,
            ]
        }
        answer["meetingId"] = sync?.meetingId ?? ""
        answer["aiAvailable"] = (sync?.aiAvailable as Any?) ?? NSNull()
        answer["listStatus"] = listStatus.name
        answer["listStatusText"] = listStatus.text()
        answer["canEditList"] = canEditList
        answer["speakers"] = state.speakers.map { speaker -> [String: Any] in
            ["id": speaker.id, "number": speaker.number, "side": speaker.side?.rawValue ?? "", "name": speaker.name ?? "", "label": speaker.label, "chip": speaker.shortLabel]
        }
        answer["lines"] = state.segments.enumerated().map { index, segment -> [String: Any] in
            ["index": index, "speaker": segment.speaker ?? "", "side": segment.side?.rawValue ?? "", "label": state.label(for: segment) ?? "", "text": segment.text]
        }
        answer["turns"] = turns.count
        answer["items"] = state.items.map { item -> [String: Any] in
            [
                "id": item.id, "kind": item.kind.rawValue, "text": item.text, "owner": item.owner ?? "", "due": item.due ?? "",
                "status": item.status.rawValue, "locked": item.locked, "updatedBy": item.updatedBy, "before": item.previousText ?? "",
                "history": item.history.count,
            ]
        }
        answer["revision"] = state.revision
        answer["pendingEdits"] = state.pendingOps.count
        answer["acknowledged"] = state.acknowledged
        answer["stored"] = state.serverStored
        answer["segments"] = state.segments.count
        answer["calls"] = (sync?.calls ?? []).map { call -> [String: Any] in
            var entry: [String: Any] = ["route": call.route, "outcome": call.outcome]
            if let fromIndex = call.fromIndex { entry["fromIndex"] = fromIndex }
            if let count = call.count { entry["count"] = count }
            if let op = call.op { entry["op"] = op }
            return entry
        }
        if let scripted = recordingEngine as? ScriptedMeetingEngine {
            answer["script"] = ["played": scripted.linesPlayed, "total": scripted.linesTotal]
        }
        answer["notices"] = notices
        answer["statusLine"] = statusLine
        answer["editing"] = [
            "speaker": renamingSpeakerId ?? "", "item": editingItemId ?? "", "adding": addingItem,
            "transcriptCollapsed": transcriptCollapsed, "listCollapsed": listCollapsed, "confirmingDiscard": confirmingDiscard,
        ]
        if let audioURL { answer["sidecar"] = MeetingSidecar.url(forAudio: audioURL).path }
        return answer
    }
}
#endif
