import AVFoundation
import XCTest
@testable import MeetingKit

final class AudioMathTests: XCTestCase {
    // MARK: - Resampling

    func testResamples48kTo16k() {
        let input = sine(frequency: 440, sampleRate: 48_000, seconds: 2)
        let output = AudioMath.resampleTo16k(input, sampleRate: 48_000)
        // length: 2 s at 16 kHz, give or take the converter's edges
        XCTAssertEqual(Double(output.count), 32_000, accuracy: 160)
        // energy: a sine of amplitude 0.5 has RMS 0.3536
        XCTAssertEqual(AudioMath.rms(output), 0.5 / Float(2).squareRoot(), accuracy: 0.01)
        // pitch: still 440 Hz
        XCTAssertEqual(Double(risingZeroCrossings(output)) / 2, 440, accuracy: 3)
    }

    func testResamples44100To16k() {
        let input = sine(frequency: 1000, sampleRate: 44_100, seconds: 1)
        let output = AudioMath.resampleTo16k(input, sampleRate: 44_100)
        XCTAssertEqual(Double(output.count), 16_000, accuracy: 160)
        XCTAssertEqual(AudioMath.rms(output), 0.5 / Float(2).squareRoot(), accuracy: 0.01)
        XCTAssertEqual(Double(risingZeroCrossings(output)), 1000, accuracy: 5)
    }

    func testStreamingInBlocksIsContinuous() throws {
        let input = sine(frequency: 440, sampleRate: 48_000, seconds: 2)
        let resampler = try XCTUnwrap(StreamResampler(inputSampleRate: 48_000))
        var output: [Float] = []
        var offset = 0
        // the block sizes devices really use, and an odd one
        for size in [480, 512, 4800, 1024, 4096, 333] + Array(repeating: 4800, count: 30) {
            guard offset < input.count else { break }
            let end = min(input.count, offset + size)
            output.append(contentsOf: resampler.process(Array(input[offset..<end])))
            offset = end
        }
        XCTAssertEqual(offset, input.count)
        output.append(contentsOf: resampler.finish())
        XCTAssertEqual(Double(output.count), 32_000, accuracy: 160)
        XCTAssertEqual(AudioMath.rms(output), 0.5 / Float(2).squareRoot(), accuracy: 0.01)
        // no click at a block edge: a 440 Hz sine at 16 kHz moves at most 0.086 per sample
        var largestStep: Float = 0
        for index in 1..<output.count {
            largestStep = max(largestStep, abs(output[index] - output[index - 1]))
        }
        XCTAssertLessThan(largestStep, 0.1)
    }

    func testRemovesWhatCannotBeRepresented() {
        // 12 kHz does not fit under the 8 kHz limit of a 16 kHz stream
        let input = sine(frequency: 12_000, sampleRate: 48_000, seconds: 1)
        let output = AudioMath.resampleTo16k(input, sampleRate: 48_000)
        XCTAssertLessThan(AudioMath.rms(output), 0.02)
    }

    func testSameRatePassesThrough() throws {
        let input = sine(frequency: 200, sampleRate: 16_000, seconds: 0.5)
        let resampler = try XCTUnwrap(StreamResampler(inputSampleRate: 16_000))
        XCTAssertEqual(resampler.process(input), input)
        XCTAssertEqual(resampler.finish(), [])
    }

    func testRejectsUnusableRates() {
        XCTAssertNil(StreamResampler(inputSampleRate: 0))
        XCTAssertNil(StreamResampler(inputSampleRate: -44_100))
        XCTAssertNil(StreamResampler(inputSampleRate: .nan))
        XCTAssertEqual(AudioMath.resampleTo16k([0.1, 0.2], sampleRate: 0), [])
    }

    // MARK: - Mono

    func testDownmixInterleaved() {
        let stereo: [Float] = [1, 0, 0.5, 0.5, -1, 1]
        XCTAssertEqual(AudioMath.downmix(interleaved: stereo, channels: 2), [0.5, 0.5, 0])
        XCTAssertEqual(AudioMath.downmix(interleaved: [0.1, 0.2], channels: 1), [0.1, 0.2])
    }

