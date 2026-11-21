# MeetingKit

The meeting engine of the Docmore macOS app: record a meeting, transcribe it
on the device, queue the transcript for the server. No UI.

- Swift package, macOS 15+, Swift language mode 5.
- One library product, `MeetingKit`, and a command line tool, `meetingkit`.
- One dependency: WhisperKit 1.1.1 (`https://github.com/argmaxinc/WhisperKit`,
  the version `mac/project.yml` already pins).

What has been verified, and how, is in [STATUS.md](STATUS.md). Short version:
transcription, the queue and the server round trip were run for real; live
capture from a real microphone and from system audio was not, because it
needs a person to click the macOS permission dialogs (its logic is covered
by unit tests with scripted audio sources).

```
Sources/MeetingKit/        the library
Sources/MeetingKitObjC/    one Objective-C function (NSException -> NSError)
Sources/MeetingKitCLI/     the `meetingkit` tool
Tests/MeetingKitTests/     unit tests
Tools/                     scripts for the end-to-end run against a server
```

## Adding it to the app

`mac/project.yml`:

```yaml
packages:
  MeetingKit:
    path: MeetingKit
targets:
  Docmore:
    dependencies:
      - package: MeetingKit
        product: MeetingKit
```

`import MeetingKit` is enough. The app does not need its own WhisperKit
dependency for meetings (it may keep it: both pin 1.1.1).

### Info.plist and signing

| Key | Why |
| --- | --- |
| `NSMicrophoneUsageDescription` | The microphone. Without it the app is killed when the microphone opens. |
| `NSAudioCaptureUsageDescription` | System audio (the Core Audio process tap). Without it the system never asks and the tap delivers silence. |

Both are already in `mac/project.yml`.

- No entitlement is needed for the process tap in an app without the App
  Sandbox (the current setting).
- With the hardened runtime on (needed for notarization) add
  `com.apple.security.device.audio-input`, or the microphone delivers silence.
- With the App Sandbox on, also `com.apple.security.network.client` for the
  model download and the server.
- An ad-hoc signature (`CODE_SIGN_IDENTITY: "-"`) changes with every build, so
  macOS may ask for both permissions again after a rebuild. A stable signing
  identity makes the answers stick.
- The system audio dialog reads "Screen & System Audio Recording"; the person
  finds it later under System Settings > Privacy & Security > Screen & System
  Audio Recording (the "System Audio Recording Only" list).

## The pieces

They are independent. Use any of them alone: for example run a WAV through
`Transcriber` and `MeetingQueue` without `MeetingRecorder`.

```
MeetingRecorder --WAV--> Transcriber --MeetingTranscript--> MeetingQueue --MeetingSender--> server
      |                       ^
      +-- onChunk --> LiveTranscriber (text while the meeting runs)
```

### MeetingTranscript

```swift
public struct MeetingTranscript: Codable, Equatable, Sendable {
    public struct Segment: Codable, Equatable, Sendable {
        public var start: Double      // seconds from the start of the recording
        public var end: Double
        public var text: String
    }
    public var text: String           // segments joined with spaces
    public var language: String?      // "en", "es", ...
    public var durationSeconds: Double
    public var segments: [Segment]

    public init(text:language:durationSeconds:segments:)
    public init(segments:language:durationSeconds:)   // trims, drops empty ones, sorts, joins
    public var isEmpty: Bool
    public static func joined(_ parts: [MeetingTranscript]) -> MeetingTranscript
}
```

JSON: `{"text": ..., "language": ..., "durationSeconds": ..., "segments": [{"start", "end", "text"}]}`.

### Models: WhisperModelCatalog, WhisperModelInfo, ModelStore

```swift
public struct WhisperModelInfo: Identifiable, Hashable, Codable, Sendable {
    public let id: String                 // WhisperKit identifier
    public let displayName: String
    public let approximateSizeBytes: Int64
    public let tokenizerRepo: String
    public let summary: String
}

public enum WhisperModelCatalog {
    public static let tiny, base, small, largeV3Turbo, largeV3TurboFull: WhisperModelInfo
    public static let all: [WhisperModelInfo]            // smallest first
    public static let recommended: WhisperModelInfo      // largeV3Turbo
    public static func model(_ idOrAlias: String) -> WhisperModelInfo?
}
```

