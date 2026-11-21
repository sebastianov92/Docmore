import XCTest
@testable import MeetingKit

final class LiveChunkerTests: XCTestCase {
    func testWindowsCoverTheStreamWithoutGapsOrOverlap() {
        var chunker = LiveChunker(windowSeconds: 30, searchSeconds: 5)
        // 100 s of a ramp: every sample is different, so order is checkable
        let total = 100 * 16_000
        let input = (0..<total).map { Float($0 % 1000) / 1000 }
        var windows: [LiveChunker.Window] = []
        var offset = 0
        while offset < total {
            let end = min(total, offset + 1600) // 0.1 s, as the recorder delivers
            windows.append(contentsOf: chunker.append(Array(input[offset..<end])))
            offset = end
        }
        XCTAssertEqual(chunker.bufferedSamples, total - windows.reduce(0) { $0 + $1.samples.count })
        if let last = chunker.flush() { windows.append(last) }
        XCTAssertNil(chunker.flush())

        XCTAssertEqual(windows.map(\.index), Array(0..<windows.count))
        XCTAssertEqual(windows.flatMap(\.samples), input, "the windows in order are the stream")
        var expectedStart = 0.0
        for window in windows {
            XCTAssertEqual(window.startSeconds, expectedStart, accuracy: 0.0001)
            XCTAssertEqual(window.sampleRate, 16_000)
            expectedStart += window.durationSeconds
            XCTAssertEqual(window.endSeconds, expectedStart, accuracy: 0.0001)
        }
        // every full window is between 25 and 30 s (the cut moves back at most 5 s)
        for window in windows.dropLast() {
            XCTAssertLessThanOrEqual(window.samples.count, 30 * 16_000)
            XCTAssertGreaterThanOrEqual(window.samples.count, 25 * 16_000)
        }
        XCTAssertEqual(windows.count, 4)
    }

    func testCutsInThePause() {
        var chunker = LiveChunker(windowSeconds: 30, searchSeconds: 5)
        // speech, a pause from 27.0 s to 27.6 s, speech again
        var input = sine(frequency: 200, sampleRate: 16_000, seconds: 40)
        let pause = (27 * 16_000)..<Int(27.6 * 16_000)
        for index in pause { input[index] = 0 }
        let windows = chunker.append(input)
        XCTAssertEqual(windows.count, 1)
        let cut = windows[0].samples.count
        XCTAssertTrue(pause.contains(cut), "cut at \(Double(cut) / 16_000) s, outside the pause")
    }

    func testSilenceGivesFullWindows() {
        var chunker = LiveChunker(windowSeconds: 10, searchSeconds: 2)
        let windows = chunker.append([Float](repeating: 0, count: 25 * 16_000))
        XCTAssertEqual(windows.count, 2)
        // all frames are equally quiet: the latest one wins, the window is almost full
        XCTAssertGreaterThan(windows[0].samples.count, Int(9.8 * 16_000))
        XCTAssertLessThanOrEqual(windows[0].samples.count, 10 * 16_000)
    }

    func testDoesNotDependOnHowTheAudioArrives() {
        let input = sine(frequency: 150, sampleRate: 16_000, seconds: 65).enumerated().map { index, value in
            // loud and quiet stretches, so the cut points are not trivial
            (index / 8000) % 3 == 0 ? value * 0.05 : value
        }
        var atOnce = LiveChunker(windowSeconds: 20, searchSeconds: 4)
        var first = atOnce.append(input)
        if let rest = atOnce.flush() { first.append(rest) }

        var inPieces = LiveChunker(windowSeconds: 20, searchSeconds: 4)
        var second: [LiveChunker.Window] = []
        var offset = 0
        for size in Array(repeating: [1, 479, 1600, 4096, 16_001], count: 60).flatMap({ $0 }) {
            guard offset < input.count else { break }
            let end = min(input.count, offset + size)
            second.append(contentsOf: inPieces.append(Array(input[offset..<end])))
            offset = end
        }
        XCTAssertEqual(offset, input.count)
        if let rest = inPieces.flush() { second.append(rest) }
        XCTAssertEqual(first, second)
    }

    func testWindowIsCappedAtWhatWhisperReads() {
        let chunker = LiveChunker(windowSeconds: 120)
        XCTAssertEqual(chunker.windowSamples, 30 * 16_000)
        let short = LiveChunker(windowSeconds: 4, searchSeconds: 10)
        XCTAssertEqual(short.windowSamples, 4 * 16_000)
        XCTAssertEqual(short.searchSamples, 2 * 16_000, "the search span is at most half the window")
    }

    func testNoSearchCutsExactly() {
        var chunker = LiveChunker(windowSeconds: 5, searchSeconds: 0)
        let windows = chunker.append([Float](repeating: 0.3, count: 12 * 16_000))
        XCTAssertEqual(windows.map(\.samples.count), [5 * 16_000, 5 * 16_000])
        XCTAssertEqual(chunker.flush()?.samples.count, 2 * 16_000)
    }
}
