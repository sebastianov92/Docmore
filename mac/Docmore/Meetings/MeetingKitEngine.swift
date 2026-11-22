#if canImport(MeetingKit)
import Foundation
import MeetingKit

/// The meeting engine backed by the local package `mac/MeetingKit`:
/// `MeetingRecorder` (in person: the microphone, one channel; virtual: the
/// microphone and the system audio as the two channels of one 16 kHz WAV),
/// `LiveMeetingSession` (text, sides and speakers while it records),
/// `MeetingProcessor` (the final pass over the file, seeded with the live
/// session's speakers), `ModelStore` for the Whisper and the speaker models
/// (both under `<data dir>/models`), and one `MeetingQueue` per account
/// under `<data dir>/meetings/jobs/<profile id>` whose sender gets its
/// bearer token from the app's refreshing token store.
///
/// The app and the package both have a `MeetingMode`, a `MeetingSide` and a
/// `MeetingSpeaker`. In this file the plain names are the app's; the
/// package's are written `MeetingKit.MeetingMode` and so on.
@MainActor
final class MeetingKitEngine: MeetingEngine {
    private let services: Services
    private let store: ModelStore
    private lazy var diarizer = SpeakerDiarizer(modelStore: store)
    private var transcriber: (key: String, value: Transcriber)?
    private var recorder: MeetingRecorder?
    private var live: LiveMeetingSession?
    /// The file of the recording under way.
    private var liveFile: URL?
    /// The speakers of the recording just stopped, as its live session left
    /// them: what the final pass starts from.
    private var finished: (file: URL, state: MeetingSpeakerState)?
    private var queues: [String: MeetingQueue] = [:]
    var onDelivered: ((MeetingJobInfo) -> Void)?
    #if DEBUG
    private var replay: ReplaySource?
    #endif

    init(services: Services) {
        self.services = services
        store = ModelStore(directory: services.paths.ensure(services.paths.modelsDir))
        // the permission state is only asked through public API
        MeetingRecorder.usesPrivatePermissionCheck = false
    }

    var isAvailable: Bool { true }
    var unavailableReason: String { "" }

    // MARK: Models

    /// Best first, the way Settings lists them.
    var models: [MeetingModelChoice] {
        let order = [
            WhisperModelCatalog.largeV3Turbo, WhisperModelCatalog.largeV3TurboFull,
            WhisperModelCatalog.small, WhisperModelCatalog.base, WhisperModelCatalog.tiny,
        ]
        return order.map { MeetingModelChoice(id: $0.id, name: $0.displayName, sizeBytes: $0.approximateSizeBytes) }
    }

    private func model(_ id: String) throws -> WhisperModelInfo {
        guard let found = WhisperModelCatalog.model(id) else {
            throw MeetingEngineError(message: L("Unknown transcription model %@", id))
        }
        return found
    }

    func isDownloaded(_ modelId: String) -> Bool {
        WhisperModelCatalog.model(modelId).map(store.isDownloaded) ?? false
    }

    func sizeOnDisk(_ modelId: String) -> Int64 {
        WhisperModelCatalog.model(modelId).map(store.sizeOnDisk) ?? 0
    }

    func download(_ modelId: String, progress: @escaping @Sendable (Double) -> Void) async throws {
        let info = try model(modelId)
        if store.isDownloaded(info) {
            progress(1)
            return
        }
        if NetworkOverride.shared.forcedUnreachable { throw NetworkOverride.unreachableError }
        // The model host drops a connection now and then (seen as a TLS
        // error). Files already fetched are kept, so trying again continues.
        var lastError: Error?
        for attempt in 0..<4 {
            do {
                try await store.download(info, progress: progress)
                return
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                lastError = error
                try? await Task.sleep(nanoseconds: UInt64(1_500_000_000 * (attempt + 1)))
            }
        }
        throw lastError ?? MeetingEngineError(message: L("The model could not be downloaded"))
    }