| `id` (WhisperKit identifier) | Name | Download |
| --- | --- | --- |
| `openai_whisper-tiny` | Tiny | 77 MB |
| `openai_whisper-base` | Base | 147 MB |
| `openai_whisper-small` | Small | 487 MB |
| `openai_whisper-large-v3-v20240930_turbo_632MB` | Large v3 Turbo | 646 MB |
| `openai_whisper-large-v3-v20240930_turbo` | Large v3 Turbo (full precision) | 1.64 GB |

All are multilingual. Store the `id` in the app's settings and get the model
back with `WhisperModelCatalog.model(id)`.

```swift
public final class ModelStore: @unchecked Sendable {
    public init(directory: URL, endpoint: String? = nil)   // endpoint: a Hugging Face mirror
    public func isDownloaded(_ model: WhisperModelInfo) -> Bool
    public func downloadedModels() -> [WhisperModelInfo]
    public func sizeOnDisk(_ model: WhisperModelInfo) -> Int64
    public func download(_ model: WhisperModelInfo, progress: ((Double) -> Void)? = nil) async throws
    public func delete(_ model: WhisperModelInfo) throws
    public func modelFolder(for:) -> URL
    public func tokenizerFolder(for:) -> URL
    public func remoteFileCount(_ model: WhisperModelInfo) async throws -> Int   // diagnostic
}
```

```swift
let store = ModelStore(directory: appSupport.appendingPathComponent("WhisperModels"))
let model = WhisperModelCatalog.recommended
if !store.isDownloaded(model) {
    try await store.download(model) { fraction in
        DispatchQueue.main.async { progressBar.doubleValue = fraction }   // 0...1, any thread
    }
}
```

- The download fetches the Core ML model and its tokenizer. Files already on
  disk are skipped, so a cut download continues. Cancel the calling `Task` to
  cancel it. Errors: `ModelStoreError.downloadFailed`.
- `isDownloaded` is true only after a complete download (a marker file), and
  from then on neither `ModelStore` nor `Transcriber` touches the network.

### Transcriber

```swift
public enum TranscriptionLanguage: Equatable, Sendable { case automatic, fixed(String) }

public final class Transcriber: SampleTranscribing, @unchecked Sendable {
    public init(modelStore: ModelStore, model: WhisperModelInfo, language: TranscriptionLanguage = .automatic)
    public func prepare() async throws                    // load the model now (optional)
    public func unload() async                            // free its memory
    public func transcribe(fileURL: URL, progress: ((Double) -> Void)? = nil) async throws -> MeetingTranscript
    public func transcribe(samples: [Float], language: String? = nil) async throws -> MeetingTranscript   // 16 kHz mono
}
```

```swift
let transcriber = Transcriber(modelStore: store, model: model, language: .automatic)
let transcript = try await transcriber.transcribe(fileURL: result.fileURL) { fraction in ... }
```

- Any audio file AVFoundation reads (WAV, M4A, MP3). Long files are read in
  pieces: memory stays bounded.
- `.automatic` detects the language once, from the first half minute that has
  sound in it, and uses it for the whole file. `.fixed("es")` skips detection.
- The model loads on first use and stays loaded. The first load of a model on
  a Mac is slow while Core ML prepares it for the chip (seconds for tiny and
  base, up to a few minutes for the large ones); later loads take a second or
  two. Call `prepare()` early (for example when the recording starts).
- Calls on one `Transcriber` run one at a time.
- Segments that are only a sound label ("[Music]", "(applause)"), which is
  what Whisper writes over silence, are dropped. Segment times are rounded to
  hundredths of a second.
- Errors: `TranscriptionError.modelNotDownloaded`, `.modelLoadFailed`,
  `.audioUnreadable`, `.failed`.

### LiveTranscriber

```swift
public struct LiveTranscriptUpdate: Equatable, Sendable {
    public var index: Int
    public var startSeconds: Double
    public var endSeconds: Double
    public var text: String                // this window only
    public var transcript: MeetingTranscript   // times relative to the recording
}

public final class LiveTranscriber: @unchecked Sendable {
    public init(transcriber: SampleTranscribing, windowSeconds: Double = 30)
    public var onUpdate: ((LiveTranscriptUpdate) -> Void)?
    public let updates: AsyncStream<LiveTranscriptUpdate>
    public func append(samples: [Float])               // 16 kHz mono, any thread
    @discardableResult public func finish() async -> MeetingTranscript
    public var transcript: MeetingTranscript           // so far
    public var errors: [String]
}
```

