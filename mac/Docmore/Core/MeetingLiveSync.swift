import Foundation

/// How `MeetingLiveSync` reaches the server. The app's implementation adds
/// the sign-in and honours the offline switch; tests use a scripted one.
public protocol MeetingLiveTransport: Sendable {
    /// POSTs JSON to `/api/ai/meetings/<route>` and returns the answer's
    /// payload (the `data` member of the server's envelope). Throws
    /// `MeetingLiveFailure`. With an `idempotencyKey` (at most 100
    /// characters of letters, digits and `_.:-`) the server answers a
    /// repeat of the same call with the answer it gave the first time, so a
    /// call whose answer was lost can be made again without doing it twice.
    func post(_ route: String, body: Data, timeout: TimeInterval, idempotencyKey: String?) async throws -> Data
}

public enum MeetingLiveFailure: Error, Equatable, Sendable {
    /// No answer, a server error, "try later" (408, 429), or a sign-in that
    /// has to be renewed first. The same request may work later. `reason`
    /// is for the call log only.
    case unreachable(reason: String)
    /// The server said no (another 4xx): the same request would be refused again.
    case refused(status: Int, message: String)

    public static var unreachable: MeetingLiveFailure { .unreachable(reason: "") }
}

/// Keeps the server's copy of a meeting under way: opens the live meeting,
/// sends the labelled transcript as it grows (one call at a time, again from
/// the first segment not acknowledged after a failure), sends each edit of
/// the list made by hand, and takes the list the server answers with.
///
/// The meeting never depends on any of it: with no server, or no language
/// model on it, the recording goes on and the list is made when it ends.
@MainActor
public final class MeetingLiveSync {
    /// Where the notes go and what the meeting is called.
    public struct Target: Equatable, Sendable {
        public var pageId: String?
        public var spaceId: String?
        public var title: String?
        /// A language code, or nil when it is detected.
        public var language: String?
        /// The language of the app's own interface ("es", "en-GB"): the
        /// server writes default labels and owners in it.
        public var locale: String?

        public init(pageId: String?, spaceId: String?, title: String?, language: String?, locale: String? = nil) {
            self.pageId = pageId
            self.spaceId = spaceId
            self.title = title
            self.language = language
            self.locale = locale
        }
    }

    /// When calls are made, in seconds.
    public struct Pacing: Equatable, Sendable {
        /// From the start of one update to the start of the next, while text
        /// keeps coming.
        public var interval: TimeInterval = 30
        /// From the answer of one update to the start of the next: a model
        /// answers each one, which can take most of a minute.
        public var settle: TimeInterval = 10
        /// From the start of the meeting to its first update.
        public var firstDelay: TimeInterval = 10
        /// Between the starts of any two updates, whatever the reason (a
        /// name typed goes out early): at most 50 calls in ten minutes, the
        /// server refuses more than 60.
        public var minimumGap: TimeInterval = 12
        /// After a call that got no answer: first, second, later failures.
        public var retryDelays: [TimeInterval] = [15, 30, 60]
        /// After an update the server refused (too many calls).
        public var refusedDelay: TimeInterval = 120
        /// How long an update may take: the server answers after its model did.
        public var updateTimeout: TimeInterval = 180
        /// How long an edit made by hand may take (it can wait behind a
        /// model round on the server).
        public var editTimeout: TimeInterval = 90

        public init() {}
    }

    /// The quiet line under the list.
    public enum ListStatus: Equatable, Sendable {
        case building
        case updated(Date)
        /// The server cannot be reached or has no language model: the list
        /// is made when the meeting ends.
        case atEnd
    }

    /// One call, for the automation server and the tests.
    public struct Call: Equatable, Sendable {
        public let route: String
        public var fromIndex: Int?
        public var count: Int?
        public var op: String?
        /// "ok", "unreachable" (with the reason after a colon when one is
        /// known) or "refused <status>".
        public var outcome: String
    }

    public private(set) var state: MeetingLiveState
    public private(set) var meetingId: String?
    public private(set) var aiAvailable: Bool?
    public private(set) var calls: [Call] = []
    /// False once the meeting was stopped or thrown away: no more calls.
    public private(set) var isOpen = true

