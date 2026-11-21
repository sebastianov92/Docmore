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
    /// The kind of meeting. Nil is the layout of the first version: the
    /// sources that are switched on, mixed into one channel.
    public private(set) var mode: MeetingMode?

    /// The mixed layout: one channel with every source that is switched on
    /// added up. Nobody can tell afterwards which side a sentence came from.
    public init(captureMicrophone: Bool = true, captureSystemAudio: Bool = true, fileName: String? = nil) {
        self.captureMicrophone = captureMicrophone
        self.captureSystemAudio = captureSystemAudio
        self.fileName = fileName
        mode = nil
    }

    /// A meeting of one of the two kinds:
    /// - `.inPerson`: the microphone alone, one channel;
    /// - `.virtual`: the microphone (the room) and the system audio (the
    ///   remote side) as two separate, time-aligned tracks: a two-channel
    ///   file, channel 0 the microphone, channel 1 the system audio. The
    ///   remote side is never taken from the microphone.
    public init(mode: MeetingMode, fileName: String? = nil) {
        captureMicrophone = true
        captureSystemAudio = mode == .virtual
        self.fileName = fileName
        self.mode = mode
    }

    /// Whether the tracks are kept apart (a two-channel file).
    public var keepsTracksApart: Bool { mode == .virtual }
}

/// A tenth of a second of a running recording, track by track: what
/// `LiveMeetingSession.append` takes.
public struct MeetingAudioChunk: Sendable {
    /// The microphone (the room), 16 kHz mono.
    public var microphone: [Float]
    /// The system audio (the remote side), 16 kHz mono, as long as
    /// `microphone` and covering the same span of time. Nil when the
    /// recording has one track. Silence when the source is missing.
    public var systemAudio: [Float]?

    public init(microphone: [Float], systemAudio: [Float]? = nil) {
        self.microphone = microphone
        self.systemAudio = systemAudio
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
    /// 16 kHz 16-bit PCM WAV: one channel, or two for a virtual meeting
    /// (channel 0 the microphone, channel 1 the system audio).
    public var fileURL: URL
    public var durationSeconds: Double
    /// The sources whose audio is really in the file. A source that failed to
    /// start, or that delivered only silence, is not here: see `warnings`.
    /// In a virtual recording the channel of a missing source is silence.
    public var sources: [AudioSource]
    public var warnings: [RecordingWarning]
    /// The mode the recording was made in. Nil for the mixed layout.
    public var mode: MeetingMode?

    public init(fileURL: URL, durationSeconds: Double, sources: [AudioSource], warnings: [RecordingWarning], mode: MeetingMode? = nil) {
        self.fileURL = fileURL
        self.durationSeconds = durationSeconds
        self.sources = sources
        self.warnings = warnings
        self.mode = mode
    }
}
