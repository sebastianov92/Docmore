import Foundation

/// What the app needs from the meeting engine. The engine itself (recording,
/// telling voices apart, transcription on the device, the queue of
/// transcripts) is the local package `mac/MeetingKit`; `MeetingKitEngine`
/// adapts it to this protocol. Everything else in the app (panel, settings,
/// bridge, automation) only knows the protocol and the shapes of
/// `Core/MeetingTypes.swift`.
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

/// What to record. The kind of meeting decides the sources: the microphone
/// alone in person; the microphone and, as a separate track, the audio the
/// Mac plays in a virtual meeting.
struct MeetingRecordingRequest {
    /// The name of the recording's file inside `recordingsDirectory` (of its
    /// first file, when a virtual meeting is several). The app writes its
    /// own small file next to it, `<fileName>.json`, before recording
    /// starts, and `stopRecording()` must answer with this same file.
    var fileName: String
    var mode: MeetingMode
    var modelId: String
    var language: String
    /// DEBUG builds only (the automation server sets it): the audio comes
    /// from this file instead of the microphone and the system audio, fed
    /// through the same live session and written to the same recording.
    var replay: MeetingReplay?
}

/// A recording to play back as if it were being captured.
struct MeetingReplay: Equatable {
    /// One channel (the room), or two (0 the room, 1 the remote side).
    var file: URL
    /// Times real time; 1 feeds a second of audio per second.
    var speed: Double
}

/// Input levels, 0...1.
struct MeetingLevels: Equatable, Sendable {
    /// The microphone.
    var room: Float
    /// The audio the Mac plays (the other side of a call); nil in person.
    var remote: Float?

    static let silent = MeetingLevels(room: 0, remote: nil)
}

struct MeetingRecordingResult {
    /// The recording. A virtual meeting may be more than one file on disk:
    /// the engine finds the rest from this one, and only the engine removes
    /// or repairs a recording.
    let fileURL: URL
    let durationSeconds: Double
    /// Human readable notes about a source that could not be recorded.
    let warnings: [String]
}

struct MeetingTranscriptData {
    var text: String
    var language: String?
    var durationSeconds: Double
    /// With speaker and side where the engine could tell.
    var segments: [MeetingSegment]
    /// The voices of the transcript, with the same ids the live updates of
    /// the same recording used, and the names the engine carried for them.
    var speakers: [MeetingSpeaker]
    /// What the engine has to say to the person about this recording (the
    /// speaker models were missing, the file had one track...).
    var notes: [String] = []
    /// Sentences of the far side heard again through the microphone and
    /// left out of the room's text.
    var droppedEchoes = 0

    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

/// What travels to the server with a transcript besides the text.
struct MeetingDelivery: Equatable {
    /// The live meeting this transcript finishes, when there was one.
    var meetingId: String?
    var mode: MeetingMode
    /// The voices with the names the person typed.
    var speakers: [MeetingSpeaker]
    /// The language of the app's interface, for the labels of the notes.
    var locale: String?
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

    // Transcription models
    var models: [MeetingModelChoice] { get }
    func isDownloaded(_ modelId: String) -> Bool
    func sizeOnDisk(_ modelId: String) -> Int64
    func download(_ modelId: String, progress: @escaping @Sendable (Double) -> Void) async throws
    func delete(_ modelId: String) throws

    // The model that tells voices apart. Nil when the engine has none: then
    // segments come without a speaker.
    var speakerModel: MeetingModelChoice? { get }
    var isSpeakerModelDownloaded: Bool { get }
    var speakerModelSizeOnDisk: Int64 { get }
    func downloadSpeakerModel(progress: @escaping @Sendable (Double) -> Void) async throws
    func deleteSpeakerModel() throws

    // Recording. The callbacks may arrive on any thread.
    /// Starts capturing; returns notes about sources that could not start.
    /// `onLive` reports the labelled text as it comes (only when the models
    /// are already on disk): each update replaces the segments from its
    /// `fromIndex` on, so earlier lines can get another speaker, and carries
    /// every voice heard so far.
    func startRecording(
        _ request: MeetingRecordingRequest,
        onLevel: @escaping @Sendable (MeetingLevels) -> Void,
        onLive: @escaping @Sendable (MeetingLiveUpdate) -> Void,
        onFailure: @escaping @Sendable (String) -> Void
    ) async throws -> [String]
    func stopRecording() async throws -> MeetingRecordingResult
    /// The person named a voice of the recording under way (nil: took the
    /// name away). The engine carries it: when two voices turn out to be
    /// one the named one stays, and the final transcript of the recording
    /// has the name even when it is made after a crash.
    func setSpeakerName(_ name: String?, for speakerId: String)
    /// Stops and deletes what was recorded.
    func cancelRecording() async
    /// Where recordings are written.
    var recordingsDirectory: URL { get }
    /// Makes a recording cut short by a crash readable again.
    func repairRecording(at file: URL)
    /// Deletes a recording (every file of it).
    func removeRecording(at file: URL)
    /// The kind a recording was made in, read from the file itself; nil when
    /// it cannot be read.
    func recordedMode(of file: URL) -> MeetingMode?

    /// The final transcript of a finished recording, with speakers and, in a
    /// virtual meeting, sides. `knownSpeakers` are the voices as they were
    /// labelled while it was recorded: the engine keeps their ids, so a name
    /// typed during the meeting stays with its voice. For the recording just
    /// stopped the engine knows them itself; for one finished after a crash
    /// they come from the file kept next to the audio.
    func transcribe(
        file: URL,
        mode: MeetingMode,
        modelId: String,
        language: String,
        knownSpeakers: [MeetingSpeaker],
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> MeetingTranscriptData

    // Queue of transcripts waiting for their server
    func enqueue(target: MeetingDestination, transcript: MeetingTranscriptData, meeting: MeetingDelivery, audio: URL?) async throws -> String
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
    var speakerModel: MeetingModelChoice? { nil }
    var isSpeakerModelDownloaded: Bool { false }
    var speakerModelSizeOnDisk: Int64 { 0 }
    func downloadSpeakerModel(progress: @escaping @Sendable (Double) -> Void) async throws { throw unavailable }
    func deleteSpeakerModel() throws { throw unavailable }
    var recordingsDirectory: URL { FileManager.default.temporaryDirectory }
    func repairRecording(at file: URL) {}
    func removeRecording(at file: URL) {}
    func recordedMode(of file: URL) -> MeetingMode? { nil }
    func setSpeakerName(_ name: String?, for speakerId: String) {}
    func startRecording(_ request: MeetingRecordingRequest, onLevel: @escaping @Sendable (MeetingLevels) -> Void, onLive: @escaping @Sendable (MeetingLiveUpdate) -> Void, onFailure: @escaping @Sendable (String) -> Void) async throws -> [String] { throw unavailable }
    func stopRecording() async throws -> MeetingRecordingResult { throw unavailable }
    func cancelRecording() async {}
    func transcribe(file: URL, mode: MeetingMode, modelId: String, language: String, knownSpeakers: [MeetingSpeaker], progress: @escaping @Sendable (Double) -> Void) async throws -> MeetingTranscriptData { throw unavailable }
    func enqueue(target: MeetingDestination, transcript: MeetingTranscriptData, meeting: MeetingDelivery, audio: URL?) async throws -> String { throw unavailable }
    func flush() async {}
    func jobs() async -> [MeetingJobInfo] { [] }
    func removeJobs(profileId: String) async {}
}
