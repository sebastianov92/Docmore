import Foundation

/// Removes from the room track what is only the remote side coming out of
/// the loudspeakers.
///
/// In a virtual meeting without headphones the microphone hears the call,
/// so every remote sentence is transcribed twice (once per track) and the
/// remote voices show up as extra speakers in the room. This pass works on
/// text alone and is deterministic: a room segment is dropped when most of
/// its words are found, in the same order and at about the same time, in
/// what the remote track says. What only the room said has no such match
/// and is never dropped.
///
/// It is a text pass, not an echo canceller: the audio is left alone.
public enum EchoFilter {
    public struct Policy: Equatable, Sendable {
        /// Share of a room segment's text (counted in letters) that has to
        /// be found on the remote track for the segment to be an echo.
        public var coverage: Double = 0.7
        /// The same for the segments of a room voice most of whose text
        /// already turned out to be echo (that voice is the loudspeaker;
        /// Whisper heard this one sentence a little differently).
        public var echoVoiceCoverage: Double = 0.4
        /// Share of a voice's text that must be echo for that.
        public var echoVoiceShare: Double = 0.6
        /// Seconds between a room word and the remote word it repeats.
        /// Covers the delay of the loudspeaker path and the slack of
        /// Whisper's word times.
        public var tolerance: Double = 1.5
        /// The same when the time of a word is only estimated from its
        /// segment (no word times).
        public var looseTolerance: Double = 4
        /// A segment of one or two words is an echo only when every word is
        /// found this close in time: short answers ("Sí.") are easily said
        /// by both sides.
        public var shortTolerance: Double = 0.8

        public init() {}
    }

    public struct Result: Equatable, Sendable {
        /// The room segments that stay, in their order.
        public var kept: [LabelledSegment]
        /// The room segments that were echo.
        public var dropped: [LabelledSegment]
    }

    public static func removeEcho(room: [LabelledSegment], remote: [LabelledSegment], policy: Policy = Policy()) -> Result {
        guard !room.isEmpty, !remote.isEmpty else { return Result(kept: room, dropped: []) }
        let stream = remote.flatMap(tokens(of:)).sorted { $0.time < $1.time }
        let roomTokens = room.map(tokens(of:))
        let coverages = roomTokens.map { coverage(of: $0, in: stream, policy: policy) }

        func isEcho(_ index: Int, threshold: Double) -> Bool {
            let own = roomTokens[index]
            guard !own.isEmpty else { return false }
            if own.count <= 2 {
                // every word, close in time
                return coverage(of: own, in: stream, policy: policy, tolerance: policy.shortTolerance) >= 0.999
            }
            return coverages[index] >= threshold
        }

        var echo = room.indices.map { isEcho($0, threshold: policy.coverage) }

        // A voice most of whose text is echo is the loudspeaker: its other
        // segments need less evidence. They still need some.
        var total: [String: Double] = [:]
        var echoed: [String: Double] = [:]
        for index in room.indices {
            guard let speaker = room[index].speaker else { continue }
            let weight = roomTokens[index].reduce(0) { $0 + $1.weight }
            total[speaker, default: 0] += weight
            if echo[index] { echoed[speaker, default: 0] += weight }
        }
        for index in room.indices where !echo[index] {
            guard let speaker = room[index].speaker, let all = total[speaker], all > 0,
                  (echoed[speaker] ?? 0) / all >= policy.echoVoiceShare else { continue }
            echo[index] = isEcho(index, threshold: policy.echoVoiceCoverage)
        }

        var result = Result(kept: [], dropped: [])
        for index in room.indices {
            if echo[index] {
                result.dropped.append(room[index])
            } else {
                result.kept.append(room[index])
            }
        }
        return result
    }

    // MARK: - Words

    struct Token: Equatable {
        var text: String
        var time: Double
        /// False when the time is only estimated from the segment.
        var timed: Bool
        var weight: Double
    }

    /// Lower case, no accents, no punctuation: "¿Cuándo?" -> ["cuando"].
    static func normalize(_ text: String) -> [String] {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }

    static func tokens(of segment: LabelledSegment) -> [Token] {
        if !segment.words.isEmpty {
            return segment.words.flatMap { word in
                normalize(word.text).map { Token(text: $0, time: word.start, timed: true, weight: Double(max(1, $0.count))) }
            }
        }
        let words = normalize(segment.text)
        let duration = max(0, segment.end - segment.start)
        return words.enumerated().map { index, word in
            let time = segment.start + duration * (Double(index) + 0.5) / Double(words.count)
            return Token(text: word, time: time, timed: false, weight: Double(max(1, word.count)))
        }
    }

    /// The same word, give or take a letter in long words (Whisper hears
    /// the quieter copy slightly differently now and then).
    static func sameWord(_ first: String, _ second: String) -> Bool {
        if first == second { return true }
        let shorter = min(first.count, second.count)
        guard shorter >= 5, abs(first.count - second.count) <= 2 else { return false }
        return editDistance(first, second) <= (shorter >= 8 ? 2 : 1)
    }

    static func editDistance(_ first: String, _ second: String) -> Int {
        let a = Array(first)
        let b = Array(second)
        if a.isEmpty { return b.count }
        if b.isEmpty { return a.count }
        var previous = Array(0...b.count)
        var current = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            current[0] = i
            for j in 1...b.count {
                let substitution = previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)
                current[j] = min(substitution, previous[j] + 1, current[j - 1] + 1)
            }
            swap(&previous, &current)
        }
        return previous[b.count]
    }

    /// Share (by letters) of `own` found in `stream` in the same order and
    /// close in time: the heaviest common subsequence over the pairs that
    /// are the same word within the tolerance.
    static func coverage(of own: [Token], in stream: [Token], policy: Policy, tolerance fixed: Double? = nil) -> Double {
        let total = own.reduce(0) { $0 + $1.weight }
        guard total > 0, let first = own.first, let last = own.last else { return 0 }
        let reach = max(policy.tolerance, policy.looseTolerance)
        // `stream` is ordered by time: the stretch around this segment, found by halving
        var low = 0
        var high = stream.count
        while low < high {
            let middle = (low + high) / 2
            if stream[middle].time < first.time - reach { low = middle + 1 } else { high = middle }
        }
        var end = low
        while end < stream.count, stream[end].time <= last.time + reach { end += 1 }
        guard end > low else { return 0 }
        let near = stream[low..<end]
        var best = [Double](repeating: 0, count: near.count + 1)
        for token in own {
            var row = best
            for (index, candidate) in near.enumerated() {
                let allowed = fixed ?? ((token.timed && candidate.timed) ? policy.tolerance : policy.looseTolerance)
                var value = max(best[index + 1], row[index])
                if abs(candidate.time - token.time) <= allowed, sameWord(token.text, candidate.text) {
                    value = max(value, best[index] + token.weight)
                }
                row[index + 1] = value
            }
            best = row
        }
        return (best.last ?? 0) / total
    }
}