    /// The state changed (the panel redraws).
    public var onChange: (() -> Void)?
    /// The live meeting got its id, or lost it (kept next to the recording).
    public var onMeetingId: ((String?) -> Void)?
    /// An item added by hand got its id from the server.
    public var onItemRenamed: ((_ provisional: String, _ id: String) -> Void)?
    /// The app's offline switch: while true nothing is sent.
    public var isOffline: () -> Bool = { false }
    /// Seconds recorded so far.
    public var elapsed: () -> Double = { 0 }

    private let target: Target
    private let transport: MeetingLiveTransport
    private let pacing: Pacing
    private let now: () -> Date
    private let createdAt: Date
    /// One key for every attempt to open this meeting: an answer that got
    /// lost must not leave a second live meeting behind. A new one when the
    /// server lost the meeting and another has to be opened.
    private var startKey = "live-start-" + UUID().uuidString.lowercased()

    // Two lanes, each with one call at a time: the text (opening the live
    // meeting, then its updates, which wait for a model on the server) and
    // the edits made by hand, which must not wait behind a model round.
    private var textBusy = false
    private var editsBusy = false
    private var updating = false
    /// No more updates for this meeting (an older server, or it keeps refusing).
    private var gaveUp = false
    /// The recording stopped: only edits of the list still go out.
    private var updatesStopped = false
    private var offlineNow = false
    private var reachable = true
    private var startFailures = 0
    private var restarts = 0
    private var failures = 0
    private var refusals = 0
    private var retryAt: Date?
    private var editFailures = 0
    private var editsRetryAt: Date?
    private var lastUpdateStarted: Date?
    private var lastUpdateEnded: Date?
    private var lastSuccess: Date?

    public init(
        mode: MeetingMode,
        target: Target,
        transport: MeetingLiveTransport,
        pacing: Pacing = Pacing(),
        now: @escaping () -> Date = Date.init
    ) {
        state = MeetingLiveState(mode: mode)
        self.target = target
        self.transport = transport
        self.pacing = pacing
        self.now = now
        createdAt = now()
    }

    // MARK: What the meeting feeds in

    /// New or relabelled text from the engine.
    public func ingest(_ update: MeetingLiveUpdate) {
        // the server refuses any other id, and with it the whole update
        assert(update.speakers.allSatisfy { MeetingSpeaker.isValidId($0.id) }, "speaker ids are 1-40 characters of [a-z0-9_-]")
        if state.apply(update) { onChange?() }
    }

    public func rename(speakerId: String, to name: String?) {
        if state.rename(speakerId: speakerId, to: name) { onChange?() }
    }

    public func restoreNames(from speakers: [MeetingSpeaker]) {
        state.restoreNames(from: speakers)
        onChange?()
    }

    /// An edit of the list made by hand: shown at once, sent as soon as the
    /// server answers. Only possible while the meeting is live on the server.
    @discardableResult
    public func edit(_ op: MeetingItemOp) -> MeetingPendingOp? {
        guard canEditList, let pending = state.enqueue(op) else { return nil }
        onChange?()
        return pending
    }

    public var canEditList: Bool { isOpen && meetingId != nil }

    public var listStatus: ListStatus {
        if offlineNow || gaveUp || aiAvailable == false { return .atEnd }
        if meetingId == nil { return startFailures == 0 ? .building : .atEnd }
        if !reachable { return .atEnd }
        if updating { return .building }
        if let lastSuccess { return .updated(lastSuccess) }
        return .building
    }

    // MARK: Calls

    /// Does what is due now: opens the live meeting, sends the edits made by
    /// hand, sends new text. Cheap to call often (the controller calls it
    /// every tick): a lane that is already waiting for an answer is left
    /// alone, so the server never gets two updates of one meeting at a time.
    /// `force` skips the waiting times.
    public func pump(force: Bool = false) async {
        guard isOpen else { return }
        let offline = isOffline()
        if offline != offlineNow {
            offlineNow = offline
            onChange?()
        }
        if offline { return }
        async let edits: Bool = editsLane(force: force)
        async let text: Void = textLane(force: force)
        _ = await (edits, text)
    }

