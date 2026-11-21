# MeetingKit: status

Last update: 2026-11-21. Machine: MacBook Pro, Apple M3 Pro (12 cores),
36 GB, macOS 27.0.1, Xcode 27.2 (Swift 6.4.2). WhisperKit package 1.1.1
(products WhisperKit and SpeakerKit). Lab server at `http://localhost:3100`.

All commands run from `mac/MeetingKit/`. `$WAV` is the 16.6 s English sample
(`meeting.wav`, 16 kHz mono) that mentions a homepage, Maria and Tom.
Everything the runs wrote is under `.build/scratch/` (models, logs, queues).

This file has two parts: **meetings with speakers** (the second round of
work: tracks, speakers, echo, the live session), then what was verified in
the first round and still holds (transcription, queue, server round trip).

## Summary

| Piece | State |
| --- | --- |
| Build, unit tests | Verified: 0 warnings, TEST_TOTAL tests green (UNIT_TOTAL without models, 4 with the real models) |
| Transcription with WhisperKit (file, samples, live windows, word times) | Verified with real models |
| Model catalog, download, delete, size (Whisper and speaker models) | Verified against the real repositories |
| Transcription and speakers with no network | Verified with networking denied to the process |
| Speaker models: never fetched except by `download`, refused while recording | Verified (unit test, and the no-network run) |
| Telling voices apart (SpeakerKit) | Verified with real models on **synthetic voices only**; numbers below |
| Recording in two aligned tracks, crash repair, old recordings | Verified by unit tests with scripted sources |
| Final pass: sides, speakers, split by words, merge | Verified with real models on the test meeting and on an hour of synthetic speech |
| Echo pass (text) and echo gate (audio for the speaker models) | Verified on a **synthetic echo only**: never tried with real loudspeakers |
| Live session: updates, stable ids, a voice that comes back, hand-over to the final pass | Verified with real models, replayed from files, up to one hour |
| Queue, retry rules, no double send; old job files | Verified by unit tests and (plain transcripts) against the lab |
| Docmore sender: plain body unchanged; `meetingId`, `mode`, `speakers`, `speaker`/`side` | Body verified by unit tests against the contract. **Not sent to a server**: the routes were not deployed |
| **Live capture: microphone (AVAudioEngine)** | **Not verified, needs a human click** |
| **Live capture: system audio (Core Audio process tap)** | **Not verified, needs a human click** |
| **Real voices, real rooms, real loudspeakers** | **Not verified: there was nobody to talk** |

## Verified in the first round (still holds)

The numbers of this part are from before the work on speakers; what was run
again is said in each place.

### Build

```
swift build --build-path .build --build-tests     # after removing the package's own intermediates
# warnings: 0  errors: 0  -> Build complete!
xcodebuild -scheme MeetingKit-Package -destination 'platform=macOS,arch=arm64' -derivedDataPath .build/xcode build
# ** BUILD SUCCEEDED **  (how the app's Xcode project will build it)
```

### Unit tests

```
swift test --build-path .build
# Executed @@TEST_TOTAL@@ tests, with 0 failures (0 unexpected) in @@TEST_SECONDS@@ seconds
```

@@UNIT_TOTAL@@ of them need no model (run again after the work on speakers:
the 91 of the first round are all still there and green). The four of
`RealModelTests` run the real models over the test meeting and are skipped
without them.

