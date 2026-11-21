import XCTest
@testable import MeetingKit

/// A server the test scripts: answers per call, counts every send.
private final class ScriptedSender: MeetingSender, @unchecked Sendable {
    private let lock = NSLock()
    private var script: [Result<MeetingReceipt, Error>] = []
    private var sentIds: [String] = []
    private var inFlight = 0
    private(set) var maxInFlight = 0
    /// Each send waits this long, so flushes overlap.
    var delayNanoseconds: UInt64 = 0
    /// What to answer once the script is used up.
    var fallback: Result<MeetingReceipt, Error>?

    func then(_ results: Result<MeetingReceipt, Error>...) {
        lock.withLock { script.append(contentsOf: results) }
    }

    var sends: [String] { lock.withLock { sentIds } }
    var peak: Int { lock.withLock { maxInFlight } }

    func send(_ job: MeetingJob) async throws -> MeetingReceipt {
        let step: Result<MeetingReceipt, Error>? = lock.withLock {
            sentIds.append(job.id)
            inFlight += 1
            maxInFlight = max(maxInFlight, inFlight)
            return script.isEmpty ? fallback : script.removeFirst()
        }
        defer { lock.withLock { inFlight -= 1 } }
        if delayNanoseconds > 0 { try? await Task.sleep(nanoseconds: delayNanoseconds) }
        switch step {
        case .success(let receipt): return receipt
        case .failure(let error): throw error
        case nil: return MeetingReceipt(id: "meeting-\(job.id)", status: "queued", pageId: job.target.pageId)
        }
    }
}

private func http(_ status: Int, _ message: String = "") -> Error {
    MeetingSendError.http(status: status, message: message)
}

final class MeetingQueueTests: XCTestCase {
    private let target = MeetingTarget.page("0195e5a4-0000-7000-8000-000000000001", title: "Weekly")

    // MARK: - Persistence

    func testEnqueueWritesOneJSONFilePerJob() throws {
        let directory = makeTemporaryDirectory(self)
        let queue = MeetingQueue(directory: directory, sender: ScriptedSender())
        let job = try queue.enqueue(sampleTranscript(), target: target, userInfo: ["recording": "/tmp/a.wav"])
        XCTAssertEqual(queue.pendingCount, 1)
        XCTAssertEqual(queue.failedCount, 0)

        let file = directory.appendingPathComponent("\(job.id).json")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertEqual(json["id"] as? String, job.id)
        XCTAssertEqual(json["attempts"] as? Int, 0)
        XCTAssertEqual((json["target"] as? [String: Any])?["pageId"] as? String, target.pageId)
        XCTAssertEqual((json["target"] as? [String: Any])?["title"] as? String, "Weekly")
        XCTAssertEqual((json["userInfo"] as? [String: String])?["recording"], "/tmp/a.wav")
        let transcript = try XCTUnwrap(json["transcript"] as? [String: Any])
        XCTAssertEqual(transcript["text"] as? String, "Hello there. General Kenobi.")
        XCTAssertEqual((transcript["segments"] as? [[String: Any]])?.count, 2)
        XCTAssertNotNil(json["createdAt"] as? String)
    }

