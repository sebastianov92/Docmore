# Docmore for Mac

A native shell for a Docmore server. The window is the real Docmore web
client in a `WKWebView`; everything around it is native: windows and tabs,
menus, sign-in, token storage, network, offline files, notifications,
Spotlight, quick notes, lock and meeting capture.

The web client is served from disk by the app, so the app opens with no
server. Every `/api` call of the page goes through the app, which adds the
sign-in. `STATUS.md` says what is verified and what is not.

## Requirements

- macOS 15 or later, Xcode 27 (Swift 5 language mode)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`
- a Docmore server with the sync endpoints (`/api/sync/info` answers
  `sync: 1`)
- network access to GitHub for the Swift packages (Sparkle, and WhisperKit
  through `mac/MeetingKit`) on the first build

## Build, run, test

All commands from the repository root.

```bash
# the Xcode project is generated, not committed
(cd mac && xcodegen generate)

# build (DerivedData stays inside mac/build)
xcodebuild -project mac/Docmore.xcodeproj -scheme Docmore -configuration Debug \
  -derivedDataPath mac/build build

# run
open mac/build/Build/Products/Debug/Docmore.app

# unit tests (pure logic, the app is not launched)
xcodebuild test -project mac/Docmore.xcodeproj -scheme Docmore \
  -derivedDataPath mac/build -destination 'platform=macOS'

# end to end against a running server (default http://localhost:3100)
mac/tools/e2e.sh

# Release build packaged as zip and DMG in mac/dist
mac/tools/package.sh
```

`mac/tools/e2e.sh` needs the test accounts of the repository's `.env`
(`LOCAL_TEST_ADMIN_EMAIL`, `LOCAL_TEST_ADMIN_PASSWORD`, and the member pair
for the two-account checks). It runs the app with a temporary data directory,
deletes the pages it creates and leaves screenshots and logs in
`mac/build/e2e/<time>/`.

Its meeting checks use models kept in `mac/build/e2e-models` (the data
directory's `models` is a link to it, so a model keeps its path from run to
run and macOS prepares a large one for the chip once, not every time). The
tiny Whisper model is downloaded there on the first run. The checks with
the Spanish test meeting (`mac/tools/fixtures/meeting-es`) need Whisper
large-v3 turbo (646 MB) in that folder and are skipped without it;
`DOCMORE_E2E_LARGE_MODEL=1 mac/tools/e2e.sh` lets the app download it once.

The notes of a meeting are written by the server's language model. A check
that needs them waits `DOCMORE_E2E_NOTES_WAIT` seconds (150) per group of
meetings and then says which of three things happened: the notes are there
(checked), the server still has the meeting with its model (the check is
reported as skipped, with that reason), or the server failed it (a
failure). Everything up to "the server has the transcript" is checked at
once and never skipped.

## Layout of the code

```
mac/project.yml            XcodeGen project (app + logic tests)
mac/Docmore/Core/          pure logic, also compiled into the test bundle (the shapes and the
                           live bookkeeping of meetings are here: Meeting*.swift)
mac/Docmore/App/           services, sign-in, reachability, coordinator
mac/Docmore/Web/           scheme handler, proxy, bridge, page scripts
mac/Docmore/UI/            windows, menus, settings, account picker
mac/Docmore/Features/      lock, quick note, meeting detection, updater
mac/Docmore/Meetings/      meeting controller, chooser and panel, engine protocol and adapter
mac/MeetingKit/            local Swift package: recording, WhisperKit, queue
mac/Docmore/Automation/    automation server (DEBUG only)
mac/DocmoreTests/          XCTest
mac/tools/                 scripts
```

### How a request travels

The page lives on `docmore-app://<profile id>/`.

| Request | Answered by |
| --- | --- |
| `/api/...` | proxied to `<server>/api/...` with `Authorization: Bearer`, cookies stripped, streamed back; one refresh and retry after a 401; a connection failure is a network error for the page |
| `GET /api/files/...`, `GET /api/attachments/...` | the server when it answers (the offline copy is refreshed), the offline file cache when it does not, 404 when absent |
| anything else | a file of the web client on disk; a path without extension that does not exist gets `index.html` |

WebKit does not hand `Blob`, `File` or file-carrying `FormData` bodies to a
custom scheme handler. `Web/PageScripts.swift` is injected at document start
and turns those bodies into an `ArrayBuffer` before they are sent.

Websockets are not proxied: the page connects to the server itself
(`window.DOCMORE_NATIVE.serverUrl`).