    func delete(_ modelId: String) throws {
        let info = try model(modelId)
        if transcriber?.key.hasPrefix(modelId + "|") == true { transcriber = nil }
        try store.delete(info)
    }

    /// One loaded model at a time: a different model or language replaces it.
    private func transcriber(modelId: String, language: String) throws -> Transcriber {
        let key = "\(modelId)|\(language)"
        if let transcriber, transcriber.key == key { return transcriber.value }
        let info = try model(modelId)
        let made = Transcriber(
            modelStore: store,
            model: info,
            language: language == "auto" || language.isEmpty ? .automatic : .fixed(language)
        )
        transcriber = (key, made)
        return made
    }

    // MARK: Speaker model

    private var speakerModelInfo: SpeakerModelInfo { SpeakerModelCatalog.recommended }

    var speakerModel: MeetingModelChoice? {
        MeetingModelChoice(id: speakerModelInfo.id, name: L("Speaker identification"), sizeBytes: speakerModelInfo.approximateSizeBytes)
    }

    var isSpeakerModelDownloaded: Bool { store.isDownloaded(speakerModelInfo) }
    var speakerModelSizeOnDisk: Int64 { store.sizeOnDisk(speakerModelInfo) }

    /// The only place the speaker models are fetched; the package refuses
    /// while it records, so a meeting is never slowed down by a download.
    func downloadSpeakerModel(progress: @escaping @Sendable (Double) -> Void) async throws {
        let info = speakerModelInfo
        if store.isDownloaded(info) {
            progress(1)
            return
        }
        if NetworkOverride.shared.forcedUnreachable { throw NetworkOverride.unreachableError }
        var lastError: Error?
        for attempt in 0..<4 {
            do {
                try await store.download(info, progress: progress)
                return
            } catch is CancellationError {
                throw CancellationError()
            } catch ModelStoreError.recordingInProgress {
                throw MeetingEngineError(message: L("The speaker model is not downloaded while a recording runs. It is downloaded when the recording ends."))
            } catch {
                lastError = error
                try? await Task.sleep(nanoseconds: UInt64(1_500_000_000 * (attempt + 1)))
            }
        }
        throw lastError ?? MeetingEngineError(message: L("The model could not be downloaded"))
    }

    func deleteSpeakerModel() throws {
        try store.delete(speakerModelInfo)
        let loaded = diarizer
        Task.detached { await loaded.unload() }
    }

    // MARK: Recording

    var recordingsDirectory: URL { services.paths.ensure(services.paths.meetingAudioDir) }

    func repairRecording(at file: URL) {
        _ = try? WAVFile.repairHeader(at: file)
    }

    /// A recording is one WAV (two channels when virtual) and, next to it,
    /// the speakers of its live session.
    func removeRecording(at file: URL) {
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.removeItem(at: Self.stateURL(for: file))
    }

    func recordedMode(of file: URL) -> MeetingMode? {
        AudioTrackReader.recordedMode(of: file)?.app
    }

    /// `<recording>.speakers.json`: the live session's speakers (ids,
    /// numbers, names, voice prints), written after every update. It is what
    /// lets the final pass of a recording finished after a crash keep the
    /// same speakers, with their names.
    nonisolated private static func stateURL(for file: URL) -> URL {
        file.deletingLastPathComponent().appendingPathComponent(file.lastPathComponent + ".speakers.json")
    }

