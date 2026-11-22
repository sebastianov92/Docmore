import Foundation

public enum MeetingQueueError: Error, LocalizedError, Equatable, Sendable {
    /// Neither a page nor a space.
    case invalidTarget
    /// Nothing was said: there is nothing to send.
    case emptyTranscript
    case storage(String)
    case notFound(String)

    public var errorDescription: String? {
        switch self {
        case .invalidTarget: return "Pick a page or a space for the meeting notes."
        case .emptyTranscript: return "The recording has no speech to send."
        case .storage(let detail): return "The meeting could not be saved: \(detail)"
        case .notFound(let id): return "There is no meeting \(id) in the queue."
        }
    }
}

/// What to do with a job after a send attempt failed.
public enum SendDisposition: Equatable, Sendable {
    /// Leave it in the queue. `stopPass`: the cause affects every job
    /// (no network, server down), so the rest of this flush is skipped.
    case keep(reason: String, stopPass: Bool)
    /// Leave it in the queue and tell the app the person must sign in.
    case needsSignIn
    /// The server will never take it: move it to `failed/`.
    case fail(reason: String)
}

/// The outcome of one `flush()`.
public struct FlushReport: Sendable {
    public struct Sent: Sendable {
        public var job: MeetingJob
        public var receipt: MeetingReceipt
    }

    /// Jobs the server took in this pass (now gone from the queue).
    public var sent: [Sent] = []
    /// Jobs moved to `failed/` in this pass.
    public var failed: [MeetingJob] = []
    /// Jobs still waiting after the pass.
    public var pending: Int = 0
    /// A job was refused with 401: sign in, then flush again.
    public var needsSignIn = false
    /// Why the pass stopped before trying every job, when it did.
    public var stoppedBy: String?
    /// Another process is flushing this directory right now; nothing was done.
    public var busy = false
}

/// A persistent queue of transcripts for the server.
///
///     <directory>/<job id>.json          waiting
///     <directory>/failed/<job id>.json   refused for good, with the reason
///
/// ```swift
/// let queue = MeetingQueue(directory: queueDirectory, sender: sender)
/// queue.onChange = { ... queue.pendingCount, queue.failedCount ... }
/// try queue.enqueue(transcript, target: .page(pageId, title: "Weekly"))
/// let report = await queue.flush()
/// ```
///
/// The queue has no timer: call `flush()` after `enqueue`, at launch, and
/// when the server becomes reachable again. Calls made while a flush runs
/// join it, and a second process is kept out with a file lock, so a job is
/// never sent twice at the same moment.
///
/// What happens to a job that was not accepted:
/// - no answer (network), HTTP 404, 408, 429, 5xx: it stays for a later flush;
/// - HTTP 401 (or the sender says "needs sign-in"): it stays, and
///   `needsSignIn` turns true;
/// - any other 4xx: it moves to `failed/` with the reason (`retryFailed`
///   puts it back).
///
/// Thread safe. `onChange` runs on an arbitrary thread.
public final class MeetingQueue: @unchecked Sendable {
    public let directory: URL
    /// Called after the pending or failed jobs, or `needsSignIn`, changed.
    public var onChange: (() -> Void)?

    private let sender: MeetingSender
    private let lock = NSLock()
    private var flushTask: Task<FlushReport, Never>?
    private var signInNeeded = false

    public init(directory: URL, sender: MeetingSender) {
        self.directory = directory
        self.sender = sender
        try? FileManager.default.createDirectory(at: failedDirectory, withIntermediateDirectories: true)
    }

    // MARK: - State

    public var pendingCount: Int { Self.jobFiles(in: directory).count }

    public var failedCount: Int { Self.jobFiles(in: failedDirectory).count }

    /// True after a 401 until a job goes through or `clearNeedsSignIn()`.
    public var needsSignIn: Bool {
        lock.lock(); defer { lock.unlock() }
        return signInNeeded
    }

    /// Call it after the person signed in again (then `flush()`).
    public func clearNeedsSignIn() {
        setNeedsSignIn(false)
    }

    /// The waiting jobs, oldest first.
    public func pendingJobs() -> [MeetingJob] {
        Self.jobs(in: directory)
    }

    /// The jobs the server refused, oldest first. `lastError` says why.
    public func failedJobs() -> [MeetingJob] {
        Self.jobs(in: failedDirectory)
    }

    // MARK: - Changes

