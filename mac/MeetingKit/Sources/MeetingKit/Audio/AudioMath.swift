import Accelerate
import AVFoundation
import Foundation

/// The format everything in MeetingKit converges to: 16 kHz mono Float32,
/// which is what Whisper reads.
public enum MeetingAudioFormat {
    public static let sampleRate: Double = 16_000
    public static let sampleRateInt: Int = 16_000
}

/// Small, pure audio helpers.
public enum AudioMath {
    /// Averages the channels of a non-interleaved buffer.
    static func downmix(channels: [UnsafePointer<Float>], frames: Int) -> [Float] {
        guard frames > 0, let first = channels.first else { return [] }
        var mono = [Float](repeating: 0, count: frames)
        if channels.count == 1 {
            mono.withUnsafeMutableBufferPointer { $0.baseAddress!.update(from: first, count: frames) }
            return mono
        }
        mono.withUnsafeMutableBufferPointer { out in
            for channel in channels {
                vDSP_vadd(out.baseAddress!, 1, channel, 1, out.baseAddress!, 1, vDSP_Length(frames))
            }
            var scale = 1 / Float(channels.count)
            vDSP_vsmul(out.baseAddress!, 1, &scale, out.baseAddress!, 1, vDSP_Length(frames))
        }
        return mono
    }

    /// Averages the channels of an interleaved buffer.
    public static func downmix(interleaved: UnsafePointer<Float>, frames: Int, channels: Int) -> [Float] {
        guard frames > 0, channels > 0 else { return [] }
        var mono = [Float](repeating: 0, count: frames)
        mono.withUnsafeMutableBufferPointer { out in
            for channel in 0..<channels {
                vDSP_vadd(out.baseAddress!, 1, interleaved.advanced(by: channel), vDSP_Stride(channels), out.baseAddress!, 1, vDSP_Length(frames))
            }
            if channels > 1 {
                var scale = 1 / Float(channels)
                vDSP_vsmul(out.baseAddress!, 1, &scale, out.baseAddress!, 1, vDSP_Length(frames))
            }
        }
        return mono
    }

    /// Averages the channels of an interleaved array.
    public static func downmix(interleaved samples: [Float], channels: Int) -> [Float] {
        guard channels > 1 else { return samples }
        return samples.withUnsafeBufferPointer {
            downmix(interleaved: $0.baseAddress!, frames: samples.count / channels, channels: channels)
        }
    }

    /// Mono samples of an `AVAudioPCMBuffer` in Float32 (what `AVAudioEngine`
    /// taps deliver). Returns an empty array for other sample formats.
    public static func mono(from buffer: AVAudioPCMBuffer) -> [Float] {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let data = buffer.floatChannelData else { return [] }
        let channelCount = Int(buffer.format.channelCount)
        if buffer.format.isInterleaved {
            return downmix(interleaved: UnsafePointer(data[0]), frames: frames, channels: channelCount)
        }
        return downmix(channels: (0..<channelCount).map { UnsafePointer(data[$0]) }, frames: frames)
    }

    /// True for linear PCM in native 32-bit float, the only format the
    /// Core Audio paths of MeetingKit read.
    static func isFloat32(_ format: AudioStreamBasicDescription) -> Bool {
        format.mFormatID == kAudioFormatLinearPCM
            && format.mFormatFlags & kAudioFormatFlagIsFloat != 0
            && format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0
            && format.mBitsPerChannel == 32
    }

    /// Mono samples of a Core Audio buffer list in 32-bit float, interleaved
    /// (one buffer with every channel) or not (one buffer per channel).
    /// Returns an empty array for anything else.
    static func mono(from list: UnsafePointer<AudioBufferList>, format: AudioStreamBasicDescription) -> [Float] {
        guard isFloat32(format) else { return [] }
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        guard let first = buffers.first, first.mData != nil else { return [] }
        let sampleBytes = MemoryLayout<Float>.size
        if buffers.count > 1 {
            let frames = buffers.map { Int($0.mDataByteSize) / sampleBytes }.min() ?? 0
            let channels = buffers.compactMap { buffer in
                buffer.mData.map { UnsafePointer($0.assumingMemoryBound(to: Float.self)) }
            }
            return downmix(channels: channels, frames: frames)
        }
        let channels = max(1, Int(first.mNumberChannels))
        let frames = Int(first.mDataByteSize) / (sampleBytes * channels)
        return downmix(interleaved: UnsafePointer(first.mData!.assumingMemoryBound(to: Float.self)), frames: frames, channels: channels)
    }

    /// Root mean square of the samples (0 for an empty array).
    public static func rms(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var value: Float = 0
        vDSP_rmsqv(samples, 1, &value, vDSP_Length(samples.count))
        return value
    }

