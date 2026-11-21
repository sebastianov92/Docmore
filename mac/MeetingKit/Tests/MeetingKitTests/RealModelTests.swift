import XCTest
@testable import MeetingKit

/// The whole thing with the real models, over the Spanish test meeting kept
/// in the repository (mac/tools/fixtures/meeting-es): two voices in the
/// room, two on the call, a delivery date that changes from Friday to
/// Monday. Each test is skipped when the models it needs are not on disk
/// (see `RealModels`): `meetingkit download turbo` and `meetingkit download
/// speakers` into `.build/scratch/models` put them there.
final class RealModelTests: XCTestCase {
    private struct Truth: Decodable {
        struct Turn: Decodable {
            var speaker: String
            var side: MeetingSide
            var start: Double
            var end: Double
            var text: String
        }
        var durationSeconds: Double
        var turns: [Turn]
    }

    private func truth() throws -> Truth {
        let url = try RealModels.meetingRecording().deletingLastPathComponent().appendingPathComponent("meeting-es.json")
        return try JSONDecoder().decode(Truth.self, from: Data(contentsOf: url))
    }

    /// The reference speaker who talks the most in a span of one side.
    private func owner(_ truth: Truth, side: MeetingSide?, from start: Double, to end: Double) -> String? {
        var shared: [String: Double] = [:]
        for turn in truth.turns where side == nil || turn.side == side {
            let overlap = min(end, turn.end) - max(start, turn.start)
            if overlap > 0 { shared[turn.speaker, default: 0] += overlap }
        }
        return shared.max { $0.value < $1.value }?.key
    }

    /// For each speaker id of a transcript, the reference speakers its
    /// segments belong to, with the seconds.
    private func voices(of transcript: MeetingTranscript, in truth: Truth) -> [String: [String: Double]] {
        var out: [String: [String: Double]] = [:]
        for segment in transcript.segments {
            guard let speaker = segment.speaker, let name = owner(truth, side: segment.side, from: segment.start, to: segment.end) else { continue }
            out[speaker, default: [:]][name, default: 0] += segment.end - segment.start
        }
        return out
    }

    /// Asserts that the transcript has the four people of the meeting, one
    /// speaker each, and returns speaker id -> name.
    private func assertFourPeople(_ transcript: MeetingTranscript, _ truth: Truth, file: StaticString = #filePath, line: UInt = #line) -> [String: String] {
        let found = voices(of: transcript, in: truth)
        var names: [String: String] = [:]
        for (speaker, shares) in found {
            let total = shares.values.reduce(0, +)
            guard let best = shares.max(by: { $0.value < $1.value }) else { continue }
            XCTAssertGreaterThan(best.value / total, 0.9, "\(speaker) is one person: \(shares)", file: file, line: line)
            names[speaker] = best.key
        }
        XCTAssertEqual(Set(names.values), ["Ana", "Luis", "Marta", "Carlos"], "\(found)", file: file, line: line)
        XCTAssertEqual(names.count, 4, "one speaker per person: \(found)", file: file, line: line)
        XCTAssertEqual(transcript.speakers.count, 4, file: file, line: line)
        for speaker in transcript.speakers {
            let expected: MeetingSide = ["Ana", "Luis"].contains(names[speaker.id] ?? "") ? .room : .remote
            XCTAssertEqual(speaker.side, expected, "\(speaker.id) is \(names[speaker.id] ?? "?")", file: file, line: line)
        }
        return names
    }

    private func normalized(_ text: String) -> String {
        EchoFilter.normalize(text).joined(separator: " ")
    }

    func testTheSpeakerModelsTellTheFourVoicesApart() async throws {
        let store = try RealModels.store(speakers: true)
        let truth = try truth()
        let tracks = try MeetingTracks(contentsOf: RealModels.meetingRecording())
        XCTAssertEqual(tracks.durationSeconds, truth.durationSeconds, accuracy: 0.01)
        let diarizer = SpeakerDiarizer(modelStore: store)
        XCTAssertTrue(diarizer.isAvailable)

        // everybody in one track, as in an in-person recording
        let result = try await diarizer.diarize(samples: tracks.mixed, options: .meeting)
        XCTAssertEqual(result.clusters.count, 4)
        XCTAssertEqual(Set(result.voicePrints.keys), Set(result.clusters))
        XCTAssertTrue(result.voicePrints.values.allSatisfy { $0.count == 256 })
        // each cluster is one person: the seconds of every cluster, by who was really talking
        var shares: [Int: [String: Double]] = [:]
        for turn in result.turns {
            guard let name = owner(truth, side: nil, from: turn.start, to: turn.end) else { continue }
            shares[turn.cluster, default: [:]][name, default: 0] += turn.duration
        }
        let people = shares.mapValues { $0.max { $0.value < $1.value }?.key ?? "" }
        XCTAssertEqual(Set(people.values), ["Ana", "Luis", "Marta", "Carlos"], "\(shares)")
        let right = shares.reduce(0.0) { $0 + ($1.value[people[$1.key] ?? ""] ?? 0) }
        let total = shares.reduce(0.0) { $0 + $1.value.values.reduce(0, +) }
        XCTAssertGreaterThan(right / total, 0.95, "\(shares)")
        // two different people are far apart, as measured (STATUS.md)
        for first in result.clusters {
            for second in result.clusters where first < second {
                XCTAssertGreaterThan(VoicePrint.distance(result.voicePrints[first]!, result.voicePrints[second]!), 0.4)
            }
        }

        // each side alone: two voices each
        let room = try await diarizer.diarize(samples: tracks.room, options: .meeting)
        let remote = try await diarizer.diarize(samples: tracks.remote ?? [], options: .meeting)
        XCTAssertEqual(room.clusters.count, 2)
        XCTAssertEqual(remote.clusters.count, 2)
        // a voice of the room is the same voice in the mixed track
        let nearest = result.voicePrints.values.map { VoicePrint.distance($0, room.voicePrints[room.clusters[0]]!) }.min() ?? 1
        XCTAssertLessThan(nearest, 0.2)
        // under a second of audio there is nothing to tell apart
        let nothing = try await diarizer.diarize(samples: [Float](repeating: 0, count: 8_000))
        XCTAssertEqual(nothing.turns, [])
    }

