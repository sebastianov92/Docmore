import XCTest

/// The file kept next to the audio of a recording until its transcript is queued.
final class MeetingSidecarTests: XCTestCase {
    func testRoundTripKeepsKindLiveMeetingAndNames() throws {
        let directory = try TestSupport.temporaryDirectory()
        let audio = directory.appendingPathComponent("meeting-20261121-101500.wav")
        try Data("RIFF".utf8).write(to: audio)
        let sidecar = MeetingSidecar(
            profileId: "p1", pageId: nil, spaceId: "space-1", title: "Weekly sync", mode: .virtual, meetingId: "m-42",
            speakers: [
                MeetingSpeaker(id: "room-1", number: 1, side: .room, name: "Ana"),
                MeetingSpeaker(id: "remote-1", number: 2, side: .remote),
            ]
        )
        sidecar.write(forAudio: audio)
        XCTAssertEqual(MeetingSidecar.url(forAudio: audio).lastPathComponent, "meeting-20261121-101500.wav.json")
        XCTAssertEqual(MeetingSidecar.read(forAudio: audio), sidecar)
        XCTAssertEqual(MeetingSidecar.all(in: directory).map(\.lastPathComponent), ["meeting-20261121-101500.wav.json"])
        XCTAssertEqual(MeetingSidecar.audio(forSidecar: MeetingSidecar.all(in: directory)[0]).lastPathComponent, audio.lastPathComponent)

        MeetingSidecar.remove(forAudio: audio)
        XCTAssertNil(MeetingSidecar.read(forAudio: audio))
        XCTAssertTrue(MeetingSidecar.all(in: directory).isEmpty)
    }

    func testAFileWrittenBeforeMeetingsHadAKindStillReads() throws {
        let old = #"{"profileId":"p1","spaceId":"space-1","title":"Meeting Nov 20"}"#
        let sidecar = try JSONDecoder().decode(MeetingSidecar.self, from: Data(old.utf8))
        XCTAssertEqual(sidecar.profileId, "p1")
        XCTAssertEqual(sidecar.spaceId, "space-1")
        XCTAssertEqual(sidecar.mode, .inPerson, "one mixed track: an in-person meeting")
        XCTAssertNil(sidecar.meetingId)
        XCTAssertTrue(sidecar.speakers.isEmpty)
    }

    func testOldestRecordingFirst() throws {
        let directory = try TestSupport.temporaryDirectory()
        for name in ["meeting-20261121-120000.wav", "meeting-20261120-090000.wav", "meeting-20261121-080000.wav"] {
            MeetingSidecar(profileId: "p", mode: .inPerson).write(forAudio: directory.appendingPathComponent(name))
        }
        try Data().write(to: directory.appendingPathComponent("notes.json"))
        XCTAssertEqual(MeetingSidecar.all(in: directory).map(\.lastPathComponent), [
            "meeting-20261120-090000.wav.json", "meeting-20261121-080000.wav.json", "meeting-20261121-120000.wav.json",
        ])
    }

    func testNamesTypedBeforeAnInterruptionGoOnTheTranscriptMadeLater() {
        let sidecar = MeetingSidecar(
            profileId: "p1", mode: .virtual, meetingId: "m-42",
            speakers: [
                MeetingSpeaker(id: "room-1", number: 1, side: .room, name: "Ana"),
                MeetingSpeaker(id: "remote-1", number: 2, side: .remote),
                MeetingSpeaker(id: "remote-2", number: 3, side: .remote, name: "Diego"),
            ]
        )
        // what the engine finds when the recording is transcribed after a relaunch
        let found = [
            MeetingSpeaker(id: "remote-2", number: 3, side: .remote),
            MeetingSpeaker(id: "room-1", number: 1, side: .room),
            MeetingSpeaker(id: "remote-9", number: 4, side: .remote),
        ]
        XCTAssertEqual(sidecar.named(found).map(\.name), ["Diego", "Ana", nil])
        XCTAssertEqual(sidecar.named(found).map(\.id), ["remote-2", "room-1", "remote-9"])
        // a name the engine kept itself (its own state survived) is not erased by a file that has none
        let seeded = [MeetingSpeaker(id: "remote-1", number: 2, side: .remote, name: "Marta"), MeetingSpeaker(id: "room-1", number: 1, side: .room, name: "Anita")]
        XCTAssertEqual(sidecar.named(seeded).map(\.name), ["Marta", "Ana"], "the name typed last, kept here, wins")
    }

    func testTheNamesOfALiveMeetingAreWhatTheSidecarKeeps() {
        var state = MeetingLiveState(mode: .virtual)
        state.apply(MeetingLiveUpdate(
            segments: [MeetingSegment(start: 0, end: 2, text: "hola", speaker: "room-1", side: .room)],
            speakers: [MeetingSpeaker(id: "room-1", number: 1, side: .room)]
        ))
        state.rename(speakerId: "room-1", to: "Ana")
        var sidecar = MeetingSidecar(profileId: "p1", mode: .virtual)
        sidecar.speakers = state.speakers
        // after a relaunch: a fresh state takes the names back from the file
        var later = MeetingLiveState(mode: sidecar.mode)
        later.restoreNames(from: sidecar.speakers)
        later.apply(MeetingLiveUpdate(
            segments: [MeetingSegment(start: 0, end: 2, text: "hola", speaker: "room-1", side: .room)],
            speakers: [MeetingSpeaker(id: "room-1", number: 1, side: .room)]
        ))
        XCTAssertEqual(later.speakers.first?.name, "Ana")
    }
}
