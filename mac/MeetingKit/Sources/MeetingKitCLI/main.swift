import Foundation
import MeetingKit

// meetingkit: a command line front end to MeetingKit, for verification and
// for people. Run `meetingkit help`.

let usage = """
meetingkit \(MeetingKitInfo.version)

  meetingkit models [--models-dir <dir>] [--check]
      The catalog, what is downloaded, and with --check whether each
      identifier resolves in the model repository (needs the network).
  meetingkit download <model> --models-dir <dir> [--endpoint <url>]
  meetingkit delete <model> --models-dir <dir>
  meetingkit transcribe <audio> --model <id> --models-dir <dir> [--language en] [--json] [--progress]
  meetingkit live <wav> --model <id> --models-dir <dir> [--language en] [--window 30]
      Feeds a 16 kHz WAV through the live transcriber, window by window.
  meetingkit enqueue <audio> --queue-dir <dir> (--page <id> | --space <id>) [--title <text>]
                     --model <id> --models-dir <dir> [--language en]
      Transcribes and stores the transcript in the queue. Sends nothing.
  meetingkit queue --queue-dir <dir>
  meetingkit flush --queue-dir <dir> --server <url> (--token <bearer> | --token-file <file>) [--json]
  meetingkit status <meetingId> --server <url> (--token <bearer> | --token-file <file>) [--wait <seconds>]
  meetingkit record --seconds 10 --out <dir> [--no-system-audio] [--no-microphone]
      For a person at the keyboard: macOS asks for the permissions.
  meetingkit permissions
      Microphone and system audio permission, without asking.

<model> is a WhisperKit identifier (openai_whisper-base) or a short name:
tiny, base, small, turbo, turbo-full. The token can also come from the
MEETINGKIT_TOKEN environment variable.
"""

struct Arguments {
    var positional: [String] = []
    var options: [String: String] = [:]
    var flags: Set<String> = []

    static let flagNames: Set<String> = ["json", "check", "progress", "no-system-audio", "no-microphone", "help", "prints", "words", "no-speakers", "no-echo-pass", "quiet"]

    init(_ raw: [String]) throws {
        var index = 0
        while index < raw.count {
            let item = raw[index]
            if item.hasPrefix("--") {
                let name = String(item.dropFirst(2))
                if Self.flagNames.contains(name) {
                    flags.insert(name)
                } else {
                    guard index + 1 < raw.count else { throw CLIError("missing value for --\(name)") }
                    options[name] = raw[index + 1]
                    index += 1
                }
            } else {
                positional.append(item)
            }
            index += 1
        }
    }

    func required(_ name: String) throws -> String {
        guard let value = options[name], !value.isEmpty else { throw CLIError("missing --\(name)") }
        return value
    }

    func directory(_ name: String) throws -> URL {
        URL(fileURLWithPath: try required(name), isDirectory: true)
    }

    func first(_ what: String) throws -> String {
        guard let value = positional.first else { throw CLIError("missing \(what)") }
        return value
    }
}

struct CLIError: Error, CustomStringConvertible {
    var description: String
    init(_ description: String) { self.description = description }
}

func printError(_ text: String) {
    FileHandle.standardError.write(Data((text + "\n").utf8))
}

func megabytes(_ bytes: Int64) -> String {
    String(format: "%.0f MB", Double(bytes) / 1_000_000)
}

func model(_ name: String) throws -> WhisperModelInfo {
    guard let found = WhisperModelCatalog.model(name) else {
        throw CLIError("unknown model \"\(name)\": try \(WhisperModelCatalog.all.map(\.id).joined(separator: ", "))")
    }
    return found
}

func language(_ arguments: Arguments) -> TranscriptionLanguage {
    if let code = arguments.options["language"], !code.isEmpty, code != "auto" { return .fixed(code) }
    return .automatic
}

func transcriber(_ arguments: Arguments) throws -> Transcriber {
    let store = ModelStore(directory: try arguments.directory("models-dir"))
    return Transcriber(modelStore: store, model: try model(arguments.required("model")), language: language(arguments))
}

