import Foundation
import WhisperKit

public enum ModelStoreError: Error, LocalizedError, Equatable, Sendable {
    case downloadFailed(String)
    case deleteFailed(String)

    public var errorDescription: String? {
        switch self {
        case .downloadFailed(let detail): return "The model could not be downloaded: \(detail)"
        case .deleteFailed(let detail): return "The model could not be deleted: \(detail)"
        }
    }
}

/// The Whisper models on disk, in a directory the caller gives.
///
/// Layout (the one WhisperKit's Hub client uses, so its own tools read it):
///
///     <directory>/models/argmaxinc/whisperkit-coreml/<model id>/   the Core ML model
///     <directory>/models/openai/whisper-<size>/                    its tokenizer
///
/// A model counts as downloaded once every file and the tokenizer are there
/// (a marker file is written at the end), so an interrupted download is
/// never taken for a complete one. After that nothing here or in
/// `Transcriber` touches the network.
public final class ModelStore: @unchecked Sendable {
    public let directory: URL
    /// Hugging Face compatible endpoint, for a mirror. Nil: huggingface.co.
    public let endpoint: String?

    static let modelRepo = "argmaxinc/whisperkit-coreml"
    static let markerName = ".meetingkit-complete"
    static let tokenizerFiles = ["tokenizer.json", "tokenizer_config.json", "config.json"]

    private let lock = NSLock()
    private var inFlight: [String: Task<Void, Error>] = [:]

    public init(directory: URL, endpoint: String? = nil) {
        self.directory = directory
        self.endpoint = endpoint
    }

    /// Where the Core ML files of a model are (whether or not they exist).
    public func modelFolder(for model: WhisperModelInfo) -> URL {
        repoFolder(Self.modelRepo).appendingPathComponent(model.id, isDirectory: true)
    }

    /// Where the tokenizer of a model is (whether or not it exists).
    public func tokenizerFolder(for model: WhisperModelInfo) -> URL {
        repoFolder(model.tokenizerRepo)
    }

    public func isDownloaded(_ model: WhisperModelInfo) -> Bool {
        let manager = FileManager.default
        let folder = modelFolder(for: model)
        guard manager.fileExists(atPath: folder.appendingPathComponent(Self.markerName).path) else { return false }
        for name in ["MelSpectrogram", "AudioEncoder", "TextDecoder"] {
            guard manager.fileExists(atPath: folder.appendingPathComponent("\(name).mlmodelc").path) else { return false }
        }
        return manager.fileExists(atPath: tokenizerFolder(for: model).appendingPathComponent("tokenizer.json").path)
    }

    /// The models of the catalog that are on disk.
    public func downloadedModels() -> [WhisperModelInfo] {
        WhisperModelCatalog.all.filter(isDownloaded)
    }

    /// Bytes the model takes on disk (0 when absent). The tokenizer, a few
    /// megabytes shared between models of one size, is not counted.
    public func sizeOnDisk(_ model: WhisperModelInfo) -> Int64 {
        Self.directorySize(modelFolder(for: model))
    }

