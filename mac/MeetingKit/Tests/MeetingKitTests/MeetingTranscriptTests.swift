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
}
