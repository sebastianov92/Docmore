import Foundation

/// Errors of the WAV reader and writer.
public enum WAVError: Error, LocalizedError, Equatable {
    case cannotCreate(String)
    case notAWAVFile(String)
    case unsupportedFormat(String)
    case writeFailed(String)

    public var errorDescription: String? {
        switch self {
        case .cannotCreate(let detail): return "Could not create the audio file: \(detail)"
        case .notAWAVFile(let detail): return "Not a WAV file: \(detail)"
        case .unsupportedFormat(let detail): return "Unsupported WAV format: \(detail)"
        case .writeFailed(let detail): return "Could not write the audio file: \(detail)"
        }
    }
}

/// Decoded WAV audio.
public struct WAVAudio: Equatable, Sendable {
    /// Mono samples in -1...1 (channels averaged).
    public var samples: [Float]
    public var sampleRate: Double
    /// Channel count of the file before the downmix.
    public var channels: Int

    public var durationSeconds: Double {
        sampleRate > 0 ? Double(samples.count) / sampleRate : 0
    }
}

/// Decoded WAV audio with its channels kept apart.
public struct WAVChannels: Equatable, Sendable {
    /// One array per channel, all of the same length, samples in -1...1.
    public var channels: [[Float]]
    public var sampleRate: Double

    public var durationSeconds: Double {
        sampleRate > 0 ? Double(channels.first?.count ?? 0) / sampleRate : 0
    }
}

/// Writes 16-bit PCM WAV incrementally.
///
/// Samples go to disk as they arrive and the two size fields of the header
/// are refreshed about once per second of audio, so a crash leaves a file
/// that every player opens and that misses at most the last second.
/// `WAVFile.repairHeader(at:)` recovers that last second too.
///
/// Not thread safe: call it from one queue.
public final class WAVWriter {
    public let url: URL
    public let sampleRate: Int
    public let channels: Int
    /// Sample frames written so far.
    public private(set) var framesWritten: Int = 0

    private var handle: FileHandle?
    private var framesAtLastHeaderUpdate = 0
    private let headerUpdateInterval: Int

    public var durationSeconds: Double {
        Double(framesWritten) / Double(sampleRate)
    }

    public init(url: URL, sampleRate: Int = 16_000, channels: Int = 1) throws {
        self.url = url
        self.sampleRate = sampleRate
        self.channels = channels
        self.headerUpdateInterval = sampleRate
        let manager = FileManager.default
        do {
            try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        } catch {
            throw WAVError.cannotCreate(error.localizedDescription)
        }
        guard manager.createFile(atPath: url.path, contents: WAVFile.header(sampleRate: sampleRate, channels: channels, dataBytes: 0)) else {
            throw WAVError.cannotCreate(url.path)
        }
        do {
            let handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
            self.handle = handle
        } catch {
            throw WAVError.cannotCreate(error.localizedDescription)
        }
    }

    deinit {
        try? finish()
    }

    /// Appends samples in -1...1 (interleaved when there are several channels).
    public func append(_ samples: [Float]) throws {
        guard let handle else { throw WAVError.writeFailed("the file is closed") }
        guard !samples.isEmpty else { return }
        let data = WAVFile.pcm16(samples)
        do {
            try handle.write(contentsOf: data)
        } catch {
            throw WAVError.writeFailed(error.localizedDescription)
        }
        framesWritten += samples.count / channels
        if framesWritten - framesAtLastHeaderUpdate >= headerUpdateInterval {
            try updateHeader()
        }
    }

    /// Writes the final sizes and closes the file. Safe to call twice.
    public func finish() throws {
        guard let handle else { return }
        try updateHeader()
        try? handle.synchronize()
        try? handle.close()
        self.handle = nil
    }

    private func updateHeader() throws {
        guard let handle else { return }
        let dataBytes = framesWritten * channels * 2
        do {
            try handle.seek(toOffset: 4)
            try handle.write(contentsOf: WAVFile.le32(UInt32(truncatingIfNeeded: 36 + dataBytes)))
            try handle.seek(toOffset: 40)
            try handle.write(contentsOf: WAVFile.le32(UInt32(truncatingIfNeeded: dataBytes)))
            try handle.seekToEnd()
        } catch {
            throw WAVError.writeFailed(error.localizedDescription)
        }
        framesAtLastHeaderUpdate = framesWritten
    }
}

