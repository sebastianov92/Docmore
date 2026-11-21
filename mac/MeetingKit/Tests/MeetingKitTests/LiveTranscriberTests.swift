import XCTest
@testable import MeetingKit

/// Stands in for Whisper: says how much audio it got.
private final class FakeTranscriber: SampleTranscribing, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var calls: [(samples: Int, language: String?)] = []
    var failOnCall: Int?
    var silentCalls: Set<Int> = []

    func transcribe(samples: [Float], language: String?) async throws -> MeetingTranscript {
        let number: Int = lock.withLock {
            calls.append((samples.count, language))
            return calls.count - 1
        }
        if number == failOnCall { throw TranscriptionError.failed("boom") }
        let duration = Double(samples.count) / 16_000
        if silentCalls.contains(number) {
            return MeetingTranscript(text: "", language: "xx", durationSeconds: duration, segments: [])
        }
        return MeetingTranscript(
            segments: [
                .init(start: 0, end: duration / 2, text: "part \(number) a"),
                .init(start: duration / 2, end: duration, text: "part \(number) b"),
            ],
            language: "es",
            durationSeconds: duration
        )
    }

    var snapshot: [(samples: Int, language: String?)] {
        lock.withLock { calls }
    }
}

final class LiveTranscriberTests: XCTestCase {
    private func feed(_ live: LiveTranscriber, seconds: Double) {
        let total = Int(seconds * 16_000)
        var offset = 0
        while offset < total {
            let size = min(1600, total - offset)
            live.append(samples: [Float](repeating: 0.1, count: size))
            offset += size
        }
    }

    func testEachWindowIsTranscribedOnceAndInOrder() async {
        let fake = FakeTranscriber()
        let live = LiveTranscriber(transcriber: fake, windowSeconds: 30)
        let seen = Box<LiveTranscriptUpdate>()
        live.onUpdate = { seen.add($0) }

        feed(live, seconds: 70)
        let transcript = await live.finish()

        let calls = fake.snapshot
        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(calls.reduce(0) { $0 + $1.samples }, 70 * 16_000, "every sample once, none twice")
        XCTAssertTrue(calls.allSatisfy { $0.samples <= 30 * 16_000 })

        let updates = seen.values
        XCTAssertEqual(updates.map(\.index), [0, 1, 2])
        XCTAssertEqual(updates.map(\.text), ["part 0 a part 0 b", "part 1 a part 1 b", "part 2 a part 2 b"])
        XCTAssertEqual(updates[0].startSeconds, 0)
        XCTAssertEqual(updates[1].startSeconds, updates[0].endSeconds, accuracy: 0.0001)
        XCTAssertEqual(updates[2].endSeconds, 70, accuracy: 0.0001)

        // the whole transcript: times moved from "inside the window" to "inside the recording"
        XCTAssertEqual(transcript.durationSeconds, 70, accuracy: 0.0001)
        XCTAssertEqual(transcript.segments.count, 6)
        XCTAssertEqual(transcript.segments[2].start, updates[1].startSeconds, accuracy: 0.0001)
        XCTAssertEqual(transcript.segments[5].end, 70, accuracy: 0.0001)
        XCTAssertEqual(transcript.segments.map(\.start), transcript.segments.map(\.start).sorted())
        XCTAssertEqual(transcript.language, "es")
        XCTAssertEqual(transcript.text, updates.map(\.text).joined(separator: " "))
        XCTAssertEqual(live.transcript, transcript)
        XCTAssertEqual(live.errors, [])
    }

    func testTheLanguageOfTheFirstSpeechIsKept() async {
        let fake = FakeTranscriber()
        fake.silentCalls = [0] // the meeting starts with silence, detected as "xx"
        let live = LiveTranscriber(transcriber: fake, windowSeconds: 10)
        feed(live, seconds: 35)
        let transcript = await live.finish()
        let languages = fake.snapshot.map(\.language)
        XCTAssertEqual(languages.count, 4)
        XCTAssertNil(languages[0])
        XCTAssertNil(languages[1], "a silent window does not decide the language")
        XCTAssertEqual(languages[2], "es")
        XCTAssertEqual(languages[3], "es")
        XCTAssertEqual(transcript.language, "es", "the language of the first window that has text")
        XCTAssertEqual(transcript.segments.count, 6)
    }

    func testAFailedWindowIsSkippedAndReported() async {
        let fake = FakeTranscriber()
        fake.failOnCall = 1
        let live = LiveTranscriber(transcriber: fake, windowSeconds: 10)
        feed(live, seconds: 25)
        let transcript = await live.finish()
        XCTAssertEqual(fake.snapshot.count, 3)
        XCTAssertEqual(live.errors.count, 1)
        XCTAssertTrue(live.errors[0].contains("window 1"))
        XCTAssertEqual(transcript.segments.count, 4)
        XCTAssertEqual(transcript.durationSeconds, 25, accuracy: 0.0001, "the failed window still counts as time")
    }

    func testTheStreamEndsAfterFinish() async {
        let live = LiveTranscriber(transcriber: FakeTranscriber(), windowSeconds: 5)
        let collector = Task { () -> [Int] in
            var indexes: [Int] = []
            for await update in live.updates { indexes.append(update.index) }
            return indexes
        }
        feed(live, seconds: 12)
        await live.finish()
        let indexes = await collector.value
        XCTAssertEqual(indexes, [0, 1, 2])
        // more audio after the end is ignored
        live.append(samples: [Float](repeating: 0.1, count: 16_000))
        let again = await live.finish()
        XCTAssertEqual(again.durationSeconds, 12, accuracy: 0.0001)
    }

    func testNothingFedGivesAnEmptyTranscript() async {
        let fake = FakeTranscriber()
        let live = LiveTranscriber(transcriber: fake)
        let transcript = await live.finish()
        XCTAssertTrue(transcript.isEmpty)
        XCTAssertEqual(fake.snapshot.count, 0)
    }
}
