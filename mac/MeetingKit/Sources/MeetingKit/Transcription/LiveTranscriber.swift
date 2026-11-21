import Foundation

/// The text of one window of a running recording.
public struct LiveTranscriptUpdate: Equatable, Sendable {
    /// Position of the window, starting at 0.
    public var index: Int
    /// Where the window starts and ends in the recording, in seconds.
    public var startSeconds: Double
    public var endSeconds: Double
    /// The text of this window alone (may be empty: silence).
    public var text: String
    /// The window's transcript with times relative to the start of the
    /// recording.
    public var transcript: MeetingTranscript
}

/// Transcribes a recording while it runs: feed it 16 kHz mono samples, get
/// the text of each window of about half a minute. Every sample is
/// transcribed once; the recording is never read again from the start.
///
/// ```swift
/// let live = LiveTranscriber(transcriber: transcriber)
/// live.onUpdate = { update in ... }                 // or: for await update in live.updates
/// recorder.onChunk = { live.append(samples: $0) }
/// ...
/// let transcript = await live.finish()              // the whole meeting
/// ```
///
/// `append` is cheap and safe to call from any thread, including the
/// recorder's callback. Windows are transcribed one after another on a
/// background task; when the model is slower than real time they queue up.
/// A window that fails to transcribe is skipped and reported in `errors`.
public final class LiveTranscriber: @unchecked Sendable {
    /// Called for each window, on a background thread.
    public var onUpdate: ((LiveTranscriptUpdate) -> Void)?
    /// The same updates as a stream. It ends after `finish()`.
    public let updates: AsyncStream<LiveTranscriptUpdate>

    private let transcriber: SampleTranscribing
    private let lock = NSLock()
    private var chunker: LiveChunker
    private var finished = false
    private var parts: [MeetingTranscript] = []
    private var failures: [String] = []
    private var language: String?

    private let windows: AsyncStream<LiveChunker.Window>
    private let windowsContinuation: AsyncStream<LiveChunker.Window>.Continuation
    private let updatesContinuation: AsyncStream<LiveTranscriptUpdate>.Continuation
    private var worker: Task<Void, Never>?

    /// - Parameter windowSeconds: length of a window, at most 30 (what
    ///   Whisper reads in one pass). Shorter windows give text sooner and
    ///   cut more sentences.
    public init(transcriber: SampleTranscribing, windowSeconds: Double = 30) {
        self.transcriber = transcriber
        chunker = LiveChunker(windowSeconds: windowSeconds)
        (windows, windowsContinuation) = AsyncStream.makeStream(of: LiveChunker.Window.self)
        (updates, updatesContinuation) = AsyncStream.makeStream(of: LiveTranscriptUpdate.self)
        worker = Task { [weak self] in
            guard let stream = self?.windows else { return }
            for await window in stream {
                await self?.process(window)
            }
        }
    }

    deinit {
        windowsContinuation.finish()
        updatesContinuation.finish()
    }

    /// Adds 16 kHz mono samples. Ignored after `finish()`.
    public func append(samples: [Float]) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        let ready = chunker.append(samples)
        lock.unlock()
        for window in ready {
            windowsContinuation.yield(window)
        }
    }

    /// Transcribes what is left, waits for every window and returns the
    /// transcript of the whole recording. Call it once, after the last
    /// `append`.
    @discardableResult
    public func finish() async -> MeetingTranscript {
        let last: LiveChunker.Window? = lock.withLock {
            let already = finished
            finished = true
            return already ? nil : chunker.flush()
        }
        if let last { windowsContinuation.yield(last) }
        windowsContinuation.finish()
        await worker?.value
        updatesContinuation.finish()
        return transcript
    }

    /// What has been transcribed so far.
    public var transcript: MeetingTranscript {
        lock.lock(); defer { lock.unlock() }
        return MeetingTranscript.joined(parts)
    }

    /// Descriptions of the windows that could not be transcribed.
    public var errors: [String] {
        lock.lock(); defer { lock.unlock() }
        return failures
    }

    private func process(_ window: LiveChunker.Window) async {
        let hint = lock.withLock { language }
        do {
            var result = try await transcriber.transcribe(samples: window.samples, language: hint)
            // times inside the window -> times inside the recording
            result.segments = result.segments.map {
                MeetingTranscript.Segment(start: $0.start + window.startSeconds, end: $0.end + window.startSeconds, text: $0.text)
            }
            result.durationSeconds = window.durationSeconds
            let transcribed = result
            lock.withLock {
                parts.append(transcribed)
                // keep the language of the first window that had speech
                if language == nil, !transcribed.isEmpty, let detected = transcribed.language, !detected.isEmpty {
                    language = detected
                }
            }
            let update = LiveTranscriptUpdate(
                index: window.index,
                startSeconds: window.startSeconds,
                endSeconds: window.endSeconds,
                text: result.text,
                transcript: result
            )
            onUpdate?(update)
            updatesContinuation.yield(update)
        } catch {
            let reason = "window \(window.index) (\(Int(window.startSeconds)) s): \(error.localizedDescription)"
            lock.withLock {
                failures.append(reason)
                // the audio still counts towards the duration
                parts.append(MeetingTranscript(text: "", language: nil, durationSeconds: window.durationSeconds, segments: []))
            }
        }
    }
}