```swift
let live = LiveTranscriber(transcriber: transcriber)
live.onUpdate = { update in DispatchQueue.main.async { textView.append(update.text) } }
recorder.onChunk = { live.append(samples: $0) }
...
let whole = await live.finish()    // the transcript of everything that was fed
```

- A window closes after `windowSeconds` (at most 30), cut at the quietest
  tenth of a second of its last 5 seconds. Each sample is transcribed once.
- `finish()` returns the full transcript, so with a live transcriber running
  the app can skip `Transcriber.transcribe(fileURL:)` at the end. Transcribing
  the file again gives slightly better text (no cuts between windows).
- `SampleTranscribing` is the one-method protocol `Transcriber` implements;
  a fake makes UI work testable without a model.

### MeetingRecorder

```swift
public enum AudioSource: String, Codable, Sendable, CaseIterable { case microphone, systemAudio }
public enum PermissionStatus: String, Sendable { case granted, denied, undetermined }

public struct RecordingOptions: Sendable {
    public init(captureMicrophone: Bool = true, captureSystemAudio: Bool = true, fileName: String? = nil)
}

public struct RecordingResult: Sendable {
    public var fileURL: URL                 // 16 kHz mono 16-bit PCM WAV
    public var durationSeconds: Double
    public var sources: [AudioSource]       // what is really in the file
    public var warnings: [RecordingWarning] // source + MeetingRecorderError
}

public final class MeetingRecorder: @unchecked Sendable {
    public init(outputDirectory: URL, options: RecordingOptions = RecordingOptions())
    public var onLevel: ((Float) -> Void)?        // 0...1, about ten times a second
    public var onChunk: (([Float]) -> Void)?      // 16 kHz mono, 0.1 s (1600 samples) each
    public var onFailure: ((MeetingRecorderError) -> Void)?
    public func start() async throws
    public func stop() async throws -> RecordingResult
    public func cancel() async                    // stop and delete the file
    public var isRecording: Bool
    public var elapsed: TimeInterval
    public var sources: [AudioSource]             // the sources that started
    public var warnings: [RecordingWarning]
    public static func microphonePermission() -> PermissionStatus
    public static func requestMicrophonePermission() async -> Bool
    public static func systemAudioPermission() -> PermissionStatus
    public static var usesPrivatePermissionCheck: Bool   // default true
}
```

```swift
let recorder = MeetingRecorder(outputDirectory: recordingsDirectory)
recorder.onLevel = { level in DispatchQueue.main.async { meter.level = level } }
try await recorder.start()                    // may show the microphone dialog
if !recorder.sources.contains(.systemAudio) { /* tell the person: see recorder.warnings */ }
...
let result = try await recorder.stop()
```

- `start()` throws only when no source could start
  (`MeetingRecorderError.microphonePermissionDenied`, `.microphoneUnavailable`,
  `.systemAudioPermissionDenied`, `.systemAudioUnavailable`, `.nothingToRecord`,
  `.alreadyRecording`, `.file`). With both sources asked and one refused, it
  records the other and lists the refusal in `warnings`.
- `RecordingResult.sources` lists only sources whose audio is in the file. A
  source that delivered nothing but zeros (which is what macOS gives when
  system audio recording is refused, or while its dialog is still open) is
  left out and gets a `.silent` or `.systemAudioPermissionDenied` warning.
- The file is written as audio arrives and its header is refreshed every
  second: after a crash the WAV opens anywhere and misses at most the last
  second. `WAVFile.repairHeader(at:)` recovers that second on the next launch.
- `systemAudioPermission()`: macOS has no public call for this permission.
  MeetingKit looks up the private `TCCAccessPreflight` at run time (no link
  dependency, no dialog). Set `usesPrivatePermissionCheck = false` to never
  touch it; the answer is then always `.undetermined`, which the app should
  read as "will be asked on first use".
- Callbacks run on a private serial queue: hop to the main queue for UI, and
  do not call `start()`/`stop()` from inside a callback.

Also public, for the app's own needs: `WAVWriter`, `WAVFile.read(_:)`,
`WAVFile.repairHeader(at:)`, `AudioMath` (rms, peak, meterLevel, mix,
resampleTo16k), `StreamResampler`, `LiveChunker`.