    nonisolated private static func writeState(_ state: MeetingSpeakerState, for file: URL) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? AtomicFile.write(data, to: stateURL(for: file))
    }

    nonisolated private static func readState(for file: URL) -> MeetingSpeakerState? {
        guard let data = try? Data(contentsOf: stateURL(for: file)) else { return nil }
        return try? JSONDecoder().decode(MeetingSpeakerState.self, from: data)
    }

    func startRecording(
        _ request: MeetingRecordingRequest,
        onLevel: @escaping @Sendable (MeetingLevels) -> Void,
        onLive: @escaping @Sendable (MeetingLiveUpdate) -> Void,
        onFailure: @escaping @Sendable (String) -> Void
    ) async throws -> [String] {
        let mode = MeetingKit.MeetingMode(request.mode)
        let file = recordingsDirectory.appendingPathComponent(request.fileName)

        // Text, sides and speakers while it records: only with the Whisper
        // model on disk (nothing is downloaded during a meeting), and with
        // speakers only when their models are on disk too.
        var session: LiveMeetingSession?
        if isDownloaded(request.modelId), let transcriber = try? transcriber(modelId: request.modelId, language: request.language) {
            let made = LiveMeetingSession(mode: mode, transcriber: transcriber, diarizer: diarizer.isAvailable ? diarizer : nil)
            made.onUpdate = { [weak made] update in
                onLive(MeetingLiveUpdate(
                    fromIndex: update.fromIndex,
                    segments: update.segments.map(MeetingSegment.init(kit:)),
                    speakers: update.speakers.map(MeetingSpeaker.init(kit:))
                ))
                if let state = made?.state { Self.writeState(state, for: file) }
            }
            session = made
        }
        // every tenth of a second of every track: the live session, and the meters
        let feed: @Sendable (MeetingAudioChunk) -> Void = { chunk in
            session?.append(chunk)
            onLevel(MeetingLevels(
                room: AudioMath.meterLevel(rms: AudioMath.rms(chunk.microphone)),
                remote: chunk.systemAudio.map { AudioMath.meterLevel(rms: AudioMath.rms($0)) }
            ))
        }

        #if DEBUG
        if let source = request.replay {
            // automation: the audio of a file, through the same session, into the same kind of recording
            let made = try ReplaySource(replay: source, mode: mode, output: file)
            made.start(onChunk: feed)
            replay = made
            live = session
            liveFile = file
            return []
        }
        #endif

        let made = MeetingRecorder(outputDirectory: recordingsDirectory, options: RecordingOptions(mode: mode, fileName: request.fileName))
        made.onTrackChunk = feed
        made.onFailure = { error in onFailure(Self.describe(error)) }
        do {
            try await made.start()
        } catch let error as MeetingRecorderError {
            throw MeetingEngineError(message: Self.describe(error))
        }
        recorder = made
        live = session
        liveFile = file
        return made.warnings.map { Self.describe($0.error) }
    }

    func setSpeakerName(_ name: String?, for speakerId: String) {
        guard let live, live.setName(name, forSpeaker: speakerId), let liveFile else { return }
        Self.writeState(live.state, for: liveFile)
    }

    func stopRecording() async throws -> MeetingRecordingResult {
        let session = live
        live = nil
        liveFile = nil
        var result: MeetingRecordingResult
        #if DEBUG
        if let source = replay {
            replay = nil
            let seconds = await source.stop()
            result = MeetingRecordingResult(fileURL: source.output, durationSeconds: seconds, warnings: [])
            await finishLive(session, file: result.fileURL)
            return result
        }
        #endif
        guard let active = recorder else {
            throw MeetingEngineError(message: Self.describe(MeetingRecorderError.notRecording))
        }
        recorder = nil
        do {
            let stopped = try await active.stop()
            result = MeetingRecordingResult(
                fileURL: stopped.fileURL,
                durationSeconds: stopped.durationSeconds,
                warnings: stopped.warnings.map { Self.describe($0.error) }
            )
        } catch let error as MeetingRecorderError {
            if let session { Task.detached { _ = await session.finish() } }
            throw MeetingEngineError(message: Self.describe(error))
        }
        await finishLive(session, file: result.fileURL)
        return result
    }

    /// Lets the live session work on the last stretch of audio and keeps
    /// its speakers: the final pass over the file starts from them, so ids,
    /// numbers and names stay the ones the person saw.
    private func finishLive(_ session: LiveMeetingSession?, file: URL) async {
        guard let session else {
            finished = nil
            return
        }
        _ = await session.finish()
        let state = session.state
        finished = (file, state)
        Self.writeState(state, for: file)
    }

    func cancelRecording() async {
        let session = live
        let file = liveFile
        live = nil
        liveFile = nil
        if let session { Task.detached { _ = await session.finish() } }
        #if DEBUG
        if let source = replay {
            replay = nil
            _ = await source.stop()
            removeRecording(at: source.output)
            return
        }
        #endif
        let active = recorder
        recorder = nil
        await active?.cancel()
        if let file { removeRecording(at: file) }
    }

    /// The package speaks English only; the cases a person can act on get
    /// the app's own words (and translation).
    nonisolated private static func describe(_ error: MeetingRecorderError) -> String {
        switch error {
        case .microphonePermissionDenied:
            return L("Microphone access is off for Docmore. Turn it on in System Settings > Privacy & Security > Microphone.")
        case .systemAudioPermissionDenied:
            return L("System audio access is off for Docmore. Turn it on in System Settings > Privacy & Security > Screen & System Audio Recording.")
        case .silent(.systemAudio):
            return L("System audio is silent: only your microphone is being recorded.")
        case .silent(.microphone):
            return L("The microphone is silent: only system audio is being recorded.")
        default:
            return error.localizedDescription
        }
    }

    // MARK: Transcription

    /// The final pass: text per track, who speaks when, the echo of the far
    /// side taken out of the room's text, the tracks merged by time.
    func transcribe(
        file: URL,
        mode: MeetingMode,
        modelId: String,
        language: String,
        knownSpeakers: [MeetingSpeaker],
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> MeetingTranscriptData {
        let transcriber = try transcriber(modelId: modelId, language: language)
        let kitMode = MeetingKit.MeetingMode(mode)
        // The speakers of the live session of this recording: in memory for
        // the one just stopped, from the file next to the audio for one
        // finished after a relaunch. Without them the voices are numbered afresh.
        var state = finished?.file == file ? finished?.state : Self.readState(for: file)
        if state?.mode != kitMode { state = nil }
        if var seeded = state {
            // names the app has that the session did not get to keep
            for speaker in knownSpeakers {
                if let name = speaker.name { _ = seeded.setName(name, for: speaker.id) }
            }
            state = seeded
        }
        let processor = MeetingProcessor(transcriber: transcriber, diarizer: diarizer.isAvailable ? diarizer : nil)
        let result: ProcessedMeeting
        do {
            result = try await processor.process(fileURL: file, mode: kitMode, state: state, progress: progress)
        } catch let error as MeetingEngineError {
            throw error
        } catch {
            throw MeetingEngineError(message: error.localizedDescription)
        }
        if finished?.file == file { finished = nil }
        let transcript = result.transcript
        return MeetingTranscriptData(
            text: transcript.text,
            language: transcript.language,
            durationSeconds: transcript.durationSeconds,
            segments: transcript.segments.map(MeetingSegment.init(kit:)),
            speakers: transcript.speakers.map(MeetingSpeaker.init(kit:)),
            notes: result.notes,
            droppedEchoes: result.echoes.count
        )
    }

    // MARK: Queue

    private func queueDirectory(_ profileId: String) -> URL {
        services.paths.meetingJobsDir.appendingPathComponent(profileId, isDirectory: true)
    }

    /// The queue of an account. Its sender asks the app's token store for a
    /// token each time, so an expired one is renewed on the way.
    private func queue(for profileId: String) -> MeetingQueue? {
        if let existing = queues[profileId] { return existing }
        guard let profile = services.profiles.profile(id: profileId) else { return nil }
        let tokens = services.tokens
        let authorization: @Sendable () async throws -> String = {
            // the forced-offline switch of the automation server applies here too
            if NetworkOverride.shared.forcedUnreachable { throw NetworkOverride.unreachableError }
            do {
                return try await tokens.accessToken(profileId: profileId)
            } catch is TokenError {
                throw MeetingSendError.needsSignIn
            }
        }
        let sender = DocmoreMeetingSender(baseURL: profile.server, session: services.plainSession, authorization: authorization)
        let made = MeetingQueue(directory: services.paths.ensure(queueDirectory(profileId)), sender: sender)
        queues[profileId] = made
        return made
    }

    func enqueue(target: MeetingDestination, transcript: MeetingTranscriptData, meeting: MeetingDelivery, audio: URL?) async throws -> String {
        guard let queue = queue(for: target.profileId) else {
            throw MeetingEngineError(message: L("This account needs to sign in again"))
        }
        var info = ["profileId": target.profileId]
        if let audio { info["audio"] = audio.path }
        // the transcript goes as it is: kind, sides, and the speakers with the
        // names the person gave them; the live meeting it finishes and the
        // language of the app's interface travel with the job
        let job = try queue.enqueue(
            MeetingTranscript(
                text: transcript.text,
                language: transcript.language,
                durationSeconds: transcript.durationSeconds,
                segments: transcript.segments.map(\.kit),
                mode: MeetingKit.MeetingMode(meeting.mode),
                speakers: meeting.speakers.map(\.kit)
            ),
            target: MeetingKit.MeetingTarget(pageId: target.pageId, spaceId: target.spaceId, title: target.title),
            userInfo: info,
            meetingId: meeting.meetingId,
            locale: meeting.locale
        )
        return job.id
    }

    func flush() async {
        for profile in services.profiles.profiles {
            guard !profile.needsSignIn, let queue = queue(for: profile.id), queue.pendingCount > 0 else { continue }
            var report = await queue.flush()
            if report.needsSignIn {
                // a 401 with a token that looked valid: renew it once and try again
                if (try? await services.tokens.forceRefresh(profileId: profile.id)) != nil {
                    queue.clearNeedsSignIn()
                    let second = await queue.flush()
                    report.sent.append(contentsOf: second.sent)
                    report.failed.append(contentsOf: second.failed)
                }
            }
            for sent in report.sent {
                if let audio = sent.job.userInfo["audio"] {
                    removeRecording(at: URL(fileURLWithPath: audio))
                }
                onDelivered?(MeetingJobInfo(
                    id: sent.job.id,
                    profileId: profile.id,
                    state: "sent",
                    title: sent.job.target.title,
                    attempts: sent.job.attempts,
                    error: nil,
                    pageId: sent.receipt.pageId ?? sent.job.target.pageId,
                    meetingId: sent.receipt.id
                ))
            }
            for failed in report.failed {
                services.notifications.post(
                    title: L("The meeting could not be saved"),
                    body: failed.lastError ?? "",
                    profileId: profile.id,
                    path: nil,
                    kind: "meeting-failed"
                )
            }
        }
    }

    func jobs() async -> [MeetingJobInfo] {
        var result: [MeetingJobInfo] = []
        for profile in services.profiles.profiles {
            guard let queue = queue(for: profile.id) else { continue }
            let describe: (MeetingJob, String) -> MeetingJobInfo = { job, state in
                MeetingJobInfo(
                    id: job.id,
                    profileId: profile.id,
                    state: state,
                    title: job.target.title,
                    attempts: job.attempts,
                    error: job.lastError,
                    pageId: job.target.pageId,
                    meetingId: nil
                )
            }
            result.append(contentsOf: queue.pendingJobs().map { describe($0, "waiting") })
            result.append(contentsOf: queue.failedJobs().map { describe($0, "failed") })
        }
        return result
    }

    func removeJobs(profileId: String) async {
        if let queue = queues[profileId] {
            for job in queue.pendingJobs() + queue.failedJobs() {
                if let audio = job.userInfo["audio"] { removeRecording(at: URL(fileURLWithPath: audio)) }
            }
        }
        queues.removeValue(forKey: profileId)
        try? FileManager.default.removeItem(at: queueDirectory(profileId))
    }
}
// MARK: The package's shapes and the app's