    /// Downloads the model and its tokenizer. `progress` gets 0...1 from an
    /// arbitrary thread. Files already on disk are not fetched again, so a
    /// download that was cut continues where it stopped. Cancelling the
    /// calling task cancels the download.
    ///
    /// Two calls for the same model at once share one download (only the
    /// first caller gets progress).
    public func download(_ model: WhisperModelInfo, progress: ((Double) -> Void)? = nil) async throws {
        let (task, joined): (Task<Void, Error>, Bool) = lock.withLock {
            if let running = inFlight[model.id] { return (running, true) }
            let made = Task { try await self.performDownload(model, progress: progress) }
            inFlight[model.id] = made
            return (made, false)
        }
        if joined { return try await task.value }
        defer { lock.withLock { inFlight[model.id] = nil } }
        try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    /// Removes the model. Its tokenizer goes too unless another downloaded
    /// model of the catalog uses it.
    public func delete(_ model: WhisperModelInfo) throws {
        let manager = FileManager.default
        do {
            let folder = modelFolder(for: model)
            if manager.fileExists(atPath: folder.path) {
                try manager.removeItem(at: folder)
            }
            // the Hub client's bookkeeping for those files
            let metadata = repoFolder(Self.modelRepo).appendingPathComponent(".cache/huggingface/download/\(model.id)")
            if manager.fileExists(atPath: metadata.path) {
                try manager.removeItem(at: metadata)
            }
            let shared = WhisperModelCatalog.all.contains {
                $0.id != model.id && $0.tokenizerRepo == model.tokenizerRepo && isDownloaded($0)
            }
            let tokenizer = tokenizerFolder(for: model)
            if !shared, manager.fileExists(atPath: tokenizer.path) {
                try manager.removeItem(at: tokenizer)
            }
        } catch {
            throw ModelStoreError.deleteFailed(error.localizedDescription)
        }
    }

    /// Asks the repository for the files of a model without downloading them.
    /// Returns how many there are; throws when the identifier does not exist
    /// or the network is down. A diagnostic: `meetingkit models --check`.
    public func remoteFileCount(_ model: WhisperModelInfo) async throws -> Int {
        let hub = HubApiWrapper(downloadBase: directory, endpoint: endpoint)
        let files = try await hub.getFilenames(from: HubApiWrapper.Repo(id: Self.modelRepo), matching: ["\(model.id)/*"])
        guard !files.isEmpty else {
            throw ModelStoreError.downloadFailed("no files for \(model.id) in \(Self.modelRepo)")
        }
        return files.count
    }

    // MARK: - Internals

    private func repoFolder(_ repo: String) -> URL {
        var url = directory.appendingPathComponent("models", isDirectory: true)
        for part in repo.split(separator: "/") {
            url.appendPathComponent(String(part), isDirectory: true)
        }
        return url
    }

    private func performDownload(_ model: WhisperModelInfo, progress: ((Double) -> Void)?) async throws {
        let manager = FileManager.default
        do {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            throw ModelStoreError.downloadFailed(error.localizedDescription)
        }
        let marker = modelFolder(for: model).appendingPathComponent(Self.markerName)
        try? manager.removeItem(at: marker)
        progress?(0)
        do {
            // The model: almost all of the bytes.
            let folder = try await WhisperKit.download(
                variant: model.id,
                downloadBase: directory,
                from: Self.modelRepo,
                endpoint: endpoint ?? Constants.defaultRemoteEndpoint,
                progressCallback: { value in progress?(min(0.97, value.fractionCompleted * 0.97)) }
            )
            guard folder.standardizedFileURL.path == modelFolder(for: model).standardizedFileURL.path else {
                throw ModelStoreError.downloadFailed("unexpected download location \(folder.path)")
            }
            try Task.checkCancellation()
            // The tokenizer: WhisperKit looks for it in this same layout.
            let hub = HubApiWrapper(downloadBase: directory, endpoint: endpoint)
            _ = try await hub.snapshot(from: HubApiWrapper.Repo(id: model.tokenizerRepo), matching: Self.tokenizerFiles)
            guard manager.fileExists(atPath: tokenizerFolder(for: model).appendingPathComponent("tokenizer.json").path) else {
                throw ModelStoreError.downloadFailed("the tokenizer of \(model.id) did not arrive")
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as ModelStoreError {
            throw error
        } catch {
            throw ModelStoreError.downloadFailed(error.localizedDescription)
        }
        manager.createFile(atPath: marker.path, contents: Data(model.id.utf8))
        progress?(1)
    }

    static func directorySize(_ url: URL) -> Int64 {
        guard let enumerator = FileManager.default.enumerator(
            at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey]
        ) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in enumerator {
            guard let values = try? file.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey]),
                  values.isRegularFile == true else { continue }
            total += Int64(values.totalFileAllocatedSize ?? 0)
        }
        return total
    }
}
