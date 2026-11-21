import Foundation

public struct LiveMeetingOptions: Equatable, Sendable {
    /// Length of a window of text, at most 30 s (what Whisper reads in one
    /// pass). Shorter windows show text sooner and cut more sentences.
    public var windowSeconds: Double = 15
    /// How much of each track the speaker models hear on every pass: the
    /// last ten minutes. Everything older keeps the speakers it has.
    ///
    /// Why a sliding window and not the whole meeting every time: telling
    /// apart ten minutes takes about 1.3 s on an M3 Pro whatever the length
    /// of the meeting, an hour takes about 7 s and would be repeated four
    /// times a minute; and the labels of what was said long ago stop
    /// moving. Why not shorter: under five minutes the models find voices
    /// that are not there (STATUS.md).
    public var speakerWindowSeconds: Double = 600
    public var diarization = DiarizerOptions.meeting
    public var matching = SpeakerMatchingPolicy()
    public var attribution = SpeakerAttribution.Policy()
    public var echo = EchoFilter.Policy()
    /// Drop from the room track what is only the remote side heard through
    /// the loudspeakers (virtual meetings).
    public var removesEcho = true
    /// Tests with made-up audio switch the audio half of that off.
    var usesEchoGate = true

    public init() {}
}

/// What changed in the transcript of a running meeting.
///
/// Apply it to a list of segments by replacing everything from `fromIndex`
/// on with `segments`: the list then has `segmentCount` entries. That is
/// also what the server's `live/update` does with `fromIndex` and
/// `segments`.
public struct LiveMeetingUpdate: Equatable, Sendable {
    /// Counts the updates of a session, from 1.
    public var revision: Int
    /// The first segment that is new or changed. Equal to the old length
    /// when segments were only added.
    public var fromIndex: Int
    /// Every segment from `fromIndex` to the end, with side and speaker.
    public var segments: [MeetingTranscript.Segment]
    /// How many segments the meeting has now: `fromIndex + segments.count`.
    public var segmentCount: Int
    /// The speakers that have text, by number, with the names set so far.
    public var speakers: [MeetingSpeaker]
    /// How much of the recording has been turned into text.
    public var durationSeconds: Double
    public var language: String?
    /// True for the update `finish()` sends last.
    public var isFinal: Bool
}

/// What to send to the server's `live/update` to bring it up to date.
public struct LiveMeetingUpload: Equatable, Sendable {
    public var fromIndex: Int
    public var segments: [MeetingTranscript.Segment]
    public var speakers: [MeetingSpeaker]
    public var durationSeconds: Double
    /// Hand the upload back to `acknowledge` once the server stored it.
    public var revision: Int
    /// False when the segments were cut at the server's limit: acknowledge
    /// it and ask for the next one.
    public var isComplete: Bool
}

/// Follows a meeting while it is recorded: text, sides and speakers, a few
/// seconds behind.
///
/// ```swift
/// let live = LiveMeetingSession(mode: .virtual, transcriber: transcriber, diarizer: SpeakerDiarizer(modelStore: store))
/// live.onUpdate = { update in ... }                       // or: for await update in live.updates
/// recorder.onTrackChunk = { live.append($0) }
/// ...
/// live.setName("Ana", forSpeaker: "s2")                   // the person typed a name
/// ...
/// let soFar = await live.finish()
/// let result = try await processor.process(fileURL: recording.fileURL, mode: .virtual, state: live.state)
/// ```
///
/// Every `windowSeconds` the new audio of each track is transcribed, the
/// last `speakerWindowSeconds` of each track are diarized again, and one
/// update goes out. A speaker keeps its id for the whole meeting however
/// the diarizer numbers its clusters from pass to pass (`TrackSpeakers`),
/// and `state` carries ids, numbers and names over to the final pass.
///
/// `append` is cheap and safe to call from any thread. Windows are worked
/// on one after another on a background task; when the Mac is slower than
/// real time they queue up. A window that fails is skipped and reported in
/// `errors`. Without speaker models on disk (or with `diarizer` nil) the
/// segments carry only their side.
public final class LiveMeetingSession: @unchecked Sendable {
    public let mode: MeetingMode
    public let options: LiveMeetingOptions

    /// Called for each update, on a background thread.
    public var onUpdate: ((LiveMeetingUpdate) -> Void)?
    /// The same updates as a stream. It ends after `finish()`.
    public let updates: AsyncStream<LiveMeetingUpdate>

    private let transcriber: WordTranscribing
    private let diarizer: SampleDiarizing?

