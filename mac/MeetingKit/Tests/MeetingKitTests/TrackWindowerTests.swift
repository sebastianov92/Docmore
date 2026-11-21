import XCTest
@testable import MeetingKit

final class TrackWindowerTests: XCTestCase {
    private let rate = 16_000

    /// A steady tone with silences at the given seconds.
    private func track(seconds: Double, level: Float, pauses: [(Double, Double)]) -> [Float] {
        var samples = [Float](repeating: level, count: Int(seconds * Double(rate)))
        for (start, end) in pauses {
            for index in Int(start * Double(rate))..<Int(end * Double(rate)) {
                samples[index] = 0
            }
        }
        return samples
    }

    private func feed(_ windower: inout TrackWindower, _ tracks: [[Float]], block: Int = 1600) -> [TrackWindower.Window] {
        var windows: [TrackWindower.Window] = []
        var offset = 0
        let total = tracks[0].count
        while offset < total {
            let end = min(total, offset + block)
            windows.append(contentsOf: windower.append(tracks.map { Array($0[offset..<end]) }))
            offset = end
        }
        if let last = windower.flush() { windows.append(last) }
        return windows
    }

    func testBothTracksAreCutAtTheSameMoments() {
        let room = track(seconds: 40, level: 0.2, pauses: [(13.0, 13.4), (27, 27.5)])
        let remote = track(seconds: 40, level: 0.1, pauses: [(12.0, 12.4), (13.1, 13.3), (27.2, 27.4)])
        var windower = TrackWindower(trackCount: 2, windowSeconds: 15)
        let windows = feed(&windower, [room, remote])

        XCTAssertEqual(windows.map(\.index), Array(0..<windows.count))
        XCTAssertTrue(windows.allSatisfy { $0.tracks.count == 2 && $0.tracks[0].count == $0.tracks[1].count })
        // nothing lost, nothing repeated, on either track
        XCTAssertEqual(windows.flatMap { $0.tracks[0] }, room)
        XCTAssertEqual(windows.flatMap { $0.tracks[1] }, remote)
        // windows follow each other
        var expectedStart = 0.0
        for window in windows {
            XCTAssertEqual(window.startSeconds, expectedStart, accuracy: 1e-9)
            XCTAssertLessThanOrEqual(window.durationSeconds, 15)
            expectedStart = window.endSeconds
        }
        // the first cut is where BOTH are silent (13.1 to 13.3), not where only one is
        XCTAssertGreaterThanOrEqual(windows[0].endSeconds, 13.1)
        XCTAssertLessThanOrEqual(windows[0].endSeconds, 13.3)
        // the second one too (27.2 to 27.4)
        XCTAssertGreaterThanOrEqual(windows[1].endSeconds, 27.2)
        XCTAssertLessThanOrEqual(windows[1].endSeconds, 27.4)
    }

    func testOneTrackBehavesLikeTheLiveChunker() {
        let audio = track(seconds: 70, level: 0.2, pauses: [(27, 27.6), (55.5, 56)])
        var windower = TrackWindower(trackCount: 1, windowSeconds: 30)
        var chunker = LiveChunker(windowSeconds: 30)
        let windows = feed(&windower, [audio])
        var expected: [LiveChunker.Window] = []
        var offset = 0
        while offset < audio.count {
            expected.append(contentsOf: chunker.append(Array(audio[offset..<min(audio.count, offset + 1600)])))
            offset += 1600
        }
        if let last = chunker.flush() { expected.append(last) }
        XCTAssertEqual(windows.map { $0.tracks[0].count }, expected.map(\.samples.count))
        XCTAssertEqual(windows.map(\.startSeconds), expected.map(\.startSeconds))
    }

    func testAShorterBlockIsPaddedWithSilence() {
        var windower = TrackWindower(trackCount: 2, windowSeconds: 1, searchSeconds: 0)
        var windows = windower.append([[Float](repeating: 0.5, count: 16_000), [Float](repeating: 0.25, count: 4_000)])
        // a missing track is silence too
        windows.append(contentsOf: windower.append([[Float](repeating: 0.5, count: 16_000)]))
        XCTAssertEqual(windows.count, 2)
        XCTAssertEqual(windows[0].tracks[1].count, 16_000)
        XCTAssertEqual(windows[0].tracks[1].filter { $0 != 0 }.count, 4_000)
        XCTAssertEqual(windows[1].tracks[1], [Float](repeating: 0, count: 16_000))
        XCTAssertNil(windower.flush())
        XCTAssertEqual(windower.append([[], []]).count, 0)
    }
}