    func testTheFinalPassGivesSidesSpeakersAndTheStory() async throws {
        let store = try RealModels.store(speakers: true)
        let model = try RealModels.whisper(in: store)
        let truth = try truth()
        let processor = MeetingProcessor(
            transcriber: Transcriber(modelStore: store, model: model, language: .fixed("es")),
            diarizer: SpeakerDiarizer(modelStore: store)
        )
        let result = try await processor.process(fileURL: RealModels.meetingRecording(), mode: .virtual)
        let transcript = result.transcript

        XCTAssertEqual(transcript.mode, .virtual)
        XCTAssertEqual(transcript.language, "es")
        XCTAssertEqual(transcript.durationSeconds, truth.durationSeconds, accuracy: 0.01)
        XCTAssertEqual(result.notes, [])
        XCTAssertEqual(result.echoes, [], "the tracks are clean: nothing is an echo")
        XCTAssertTrue(transcript.segments.allSatisfy { $0.side != nil && $0.speaker != nil })
        XCTAssertEqual(transcript.segments.map(\.start), transcript.segments.map(\.start).sorted())
        XCTAssertEqual(transcript.text, transcript.segments.map(\.text).joined(separator: " "))

        // four people, one speaker each, on their side, numbered as they first speak
        let names = assertFourPeople(transcript, truth)
        XCTAssertEqual(transcript.speakers.map(\.id), ["s1", "s2", "s3", "s4"])
        XCTAssertEqual(transcript.speakers.map(\.number), [1, 2, 3, 4])
        XCTAssertEqual(transcript.speakers.map { names[$0.id] }, ["Ana", "Marta", "Luis", "Carlos"])
        XCTAssertTrue(transcript.speakers.allSatisfy { $0.name == nil })

        // every turn of the meeting is there, said by who said it
        for turn in truth.turns where turn.end - turn.start > 2 {
            let inside = transcript.segments.filter { $0.side == turn.side && min($0.end, turn.end) - max($0.start, turn.start) > 0.5 * ($0.end - $0.start) }
            XCTAssertFalse(inside.isEmpty, turn.text)
            XCTAssertTrue(inside.allSatisfy { names[$0.speaker ?? ""] == turn.speaker }, "\(turn.speaker): \(turn.text)")
        }
        // the decision and its change are in the text, in that order, said in the room
        let text = normalized(transcript.text)
        let friday = try XCTUnwrap(text.range(of: "entregamos el viernes"))
        let monday = try XCTUnwrap(text.range(of: "mejor el lunes"))
        XCTAssertLessThan(friday.lowerBound, monday.lowerBound)
        let decision = try XCTUnwrap(transcript.segments.first { normalized($0.text).contains("mejor el lunes") })
        XCTAssertEqual(names[decision.speaker ?? ""], "Ana")
        XCTAssertEqual(decision.side, .room)
        // the task given by name
        let task = try XCTUnwrap(transcript.segments.first { normalized($0.text).contains("presentacion para el cliente") })
        XCTAssertEqual(names[task.speaker ?? ""], "Luis")

        // without the speaker models: the same text, sides and no speakers
        let plain = try await MeetingProcessor(
            transcriber: Transcriber(modelStore: store, model: model, language: .fixed("es")), diarizer: nil
        ).process(fileURL: RealModels.meetingRecording(), mode: .virtual)
        XCTAssertEqual(plain.transcript.speakers, [])
        XCTAssertTrue(plain.transcript.segments.allSatisfy { $0.speaker == nil && $0.side != nil })
        XCTAssertEqual(normalized(plain.transcript.segments.filter { $0.side == .remote }.map(\.text).joined(separator: " ")),
                       normalized(transcript.segments.filter { $0.side == .remote }.map(\.text).joined(separator: " ")))
    }

