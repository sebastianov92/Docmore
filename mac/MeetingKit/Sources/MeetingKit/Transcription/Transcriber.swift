import AVFoundation
import Foundation
import WhisperKit

public enum TranscriptionLanguage: Equatable, Sendable {
    /// Whisper detects the language from the first speech it hears.
    case automatic
    /// A Whisper language code: "en", "es", "pt", ...
    case fixed(String)
}

public enum TranscriptionError: Error, LocalizedError, Equatable, Sendable {
    /// `ModelStore.download` has to run first.
    case modelNotDownloaded(String)
    case modelLoadFailed(String)
    case audioUnreadable(String)
    case failed(String)

    public var errorDescription: String? {
        switch self {
        case .modelNotDownloaded(let id): return "The transcription model \(id) is not downloaded."
        case .modelLoadFailed(let detail): return "The transcription model could not be loaded: \(detail)"
        case .audioUnreadable(let detail): return "The audio could not be read: \(detail)"
        case .failed(let detail): return "Transcription failed: \(detail)"
        }
    }
}

/// Something that turns 16 kHz mono samples into text. `Transcriber` is the
/// real one; `LiveTranscriber` accepts any (tests use a fake).
public protocol SampleTranscribing: AnyObject, Sendable {
    /// `language` nil: the transcriber's own setting.
    func transcribe(samples: [Float], language: String?) async throws -> MeetingTranscript
}

/// Transcribes on the device with WhisperKit.
///
/// ```swift
/// let store = ModelStore(directory: modelsDirectory)
/// try await store.download(WhisperModelCatalog.base)
/// let transcriber = Transcriber(modelStore: store, model: WhisperModelCatalog.base)
/// let transcript = try await transcriber.transcribe(fileURL: wav)
/// ```
///
/// The model loads on first use (seconds; the very first load of a model on
/// a Mac takes longer, up to minutes for the large ones, while Core ML
/// prepares it for the chip) and stays in memory until `unload()` or until
/// the transcriber goes away. Calls are served one at a time. No call
/// reaches the network.
public final class Transcriber: SampleTranscribing, @unchecked Sendable {
    public let modelStore: ModelStore
    public let model: WhisperModelInfo
    public let language: TranscriptionLanguage

    private let gate = AsyncGate()
    private var whisper: WhisperKit?

    public init(modelStore: ModelStore, model: WhisperModelInfo, language: TranscriptionLanguage = .automatic) {
        self.modelStore = modelStore
        self.model = model
        self.language = language
    }

    /// Loads the model now instead of at the first transcription.
    public func prepare() async throws {
        await gate.enter()
        defer { Task { await gate.leave() } }
        _ = try await loaded()
    }

    /// Frees the model's memory. The next transcription loads it again.
    public func unload() async {
        await gate.enter()
        defer { Task { await gate.leave() } }
        await whisper?.unloadModels()
        whisper = nil
    }

    /// Transcribes an audio file (WAV, M4A, MP3, anything AVFoundation
    /// reads). Long files are read in pieces, so memory stays bounded.
    /// `progress` gets 0...1 from an arbitrary thread.
    public func transcribe(fileURL: URL, progress: ((Double) -> Void)? = nil) async throws -> MeetingTranscript {
        await gate.enter()
        defer { Task { await gate.leave() } }
        let duration = try Self.duration(of: fileURL)
        let whisper = try await loaded()
        guard duration > 0 else {
            return MeetingTranscript(text: "", language: nil, durationSeconds: 0, segments: [])
        }

        var code: String
        switch language {
        case .fixed(let fixed):
            code = fixed
        case .automatic:
            code = try await detectLanguage(whisper, fileURL: fileURL, duration: duration)
        }

        let tracker = ProgressTracker(duration: duration, report: progress)
        whisper.segmentDiscoveryCallback = { segments in tracker.saw(segments) }
        defer { whisper.segmentDiscoveryCallback = nil }
        progress?(0)
        let results: [TranscriptionResult]
        do {
            results = try await whisper.transcribe(
                audioPath: fileURL.path,
                audioInputOptions: AudioInputOptions(audioLoadingMode: .incremental),
                decodeOptions: Self.options(language: code)
            )
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw TranscriptionError.failed(error.localizedDescription)
        }
        if code.isEmpty { code = results.first?.language ?? "" }
        progress?(1)
        return Self.transcript(from: results, language: code, duration: duration)
    }

    /// Transcribes 16 kHz mono samples (a window of a running recording).
    public func transcribe(samples: [Float], language override: String? = nil) async throws -> MeetingTranscript {
        await gate.enter()
        defer { Task { await gate.leave() } }
        let duration = Double(samples.count) / MeetingAudioFormat.sampleRate
        guard !samples.isEmpty else {
            return MeetingTranscript(text: "", language: override, durationSeconds: 0, segments: [])
        }
        let whisper = try await loaded()
        var code: String
        if let override, !override.isEmpty {
            code = override
        } else {
            switch language {
            case .fixed(let fixed):
                code = fixed
            case .automatic:
                let head = Array(samples.prefix(Int(30 * MeetingAudioFormat.sampleRate)))
                code = (try? await whisper.detectLangauge(audioArray: head).language) ?? ""
            }
        }
        let results: [TranscriptionResult]
        do {
            results = try await whisper.transcribe(audioArray: samples, decodeOptions: Self.options(language: code))
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw TranscriptionError.failed(error.localizedDescription)
        }
        if code.isEmpty { code = results.first?.language ?? "" }
        return Self.transcript(from: results, language: code, duration: duration)
    }

