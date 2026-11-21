import Foundation

/// Sends transcripts to a Docmore server.
///
///     POST <base>/api/ai/meetings/from-transcript
///     Authorization: Bearer <token>
///     { pageId?, spaceId?, title?, transcript, language?, durationSeconds?,
///       segments?: [{ start, end, text, speaker?, side? }],
///       meetingId?, mode?, speakers?: [{ id, number, side, name }] }
///
/// The fields of meetings with speakers (`meetingId`, `mode`, `speakers`,
/// and `speaker`/`side` inside a segment) are sent only when the job has
/// something to put in them: a plain transcript posts the body it always
/// did. (A server that does not know them yet ignores them.)
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
    static let maxSpeakerName = 80

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
        // meetings with speakers: nil (left out of the JSON) unless there is something to say
        var meetingId: String?
        var mode: MeetingMode?
        var speakers: [MeetingSpeaker]?

    }

    /// The request body for a job, cut to what the server's validation takes.
    static func payload(for job: MeetingJob) -> Payload {
        let transcript = job.transcript
        let title = job.target.title?.trimmingCharacters(in: .whitespacesAndNewlines)

        // Speakers the server accepts: a valid id, once, a name of at most 80 characters.
        var speakers: [MeetingSpeaker] = []
        for speaker in transcript.speakers
        where MeetingSpeaker.isValidId(speaker.id) && speaker.number >= 1 && !speakers.contains(where: { $0.id == speaker.id }) {
            let name = speaker.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            speakers.append(MeetingSpeaker(
                id: speaker.id,
                number: speaker.number,
                // sides exist only in a virtual meeting
                side: transcript.mode == .virtual ? speaker.side : nil,
                name: name.isEmpty ? nil : String(name.prefix(maxSpeakerName))
            ))
        }
        let known = Set(speakers.map(\.id))

        var segments = transcript.segments.map {
            MeetingTranscript.Segment(
                start: $0.start,
                end: $0.end,
                text: String($0.text.prefix(maxSegmentText)),
                speaker: $0.speaker.flatMap { known.contains($0) ? $0 : nil },
                side: transcript.mode == .virtual ? $0.side : nil
            )
        }
        // Too many segments: join neighbours until they fit.
        while segments.count > maxSegments {
            var joined: [MeetingTranscript.Segment] = []
            joined.reserveCapacity(segments.count / 2 + 1)
            var index = 0
            while index < segments.count {
                if index + 1 < segments.count {
                    let first = segments[index]
                    let second = segments[index + 1]
                    let text = first.text + " " + second.text
                    joined.append(.init(
                        start: first.start,
                        end: second.end,
                        text: String(text.prefix(maxSegmentText)),
                        // two voices in one segment: it no longer has one speaker
                        speaker: first.speaker == second.speaker ? first.speaker : nil,
                        side: first.side == second.side ? first.side : nil
                    ))
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
            segments: segments.isEmpty ? nil : segments,
            meetingId: job.meetingId.flatMap { isUUID($0) ? $0 : nil },
            mode: transcript.mode,
            speakers: speakers.isEmpty ? nil : speakers
        )
    }

    /// The server takes `meetingId` only as a UUID; anything else would get
    /// a job that is otherwise fine refused.
    static func isUUID(_ text: String) -> Bool {
        text.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil
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
