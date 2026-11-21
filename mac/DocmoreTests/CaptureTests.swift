import XCTest

final class CaptureTests: XCTestCase {
    func testSplitTitleAndBody() {
        XCTAssertNil(CaptureNote.split("   \n  "))
        let single = CaptureNote.split("  Call the plumber  ")
        XCTAssertEqual(single?.title, "Call the plumber")
        XCTAssertEqual(single?.content, "")
        let multi = CaptureNote.split("Shopping\n\n- milk\n- bread\n")
        XCTAssertEqual(multi?.title, "Shopping")
        XCTAssertEqual(multi?.content, "- milk\n- bread")
        let heading = CaptureNote.split("## Ideas\nfirst idea")
        XCTAssertEqual(heading?.title, "Ideas")
        XCTAssertEqual(heading?.content, "first idea")
    }

    func testLongFirstLineKeepsEveryWordInTheBody() {
        let long = String(repeating: "word ", count: 60).trimmingCharacters(in: .whitespaces)
        let split = CaptureNote.split(long)
        XCTAssertNotNil(split)
        XCTAssertLessThanOrEqual(split!.title.count, 123)
        XCTAssertTrue(split!.title.hasSuffix("..."))
        XCTAssertEqual(split!.content, long, "nothing typed is lost")
    }

    func testRequestBody() {
        let note = CaptureNote(profileId: "p", spaceId: "space-1", title: "T", content: "body")
        XCTAssertEqual(note.requestBody["spaceId"] as? String, "space-1")
        XCTAssertEqual(note.requestBody["title"] as? String, "T")
        XCTAssertEqual(note.requestBody["content"] as? String, "body")
        XCTAssertEqual(note.requestBody["format"] as? String, "markdown")
        let bare = CaptureNote(profileId: "p", spaceId: "space-1", title: "T", content: "")
        XCTAssertNil(bare.requestBody["content"])
        XCTAssertNil(bare.requestBody["format"])
    }

    func testQueuePersistsInOrder() throws {
        let dir = try TestSupport.temporaryDirectory()
        let queue = CaptureQueue(directory: dir)
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        try queue.enqueue(CaptureNote(id: "b", profileId: "p", spaceId: "s", title: "second", content: "", createdAt: base.addingTimeInterval(5)))
        try queue.enqueue(CaptureNote(id: "a", profileId: "p", spaceId: "s", title: "first", content: "", createdAt: base))
        try queue.enqueue(CaptureNote(id: "c", profileId: "other", spaceId: "s", title: "third", content: "", createdAt: base.addingTimeInterval(9)))
        XCTAssertEqual(CaptureQueue(directory: dir).all().map(\.title), ["first", "second", "third"])
        queue.removeAll(profileId: "other")
        XCTAssertEqual(queue.all().map(\.id), ["a", "b"])
    }

    func testFlushSendsInOrderAndStopsWhenTheServerIsAway() async throws {
        let queue = CaptureQueue(directory: try TestSupport.temporaryDirectory())
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        for (index, id) in ["a", "b", "c"].enumerated() {
            try queue.enqueue(CaptureNote(id: id, profileId: "p", spaceId: "s", title: id, content: "", createdAt: base.addingTimeInterval(Double(index))))
        }
        let seen = Recorder()
        // the server goes away at the second note
        let first = await queue.flush { note in
            seen.add(note.id)
            return note.id == "b" ? .retryLater : .sent(pageId: "page-\(note.id)")
        }
        XCTAssertEqual(seen.values, ["a", "b"], "the third note must not overtake the second")
        XCTAssertEqual(first.sent, 1)
        XCTAssertEqual(first.left, 2)
        XCTAssertEqual(queue.pending().map(\.id), ["b", "c"])
        XCTAssertEqual(queue.pending().first?.attempts, 1)

        let second = await queue.flush { _ in .sent(pageId: nil) }
        XCTAssertEqual(second.sent, 2)
        XCTAssertEqual(second.left, 0)
        XCTAssertTrue(queue.all().isEmpty)
    }

    func testRefusedNoteIsKeptAsideAndDoesNotBlockTheRest() async throws {
        let queue = CaptureQueue(directory: try TestSupport.temporaryDirectory())
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        try queue.enqueue(CaptureNote(id: "a", profileId: "p", spaceId: "gone", title: "a", content: "", createdAt: base))
        try queue.enqueue(CaptureNote(id: "b", profileId: "p", spaceId: "s", title: "b", content: "", createdAt: base.addingTimeInterval(1)))
        let result = await queue.flush { note in
            note.id == "a" ? .refused("Space not found") : .sent(pageId: "x")
        }
        XCTAssertEqual(result.sent, 1)
        XCTAssertEqual(result.left, 0)
        XCTAssertEqual(queue.all().map(\.id), ["a"], "the refused note is not thrown away")
        XCTAssertEqual(queue.all().first?.failure, "Space not found")
        XCTAssertTrue(queue.pending().isEmpty)
    }

    func testMicrophoneOfferPolicy() {
        var policy = MicrophoneOfferPolicy(quietPeriod: 600)
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertFalse(policy.shouldOffer(inUse: false, appIsCapturing: false, enabled: true, now: start))
        XCTAssertTrue(policy.shouldOffer(inUse: true, appIsCapturing: false, enabled: true, now: start.addingTimeInterval(1)))
        // still in use: no second offer
        XCTAssertFalse(policy.shouldOffer(inUse: true, appIsCapturing: false, enabled: true, now: start.addingTimeInterval(2)))
        // released and taken again within the quiet period
        XCTAssertFalse(policy.shouldOffer(inUse: false, appIsCapturing: false, enabled: true, now: start.addingTimeInterval(60)))
        XCTAssertFalse(policy.shouldOffer(inUse: true, appIsCapturing: false, enabled: true, now: start.addingTimeInterval(120)))
        // after the quiet period
        XCTAssertFalse(policy.shouldOffer(inUse: false, appIsCapturing: false, enabled: true, now: start.addingTimeInterval(700)))
        XCTAssertTrue(policy.shouldOffer(inUse: true, appIsCapturing: false, enabled: true, now: start.addingTimeInterval(800)))
    }

    func testNoOfferWhileTheAppItselfRecordsOrWhenTurnedOff() {
        var policy = MicrophoneOfferPolicy(quietPeriod: 600)
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertFalse(policy.shouldOffer(inUse: true, appIsCapturing: true, enabled: true, now: start))
        XCTAssertFalse(policy.shouldOffer(inUse: false, appIsCapturing: false, enabled: true, now: start.addingTimeInterval(1)))
        XCTAssertFalse(policy.shouldOffer(inUse: true, appIsCapturing: false, enabled: false, now: start.addingTimeInterval(2)))
        XCTAssertFalse(policy.shouldOffer(inUse: false, appIsCapturing: false, enabled: true, now: start.addingTimeInterval(3)))
        XCTAssertTrue(policy.shouldOffer(inUse: true, appIsCapturing: false, enabled: true, now: start.addingTimeInterval(4)))
    }
}
