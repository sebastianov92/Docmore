# Docmore for Mac: status

Last update: 2026-11-21 20:30. Stages A (shell), C (polish) and B
(meetings, as the integration of the local package `mac/MeetingKit`) are
built and verified as far as a scripted run can go. Meetings v2 (kind of
meeting, speakers, live list) is built, wired to the engine with tracks and
speakers and verified with real audio from files, against the lab (see
"Meetings v2" at the end; the lab's language model was sick at the time,
which that section spells out). What needs a person at the Mac is listed
per stage under "Not verified".

Machine used: macOS 27.0.1, Xcode 27.2, ad-hoc signature, lab server at
`http://localhost:3100`.

Latest full runs:

```
xcodebuild test ...                # Executed 117 tests, with 0 failures
mac/tools/e2e.sh                   # passed 218, failed 0, skipped 11   (19:53, artifacts mac/build/e2e/20261121-195343)
                                   # the 11 skips are checks that need an answer of the lab's language model,
                                   # which was too slow; each says so in the output
(cd mac/MeetingKit && swift test --build-path .build --skip RealModelTests)   # Executed 177 tests, with 0 failures
(cd mac/MeetingKit && MEETINGKIT_MODELS_DIR=../build/e2e-models swift test --build-path .build)   # Executed 181 tests, with 0 failures
mac/tools/gen-strings.py --check   # 243 strings, all translated
mac/tools/package.sh               # mac/dist/Docmore-0.1.0.zip (6.0 MB) and .dmg (7.6 MB), ad-hoc signed (19:53)
```

## Stage A: the shell

### What works

- Swift/SwiftUI app (AppKit life cycle, SwiftUI for native panels) that hosts
  the real web client in `WKWebView` on the origin `docmore-app://<profile>/`.
- `WKURLSchemeHandler` for `docmore-app`:
  - static files of the web client from disk, `index.html` for routes without
    an extension, content type per extension, path traversal refused;
  - `/api/...` proxied with `URLSession`: same method, headers and body,
    `Cookie` and `Set-Cookie` stripped, `Authorization: Bearer` added,
    answers forwarded as they arrive, one token refresh (single flight) and a
    retry after a 401, connection failures surfaced as network errors;
  - `GET /api/files/...` and `GET /api/attachments/...`: server first (and the
    offline copy refreshed when there is one), offline cache when the server
    does not answer, `Range` honoured for cached files, 404 when absent.
- Web client bundle: manifest from `/api/sync/client-bundle`, every file
  checked against its sha256 prefix, installed atomically under
  `profiles/<id>/bundle/<hash>/`, previous copy kept, unchanged files reused
  as hard links, a page keeps the bundle it started with, a newer bundle is
  fetched in the background and used by the next load.
- Sign-in: server check with `/api/sync/info`, dynamic client registration,
  `ASWebAuthenticationSession` with PKCE (S256), token exchange, refresh with
  rotation, revoke on sign-out. Tokens in the Keychain, or in a 0600 file
  when `DOCMORE_DATA_DIR` is set.
- A refused refresh (`invalid_grant`) keeps the local data, marks the account
  "needs sign-in" and raises a sheet (Sign In / Later / Sign Out and Erase).
  The page's `authRequired` message takes the same path after one forced
  refresh. Signing in as the same person continues the same account.
- Bridge, both directions, exactly as specified: `net.probe`, `files.*`,
  `notify`, `badge`, `openExternal`, `spotlight.*`, `state`, `signOut`,
  `authRequired`, `meeting.*`, `print`; events `net.changed`, `navigate`,
  `command`, `meeting.state`, `meeting.done`.
- Reachability: `NWPathMonitor` plus a health probe every 5 s while the
  server does not answer. Requests made while unreachable wait for one shared
  probe instead of each waiting for its own connection timeout.
- Windows: toolbar with back, forward, page title and a sync status item;
  native tabs (Cmd-T), several windows (Cmd-Shift-N), state restoration from
  `windows.json`; menus File, Edit, View, Go, Account, Window, Help.
