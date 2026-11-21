import XCTest
@testable import MeetingKit

final class ModelStoreTests: XCTestCase {
    /// Puts on disk what a finished download leaves.
    private func install(_ model: WhisperModelInfo, in store: ModelStore, marker: Bool = true, bytes: Int = 4096) throws {
        let manager = FileManager.default
        let folder = store.modelFolder(for: model)
        for name in ["MelSpectrogram", "AudioEncoder", "TextDecoder"] {
            let compiled = folder.appendingPathComponent("\(name).mlmodelc")
            try manager.createDirectory(at: compiled, withIntermediateDirectories: true)
            try Data(count: bytes).write(to: compiled.appendingPathComponent("weights.bin"))
        }
        let tokenizer = store.tokenizerFolder(for: model)
        try manager.createDirectory(at: tokenizer, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: tokenizer.appendingPathComponent("tokenizer.json"))
        if marker {
            try Data().write(to: folder.appendingPathComponent(ModelStore.markerName))
        }
    }

    func testCatalog() {
        let all = WhisperModelCatalog.all
        XCTAssertEqual(Set(all.map(\.id)).count, all.count)
        XCTAssertEqual(all.map(\.id), [
            "openai_whisper-tiny",
            "openai_whisper-base",
            "openai_whisper-small",
            "openai_whisper-large-v3-v20240930_turbo_632MB",
            "openai_whisper-large-v3-v20240930_turbo",
        ])
        XCTAssertEqual(all.map(\.approximateSizeBytes), all.map(\.approximateSizeBytes).sorted(), "smallest first")
        XCTAssertTrue(all.allSatisfy { !$0.displayName.isEmpty && $0.tokenizerRepo.hasPrefix("openai/whisper-") })
        XCTAssertEqual(WhisperModelCatalog.model("tiny"), WhisperModelCatalog.tiny)
        XCTAssertEqual(WhisperModelCatalog.model("openai_whisper-base"), WhisperModelCatalog.base)
        XCTAssertEqual(WhisperModelCatalog.model("turbo"), WhisperModelCatalog.largeV3Turbo)
        XCTAssertEqual(WhisperModelCatalog.model("turbo-full"), WhisperModelCatalog.largeV3TurboFull)
        XCTAssertNil(WhisperModelCatalog.model("gigantic"))
        XCTAssertTrue(all.contains(WhisperModelCatalog.recommended))
    }

    func testLayoutIsTheOneWhisperKitReads() {
        let directory = URL(fileURLWithPath: "/models-root", isDirectory: true)
        let store = ModelStore(directory: directory)
        XCTAssertEqual(store.modelFolder(for: WhisperModelCatalog.base).path,
                       "/models-root/models/argmaxinc/whisperkit-coreml/openai_whisper-base")
        XCTAssertEqual(store.tokenizerFolder(for: WhisperModelCatalog.base).path, "/models-root/models/openai/whisper-base")
        XCTAssertEqual(store.tokenizerFolder(for: WhisperModelCatalog.largeV3Turbo).path, "/models-root/models/openai/whisper-large-v3")
    }

    func testIsDownloadedNeedsEverything() throws {
        let store = ModelStore(directory: makeTemporaryDirectory(self))
        let model = WhisperModelCatalog.tiny
        XCTAssertFalse(store.isDownloaded(model))
        XCTAssertEqual(store.sizeOnDisk(model), 0)
        XCTAssertEqual(store.downloadedModels(), [])

        // every file but no marker: a download that was cut
        try install(model, in: store, marker: false)
        XCTAssertFalse(store.isDownloaded(model))

        try install(model, in: store)
        XCTAssertTrue(store.isDownloaded(model))
        XCTAssertEqual(store.downloadedModels(), [model])
        XCTAssertGreaterThanOrEqual(store.sizeOnDisk(model), 3 * 4096)

        // the tokenizer is part of it
        try FileManager.default.removeItem(at: store.tokenizerFolder(for: model).appendingPathComponent("tokenizer.json"))
        XCTAssertFalse(store.isDownloaded(model))
        // and so is each of the three Core ML models
        try install(model, in: store)
        try FileManager.default.removeItem(at: store.modelFolder(for: model).appendingPathComponent("TextDecoder.mlmodelc"))
        XCTAssertFalse(store.isDownloaded(model))
    }

    func testDeleteKeepsATokenizerAnotherModelUses() throws {
        let store = ModelStore(directory: makeTemporaryDirectory(self))
        let turbo = WhisperModelCatalog.largeV3Turbo
        let full = WhisperModelCatalog.largeV3TurboFull
        let tiny = WhisperModelCatalog.tiny
        try install(turbo, in: store)
        try install(full, in: store)
        try install(tiny, in: store)

        try store.delete(turbo)
        XCTAssertFalse(store.isDownloaded(turbo))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.modelFolder(for: turbo).path))
        XCTAssertTrue(store.isDownloaded(full), "the shared tokenizer stays")
        XCTAssertTrue(store.isDownloaded(tiny))

        try store.delete(full)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.tokenizerFolder(for: full).path), "nobody uses it any more")
        XCTAssertTrue(store.isDownloaded(tiny))
        try store.delete(tiny)
        try store.delete(tiny) // deleting what is not there is fine
        XCTAssertEqual(store.downloadedModels(), [])
    }

    func testTranscribingWithoutTheModelSaysSo() async throws {
        let directory = makeTemporaryDirectory(self)
        let wav = directory.appendingPathComponent("a.wav")
        let writer = try WAVWriter(url: wav)
        try writer.append(sine(frequency: 300, sampleRate: 16_000, seconds: 1))
        try writer.finish()
        let transcriber = Transcriber(modelStore: ModelStore(directory: directory.appendingPathComponent("models")), model: WhisperModelCatalog.base)
        do {
            _ = try await transcriber.transcribe(fileURL: wav)
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? TranscriptionError, .modelNotDownloaded("openai_whisper-base"))
        }
        do {
            _ = try await transcriber.transcribe(samples: [Float](repeating: 0.1, count: 16_000))
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? TranscriptionError, .modelNotDownloaded("openai_whisper-base"))
        }
        do {
            _ = try await transcriber.transcribe(fileURL: directory.appendingPathComponent("missing.wav"))
            XCTFail("should throw")
        } catch {
            guard case TranscriptionError.audioUnreadable = error else { return XCTFail("got \(error)") }
        }
    }
}
