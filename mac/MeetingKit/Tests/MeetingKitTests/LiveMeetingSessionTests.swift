import XCTest
@testable import MeetingKit

final class LiveMeetingSessionTests: XCTestCase {
    // An in-person minute: two voices take turns.
    private let text = [
        timed("uno uno uno uno", 1, 9),
        timed("dos dos dos dos", 16, 26),
        timed("tres tres tres tres", 31, 39),
        timed("cuatro cuatro cuatro cuatro", 46, 54),
    ]
    private let voices: [(Double, Double, Int)] = [(1, 9, 0), (16, 26, 1), (31, 39, 0), (46, 54, 1)]

    private func options(speakerWindow: Double = 600) -> LiveMeetingOptions {
        var options = LiveMeetingOptions()
        options.speakerWindowSeconds = speakerWindow
        options.usesEchoGate = false     // the audio here is made up: only its text and its turns mean anything
        return options
    }

    /// The way the recorder hands audio over: a tenth of a second at a time.
    private func feed(_ session: LiveMeetingSession, room: [Float], remote: [Float]? = nil) {
        var offset = 0
        while offset < room.count {
            let end = min(room.count, offset + 1600)
            session.append(MeetingAudioChunk(microphone: Array(room[offset..<end]), systemAudio: remote.map { Array($0[offset..<end]) }))
            offset = end
        }
    }

    /// What somebody who follows the updates has in the end.
    private func applying(_ updates: [LiveMeetingUpdate]) -> [MeetingTranscript.Segment] {
        var list: [MeetingTranscript.Segment] = []
        for update in updates {
            list = Array(list.prefix(update.fromIndex)) + update.segments
        }
        return list
    }

    func testUpdatesCarryTheChangedTailAndTheSpeakers() async {
        let transcriber = ScriptedTranscriber([text])
        let diarizer = ScriptedDiarizer([voices])
        let session = LiveMeetingSession(mode: .inPerson, transcriber: transcriber, diarizer: diarizer, options: options())
        let seen = Box<LiveMeetingUpdate>()
        session.onUpdate = { seen.add($0) }

        feed(session, room: ScriptedAudio.track(0, seconds: 60))
        let transcript = await session.finish()
        let updates = seen.values

        // the transcript at the end: every sentence, each with its voice
        XCTAssertEqual(transcript.mode, .inPerson)
        XCTAssertEqual(transcript.language, "es")
        XCTAssertEqual(transcript.segments.map(\.text), text.map(\.text))
        XCTAssertEqual(transcript.segments.map(\.speaker), ["s1", "s2", "s1", "s2"])
        XCTAssertTrue(transcript.segments.allSatisfy { $0.side == nil })
        XCTAssertEqual(transcript.speakers, [MeetingSpeaker(id: "s1", number: 1), MeetingSpeaker(id: "s2", number: 2)])
        XCTAssertEqual(transcript.durationSeconds, 60, accuracy: 1e-6)
        for (segment, expected) in zip(transcript.segments, text) {
            XCTAssertEqual(segment.start, expected.start, accuracy: 1e-6)
            XCTAssertEqual(segment.end, expected.end, accuracy: 1e-6)
        }
        XCTAssertEqual(session.segments, transcript.segments)
        XCTAssertEqual(session.speakers, transcript.speakers)
        XCTAssertEqual(session.errors, [])

        // the updates: one per window that changed something, then the closing one
        XCTAssertEqual(updates.map(\.revision), Array(1...updates.count))
        XCTAssertTrue(updates.allSatisfy { $0.segmentCount == $0.fromIndex + $0.segments.count })
        XCTAssertEqual(updates.map(\.segmentCount), [1, 2, 3, 4, 4])
        XCTAssertEqual(updates.map(\.fromIndex), [0, 1, 2, 3, 4], "only the new tail each time")
        XCTAssertEqual(updates.map(\.isFinal), [false, false, false, false, true])
        XCTAssertEqual(updates.map { $0.speakers.map(\.id) }, [["s1"], ["s1", "s2"], ["s1", "s2"], ["s1", "s2"], ["s1", "s2"]])
        XCTAssertEqual(applying(updates), transcript.segments, "following the updates gives the transcript")
        XCTAssertEqual(updates.map(\.durationSeconds), updates.map(\.durationSeconds).sorted())

        // every sample was transcribed once; the speaker models heard the meeting so far each time
        XCTAssertEqual(transcriber.snapshot.reduce(0) { $0 + $1.seconds }, 60, accuracy: 1e-6)
        XCTAssertTrue(transcriber.snapshot.allSatisfy { $0.seconds <= 15 })
        XCTAssertEqual(transcriber.snapshot.dropFirst().map(\.language), Array(repeating: "es", count: transcriber.snapshot.count - 1))
        XCTAssertTrue(diarizer.snapshot.allSatisfy { $0.start == 0 }, "the window has not started to slide in a minute")
        XCTAssertGreaterThanOrEqual(diarizer.snapshot.count, 4)
    }

