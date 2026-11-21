# MeetingKit

The meeting engine of the Docmore macOS app: record a meeting, transcribe it
on the device, tell who said what, queue the transcript for the server. No UI.

- Swift package, macOS 15+, Swift language mode 5.
- One library product, `MeetingKit`, and a command line tool, `meetingkit`.
- One dependency: the WhisperKit package, 1.1.1
  (`https://github.com/argmaxinc/WhisperKit`, the version `mac/project.yml`
  already pins). Two of its products are used: `WhisperKit` (speech to text)
  and `SpeakerKit` (telling voices apart).

A meeting is of one of two kinds, chosen when the recording starts:

- **in person**: the microphone alone. Everybody is in the room.
- **virtual**: the microphone is the room, what the Mac plays is the remote
  side of the call. The two are recorded as separate tracks, so every
  sentence knows its side, and the remote side is never taken from the
  microphone.

Inside each track the voices are told apart on the device. Each voice is a
speaker with an id that is stable for the whole meeting ("s1", "s2", ...),
a number for its default label and, once the person types one, a name.

What has been verified, and how, is in [STATUS.md](STATUS.md). Short version:
transcription, speakers, the echo pass, the queue and the server round trip
of plain transcripts were run for real, with files; live capture from a real
microphone and from system audio was not, because it needs a person to click
the macOS permission dialogs (its logic is covered by unit tests with
scripted audio sources); speakers and echo were only tried with synthetic
voices and a synthetic echo.

```
Sources/MeetingKit/        the library
Sources/MeetingKitObjC/    one Objective-C function (NSException -> NSError)
Sources/MeetingKitCLI/     the `meetingkit` tool
Tests/MeetingKitTests/     unit tests
Tools/                     scripts: the end-to-end run against a server, scoring of speakers
../tools/fixtures/meeting-es/   the Spanish test meeting and its generator
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
dependency for meetings (it may keep it: both pin 1.1.1). SpeakerKit comes
with the same package: nothing to add to `project.yml`.

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
                          +--> LiveMeetingSession --updates--> the panel, the server's live/update
                          |      (text, sides, speakers; setName)      |
MeetingRecorder --tracks--+                                            | state (ids, numbers, names)
      |                                                                v
      +--WAV (1 or 2 channels)--> MeetingProcessor --MeetingTranscript--> MeetingQueue --MeetingSender--> server
                                   (Transcriber + SpeakerDiarizer,        (job: transcript + meetingId)
                                    echo pass, merge)
```

The pieces of the first version are still there and still work the same:
`Transcriber.transcribe(fileURL:)` and `LiveTranscriber` make plain
transcripts (no sides, no speakers) from one mixed track.

### MeetingTranscript, MeetingSpeaker

```swift
public enum MeetingMode: String, Codable { case inPerson = "in_person", virtual }
public enum MeetingSide: String, Codable { case room, remote }

public struct MeetingSpeaker: Codable, Equatable, Identifiable, Sendable {
    public var id: String            // "s1", "s2", ...: stable for the whole meeting
    public var number: Int           // for the default label ("Persona 2"), from 1
    public var side: MeetingSide?    // nil in an in-person meeting
    public var name: String?         // what the person typed; MeetingKit only carries it
}

public struct MeetingTranscript: Codable, Equatable, Sendable {
    public struct Segment: Codable, Equatable, Sendable {
        public var start: Double      // seconds from the start of the recording
        public var end: Double
        public var text: String
        public var speaker: String?   // a MeetingSpeaker.id; nil when voices were not told apart
        public var side: MeetingSide? // nil in an in-person meeting
    }
    public var text: String           // segments joined with spaces
    public var language: String?      // "en", "es", ...
    public var durationSeconds: Double
    public var segments: [Segment]
    public var mode: MeetingMode?     // nil: a plain transcript (no tracks, no speakers)
    public var speakers: [MeetingSpeaker]   // by number; empty when voices were not told apart

    public init(text:language:durationSeconds:segments:mode:speakers:)
    public init(segments:language:durationSeconds:mode:speakers:)   // trims, drops empty ones, sorts, joins
    public var isEmpty: Bool
    public func speaker(_ id: String?) -> MeetingSpeaker?
    public static func joined(_ parts: [MeetingTranscript]) -> MeetingTranscript
}
```

