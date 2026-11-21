import Foundation

/// Decides who answers a request made by the page to `docmore-app://<profile>/`.
public enum RequestRoute: Equatable, Sendable {
    /// Forwarded to `<server>/api/...` with the sign-in added.
    case api
    /// `GET /api/files/...` or `GET /api/attachments/...`: the server when it
    /// answers, the offline file cache when it does not.
    case cachedFile(key: String)
    /// A file of the cached web client; `path` is relative, no leading slash.
    case staticFile(path: String)
    /// Refused before touching the disk or the network.
    case invalid
}

public enum RequestRouter {
    public static func route(method: String, path rawPath: String) -> RequestRoute {
        let path = rawPath.isEmpty ? "/" : rawPath
        if path == "/api" || path.hasPrefix("/api/") {
            if method.uppercased() == "GET", FileCacheKey.isCacheable(path: path) {
                return .cachedFile(key: FileCacheKey.normalize(path: path))
            }
            return .api
        }
        guard let relative = safeRelativePath(path) else { return .invalid }
        return .staticFile(path: relative.isEmpty ? "index.html" : relative)
    }

    /// The path without its leading slash, percent-decoded, or nil when it
    /// tries to leave the folder.
    public static func safeRelativePath(_ path: String) -> String? {
        let decoded = path.removingPercentEncoding ?? path
        if decoded.contains("\0") || decoded.contains("\\") { return nil }
        var parts: [String] = []
        for part in decoded.split(separator: "/", omittingEmptySubsequences: true) {
            if part == ".." { return nil }
            if part == "." { continue }
            parts.append(String(part))
        }
        return parts.joined(separator: "/")
    }

    /// A single page app route: no file by that name and nothing that looks
    /// like a file extension, so `index.html` answers and the router inside
    /// the page takes over.
    public static func servesIndexFallback(path: String, fileExists: Bool) -> Bool {
        if fileExists { return false }
        return ContentTypes.fileExtension(of: path).isEmpty
    }
}

public enum FileCacheKey {
    private static let prefixes = ["/api/files/", "/api/attachments/"]

    public static func isCacheable(path: String) -> Bool {
        prefixes.contains { path.hasPrefix($0) }
    }

    /// One spelling per file: the decoded path, no query, no fragment.
    public static func normalize(path: String) -> String {
        var value = path
        if let cut = value.firstIndex(where: { $0 == "?" || $0 == "#" }) {
            value = String(value[..<cut])
        }
        return value.removingPercentEncoding ?? value
    }

    /// Accepts what the page sends in bridge messages: "/api/files/<id>/<name>",
    /// the same with a query, or a full URL on the app origin or the server.
    public static func key(for urlString: String) -> String? {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        var path = trimmed
        if let schemeRange = trimmed.range(of: "://") {
            let afterScheme = trimmed[schemeRange.upperBound...]
            guard let slash = afterScheme.firstIndex(of: "/") else { return nil }
            path = String(afterScheme[slash...])
        }
        guard path.hasPrefix("/") else { return nil }
        let normalized = normalize(path: path)
        guard isCacheable(path: normalized), !normalized.contains("/../") else { return nil }
        return normalized
    }
}

/// `Range: bytes=a-b` for answers served from disk.
public enum ByteRange {
    public static func parse(_ header: String?, fileSize: Int64) -> ClosedRange<Int64>? {
        guard let header, fileSize > 0 else { return nil }
        let value = header.trimmingCharacters(in: .whitespaces).lowercased()
        guard value.hasPrefix("bytes=") else { return nil }
        let spec = value.dropFirst(6)
        guard !spec.contains(",") else { return nil }
        let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let first = String(parts[0]), last = String(parts[1])
        if first.isEmpty {
            // suffix: the last N bytes
            guard let count = Int64(last), count > 0 else { return nil }
            let start = max(0, fileSize - count)
            return start...(fileSize - 1)
        }
        guard let start = Int64(first), start < fileSize else { return nil }
        if last.isEmpty { return start...(fileSize - 1) }
        guard let end = Int64(last), end >= start else { return nil }
        return start...min(end, fileSize - 1)
    }
}

extension FileCacheKey {
    /// The path to ask the server for, percent-encoded again from the key.
    public static func requestPath(forKey key: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "?#%")
        return key.addingPercentEncoding(withAllowedCharacters: allowed) ?? key
    }
}