    // MARK: - Internals

    private func loaded() async throws -> WhisperKit {
        if let whisper { return whisper }
        guard modelStore.isDownloaded(model) else {
            throw TranscriptionError.modelNotDownloaded(model.id)
        }
        let config = WhisperKitConfig(
            modelFolder: modelStore.modelFolder(for: model).path,
            tokenizerFolder: modelStore.directory,
            verbose: false,
            logLevel: .none,
            prewarm: false,
            load: true,
            download: false
        )
        do {
            let made = try await WhisperKit(config)
            whisper = made
            return made
        } catch {
            throw TranscriptionError.modelLoadFailed(error.localizedDescription)
        }
    }

    /// The language of the first half minute that has sound in it. Meetings
    /// often start with silence, where detection guesses.
    private func detectLanguage(_ whisper: WhisperKit, fileURL: URL, duration: Double) async throws -> String {
        let window = 30.0
        var best: (samples: [Float], level: Float)?
        var start = 0.0
        while start < duration, start < 10 * window {
            let samples: [Float]
            do {
                samples = try AudioProcessor.loadAudioAsFloatArray(fromPath: fileURL.path, startTime: start, endTime: min(duration, start + window))
            } catch {
                throw TranscriptionError.audioUnreadable(error.localizedDescription)
            }
            let level = AudioMath.rms(samples)
            if best == nil || level > best!.level { best = (samples, level) }
            // about -46 dBFS: somebody is talking
            if level > 0.005 { break }
            start += window
        }
        guard let best, !best.samples.isEmpty else { return "" }
        return (try? await whisper.detectLangauge(audioArray: best.samples).language) ?? ""
    }

    private static func options(language: String) -> DecodingOptions {
        DecodingOptions(
            verbose: false,
            task: .transcribe,
            language: language.isEmpty ? nil : language,
            temperature: 0,
            usePrefillPrompt: true,
            detectLanguage: language.isEmpty,
            skipSpecialTokens: true,
            withoutTimestamps: false,
            wordTimestamps: false,
            chunkingStrategy: .vad
        )
    }

    static func transcript(from results: [TranscriptionResult], language: String, duration: Double) -> MeetingTranscript {
        // Whisper's clock ticks every 0.02 s: two decimals keep all of it
        // and drop the noise of the Float to Double conversion.
        func seconds(_ value: Float) -> Double { (Double(value) * 100).rounded() / 100 }
        let segments = results.flatMap(\.segments).map {
            MeetingTranscript.Segment(start: seconds($0.start), end: seconds($0.end), text: clean($0.text))
        }.filter { !isAnnotation($0.text) }
        return MeetingTranscript(segments: segments, language: language.isEmpty ? nil : language, durationSeconds: duration)
    }

    /// Drops what is left of Whisper's markers ("<|0.00|>", "<|en|>").
    static func clean(_ text: String) -> String {
        text.replacingOccurrences(of: "<\\|[^|]*\\|>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// True for a segment that is only a sound label, which is what Whisper
    /// writes over silence and noise: "[Music]", "(applause)", "[BLANK_AUDIO]".
    static func isAnnotation(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2, trimmed.count <= 40, let first = trimmed.first, let last = trimmed.last else { return false }
        switch (first, last) {
        case ("[", "]"), ("(", ")"):
            // one label, not "(a) ... (b)"
            let inner = trimmed.dropFirst().dropLast()
            return !inner.contains(where: { "[]()".contains($0) })
        case ("\u{266A}", "\u{266A}"), ("*", "*"):
            return true
        default:
            return false
        }
    }

    private static func duration(of url: URL) throws -> Double {
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw TranscriptionError.audioUnreadable("no file at \(url.path)")
        }
        do {
            let file = try AVAudioFile(forReading: url)
            let rate = file.fileFormat.sampleRate
            return rate > 0 ? Double(file.length) / rate : 0
        } catch {
            throw TranscriptionError.audioUnreadable(error.localizedDescription)
        }
    }
}

/// Turns the segments WhisperKit finds into a fraction of the file.
private final class ProgressTracker: @unchecked Sendable {
    private let lock = NSLock()
    private let duration: Double
    private let report: ((Double) -> Void)?
    private var furthest = 0.0

    init(duration: Double, report: ((Double) -> Void)?) {
        self.duration = duration
        self.report = report
    }

    func saw(_ segments: [TranscriptionSegment]) {
        guard let report, duration > 0, let end = segments.map({ Double($0.end) }).max() else { return }
        lock.lock()
        let advanced = end > furthest
        if advanced { furthest = end }
        lock.unlock()
        if advanced { report(min(0.99, end / duration)) }
    }
}

/// Lets one caller through at a time, in arrival order.
actor AsyncGate {
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func enter() async {
        if !busy {
            busy = true
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func leave() {
        if waiters.isEmpty {
            busy = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}
