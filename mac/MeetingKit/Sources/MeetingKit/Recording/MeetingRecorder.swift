import AVFoundation
import Foundation

/// Records a meeting: the microphone and what the Mac plays, mixed to
/// 16 kHz mono and written, as it comes, to a 16-bit PCM WAV.
///
/// ```swift
/// let recorder = MeetingRecorder(outputDirectory: directory)
/// recorder.onLevel = { level in ... }            // 0...1, about ten times a second
/// recorder.onChunk = { samples in live.append(samples: samples) }
/// try await recorder.start()
/// ...
/// let result = try await recorder.stop()         // result.fileURL, result.sources
/// ```
///
/// A source that cannot start does not stop the other one: `start()` throws
/// only when no source at all could start. `sources` and `warnings` tell what
/// happened right after `start()`, and `RecordingResult` at the end.
///
/// Callbacks run on a private serial queue, never on the main thread.
/// One recorder makes one recording at a time and can be used again.
public final class MeetingRecorder: @unchecked Sendable {
    public let outputDirectory: URL
    public let options: RecordingOptions

    /// Input level of the mix for a meter, 0...1 (-60 dBFS...0 dBFS), about
    /// ten times a second. Set before `start()`.
    public var onLevel: ((Float) -> Void)?
    /// The mixed audio, 16 kHz mono Float32, in pieces of 0.1 s: what
    /// `LiveTranscriber.append(samples:)` takes. Set before `start()`.
    public var onChunk: (([Float]) -> Void)?
    /// The recording cannot go on (the disk is full, every source is gone).
    /// What was written is kept: call `stop()` to get it. Set before `start()`.
    public var onFailure: ((MeetingRecorderError) -> Void)?

    /// Whether `systemAudioPermission()` may ask the private TCC call (see
    /// README). Off: it always answers `.undetermined`.
    public static var usesPrivatePermissionCheck = true

