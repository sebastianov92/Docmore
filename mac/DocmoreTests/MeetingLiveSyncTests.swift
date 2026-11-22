import XCTest

/// A stand-in for the server's live meeting routes, following the contract:
/// keeps the segments it is sent, answers `stored`, and can be told to fail,
/// to refuse or to hold an answer back.
final class FakeMeetingServer: MeetingLiveTransport, @unchecked Sendable {
    struct Sent {
        let route: String
        let body: [String: Any]
        let key: String?
    }

    private let lock = NSLock()
    private var log: [Sent] = []
    private var segments: [[String: Any]] = []
    private var items: [[String: Any]] = []
    private var revision = 0
    private var nextItem = 1
    private var starts = 0
    private var failures: [String: [MeetingLiveFailure]] = [:]
    private var gates: [String: Gate] = [:]
    var aiAvailable = true

    final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var opened = false
        private var waiting: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            await withCheckedContinuation { continuation in
                lock.lock()
                if opened {
                    lock.unlock()
                    continuation.resume()
                } else {
                    waiting.append(continuation)
                    lock.unlock()
                }
            }
        }

        func open() {
            lock.lock()
            opened = true
            let pending = waiting
            waiting = []
            lock.unlock()
            pending.forEach { $0.resume() }
        }
    }

    var sent: [Sent] {
        lock.lock(); defer { lock.unlock() }
        return log
    }

    func sent(_ route: String) -> [[String: Any]] {
        sent.filter { $0.route == route }.map(\.body)
    }

    var routes: [String] { sent.map(\.route) }

    var storedTexts: [String] {
        lock.lock(); defer { lock.unlock() }
        return segments.compactMap { $0["text"] as? String }
    }

    var storedSpeakers: [String] {
        lock.lock(); defer { lock.unlock() }
        return segments.map { $0["speaker"] as? String ?? "" }
    }

    /// The next calls to `route` fail this way, one each.
    func fail(_ route: String, _ failure: MeetingLiveFailure, times: Int = 1) {
        lock.lock(); defer { lock.unlock() }
        failures[route, default: []].append(contentsOf: Array(repeating: failure, count: times))
    }

    /// Calls to `route` wait until the gate returned is opened.
    func hold(_ route: String) -> Gate {
        lock.lock(); defer { lock.unlock() }
        let gate = Gate()
        gates[route] = gate
        return gate
    }

    func setItems(_ list: [[String: Any]], revision: Int) {
        lock.lock(); defer { lock.unlock() }
        items = list
        self.revision = revision
    }

    /// Answers already given, by key: a repeat gets the same one again.
    private var answered: [String: Data] = [:]
    /// The next answers to `route` are lost on their way back: the server
    /// did the work, the client sees no answer.
    private var lostAnswers: [String: Int] = [:]

    func loseAnswer(_ route: String, times: Int = 1) {
        lock.lock(); defer { lock.unlock() }
        lostAnswers[route, default: 0] += times
    }

    func keys(_ route: String) -> [String?] {
        sent.filter { $0.route == route }.map(\.key)
    }

    func post(_ route: String, body: Data, timeout: TimeInterval, idempotencyKey: String?) async throws -> Data {
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        lock.lock()
        log.append(Sent(route: route, body: object, key: idempotencyKey))
        let gate = gates.removeValue(forKey: route)
        lock.unlock()
        if let gate { await gate.wait() }
        let data = try handle(route, object, key: idempotencyKey)
        lock.lock()
        defer { lock.unlock() }
        if let left = lostAnswers[route], left > 0 {
            lostAnswers[route] = left - 1
            throw MeetingLiveFailure.unreachable(reason: "answer lost")
        }
        return data
    }

    private func handle(_ route: String, _ object: [String: Any], key: String?) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        if var queued = failures[route], !queued.isEmpty {
            let failure = queued.removeFirst()
            failures[route] = queued
            throw failure
        }
        if let key, let stored = answered[key] { return stored }
        var answer: [String: Any]
        switch route {
        case "live/start":
            starts += 1
            segments = []
            items = []
            revision = 0
            answer = ["id": "meeting-\(starts)", "status": "live", "mode": object["mode"] ?? "", "items": [], "revision": 0, "aiAvailable": aiAvailable, "speakers": [], "canManage": true]
        case "live/update":
            let from = min(object["fromIndex"] as? Int ?? 0, segments.count)
            segments = Array(segments[..<from]) + ((object["segments"] as? [[String: Any]]) ?? [])
            answer = ["items": items, "revision": revision, "aiAvailable": aiAvailable, "stored": segments.count]
        case "items":
            revision += 1
            let id = object["id"] as? String ?? ""
            switch object["op"] as? String ?? "" {
            case "add":
                var entry: [String: Any] = [
                    "id": "i\(nextItem)", "kind": object["kind"] ?? "task", "text": object["text"] ?? "", "status": "active",
                    "locked": true, "updatedBy": "user", "history": [],
                ]
                if let owner = object["owner"] as? String { entry["owner"] = owner }
                if let due = object["due"] as? String { entry["due"] = due }
                nextItem += 1
                items.append(entry)
            case "remove":
                items.removeAll { $0["id"] as? String == id }
            default:
                guard let index = items.firstIndex(where: { $0["id"] as? String == id }) else {
                    throw MeetingLiveFailure.refused(status: 400, message: "That entry is not in the list")
                }
                if let text = object["text"] as? String { items[index]["text"] = text }
                if object["op"] as? String == "cancel" { items[index]["status"] = "cancelled" }
                if object["op"] as? String == "restore" { items[index]["status"] = "active" }
                items[index]["locked"] = true
                items[index]["updatedBy"] = "user"
            }
            answer = ["items": items, "revision": revision]
        case "live/discard":
            answer = ["ok": true]
        default:
            throw MeetingLiveFailure.refused(status: 404, message: "no such route")
        }
        let data = try JSONSerialization.data(withJSONObject: answer)
        if let key { answered[key] = data }
        return data
    }
}

