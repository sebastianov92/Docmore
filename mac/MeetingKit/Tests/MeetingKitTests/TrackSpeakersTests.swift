import XCTest
@testable import MeetingKit

/// Hands out "s1", "s2", ... like `MeetingSpeakerState.makeSpeaker`.
private final class Ids {
    private(set) var made: [String] = []
    func next() -> String {
        let id = "s\(made.count + 1)"
        made.append(id)
        return id
    }
}

final class TrackSpeakersTests: XCTestCase {
    private func turns(_ track: TrackSpeakers) -> [String] {
        track.labelledTurns.map { "\(Int($0.start))-\(Int($0.end)) \($0.speaker)" }
    }

    func testFirstPassMakesSpeakersInOrderOfFirstAppearance() {
        var track = TrackSpeakers()
        let ids = Ids()
        let outcome = track.absorb(
            diarization([(0, 10, 4), (10, 22, 9), (22, 30, 4)], prints: [4: voicePrint(0), 9: voicePrint(1)]),
            from: 0, to: 30, makeSpeaker: ids.next
        )
        XCTAssertEqual(outcome.assignment, [4: "s1", 9: "s2"])
        XCTAssertEqual(outcome.created, ["s1", "s2"])
        XCTAssertEqual(outcome.retired, [])
        XCTAssertEqual(turns(track), ["0-10 s1", "10-22 s2", "22-30 s1"])
        XCTAssertEqual(track.voices.map(\.id), ["s1", "s2"])
        XCTAssertEqual(track.voices.map(\.printSeconds), [18, 12])
        XCTAssertEqual(track.voices[0].print, voicePrint(0))
        XCTAssertEqual(track.speaker(from: 9, to: 12)?.id, "s2", "the speaker who talks the most in a span")
    }

    func testIdsStayWhenTheDiarizerNumbersItsClustersDifferently() {
        var track = TrackSpeakers()
        let ids = Ids()
        _ = track.absorb(diarization([(0, 10, 4), (10, 22, 9), (22, 30, 4)]), from: 0, to: 30, makeSpeaker: ids.next)
        // the same audio and fifteen seconds more: what was cluster 4 is now 1, what was 9 is now 0
        for pass in 0..<4 {
            let first = pass % 2 == 0 ? 1 : 6
            let second = pass % 2 == 0 ? 0 : 2
            let outcome = track.absorb(
                diarization([(0, 10, first), (10, 22, second), (22, 30, first), (30, 45, second)]),
                from: 0, to: 45, makeSpeaker: ids.next
            )
            XCTAssertEqual(outcome.assignment, [first: "s1", second: "s2"], "pass \(pass)")
            XCTAssertEqual(outcome.created, [])
        }
        XCTAssertEqual(turns(track), ["0-10 s1", "10-22 s2", "22-30 s1", "30-45 s2"])
        XCTAssertEqual(ids.made, ["s1", "s2"], "no id was made after the first pass")
    }

    func testAVoiceHeardLittleWaitsOnePassBeforeItIsASpeaker() {
        var track = TrackSpeakers()
        let ids = Ids()
        // ten seconds of one voice, four of another
        let first = track.absorb(diarization([(0, 10, 0), (10, 14, 1)]), from: 0, to: 15, makeSpeaker: ids.next)
        XCTAssertEqual(first.created, ["s1"])
        XCTAssertEqual(first.assignment[0], "s1")
        XCTAssertTrue(TrackSpeakers.isProvisional(first.assignment[1] ?? ""), "known, not shown yet")
        XCTAssertEqual(turns(track), ["0-10 s1"])
        XCTAssertNil(track.speaker(from: 10, to: 14))
        XCTAssertEqual(ids.made, ["s1"])

        // the next pass still hears it as a voice of its own: now it is a speaker, for all it said
        let second = track.absorb(diarization([(0, 10, 5), (10, 14, 3), (20, 24, 3)]), from: 0, to: 30, makeSpeaker: ids.next)
        XCTAssertEqual(second.created, ["s2"])
        XCTAssertEqual(second.assignment, [5: "s1", 3: "s2"])
        XCTAssertEqual(turns(track), ["0-10 s1", "10-14 s2", "20-24 s2"])
        XCTAssertFalse(track.voices.contains { $0.isProvisional })
    }