- Links to other hosts open in the default browser, `target=_blank` to the
  app opens a tab, downloads use a save panel (blob downloads through
  `WKDownload`, files of the app's own origin through the proxy), file inputs
  use an open panel, `window.print()` prints, media capture is granted to the
  app's own page.
- Deep links `docmore://page/<slugOrId>` and `docmore://open?path=/...`.
- Settings window: General, Accounts, Offline (real sizes, clear button that
  also sends `clear-offline-data`), Meetings, Security.
- Automation server (DEBUG builds only, `DOCMORE_AUTOMATION_PORT` +
  `DOCMORE_AUTOMATION_TOKEN`, 127.0.0.1 only).
- English and Spanish for every native string (144 at this point), checked by
  `tools/gen-strings.py --check`.

### How it was verified

Unit tests (logic only, no app launch):

```
xcodebuild test -project mac/Docmore.xcodeproj -scheme Docmore \
  -derivedDataPath mac/build -destination 'platform=macOS'
# Executed 62 tests, with 0 failures
```

They cover PKCE (RFC 7636 vector), profile ids and data store ids, server
address normalisation, manifest decoding/validation/diffing, bundle install,
switch, reuse and corrupt download, content types, request routing, cache
keys, byte ranges, token refresh single flight (25 concurrent callers, one
refresh), refused refresh, file cache index, deep links, Spotlight ids, hot
key storage.

End to end against the lab, through the automation server
(`mac/tools/e2e.sh`; the stage A part is 107 of its 196 checks):

```
mac/tools/e2e.sh
# passed 196, failed 0, skipped 0
```

The stage A checks:

- first launch shows the account picker; test data dir and defaults suite
- session injected, 500 files downloaded and checksummed, `/home` rendered
  (DOM title and text, `#root`, `window.DOCMORE_NATIVE`), snapshot PNG looked
  at (the home page of "Docmore Lab")
- static: module script, stylesheet, `manifest.json`, SPA fallback, missing
  asset 404, traversal refused
- proxy: JSON POST (page created and read back), 480 KB JSON body, multipart
  by `fetch` (300 KB) and by `XMLHttpRequest` (3 MB) byte for byte, `Blob`
  body, no cookie visible, streamed download, server-sent events from
  `/api/ai/generate/stream` (27 chunks over 1.5 s, 27 events)
- refresh: garbage access token, eight parallel requests, all 200, rotated
  refresh token stored (the server refuses a second use of a refresh token,
  so eight successes mean one refresh)
- bridge: `net.probe`, `files.ensure/has/put/usage`, `files.ensure` with
  `maxBytes` (the 3 MB file is skipped and listed under `failed`), unknown
  type error, `notify`, `badge`, `spotlight.index`, `state`
- downloads to the chosen folder (blob and attachment), external link handed
  to the browser, `target=_blank` tab
- `command`, `docmore://open`, Spotlight result, refused deep link, new tab,
  new window
- relaunch: window restored on its page with no sign-in, IndexedDB and
  localStorage intact, older bundle replaced in the background (1 file
  downloaded, 499 hard links), open page pinned to its bundle, next load on
  the new one
- unreachable: `net.changed` false in the page, `/api` rejects as
  `TypeError` (XHR `onerror`), cached file 200 from disk, range 206,
  `files.put` bytes, uncached 404, reload works, status "Offline"; back
  online `net.changed` true
- web offline engine under the custom scheme: page opened and pinned, body
  in IndexedDB, image in the native file cache; unreachable + full reload:
  the page opens from the device with its image; `fetch("/api/health/live")`
  is a network error; a page created offline queues (pending 1) and reaches
  the server once reachable (pending 0)
- refused refresh token: plain 401 to the page, account marked, sheet up,
  IndexedDB and bundle kept; signing in again as the same user continues
- cold launch with the server unreachable from the first moment, in Spanish:
  page renders, menus and status in Spanish, Settings snapshots looked at
- sign-out from the page: windows closed, account folder, tokens and web
  data erased, refresh token revoked on the server (`invalid_grant`),
  emptied data store removed at the next launch

Also checked by hand through the automation server: typing in the editor
inside the app reaches the server (the collaboration websocket connects to
`ws://localhost:3100` from the `docmore-app://` origin), and the app recovers
by itself after the lab restarts.

### Findings that matter to the web side

1. Request bodies on the custom scheme. WebKit delivers `string`,
   `ArrayBuffer`, `URLSearchParams` and `FormData` with text fields only. A
   `Blob`, a `File`, or a `FormData` holding a file never arrives: both
   `httpBody` and `httpBodyStream` are nil (measured: uploads reached the
   proxy with no body, the server answered 400). Fix in the shell: a script
   injected at document start (`Docmore/Web/PageScripts.swift`) turns those
   bodies into an `ArrayBuffer` before `fetch` / `XMLHttpRequest.send`,
   keeping the multipart boundary. The message handler was not needed for
   this. Verified up to a 40 MB upload. Nothing to change on the web side;
   avoid `navigator.sendBeacon` with a Blob and `<form>` posts with files,
   which the shim does not cover.
2. IndexedDB, localStorage, streaming and `isSecureContext` all behave under
   `docmore-app://` (see the checks above).
3. A page pinned without ever being opened does not open offline when its
   space was never visited in the app: `/spaces/info { spaceId: "<slug>" }`
   has no recorded answer and no offline handler, so the route renders an
   empty content area (no error shown). `/pages/info` answers from the
   device. Seen with a page created through the API and pinned through
   `window.__docmoreOffline.pin`; once the page had been opened online it
   reloads offline correctly.
4. `normalizeRoute` in `apps/client/src/lib/offline/recorder.ts` only strips
   the origin of URLs that start with `http`. In the shell an absolute URL
   starts with `docmore-app://`. Requests made with relative URLs are fine;
   an absolute one would be recorded under a wrong route.
5. App Transport Security: `NSAllowsLocalNetworking` next to
   `NSAllowsArbitraryLoads` makes macOS ignore the latter, so plain http to
   a server named by a tailnet host name would have been refused. The plist
   now carries `NSAllowsArbitraryLoads` alone (found while the first model
   download failed; that failure itself turned out to be the model host
   dropping connections now and then, which the app retries).
6. The lab restarted several times during the night (seen by an independent
   monitor, for example 01:07:41 to 01:09:27 and 01:24:11 to 01:24:22). Two
   early failures of the streaming check and one of the editor were those
   restarts, not the proxy. `e2e.sh` now waits for the server and retries.

### Not verified, and why

Needs a human click (the code is there, the dialogs are not automatable
here):

- the consent screen inside `ASWebAuthenticationSession` (the automation
  server injects tokens instead; the PKCE and token calls are unit tested and
  the same token calls are used end to end)
- Keychain storage (test runs use the 0600 file store on purpose)
- the notification permission prompt and a real notification click (test
  runs record notifications instead of posting them)
- real Spotlight indexing (test runs record the calls)
- save panel, open panel and print panel themselves (downloads are verified
  with the folder preset `DOCMORE_AUTOMATION_DOWNLOAD_DIR`)
- the `getUserMedia` system prompt
- launch at login (`SMAppService`)
- `docmore://` links arriving from another app (the same handler is verified
  through `/automation/deeplink`)

### Known gaps

- Uploads are held in memory once on their way through the proxy (fine at
  the 50 MB attachment limit, heavy for a 200 MB import).
- `WKWebsiteDataStore.remove(forIdentifier:)` is refused while WebKit's
  network process still holds a signed-out store, so the web data is emptied
  at once through WebKit and the empty store itself is removed at the next
  launch.
- No Developer ID on this machine: the build is ad-hoc signed and not
  notarized.

## Stage C: polish

### What works

- Spotlight: `spotlight.index/remove/clear` go to CoreSpotlight under a
  per-account domain; the path of each item is kept in
  `profiles/<id>/spotlight.json`; opening a result navigates to it.
- Several accounts: each has its own origin, web data store, web client
  copy, file cache, tokens and reachability. Account menu > Switch Account,
  Settings > Accounts, account picker. Signing one out leaves the others.
- Lock (Settings > Security, off by default): Touch ID or the Mac password
  (`LocalAuthentication`, `.deviceOwnerAuthentication`) at launch, after
  wake and from the app menu (Lock Docmore). A locked window hides its page
  and its title; Settings and the quick note panel close; the pages keep
  running underneath. Turning the lock off asks for the same proof.
- Quick note: global shortcut (Option-Command-N by default, changeable in
  Settings > General, Carbon hot key so no accessibility permission), a
  floating panel with a space picker, first line = title, rest = Markdown
  body, `POST /api/pages/create { spaceId, title, content, format: "markdown" }`
  with an `Idempotency-Key`. Notes wait in `capture-queue/` while the server
  is out of reach and go out in order when it answers; a note the server
  refuses for good is kept aside with the reason and a notification.
- Meeting detection (Settings > Meetings, on by default): when another app
  starts using the default microphone (`kAudioDevicePropertyDeviceIsRunningSomewhere`,
  the sound itself is never read) a notification offers to record; one offer
  per ten minutes, none while Docmore itself records or a page captures.
- Updates: Sparkle 2.10.1 is linked; the updater starts and "Check for
  Updates..." shows only when the build setting `SPARKLE_FEED_URL` is not
  empty.
- `tools/package.sh`: Release build, zip and DMG (with an Applications
  link), ad-hoc signed; Developer ID signing and notarization behind
  environment variables.
- `README.md`: build, run, tests, automation, data layout, signing,
  notarization, Sparkle.

### How it was verified

Unit tests added: quick note title/body split, queue order, "do not
overtake", refused note kept, microphone offer policy.

`mac/tools/e2e.sh` (same run as above):

- two accounts (the admin and the member test users): two origins, two web
  clients, two windows; each window is its own user on the server;
  localStorage and IndexedDB of one are invisible to the other; Switch
  Account; signing the member out erases only its folder and leaves the
  admin's window, data and sign-in
- quick note: saved while forced unreachable (one JSON file in
  `capture-queue/`), sent by itself when reachable again, exactly one page
  on the server with the body, queue empty; the panel opens (snapshot
  `06-quick-note-panel.png` looked at)
- shortcut: `RegisterEventHotKey` succeeds for Option-Command-N
- meeting detection: microphone "in use" twice in a row raises one offer
- lock: locking hides every page and title (snapshot `07-locked.png` looked
  at), Settings refuses to open, a relaunch with the lock on starts locked,
  unlocking shows the pages again
- updates: no feed, so the menu item is hidden; built once with
  `SPARKLE_FEED_URL=https://example.com/appcast.xml`: `SUFeedURL` is in
  Info.plist and the menu item is shown
- `tools/package.sh` ran: `codesign --verify --deep --strict` passes on the
  app inside the DMG, the Release binary has no automation code, and the
  Release app starts with an empty data directory

### Not verified, and why

- the Touch ID / password prompt itself (the e2e unlocks through the
  automation server) and locking on a real sleep/wake
- pressing the global shortcut (posting key events is GUI automation)
- the microphone watcher against real hardware activity (the e2e feeds the
  same decision code by hand)
- a Sparkle update from a real appcast
- Developer ID signing and notarization (no identity on this machine)

## Stage B: meetings

Stage B is the integration of `mac/MeetingKit` (written by another agent;
its `README.md` is the contract, nothing inside it was edited from here).

### What works

- `MeetingKit` is a local package dependency in `project.yml`. Only
  `Docmore/Meetings/MeetingKitEngine.swift` imports it, behind
  `#if canImport(MeetingKit)`: remove the two entries from `project.yml` and
  the app still builds, with meeting recording reported as unavailable.
- `MeetingController`: `meeting.start { pageId?, spaceId?, title?, mode? }`,
  `meeting.stop`, `meeting.state` answer `{ recording, elapsed, queued,
  choosing, mode? }`; the event `meeting.state` goes to every page on start,
  stop, each second of a recording and each queue change; `meeting.done
  { pageId, meetingId }` goes out when the server has written the notes.
  (The kind of meeting and the chooser are described under "Meetings v2".)
- After Stop (and for a WAV pushed by automation): model download if it is
  not on disk (visible progress, four attempts), transcription on the Mac,
  one job in the account's `MeetingQueue`
  (`meetings/jobs/<profile>/<job>.json`), sent by `DocmoreMeetingSender`
  whose token comes from the app's refreshing token store. A 401 on send
  renews the token once and sends again. The queue is flushed after a
  recording, at launch and whenever a server becomes reachable.
- After the server accepts a transcript the app polls
  `/api/ai/meetings/status` until `done` or `failed`, then sends
  `meeting.done` with the page that got the notes (a new page when the
  target was a space) and a notification that opens it.
- A recording whose transcript never reached the queue (the app quit or
  crashed, the model could not be downloaded at the time) keeps a small
  file next to the WAV saying where its notes go; it is repaired
  (`WAVFile.repairHeader`) and finished at the next launch or when a server
  becomes reachable. The WAV is removed once the server has the transcript.
- Floating panel: see "Meetings v2". With the engine linked today the live
  text is one line per 15 s window (only when the model is already on disk).
- Settings > Meetings: the default kind of meeting; the five models with
  their size, download with progress, delete, the selected one (default
  Large v3 Turbo, 646 MB); language (automatic or fixed); the offer to
  record when another app takes the microphone. The microphone and system
  audio switches are gone: the kind of meeting decides what is recorded.
- Account > Record Meeting sends the `record-meeting` command, so the page
  picks the destination (the open page, or its space); with no page up it
  records for the active account into its default space.
- `Info.plist` has `NSMicrophoneUsageDescription` and
  `NSAudioCaptureUsageDescription` (English and Spanish); the entitlements
  file has `com.apple.security.device.audio-input` for a hardened build.
- Automation: `POST /automation/transcribe-file { path, pageId?, spaceId?,
  title?, model? }`, `GET /automation/meetings`,
  `POST /automation/meeting-preview` (the panel on a made-up meeting,
  nothing recorded), `GET` and `POST /automation/meeting`.

### How it was verified

`mac/tools/e2e.sh`, section "Meetings" (14 checks), with the speech sample
`meeting.wav` (16 kHz mono, 16.6 s) and the tiny model:

- the engine is in the build with its five models; the default is the
  large-v3 turbo
- online: the WAV is transcribed inside the app ("Welcome everyone to the
  weekly sink. First, the deploy of the new homepage is done and live.
  Second, we decided to move the launch to next Friday. Maria will write
  the release notes and Tom will update the pricing page before Thursday."),
  language `en`, 7 segments; the model (76 MB) landed in `<data dir>/models`;
  the job was sent at once; `meeting.done { pageId }` reached the page after
  the server wrote the notes; the page on the server contains "homepage",
  "Maria" and "Tom" (summary, decisions, action items, transcript); a
  notification leads to `/p/<pageId>`
- forced unreachable: transcription still works, the transcript waits as
  one JSON file in `meetings/jobs/<profile>/`, `meeting.state` says
  `queued: 1`; reachable again: the queue sends it by itself and a second
  notes page appears
- the recording panel preview (snapshot `08-recording-panel.png` looked
  at) and Settings > Meetings with the model list (snapshot looked at:
  Tiny "on this Mac, 76.7 MB" with Delete, the others with Download)

### Not verified, needs a human click

- live capture: the microphone prompt and the "Screen & System Audio
  Recording" prompt cannot be answered from a script, so
  `meeting.start` / `meeting.stop` from a page, the level meter, live text
  while recording, the notices for a refused source and finishing an
  interrupted recording were not exercised with real audio. The code path
  after Stop is the same one `transcribe-file` runs.
- the large-v3 turbo model itself (only the tiny model was downloaded and
  run here; the default downloads 646 MB on first use)
- the meeting-detected notification's Record button

### Known gaps

- MeetingKit's error texts are English; the app translates the ones a
  person can act on (permissions, a silent source) and passes the rest
  through.
- `Idempotency-Key` on `from-transcript`: MeetingKit sends the job id as the
  key and the server answers a repeat with the first answer (checked by the
  lead: same meeting id, `Idempotent-Replayed: true`, one row), so a send
  whose answer is lost does not write the notes twice.
- The final transcript is made from the file after Stop even when live
  windows ran (better text, more time: a one hour meeting takes a few
  minutes with the large model).
- No "MeetingKit/STATUS.md" existed yet when this was written; the
  integration was done against its `README.md` and sources as of 04:20.

## Meetings v2: kind of meeting, speakers, live list

Built against the shared contract of the feature and the lab server, and
wired to the engine with tracks and speakers (`mac/MeetingKit` as merged in
f260cdd8). Nothing in `Docmore/Meetings/MeetingKitEngine.swift` is
temporary any more.

**What was run for real and what was not.** The whole path was run with
real audio and the real models, from files: the Spanish test meeting
(`mac/tools/fixtures/meeting-es`, four synthetic voices, two on each side)
as a finished recording of both kinds, as a call on loudspeakers, and fed
through the live session as if it were being captured, with the panel open
and the lab on the other end. What was **not** run is capture itself: the
microphone and the system audio need a person to answer the macOS
permission dialogs. And the voices are text-to-speech: how well real
people are told apart was not measured (MeetingKit's `STATUS.md` says the
same of itself).

**The lab's language model was sick while this was verified** (its GPU
hung; about one token per second, at times no answer at all). What that
did: most `live/update` calls got no answer within the 180 s the app waits
(the server answers after its model), so the app kept the lines and sent
them again from the first one not acknowledged, and the panel said "La
lista se arma al terminar"; the edits made by hand went through all the
same, on their own lane; the final notes were written after the server
gave its model up, without a summary ("No summary: fetch failed"), and
often later than a test run waits. So in this round the list coming back
from the model during a meeting, "antes: ..." on an entry the model
changed and the summary of the notes were **not seen with the real
engine**, except one `live/update` of the test meeting that did come back,
with one entry. They were seen in the round before (scripted meeting,
healthy model: three entries, one of them changed, a summary). Everything
that does not need the model's answer was checked and passes; the e2e
reports the rest as skipped with that reason: it does not fail for it and
does not pretend.

### What works

- Kind of meeting: `MeetingMode` (`in_person`, `virtual`). The panel opens on
  the chooser (two cards, the whole card clicks, one click starts, the kind
  picked last time marked, Return starts it, Escape cancels); a failure to
  start is shown in the chooser. `meeting.start` and the automation server
  take a `mode` and skip the chooser. The default kind is in Settings >
  Meetings and is the same setting the chooser updates.
- Recording by kind (`MeetingRecorder`, `RecordingOptions(mode:)`): in
  person the microphone, one channel; virtual the microphone and the system
  audio as the two channels of one WAV.
- Panel while recording (`Docmore/Meetings/MeetingPanel.swift`): kind, clock
  and level (two meters, room and remote, in a virtual meeting); the voices
  that have text now; the transcript as turns, each with its speaker as a
  coloured chip (colour by the speaker's number, stable) and its side in a
  virtual meeting; a line the engine has not given a speaker yet shows its
  side alone; a click on a chip names the voice on every line at once, an
  empty name brings the default label back; the list "Acuerdos y tareas"
  with kind (SF Symbols), text, owner, date, "antes: ..." on an entry the
  model changed, cancelled entries struck through, a lock on entries edited
  by hand; the form of an entry (text, who, when, the voices offered as
  owners; cancel or restore, delete with a second click, add by hand); one
  quiet status line: "Armando la lista", "Actualizada hace n s", "La lista se
  arma al terminar". Both parts fold; the transcript follows the end, also
  while earlier lines change speaker, unless the person scrolled up.
  Resizable, 360 x 440 at least (in a panel that short the lines of the
  transcript step aside while an entry is typed), place and size remembered.
- Live text, sides and speakers: `LiveMeetingSession`, with the Whisper
  model on disk; speakers when the speaker models are on disk too. Its
  updates (replace from an index on, the speakers that have text) feed the
  panel and the server as they are: speakers that come and go, numbers with
  gaps, a tail of lines that changes speaker.
- Names: typed in the panel, kept by the app, sent to the server, written
  next to the audio, and handed to the engine (`setName`), which carries
  them when two speakers turn out to be one and into the final transcript.
- Calls during the meeting (`Docmore/Core/MeetingLiveSync.swift`):
  `live/start` at the start, with the language of the app's interface
  (`locale`), asked again later when the server did not answer and given up
  for good when it refuses, as an older server would; `live/update` 10 s
  after the start, then at least 30 s after the previous one started and
  10 s after it was answered, never two at a time, with a 180 s timeout
  because the server answers after its model; after a failure again from
  the first segment not acknowledged (15, 30, 60 s apart); a relabelled
  line is sent again with everything after it; the speakers with their
  names go in every update and a typed name goes out early (12 s between
  any two updates at least); a line that still points at a speaker that is
  gone travels without it; `items` for each edit made by hand, on its own
  lane so it does not wait behind the model, shown at once and kept on top
  of the server's list until confirmed; `live/discard` when the recording
  is thrown away or had no speech. `live/start`, every `items` edit and
  `live/discard` carry an `Idempotency-Key` that is the same on a retry
  (a new one for `live/start` after the server lost the meeting). A 404 on
  an update opens a new live meeting and sends everything again. The
  offline switch of the page ("Work Offline") and the automation's
  forced-unreachable switch hold every call back. None of it can stop a
  recording.
- After Stop: the live session works on the last stretch and its speakers
  are kept; the speaker models are downloaded now if they were missing;
  `MeetingProcessor` makes the final transcript from the file, seeded with
  those speakers, so ids, numbers and names are the ones the panel showed;
  in a virtual meeting what the microphone heard of the call is left out
  of the room's text; the edits of the list still waiting are pushed (20 s
  at most); the transcript is queued with the live meeting's id, the kind,
  the speakers with their names and the `locale`; `meeting.done` carries
  `meetingId`. When the server's model did not answer, the server writes
  the notes without a summary and says why: the app then says that in the
  "notes are ready" notification.
- Interrupted recordings: the file next to the audio
  (`Docmore/Core/MeetingSidecar.swift`) keeps the kind, the live meeting and
  the speakers with the names typed so far, and the engine's speakers are
  kept in `<recording>.speakers.json`; the next launch repairs the WAV and
  finishes the recording with both. Files written before this change still
  read (as in-person meetings).
- Settings > Meetings: default kind (two rows, the whole row selects); the
  row of the speaker models (11 MB: size, download with progress, delete).
- Engine seam (`Docmore/Meetings/MeetingEngine.swift`): unchanged in shape
  since the first round, plus `setSpeakerName`, `recordedMode(of:)`, the
  engine's notes and the count of echoes in the transcript, `locale` in
  what travels with it, and `replay` in the recording request (below).
- DEBUG only: `replay` (the real engine takes its audio from a file, a
  tenth of a second at a time, at the speed asked, through the same live
  session and into a recording written the way the recorder writes it);
  the engine double `ScriptedMeetingEngine` (a scripted meeting, no model
  needed); the panel on a made-up meeting. The Release binary has none of
  the three.
- In `mac/MeetingKit` (the one change made there): an optional `locale` in
  `MeetingJob`, `MeetingQueue.enqueue` and the body `DocmoreMeetingSender`
  posts, sent only when set and shaped like a language tag; a job without
  one posts the body it always did. Two tests added.
- A "Discard" button with a second click to confirm (not in the brief).
- Spanish for every new string (243 in all).

### How it was verified

Unit tests of the app: 117, no failures (57 for this feature, no app
launch, a scripted server that follows the contract and honours
`Idempotency-Key`, a clock moved by hand). Beyond the first round: names the
engine carries are shown unless the person decided otherwise, a name that
moves to the voice that stays, a name taken away not coming back; a line
of a speaker that is gone travels without it; an `items` edit and a
`live/start` whose answer was lost are tried again with the same key and
happen once; a new key after the server lost the meeting (this one caught
a real mistake: with the old key the server would have handed back the
meeting that was gone); a discard tried once more; `locale` in `live/start`.

MeetingKit: `swift test --build-path .build`, 181 tests, no failures: the 177 that need no model (two of them new, for `locale`) and the four `RealModelTests`, run with the models the app's e2e keeps in `mac/build/e2e-models` (Whisper large-v3 turbo, and the speaker models as the app downloaded them).

`mac/tools/e2e.sh`: passed 218, failed 0, skipped 11 (of them 77 passed and 10 skipped
for this feature). Every skip is a check that needs an answer of the lab's
language model and says so: the stream of `/api/ai/generate/stream`; a
`live/update` answered within the app's 180 s (scripted meeting and test
meeting), and with it the list made by the model; `meeting.done` after the
notes; the notes of six meetings. In earlier runs of the same day, with
the model answering, those same checks passed (`meeting.done`, the notes
of the two plain transcripts, the stream), and once a `live/update` of the
test meeting came back with an entry of the model's list. The checks of this feature:

