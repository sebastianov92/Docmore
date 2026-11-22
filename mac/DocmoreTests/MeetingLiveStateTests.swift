import XCTest

/// The pure state of a meeting under way: labels, names, what is sent to the
/// server and from which index, the list and the edits made by hand.
final class MeetingLiveStateTests: XCTestCase {
    private func segment(_ index: Int, _ speaker: String? = nil, side: MeetingSide? = nil, text: String? = nil) -> MeetingSegment {
        MeetingSegment(start: Double(index) * 5, end: Double(index) * 5 + 4, text: text ?? "line \(index)", speaker: speaker, side: side)
    }

    private let ana = MeetingSpeaker(id: "room-1", number: 1, side: .room)
    private let marta = MeetingSpeaker(id: "remote-1", number: 2, side: .remote)
    private let diego = MeetingSpeaker(id: "remote-2", number: 3, side: .remote)

    // MARK: Labels and names

    func testDefaultLabels() {
        XCTAssertEqual(MeetingSpeaker(id: "a", number: 3).label, "Speaker 3")
        XCTAssertEqual(MeetingSpeaker(id: "a", number: 3, side: .remote).label, "Speaker 3 (remote)")
        XCTAssertEqual(MeetingSpeaker(id: "a", number: 1, side: .room).label, "Speaker 1 (room)")
        XCTAssertEqual(MeetingSpeaker(id: "a", number: 1, side: .room).shortLabel, "Speaker 1")
        XCTAssertEqual(MeetingSpeaker(id: "a", number: 1, side: .room, name: "Ana").label, "Ana", "a name replaces the default label, side included")

        var state = MeetingLiveState(mode: .virtual)
        state.apply(MeetingLiveUpdate(segments: [segment(0, "room-1", side: .room), segment(1, nil, side: .remote), segment(2)], speakers: [ana]))
        XCTAssertEqual(state.label(for: state.segments[0]), "Speaker 1 (room)")
        XCTAssertEqual(state.label(for: state.segments[1]), "Remote", "a side with no speaker is labelled by its side")
        XCTAssertNil(state.label(for: state.segments[2]), "voices not told apart: no label")
    }

    func testANameReplacesTheLabelOnEveryLineAtOnceAndCanChangeAgain() {
        var state = MeetingLiveState(mode: .virtual)
        state.apply(MeetingLiveUpdate(
            segments: [segment(0, "room-1", side: .room), segment(1, "remote-1", side: .remote), segment(2, "room-1", side: .room)],
            speakers: [ana, marta]
        ))
        XCTAssertTrue(state.rename(speakerId: "room-1", to: "  Ana  "))
        XCTAssertEqual(state.segments.map { state.label(for: $0) }, ["Ana", "Speaker 2 (remote)", "Ana"])
        XCTAssertEqual(state.turns.map { $0.speaker?.name }, ["Ana", nil, "Ana"])
        XCTAssertFalse(state.rename(speakerId: "room-1", to: "Ana"), "the same name again changes nothing")

        XCTAssertTrue(state.rename(speakerId: "room-1", to: "Ana María"))
        XCTAssertEqual(state.label(for: state.segments[2]), "Ana María")

        // lines said after the name was typed carry it too
        state.apply(MeetingLiveUpdate(segments: [segment(3, "room-1", side: .room)], speakers: [ana, marta]))
        XCTAssertEqual(state.label(for: state.segments[3]), "Ana María")

        XCTAssertTrue(state.rename(speakerId: "room-1", to: "   "))
        XCTAssertEqual(state.label(for: state.segments[0]), "Speaker 1 (room)", "an empty name brings the default label back")
    }

    func testNamesAreTrimmedAndCut() {
        XCTAssertNil(MeetingSpeaker.cleanName(nil))
        XCTAssertNil(MeetingSpeaker.cleanName(" \n "))
        XCTAssertEqual(MeetingSpeaker.cleanName("  Luis "), "Luis")
        XCTAssertEqual(MeetingSpeaker.cleanName(String(repeating: "x", count: 200))?.count, 80)
    }

