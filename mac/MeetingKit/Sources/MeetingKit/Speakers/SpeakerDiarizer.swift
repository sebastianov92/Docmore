import ArgmaxCore
import Foundation
import SpeakerKit
import WhisperKit

/// A stretch of audio one voice speaks in.
public struct SpeakerTurn: Equatable, Sendable {
    /// Seconds from the start of the audio that was diarized.
    public var start: Double
    public var end: Double
    /// Which voice: a number that means something only inside one
    /// `Diarization` (the next run may number the same voices differently).
    public var cluster: Int

    public init(start: Double, end: Double, cluster: Int) {
        self.start = start
        self.end = end
        self.cluster = cluster
    }

    public var duration: Double { max(0, end - start) }
}

/// Who speaks when in a piece of audio.
public struct Diarization: Equatable, Sendable {
    /// Ordered by start. At most one voice at a time.
    public var turns: [SpeakerTurn]
    /// One voice print per cluster (the mean of the embeddings of its
    /// speech). Comparable between runs with `VoicePrint.distance`.
    public var voicePrints: [Int: [Float]]
    public var durationSeconds: Double

    public init(turns: [SpeakerTurn], voicePrints: [Int: [Float]] = [:], durationSeconds: Double) {
        self.turns = turns.sorted { $0.start < $1.start }
        self.voicePrints = voicePrints
        self.durationSeconds = durationSeconds
    }

    public static let empty = Diarization(turns: [], durationSeconds: 0)

    /// The clusters that speak, in order of first appearance.
    public var clusters: [Int] {
        var seen: [Int] = []
        for turn in turns where !seen.contains(turn.cluster) {
            seen.append(turn.cluster)
        }
        return seen
    }

    /// Seconds each cluster speaks.
    public var speechSeconds: [Int: Double] {
        var totals: [Int: Double] = [:]
        for turn in turns {
            totals[turn.cluster, default: 0] += turn.duration
        }
        return totals
    }

    /// The same diarization on the clock of a longer recording.
    public func shifted(by seconds: Double) -> Diarization {
        var copy = self
        copy.turns = turns.map { SpeakerTurn(start: $0.start + seconds, end: $0.end + seconds, cluster: $0.cluster) }
        return copy
    }
}

public enum SpeakerDiarizerError: Error, LocalizedError, Equatable, Sendable {
    /// `ModelStore.download(_: SpeakerModelInfo)` has to run first.
    case modelNotDownloaded(String)
    case modelLoadFailed(String)
    case failed(String)

    public var errorDescription: String? {
        switch self {
        case .modelNotDownloaded(let id): return "The speaker models (\(id)) are not downloaded."
        case .modelLoadFailed(let detail): return "The speaker models could not be loaded: \(detail)"
        case .failed(let detail): return "Telling the voices apart failed: \(detail)"
        }
    }
}

/// How the voices of one piece of audio are grouped.
public struct DiarizationOptions: Equatable, Sendable {
    /// What MeetingKit uses: 0.5. With SpeakerKit's own 0.6 two clearly
    /// different voices that had under a minute of speech between them were
    /// taken for one; at 0.5 they were told apart, and nothing else in the
    /// measurements changed (STATUS.md).
    public static let meetingClusterThreshold: Float = 0.5

    /// How far apart two stretches of speech may sound and still be taken
    /// for one voice: smaller finds more voices. Nil: SpeakerKit's own
    /// value (0.6).
    public var clusterThreshold: Float?
    /// The number of voices, when it is known. Nil: found from the audio.
    public var speakerCount: Int?

    public init(clusterThreshold: Float? = nil, speakerCount: Int? = nil) {
        self.clusterThreshold = clusterThreshold
        self.speakerCount = speakerCount
    }

    /// The options the live session and the final pass use.
    public static let meeting = DiarizationOptions(clusterThreshold: meetingClusterThreshold)
}

/// Something that says who speaks when in 16 kHz mono samples.
/// `SpeakerDiarizer` is the real one; the live session and the final pass
/// accept any (tests use a fake).
public protocol SampleDiarizing: AnyObject, Sendable {
    /// False when it cannot work (the speaker models are not on disk): the
    /// meeting then goes on without speakers.
    var isAvailable: Bool { get }
    func diarize(samples: [Float], options: DiarizationOptions) async throws -> Diarization
}

public extension SampleDiarizing {
    var isAvailable: Bool { true }

    func diarize(samples: [Float]) async throws -> Diarization {
        try await diarize(samples: samples, options: DiarizationOptions())
    }
}

/// Tells voices apart on the device with SpeakerKit (Pyannote on Core ML).
///
/// ```swift
/// let store = ModelStore(directory: modelsDirectory)
/// try await store.download(SpeakerModelCatalog.recommended)      // once, never during a recording
/// let diarizer = SpeakerDiarizer(modelStore: store)
/// let diarization = try await diarizer.diarize(samples: samples)  // 16 kHz mono
/// ```
///
/// The models load on first use and stay in memory until `unload()`. Calls
/// are served one at a time. No call reaches the network: when the models
/// are not on disk, `diarize` throws `.modelNotDownloaded` and `isAvailable`
/// is false.
public final class SpeakerDiarizer: SampleDiarizing, @unchecked Sendable {
    public let modelStore: ModelStore
    public let model: SpeakerModelInfo