    func testAVoiceThatMeltsIntoAnotherNeverUsesANumber() {
        var track = TrackSpeakers()
        let ids = Ids()
        _ = track.absorb(diarization([(0, 10, 0), (10, 14, 1)]), from: 0, to: 15, makeSpeaker: ids.next)
        // with more audio the models see that the four seconds were the first voice too
        let second = track.absorb(diarization([(0, 14, 2), (15, 30, 2)]), from: 0, to: 30, makeSpeaker: ids.next)
        XCTAssertEqual(second.assignment, [2: "s1"])
        XCTAssertEqual(second.retired, [], "a provisional voice goes without a trace")
        XCTAssertEqual(track.voices.map(\.id), ["s1"])
        // the next real voice is number two
        let third = track.absorb(diarization([(0, 14, 2), (15, 30, 2), (30, 44, 7)]), from: 0, to: 45, makeSpeaker: ids.next)
        XCTAssertEqual(third.created, ["s2"])
        XCTAssertEqual(ids.made, ["s1", "s2"])
    }

    func testWhatLiesBeforeTheWindowKeepsItsSpeakers() {
        var track = TrackSpeakers()
        let ids = Ids()
        _ = track.absorb(diarization([(0, 20, 0), (20, 40, 1), (40, 60, 0)]), from: 0, to: 60, makeSpeaker: ids.next)
        // a pass over 30...90 that hears one single voice
        let outcome = track.absorb(diarization([(30, 90, 3)]), from: 30, to: 90, makeSpeaker: ids.next)
        // 30...40 was s2 (10 s) and 40...60 was s1 (20 s): the cluster is s1
        XCTAssertEqual(outcome.assignment, [3: "s1"])
        XCTAssertEqual(turns(track), ["0-20 s1", "20-30 s2", "30-90 s1"])
        XCTAssertEqual(outcome.retired, [], "s2 still has what it said before the window")
        XCTAssertEqual(Set(track.voices.map(\.id)), ["s1", "s2"])
    }

    func testAVoiceThatComesBackAfterALongSilenceGetsItsIdBack() {
        var track = TrackSpeakers()
        let ids = Ids()
        _ = track.absorb(
            diarization([(0, 30, 0), (30, 60, 1)], prints: [0: voicePrint(0), 1: voicePrint(1)]),
            from: 0, to: 60, makeSpeaker: ids.next
        )
        // ten minutes later the window has nothing in common with those turns
        let outcome = track.absorb(
            diarization([(600, 620, 8), (620, 660, 2)], prints: [8: voicePrint(0, wobble: 0.05), 2: voicePrint(2)]),
            from: 600, to: 660, makeSpeaker: ids.next
        )
        XCTAssertEqual(outcome.assignment[8], "s1", "the same voice print: the same speaker")
        XCTAssertEqual(outcome.assignment[2], "s3", "a voice nobody knows, with plenty of speech: somebody new")
        XCTAssertEqual(outcome.created, ["s3"])
        XCTAssertEqual(turns(track), ["0-30 s1", "30-60 s2", "600-620 s1", "620-660 s3"])
        // the print of s1 stays the one from the pass that heard more of it
        XCTAssertEqual(track.voices.first { $0.id == "s1" }?.printSeconds, 30)
        XCTAssertEqual(track.voices.first { $0.id == "s1" }?.print, voicePrint(0))
    }

    func testTheVoicePrintDoesNotFadeAsTheWindowSlidesAway() {
        var track = TrackSpeakers()
        let ids = Ids()
        _ = track.absorb(diarization([(0, 60, 0)], prints: [0: voicePrint(0)]), from: 0, to: 60, makeSpeaker: ids.next)
        // the window moves on: every pass hears ten seconds less of the voice, with a worse print
        for start in stride(from: 10.0, through: 50.0, by: 10.0) {
            _ = track.absorb(diarization([(start, 60, 4)], prints: [4: voicePrint(9)]), from: start, to: start + 60, makeSpeaker: ids.next)
        }
        XCTAssertEqual(track.voices.map(\.id), ["s1"])
        XCTAssertEqual(track.voices[0].print, voicePrint(0), "still the print of the pass that heard a minute of it")
        XCTAssertEqual(track.voices[0].printSeconds, 60)
        // a pass that hears more of it does replace the print
        _ = track.absorb(diarization([(500, 590, 2)], prints: [2: voicePrint(0, wobble: 0.02)]), from: 500, to: 600, makeSpeaker: ids.next)
        XCTAssertEqual(track.voices.map(\.id), ["s1"], "it came back and was recognised")
        XCTAssertEqual(track.voices[0].printSeconds, 90)
    }

