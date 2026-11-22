import Foundation

/// A stretch of the transcript said by one voice, the way the panel shows it:
/// consecutive segments of the same speaker and side joined.
public struct MeetingTurn: Equatable, Identifiable, Sendable {
    /// Index of its first segment.
    public let id: Int
    /// The speaker id of its segments, known to the meeting or not.
    public let speakerId: String?
    public let speaker: MeetingSpeaker?
    public let side: MeetingSide?
    public let start: Double
    public var text: String
    /// Segments joined into this turn.
    public var count: Int
}

/// An edit of the list made by hand that the server has not confirmed yet.
public struct MeetingPendingOp: Equatable, Identifiable, Sendable {
    public let id: String
    public var op: MeetingItemOp
    /// The id an added item carries until the server names it.
    public let provisionalId: String?
}

/// A meeting under way, as the panel shows it and as far as the server has
/// it: the labelled transcript, the names typed, the list of agreements and
/// tasks with the edits still on their way, and the bookkeeping of what was
/// sent. Pure state: `MeetingLiveSync` does the calls.
public struct MeetingLiveState: Equatable, Sendable {
    public let mode: MeetingMode

    public private(set) var segments: [MeetingSegment] = []
    /// The voices that have text now, with their names.
    public private(set) var speakers: [MeetingSpeaker] = []
    // What the person decided here about a name wins over what the engine
    // carries: a name typed, or a name taken away. For a voice with no
    // decision the engine's own name shows (it moves a name to the voice
    // that stays when two turn out to be one).
    private var names: [String: String] = [:]
    private var unnamed: Set<String> = []

    // What the server holds of the transcript

    /// The server holds the segments before this index exactly as they are here.
    public private(set) var acknowledged = 0
    /// How many segments the server said it holds.
    public private(set) var serverStored = 0
    private var namesRevision = 0
    private var sentNamesRevision = 0
    private var inFlight: InFlight?

    private struct InFlight: Equatable, Sendable {
        var end: Int
        /// Lowest index that changed here while the request was on its way.
        var changedFrom: Int?
    }

    // The list

    private var serverItems: [MeetingItem] = []
    /// The server's list with the edits not confirmed yet applied on top.
    public private(set) var items: [MeetingItem] = []
    public private(set) var revision = 0
    public private(set) var pendingOps: [MeetingPendingOp] = []

    public init(mode: MeetingMode) {
        self.mode = mode
    }

    // MARK: Transcript