private extension MeetingKit.MeetingMode {
    init(_ mode: MeetingMode) {
        self = mode == .virtual ? .virtual : .inPerson
    }

    var app: MeetingMode { self == .virtual ? .virtual : .inPerson }
}

private extension MeetingKit.MeetingSide {
    init(_ side: MeetingSide) {
        self = side == .remote ? .remote : .room
    }

    var app: MeetingSide { self == .remote ? .remote : .room }
}

private extension MeetingSegment {
    init(kit segment: MeetingKit.MeetingTranscript.Segment) {
        self.init(start: segment.start, end: segment.end, text: segment.text, speaker: segment.speaker, side: segment.side?.app)
    }

    var kit: MeetingKit.MeetingTranscript.Segment {
        MeetingKit.MeetingTranscript.Segment(start: start, end: end, text: text, speaker: speaker, side: side.map(MeetingKit.MeetingSide.init))
    }
}

private extension MeetingSpeaker {
    init(kit speaker: MeetingKit.MeetingSpeaker) {
        self.init(id: speaker.id, number: speaker.number, side: speaker.side?.app, name: MeetingSpeaker.cleanName(speaker.name))
    }

    var kit: MeetingKit.MeetingSpeaker {
        MeetingKit.MeetingSpeaker(id: id, number: number, side: side.map(MeetingKit.MeetingSide.init), name: name)
    }
}