### MeetingQueue, MeetingTarget, MeetingJob

```swift
public struct MeetingTarget: Codable, Equatable, Sendable {
    public var pageId: String?      // the page's UUID (not the slug)
    public var spaceId: String?
    public var title: String?
    public static func page(_ pageId: String, title: String? = nil) -> MeetingTarget
    public static func space(_ spaceId: String, title: String? = nil) -> MeetingTarget
}

public struct MeetingJob: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var target: MeetingTarget
    public var transcript: MeetingTranscript
    public var createdAt: Date
    public var attempts: Int
    public var lastAttemptAt: Date?
    public var lastError: String?
    public var userInfo: [String: String]   // the app's own data, e.g. the recording path
}

public struct MeetingReceipt: Codable, Equatable, Sendable {
    public var id: String           // the meeting id on the server
    public var status: String       // queued | summarizing | done | failed
    public var pageId: String?
    public var spaceId: String?
    public var error: String?
    public var isFinished: Bool
}

public protocol MeetingSender: Sendable {
    func send(_ job: MeetingJob) async throws -> MeetingReceipt
}

public final class MeetingQueue: @unchecked Sendable {
    public init(directory: URL, sender: MeetingSender)
    public var onChange: (() -> Void)?
    public var pendingCount: Int
    public var failedCount: Int
    public var needsSignIn: Bool
    public func clearNeedsSignIn()
    public func pendingJobs() -> [MeetingJob]
    public func failedJobs() -> [MeetingJob]
    @discardableResult public func enqueue(_ transcript: MeetingTranscript, target: MeetingTarget,
                                           userInfo: [String: String] = [:]) throws -> MeetingJob
    @discardableResult public func flush() async -> FlushReport
    @discardableResult public func retryFailed(id: String? = nil) throws -> Int
    public func remove(id: String) throws
    public static func disposition(for error: Error) -> SendDisposition
}

public struct FlushReport: Sendable {
    public var sent: [Sent]            // Sent(job, receipt)
    public var failed: [MeetingJob]    // moved to failed/ in this pass
    public var pending: Int            // still waiting
    public var needsSignIn: Bool
    public var stoppedBy: String?      // why the pass ended early
    public var busy: Bool              // another process holds the queue
}
```

```swift
let sender = DocmoreMeetingSender(baseURL: account.serverURL) { try await account.accessToken() }
let queue = MeetingQueue(directory: profileDirectory.appendingPathComponent("meeting-queue"), sender: sender)
queue.onChange = { DispatchQueue.main.async { badge.count = queue.pendingCount } }

try queue.enqueue(transcript, target: .page(pageId, title: "Weekly sync"),
                  userInfo: ["recording": result.fileURL.path])
let report = await queue.flush()
for sent in report.sent { /* sent.receipt.id is the meeting id; delete sent.job.userInfo["recording"] */ }
if report.needsSignIn { /* show the sign-in sheet, then queue.flush() */ }
```

- Files: `<directory>/<job id>.json` waiting, `<directory>/failed/<job id>.json`
  refused. Use one directory per account.
- `enqueue` throws `MeetingQueueError.invalidTarget` (no page and no space)
  and `.emptyTranscript` (nothing was said) instead of storing a job the
  server would refuse.
- The queue has no timer. Call `flush()` after `enqueue`, at launch, and when
  the server becomes reachable (`net.changed`).
- A job is never sent twice at the same moment: calls made while a flush runs
  join it, and a file lock keeps a second process (or a second `MeetingQueue`
  on the same directory) out (`report.busy`).
- What a failed send does to the job (`MeetingQueue.disposition(for:)`):

  | Cause | Job | Pass |
  | --- | --- | --- |
  | No answer (network, timeout, token closure threw) | stays | stops |
  | HTTP 5xx | stays | stops |
  | HTTP 404 | stays | goes on |
  | HTTP 408, 429 | stays | stops |
  | HTTP 401, or `MeetingSendError.needsSignIn` | stays, `needsSignIn` = true | stops |
  | Any other 4xx, or `MeetingSendError.invalid` | moves to `failed/`, reason in `lastError` | goes on |

  408 and 429 are kept, not failed: they mean "try later" (429 is also the
  server's daily AI limit). This is the one deliberate difference from "other
  4xx fails".
- `onChange` runs on an arbitrary thread.

### DocmoreMeetingSender

```swift
public struct DocmoreMeetingSender: MeetingSender {
    public init(baseURL: URL, session: URLSession? = nil,
                authorization: @escaping @Sendable () async throws -> String)
    public func send(_ job: MeetingJob) async throws -> MeetingReceipt
    public func status(meetingId: String) async throws -> MeetingReceipt
}
```

- `POST <base>/api/ai/meetings/from-transcript` with
  `Authorization: Bearer <token>` and the JSON body
  `{ pageId?, spaceId?, title?, transcript, language?, durationSeconds?, segments? }`,
  cut to the server's limits (title 200, transcript 2,000,000 characters,
  20,000 segments: more are joined in pairs).
