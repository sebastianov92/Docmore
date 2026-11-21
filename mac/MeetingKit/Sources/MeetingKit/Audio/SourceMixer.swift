import Foundation

/// Lines up blocks that arrive from several sources at their own pace (all
/// at the same sample rate, mono) into pieces that cover the same span of
/// time for every source.
///
/// Each source has a queue. Output is produced for the span every source has
/// delivered. When a source falls more than `maxLagSamples` behind (it
/// stalled, or it died), the others stop waiting for it: their audio goes
/// out and the missing source is filled with silence, so the recording keeps
/// moving.
struct SourceAligner {
    private var queues: [[Float]]
    private var active: [Bool]
    let maxLagSamples: Int

    init(sourceCount: Int, maxLagSamples: Int = MeetingAudioFormat.sampleRateInt / 2) {
        queues = Array(repeating: [], count: max(1, sourceCount))
        active = Array(repeating: true, count: max(1, sourceCount))
        self.maxLagSamples = max(0, maxLagSamples)
    }

    var sourceCount: Int { queues.count }

    /// Samples waiting in the queue of a source.
    func pending(source: Int) -> Int {
        queues[source].count
    }

    /// Adds a block of one source and returns what is ready: one block per
    /// source, all of the same length (empty when nothing is ready).
    mutating func push(_ samples: [Float], source: Int) -> [[Float]] {
        guard queues.indices.contains(source) else { return [] }
        queues[source].append(contentsOf: samples)
        return drain(final: false)
    }

    /// A source that ended: what it has queued still goes out, and the
    /// others no longer wait for it.
    mutating func end(source: Int) -> [[Float]] {
        guard active.indices.contains(source) else { return [] }
        active[source] = false
        return drain(final: false)
    }

    /// Everything that is left, the shorter queues padded with silence.
    mutating func flush() -> [[Float]] {
        drain(final: true)
    }

    private mutating func drain(final: Bool) -> [[Float]] {
        let lengths = queues.map(\.count)
        guard let longest = lengths.max(), longest > 0 else { return [] }
        let count: Int
        if final {
            count = longest
        } else {
            // What every live source has. An ended source only counts while it still has audio.
            let waitingOn = queues.indices.filter { active[$0] }
            let common = waitingOn.map { lengths[$0] }.min() ?? longest
            // Do not let the leader run more than maxLag ahead of the output.
            count = max(common, longest - maxLagSamples)
        }
        guard count > 0 else { return [] }
        var out: [[Float]] = []
        out.reserveCapacity(queues.count)
        for index in queues.indices {
            let take = min(count, queues[index].count)
            var block = take > 0 ? Array(queues[index][0..<take]) : []
            if take > 0 { queues[index].removeFirst(take) }
            if block.count < count {
                block.append(contentsOf: [Float](repeating: 0, count: count - block.count))
            }
            out.append(block)
        }
        return out
    }
}

/// Mixes blocks that arrive from several sources at their own pace into one
/// stream: `SourceAligner`, with the aligned blocks added up.
struct SourceMixer {
    private var aligner: SourceAligner

    var maxLagSamples: Int { aligner.maxLagSamples }

    init(sourceCount: Int, maxLagSamples: Int = MeetingAudioFormat.sampleRateInt / 2) {
        aligner = SourceAligner(sourceCount: sourceCount, maxLagSamples: maxLagSamples)
    }

    /// Samples waiting in the queue of a source.
    func pending(source: Int) -> Int {
        aligner.pending(source: source)
    }

    /// Adds a block of one source and returns the mixed audio that is ready.
    mutating func push(_ samples: [Float], source: Int) -> [Float] {
        Self.sum(aligner.push(samples, source: source))
    }

    /// A source that ended: what it has queued is still mixed, and the others
    /// no longer wait for it.
    mutating func end(source: Int) -> [Float] {
        Self.sum(aligner.end(source: source))
    }

    /// Everything that is left, the shorter queues padded with silence.
    mutating func flush() -> [Float] {
        Self.sum(aligner.flush())
    }

    static func sum(_ blocks: [[Float]]) -> [Float] {
        guard var out = blocks.first else { return [] }
        for block in blocks.dropFirst() {
            out = AudioMath.mix(out, block)
        }
        return out
    }
}
