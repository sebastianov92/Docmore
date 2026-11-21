import Foundation

/// Files of pages kept for offline use (images, attachments), per account.
///
///     files/index.json     key -> { file, contentType, size, updatedAt }
///     files/blobs/<name>   the bytes; <name> is a hash of the key
///
/// The key is the request path (`/api/files/<id>/<name>`), see `FileCacheKey`.
public final class FileCache: @unchecked Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var file: String
        public var contentType: String
        public var size: Int64
        public var updatedAt: Date
    }

    public let directory: URL
    private let lock = NSLock()
    private var index: [String: Entry] = [:]
    private var blobs: URL { directory.appendingPathComponent("blobs", isDirectory: true) }
    private var indexFile: URL { directory.appendingPathComponent("index.json") }

    public init(directory: URL) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory.appendingPathComponent("blobs"), withIntermediateDirectories: true)
        load()
    }

    private func load() {
        guard let data = try? Data(contentsOf: indexFile) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let decoded = try? decoder.decode([String: Entry].self, from: data) else { return }
        // forget entries whose bytes are gone
        let manager = FileManager.default
        index = decoded.filter { manager.fileExists(atPath: blobs.appendingPathComponent($0.value.file).path) }
    }

    private func persistLocked() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        if let data = try? encoder.encode(index) {
            try? AtomicFile.write(data, to: indexFile)
        }
    }

    public static func blobName(for key: String) -> String {
        String(Hashing.sha256Hex(key).prefix(40))
    }

    public func has(_ key: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return index[key] != nil
    }

    public func entry(_ key: String) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        return index[key]
    }

    public func fileURL(_ key: String) -> URL? {
        guard let entry = entry(key) else { return nil }
        return blobs.appendingPathComponent(entry.file)
    }

    public var keys: [String] {
        lock.lock(); defer { lock.unlock() }
        return Array(index.keys)
    }

    public func store(key: String, data: Data, contentType: String, now: Date = Date()) throws {
        let name = FileCache.blobName(for: key)
        let target = blobs.appendingPathComponent(name)
        try AtomicFile.write(data, to: target)
        lock.lock()
        index[key] = Entry(file: name, contentType: contentType, size: Int64(data.count), updatedAt: now)
        persistLocked()
        lock.unlock()
    }

    /// Takes over a finished download without copying it through memory.
    public func store(key: String, movingFileAt source: URL, contentType: String, now: Date = Date()) throws {
        let manager = FileManager.default
        let name = FileCache.blobName(for: key)
        let target = blobs.appendingPathComponent(name)
        try manager.createDirectory(at: blobs, withIntermediateDirectories: true)
        if manager.fileExists(atPath: target.path) {
            _ = try manager.replaceItemAt(target, withItemAt: source)
        } else {
            try manager.moveItem(at: source, to: target)
        }
        let size = ((try? manager.attributesOfItem(atPath: target.path))?[.size] as? NSNumber)?.int64Value ?? 0
        lock.lock()
        index[key] = Entry(file: name, contentType: contentType, size: size, updatedAt: now)
        persistLocked()
        lock.unlock()
    }

    public func remove(keys: [String]) {
        lock.lock()
        let manager = FileManager.default
        for key in keys {
            if let entry = index.removeValue(forKey: key) {
                try? manager.removeItem(at: blobs.appendingPathComponent(entry.file))
            }
        }
        persistLocked()
        lock.unlock()
    }

    public func clear() {
        lock.lock()
        index.removeAll()
        let manager = FileManager.default
        try? manager.removeItem(at: blobs)
        try? manager.createDirectory(at: blobs, withIntermediateDirectories: true)
        persistLocked()
        lock.unlock()
    }

    public func usage() -> (bytes: Int64, count: Int) {
        lock.lock(); defer { lock.unlock() }
        return (index.values.reduce(0) { $0 + $1.size }, index.count)
    }
}