    private let gate = AsyncGate()
    private var kit: SpeakerKit?

    public init(modelStore: ModelStore, model: SpeakerModelInfo = SpeakerModelCatalog.recommended) {
        self.modelStore = modelStore
        self.model = model
    }

    /// Whether the speaker models are on disk.
    public var isAvailable: Bool { modelStore.isDownloaded(model) }

    /// Loads the models now instead of at the first diarization.
    public func prepare() async throws {
        await gate.enter()
        defer { Task { await gate.leave() } }
        _ = try await loaded()
    }

    /// Frees the models' memory. The next diarization loads them again.
    public func unload() async {
        await gate.enter()
        defer { Task { await gate.leave() } }
        await kit?.unloadModels()
        kit = nil
    }

    /// Says who speaks when in 16 kHz mono samples.
    public func diarize(samples: [Float], options: DiarizationOptions = DiarizationOptions()) async throws -> Diarization {
        await gate.enter()
        defer { Task { await gate.leave() } }
        let duration = Double(samples.count) / MeetingAudioFormat.sampleRate
        // under a second there is nothing to tell apart, and the models want at least a window
        guard samples.count >= MeetingAudioFormat.sampleRateInt else {
            return Diarization(turns: [], durationSeconds: duration)
        }
        let kit = try await loaded()
        let result: DiarizationResult
        do {
            result = try await kit.diarize(audioArray: samples, options: PyannoteDiarizationOptions(
                numberOfSpeakers: options.speakerCount,
                clusterDistanceThreshold: options.clusterThreshold
            ))
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SpeakerDiarizerError.failed(error.localizedDescription)
        }
        return Self.diarization(from: result, duration: duration)
    }

    /// Diarizes one channel of an audio file (16 kHz WAV written by the
    /// recorder, or anything AVFoundation reads). `channel` nil: the mix of
    /// all channels.
    public func diarize(fileURL: URL, channel: Int? = nil, options: DiarizationOptions = DiarizationOptions()) async throws -> Diarization {
        let samples: [Float]
        do {
            samples = try AudioTrackReader.samples(of: fileURL, channel: channel)
        } catch {
            throw SpeakerDiarizerError.failed(error.localizedDescription)
        }
        return try await diarize(samples: samples, options: options)
    }

    // MARK: - Internals

    private func loaded() async throws -> SpeakerKit {
        if let kit { return kit }
        guard modelStore.isDownloaded(model) else {
            throw SpeakerDiarizerError.modelNotDownloaded(model.id)
        }
        let parts = SpeakerModelParts.parts(for: model)
        // modelFolder set and download off: SpeakerKit reads the disk and nothing else
        let config = PyannoteConfig(
            modelFolder: modelStore.modelFolder(for: model).path,
            download: false,
            load: false,
            verbose: false,
            logLevel: .none
        )
        config.diarizer = SpeakerKitDiarizer.pyannote(
            config: config,
            segmenterModelInfo: parts.segmenter,
            embedderModelInfo: parts.embedder,
            pldaModelInfo: parts.projector
        )
        do {
            let made = try await SpeakerKit(config)
            try await made.ensureModelsLoaded()
            kit = made
            return made
        } catch {
            throw SpeakerDiarizerError.modelLoadFailed(error.localizedDescription)
        }
    }

    static func diarization(from result: DiarizationResult, duration: Double) -> Diarization {
        func seconds(_ value: Float) -> Double { (Double(value) * 100).rounded() / 100 }
        let turns: [SpeakerTurn] = result.segments.compactMap { segment in
            guard let cluster = segment.speaker.speakerId else { return nil }
            let start = seconds(segment.startTime)
            let end = min(seconds(segment.endTime), max(duration, start))
            guard end > start else { return nil }
            return SpeakerTurn(start: start, end: end, cluster: cluster)
        }
        return Diarization(turns: turns, voicePrints: result.speakerCentroidEmbeddings, durationSeconds: duration)
    }
}

/// Compares the voice prints SpeakerKit computes.
public enum VoicePrint {
    /// Cosine distance, 0 (same direction) to 2. 1 when a vector is empty,
    /// all zeros, or the sizes differ.
    public static func distance(_ first: [Float], _ second: [Float]) -> Float {
        guard !first.isEmpty, first.count == second.count else { return 1 }
        var dot: Float = 0
        var firstNorm: Float = 0
        var secondNorm: Float = 0
        for index in first.indices {
            dot += first[index] * second[index]
            firstNorm += first[index] * first[index]
            secondNorm += second[index] * second[index]
        }
        guard firstNorm > 0, secondNorm > 0 else { return 1 }
        return max(0, min(2, 1 - dot / (firstNorm.squareRoot() * secondNorm.squareRoot())))
    }

    /// Scales a voice print to length 1, so that averaging several of them
    /// weighs each by the time it stands for and not by its loudness.
    public static func normalized(_ print: [Float]) -> [Float] {
        var norm: Float = 0
        for value in print { norm += value * value }
        guard norm > 0 else { return print }
        let scale = 1 / norm.squareRoot()
        return print.map { $0 * scale }
    }
}
