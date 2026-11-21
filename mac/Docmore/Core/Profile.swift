import Foundation

/// One signed-in account on one server. Its id names the page origin
/// (`docmore-app://<id>/`), the web data store and the folder on disk.
public struct Profile: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    /// Origin of the server, no trailing slash: `https://wiki.example.com`.
    public var serverURL: String
    public var clientId: String
    public var userId: String
    public var userName: String
    public var userEmail: String
    public var workspaceName: String
    /// The refresh token was refused: local data is kept, the person has to
    /// sign in again before anything reaches the server.
    public var needsSignIn: Bool
    public var createdAt: Date
    public var lastUsedAt: Date
    /// The workspace's default space, where a quick note goes when no space
    /// was chosen yet.
    public var defaultSpaceId: String?

    public init(
        id: String,
        serverURL: String,
        clientId: String,
        userId: String,
        userName: String,
        userEmail: String,
        workspaceName: String,
        needsSignIn: Bool = false,
        createdAt: Date = Date(),
        lastUsedAt: Date = Date(),
        defaultSpaceId: String? = nil
    ) {
        self.id = id
        self.serverURL = serverURL
        self.clientId = clientId
        self.userId = userId
        self.userName = userName
        self.userEmail = userEmail
        self.workspaceName = workspaceName
        self.needsSignIn = needsSignIn
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.defaultSpaceId = defaultSpaceId
    }

    public var server: URL { URL(string: serverURL) ?? URL(string: "http://invalid.invalid")! }

    /// Short label for menus: "Name - host".
    public var displayName: String {
        let host = server.host ?? serverURL
        let person = userName.isEmpty ? userEmail : userName
        return person.isEmpty ? host : "\(person) - \(host)"
    }

    public var appOrigin: String { "\(AppScheme.name)://\(id)" }
}

public enum AppScheme {
    /// Scheme of the page origin served by the app.
    public static let name = "docmore-app"
    /// Scheme of deep links and of the OAuth callback.
    public static let deepLink = "docmore"
    public static let oauthRedirect = "docmore://oauth/callback"
}

public enum ProfileID {
    /// Stable id of an account: the first 16 hex characters of
    /// sha256("<server origin>\n<user id>").
    public static func make(serverURL: String, userId: String) -> String {
        let normalized = ServerAddress.normalize(serverURL)?.absoluteString ?? serverURL
        return String(Hashing.sha256Hex("\(normalized)\n\(userId)").prefix(16))
    }

    public static func isValid(_ id: String) -> Bool {
        id.count == 16 && id.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    /// The web data store wants a UUID. It is derived from the profile id and,
    /// when the data directory was moved (tests), from that directory too, so a
    /// test run never opens the real store of the same account.
    public static func dataStoreUUID(profileId: String, dataRoot: String?) -> UUID {
        let seed = dataRoot.map { "\($0)\n\(profileId)" } ?? profileId
        let hex = Array(Hashing.sha256Hex("docmore-datastore\n\(seed)").prefix(32))
        var bytes = [UInt8](repeating: 0, count: 16)
        for index in 0..<16 {
            bytes[index] = UInt8(String(hex[index * 2...index * 2 + 1]), radix: 16) ?? 0
        }
        // RFC 4122 version 4 layout, so every consumer accepts it.
        bytes[6] = (bytes[6] & 0x0F) | 0x40
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }
}

public enum ServerAddress {
    /// Turns what a person typed into a server origin: scheme and host in lower
    /// case, default ports dropped, no path, no trailing slash.
    public static func normalize(_ input: String) -> URL? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var components = URLComponents(string: withScheme),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else { return nil }
        components.scheme = scheme
        components.host = host.lowercased()
        if (scheme == "http" && components.port == 80) || (scheme == "https" && components.port == 443) {
            components.port = nil
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        return components.url
    }