    func testAVoiceThatCouldBeSomebodyKnownWaitsUntilThereIsEnoughToTell() {
        var track = TrackSpeakers()
        let ids = Ids()
        _ = track.absorb(
            diarization([(0, 30, 0), (30, 60, 1)], prints: [0: voicePrint(0), 1: voicePrint(1)]),
            from: 0, to: 60, makeSpeaker: ids.next
        )
        // four seconds that sound like nobody known: could be a bad print of a known voice
        let early = track.absorb(diarization([(600, 604, 5)], prints: [5: voicePrint(3)]), from: 600, to: 606, makeSpeaker: ids.next)
        XCTAssertEqual(early.assignment, [:])
        XCTAssertEqual(early.created, [])
        XCTAssertNil(track.speaker(from: 600, to: 604))
        // fourteen seconds that still sound like nobody known: somebody new
        let later = track.absorb(diarization([(600, 604, 6), (608, 618, 6)], prints: [6: voicePrint(3)]), from: 600, to: 620, makeSpeaker: ids.next)
        XCTAssertEqual(later.assignment, [6: "s3"])
        XCTAssertEqual(track.speaker(from: 600, to: 604)?.id, "s3")

        // four seconds that do sound like a known voice need no waiting
        var other = TrackSpeakers()
        let otherIds = Ids()
        _ = other.absorb(
            diarization([(0, 30, 0), (30, 60, 1)], prints: [0: voicePrint(0), 1: voicePrint(1)]),
            from: 0, to: 60, makeSpeaker: otherIds.next
        )
        let back = other.absorb(diarization([(600, 604, 5)], prints: [5: voicePrint(1, wobble: 0.1)]), from: 600, to: 606, makeSpeaker: otherIds.next)
        XCTAssertEqual(back.assignment, [5: "s2"])
    }

    func testTwoSpeakersThatWereOnePersonBecomeOne() {
        func split() -> (TrackSpeakers, Ids) {
            var track = TrackSpeakers()
            let ids = Ids()
            _ = track.absorb(diarization([(0, 20, 0), (20, 40, 1)]), from: 0, to: 40, makeSpeaker: ids.next)
            return (track, ids)
        }
        // nobody has a name: the first one stays
        var (track, ids) = split()
        var outcome = track.absorb(diarization([(0, 60, 4)]), from: 0, to: 60, makeSpeaker: ids.next)
        XCTAssertEqual(outcome.assignment, [4: "s1"])
        XCTAssertEqual(outcome.retired, ["s2"])
        XCTAssertEqual(outcome.absorbedBy, ["s2": "s1"])
        XCTAssertEqual(turns(track), ["0-60 s1"])
        XCTAssertEqual(track.voices.map(\.id), ["s1"])

        // the person gave the second one a name: that is the one that stays
        (track, ids) = split()
        outcome = track.absorb(diarization([(0, 60, 4)]), from: 0, to: 60, named: ["s2"], makeSpeaker: ids.next)
        XCTAssertEqual(outcome.assignment, [4: "s2"])
        XCTAssertEqual(outcome.retired, ["s1"])
        XCTAssertEqual(outcome.absorbedBy, ["s1": "s2"])
    }

    func testOneSpeakerThatWasTwoPeopleKeepsItsIdForTheOneWhoSpokeMore() {
        var track = TrackSpeakers()
        let ids = Ids()
        _ = track.absorb(diarization([(0, 40, 0)]), from: 0, to: 40, makeSpeaker: ids.next)
        let outcome = track.absorb(diarization([(0, 25, 3), (25, 40, 8)]), from: 0, to: 40, makeSpeaker: ids.next)
        XCTAssertEqual(outcome.assignment, [3: "s1", 8: "s2"])
        XCTAssertEqual(outcome.created, ["s2"])
        XCTAssertEqual(turns(track), ["0-25 s1", "25-40 s2"])
    }

    func testTheFinalPassGivesEveryVoiceASpeaker() {
        var track = TrackSpeakers()
        let ids = Ids()
        // one second of a voice: far too little while the meeting runs
        var outcome = track.absorb(diarization([(0, 12, 0), (12, 13, 1)]), from: 0, to: 15, makeSpeaker: ids.next)
        XCTAssertEqual(outcome.assignment, [0: "s1"])
        outcome = track.absorb(diarization([(0, 12, 0), (12, 13, 1)]), from: 0, to: 15, final: true, makeSpeaker: ids.next)
        XCTAssertEqual(outcome.assignment, [0: "s1", 1: "s2"])
        XCTAssertEqual(turns(track), ["0-12 s1", "12-13 s2"])
    }