| Suite | Tests | What it covers |
| --- | --- | --- |
| WAVFileTests | 9 | write in uneven pieces and read back sample by sample; canonical 44-byte header; AVAudioFile opens it; the file is valid while still recording (header at most 1 s behind); stale header tolerated and repaired; stereo; clamping and NaN; not-a-WAV |
| AudioMathTests | 13 | 48 kHz and 44.1 kHz sine to 16 kHz: expected length, RMS and pitch; streaming in device-sized blocks without clicks; a 12 kHz tone is removed (anti-aliasing); downmix from interleaved, from AVAudioPCMBuffer, from interleaved and deinterleaved AudioBufferList; mix adds and clamps; energy of two tones; meter scale |
| SourceMixerTests | 5 | sum over the common span; nothing lost with uneven arrival (sample-exact); a stalled source does not hold the recording; an ended source is not waited for |
| LiveChunkerTests | 6 | windows cover the stream with no gap or overlap; 25 to 30 s each; cut falls in a pause; same windows however the audio arrives; 30 s cap |
| LiveTranscriberTests | 5 | every sample transcribed once, in order; times moved to the recording's clock; language of the first speech kept; a failed window skipped and reported; stream ends |
| MeetingRecorderTests | 14 | scripted microphone to a 16 kHz mono WAV (duration, energy, pitch, level, 0.1 s chunks); two sources at 44.1 and 48 kHz mixed; system audio refused -> microphone alone, with the warning; no microphone -> system audio alone; no source -> clean error, no file; silent source not reported as captured; file readable mid-recording; source lost midway; state errors; permission queries |
| SeparateTracksTests | 10 | the options of the two kinds of meeting; a virtual recording is two channels, the microphone alone in 0 and the system audio alone in 1 (pitch and level of each), same length, live chunks per track that add up to the file; a missing source is a silent channel, never the other source; in person records the microphone alone; the mixed layout of the first version unchanged and read as one track; a late source is padded; a two-channel recording cut by a crash is repaired; reading tracks from one file or two; the speaker models are refused while a recording runs and allowed again after stop and after cancel |
| TrackWindowerTests | 3 | both tracks cut at the same samples, in a pause both have; one track behaves like `LiveChunker`; unequal blocks padded |
| MeetingQueueTests | 16 | one JSON file per job; survives a new queue object; retry classification table; network failure keeps the job and a later flush sends it once; the job id is the same on every attempt; 401 keeps it and reports needs-sign-in; 400/403 move to `failed/` with the reason; 404 keeps and goes on; 8 concurrent flushes send each job once, never two at a time; a job stored during a flush is sent; a second queue on the directory gets `busy`; `onChange`; unreadable file moved aside; removed job does not come back |
| MeetingJobCodingTests | 3 | a job file exactly as the first version wrote it decodes, encodes back to the same bytes and is sent with the old body; such a file left in the queue directory is flushed; a job with mode, speakers and `meetingId` survives the disk and another queue object |
| DocmoreMeetingSenderTests | 17 | request path, headers and exact JSON keys; the same `Idempotency-Key` on every attempt of a job, none for an id the server would refuse as a key; envelope parsing; status and message for 400/401/403/404/429/502; real connection failure is a network error; token asked each time; no token -> needs sign-in, nothing sent; odd 2xx body does not cause a resend; `status`; limits (title, 20,000 segments, 2,000,000 characters). New: a plain transcript posts byte for byte the old body; `meetingId`, `mode`, `speakers` (with `side` and `name` as null when there is none) and `speaker`/`side` of segments exactly as the contract; no sides in person; invalid speaker ids, unknown references, a `meetingId` that is not a UUID and names over 80 characters never reach the server; joined segments keep a speaker only when both had it |
| MeetingTranscriptTests | 10 | JSON shape `{text, language, durationSeconds, segments:[{start,end,text}]}`; decode; build from segments; join; sound labels; Whisper markers. New: the shape with mode, speakers and sides; speakers write `side` and `name` as null; the two tracks merge by time, the room first on a tie; join keeps mode and speakers |
| ModelStoreTests | 5 | catalog identifiers and aliases; on-disk layout; `isDownloaded` needs model, tokenizer and marker; delete keeps a shared tokenizer; transcribing without the model says so |
| SpeakerModelStoreTests | 6 | catalog and aliases; the layout SpeakerKit reads, next to the Whisper models; `isDownloaded` needs every part and the marker; delete removes the speaker models and nothing else; without the models the diarizer says so and starts no download; diarization values |
| TrackSpeakersTests | 14 | speakers in order of first appearance; ids stay when the diarizer renumbers its clusters; a voice heard little waits one pass; a voice that melts into another never uses a number; what lies before the window is untouched; a voice that comes back is recognised by its print; the print does not fade as the window slides away; too little speech to tell waits; two speakers that were one person become one (the named one stays); one that was two; the final pass gives every voice a speaker and keeps the ids of the live session; the state survives JSON; voice print distance |
| SpeakerAttributionTests | 7 | the speaker who talks the most in a segment; a segment two voices share is split at the word; the edge of a turn does not split; without word times; the nearest turn; no speakers; a voice not confirmed yet labels nothing |
| EchoFilterTests | 8 | a room segment that repeats the remote side is dropped; what only the room said is never dropped (other words, the same words at another time, talking over the call); the quieter copy heard slightly differently; short answers need to be right on time; a voice that is mostly echo needs less evidence; without word times; deterministic; word normalisation |
| EchoGateTests | 3 | delay (180 ms) and level (0.35) of a synthetic echo found; the echo silenced, its tail too; the room untouched sample for sample, also when it talks over the call; headphones; a silent remote side |
| MeetingProcessorTests | 9 | a virtual meeting becomes one transcript with sides and speakers numbered by first appearance, the echo and its voice gone; the speakers of the live session keep ids, numbers and names; one of them with no text left is dropped; without speaker models only sides; a one-track recording has no sides; a silent track is not worked on; a track that cannot be diarized keeps its text; in person on two channels is one track; deterministic |
| LiveMeetingSessionTests | 10 | updates carry the changed tail and the speakers, and following them gives the transcript; the stream ends; ids never change over four minutes of a sliding window while the diarizer renumbers its clusters on every pass, and a voice that comes back gets its id; the end of a turn that leaves the window keeps its speaker; a name typed during the meeting is on the same voice in the final transcript; sides, and silence is not given to Whisper; the echo is never shown; without speaker models only sides; a window that fails is skipped and reported; uploads start at the first segment the server has not stored |
| RealModelTests | 4 | with the real models over the test meeting: the speaker models tell the four voices apart (one track, and each side); the final pass gives sides, four speakers in order of first appearance and the story (the decision, its change, the task) with the right people; the echo of loudspeakers (synthetic) is removed and nothing the room said; the live session ends with the four people and hands its ids, numbers and a name to the final pass |

