import XCTest
@testable import MeetingKit

/// Jobs the version before speakers left in the queue directory must still
/// be read and sent; jobs of this version carry the new fields.
final class MeetingJobCodingTests: XCTestCase {
    /// A job file exactly as the version before speakers wrote it.
    private let oldJobFile = #"""
    {
      "attempts" : 1,
      "createdAt" : "2026-11-20T15:04:05.123Z",
      "id" : "0b0e7c0a-2f6f-4d0e-9a53-6f3f0c0a1b2c",
      "lastAttemptAt" : "2026-11-20T15:04:09.500Z",
      "lastError" : "Could not connect to the server.",
      "target" : {
        "pageId" : "0195e5a4-0000-7000-8000-000000000001",
        "title" : "Weekly sync"
      },
      "transcript" : {
        "durationSeconds" : 16.6,
        "language" : "en",
        "segments" : [
          {
            "end" : 2.5,
            "start" : 0,
            "text" : "Welcome everyone to the weekly sync."
          },
          {
            "end" : 5.4,
            "start" : 2.5,
            "text" : "First, the deploy of the new homepage is done and live."
          }
        ],
        "text" : "Welcome everyone to the weekly sync. First, the deploy of the new homepage is done and live."
      },
      "userInfo" : {
        "recording" : "\/tmp\/meeting.wav"
      }
    }
    """#

    func testAJobOfTheOldVersionDecodes() throws {
        let job = try JobCoding.decoder().decode(MeetingJob.self, from: Data(oldJobFile.utf8))
        XCTAssertEqual(job.id, "0b0e7c0a-2f6f-4d0e-9a53-6f3f0c0a1b2c")
        XCTAssertEqual(job.attempts, 1)
        XCTAssertEqual(job.lastError, "Could not connect to the server.")
        XCTAssertEqual(job.userInfo, ["recording": "/tmp/meeting.wav"])
        XCTAssertNil(job.meetingId)
        XCTAssertNil(job.transcript.mode)
        XCTAssertEqual(job.transcript.speakers, [])
        XCTAssertEqual(job.transcript.segments.count, 2)
        XCTAssertTrue(job.transcript.segments.allSatisfy { $0.speaker == nil && $0.side == nil })

        // written back, it is the same file: no new keys appear in an old job
        let again = String(decoding: try JobCoding.encoder().encode(job), as: UTF8.self)
        XCTAssertEqual(again, oldJobFile)

        // and it is sent with the body the old version sent
        let payload = try JSONEncoder().encode(DocmoreMeetingSender.payload(for: job))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["pageId", "title", "transcript", "language", "durationSeconds", "segments"])
        let segments = try XCTUnwrap(body["segments"] as? [[String: Any]])
        XCTAssertTrue(segments.allSatisfy { Set($0.keys) == ["start", "end", "text"] })
    }

    func testAJobLeftInTheQueueByTheOldVersionIsSent() async throws {
        let directory = makeTemporaryDirectory(self)
        try Data(oldJobFile.utf8).write(to: directory.appendingPathComponent("0b0e7c0a-2f6f-4d0e-9a53-6f3f0c0a1b2c.json"))
        let sent = Box<MeetingJob>()
        let queue = MeetingQueue(directory: directory, sender: ClosureMeetingSender { job in
            sent.add(job)
            return MeetingReceipt(id: "m-1", status: "queued", pageId: job.target.pageId)
        })
        XCTAssertEqual(queue.pendingCount, 1)
        let report = await queue.flush()
        XCTAssertEqual(report.sent.map(\.job.id), ["0b0e7c0a-2f6f-4d0e-9a53-6f3f0c0a1b2c"])
        XCTAssertEqual(report.pending, 0)
        XCTAssertEqual(sent.values.first?.transcript.text, "Welcome everyone to the weekly sync. First, the deploy of the new homepage is done and live.")
        XCTAssertNil(sent.values.first?.meetingId)
    }

    func testAJobWithSpeakersAndItsLiveMeetingSurvivesTheQueue() async throws {
        let directory = makeTemporaryDirectory(self)
        let transcript = MeetingTranscript(
            segments: [
                .init(start: 1, end: 5, text: "Entregamos el viernes.", speaker: "s1", side: .room),
                .init(start: 6, end: 9, text: "Mejor el lunes.", speaker: "s2", side: .remote),
            ],
            language: "es",
            durationSeconds: 10,
            mode: .virtual,
            speakers: [MeetingSpeaker(id: "s1", number: 1, side: .room, name: "Ana"), MeetingSpeaker(id: "s2", number: 2, side: .remote)]
        )
        let sent = Box<MeetingJob>()
        let queue = MeetingQueue(directory: directory, sender: ClosureMeetingSender { job in
            sent.add(job)
            return MeetingReceipt(id: "m-2", status: "queued")
        })
        let meetingId = "0195e5a4-1111-7000-8000-00000000abcd"
        let job = try queue.enqueue(transcript, target: .space("0195e5a4-0000-7000-8000-000000000002"), meetingId: meetingId)
        XCTAssertEqual(job.meetingId, meetingId)

        // on disk, and back through another queue object
        let file = directory.appendingPathComponent("\(job.id).json")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertEqual(json["meetingId"] as? String, meetingId)
        let stored = try XCTUnwrap(json["transcript"] as? [String: Any])
        XCTAssertEqual(stored["mode"] as? String, "virtual")
        XCTAssertEqual((stored["speakers"] as? [[String: Any]])?.count, 2)
        let reopened = MeetingQueue(directory: directory, sender: ClosureMeetingSender { _ in throw MeetingSendError.needsSignIn })
        XCTAssertEqual(reopened.pendingJobs(), [job])

        _ = await queue.flush()
        XCTAssertEqual(sent.values, [job])
        XCTAssertEqual(sent.values.first?.transcript, transcript)

        // a job that finishes no live meeting has no such key
        let plain = try queue.enqueue(transcript, target: .space("0195e5a4-0000-7000-8000-000000000002"), meetingId: "")
        XCTAssertNil(plain.meetingId)
        let plainJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("\(plain.id).json"))) as? [String: Any])
        XCTAssertNil(plainJSON["meetingId"])
    }
}
