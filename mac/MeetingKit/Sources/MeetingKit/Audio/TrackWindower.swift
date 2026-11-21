import Foundation

/// Cuts the running tracks of a recording into windows for the live
/// session: every track is cut at the same moments, so a window is the same
/// span of time on all of them.
///
/// A window closes when `windowSeconds` of audio has gathered. As in
/// `LiveChunker`, the cut moves back to the quietest tenth of a second
/// inside the last `searchSeconds`, quietest over all tracks together, so
/// neither side is cut in the middle of a word when it can be helped.
/// Nothing is dropped or repeated.
struct TrackWindower {
    struct Window: Equatable {
        /// Position in the stream, starting at 0.
        var index: Int
        /// Where the window starts, in seconds from the start of the stream.
        var startSeconds: Double
        /// One block per track, all of the same length.
        var tracks: [[Float]]

        var durationSeconds: Double { Double(tracks.first?.count ?? 0) / MeetingAudioFormat.sampleRate }
        var endSeconds: Double { startSeconds + durationSeconds }
    }

    let trackCount: Int
    let windowSamples: Int
    let searchSamples: Int
    private let frameSamples: Int

    private var buffers: [[Float]]
    private var consumedSamples = 0
    private var nextIndex = 0

    /// Whisper reads at most 30 s at a time, so longer windows are clamped.
    init(trackCount: Int, windowSeconds: Double = 15, searchSeconds: Double = 5) {
        self.trackCount = max(1, trackCount)
        let window = max(1, min(30, windowSeconds))
        windowSamples = Int(window * MeetingAudioFormat.sampleRate)
        searchSamples = Int(max(0, min(searchSeconds, window / 2)) * MeetingAudioFormat.sampleRate)
        frameSamples = MeetingAudioFormat.sampleRateInt / 10
        buffers = Array(repeating: [], count: max(1, trackCount))
    }

    /// Samples waiting for the next window.
    var bufferedSamples: Int { buffers[0].count }

    /// Adds one block per track and returns the windows that closed
    /// (usually none). Blocks of unequal length are padded with silence.
    mutating func append(_ blocks: [[Float]]) -> [Window] {
        let length = blocks.map(\.count).max() ?? 0
        guard length > 0 else { return [] }
        for index in buffers.indices {
            let block = index < blocks.count ? blocks[index] : []
            buffers[index].append(contentsOf: block)
            if block.count < length {
                buffers[index].append(contentsOf: [Float](repeating: 0, count: length - block.count))
            }
        }
        var windows: [Window] = []
        while buffers[0].count >= windowSamples {
            windows.append(take(cutPoint()))
        }
        return windows
    }

    /// The remainder as a last window, or nil when nothing is left.
    mutating func flush() -> Window? {
        guard !buffers[0].isEmpty else { return nil }
        return take(buffers[0].count)
    }

    private mutating func take(_ count: Int) -> Window {
        let window = Window(
            index: nextIndex,
            startSeconds: Double(consumedSamples) / MeetingAudioFormat.sampleRate,
            tracks: buffers.map { Array($0[0..<count]) }
        )
        for index in buffers.indices {
            buffers[index].removeFirst(count)
        }
        consumedSamples += count
        nextIndex += 1
        return window
    }

    /// The middle of the frame that is quietest over all tracks in the
    /// search span at the end of the window.
    private func cutPoint() -> Int {
        guard searchSamples >= frameSamples else { return windowSamples }
        let searchStart = windowSamples - searchSamples
        var bestStart = windowSamples - frameSamples
        var bestEnergy = Float.greatestFiniteMagnitude
        var frameStart = searchStart
        while frameStart + frameSamples <= windowSamples {
            var energy: Float = 0
            for buffer in buffers {
                for index in frameStart..<(frameStart + frameSamples) {
                    energy += buffer[index] * buffer[index]
                }
            }
            // "<=" prefers the latest of equally quiet frames: longer windows
            if energy <= bestEnergy {
                bestEnergy = energy
                bestStart = frameStart
            }
            frameStart += frameSamples
        }
        return bestStart + frameSamples / 2
    }
}