    func testTheStreamEndsAndLateAudioIsIgnored() async {
        let session = LiveMeetingSession(mode: .inPerson, transcriber: ScriptedTranscriber([text]), diarizer: ScriptedDiarizer([voices]), options: options())
        let collector = Task { () -> [LiveMeetingUpdate] in
            var all: [LiveMeetingUpdate] = []
            for await update in session.updates { all.append(update) }
            return all
        }
        feed(session, room: ScriptedAudio.track(0, seconds: 30))
        let first = await session.finish()
        feed(session, room: ScriptedAudio.track(0, seconds: 30))
        let second = await session.finish()
        XCTAssertEqual(first, second)
        let streamed = await collector.value
        XCTAssertEqual(streamed.last?.isFinal, true)
        XCTAssertEqual(applying(streamed), first.segments)
    }

    func testSpeakerIdsNeverChangeAndAVoiceThatComesBackGetsItsIdBack() async {
        // four minutes with a one-minute window for the speaker models. Three
        // voices open; then two of them talk for three minutes; then the
        // third one comes back.
        var script: [TimedTranscript.Segment] = [timed("primera voz habla ahora", 1, 11), timed("segunda voz habla ahora", 16, 28), timed("tercera voz habla ahora", 31, 43)]
        var turns: [(Double, Double, Int)] = [(1, 11, 0), (16, 28, 1), (31, 43, 2)]
        for index in 0..<12 {
            let start = 46 + Double(index) * 15
            script.append(timed("sigue la conversación número \(index)", start, start + 10))
            turns.append((start, start + 10, index % 2))
        }
        script.append(timed("la tercera voz vuelve después de tres minutos", 231, 245))
        turns.append((231, 245, 2))

        let diarizer = ScriptedDiarizer([turns])
        let session = LiveMeetingSession(mode: .inPerson, transcriber: ScriptedTranscriber([script]), diarizer: diarizer, options: options(speakerWindow: 60))
        let seen = Box<LiveMeetingUpdate>()
        session.onUpdate = { seen.add($0) }
        feed(session, room: ScriptedAudio.track(0, seconds: 260))
        let transcript = await session.finish()

        XCTAssertEqual(transcript.segments.count, script.count)
        XCTAssertEqual(transcript.speakers.map(\.id), ["s1", "s2", "s3"])
        let speakerOfVoice: [Int: String] = [0: "s1", 1: "s2", 2: "s3"]
        XCTAssertEqual(transcript.segments.map(\.speaker), turns.map { speakerOfVoice[$0.2] })
        XCTAssertEqual(transcript.segments.last?.speaker, transcript.segments[2].speaker, "the voice that came back is who it was")

        // the window did slide, and the diarizer numbered its clusters differently on every pass
        XCTAssertTrue(diarizer.snapshot.contains { $0.start > 100 })
        XCTAssertTrue(diarizer.snapshot.allSatisfy { $0.seconds <= 60.001 })

        // nobody who followed the updates ever saw a sentence change hands
        var list: [MeetingTranscript.Segment] = []
        var owners: [Double: Set<String>] = [:]
        for update in seen.values {
            list = Array(list.prefix(update.fromIndex)) + update.segments
            for segment in list {
                if let speaker = segment.speaker { owners[segment.start, default: []].insert(speaker) }
            }
        }
        XCTAssertTrue(owners.values.allSatisfy { $0.count == 1 })
        XCTAssertEqual(list, transcript.segments)
    }

