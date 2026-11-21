import Foundation

/// A stretch of a track with the speaker it belongs to.
public struct LabelledTurn: Codable, Equatable, Sendable {
    /// Seconds from the start of the recording.
    public var start: Double
    public var end: Double
    /// A `MeetingSpeaker.id`.
    public var speaker: String

    public init(start: Double, end: Double, speaker: String) {
        self.start = start
        self.end = end
        self.speaker = speaker
    }

    public var duration: Double { max(0, end - start) }
}

/// What is remembered about a voice so it can be recognised again.
public struct KnownVoice: Codable, Equatable, Sendable {
    public var id: String
    /// The voice print from the run that heard the most of this voice.
    public var print: [Float]
    /// How many seconds of speech that print stands for.
    public var printSeconds: Double
    /// True for a voice that was heard too little, and in one pass only, to
    /// be shown as a speaker yet. Its id is a private one ("?3").
    public var isProvisional: Bool

    public init(id: String, print: [Float] = [], printSeconds: Double = 0, isProvisional: Bool = false) {
        self.id = id
        self.print = print
        self.printSeconds = printSeconds
        self.isProvisional = isProvisional
    }

    private enum CodingKeys: String, CodingKey { case id, print, printSeconds, isProvisional }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        print = try container.decodeIfPresent([Float].self, forKey: .print) ?? []
        printSeconds = try container.decodeIfPresent(Double.self, forKey: .printSeconds) ?? 0
        isProvisional = try container.decodeIfPresent(Bool.self, forKey: .isProvisional) ?? false
    }
}

/// How the clusters of a fresh diarization are matched to the voices that
/// are already known. The numbers come from measurements with synthetic
/// voices (see STATUS.md); real voices may want other values.
public struct SpeakerMatchingPolicy: Equatable, Sendable {
    /// Seconds a cluster must share with what a known voice was heard
    /// saying before to inherit its id. Small clusters need half of their
    /// own speech instead.
    public var minOverlapSeconds: Double = 1.0
    /// Voice print distance under which a cluster with no such overlap is
    /// taken for a known voice that came back. Measured: the same voice
    /// stays under 0.2 with six seconds of speech or more, two different
    /// voices never came closer than 0.43.
    public var sameVoiceDistance: Float = 0.35
    /// Speech a cluster needs before "close to nobody" is read as "somebody
    /// new" while there are known voices it could still turn out to be.
    public var reliablePrintSeconds: Double = 10
    /// Speech a cluster needs to count as a voice at all, while the meeting runs.
    public var minNewSpeakerSeconds: Double = 2
    /// Speech a new voice needs to be shown as a speaker at once. With less
    /// it waits, unseen, for the next pass: if it is still a voice of its
    /// own then, it becomes a speaker; if it has melted into another voice
    /// (the models often split a voice for one pass when they have heard
    /// little), it is gone without ever having used a number.
    public var confidentNewSpeakerSeconds: Double = 8
    /// A voice print made of this much speech is as good as it gets: a newer
    /// one of this much replaces an older one of more (voices and rooms
    /// drift over a long meeting).
    public var plentyPrintSeconds: Double = 120
    /// When a cluster covers what two known voices said (they were one
    /// person all along), the one the person gave a name to weighs this
    /// much more, so the name is not lost.
    public var namedBoost: Double = 1.5

    public init() {}
}

/// The speakers of one track: who is known, and who was heard when.
///
/// The heart of it is `absorb`: the clusters of every new diarization are
/// matched to the known voices, first by time (a cluster that covers what
/// speaker s2 was already heard saying is s2) and then by voice print (a
/// cluster nobody was heard saying, that sounds like a known voice, is that
/// voice coming back). Ids are therefore stable however the diarizer numbers
/// its clusters from run to run.
public struct TrackSpeakers: Codable, Equatable, Sendable {
    public var side: MeetingSide?
    public private(set) var voices: [KnownVoice]
    /// Ordered by start, not overlapping. Includes the turns of voices that
    /// are still provisional (see `labelledTurns`).
    public private(set) var turns: [LabelledTurn]
    private var provisionalCount: Int

