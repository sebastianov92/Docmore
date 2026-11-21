import XCTest
@testable import MeetingKit

final class SourceMixerTests: XCTestCase {
    func testSingleSourcePassesThrough() {
        var mixer = SourceMixer(sourceCount: 1)
        XCTAssertEqual(mixer.push([0.1, 0.2, 0.3], source: 0), [0.1, 0.2, 0.3])
        XCTAssertEqual(mixer.flush(), [])
    }

    func testTwoSourcesAreSummedOverTheSpanBothHave() {
        var mixer = SourceMixer(sourceCount: 2)
        XCTAssertEqual(mixer.push([0.1, 0.1, 0.1, 0.1], source: 0), [], "waits for the other source")
        XCTAssertEqual(mixer.push([0.2, 0.2], source: 1), [0.3, 0.3])
        XCTAssertEqual(mixer.pending(source: 0), 2)
        XCTAssertEqual(mixer.push([0.2, 0.2, 0.2], source: 1), [0.3, 0.3])
        XCTAssertEqual(mixer.pending(source: 1), 1)
        // the end: what is left, padded with silence
        XCTAssertEqual(mixer.flush(), [0.2])
        XCTAssertEqual(mixer.flush(), [])
    }

    func testNothingIsLostOrInventedWithUnevenArrival() {
        var mixer = SourceMixer(sourceCount: 2)
        let first = sine(frequency: 300, sampleRate: 16_000, seconds: 3, amplitude: 0.3)
        let second = sine(frequency: 1100, sampleRate: 16_000, seconds: 3, amplitude: 0.4)
        var output: [Float] = []
        var firstOffset = 0
        var secondOffset = 0
        // source 0 in pieces of 1600, source 1 in pieces of 171
        while firstOffset < first.count || secondOffset < second.count {
            if firstOffset < first.count {
                let end = min(first.count, firstOffset + 1600)
                output.append(contentsOf: mixer.push(Array(first[firstOffset..<end]), source: 0))
                firstOffset = end
            }
            for _ in 0..<9 where secondOffset < second.count {
                let end = min(second.count, secondOffset + 171)
                output.append(contentsOf: mixer.push(Array(second[secondOffset..<end]), source: 1))
                secondOffset = end
            }
        }
        output.append(contentsOf: mixer.flush())
        XCTAssertEqual(output.count, first.count)
        // exactly the sum, sample by sample: the sources stayed aligned
        let expected = AudioMath.mix(first, second)
        for index in stride(from: 0, to: expected.count, by: 53) {
            XCTAssertEqual(output[index], expected[index], accuracy: 0.0001, "sample \(index)")
        }
    }

    func testAStalledSourceDoesNotHoldTheRecording() {
        var mixer = SourceMixer(sourceCount: 2, maxLagSamples: 8000)
        var produced = 0
        // source 1 never delivers
        for _ in 0..<20 {
            produced += mixer.push([Float](repeating: 0.5, count: 1600), source: 0).count
        }
        // everything but the allowed lag went out
        XCTAssertEqual(produced, 20 * 1600 - 8000)
        XCTAssertEqual(mixer.pending(source: 0), 8000)
        // when the late source shows up it is mixed from here on
        let mixed = mixer.push([Float](repeating: 0.25, count: 100), source: 1)
        XCTAssertEqual(mixed.count, 100)
        XCTAssertEqual(mixed[0], 0.75, accuracy: 0.0001)
    }

    func testAnEndedSourceIsNotWaitedFor() {
        var mixer = SourceMixer(sourceCount: 2)
        XCTAssertEqual(mixer.push([0.1, 0.1, 0.1], source: 0), [])
        XCTAssertEqual(mixer.push([0.2], source: 1), [0.3])
        // source 1 dies: the rest of source 0 goes out at once, and so does what follows
        XCTAssertEqual(mixer.end(source: 1), [0.1, 0.1])
        XCTAssertEqual(mixer.push([0.4, 0.4], source: 0), [0.4, 0.4])
    }
}