    func testANameTypedDuringTheMeetingIsOnTheSameVoiceInTheFinalTranscript() async throws {
        let session = LiveMeetingSession(mode: .inPerson, transcriber: ScriptedTranscriber([text]), diarizer: ScriptedDiarizer([voices]), options: options())
        let seen = Box<LiveMeetingUpdate>()
        let typed = Box<String>()
        session.onUpdate = { [unowned session] update in
            seen.add(update)
            // the person names the second voice the moment it shows up
            if typed.count == 0, update.speakers.contains(where: { $0.id == "s2" }) {
                typed.add("s2")
                XCTAssertTrue(session.setName("Luis", forSpeaker: "s2"))
            }
        }
        feed(session, room: ScriptedAudio.track(0, seconds: 60))
        let live = await session.finish()
        XCTAssertFalse(session.setName("Nobody", forSpeaker: "s9"))

        XCTAssertEqual(live.speakers, [MeetingSpeaker(id: "s1", number: 1), MeetingSpeaker(id: "s2", number: 2, name: "Luis")])
        // every update after the name was typed carries it
        let updates = seen.values
        let firstNamed = try XCTUnwrap(updates.firstIndex { $0.speakers.contains { $0.name == "Luis" } })
        XCTAssertTrue(updates[firstNamed...].allSatisfy { $0.speakers.first { $0.id == "s2" }?.name == "Luis" })
        XCTAssertEqual(updates[firstNamed].segments, [], "a name changes no segment")
        XCTAssertEqual(updates[firstNamed].fromIndex, updates[firstNamed].segmentCount)

        // the final pass over the recording starts from what the session knew
        let state = session.state
        XCTAssertEqual(state.speakers.first { $0.id == "s2" }?.name, "Luis")
        let copy = try JSONDecoder().decode(MeetingSpeakerState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(copy, state, "it can be kept next to the recording")
        var processing = MeetingProcessingOptions()
        processing.usesEchoGate = false
        // the final diarizer numbers its clusters its own way, and the text comes out in other pieces
        let final = try await MeetingProcessor(transcriber: ScriptedTranscriber([text]), diarizer: ScriptedDiarizer([voices]), options: processing)
            .process(MeetingTracks(room: ScriptedAudio.track(0, seconds: 60)), mode: .inPerson, state: copy)
        XCTAssertEqual(final.transcript.speakers, live.speakers)
        XCTAssertEqual(final.transcript.segments.map(\.speaker), ["s1", "s2", "s1", "s2"])
        XCTAssertEqual(final.transcript.speaker("s2")?.name, "Luis")
    }

    func testAVirtualMeetingHasSidesAndSilenceIsNotTranscribed() async {
        // nothing plays on the call for the first fifteen seconds
        let room = ScriptedAudio.track(0, seconds: 45)
        let remote = ScriptedAudio.track(1, seconds: 45, silentSeconds: Set(0..<15))
        let transcriber = ScriptedTranscriber([
            [timed("hola equipo empezamos ya", 1, 6), timed("de acuerdo lo reviso mañana", 31, 39)],
            [timed("tenemos listo el informe de ventas", 18, 26)],
        ])
        let diarizer = ScriptedDiarizer([[(1, 6, 0), (31, 39, 0)], [(18, 26, 0)]])
        let session = LiveMeetingSession(mode: .virtual, transcriber: transcriber, diarizer: diarizer, options: options())
        let seen = Box<LiveMeetingUpdate>()
        session.onUpdate = { seen.add($0) }
        feed(session, room: room, remote: remote)
        let transcript = await session.finish()

        XCTAssertEqual(transcript.mode, .virtual)
        XCTAssertEqual(transcript.segments.map(\.side), [.room, .remote, .room])
        XCTAssertEqual(transcript.segments.map(\.speaker), ["s1", "s2", "s1"])
        XCTAssertEqual(transcript.speakers, [MeetingSpeaker(id: "s1", number: 1, side: .room), MeetingSpeaker(id: "s2", number: 2, side: .remote)])
        // the silent start of the remote track was never given to Whisper
        XCTAssertFalse(transcriber.snapshot.contains { $0.track == 1 && $0.start < 10 })
        XCTAssertTrue(transcriber.snapshot.contains { $0.track == 1 })
        XCTAssertEqual(transcriber.snapshot.filter { $0.track == 0 }.reduce(0) { $0 + $1.seconds }, 45, accuracy: 1e-6)

        // five seconds of a first voice: text at once, its speaker one window later
        let updates = seen.values
        XCTAssertEqual(updates[0].segments.map(\.speaker), [nil])
        XCTAssertEqual(updates[0].segments.map(\.side), [.room])
        XCTAssertEqual(updates[0].speakers, [])
        XCTAssertEqual(updates[1].fromIndex, 0, "the first sentence got its speaker: the update starts there")
        XCTAssertEqual(updates[1].segments.map(\.speaker), ["s1", "s2"])
        XCTAssertEqual(applying(updates), transcript.segments)
    }

    func testTheEchoOfTheRemoteSideIsNeverShown() async {
        let transcriber = ScriptedTranscriber([
            [timed("hola equipo empezamos ya", 1, 6), timed("tenemos listo el informe de ventas", 18.2, 26.2), timed("perfecto gracias por el informe", 31, 37)],
            [timed("tenemos listo el informe de ventas", 18, 26)],
        ])
        let diarizer = ScriptedDiarizer([[(1, 6, 0), (18.2, 26.2, 3), (31, 37, 0)], [(18, 26, 0)]])
        let session = LiveMeetingSession(mode: .virtual, transcriber: transcriber, diarizer: diarizer, options: options())
        let seen = Box<LiveMeetingUpdate>()
        session.onUpdate = { seen.add($0) }
        feed(session, room: ScriptedAudio.track(0, seconds: 45), remote: ScriptedAudio.track(1, seconds: 45))
        let transcript = await session.finish()

        XCTAssertEqual(transcript.segments.map(\.text), ["hola equipo empezamos ya", "tenemos listo el informe de ventas", "perfecto gracias por el informe"])
        XCTAssertEqual(transcript.segments.map(\.side), [.room, .remote, .room])
        // not even for a moment
        XCTAssertFalse(seen.values.contains { update in
            update.segments.contains { $0.side == .room && $0.text == "tenemos listo el informe de ventas" }
        })
        // the voice of the loudspeaker is not a speaker
        XCTAssertEqual(transcript.speakers.map(\.side), [.room, .remote])
        XCTAssertEqual(transcript.segments[0].speaker, transcript.segments[2].speaker)

        // with the echo pass off both copies are there
        var keeping = options()
        keeping.removesEcho = false
        let other = LiveMeetingSession(mode: .virtual, transcriber: ScriptedTranscriber([
            [timed("tenemos listo el informe de ventas", 18.2, 26.2)], [timed("tenemos listo el informe de ventas", 18, 26)],
        ]), diarizer: nil, options: keeping)
        feed(other, room: ScriptedAudio.track(0, seconds: 30), remote: ScriptedAudio.track(1, seconds: 30))
        let both = await other.finish()
        XCTAssertEqual(both.segments.map(\.side), [.remote, .room])
    }

    func testWithoutSpeakerModelsThereAreOnlySides() async {
        let diarizer = ScriptedDiarizer([voices])
        diarizer.available = false
        for unavailable: SampleDiarizing? in [nil, diarizer] {
            let session = LiveMeetingSession(mode: .inPerson, transcriber: ScriptedTranscriber([text]), diarizer: unavailable, options: options())
            feed(session, room: ScriptedAudio.track(0, seconds: 60))
            let transcript = await session.finish()
            XCTAssertEqual(transcript.segments.map(\.text), text.map(\.text))
            XCTAssertTrue(transcript.segments.allSatisfy { $0.speaker == nil })
            XCTAssertEqual(transcript.speakers, [])
            XCTAssertEqual(session.state.speakers, [])
        }
        XCTAssertEqual(diarizer.snapshot.count, 0)
    }

    func testAWindowThatFailsIsSkippedAndReported() async {
        let transcriber = ScriptedTranscriber([text])
        transcriber.failingCalls = [1]
        let diarizer = ScriptedDiarizer([voices])
        diarizer.failingCalls = [0]
        let session = LiveMeetingSession(mode: .inPerson, transcriber: transcriber, diarizer: diarizer, options: options())
        feed(session, room: ScriptedAudio.track(0, seconds: 60))
        let transcript = await session.finish()
        // the second window's sentence is missing, the others are there with their speakers
        XCTAssertEqual(transcript.segments.map(\.text), ["uno uno uno uno", "tres tres tres tres", "cuatro cuatro cuatro cuatro"])
        XCTAssertEqual(transcript.segments.map(\.speaker), ["s1", "s1", "s2"])
        XCTAssertEqual(session.errors.count, 2)
        XCTAssertTrue(session.errors[0].contains("speakers"), session.errors[0])
        XCTAssertTrue(session.errors[1].contains("window 1"), session.errors[1])
    }

    func testUploadsStartAtTheFirstSegmentTheServerHasNotStored() async throws {
        let session = LiveMeetingSession(mode: .inPerson, transcriber: ScriptedTranscriber([text]), diarizer: ScriptedDiarizer([voices]), options: options())
        XCTAssertNil(session.pendingUpload(), "nothing yet")
        let early = Box<LiveMeetingUpload>()
        session.onUpdate = { [unowned session] update in
            // after the second sentence the app posts what there is ...
            if update.segmentCount == 2, early.count == 0, let upload = session.pendingUpload() { early.add(upload) }
        }
        feed(session, room: ScriptedAudio.track(0, seconds: 60))
        let transcript = await session.finish()

        let first = try XCTUnwrap(early.values.first)
        XCTAssertEqual(first.fromIndex, 0)
        XCTAssertEqual(first.segments, Array(transcript.segments.prefix(2)))
        XCTAssertTrue(first.isComplete)

        // ... and the call fails: later it is asked again and everything is still to send
        var upload = try XCTUnwrap(session.pendingUpload())
        XCTAssertEqual(upload.fromIndex, 0)
        XCTAssertEqual(upload.segments, transcript.segments)
        XCTAssertEqual(upload.speakers, transcript.speakers)
        XCTAssertEqual(upload.durationSeconds, 60, accuracy: 1e-6)
        XCTAssertEqual(session.pendingUpload(), upload, "asking does not change anything")

        // the early upload does arrive after all: what came after it is still pending, from where it ended
        session.acknowledge(first)
        upload = try XCTUnwrap(session.pendingUpload())
        XCTAssertEqual(upload.fromIndex, 2)
        XCTAssertEqual(upload.segments, Array(transcript.segments.suffix(2)))

        // the server's limit of segments per call: the tail goes in pieces
        var piece = try XCTUnwrap(session.pendingUpload(maxSegments: 1))
        XCTAssertEqual(piece.segments, [transcript.segments[2]])
        XCTAssertFalse(piece.isComplete)
        session.acknowledge(piece)
        piece = try XCTUnwrap(session.pendingUpload(maxSegments: 1))
        XCTAssertEqual(piece.fromIndex, 3)
        XCTAssertEqual(piece.segments, [transcript.segments[3]])
        XCTAssertTrue(piece.isComplete)
        session.acknowledge(piece)
        XCTAssertNil(session.pendingUpload(), "the server has everything")

        // a name is something to send too, with no segments
        session.setName("Ana", forSpeaker: "s1")
        upload = try XCTUnwrap(session.pendingUpload())
        XCTAssertEqual(upload.fromIndex, 4)
        XCTAssertEqual(upload.segments, [])
        XCTAssertEqual(upload.speakers.first?.name, "Ana")
        session.acknowledge(upload)
        XCTAssertNil(session.pendingUpload())
    }
}