### Bridge

- web to native: `window.webkit.messageHandlers.docmore.postMessage({ id, type, payload })`,
  answered with `window.__docmoreNativeReply(id, error, result)` when `id` is
  not null. Types: `net.probe`, `files.ensure|put|has|remove|clear|usage`,
  `notify`, `badge`, `openExternal`, `spotlight.index|remove|clear`, `state`,
  `signOut`, `authRequired`, `meeting.start|stop|state`, `print`.
- native to web: `window.dispatchEvent(new CustomEvent("docmore:native", { detail: { type, payload } }))`.
  Types: `net.changed`, `navigate`, `command`, `meeting.state`, `meeting.done`.

The meeting messages:

| Message | Payload | Answer / meaning |
| --- | --- | --- |
| `meeting.start` | `{ pageId?, spaceId?, title?, mode? }`, `mode` = `"in_person"` or `"virtual"` | Without `mode` the panel opens on the chooser and the answer comes at once with `choosing: true` (the person may take their time; a failure to start is then shown in the chooser). With `mode` the recording starts and the answer comes once it runs; an unknown `mode` or a failed start is an error. |
| `meeting.stop` | none | the state, after the transcript was queued |
| `meeting.state` (call and event) | none | `{ recording, elapsed, queued, choosing, mode? }`; `mode` only while a recording runs or finishes |
| `meeting.done` (event) | `{ pageId?, meetingId? }` | the server wrote the notes; `meetingId` is the meeting on the server (the live one when there was one) |

## Data on disk

Root: `~/Library/Application Support/Docmore/`, or `DOCMORE_DATA_DIR` when
that environment variable is set.

```
profiles.json                      accounts, OAuth client per server
device.json                        device id and name
windows.json                       open windows and tabs, for the next launch
stores-to-remove.json              web data stores of signed-out accounts not removed yet
capture-queue/<id>.json            quick notes waiting for the server
meetings/audio/<name>.wav          recordings (16 kHz; one channel in person, two when virtual: 0 the room,
                                   1 the remote side), removed once the server has the transcript
meetings/audio/<name>.wav.speakers.json   the engine's speakers of that recording (ids, numbers, names,
                                   voice prints), rewritten at every live update: what lets a recording
                                   finished after a crash keep the same speakers
meetings/audio/<name>.wav.json     until the transcript of that recording is queued: where its notes go,
                                   the kind of meeting, the live meeting on the server, the speakers
                                   with the names typed so far (Core/MeetingSidecar.swift)
meetings/jobs/<id>/<job>.json      transcripts waiting for the server, per account
meetings/jobs/<id>/failed/         transcripts the server refused, with the reason
models/                            Whisper models (downloaded on first use) and the speaker models
                                   (11 MB, downloaded from Settings > Meetings or after a Stop,
                                   never while a meeting is recorded)
profiles/<id>/bundle/<hash>/       one copy of the web client per bundle hash
profiles/<id>/bundle/current.json  { hash, version, previousHash }
profiles/<id>/files/index.json     offline file cache index
profiles/<id>/files/blobs/         offline files
profiles/<id>/spotlight.json       Spotlight item -> path
```

Outside that root, by macOS design:

- web data (IndexedDB, localStorage) of each account:
  `~/Library/WebKit/com.dezik.docmore/WebsiteDataStore/<uuid>/`
- tokens: login Keychain, service `com.dezik.docmore.tokens`, one item per
  account
- settings: `UserDefaults` of `com.dezik.docmore`

With `DOCMORE_DATA_DIR` set (tests, automation) the app uses a separate
defaults suite (`com.dezik.docmore.test-<hash>`), a 0600 `tokens.json` in the
data directory instead of the Keychain, a separate web data store per data
directory, and records notifications and Spotlight calls instead of making
them.

## Automation server

Compiled only into DEBUG builds; started only when
`DOCMORE_AUTOMATION_PORT` is set; bound to 127.0.0.1; every request needs the
header `X-Automation-Token` equal to `DOCMORE_AUTOMATION_TOKEN`.

```bash
DOCMORE_DATA_DIR=/tmp/docmore-dev \
DOCMORE_AUTOMATION_PORT=47811 DOCMORE_AUTOMATION_TOKEN=secret \
  mac/build/Build/Products/Debug/Docmore.app/Contents/MacOS/Docmore &

# tokens without the consent click (never prints them)
mac/tools/dev-token.sh --out /tmp/docmore-token.json

curl -H 'X-Automation-Token: secret' -H 'Content-Type: application/json' \
  --data-binary @/tmp/docmore-token.json http://127.0.0.1:47811/automation/session
```