/// What `MeetingLiveSync` sends, when, and what it does when a call fails.
@MainActor
final class MeetingLiveSyncTests: XCTestCase {
    private final class Clock {
        var time = Date(timeIntervalSince1970: 1_800_000_000)
        func advance(_ seconds: TimeInterval) { time = time.addingTimeInterval(seconds) }
    }

    private var server = FakeMeetingServer()
    private var clock = Clock()

    override func setUp() async throws {
        server = FakeMeetingServer()
        clock = Clock()
    }

    private func makeSync(mode: MeetingMode = .virtual, pageId: String? = nil) -> MeetingLiveSync {
        let clock = self.clock
        return MeetingLiveSync(
            mode: mode,
            target: MeetingLiveSync.Target(pageId: pageId, spaceId: "space-1", title: "Weekly sync", language: "es", locale: "es-ES"),
            transport: server,
            now: { clock.time }
        )
    }

    private let ana = MeetingSpeaker(id: "room-1", number: 1, side: .room)
    private let marta = MeetingSpeaker(id: "remote-1", number: 2, side: .remote)
    private let diego = MeetingSpeaker(id: "remote-2", number: 3, side: .remote)

    private func line(_ index: Int, _ speaker: MeetingSpeaker) -> MeetingSegment {
        MeetingSegment(start: Double(index) * 6, end: Double(index) * 6 + 5, text: "line \(index)", speaker: speaker.id, side: speaker.side)
    }

    private func updateBodies() -> [[String: Any]] { server.sent("live/update") }

    private func fromIndexes() -> [Int] { updateBodies().compactMap { $0["fromIndex"] as? Int } }

    private func counts() -> [Int] { updateBodies().map { ($0["segments"] as? [Any])?.count ?? -1 } }

    // MARK: Start