func token(_ arguments: Arguments) throws -> String {
    if let file = arguments.options["token-file"] {
        let text = try String(contentsOfFile: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        // a dev-token JSON file ({"accessToken": ...}) or the bare token
        if let data = text.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let access = json["accessToken"] as? String {
            return access
        }
        return text
    }
    if let value = arguments.options["token"] { return value }
    if let value = ProcessInfo.processInfo.environment["MEETINGKIT_TOKEN"], !value.isEmpty { return value }
    throw CLIError("missing --token, --token-file or MEETINGKIT_TOKEN")
}

func sender(_ arguments: Arguments) throws -> DocmoreMeetingSender {
    guard let url = URL(string: try arguments.required("server")), url.scheme != nil else {
        throw CLIError("--server must be a URL like http://localhost:3100")
    }
    let bearer = try token(arguments)
    return DocmoreMeetingSender(baseURL: url) { bearer }
}

func jsonString<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
}

func timestamp(_ seconds: Double) -> String {
    let total = Int(seconds)
    return String(format: "%02d:%02d", total / 60, total % 60)
}

/// "virtual" or "in_person" from --mode; without it, what the tracks say.
func meetingMode(_ arguments: Arguments, tracks: MeetingTracks) throws -> MeetingMode {
    guard let text = arguments.options["mode"] else { return tracks.remote == nil ? .inPerson : .virtual }
    switch text.lowercased().replacingOccurrences(of: "-", with: "_") {
    case "virtual": return .virtual
    case "in_person", "inperson": return .inPerson
    default: throw CLIError("--mode is in_person or virtual")
    }
}

/// The default label of the contract: the name, else "Speaker 2 (remote)";
/// a segment without a speaker shows its side.
func label(_ segment: MeetingTranscript.Segment, in transcript: MeetingTranscript) -> String {
    let side = segment.side.map { $0 == .room ? "room" : "remote" }
    guard let speaker = transcript.speaker(segment.speaker) else { return side.map { $0.capitalized } ?? "" }
    if let name = speaker.name { return name }
    return "Speaker \(speaker.number)" + (side.map { " (\($0))" } ?? "")
}

func printTranscript(_ transcript: MeetingTranscript) {
    for segment in transcript.segments {
        let who = label(segment, in: transcript)
        print("[\(timestamp(segment.start)) - \(timestamp(segment.end))] \(who.isEmpty ? "" : who + ": ")\(segment.text)")
    }
}

