import XCTest
@testable import MeetingKit

final class MeetingTranscriptTests: XCTestCase {
    func testJSONShape() throws {
        let data = try JSONEncoder().encode(sampleTranscript())
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["text", "language", "durationSeconds", "segments"])
        XCTAssertEqual(json["text"] as? String, "Hello there. General Kenobi.")
        XCTAssertEqual(json["language"] as? String, "en")
        XCTAssertEqual(json["durationSeconds"] as? Double, 3)
        let segments = try XCTUnwrap(json["segments"] as? [[String: Any]])
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(Set(segments[0].keys), ["start", "end", "text"])
        XCTAssertEqual(segments[0]["start"] as? Double, 0)
        XCTAssertEqual(segments[0]["end"] as? Double, 1.5)
        XCTAssertEqual(segments[0]["text"] as? String, "Hello there.")
    }

    func testDecodesWhatAnotherProgramWrote() throws {
        let text = #"{"text":"Hola. Adios.","language":"es","durationSeconds":4.25,"segments":[{"start":0,"end":2,"text":"Hola."},{"start":2,"end":4.25,"text":"Adios."}]}"#
        let transcript = try JSONDecoder().decode(MeetingTranscript.self, from: Data(text.utf8))
        XCTAssertEqual(transcript.language, "es")
        XCTAssertEqual(transcript.durationSeconds, 4.25)
        XCTAssertEqual(transcript.segments.last, .init(start: 2, end: 4.25, text: "Adios."))
        XCTAssertEqual(try JSONDecoder().decode(MeetingTranscript.self, from: JSONEncoder().encode(transcript)), transcript)
        // no language is fine
        let bare = try JSONDecoder().decode(MeetingTranscript.self, from: Data(#"{"text":"x","durationSeconds":1,"segments":[]}"#.utf8))
        XCTAssertNil(bare.language)
    }

    func testBuildsFromSegments() {
        let transcript = MeetingTranscript(
            segments: [
                .init(start: 5, end: 7, text: "  second  "),
                .init(start: 3, end: 4, text: "   "),
                .init(start: 0, end: 2, text: "first\n"),
            ],
            language: "en",
            durationSeconds: 8
        )
        XCTAssertEqual(transcript.text, "first second")
        XCTAssertEqual(transcript.segments.map(\.text), ["first", "second"])
        XCTAssertEqual(transcript.segments.map(\.start), [0, 5])
        XCTAssertFalse(transcript.isEmpty)
        XCTAssertTrue(MeetingTranscript(segments: [], language: nil, durationSeconds: 9).isEmpty)
    }

    func testJoined() {
        let first = MeetingTranscript(segments: [.init(start: 0, end: 10, text: "one")], language: "en", durationSeconds: 28.5)
        let silence = MeetingTranscript(text: "", language: nil, durationSeconds: 30, segments: [])
        let last = MeetingTranscript(segments: [.init(start: 60, end: 62, text: "two")], language: "en", durationSeconds: 11.5)
        let whole = MeetingTranscript.joined([first, silence, last])
        XCTAssertEqual(whole.text, "one two")
        XCTAssertEqual(whole.durationSeconds, 70)
        XCTAssertEqual(whole.language, "en")
        XCTAssertEqual(whole.segments.count, 2)
        XCTAssertTrue(MeetingTranscript.joined([]).isEmpty)
    }

    func testSoundLabelsAreNotSpeech() {
        for label in ["[Music]", "[M\u{FA}sica]", "(applause)", "[BLANK_AUDIO]", " [ Silence ] ", "*coughs*", "\u{266A} la la \u{266A}"] {
            XCTAssertTrue(Transcriber.isAnnotation(label), label)
        }
        for speech in ["Hello.", "[1] is the first item", "(a) first (b) second", "We agreed (mostly) on it.", "]", "",
                       "[this is far too long to be a sound label, it is something somebody said]"] {
            XCTAssertFalse(Transcriber.isAnnotation(speech), speech)
        }
    }

    func testWhisperMarkersAreRemoved() {
        XCTAssertEqual(Transcriber.clean("<|startoftranscript|><|en|><|transcribe|><|0.00|> Hello  world.<|2.40|><|endoftext|>"), "Hello world.")
        XCTAssertEqual(Transcriber.clean("  plain text "), "plain text")
        XCTAssertEqual(Transcriber.clean("a < b and c > d"), "a < b and c > d")
    }

    // MARK: - Mode, sides and speakers

    private func virtualTranscript() -> MeetingTranscript {
        MeetingTranscript(
            segments: [
                .init(start: 6, end: 9, text: "Mejor el lunes.", speaker: "s2", side: .remote),
                .init(start: 1, end: 5, text: "Entregamos el viernes.", speaker: "s1", side: .room),
                .init(start: 10, end: 11, text: "De acuerdo.", side: .room),
            ],
            language: "es",
            durationSeconds: 12,
            mode: .virtual,
            speakers: [MeetingSpeaker(id: "s1", number: 1, side: .room, name: "Ana"), MeetingSpeaker(id: "s2", number: 2, side: .remote)]
        )
    }

    func testJSONShapeWithSpeakers() throws {
        let transcript = virtualTranscript()
        XCTAssertEqual(transcript.text, "Entregamos el viernes. Mejor el lunes. De acuerdo.")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(transcript)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["text", "language", "durationSeconds", "segments", "mode", "speakers"])
        XCTAssertEqual(json["mode"] as? String, "virtual")
        let segments = try XCTUnwrap(json["segments"] as? [[String: Any]])
        XCTAssertEqual(Set(segments[0].keys), ["start", "end", "text", "speaker", "side"])
        XCTAssertEqual(segments[0]["speaker"] as? String, "s1")
        XCTAssertEqual(segments[0]["side"] as? String, "room")
        XCTAssertEqual(Set(segments[2].keys), ["start", "end", "text", "side"], "no speaker, no key")
        let speakers = try XCTUnwrap(json["speakers"] as? [[String: Any]])
        XCTAssertEqual(speakers[0]["id"] as? String, "s1")
        XCTAssertEqual(speakers[0]["number"] as? Int, 1)
        XCTAssertEqual(speakers[0]["side"] as? String, "room")
        XCTAssertEqual(speakers[0]["name"] as? String, "Ana")
        XCTAssertTrue(speakers[1]["name"] is NSNull)
        // and back
        XCTAssertEqual(try JSONDecoder().decode(MeetingTranscript.self, from: JSONEncoder().encode(transcript)), transcript)
        XCTAssertEqual(transcript.speaker("s2")?.number, 2)
        XCTAssertNil(transcript.speaker("s9"))
        XCTAssertNil(transcript.speaker(nil))
    }

    func testAnInPersonSpeakerHasNoSide() throws {
        let speaker = MeetingSpeaker(id: "s1", number: 1)
        let text = String(decoding: try JSONEncoder().encode(speaker), as: UTF8.self)
        XCTAssertTrue(text.contains(#""side":null"#), text)
        XCTAssertTrue(text.contains(#""name":null"#), text)
        XCTAssertEqual(try JSONDecoder().decode(MeetingSpeaker.self, from: Data(text.utf8)), speaker)
        // keys may also be missing
        XCTAssertEqual(try JSONDecoder().decode(MeetingSpeaker.self, from: Data(#"{"id":"s1","number":1}"#.utf8)), speaker)
        XCTAssertEqual(MeetingMode.inPerson.rawValue, "in_person")
        XCTAssertEqual(MeetingMode.virtual.rawValue, "virtual")
        XCTAssertEqual(MeetingSide.allCases.map(\.rawValue), ["room", "remote"])
        XCTAssertTrue(MeetingSpeaker.isValidId("s12"))
        XCTAssertTrue(MeetingSpeaker.isValidId("room_1-a"))
        XCTAssertFalse(MeetingSpeaker.isValidId(""))
        XCTAssertFalse(MeetingSpeaker.isValidId("S1"))
        XCTAssertFalse(MeetingSpeaker.isValidId(String(repeating: "a", count: 41)))
    }

    func testTheTwoTracksMergeByTimeTheRoomFirstWhenBothStartTogether() {
        let transcript = MeetingTranscript(
            segments: [
                .init(start: 5, end: 6, text: "remote at five", side: .remote),
                .init(start: 5, end: 6, text: "room at five", side: .room),
                .init(start: 2, end: 3, text: "remote at two", side: .remote),
                .init(start: 5, end: 7, text: "room at five again", side: .room),
            ],
            language: nil,
            durationSeconds: 8,
            mode: .virtual
        )
        XCTAssertEqual(transcript.segments.map(\.text), ["remote at two", "room at five", "room at five again", "remote at five"])
        XCTAssertEqual(transcript.speakers, [])
    }

    func testJoinedKeepsModeAndSpeakers() {
        let first = virtualTranscript()
        var second = MeetingTranscript(
            segments: [.init(start: 20, end: 22, text: "Hasta luego.", speaker: "s3", side: .remote)],
            language: "es", durationSeconds: 10, mode: .virtual,
            speakers: [MeetingSpeaker(id: "s2", number: 2, side: .remote), MeetingSpeaker(id: "s3", number: 3, side: .remote)]
        )
        second.speakers[0].name = "ignored: the first one wins"
        let whole = MeetingTranscript.joined([first, second])
        XCTAssertEqual(whole.mode, .virtual)
        XCTAssertEqual(whole.speakers.map(\.id), ["s1", "s2", "s3"])
        XCTAssertNil(whole.speakers[1].name)
        XCTAssertEqual(whole.segments.count, 4)
        XCTAssertEqual(whole.segments.last?.speaker, "s3")
        // plain transcripts join into a plain one
        XCTAssertNil(MeetingTranscript.joined([sampleTranscript(), sampleTranscript()]).mode)
    }
}