| Endpoint | Does |
| --- | --- |
| `POST /automation/session { serverUrl, clientId, accessToken, refreshToken }` | creates the account and opens it |
| `POST /automation/eval { js, timeout?, window? }` | runs the body of an async function in the page, answers `{ ok, value }` |
| `GET /automation/snapshot` | PNG of the web view |
| `GET /automation/native-snapshot?which=front\|settings\|picker\|panel\|meeting` | PNG of a native window, drawn off screen (`meeting` = the meeting panel). For the window as the screen shows it: `screencapture -x -o -l <windowNumber>`, the number is in `GET /automation/meeting` |
| `POST /automation/network { reachable: true\|false\|null }` | `false` makes the proxy and the probe behave as if the server were unreachable |
| `GET /automation/state` | accounts, windows, sync state, notifications, queues |
| `POST /automation/command { id }` | sends a `command` event to the page |
| `POST /automation/reload`, `POST /automation/navigate { path, load? }` | reload, go to a path |
| `GET /automation/bridge-log?type=&dir=` | recent bridge messages |
| `POST /automation/token { accessToken?, refreshToken? }` | overwrites the stored tokens (refresh tests) |
| `POST /automation/deeplink { url }`, `POST /automation/spotlight-open { identifier }` | the same paths as a `docmore://` link and a Spotlight result |
| `POST /automation/window { action }` | `new-tab`, `new-window`, `close`, `front`, `settings` (`tab`, `scroll: 0...1`), `picker`, `switch` |
| `POST /automation/emit { type, payload }` | any native event to the page |
| `POST /automation/bundle-check` | installs the server's bundle now |
| `POST /automation/quick-capture { text, spaceId? }` | saves a quick note; `{ action: show\|close\|flush\|list }` |
| `POST /automation/lock { action }` | `enable`, `disable`, `lock`, `unlock` |
| `POST /automation/mic-activity { inUse }` | what the microphone watcher would report |
| `POST /automation/transcribe-file { path, pageId?, spaceId?, title?, model?, mode?, names? }` | pushes a recording through the meeting pipeline: the final pass on the device (text, sides, speakers), queue, send. `mode` defaults to what the file tells (two channels are a virtual meeting); `names` are names for its speakers by id. Answers the transcript, its speakers and lines, how many echoes were left out |
| `GET /automation/meetings[?flush=1]` | meeting engine, Whisper models, speaker models, queue, and the transcripts the server took in this run with the meeting each became |
| `POST /automation/meeting-preview { show, what?, mode?, language?, long?, status?, preselected?, error? }` | the meeting panel on a made-up meeting (`what: "chooser"` for the chooser alone): nothing recorded, nothing sent, the editors work on the made-up state |
| `GET /automation/meeting` | everything about the meeting under way: phase, kind, speakers, lines with their labels, the list, the status line, the calls made to the server, the panel's size |
| `POST /automation/meeting { action, ... }` | `start` (`mode?`, `script?` = the engine double, `replay?: { file, speed? }` = the real engine fed from an audio file as if it were captured), `script`, `choose`, `cancel`, `rename`, `item`, `advance`, `sync`, `stop`, `discard`, `ui`, `settings`, `speaker-model`; see `Automation/AutomationMeetings.swift`. Answers the same as the GET |
| `POST /automation/sign-out { profileId? }` | sign out and erase |
| `POST /automation/quit { erase? }` | quits; `erase` also removes the test web data and defaults |

Environment for scripted runs: `DOCMORE_AUTOMATION_OFFLINE=1` starts as if
the server were unreachable, `DOCMORE_AUTOMATION_DOWNLOAD_DIR` names the
folder downloads go to (no save panel), `DOCMORE_AUTOMATION_OPEN_FILE` names
the file a file input receives (no open panel), `DOCMORE_AUTOMATION_HOTKEY=1`
lets a test run register the global shortcut, `DOCMORE_PROXY_DEBUG=1` logs
every proxied request.

## Meetings

A recording has a kind, chosen when it starts:

- **In person** (`in_person`): only the microphone.
- **Virtual** (`virtual`): the microphone is the person and whoever sits
  with them (the "room"); the audio the Mac plays is the other side of the
  call ("remote"), as a separate track.