    public init(side: MeetingSide? = nil, voices: [KnownVoice] = [], turns: [LabelledTurn] = []) {
        self.side = side
        self.voices = voices
        self.turns = turns.sorted { $0.start < $1.start }
        provisionalCount = 0
    }

    private enum CodingKeys: String, CodingKey { case side, voices, turns, provisionalCount }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        side = try container.decodeIfPresent(MeetingSide.self, forKey: .side)
        voices = try container.decodeIfPresent([KnownVoice].self, forKey: .voices) ?? []
        turns = try container.decodeIfPresent([LabelledTurn].self, forKey: .turns) ?? []
        provisionalCount = try container.decodeIfPresent(Int.self, forKey: .provisionalCount) ?? 0
    }

    /// Whether an id is the private id of a provisional voice.
    public static func isProvisional(_ id: String) -> Bool { id.hasPrefix("?") }

    /// The turns of the voices that are speakers.
    public var labelledTurns: [LabelledTurn] {
        turns.filter { !Self.isProvisional($0.speaker) }
    }

    /// What `absorb` did.
    public struct Outcome: Equatable, Sendable {
        /// Cluster -> speaker id. A cluster that is not here, or that has the
        /// private id of a provisional voice, stays without a speaker for
        /// now (too little speech to tell who it is).
        public var assignment: [Int: String] = [:]
        /// Ids made in this run, in order of first appearance.
        public var created: [String] = []
        /// Ids of voices that no longer have any speech (they turned out to
        /// be part of another voice).
        public var retired: [String] = []
        /// For a retired voice, the speaker that now has most of what it
        /// said: where a name typed on the retired one should go.
        public var absorbedBy: [String: String] = [:]
    }

    /// Takes in a diarization of the window `from...to` of this track (its
    /// times already on the recording's clock): replaces the turns inside
    /// the window, keeps everything before it as it was.
    ///
    /// - Parameters:
    ///   - named: ids the person gave a name to.
    ///   - final: nothing comes after this run, so every cluster gets a speaker.
    ///   - makeSpeaker: called for a voice nobody knows; returns its new id.
    public mutating func absorb(
        _ diarization: Diarization,
        from windowStart: Double,
        to windowEnd: Double,
        policy: SpeakerMatchingPolicy = SpeakerMatchingPolicy(),
        named: Set<String> = [],
        final: Bool = false,
        makeSpeaker: () -> String
    ) -> Outcome {
        var outcome = Outcome()
        let clusters = diarization.clusters
        var clusterTurns: [Int: [SpeakerTurn]] = [:]
        for turn in diarization.turns {
            let start = max(turn.start, windowStart)
            let end = min(turn.end, windowEnd)
            guard end > start else { continue }
            clusterTurns[turn.cluster, default: []].append(SpeakerTurn(start: start, end: end, cluster: turn.cluster))
        }
        let speech = clusterTurns.mapValues { $0.reduce(0) { $0 + $1.duration } }

        // What was already said inside the window, and by whom.
        let previous = turns.compactMap { turn -> LabelledTurn? in
            let start = max(turn.start, windowStart)
            let end = min(turn.end, windowEnd)
            return end > start ? LabelledTurn(start: start, end: end, speaker: turn.speaker) : nil
        }

        // 1. By time: seconds each cluster shares with each known voice.
        struct Pair { var cluster: Int; var order: Int; var id: String; var seconds: Double; var weight: Double }
        var pairs: [Pair] = []
        for (order, cluster) in clusters.enumerated() {
            guard let own = clusterTurns[cluster] else { continue }
            var shared: [String: Double] = [:]
            for turn in own {
                for old in previous where old.end > turn.start && old.start < turn.end {
                    shared[old.speaker, default: 0] += min(turn.end, old.end) - max(turn.start, old.start)
                }
            }
            let needed = min(policy.minOverlapSeconds, 0.5 * (speech[cluster] ?? 0))
            for (id, seconds) in shared where seconds >= needed && seconds > 0 {
                let weight = seconds * (named.contains(id) ? policy.namedBoost : 1)
                pairs.append(Pair(cluster: cluster, order: order, id: id, seconds: seconds, weight: weight))
            }
        }
        pairs.sort {
            if $0.weight != $1.weight { return $0.weight > $1.weight }
            if $0.order != $1.order { return $0.order < $1.order }
            return $0.id < $1.id
        }
        var used: Set<String> = []
        var promoted: [String: String] = [:]
        for pair in pairs where outcome.assignment[pair.cluster] == nil && !used.contains(pair.id) {
            outcome.assignment[pair.cluster] = pair.id
            used.insert(pair.id)
        }
        // A provisional voice that is still a voice of its own in this pass
        // is real: it becomes a speaker (in order of first appearance).
        for cluster in clusters {
            guard let id = outcome.assignment[cluster], Self.isProvisional(id) else { continue }
            let real = makeSpeaker()
            promoted[id] = real
            outcome.assignment[cluster] = real
            outcome.created.append(real)
            used.insert(real)
        }
        if !promoted.isEmpty {
            for index in voices.indices where promoted[voices[index].id] != nil {
                voices[index].id = promoted[voices[index].id]!
                voices[index].isProvisional = false
            }
            for index in turns.indices where promoted[turns[index].speaker] != nil {
                turns[index].speaker = promoted[turns[index].speaker]!
            }
        }

        // 2. By voice: a cluster nobody was heard saying may be a known
        // voice that came back after a silence longer than the window.
        var candidates = voices.filter { !used.contains($0.id) && !$0.print.isEmpty }
        for cluster in clusters where outcome.assignment[cluster] == nil {
            guard let seconds = speech[cluster], seconds > 0 else { continue }
            let print = diarization.voicePrints[cluster] ?? []
            var nearest: (index: Int, distance: Float)?
            if !print.isEmpty {
                for (index, voice) in candidates.enumerated() {
                    let distance = VoicePrint.distance(print, voice.print)
                    if nearest == nil || distance < nearest!.distance { nearest = (index, distance) }
                }
            }
            if let nearest, nearest.distance <= policy.sameVoiceDistance {
                let id = candidates.remove(at: nearest.index).id
                outcome.assignment[cluster] = id
                used.insert(id)
            } else if final || ((candidates.isEmpty || seconds >= policy.reliablePrintSeconds) && seconds >= policy.minNewSpeakerSeconds) {
                if final || seconds >= policy.confidentNewSpeakerSeconds {
                    let id = makeSpeaker()
                    outcome.assignment[cluster] = id
                    outcome.created.append(id)
                    used.insert(id)
                    voices.append(KnownVoice(id: id))
                } else {
                    // heard too little to be shown yet: see `confidentNewSpeakerSeconds`
                    provisionalCount += 1
                    let id = "?\(provisionalCount)"
                    outcome.assignment[cluster] = id
                    used.insert(id)
                    voices.append(KnownVoice(id: id, isProvisional: true))
                }
            }
            // otherwise: too little speech to say who it is. It stays
            // without a speaker until a later run hears more of it.
        }

        // 2b. A speaker that was made when a voice came back and its first
        // seconds sounded like nobody known: now that more of it has been
        // heard, it may sound like a known voice that is silent in this
        // window. Then the two are one, and the older one stays (or the one
        // the person named).
        var folded: [String: String] = [:]
        for cluster in clusters {
            guard let id = outcome.assignment[cluster], !Self.isProvisional(id),
                  let seconds = speech[cluster], seconds >= policy.reliablePrintSeconds,
                  let print = diarization.voicePrints[cluster], !print.isEmpty else { continue }
            var nearest: (index: Int, distance: Float)?
            for (index, voice) in candidates.enumerated() where voice.id != id && !voice.isProvisional {
                let distance = VoicePrint.distance(print, voice.print)
                if nearest == nil || distance < nearest!.distance { nearest = (index, distance) }
            }
            guard let nearest, nearest.distance <= policy.sameVoiceDistance else { continue }
            let other = candidates.remove(at: nearest.index).id
            let ownAge = voices.firstIndex { $0.id == id } ?? Int.max
            let otherAge = voices.firstIndex { $0.id == other } ?? Int.max
            var keepsOther = otherAge < ownAge
            if named.contains(id) != named.contains(other) { keepsOther = named.contains(other) }
            let (stays, goes) = keepsOther ? (other, id) : (id, other)
            for index in turns.indices where turns[index].speaker == goes {
                turns[index].speaker = stays
            }
            voices.removeAll { $0.id == goes }
            outcome.assignment[cluster] = stays
            outcome.created.removeAll { $0 == goes }
            used.insert(stays)
            folded[goes] = stays
        }

        // 3. The new turns of the window replace the old ones.
        var kept: [LabelledTurn] = []
        for turn in turns {
            if turn.end <= windowStart || turn.start >= windowEnd {
                kept.append(turn)
            } else {
                if turn.start < windowStart {
                    kept.append(LabelledTurn(start: turn.start, end: windowStart, speaker: turn.speaker))
                }
                if turn.end > windowEnd {
                    kept.append(LabelledTurn(start: windowEnd, end: turn.end, speaker: turn.speaker))
                }
            }
        }
        for cluster in clusters {
            guard let id = outcome.assignment[cluster], let own = clusterTurns[cluster] else { continue }
            kept.append(contentsOf: own.map { LabelledTurn(start: $0.start, end: $0.end, speaker: id) })
        }
        turns = kept.sorted {
            if $0.start != $1.start { return $0.start < $1.start }
            return $0.speaker < $1.speaker
        }

        // 4. Remember each voice by the run that heard the most of it. Never
        // by a run that heard less: as the window slides away from a voice,
        // every pass hears a little less of it, and a print that followed
        // would end up made of its last two seconds.
        for (cluster, id) in outcome.assignment {
            guard let index = voices.firstIndex(where: { $0.id == id }),
                  let print = diarization.voicePrints[cluster], !print.isEmpty,
                  let seconds = speech[cluster] else { continue }
            if voices[index].print.isEmpty || seconds >= min(voices[index].printSeconds, policy.plentyPrintSeconds) {
                voices[index].print = print
                voices[index].printSeconds = seconds
            }
        }

        // 5. A voice with nothing left to its name is gone.
        let alive = Set(turns.map(\.speaker))
        let emptied = voices.map(\.id).filter { !alive.contains($0) && !Self.isProvisional($0) }
        voices.removeAll { !alive.contains($0.id) }
        outcome.retired = folded.keys.sorted() + emptied
        outcome.absorbedBy = folded
        for id in emptied {
            var heirs: [String: Double] = [:]
            for old in previous where old.speaker == id {
                for turn in turns where turn.end > old.start && turn.start < old.end {
                    heirs[turn.speaker, default: 0] += min(turn.end, old.end) - max(turn.start, old.start)
                }
            }
            let heir = heirs.filter { !Self.isProvisional($0.key) }.max { first, second in
                first.value != second.value ? first.value < second.value : first.key > second.key
            }
            if let heir { outcome.absorbedBy[id] = heir.key }
        }
        return outcome
    }

    /// Replaces speaker ids (placeholders by their final ids).
    public mutating func rename(_ mapping: [String: String]) {
        guard !mapping.isEmpty else { return }
        for index in voices.indices {
            if let new = mapping[voices[index].id] { voices[index].id = new }
        }
        for index in turns.indices {
            if let new = mapping[turns[index].speaker] { turns[index].speaker = new }
        }
    }

    /// Forgets voices (after their text was dropped).
    public mutating func remove(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        voices.removeAll { ids.contains($0.id) }
        turns.removeAll { ids.contains($0.speaker) }
    }

    /// The speaker who talks the most between two times, with the seconds.
    public func speaker(from start: Double, to end: Double) -> (id: String, seconds: Double)? {
        var totals: [String: Double] = [:]
        for turn in turns where turn.end > start && turn.start < end && !Self.isProvisional(turn.speaker) {
            totals[turn.speaker, default: 0] += min(end, turn.end) - max(start, turn.start)
        }
        return totals.max { first, second in
            first.value != second.value ? first.value < second.value : first.key > second.key
        }.map { ($0.key, $0.value) }
    }

    /// The turn closest to a moment, when it is within `reach` seconds.
    public func nearestSpeaker(to time: Double, within reach: Double) -> String? {
        var best: (id: String, distance: Double)?
        for turn in turns where !Self.isProvisional(turn.speaker) {
            let distance = time < turn.start ? turn.start - time : (time > turn.end ? time - turn.end : 0)
            if distance <= reach, best == nil || distance < best!.distance {
                best = (turn.speaker, distance)
            }
        }
        return best?.id
    }
}