JSON: `{"text", "language", "durationSeconds", "segments": [{"start", "end", "text", "speaker"?, "side"?}], "mode"?, "speakers"?: [{"id", "number", "side", "name"}]}`.
`mode`, `speakers`, and `speaker`/`side` of a segment are left out when
there is nothing in them, so a plain transcript has the JSON it always had
and files written by the first version decode. In a speaker, `side` and
`name` are always written (`null` when there is none): the shape of the
server's `Speaker`.

MeetingKit does not make labels. The contract's default label is the name,
else "Persona N" / "Speaker N", with "(sala)" / "(remoto)" in a virtual
meeting; a segment with a side and no speaker is "Sala" / "Remoto".

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

### Speaker models: SpeakerModelCatalog, SpeakerModelInfo

The models that tell voices apart (Pyannote "community-1" on Core ML, run
by SpeakerKit; from the Hugging Face repository `argmaxinc/speakerkit-coreml`).
One set, 11 MB. They live next to the Whisper models, in the same
directory, and are managed by the same `ModelStore`:

```swift
public struct SpeakerModelInfo: Identifiable, Hashable, Codable, Sendable {
    public let id: String                 // "pyannote-community-1": store it in the settings
    public let displayName: String        // "Speaker recognition"
    public let approximateSizeBytes: Int64
    public let summary: String
}

public enum SpeakerModelCatalog {
    public static let pyannote: SpeakerModelInfo
    public static let all: [SpeakerModelInfo]
    public static let recommended: SpeakerModelInfo
    public static func model(_ idOrAlias: String) -> SpeakerModelInfo?   // also "speakers", "pyannote"
}

extension ModelStore {
    public func isDownloaded(_ model: SpeakerModelInfo) -> Bool
    public func downloadedSpeakerModels() -> [SpeakerModelInfo]
    public func sizeOnDisk(_ model: SpeakerModelInfo) -> Int64
    public func download(_ model: SpeakerModelInfo, progress: ((Double) -> Void)? = nil) async throws
    public func delete(_ model: SpeakerModelInfo) throws
    public func modelFolder(for: SpeakerModelInfo) -> URL
    public func remoteFileCount(_ model: SpeakerModelInfo) async throws -> Int   // diagnostic
}
```

```swift
let speakers = SpeakerModelCatalog.recommended
if !store.isDownloaded(speakers) {
    try await store.download(speakers) { fraction in ... }   // 0...1, any thread; about 11 MB
}
```

- `<directory>/models/argmaxinc/speakerkit-coreml/...`, next to
  `<directory>/models/argmaxinc/whisperkit-coreml/...`.
- `download(_:)` is the only place the speaker models are ever fetched.
  Nothing else downloads them: `SpeakerDiarizer` reads the disk and nothing
  more. While a `MeetingRecorder` of the process is recording, `download`
  refuses with `ModelStoreError.recordingInProgress`.
- Without them everything still works: the transcripts have sides and no
  speakers.
- `delete` removes the speaker models and nothing else.

### SpeakerDiarizer

```swift
public struct SpeakerTurn: Equatable, Sendable { public var start, end: Double; public var cluster: Int }

public struct Diarization: Equatable, Sendable {
    public var turns: [SpeakerTurn]            // by start; one voice at a time
    public var voicePrints: [Int: [Float]]     // per cluster, comparable between runs (VoicePrint.distance)
    public var durationSeconds: Double
    public var clusters: [Int]                 // in order of first appearance
    public var speechSeconds: [Int: Double]
}

public struct DiarizerOptions: Equatable, Sendable {
    public var clusterThreshold: Float?        // nil: SpeakerKit's 0.6
    public var speakerCount: Int?              // when it is known
    public static let meeting: DiarizerOptions // what MeetingKit uses: threshold 0.5
}

public protocol SampleDiarizing: AnyObject, Sendable {
    var isAvailable: Bool { get }
    func diarize(samples: [Float], options: DiarizerOptions) async throws -> Diarization
}

public final class SpeakerDiarizer: SampleDiarizing, @unchecked Sendable {
    public init(modelStore: ModelStore, model: SpeakerModelInfo = SpeakerModelCatalog.recommended)
    public var isAvailable: Bool               // the models are on disk
    public func prepare() async throws         // load the models now (optional)
    public func unload() async
    public func diarize(samples: [Float], options: DiarizerOptions = DiarizerOptions()) async throws -> Diarization   // 16 kHz mono
    public func diarize(fileURL: URL, channel: Int? = nil, options: DiarizerOptions = DiarizerOptions()) async throws -> Diarization
}
```

