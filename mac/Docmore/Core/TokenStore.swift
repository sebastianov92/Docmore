import Foundation
import Security

public struct TokenSet: Codable, Equatable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date

    public init(accessToken: String, refreshToken: String, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }
}

public protocol TokenStore: Sendable {
    func load(profileId: String) -> TokenSet?
    func save(_ tokens: TokenSet, profileId: String) throws
    func delete(profileId: String)
}

/// Tokens in one JSON file readable only by the owner. Used while
/// `DOCMORE_DATA_DIR` is set: an ad-hoc signed build would make the Keychain
/// ask for the login password after every rebuild.
public final class FileTokenStore: TokenStore, @unchecked Sendable {
    private let file: URL
    private let lock = NSLock()

    public init(file: URL) {
        self.file = file
    }

    private func readAll() -> [String: TokenSet] {
        guard let data = try? Data(contentsOf: file) else { return [:] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([String: TokenSet].self, from: data)) ?? [:]
    }

    private func writeAll(_ all: [String: TokenSet]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try AtomicFile.write(try encoder.encode(all), to: file, permissions: 0o600)
    }

    public func load(profileId: String) -> TokenSet? {
        lock.lock(); defer { lock.unlock() }
        return readAll()[profileId]
    }

    public func save(_ tokens: TokenSet, profileId: String) throws {
        lock.lock(); defer { lock.unlock() }
        var all = readAll()
        all[profileId] = tokens
        try writeAll(all)
    }

    public func delete(profileId: String) {
        lock.lock(); defer { lock.unlock() }
        var all = readAll()
        all.removeValue(forKey: profileId)
        try? writeAll(all)
    }
}

/// Tokens as generic passwords in the login Keychain, one item per account.
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service: String
    /// The Keychain is slow and may prompt; keep what was read in memory.
    private var cache: [String: TokenSet] = [:]
    private let lock = NSLock()

    public init(service: String = "com.dezik.docmore.tokens") {
        self.service = service
    }

    private func query(_ profileId: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: profileId,
        ]
    }

    public func load(profileId: String) -> TokenSet? {
        lock.lock(); defer { lock.unlock() }
        if let cached = cache[profileId] { return cached }
        var request = query(profileId)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let tokens = try? decoder.decode(TokenSet.self, from: data) else { return nil }
        cache[profileId] = tokens
        return tokens
    }

    public func save(_ tokens: TokenSet, profileId: String) throws {
        lock.lock(); defer { lock.unlock() }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(tokens)
        let update: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(query(profileId) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = query(profileId)
            add[kSecValueData as String] = data
            add[kSecAttrLabel as String] = "Docmore sign-in"
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [
                NSLocalizedDescriptionKey: "The Keychain refused to store the sign-in (\(status))",
            ])
        }
        cache[profileId] = tokens
    }

    public func delete(profileId: String) {
        lock.lock(); defer { lock.unlock() }
        cache.removeValue(forKey: profileId)
        SecItemDelete(query(profileId) as CFDictionary)
    }
}