    func testANameTypedBeforeItsVoiceIsHeardAgainIsKept() {
        var state = MeetingLiveState(mode: .inPerson)
        state.apply(MeetingLiveUpdate(segments: [segment(0, "v1")], speakers: [MeetingSpeaker(id: "v1", number: 1)]))
        state.rename(speakerId: "v1", to: "Ana")
        // the engine never sends names: the next update must not erase the one typed
        state.apply(MeetingLiveUpdate(segments: [segment(1, "v2")], speakers: [MeetingSpeaker(id: "v1", number: 1), MeetingSpeaker(id: "v2", number: 2)]))
        XCTAssertEqual(state.speakers.map(\.name), ["Ana", nil])
        XCTAssertEqual(state.named([MeetingSpeaker(id: "v2", number: 2), MeetingSpeaker(id: "v1", number: 1)]).map(\.name), [nil, "Ana"])
    }

    func testNamesTheEngineCarriesShowUnlessThePersonDecidedOtherwise() {
        var state = MeetingLiveState(mode: .virtual)
        let s1 = MeetingSpeaker(id: "s1", number: 1, side: .room)
        let s2 = MeetingSpeaker(id: "s2", number: 2, side: .remote)
        let s5 = MeetingSpeaker(id: "s5", number: 5, side: .remote)
        state.apply(MeetingLiveUpdate(segments: [segment(0, "s1", side: .room), segment(1, "s2", side: .remote), segment(2, "s5", side: .remote)], speakers: [s1, s2, s5]))
        state.rename(speakerId: "s5", to: "Marta")
        state.completeUpdate(state.beginUpdate(), stored: 3)
        XCTAssertFalse(state.hasUnsent)

        // s5 turns out to be the voice of s2: the engine keeps s2 and moves the name to it
        var merged = s2
        merged.name = "Marta"
        state.apply(MeetingLiveUpdate(fromIndex: 2, segments: [segment(2, "s2", side: .remote)], speakers: [s1, merged]))
        XCTAssertEqual(state.speakers.map(\.name), [nil, "Marta"], "the name follows the voice")
        XCTAssertEqual(state.label(for: state.segments[1]), "Marta")
        XCTAssertEqual(state.label(for: state.segments[2]), "Marta")
        XCTAssertTrue(state.hasUnsent, "the server has to learn it")

        // the person gives that voice another name: theirs wins over the engine's from then on
        state.rename(speakerId: "s2", to: "Marta P.")
        state.apply(MeetingLiveUpdate(segments: [segment(3, "s2", side: .remote)], speakers: [s1, merged]))
        XCTAssertEqual(state.speakers[1].name, "Marta P.", "an update that left before the rename does not undo it")

        // and takes it away: the engine's copy of the name does not bring it back
        XCTAssertTrue(state.rename(speakerId: "s2", to: ""))
        state.apply(MeetingLiveUpdate(segments: [segment(4, "s2", side: .remote)], speakers: [s1, merged]))
        XCTAssertNil(state.speakers[1].name)
        XCTAssertEqual(state.label(for: state.segments[4]), "Speaker 2 (remote)")

        // the final transcript: decided here first, else what it carries
        var carried = s1
        carried.name = "Ana"
        XCTAssertEqual(state.named([carried, merged]).map(\.name), ["Ana", nil])
    }

    func testTurnsJoinConsecutiveLinesOfOneVoice() {
        var state = MeetingLiveState(mode: .virtual)
        state.apply(MeetingLiveUpdate(
            segments: [
                segment(0, "room-1", side: .room), segment(1, "room-1", side: .room), segment(2, "remote-1", side: .remote),
                segment(3, nil, side: .remote, text: "  "), segment(4, "remote-1", side: .remote),
            ],
            speakers: [ana, marta]
        ))
        let turns = state.turns
        XCTAssertEqual(turns.map(\.id), [0, 2])
        XCTAssertEqual(turns[0].text, "line 0 line 1")
        XCTAssertEqual(turns[1].text, "line 2 line 4", "an empty line is skipped")
        XCTAssertEqual(turns[1].side, .remote)
    }