- chooser and panel on a made-up meeting, the bridge (`meeting.start` with
  and without a kind, an unknown kind), a scripted in-person meeting
  discarded, a scripted virtual meeting against the lab (relabel, name,
  the file next to the audio, `live/update`, every `items` edit, forced
  unreachable and back, Stop as the same meeting id), the app killed while
  it records and the next launch finishing the same meeting: as in the
  first round, now with what needs the server's model separated from what
  does not
- the speaker models downloaded through the path Settings uses (11 MB, with
  progress), next to the Whisper models
- the test meeting as finished recordings, final pass by the real engine
  (Whisper large-v3 turbo, speaker models):
  two channels: 25 segments, every line with its side, four speakers, two
  on each side, each one person of the ground truth (purity 1.0), "viernes"
  and "lunes" in the text, the name given in the app on its speaker on the
  server; one channel: 27 segments, no sides, four speakers for the four
  people; the call on loudspeakers: 12 echoes left out, no sentence of the
  call twice, still two speakers per side
- the test meeting fed to the real live session (three times real time),
  the panel open: speakers appear on both sides, a name typed when the
  first remote voice shows is still on it after the relabels and in the
  engine's file next to the recording, `live/update` carries speakers and
  sides, Stop sends the final pass as the same meeting, the name is on the
  same speaker in the final transcript on the server
