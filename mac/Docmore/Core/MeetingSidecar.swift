import Foundation

/// What is written next to the audio of a recording until its transcript is
/// queued: where the notes go, the kind of meeting, the live meeting on the
/// server and the voices with the names typed so far. A recording that could
/// not be finished (the app quit or crashed, no model yet) is finished later
/// from this file and keeps all of it.
public struct MeetingSidecar: Codable, Equatable, Sendable {
    public var profileId: String
    public var pageId: String?
    public var spaceId: String?
    public var title: String?
    public var mode: MeetingMode
    /// The live meeting this recording belongs to on the server.
    public var meetingId: String?
    public var speakers: [MeetingSpeaker]

    public init(
        profileId: String,
        pageId: String? = nil,
        spaceId: String? = nil,
        title: String? = nil,
        mode: MeetingMode,
        meetingId: String? = nil,
        speakers: [MeetingSpeaker] = []
    ) {
        self.profileId = profileId
        self.pageId = pageId
        self.spaceId = spaceId
        self.title = title
        self.mode = mode
        self.meetingId = meetingId
        self.speakers = speakers
    }

    enum CodingKeys: String, CodingKey { case profileId, pageId, spaceId, title, mode, meetingId, speakers }

    /// A file written before meetings had a kind has one mixed track and no
    /// speakers: it reads as an in-person meeting.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        profileId = try container.decode(String.self, forKey: .profileId)
        pageId = try container.decodeIfPresent(String.self, forKey: .pageId)
        spaceId = try container.decodeIfPresent(String.self, forKey: .spaceId)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        mode = (try? container.decode(MeetingMode.self, forKey: .mode)) ?? .inPerson
        meetingId = try? container.decodeIfPresent(String.self, forKey: .meetingId)
        speakers = (try? container.decode([MeetingSpeaker].self, forKey: .speakers)) ?? []
    }

    // MARK: On disk

    /// `<audio file>.json`, next to the audio.
    public static func url(forAudio audio: URL) -> URL {
        audio.deletingLastPathComponent().appendingPathComponent(audio.lastPathComponent + ".json")
    }

    /// The audio file a sidecar belongs to.
    public static func audio(forSidecar sidecar: URL) -> URL {
        sidecar.deletingPathExtension()
    }

    public static func read(forAudio audio: URL) -> MeetingSidecar? {
        guard let data = try? Data(contentsOf: url(forAudio: audio)) else { return nil }
        return try? JSONDecoder().decode(MeetingSidecar.self, from: data)
    }

    public func write(forAudio audio: URL) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self) else { return }
        try? AtomicFile.write(data, to: Self.url(forAudio: audio))
    }

    public static func remove(forAudio audio: URL) {
        try? FileManager.default.removeItem(at: url(forAudio: audio))
    }

    /// The sidecars in a folder of recordings, oldest first (the file names
    /// carry the time).
    public static func all(in directory: URL) -> [URL] {
        ((try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasSuffix(".wav.json") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// The speakers of a transcript made later, carrying the names kept
    /// here; a speaker with no name here keeps the one the transcript has.
    public func named(_ transcriptSpeakers: [MeetingSpeaker]) -> [MeetingSpeaker] {
        let names = Dictionary(speakers.compactMap { speaker in speaker.name.map { (speaker.id, $0) } }, uniquingKeysWith: { first, _ in first })
        return transcriptSpeakers.map { speaker in
            var copy = speaker
            if let name = names[speaker.id] { copy.name = name }
            return copy
        }
    }
}