- The app normally does not call it: it hands one to `LiveMeetingSession`
  and to `MeetingProcessor`.
- Cluster numbers mean something only inside one `Diarization`. What makes
  speakers stable from run to run is `TrackSpeakers` (below).
- The models load on first use (about 6 s the first time on a Mac, 0.05 s
  afterwards) and stay loaded. Calls are served one at a time. No call
  reaches the network. Errors: `SpeakerDiarizerError.modelNotDownloaded`,
  `.modelLoadFailed`, `.failed`.
- `SampleDiarizing` is the protocol the session and the processor take; a
  fake makes UI work testable without models.

### Transcriber

```swift
public enum TranscriptionLanguage: Equatable, Sendable { case automatic, fixed(String) }

public final class Transcriber: SampleTranscribing, WordTranscribing, @unchecked Sendable {
    public init(modelStore: ModelStore, model: WhisperModelInfo, language: TranscriptionLanguage = .automatic)
    public func prepare() async throws                    // load the model now (optional)
    public func unload() async                            // free its memory
    public func transcribe(fileURL: URL, progress: ((Double) -> Void)? = nil) async throws -> MeetingTranscript
    public func transcribe(samples: [Float], language: String? = nil) async throws -> MeetingTranscript   // 16 kHz mono
    public func transcribeWords(samples: [Float], language: String?) async throws -> TimedTranscript       // with the time of every word
    public func transcribeWords(samples: [Float], language: String?, progress: ((Double) -> Void)?) async throws -> TimedTranscript
}

public struct TimedWord: Equatable, Sendable { public var start, end: Double; public var text: String }
public struct TimedTranscript: Equatable, Sendable {
    public struct Segment { public var start, end: Double; public var text: String; public var words: [TimedWord] }
    public var language: String?
    public var durationSeconds: Double
    public var segments: [Segment]
    public var plain: MeetingTranscript
}
public protocol WordTranscribing: AnyObject, Sendable {
    func transcribeWords(samples: [Float], language: String?) async throws -> TimedTranscript
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
- `transcribeWords` is what the live session and the final pass use: the
  time of every word is what lets a segment be split where the voice
  changes, and an echo be matched word by word. `WordTranscribing` is its
  protocol, for fakes.

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
- It makes plain text from one track. For sides and speakers use
  `LiveMeetingSession`.

### MeetingRecorder

```swift
public enum AudioSource: String, Codable, Sendable, CaseIterable { case microphone, systemAudio }
public enum PermissionStatus: String, Sendable { case granted, denied, undetermined }

public struct RecordingOptions: Sendable {
    public init(mode: MeetingMode, fileName: String? = nil)       // .inPerson or .virtual: what the app uses
    public init(captureMicrophone: Bool = true, captureSystemAudio: Bool = true, fileName: String? = nil)   // the first version: mixed
    public var mode: MeetingMode?           // nil for the mixed layout
    public var keepsTracksApart: Bool       // true for .virtual
}

public struct MeetingAudioChunk: Sendable {
    public var microphone: [Float]          // the room, 16 kHz mono
    public var systemAudio: [Float]?        // the remote side, same length; nil when the recording has one track
}

public struct RecordingResult: Sendable {
    public var fileURL: URL                 // 16 kHz 16-bit PCM WAV, one channel or two
    public var durationSeconds: Double
    public var sources: [AudioSource]       // what is really in the file
    public var warnings: [RecordingWarning] // source + MeetingRecorderError
    public var mode: MeetingMode?           // nil for the mixed layout
}