- that replay killed (`kill -9`) half way: part of the audio, kind, meeting
  id, name and the engine's speakers are on disk; the next launch finishes
  it with the real engine as the same meeting, virtual, the name on the
  same speaker; nothing left next to the recordings
- notes: for each meeting, when the server finished it in time, the page
  (labels with sides, the names, "viernes"), and the page opened in the
  app's web view; otherwise a skip that says the model was too slow

By hand through the automation server, with real captures of the panel's
window (`screencapture -l`), Spanish:

- the test meeting live as a virtual meeting: lines first with their side
  alone ("Sala", "Remoto"), then chips as the engine tells the voices
  apart; four speakers; "Marta" typed at 0:18 on the first remote voice and
  still there at the end; the two meters moving with who talks
- the same as an in-person meeting: no sides; a speaker that came and went
  (numbers 1, 3, 4, 5); the transcript following the end while earlier
  lines changed speaker (it did not at first: fixed)
- the notes page of the two-channel recording in the app's web view:
  "Notas de la reunión: ...", every line labelled "Persona 1 (sala)",
  "Marta", "Persona 3 (sala)", "Persona 4 (remoto)" (the labels are Spanish
  because the app sends its language), no summary (the model)
- Settings > Meetings with the real row of the speaker models before,
  during and after the download