    /// Takes what the engine reports. Returns false when nothing changed.
    @discardableResult
    public mutating func apply(_ update: MeetingLiveUpdate) -> Bool {
        var changed = false
        let from = min(max(update.fromIndex ?? segments.count, 0), segments.count)
        let next = Array(segments[..<from]) + update.segments
        var index = from
        while index < segments.count, index < next.count, segments[index] == next[index] { index += 1 }
        if index != segments.count || index != next.count {
            segments = next
            markChanged(from: index)
            changed = true
        }
        let named = update.speakers.map(resolved)
        if named != speakers {
            // a name that came or went with the engine's update has to reach the server too
            let before = Dictionary(speakers.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
            if named.contains(where: { $0.name != nil && before[$0.id] != .some($0.name) })
                || speakers.contains(where: { old in old.name != nil && !named.contains { $0.id == old.id && $0.name == old.name } }) {
                namesRevision += 1
            }
            speakers = named
            changed = true
        }
        return changed
    }

    /// A speaker as it is shown: with the name decided here, else the one it carries.
    private func resolved(_ speaker: MeetingSpeaker) -> MeetingSpeaker {
        var copy = speaker
        if let typed = names[speaker.id] {
            copy.name = typed
        } else if unnamed.contains(speaker.id) {
            copy.name = nil
        } else {
            copy.name = MeetingSpeaker.cleanName(speaker.name)
        }
        return copy
    }

    private mutating func markChanged(from index: Int) {
        acknowledged = min(acknowledged, index)
        if var flight = inFlight, index < flight.end {
            flight.changedFrom = min(flight.changedFrom ?? .max, index)
            inFlight = flight
        }
    }

    public func speaker(_ id: String?) -> MeetingSpeaker? {
        guard let id else { return nil }
        return speakers.first { $0.id == id }
    }

    /// The name typed for a voice replaces its default label everywhere at
    /// once; an empty name brings the default label back.
    @discardableResult
    public mutating func rename(speakerId: String, to typed: String?) -> Bool {
        let name = MeetingSpeaker.cleanName(typed)
        // what the voice is called now (a voice not heard yet may have a name waiting)
        let shown: String? = speakers.first { $0.id == speakerId }.map(\.name) ?? names[speakerId]
        guard shown != name else { return false }
        if let name {
            names[speakerId] = name
            unnamed.remove(speakerId)
        } else {
            names[speakerId] = nil
            unnamed.insert(speakerId)
        }
        if let index = speakers.firstIndex(where: { $0.id == speakerId }) {
            speakers[index].name = name
        }
        namesRevision += 1
        return true
    }

    /// Names known before any update arrived (a recording finished later).
    public mutating func restoreNames(from known: [MeetingSpeaker]) {
        for speaker in known {
            if let name = speaker.name {
                names[speaker.id] = name
                unnamed.remove(speaker.id)
            }
        }
        speakers = speakers.map(resolved)
    }

    /// The speakers of a finished transcript as the person named them: the
    /// name decided here, else the one the transcript carries.
    public func named(_ engineSpeakers: [MeetingSpeaker]) -> [MeetingSpeaker] {
        engineSpeakers.map(resolved)
    }

    /// The label of one segment: its speaker's, else its side's, else none.
    public func label(for segment: MeetingSegment) -> String? {
        if let speaker = speaker(segment.speaker) { return speaker.label }
        return segment.side?.label
    }

    /// The transcript as turns: one chip per change of voice, and a new turn
    /// after a long stretch so the chip is never far.
    public var turns: [MeetingTurn] {
        var result: [MeetingTurn] = []
        for (index, segment) in segments.enumerated() {
            let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            if var last = result.last, last.speakerId == segment.speaker, last.side == segment.side,
               last.text.count + text.count < 480 {
                last.text += " " + text
                last.count += 1
                result[result.count - 1] = last
            } else {
                result.append(MeetingTurn(
                    id: index, speakerId: segment.speaker, speaker: speaker(segment.speaker),
                    side: segment.side, start: segment.start, text: text, count: 1
                ))
            }
        }
        return result
    }

    // MARK: What goes to the server

    /// One `live/update`: the segments from the first one not acknowledged.
    public struct UpdateDraft: Equatable, Sendable {
        public let fromIndex: Int
        public let segments: [MeetingSegment]
        public let speakers: [MeetingSpeaker]
        let namesRevision: Int
    }

    public var hasUnsentText: Bool { acknowledged < segments.count || serverStored > segments.count }

    /// A name was typed since the speakers last reached the server.
    public var hasUnsentNames: Bool { namesRevision != sentNamesRevision && !speakers.isEmpty }

    public var hasUnsent: Bool { hasUnsentText || hasUnsentNames }

    /// Starts an update. Changes made while it is on its way are noticed, so
    /// `completeUpdate` never acknowledges a segment that changed meanwhile.
    public mutating func beginUpdate(limit: Int = 2000) -> UpdateDraft {
        let from = min(acknowledged, segments.count)
        let end = min(segments.count, from + max(1, limit))
        inFlight = InFlight(end: end, changedFrom: nil)
        return UpdateDraft(fromIndex: from, segments: Array(segments[from..<end]), speakers: speakers, namesRevision: namesRevision)
    }

    /// The server took the update; `stored` is how many segments it holds now.
    public mutating func completeUpdate(_ draft: UpdateDraft, stored: Int?) {
        let end = draft.fromIndex + draft.segments.count
        let changedFrom = inFlight?.changedFrom ?? .max
        inFlight = nil
        serverStored = max(0, stored ?? end)
        acknowledged = max(0, min(end, changedFrom, serverStored, segments.count))
        sentNamesRevision = draft.namesRevision
    }

    /// The update was lost: nothing is acknowledged, the next one starts at
    /// the same index (or lower, when an earlier segment changed meanwhile).
    public mutating func failUpdate(_ draft: UpdateDraft) {
        inFlight = nil
    }

    /// A new live meeting on the server knows nothing: send everything again.
    public mutating func resetAcknowledgement() {
        inFlight = nil
        acknowledged = 0
        serverStored = 0
        sentNamesRevision = -1
    }

    // MARK: The list

    /// Takes the list the server answered with. An answer older than the one
    /// already shown is ignored. Returns false when it was ignored.
    @discardableResult
    public mutating func applyServer(items: [MeetingItem], revision: Int) -> Bool {
        guard revision >= self.revision else { return false }
        serverItems = items
        self.revision = revision
        rebuildItems()
        return true
    }

    /// The live meeting is gone from the server, and its list with it.
    public mutating func dropServerList() {
        serverItems = []
        revision = 0
        pendingOps = []
        rebuildItems()
    }

    /// Records an edit made by hand and shows it at once. Returns nil when
    /// there is nothing to do (no text, or the item is not in the list).
    @discardableResult
    public mutating func enqueue(_ op: MeetingItemOp, id: String = UUID().uuidString.lowercased()) -> MeetingPendingOp? {
        var cleaned = op
        switch op {
        case .add(let kind, let text, let owner, let due):
            guard let text = Self.clean(text) else { return nil }
            cleaned = .add(kind: kind, text: text, owner: Self.clean(owner), due: Self.clean(due))
        case .update(let itemId, let text, let owner, let due):
            guard let text = Self.clean(text), let current = items.first(where: { $0.id == itemId }) else { return nil }
            let owner = Self.clean(owner), due = Self.clean(due)
            guard current.text != text || current.owner != owner || current.due != due else { return nil }
            cleaned = .update(id: itemId, text: text, owner: owner, due: due)
        case .cancel(let itemId):
            guard let current = items.first(where: { $0.id == itemId }), !current.isCancelled else { return nil }
        case .restore(let itemId):
            guard let current = items.first(where: { $0.id == itemId }), current.isCancelled else { return nil }
        case .remove(let itemId):
            guard items.contains(where: { $0.id == itemId }) else { return nil }
        }
        var provisional: String?
        if case .add = cleaned { provisional = "local-\(id)" }
        let pending = MeetingPendingOp(id: id, op: cleaned, provisionalId: provisional)
        pendingOps.append(pending)
        rebuildItems()
        return pending
    }

    private static func clean(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    /// The edit to send next: they go one at a time, in the order made.
    public var nextOp: MeetingPendingOp? { pendingOps.first }

    /// The server applied an edit and answered with its list. For an added
    /// item, returns the provisional id and the id the server gave it.
    @discardableResult
    public mutating func opSucceeded(_ opId: String, items answered: [MeetingItem], revision answeredRevision: Int) -> (provisional: String, id: String)? {
        var renamed: (provisional: String, id: String)?
        if let index = pendingOps.firstIndex(where: { $0.id == opId }) {
            let done = pendingOps.remove(at: index)
            if case .add(_, let text, _, _) = done.op, let provisional = done.provisionalId {
                let known = Set(serverItems.map(\.id))
                let fresh = answered.filter { !known.contains($0.id) }
                if let match = fresh.last(where: { $0.updatedBy == "user" && $0.text == text }) ?? fresh.last {
                    pendingOps = pendingOps.map { pending in
                        MeetingPendingOp(id: pending.id, op: pending.op.replacingItemId(provisional, with: match.id), provisionalId: pending.provisionalId)
                    }
                    renamed = (provisional, match.id)
                } else {
                    // the server did not keep it: later edits of it have nothing to act on
                    pendingOps.removeAll { $0.op.itemId == provisional }
                }
            }
        }
        if answeredRevision >= revision {
            serverItems = answered
            revision = answeredRevision
        }
        rebuildItems()
        return renamed
    }

    /// The server refused an edit for good: it is dropped, and with it the
    /// edits of an item that was never added.
    public mutating func opRejected(_ opId: String) {
        guard let index = pendingOps.firstIndex(where: { $0.id == opId }) else { return }
        let dropped = pendingOps.remove(at: index)
        if let provisional = dropped.provisionalId {
            pendingOps.removeAll { $0.op.itemId == provisional }
        }
        rebuildItems()
    }

    private mutating func rebuildItems() {
        var list = serverItems
        for pending in pendingOps {
            switch pending.op {
            case .add(let kind, let text, let owner, let due):
                list.append(MeetingItem(
                    id: pending.provisionalId ?? "local-\(pending.id)", kind: kind, text: text, owner: owner, due: due,
                    status: .active, locked: true, at: nil, updatedBy: "user"
                ))
            case .update(let id, let text, let owner, let due):
                guard let index = list.firstIndex(where: { $0.id == id }) else { continue }
                list[index].text = text
                list[index].owner = owner
                list[index].due = due
                list[index].locked = true
                list[index].updatedBy = "user"
            case .cancel(let id):
                guard let index = list.firstIndex(where: { $0.id == id }) else { continue }
                list[index].status = .cancelled
                list[index].locked = true
                list[index].updatedBy = "user"
            case .restore(let id):
                guard let index = list.firstIndex(where: { $0.id == id }) else { continue }
                list[index].status = .active
                list[index].locked = true
                list[index].updatedBy = "user"
            case .remove(let id):
                list.removeAll { $0.id == id }
            }
        }
        items = list
    }
}