    private func textLane(force: Bool) async {
        guard isOpen, !textBusy, !gaveUp, !updatesStopped else { return }
        textBusy = true
        defer { textBusy = false }
        if !force, let retryAt, now() < retryAt { return }
        if meetingId == nil {
            await start()
            guard meetingId != nil, isOpen else { return }
        }
        guard state.hasUnsent, force || updateIsDue() else { return }
        await update()
    }

    /// False when the server did not answer an edit (try later).
    @discardableResult
    private func editsLane(force: Bool) async -> Bool {
        guard isOpen, !editsBusy, meetingId != nil else { return true }
        editsBusy = true
        defer { editsBusy = false }
        if !force, let editsRetryAt, now() < editsRetryAt { return true }
        while isOpen, meetingId != nil, let pending = state.nextOp {
            guard await send(pending) else { return false }
        }
        return true
    }

    /// Gets the edits made by hand to the server before the transcript of
    /// the finished recording goes out, for at most `timeout` seconds. The
    /// last stretch of text is not sent: the transcript carries all of it.
    public func flushEdits(timeout: TimeInterval = 20) async {
        let deadline = Date().addingTimeInterval(timeout)
        while isOpen, meetingId != nil, state.nextOp != nil, !isOffline(), Date() < deadline {
            guard await editsLane(force: true) else { return }
            if state.nextOp != nil { try? await Task.sleep(nanoseconds: 100_000_000) }
        }
    }

    /// The recording stopped: no more text goes to the live meeting (the
    /// transcript of the recording carries all of it). Edits of the list
    /// made by hand still go out until `close()`.
    public func stopUpdates() {
        updatesStopped = true
    }

    /// No more calls: the transcript is queued and takes over.
    public func close() {
        isOpen = false
    }

