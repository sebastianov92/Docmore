import Foundation
import XCTest
@testable import MeetingKit

/// Words of a sentence spread evenly over a span, the way Whisper gives
/// them: each with the space before it.
func words(_ text: String, from start: Double, to end: Double) -> [TimedWord] {
    let parts = text.split(separator: " ").map(String.init)
    guard !parts.isEmpty else { return [] }
    let step = (end - start) / Double(parts.count)
    return parts.enumerated().map { index, word in
        TimedWord(start: start + step * Double(index), end: start + step * Double(index + 1), text: (index == 0 ? "" : " ") + word)
    }
}

func timed(_ text: String, _ start: Double, _ end: Double, wordTimes: Bool = true) -> TimedTranscript.Segment {
    TimedTranscript.Segment(start: start, end: end, text: text, words: wordTimes ? words(text, from: start, to: end) : [])
}

func labelled(_ text: String, _ start: Double, _ end: Double, speaker: String? = nil, side: MeetingSide? = nil, wordTimes: Bool = true) -> LabelledSegment {
    LabelledSegment(start: start, end: end, text: text, words: wordTimes ? words(text, from: start, to: end) : [], speaker: speaker, side: side)
}

/// A voice print that points mostly along one axis: prints of the same
/// axis are close, prints of different axes are far.
func voicePrint(_ axis: Int, wobble: Float = 0) -> [Float] {
    var print = [Float](repeating: 0.02, count: 16)
    print[axis % 16] = 1
    print[(axis + 1) % 16] += wobble
    return print
}

func diarization(_ turns: [(Double, Double, Int)], prints: [Int: [Float]] = [:], duration: Double? = nil) -> Diarization {
    Diarization(
        turns: turns.map { SpeakerTurn(start: $0.0, end: $0.1, cluster: $0.2) },
        voicePrints: prints,
        durationSeconds: duration ?? (turns.map(\.1).max() ?? 0)
    )
}

/// Stands in for Whisper with word times. The script says what is said on
/// each track of a recording, in seconds of the recording; a call returns
/// what falls inside the audio it was given. Which track and which stretch
/// a call is about is read from the samples themselves: `ScriptedAudio`
/// writes the track number and the time into them.
final class ScriptedTranscriber: WordTranscribing, @unchecked Sendable {
    private let lock = NSLock()
    private let script: [[TimedTranscript.Segment]]
    private(set) var calls: [(track: Int, start: Double, seconds: Double, language: String?)] = []
    var language = "es"
    /// Calls (counted from 0) that throw.
    var failingCalls: Set<Int> = []
    var wordTimes = true

    init(_ script: [[TimedTranscript.Segment]]) {
        self.script = script
    }

    var snapshot: [(track: Int, start: Double, seconds: Double, language: String?)] {
        lock.withLock { calls }
    }

    func transcribeWords(samples: [Float], language hint: String?) async throws -> TimedTranscript {
        let (track, start) = ScriptedAudio.read(samples)
        let seconds = Double(samples.count) / 16_000
        let number: Int = lock.withLock {
            calls.append((track, start, seconds, hint))
            return calls.count - 1
        }
        if failingCalls.contains(number) { throw TranscriptionError.failed("boom") }
        // a segment belongs to the audio its middle falls in; times are relative to that audio
        let own = (track < script.count ? script[track] : []).filter {
            let middle = ($0.start + $0.end) / 2
            return middle >= start && middle < start + seconds
        }
        let moved = TimedTranscript(language: own.isEmpty ? nil : language, durationSeconds: seconds, segments: own).shifted(by: -start)
        guard !wordTimes else { return moved }
        return TimedTranscript(language: moved.language, durationSeconds: seconds,
                               segments: moved.segments.map { .init(start: $0.start, end: $0.end, text: $0.text) })
    }
}

/// Audio that knows where it comes from. Each second of a track starts with
/// a marker: a tiny positive sample that carries the track number, then a
/// tiny negative one that carries the second. The rest is a steady level,
/// or nothing in a silent second (the markers are far too small to count
/// as sound).
enum ScriptedAudio {
    static let rate = 16_000

    /// `seconds` of track `track`. `silentSeconds`: whole seconds with no sound.
    static func track(_ track: Int, seconds: Int, silentSeconds: Set<Int> = []) -> [Float] {
        var samples = [Float](repeating: 0, count: seconds * rate)
        for second in 0..<seconds {
            let level: Float = silentSeconds.contains(second) ? 0 : 0.1
            for index in 0..<rate {
                samples[second * rate + index] = level
            }
            samples[second * rate] = Float(track + 1) * 1e-5
            samples[second * rate + 1] = -Float(second + 1) * 1e-7
        }
        return samples
    }