    // MARK: What is sent, and from which index

    func testFirstUpdateSendsEverythingFromZero() {
        var state = MeetingLiveState(mode: .virtual)
        XCTAssertFalse(state.hasUnsent)
        state.apply(MeetingLiveUpdate(segments: [segment(0, "room-1", side: .room), segment(1, "remote-1", side: .remote)], speakers: [ana, marta]))
        XCTAssertTrue(state.hasUnsentText)
        let draft = state.beginUpdate()
        XCTAssertEqual(draft.fromIndex, 0)
        XCTAssertEqual(draft.segments.count, 2)
        XCTAssertEqual(draft.speakers.map(\.id), ["room-1", "remote-1"])
        state.completeUpdate(draft, stored: 2)
        XCTAssertEqual(state.acknowledged, 2)
        XCTAssertFalse(state.hasUnsent)
    }

    func testNextUpdateSendsOnlyWhatIsNew() {
        var state = MeetingLiveState(mode: .inPerson)
        state.apply(MeetingLiveUpdate(segments: [segment(0), segment(1)]))
        state.completeUpdate(state.beginUpdate(), stored: 2)
        state.apply(MeetingLiveUpdate(segments: [segment(2)]))
        state.apply(MeetingLiveUpdate(fromIndex: 3, segments: [segment(3)]))
        let draft = state.beginUpdate()
        XCTAssertEqual(draft.fromIndex, 2)
        XCTAssertEqual(draft.segments.map(\.text), ["line 2", "line 3"])
    }

    func testAfterAFailureTheNextUpdateStartsAtTheFirstIndexNotAcknowledged() {
        var state = MeetingLiveState(mode: .inPerson)
        state.apply(MeetingLiveUpdate(segments: [segment(0), segment(1)]))
        state.completeUpdate(state.beginUpdate(), stored: 2)
        state.apply(MeetingLiveUpdate(segments: [segment(2), segment(3)]))
        let lost = state.beginUpdate()
        XCTAssertEqual(lost.fromIndex, 2)
        state.failUpdate(lost)
        XCTAssertEqual(state.acknowledged, 2, "a lost call acknowledges nothing")
        state.apply(MeetingLiveUpdate(segments: [segment(4)]))
        let again = state.beginUpdate()
        XCTAssertEqual(again.fromIndex, 2, "nothing is skipped")
        XCTAssertEqual(again.segments.map(\.text), ["line 2", "line 3", "line 4"])
        state.completeUpdate(again, stored: 5)
        XCTAssertFalse(state.hasUnsent)
    }

    func testARelabelledLineIsSentAgainWithEverythingAfterIt() {
        var state = MeetingLiveState(mode: .virtual)
        state.apply(MeetingLiveUpdate(
            segments: (0..<5).map { segment($0, $0 == 1 || $0 == 3 ? "remote-1" : "room-1", side: $0 == 1 || $0 == 3 ? .remote : .room) },
            speakers: [ana, marta]
        ))
        state.completeUpdate(state.beginUpdate(), stored: 5)
        XCTAssertEqual(state.acknowledged, 5)

        // the engine tells a third voice apart: line 3 was not Marta's
        let changed = state.apply(MeetingLiveUpdate(
            fromIndex: 3,
            segments: [segment(3, "remote-2", side: .remote), segment(4, "room-1", side: .room), segment(5, "remote-2", side: .remote)],
            speakers: [ana, marta, diego]
        ))
        XCTAssertTrue(changed)
        XCTAssertEqual(state.acknowledged, 3)
        let draft = state.beginUpdate()
        XCTAssertEqual(draft.fromIndex, 3)
        XCTAssertEqual(draft.segments.map(\.speaker), ["remote-2", "room-1", "remote-2"])
        XCTAssertEqual(draft.speakers.count, 3)
    }

