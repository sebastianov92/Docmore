#if canImport(MeetingKit)
import Foundation
import MeetingKit

/// The meeting engine backed by the local package `mac/MeetingKit`:
/// `MeetingRecorder` (microphone + system audio to a 16 kHz mono WAV),
/// `ModelStore` + `Transcriber` + `LiveTranscriber` (WhisperKit on the
/// device, models under `<data dir>/models`), and one `MeetingQueue` per
/// account under `<data dir>/meetings/jobs/<profile id>` whose
/// `DocmoreMeetingSender` gets its bearer token from the app's refreshing
/// token store.
@MainActor
final class MeetingKitEngine: MeetingEngine {
    private let services: Services
    private let store: ModelStore
    private var transcriber: (key: String, value: Transcriber)?
    private var recorder: MeetingRecorder?
    private var live: LiveTranscriber?
    private var queues: [String: MeetingQueue] = [:]
    var onDelivered: ((MeetingJobInfo) -> Void)?

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

    // MARK: Recording

    var recordingsDirectory: URL { services.paths.ensure(services.paths.meetingAudioDir) }

    func repairRecording(at file: URL) {
        _ = try? WAVFile.repairHeader(at: file)
    }

    func startRecording(
        fileName: String,
        microphone: Bool,
        systemAudio: Bool,
        modelId: String,
        language: String,
        onLevel: @escaping @Sendable (Float) -> Void,
        onLiveText: @escaping @Sendable (String) -> Void,
        onFailure: @escaping @Sendable (String) -> Void
    ) async throws -> [String] {
        let made = MeetingRecorder(
            outputDirectory: recordingsDirectory,
            options: RecordingOptions(captureMicrophone: microphone, captureSystemAudio: systemAudio, fileName: fileName)
        )
        made.onLevel = onLevel
        made.onFailure = { error in onFailure(Self.describe(error)) }
        // live text only with the model on disk: nothing is downloaded while
        // a meeting is being recorded
        if isDownloaded(modelId), let transcriber = try? transcriber(modelId: modelId, language: language) {
            let liveTranscriber = LiveTranscriber(transcriber: transcriber, windowSeconds: 15)
            liveTranscriber.onUpdate = { update in onLiveText(update.text) }
            made.onChunk = { samples in liveTranscriber.append(samples: samples) }
            live = liveTranscriber
        } else {
            live = nil
        }
        do {
            try await made.start()
        } catch let error as MeetingRecorderError {
            live = nil
            throw MeetingEngineError(message: Self.describe(error))
        }
        recorder = made
        return made.warnings.map { Self.describe($0.error) }
    }

    func stopRecording() async throws -> MeetingRecordingResult {
        guard let active = recorder else { throw MeetingEngineError(message: Self.describe(MeetingRecorderError.notRecording)) }
        recorder = nil
        let finishedLive = live
        live = nil
        // the whole file is transcribed again after this; the live windows
        // only fed the panel
        if let finishedLive { Task.detached { _ = await finishedLive.finish() } }
        do {
            let result = try await active.stop()
            return MeetingRecordingResult(
                fileURL: result.fileURL,
                durationSeconds: result.durationSeconds,
                warnings: result.warnings.map { Self.describe($0.error) }
            )
        } catch let error as MeetingRecorderError {
            throw MeetingEngineError(message: Self.describe(error))
        }
    }

    func cancelRecording() async {
        let active = recorder
        recorder = nil
        live = nil
        await active?.cancel()
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

    func transcribe(
        file: URL,
        modelId: String,
        language: String,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> MeetingTranscriptData {
        let transcriber = try transcriber(modelId: modelId, language: language)
        let transcript = try await transcriber.transcribe(fileURL: file, progress: progress)
        return MeetingTranscriptData(
            text: transcript.text,
            language: transcript.language,
            durationSeconds: transcript.durationSeconds,
            segments: transcript.segments.map { ($0.start, $0.end, $0.text) }
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
        let sender = DocmoreMeetingSender(baseURL: profile.server, session: services.plainSession) {
            // the forced-offline switch of the automation server applies here too
            if NetworkOverride.shared.forcedUnreachable { throw NetworkOverride.unreachableError }
            do {
                return try await tokens.accessToken(profileId: profileId)
            } catch is TokenError {
                throw MeetingSendError.needsSignIn
            }
        }
        let made = MeetingQueue(directory: services.paths.ensure(queueDirectory(profileId)), sender: sender)
        queues[profileId] = made
        return made
    }

    func enqueue(target: MeetingDestination, transcript: MeetingTranscriptData, audio: URL?) async throws -> String {
        guard let queue = queue(for: target.profileId) else {
            throw MeetingEngineError(message: L("This account needs to sign in again"))
        }
        var info = ["profileId": target.profileId]
        if let audio { info["audio"] = audio.path }
        let job = try queue.enqueue(
            MeetingTranscript(
                text: transcript.text,
                language: transcript.language,
                durationSeconds: transcript.durationSeconds,
                segments: transcript.segments.map { MeetingTranscript.Segment(start: $0.start, end: $0.end, text: $0.text) }
            ),
            target: MeetingKit.MeetingTarget(pageId: target.pageId, spaceId: target.spaceId, title: target.title),
            userInfo: info
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
                    try? FileManager.default.removeItem(atPath: audio)
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
                if let audio = job.userInfo["audio"] { try? FileManager.default.removeItem(atPath: audio) }
            }
        }
        queues.removeValue(forKey: profileId)
        try? FileManager.default.removeItem(at: queueDirectory(profileId))
    }
}
#endif