    func testSurvivesRelaunch() async throws {
        let directory = makeTemporaryDirectory(self)
        var ids: [String] = []
        do {
            let queue = MeetingQueue(directory: directory, sender: ScriptedSender())
            ids.append(try queue.enqueue(sampleTranscript(), target: target).id)
            ids.append(try queue.enqueue(sampleTranscript(), target: .space("space-1")).id)
        }
        // a new process: a new queue object on the same directory
        let sender = ScriptedSender()
        let queue = MeetingQueue(directory: directory, sender: sender)
        XCTAssertEqual(queue.pendingCount, 2)
        XCTAssertEqual(queue.pendingJobs().map(\.id), ids, "oldest first")
        XCTAssertEqual(queue.pendingJobs()[0].transcript, sampleTranscript())
        XCTAssertEqual(queue.pendingJobs()[1].target, .space("space-1"))

        let report = await queue.flush()
        XCTAssertEqual(report.sent.map(\.job.id), ids)
        XCTAssertEqual(report.sent[0].receipt.id, "meeting-\(ids[0])")
        XCTAssertEqual(report.pending, 0)
        XCTAssertEqual(queue.pendingCount, 0)
        XCTAssertEqual(sender.sends, ids)
        let left = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }
        XCTAssertEqual(left, [], "sent jobs are removed from disk")
    }

    func testRefusesWhatTheServerWouldRefuse() {
        let queue = MeetingQueue(directory: makeTemporaryDirectory(self), sender: ScriptedSender())
        XCTAssertThrowsError(try queue.enqueue(sampleTranscript(), target: MeetingTarget(title: "nowhere"))) {
            XCTAssertEqual($0 as? MeetingQueueError, .invalidTarget)
        }
        let silence = MeetingTranscript(text: "  ", language: nil, durationSeconds: 30, segments: [])
        XCTAssertThrowsError(try queue.enqueue(silence, target: target)) {
            XCTAssertEqual($0 as? MeetingQueueError, .emptyTranscript)
        }
        XCTAssertEqual(queue.pendingCount, 0)
    }

    // MARK: - Retry classification

    func testClassification() {
        func keep(_ error: Error, stop: Bool, file: StaticString = #filePath, line: UInt = #line) {
            guard case .keep(_, let stopPass) = MeetingQueue.disposition(for: error) else {
                return XCTFail("\(error) should keep the job", file: file, line: line)
            }
            XCTAssertEqual(stopPass, stop, file: file, line: line)
        }
        func fail(_ error: Error, file: StaticString = #filePath, line: UInt = #line) {
            guard case .fail = MeetingQueue.disposition(for: error) else {
                return XCTFail("\(error) should fail the job", file: file, line: line)
            }
        }
        // no answer at all
        keep(URLError(.notConnectedToInternet), stop: true)
        keep(URLError(.cannotConnectToHost), stop: true)
        keep(URLError(.timedOut), stop: true)
        keep(CancellationError(), stop: true)
        // the server is there but not well, or the page is not there (yet)
        keep(http(500), stop: true)
        keep(http(502), stop: true)
        keep(http(503), stop: true)
        keep(http(404), stop: false)
        keep(http(408), stop: true)
        keep(http(429), stop: true)
        // sign in again
        XCTAssertEqual(MeetingQueue.disposition(for: http(401)), .needsSignIn)
        XCTAssertEqual(MeetingQueue.disposition(for: MeetingSendError.needsSignIn), .needsSignIn)
        // the server will never take it
        fail(http(400))
        fail(http(403))
        fail(http(413))
        fail(http(422))
        fail(MeetingSendError.invalid("no target"))
        XCTAssertEqual(MeetingQueue.disposition(for: http(403, "You cannot create pages in that space")),
                       .fail(reason: "The server answered 403: You cannot create pages in that space"))
    }

    func testNetworkFailureKeepsTheJobAndALaterFlushSendsItOnce() async throws {
        let directory = makeTemporaryDirectory(self)
        let sender = ScriptedSender()
        let queue = MeetingQueue(directory: directory, sender: sender)
        let job = try queue.enqueue(sampleTranscript(), target: target)

        sender.then(.failure(URLError(.cannotConnectToHost)))
        var report = await queue.flush()
        XCTAssertEqual(report.sent.count, 0)
        XCTAssertEqual(report.pending, 1)
        XCTAssertNotNil(report.stoppedBy)
        XCTAssertFalse(report.needsSignIn)
        XCTAssertEqual(queue.pendingCount, 1)
        XCTAssertEqual(queue.failedCount, 0)
        let kept = try XCTUnwrap(queue.pendingJobs().first)
        XCTAssertEqual(kept.id, job.id)
        XCTAssertEqual(kept.attempts, 1)
        XCTAssertNotNil(kept.lastError)
        XCTAssertNotNil(kept.lastAttemptAt)

        sender.then(.failure(http(503, "Service Unavailable")))
        report = await queue.flush()
        XCTAssertEqual(queue.pendingJobs().first?.attempts, 2)
        XCTAssertEqual(queue.pendingJobs().first?.lastError, "The server answered 503: Service Unavailable")

        // the server is back
        report = await queue.flush()
        XCTAssertEqual(report.sent.map(\.job.id), [job.id])
        XCTAssertEqual(queue.pendingCount, 0)
        report = await queue.flush()
        XCTAssertEqual(report.sent.count, 0)
        XCTAssertEqual(sender.sends, [job.id, job.id, job.id], "two refused attempts and one that went through: never again after that")
    }

    func testAJobWhoseAnswerWasLostKeepsItsIdForTheNextAttempt() async throws {
        // the id is the idempotency key: it must be the same on every attempt
        let sender = ScriptedSender()
        let queue = MeetingQueue(directory: makeTemporaryDirectory(self), sender: sender)
        let job = try queue.enqueue(sampleTranscript(), target: target)
        sender.then(.failure(URLError(.timedOut)), .failure(URLError(.networkConnectionLost)))
        _ = await queue.flush()
        _ = await queue.flush()
        let report = await queue.flush()
        XCTAssertEqual(sender.sends, [job.id, job.id, job.id])
        XCTAssertEqual(report.sent.map(\.job.id), [job.id])
        XCTAssertEqual(report.sent.first?.job.attempts, 2)
    }

    func testANetworkFailureStopsThePass() async throws {
        let sender = ScriptedSender()
        let queue = MeetingQueue(directory: makeTemporaryDirectory(self), sender: sender)
        let first = try queue.enqueue(sampleTranscript(), target: target)
        _ = try queue.enqueue(sampleTranscript(), target: target)
        sender.then(.failure(URLError(.notConnectedToInternet)))
        let report = await queue.flush()
        XCTAssertEqual(sender.sends, [first.id], "offline: the second job is not even tried")
        XCTAssertEqual(report.pending, 2)
    }

    func testNotFoundKeepsTheJobAndGoesOn() async throws {
        let sender = ScriptedSender()
        let queue = MeetingQueue(directory: makeTemporaryDirectory(self), sender: sender)
        let first = try queue.enqueue(sampleTranscript(), target: target)
        let second = try queue.enqueue(sampleTranscript(), target: target)
        sender.then(.failure(http(404, "Page not found")))
        let report = await queue.flush()
        XCTAssertEqual(sender.sends, [first.id, second.id])
        XCTAssertEqual(report.sent.map(\.job.id), [second.id])
        XCTAssertEqual(queue.pendingJobs().map(\.id), [first.id])
        XCTAssertEqual(queue.failedCount, 0)
    }

    func testUnauthorizedKeepsTheJobAndAsksForSignIn() async throws {
        let sender = ScriptedSender()
        let queue = MeetingQueue(directory: makeTemporaryDirectory(self), sender: sender)
        let first = try queue.enqueue(sampleTranscript(), target: target)
        let second = try queue.enqueue(sampleTranscript(), target: target)
        XCTAssertFalse(queue.needsSignIn)

        sender.then(.failure(http(401, "Unauthorized")))
        var report = await queue.flush()
        XCTAssertTrue(report.needsSignIn)
        XCTAssertTrue(queue.needsSignIn)
        XCTAssertEqual(queue.pendingCount, 2, "nothing is lost")
        XCTAssertEqual(queue.failedCount, 0)
        XCTAssertEqual(sender.sends, [first.id], "no point in trying the others with the same token")

        // after signing in again
        report = await queue.flush()
        XCTAssertEqual(report.sent.map(\.job.id), [first.id, second.id])
        XCTAssertFalse(report.needsSignIn)
        XCTAssertFalse(queue.needsSignIn)
    }

    func testRejectedJobsMoveToFailedWithTheReason() async throws {
        let directory = makeTemporaryDirectory(self)
        let sender = ScriptedSender()
        let queue = MeetingQueue(directory: directory, sender: sender)
        let bad = try queue.enqueue(sampleTranscript(), target: target)
        let forbidden = try queue.enqueue(sampleTranscript(), target: .space("space-1"))
        let good = try queue.enqueue(sampleTranscript(), target: target)
        sender.then(.failure(http(400, "pageId must be a UUID")), .failure(http(403, "You cannot create pages in that space")))

        let report = await queue.flush()
        XCTAssertEqual(report.failed.map(\.id), [bad.id, forbidden.id])
        XCTAssertEqual(report.sent.map(\.job.id), [good.id], "a rejected job does not block the next one")
        XCTAssertEqual(queue.pendingCount, 0)
        XCTAssertEqual(queue.failedCount, 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("failed/\(bad.id).json").path))
        let failed = queue.failedJobs()
        XCTAssertEqual(failed.map(\.id), [bad.id, forbidden.id])
        XCTAssertEqual(failed[0].lastError, "The server answered 400: pageId must be a UUID")
        XCTAssertEqual(failed[1].lastError, "The server answered 403: You cannot create pages in that space")
        XCTAssertEqual(failed[0].transcript, sampleTranscript(), "the transcript is kept")

        // failed jobs are not sent again by themselves
        _ = await queue.flush()
        XCTAssertEqual(sender.sends.count, 3)
        // until someone asks
        XCTAssertEqual(try queue.retryFailed(id: bad.id), 1)
        XCTAssertEqual(queue.pendingCount, 1)
        XCTAssertEqual(queue.failedCount, 1)
        XCTAssertEqual(queue.pendingJobs().first?.attempts, 0)
        let again = await queue.flush()
        XCTAssertEqual(again.sent.map(\.job.id), [bad.id])
        try queue.remove(id: forbidden.id)
        XCTAssertEqual(queue.failedCount, 0)
        XCTAssertThrowsError(try queue.remove(id: "nope"))
        XCTAssertThrowsError(try queue.retryFailed(id: "nope"))
    }

    // MARK: - No double send

    func testConcurrentFlushesSendEachJobOnce() async throws {
        let sender = ScriptedSender()
        sender.delayNanoseconds = 30_000_000
        let queue = MeetingQueue(directory: makeTemporaryDirectory(self), sender: sender)
        var ids: [String] = []
        for _ in 0..<4 { ids.append(try queue.enqueue(sampleTranscript(), target: target).id) }

        let reports = await withTaskGroup(of: FlushReport.self) { group -> [FlushReport] in
            for _ in 0..<8 { group.addTask { await queue.flush() } }
            var all: [FlushReport] = []
            for await report in group { all.append(report) }
            return all
        }
        XCTAssertEqual(sender.sends.sorted(), ids.sorted(), "each job exactly once")
        XCTAssertEqual(sender.peak, 1, "never two sends at the same moment")
        XCTAssertEqual(queue.pendingCount, 0)
        XCTAssertTrue(reports.allSatisfy { !$0.busy })
        XCTAssertTrue(reports.contains { $0.sent.count == 4 })
    }

    func testAJobStoredDuringAFlushIsSentByTheFlushThatFollowsIt() async throws {
        let sender = ScriptedSender()
        sender.delayNanoseconds = 80_000_000
        let queue = MeetingQueue(directory: makeTemporaryDirectory(self), sender: sender)
        let first = try queue.enqueue(sampleTranscript(), target: target)
        let running = Task { await queue.flush() }
        try await Task.sleep(nanoseconds: 20_000_000) // the first send is on its way
        let second = try queue.enqueue(sampleTranscript(), target: target)
        _ = await queue.flush()
        _ = await running.value
        XCTAssertEqual(sender.sends, [first.id, second.id])
        XCTAssertEqual(queue.pendingCount, 0)
    }

    func testASecondQueueOnTheSameDirectoryIsKeptOut() async throws {
        // stands for a second process: the lock is on a file
        let directory = makeTemporaryDirectory(self)
        let slow = ScriptedSender()
        slow.delayNanoseconds = 150_000_000
        let first = MeetingQueue(directory: directory, sender: slow)
        let job = try first.enqueue(sampleTranscript(), target: target)
        let other = ScriptedSender()
        let second = MeetingQueue(directory: directory, sender: other)

        let running = Task { await first.flush() }
        try await Task.sleep(nanoseconds: 40_000_000)
        let report = await second.flush()
        XCTAssertTrue(report.busy)
        XCTAssertEqual(report.sent.count, 0)
        XCTAssertEqual(other.sends, [])
        let done = await running.value
        XCTAssertEqual(done.sent.map(\.job.id), [job.id])
        // once the first is done the second may flush
        let later = await second.flush()
        XCTAssertFalse(later.busy)
        XCTAssertEqual(slow.sends, [job.id])
    }

    // MARK: - Callbacks and odd files

    func testOnChangeFollowsTheCounts() async throws {
        let sender = ScriptedSender()
        let queue = MeetingQueue(directory: makeTemporaryDirectory(self), sender: sender)
        let seen = Box<String>()
        queue.onChange = { seen.add("\(queue.pendingCount)/\(queue.failedCount)/\(queue.needsSignIn)") }
        _ = try queue.enqueue(sampleTranscript(), target: target)
        XCTAssertEqual(seen.values, ["1/0/false"])
        sender.then(.failure(http(401)))
        _ = await queue.flush()
        XCTAssertEqual(seen.values.last, "1/0/true")
        sender.then(.failure(http(422, "bad")))
        _ = await queue.flush()
        XCTAssertEqual(seen.values.last, "0/1/true")
        queue.clearNeedsSignIn()
        XCTAssertEqual(seen.values.last, "0/1/false")
    }

    func testAnUnreadableFileIsMovedAside() async throws {
        let directory = makeTemporaryDirectory(self)
        let sender = ScriptedSender()
        let queue = MeetingQueue(directory: directory, sender: sender)
        try Data("{ not json".utf8).write(to: directory.appendingPathComponent("broken.json"))
        let good = try queue.enqueue(sampleTranscript(), target: target)
        XCTAssertEqual(queue.pendingCount, 2)
        let report = await queue.flush()
        XCTAssertEqual(report.sent.map(\.job.id), [good.id])
        XCTAssertEqual(queue.pendingCount, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("failed/broken.json").path))
    }

    func testAJobRemovedWhileItIsSentDoesNotComeBack() async throws {
        let sender = ScriptedSender()
        sender.delayNanoseconds = 80_000_000
        sender.then(.failure(http(500)))
        let queue = MeetingQueue(directory: makeTemporaryDirectory(self), sender: sender)
        let job = try queue.enqueue(sampleTranscript(), target: target)
        let running = Task { await queue.flush() }
        try await Task.sleep(nanoseconds: 20_000_000)
        try queue.remove(id: job.id)
        _ = await running.value
        XCTAssertEqual(queue.pendingCount, 0)
        XCTAssertEqual(queue.failedCount, 0)
    }
}
