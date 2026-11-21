import XCTest
@testable import MeetingKit

final class SpeakerModelStoreTests: XCTestCase {
    private let model = SpeakerModelCatalog.recommended

    /// Puts on disk what a finished download leaves.
    private func install(in store: ModelStore, marker: Bool = true, skip: String? = nil) throws {
        let manager = FileManager.default
        let folder = store.modelFolder(for: model)
        for relative in SpeakerModelParts.parts(for: model).requiredModels where relative != skip {
            let compiled = folder.appendingPathComponent(relative)
            try manager.createDirectory(at: compiled, withIntermediateDirectories: true)
            try Data(count: 4096).write(to: compiled.appendingPathComponent("weights.bin"))
        }
        if marker {
            try Data().write(to: folder.appendingPathComponent(".meetingkit-complete-\(model.id)"))
        }
    }

    func testCatalog() {
        XCTAssertEqual(SpeakerModelCatalog.all.map(\.id), ["pyannote-community-1"])
        XCTAssertEqual(SpeakerModelCatalog.recommended, SpeakerModelCatalog.pyannote)
        XCTAssertEqual(SpeakerModelCatalog.model("pyannote-community-1"), SpeakerModelCatalog.pyannote)
        XCTAssertEqual(SpeakerModelCatalog.model("speakers"), SpeakerModelCatalog.pyannote)
        XCTAssertNil(SpeakerModelCatalog.model("tiny"), "the Whisper names are not speaker models")
        XCTAssertNil(WhisperModelCatalog.model("speakers"))
        XCTAssertGreaterThan(model.approximateSizeBytes, 5_000_000)
        XCTAssertLessThan(model.approximateSizeBytes, 30_000_000)
    }

    func testTheyLiveNextToTheWhisperModelsInTheLayoutSpeakerKitReads() {
        let store = ModelStore(directory: URL(fileURLWithPath: "/models-root", isDirectory: true))
        XCTAssertEqual(store.modelFolder(for: model).path, "/models-root/models/argmaxinc/speakerkit-coreml")
        XCTAssertEqual(store.modelFolder(for: WhisperModelCatalog.base).deletingLastPathComponent().deletingLastPathComponent().path,
                       store.modelFolder(for: model).deletingLastPathComponent().path, "the same folder of repositories")
        let parts = SpeakerModelParts.parts(for: model)
        XCTAssertEqual(parts.requiredModels, [
            "speaker_segmenter/pyannote-v3/W8A16/SpeakerSegmenter.mlmodelc",
            "speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedderPreprocessor.mlmodelc",
            "speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedder.mlmodelc",
            "speaker_clusterer/pyannote-v4/W32A32/PldaProjector.mlmodelc",
        ])
        XCTAssertEqual(parts.downloadPatterns, [
            "speaker_segmenter/pyannote-v3/W8A16/*",
            "speaker_embedder/pyannote-v3/W8A16/*",
            "speaker_clusterer/pyannote-v4/W32A32/*",
        ])
    }

    func testIsDownloadedNeedsEveryPartAndTheMarker() throws {
        let store = ModelStore(directory: makeTemporaryDirectory(self))
        XCTAssertFalse(store.isDownloaded(model))
        XCTAssertEqual(store.sizeOnDisk(model), 0)
        XCTAssertEqual(store.downloadedSpeakerModels(), [])

        // every file but no marker: a download that was cut
        try install(in: store, marker: false)
        XCTAssertFalse(store.isDownloaded(model))
        try install(in: store)
        XCTAssertTrue(store.isDownloaded(model))
        XCTAssertEqual(store.downloadedSpeakerModels(), [model])
        XCTAssertGreaterThanOrEqual(store.sizeOnDisk(model), 4 * 4096)

        // a part missing: not downloaded, whatever the marker says
        try FileManager.default.removeItem(at: store.modelFolder(for: model)
            .appendingPathComponent("speaker_clusterer/pyannote-v4/W32A32/PldaProjector.mlmodelc"))
        XCTAssertFalse(store.isDownloaded(model))
    }

    func testDeleteRemovesTheSpeakerModelsAndNothingElse() throws {
        let directory = makeTemporaryDirectory(self)
        let store = ModelStore(directory: directory)
        try install(in: store)
        // a Whisper model next to them
        let whisper = store.modelFolder(for: WhisperModelCatalog.tiny)
        try FileManager.default.createDirectory(at: whisper, withIntermediateDirectories: true)
        try Data(count: 10).write(to: whisper.appendingPathComponent("keep.bin"))

        try store.delete(model)
        XCTAssertFalse(store.isDownloaded(model))
        XCTAssertEqual(store.sizeOnDisk(model), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.modelFolder(for: model).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: whisper.appendingPathComponent("keep.bin").path))
        // deleting what is not there is fine
        XCTAssertNoThrow(try store.delete(model))
    }

    func testWithoutTheModelsTheDiarizerSaysSoAndTouchesNothing() async {
        let directory = makeTemporaryDirectory(self).appendingPathComponent("never-created")
        let diarizer = SpeakerDiarizer(modelStore: ModelStore(directory: directory))
        XCTAssertFalse(diarizer.isAvailable)
        do {
            _ = try await diarizer.diarize(samples: [Float](repeating: 0.1, count: 32_000))
            XCTFail("there are no models")
        } catch {
            XCTAssertEqual(error as? SpeakerDiarizerError, .modelNotDownloaded("pyannote-community-1"))
        }
        do {
            try await diarizer.prepare()
            XCTFail("there are no models")
        } catch {
            XCTAssertEqual(error as? SpeakerDiarizerError, .modelNotDownloaded("pyannote-community-1"))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path), "no download was started")
    }

    func testDiarizationValues() {
        let value = diarization([(5, 9, 3), (0, 4, 7), (10, 12, 7)], prints: [3: [1], 7: [2]], duration: 12)
        XCTAssertEqual(value.turns.map(\.start), [0, 5, 10], "by start")
        XCTAssertEqual(value.clusters, [7, 3], "in order of first appearance")
        XCTAssertEqual(value.speechSeconds, [7: 6, 3: 4])
        let moved = value.shifted(by: 100)
        XCTAssertEqual(moved.turns.map(\.start), [100, 105, 110])
        XCTAssertEqual(moved.turns.map(\.end), [104, 109, 112])
        XCTAssertEqual(moved.voicePrints, value.voicePrints)
        XCTAssertEqual(Diarization.empty.clusters, [])
        XCTAssertEqual(DiarizerOptions.meeting.clusterThreshold, 0.5)
        XCTAssertNil(DiarizerOptions().clusterThreshold)
    }
}
