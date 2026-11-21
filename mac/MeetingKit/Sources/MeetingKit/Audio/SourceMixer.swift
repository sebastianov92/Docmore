import Foundation

/// Mixes blocks that arrive from several sources at their own pace into one
/// stream (all at the same sample rate, mono).
///
/// Each source has a queue. Output is produced for the span every source has
/// delivered. When a source falls more than `maxLagSamples` behind (it
/// stalled, or it died), the others stop waiting for it and their audio goes
/// out alone, so the recording keeps moving.
struct SourceMixer {
    private var queues: [[Float]]
    private var active: [Bool]
    let maxLagSamples: Int

    init(sourceCount: Int, maxLagSamples: Int = MeetingAudioFormat.sampleRateInt / 2) {
        queues = Array(repeating: [], count: max(1, sourceCount))
        active = Array(repeating: true, count: max(1, sourceCount))
        self.maxLagSamples = max(0, maxLagSamples)
    }

    /// Samples waiting in the queue of a source.
    func pending(source: Int) -> Int {
        queues[source].count
    }

    /// Adds a block of one source and returns the mixed audio that is ready.
    mutating func push(_ samples: [Float], source: Int) -> [Float] {
        guard queues.indices.contains(source) else { return [] }
        queues[source].append(contentsOf: samples)
        return drain(final: false)
    }

    /// A source that ended: what it has queued is still mixed, and the others
    /// no longer wait for it.
    mutating func end(source: Int) -> [Float] {
        guard active.indices.contains(source) else { return [] }
        active[source] = false
        return drain(final: false)
    }

    /// Everything that is left, the shorter queues padded with silence.
    mutating func flush() -> [Float] {
        drain(final: true)
    }

    private mutating func drain(final: Bool) -> [Float] {
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
        var out: [Float] = []
        for index in queues.indices {
            let take = min(count, queues[index].count)
            guard take > 0 else { continue }
            let block = Array(queues[index][0..<take])
            queues[index].removeFirst(take)
            out = out.isEmpty ? block : AudioMath.mix(out, block)
        }
        if out.count < count {
            out.append(contentsOf: [Float](repeating: 0, count: count - out.count))
        }
        return out
    }
}
