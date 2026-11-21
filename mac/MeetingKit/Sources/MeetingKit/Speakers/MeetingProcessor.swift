import Foundation

/// The audio of a recording, track by track, as 16 kHz mono samples.
public struct MeetingTracks: Sendable {
    /// The microphone: the room in a virtual meeting, everybody in person.
    public var room: [Float]
    /// The system audio (the remote side). Nil for a one-track recording.
    public var remote: [Float]?

    public init(room: [Float], remote: [Float]? = nil) {
        self.room = room
        self.remote = remote
    }

    /// Reads a recording. Two channels: channel 0 is the room, channel 1
    /// the remote side (what `MeetingRecorder` writes in virtual mode). One
    /// channel: a single track (in person, or a recording of an older
    /// version that mixed both sources).
    public init(contentsOf url: URL) throws {
        let channels = try AudioTrackReader.channels(of: url)
        switch channels.count {
        case 0: self.init(room: [])
        case 1: self.init(room: channels[0])
        default: self.init(room: channels[0], remote: channels[1])
        }
    }

    /// Reads the two tracks from separate files (each mixed down to mono).
    public init(microphone: URL, systemAudio: URL?) throws {
        let room = try AudioTrackReader.samples(of: microphone)
        guard let systemAudio else {
            self.init(room: room)
            return
        }
        var remote = try AudioTrackReader.samples(of: systemAudio)
        var padded = room
        // the same length, so times mean the same on both
        if remote.count < padded.count { remote.append(contentsOf: [Float](repeating: 0, count: padded.count - remote.count)) }
        if padded.count < remote.count { padded.append(contentsOf: [Float](repeating: 0, count: remote.count - padded.count)) }
        self.init(room: padded, remote: remote)
    }

    public var durationSeconds: Double {
        Double(max(room.count, remote?.count ?? 0)) / MeetingAudioFormat.sampleRate
    }

    /// Everything in one track (the sum of both).
    public var mixed: [Float] {
        guard let remote else { return room }
        return AudioMath.mix(room, remote)
    }
}

public struct MeetingProcessingOptions: Equatable, Sendable {
    public var diarization = DiarizationOptions.meeting
    public var matching = SpeakerMatchingPolicy()
    public var attribution = SpeakerAttribution.Policy()
    public var echo = EchoFilter.Policy()
    /// Drop from the room track what is only the remote side heard through
    /// the loudspeakers (virtual meetings): as text (`EchoFilter`), and in
    /// what the speaker models listen to (`EchoGate`).
    public var removesEcho = true
    /// Tests with made-up audio switch the audio half of that off.
    var usesEchoGate = true

    public init() {}
}

/// What `MeetingProcessor` makes of a recording.
public struct ProcessedMeeting: Sendable {
    /// With mode, sides and, when the speaker models are on disk, speakers.
    public var transcript: MeetingTranscript
    /// The speakers as they are now, to keep with the recording (names can
    /// still be set on it and it can seed another pass).
    public var state: MeetingSpeakerState
    /// The room segments the echo pass dropped (virtual meetings).
    public var echoes: [MeetingTranscript.Segment]
    /// Things worth telling the person: no speaker models, a track that
    /// could not be diarized, a one-track recording asked as virtual.
    public var notes: [String]
    /// Seconds spent, for measurements.
    public var transcriptionSeconds: Double
    public var diarizationSeconds: Double
}

/// The final pass over a finished recording: transcribes each track, tells
/// the voices of each track apart, gives every segment its side and its
/// speaker, removes the echo of the remote side from the room track and
/// merges the tracks by time.
///
/// ```swift
/// let processor = MeetingProcessor(transcriber: transcriber, diarizer: SpeakerDiarizer(modelStore: store))
/// let result = try await processor.process(fileURL: recording.fileURL, mode: .virtual, state: live.state)
/// try queue.enqueue(result.transcript, target: target, meetingId: liveMeetingId)
/// ```
///
/// With `state` from the live session of the same recording, the speakers
/// keep the ids, numbers and names they had while the meeting ran. Without
/// speaker models on disk (or with `diarizer` nil) the transcript has no
/// speakers: segments carry only their side.
public final class MeetingProcessor: @unchecked Sendable {
    private let transcriber: WordTranscribing
    private let diarizer: SampleDiarizing?
    public let options: MeetingProcessingOptions

