import AVFoundation
import Foundation

/// Reads the tracks of a recording as 16 kHz mono samples.
///
/// A recording made in virtual mode is a two-channel WAV: channel 0 is the
/// microphone (the room), channel 1 is the system audio (the remote side).
/// Recordings made in person, and everything the older versions wrote, have
/// one channel.
public enum AudioTrackReader {
    /// How many channels a file has. 0 when it cannot be read.
    public static func channelCount(of url: URL) -> Int {
        if let data = try? Data(contentsOf: url, options: .mappedIfSafe), let layout = try? WAVFile.parse(data) {
            return layout.channels
        }
        guard let file = try? AVAudioFile(forReading: url) else { return 0 }
        return Int(file.processingFormat.channelCount)
    }

    /// The mode a recording was made in, read from its channels: two is a
    /// virtual meeting, one is in person (or a mixed recording of the first
    /// version, which has no sides either). Nil when the file cannot be
    /// read. For recordings found after a crash, once
    /// `WAVFile.repairHeader(at:)` has run.
    public static func recordedMode(of url: URL) -> MeetingMode? {
        switch channelCount(of: url) {
        case 0: return nil
        case 1: return .inPerson
        default: return .virtual
        }
    }

    /// Every channel of a file, each as 16 kHz mono samples of the same length.
    public static func channels(of url: URL) throws -> [[Float]] {
        if let data = try? Data(contentsOf: url, options: .mappedIfSafe), (try? WAVFile.parse(data)) != nil {
            let audio = try WAVFile.readChannels(url)
            return audio.channels.map { AudioMath.resampleTo16k($0, sampleRate: audio.sampleRate) }
        }
        // not one of ours: let AVFoundation decode it
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            throw WAVError.notAWAVFile(error.localizedDescription)
        }
        let format = file.processingFormat
        let frames = AVAudioFrameCount(file.length)
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
            return Array(repeating: [], count: Int(format.channelCount))
        }
        do {
            try file.read(into: buffer)
        } catch {
            throw WAVError.notAWAVFile(error.localizedDescription)
        }
        guard let data = buffer.floatChannelData else {
            throw WAVError.unsupportedFormat("no float samples")
        }
        let count = Int(buffer.frameLength)
        return (0..<Int(format.channelCount)).map { channel in
            let samples = Array(UnsafeBufferPointer(start: data[channel], count: count))
            return AudioMath.resampleTo16k(samples, sampleRate: format.sampleRate)
        }
    }

    /// One channel as 16 kHz mono samples; `channel` nil gives the mix
    /// (average) of all channels.
    public static func samples(of url: URL, channel: Int? = nil) throws -> [Float] {
        let all = try channels(of: url)
        guard let channel else { return mixdown(all) }
        guard all.indices.contains(channel) else {
            throw WAVError.unsupportedFormat("the file has \(all.count) channel(s), there is no channel \(channel)")
        }
        return all[channel]
    }

    /// The average of several channels of the same length.
    public static func mixdown(_ channels: [[Float]]) -> [Float] {
        guard let first = channels.first else { return [] }
        guard channels.count > 1 else { return first }
        var out = [Float](repeating: 0, count: channels.map(\.count).max() ?? 0)
        for channel in channels {
            for index in channel.indices {
                out[index] += channel[index]
            }
        }
        let scale = 1 / Float(channels.count)
        for index in out.indices {
            out[index] *= scale
        }
        return out
    }
}
