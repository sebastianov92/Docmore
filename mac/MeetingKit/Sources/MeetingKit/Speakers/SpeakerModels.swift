import ArgmaxCore
import CoreML
import Foundation
import SpeakerKit
import WhisperKit

/// The models that tell voices apart (speaker diarization): a segmenter, a
/// voice embedder and a small projector, all run by SpeakerKit on Core ML.
public struct SpeakerModelInfo: Identifiable, Hashable, Codable, Sendable {
    /// Stable identifier for the app's settings ("pyannote-community-1").
    public let id: String
    /// Name for a menu ("Speaker recognition").
    public let displayName: String
    /// Download size in bytes, rounded.
    public let approximateSizeBytes: Int64
    /// One line about what it is.
    public let summary: String

    public init(id: String, displayName: String, approximateSizeBytes: Int64, summary: String = "") {
        self.id = id
        self.displayName = displayName
        self.approximateSizeBytes = approximateSizeBytes
        self.summary = summary
    }
}

/// The speaker models MeetingKit offers. One set today.
public enum SpeakerModelCatalog {
    /// Pyannote "community-1" as SpeakerKit 1.1.1 runs it: segmenter and
    /// embedder with 8-bit weights, plus the PLDA projector. About 11 MB.
    public static let pyannote = SpeakerModelInfo(
        id: "pyannote-community-1",
        displayName: "Speaker recognition",
        approximateSizeBytes: 11_300_000,
        summary: "Tells voices apart on this Mac (Pyannote on Core ML)."
    )

    public static let all: [SpeakerModelInfo] = [pyannote]

    public static let recommended = pyannote

    /// Looks a set up by its identifier, or by a short name: "pyannote",
    /// "speakers".
    public static func model(_ idOrAlias: String) -> SpeakerModelInfo? {
        if let exact = all.first(where: { $0.id == idOrAlias }) { return exact }
        switch idOrAlias.lowercased() {
        case "pyannote", "speakers", "speaker": return pyannote
        default: return nil
        }
    }
}

/// Where the three parts of a speaker model set are in the repository and
/// on disk. They are the defaults SpeakerKit uses on macOS 15 and later,
/// written out so the download and the loader can never disagree.
struct SpeakerModelParts {
    let segmenter: ModelInfo
    let embedder: ModelInfo
    let projector: ModelInfo

    static let pyannote = SpeakerModelParts(
        segmenter: ModelInfo(version: "pyannote-v3", variant: "W8A16", name: "speaker_segmenter", computeUnits: .cpuOnly),
        embedder: ModelInfo(version: "pyannote-v3", variant: "W8A16", name: "speaker_embedder", computeUnits: .cpuAndNeuralEngine),
        projector: ModelInfo(version: "pyannote-v4", variant: "W32A32", name: "speaker_clusterer", computeUnits: .cpuOnly)
    )

    static func parts(for model: SpeakerModelInfo) -> SpeakerModelParts { pyannote }

    /// The compiled models the loader opens, relative to the repository folder.
    var requiredModels: [String] {
        [
            "\(segmenter.description)/SpeakerSegmenter.mlmodelc",
            "\(embedder.description)/SpeakerEmbedderPreprocessor.mlmodelc",
            "\(embedder.description)/SpeakerEmbedder.mlmodelc",
            "\(projector.description)/PldaProjector.mlmodelc",
        ]
    }

    var downloadPatterns: [String] {
        [segmenter.downloadPattern, embedder.downloadPattern, projector.downloadPattern]
    }

    /// The folders that hold the files of this set, relative to the repository folder.
    var folders: [String] {
        [segmenter.description, embedder.description, projector.description]
    }
}

/// True while a `MeetingRecorder` of this process is recording. The speaker
/// models are never downloaded then: a meeting must not compete with a
/// download for the network and the disk, and a download that finishes
/// midway would change what the rest of the meeting looks like.
enum RecordingActivity {
    private static let lock = NSLock()
    private static var count = 0

    static var isRecording: Bool {
        lock.lock(); defer { lock.unlock() }
        return count > 0
    }

    static func began() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    static func ended() {
        lock.lock()
        count = max(0, count - 1)
        lock.unlock()
    }
}

// The speaker models live next to the Whisper models:
//
//     <directory>/models/argmaxinc/speakerkit-coreml/speaker_segmenter/pyannote-v3/W8A16/SpeakerSegmenter.mlmodelc
//     <directory>/models/argmaxinc/speakerkit-coreml/speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedder[Preprocessor].mlmodelc
//     <directory>/models/argmaxinc/speakerkit-coreml/speaker_clusterer/pyannote-v4/W32A32/PldaProjector.mlmodelc
//
// As with Whisper, a set counts as downloaded only once a marker file says
// every file arrived, and from then on nothing touches the network.
extension ModelStore {
    static let speakerRepo = "argmaxinc/speakerkit-coreml"

    /// The folder SpeakerKit loads from (whether or not it exists).
    public func modelFolder(for model: SpeakerModelInfo) -> URL {
        var url = directory.appendingPathComponent("models", isDirectory: true)
        for part in Self.speakerRepo.split(separator: "/") {
            url.appendPathComponent(String(part), isDirectory: true)
        }
        return url
    }