Starting from the menu, the shortcut, the "meeting detected" notification or
the web client's "Record meeting" opens the floating panel on the chooser:
two cards, one click starts, the kind picked last time is marked and Return
starts it (it is also the default of Settings > Meetings). A caller that
already knows the kind passes `mode` and skips the chooser.

While it records the panel shows the transcript as it comes (each line with
its speaker as a coloured chip and, in a virtual meeting, its side), the
list "Agreements and tasks" the server keeps, and one quiet status line for
that list. Clicking a chip names the voice everywhere at once. Entries of
the list are edited, cancelled, restored, deleted and added by hand; an
entry edited by hand is locked on the server and shows a lock. The panel is
resizable (360 x 440 at least) and remembers its place.

The pieces:

- `Core/MeetingTypes.swift`: the shapes shared with the server and the web
  client (`MeetingMode`, `MeetingSide`, `MeetingSpeaker`, `MeetingSegment`,
  `MeetingItem`), with their JSON.
- `Core/MeetingLiveState.swift`: what the panel shows and how far the server
  has it: labelled segments, names, the list with the edits still on their
  way, and from which index the next update has to start.
- `Core/MeetingLiveSync.swift`: the calls. `live/start` when the recording
  begins (with the language of the app's interface, so the server's labels
  match the panel's); `live/update` with what is new, about every half
  minute, one at a time (the server answers after its language model did),
  again from the first segment not acknowledged after a failure, names
  included; `items` for each edit made by hand, on its own lane so it never
  waits behind the model; `live/discard` when the recording is thrown away.
  `live/start`, each `items` edit and `live/discard` carry an
  `Idempotency-Key` that stays the same on a retry, so a call whose answer
  was lost is not done twice. Nothing of the
  meeting depends on these calls: with no server, an older server or no
  language model the recording goes on and the status line says the list is
  made when the meeting ends. The app's offline switch ("Work Offline")
  holds every call back.
- `Core/MeetingSidecar.swift`: the file next to the audio, so a recording
  finished after a crash keeps its kind, its live meeting and its names.
- `Meetings/MeetingServerTransport.swift`: those calls through `ServerAPI`
  (sign-in, one renewal after a 401, the forced-offline switch).
- `Meetings/MeetingEngine.swift`: the protocol the rest of the app sees.
- `Meetings/MeetingKitEngine.swift`: the only file that imports MeetingKit.
  It is compiled when the package is linked (`#if canImport(MeetingKit)`);
  without the two `MeetingKit` entries in `project.yml` the app still builds
  and reports meeting recording as unavailable.
- `Meetings/MeetingController.swift`: chooser, start, stop, discard, the
  bridge payloads, recordings left unfinished, `meeting.done`.
- `Meetings/MeetingPanel.swift`: the window and its SwiftUI views.
- `Meetings/ScriptedMeetingEngine.swift` (DEBUG only): an engine double that
  "records" a scripted meeting with four voices on two sides, one of them
  told apart late so an earlier line changes speaker. Everything after the
  engine is the real code, the calls to the server included. It needs no
  model, so the checks of the chooser, the panel and the calls run with it.

A recording goes: Stop, model download if needed (visible progress),
transcription on the Mac, the edits of the list still waiting are pushed,
queue, send when the server is reachable (`from-transcript`, with the live
meeting's id, the kind and the speakers with their names), wait for the
server to write the notes (`/api/ai/meetings/status`), then
`meeting.done { pageId, meetingId }` and a notification. Nothing needs the
server until the send.

The engine itself is the local package `mac/MeetingKit` (its own `README.md`
is its contract, its `STATUS.md` has the measurements and the limits). How
`MeetingKitEngine.swift` uses it:

- Recording: `MeetingRecorder` with `RecordingOptions(mode:)`. In person the
  microphone alone, one channel; virtual the microphone and the system
  audio as the two channels of one WAV, so the remote side is never taken
  from the microphone. The two level meters come from the recorder's track
  chunks.
- While it records: `LiveMeetingSession` (Whisper with word times, the
  speaker models when they are on disk). Each of its updates replaces the
  segments from an index on and lists the speakers that have text now; it
  goes to the panel and to `MeetingLiveState` as it is. The app keeps its
  own count of what the server has (`MeetingLiveState`), not the session's
  `pendingUpload`.
- Names: what the person types is kept by the app (panel, server, the file
  next to the audio) and handed to the session with `setName`, which is
  what moves a name to the voice that stays when two speakers turn out to
  be one and what puts it in the final transcript. A name decided in the
  app wins over the one the session carries; a voice with no decision in
  the app shows the session's.
- The session's speakers (`MeetingSpeakerState`) are written next to the
  recording after every update (`<recording>.speakers.json`).
- After Stop: `MeetingProcessor` over the file, seeded with those speakers
  (from memory, or from that file for a recording finished after a crash),
  so ids, numbers and names are the ones the person saw. In a virtual
  meeting it also leaves out of the room's text what the microphone heard
  of the call. Its notes for the person, when it has any, become a
  notification.
- The transcript is queued as it is (kind, sides, speakers with names),
  with the live meeting's id and the language of the app's interface
  (`locale`), and `DocmoreMeetingSender` posts it.
- The speaker models are one row in Settings > Meetings. The package
  refuses to download them while it records; a recording started without
  them has sides and no speakers while it runs, and they are downloaded
  after Stop, before the final pass.

In a DEBUG build the automation server can make the engine take its audio
from a file (`replay`): the file is fed a tenth of a second at a time, at
the speed asked, to the same live session and into a recording written the
way the recorder writes it. That is how the test meeting is run end to end
with no microphone.

## Strings

Every user-facing string is written `L("English text")`. Spanish lives in
`tools/strings.es.json`.

```bash
mac/tools/gen-strings.py --check   # fails when a string has no Spanish text
mac/tools/add-strings.py <<'JSON'  # add translations
{ "New text": "Texto nuevo" }
JSON
mac/tools/gen-strings.py           # writes Localizable.xcstrings and InfoPlist.xcstrings
```

Run the app in Spanish without changing the system language:
`Docmore.app/Contents/MacOS/Docmore -AppleLanguages '(es)'`.

## Signing, notarization, updates

This repository builds with an ad-hoc signature (`CODE_SIGN_IDENTITY = "-"`),
because the machine it was written on has no signing identity. Such a build
runs where it was built. On another Mac, Gatekeeper refuses it until the
quarantine flag is removed (`xattr -dr com.apple.quarantine Docmore.app`) or
the person chooses Open from the context menu.

With an Apple Developer account (none of the following could be exercised
here):

1. Install a "Developer ID Application" certificate in the login Keychain
   (`security find-identity -v -p codesigning` lists it).
2. Store notarization credentials once:
   `xcrun notarytool store-credentials docmore-notary --apple-id <id> --team-id <TEAMID> --password <app-specific password>`.
3. Package:

   ```bash
   DOCMORE_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" \
   DOCMORE_TEAM_ID=TEAMID DOCMORE_NOTARY_PROFILE=docmore-notary \
     mac/tools/package.sh
   ```

   The script builds with the hardened runtime and a secure timestamp, signs
   the DMG, submits it with `notarytool --wait` and staples the ticket.
4. The entitlements file (`Docmore/Support/Docmore.entitlements`) already
   asks for audio input and camera, which the hardened runtime needs for
   meeting capture and for pages that record.
5. Keychain: a Developer ID build keeps the same signature across updates,
   so the Keychain stops asking after the first "Always Allow".
6. Launch at login (`SMAppService`) and Spotlight work with any signature;
   iCloud or App Groups are not used.

Updates use [Sparkle](https://sparkle-project.org) and stay off until a feed
is configured:

1. Generate keys once with Sparkle's `generate_keys` (it prints the public
   key and keeps the private one in the Keychain).
2. Build with the feed: `SPARKLE_FEED_URL=https://example.com/appcast.xml
   SPARKLE_PUBLIC_KEY=<public key> mac/tools/package.sh` (or set both in
   `project.yml`). With `SPARKLE_FEED_URL` empty the updater never starts and
   "Check for Updates..." is hidden.
3. For each release, run Sparkle's `generate_appcast` over the folder with
   the DMGs and publish the folder at that URL.

## Things to know

- App Transport Security is switched off with `NSAllowsArbitraryLoads` alone
  (self-hosted servers on plain http). Do not add `NSAllowsLocalNetworking`
  next to it: macOS then ignores the first key, which breaks http servers on
  tailnet names and, as measured, the model download.

- The Xcode project is generated: change `project.yml`, not the project.
- `Docmore/Core` must stay free of AppKit and WebKit; the tests compile it
  directly.
- A sign-out empties the account's web data through WebKit at once; the
  empty store itself is removed at the next launch (WebKit keeps it open
  until then).
- The lab server can restart while tests run; `e2e.sh` waits for it.