    func testAnUpdateThatRepeatsWhatIsKnownChangesNothing() {
        var state = MeetingLiveState(mode: .inPerson)
        state.apply(MeetingLiveUpdate(segments: [segment(0), segment(1), segment(2)]))
        state.completeUpdate(state.beginUpdate(), stored: 3)
        // an engine that sends the whole transcript each time
        XCTAssertFalse(state.apply(MeetingLiveUpdate(fromIndex: 0, segments: [segment(0), segment(1), segment(2)])))
        XCTAssertEqual(state.acknowledged, 3)
        XCTAssertTrue(state.apply(MeetingLiveUpdate(fromIndex: 0, segments: [segment(0), segment(1), segment(2), segment(3)])))
        XCTAssertEqual(state.acknowledged, 3, "only the new line is unsent")
    }

    func testAChangeMadeWhileAnUpdateIsOnItsWayIsNotAcknowledged() {
        var state = MeetingLiveState(mode: .inPerson)
        state.apply(MeetingLiveUpdate(segments: [segment(0, "v1"), segment(1, "v1"), segment(2, "v1")]))
        let draft = state.beginUpdate()
        // while the server works on it: a new line, and line 1 changes speaker
        state.apply(MeetingLiveUpdate(segments: [segment(3, "v1")]))
        state.apply(MeetingLiveUpdate(fromIndex: 1, segments: [segment(1, "v2"), segment(2, "v1"), segment(3, "v1")]))
        state.completeUpdate(draft, stored: 3)
        XCTAssertEqual(state.acknowledged, 1, "the server has line 1 with its old speaker")
        let next = state.beginUpdate()
        XCTAssertEqual(next.fromIndex, 1)
        XCTAssertEqual(next.segments.count, 3)
    }

    func testTextTheEngineTookBackIsRemovedOnTheServerToo() {
        var state = MeetingLiveState(mode: .inPerson)
        state.apply(MeetingLiveUpdate(segments: [segment(0), segment(1), segment(2)]))
        state.completeUpdate(state.beginUpdate(), stored: 3)
        state.apply(MeetingLiveUpdate(fromIndex: 2, segments: []))
        XCTAssertEqual(state.segments.count, 2)
        XCTAssertTrue(state.hasUnsentText, "the server still holds three")
        let draft = state.beginUpdate()
        XCTAssertEqual(draft.fromIndex, 2)
        XCTAssertTrue(draft.segments.isEmpty)
        state.completeUpdate(draft, stored: 2)
        XCTAssertFalse(state.hasUnsent)
    }

    func testAtMostTheLimitPerCall() {
        var state = MeetingLiveState(mode: .inPerson)
        state.apply(MeetingLiveUpdate(segments: (0..<2500).map { segment($0) }))
        let first = state.beginUpdate(limit: 2000)
        XCTAssertEqual(first.segments.count, 2000)
        state.completeUpdate(first, stored: 2000)
        XCTAssertTrue(state.hasUnsentText)
        let second = state.beginUpdate(limit: 2000)
        XCTAssertEqual(second.fromIndex, 2000)
        XCTAssertEqual(second.segments.count, 500)
    }

    func testANameTypedIsUnsentUntilAnUpdateCarriesIt() {
        var state = MeetingLiveState(mode: .virtual)
        state.apply(MeetingLiveUpdate(segments: [segment(0, "room-1", side: .room)], speakers: [ana]))
        state.completeUpdate(state.beginUpdate(), stored: 1)
        XCTAssertFalse(state.hasUnsent)
        state.rename(speakerId: "room-1", to: "Ana")
        XCTAssertTrue(state.hasUnsentNames)
        XCTAssertFalse(state.hasUnsentText)
        let draft = state.beginUpdate()
        XCTAssertEqual(draft.fromIndex, 1)
        XCTAssertTrue(draft.segments.isEmpty, "no text again, only the speakers")
        XCTAssertEqual(draft.speakers.first?.name, "Ana")
        // a second name while that one travels stays unsent
        state.rename(speakerId: "room-1", to: "Ana B.")
        state.completeUpdate(draft, stored: 1)
        XCTAssertTrue(state.hasUnsentNames)
    }