    public init(transcriber: WordTranscribing, diarizer: SampleDiarizing?, options: MeetingProcessingOptions = MeetingProcessingOptions()) {
        self.transcriber = transcriber
        self.diarizer = diarizer
        self.options = options
    }

    /// Processes a recording file (see `MeetingTracks.init(contentsOf:)`).
    public func process(
        fileURL: URL,
        mode: MeetingMode,
        state: MeetingSpeakerState? = nil,
        progress: ((Double) -> Void)? = nil
    ) async throws -> ProcessedMeeting {
        let tracks: MeetingTracks
        do {
            tracks = try MeetingTracks(contentsOf: fileURL)
        } catch {
            throw TranscriptionError.audioUnreadable(error.localizedDescription)
        }
        return try await process(tracks, mode: mode, state: state, progress: progress)
    }

    /// Processes the tracks of a recording. `progress` gets 0...1 from an
    /// arbitrary thread.
    public func process(
        _ tracks: MeetingTracks,
        mode requested: MeetingMode,
        state seed: MeetingSpeakerState? = nil,
        progress: ((Double) -> Void)? = nil
    ) async throws -> ProcessedMeeting {
        var notes: [String] = []
        let duration = tracks.durationSeconds

        // What there is to work with decides the mode in the end.
        var mode = requested
        var audio: [[Float]]
        switch (requested, tracks.remote) {
        case (.virtual, .some(let remote)):
            audio = [tracks.room, remote]
        case (.virtual, .none):
            mode = .inPerson
            audio = [tracks.room]
            notes.append("The recording has one track: it has no sides and was processed as an in-person meeting.")
        case (.inPerson, .some):
            audio = [tracks.mixed]
        case (.inPerson, .none):
            audio = [tracks.room]
        }

        var state = MeetingSpeakerState(mode: mode)
        if let seed {
            if seed.mode == mode, seed.tracks.count == audio.count {
                state = seed
            } else {
                notes.append("The speakers of the live session were for another kind of meeting and were not used.")
            }
        }

        let canDiarize = diarizer?.isAvailable ?? false
        if diarizer != nil, !canDiarize {
            notes.append("The speaker models are not downloaded: the transcript has no speakers.")
        }

        progress?(0)
        var language: String?
        var transcriptionSeconds = 0.0
        var diarizationSeconds = 0.0
        var labelled: [[LabelledSegment]] = []
        var placeholders: [String: MeetingSide?] = [:]
        var waitingNames: [String: String] = [:]
        var hadSpeakers = false

        for (index, samples) in audio.enumerated() {
            let side = state.tracks[index].side
            let base = Double(index) / Double(audio.count)
            let share = 1 / Double(audio.count)

            // 1. Text, with the time of every word.
            var timed = TimedTranscript(language: language, durationSeconds: duration, segments: [])
            if AudioMath.peak(samples) >= Self.silencePeak {
                let started = Date()
                timed = try await transcribe(samples, language: language) { fraction in
                    progress?(base + share * 0.85 * fraction)
                }
                transcriptionSeconds += Date().timeIntervalSince(started)
                if language == nil, !timed.isEmpty { language = timed.language }
            }
            progress?(base + share * 0.85)

            // 2. Who speaks when.
            if canDiarize, let diarizer, !timed.isEmpty {
                let started = Date()
                do {
                    // the room track is heard without the echo of the remote side
                    var heard = samples
                    if options.removesEcho, options.usesEchoGate, mode == .virtual, index == 0, audio.count > 1 {
                        heard = EchoGate.suppress(microphone: samples, remote: audio[1]).samples
                    }
                    let diarization = try await diarizer.diarize(samples: heard, options: options.diarization)
                    let outcome = state.tracks[index].absorb(
                        diarization, from: 0, to: max(duration, diarization.durationSeconds),
                        policy: options.matching, named: state.namedIds, final: true
                    ) {
                        let id = "new-\(index)-\(placeholders.count)"
                        placeholders[id] = side
                        return id
                    }
                    Self.inheritNames(outcome, into: &state, waiting: &waitingNames)
                    hadSpeakers = true
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    notes.append("The voices of the \(Self.trackName(side)) could not be told apart: \(error.localizedDescription)")
                    state.tracks[index] = TrackSpeakers(side: side)
                }
                diarizationSeconds += Date().timeIntervalSince(started)
            } else {
                // no diarization of this track: what the live session thought does not apply to the final text
                state.tracks[index] = TrackSpeakers(side: side)
            }
            labelled.append(SpeakerAttribution.label(timed.segments, speakers: state.tracks[index], policy: options.attribution))
            progress?(base + share)
        }

        // 3. Echo, merge, and the speakers that are left.
        let assembly = MeetingAssembler.assemble(tracks: labelled, removeEcho: options.removesEcho && mode == .virtual, echoPolicy: options.echo)

        // New speakers get their id and number now, in order of first
        // appearance; the ones known from the live session keep theirs.
        var renames: [String: String] = [:]
        for id in assembly.speakersInOrder where placeholders[id] != nil {
            let made = state.makeSpeaker(side: placeholders[id] ?? nil)
            renames[id] = made
            if let name = waitingNames[id] { state.setName(name, for: made) }
        }
        for index in state.tracks.indices {
            state.tracks[index].rename(renames)
        }
        // Speakers left with no text are dropped: echoes, and voices of the live session that are gone.
        let withText = Set(assembly.speakersInOrder.map { renames[$0] ?? $0 })
        var gone = Set(state.speakers.map(\.id)).subtracting(withText)
        gone.formUnion(placeholders.keys.filter { renames[$0] == nil })
        state.removeSpeakers(gone)
        state.speakers.sort { $0.number < $1.number }

        let segments = assembly.segments.map { segment -> MeetingTranscript.Segment in
            var copy = segment
            copy.speaker = segment.speaker.map { renames[$0] ?? $0 }
            return copy
        }
        let echoes = assembly.echoes.map { segment -> MeetingTranscript.Segment in
            var copy = segment
            copy.speaker = nil
            return copy
        }
        let transcript = MeetingTranscript(
            segments: segments,
            language: language,
            durationSeconds: duration,
            mode: mode,
            speakers: hadSpeakers ? state.speakers : []
        )
        progress?(1)
        return ProcessedMeeting(
            transcript: transcript,
            state: state,
            echoes: echoes,
            notes: notes,
            transcriptionSeconds: transcriptionSeconds,
            diarizationSeconds: diarizationSeconds
        )
    }

