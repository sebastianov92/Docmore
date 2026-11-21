import Foundation

/// Sends transcripts to a Docmore server.
///
///     POST <base>/api/ai/meetings/from-transcript
///     Authorization: Bearer <token>
///     { pageId?, spaceId?, title?, transcript, language?, durationSeconds?,
///       segments?: [{ start, end, text }] }
///
/// The token comes from the `authorization` closure each time, so the app
/// can hand out a fresh one. When the closure throws
/// `MeetingSendError.needsSignIn` the queue reports "needs sign-in"; any
/// other error it throws is treated like a network failure (the job stays).
///
/// The request carries `Idempotency-Key: <job id>`. The server keeps the first
/// answer for that key, so a repeated send of the same job writes the notes once.
/// (The server keeps a key for 14 days, per signed-in person.)
public struct DocmoreMeetingSender: MeetingSender {
    public let baseURL: URL
    private let session: URLSession
    private let authorization: @Sendable () async throws -> String

    /// Limits of the server's validation (FromTranscriptDto).
    static let maxTitle = 200
    static let maxTranscript = 2_000_000
    static let maxSegments = 20_000
    static let maxSegmentText = 4_000
    static let maxLanguage = 20

    /// - Parameters:
    ///   - baseURL: the server's address ("https://docs.example.com"), with
    ///     or without a trailing slash, without "/api".
    ///   - session: the default has a 60 s request timeout.
    ///   - authorization: returns the access token (with or without the
    ///     "Bearer " prefix).
    public init(baseURL: URL, session: URLSession? = nil, authorization: @escaping @Sendable () async throws -> String) {
        self.baseURL = baseURL
        self.authorization = authorization
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 60
            configuration.waitsForConnectivity = false
            self.session = URLSession(configuration: configuration)
        }
    }

    public func send(_ job: MeetingJob) async throws -> MeetingReceipt {
        guard job.target.isValid else {
            throw MeetingSendError.invalid("The meeting has neither a page nor a space.")
        }
        let body = try JSONEncoder().encode(Self.payload(for: job))
        let data = try await post("api/ai/meetings/from-transcript", body: body, idempotencyKey: Self.idempotencyKey(for: job))
        // The server took it. An answer that cannot be read must not make the job go out again.
        return Self.receipt(from: data) ?? MeetingReceipt(id: "", status: "queued", pageId: job.target.pageId, spaceId: job.target.spaceId)
    }

    /// Where the notes are: "queued" -> "summarizing" -> "done" or "failed".
    /// `pageId` is the page that got them.
    public func status(meetingId: String) async throws -> MeetingReceipt {
        let body = try JSONEncoder().encode(["meetingId": meetingId])
        let data = try await post("api/ai/meetings/status", body: body, idempotencyKey: nil)
        guard let receipt = Self.receipt(from: data) else {
            throw MeetingSendError.http(status: 200, message: "unreadable answer")
        }
        return receipt
    }

    // MARK: - Wire format

    struct Payload: Encodable, Equatable {
        var pageId: String?
        var spaceId: String?
        var title: String?
        var transcript: String
        var language: String?
        var durationSeconds: Double?
        var segments: [MeetingTranscript.Segment]?
    }

    /// The request body for a job, cut to what the server's validation takes.
    static func payload(for job: MeetingJob) -> Payload {
        let transcript = job.transcript
        let title = job.target.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        var segments = transcript.segments.map {
            MeetingTranscript.Segment(start: $0.start, end: $0.end, text: String($0.text.prefix(maxSegmentText)))
        }
        // Too many segments: join neighbours until they fit.
        while segments.count > maxSegments {
            var joined: [MeetingTranscript.Segment] = []
            joined.reserveCapacity(segments.count / 2 + 1)
            var index = 0
            while index < segments.count {
                if index + 1 < segments.count {
                    let text = segments[index].text + " " + segments[index + 1].text
                    joined.append(.init(start: segments[index].start, end: segments[index + 1].end, text: String(text.prefix(maxSegmentText))))
                } else {
                    joined.append(segments[index])
                }
                index += 2
            }
            segments = joined
        }
        // the page wins when both are set, as on the server
        let pageId = (job.target.pageId ?? "").isEmpty ? nil : job.target.pageId
        let spaceId = pageId == nil ? job.target.spaceId : nil
        return Payload(
            pageId: pageId,
            spaceId: spaceId,
            title: (title ?? "").isEmpty ? nil : String(title!.prefix(maxTitle)),
            transcript: String(transcript.text.prefix(maxTranscript)),
            language: transcript.language.map { String($0.prefix(maxLanguage)) },
            durationSeconds: transcript.durationSeconds > 0 ? transcript.durationSeconds : nil,
            segments: segments.isEmpty ? nil : segments
        )
    }

    /// The job id, when the server accepts it as a key (up to 100 characters
    /// of letters, digits and "_.:-"; the ids the queue makes are UUIDs).
    /// Any other id goes without a key: an invalid key is answered with 400,
    /// which would fail a job that is otherwise fine.
    static func idempotencyKey(for job: MeetingJob) -> String? {
        let id = job.id
        guard !id.isEmpty, id.count <= 100,
              id.range(of: "^[A-Za-z0-9_.:-]+$", options: .regularExpression) != nil else { return nil }
        return id
    }

    /// Reads `{ "data": { "id", "status", "pageId", ... } }` (or the bare object).
    static func receipt(from data: Data) -> MeetingReceipt? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let object = (json["data"] as? [String: Any]) ?? json
        guard let id = object["id"] as? String, let status = object["status"] as? String else { return nil }
        return MeetingReceipt(
            id: id,
            status: status,
            pageId: object["pageId"] as? String,
            spaceId: object["spaceId"] as? String,
            error: object["error"] as? String
        )
    }

    /// The server's own words from an error body, when it has some.
    static func message(from data: Data) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        if let message = json["message"] as? String { return message }
        if let messages = json["message"] as? [String] { return messages.joined(separator: "; ") }
        if let error = json["error"] as? String { return error }
        return ""
    }

    private func post(_ path: String, body: Data, idempotencyKey: String?) async throws -> Data {
        var token = try await authorization()
        if token.lowercased().hasPrefix("bearer ") { token = String(token.dropFirst(7)) }
        token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw MeetingSendError.needsSignIn }

        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw MeetingSendError.http(status: http.statusCode, message: Self.message(from: data))
        }
        return data
    }
}
