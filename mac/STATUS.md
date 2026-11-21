# Docmore for Mac: status

Last update: 2026-11-21 04:50. Stages A (shell), C (polish) and B (meetings,
as the integration of the local package `mac/MeetingKit`) are built and
verified as far as a scripted run can go. What needs a person at the Mac is
listed per stage under "Not verified".

Machine used: macOS 27.0.1, Xcode 27.2, ad-hoc signature, lab server at
`http://localhost:3100`.

Latest full runs:

```
xcodebuild test ...                # Executed 62 tests, with 0 failures
mac/tools/e2e.sh                   # passed 144, failed 0, skipped 0   (04:38, artifacts mac/build/e2e/20261121-043855)
mac/tools/package.sh               # mac/dist/Docmore-0.1.0.zip (4.6 MB) and .dmg (5.0 MB), ad-hoc signed
mac/tools/gen-strings.py --check   # 190 strings, all translated
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
(`mac/tools/e2e.sh`; the stage A part is 107 of its 144 checks):

```
mac/tools/e2e.sh
# passed 144, failed 0, skipped 0
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
- `MeetingController`: `meeting.start { pageId?, spaceId?, title? }`,
  `meeting.stop`, `meeting.state` answer `{ recording, elapsed, queued }`;
  the event `meeting.state` goes to every page on start, stop, each second
  of a recording and each queue change; `meeting.done { pageId }` goes out
  when the server has written the notes.
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
- Floating panel: elapsed time, level, live transcript (15 s windows, only
  when the model is already on disk), notices about a source that could not
  be recorded, Stop.
- Settings > Meetings: the five models with their size, download with
  progress, delete, the selected one (default Large v3 Turbo, 646 MB);
  language (automatic or fixed); microphone and system audio switches; the
  offer to record when another app takes the microphone.
- Account > Record Meeting sends the `record-meeting` command, so the page
  picks the destination (the open page, or its space); with no page up it
  records for the active account into its default space.
- `Info.plist` has `NSMicrophoneUsageDescription` and
  `NSAudioCaptureUsageDescription` (English and Spanish); the entitlements
  file has `com.apple.security.device.audio-input` for a hardened build.
- Automation: `POST /automation/transcribe-file { path, pageId?, spaceId?,
  title?, model? }`, `GET /automation/meetings`,
  `POST /automation/meeting-preview { show }` (the panel with made-up
  values, nothing recorded).

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