/// WAV helpers: read a file back, repair a header after a crash.
public enum WAVFile {
    /// Reads 16-bit PCM (and 32-bit float) WAV into mono Float32.
    ///
    /// Tolerates a stale header: when the declared data size is zero or goes
    /// past the end of the file, what is really on disk is used.
    public static func read(_ url: URL) throws -> WAVAudio {
        let data: Data
        do {
            data = try Data(contentsOf: url, options: .mappedIfSafe)
        } catch {
            throw WAVError.notAWAVFile(error.localizedDescription)
        }
        let layout = try parse(data)
        let bytesPerSample = layout.bitsPerSample / 8
        let frameBytes = bytesPerSample * layout.channels
        let frames = layout.dataLength / frameBytes
        var mono = [Float](repeating: 0, count: frames)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!.advanced(by: layout.dataOffset)
            let scale = 1 / Float(layout.channels)
            for frame in 0..<frames {
                var sum: Float = 0
                for channel in 0..<layout.channels {
                    let offset = frame * frameBytes + channel * bytesPerSample
                    if layout.isFloat {
                        let bits = base.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
                        sum += Float(bitPattern: UInt32(littleEndian: bits))
                    } else {
                        let value = base.loadUnaligned(fromByteOffset: offset, as: Int16.self)
                        sum += Float(Int16(littleEndian: value)) / 32768
                    }
                }
                mono[frame] = sum * scale
            }
        }
        return WAVAudio(samples: mono, sampleRate: Double(layout.sampleRate), channels: layout.channels)
    }

    /// Reads 16-bit PCM (and 32-bit float) WAV keeping every channel apart:
    /// what a recording made in virtual mode needs (channel 0 the microphone,
    /// channel 1 the system audio). Tolerates a stale header like `read`.
    public static func readChannels(_ url: URL) throws -> WAVChannels {
        let data: Data
        do {
            data = try Data(contentsOf: url, options: .mappedIfSafe)
        } catch {
            throw WAVError.notAWAVFile(error.localizedDescription)
        }
        let layout = try parse(data)
        let bytesPerSample = layout.bitsPerSample / 8
        let frameBytes = bytesPerSample * layout.channels
        let frames = layout.dataLength / frameBytes
        var channels = Array(repeating: [Float](repeating: 0, count: frames), count: layout.channels)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!.advanced(by: layout.dataOffset)
            for channel in 0..<layout.channels {
                channels[channel].withUnsafeMutableBufferPointer { out in
                    for frame in 0..<frames {
                        let offset = frame * frameBytes + channel * bytesPerSample
                        if layout.isFloat {
                            let bits = base.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
                            out[frame] = Float(bitPattern: UInt32(littleEndian: bits))
                        } else {
                            let value = base.loadUnaligned(fromByteOffset: offset, as: Int16.self)
                            out[frame] = Float(Int16(littleEndian: value)) / 32768
                        }
                    }
                }
            }
        }
        return WAVChannels(channels: channels, sampleRate: Double(layout.sampleRate))
    }

    /// Rewrites the size fields of a WAV written by `WAVWriter` so they match
    /// what is on disk. Use it on recordings found after a crash.
    /// Returns the duration in seconds.
    @discardableResult
    public static func repairHeader(at url: URL) throws -> Double {
        let data: Data
        do {
            data = try Data(contentsOf: url, options: .mappedIfSafe)
        } catch {
            throw WAVError.notAWAVFile(error.localizedDescription)
        }
        let layout = try parse(data)
        let frameBytes = layout.bitsPerSample / 8 * layout.channels
        let dataBytes = (data.count - layout.dataOffset) / frameBytes * frameBytes
        let handle: FileHandle
        do {
            handle = try FileHandle(forUpdating: url)
        } catch {
            throw WAVError.writeFailed(error.localizedDescription)
        }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: 4)
            try handle.write(contentsOf: le32(UInt32(truncatingIfNeeded: layout.dataOffset - 8 + dataBytes)))
            try handle.seek(toOffset: UInt64(layout.dataOffset - 4))
            try handle.write(contentsOf: le32(UInt32(truncatingIfNeeded: dataBytes)))
            // drop a trailing partial frame, if the crash cut one
            try handle.truncate(atOffset: UInt64(layout.dataOffset + dataBytes))
        } catch {
            throw WAVError.writeFailed(error.localizedDescription)
        }
        return Double(dataBytes / frameBytes) / Double(layout.sampleRate)
    }

    // MARK: - Internals

    struct Layout {
        var sampleRate: Int
        var channels: Int
        var bitsPerSample: Int
        var isFloat: Bool
        var dataOffset: Int
        var dataLength: Int
    }

    static func parse(_ data: Data) throws -> Layout {
        guard data.count >= 12, tag(data, 0) == "RIFF", tag(data, 8) == "WAVE" else {
            throw WAVError.notAWAVFile("missing RIFF/WAVE header")
        }
        var offset = 12
        var format: (tag: Int, channels: Int, rate: Int, bits: Int)?
        while offset + 8 <= data.count {
            let id = tag(data, offset)
            let size = Int(u32(data, offset + 4))
            let body = offset + 8
            if id == "fmt " {
                guard size >= 16, body + 16 <= data.count else {
                    throw WAVError.notAWAVFile("truncated fmt chunk")
                }
                var formatTag = Int(u16(data, body))
                // WAVE_FORMAT_EXTENSIBLE: the real tag is the first two bytes of the sub format
                if formatTag == 0xFFFE, size >= 26, body + 26 <= data.count {
                    formatTag = Int(u16(data, body + 24))
                }
                format = (formatTag, Int(u16(data, body + 2)), Int(u32(data, body + 4)), Int(u16(data, body + 14)))
            } else if id == "data" {
                guard let format else { throw WAVError.notAWAVFile("data chunk before fmt chunk") }
                let isFloat = format.tag == 3
                guard format.tag == 1 || isFloat else {
                    throw WAVError.unsupportedFormat("format tag \(format.tag)")
                }
                guard (format.tag == 1 && format.bits == 16) || (isFloat && format.bits == 32) else {
                    throw WAVError.unsupportedFormat("\(format.bits) bits per sample")
                }
                guard format.channels > 0, format.rate > 0 else {
                    throw WAVError.unsupportedFormat("no channels or no sample rate")
                }
                let available = data.count - body
                let frameBytes = format.bits / 8 * format.channels
                // a stale header (crash) says 0 or more than there is
                let declared = (size == 0 || size > available) ? available : size
                return Layout(
                    sampleRate: format.rate,
                    channels: format.channels,
                    bitsPerSample: format.bits,
                    isFloat: isFloat,
                    dataOffset: body,
                    dataLength: declared / frameBytes * frameBytes
                )
            }
            // chunks are padded to an even size
            offset = body + size + (size & 1)
        }
        throw WAVError.notAWAVFile("no data chunk")
    }

    static func header(sampleRate: Int, channels: Int, dataBytes: Int) -> Data {
        var data = Data(capacity: 44)
        data.append(contentsOf: Array("RIFF".utf8))
        data.append(le32(UInt32(truncatingIfNeeded: 36 + dataBytes)))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        data.append(le32(16))
        data.append(le16(1)) // PCM
        data.append(le16(UInt16(channels)))
        data.append(le32(UInt32(sampleRate)))
        data.append(le32(UInt32(sampleRate * channels * 2))) // byte rate
        data.append(le16(UInt16(channels * 2))) // block align
        data.append(le16(16)) // bits per sample
        data.append(contentsOf: Array("data".utf8))
        data.append(le32(UInt32(truncatingIfNeeded: dataBytes)))
        return data
    }

    /// Float -1...1 to little endian 16-bit PCM, clamped.
    static func pcm16(_ samples: [Float]) -> Data {
        var out = [Int16](repeating: 0, count: samples.count)
        for index in 0..<samples.count {
            let value = samples[index]
            let clamped = value.isNaN ? 0 : max(-1, min(1, value))
            out[index] = Int16((clamped * 32767).rounded()).littleEndian
        }
        return out.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    static func le32(_ value: UInt32) -> Data {
        withUnsafeBytes(of: value.littleEndian) { Data($0) }
    }

    static func le16(_ value: UInt16) -> Data {
        withUnsafeBytes(of: value.littleEndian) { Data($0) }
    }

    private static func tag(_ data: Data, _ offset: Int) -> String {
        String(decoding: data[data.startIndex + offset..<data.startIndex + offset + 4], as: UTF8.self)
    }

    private static func u32(_ data: Data, _ offset: Int) -> UInt32 {
        data.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self)) }
    }

    private static func u16(_ data: Data, _ offset: Int) -> UInt16 {
        data.withUnsafeBytes { UInt16(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt16.self)) }
    }
}
