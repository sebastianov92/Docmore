import Foundation

/// The result of transcribing a recording: what the queue stores and what the
/// server receives.
public struct MeetingTranscript: Codable, Equatable, Sendable {
    public struct Segment: Codable, Equatable, Sendable {
        /// Seconds from the start of the recording.
        public var start: Double
        public var end: Double
        public var text: String

        public init(start: Double, end: Double, text: String) {
            self.start = start
            self.end = end
            self.text = text
        }
    }

    /// The whole text, segments joined with single spaces.
    public var text: String
    /// Language code as Whisper reports it ("en", "es", ...). Nil when unknown.
    public var language: String?
    /// Length of the audio that was transcribed.
    public var durationSeconds: Double
    public var segments: [Segment]

    public init(text: String, language: String?, durationSeconds: Double, segments: [Segment]) {
        self.text = text
        self.language = language
        self.durationSeconds = durationSeconds
        self.segments = segments
    }

    /// Builds a transcript from segments: trims them, drops the empty ones,
    /// orders them by start time and joins the text.
    public init(segments: [Segment], language: String?, durationSeconds: Double) {
        let cleaned = segments
            .map { Segment(start: $0.start, end: $0.end, text: $0.text.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { !$0.text.isEmpty }
            .sorted { $0.start < $1.start }
        self.init(
            text: cleaned.map(\.text).joined(separator: " "),
            language: language,
            durationSeconds: durationSeconds,
            segments: cleaned
        )
    }

    /// True when there is nothing worth sending.
    public var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Joins several transcripts made of consecutive pieces of one recording
    /// (what `LiveTranscriber` produces). Segment times must already be
    /// relative to the start of the recording.
    public static func joined(_ parts: [MeetingTranscript]) -> MeetingTranscript {
        // the language of the first piece that has text: silence is detected as anything
        let language = parts.first(where: { !$0.isEmpty && $0.language != nil })?.language
            ?? parts.compactMap(\.language).first
        let duration = parts.reduce(0) { $0 + $1.durationSeconds }
        return MeetingTranscript(segments: parts.flatMap(\.segments), language: language, durationSeconds: duration)
    }
}