    /// The recording was thrown away: the live meeting goes too.
    public func discard() async {
        isOpen = false
        guard let meetingId, !isOffline() else { return }
        // tried again once when there was no answer: the key makes a repeat harmless
        for attempt in 0..<2 {
            var call = Call(route: "live/discard", outcome: "ok")
            do {
                _ = try await transport.post(
                    "live/discard", body: Self.encode(["meetingId": meetingId]), timeout: 15,
                    idempotencyKey: "live-discard-" + meetingId
                )
                record(call)
                break
            } catch {
                call.outcome = Self.outcome(of: error)
                record(call)
                guard case MeetingLiveFailure.unreachable = error, attempt == 0 else { break }
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
        }
        self.meetingId = nil
        onMeetingId?(nil)
    }

    private func updateIsDue() -> Bool {
        let time = now()
        // after a failure the wait was `retryAt`
        if failures > 0 { return true }
        guard let started = lastUpdateStarted else {
            return time.timeIntervalSince(createdAt) >= pacing.firstDelay
        }
        let sinceStart = time.timeIntervalSince(started)
        let sinceEnd = time.timeIntervalSince(lastUpdateEnded ?? started)
        if sinceStart < pacing.minimumGap || sinceEnd < pacing.settle { return false }
        return state.hasUnsentNames || sinceStart >= pacing.interval
    }

    private func delay(after failures: Int) -> TimeInterval {
        guard !pacing.retryDelays.isEmpty else { return 0 }
        return pacing.retryDelays[min(max(failures, 1), pacing.retryDelays.count) - 1]
    }

    private func start() async {
        struct Body: Encodable {
            let pageId: String?
            let spaceId: String?
            let title: String?
            let mode: MeetingMode
            let language: String?
            let locale: String?
        }
        struct Answer: Decodable {
            let id: String
            let aiAvailable: Bool?
            let items: LossyItems?
            let revision: Int?
        }
        // the page wins when both are set, as on the server
        let pageId = (target.pageId ?? "").isEmpty ? nil : target.pageId
        let body = Body(
            pageId: pageId,
            spaceId: pageId == nil ? target.spaceId : nil,
            title: (target.title ?? "").isEmpty ? nil : target.title.map { String($0.prefix(200)) },
            mode: state.mode,
            language: target.language,
            locale: (target.locale ?? "").isEmpty ? nil : target.locale
        )
        var call = Call(route: "live/start", outcome: "ok")
        do {
            let data = try await transport.post("live/start", body: Self.encode(body), timeout: 20, idempotencyKey: startKey)
            let answer = try JSONDecoder().decode(Answer.self, from: data)
            meetingId = answer.id
            aiAvailable = answer.aiAvailable ?? true
            reachable = true
            startFailures = 0
            failures = 0
            retryAt = nil
            state.resetAcknowledgement()
            state.applyServer(items: answer.items?.items ?? [], revision: answer.revision ?? 0)
            onMeetingId?(answer.id)
        } catch MeetingLiveFailure.refused(let status, _) {
            // an older server, or no right to write there: no live list
            call.outcome = "refused \(status)"
            gaveUp = true
        } catch {
            call.outcome = Self.outcome(of: error)
            reachable = false
            startFailures += 1
            retryAt = now().addingTimeInterval(delay(after: startFailures))
        }
        record(call)
        onChange?()
    }

    private func update() async {
        struct Body: Encodable {
            let meetingId: String
            let fromIndex: Int
            let segments: [MeetingSegment]
            let speakers: [MeetingSpeaker]?
            let durationSeconds: Double?
        }
        struct Answer: Decodable {
            let items: LossyItems?
            let revision: Int?
            let aiAvailable: Bool?
            let stored: Int?
        }
        guard let meetingId else { return }
        let draft = state.beginUpdate(limit: 2000)
        let seconds = elapsed()
        // a line can still carry the id of a voice that has since turned
        // out to be another one's: the server only knows the speakers sent
        let known = Set(draft.speakers.map(\.id))
        let body = Body(
            meetingId: meetingId,
            fromIndex: draft.fromIndex,
            segments: draft.segments.map { segment in
                var copy = segment
                if copy.text.count > 4000 { copy.text = String(copy.text.prefix(4000)) }
                if let speaker = copy.speaker, !known.contains(speaker) { copy.speaker = nil }
                return copy
            },
            speakers: draft.speakers.isEmpty ? nil : draft.speakers,
            durationSeconds: seconds > 0 ? (seconds * 10).rounded() / 10 : nil
        )
        var call = Call(route: "live/update", fromIndex: draft.fromIndex, count: draft.segments.count, outcome: "ok")
        lastUpdateStarted = now()
        updating = true
        onChange?()
        do {
            let data = try await transport.post("live/update", body: Self.encode(body), timeout: pacing.updateTimeout, idempotencyKey: nil)
            // the server took it; an answer that cannot be read changes nothing here
            let answer = try? JSONDecoder().decode(Answer.self, from: data)
            state.completeUpdate(draft, stored: answer?.stored)
            if let items = answer?.items?.items {
                state.applyServer(items: items, revision: answer?.revision ?? state.revision)
            }
            if let available = answer?.aiAvailable { aiAvailable = available }
            reachable = true
            failures = 0
            refusals = 0
            retryAt = nil
            lastSuccess = now()
        } catch MeetingLiveFailure.refused(let status, _) {
            call.outcome = "refused \(status)"
            state.failUpdate(draft)
            if status == 404 {
                meetingLost()
            } else {
                // too many calls, or a request this server does not take
                refusals += 1
                failures += 1
                retryAt = now().addingTimeInterval(pacing.refusedDelay)
                if refusals >= 3 { gaveUp = true }
            }
        } catch {
            call.outcome = Self.outcome(of: error)
            state.failUpdate(draft)
            reachable = false
            failures += 1
            retryAt = now().addingTimeInterval(delay(after: failures))
        }
        updating = false
        lastUpdateEnded = now()
        record(call)
        onChange?()
    }

    /// The server no longer has the live meeting (it gave it up after a long
    /// silence, for example): open a new one and send everything again.
    private func meetingLost() {
        meetingId = nil
        onMeetingId?(nil)
        state.resetAcknowledgement()
        state.dropServerList()
        lastSuccess = nil
        // the old key would only bring back the meeting that is gone
        startKey = "live-start-" + UUID().uuidString.lowercased()
        // the new meeting gets the whole transcript as soon as it is open
        lastUpdateStarted = nil
        lastUpdateEnded = nil
        failures = 0
        retryAt = nil
        restarts += 1
        if restarts > 2 { gaveUp = true }
    }

    /// True when the lane may go on (sent, or refused for good); false when
    /// the server did not answer.
    private func send(_ pending: MeetingPendingOp) async -> Bool {
        struct Answer: Decodable {
            let items: LossyItems?
            let revision: Int?
        }
        guard let meetingId else { return false }
        var call = Call(route: "items", op: pending.op.name, outcome: "ok")
        defer {
            record(call)
            onChange?()
        }
        do {
            // the edit's own id is its key, the same on every attempt: an edit
            // whose answer was lost is not applied twice by the next try
            let data = try await transport.post(
                "items", body: Self.encode(ItemsBody(meetingId: meetingId, op: pending.op)), timeout: pacing.editTimeout,
                idempotencyKey: "item-" + pending.id
            )
            if let answer = try? JSONDecoder().decode(Answer.self, from: data), let items = answer.items?.items {
                if let renamed = state.opSucceeded(pending.id, items: items, revision: answer.revision ?? state.revision) {
                    onItemRenamed?(renamed.provisional, renamed.id)
                }
            } else {
                // taken, with an answer that cannot be read: the next update brings the list
                state.opRejected(pending.id)
            }
            reachable = true
            editFailures = 0
            editsRetryAt = nil
            return true
        } catch MeetingLiveFailure.refused(let status, _) {
            // the entry is gone, or the meeting is (the next update finds out)
            call.outcome = "refused \(status)"
            state.opRejected(pending.id)
            return true
        } catch {
            call.outcome = Self.outcome(of: error)
            reachable = false
            editFailures += 1
            editsRetryAt = now().addingTimeInterval(delay(after: editFailures))
            return false
        }
    }

    private func record(_ call: Call) {
        calls.append(call)
        if calls.count > 300 { calls.removeFirst(calls.count - 300) }
    }

    private static func outcome(of error: Error) -> String {
        switch error {
        case MeetingLiveFailure.refused(let status, _):
            return "refused \(status)"
        case MeetingLiveFailure.unreachable(let reason) where !reason.isEmpty:
            return "unreachable: \(reason)"
        case is MeetingLiveFailure:
            return "unreachable"
        default:
            // an answer that could not be read
            return "unreachable: \(String(describing: type(of: error)))"
        }
    }

    private static func encode<Body: Encodable>(_ body: Body) -> Data {
        (try? JSONEncoder().encode(body)) ?? Data("{}".utf8)
    }
}

/// The body of `items`: what each op needs and nothing else. An update
/// always carries owner and due, as null when the person cleared them.
struct ItemsBody: Encodable {
    let meetingId: String
    let op: MeetingItemOp

    enum Keys: String, CodingKey { case meetingId, op, id, kind, text, owner, due }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(meetingId, forKey: .meetingId)
        try container.encode(op.name, forKey: .op)
        switch op {
        case .add(let kind, let text, let owner, let due):
            try container.encode(kind, forKey: .kind)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(owner, forKey: .owner)
            try container.encodeIfPresent(due, forKey: .due)
        case .update(let id, let text, let owner, let due):
            try container.encode(id, forKey: .id)
            try container.encode(text, forKey: .text)
            try container.encode(owner, forKey: .owner)
            try container.encode(due, forKey: .due)
        case .cancel(let id), .restore(let id), .remove(let id):
            try container.encode(id, forKey: .id)
        }
    }
}

/// A list of items in which an entry that cannot be read is skipped instead
/// of making the whole answer unreadable.
struct LossyItems: Decodable {
    let items: [MeetingItem]

    private struct Anything: Decodable {}

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var result: [MeetingItem] = []
        while !container.isAtEnd {
            if let item = try? container.decode(MeetingItem.self) {
                result.append(item)
            } else {
                _ = try? container.decode(Anything.self)
            }
        }
        items = result
    }
}
