import Foundation

/// The part of the recorder that has nothing to do with hardware: blocks of
/// mono audio come in per source at whatever rate the device has, 16 kHz
/// goes out to the WAV file and to the callbacks.
///
/// Two layouts:
/// - mixed: every source added into one channel (what the first version
///   did, still there for callers that ask for it);
/// - separate: one channel per track, the tracks lined up in time. A track
///   whose source is missing or behind is silence.
///
/// Not thread safe: the recorder calls it from its serial queue.
final class RecordingPipeline {
    /// One tenth of a second of the recording.
    struct Batch {
        /// Everything added up, 16 kHz mono.
        var mixed: [Float]
        /// One block per channel of the file, each as long as `mixed`. Nil
        /// in the mixed layout.
        var tracks: [[Float]]?
    }

    /// Audio is handed to `onBatch` in pieces of exactly this size (0.1 s);
    /// only the last piece of a recording is shorter.
    static let batchSamples = MeetingAudioFormat.sampleRateInt / 10

    private let writer: WAVWriter
    private var aligner: SourceAligner
    /// Separate layout: the channel of the file each source goes to.
    private let channelOfSlot: [Int]?
    private let channelCount: Int
    private var resamplers: [StreamResampler?]
    private var peaks: [Float]
    private var ended: [Bool]
    private var mixedBatch: [Float] = []
    private var trackBatches: [[Float]]

    /// Called with each batch.
    var onBatch: ((Batch) -> Void)?
    /// The first write error. After it nothing more is written.
    private(set) var failure: Error?

    /// - Parameter channelOfSlot: nil mixes the sources into the writer's
    ///   single channel; otherwise source `i` is written to channel
    ///   `channelOfSlot[i]` of the writer.
    init(writer: WAVWriter, sourceCount: Int, channelOfSlot: [Int]? = nil) {
        self.writer = writer
        self.channelOfSlot = channelOfSlot
        channelCount = channelOfSlot == nil ? 1 : writer.channels
        aligner = SourceAligner(sourceCount: sourceCount)
        resamplers = Array(repeating: nil, count: sourceCount)
        peaks = Array(repeating: 0, count: sourceCount)
        ended = Array(repeating: false, count: sourceCount)
        trackBatches = Array(repeating: [], count: channelOfSlot == nil ? 0 : writer.channels)
    }

    var durationSeconds: Double { writer.durationSeconds }

    /// Largest absolute sample a source delivered. Zero means it was silent.
    func peak(slot: Int) -> Float { peaks[slot] }

    func ingest(slot: Int, samples: [Float], sampleRate: Double) {
        guard failure == nil, resamplers.indices.contains(slot), !ended[slot], !samples.isEmpty else { return }
        peaks[slot] = max(peaks[slot], AudioMath.peak(samples))
        var converted: [Float] = []
        if let current = resamplers[slot], current.inputSampleRate != sampleRate {
            // the device changed its rate (another microphone, another output)
            converted.append(contentsOf: current.finish())
            resamplers[slot] = nil
        }
        if resamplers[slot] == nil {
            resamplers[slot] = StreamResampler(inputSampleRate: sampleRate)
        }
        guard let resampler = resamplers[slot] else { return }
        converted.append(contentsOf: resampler.process(samples))
        emit(aligner.push(converted, source: slot))
    }

    /// A source that stopped for good while the recording goes on.
    func end(slot: Int) {
        guard resamplers.indices.contains(slot), !ended[slot] else { return }
        ended[slot] = true
        if let tail = resamplers[slot]?.finish(), !tail.isEmpty {
            emit(aligner.push(tail, source: slot))
        }
        emit(aligner.end(source: slot))
    }

    /// Drains everything and closes the file. Returns the duration.
    func finish() throws -> Double {
        for slot in resamplers.indices where !ended[slot] {
            if let tail = resamplers[slot]?.finish(), !tail.isEmpty {
                emit(aligner.push(tail, source: slot))
            }
        }
        emit(aligner.flush())
        if !mixedBatch.isEmpty {
            let rest = Batch(mixed: mixedBatch, tracks: channelOfSlot == nil ? nil : trackBatches)
            mixedBatch = []
            trackBatches = trackBatches.map { _ in [] }
            onBatch?(rest)
        }
        do {
            try writer.finish()
        } catch {
            if failure == nil { failure = error }
        }
        if let failure { throw failure }
        return writer.durationSeconds
    }

    /// `blocks`: one block per source, all of the same length.
    private func emit(_ blocks: [[Float]]) {
        guard let count = blocks.first?.count, count > 0, failure == nil else { return }
        let mixed = SourceMixer.sum(blocks)
        var tracks: [[Float]] = []
        do {
            if let channelOfSlot {
                // each source into its channel; a channel without a source is silence
                tracks = Array(repeating: [Float](repeating: 0, count: count), count: channelCount)
                for (slot, block) in blocks.enumerated() where slot < channelOfSlot.count && tracks.indices.contains(channelOfSlot[slot]) {
                    tracks[channelOfSlot[slot]] = block
                }
                try writer.append(Self.interleave(tracks))
            } else {
                try writer.append(mixed)
            }
        } catch {
            failure = error
            return
        }
        mixedBatch.append(contentsOf: mixed)
        for index in tracks.indices {
            trackBatches[index].append(contentsOf: tracks[index])
        }
        while mixedBatch.count >= Self.batchSamples {
            var batch = Batch(mixed: Array(mixedBatch[0..<Self.batchSamples]), tracks: nil)
            mixedBatch.removeFirst(Self.batchSamples)
            if channelOfSlot != nil {
                batch.tracks = trackBatches.map { Array($0[0..<Self.batchSamples]) }
                for index in trackBatches.indices {
                    trackBatches[index].removeFirst(Self.batchSamples)
                }
            }
            onBatch?(batch)
        }
    }

    /// Channel blocks of equal length to frames (L R L R ...).
    static func interleave(_ channels: [[Float]]) -> [Float] {
        guard let count = channels.first?.count, channels.count > 1 else { return channels.first ?? [] }
        var out = [Float](repeating: 0, count: count * channels.count)
        for (index, channel) in channels.enumerated() {
            for frame in 0..<min(count, channel.count) {
                out[frame * channels.count + index] = channel[frame]
            }
        }
        return out
    }
}
