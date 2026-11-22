import Foundation

// The shapes of meetings v2. The server, the web client, the meeting engine
// and this app all use the same ones (JSON names included).

/// The kind of meeting, chosen when the recording starts.
public enum MeetingMode: String, Codable, Sendable, CaseIterable {
    /// Everybody is in the room: only the microphone is recorded.
    case inPerson = "in_person"
    /// The microphone is the person and whoever sits with them; the audio
    /// the Mac plays is the other side of the call. Two separate tracks.
    case virtual
}

/// Which track a sentence came from in a virtual meeting.
public enum MeetingSide: String, Codable, Sendable {
    case room, remote

    public var label: String {
        switch self {
        case .room: return L("Room")
        case .remote: return L("Remote")
        }
    }
}

/// One voice of a meeting.
public struct MeetingSpeaker: Codable, Equatable, Identifiable, Sendable {
    /// 1-40 characters of [a-z0-9_-], unique in the meeting, stable for its whole life.
    public var id: String
    /// Order of first appearance, from 1: the default label is "Speaker <number>".
    public var number: Int
    /// Nil in an in-person meeting.
    public var side: MeetingSide?
    /// What the person typed (at most 80 characters); nil shows the default label.
    public var name: String?

    public static let maxNameLength = 80

    public init(id: String, number: Int, side: MeetingSide? = nil, name: String? = nil) {
        self.id = id
        self.number = number
        self.side = side
        self.name = name
    }

    enum CodingKeys: String, CodingKey { case id, number, side, name }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        number = (try? container.decode(Int.self, forKey: .number)) ?? 1
        side = try? container.decodeIfPresent(MeetingSide.self, forKey: .side)
        name = MeetingSpeaker.cleanName(try? container.decodeIfPresent(String.self, forKey: .name))
    }

    /// `side` and `name` always travel, as null when there is none.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(number, forKey: .number)
        try container.encode(side, forKey: .side)
        try container.encode(name, forKey: .name)
    }

    /// A typed name as it is kept: trimmed, cut to the limit, nil when empty.
    public static func cleanName(_ typed: String?) -> String? {
        guard let typed else { return nil }
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxNameLength)).trimmingCharacters(in: .whitespaces)
    }

    /// "Speaker 3" ("Persona 3" in Spanish).
    public var defaultLabel: String { L("Speaker %lld", number) }

    /// The name, else the default label: what a chip shows next to the side.
    public var shortLabel: String { name ?? defaultLabel }

    /// The name, else the default label with the side of a virtual meeting:
    /// "Speaker 3 (remote)".
    public var label: String {
        if let name { return name }
        switch side {
        case .room: return L("%@ (room)", defaultLabel)
        case .remote: return L("%@ (remote)", defaultLabel)
        case nil: return defaultLabel
        }
    }

    /// Whether an id can travel to the server as it is.
    public static func isValidId(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 40 && id.unicodeScalars.allSatisfy { scalar in
            (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
                || scalar == "_" || scalar == "-"
        }
    }
}

/// A stretch of speech.
public struct MeetingSegment: Codable, Equatable, Sendable {
    /// Seconds from the start of the recording.
    public var start: Double
    public var end: Double
    public var text: String
    /// A `MeetingSpeaker.id`; nil when voices were not told apart.
    public var speaker: String?
    /// Nil in an in-person meeting.
    public var side: MeetingSide?

    public init(start: Double, end: Double, text: String, speaker: String? = nil, side: MeetingSide? = nil) {
        self.start = start
        self.end = end
        self.text = text
        self.speaker = speaker
        self.side = side
    }
}

