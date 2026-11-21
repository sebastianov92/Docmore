import CryptoKit
import Foundation

/// Where the app keeps everything it stores, and which defaults it uses.
///
/// `DOCMORE_DATA_DIR` moves the whole tree somewhere else (tests, automation).
/// When it is set the app also switches to a separate `UserDefaults` suite and
/// to a file-based token store, so a test run never touches real user data.
public struct AppPaths: Sendable {
    public let root: URL
    /// True when `DOCMORE_DATA_DIR` moved the data somewhere else.
    public let isOverridden: Bool

    public init(root: URL, isOverridden: Bool) {
        self.root = root
        self.isOverridden = isOverridden
    }

    public static let shared: AppPaths = resolve(environment: ProcessInfo.processInfo.environment)

    public static func resolve(environment: [String: String]) -> AppPaths {
        if let custom = environment["DOCMORE_DATA_DIR"], !custom.isEmpty {
            let url = URL(fileURLWithPath: (custom as NSString).expandingTildeInPath, isDirectory: true)
            return AppPaths(root: url.standardizedFileURL, isOverridden: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return AppPaths(root: base.appendingPathComponent("Docmore", isDirectory: true), isOverridden: false)
    }

    // MARK: Layout

    public var profilesFile: URL { root.appendingPathComponent("profiles.json") }
    public var tokensFile: URL { root.appendingPathComponent("tokens.json") }
    public var deviceFile: URL { root.appendingPathComponent("device.json") }
    public var windowsFile: URL { root.appendingPathComponent("windows.json") }
    public var profilesDir: URL { root.appendingPathComponent("profiles", isDirectory: true) }
    public var meetingsDir: URL { root.appendingPathComponent("meetings", isDirectory: true) }
    public var meetingJobsDir: URL { meetingsDir.appendingPathComponent("jobs", isDirectory: true) }
    public var meetingAudioDir: URL { meetingsDir.appendingPathComponent("audio", isDirectory: true) }
    public var modelsDir: URL { root.appendingPathComponent("models", isDirectory: true) }
    public var captureQueueDir: URL { root.appendingPathComponent("capture-queue", isDirectory: true) }

    public func profileDir(_ profileId: String) -> URL {
        profilesDir.appendingPathComponent(profileId, isDirectory: true)
    }

    public func bundleDir(_ profileId: String) -> URL {
        profileDir(profileId).appendingPathComponent("bundle", isDirectory: true)
    }

    public func filesDir(_ profileId: String) -> URL {
        profileDir(profileId).appendingPathComponent("files", isDirectory: true)
    }

    // MARK: Defaults

    /// The suite used while `DOCMORE_DATA_DIR` is set. It carries a short hash
    /// of the directory so two test runs never share settings.
    public var defaultsSuiteName: String? {
        guard isOverridden else { return nil }
        let digest = SHA256.hash(data: Data(root.path.utf8))
        let short = digest.prefix(6).map { String(format: "%02x", $0) }.joined()
        return "com.dezik.docmore.test-\(short)"
    }

    public func makeDefaults() -> UserDefaults {
        if let suite = defaultsSuiteName, let defaults = UserDefaults(suiteName: suite) {
            return defaults
        }
        return .standard
    }

    @discardableResult
    public func ensure(_ directory: URL) -> URL {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

public enum DiskUsage {
    /// Total size of the regular files under `url` (0 when it does not exist).
    public static func size(of url: URL) -> Int64 {
        let manager = FileManager.default
        var isDirectory: ObjCBool = false
        guard manager.fileExists(atPath: url.path, isDirectory: &isDirectory) else { return 0 }
        if !isDirectory.boolValue {
            let attributes = try? manager.attributesOfItem(atPath: url.path)
            return (attributes?[.size] as? NSNumber)?.int64Value ?? 0
        }
        guard let enumerator = manager.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey, .totalFileAllocatedSizeKey, .fileSizeKey],
            options: [],
            errorHandler: nil
        ) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in enumerator {
            guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                  values.isRegularFile == true else { continue }
            total += Int64(values.fileSize ?? 0)
        }
        return total
    }
}

public enum AtomicFile {
    /// Writes through a temporary file in the same directory and renames it
    /// into place, so readers never see half a file.
    public static func write(_ data: Data, to url: URL, permissions: Int? = nil) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temp = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        try data.write(to: temp)
        if let permissions {
            try manager.setAttributes([.posixPermissions: NSNumber(value: permissions)], ofItemAtPath: temp.path)
        }
        if manager.fileExists(atPath: url.path) {
            _ = try manager.replaceItemAt(url, withItemAt: temp)
        } else {
            try manager.moveItem(at: temp, to: url)
        }
    }
}
