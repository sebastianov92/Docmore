import Foundation

/// A note jotted in the quick capture panel, waiting to become a page.
public struct CaptureNote: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var profileId: String
    public var spaceId: String
    public var title: String
    /// Markdown body (may be empty).
    public var content: String
    public var createdAt: Date
    public var attempts: Int
    /// Set when the server refused the note for good (kept so it is not lost).
    public var failure: String?

    public init(
        id: String = UUID().uuidString.lowercased(),
        profileId: String,
        spaceId: String,
        title: String,
        content: String,
        createdAt: Date = Date(),
        attempts: Int = 0,
        failure: String? = nil
    ) {
        self.id = id
        self.profileId = profileId
        self.spaceId = spaceId
        self.title = title
        self.content = content
        self.createdAt = createdAt
        self.attempts = attempts
        self.failure = failure
    }

    /// The first line is the title, the rest is the body. A single line is
    /// only a title. Returns nil when there is nothing but white space.
    public static func split(_ text: String, maxTitleLength: Int = 120) -> (title: String, content: String)? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let lines = trimmed.components(separatedBy: .newlines)
        var title = lines[0].trimmingCharacters(in: .whitespaces)
        // a markdown heading on the first line reads better without its marks
        while title.hasPrefix("#") { title.removeFirst() }
        title = title.trimmingCharacters(in: .whitespaces)
        var body = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if title.count > maxTitleLength {
            // a long first line is a paragraph, not a title: keep all of it in the body
            let cut = title.index(title.startIndex, offsetBy: maxTitleLength)
            let head = String(title[..<cut])
            let shortened = head.lastIndex(of: " ").map { String(head[..<$0]) } ?? head
            body = trimmed
            title = shortened + "..."
        }
        if title.isEmpty { title = String(body.prefix(maxTitleLength)) }
        return (title, body)
    }

    /// The JSON body of `POST /api/pages/create`.
    public var requestBody: [String: Any] {
        var body: [String: Any] = ["spaceId": spaceId, "title": title]
        if !content.isEmpty {
            body["content"] = content
            body["format"] = "markdown"
        }
        return body
    }
}

public enum CaptureSendResult: Equatable, Sendable {
    /// The server made the page.
    case sent(pageId: String?)
    /// Nothing wrong with the note: the server did not answer (or the
    /// account has to sign in again). Try later.
    case retryLater
    /// The server refused this note and will refuse it again.
    case refused(String)
}

/// Quick notes on disk, one JSON file each, oldest first.
public final class CaptureQueue: @unchecked Sendable {
    public let directory: URL
    private let lock = NSLock()

    public init(directory: URL) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private func file(_ id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }

    public func enqueue(_ note: CaptureNote) throws {
        lock.lock(); defer { lock.unlock() }
        try AtomicFile.write(try CaptureQueue.encoder.encode(note), to: file(note.id))
    }

    public func update(_ note: CaptureNote) {
        try? enqueue(note)
    }

    public func remove(id: String) {
        lock.lock(); defer { lock.unlock() }
        try? FileManager.default.removeItem(at: file(id))
    }

    public func removeAll(profileId: String) {
        for note in all() where note.profileId == profileId {
            remove(id: note.id)
        }
    }

    /// Every note on disk, oldest first.
    public func all() -> [CaptureNote] {
        lock.lock(); defer { lock.unlock() }
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { try? CaptureQueue.decoder.decode(CaptureNote.self, from: Data(contentsOf: $0)) }
            .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    /// Notes still waiting to be sent (not refused for good).
    public func pending() -> [CaptureNote] {
        all().filter { $0.failure == nil }
    }

    /// Sends what is waiting, in order. Stops at the first note the server
    /// could not be reached for, so notes never overtake each other.
    @discardableResult
    public func flush(send: (CaptureNote) async -> CaptureSendResult) async -> (sent: Int, left: Int) {
        var sent = 0
        for var note in pending() {
            switch await send(note) {
            case .sent:
                remove(id: note.id)
                sent += 1
            case .retryLater:
                note.attempts += 1
                update(note)
                return (sent, pending().count)
            case .refused(let reason):
                note.attempts += 1
                note.failure = reason
                update(note)
            }
        }
        return (sent, pending().count)
    }
}

/// Decides when "another app started using the microphone" is worth an offer
/// to record: on the change from idle to in use, not while the app records
/// or captures itself, and not again within the quiet period.
public struct MicrophoneOfferPolicy: Sendable {
    public var quietPeriod: TimeInterval
    private var wasInUse = false
    private var lastOffer: Date?

    public init(quietPeriod: TimeInterval = 10 * 60) {
        self.quietPeriod = quietPeriod
    }

    public mutating func shouldOffer(inUse: Bool, appIsCapturing: Bool, enabled: Bool, now: Date = Date()) -> Bool {
        let started = inUse && !wasInUse
        wasInUse = inUse
        guard started, enabled, !appIsCapturing else { return false }
        if let lastOffer, now.timeIntervalSince(lastOffer) < quietPeriod { return false }
        lastOffer = now
        return true
    }
}