- `authorization` is called for every request and returns the access token
  (a "Bearer " prefix is accepted). Throw `MeetingSendError.needsSignIn` from
  it when there is no way to get a token; any other error counts as a network
  failure.
- `status(meetingId:)` posts to `/api/ai/meetings/status`. Poll it every few
  seconds until `isFinished`; `pageId` is the page that got the notes.
- Every send carries `Idempotency-Key: <job id>`, and the server honours it:
  a send whose answer was lost (a timeout after the server already took the
  transcript) is sent again and gets the first answer back, with the header
  `Idempotent-Replayed: true`. The notes are written once. The job id stays
  the same on every attempt; the ids the queue makes are UUIDs, which fit the
  server's rule for keys (a hand-made id that does not fit is sent without
  the header). The server keeps a key for 14 days.

## Wiring it in the app

1. Settings > Meetings: list `WhisperModelCatalog.all`, show
   `store.isDownloaded`, `store.sizeOnDisk`, download and delete buttons.
2. Start: check `store.isDownloaded(model)`; `try await recorder.start()`;
   show `recorder.sources` and `recorder.warnings`; `transcriber.prepare()` in
   the background; optionally a `LiveTranscriber` on `recorder.onChunk`.
3. Stop: `let result = try await recorder.stop()`, then
   `transcriber.transcribe(fileURL: result.fileURL)` (or `live.finish()`).
4. `try queue.enqueue(transcript, target: ...)`, `await queue.flush()`.
5. For each `report.sent`: poll `sender.status(meetingId:)` until done and
   open `pageId`; delete the WAV.
6. At launch: `WAVFile.repairHeader(at:)` for recordings left by a crash
   (offer to transcribe them), `queue.flush()`.
7. On `net.changed` to reachable, and after a sign-in: `queue.flush()`.

## Command line

```
swift build --build-path .build
.build/debug/meetingkit help
```

```
meetingkit models [--models-dir <dir>] [--check]
meetingkit download <model> --models-dir <dir> [--endpoint <url>]
meetingkit delete <model> --models-dir <dir>
meetingkit transcribe <audio> --model <id> --models-dir <dir> [--language en] [--json] [--progress]
meetingkit live <wav> --model <id> --models-dir <dir> [--language en] [--window 30]
meetingkit enqueue <audio> --queue-dir <dir> (--page <id> | --space <id>) [--title <text>] --model <id> --models-dir <dir>
meetingkit queue --queue-dir <dir>
meetingkit flush --queue-dir <dir> --server <url> (--token <bearer> | --token-file <file>) [--json]
meetingkit status <meetingId> --server <url> (--token <bearer> | --token-file <file>) [--wait <seconds>]
meetingkit record --seconds 10 --out <dir> [--no-system-audio] [--no-microphone]
meetingkit permissions
```

`<model>` is an identifier from the table above or a short name: `tiny`,
`base`, `small`, `turbo`, `turbo-full`. `flush` exits 0 when nothing is left
to send and 3 when jobs are still waiting. `--token-file` takes a file with
the bare token or the JSON that `Tools/lab-token.sh` writes; the token can
also come from `MEETINGKIT_TOKEN`.

`meetingkit record` is for a person: macOS shows the permission dialogs in
the name of the terminal application it runs in.

## Tests

```
swift test --build-path .build
```

91 tests. None needs a microphone, a model or the network (one opens a
connection to a closed local port to see a real connection failure).

The end-to-end run against a server (needs the test credentials in the
repository's `.env`; logs in once and reuses the token while it is valid):

```
Tools/e2e.sh /path/to/speech.wav [--server http://localhost:3100] [--model tiny] [--expect homepage]
```
