import Foundation

public struct BundleFile: Codable, Hashable, Sendable {
    public let path: String
    public let size: Int
    /// First 32 hex characters of the file's sha256.
    public let hash: String

    public init(path: String, size: Int, hash: String) {
        self.path = path
        self.size = size
        self.hash = hash
    }
}

/// The web client a server serves, file by file (`GET /api/sync/client-bundle`).
public struct BundleManifest: Codable, Equatable, Sendable {
    public let hash: String
    public let version: String
    public let files: [BundleFile]

    public init(hash: String, version: String, files: [BundleFile]) {
        self.hash = hash
        self.version = version
        self.files = files
    }

    /// Decodes the manifest whether or not it is wrapped in `{ "data": ... }`.
    public static func decode(_ data: Data) throws -> BundleManifest {
        struct Envelope: Decodable { let data: BundleManifest }
        let decoder = JSONDecoder()
        if let wrapped = try? decoder.decode(Envelope.self, from: data) {
            return wrapped.data
        }
        return try decoder.decode(BundleManifest.self, from: data)
    }

    public var totalSize: Int { files.reduce(0) { $0 + $1.size } }

    /// A manifest the app is willing to install: a real hash, an index.html
    /// and no path that could leave the bundle folder.
    public func validate() throws {
        guard BundleVerifier.isHash(hash) else { throw BundleError.invalidManifest("bad bundle hash") }
        guard !files.isEmpty else { throw BundleError.invalidManifest("no files") }
        guard files.contains(where: { $0.path == "index.html" }) else {
            throw BundleError.invalidManifest("no index.html")
        }
        var seen = Set<String>()
        for file in files {
            guard BundleVerifier.isSafePath(file.path) else {
                throw BundleError.invalidManifest("unsafe path \(file.path)")
            }
            guard BundleVerifier.isHash(file.hash) else {
                throw BundleError.invalidManifest("bad hash for \(file.path)")
            }
            guard seen.insert(file.path).inserted else {
                throw BundleError.invalidManifest("duplicate path \(file.path)")
            }
        }
    }
}

public enum BundleError: Error, Equatable, LocalizedError {
    case invalidManifest(String)
    case hashMismatch(path: String)
    case download(path: String, detail: String)

    public var errorDescription: String? {
        switch self {
        case .invalidManifest(let detail): return L("The app files listed by the server are not valid: %@", detail)
        case .hashMismatch(let path): return L("The downloaded file %@ does not match its checksum", path)
        case .download(let path, let detail): return L("Could not download %@: %@", path, detail)
        }
    }
}

public enum BundleVerifier {
    public static func hash32(_ data: Data) -> String {
        String(Hashing.sha256Hex(data).prefix(32))
    }

    public static func matches(_ data: Data, expected: String) -> Bool {
        hash32(data) == expected.lowercased()
    }

    public static func isHash(_ value: String) -> Bool {
        value.count == 32 && value.allSatisfy { $0.isHexDigit }
    }

    public static func isSafePath(_ path: String) -> Bool {
        if path.isEmpty || path.hasPrefix("/") || path.contains("\\") || path.contains("\0") { return false }
        for part in path.split(separator: "/", omittingEmptySubsequences: false) {
            if part.isEmpty || part == "." || part == ".." { return false }
        }
        return true
    }
}

/// What installing a manifest takes, given the files already on disk.
public struct BundlePlan: Equatable, Sendable {
    /// Same path and same hash as an installed file: copied, not downloaded.
    public let reuse: [BundleFile]
    public let download: [BundleFile]

    public var downloadSize: Int { download.reduce(0) { $0 + $1.size } }

    /// `installed` maps a path to the hash of the copy on disk.
    public static func make(manifest: BundleManifest, installed: [String: String]) -> BundlePlan {
        var reuse: [BundleFile] = []
        var download: [BundleFile] = []
        for file in manifest.files {
            if installed[file.path] == file.hash {
                reuse.append(file)
            } else {
                download.append(file)
            }
        }
        return BundlePlan(reuse: reuse, download: download)
    }
}
