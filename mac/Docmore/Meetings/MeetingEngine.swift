import Foundation

/// What the app needs from the meeting engine. The engine itself (recording,
/// transcription on the device, the queue of transcripts) is the local
/// package `mac/MeetingKit`; `MeetingKitEngine` adapts it to this protocol.
/// Everything else in the app (panel, settings, bridge, automation) only
/// knows the protocol.
struct MeetingModelChoice: Identifiable, Equatable {
    let id: String
    let name: String
    let sizeBytes: Int64
}

struct MeetingDestination: Equatable {
    var profileId: String
    var pageId: String?
    var spaceId: String?
    var title: String?
}

struct MeetingRecordingResult {
    let fileURL: URL
    let durationSeconds: Double
    /// Human readable notes about a source that could not be recorded.
    let warnings: [String]
}

struct MeetingTranscriptData {
    var text: String
    var language: String?
    var durationSeconds: Double
    var segments: [(start: Double, end: Double, text: String)]

    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

struct MeetingJobInfo: Equatable {
    let id: String
    let profileId: String
    /// "waiting", "sending", "sent", "failed"
    let state: String
    let title: String?
    let attempts: Int
    let error: String?
    let pageId: String?
    let meetingId: String?

    var json: [String: Any] {
        var entry: [String: Any] = ["id": id, "profileId": profileId, "state": state, "attempts": attempts]
        if let title { entry["title"] = title }
        if let error { entry["error"] = error }
        if let pageId { entry["pageId"] = pageId }
        if let meetingId { entry["meetingId"] = meetingId }
        return entry
    }
}

struct MeetingEngineError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
protocol MeetingEngine: AnyObject {
    /// False when the build has no engine; `unavailableReason` says why.
    var isAvailable: Bool { get }
    var unavailableReason: String { get }

    // Models
    var models: [MeetingModelChoice] { get }
    func isDownloaded(_ modelId: String) -> Bool
    func sizeOnDisk(_ modelId: String) -> Int64
    func download(_ modelId: String, progress: @escaping @Sendable (Double) -> Void) async throws
    func delete(_ modelId: String) throws

    // Recording. The callbacks may arrive on any thread.
    /// Starts capturing; returns notes about sources that could not start.
    /// Live text is produced only when the model is already on disk.
    func startRecording(
        fileName: String,
        microphone: Bool,
        systemAudio: Bool,
        modelId: String,
        language: String,
        onLevel: @escaping @Sendable (Float) -> Void,
        onLiveText: @escaping @Sendable (String) -> Void,
        onFailure: @escaping @Sendable (String) -> Void
    ) async throws -> [String]
    func stopRecording() async throws -> MeetingRecordingResult
    func cancelRecording() async
    /// Where recordings are written.
    var recordingsDirectory: URL { get }
    /// Makes a recording cut short by a crash readable again.
    func repairRecording(at file: URL)

    // Transcription of a finished recording (16 kHz mono WAV)
    func transcribe(
        file: URL,
        modelId: String,
        language: String,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> MeetingTranscriptData

    // Queue of transcripts waiting for their server
    func enqueue(target: MeetingDestination, transcript: MeetingTranscriptData, audio: URL?) async throws -> String
    /// Sends what can be sent now.
    func flush() async
    func jobs() async -> [MeetingJobInfo]
    func removeJobs(profileId: String) async
    /// Called on the main actor when the server accepted a transcript.
    var onDelivered: ((MeetingJobInfo) -> Void)? { get set }
}

/// The engine of a build without MeetingKit.
@MainActor
final class UnavailableMeetingEngine: MeetingEngine {
    var isAvailable: Bool { false }
    var unavailableReason: String { L("Meeting recording is not part of this build") }
    var models: [MeetingModelChoice] { [] }
    var onDelivered: ((MeetingJobInfo) -> Void)?

    private var unavailable: MeetingEngineError { MeetingEngineError(message: unavailableReason) }

    func isDownloaded(_ modelId: String) -> Bool { false }
    func sizeOnDisk(_ modelId: String) -> Int64 { 0 }
    func download(_ modelId: String, progress: @escaping @Sendable (Double) -> Void) async throws { throw unavailable }
    func delete(_ modelId: String) throws { throw unavailable }
    var recordingsDirectory: URL { FileManager.default.temporaryDirectory }
    func repairRecording(at file: URL) {}
    func startRecording(fileName: String, microphone: Bool, systemAudio: Bool, modelId: String, language: String, onLevel: @escaping @Sendable (Float) -> Void, onLiveText: @escaping @Sendable (String) -> Void, onFailure: @escaping @Sendable (String) -> Void) async throws -> [String] { throw unavailable }
    func stopRecording() async throws -> MeetingRecordingResult { throw unavailable }
    func cancelRecording() async {}
    func transcribe(file: URL, modelId: String, language: String, progress: @escaping @Sendable (Double) -> Void) async throws -> MeetingTranscriptData { throw unavailable }
    func enqueue(target: MeetingDestination, transcript: MeetingTranscriptData, audio: URL?) async throws -> String { throw unavailable }
    func flush() async {}
    func jobs() async -> [MeetingJobInfo] { [] }
    func removeJobs(profileId: String) async {}
}