    func testStartOpensTheLiveMeetingWithItsKind() async {
        let sync = makeSync()
        XCTAssertEqual(sync.listStatus, .building, "nothing is wrong before the first answer")
        await sync.pump()
        let start = server.sent("live/start")
        XCTAssertEqual(start.count, 1)
        XCTAssertEqual(Set(start[0].keys), ["spaceId", "title", "mode", "language", "locale"], "only the contract's fields, and no page when the notes go to a space")
        XCTAssertEqual(start[0]["locale"] as? String, "es-ES", "the language of the app's interface, for the server's labels")
        XCTAssertEqual(start[0]["mode"] as? String, "virtual")
        XCTAssertEqual(start[0]["spaceId"] as? String, "space-1")
        XCTAssertEqual(start[0]["language"] as? String, "es")
        XCTAssertEqual(sync.meetingId, "meeting-1")
        XCTAssertTrue(sync.canEditList)
        await sync.pump()
        XCTAssertEqual(server.routes, ["live/start"], "nothing said yet: nothing more to send")
    }

    func testThePageWinsOverTheSpace() async {
        let sync = makeSync(mode: .inPerson, pageId: "page-9")
        await sync.pump()
        let start = server.sent("live/start")[0]
        XCTAssertEqual(start["pageId"] as? String, "page-9")
        XCTAssertNil(start["spaceId"])
        XCTAssertEqual(start["mode"] as? String, "in_person")
    }