### Models (real repository, real downloads)

```
.build/debug/meetingkit models --models-dir .build/scratch/models --check
# openai_whisper-tiny                              [resolves: 19 files]
# openai_whisper-base                              [resolves: 19 files]
# openai_whisper-small                             [resolves: 19 files]
# openai_whisper-large-v3-v20240930_turbo_632MB    [resolves: 22 files]
# openai_whisper-large-v3-v20240930_turbo          [resolves: 24 files]

.build/debug/meetingkit download tiny  --models-dir .build/scratch/models   # 77 MB, 30 s
.build/debug/meetingkit download base  --models-dir .build/scratch/models   # 150 MB, 26 s
.build/debug/meetingkit download turbo --models-dir .build/scratch/models   # 654 MB, 39 s
.build/debug/meetingkit delete base --models-dir .build/scratch/models      # folder, bookkeeping and tokenizer gone
.build/debug/meetingkit download base --models-dir .build/scratch/models    # back, and it transcribes
```

tiny, base and the 632 MB turbo were downloaded, loaded and used. small and
the full-precision turbo were only resolved (file listing), not downloaded.
The turbo model was deleted after the runs; tiny and base are still in
`.build/scratch/models` (the end-to-end script uses tiny).

### Real transcription

```
.build/debug/meetingkit transcribe "$WAV" --model tiny --models-dir .build/scratch/models
# language en, 16.6 s of audio, 7 segments, 1.2 s to transcribe (5.6 s the first time)
# [00:00 - 00:02] Welcome everyone to the weekly sink.
# [00:02 - 00:05] First, the deploy of the new homepage is done and live.
# [00:05 - 00:09] Second, we decided to move the launch to next Friday.
# [00:09 - 00:14] Maria will write the release notes and Tom will update the pricing page before Thursday.
# [00:14 - 00:15] Any questions?
# [00:15 - 00:16] Great.
# [00:16 - 00:17] Thanks all.
```

