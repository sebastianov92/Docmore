import Foundation

/// The copies of the web client kept for one account:
///
///     bundle/<hash>/...        one complete copy per bundle hash
///     bundle/<hash>/.manifest.json
///     bundle/current.json      { hash, version, previousHash }
///
/// A new copy is assembled in `<hash>.partial`, verified file by file and
/// renamed into place; only then does `current.json` point at it. The copy
/// that was current before is kept so pages already open keep their files.
public final class BundleStore: @unchecked Sendable {
    public struct Current: Codable, Equatable, Sendable {
        public var hash: String
        public var version: String
        public var previousHash: String?
    }

    public struct Progress: Sendable {
        public let completedFiles: Int
        public let totalFiles: Int
        public let completedBytes: Int
        public let totalBytes: Int

        public var fraction: Double {
            totalBytes > 0 ? Double(completedBytes) / Double(totalBytes) : (totalFiles > 0 ? Double(completedFiles) / Double(totalFiles) : 1)
        }
    }

    public typealias Fetch = @Sendable (BundleFile) async throws -> Data

    public let directory: URL
    private let lock = NSLock()
    private var cachedCurrent: Current?
    private var installing: Task<Current, Error>?

    public init(directory: URL) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        cachedCurrent = readCurrent()
    }

    private var currentFile: URL { directory.appendingPathComponent("current.json") }

    private func readCurrent() -> Current? {
        guard let data = try? Data(contentsOf: currentFile),
              let current = try? JSONDecoder().decode(Current.self, from: data) else { return nil }
        guard FileManager.default.fileExists(atPath: folder(for: current.hash).appendingPathComponent("index.html").path) else {
            return nil
        }
        return current
    }

    public var current: Current? {
        lock.lock(); defer { lock.unlock() }
        return cachedCurrent
    }

    public func folder(for hash: String) -> URL {
        directory.appendingPathComponent(hash, isDirectory: true)
    }

    /// The file on disk for a request, looking first in the bundle the page
    /// was opened with, then in the current one, then in the previous one.
    public func fileURL(path: String, pinnedHash: String?) -> URL? {
        guard BundleVerifier.isSafePath(path) else { return nil }
        let state = current
        var hashes: [String] = []
        for hash in [pinnedHash, state?.hash, state?.previousHash] {
            if let hash, !hashes.contains(hash) { hashes.append(hash) }
        }
        let manager = FileManager.default
        for hash in hashes {
            let candidate = folder(for: hash).appendingPathComponent(path)
            var isDirectory: ObjCBool = false
            if manager.fileExists(atPath: candidate.path, isDirectory: &isDirectory), !isDirectory.boolValue {
                return candidate
            }
        }
        return nil
    }

    /// Path -> hash of the files of an installed bundle.
    public func installedFiles(hash: String) -> [String: String] {
        let manifestFile = folder(for: hash).appendingPathComponent(".manifest.json")
        guard let data = try? Data(contentsOf: manifestFile),
              let manifest = try? JSONDecoder().decode(BundleManifest.self, from: data) else { return [:] }
        var result: [String: String] = [:]
        for file in manifest.files { result[file.path] = file.hash }
        return result
    }

    /// Installs `manifest` unless it already is the current bundle. Concurrent
    /// callers share one installation.
    @discardableResult
    public func install(
        manifest: BundleManifest,
        concurrency: Int = 8,
        fetch: @escaping Fetch,
        progress: (@Sendable (Progress) -> Void)? = nil
    ) async throws -> Current {
        if let current, current.hash == manifest.hash { return current }
        let task: Task<Current, Error> = lock.withLock {
            if let running = installing { return running }
            let created = Task<Current, Error> { [self] in
                try await performInstall(manifest: manifest, concurrency: concurrency, fetch: fetch, progress: progress)
            }
            installing = created
            return created
        }
        defer {
            lock.withLock {
                if installing == task { installing = nil }
            }
        }
        return try await task.value
    }

    private func performInstall(
        manifest: BundleManifest,
        concurrency: Int,
        fetch: @escaping Fetch,
        progress: (@Sendable (Progress) -> Void)?
    ) async throws -> Current {
        try manifest.validate()
        let manager = FileManager.default
        let previous = current
        let final = folder(for: manifest.hash)
        let partial = directory.appendingPathComponent("\(manifest.hash).partial", isDirectory: true)
        try? manager.removeItem(at: partial)
        try manager.createDirectory(at: partial, withIntermediateDirectories: true)

        let installed = previous.map { installedFiles(hash: $0.hash) } ?? [:]
        let plan = BundlePlan.make(manifest: manifest, installed: installed)
        let counter = ProgressCounter(totalFiles: manifest.files.count, totalBytes: manifest.totalSize, report: progress)

        var toDownload = plan.download
        if let previous {
            let source = folder(for: previous.hash)
            for file in plan.reuse {
                let from = source.appendingPathComponent(file.path)
                let to = partial.appendingPathComponent(file.path)
                try manager.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
                do {
                    // a hard link costs no space; fall back to a copy
                    do { try manager.linkItem(at: from, to: to) } catch { try manager.copyItem(at: from, to: to) }
                    counter.add(bytes: file.size)
                } catch {
                    toDownload.append(file)
                }
            }
        } else {
            toDownload.append(contentsOf: plan.reuse)
        }

        try await withThrowingTaskGroup(of: Void.self) { group in
            var iterator = toDownload.makeIterator()
            var running = 0
            func startNext() -> Bool {
                guard let file = iterator.next() else { return false }
                group.addTask {
                    let data = try await fetch(file)
                    guard BundleVerifier.matches(data, expected: file.hash) else {
                        throw BundleError.hashMismatch(path: file.path)
                    }
                    let target = partial.appendingPathComponent(file.path)
                    try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try data.write(to: target)
                    counter.add(bytes: file.size)
                }
                return true
            }
            while running < max(1, concurrency), startNext() { running += 1 }
            while try await group.next() != nil {
                if startNext() { continue }
            }
        }

        let manifestData = try JSONEncoder().encode(manifest)
        try manifestData.write(to: partial.appendingPathComponent(".manifest.json"))

        // a leftover copy of the same hash is incomplete or stale: replace it
        if manager.fileExists(atPath: final.path) {
            try manager.removeItem(at: final)
        }
        try manager.moveItem(at: partial, to: final)

        let next = Current(hash: manifest.hash, version: manifest.version, previousHash: previous?.hash)
        try AtomicFile.write(try JSONEncoder().encode(next), to: currentFile)
        lock.withLock { cachedCurrent = next }
        return next
    }

    /// Removes every copy that is neither current nor previous, and leftovers
    /// of interrupted installations. `keeping` protects copies in use by open
    /// pages.
    public func prune(keeping pinned: Set<String> = []) {
        let manager = FileManager.default
        let state = current
        var keep = pinned
        if let state {
            keep.insert(state.hash)
            if let previous = state.previousHash { keep.insert(previous) }
        }
        guard let entries = try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        lock.lock()
        let busy = installing != nil
        lock.unlock()
        for entry in entries {
            let name = entry.lastPathComponent
            if name == "current.json" { continue }
            if name.hasSuffix(".partial") {
                if !busy { try? manager.removeItem(at: entry) }
                continue
            }
            if !keep.contains(name) {
                try? manager.removeItem(at: entry)
            }
        }
    }

    public func sizeOnDisk() -> Int64 {
        DiskUsage.size(of: directory)
    }

    public func removeAll() {
        lock.lock()
        cachedCurrent = nil
        lock.unlock()
        try? FileManager.default.removeItem(at: directory)
    }
}

private final class ProgressCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var files = 0
    private var bytes = 0
    private let totalFiles: Int
    private let totalBytes: Int
    private let report: (@Sendable (BundleStore.Progress) -> Void)?

    init(totalFiles: Int, totalBytes: Int, report: (@Sendable (BundleStore.Progress) -> Void)?) {
        self.totalFiles = totalFiles
        self.totalBytes = totalBytes
        self.report = report
    }

    func add(bytes count: Int) {
        lock.lock()
        files += 1
        bytes += count
        let snapshot = BundleStore.Progress(completedFiles: files, totalFiles: totalFiles, completedBytes: bytes, totalBytes: totalBytes)
        lock.unlock()
        report?(snapshot)
    }
}