#if DEBUG
/// Plays a recording as if it were being captured (the automation server's
/// way to run a real meeting with no microphone): a tenth of a second of
/// every track at a time, at the speed asked, to the live session and into
/// a WAV written the way the recorder writes it (one channel in person, two
/// when virtual), so stopping it, or killing the app while it runs, leaves
/// what a real recording leaves.
private final class ReplaySource: @unchecked Sendable {
    let output: URL
    private let room: [Float]
    private let remote: [Float]?
    private let speed: Double
    private let writer: WAVWriter
    private let lock = NSLock()
    private var written = 0
    private var task: Task<Void, Never>?

    init(replay: MeetingReplay, mode: MeetingKit.MeetingMode, output: URL) throws {
        let channels: [[Float]]
        do {
            channels = try AudioTrackReader.channels(of: replay.file)
        } catch {
            throw MeetingEngineError(message: "the recording to replay cannot be read: \(error.localizedDescription)")
        }
        guard let first = channels.first, !first.isEmpty else {
            throw MeetingEngineError(message: "the recording to replay has no audio")
        }
        if mode == .virtual {
            room = first
            remote = channels.count > 1 ? channels[1] : [Float](repeating: 0, count: first.count)
        } else {
            // everybody in one track, as the microphone of a room hears them
            room = channels.count > 1 ? AudioTrackReader.mixdown(channels) : first
            remote = nil
        }
        speed = max(0.1, replay.speed)
        self.output = output
        do {
            writer = try WAVWriter(url: output, sampleRate: 16_000, channels: remote == nil ? 1 : 2)
        } catch {
            throw MeetingEngineError(message: error.localizedDescription)
        }
    }