/// An agreement or a task of the list the server keeps during a meeting.
public struct MeetingItem: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case agreement, task
    }

    public enum Status: String, Codable, Sendable {
        case active, cancelled
    }

    /// An earlier state of the item.
    public struct Version: Codable, Equatable, Sendable {
        public var text: String
        public var owner: String?
        public var due: String?
        public var status: Status
        public var at: Double?
        /// "ai" or "user"
        public var by: String

        public init(text: String, owner: String? = nil, due: String? = nil, status: Status = .active, at: Double? = nil, by: String = "ai") {
            self.text = text
            self.owner = owner
            self.due = due
            self.status = status
            self.at = at
            self.by = by
        }

        enum CodingKeys: String, CodingKey { case text, owner, due, status, at, by }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            text = (try? container.decode(String.self, forKey: .text)) ?? ""
            owner = try? container.decodeIfPresent(String.self, forKey: .owner)
            due = try? container.decodeIfPresent(String.self, forKey: .due)
            status = (try? container.decode(Status.self, forKey: .status)) ?? .active
            at = try? container.decodeIfPresent(Double.self, forKey: .at)
            by = (try? container.decode(String.self, forKey: .by)) ?? "ai"
        }
    }

    public var id: String
    public var kind: Kind
    public var text: String
    /// Who does it; a speaker's name when known.
    public var owner: String?
    /// As it was said ("Friday", "2026-11-28").
    public var due: String?
    public var status: Status
    /// Edited by the person: the model no longer touches it.
    public var locked: Bool
    /// Seconds into the meeting when it last changed.
    public var at: Double?
    /// "ai" or "user"
    public var updatedBy: String
    /// Earlier versions, oldest first.
    public var history: [Version]

    public init(
        id: String,
        kind: Kind,
        text: String,
        owner: String? = nil,
        due: String? = nil,
        status: Status = .active,
        locked: Bool = false,
        at: Double? = nil,
        updatedBy: String = "ai",
        history: [Version] = []
    ) {
        self.id = id
        self.kind = kind
        self.text = text
        self.owner = owner
        self.due = due
        self.status = status
        self.locked = locked
        self.at = at
        self.updatedBy = updatedBy
        self.history = history
    }

    enum CodingKeys: String, CodingKey { case id, kind, text, owner, due, status, locked, at, updatedBy, history }

    /// Only `id` is required: a field this build does not know or that is
    /// missing must not make the whole list unreadable.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = (try? container.decode(Kind.self, forKey: .kind)) ?? .agreement
        text = (try? container.decode(String.self, forKey: .text)) ?? ""
        owner = try? container.decodeIfPresent(String.self, forKey: .owner)
        due = try? container.decodeIfPresent(String.self, forKey: .due)
        status = (try? container.decode(Status.self, forKey: .status)) ?? .active
        locked = (try? container.decode(Bool.self, forKey: .locked)) ?? false
        at = try? container.decodeIfPresent(Double.self, forKey: .at)
        updatedBy = (try? container.decode(String.self, forKey: .updatedBy)) ?? "ai"
        history = (try? container.decode([Version].self, forKey: .history)) ?? []
    }

    public var isCancelled: Bool { status == .cancelled }

    /// What the item said before the model last changed its wording: the
    /// panel shows it as "before: ...". Nothing for an item the person
    /// edited (they know what it said) or whose wording did not change.
    public var previousText: String? {
        guard updatedBy != "user", let last = history.last else { return nil }
        let before = last.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !before.isEmpty, before != text.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return before
    }
}

/// What the meeting engine reports while a meeting is recorded: the segments
/// from `fromIndex` on are replaced by `segments` (nil appends), which lets
/// the engine both add text and give earlier lines another speaker.
public struct MeetingLiveUpdate: Equatable, Sendable {
    public var fromIndex: Int?
    public var segments: [MeetingSegment]
    /// Every voice heard so far, in order of first appearance. The engine
    /// never sets `name`: names belong to the person.
    public var speakers: [MeetingSpeaker]

    public init(fromIndex: Int? = nil, segments: [MeetingSegment], speakers: [MeetingSpeaker] = []) {
        self.fromIndex = fromIndex
        self.segments = segments
        self.speakers = speakers
    }
}

/// A change the person makes to the list by hand.
public enum MeetingItemOp: Equatable, Sendable {
    case add(kind: MeetingItem.Kind, text: String, owner: String?, due: String?)
    /// The three fields as the editor leaves them (nil clears owner or due).
    case update(id: String, text: String, owner: String?, due: String?)
    case cancel(id: String)
    case restore(id: String)
    case remove(id: String)

    public var name: String {
        switch self {
        case .add: return "add"
        case .update: return "update"
        case .cancel: return "cancel"
        case .restore: return "restore"
        case .remove: return "remove"
        }
    }

    /// The item the op acts on (nil for `add`).
    public var itemId: String? {
        switch self {
        case .add: return nil
        case .update(let id, _, _, _), .cancel(let id), .restore(let id), .remove(let id): return id
        }
    }

    func replacingItemId(_ old: String, with new: String) -> MeetingItemOp {
        switch self {
        case .add: return self
        case .update(let id, let text, let owner, let due): return id == old ? .update(id: new, text: text, owner: owner, due: due) : self
        case .cancel(let id): return id == old ? .cancel(id: new) : self
        case .restore(let id): return id == old ? .restore(id: new) : self
        case .remove(let id): return id == old ? .remove(id: new) : self
        }
    }
}
