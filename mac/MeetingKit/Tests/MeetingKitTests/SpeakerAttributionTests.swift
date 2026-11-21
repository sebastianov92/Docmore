import XCTest
@testable import MeetingKit

final class SpeakerAttributionTests: XCTestCase {
    private let twoVoices = TrackSpeakers(side: .room, turns: [
        .init(start: 0, end: 5, speaker: "s1"),
        .init(start: 5, end: 10, speaker: "s2"),
    ])

    func testEachSegmentGetsTheSpeakerWhoTalksTheMostInIt() {
        let out = SpeakerAttribution.label(
            [timed("uno dos tres", 0.2, 4.6), timed("cuatro cinco seis", 5.3, 9.0)],
            speakers: twoVoices
        )
        XCTAssertEqual(out.map(\.speaker), ["s1", "s2"])
        XCTAssertEqual(out.map(\.side), [.room, .room])
        XCTAssertEqual(out.map(\.text), ["uno dos tres", "cuatro cinco seis"])
        XCTAssertEqual(out[0].start, 0.2)
        XCTAssertEqual(out[0].end, 4.6)
        XCTAssertEqual(out[0].words.count, 3, "the words stay with the segment")
    }

    func testASegmentTwoVoicesShareIsSplitWhereTheVoiceChanges() {
        // ten words over six seconds: five before second 5, five after
        let out = SpeakerAttribution.label(
            [timed("pregunta de uno dos tres respuesta de dos cuatro cinco", 2, 8)],
            speakers: twoVoices
        )
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out.map(\.speaker), ["s1", "s2"])
        XCTAssertEqual(out.map(\.text), ["pregunta de uno dos tres", "respuesta de dos cuatro cinco"])
        XCTAssertEqual(out[0].start, 2, accuracy: 1e-9)
        XCTAssertEqual(out[0].end, 5, accuracy: 1e-9)
        XCTAssertEqual(out[1].start, 5, accuracy: 1e-9)
        XCTAssertEqual(out[1].end, 8, accuracy: 1e-9)
        XCTAssertEqual(out.map { $0.words.count }, [5, 5])
    }

    func testTheEdgeOfATurnFallingALittleOffDoesNotSplit() {
        // eight words from 0.5 to 5.4: only the last one reaches into the second voice
        let out = SpeakerAttribution.label([timed("uno dos tres cuatro cinco seis siete ocho", 0.5, 5.4)], speakers: twoVoices)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].speaker, "s1")
        XCTAssertEqual(out[0].text, "uno dos tres cuatro cinco seis siete ocho")

        // a short answer of one word inside somebody's sentence stays there too
        let speakers = TrackSpeakers(turns: [
            .init(start: 0, end: 4, speaker: "s1"), .init(start: 4, end: 4.5, speaker: "s2"), .init(start: 4.5, end: 10, speaker: "s1"),
        ])
        let folded = SpeakerAttribution.label([timed("a b c d e f g h i j", 0, 10)], speakers: speakers)
        XCTAssertEqual(folded.map(\.speaker), ["s1"])
    }

    func testWithoutWordTimesTheWholeSegmentGoesToOneSpeaker() {
        let out = SpeakerAttribution.label(
            [timed("pregunta y respuesta en un solo segmento", 3, 9, wordTimes: false)],
            speakers: twoVoices
        )
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].speaker, "s2", "four of its six seconds are the second voice")
        XCTAssertEqual(out[0].words, [])
    }

    func testASegmentJustOutsideATurnTakesTheNearestOne() {
        let speakers = TrackSpeakers(turns: [.init(start: 0, end: 5, speaker: "s1")])
        let out = SpeakerAttribution.label(
            [timed("casi dentro", 5.4, 6.0), timed("muy lejos de todo", 20, 22)],
            speakers: speakers
        )
        XCTAssertEqual(out.map(\.speaker), ["s1", nil])
    }

    func testNoSpeakersGivesSegmentsWithOnlyTheirSide() {
        let out = SpeakerAttribution.label([timed("hola", 0, 1), timed("   ", 1, 2)], speakers: TrackSpeakers(side: .remote))
        XCTAssertEqual(out.count, 1, "an empty segment is dropped")
        XCTAssertNil(out[0].speaker)
        XCTAssertEqual(out[0].side, .remote)
        XCTAssertEqual(out[0].plain, MeetingTranscript.Segment(start: 0, end: 1, text: "hola", speaker: nil, side: .remote))
    }

    func testAVoiceThatIsNotASpeakerYetLabelsNothing() {
        var speakers = TrackSpeakers()
        var count = 0
        // four seconds: provisional
        _ = speakers.absorb(diarization([(0, 4, 0)]), from: 0, to: 5) {
            count += 1
            return "s\(count)"
        }
        XCTAssertEqual(speakers.turns.count, 1)
        XCTAssertEqual(speakers.labelledTurns.count, 0)
        let out = SpeakerAttribution.label([timed("todavía sin nombre", 0.5, 3.5)], speakers: speakers)
        XCTAssertEqual(out.map(\.speaker), [nil])
    }
}
