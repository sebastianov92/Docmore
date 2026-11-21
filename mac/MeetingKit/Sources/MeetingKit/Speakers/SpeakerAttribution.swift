import Foundation

/// A piece of one track's transcript with the speaker it was given.
public struct LabelledSegment: Equatable, Sendable {
    public var start: Double
    public var end: Double
    public var text: String
    /// Empty when word times are not known.
    public var words: [TimedWord]
    public var speaker: String?
    public var side: MeetingSide?

    public init(start: Double, end: Double, text: String, words: [TimedWord] = [], speaker: String? = nil, side: MeetingSide? = nil) {
        self.start = start
        self.end = end
        self.text = text
        self.words = words
        self.speaker = speaker
        self.side = side
    }

    var plain: MeetingTranscript.Segment {
        MeetingTranscript.Segment(start: start, end: end, text: text, speaker: speaker, side: side)
    }
}

/// Gives the transcript of a track its speakers.
public enum SpeakerAttribution {
    public struct Policy: Equatable, Sendable {
        /// A word that falls in no turn takes the nearest turn when it is
        /// this close (seconds); Whisper's word times are good to a few
        /// tenths of a second.
        public var wordReach: Double = 0.6
        /// A segment without word times takes the nearest turn when it is
        /// this close.
        public var segmentReach: Double = 1.0
        /// A segment is split between two voices only when each part has at
        /// least this many words and lasts at least this long: anything
        /// smaller is the edge of a turn falling a little off, not a second
        /// voice.
        public var minSplitWords: Int = 2
        public var minSplitSeconds: Double = 0.7

        public init() {}
    }

    /// Each segment gets the speaker who talks the most in it. When the
    /// words of a segment clearly belong to two voices (an answer that
    /// Whisper glued to the question), the segment is split at the word
    /// where the voice changes.
    public static func label(
        _ segments: [TimedTranscript.Segment],
        speakers: TrackSpeakers,
        policy: Policy = Policy()
    ) -> [LabelledSegment] {
        var out: [LabelledSegment] = []
        for segment in segments {
            let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let words = segment.words
            if speakers.turns.isEmpty {
                out.append(LabelledSegment(start: segment.start, end: segment.end, text: text, words: words, speaker: nil, side: speakers.side))
                continue
            }
            let parts = words.count >= 2 * policy.minSplitWords ? split(words, speakers: speakers, policy: policy) : []
            if parts.count > 1 {
                for part in parts {
                    let partText = part.words.map(\.text).joined().trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !partText.isEmpty, let first = part.words.first, let last = part.words.last else { continue }
                    out.append(LabelledSegment(start: first.start, end: max(first.start, last.end), text: partText,
                                               words: part.words, speaker: part.speaker, side: speakers.side))
                }
            } else {
                let speaker = speakers.speaker(from: segment.start, to: max(segment.end, segment.start + 0.01))?.id
                    ?? speakers.nearestSpeaker(to: (segment.start + segment.end) / 2, within: policy.segmentReach + (segment.end - segment.start) / 2)
                out.append(LabelledSegment(start: segment.start, end: segment.end, text: text, words: words, speaker: speaker, side: speakers.side))
            }
        }
        return out
    }

    private struct Part {
        var speaker: String?
        var words: [TimedWord]
    }

    /// The words of a segment grouped by voice, small groups folded into
    /// their neighbours. One group: nothing to split.
    private static func split(_ words: [TimedWord], speakers: TrackSpeakers, policy: Policy) -> [Part] {
        var owners: [String?] = words.map { word in
            speakers.speaker(from: word.start, to: max(word.end, word.start + 0.01))?.id
                ?? speakers.nearestSpeaker(to: (word.start + word.end) / 2, within: policy.wordReach)
        }
        // a word in no turn goes with the word before it (or, at the start, after it)
        for index in owners.indices where owners[index] == nil {
            if index > 0 { owners[index] = owners[index - 1] }
        }
        for index in owners.indices.reversed() where owners[index] == nil {
            if index + 1 < owners.count { owners[index] = owners[index + 1] }
        }
        var parts: [Part] = []
        for (word, owner) in zip(words, owners) {
            if let last = parts.indices.last, parts[last].speaker == owner {
                parts[last].words.append(word)
            } else {
                parts.append(Part(speaker: owner, words: [word]))
            }
        }
        // fold the parts that are too small to be a voice of their own, smallest first
        func isSmall(_ part: Part) -> Bool {
            guard let first = part.words.first, let last = part.words.last else { return true }
            return part.words.count < policy.minSplitWords || last.end - first.start < policy.minSplitSeconds
        }
        while parts.count > 1, let index = parts.indices.filter({ isSmall(parts[$0]) }).min(by: { parts[$0].words.count < parts[$1].words.count }) {
            let into: Int
            if index == 0 {
                into = 1
            } else if index == parts.count - 1 {
                into = index - 1
            } else {
                // the longer neighbour takes it
                into = parts[index - 1].words.count >= parts[index + 1].words.count ? index - 1 : index + 1
            }
            if into < index {
                parts[into].words.append(contentsOf: parts[index].words)
            } else {
                parts[into].words.insert(contentsOf: parts[index].words, at: 0)
            }
            parts.remove(at: index)
            // neighbours that now have the same voice become one
            var merged: [Part] = []
            for part in parts {
                if let last = merged.indices.last, merged[last].speaker == part.speaker {
                    merged[last].words.append(contentsOf: part.words)
                } else {
                    merged.append(part)
                }
            }
            parts = merged
        }
        return parts
    }
}
