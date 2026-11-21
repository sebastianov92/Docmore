import XCTest
@testable import MeetingKit

/// Answers requests inside the process: no socket is opened.
private final class StubProtocol: URLProtocol {
    struct Recorded {
        var url: URL
        var method: String
        var headers: [String: String]
        var body: Data
    }

    nonisolated(unsafe) static var handler: ((Recorded) -> (Int, Data))?
    nonisolated(unsafe) static var requests: [Recorded] = []
    static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                guard read > 0 else { break }
                body.append(buffer, count: read)
            }
            stream.close()
        }
        let recorded = Recorded(url: request.url!, method: request.httpMethod ?? "", headers: request.allHTTPHeaderFields ?? [:], body: body)
        let answer: (Int, Data) = Self.lock.withLock {
            Self.requests.append(recorded)
            return Self.handler?(recorded) ?? (500, Data())
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.0, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.1)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class DocmoreMeetingSenderTests: XCTestCase {
    private let pageId = "0195e5a4-0000-7000-8000-000000000001"
    private let accepted = Data(#"{"data":{"id":"m-1","status":"queued","fileName":"Weekly","pageId":"0195e5a4-0000-7000-8000-000000000001","spaceId":"s-1","language":"en","durationSeconds":3,"summary":null,"error":null,"createdAt":"2026-11-21T10:00:00.000Z","updatedAt":"2026-11-21T10:00:00.000Z"},"success":true,"status":200}"#.utf8)

    override func setUp() {
        super.setUp()
        StubProtocol.lock.withLock {
            StubProtocol.requests = []
            StubProtocol.handler = nil
        }
    }

    private func sender(token: @escaping @Sendable () async throws -> String = { "tok-123" }) -> DocmoreMeetingSender {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return DocmoreMeetingSender(baseURL: URL(string: "http://docs.test:3100/")!, session: URLSession(configuration: configuration), authorization: token)
    }

    private func respond(_ status: Int, _ body: Data) {
        StubProtocol.lock.withLock { StubProtocol.handler = { _ in (status, body) } }
    }

    private var requests: [StubProtocol.Recorded] { StubProtocol.lock.withLock { StubProtocol.requests } }

    func testSendsTheTranscriptTheWayTheServerReadsIt() async throws {
        respond(200, accepted)
        let job = MeetingJob(target: .page(pageId, title: "Weekly"), transcript: sampleTranscript())
        let receipt = try await sender().send(job)
        XCTAssertEqual(receipt, MeetingReceipt(id: "m-1", status: "queued", pageId: pageId, spaceId: "s-1", error: nil))
        XCTAssertFalse(receipt.isFinished)

        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, "http://docs.test:3100/api/ai/meetings/from-transcript")
        XCTAssertEqual(request.headers["Authorization"], "Bearer tok-123")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(request.headers["Idempotency-Key"], job.id)

        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["pageId", "title", "transcript", "language", "durationSeconds", "segments"],
                       "exactly the fields of FromTranscriptDto that have a value; no spaceId, no nulls")
        XCTAssertEqual(body["pageId"] as? String, pageId)
        XCTAssertEqual(body["title"] as? String, "Weekly")
        XCTAssertEqual(body["transcript"] as? String, "Hello there. General Kenobi.")
        XCTAssertEqual(body["language"] as? String, "en")
        XCTAssertEqual(body["durationSeconds"] as? Double, 3)
        let segments = try XCTUnwrap(body["segments"] as? [[String: Any]])
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(Set(segments[1].keys), ["start", "end", "text"])
        XCTAssertEqual(segments[1]["start"] as? Double, 1.5)
        XCTAssertEqual(segments[1]["end"] as? Double, 3)
        XCTAssertEqual(segments[1]["text"] as? String, "General Kenobi.")
    }

    func testEveryAttemptOfAJobCarriesTheSameIdempotencyKey() async throws {
        // the server keeps the answer per key: a job sent again after a lost
        // answer gets the same meeting back instead of a second one
        respond(200, accepted)
        let sender = sender()
        let job = MeetingJob(target: .page(pageId), transcript: sampleTranscript())
        var retried = job
        retried.attempts = 3
        retried.lastError = "The request timed out."
        _ = try await sender.send(job)
        _ = try await sender.send(retried)
        let other = MeetingJob(target: .page(pageId), transcript: sampleTranscript())
        _ = try await sender.send(other)
        let keys = requests.map { $0.headers["Idempotency-Key"] }
        XCTAssertEqual(keys, [job.id, job.id, other.id])
        XCTAssertNotEqual(job.id, other.id)
        // the ids the queue makes fit the server's rule: at most 100 of [A-Za-z0-9_.:-]
        XCTAssertNotNil(job.id.range(of: "^[A-Za-z0-9_.:-]{1,100}$", options: .regularExpression))
    }

    func testAnIdTheServerWouldRefuseAsAKeyGoesWithoutOne() async throws {
        // an invalid key is a 400, which would fail a good job
        respond(200, accepted)
        for id in ["has space", "slash/inside", String(repeating: "a", count: 101), "", "acento-\u{E9}"] {
            let job = MeetingJob(id: id, target: .page(pageId), transcript: sampleTranscript())
            XCTAssertNil(DocmoreMeetingSender.idempotencyKey(for: job), id)
            _ = try await sender().send(job)
        }
        XCTAssertTrue(requests.allSatisfy { $0.headers["Idempotency-Key"] == nil })
        XCTAssertEqual(requests.count, 5, "the job is still sent")
        let fine = MeetingJob(id: "job_1.a:b-2", target: .page(pageId), transcript: sampleTranscript())
        XCTAssertEqual(DocmoreMeetingSender.idempotencyKey(for: fine), "job_1.a:b-2")
    }

    func testSpaceTargetAndMissingOptionals() async throws {
        respond(200, accepted)
        let bare = MeetingTranscript(text: "Just text.", language: nil, durationSeconds: 0, segments: [])
        _ = try await sender().send(MeetingJob(target: .space("s-1"), transcript: bare))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(requests.first).body) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["spaceId", "transcript"])
        XCTAssertEqual(body["spaceId"] as? String, "s-1")
    }

    func testHTTPErrorsCarryTheStatusAndTheServersWords() async {
        let job = MeetingJob(target: .page(pageId), transcript: sampleTranscript())
        let cases: [(Int, String, String)] = [
            (401, #"{"message":"Unauthorized","statusCode":401}"#, "Unauthorized"),
            (403, #"{"message":"You cannot create pages in that space","error":"Forbidden","statusCode":403}"#, "You cannot create pages in that space"),
            (400, #"{"message":["pageId must be a UUID","transcript must be a string"],"error":"Bad Request","statusCode":400}"#, "pageId must be a UUID; transcript must be a string"),
            (404, #"{"message":"Page not found","statusCode":404}"#, "Page not found"),
            (429, #"{"message":"Daily AI limit reached (5 requests). Try again tomorrow.","reason":"ai_limit_reached"}"#, "Daily AI limit reached (5 requests). Try again tomorrow."),
            (502, "<html>bad gateway</html>", ""),
        ]
        for (status, body, message) in cases {
            respond(status, Data(body.utf8))
            do {
                _ = try await sender().send(job)
                XCTFail("\(status) should throw")
            } catch {
                XCTAssertEqual(error as? MeetingSendError, .http(status: status, message: message))
            }
        }
    }

    func testAnUnreachableServerIsANetworkError() async {
        // a real connection attempt to a port nobody listens on
        let sender = DocmoreMeetingSender(baseURL: URL(string: "http://127.0.0.1:9")!) { "tok" }
        do {
            _ = try await sender.send(MeetingJob(target: .page(pageId), transcript: sampleTranscript()))
            XCTFail("should throw")
        } catch {
            XCTAssertTrue(error is URLError, "got \(error)")
            guard case .keep(_, let stopPass) = MeetingQueue.disposition(for: error) else { return XCTFail("should keep the job") }
            XCTAssertTrue(stopPass)
        }
    }

    func testTheTokenComesFromTheClosureEachTime() async throws {
        respond(200, accepted)
        let counter = Box<Int>()
        let sender = sender {
            counter.add(1)
            return "Bearer fresh-\(counter.count)"
        }
        let job = MeetingJob(target: .page(pageId), transcript: sampleTranscript())
        _ = try await sender.send(job)
        _ = try await sender.send(job)
        XCTAssertEqual(requests.map { $0.headers["Authorization"] }, ["Bearer fresh-1", "Bearer fresh-2"], "asked every time; the prefix is not doubled")
    }

    func testNoTokenMeansSignIn() async {
        let job = MeetingJob(target: .page(pageId), transcript: sampleTranscript())
        for provider in [{ "" }, { "   " }, { throw MeetingSendError.needsSignIn }] as [@Sendable () async throws -> String] {
            do {
                _ = try await sender(token: provider).send(job)
                XCTFail("should throw")
            } catch {
                XCTAssertEqual(error as? MeetingSendError, .needsSignIn)
            }
        }
        XCTAssertEqual(requests.count, 0, "nothing goes out without a token")
    }

    func testAnAcceptedJobIsNotResentBecauseTheAnswerIsOdd() async throws {
        respond(200, Data("OK".utf8))
        let receipt = try await sender().send(MeetingJob(target: .page(pageId), transcript: sampleTranscript()))
        XCTAssertEqual(receipt.id, "")
        XCTAssertEqual(receipt.status, "queued")
        XCTAssertEqual(receipt.pageId, pageId)
    }

    func testStatus() async throws {
        respond(200, Data(#"{"data":{"id":"m-1","status":"done","pageId":"p-9","spaceId":"s-1","summary":"Short.","error":null},"success":true,"status":200}"#.utf8))
        let receipt = try await sender().status(meetingId: "m-1")
        XCTAssertEqual(receipt, MeetingReceipt(id: "m-1", status: "done", pageId: "p-9", spaceId: "s-1", error: nil))
        XCTAssertTrue(receipt.isFinished)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.url.path, "/api/ai/meetings/status")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: request.body) as? [String: String], ["meetingId": "m-1"])
        XCTAssertNil(request.headers["Idempotency-Key"])

        respond(200, Data(#"{"data":{"id":"m-2","status":"failed","pageId":null,"error":"The page is gone"}}"#.utf8))
        let failed = try await sender().status(meetingId: "m-2")
        XCTAssertEqual(failed.error, "The page is gone")
        XCTAssertNil(failed.pageId)
        XCTAssertTrue(failed.isFinished)
    }

    func testPayloadIsCutToTheServersLimits() {
        // a title too long, 50,000 short segments
        let segments = (0..<50_000).map { MeetingTranscript.Segment(start: Double($0), end: Double($0) + 1, text: "w\($0)") }
        let transcript = MeetingTranscript(segments: segments, language: "en", durationSeconds: 50_000)
        let job = MeetingJob(target: MeetingTarget(pageId: pageId, spaceId: "s-1", title: String(repeating: "t", count: 500)), transcript: transcript)
        let payload = DocmoreMeetingSender.payload(for: job)
        XCTAssertEqual(payload.title?.count, 200)
        XCTAssertEqual(payload.pageId, pageId)
        XCTAssertNil(payload.spaceId, "the page wins, as on the server")
        let sent = payload.segments ?? []
        XCTAssertLessThanOrEqual(sent.count, 20_000)
        XCTAssertEqual(sent.count, 12_500)
        XCTAssertEqual(sent.first?.start, 0)
        XCTAssertEqual(sent.first?.end, 4)
        XCTAssertEqual(sent.first?.text, "w0 w1 w2 w3")
        XCTAssertEqual(sent.last?.end, 50_000)
        XCTAssertEqual(payload.transcript, transcript.text, "the text itself is whole")

        let long = MeetingTranscript(text: String(repeating: "a", count: 2_000_100), language: "en", durationSeconds: 1, segments: [])
        XCTAssertEqual(DocmoreMeetingSender.payload(for: MeetingJob(target: .page(pageId), transcript: long)).transcript.count, 2_000_000)
    }

    func testAJobWithoutATargetNeverLeaves() async {
        do {
            _ = try await sender().send(MeetingJob(target: MeetingTarget(title: "x"), transcript: sampleTranscript()))
            XCTFail("should throw")
        } catch {
            guard case MeetingSendError.invalid = error else { return XCTFail("got \(error)") }
        }
        XCTAssertEqual(requests.count, 0)
    }

    // MARK: - Meetings with speakers

    private let meetingId = "0195e5a4-1111-7000-8000-00000000abcd"

    private func virtualTranscript() -> MeetingTranscript {
        MeetingTranscript(
            segments: [
                .init(start: 1, end: 5.2, text: "Buenos días a todos.", speaker: "s1", side: .room),
                .init(start: 5.9, end: 13.1, text: "Buenos días.", speaker: "s2", side: .remote),
                .init(start: 13.7, end: 18.5, text: "Perfecto.", speaker: nil, side: .room),
            ],
            language: "es",
            durationSeconds: 20,
            mode: .virtual,
            speakers: [
                MeetingSpeaker(id: "s1", number: 1, side: .room, name: "Ana"),
                MeetingSpeaker(id: "s2", number: 2, side: .remote, name: nil),
            ]
        )
    }

    func testAPlainTranscriptStillPostsExactlyTheOldBody() throws {
        // byte for byte what the version before speakers sent for this job
        let job = MeetingJob(id: "job-1", target: .page(pageId, title: "Weekly"), transcript: sampleTranscript())
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let body = String(decoding: try encoder.encode(DocmoreMeetingSender.payload(for: job)), as: UTF8.self)
        XCTAssertEqual(body, #"{"durationSeconds":3,"language":"en","pageId":"0195e5a4-0000-7000-8000-000000000001","segments":[{"end":1.5,"start":0,"text":"Hello there."},{"end":3,"start":1.5,"text":"General Kenobi."}],"title":"Weekly","transcript":"Hello there. General Kenobi."}"#)
        // also when the job carries empty new fields
        var empty = job
        empty.meetingId = ""
        empty.transcript.speakers = []
        empty.transcript.mode = nil
        XCTAssertEqual(String(decoding: try encoder.encode(DocmoreMeetingSender.payload(for: empty)), as: UTF8.self), body)
    }

    func testSendsModeSpeakersSidesAndTheLiveMeetingTheWayTheContractSays() async throws {
        respond(200, accepted)
        let job = MeetingJob(target: .page(pageId, title: "Seguimiento"), transcript: virtualTranscript(), meetingId: meetingId)
        _ = try await sender().send(job)

        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(requests.first).body) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["pageId", "title", "transcript", "language", "durationSeconds", "segments", "meetingId", "mode", "speakers"])
        XCTAssertEqual(body["meetingId"] as? String, meetingId)
        XCTAssertEqual(body["mode"] as? String, "virtual")
        XCTAssertEqual(body["transcript"] as? String, "Buenos días a todos. Buenos días. Perfecto.", "the segments' text joined, as before")

        let speakers = try XCTUnwrap(body["speakers"] as? [[String: Any]])
        XCTAssertEqual(speakers.count, 2)
        XCTAssertEqual(Set(speakers[0].keys), ["id", "number", "side", "name"])
        XCTAssertEqual(speakers[0]["id"] as? String, "s1")
        XCTAssertEqual(speakers[0]["number"] as? Int, 1)
        XCTAssertEqual(speakers[0]["side"] as? String, "room")
        XCTAssertEqual(speakers[0]["name"] as? String, "Ana")
        XCTAssertEqual(Set(speakers[1].keys), ["id", "number", "side", "name"], "side and name are always there")
        XCTAssertEqual(speakers[1]["side"] as? String, "remote")
        XCTAssertTrue(speakers[1]["name"] is NSNull, "no name is null, not a missing key")

        let segments = try XCTUnwrap(body["segments"] as? [[String: Any]])
        XCTAssertEqual(Set(segments[0].keys), ["start", "end", "text", "speaker", "side"])
        XCTAssertEqual(segments[0]["speaker"] as? String, "s1")
        XCTAssertEqual(segments[0]["side"] as? String, "room")
        XCTAssertEqual(segments[1]["speaker"] as? String, "s2")
        XCTAssertEqual(segments[1]["side"] as? String, "remote")
        XCTAssertEqual(Set(segments[2].keys), ["start", "end", "text", "side"], "no speaker: the key is left out")
        XCTAssertEqual(segments[2]["side"] as? String, "room")
    }

    func testAnInPersonMeetingHasNoSides() throws {
        var transcript = virtualTranscript()
        transcript.mode = .inPerson
        let payload = DocmoreMeetingSender.payload(for: MeetingJob(target: .page(pageId), transcript: transcript))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any])
        XCTAssertEqual(body["mode"] as? String, "in_person")
        XCTAssertNil(body["meetingId"], "not followed live: no meetingId")
        let speakers = try XCTUnwrap(body["speakers"] as? [[String: Any]])
        XCTAssertTrue(speakers.allSatisfy { $0["side"] is NSNull })
        let segments = try XCTUnwrap(body["segments"] as? [[String: Any]])
        XCTAssertTrue(segments.allSatisfy { $0["side"] == nil })
        XCTAssertEqual(segments[0]["speaker"] as? String, "s1")
    }

    func testOnlyWhatTheServerAcceptsIsSent() {
        var transcript = virtualTranscript()
        transcript.speakers = [
            MeetingSpeaker(id: "s1", number: 1, side: .room, name: String(repeating: "x", count: 120)),
            MeetingSpeaker(id: "Not Valid!", number: 2, side: .remote),      // not [a-z0-9_-]
            MeetingSpeaker(id: "s1", number: 3, side: .room),                // the same id twice
            MeetingSpeaker(id: "s4", number: 0, side: .room),                // numbers start at 1
            MeetingSpeaker(id: "s5", number: 5, side: .remote, name: "   "),
        ]
        transcript.segments = [
            .init(start: 0, end: 1, text: "a", speaker: "s1", side: .room),
            .init(start: 1, end: 2, text: "b", speaker: "Not Valid!", side: .remote),
            .init(start: 2, end: 3, text: "c", speaker: "s9", side: .remote),    // nobody by that id
        ]
        // a meeting id that is not a UUID would get the whole job refused
        let payload = DocmoreMeetingSender.payload(for: MeetingJob(target: .page(pageId), transcript: transcript, meetingId: "meeting 7"))
        XCTAssertNil(payload.meetingId)
        XCTAssertEqual(payload.speakers?.map(\.id), ["s1", "s5"])
        XCTAssertEqual(payload.speakers?[0].name?.count, 80, "names are cut to the server's 80 characters")
        XCTAssertNil(payload.speakers?[1].name, "a blank name is no name")
        XCTAssertEqual(payload.segments?.map(\.speaker), ["s1", nil, nil], "a segment never points at a speaker that is not sent")
        XCTAssertEqual(payload.segments?.map(\.side), [.room, .remote, .remote])
        XCTAssertTrue(DocmoreMeetingSender.isUUID("0195E5A4-1111-7000-8000-00000000ABCD"))
        XCTAssertFalse(DocmoreMeetingSender.isUUID("0195e5a4-1111-7000-8000"))
    }

    func testJoiningTooManySegmentsKeepsTheSpeakerOnlyWhenBothHaveIt() {
        var transcript = virtualTranscript()
        // 20,002 segments: s1, s1, s2, s2, s1, s1, ... so pairs share a speaker; the last pair does not
        var segments: [MeetingTranscript.Segment] = []
        for index in 0..<20_000 {
            let first = (index / 2) % 2 == 0
            let start = Double(index)
            segments.append(MeetingTranscript.Segment(
                start: start, end: start + 1, text: "w\(index)", speaker: first ? "s1" : "s2", side: first ? MeetingSide.room : MeetingSide.remote
            ))
        }
        segments.append(.init(start: 20_000, end: 20_001, text: "x", speaker: "s1", side: .room))
        segments.append(.init(start: 20_001, end: 20_002, text: "y", speaker: "s2", side: .remote))
        transcript.segments = segments
        let payload = DocmoreMeetingSender.payload(for: MeetingJob(target: .page(pageId), transcript: transcript))
        let joined = payload.segments ?? []
        XCTAssertEqual(joined.count, 10_001)
        XCTAssertEqual(joined[0], .init(start: 0, end: 2, text: "w0 w1", speaker: "s1", side: .room))
        XCTAssertEqual(joined[1], .init(start: 2, end: 4, text: "w2 w3", speaker: "s2", side: .remote))
        XCTAssertEqual(joined[10_000], .init(start: 20_000, end: 20_002, text: "x y", speaker: nil, side: nil), "two voices in one segment: no speaker")
    }
}