    /// The track and the time (seconds of the recording) of a piece of audio.
    static func read(_ samples: [Float]) -> (track: Int, start: Double) {
        var index = 0
        while index + 1 < samples.count {
            let value = samples[index]
            let next = samples[index + 1]
            // the only place where a tiny positive sample is followed by a tiny negative one
            if value > 0.5e-5, value < 1e-3, next < 0, next > -1e-2 {
                let track = Int((value / 1e-5).rounded()) - 1
                let second = Int((-next / 1e-7).rounded()) - 1
                return (track, Double(second) - Double(index) / Double(rate))
            }
            index += 1
        }
        return (0, 0)
    }
}

/// Stands in for the speaker models. The script says who speaks when on
/// each track (seconds of the recording, a true voice number per turn);
/// a call returns the turns inside the audio it was given, on the clock of
/// that audio. To behave like the real thing, it numbers the clusters
/// differently on every call.
final class ScriptedDiarizer: SampleDiarizing, @unchecked Sendable {
    private let lock = NSLock()
    private let script: [[(start: Double, end: Double, voice: Int)]]
    private(set) var calls: [(track: Int, start: Double, seconds: Double)] = []
    var available = true
    /// Shuffle the cluster numbers from call to call.
    var shuffles = true
    var failingCalls: Set<Int> = []

    init(_ script: [[(Double, Double, Int)]]) {
        self.script = script.map { $0.map { (start: $0.0, end: $0.1, voice: $0.2) } }
    }

    var isAvailable: Bool { available }

    var snapshot: [(track: Int, start: Double, seconds: Double)] {
        lock.withLock { calls }
    }

    func diarize(samples: [Float], options: DiarizerOptions) async throws -> Diarization {
        let (track, start) = ScriptedAudio.read(samples)
        let seconds = Double(samples.count) / 16_000
        let number: Int = lock.withLock {
            calls.append((track, start, seconds))
            return calls.count - 1
        }
        if failingCalls.contains(number) { throw SpeakerDiarizerError.failed("boom") }
        var turns: [SpeakerTurn] = []
        var prints: [Int: [Float]] = [:]
        for turn in track < script.count ? script[track] : [] {
            let from = max(turn.start, start)
            let to = min(turn.end, start + seconds)
            guard to > from else { continue }
            // the same voice gets another cluster number on every call
            let cluster = shuffles ? (turn.voice * 7 + number * 3) % 11 : turn.voice
            turns.append(SpeakerTurn(start: from - start, end: to - start, cluster: cluster))
            prints[cluster] = voicePrint(turn.voice + track * 5, wobble: Float(number % 3) * 0.01)
        }
        return Diarization(turns: turns, voicePrints: prints, durationSeconds: seconds)
    }
}

/// Where the real models are, for the tests that need them: the directory
/// named by MEETINGKIT_MODELS_DIR, or `.build/scratch/models` of the
/// package. Throws `XCTSkip` when the models asked for are not there.
enum RealModels {
    static var directory: URL {
        if let path = ProcessInfo.processInfo.environment["MEETINGKIT_MODELS_DIR"], !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/scratch/models", isDirectory: true)
    }

    static func store(whisper: WhisperModelInfo? = nil, speakers: Bool = false) throws -> ModelStore {
        let store = ModelStore(directory: directory)
        if let whisper, !store.isDownloaded(whisper) {
            throw XCTSkip("the Whisper model \(whisper.id) is not in \(directory.path)")
        }
        if speakers, !store.isDownloaded(SpeakerModelCatalog.recommended) {
            throw XCTSkip("the speaker models are not in \(directory.path)")
        }
        return store
    }

    /// The best Whisper model on disk among the ones the tests accept.
    static func whisper(in store: ModelStore) throws -> WhisperModelInfo {
        for model in [WhisperModelCatalog.largeV3Turbo, WhisperModelCatalog.small, WhisperModelCatalog.base] where store.isDownloaded(model) {
            return model
        }
        throw XCTSkip("no Whisper model (turbo, small or base) in \(directory.path)")
    }

    /// The Spanish test meeting (two channels: room, remote), when it is in the repository.
    static func meetingRecording() throws -> URL {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tools/fixtures/meeting-es/meeting-es.virtual.flac")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("the test meeting is not at \(url.path)")
        }
        return url
    }
}