    private struct Track {
        /// The text of the track so far, with word times, by start.
        var raw: [TimedTranscript.Segment] = []
        /// The last `speakerWindowSeconds` of audio and where they begin.
        var recent: [Float] = []
        var recentStart = 0.0
        /// Segments old enough that their speaker can no longer change.
        var settled: [LabelledSegment] = []
        var settledCount = 0
    }

    private let lock = NSLock()
    private var windower: TrackWindower
    private var finished = false
    // touched only by the worker
    private var tracks: [Track]
    // under `lock`
    private var speakerState: MeetingSpeakerState
    private var current: [MeetingTranscript.Segment] = []
    private var currentSpeakers: [MeetingSpeaker] = []
    private var language: String?
    private var processed = 0.0
    private var revision = 0
    private var failures: [String] = []
    private var unsent: [(revision: Int, fromIndex: Int)] = []
    private var spentTranscribing = 0.0
    private var spentOnSpeakers = 0.0

    private let windows: AsyncStream<(window: TrackWindower.Window, last: Bool)>
    private let windowsContinuation: AsyncStream<(window: TrackWindower.Window, last: Bool)>.Continuation
    private let updatesContinuation: AsyncStream<LiveMeetingUpdate>.Continuation
    private var worker: Task<Void, Never>?

    public init(
        mode: MeetingMode,
        transcriber: WordTranscribing,
        diarizer: SampleDiarizing?,
        options: LiveMeetingOptions = LiveMeetingOptions()
    ) {
        self.mode = mode
        self.options = options
        self.transcriber = transcriber
        self.diarizer = diarizer
        let count = mode == .virtual ? 2 : 1
        windower = TrackWindower(trackCount: count, windowSeconds: options.windowSeconds)
        tracks = Array(repeating: Track(), count: count)
        speakerState = MeetingSpeakerState(mode: mode)
        (windows, windowsContinuation) = AsyncStream.makeStream(of: (window: TrackWindower.Window, last: Bool).self)
        (updates, updatesContinuation) = AsyncStream.makeStream(of: LiveMeetingUpdate.self)
        worker = Task { [weak self] in
            guard let stream = self?.windows else { return }
            for await item in stream {
                await self?.process(item.window, last: item.last)
            }
        }
    }

    deinit {
        windowsContinuation.finish()
        updatesContinuation.finish()
    }

    // MARK: - Audio in

    /// Adds a piece of the recording, track by track (16 kHz mono): what
    /// `MeetingRecorder.onTrackChunk` delivers. Ignored after `finish()`.
    public func append(_ chunk: MeetingAudioChunk) {
        append(microphone: chunk.microphone, systemAudio: chunk.systemAudio)
    }