    func testANewLiveMeetingGetsEverythingAgain() {
        var state = MeetingLiveState(mode: .virtual)
        state.apply(MeetingLiveUpdate(segments: [segment(0, "room-1", side: .room), segment(1, "room-1", side: .room)], speakers: [ana]))
        state.rename(speakerId: "room-1", to: "Ana")
        state.completeUpdate(state.beginUpdate(), stored: 2)
        state.resetAcknowledgement()
        XCTAssertTrue(state.hasUnsentText)
        let draft = state.beginUpdate()
        XCTAssertEqual(draft.fromIndex, 0)
        XCTAssertEqual(draft.segments.count, 2)
        XCTAssertEqual(draft.speakers.first?.name, "Ana")
    }

    // MARK: The list

    private func item(_ id: String, _ text: String, kind: MeetingItem.Kind = .task, status: MeetingItem.Status = .active) -> MeetingItem {
        MeetingItem(id: id, kind: kind, text: text, status: status)
    }

    func testTheServersListReplacesTheOneShownUnlessItIsOlder() {
        var state = MeetingLiveState(mode: .inPerson)
        XCTAssertTrue(state.applyServer(items: [item("i1", "first")], revision: 3))
        XCTAssertEqual(state.items.map(\.text), ["first"])
        XCTAssertFalse(state.applyServer(items: [], revision: 2), "an answer that left before the last one must not undo it")
        XCTAssertEqual(state.items.count, 1)
        XCTAssertTrue(state.applyServer(items: [item("i1", "first"), item("i2", "second")], revision: 4))
        XCTAssertEqual(state.items.map(\.id), ["i1", "i2"])
    }

    func testAnEditShowsAtOnceLockedAndSurvivesTheServersList() {
        var state = MeetingLiveState(mode: .inPerson)
        state.applyServer(items: [item("i1", "Write the notes"), item("i2", "Call the client")], revision: 1)

        let update = state.enqueue(.update(id: "i1", text: " Write the release notes ", owner: "Ana", due: ""))
        XCTAssertNotNil(update)
        XCTAssertEqual(state.items[0].text, "Write the release notes")
        XCTAssertEqual(state.items[0].owner, "Ana")
        XCTAssertNil(state.items[0].due, "an empty field is no value")
        XCTAssertTrue(state.items[0].locked)
        XCTAssertEqual(state.items[0].updatedBy, "user")

        // the model's answer arrives before the edit reached the server
        state.applyServer(items: [item("i1", "Write the notes"), item("i2", "Call the client"), item("i3", "New from the model")], revision: 2)
        XCTAssertEqual(state.items[0].text, "Write the release notes", "the edit stays on top until the server confirms it")
        XCTAssertEqual(state.items.count, 3)

        var confirmed = item("i1", "Write the release notes")
        confirmed.owner = "Ana"
        confirmed.locked = true
        confirmed.updatedBy = "user"
        state.opSucceeded(update!.id, items: [confirmed, item("i2", "Call the client"), item("i3", "New from the model")], revision: 3)
        XCTAssertTrue(state.pendingOps.isEmpty)
        XCTAssertEqual(state.items[0], confirmed)
    }

    func testCancelRestoreAndRemove() {
        var state = MeetingLiveState(mode: .inPerson)
        state.applyServer(items: [item("i1", "a"), item("i2", "b", status: .cancelled)], revision: 1)
        XCTAssertNil(state.enqueue(.restore(id: "i1")), "an active entry has nothing to restore")
        XCTAssertNil(state.enqueue(.cancel(id: "i2")))
        XCTAssertNil(state.enqueue(.cancel(id: "missing")))
        XCTAssertNotNil(state.enqueue(.cancel(id: "i1")))
        XCTAssertTrue(state.items[0].isCancelled)
        XCTAssertTrue(state.items[0].locked)
        XCTAssertNotNil(state.enqueue(.restore(id: "i2")))
        XCTAssertFalse(state.items[1].isCancelled)
        XCTAssertNotNil(state.enqueue(.remove(id: "i2")))
        XCTAssertEqual(state.items.map(\.id), ["i1"])
        XCTAssertEqual(state.pendingOps.map(\.op.name), ["cancel", "restore", "remove"], "sent in the order made")
    }