public final class MeetingRecorder: @unchecked Sendable {
    public init(outputDirectory: URL, options: RecordingOptions = RecordingOptions())
    public var onLevel: ((Float) -> Void)?        // 0...1, about ten times a second
    public var onTrackChunk: ((MeetingAudioChunk) -> Void)?   // 0.1 s (1600 samples) of every track
    public var onChunk: (([Float]) -> Void)?      // the same 0.1 s with everything added up, 16 kHz mono
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
let recorder = MeetingRecorder(outputDirectory: recordingsDirectory, options: RecordingOptions(mode: .virtual))
recorder.onLevel = { level in DispatchQueue.main.async { meter.level = level } }
recorder.onTrackChunk = { chunk in live.append(chunk) }       // LiveMeetingSession
try await recorder.start()                    // may show the microphone dialog
if !recorder.sources.contains(.systemAudio) { /* tell the person: see recorder.warnings */ }
...
let result = try await recorder.stop()
```

The three layouts:

| Options | Sources | File | `onTrackChunk` |
| --- | --- | --- | --- |
| `RecordingOptions(mode: .inPerson)` | microphone | one channel | `microphone` |
| `RecordingOptions(mode: .virtual)` | microphone + system audio | two channels: 0 microphone (room), 1 system audio (remote) | `microphone` and `systemAudio`, same length, same span of time |
| `RecordingOptions()` (the first version) | what is switched on | one channel, everything mixed | `microphone` = the mix |

- In a virtual recording the file always has two channels. A source that
  did not start, or that falls behind, is silence in its channel (and a
  warning): the channels stay the same length and the remote side is never
  written to the microphone's channel.
- The two tracks are lined up by arrival, as before: when one source runs
  more than half a second behind, the other goes ahead and the late one is
  filled with silence.
- A recording tells its own kind: `AudioTrackReader.recordedMode(of:)` is
  `.virtual` for two channels and `.inPerson` for one. A one-channel
  recording of the first version has no sides either: it is processed as an
  in-person meeting.

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
  The same for two channels.
- `systemAudioPermission()`: macOS has no public call for this permission.
  MeetingKit looks up the private `TCCAccessPreflight` at run time (no link
  dependency, no dialog). Set `usesPrivatePermissionCheck = false` to never
  touch it; the answer is then always `.undetermined`, which the app should
  read as "will be asked on first use".
- Callbacks run on a private serial queue: hop to the main queue for UI, and
  do not call `start()`/`stop()` from inside a callback.

Also public, for the app's own needs: `WAVWriter`, `WAVFile.read(_:)`,
`WAVFile.readChannels(_:)`, `WAVFile.repairHeader(at:)`, `AudioTrackReader`
(channelCount, recordedMode, channels, samples), `AudioMath` (rms, peak,
meterLevel, mix, resampleTo16k), `StreamResampler`, `LiveChunker`.

### LiveMeetingSession

Text, sides and speakers while the meeting runs.

```swift
public struct LiveMeetingOptions: Equatable, Sendable {
    public var windowSeconds: Double = 15             // text arrives every window
    public var speakerWindowSeconds: Double = 600     // what the speaker models hear on every pass
    public var removesEcho = true
    // also: diarization, matching, attribution, echo (the policies; the defaults are the measured ones)
}

public struct LiveMeetingUpdate: Equatable, Sendable {
    public var revision: Int                          // 1, 2, 3, ...
    public var fromIndex: Int                         // the first segment that is new or changed
    public var segments: [MeetingTranscript.Segment]  // every segment from fromIndex to the end
    public var segmentCount: Int                      // fromIndex + segments.count
    public var speakers: [MeetingSpeaker]             // the speakers that have text, by number, with names
    public var durationSeconds: Double                // how much of the recording is text by now
    public var language: String?
    public var isFinal: Bool                          // the one finish() sends last
}

public final class LiveMeetingSession: @unchecked Sendable {
    public init(mode: MeetingMode, transcriber: WordTranscribing, diarizer: SampleDiarizing?,
                options: LiveMeetingOptions = LiveMeetingOptions())
    public var onUpdate: ((LiveMeetingUpdate) -> Void)?       // on a background thread
    public let updates: AsyncStream<LiveMeetingUpdate>
    public func append(_ chunk: MeetingAudioChunk)            // any thread
    public func append(microphone: [Float], systemAudio: [Float]? = nil)
    @discardableResult public func setName(_ name: String?, forSpeaker id: String) -> Bool
    @discardableResult public func finish() async -> MeetingTranscript
    public var transcript: MeetingTranscript                  // so far
    public var segments: [MeetingTranscript.Segment]
    public var speakers: [MeetingSpeaker]
    public var state: MeetingSpeakerState                     // for MeetingProcessor; Codable
    public var processedSeconds: Double
    public var errors: [String]
    public func pendingUpload(maxSegments: Int = 2000) -> LiveMeetingUpload?
    public func acknowledge(_ upload: LiveMeetingUpload)
}

public struct LiveMeetingUpload: Equatable, Sendable {      // one body of the server's live/update
    public var fromIndex: Int
    public var segments: [MeetingTranscript.Segment]
    public var speakers: [MeetingSpeaker]
    public var durationSeconds: Double
    public var revision: Int
    public var isComplete: Bool
}
```

```swift
let live = LiveMeetingSession(mode: .virtual, transcriber: transcriber, diarizer: SpeakerDiarizer(modelStore: store))
live.onUpdate = { update in
    DispatchQueue.main.async {
        panel.segments = Array(panel.segments.prefix(update.fromIndex)) + update.segments
        panel.speakers = update.speakers
    }
}
recorder.onTrackChunk = { live.append($0) }
...
live.setName("Ana", forSpeaker: "s2")          // the person typed a name in the panel

// every 30 to 60 seconds, one call at a time:
if let upload = live.pendingUpload() {
    try await server.liveUpdate(meetingId, fromIndex: upload.fromIndex, segments: upload.segments,
                                speakers: upload.speakers, durationSeconds: upload.durationSeconds)
    live.acknowledge(upload)                   // only when the server took it
}
...
await live.finish()
let state = live.state                         // goes to the final pass
```

- Every `windowSeconds` both tracks are cut at the same moment (the
  quietest tenth of a second of the last five, over both), the new audio of
  each track is transcribed, the last `speakerWindowSeconds` of each track
  are diarized again, and one update goes out. A track with no sound in a
  window is not given to Whisper.
- An update says what changed: replace everything from `fromIndex` on with
  `segments`. Usually that is the new tail. It starts earlier when earlier
  segments changed: a sentence got its speaker, or changed speaker because
  the models heard more. That is also the meaning of `fromIndex` and
  `segments` in the server's `live/update`.
- **Speaker ids are stable.** The diarizer numbers its clusters afresh on
  every pass; the session maps each cluster to the speaker who was already
  heard saying the same stretch of audio, and, for a voice that comes back
  after being silent for longer than the window, to the known speaker with
  the closest voice print. An id is never used for another voice, and a
  number is never given twice.
- What is older than `speakerWindowSeconds` keeps the speaker it has.
- A new voice heard for less than eight seconds waits one window before it
  is shown as a speaker (its text is shown at once, with its side): when the
  models have heard little they often split one voice in two for a moment.
- `setName` only carries the name: it is in every update from then on, in
  `state`, and through it in the final transcript. When two speakers turn
  out to be one voice, the one that has a name is the one that stays.
- `pendingUpload` / `acknowledge` keep track of what the server has: an
  upload starts at the first segment that changed since the last
  acknowledged one. A call that failed needs nothing: ask again later. More
  than `maxSegments` (the server takes 2000 per call): the upload comes with
  `isComplete == false`; acknowledge it and ask for the next one.
- `finish()` returns what the session made. The final pass over the file
  (`MeetingProcessor`) gives better text and better speakers; give it
  `state` so they keep their ids, numbers and names.
- A window that fails is skipped and reported in `errors`. Without speaker
  models on disk, or with `diarizer` nil, segments carry only their side.
- Why a sliding window of ten minutes, and what it costs: STATUS.md.

### MeetingProcessor

The final pass over a finished recording.

```swift
public struct MeetingTracks: Sendable {
    public var room: [Float]                    // the microphone, or the only track
    public var remote: [Float]?                 // the system audio
    public init(room: [Float], remote: [Float]? = nil)
    public init(contentsOf url: URL) throws     // two channels: room, remote; one channel: one track
    public init(microphone: URL, systemAudio: URL?) throws
    public var durationSeconds: Double
}

public struct ProcessedMeeting: Sendable {
    public var transcript: MeetingTranscript    // mode, sides, speakers
    public var state: MeetingSpeakerState       // the speakers as they are now
    public var echoes: [MeetingTranscript.Segment]   // what the echo pass dropped from the room track
    public var notes: [String]                  // e.g. "The speaker models are not downloaded ..."
    public var transcriptionSeconds: Double
    public var diarizationSeconds: Double
}

public final class MeetingProcessor: @unchecked Sendable {
    public init(transcriber: WordTranscribing, diarizer: SampleDiarizing?,
                options: MeetingProcessingOptions = MeetingProcessingOptions())
    public func process(fileURL: URL, mode: MeetingMode, state: MeetingSpeakerState? = nil,
                        progress: ((Double) -> Void)? = nil) async throws -> ProcessedMeeting
    public func process(_ tracks: MeetingTracks, mode: MeetingMode, state: MeetingSpeakerState? = nil,
                        progress: ((Double) -> Void)? = nil) async throws -> ProcessedMeeting
}
```

```swift
let processor = MeetingProcessor(transcriber: transcriber, diarizer: SpeakerDiarizer(modelStore: store))
let result = try await processor.process(fileURL: recording.fileURL, mode: .virtual, state: live.state) { fraction in ... }
try queue.enqueue(result.transcript, target: target, meetingId: liveMeetingId)
```

- Per track: text with the time of every word, then who speaks when. Each
  segment gets the speaker who talks the most in it; a segment two voices
  clearly share (an answer Whisper glued to the question) is split at the
  word where the voice changes. Then the echo pass (virtual), the two tracks
  merged by time, speakers left with no text dropped.
- Speakers are numbered by first appearance over both tracks. With `state`
  from the live session of the same recording, the speakers the session
  knew keep their id, number and name, and new ones get the next numbers.
- A one-channel recording has no sides: it is processed as an in-person
  meeting whatever `mode` says (there is a note). An in-person meeting given
  two channels is their mix.
- Without speaker models on disk, or with `diarizer` nil: the same
  transcript with sides and no speakers.
- The whole track is in memory while it is worked on (230 MB per track and
  hour).
- `MeetingSpeakerState` is `Codable`: the app can keep `live.state` next to
  the recording and finish a meeting after a crash.

### Echo

With loudspeakers the microphone hears the call: every remote sentence would
be in the transcript twice, and the remote voices would show up as people in
the room. Two things are done about it, in the live session and in the final
pass, both switched by `removesEcho` (on by default):

- `EchoFilter` (text): a room segment is dropped when most of its words
  (70 %, counted in letters) are found in the same order and within 1.5 s in
  what the remote track says. It is deterministic. A room sentence nobody
  said on the other side has nothing to match and is never dropped; neither
  is one that only shares a few small words with what the remote side was
  saying at that moment. Short answers of one or two words ("Sí.") are only
  dropped when every word is found within 0.8 s.
- `EchoGate` (audio, for the speaker models only): in the copy of the
  microphone track the speaker models listen to, the moments that are no
  louder than the echo of the remote track would be are silenced. The text
  is still made from the untouched microphone.

It is not an echo canceller, and it was only tried with a synthetic echo
(STATUS.md). Headphones are still the clean way.

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
    public var meetingId: String?           // the live meeting on the server this transcript finishes
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
                                           userInfo: [String: String] = [:],
                                           meetingId: String? = nil) throws -> MeetingJob
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
- A job carries the transcript as it is (mode, speakers, sides) and, in
  `meetingId`, the id the server gave at `live/start` when the meeting was
  followed live. Job files the first version left in the directory have
  none of that: they still decode and are sent with the body they always had.
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

  ```
  { pageId?, spaceId?, title?, transcript, language?, durationSeconds?,
    segments?: [{ start, end, text, speaker?, side? }],
    meetingId?, mode?, speakers?: [{ id, number, side, name }] }
  ```

  cut to the server's limits (title 200, transcript 2,000,000 characters,
  20,000 segments: more are joined in pairs; speaker names 80).
- `meetingId`, `mode`, `speakers`, and `speaker`/`side` of a segment are
  sent only when the job has something to put in them. A plain transcript
  posts byte for byte the body the first version posted.
- `meetingId` is `job.meetingId`, when it is a UUID. `side` is sent only in
  a virtual meeting. In a speaker `side` and `name` are always there
  (`null` when there is none). A segment never points at a speaker that is
  not in `speakers`.
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

1. Settings > Meetings: list `WhisperModelCatalog.all` and
   `SpeakerModelCatalog.all`, show `store.isDownloaded`, `store.sizeOnDisk`,
   download and delete buttons. No download button for the speaker models
   while a recording runs (`download` refuses anyway).
2. Start: the person picks in person or virtual. Check
   `store.isDownloaded(model)`; `transcriber.prepare()` and, when
   `diarizer.isAvailable`, `diarizer.prepare()` in the background.
   `recorder = MeetingRecorder(outputDirectory:, options: RecordingOptions(mode: mode))`,
   `live = LiveMeetingSession(mode: mode, transcriber: transcriber, diarizer: diarizer)`,
   `recorder.onTrackChunk = { live.append($0) }`, `try await recorder.start()`;
   show `recorder.sources` and `recorder.warnings`. The server's
   `live/start` gives the meeting id.
3. While it runs: `live.onUpdate` feeds the panel; `live.setName` when the
   person names a speaker; every 30 to 60 s `live.pendingUpload()` goes to
   the server's `live/update` and, when it was taken, `live.acknowledge`.
4. Stop: `let result = try await recorder.stop()`, `await live.finish()`
   (one last `pendingUpload`), keep `live.state`. Then
   `processor.process(fileURL: result.fileURL, mode: mode, state: live.state)`.
5. `try queue.enqueue(processed.transcript, target: ..., meetingId: liveMeetingId)`,
   `await queue.flush()`.
6. For each `report.sent`: poll `sender.status(meetingId:)` until done and
   open `pageId`; delete the WAV.
7. At launch: `WAVFile.repairHeader(at:)` for recordings left by a crash,
   `AudioTrackReader.recordedMode(of:)` tells their kind (offer to process
   them, with the `MeetingSpeakerState` the app saved if it saved one);
   `queue.flush()`.
8. On `net.changed` to reachable, and after a sign-in: `queue.flush()`.

## Command line

```
swift build --build-path .build
.build/debug/meetingkit help
```

```
meetingkit models [--models-dir <dir>] [--check]
meetingkit download <model> --models-dir <dir> [--endpoint <url>]
meetingkit delete <model> --models-dir <dir>
meetingkit transcribe <audio> --model <id> --models-dir <dir> [--language en] [--json] [--progress] [--words] [--channel <n>]
meetingkit process <audio> [--system <audio>] [--mode in_person|virtual] --model <id> --models-dir <dir>
                   [--language es] [--state <file>] [--state-out <file>] [--no-speakers] [--no-echo-pass] [--json] [--progress]
meetingkit live-meeting <audio> [--system <audio>] [--mode in_person|virtual] --model <id> --models-dir <dir>
                   [--language es] [--window 15] [--speaker-window 600] [--speed <n>] [--seconds <n>] [--name s2=Ana]
                   [--state-out <file>] [--transcript-out <file>] [--no-speakers] [--no-echo-pass] [--json] [--quiet]
meetingkit diarize <audio> --models-dir <dir> [--channel <n>] [--from <s>] [--seconds <s>] [--threshold 0.5] [--speakers <n>] [--json] [--prints]
meetingkit live <wav> --model <id> --models-dir <dir> [--language en] [--window 30]
meetingkit enqueue <audio> --queue-dir <dir> (--page <id> | --space <id>) [--title <text>] --model <id> --models-dir <dir>
                   [--mode in_person|virtual] [--system <audio>] [--state <file>] [--meeting <id>]
meetingkit queue --queue-dir <dir>
meetingkit flush --queue-dir <dir> --server <url> (--token <bearer> | --token-file <file>) [--json]
meetingkit status <meetingId> --server <url> (--token <bearer> | --token-file <file>) [--wait <seconds>]
meetingkit record --seconds 10 --out <dir> [--mode in_person|virtual] [--no-system-audio] [--no-microphone]
meetingkit permissions
```

`<model>` is an identifier from the table above or a short name: `tiny`,
`base`, `small`, `turbo`, `turbo-full`; `speakers` is the speaker models.
`flush` exits 0 when nothing is left to send and 3 when jobs are still
waiting. `--token-file` takes a file with the bare token or the JSON that
`Tools/lab-token.sh` writes; the token can also come from `MEETINGKIT_TOKEN`.

Meetings with speakers, from files:

```
M=.build/scratch/models
meetingkit download turbo --models-dir $M && meetingkit download speakers --models-dir $M

# the final pass. A two-channel file is a virtual meeting (0 microphone, 1 system audio);
# or the two tracks as two files; or one track in person
meetingkit process meeting.wav --model turbo --models-dir $M --language es --json
meetingkit process microphone.wav --system system.wav --model turbo --models-dir $M --json
meetingkit process mixed.wav --mode in_person --model turbo --models-dir $M

# the live session, replayed as fast as the Mac goes; then the final pass with its speakers
meetingkit live-meeting meeting.wav --model turbo --models-dir $M --json --name s2=Marta --state-out state.json
meetingkit process meeting.wav --model turbo --models-dir $M --state state.json --json
```

`process --json` prints `{ "transcript": MeetingTranscript, "echoes": [...],
"notes": [...], "seconds", "transcriptionSeconds", "diarizationSeconds" }`.
`live-meeting --json` prints one line per update: `{"update": {"revision",
"fromIndex", "segments", "segmentCount", "speakers", "durationSeconds",
"isFinal", "at"}}` (`at`: seconds since the replay started); the summary
goes to the standard error. `Tools/score-speakers.py` compares either with
the ground truth of a generated recording.

`meetingkit record` is for a person: macOS shows the permission dialogs in
the name of the terminal application it runs in.

## Tests

```
swift test --build-path .build
```

TEST_COUNT tests. UNIT_COUNT of them need no microphone, no model and no network
(one opens a connection to a closed local port to see a real connection
failure): the recorder runs on scripted sources, the live session and the
final pass on a scripted transcriber and a scripted diarizer.

The other four (`RealModelTests`) run the real models over the test meeting
below and are skipped when the models are not on disk. They look in the
directory named by `MEETINGKIT_MODELS_DIR`, or in `.build/scratch/models`:

```
swift build --build-path .build
.build/debug/meetingkit download turbo --models-dir .build/scratch/models      # or small, or base
.build/debug/meetingkit download speakers --models-dir .build/scratch/models
swift test --build-path .build --filter RealModelTests
```

The end-to-end run against a server (needs the test credentials in the
repository's `.env`; logs in once and reuses the token while it is valid):

```
Tools/e2e.sh /path/to/speech.wav [--server http://localhost:3100] [--model tiny] [--expect homepage]
```

It sends a plain transcript. The new fields of `from-transcript` and the
`live/*` routes were not on the lab server when this was written: the
sender is tested against the bodies of the contract.

## The test meeting

`mac/tools/fixtures/meeting-es/`: a scripted meeting in Spanish, 123.5 s,
spoken by four macOS voices.

| Who | Side | Voice (`say -v`) |
| --- | --- | --- |
| Ana | room (microphone) | Mónica |
| Luis | room (microphone) | Eddy (Spanish (Spain)) |
| Marta | remote (system audio) | Paulina |
| Carlos | remote (system audio) | Rocko (Spanish (Mexico)) |

Twenty-five turns, one person at a time. At 0:34 Ana decides "entregamos el
viernes"; at 0:44 Luis gives Carlos a task by name ("Carlos, ¿puedes
preparar la presentación para el cliente?", accepted at 0:48 for
"el miércoles"); at 1:15 Marta names a risk; at 1:39 Ana changes the
decision ("mejor el lunes. Entregamos el lunes y no el viernes"); at 1:45
Marta takes a task ("Yo aviso al cliente del cambio de fecha") and at 1:50
Luis another ("yo actualizo el calendario del proyecto hoy mismo").

In the repository:

| File | What |
| --- | --- |
| `meeting-es.virtual.flac` | The recording: two channels, 0 the room, 1 the remote side. 16 kHz, lossless, 1.8 MB. `meetingkit` reads it as it is. |
| `meeting-es.json` | The ground truth: the cast and every turn with speaker, side, start, end and text. |
| `make-fixture.py` | The generator. |
| `expected/` | What MeetingKit made of it (Large v3 Turbo and the speaker models, see STATUS.md): the final transcripts of the virtual and of the in-person form, the result with echo, and the updates and the state of a live session in which "s2" was named Marta. For tests of the server and of the app that should not need the models. |

```
make-fixture.py --from-recording meeting-es.virtual.flac --out DIR
```

writes, from the kept recording and without any voice installed (byte for
byte the same files every time):

| File | What |
| --- | --- |
| `meeting-es.virtual.wav` | two channels: what the recorder writes in virtual mode |
| `meeting-es.room.wav`, `meeting-es.remote.wav` | each track alone |
| `meeting-es.mixed.wav` | everybody in one track: an in-person recording, or a mixed one of the first version |
| `meeting-es.virtual-echo.wav` | the call on loudspeakers: channel 0 is the room plus the remote track 180 ms later at 0.35 of its level |
| `meeting-es.room-echo.wav` | that microphone track alone |

`make-fixture.py` alone speaks the meeting again with `say` (the four voices
must be installed; times then differ a little and come out in a new
`meeting-es.json`). `make-fixture.py --long 60 [--voices 4] [--virtual]`
makes the long recordings of the measurements, with their ground truth.

The four voices were picked to be far apart for the speaker models. Not
every pair of `say` voices is: STATUS.md.