    private func speakerMarker(_ model: SpeakerModelInfo) -> URL {
        modelFolder(for: model).appendingPathComponent(".meetingkit-complete-\(model.id)")
    }

    public func isDownloaded(_ model: SpeakerModelInfo) -> Bool {
        let manager = FileManager.default
        guard manager.fileExists(atPath: speakerMarker(model).path) else { return false }
        let folder = modelFolder(for: model)
        for relative in SpeakerModelParts.parts(for: model).requiredModels {
            guard manager.fileExists(atPath: folder.appendingPathComponent(relative).path) else { return false }
        }
        return true
    }

    /// The speaker model sets of the catalog that are on disk.
    public func downloadedSpeakerModels() -> [SpeakerModelInfo] {
        SpeakerModelCatalog.all.filter(isDownloaded)
    }

    /// Bytes the set takes on disk (0 when absent).
    public func sizeOnDisk(_ model: SpeakerModelInfo) -> Int64 {
        let folder = modelFolder(for: model)
        return SpeakerModelParts.parts(for: model).folders.reduce(0) {
            $0 + Self.directorySize(folder.appendingPathComponent($1, isDirectory: true))
        }
    }

    /// Downloads the speaker models. `progress` gets 0...1 from an arbitrary
    /// thread. Files already on disk are not fetched again. Cancelling the
    /// calling task cancels the download.
    ///
    /// Refused with `ModelStoreError.recordingInProgress` while a
    /// `MeetingRecorder` of this process is recording: this is the only
    /// place the speaker models are ever fetched, so a meeting never starts
    /// or waits for a download. Without the models everything still works,
    /// with no speakers.
    public func download(_ model: SpeakerModelInfo, progress: ((Double) -> Void)? = nil) async throws {
        guard !RecordingActivity.isRecording else { throw ModelStoreError.recordingInProgress }
        let manager = FileManager.default
        do {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            throw ModelStoreError.downloadFailed(error.localizedDescription)
        }
        let marker = speakerMarker(model)
        try? manager.removeItem(at: marker)
        progress?(0)
        let parts = SpeakerModelParts.parts(for: model)
        do {
            let hub = HubApiWrapper(downloadBase: directory, endpoint: endpoint)
            let folder = try await hub.snapshot(
                from: HubApiWrapper.Repo(id: Self.speakerRepo),
                matching: parts.downloadPatterns,
                progressHandler: { value in progress?(min(0.99, value.fractionCompleted * 0.99)) }
            )
            guard folder.standardizedFileURL.path == modelFolder(for: model).standardizedFileURL.path else {
                throw ModelStoreError.downloadFailed("unexpected download location \(folder.path)")
            }
            try Task.checkCancellation()
            for relative in parts.requiredModels {
                guard manager.fileExists(atPath: folder.appendingPathComponent(relative).path) else {
                    throw ModelStoreError.downloadFailed("\(relative) did not arrive")
                }
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

    /// Removes the speaker models. The Whisper models are not touched.
    public func delete(_ model: SpeakerModelInfo) throws {
        let manager = FileManager.default
        let folder = modelFolder(for: model)
        do {
            if manager.fileExists(atPath: speakerMarker(model).path) {
                try manager.removeItem(at: speakerMarker(model))
            }
            for relative in SpeakerModelParts.parts(for: model).folders {
                // "speaker_segmenter/pyannote-v3/W8A16": the first component holds only this set
                let top = folder.appendingPathComponent(String(relative.split(separator: "/")[0]), isDirectory: true)
                if manager.fileExists(atPath: top.path) {
                    try manager.removeItem(at: top)
                }
                // the Hub client's bookkeeping for those files
                let metadata = folder.appendingPathComponent(".cache/huggingface/download/\(relative.split(separator: "/")[0])")
                if manager.fileExists(atPath: metadata.path) {
                    try manager.removeItem(at: metadata)
                }
            }
            // nothing else lives in the repository folder: remove it when it is empty
            if let rest = try? manager.contentsOfDirectory(atPath: folder.path),
               rest.allSatisfy({ $0 == ".cache" || $0 == ".DS_Store" }) {
                try? manager.removeItem(at: folder)
            }
        } catch {
            throw ModelStoreError.deleteFailed(error.localizedDescription)
        }
    }

    /// Asks the repository for the files of the speaker models without
    /// downloading them. A diagnostic: `meetingkit models --check`.
    public func remoteFileCount(_ model: SpeakerModelInfo) async throws -> Int {
        let hub = HubApiWrapper(downloadBase: directory, endpoint: endpoint)
        let files = try await hub.getFilenames(
            from: HubApiWrapper.Repo(id: Self.speakerRepo),
            matching: SpeakerModelParts.parts(for: model).downloadPatterns
        )
        guard !files.isEmpty else {
            throw ModelStoreError.downloadFailed("no files for \(model.id) in \(Self.speakerRepo)")
        }
        return files.count
    }
}