    /// Stores a transcript for sending. Does not send: call `flush()`.
    /// `meetingId` is the live meeting on the server this transcript
    /// finishes, when it was followed live. `locale` is the language of the
    /// recorder's interface ("es-ES", "en"), for the labels of the notes.
    @discardableResult
    public func enqueue(
        _ transcript: MeetingTranscript,
        target: MeetingTarget,
        userInfo: [String: String] = [:],
        meetingId: String? = nil,
        locale: String? = nil
    ) throws -> MeetingJob {
        guard target.isValid else { throw MeetingQueueError.invalidTarget }
        guard !transcript.isEmpty else { throw MeetingQueueError.emptyTranscript }
        let job: MeetingJob = try locked {
            // Jobs are sent oldest first, and the files keep milliseconds:
            // two jobs made in the same millisecond still get distinct times.
            var createdAt = Date(timeIntervalSince1970: (Date().timeIntervalSince1970 * 1000).rounded(.down) / 1000)
            if let newest = Self.jobs(in: directory).last?.createdAt, createdAt <= newest {
                createdAt = newest.addingTimeInterval(0.001)
            }
            let job = MeetingJob(target: target, transcript: transcript, createdAt: createdAt, userInfo: userInfo,
                                 meetingId: (meetingId ?? "").isEmpty ? nil : meetingId,
                                 locale: (locale ?? "").isEmpty ? nil : locale)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try Self.write(job, to: Self.file(for: job.id, in: directory))
            } catch {
                throw MeetingQueueError.storage(error.localizedDescription)
            }
            return job
        }
        notify()
        return job
    }

    /// Puts failed jobs back in the queue (one, or all with `id` nil).
    /// Returns how many moved.
    @discardableResult
    public func retryFailed(id: String? = nil) throws -> Int {
        let moved: Int = try locked {
            var moved = 0
            for var job in Self.jobs(in: failedDirectory) where id == nil || job.id == id {
                job.lastError = nil
                job.attempts = 0
                do {
                    try Self.write(job, to: Self.file(for: job.id, in: directory))
                    try FileManager.default.removeItem(at: Self.file(for: job.id, in: failedDirectory))
                } catch {
                    throw MeetingQueueError.storage(error.localizedDescription)
                }
                moved += 1
            }
            return moved
        }
        if let id, moved == 0 { throw MeetingQueueError.notFound(id) }
        if moved > 0 { notify() }
        return moved
    }

    /// Deletes a job, waiting or failed.
    public func remove(id: String) throws {
        let removed: Bool = try locked {
            var removed = false
            for folder in [directory, failedDirectory] {
                let file = Self.file(for: id, in: folder)
                if FileManager.default.fileExists(atPath: file.path) {
                    do {
                        try FileManager.default.removeItem(at: file)
                    } catch {
                        throw MeetingQueueError.storage(error.localizedDescription)
                    }
                    removed = true
                }
            }
            return removed
        }
        guard removed else { throw MeetingQueueError.notFound(id) }
        notify()
    }

    // MARK: - Sending

    /// Sends the waiting jobs, oldest first. Never throws: the report and
    /// the job files say what happened.
    @discardableResult
    public func flush() async -> FlushReport {
        let task: Task<FlushReport, Never> = locked {
            if let running = flushTask { return running }
            let made = Task { await self.performFlush() }
            flushTask = made
            return made
        }
        return await task.value
    }

    /// The rule that decides the fate of a job from the error of its send.
    public static func disposition(for error: Error) -> SendDisposition {
        if let sendError = error as? MeetingSendError {
            switch sendError {
            case .needsSignIn:
                return .needsSignIn
            case .invalid(let detail):
                return .fail(reason: detail)
            case .http(let status, _):
                let reason = sendError.localizedDescription
                switch status {
                case 401:
                    return .needsSignIn
                case 404:
                    // the page may come back, the endpoint may not be deployed yet
                    return .keep(reason: reason, stopPass: false)
                case 408, 429:
                    // "try later" by definition (429 is also the daily AI limit)
                    return .keep(reason: reason, stopPass: true)
                case 400..<500:
                    return .fail(reason: reason)
                default:
                    // 5xx, and anything that is not an answer of the API
                    return .keep(reason: reason, stopPass: true)
                }
            }
        }
        // URLError, a cancelled task, a token provider that threw: no answer
        return .keep(reason: error.localizedDescription, stopPass: true)
    }

    private func performFlush() async -> FlushReport {
        var report = FlushReport()
        guard let fileLock = FileLock(url: directory.appendingPathComponent(".flush.lock")) else {
            report.busy = true
            report.pending = pendingCount
            locked { flushTask = nil }
            return report
        }
        defer { fileLock.unlock() }

        var attempted = Set<String>()
        var stopped = false
        while true {
            // Picking the next job and ending the flush happen under the lock
            // enqueue() takes, so a job stored while this pass runs is either
            // seen here or sent by the flush() that follows it.
            let next: URL? = locked {
                let found = stopped ? nil : Self.oldestFirst(in: directory).first { !attempted.contains($0.lastPathComponent) }
                if found == nil { flushTask = nil }
                return found
            }
            guard let file = next else { break }
            attempted.insert(file.lastPathComponent)

            guard let job = Self.read(file) else {
                // unreadable: out of the way, kept for inspection
                try? FileManager.default.moveItem(at: file, to: failedDirectory.appendingPathComponent(file.lastPathComponent))
                notify()
                continue
            }
            do {
                let receipt = try await sender.send(job)
                try? FileManager.default.removeItem(at: file)
                report.sent.append(FlushReport.Sent(job: job, receipt: receipt))
                setNeedsSignIn(false, notifying: false)
                notify()
            } catch {
                var updated = job
                updated.attempts += 1
                updated.lastAttemptAt = Date()
                switch Self.disposition(for: error) {
                case .keep(let reason, let stopPass):
                    updated.lastError = reason
                    rewrite(updated, at: file)
                    if stopPass {
                        stopped = true
                        report.stoppedBy = reason
                    }
                case .needsSignIn:
                    updated.lastError = MeetingSendError.needsSignIn.localizedDescription
                    rewrite(updated, at: file)
                    report.needsSignIn = true
                    report.stoppedBy = updated.lastError
                    stopped = true
                    setNeedsSignIn(true, notifying: false)
                case .fail(let reason):
                    updated.lastError = reason
                    locked {
                        if FileManager.default.fileExists(atPath: file.path) {
                            try? Self.write(updated, to: Self.file(for: job.id, in: failedDirectory))
                            try? FileManager.default.removeItem(at: file)
                        }
                    }
                    report.failed.append(updated)
                }
                notify()
            }
        }
        report.pending = pendingCount
        return report
    }

    /// Stores the attempt count and the reason, unless the app removed the
    /// job while it was being sent.
    private func rewrite(_ job: MeetingJob, at file: URL) {
        lock.lock()
        defer { lock.unlock() }
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        try? Self.write(job, to: file)
    }

    private func setNeedsSignIn(_ value: Bool, notifying: Bool = true) {
        lock.lock()
        let changed = signInNeeded != value
        signInNeeded = value
        lock.unlock()
        if changed, notifying { notify() }
    }

    private func notify() {
        onChange?()
    }

    // MARK: - Files

    private var failedDirectory: URL {
        directory.appendingPathComponent("failed", isDirectory: true)
    }

    private static func file(for id: String, in folder: URL) -> URL {
        folder.appendingPathComponent("\(id).json")
    }

    /// The job files of a folder, in no particular order.
    private static func jobFiles(in folder: URL) -> [URL] {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
        return files.filter { $0.pathExtension == "json" }
    }

    /// The job files of a folder by the date the job was made (the file's
    /// own dates change each time an attempt is recorded). Unreadable files
    /// come first, so they are moved out of the way.
    private static func oldestFirst(in folder: URL) -> [URL] {
        var dated: [(file: URL, date: Date)] = []
        for file in jobFiles(in: folder) {
            dated.append((file, read(file)?.createdAt ?? Date.distantPast))
        }
        dated.sort { first, second in
            if first.date != second.date { return first.date < second.date }
            return first.file.lastPathComponent < second.file.lastPathComponent
        }
        return dated.map { $0.file }
    }

    private static func jobs(in folder: URL) -> [MeetingJob] {
        jobFiles(in: folder).compactMap(read).sorted {
            $0.createdAt != $1.createdAt ? $0.createdAt < $1.createdAt : $0.id < $1.id
        }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    private static func read(_ file: URL) -> MeetingJob? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JobCoding.decoder().decode(MeetingJob.self, from: data)
    }

    private static func write(_ job: MeetingJob, to file: URL) throws {
        try JobCoding.encoder().encode(job).write(to: file, options: .atomic)
    }
}

/// JSON for the job files: readable, with dates as ISO 8601 with
/// milliseconds (jobs made within one second keep their order).
enum JobCoding {
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatter(fractional: true).string(from: date))
        }
        return encoder
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = formatter(fractional: true).date(from: text) ?? formatter(fractional: false).date(from: text) {
                return date
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "not an ISO 8601 date: \(text)")
        }
        return decoder
    }

    private static func formatter(fractional: Bool) -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = fractional ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return formatter
    }
}

/// An advisory lock on a file, released when the process ends whatever
/// happens: keeps two processes from flushing one queue directory at once.
private final class FileLock {
    private let descriptor: Int32

    /// Nil when another process holds it.
    init?(url: URL) {
        let descriptor = open(url.path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { return nil }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return nil
        }
        self.descriptor = descriptor
    }

    func unlock() {
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}