    func testTheFinalPassOverTheWholeRecordingKeepsTheIdsOfTheLiveSession() {
        // what the live session left: two speakers, heard through a sliding window
        var track = TrackSpeakers(
            side: .room,
            voices: [KnownVoice(id: "s1", print: voicePrint(0), printSeconds: 40), KnownVoice(id: "s3", print: voicePrint(1), printSeconds: 30)],
            turns: [.init(start: 0, end: 20, speaker: "s1"), .init(start: 20, end: 50, speaker: "s3"), .init(start: 50, end: 70, speaker: "s1")]
        )
        var placeholders = 0
        // the final diarization of the whole file: other cluster numbers, slightly other edges, one voice more
        let outcome = track.absorb(
            diarization([(0, 21, 7), (21, 49, 2), (49, 70, 7), (70, 82, 5)], prints: [7: voicePrint(0), 2: voicePrint(1), 5: voicePrint(4)]),
            from: 0, to: 82, final: true
        ) {
            placeholders += 1
            return "new-\(placeholders)"
        }
        XCTAssertEqual(outcome.assignment, [7: "s1", 2: "s3", 5: "new-1"])
        XCTAssertEqual(outcome.created, ["new-1"])
        track.rename(["new-1": "s4"])
        XCTAssertEqual(turns(track), ["0-21 s1", "21-49 s3", "49-70 s1", "70-82 s4"])
        XCTAssertEqual(track.voices.map(\.id), ["s1", "s3", "s4"])
    }

    func testStateKeepsNumbersNamesAndSurvivesJSON() throws {
        var state = MeetingSpeakerState(mode: .virtual)
        XCTAssertEqual(state.tracks.map(\.side), [.room, .remote])
        XCTAssertEqual(MeetingSpeakerState(mode: .inPerson).tracks.map(\.side), [nil])
        XCTAssertEqual(state.makeSpeaker(side: .room), "s1")
        XCTAssertEqual(state.makeSpeaker(side: .remote), "s2")
        XCTAssertEqual(state.makeSpeaker(side: .room), "s3")
        XCTAssertEqual(state.speakers.map(\.number), [1, 2, 3])
        XCTAssertEqual(state.speakers.map(\.side), [.room, .remote, .room])
        XCTAssertTrue(state.speakers.allSatisfy { MeetingSpeaker.isValidId($0.id) })

        XCTAssertTrue(state.setName("  Ana  ", for: "s2"))
        XCTAssertFalse(state.setName("Nobody", for: "s9"))
        XCTAssertEqual(state.speakers[1].name, "Ana")
        XCTAssertEqual(state.namedIds, ["s2"])
        XCTAssertTrue(state.setName("", for: "s2"))
        XCTAssertNil(state.speakers[1].name, "an empty name is the default label again")
        state.setName("Ana", for: "s2")

        // a speaker that is gone does not give its number back
        state.removeSpeakers(["s3"])
        XCTAssertEqual(state.makeSpeaker(side: .room), "s4")

        var ids = 0
        _ = state.tracks[0].absorb(diarization([(0, 10, 0), (10, 13, 1)], prints: [0: voicePrint(0)]), from: 0, to: 15) {
            ids += 1
            return "s\(ids)"
        }
        let copy = try JSONDecoder().decode(MeetingSpeakerState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(copy, state)
        XCTAssertEqual(copy.nextNumber, 5)
        XCTAssertTrue(copy.tracks[0].voices.contains { $0.isProvisional }, "a provisional voice is kept too")
    }

    func testVoicePrintDistance() {
        XCTAssertEqual(VoicePrint.distance([1, 0], [2, 0]), 0, accuracy: 1e-6, "loudness does not matter")
        XCTAssertEqual(VoicePrint.distance([1, 0], [0, 1]), 1, accuracy: 1e-6)
        XCTAssertEqual(VoicePrint.distance([1, 0], [-1, 0]), 2, accuracy: 1e-6)
        XCTAssertEqual(VoicePrint.distance([], []), 1)
        XCTAssertEqual(VoicePrint.distance([1, 0], [1, 0, 0]), 1, "different sizes cannot be compared")
        XCTAssertEqual(VoicePrint.distance([0, 0], [1, 0]), 1)
        XCTAssertLessThan(VoicePrint.distance(voicePrint(0), voicePrint(0, wobble: 0.1)), 0.05)
        XCTAssertGreaterThan(VoicePrint.distance(voicePrint(0), voicePrint(1)), 0.9)
        let unit = VoicePrint.normalized([3, 4])
        XCTAssertEqual(unit[0], 0.6, accuracy: 1e-6)
        XCTAssertEqual(unit[1], 0.8, accuracy: 1e-6)
    }
}