Found and fixed in this round: the key of `live/start` reused after a lost
meeting; the transcript not following the end when earlier lines change
speaker; the speaker models asked for while recording (the package refuses:
now a notice during the meeting and the download after Stop).

### Not verified, and why

- Capture: the microphone prompt, the system audio prompt, what each kind
  really records from real devices, the meters with real sound, notices of
  a refused source. The recorder is covered by MeetingKit's unit tests with
  scripted sources; the app hands it the kind and reads its track chunks.
- Real voices, a real room, real loudspeakers. Every number above is from
  four text-to-speech voices and a synthetic echo.
- With the real engine and a healthy model: the live list, "antes: ...",
  the summary. (Seen with the scripted meeting in the first round.)
- Clicks and keys by hand in the panel: the automation calls the methods
  the buttons call; hover, focus, Return on the preselected card, Escape,
  scrolling up to read (which should stop the transcript from jumping to
  the end) and dragging the corner were not done with a mouse and a
  keyboard. VoiceOver was not tried.
- "Work Offline" chosen in the page (unit tested as a closure; the e2e uses
  the automation's switch).
- A meeting longer than the two-minute test meeting, in the app. MeetingKit
  measured an hour through its command line; the panel was not watched
  with that much text.
- The web client passing `mode` (it sends none, so it gets the chooser).

### Known gaps and choices made

- A name typed in the first seconds can end up on another voice. Seen with
  the test meeting in person: "Ana" typed when one speaker was showing;
  that speaker then turned out to be two voices and the id stayed with the
  other one. The name follows the engine's id, which is what the engine
  promises to keep; the person can type it again on the right chip, during
  the meeting or afterwards on the page. In the virtual form it did not
  happen (each side has fewer voices to confuse).
- The owner the model writes for an unnamed speaker, and the labels of the
  notes, are in the app's language now (`locale`); the engine's own notes
  for the person ("The speaker models are not downloaded ...") and its
  error texts are English.
- An edit of the list that never reaches the server before the transcript
  is queued (server away at the end, 20 s of trying) is lost: the contract
  has no place for it in `from-transcript`.
- When the server loses a live meeting (404), the new one gets the whole
  transcript and the names, but the edits made by hand on the old one are
  gone. Two reopenings at most.
- The default kind is the last kind picked in the chooser (one setting, the
  one Settings shows). A `mode` passed by a caller does not change it. On a
  new install it is virtual.
- `meeting.start` without `mode` answers before anything is recorded; the
  `meeting.state` event says when it does.
- The first time a Mac uses Whisper large-v3 turbo, macOS prepares it for
  the chip: about three minutes here, once per place the model is kept.
  After a Stop that shows as "Transcribiendo en este Mac" with no movement
  for that long. The live text of that first meeting also starts late.
- The server has no call to remove a meeting: a test meeting whose notes
  the model writes after the e2e ended leaves its page on the lab until the
  next run's clean-up (it finds them by "mac-e2e" in the title).

### What is left

- With a healthy language model on the lab, run `mac/tools/e2e.sh` once
  more: the eleven checks it skipped are written and wait for that. Not
  seen with the real engine yet for that reason: the list of the model
  during a meeting shown in the panel (one answer with one entry reached
  the app in one run, unwatched), "antes: ..." on a changed entry, a
  summary in the notes.
- A person at the Mac: a real recording of each kind (the two permission
  dialogs), with real voices, and the mouse and keyboard in the panel.
- The e2e waits up to six minutes on an unanswered `live/update` of the
  test meeting before it gives up (two calls of 180 s); it could stop after
  the first.
- Test meetings the lab's model had not finished when the last run ended
  (seven) will still get their notes pages; the next e2e run removes pages
  with "mac-e2e" in the title. A manual probe titled "mac v2 cache probe"
  may also appear and has to be removed by hand.