    func start(onChunk: @escaping @Sendable (MeetingAudioChunk) -> Void) {
        task = Task.detached(priority: .userInitiated) { [self] in
            let step = 1600
            let started = Date()
            var index = 0
            while index < room.count, !Task.isCancelled {
                let end = min(index + step, room.count)
                let microphone = Array(room[index..<end])
                let system = remote.map { Array($0[index..<end]) }
                var frames = microphone
                if let system {
                    frames = [Float](repeating: 0, count: microphone.count * 2)
                    for offset in microphone.indices {
                        frames[offset * 2] = microphone[offset]
                        frames[offset * 2 + 1] = system[offset]
                    }
                }
                lock.withLock {
                    try? writer.append(frames)
                    written = end
                }
                onChunk(MeetingAudioChunk(microphone: microphone, systemAudio: system))
                index = end
                // keep to the clock of the recording, however long the work on a chunk took
                let wait = started.addingTimeInterval(Double(index) / 16_000 / speed).timeIntervalSinceNow
                if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            }
        }
    }

    /// Stops feeding and closes the file; answers how many seconds it holds.
    func stop() async -> Double {
        task?.cancel()
        await task?.value
        return lock.withLock {
            try? writer.finish()
            return Double(written) / 16_000
        }
    }
}
#endif
#endif
