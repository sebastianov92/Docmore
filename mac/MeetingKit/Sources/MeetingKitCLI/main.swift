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

    static let flagNames: Set<String> = ["json", "check", "progress", "no-system-audio", "no-microphone", "help"]

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

    case "download":
        let info = try model(arguments.first("model"))
        let store = ModelStore(directory: try arguments.directory("models-dir"), endpoint: arguments.options["endpoint"])
        var lastShown = -1
        try await store.download(info) { fraction in
            let percent = Int(fraction * 100)
            if percent / 10 != lastShown / 10 || percent == 100, percent != lastShown {
                lastShown = percent
                printError("download \(percent)%")
            }
        }
        print("downloaded \(info.id): \(megabytes(store.sizeOnDisk(info))) in \(store.modelFolder(for: info).path)")

    case "delete":
        let info = try model(arguments.first("model"))
        let store = ModelStore(directory: try arguments.directory("models-dir"))
        try store.delete(info)
        print("deleted \(info.id)")

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