    /// In a virtual meeting both tracks, of the same length (a missing
    /// `systemAudio` counts as silence); in person only the microphone.
    public func append(microphone: [Float], systemAudio: [Float]? = nil) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        let ready = windower.append(mode == .virtual ? [microphone, systemAudio ?? []] : [microphone])
        lock.unlock()
        for window in ready {
            windowsContinuation.yield((window, false))
        }
    }

    /// Works on what is left, waits for every window and returns the
    /// transcript of what was fed. Call it once, after the last `append`.
    /// The final pass over the recording file (`MeetingProcessor`, with
    /// `state`) gives better text and speakers than this.
    @discardableResult
    public func finish() async -> MeetingTranscript {
        let last: TrackWindower.Window? = lock.withLock {
            let already = finished
            finished = true
            return already ? nil : windower.flush()
        }
        if let last {
            windowsContinuation.yield((last, true))
        }
        windowsContinuation.finish()
        await worker?.value
        // the last word on what there is: marks the end for whoever follows the updates
        let closing: LiveMeetingUpdate = lock.withLock {
            revision += 1
            unsent.append((revision, current.count))
            return LiveMeetingUpdate(
                revision: revision, fromIndex: current.count, segments: [], segmentCount: current.count,
                speakers: currentSpeakers, durationSeconds: processed, language: language, isFinal: true
            )
        }
        onUpdate?(closing)
        updatesContinuation.yield(closing)
        updatesContinuation.finish()
        return transcript
    }

    // MARK: - Names

    /// Sets the name the person typed for a speaker (nil or empty: back to
    /// the default label). The name is in every update from now on, in
    /// `state`, and through it in the final transcript. Returns false when
    /// there is no such speaker.
    @discardableResult
    public func setName(_ name: String?, forSpeaker id: String) -> Bool {
        let update: LiveMeetingUpdate? = lock.withLock {
            guard speakerState.setName(name, for: id) else { return nil }
            let named = speakerState.speakers
            currentSpeakers = currentSpeakers.map { speaker in named.first { $0.id == speaker.id } ?? speaker }
            revision += 1
            unsent.append((revision, current.count))
            return LiveMeetingUpdate(
                revision: revision, fromIndex: current.count, segments: [], segmentCount: current.count,
                speakers: currentSpeakers, durationSeconds: processed, language: language, isFinal: false
            )
        }
        guard let update else { return false }
        onUpdate?(update)
        updatesContinuation.yield(update)
        return true
    }

    // MARK: - What there is so far

    /// The transcript so far, with mode, sides and speakers.
    public var transcript: MeetingTranscript {
        lock.lock(); defer { lock.unlock() }
        return MeetingTranscript(
            text: current.map(\.text).joined(separator: " "),
            language: language,
            durationSeconds: processed,
            segments: current,
            mode: mode,
            speakers: currentSpeakers
        )
    }

    public var segments: [MeetingTranscript.Segment] {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    /// The speakers that have text, by number.
    public var speakers: [MeetingSpeaker] {
        lock.lock(); defer { lock.unlock() }
        return currentSpeakers
    }

    /// Everything the final pass needs to keep ids, numbers and names:
    /// `MeetingProcessor.process(..., state:)`. Codable.
    public var state: MeetingSpeakerState {
        lock.lock(); defer { lock.unlock() }
        return speakerState
    }

    /// How much of the recording has been turned into text.
    public var processedSeconds: Double {
        lock.lock(); defer { lock.unlock() }
        return processed
    }

    /// Descriptions of the windows that could not be worked on.
    public var errors: [String] {
        lock.lock(); defer { lock.unlock() }
        return failures
    }

    /// Seconds spent so far transcribing and telling voices apart.
    public var workSeconds: (transcription: Double, speakers: Double) {
        lock.lock(); defer { lock.unlock() }
        return (spentTranscribing, spentOnSpeakers)
    }

    // MARK: - Keeping the server up to date

    /// What the server has not been told yet, as one `live/update` body:
    /// the segments from the first index that changed since the last
    /// acknowledged upload, and the speakers. Nil when it is up to date.
    /// Call it every 30 to 60 seconds, one call at a time.
    ///
    /// A call that failed needs nothing: ask again later and the upload
    /// starts at the same index or before.
    public func pendingUpload(maxSegments: Int = 2000) -> LiveMeetingUpload? {
        lock.lock(); defer { lock.unlock() }
        guard let first = unsent.map(\.fromIndex).min(), let latest = unsent.map(\.revision).max() else { return nil }
        let from = min(first, current.count)
        let tail = Array(current[from...])
        let limit = max(1, maxSegments)
        return LiveMeetingUpload(
            fromIndex: from,
            segments: Array(tail.prefix(limit)),
            speakers: currentSpeakers,
            durationSeconds: processed,
            revision: latest,
            isComplete: tail.count <= limit
        )
    }

    /// The server stored `upload`.
    public func acknowledge(_ upload: LiveMeetingUpload) {
        lock.lock(); defer { lock.unlock() }
        unsent.removeAll { $0.revision <= upload.revision }
        if !upload.isComplete {
            // the rest of the tail still has to go
            unsent.append((upload.revision, upload.fromIndex + upload.segments.count))
        }
    }

    // MARK: - The worker

    private func process(_ window: TrackWindower.Window, last: Bool) async {
        let virtual = mode == .virtual
        var spoke = [Bool](repeating: false, count: tracks.count)

        // 1. The new audio of every track: remember it, and turn it into text.
        for index in tracks.indices {
            let samples = index < window.tracks.count ? window.tracks[index] : []
            tracks[index].recent.append(contentsOf: samples)
            let limit = Int(max(options.windowSeconds, options.speakerWindowSeconds) * MeetingAudioFormat.sampleRate)
            if tracks[index].recent.count > limit {
                let extra = tracks[index].recent.count - limit
                tracks[index].recent.removeFirst(extra)
                tracks[index].recentStart += Double(extra) / MeetingAudioFormat.sampleRate
            }
            guard AudioMath.peak(samples) >= MeetingProcessor.silencePeak else { continue }
            let hint = lock.withLock { language }
            let started = Date()
            do {
                let timed = try await transcriber.transcribeWords(samples: samples, language: hint).shifted(by: window.startSeconds)
                tracks[index].raw.append(contentsOf: timed.segments.filter {
                    !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                })
                spoke[index] = !timed.isEmpty
                lock.withLock {
                    spentTranscribing += Date().timeIntervalSince(started)
                    // keep the language of the first window that had speech
                    if language == nil, !timed.isEmpty, let detected = timed.language, !detected.isEmpty {
                        language = detected
                    }
                }
            } catch {
                let reason = "window \(window.index) (\(Int(window.startSeconds)) s), \(Self.trackName(index, virtual: virtual)): \(error.localizedDescription)"
                lock.withLock { failures.append(reason) }
            }
        }

        // 2. Who speaks, over the last minutes of every track that said
        // something, or that has a voice waiting to be confirmed.
        if let diarizer, diarizer.isAvailable {
            let waiting = lock.withLock { speakerState.tracks.map { $0.voices.contains(where: \.isProvisional) } }
            for index in tracks.indices where spoke[index] || waiting[index] || (last && !tracks[index].raw.isEmpty) {
                let started = Date()
                var heard = tracks[index].recent
                if options.removesEcho, options.usesEchoGate, virtual, index == 0, tracks.count > 1 {
                    heard = EchoGate.suppress(microphone: heard, remote: tracks[1].recent).samples
                }
                let from = tracks[index].recentStart
                do {
                    let diarization = try await diarizer.diarize(samples: heard, options: options.diarization).shifted(by: from)
                    lock.withLock {
                        var track = speakerState.tracks[index]
                        let side = track.side
                        let outcome = track.absorb(
                            diarization, from: from, to: window.endSeconds,
                            policy: options.matching, named: speakerState.namedIds, final: last
                        ) { speakerState.makeSpeaker(side: side) }
                        speakerState.tracks[index] = track
                        var waiting: [String: String] = [:]
                        MeetingProcessor.inheritNames(outcome, into: &speakerState, waiting: &waiting)
                        spentOnSpeakers += Date().timeIntervalSince(started)
                    }
                } catch {
                    let reason = "window \(window.index) (\(Int(window.startSeconds)) s), speakers of the \(Self.trackName(index, virtual: virtual)): \(error.localizedDescription)"
                    lock.withLock { failures.append(reason) }
                }
            }
        }

        // 3. Put it together and say what changed.
        let update: LiveMeetingUpdate? = lock.withLock {
            var labelled: [[LabelledSegment]] = []
            for index in tracks.indices {
                labelled.append(label(track: index))
            }
            let assembly = MeetingAssembler.assemble(tracks: labelled, removeEcho: options.removesEcho && virtual, echoPolicy: options.echo)
            let withText = Set(assembly.speakersInOrder)
            let speakers = speakerState.speakers.filter { withText.contains($0.id) }.sorted { $0.number < $1.number }
            let old = current
            let new = assembly.segments
            var from = 0
            while from < old.count, from < new.count, old[from] == new[from] { from += 1 }
            let speakersChanged = speakers != currentSpeakers
            current = new
            currentSpeakers = speakers
            processed = window.endSeconds
            guard from < new.count || new.count != old.count || speakersChanged else { return nil }
            revision += 1
            unsent.append((revision, from))
            return LiveMeetingUpdate(
                revision: revision, fromIndex: from, segments: Array(new[from...]), segmentCount: new.count,
                speakers: speakers, durationSeconds: processed, language: language, isFinal: false
            )
        }
        if let update {
            onUpdate?(update)
            updatesContinuation.yield(update)
        }
    }

    /// The segments of a track with their speakers. What lies well before
    /// the stretch the speaker models still listen to is settled and kept.
    /// Called under `lock`.
    private func label(track index: Int) -> [LabelledSegment] {
        let speakers = speakerState.tracks[index]
        // two seconds of margin: a segment may take the nearest turn a little after its end
        let horizon = tracks[index].recentStart - 2
        var settle = tracks[index].settledCount
        while settle < tracks[index].raw.count, tracks[index].raw[settle].end <= horizon { settle += 1 }
        if settle > tracks[index].settledCount {
            let fresh = Array(tracks[index].raw[tracks[index].settledCount..<settle])
            tracks[index].settled.append(contentsOf: SpeakerAttribution.label(fresh, speakers: speakers, policy: options.attribution))
            tracks[index].settledCount = settle
        }
        let open = Array(tracks[index].raw[tracks[index].settledCount...])
        return tracks[index].settled + SpeakerAttribution.label(open, speakers: speakers, policy: options.attribution)
    }

    private static func trackName(_ index: Int, virtual: Bool) -> String {
        guard virtual else { return "recording" }
        return index == 0 ? "room track" : "remote track"
    }
}
