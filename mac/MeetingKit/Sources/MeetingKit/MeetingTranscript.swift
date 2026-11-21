import Foundation

/// The kind of meeting, chosen when the recording starts.
public enum MeetingMode: String, Codable, Sendable, CaseIterable {
    /// Everybody is in the room: only the microphone is recorded.
    case inPerson = "in_person"
    /// A call: the microphone is the room, what the Mac plays is the remote
    /// side. The two are kept as separate tracks.
    case virtual
}

/// Which side of a virtual meeting a sentence came from.
public enum MeetingSide: String, Codable, Sendable, CaseIterable {
    /// The microphone: the person at this Mac and whoever sits with them.
    case room
    /// The system audio: the people on the other side of the call.
    case remote
}

/// A voice of a meeting. The shape the server calls `Speaker`.
public struct MeetingSpeaker: Codable, Equatable, Identifiable, Sendable {
    /// 1 to 40 characters of `[a-z0-9_-]`, unique in the meeting and stable
    /// for its whole life ("s1", "s2", ...).
    public var id: String
    /// For the default label ("Persona 2"): order of first appearance, from 1.
    public var number: Int
    /// Nil in an in-person meeting.
    public var side: MeetingSide?
    /// What the person typed. Nil: the default label. MeetingKit only
    /// carries it; the app sets it.
    public var name: String?

    public init(id: String, number: Int, side: MeetingSide? = nil, name: String? = nil) {
        self.id = id
        self.number = number
        self.side = side
        self.name = name
    }

    private enum CodingKeys: String, CodingKey { case id, number, side, name }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        number = try container.decode(Int.self, forKey: .number)
        side = try container.decodeIfPresent(MeetingSide.self, forKey: .side)
        name = try container.decodeIfPresent(String.self, forKey: .name)
    }

    /// `side` and `name` are always written, as `null` when there is none:
    /// that is the shape of the contract (`side: "room" | "remote" | null`).
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(number, forKey: .number)
        try container.encode(side, forKey: .side)
        try container.encode(name, forKey: .name)
    }

    /// Whether the server takes this as a speaker id.
    public static func isValidId(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 40 && id.range(of: "^[a-z0-9_-]+$", options: .regularExpression) != nil
    }
}

/// The result of transcribing a recording: what the queue stores and what the
/// server receives.
public struct MeetingTranscript: Codable, Equatable, Sendable {
    public struct Segment: Codable, Equatable, Sendable {
        /// Seconds from the start of the recording.
        public var start: Double
        public var end: Double
        public var text: String
        /// The `id` of a speaker in `MeetingTranscript.speakers`. Nil when
        /// voices were not told apart (no speaker models on disk).
        public var speaker: String?
        /// Nil in an in-person meeting.
        public var side: MeetingSide?

        public init(start: Double, end: Double, text: String, speaker: String? = nil, side: MeetingSide? = nil) {
            self.start = start
            self.end = end
            self.text = text
            self.speaker = speaker
            self.side = side
        }
        // Codable is synthesized: `speaker` and `side` are left out of the
        // JSON when nil, so a plain segment is still `{start, end, text}`.
    }

    /// The whole text, segments joined with single spaces.
    public var text: String
    /// Language code as Whisper reports it ("en", "es", ...). Nil when unknown.
    public var language: String?
    /// Length of the audio that was transcribed.
    public var durationSeconds: Double
    public var segments: [Segment]
    /// Nil for a transcript that knows nothing about tracks (what the older
    /// versions made, and what `Transcriber` alone makes).
    public var mode: MeetingMode?
    /// The voices of the meeting, by number. Empty when voices were not told
    /// apart.
    public var speakers: [MeetingSpeaker]

    public init(
        text: String,
        language: String?,
        durationSeconds: Double,
        segments: [Segment],
        mode: MeetingMode? = nil,
        speakers: [MeetingSpeaker] = []
    ) {
        self.text = text
        self.language = language
        self.durationSeconds = durationSeconds
        self.segments = segments
        self.mode = mode
        self.speakers = speakers
    }

    /// Builds a transcript from segments: trims them, drops the empty ones,
    /// orders them by start time and joins the text.
    public init(
        segments: [Segment],
        language: String?,
        durationSeconds: Double,
        mode: MeetingMode? = nil,
        speakers: [MeetingSpeaker] = []
    ) {
        let cleaned = Self.ordered(segments.map {
            var segment = $0
            segment.text = $0.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return segment
        }.filter { !$0.text.isEmpty })
        self.init(
            text: cleaned.map(\.text).joined(separator: " "),
            language: language,
            durationSeconds: durationSeconds,
            segments: cleaned,
            mode: mode,
            speakers: speakers
        )
    }

    /// True when there is nothing worth sending.
    public var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The speaker with this id.
    public func speaker(_ id: String?) -> MeetingSpeaker? {
        guard let id else { return nil }
        return speakers.first { $0.id == id }
    }

    /// Joins several transcripts made of consecutive pieces of one recording
    /// (what `LiveTranscriber` produces). Segment times must already be
    /// relative to the start of the recording.
    public static func joined(_ parts: [MeetingTranscript]) -> MeetingTranscript {
        // the language of the first piece that has text: silence is detected as anything
        let language = parts.first(where: { !$0.isEmpty && $0.language != nil })?.language
            ?? parts.compactMap(\.language).first
        let duration = parts.reduce(0) { $0 + $1.durationSeconds }
        var speakers: [MeetingSpeaker] = []
        for speaker in parts.flatMap(\.speakers) where !speakers.contains(where: { $0.id == speaker.id }) {
            speakers.append(speaker)
        }
        return MeetingTranscript(
            segments: parts.flatMap(\.segments),
            language: language,
            durationSeconds: duration,
            mode: parts.compactMap(\.mode).first,
            speakers: speakers
        )
    }

    /// Segments by start time. Equal starts keep a fixed order (the room
    /// before the remote side, then the order given), so two runs over the
    /// same input give the same transcript.
    static func ordered(_ segments: [Segment]) -> [Segment] {
        func rank(_ side: MeetingSide?) -> Int {
            switch side {
            case .none: return 0
            case .room: return 1
            case .remote: return 2
            }
        }
        return segments.enumerated().sorted { first, second in
            if first.element.start != second.element.start { return first.element.start < second.element.start }
            if rank(first.element.side) != rank(second.element.side) { return rank(first.element.side) < rank(second.element.side) }
            return first.offset < second.offset
        }.map(\.element)
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case text, language, durationSeconds, segments, mode, speakers
    }

    /// Reads what every version wrote: `mode` and `speakers` may be missing.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decode(String.self, forKey: .text)
        language = try container.decodeIfPresent(String.self, forKey: .language)
        durationSeconds = try container.decode(Double.self, forKey: .durationSeconds)
        segments = try container.decode([Segment].self, forKey: .segments)
        mode = try container.decodeIfPresent(MeetingMode.self, forKey: .mode)
        speakers = try container.decodeIfPresent([MeetingSpeaker].self, forKey: .speakers) ?? []
    }

    /// `mode` and `speakers` are written only when there is something in
    /// them: a plain transcript keeps the JSON it always had.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(text, forKey: .text)
        try container.encodeIfPresent(language, forKey: .language)
        try container.encode(durationSeconds, forKey: .durationSeconds)
        try container.encode(segments, forKey: .segments)
        try container.encodeIfPresent(mode, forKey: .mode)
        if !speakers.isEmpty {
            try container.encode(speakers, forKey: .speakers)
        }
    }
}