    func testAMeetingTheServerCannotOpenStillRunsWithoutItsList() async {
        // an older server has no such route
        server.fail("live/start", .refused(status: 404, message: "Cannot POST"))
        let sync = makeSync()
        var ids: [String?] = []
        sync.onMeetingId = { ids.append($0) }
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana)], speakers: [ana]))
        await sync.pump()
        clock.advance(600)
        await sync.pump()
        await sync.pump(force: true)
        XCTAssertEqual(server.routes, ["live/start"], "asked once, never again")
        XCTAssertNil(sync.meetingId)
        XCTAssertEqual(sync.listStatus, .atEnd)
        XCTAssertFalse(sync.canEditList)
        XCTAssertNil(sync.edit(.add(kind: .task, text: "x", owner: nil, due: nil)), "with no live meeting there is no list to edit")
        XCTAssertTrue(ids.isEmpty)
        XCTAssertEqual(sync.state.segments.count, 1, "the transcript is kept all the same")
    }

    func testAServerOutOfReachIsAskedAgainLater() async {
        server.fail("live/start", .unreachable, times: 2)
        let sync = makeSync()
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana), line(1, marta)], speakers: [ana, marta]))
        await sync.pump()
        XCTAssertEqual(sync.listStatus, .atEnd)
        await sync.pump()
        XCTAssertEqual(server.routes, ["live/start"], "not hammered: it waits before trying again")
        clock.advance(16)
        await sync.pump()
        XCTAssertEqual(server.routes, ["live/start", "live/start"])
        clock.advance(31)
        await sync.pump()
        XCTAssertEqual(sync.meetingId, "meeting-1")
        // everything said while the server was away goes in the first update
        XCTAssertEqual(server.routes, ["live/start", "live/start", "live/start", "live/update"])
        XCTAssertEqual(fromIndexes(), [0])
        XCTAssertEqual(server.storedTexts, ["line 0", "line 1"])
    }

    func testOpeningAgainAfterALostAnswerDoesNotLeaveASecondMeeting() async {
        // the server opened the meeting, the answer never arrived
        server.loseAnswer("live/start")
        let sync = makeSync()
        await sync.pump()
        XCTAssertNil(sync.meetingId)
        clock.advance(16)
        await sync.pump()
        XCTAssertEqual(sync.meetingId, "meeting-1", "the same key again: the server gives the first answer, not a second meeting")
        let keys = server.keys("live/start")
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotNil(keys[0])
        XCTAssertEqual(keys[0], keys[1])
    }

    // MARK: Updates

    func testUpdatesGoOutAboutEveryHalfMinuteWithOnlyWhatIsNew() async {
        let sync = makeSync()
        await sync.pump()
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana), line(1, marta)], speakers: [ana, marta]))
        clock.advance(5)
        await sync.pump()
        XCTAssertTrue(updateBodies().isEmpty, "the first update waits a moment for text to gather")
        clock.advance(6)
        await sync.pump()
        XCTAssertEqual(fromIndexes(), [0])
        XCTAssertEqual(counts(), [2])
        let first = updateBodies()[0]
        XCTAssertEqual(Set(first.keys), ["meetingId", "fromIndex", "segments", "speakers"], "only the contract's fields")
        XCTAssertEqual(first["meetingId"] as? String, "meeting-1")
        let firstSegment = (first["segments"] as? [[String: Any]])?.first ?? [:]
        XCTAssertEqual(Set(firstSegment.keys), ["start", "end", "text", "speaker", "side"])
        XCTAssertEqual(sync.state.acknowledged, 2)
        if case .updated = sync.listStatus {} else { XCTFail("after an answer the line says when: \(sync.listStatus)") }

        sync.ingest(MeetingLiveUpdate(segments: [line(2, ana)], speakers: [ana, marta]))
        clock.advance(20)
        await sync.pump()
        XCTAssertEqual(counts(), [2], "not yet: half a minute between updates")
        clock.advance(11)
        await sync.pump()
        XCTAssertEqual(fromIndexes(), [0, 2])
        XCTAssertEqual(counts(), [2, 1])
        clock.advance(120)
        await sync.pump()
        XCTAssertEqual(counts(), [2, 1], "silence: no call")
        XCTAssertEqual(server.storedTexts, ["line 0", "line 1", "line 2"])
    }

    func testOneUpdateAtATime() async {
        let sync = makeSync()
        await sync.pump()
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana)], speakers: [ana]))
        clock.advance(11)
        let gate = server.hold("live/update")
        let slow = Task { await sync.pump() }
        // the model on the server takes its time; text keeps coming and the ticks keep calling
        for _ in 0..<20 where updateBodies().isEmpty { await Task.yield() }
        XCTAssertEqual(sync.listStatus, .building)
        sync.ingest(MeetingLiveUpdate(segments: [line(1, marta)], speakers: [ana, marta]))
        clock.advance(120)
        await sync.pump()
        await sync.pump(force: true)
        XCTAssertEqual(updateBodies().count, 1, "no second update while the first has no answer")
        gate.open()
        await slow.value
        XCTAssertEqual(sync.state.acknowledged, 1)
        clock.advance(5)
        await sync.pump()
        XCTAssertEqual(updateBodies().count, 1, "a breath after the answer before the next one")
        clock.advance(6)
        await sync.pump()
        XCTAssertEqual(fromIndexes(), [0, 1])
    }

    func testAFailedUpdateIsSentAgainFromTheFirstIndexNotAcknowledged() async {
        let sync = makeSync()
        await sync.pump()
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana), line(1, marta)], speakers: [ana, marta]))
        clock.advance(11)
        await sync.pump()
        XCTAssertEqual(sync.state.acknowledged, 2)

        server.fail("live/update", .unreachable, times: 2)
        sync.ingest(MeetingLiveUpdate(segments: [line(2, ana)], speakers: [ana, marta]))
        clock.advance(31)
        await sync.pump()
        XCTAssertEqual(fromIndexes(), [0, 2])
        XCTAssertEqual(sync.state.acknowledged, 2, "the lost call acknowledged nothing")
        XCTAssertEqual(sync.listStatus, .atEnd, "the server cannot be reached right now")

        sync.ingest(MeetingLiveUpdate(segments: [line(3, marta)], speakers: [ana, marta]))
        clock.advance(5)
        await sync.pump()
        XCTAssertEqual(updateBodies().count, 2, "it waits before trying again")
        clock.advance(11)
        await sync.pump()
        XCTAssertEqual(fromIndexes(), [0, 2, 2], "again from line 2, with what was said meanwhile")
        XCTAssertEqual(counts(), [2, 1, 2])
        XCTAssertEqual(sync.state.acknowledged, 2)

        clock.advance(31)
        await sync.pump()
        XCTAssertEqual(fromIndexes(), [0, 2, 2, 2])
        XCTAssertEqual(sync.state.acknowledged, 4)
        XCTAssertEqual(server.storedTexts, ["line 0", "line 1", "line 2", "line 3"], "nothing lost, nothing twice")
        if case .updated = sync.listStatus {} else { XCTFail("back to normal: \(sync.listStatus)") }
        XCTAssertEqual(sync.calls.map(\.outcome), ["ok", "ok", "unreachable", "unreachable", "ok"])
    }

    func testARelabelledLineIsSentAgain() async {
        let sync = makeSync()
        await sync.pump()
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana), line(1, marta), line(2, ana), line(3, marta)], speakers: [ana, marta]))
        clock.advance(11)
        await sync.pump()
        XCTAssertEqual(server.storedSpeakers, ["room-1", "remote-1", "room-1", "remote-1"])

        // line 1 turns out to be a third voice
        sync.ingest(MeetingLiveUpdate(
            fromIndex: 1,
            segments: [line(1, diego), line(2, ana), line(3, marta), line(4, diego)],
            speakers: [ana, marta, diego]
        ))
        clock.advance(31)
        await sync.pump()
        XCTAssertEqual(fromIndexes(), [0, 1])
        XCTAssertEqual(counts(), [4, 4])
        XCTAssertEqual(server.storedSpeakers, ["room-1", "remote-2", "room-1", "remote-1", "remote-2"])
        let speakers = (updateBodies()[1]["speakers"] as? [[String: Any]]) ?? []
        XCTAssertEqual(speakers.compactMap { $0["id"] as? String }, ["room-1", "remote-1", "remote-2"])
    }

    func testNamesTravelInTheSpeakersAndATypedNameGoesOutEarly() async {
        let sync = makeSync()
        await sync.pump()
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana), line(1, marta)], speakers: [ana, marta]))
        clock.advance(11)
        await sync.pump()
        var speakers = (updateBodies()[0]["speakers"] as? [[String: Any]]) ?? []
        XCTAssertTrue(speakers[0]["name"] is NSNull, "no name yet: null, the server shows the default label")
        XCTAssertEqual(speakers[0]["number"] as? Int, 1)
        XCTAssertEqual(speakers[1]["side"] as? String, "remote")

        sync.rename(speakerId: "remote-1", to: "Marta")
        clock.advance(8)
        await sync.pump()
        XCTAssertEqual(updateBodies().count, 1, "still inside the minimum gap between calls")
        clock.advance(5)
        await sync.pump()
        XCTAssertEqual(updateBodies().count, 2, "a name does not wait for the half minute")
        XCTAssertEqual(fromIndexes(), [0, 2])
        XCTAssertEqual(counts(), [2, 0], "no text is sent again for a name")
        speakers = (updateBodies()[1]["speakers"] as? [[String: Any]]) ?? []
        XCTAssertEqual(speakers[1]["name"] as? String, "Marta")
        XCTAssertTrue(speakers[0]["name"] is NSNull)
    }

    func testTheServersListIsShown() async {
        let sync = makeSync()
        await sync.pump()
        server.setItems([
            ["id": "i1", "kind": "agreement", "text": "Launch on Monday", "status": "active", "locked": false, "updatedBy": "ai",
             "history": [["text": "Launch on Friday", "status": "active", "by": "ai"]]],
            ["id": "i2", "kind": "task", "text": "Internal demo", "owner": "Diego", "status": "cancelled", "locked": false, "updatedBy": "ai", "history": []],
        ], revision: 5)
        var changes = 0
        sync.onChange = { changes += 1 }
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana)], speakers: [ana]))
        clock.advance(11)
        await sync.pump()
        XCTAssertEqual(sync.state.items.map(\.id), ["i1", "i2"])
        XCTAssertEqual(sync.state.items[0].previousText, "Launch on Friday")
        XCTAssertTrue(sync.state.items[1].isCancelled)
        XCTAssertEqual(sync.state.items[1].owner, "Diego")
        XCTAssertEqual(sync.state.revision, 5)
        XCTAssertGreaterThan(changes, 0, "the panel is told to redraw")
    }

    func testNoLanguageModelMeansTheListIsMadeAtTheEnd() async {
        server.aiAvailable = false
        let sync = makeSync()
        await sync.pump()
        XCTAssertEqual(sync.listStatus, .atEnd)
        XCTAssertEqual(sync.aiAvailable, false)
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana)], speakers: [ana]))
        clock.advance(11)
        await sync.pump()
        XCTAssertEqual(updateBodies().count, 1, "the transcript is still kept on the server")
        XCTAssertEqual(sync.listStatus, .atEnd)
        // a model was set up meanwhile
        server.aiAvailable = true
        sync.ingest(MeetingLiveUpdate(segments: [line(1, ana)], speakers: [ana]))
        clock.advance(31)
        await sync.pump()
        if case .updated = sync.listStatus {} else { XCTFail("the list is live again: \(sync.listStatus)") }
    }

    func testTheOfflineSwitchHoldsEveryCallBack() async {
        let sync = makeSync()
        var offline = true
        sync.isOffline = { offline }
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana)], speakers: [ana]))
        clock.advance(60)
        await sync.pump()
        await sync.pump(force: true)
        XCTAssertTrue(server.routes.isEmpty)
        XCTAssertEqual(sync.listStatus, .atEnd)
        offline = false
        await sync.pump()
        XCTAssertEqual(server.routes, ["live/start", "live/update"])
        XCTAssertEqual(fromIndexes(), [0])
        offline = true
        sync.ingest(MeetingLiveUpdate(segments: [line(1, ana)], speakers: [ana]))
        clock.advance(60)
        await sync.pump()
        XCTAssertEqual(server.routes.count, 2)
        XCTAssertEqual(sync.listStatus, .atEnd)
    }

    func testAMeetingTheServerLostIsOpenedAgainAndSentWhole() async {
        let sync = makeSync()
        var ids: [String?] = []
        sync.onMeetingId = { ids.append($0) }
        await sync.pump()
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana), line(1, marta)], speakers: [ana, marta]))
        sync.rename(speakerId: "room-1", to: "Ana")
        clock.advance(11)
        await sync.pump()
        XCTAssertEqual(sync.state.acknowledged, 2)

        server.fail("live/update", .refused(status: 404, message: "This meeting is not running"))
        sync.ingest(MeetingLiveUpdate(segments: [line(2, ana)], speakers: [ana, marta]))
        clock.advance(31)
        await sync.pump()
        XCTAssertNil(sync.meetingId)
        XCTAssertEqual(sync.state.acknowledged, 0)
        await sync.pump()
        XCTAssertEqual(sync.meetingId, "meeting-2")
        XCTAssertEqual(ids, ["meeting-1", nil, "meeting-2"], "the file next to the audio follows the live meeting")
        XCTAssertEqual(server.routes, ["live/start", "live/update", "live/update", "live/start", "live/update"])
        XCTAssertEqual(fromIndexes().last, 0)
        XCTAssertEqual(counts().last, 3)
        let speakers = (updateBodies().last?["speakers"] as? [[String: Any]]) ?? []
        XCTAssertEqual(speakers.first?["name"] as? String, "Ana", "the names go with it")
        XCTAssertEqual(server.storedTexts, ["line 0", "line 1", "line 2"])
    }

    func testAServerThatKeepsRefusingIsLeftAlone() async {
        let sync = makeSync()
        await sync.pump()
        server.fail("live/update", .refused(status: 400, message: "Too many calls"), times: 3)
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana)], speakers: [ana]))
        clock.advance(11)
        await sync.pump()
        clock.advance(60)
        await sync.pump()
        XCTAssertEqual(updateBodies().count, 1, "a refusal is followed by a long wait")
        clock.advance(61)
        await sync.pump()
        clock.advance(121)
        await sync.pump()
        XCTAssertEqual(updateBodies().count, 3)
        clock.advance(600)
        await sync.pump()
        XCTAssertEqual(updateBodies().count, 3, "three refusals: no more updates for this meeting")
        XCTAssertEqual(sync.listStatus, .atEnd)
        XCTAssertEqual(sync.meetingId, "meeting-1", "the final transcript still finishes this meeting")
    }

    // MARK: Edits made by hand

    func testAnEditGoesOutAtOnceAndComesBackWithTheServersId() async {
        let sync = makeSync()
        await sync.pump()
        var renamed: [String] = []
        sync.onItemRenamed = { provisional, id in renamed = [provisional, id] }
        let pending = sync.edit(.add(kind: .task, text: "Write the release notes", owner: "Diego", due: "Thursday"))
        XCTAssertEqual(sync.state.items.count, 1, "shown before the server answers")
        XCTAssertTrue(sync.state.items[0].locked)
        await sync.pump()
        let body = server.sent("items")[0]
        XCTAssertEqual(body["op"] as? String, "add")
        XCTAssertEqual(body["meetingId"] as? String, "meeting-1")
        XCTAssertEqual(body["owner"] as? String, "Diego")
        XCTAssertEqual(sync.state.items.map(\.id), ["i1"])
        XCTAssertEqual(renamed, [pending?.provisionalId ?? "", "i1"])
        XCTAssertTrue(sync.state.pendingOps.isEmpty)

        sync.edit(.update(id: "i1", text: "Write the release notes and the changelog", owner: nil, due: "Thursday"))
        sync.edit(.cancel(id: "i1"))
        sync.edit(.restore(id: "i1"))
        await sync.pump()
        XCTAssertEqual(server.sent("items").compactMap { $0["op"] as? String }, ["add", "update", "cancel", "restore"], "in the order made")
        XCTAssertTrue(server.sent("items")[1]["owner"] is NSNull)
        sync.edit(.remove(id: "i1"))
        await sync.pump()
        XCTAssertTrue(sync.state.items.isEmpty)
    }

    func testAnEditDoesNotWaitBehindTheModel() async {
        let sync = makeSync()
        await sync.pump()
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana)], speakers: [ana]))
        clock.advance(11)
        let gate = server.hold("live/update")
        let slow = Task { await sync.pump() }
        for _ in 0..<20 where updateBodies().isEmpty { await Task.yield() }
        // the update is with the model; the person adds an entry meanwhile
        sync.edit(.add(kind: .agreement, text: "Launch on Monday", owner: nil, due: nil))
        await sync.pump()
        XCTAssertEqual(server.sent("items").count, 1, "sent while the update has no answer yet")
        XCTAssertEqual(sync.state.items.map(\.id), ["i1"])
        gate.open()
        await slow.value
        XCTAssertEqual(sync.state.items.map(\.id), ["i1"], "the update's answer does not undo the edit")
    }

    func testAnEditMadeWhileTheServerIsAwayIsSentLater() async {
        let sync = makeSync()
        await sync.pump()
        server.fail("items", .unreachable)
        sync.edit(.add(kind: .task, text: "Call the client", owner: nil, due: nil))
        await sync.pump()
        XCTAssertEqual(sync.state.pendingOps.count, 1)
        XCTAssertEqual(sync.state.items.count, 1, "still shown")
        await sync.pump()
        XCTAssertEqual(server.sent("items").count, 1, "it waits before trying again")
        clock.advance(16)
        await sync.pump()
        XCTAssertEqual(server.sent("items").count, 2)
        XCTAssertTrue(sync.state.pendingOps.isEmpty)
        XCTAssertEqual(sync.state.items.map(\.id), ["i1"])
    }

    func testAnEditWhoseAnswerWasLostIsNotAppliedTwice() async {
        let sync = makeSync()
        await sync.pump()
        // the server adds the entry; its answer is lost on the way back
        server.loseAnswer("items")
        sync.edit(.add(kind: .task, text: "Call the client", owner: nil, due: nil))
        await sync.pump()
        XCTAssertEqual(sync.state.pendingOps.count, 1, "no answer: the edit is tried again")
        clock.advance(16)
        await sync.pump()
        XCTAssertTrue(sync.state.pendingOps.isEmpty)
        let keys = server.keys("items")
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotNil(keys[0])
        XCTAssertEqual(keys[0], keys[1], "the same key on the retry")
        XCTAssertEqual(sync.state.items.map(\.id), ["i1"], "one entry, not two")

        // another edit is another key
        sync.edit(.cancel(id: "i1"))
        await sync.pump()
        XCTAssertNotEqual(server.keys("items").last, keys[0])
        XCTAssertTrue(server.keys("live/update").allSatisfy { $0 == nil }, "updates are resent by index, never replayed")
    }

    func testALineOfAVoiceThatIsGoneTravelsWithoutIt() async {
        let sync = makeSync()
        await sync.pump()
        // two ids turned out to be one voice: the engine lists only the one
        // that stays, an old line still carries the other id
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana), line(1, diego), line(2, marta)], speakers: [ana, marta]))
        clock.advance(11)
        await sync.pump()
        let segments = (updateBodies()[0]["segments"] as? [[String: Any]]) ?? []
        XCTAssertEqual(segments.map { $0["speaker"] as? String }, ["room-1", nil, "remote-1"], "the server only knows the speakers it is sent")
        XCTAssertEqual(segments[1]["side"] as? String, "remote", "its side stays")
    }

    func testAnEditTheServerRefusesIsDropped() async {
        let sync = makeSync()
        await sync.pump()
        server.setItems([["id": "i1", "kind": "task", "text": "a", "status": "active"]], revision: 1)
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana)], speakers: [ana]))
        clock.advance(11)
        await sync.pump()
        XCTAssertEqual(sync.state.items.map(\.id), ["i1"])
        // the entry went away on the server meanwhile
        server.setItems([], revision: 2)
        sync.edit(.cancel(id: "i1"))
        await sync.pump()
        XCTAssertTrue(sync.state.pendingOps.isEmpty, "not sent again and again")
        XCTAssertEqual(sync.calls.last?.outcome, "refused 400")
    }

    // MARK: The end of the recording

    func testAfterStopOnlyEditsGoOutThenNothing() async {
        let sync = makeSync()
        await sync.pump()
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana)], speakers: [ana]))
        clock.advance(11)
        await sync.pump()
        sync.ingest(MeetingLiveUpdate(segments: [line(1, ana)], speakers: [ana]))
        sync.stopUpdates()
        clock.advance(120)
        await sync.pump()
        await sync.pump(force: true)
        XCTAssertEqual(updateBodies().count, 1, "the transcript of the recording carries the rest")

        server.fail("items", .unreachable)
        sync.edit(.add(kind: .task, text: "Send the minutes", owner: nil, due: nil))
        await sync.pump()
        XCTAssertEqual(sync.state.pendingOps.count, 1)
        // before the transcript is queued the edits are pushed, whatever the wait was
        await sync.flushEdits(timeout: 5)
        XCTAssertTrue(sync.state.pendingOps.isEmpty)
        XCTAssertEqual(server.sent("items").count, 2)

        sync.close()
        XCTAssertFalse(sync.canEditList)
        XCTAssertNil(sync.edit(.add(kind: .task, text: "too late", owner: nil, due: nil)))
        await sync.pump(force: true)
        XCTAssertEqual(server.sent("items").count, 2)
        XCTAssertEqual(sync.meetingId, "meeting-1", "the id travels with the transcript")
    }

    func testDiscardRemovesTheLiveMeeting() async {
        let sync = makeSync()
        var ids: [String?] = []
        sync.onMeetingId = { ids.append($0) }
        await sync.pump()
        sync.ingest(MeetingLiveUpdate(segments: [line(0, ana)], speakers: [ana]))
        await sync.discard()
        XCTAssertEqual(server.routes, ["live/start", "live/discard"])
        XCTAssertEqual(server.sent("live/discard")[0]["meetingId"] as? String, "meeting-1")
        XCTAssertEqual(ids, ["meeting-1", nil])
        clock.advance(120)
        await sync.pump(force: true)
        XCTAssertEqual(server.routes.count, 2, "nothing after a discard")
    }

    func testADiscardThatGotNoAnswerIsTriedOnceMoreWithTheSameKey() async {
        let sync = makeSync()
        await sync.pump()
        server.fail("live/discard", .unreachable)
        await sync.discard()
        XCTAssertEqual(server.routes, ["live/start", "live/discard", "live/discard"])
        let keys = server.keys("live/discard")
        XCTAssertNotNil(keys[0])
        XCTAssertEqual(keys[0], keys[1])
        XCTAssertNil(sync.meetingId)
    }

    func testDiscardWithNoLiveMeetingCallsNothing() async {
        server.fail("live/start", .unreachable)
        let sync = makeSync()
        await sync.pump()
        await sync.discard()
        XCTAssertEqual(server.routes, ["live/start"])
    }
}