func run(_ command: String, _ arguments: Arguments) async throws {
    switch command {
    case "models":
        let store = arguments.options["models-dir"].map { ModelStore(directory: URL(fileURLWithPath: $0, isDirectory: true)) }
        for info in WhisperModelCatalog.all {
            var line = "\(info.id)  \(info.displayName), about \(megabytes(info.approximateSizeBytes))"
            if let store {
                line += store.isDownloaded(info) ? "  [downloaded, \(megabytes(store.sizeOnDisk(info))) on disk]" : "  [not downloaded]"
            }
            if arguments.flags.contains("check") {
                let checker = store ?? ModelStore(directory: FileManager.default.temporaryDirectory)
                do {
                    line += "  [resolves: \(try await checker.remoteFileCount(info)) files]"
                } catch {
                    line += "  [does not resolve: \(error.localizedDescription)]"
                }
            }
            print(line)
        }
        for info in SpeakerModelCatalog.all {
            var line = "\(info.id)  \(info.displayName), about \(megabytes(info.approximateSizeBytes))"
            if let store {
                line += store.isDownloaded(info) ? "  [downloaded, \(megabytes(store.sizeOnDisk(info))) on disk]" : "  [not downloaded]"
            }
            if arguments.flags.contains("check") {
                let checker = store ?? ModelStore(directory: FileManager.default.temporaryDirectory)
                do {
                    line += "  [resolves: \(try await checker.remoteFileCount(info)) files]"
                } catch {
                    line += "  [does not resolve: \(error.localizedDescription)]"
                }
            }
            print(line)
        }

    case "download":
        let name = try arguments.first("model")
        let store = ModelStore(directory: try arguments.directory("models-dir"), endpoint: arguments.options["endpoint"])
        var lastShown = -1
        let report: (Double) -> Void = { fraction in
            let percent = Int(fraction * 100)
            if percent / 10 != lastShown / 10 || percent == 100, percent != lastShown {
                lastShown = percent
                printError("download \(percent)%")
            }
        }
        if let speakers = SpeakerModelCatalog.model(name) {
            try await store.download(speakers, progress: report)
            print("downloaded \(speakers.id): \(megabytes(store.sizeOnDisk(speakers))) in \(store.modelFolder(for: speakers).path)")
        } else {
            let info = try model(name)
            try await store.download(info, progress: report)
            print("downloaded \(info.id): \(megabytes(store.sizeOnDisk(info))) in \(store.modelFolder(for: info).path)")
        }

    case "delete":
        let name = try arguments.first("model")
        let store = ModelStore(directory: try arguments.directory("models-dir"))
        if let speakers = SpeakerModelCatalog.model(name) {
            try store.delete(speakers)
            print("deleted \(speakers.id)")
        } else {
            let info = try model(name)
            try store.delete(info)
            print("deleted \(info.id)")
        }

    case "diarize":
        let file = URL(fileURLWithPath: try arguments.first("audio file"))
        let store = ModelStore(directory: try arguments.directory("models-dir"))
        let diarizer = SpeakerDiarizer(modelStore: store)
        let channel = arguments.options["channel"].flatMap { Int($0) }
        var samples = try AudioTrackReader.samples(of: file, channel: channel)
        if let from = arguments.options["from"].flatMap({ Double($0) }) {
            samples = Array(samples.dropFirst(Int(from * MeetingAudioFormat.sampleRate)))
        }
        if let limit = arguments.options["seconds"].flatMap({ Double($0) }) {
            samples = Array(samples.prefix(Int(limit * MeetingAudioFormat.sampleRate)))
        }
        let options = DiarizationOptions(
            clusterThreshold: arguments.options["threshold"].flatMap { Float($0) },
            speakerCount: arguments.options["speakers"].flatMap { Int($0) }
        )
        let loadStarted = Date()
        try await diarizer.prepare()
        let loadSeconds = Date().timeIntervalSince(loadStarted)
        let started = Date()
        let diarization = try await diarizer.diarize(samples: samples, options: options)
        let seconds = Date().timeIntervalSince(started)
        if arguments.flags.contains("json") {
            struct Output: Encodable {
                struct Turn: Encodable { var start: Double; var end: Double; var cluster: Int }
                var durationSeconds: Double
                var loadSeconds: Double
                var diarizeSeconds: Double
                var clusters: [Int]
                var speechSeconds: [String: Double]
                var turns: [Turn]
                var voicePrints: [String: [Float]]?
            }
            print(try jsonString(Output(
                durationSeconds: diarization.durationSeconds,
                loadSeconds: loadSeconds,
                diarizeSeconds: seconds,
                clusters: diarization.clusters,
                speechSeconds: Dictionary(uniqueKeysWithValues: diarization.speechSeconds.map { (String($0.key), ($0.value * 100).rounded() / 100) }),
                turns: diarization.turns.map { .init(start: $0.start, end: $0.end, cluster: $0.cluster) },
                voicePrints: arguments.flags.contains("prints")
                    ? Dictionary(uniqueKeysWithValues: diarization.voicePrints.map { (String($0.key), $0.value) }) : nil
            )))
        } else {
            for turn in diarization.turns {
                print(String(format: "[%@ - %@] voice %d", timestamp(turn.start), timestamp(turn.end), turn.cluster))
            }
        }
        printError(String(format: "%.1f s of audio, %d voices, %d turns, %.2f s to load the models, %.2f s to diarize (%.0fx real time)",
                          diarization.durationSeconds, diarization.clusters.count, diarization.turns.count,
                          loadSeconds, seconds, seconds > 0 ? diarization.durationSeconds / seconds : 0))

    case "transcribe" where arguments.flags.contains("words") || arguments.options["channel"] != nil:
        // one track of the file, with the time of every word
        let file = URL(fileURLWithPath: try arguments.first("audio file"))
        let samples = try AudioTrackReader.samples(of: file, channel: arguments.options["channel"].flatMap { Int($0) })
        let whisper = try transcriber(arguments)
        try await whisper.prepare()
        let started = Date()
        let timed = try await whisper.transcribeWords(samples: samples, language: nil)
        let seconds = Date().timeIntervalSince(started)
        if arguments.flags.contains("json") {
            struct Output: Encodable {
                struct Word: Encodable { var start: Double; var end: Double; var text: String }
                struct Segment: Encodable { var start: Double; var end: Double; var text: String; var words: [Word] }
                var language: String?
                var durationSeconds: Double
                var segments: [Segment]
            }
            print(try jsonString(Output(
                language: timed.language,
                durationSeconds: timed.durationSeconds,
                segments: timed.segments.map { segment in
                    .init(start: segment.start, end: segment.end, text: segment.text,
                          words: segment.words.map { .init(start: $0.start, end: $0.end, text: $0.text) })
                }
            )))
        } else {
            for segment in timed.segments {
                print(String(format: "[%6.2f - %6.2f] %@", segment.start, segment.end, segment.text))
            }
        }
        printError(String(format: "language %@, %.1f s of audio, %d segments, %d words, %.1f s to transcribe",
                          timed.language ?? "?", timed.durationSeconds, timed.segments.count,
                          timed.segments.reduce(0) { $0 + $1.words.count }, seconds))

    case "transcribe":
        let file = URL(fileURLWithPath: try arguments.first("audio file"))
        let started = Date()
        let showProgress = arguments.flags.contains("progress")
        let transcript = try await transcriber(arguments).transcribe(fileURL: file) { fraction in
            if showProgress { printError(String(format: "progress %.0f%%", fraction * 100)) }
        }
        if arguments.flags.contains("json") {
            print(try jsonString(transcript))
        } else {
            for segment in transcript.segments {
                print("[\(timestamp(segment.start)) - \(timestamp(segment.end))] \(segment.text)")
            }
            printError(String(format: "language %@, %.1f s of audio, %d segments, %.1f s to transcribe",
                              transcript.language ?? "?", transcript.durationSeconds, transcript.segments.count, Date().timeIntervalSince(started)))
        }

    case "process":
        let file = URL(fileURLWithPath: try arguments.first("audio file"))
        let tracks: MeetingTracks
        if let system = arguments.options["system"] {
            tracks = try MeetingTracks(microphone: file, systemAudio: URL(fileURLWithPath: system))
        } else {
            tracks = try MeetingTracks(contentsOf: file)
        }
        let mode = try meetingMode(arguments, tracks: tracks)
        let store = ModelStore(directory: try arguments.directory("models-dir"))
        let whisper = try transcriber(arguments)
        var options = MeetingProcessingOptions()
        options.removesEcho = !arguments.flags.contains("no-echo-pass")
        if let threshold = arguments.options["threshold"].flatMap({ Float($0) }) { options.diarization.clusterThreshold = threshold }
        let processor = MeetingProcessor(
            transcriber: whisper,
            diarizer: arguments.flags.contains("no-speakers") ? nil : SpeakerDiarizer(modelStore: store),
            options: options
        )
        var seed: MeetingSpeakerState?
        if let path = arguments.options["state"] {
            seed = try JSONDecoder().decode(MeetingSpeakerState.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        }
        let showProgress = arguments.flags.contains("progress")
        let started = Date()
        let result = try await processor.process(tracks, mode: mode, state: seed) { fraction in
            if showProgress { printError(String(format: "progress %.0f%%", fraction * 100)) }
        }
        let seconds = Date().timeIntervalSince(started)
        if let path = arguments.options["state-out"] {
            try Data(try jsonString(result.state).utf8).write(to: URL(fileURLWithPath: path))
        }
        if arguments.flags.contains("json") {
            struct Output: Encodable {
                var transcript: MeetingTranscript
                var echoes: [MeetingTranscript.Segment]
                var notes: [String]
                var seconds: Double
                var transcriptionSeconds: Double
                var diarizationSeconds: Double
            }
            print(try jsonString(Output(
                transcript: result.transcript, echoes: result.echoes, notes: result.notes,
                seconds: seconds, transcriptionSeconds: result.transcriptionSeconds, diarizationSeconds: result.diarizationSeconds
            )))
        } else {
            printTranscript(result.transcript)
            for echo in result.echoes {
                print("echo dropped [\(timestamp(echo.start)) - \(timestamp(echo.end))] \(echo.text)")
            }
        }
        for note in result.notes { printError("note: \(note)") }
        printError(String(format: "%@, language %@, %.1f s of audio, %d segments, %d speakers, %d echoes dropped; %.1f s in all (%.1f s transcribing, %.1f s telling voices apart)",
                          result.transcript.mode?.rawValue ?? "?", result.transcript.language ?? "?", result.transcript.durationSeconds,
                          result.transcript.segments.count, result.transcript.speakers.count, result.echoes.count,
                          seconds, result.transcriptionSeconds, result.diarizationSeconds))

    case "live-meeting":
        // replays a recording through the live session, a tenth of a second at a time
        let file = URL(fileURLWithPath: try arguments.first("audio file"))
        var tracks: MeetingTracks
        if let system = arguments.options["system"] {
            tracks = try MeetingTracks(microphone: file, systemAudio: URL(fileURLWithPath: system))
        } else {
            tracks = try MeetingTracks(contentsOf: file)
        }
        let mode = try meetingMode(arguments, tracks: tracks)
        if mode == .inPerson, tracks.remote != nil { tracks = MeetingTracks(room: tracks.mixed) }
        if let limit = arguments.options["seconds"].flatMap({ Double($0) }) {
            let count = Int(limit * MeetingAudioFormat.sampleRate)
            tracks = MeetingTracks(room: Array(tracks.room.prefix(count)), remote: tracks.remote.map { Array($0.prefix(count)) })
        }
        let store = ModelStore(directory: try arguments.directory("models-dir"))
        let whisper = try transcriber(arguments)
        try await whisper.prepare()
        let diarizer: SpeakerDiarizer? = arguments.flags.contains("no-speakers") ? nil : SpeakerDiarizer(modelStore: store)
        if let diarizer, diarizer.isAvailable { try await diarizer.prepare() }
        var options = LiveMeetingOptions()
        if let window = arguments.options["window"].flatMap({ Double($0) }) { options.windowSeconds = window }
        if let window = arguments.options["speaker-window"].flatMap({ Double($0) }) { options.speakerWindowSeconds = window }
        options.removesEcho = !arguments.flags.contains("no-echo-pass")
        let session = LiveMeetingSession(mode: mode, transcriber: whisper, diarizer: diarizer, options: options)
        let asJSON = arguments.flags.contains("json")
        let quiet = arguments.flags.contains("quiet")
        let started = Date()
        struct UpdateLine: Encodable {
            struct Body: Encodable {
                var revision: Int
                var fromIndex: Int
                var segments: [MeetingTranscript.Segment]
                var segmentCount: Int
                var speakers: [MeetingSpeaker]
                var durationSeconds: Double
                var isFinal: Bool
                /// Seconds since the replay started.
                var at: Double
            }
            var update: Body
        }
        let compact = JSONEncoder()
        compact.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var names: [String: String] = [:]
        for pair in (arguments.options["name"] ?? "").split(separator: ",") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if parts.count == 2 { names[parts[0]] = parts[1] }
        }
        session.onUpdate = { update in
            // names given on the command line are typed the moment the speaker shows up
            for speaker in update.speakers where speaker.name == nil {
                if let name = names[speaker.id] { session.setName(name, forSpeaker: speaker.id) }
            }
            guard !quiet else { return }
            let at = Date().timeIntervalSince(started)
            if asJSON {
                let line = UpdateLine(update: .init(
                    revision: update.revision, fromIndex: update.fromIndex, segments: update.segments,
                    segmentCount: update.segmentCount, speakers: update.speakers,
                    durationSeconds: update.durationSeconds, isFinal: update.isFinal, at: at
                ))
                if let data = try? compact.encode(line) { print(String(decoding: data, as: UTF8.self)) }
            } else {
                let who = update.speakers.map { "\($0.id)\($0.side.map { "/" + $0.rawValue } ?? "")\($0.name.map { "=" + $0 } ?? "")" }.joined(separator: " ")
                print(String(format: "update %d at %@ (+%.1f s): from segment %d, %d in all; speakers: %@%@",
                             update.revision, timestamp(update.durationSeconds), at, update.fromIndex, update.segmentCount,
                             who.isEmpty ? "none" : who, update.isFinal ? " (final)" : ""))
                let view = MeetingTranscript(text: "", language: nil, durationSeconds: 0, segments: update.segments, mode: mode, speakers: update.speakers)
                for segment in update.segments {
                    let label = label(segment, in: view)
                    print("    [\(timestamp(segment.start)) - \(timestamp(segment.end))] \(label.isEmpty ? "" : label + ": ")\(segment.text)")
                }
            }
        }
        // the recorder hands over a tenth of a second at a time
        let speed = Double(arguments.options["speed"] ?? "") ?? 0
        var offset = 0
        let total = tracks.room.count
        while offset < total {
            let end = min(total, offset + 1600)
            session.append(microphone: Array(tracks.room[offset..<end]), systemAudio: tracks.remote.map { Array($0[offset..<min($0.count, end)]) })
            offset = end
            if speed > 0 {
                // --speed 10: ten times faster than the meeting ran
                let due = Double(offset) / MeetingAudioFormat.sampleRate / speed
                let ahead = due - Date().timeIntervalSince(started)
                if ahead > 0 { try await Task.sleep(nanoseconds: UInt64(ahead * 1_000_000_000)) }
            }
        }
        let transcript = await session.finish()
        let seconds = Date().timeIntervalSince(started)
        for failure in session.errors { printError("failed: \(failure)") }
        if let path = arguments.options["state-out"] {
            try Data(try jsonString(session.state).utf8).write(to: URL(fileURLWithPath: path))
        }
        if let path = arguments.options["transcript-out"] {
            try Data(try jsonString(transcript).utf8).write(to: URL(fileURLWithPath: path))
        }
        if !asJSON, !quiet {
            print("transcript at the end:")
            printTranscript(transcript)
        }
        let work = session.workSeconds
        printError(String(format: "%@, language %@, %.1f s of audio, %d segments, %d speakers; replayed in %.1f s (%.1fx real time): %.1f s transcribing, %.1f s telling voices apart",
                          mode.rawValue, transcript.language ?? "?", transcript.durationSeconds, transcript.segments.count,
                          transcript.speakers.count, seconds, seconds > 0 ? transcript.durationSeconds / seconds : 0,
                          work.transcription, work.speakers))

    case "live":
        let audio = try WAVFile.read(URL(fileURLWithPath: try arguments.first("WAV file")))
        guard audio.sampleRate == MeetingAudioFormat.sampleRate else {
            throw CLIError("live needs a 16 kHz WAV (this one is \(Int(audio.sampleRate)) Hz)")
        }
        let live = LiveTranscriber(transcriber: try transcriber(arguments), windowSeconds: Double(arguments.options["window"] ?? "") ?? 30)
        live.onUpdate = { update in
            print("window \(update.index) [\(timestamp(update.startSeconds)) - \(timestamp(update.endSeconds))] \(update.text)")
        }
        // the recorder hands over a tenth of a second at a time
        var offset = 0
        while offset < audio.samples.count {
            let end = min(audio.samples.count, offset + 1600)
            live.append(samples: Array(audio.samples[offset..<end]))
            offset = end
        }
        let transcript = await live.finish()
        for failure in live.errors { printError("failed: \(failure)") }
        printError(String(format: "language %@, %.1f s, %d segments", transcript.language ?? "?", transcript.durationSeconds, transcript.segments.count))

    case "enqueue":
        let file = URL(fileURLWithPath: try arguments.first("audio file"))
        let target = MeetingTarget(pageId: arguments.options["page"], spaceId: arguments.options["space"], title: arguments.options["title"])
        guard target.pageId != nil || target.spaceId != nil else { throw CLIError("missing --page or --space") }
        let transcript = try await transcriber(arguments).transcribe(fileURL: file)
        let queue = MeetingQueue(directory: try arguments.directory("queue-dir"), sender: ClosureMeetingSender { _ in
            throw MeetingSendError.invalid("enqueue does not send")
        })
        let job = try queue.enqueue(transcript, target: target, userInfo: ["recording": file.path])
        print("queued \(job.id): \(transcript.segments.count) segments, \(transcript.text.count) characters, language \(transcript.language ?? "?")")
        print("pending \(queue.pendingCount), failed \(queue.failedCount)")

    case "queue":
        let queue = MeetingQueue(directory: try arguments.directory("queue-dir"), sender: ClosureMeetingSender { _ in
            throw MeetingSendError.invalid("queue does not send")
        })
        print("pending \(queue.pendingCount), failed \(queue.failedCount)")
        for job in queue.pendingJobs() {
            print("pending \(job.id) attempts \(job.attempts)\(job.lastError.map { " last error: \($0)" } ?? "")")
        }
        for job in queue.failedJobs() {
            print("failed  \(job.id) reason: \(job.lastError ?? "?")")
        }

    case "flush":
        let queue = MeetingQueue(directory: try arguments.directory("queue-dir"), sender: try sender(arguments))
        let report = await queue.flush()
        if arguments.flags.contains("json") {
            struct Output: Encodable {
                struct Sent: Encodable { var jobId: String; var meetingId: String; var status: String; var pageId: String? }
                struct Failed: Encodable { var jobId: String; var reason: String }
                var sent: [Sent]
                var failed: [Failed]
                var pending: Int
                var needsSignIn: Bool
                var stoppedBy: String?
                var busy: Bool
            }
            print(try jsonString(Output(
                sent: report.sent.map { .init(jobId: $0.job.id, meetingId: $0.receipt.id, status: $0.receipt.status, pageId: $0.receipt.pageId) },
                failed: report.failed.map { .init(jobId: $0.id, reason: $0.lastError ?? "") },
                pending: report.pending,
                needsSignIn: report.needsSignIn,
                stoppedBy: report.stoppedBy,
                busy: report.busy
            )))
        } else {
            for sent in report.sent {
                print("sent \(sent.job.id) -> meeting \(sent.receipt.id) (\(sent.receipt.status))")
            }
            for failed in report.failed {
                print("failed \(failed.id): \(failed.lastError ?? "?")")
            }
            if report.busy { print("another process is flushing this queue") }
            if report.needsSignIn { print("needs sign-in") }
            if let reason = report.stoppedBy { print("stopped: \(reason)") }
            print("pending \(report.pending), failed \(queue.failedCount)")
        }
        // 0: nothing left to send; 3: jobs are still waiting
        if report.pending > 0 { exit(3) }

    case "status":
        let meetingId = try arguments.first("meeting id")
        let client = try sender(arguments)
        let deadline = Date().addingTimeInterval(Double(arguments.options["wait"] ?? "") ?? 0)
        while true {
            let receipt = try await client.status(meetingId: meetingId)
            if receipt.isFinished || Date() >= deadline {
                print("\(receipt.status)\(receipt.pageId.map { " page \($0)" } ?? "")\(receipt.error.map { " error: \($0)" } ?? "")")
                if receipt.status == "failed" { exit(4) }
                if !receipt.isFinished { exit(3) }
                return
            }
            try await Task.sleep(nanoseconds: 2_000_000_000)
        }

    case "record":
        let seconds = Double(arguments.options["seconds"] ?? "") ?? 10
        let options = RecordingOptions(
            captureMicrophone: !arguments.flags.contains("no-microphone"),
            captureSystemAudio: !arguments.flags.contains("no-system-audio")
        )
        let recorder = MeetingRecorder(outputDirectory: try arguments.directory("out"), options: options)
        var lastPrint = Date.distantPast
        recorder.onLevel = { level in
            guard Date().timeIntervalSince(lastPrint) > 0.5 else { return }
            lastPrint = Date()
            let bars = String(repeating: "#", count: Int(level * 40))
            printError(String(format: "%5.1f s  %@", recorder.elapsed, bars))
        }
        recorder.onFailure = { error in printError("recording failed: \(error.localizedDescription)") }
        try await recorder.start()
        printError("recording \(recorder.sources.map(\.rawValue).joined(separator: " + ")) for \(Int(seconds)) s")
        for warning in recorder.warnings { printError("warning (\(warning.source.rawValue)): \(warning.error.localizedDescription)") }
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        let result = try await recorder.stop()
        for warning in result.warnings { printError("warning (\(warning.source.rawValue)): \(warning.error.localizedDescription)") }
        print(String(format: "%@  %.1f s  sources: %@", result.fileURL.path, result.durationSeconds,
                     result.sources.isEmpty ? "none" : result.sources.map(\.rawValue).joined(separator: ", ")))

    case "permissions":
        print("microphone: \(MeetingRecorder.microphonePermission().rawValue)")
        print("system audio: \(MeetingRecorder.systemAudioPermission().rawValue)")

    default:
        throw CLIError("unknown command \"\(command)\"")
    }
}

var raw = Array(CommandLine.arguments.dropFirst())
guard let command = raw.first, command != "help", command != "--help", command != "-h" else {
    print(usage)
    exit(raw.isEmpty ? 2 : 0)
}
raw.removeFirst()

do {
    try await run(command, try Arguments(raw))
} catch let error as CLIError {
    printError("meetingkit: \(error.description)")
    exit(2)
} catch {
    printError("meetingkit: \(error.localizedDescription)")
    exit(1)
}