    /// Addresses worth trying for what was typed. Without a scheme, https
    /// first and then http (a homelab on a tailnet is often plain http).
    public static func candidates(_ input: String) -> [URL] {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        if trimmed.contains("://") {
            return normalize(trimmed).map { [$0] } ?? []
        }
        var result: [URL] = []
        let local = isLocalHost(trimmed)
        let order = local ? ["http", "https"] : ["https", "http"]
        for scheme in order {
            if let url = normalize("\(scheme)://\(trimmed)"), !result.contains(url) {
                result.append(url)
            }
        }
        return result
    }

    static func isLocalHost(_ value: String) -> Bool {
        let host = value.split(separator: "/").first.map(String.init) ?? value
        let bare = host.split(separator: ":").first.map(String.init)?.lowercased() ?? host.lowercased()
        if bare == "localhost" || bare.hasSuffix(".local") || bare.hasSuffix(".localhost") { return true }
        // dotted IPv4
        let parts = bare.split(separator: ".")
        return parts.count == 4 && parts.allSatisfy { UInt8($0) != nil }
    }
}

/// The list of accounts, kept as one JSON file in the data directory.
public final class ProfileStore: @unchecked Sendable {
    private struct Document: Codable {
        var profiles: [Profile] = []
        /// OAuth client registered per server origin (one registration serves
        /// every account of that server on this Mac).
        var clients: [String: String] = [:]
        var activeProfileId: String?
    }

    private let file: URL
    private let lock = NSLock()
    private var document: Document
    /// Called (on the caller's thread) after every change.
    public var onChange: (() -> Void)?

    public init(file: URL) {
        self.file = file
        if let data = try? Data(contentsOf: file),
           let decoded = try? ProfileStore.decoder.decode(Document.self, from: data) {
            document = decoded
        } else {
            document = Document()
        }
    }

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }()

    public var profiles: [Profile] {
        lock.lock(); defer { lock.unlock() }
        return document.profiles
    }

    public var activeProfileId: String? {
        lock.lock(); defer { lock.unlock() }
        return document.activeProfileId
    }

    public var activeProfile: Profile? {
        lock.lock(); defer { lock.unlock() }
        if let id = document.activeProfileId, let match = document.profiles.first(where: { $0.id == id }) {
            return match
        }
        return document.profiles.first
    }

    public func profile(id: String) -> Profile? {
        lock.lock(); defer { lock.unlock() }
        return document.profiles.first { $0.id == id }
    }

    public func clientId(forServer serverURL: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return document.clients[serverURL]
    }

    public func setClientId(_ clientId: String, forServer serverURL: String) {
        mutate { $0.clients[serverURL] = clientId }
    }

    /// Adds the account or updates the stored copy with the same id.
    public func upsert(_ profile: Profile) {
        mutate { document in
            if let index = document.profiles.firstIndex(where: { $0.id == profile.id }) {
                var updated = profile
                updated.createdAt = document.profiles[index].createdAt
                document.profiles[index] = updated
            } else {
                document.profiles.append(profile)
            }
        }
    }

    public func update(id: String, _ change: (inout Profile) -> Void) {
        mutate { document in
            guard let index = document.profiles.firstIndex(where: { $0.id == id }) else { return }
            change(&document.profiles[index])
        }
    }

    public func setActive(_ id: String?) {
        mutate { document in
            document.activeProfileId = id
            if let id, let index = document.profiles.firstIndex(where: { $0.id == id }) {
                document.profiles[index].lastUsedAt = Date()
            }
        }
    }

    public func remove(id: String) {
        mutate { document in
            document.profiles.removeAll { $0.id == id }
            if document.activeProfileId == id {
                document.activeProfileId = document.profiles.first?.id
            }
        }
    }

    private func mutate(_ change: (inout Document) -> Void) {
        lock.lock()
        change(&document)
        let snapshot = document
        lock.unlock()
        if let data = try? ProfileStore.encoder.encode(snapshot) {
            try? AtomicFile.write(data, to: file)
        }
        onChange?()
    }
}