    /// Largest absolute sample (0 for an empty array).
    public static func peak(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var value: Float = 0
        vDSP_maxmgv(samples, 1, &value, vDSP_Length(samples.count))
        return value
    }

    /// Maps an RMS value to 0...1 for a level meter: -60 dBFS and below is 0,
    /// 0 dBFS is 1, linear in decibels in between.
    public static func meterLevel(rms: Float) -> Float {
        guard rms > 0 else { return 0 }
        let decibels = 20 * log10(rms)
        return max(0, min(1, (decibels + 60) / 60))
    }

    /// Adds two blocks sample by sample and clamps to -1...1. The result is as
    /// long as the longer block.
    public static func mix(_ first: [Float], _ second: [Float]) -> [Float] {
        let (long, short) = first.count >= second.count ? (first, second) : (second, first)
        guard !short.isEmpty else { return long }
        var out = long
        out.withUnsafeMutableBufferPointer { buffer in
            short.withUnsafeBufferPointer { other in
                vDSP_vadd(buffer.baseAddress!, 1, other.baseAddress!, 1, buffer.baseAddress!, 1, vDSP_Length(short.count))
            }
            var low: Float = -1
            var high: Float = 1
            vDSP_vclip(buffer.baseAddress!, 1, &low, &high, buffer.baseAddress!, 1, vDSP_Length(buffer.count))
        }
        return out
    }

    /// One-shot resampling of mono audio to 16 kHz.
    public static func resampleTo16k(_ samples: [Float], sampleRate: Double) -> [Float] {
        guard let resampler = StreamResampler(inputSampleRate: sampleRate) else { return [] }
        var out = resampler.process(samples)
        out.append(contentsOf: resampler.finish())
        return out
    }
}

/// Streaming sample-rate conversion of mono Float32 to 16 kHz, block after
/// block, without clicks at the block edges.
///
/// Not thread safe: use one instance per source and call it from one queue.
public final class StreamResampler {
    public let inputSampleRate: Double
    public let outputSampleRate: Double

    private let converter: AVAudioConverter?
    private let inputFormat: AVAudioFormat
    private let outputFormat: AVAudioFormat

    /// Returns nil when the input rate is not usable (zero, negative, NaN).
    public init?(inputSampleRate: Double, outputSampleRate: Double = MeetingAudioFormat.sampleRate) {
        guard inputSampleRate.isFinite, inputSampleRate > 0, outputSampleRate > 0,
              let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inputSampleRate, channels: 1, interleaved: false),
              let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: outputSampleRate, channels: 1, interleaved: false)
        else { return nil }
        self.inputSampleRate = inputSampleRate
        self.outputSampleRate = outputSampleRate
        inputFormat = input
        outputFormat = output
        if inputSampleRate == outputSampleRate {
            converter = nil
        } else {
            guard let made = AVAudioConverter(from: input, to: output) else { return nil }
            converter = made
        }
    }

    /// Converts one block. The output of consecutive calls concatenates into
    /// the converted stream; a few samples stay inside until the next call.
    public func process(_ samples: [Float]) -> [Float] {
        guard !samples.isEmpty else { return [] }
        guard let converter else { return samples }
        guard let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(samples.count)) else { return [] }
        input.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            input.floatChannelData![0].update(from: source.baseAddress!, count: samples.count)
        }
        return run(converter: converter, input: input, endOfStream: false)
    }

    /// Drains what the converter still holds. Call once at the end.
    public func finish() -> [Float] {
        guard let converter else { return [] }
        return run(converter: converter, input: nil, endOfStream: true)
    }

    private func run(converter: AVAudioConverter, input: AVAudioPCMBuffer?, endOfStream: Bool) -> [Float] {
        let ratio = outputSampleRate / inputSampleRate
        let expected = Double(input?.frameLength ?? 0) * ratio
        let capacity = AVAudioFrameCount(expected.rounded(.up)) + 4096
        var result: [Float] = []
        var pending = input
        while true {
            guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { break }
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in
                if let buffer = pending {
                    pending = nil
                    inputStatus.pointee = .haveData
                    return buffer
                }
                inputStatus.pointee = endOfStream ? .endOfStream : .noDataNow
                return nil
            }
            let produced = Int(output.frameLength)
            if produced > 0, let data = output.floatChannelData {
                result.append(contentsOf: UnsafeBufferPointer(start: data[0], count: produced))
            }
            // The output buffer was full: there may be more to pull.
            if status == .haveData, produced == Int(capacity) { continue }
            break
        }
        return result
    }
}
