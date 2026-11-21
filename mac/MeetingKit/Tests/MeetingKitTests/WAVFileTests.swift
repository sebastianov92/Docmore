import AVFoundation
import XCTest
@testable import MeetingKit

final class WAVFileTests: XCTestCase {
    func testWriteAndReadBack() throws {
        let url = makeTemporaryDirectory(self).appendingPathComponent("tone.wav")
        let tone = sine(frequency: 440, sampleRate: 16_000, seconds: 2.5)
        let writer = try WAVWriter(url: url)
        // in uneven pieces, as a recorder delivers them
        var offset = 0
        for size in [1, 1599, 1600, 4801, 16_000, 15_999] {
            try writer.append(Array(tone[offset..<offset + size]))
            offset += size
        }
        XCTAssertEqual(offset, tone.count)
        try writer.finish()
        XCTAssertEqual(writer.framesWritten, tone.count)
        XCTAssertEqual(writer.durationSeconds, 2.5, accuracy: 0.0001)

        let audio = try WAVFile.read(url)
        XCTAssertEqual(audio.sampleRate, 16_000)
        XCTAssertEqual(audio.channels, 1)
        XCTAssertEqual(audio.samples.count, tone.count)
        XCTAssertEqual(audio.durationSeconds, 2.5, accuracy: 0.0001)
        for index in stride(from: 0, to: tone.count, by: 97) {
            XCTAssertEqual(audio.samples[index], tone[index], accuracy: 1.0 / 16_000, "sample \(index)")
        }
    }

    func testHeaderIsCanonical16BitPCM() throws {
        let url = makeTemporaryDirectory(self).appendingPathComponent("header.wav")
        let writer = try WAVWriter(url: url)
        try writer.append([Float](repeating: 0.25, count: 16_000))
        try writer.finish()
        let data = try Data(contentsOf: url)
        XCTAssertEqual(data.count, 44 + 32_000)
        XCTAssertEqual(String(decoding: data[0..<4], as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: data[8..<16], as: UTF8.self), "WAVEfmt ")
        XCTAssertEqual(String(decoding: data[36..<40], as: UTF8.self), "data")
        func u32(_ offset: Int) -> UInt32 { data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self) } }
        func u16(_ offset: Int) -> UInt16 { data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: UInt16.self) } }
        XCTAssertEqual(u32(4), 36 + 32_000)   // RIFF size
        XCTAssertEqual(u16(20), 1)            // PCM
        XCTAssertEqual(u16(22), 1)            // mono
        XCTAssertEqual(u32(24), 16_000)       // sample rate
        XCTAssertEqual(u32(28), 32_000)       // byte rate
        XCTAssertEqual(u16(32), 2)            // block align
        XCTAssertEqual(u16(34), 16)           // bits
        XCTAssertEqual(u32(40), 32_000)       // data size
    }

    func testOtherSoftwareReadsTheFile() throws {
        let url = makeTemporaryDirectory(self).appendingPathComponent("avf.wav")
        let writer = try WAVWriter(url: url)
        try writer.append(sine(frequency: 300, sampleRate: 16_000, seconds: 1))
        try writer.finish()
        let file = try AVAudioFile(forReading: url)
        XCTAssertEqual(file.fileFormat.sampleRate, 16_000)
        XCTAssertEqual(file.fileFormat.channelCount, 1)
        XCTAssertEqual(file.length, 16_000)
    }

    func testFileIsUsableWhileStillRecording() throws {
        // a crash is the writer never reaching finish()
        let url = makeTemporaryDirectory(self).appendingPathComponent("crash.wav")
        let writer = try WAVWriter(url: url)
        for _ in 0..<35 {
            try writer.append([Float](repeating: 0.1, count: 1600)) // 3.5 s in 0.1 s pieces
        }
        // what a player sees: the header as of the last refresh, at most 1 s behind
        let file = try AVAudioFile(forReading: url)
        XCTAssertGreaterThanOrEqual(file.length, Int64(2.5 * 16_000))
        XCTAssertLessThanOrEqual(file.length, Int64(3.5 * 16_000))
        // the reader of MeetingKit takes everything that is on disk
        let onDisk = try Data(contentsOf: url).count
        XCTAssertEqual(onDisk, 44 + 35 * 1600 * 2)
        // and the repair makes the header say so
        let seconds = try WAVFile.repairHeader(at: url)
        XCTAssertEqual(seconds, 3.5, accuracy: 0.0001)
        XCTAssertEqual(try AVAudioFile(forReading: url).length, Int64(3.5 * 16_000))
        try writer.finish()
    }

    func testStaleHeaderIsTolerated() throws {
        let url = makeTemporaryDirectory(self).appendingPathComponent("stale.wav")
        var data = WAVFile.header(sampleRate: 16_000, channels: 1, dataBytes: 0) // sizes never updated
        data.append(WAVFile.pcm16([Float](repeating: 0.5, count: 8000)))
        data.append(0x7F) // half a sample cut by the crash
        try data.write(to: url)
        let audio = try WAVFile.read(url)
        XCTAssertEqual(audio.samples.count, 8000)
        XCTAssertEqual(audio.samples[10], 0.5, accuracy: 0.001)

        XCTAssertEqual(try WAVFile.repairHeader(at: url), 0.5, accuracy: 0.0001)
        let repaired = try Data(contentsOf: url)
        XCTAssertEqual(repaired.count, 44 + 16_000)
        XCTAssertEqual(try WAVFile.parse(repaired).dataLength, 16_000)
    }

    func testReadsStereoAsMono() throws {
        let url = makeTemporaryDirectory(self).appendingPathComponent("stereo.wav")
        let writer = try WAVWriter(url: url, sampleRate: 48_000, channels: 2)
        // left 0.8, right 0.2
        try writer.append((0..<9600).map { $0 % 2 == 0 ? 0.8 : 0.2 })
        try writer.finish()
        XCTAssertEqual(writer.framesWritten, 4800)
        let audio = try WAVFile.read(url)
        XCTAssertEqual(audio.channels, 2)
        XCTAssertEqual(audio.sampleRate, 48_000)
        XCTAssertEqual(audio.samples.count, 4800)
        XCTAssertEqual(audio.samples[100], 0.5, accuracy: 0.001)
    }

    func testClampsAndSurvivesNaN() throws {
        let url = makeTemporaryDirectory(self).appendingPathComponent("clamp.wav")
        let writer = try WAVWriter(url: url)
        try writer.append([2, -2, .nan, 0])
        try writer.finish()
        let audio = try WAVFile.read(url)
        XCTAssertEqual(audio.samples[0], 1, accuracy: 0.001)
        XCTAssertEqual(audio.samples[1], -1, accuracy: 0.001)
        XCTAssertEqual(audio.samples[2], 0)
        XCTAssertEqual(audio.samples[3], 0)
    }

    func testRejectsWhatIsNotWAV() throws {
        let url = makeTemporaryDirectory(self).appendingPathComponent("not.wav")
        try Data("hello, this is not audio".utf8).write(to: url)
        XCTAssertThrowsError(try WAVFile.read(url)) { error in
            guard case WAVError.notAWAVFile = error else { return XCTFail("unexpected \(error)") }
        }
        XCTAssertThrowsError(try WAVFile.read(url.appendingPathExtension("missing")))
    }

    func testAppendAfterFinishFails() throws {
        let url = makeTemporaryDirectory(self).appendingPathComponent("closed.wav")
        let writer = try WAVWriter(url: url)
        try writer.finish()
        try writer.finish() // twice is fine
        XCTAssertThrowsError(try writer.append([0.1]))
    }
}