The transcript contains "homepage" with tiny and with turbo. base writes it
as two words ("the new home page") and gets "weekly sync" right; turbo gets
both right. `--json` prints the `MeetingTranscript` JSON.

Also run:

- An 85 s recording (`say`-generated, WAV 16 kHz and M4A 22 kHz): 16 segments
  with times up to 84.6 s, sorted, inside the duration, text equal to the
  segments joined. So the 30 s chunking and the piecewise file reading keep
  absolute times. base: 2.4 s warm; turbo: 7 s including the model load.
- Spanish (27 s), language automatic: detected `es`, Spanish text.
- 45 s of near-silence, then the Spanish speech: detected `es` (detection
  skips the silent start), first segment at 00:45, and the "[Música]" that
  Whisper writes over the silence is dropped.
- `--progress`: 0, 27, 55, 61, 80, 81, 99, 100 % on the 85 s file (monotonic).
- Live helper: `meetingkit live "$WAV" --model tiny --models-dir .build/scratch/models --window 8`
  fed the WAV 0.1 s at a time and printed three windows cut at pauses
  (00:00-00:05, 00:05-00:10, 00:10-00:16) with the same words as the file run.
- First load of turbo on this Mac: 160 s (Core ML prepares the model for the
  chip, once). Later runs: 7 s in total for the 85 s file, load included.

### No network once the model is on disk

Done by denying all networking to the process with the system sandbox
(`sandbox-exec`), not by pointing at an unreachable host. Controls show the
denial is real:

```
P='(version 1)(allow default)(deny network*)'
sandbox-exec -p "$P" curl -sS -m 8 https://huggingface.co
# curl: (6) Could not resolve host: huggingface.co            (outside the sandbox: HTTP 200)
sandbox-exec -p "$P" .build/debug/meetingkit models --models-dir .build/scratch/models --check
# ... [does not resolve: Download failed: ... Operation not permitted]
sandbox-exec -p "$P" .build/debug/meetingkit download small --models-dir .build/scratch/models
# meetingkit: The model could not be downloaded: Download failed: ... Operation not permitted
sandbox-exec -p "$P" .build/debug/meetingkit transcribe "$WAV" --model tiny --models-dir .build/scratch/models
# language en, 16.6 s of audio, 7 segments, 1.2 s to transcribe
# ... [00:02 - 00:05] First, the deploy of the new homepage is done and live. ...
sandbox-exec -p "$P" .build/debug/meetingkit live "$WAV" --model tiny --models-dir .build/scratch/models --window 8
# three windows, same text
```

Same with base, and with turbo on the 85 s file. (Inside that sandbox Core
ML did not reuse its prepared copy of the model, so turbo took 165 s there
against 7 s outside; a property of the sandboxed test, not of the app.)

### End to end against the lab

```
Tools/e2e.sh "$WAV"            # 26 checks, ALL PASSED, exit 0 (last of four runs; the first three had 22 checks)
```

Two logins in all: one for the first three runs and one for the fourth
(`Tools/lab-token.sh` reuses its token file while the token works; the file
was removed between the third and the fourth run). What the script does and what it saw:

1. Creates a test page in the space `general`.
2. `meetingkit enqueue "$WAV" --queue-dir Q --page <id> --title "Weekly sync" --model tiny --models-dir ...`:
   one job file, transcript contains "homepage".
3. `meetingkit flush --queue-dir Q --server http://127.0.0.1:9 ...` (nobody
   listens there): exit 3, `sent 0, pending 1, failed 0`, the job file now
   has `attempts: 1` and `lastError: "Could not connect to the server."`.
4. `meetingkit flush` with a token the server does not know: HTTP 401,
   `pending 1, failed 0, needsSignIn true`.
5. `meetingkit flush --server http://localhost:3100 --token-file ...`: exit 0,
   `sent 1`, it is the same job id, the queue directory is empty.
