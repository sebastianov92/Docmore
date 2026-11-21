import Foundation

/// Remembers which path each indexed page opens, so a Spotlight result (which
/// only carries an identifier) can be turned back into a place in the app.
public final class SpotlightMap: @unchecked Sendable {
    private let file: URL
    private let lock = NSLock()
    private var paths: [String: String] = [:]

    public init(file: URL) {
        self.file = file
        if let data = try? Data(contentsOf: file),
           let decoded = try? JSONDecoder().decode([String: String].self, from: data) {
            paths = decoded
        }
    }

    /// `<profile>|<item id>`: unique across accounts, splits back cleanly
    /// because a profile id never contains the separator.
    public static func identifier(profileId: String, itemId: String) -> String {
        "\(profileId)|\(itemId)"
    }

    public static func split(_ identifier: String) -> (profileId: String, itemId: String)? {
        guard let bar = identifier.firstIndex(of: "|") else { return nil }
        let profileId = String(identifier[..<bar])
        let itemId = String(identifier[identifier.index(after: bar)...])
        guard ProfileID.isValid(profileId), !itemId.isEmpty else { return nil }
        return (profileId, itemId)
    }

    public func path(for itemId: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return paths[itemId]
    }

    public var count: Int {
        lock.lock(); defer { lock.unlock() }
        return paths.count
    }

    public func set(_ entries: [(id: String, path: String)]) {
        lock.lock()
        for entry in entries { paths[entry.id] = entry.path }
        persistLocked()
        lock.unlock()
    }

    public func remove(_ ids: [String]) {
        lock.lock()
        for id in ids { paths.removeValue(forKey: id) }
        persistLocked()
        lock.unlock()
    }

    public func clear() {
        lock.lock()
        paths.removeAll()
        persistLocked()
        lock.unlock()
    }

    private func persistLocked() {
        if let data = try? JSONEncoder().encode(paths) {
            try? AtomicFile.write(data, to: file)
        }
    }
}

/// Turns `docmore://` links into a path inside the app.
public enum DeepLink {
    public enum Target: Equatable {
        case path(String)
        case oauthCallback
    }

    public static func parse(_ url: URL) -> Target? {
        guard url.scheme?.lowercased() == AppScheme.deepLink else { return nil }
        let host = url.host?.lowercased() ?? ""
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        switch host {
        case "oauth":
            return .oauthCallback
        case "page":
            let slug = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !slug.isEmpty, !slug.contains("/") else { return nil }
            let encoded = slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? slug
            return .path("/p/\(encoded)")
        case "open":
            guard let path = components?.queryItems?.first(where: { $0.name == "path" })?.value,
                  let safe = sanitize(path: path) else { return nil }
            return .path(safe)
        default:
            return nil
        }
    }

    /// Only paths inside the app: one leading slash, no scheme, no host.
    public static func sanitize(path: String) -> String? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"), !path.contains("\n") else { return nil }
        return path
    }
}