    func testAnEntryAddedByHandGetsTheServersIdAndLaterEditsFollowIt() {
        var state = MeetingLiveState(mode: .inPerson)
        state.applyServer(items: [item("i1", "a")], revision: 1)
        XCTAssertNil(state.enqueue(.add(kind: .task, text: "  ", owner: nil, due: nil)), "nothing typed, nothing added")
        let add = state.enqueue(.add(kind: .agreement, text: "Launch on Monday", owner: nil, due: "Monday"), id: "op1")!
        XCTAssertEqual(add.provisionalId, "local-op1")
        XCTAssertEqual(state.items.last?.id, "local-op1")
        XCTAssertEqual(state.items.last?.kind, .agreement)
        XCTAssertTrue(state.items.last?.locked ?? false)
        // edited again before the server answered
        XCTAssertNotNil(state.enqueue(.cancel(id: "local-op1"), id: "op2"))
        XCTAssertTrue(state.items.last?.isCancelled ?? false)

        var added = item("i7", "Launch on Monday", kind: .agreement)
        added.due = "Monday"
        added.locked = true
        added.updatedBy = "user"
        let renamed = state.opSucceeded("op1", items: [item("i1", "a"), added], revision: 2)
        XCTAssertEqual(renamed?.provisional, "local-op1")
        XCTAssertEqual(renamed?.id, "i7")
        XCTAssertEqual(state.nextOp?.op, .cancel(id: "i7"), "the edit waiting now names the real entry")
        XCTAssertEqual(state.items.map(\.id), ["i1", "i7"])
        XCTAssertTrue(state.items[1].isCancelled)
    }

    func testARefusedEditIsDroppedWithTheEditsOfAnEntryThatWasNeverAdded() {
        var state = MeetingLiveState(mode: .inPerson)
        state.applyServer(items: [item("i1", "a")], revision: 1)
        state.enqueue(.add(kind: .task, text: "b", owner: nil, due: nil), id: "op1")
        state.enqueue(.update(id: "local-op1", text: "b2", owner: nil, due: nil), id: "op2")
        state.enqueue(.cancel(id: "i1"), id: "op3")
        state.opRejected("op1")
        XCTAssertEqual(state.pendingOps.map(\.id), ["op3"])
        XCTAssertEqual(state.items.map(\.id), ["i1"])
        XCTAssertTrue(state.items[0].isCancelled)
    }

    func testBeforeShowsWhatTheModelChanged() {
        var changed = MeetingItem(id: "i1", kind: .agreement, text: "Launch on Monday", updatedBy: "ai", history: [
            MeetingItem.Version(text: "Launch on Thursday", by: "ai"),
            MeetingItem.Version(text: "Launch on Friday", by: "ai"),
        ])
        XCTAssertEqual(changed.previousText, "Launch on Friday", "the version right before this one")
        changed.updatedBy = "user"
        XCTAssertNil(changed.previousText, "the person knows what their own edit replaced")
        let cancelled = MeetingItem(id: "i2", kind: .task, text: "Demo", status: .cancelled, updatedBy: "ai", history: [MeetingItem.Version(text: "Demo", by: "ai")])
        XCTAssertNil(cancelled.previousText, "same wording: nothing to show")
        XCTAssertNil(MeetingItem(id: "i3", kind: .task, text: "x").previousText)
    }

    // MARK: JSON

