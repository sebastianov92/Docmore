import Foundation

/// The part of the recorder that has nothing to do with hardware: blocks of
/// mono audio come in per source at whatever rate the device has, 16 kHz mono
/// goes out to the WAV file and to the callbacks.
///
/// Not thread safe: the recorder calls it from its serial queue.
final class RecordingPipeline {
    /// Mixed audio is handed to `onBatch` in pieces of exactly this size
    /// (0.1 s); only the last piece of a recording is shorter.
    static let batchSamples = MeetingAudioFormat.sampleRateInt / 10

    private let writer: WAVWriter
    private var mixer: SourceMixer
    private var resamplers: [StreamResampler?]
    private var peaks: [Float]
    private var ended: [Bool]
    private var batch: [Float] = []

    /// Called with each batch of mixed 16 kHz mono audio.
    var onBatch: (([Float]) -> Void)?
    /// The first write error. After it nothing more is written.
    private(set) var failure: Error?

    init(writer: WAVWriter, sourceCount: Int) {
        self.writer = writer
        mixer = SourceMixer(sourceCount: sourceCount)
        resamplers = Array(repeating: nil, count: sourceCount)
        peaks = Array(repeating: 0, count: sourceCount)
        ended = Array(repeating: false, count: sourceCount)
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
        emit(mixer.push(converted, source: slot))
    }

    /// A source that stopped for good while the recording goes on.
    func end(slot: Int) {
        guard resamplers.indices.contains(slot), !ended[slot] else { return }
        ended[slot] = true
        if let tail = resamplers[slot]?.finish(), !tail.isEmpty {
            emit(mixer.push(tail, source: slot))
        }
        emit(mixer.end(source: slot))
    }

    /// Drains everything and closes the file. Returns the duration.
    func finish() throws -> Double {
        for slot in resamplers.indices where !ended[slot] {
            if let tail = resamplers[slot]?.finish(), !tail.isEmpty {
                emit(mixer.push(tail, source: slot))
            }
        }
        emit(mixer.flush())
        if !batch.isEmpty {
            let rest = batch
            batch = []
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

    private func emit(_ mixed: [Float]) {
        guard !mixed.isEmpty, failure == nil else { return }
        do {
            try writer.append(mixed)
        } catch {
            failure = error
            return
        }
        batch.append(contentsOf: mixed)
        while batch.count >= Self.batchSamples {
            let ready = Array(batch[0..<Self.batchSamples])
            batch.removeFirst(Self.batchSamples)
            onBatch?(ready)
        }
    }
}