    func testMonoFromEngineBuffer() throws {
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4))
        buffer.frameLength = 4
        for frame in 0..<4 {
            buffer.floatChannelData![0][frame] = 0.8
            buffer.floatChannelData![1][frame] = 0.2
        }
        let mono = AudioMath.mono(from: buffer)
        XCTAssertEqual(mono.count, 4)
        XCTAssertEqual(mono[0], 0.5, accuracy: 0.0001)
    }

    func testMonoFromInterleavedBufferList() {
        // what a process tap delivers: one buffer, stereo, interleaved float
        var format = AudioStreamBasicDescription(
            mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0
        )
        var samples: [Float] = [0.6, 0.2, -0.4, 0.4, 1, 0]
        let mono: [Float] = samples.withUnsafeMutableBytes { raw in
            var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 2, mDataByteSize: UInt32(raw.count), mData: raw.baseAddress))
            return AudioMath.mono(from: &list, format: format)
        }
        XCTAssertEqual(mono.count, 3)
        XCTAssertEqual(mono[0], 0.4, accuracy: 0.0001)
        XCTAssertEqual(mono[1], 0, accuracy: 0.0001)
        XCTAssertEqual(mono[2], 0.5, accuracy: 0.0001)

        // 16-bit integers are not read as floats
        format.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked
        format.mBitsPerChannel = 16
        let refused: [Float] = samples.withUnsafeMutableBytes { raw in
            var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 2, mDataByteSize: UInt32(raw.count), mData: raw.baseAddress))
            return AudioMath.mono(from: &list, format: format)
        }
        XCTAssertEqual(refused, [])
    }

    func testMonoFromDeinterleavedBufferList() {
        let format = AudioStreamBasicDescription(
            mSampleRate: 44_100, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0
        )
        var left: [Float] = [1, 1, 1]
        var right: [Float] = [0, 0.5, -1]
        let list = AudioBufferList.allocate(maximumBuffers: 2)
        defer { free(list.unsafeMutablePointer) }
        let mono: [Float] = left.withUnsafeMutableBytes { leftRaw in
            right.withUnsafeMutableBytes { rightRaw in
                list[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(leftRaw.count), mData: leftRaw.baseAddress)
                list[1] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(rightRaw.count), mData: rightRaw.baseAddress)
                return AudioMath.mono(from: list.unsafePointer, format: format)
            }
        }
        XCTAssertEqual(mono.count, 3)
        XCTAssertEqual(mono[0], 0.5, accuracy: 0.0001)
        XCTAssertEqual(mono[1], 0.75, accuracy: 0.0001)
        XCTAssertEqual(mono[2], 0, accuracy: 0.0001)
    }

    // MARK: - Mixing and level

    func testMixAddsAndClamps() {
        XCTAssertEqual(AudioMath.mix([0.25, 0.5, -0.5], [0.25, 0.75, -0.75]), [0.5, 1, -1])
        XCTAssertEqual(AudioMath.mix([0.1, 0.2, 0.3], [0.1]), [0.2, 0.2, 0.3])
        XCTAssertEqual(AudioMath.mix([], [0.4]), [0.4])
    }

    func testMixOfTwoTonesHasTheEnergyOfBoth() {
        let first = sine(frequency: 300, sampleRate: 16_000, seconds: 1, amplitude: 0.3)
        let second = sine(frequency: 1100, sampleRate: 16_000, seconds: 1, amplitude: 0.4)
        let mixed = AudioMath.mix(first, second)
        let expected = (pow(AudioMath.rms(first), 2) + pow(AudioMath.rms(second), 2)).squareRoot()
        XCTAssertEqual(AudioMath.rms(mixed), expected, accuracy: 0.005)
    }

    func testLevels() {
        XCTAssertEqual(AudioMath.rms([]), 0)
        XCTAssertEqual(AudioMath.rms([0.5, -0.5, 0.5, -0.5]), 0.5, accuracy: 0.0001)
        XCTAssertEqual(AudioMath.peak([0.1, -0.9, 0.3]), 0.9, accuracy: 0.0001)
        XCTAssertEqual(AudioMath.meterLevel(rms: 0), 0)
        XCTAssertEqual(AudioMath.meterLevel(rms: 1), 1)
        XCTAssertEqual(AudioMath.meterLevel(rms: 0.001), 0, accuracy: 0.001)      // -60 dBFS
        XCTAssertEqual(AudioMath.meterLevel(rms: 0.0316228), 0.5, accuracy: 0.001) // -30 dBFS
        XCTAssertEqual(AudioMath.meterLevel(rms: 4), 1)
    }
}