/// Everything about the speakers of a meeting that has to survive from the
/// live labels to the final transcript: the speakers with their ids,
/// numbers and names, and per track who was heard when and what each voice
/// sounds like.
///
/// `LiveMeetingSession.state` hands it out and `MeetingProcessor` takes it
/// as the starting point, so a name typed against "s2" at minute 3 is on
/// the same voice in the final notes. It is `Codable`: the app can keep it
/// next to the recording and finish a meeting after a crash.
public struct MeetingSpeakerState: Codable, Equatable, Sendable {
    public var mode: MeetingMode
    /// Every speaker that has speech, by number.
    public var speakers: [MeetingSpeaker]
    /// The number the next new speaker gets. Never goes back: the number of
    /// a speaker that disappeared is not used again.
    public var nextNumber: Int
    /// One entry per track: the room (or the only track), then the remote side.
    public var tracks: [TrackSpeakers]

    public init(mode: MeetingMode, speakers: [MeetingSpeaker] = [], nextNumber: Int = 1, tracks: [TrackSpeakers]? = nil) {
        self.mode = mode
        self.speakers = speakers
        self.nextNumber = max(nextNumber, (speakers.map(\.number).max() ?? 0) + 1)
        self.tracks = tracks ?? (mode == .virtual
            ? [TrackSpeakers(side: .room), TrackSpeakers(side: .remote)]
            : [TrackSpeakers(side: nil)])
    }

    /// Makes a speaker for a track and returns its id ("s3").
    public mutating func makeSpeaker(side: MeetingSide?) -> String {
        let number = nextNumber
        nextNumber += 1
        let id = "s\(number)"
        speakers.append(MeetingSpeaker(id: id, number: number, side: side, name: nil))
        return id
    }

    /// Sets or clears the name of a speaker. Returns false for an unknown id.
    @discardableResult
    public mutating func setName(_ name: String?, for id: String) -> Bool {
        guard let index = speakers.firstIndex(where: { $0.id == id }) else { return false }
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        speakers[index].name = trimmed.isEmpty ? nil : trimmed
        return true
    }

    /// The ids that carry a name.
    public var namedIds: Set<String> {
        Set(speakers.filter { $0.name != nil }.map(\.id))
    }

    /// Drops speakers. A name on a dropped speaker goes with it.
    public mutating func removeSpeakers(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        speakers.removeAll { ids.contains($0.id) }
        for index in tracks.indices {
            tracks[index].remove(ids)
        }
    }
}
