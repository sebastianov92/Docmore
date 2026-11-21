import Foundation

/// Where the notes of a meeting go: onto an existing page, or into a new
/// page of a space. One of the two is required; with both, the page wins.
public struct MeetingTarget: Codable, Equatable, Sendable {
    /// The page's id (a UUID, not the slug in its address).
    public var pageId: String?
    /// The space's id (a UUID).
    public var spaceId: String?
    /// Label of the meeting, at most 200 characters on the server.
    public var title: String?

    public init(pageId: String? = nil, spaceId: String? = nil, title: String? = nil) {
        self.pageId = pageId
        self.spaceId = spaceId
        self.title = title
    }

    /// Append the notes to this page.
    public static func page(_ pageId: String, title: String? = nil) -> MeetingTarget {
        MeetingTarget(pageId: pageId, title: title)
    }

    /// Create a page for the notes in this space.
    public static func space(_ spaceId: String, title: String? = nil) -> MeetingTarget {
        MeetingTarget(spaceId: spaceId, title: title)
    }

    var isValid: Bool {
        !(pageId ?? "").isEmpty || !(spaceId ?? "").isEmpty
    }
}

/// A finished transcript waiting to reach the server. One JSON file each.
public struct MeetingJob: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var target: MeetingTarget
    public var transcript: MeetingTranscript
    public var createdAt: Date
    /// How many times it was sent without success.
    public var attempts: Int
    public var lastAttemptAt: Date?
    /// Why the last attempt did not go through, or why the job failed.
    public var lastError: String?
    /// Anything the app wants to find again later (the path of the
    /// recording, the account). MeetingKit does not read it.
    public var userInfo: [String: String]
    /// The id of the live meeting on the server (`live/start`) that this
    /// transcript finishes. Nil for a meeting that was not followed live.
    /// Jobs written by older versions have no such field and read as nil.
    public var meetingId: String?

    public init(
        id: String = UUID().uuidString.lowercased(),
        target: MeetingTarget,
        transcript: MeetingTranscript,
        createdAt: Date = Date(),
        attempts: Int = 0,
        lastAttemptAt: Date? = nil,
        lastError: String? = nil,
        userInfo: [String: String] = [:],
        meetingId: String? = nil
    ) {
        self.id = id
        self.target = target
        self.transcript = transcript
        self.createdAt = createdAt
        self.attempts = attempts
        self.lastAttemptAt = lastAttemptAt
        self.lastError = lastError
        self.userInfo = userInfo
        self.meetingId = meetingId
    }
}

/// What the server answered when it took a transcript.
public struct MeetingReceipt: Codable, Equatable, Sendable {
    /// The meeting's id on the server: what `status` polls.
    public var id: String
    /// "queued", "summarizing", "done" or "failed".
    public var status: String
    /// The page that has, or will have, the notes. Nil while a new page is
    /// still to be created.
    public var pageId: String?
    public var spaceId: String?
    /// The server's reason when `status` is "failed".
    public var error: String?

    public init(id: String, status: String, pageId: String? = nil, spaceId: String? = nil, error: String? = nil) {
        self.id = id
        self.status = status
        self.pageId = pageId
        self.spaceId = spaceId
        self.error = error
    }

    public var isFinished: Bool { status == "done" || status == "failed" }
}

/// How a sender reports that a job did not go through. Anything else a
/// sender throws counts as a network failure (the job is kept).
public enum MeetingSendError: Error, LocalizedError, Equatable, Sendable {
    /// The server answered with this HTTP status.
    case http(status: Int, message: String)
    /// There is no usable token: the person has to sign in again.
    case needsSignIn
    /// The job itself is wrong and will never be accepted.
    case invalid(String)

    public var errorDescription: String? {
        switch self {
        case .http(let status, let message):
            return message.isEmpty ? "The server answered \(status)." : "The server answered \(status): \(message)"
        case .needsSignIn:
            return "Sign in again to send the meeting."
        case .invalid(let detail):
            return detail
        }
    }
}

/// Sends one job. `DocmoreMeetingSender` is the real one.
public protocol MeetingSender: Sendable {
    func send(_ job: MeetingJob) async throws -> MeetingReceipt
}

/// A sender made of a closure, for tests and small tools.
public struct ClosureMeetingSender: MeetingSender {
    private let body: @Sendable (MeetingJob) async throws -> MeetingReceipt

    public init(_ body: @escaping @Sendable (MeetingJob) async throws -> MeetingReceipt) {
        self.body = body
    }

    public func send(_ job: MeetingJob) async throws -> MeetingReceipt {
        try await body(job)
    }
}