    // MARK: - Internals

    /// Below this peak (about -54 dBFS) a track is silence: a system audio
    /// track nobody played anything on, a muted microphone.
    static let silencePeak: Float = 0.002

    private func transcribe(_ samples: [Float], language: String?, progress: @escaping (Double) -> Void) async throws -> TimedTranscript {
        if let real = transcriber as? Transcriber {
            return try await real.transcribeWords(samples: samples, language: language, progress: progress)
        }
        return try await transcriber.transcribeWords(samples: samples, language: language)
    }

    /// A name typed on a voice that turned out to be part of another one
    /// goes to that one, unless it has a name already. `waiting` collects
    /// the names for speakers that have no entry yet.
    static func inheritNames(_ outcome: TrackSpeakers.Outcome, into state: inout MeetingSpeakerState, waiting: inout [String: String]) {
        for id in outcome.retired {
            guard let name = state.speakers.first(where: { $0.id == id })?.name, let heir = outcome.absorbedBy[id] else { continue }
            if let index = state.speakers.firstIndex(where: { $0.id == heir }) {
                if state.speakers[index].name == nil { state.speakers[index].name = name }
            } else if waiting[heir] == nil {
                waiting[heir] = name
            }
        }
        state.speakers.removeAll { outcome.retired.contains($0.id) }
    }

    private static func trackName(_ side: MeetingSide?) -> String {
        switch side {
        case .room: return "room track"
        case .remote: return "remote track"
        case .none: return "recording"
        }
    }
}
