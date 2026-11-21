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

## Layout of the code

```
mac/project.yml            XcodeGen project (app + logic tests)
mac/Docmore/Core/          pure logic, also compiled into the test bundle
mac/Docmore/App/           services, sign-in, reachability, coordinator
mac/Docmore/Web/           scheme handler, proxy, bridge, page scripts
mac/Docmore/UI/            windows, menus, settings, account picker
mac/Docmore/Features/      lock, quick note, meeting detection, updater
mac/Docmore/Meetings/      meeting controller, floating panel, engine adapter
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

## Data on disk

Root: `~/Library/Application Support/Docmore/`, or `DOCMORE_DATA_DIR` when
that environment variable is set.

```
profiles.json                      accounts, OAuth client per server
device.json                        device id and name
windows.json                       open windows and tabs, for the next launch
stores-to-remove.json              web data stores of signed-out accounts not removed yet
capture-queue/<id>.json            quick notes waiting for the server
meetings/audio/<name>.wav          recordings (16 kHz mono), removed once the server has the transcript
meetings/audio/<name>.wav.json     where the notes of that recording go, until its transcript is queued
meetings/jobs/<id>/<job>.json      transcripts waiting for the server, per account
meetings/jobs/<id>/failed/         transcripts the server refused, with the reason
models/                            transcription models (WhisperKit), downloaded on first use
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
| `GET /automation/native-snapshot?which=front\|settings\|picker\|panel` | PNG of a native window |
| `POST /automation/network { reachable: true\|false\|null }` | `false` makes the proxy and the probe behave as if the server were unreachable |
| `GET /automation/state` | accounts, windows, sync state, notifications, queues |
| `POST /automation/command { id }` | sends a `command` event to the page |
| `POST /automation/reload`, `POST /automation/navigate { path, load? }` | reload, go to a path |
| `GET /automation/bridge-log?type=&dir=` | recent bridge messages |
| `POST /automation/token { accessToken?, refreshToken? }` | overwrites the stored tokens (refresh tests) |
| `POST /automation/deeplink { url }`, `POST /automation/spotlight-open { identifier }` | the same paths as a `docmore://` link and a Spotlight result |
| `POST /automation/window { action }` | `new-tab`, `new-window`, `close`, `front`, `settings`, `picker`, `switch` |
| `POST /automation/emit { type, payload }` | any native event to the page |
| `POST /automation/bundle-check` | installs the server's bundle now |
| `POST /automation/quick-capture { text, spaceId? }` | saves a quick note; `{ action: show\|close\|flush\|list }` |
| `POST /automation/lock { action }` | `enable`, `disable`, `lock`, `unlock` |
| `POST /automation/mic-activity { inUse }` | what the microphone watcher would report |
| `POST /automation/transcribe-file { path, pageId?, spaceId?, title?, model? }` | pushes a WAV through the meeting pipeline: transcription on the device, queue, send |
| `GET /automation/meetings[?flush=1]` | meeting engine, models, queue |
| `POST /automation/sign-out { profileId? }` | sign out and erase |
| `POST /automation/quit { erase? }` | quits; `erase` also removes the test web data and defaults |

Environment for scripted runs: `DOCMORE_AUTOMATION_OFFLINE=1` starts as if
the server were unreachable, `DOCMORE_AUTOMATION_DOWNLOAD_DIR` names the
folder downloads go to (no save panel), `DOCMORE_AUTOMATION_OPEN_FILE` names
the file a file input receives (no open panel), `DOCMORE_AUTOMATION_HOTKEY=1`
lets a test run register the global shortcut, `DOCMORE_PROXY_DEBUG=1` logs
every proxied request.

## Meetings

The engine is the local package `mac/MeetingKit` (its own `README.md` is the
contract): `MeetingRecorder` records the microphone and the system audio to
a 16 kHz mono WAV, `Transcriber` and `LiveTranscriber` run WhisperKit on the
device, `MeetingQueue` keeps transcripts until `DocmoreMeetingSender` gets
them to `POST /api/ai/meetings/from-transcript`.

The app side is `Docmore/Meetings/`:

- `MeetingEngine.swift`: the protocol the rest of the app sees.
- `MeetingKitEngine.swift`: the only file that imports MeetingKit. It is
  compiled when the package is linked (`#if canImport(MeetingKit)`); without
  the two `MeetingKit` entries in `project.yml` the app still builds and
  reports meeting recording as unavailable.
- `MeetingController.swift`: start, stop, the floating panel, the bridge
  payloads, recordings left unfinished, `meeting.done`.

A recording goes: Stop, model download if needed (visible progress),
transcription on the Mac, queue, send when the server is reachable, wait for
the server to write the notes (`/api/ai/meetings/status`), then
`meeting.done { pageId }` and a notification. Nothing needs the server until
the send.

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