    private enum State { case idle, starting, recording, stopping }

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "com.dezik.meetingkit.recorder")
    private let makeSource: (AudioSource) -> AudioCaptureSource

    private var state = State.idle
    private var startedAt: Date?
    private var lastDuration: Double = 0
    private var activeSources: [AudioSource] = []
    private var currentWarnings: [RecordingWarning] = []

    // touched only on `queue`
    private var pipeline: RecordingPipeline?
    private var accepting = false
    private var liveSlots = 0
    private var failureReported = false

    private var captures: [AudioCaptureSource] = []
    private var fileURL: URL?

    public convenience init(outputDirectory: URL, options: RecordingOptions = RecordingOptions()) {
        self.init(outputDirectory: outputDirectory, options: options) { kind in
            switch kind {
            case .microphone: return MicrophoneCapture()
            case .systemAudio: return SystemAudioCapture()
            }
        }
    }

    /// For tests: the sources come from `makeSource`.
    init(outputDirectory: URL, options: RecordingOptions, makeSource: @escaping (AudioSource) -> AudioCaptureSource) {
        self.outputDirectory = outputDirectory
        self.options = options
        self.makeSource = makeSource
    }

    // MARK: - State

    public var isRecording: Bool {
        lock.lock(); defer { lock.unlock() }
        return state == .recording
    }

    /// Seconds since `start()` returned; after `stop()`, the length of the
    /// last recording.
    public var elapsed: TimeInterval {
        lock.lock(); defer { lock.unlock() }
        if state == .recording, let startedAt { return Date().timeIntervalSince(startedAt) }
        return lastDuration
    }

    /// The sources that started, valid once `start()` has returned.
    public var sources: [AudioSource] {
        lock.lock(); defer { lock.unlock() }
        return activeSources
    }

    /// What went wrong so far with a source (it did not start, it was lost).
    public var warnings: [RecordingWarning] {
        lock.lock(); defer { lock.unlock() }
        return currentWarnings
    }

    // MARK: - Permissions

    /// The microphone permission, without asking.
    public static func microphonePermission() -> PermissionStatus {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        default: return .undetermined
        }
    }

    /// Shows the system dialog for the microphone when it was never asked.
    /// Returns whether access is granted.
    public static func requestMicrophonePermission() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .audio)
    }

    /// The "Screen & System Audio Recording" permission, without asking.
    /// `.undetermined` also means "the system does not tell": the dialog for
    /// it appears by itself the first time a recording captures system audio.
    public static func systemAudioPermission() -> PermissionStatus {
        SystemAudioPermission.status()
    }

    // MARK: - Recording

    /// Starts recording. May show the microphone dialog and wait for the
    /// answer. Throws when no source could start; with two sources asked and
    /// one refused it records the other one and reports it in `warnings`.
    public func start() async throws {
        var requested: [AudioSource] = []
        if options.captureMicrophone { requested.append(.microphone) }
        if options.captureSystemAudio { requested.append(.systemAudio) }
        guard !requested.isEmpty else { throw MeetingRecorderError.nothingToRecord }

        let free: Bool = lock.withLock {
            guard state == .idle else { return false }
            state = .starting
            activeSources = []
            currentWarnings = []
            lastDuration = 0
            return true
        }
        guard free else { throw MeetingRecorderError.alreadyRecording }

        let url = options.fileName.map { outputDirectory.appendingPathComponent($0) } ?? Self.defaultFileURL(in: outputDirectory)
        let writer: WAVWriter
        do {
            writer = try WAVWriter(url: url, sampleRate: MeetingAudioFormat.sampleRateInt, channels: 1)
        } catch {
            setState(.idle)
            throw MeetingRecorderError.file(error.localizedDescription)
        }

        // Start every source. Audio that arrives before all of them have
        // answered is dropped: the recording begins when start() returns.
        var started: [AudioCaptureSource] = []
        var failures: [RecordingWarning] = []
        for kind in requested {
            let capture = makeSource(kind)
            let slot = started.count
            capture.onEnded = { [weak self] error in self?.sourceEnded(slot: slot, kind: kind, error: error) }
            do {
                try await capture.start { [weak self] samples, sampleRate in
                    self?.queue.async { self?.ingest(slot: slot, samples: samples, sampleRate: sampleRate) }
                }
                started.append(capture)
            } catch {
                capture.onEnded = nil
                capture.stop()
                failures.append(RecordingWarning(source: kind, error: Self.recorderError(error, source: kind)))
            }
        }

        guard !started.isEmpty else {
            try? writer.finish()
            try? FileManager.default.removeItem(at: url)
            let reasons = failures
            lock.withLock {
                state = .idle
                currentWarnings = reasons
            }
            throw failures.first?.error ?? MeetingRecorderError.nothingToRecord
        }

        let pipeline = RecordingPipeline(writer: writer, sourceCount: started.count)
        pipeline.onBatch = { [weak self] batch in
            guard let self else { return }
            self.onLevel?(AudioMath.meterLevel(rms: AudioMath.rms(batch)))
            self.onChunk?(batch)
        }
        queue.sync {
            self.pipeline = pipeline
            self.liveSlots = started.count
            self.failureReported = false
            self.accepting = true
        }
        let running = started
        let reasons = failures
        lock.withLock {
            captures = running
            fileURL = url
            activeSources = running.map(\.kind)
            currentWarnings = reasons
            startedAt = Date()
            state = .recording
        }
    }

    /// Stops, closes the file and says what is in it.
    public func stop() async throws -> RecordingResult {
        let taken: (URL, [AudioCaptureSource], [RecordingWarning])? = lock.withLock {
            guard state == .recording, let url = fileURL else { return nil }
            state = .stopping
            return (url, self.captures, currentWarnings)
        }
        guard let taken else { throw MeetingRecorderError.notRecording }
        let url = taken.0
        let captures = taken.1
        var warnings = taken.2

        for capture in captures {
            capture.onEnded = nil
            capture.stop()
        }

        var duration = 0.0
        var failure: Error?
        var peaks: [Float] = []
        queue.sync {
            self.accepting = false
            guard let pipeline = self.pipeline else { return }
            do {
                duration = try pipeline.finish()
            } catch {
                failure = error
                duration = pipeline.durationSeconds
            }
            peaks = captures.indices.map { pipeline.peak(slot: $0) }
            self.pipeline = nil
        }

        // A source that delivered only zeros is not in the file.
        var captured: [AudioSource] = []
        for (index, capture) in captures.enumerated() {
            if index < peaks.count, peaks[index] > 0 {
                captured.append(capture.kind)
            } else if !warnings.contains(where: { $0.source == capture.kind }) {
                let denied = capture.kind == .systemAudio && SystemAudioPermission.status() == .denied
                warnings.append(RecordingWarning(source: capture.kind, error: denied ? .systemAudioPermissionDenied : .silent(capture.kind)))
            }
        }

        let length = duration
        let finalWarnings = warnings
        lock.withLock {
            self.captures = []
            fileURL = nil
            startedAt = nil
            lastDuration = length
            currentWarnings = finalWarnings
            state = .idle
        }

        if let failure, duration == 0 {
            throw MeetingRecorderError.file(failure.localizedDescription)
        }
        return RecordingResult(fileURL: url, durationSeconds: duration, sources: captured, warnings: warnings)
    }

    /// Stops and deletes the file.
    public func cancel() async {
        if let result = try? await stop() {
            try? FileManager.default.removeItem(at: result.fileURL)
        }
    }

    // MARK: - Internals

    private func setState(_ new: State) {
        lock.lock()
        state = new
        lock.unlock()
    }

    /// On `queue`.
    private func ingest(slot: Int, samples: [Float], sampleRate: Double) {
        guard accepting, let pipeline else { return }
        pipeline.ingest(slot: slot, samples: samples, sampleRate: sampleRate)
        if let failure = pipeline.failure, !failureReported {
            failureReported = true
            onFailure?(.file(failure.localizedDescription))
        }
    }

    private func sourceEnded(slot: Int, kind: AudioSource, error: MeetingRecorderError) {
        lock.lock()
        currentWarnings.append(RecordingWarning(source: kind, error: error))
        lock.unlock()
        queue.async {
            guard self.accepting, let pipeline = self.pipeline else { return }
            pipeline.end(slot: slot)
            self.liveSlots -= 1
            if self.liveSlots <= 0, !self.failureReported {
                self.failureReported = true
                self.onFailure?(error)
            }
        }
    }

    private static func recorderError(_ error: Error, source: AudioSource) -> MeetingRecorderError {
        if let known = error as? MeetingRecorderError { return known }
        switch source {
        case .microphone: return .microphoneUnavailable(error.localizedDescription)
        case .systemAudio: return .systemAudioUnavailable(error.localizedDescription)
        }
    }

    /// "meeting-<date>-<time>.wav", with a counter when that name is taken.
    private static func defaultFileURL(in directory: URL) -> URL {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let base = "meeting-\(formatter.string(from: Date()))"
        var url = directory.appendingPathComponent(base + ".wav")
        var counter = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = directory.appendingPathComponent("\(base)-\(counter).wav")
            counter += 1
        }
        return url
    }
}