    func testTheEchoOfLoudspeakersIsRemovedAndNothingTheRoomSaid() async throws {
        let store = try RealModels.store(speakers: true)
        let model = try RealModels.whisper(in: store)
        let truth = try truth()
        let clean = try MeetingTracks(contentsOf: RealModels.meetingRecording())
        // the call on loudspeakers, made up: the remote track 180 ms later at 0.35 of its level, on top of the microphone
        var microphone = clean.room
        let remote = clean.remote ?? []
        let delay = Int(0.18 * 16_000)
        for index in delay..<microphone.count {
            microphone[index] = max(-1, min(1, microphone[index] + 0.35 * remote[index - delay]))
        }
        let processor = MeetingProcessor(
            transcriber: Transcriber(modelStore: store, model: model, language: .fixed("es")),
            diarizer: SpeakerDiarizer(modelStore: store)
        )
        let result = try await processor.process(MeetingTracks(room: microphone, remote: remote), mode: .virtual)
        let transcript = result.transcript

        // the twelve remote turns were heard twice and dropped once
        let remoteTurns = truth.turns.filter { $0.side == .remote }
        XCTAssertGreaterThanOrEqual(result.echoes.count, remoteTurns.count - 1)
        // nothing that is left in the room is a sentence of the remote side
        for segment in transcript.segments where segment.side == .room {
            XCTAssertEqual(owner(truth, side: nil, from: segment.start, to: segment.end).map { ["Ana", "Luis"].contains($0) }, true,
                           "left in the room: \(segment.text)")
        }
        // and every sentence the room did say is still there
        for turn in truth.turns where turn.side == .room && turn.end - turn.start > 2 {
            XCTAssertTrue(transcript.segments.contains { $0.side == .room && min($0.end, turn.end) - max($0.start, turn.start) > 1 }, turn.text)
        }
        XCTAssertFalse(result.echoes.contains { echo in
            owner(truth, side: .room, from: echo.start, to: echo.end) != nil && owner(truth, side: .remote, from: echo.start - 0.5, to: echo.end) == nil
        }, "an echo is always something the remote side was saying")
        // the voices of the loudspeaker are not people in the room
        _ = assertFourPeople(transcript, truth)
    }

    func testTheLiveSessionFollowsTheMeetingAndHandsItsSpeakersOn() async throws {
        let store = try RealModels.store(speakers: true)
        let model = try RealModels.whisper(in: store)
        let truth = try truth()
        let tracks = try MeetingTracks(contentsOf: RealModels.meetingRecording())
        let transcriber = Transcriber(modelStore: store, model: model, language: .fixed("es"))
        let diarizer = SpeakerDiarizer(modelStore: store)
        let session = LiveMeetingSession(mode: .virtual, transcriber: transcriber, diarizer: diarizer)
        let seen = Box<LiveMeetingUpdate>()
        session.onUpdate = { seen.add($0) }

        let remote = tracks.remote ?? []
        var offset = 0
        while offset < tracks.room.count {
            let end = min(tracks.room.count, offset + 1600)
            session.append(microphone: Array(tracks.room[offset..<end]), systemAudio: Array(remote[offset..<end]))
            offset = end
        }
        let live = await session.finish()
        XCTAssertEqual(session.errors, [])

        // what the panel showed in the end: four people on their sides
        let liveNames = assertFourPeople(live, truth)
        XCTAssertTrue(live.segments.allSatisfy { $0.side != nil })
        var list: [MeetingTranscript.Segment] = []
        for update in seen.values {
            XCTAssertEqual(update.segmentCount, update.fromIndex + update.segments.count)
            list = Array(list.prefix(update.fromIndex)) + update.segments
        }
        XCTAssertEqual(list, live.segments)
        XCTAssertGreaterThanOrEqual(seen.values.count, 8, "about one update every fifteen seconds")
        XCTAssertEqual(seen.values.last?.isFinal, true)

        // the person named Marta during the meeting
        let marta = try XCTUnwrap(liveNames.first { $0.value == "Marta" }?.key)
        XCTAssertTrue(session.setName("Marta", forSpeaker: marta))

        // the final pass over the recording: better text, the same speakers
        let final = try await MeetingProcessor(transcriber: transcriber, diarizer: diarizer)
            .process(tracks, mode: .virtual, state: session.state)
        let finalNames = assertFourPeople(final.transcript, truth)
        XCTAssertEqual(finalNames, liveNames, "every person kept the id they had while the meeting ran")
        XCTAssertEqual(final.transcript.speaker(marta)?.name, "Marta")
        XCTAssertEqual(Set(final.transcript.speakers.map(\.id)), Set(live.speakers.map(\.id)))
        for speaker in final.transcript.speakers {
            XCTAssertEqual(speaker.number, live.speakers.first { $0.id == speaker.id }?.number)
        }
    }
}
