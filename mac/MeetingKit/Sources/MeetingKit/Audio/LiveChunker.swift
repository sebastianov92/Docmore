import Foundation

/// Cuts a running stream of 16 kHz mono samples into windows for live
/// transcription.
///
/// A window closes when `windowSeconds` of audio has gathered. Instead of
/// cutting exactly there (often in the middle of a word), the cut moves back
/// to the quietest tenth of a second inside the last `searchSeconds`. Nothing
/// is dropped or repeated: the windows, in order, are the whole stream.
public struct LiveChunker {
    public struct Window: Equatable, Sendable {
        /// Position in the stream, starting at 0.
        public var index: Int
        /// Where the window starts, in seconds from the start of the stream.
        public var startSeconds: Double
        public var samples: [Float]
        public var sampleRate: Double

        public var durationSeconds: Double { Double(samples.count) / sampleRate }
        public var endSeconds: Double { startSeconds + durationSeconds }
    }

    public let sampleRate: Double
    public let windowSamples: Int
    public let searchSamples: Int
    private let frameSamples: Int

    private var buffer: [Float] = []
    private var consumedSamples = 0
    private var nextIndex = 0

    /// Whisper reads at most 30 s at a time, so longer windows are clamped.
    public init(windowSeconds: Double = 30, searchSeconds: Double = 5, sampleRate: Double = MeetingAudioFormat.sampleRate) {
        self.sampleRate = sampleRate
        let window = max(1, min(30, windowSeconds))
        windowSamples = Int(window * sampleRate)
        searchSamples = Int(max(0, min(searchSeconds, window / 2)) * sampleRate)
        frameSamples = max(1, Int(0.1 * sampleRate))
    }

    /// Samples waiting for the next window.
    public var bufferedSamples: Int { buffer.count }

    /// Adds samples and returns the windows that closed (usually none).
    public mutating func append(_ samples: [Float]) -> [Window] {
        buffer.append(contentsOf: samples)
        var windows: [Window] = []
        while buffer.count >= windowSamples {
            windows.append(take(cutPoint()))
        }
        return windows
    }

    /// The remainder as a last window, or nil when nothing is left.
    public mutating func flush() -> Window? {
        guard !buffer.isEmpty else { return nil }
        return take(buffer.count)
    }

    private mutating func take(_ count: Int) -> Window {
        let window = Window(
            index: nextIndex,
            startSeconds: Double(consumedSamples) / sampleRate,
            samples: Array(buffer[0..<count]),
            sampleRate: sampleRate
        )
        buffer.removeFirst(count)
        consumedSamples += count
        nextIndex += 1
        return window
    }

    /// The middle of the quietest frame in the search span at the end of the
    /// window; the end of the window when there is no search span.
    private func cutPoint() -> Int {
        guard searchSamples >= frameSamples else { return windowSamples }
        let searchStart = windowSamples - searchSamples
        var bestStart = windowSamples - frameSamples
        var bestEnergy = Float.greatestFiniteMagnitude
        var frameStart = searchStart
        while frameStart + frameSamples <= windowSamples {
            var energy: Float = 0
            for index in frameStart..<(frameStart + frameSamples) {
                energy += buffer[index] * buffer[index]
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
