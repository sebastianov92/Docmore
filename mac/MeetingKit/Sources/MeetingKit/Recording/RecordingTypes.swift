import Foundation

/// Where recorded audio comes from.
public enum AudioSource: String, Codable, Sendable, CaseIterable {
    /// The default input device (the person at this Mac).
    case microphone
    /// Everything the Mac plays (the other participants of a call).
    case systemAudio
}

/// What the system says about a permission, without asking the person.
public enum PermissionStatus: String, Sendable {
    case granted
    case denied
    /// Not asked yet, or the system does not tell.
    case undetermined
}

public struct RecordingOptions: Sendable {
    public var captureMicrophone: Bool
    public var captureSystemAudio: Bool
    /// File name inside the output directory. Nil: "meeting-<date>-<time>.wav".
    public var fileName: String?

    public init(captureMicrophone: Bool = true, captureSystemAudio: Bool = true, fileName: String? = nil) {
        self.captureMicrophone = captureMicrophone
        self.captureSystemAudio = captureSystemAudio
        self.fileName = fileName
    }
}

public enum MeetingRecorderError: Error, LocalizedError, Equatable, Sendable {
    /// Both sources are switched off in the options.
    case nothingToRecord
    case alreadyRecording
    case notRecording
    /// The person refused the microphone (System Settings > Privacy & Security > Microphone).
    case microphonePermissionDenied
    /// No input device, or the audio engine did not start.
    case microphoneUnavailable(String)
    /// The person refused system audio (System Settings > Privacy & Security > Screen & System Audio Recording).
    case systemAudioPermissionDenied
    /// The process tap or its device could not be created or started.
    case systemAudioUnavailable(String)
    /// The source delivered only silence (every sample was zero).
    case silent(AudioSource)
    /// The recording file could not be created or written (disk full, no access).
    case file(String)

    public var errorDescription: String? {
        switch self {
        case .nothingToRecord:
            return "Neither the microphone nor system audio is selected."
        case .alreadyRecording:
            return "A recording is already running."
        case .notRecording:
            return "No recording is running."
        case .microphonePermissionDenied:
            return "Microphone access is off for this app. Turn it on in System Settings > Privacy & Security > Microphone."
        case .microphoneUnavailable(let detail):
            return "The microphone is not available: \(detail)"
        case .systemAudioPermissionDenied:
            return "System audio recording is off for this app. Turn it on in System Settings > Privacy & Security > Screen & System Audio Recording."
        case .systemAudioUnavailable(let detail):
            return "System audio is not available: \(detail)"
        case .silent(let source):
            switch source {
            case .microphone:
                return "The microphone delivered only silence. Check that it is not muted and that microphone access is on."
            case .systemAudio:
                return "No system audio was captured: nothing played, or system audio recording is off for this app."
            }
        case .file(let detail):
            return "The recording could not be saved: \(detail)"
        }
    }
}

/// Something that went wrong with one source while the recording as a whole
/// went on.
public struct RecordingWarning: Equatable, Sendable {
    public var source: AudioSource
    public var error: MeetingRecorderError

    public init(source: AudioSource, error: MeetingRecorderError) {
        self.source = source
        self.error = error
    }
}

public struct RecordingResult: Sendable {
    /// 16 kHz mono 16-bit PCM WAV.
    public var fileURL: URL
    public var durationSeconds: Double
    /// The sources whose audio is really in the file. A source that failed to
    /// start, or that delivered only silence, is not here: see `warnings`.
    public var sources: [AudioSource]
    public var warnings: [RecordingWarning]

    public init(fileURL: URL, durationSeconds: Double, sources: [AudioSource], warnings: [RecordingWarning]) {
        self.fileURL = fileURL
        self.durationSeconds = durationSeconds
        self.sources = sources
        self.warnings = warnings
    }
}