    func testSpeakerAndSegmentJSON() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let unnamed = try encoder.encode(MeetingSpeaker(id: "voice-1", number: 1))
        XCTAssertEqual(String(decoding: unnamed, as: UTF8.self), #"{"id":"voice-1","name":null,"number":1,"side":null}"#, "side and name travel as null")
        let named = try encoder.encode(MeetingSpeaker(id: "remote-2", number: 4, side: .remote, name: "Diego"))
        XCTAssertEqual(String(decoding: named, as: UTF8.self), #"{"id":"remote-2","name":"Diego","number":4,"side":"remote"}"#)

        let bare = try encoder.encode(MeetingSegment(start: 1, end: 2.5, text: "hi"))
        XCTAssertEqual(String(decoding: bare, as: UTF8.self), #"{"end":2.5,"start":1,"text":"hi"}"#, "no speaker, no side: both absent")
        let labelled = try encoder.encode(MeetingSegment(start: 1, end: 2, text: "hi", speaker: "room-1", side: .room))
        XCTAssertEqual(String(decoding: labelled, as: UTF8.self), #"{"end":2,"side":"room","speaker":"room-1","start":1,"text":"hi"}"#)

        XCTAssertEqual(MeetingMode.inPerson.rawValue, "in_person")
        XCTAssertEqual(MeetingMode.virtual.rawValue, "virtual")
        XCTAssertTrue(MeetingSpeaker.isValidId("remote-2"))
        XCTAssertTrue(MeetingSpeaker.isValidId("s_1"))
        XCTAssertFalse(MeetingSpeaker.isValidId("Speaker 1"))
        XCTAssertFalse(MeetingSpeaker.isValidId(""))
        XCTAssertFalse(MeetingSpeaker.isValidId(String(repeating: "a", count: 41)))
    }

    func testItemsDecodeAsTheServerSendsThem() throws {
        let json = #"""
        [
          {"id":"i1","kind":"task","text":"Probar la app nueva","owner":null,"due":"viernes","status":"active","locked":true,"at":3,"updatedBy":"user",
           "history":[{"text":"Probar la app","owner":"Ana","due":null,"status":"active","at":3,"by":"user"}]},
          {"id":"i2","kind":"agreement","text":"Lanzar el lunes","owner":null,"due":null,"status":"cancelled","locked":false,"at":null,"updatedBy":"ai","history":[]},
          {"kind":"task","text":"no id: skipped"},
          {"id":"i3","kind":"something new","text":"unknown kind"}
        ]
        """#
        let items = try JSONDecoder().decode(LossyItems.self, from: Data(json.utf8)).items
        XCTAssertEqual(items.map(\.id), ["i1", "i2", "i3"], "an entry that cannot be read does not lose the others")
        XCTAssertEqual(items[0].due, "viernes")
        XCTAssertNil(items[0].owner)
        XCTAssertTrue(items[0].locked)
        XCTAssertEqual(items[0].history.first?.owner, "Ana")
        XCTAssertEqual(items[0].history.first?.by, "user")
        XCTAssertTrue(items[1].isCancelled)
        XCTAssertNil(items[1].at)
        XCTAssertEqual(items[2].kind, .agreement)
        XCTAssertEqual(items[2].status, .active)
    }

    func testItemsRequestBodies() throws {
        func body(_ op: MeetingItemOp) throws -> [String: Any] {
            let data = try JSONEncoder().encode(ItemsBody(meetingId: "m1", op: op))
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        let add = try body(.add(kind: .task, text: "Write the notes", owner: "Ana", due: nil))
        XCTAssertEqual(Set(add.keys), ["meetingId", "op", "kind", "text", "owner"])
        XCTAssertEqual(add["op"] as? String, "add")
        XCTAssertEqual(add["kind"] as? String, "task")

        let update = try body(.update(id: "i1", text: "Write the notes", owner: nil, due: "Friday"))
        XCTAssertEqual(Set(update.keys), ["meetingId", "op", "id", "text", "owner", "due"])
        XCTAssertTrue(update["owner"] is NSNull, "a cleared owner travels as null")
        XCTAssertEqual(update["due"] as? String, "Friday")

        for op in [MeetingItemOp.cancel(id: "i1"), .restore(id: "i1"), .remove(id: "i1")] {
            let simple = try body(op)
            XCTAssertEqual(Set(simple.keys), ["meetingId", "op", "id"])
            XCTAssertEqual(simple["op"] as? String, op.name)
        }
    }
}