6. `meetingkit flush` again: `sent 0, pending 0` (sent once).
   Then the lost-answer case: the job file is put back in the queue, as a
   timeout after the server took the transcript would leave it, and flushed
   again. The server answers with the same meeting id (`Idempotency-Key`),
   `/api/ai/meetings` lists one meeting for the test page, and the page ends
   up with one "Transcript" section: the notes are written once.
7. `meetingkit status <meetingId> --wait 180`: `done page <the test page>`.
   `/api/ai/meetings/status` reports `language en, durationSeconds 17,
   fileName "Weekly sync"`.
8. `/api/pages/info`: the page text contains "homepage" and contains the
   whole transcript word for word (plus the summary, decisions and action
   items the lab's model wrote: "Write release notes — Maria", "Update
   pricing page — Tom").
9. The same with `--space <general>`: the server created a new page with the
   notes; `status` returned its id.
10. Both pages deleted (`/api/pages/delete`, HTTP 200). Eight test pages were
    created over the four runs and all eight were deleted.

Rejections, against the real server:

```
meetingkit enqueue "$WAV" --queue-dir Q2 --page not-a-uuid ... ; meetingkit flush --queue-dir Q2 ...
# failed <job>: The server answered 400: pageId must be a UUID      -> Q2/failed/<job>.json
meetingkit enqueue "$WAV" --queue-dir Q2 --page 01a1fd78-0000-7000-8000-000000000000 ... ; meetingkit flush ...
# pending <job> attempts 1 last error: The server answered 404: Page not found   (kept, exit 3)
```

### Permissions (queries only, nothing was prompted)

```
.build/debug/meetingkit permissions
# microphone: granted
# system audio: undetermined
```

Those are the answers for the process tree this ran in, not for the app.

## Not verified, and why

Nobody was there to click or to talk, and the rules of these runs forbid
GUI automation and answering permission dialogs. `meetingkit record` was
never started.

Meetings with speakers:

- **Real voices.** Every voice was text-to-speech. Whether the speaker
  models tell two real people apart, in particular two of the same sex and
  age, how they cope with laughter, interruptions, people talking at once,
  a bad microphone or a noisy room: not measured. The thresholds that
  decide "the same voice" (0.35) and the clustering threshold (0.5) were
  set on synthetic voices.
- **Real echo.** The echo pass and the echo gate were only tried with the
  remote track mixed into the microphone track, delayed 180 ms, at 0.35 of
  its level. Never with loudspeakers, a room and a microphone.
- **Two tracks from real devices.** `RecordingOptions(mode: .virtual)` is
  tested with scripted sources. With real devices the two tracks are lined
  up by arrival; how far apart they really are (and so how well the echo
  measures line up) will only show in a real recording. The echo pass
  tolerates 1.5 s.
- **The server.** `meetingId`, `mode`, `speakers` and `speaker`/`side` were
  never posted to a server: the routes were not deployed. The body is
  checked against the contract by unit tests. `live/update` is not called
  by MeetingKit at all: the session only says what to send
  (`pendingUpload`).
- **Meetings longer than an hour**, and more than six voices.
- **Other languages than Spanish** for speakers and echo (the echo pass
  compares words after removing accents and case; languages written
  without spaces were not tried).
- **Memory.** The final pass keeps a whole track in memory (230 MB per
  track and hour); the live session ten minutes per track. Not measured
  beyond the fact that the hour-long runs went through.
- **The app's Xcode build with the SpeakerKit product**: the package was
  built with `xcodebuild` on its own (@@XCODEBUILD@@), not inside the app.

What a person needs to do to close the first three (ten minutes): record a
short real call in virtual mode with loudspeakers and with headphones
(`meetingkit record --seconds 120 --out DIR --mode virtual`), then
`meetingkit process DIR/<file>.wav --model turbo --models-dir M` and read
the result: the remote sentences once, on the remote side; the people in
the room as speakers of the room; and the list of echoes dropped.

Capture, as in the first round:

- **Microphone capture** (`MicrophoneCapture`: AVAudioEngine input tap, the
  permission request, restart after a device change). Written, compiles,
  never run against a device.
- **System audio capture** (`SystemAudioCapture`: `CATapDescription`,
  `AudioHardwareCreateProcessTap`, private aggregate device, IO block).
  Written, compiles, never run. Open questions a first run will answer:
  - whether the aggregate device that holds only the tap (the way Apple's
    documentation shows) starts on this macOS; if creating or starting it
    returns an error the code falls back to an aggregate with the default
    output device as clock, but if it starts and never calls back there is no
    fallback (the recording would then be microphone only, with a
    "silent" warning for system audio);
  - what the tap delivers while the permission dialog is open and after a
    refusal (expected: zeros; the recorder then leaves system audio out of
    `sources` and adds a warning);
  - what happens when the output device changes during a recording (the tap
    format is re-read on change; untested).
- **`systemAudioPermission()` values `.granted` and `.denied`**. Only
  `.undetermined` was observed. The mapping (0 granted, 1 denied, other
  undetermined) of the private `TCCAccessPreflight` is from published
  examples, not from a test here.
- **The level meter and the chunks with real audio**: covered with scripted
  sources only.

What a person needs to do to close this (about two minutes):

```
.build/debug/meetingkit record --seconds 10 --out .build/scratch/rec                       # both: allow the two dialogs
.build/debug/meetingkit record --seconds 10 --out .build/scratch/rec --no-system-audio     # microphone only
.build/debug/meetingkit record --seconds 10 --out .build/scratch/rec --no-microphone       # play some audio meanwhile
.build/debug/meetingkit transcribe .build/scratch/rec/<file>.wav --model base --models-dir .build/scratch/models
```

Expected: a level bar while it records, a line with the file, its length and
`sources: microphone, systemAudio`, and a transcript of what was said and
played. In a terminal the dialogs appear in the name of the terminal
application. Then refuse system audio once (System Settings > Privacy &
Security > Screen & System Audio Recording) and check that the result says
`sources: microphone` with a warning.

Other things not exercised:

- Cancelling a download or a transcription in the middle.
- Recordings of an hour or more (the longest real run was 85 s). The file is
  read in pieces by WhisperKit; memory was not measured.
- The models small and turbo full precision (resolved, not downloaded).
- HTTP 429 (the daily AI limit) and 5xx from the real server; both are
  covered by unit tests of the rule and of the sender.
- The `Idempotent-Replayed: true` response header itself: the sender does not
  read it (the lead saw it with two identical requests). What the header
  stands for, the same meeting id and a single meeting, is checked by the
  end-to-end run above.
- A repeat of a job more than 14 days after its first send: the server has
  forgotten the key by then and would write the notes again.

## Known limits

- Two sources are aligned by arrival, not by timestamps: when one runs more
  than 0.5 s behind, the other goes ahead and the late one is filled with
  silence. Fine for transcription, not sample-accurate.
- No echo cancellation. With loudspeakers the echo of the call is removed
  from the transcript as text and kept away from the speaker models, both
  only as well as described above. Headphones are cleaner.
- Voices that sound alike are one speaker; now and then a single sentence
  gets a speaker of its own; the first minutes of a meeting are rough. All
  with numbers above.
- Speaker numbers can have gaps (a speaker that turned out to be part of
  another one is gone, and its number is not used again), and they follow
  the order in which voices were confirmed, which is not always the order
  of the first word.
- In the live session a sentence can change speaker for up to ten minutes
  after it was said, and a new voice heard for under eight seconds has no
  speaker for one window (15 s).
- A segment is split between two voices only at a word, and only when each
  part has two words and 0.7 s: a one-word answer inside somebody else's
  sentence stays with that sentence.
- A one-channel recording has no sides, whatever mode is asked.
- No pause and resume.
- The queue does not retry by itself: the app calls `flush()`.
- `needsSignIn` lives in memory; after a relaunch the next flush finds out
  again.
