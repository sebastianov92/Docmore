#if DEBUG
import AppKit
import WebKit

/// What each automation endpoint does. Everything runs on the main actor,
/// through the same code paths the menus and the bridge use.
@MainActor
final class AutomationRoutes {
    typealias Request = AutomationServer.Request
    typealias Response = AutomationServer.Response

    private var services: Services { .shared }
    private var coordinator: AppCoordinator { .shared }
    private var quitRequested = false
    private var eraseOnQuit = false

    func handle(_ request: Request) async -> Response {
        switch (request.method, request.path) {
        case ("POST", "/automation/session"): return await session(request)
        case ("POST", "/automation/eval"): return await eval(request)
        case ("GET", "/automation/snapshot"): return await snapshot(request)
        case ("POST", "/automation/network"): return await network(request)
        case ("GET", "/automation/state"): return .json(state())
        case ("POST", "/automation/command"): return command(request)
        case ("POST", "/automation/reload"): return await reload(request)
        case ("GET", "/automation/bridge-log"): return bridgeLog(request)
        case ("POST", "/automation/quit"): return quit(request)
        // beyond the minimum: things the end-to-end script needs to reach
        case ("POST", "/automation/navigate"): return await navigate(request)
        case ("POST", "/automation/token"): return await overwriteToken(request)
        case ("POST", "/automation/deeplink"): return deepLink(request)
        case ("POST", "/automation/bundle-check"): return await bundleCheck(request)
        case ("POST", "/automation/window"): return await window(request)
        case ("POST", "/automation/emit"): return emit(request)
        case ("POST", "/automation/spotlight-open"): return spotlightOpen(request)
        case ("POST", "/automation/spotlight-find"): return await spotlightFind(request)
        case ("POST", "/automation/spotlight-selftest"): return await spotlightSelfTest(request)
        case ("POST", "/automation/sign-out"): return await signOut(request)
        case ("GET", "/automation/native-snapshot"): return nativeSnapshot(request)
        case ("POST", "/automation/transcribe-file"): return await AutomationExtras.transcribeFile(request)
        case ("GET", "/automation/meetings"): return await AutomationExtras.meetings(request)
        case ("POST", "/automation/quick-capture"): return await AutomationExtras.quickCapture(request)
        case ("POST", "/automation/meeting-preview"): return AutomationMeetings.preview(request)
        case ("POST", "/automation/meeting"): return await AutomationMeetings.act(request)
        case ("GET", "/automation/meeting"): return .json(AutomationMeetings.state())
        case ("POST", "/automation/lock"): return AutomationExtras.lock(request)
        case ("POST", "/automation/mic-activity"): return AutomationExtras.microphoneActivity(request)
        default: return .error("no such endpoint: \(request.method) \(request.path)", status: 404)
        }
    }

    /// Runs after the answer went out (quitting before would cut it off).
    func afterResponse(_ request: Request) {
        guard quitRequested else { return }
        let erase = eraseOnQuit
        Task { @MainActor in
            if erase { await eraseEverything() }
            try? await Task.sleep(nanoseconds: 150_000_000)
            NSApp.terminate(nil)
        }
    }

    private func browser(_ request: Request) -> BrowserWindowController? {
        if let index = request.json["window"] as? Int, coordinator.browsers.indices.contains(index) {
            return coordinator.browsers[index]
        }
        if let index = request.query["window"].flatMap({ Int($0) }), coordinator.browsers.indices.contains(index) {
            return coordinator.browsers[index]
        }
        return coordinator.frontBrowser
    }

    // MARK: Endpoints

    /// { serverUrl, clientId, accessToken, refreshToken, expiresIn?, path?, open? }
    private func session(_ request: Request) async -> Response {
        let body = request.json
        guard let serverText = body["serverUrl"] as? String, let server = ServerAddress.normalize(serverText),
              let clientId = body["clientId"] as? String,
              let access = body["accessToken"] as? String,
              let refresh = body["refreshToken"] as? String else {
            return .error("session needs serverUrl, clientId, accessToken and refreshToken")
        }
        let lifetime = (body["expiresIn"] as? Double) ?? 3600
        do {
            let profile = try await coordinator.signIn.complete(
                server: server,
                clientId: clientId,
                tokens: TokenSet(accessToken: access, refreshToken: refresh, expiresAt: Date().addingTimeInterval(lifetime))
            )
            if (body["open"] as? Bool) == false {
                return .json(["ok": true, "profileId": profile.id, "userId": profile.userId])
            }
            services.profiles.setActive(profile.id)
            let controller = coordinator.browsers(for: profile.id).first
                ?? coordinator.openWindow(profileId: profile.id, path: body["path"] as? String ?? "/home")
            await controller?.waitForLoad(timeout: 180)
            var answer: [String: Any] = [
                "ok": controller?.loadFailure == nil,
                "profileId": profile.id,
                "userId": profile.userId,
                "origin": profile.appOrigin,
                "loaded": controller?.pageLoaded ?? false,
            ]
            if let failure = controller?.loadFailure { answer["error"] = failure }
            return .json(answer)
        } catch {
            return .error("session failed: \(error.localizedDescription)", status: 500)
        }
    }

    /// { js, timeout?, window? }: `js` is the body of an async function.
    private func eval(_ request: Request) async -> Response {
        guard let js = request.json["js"] as? String else { return .error("eval needs js") }
        guard let controller = browser(request) else { return .error("no window", status: 409) }
        let timeout = (request.json["timeout"] as? Double) ?? 30
        let wrapped = """
        try {
          const __value = await (async () => { \(js)
          })();
          return JSON.stringify({ ok: true, value: __value === undefined ? null : __value });
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error), name: String(error && error.name || ""), stack: String(error && error.stack || "").slice(0, 1500) });
        }
        """
        let webView = controller.webView
        let outcome: Result<String, Error> = await withCheckedContinuation { continuation in
            var resumed = false
            let finish: (Result<String, Error>) -> Void = { result in
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: result)
            }
            webView.callAsyncJavaScript(wrapped, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value): finish(.success(value as? String ?? "null"))
                case .failure(let error): finish(.failure(error))
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
                finish(.failure(NSError(domain: "automation", code: 1, userInfo: [NSLocalizedDescriptionKey: "eval timed out after \(Int(timeout)) s"])))
            }
        }
        switch outcome {
        case .success(let text):
            // already JSON: pass it through as is
            return Response(status: 200, contentType: "application/json", body: Data(text.utf8))
        case .failure(let error):
            let detail = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
            return .error(detail, status: 500)
        }
    }

    private func snapshot(_ request: Request) async -> Response {
        guard let controller = browser(request) else { return .error("no window", status: 409) }
        let image: NSImage? = await withCheckedContinuation { continuation in
            controller.webView.takeSnapshot(with: nil) { image, _ in
                continuation.resume(returning: image)
            }
        }
        guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            return .error("snapshot failed", status: 500)
        }
        return Response(status: 200, contentType: "image/png", body: png)
    }

    /// { reachable: true | false | null }
    private func network(_ request: Request) async -> Response {
        let value = request.json["reachable"]
        let forced = (value as? Bool) == false
        NetworkOverride.shared.forcedUnreachable = forced
        var results: [String: Bool] = [:]
        for session in services.liveSessions {
            results[session.profileId] = await session.reachability.probe()
        }
        // let the change reach the pages before answering
        try? await Task.sleep(nanoseconds: 100_000_000)
        return .json(["ok": true, "forcedUnreachable": forced, "reachable": results])
    }

    func state() -> [String: Any] {
        var profiles: [[String: Any]] = []
        for profile in services.profiles.profiles {
            var entry: [String: Any] = [
                "id": profile.id,
                "serverUrl": profile.serverURL,
                "userId": profile.userId,
                "userName": profile.userName,
                "needsSignIn": profile.needsSignIn,
                "origin": profile.appOrigin,
                "webDataDirectory": services.webDataDirectory(profileId: profile.id).path,
            ]
            if let session = services.liveSessions.first(where: { $0.profileId == profile.id }) {
                let usage = session.files.usage()
                let sync = session.syncState
                entry["reachable"] = session.reachability.reachable
                entry["files"] = ["bytes": usage.bytes, "count": usage.count]
                entry["sync"] = ["reported": sync.reported, "online": sync.online, "pending": sync.pending, "syncing": sync.syncing, "conflicts": sync.conflicts]
                entry["badge"] = session.badgeCount
                entry["spotlightItems"] = session.spotlightMap.count
                if let current = session.bundle.current {
                    entry["bundle"] = ["hash": current.hash, "version": current.version, "previousHash": (current.previousHash as Any?) ?? NSNull()]
                }
                entry["status"] = SyncStatus.describe(session: session).text
            }
            profiles.append(entry)
        }
        let windows: [[String: Any]] = coordinator.browsers.enumerated().map { index, controller in
            [
                "index": index,
                "profileId": controller.session.profileId,
                "url": controller.webView.url?.absoluteString ?? "",
                "path": controller.currentPath,
                "title": controller.window?.title ?? "",
                "loaded": controller.pageLoaded,
                "loading": controller.webView.isLoading,
                "key": controller.window?.isKeyWindow ?? false,
                "tabs": controller.window?.tabbedWindows?.count ?? 1,
                "canGoBack": controller.webView.canGoBack,
                "signInSheet": controller.signInSheetShown,
                "locked": controller.isLocked,
                "webViewHidden": controller.webView.isHidden,
                "zoom": controller.webView.pageZoom,
            ]
        }
        return [
            "ok": true,
            "appVersion": services.appVersion,
            "dataDir": services.paths.root.path,
            "defaultsSuite": (services.paths.defaultsSuiteName as Any?) ?? NSNull(),
            "deviceId": services.device.deviceId,
            "activeProfileId": (services.profiles.activeProfileId as Any?) ?? NSNull(),
            "forcedUnreachable": NetworkOverride.shared.forcedUnreachable,
            "profiles": profiles,
            "windows": windows,
            "notifications": services.notifications.recorded,
            "spotlight": services.spotlight.recorded,
            "dockBadge": NSApp.dockTile.badgeLabel ?? "",
            "meeting": MeetingController.shared.statePayload,
            "menus": (NSApp.mainMenu?.items ?? []).map(\.title),
            "externalOpened": services.externalOpened,
            "locked": AppLock.shared.isLocked,
            "updaterConfigured": Updater.shared.isConfigured,
            "updateMenuHidden": NSApp.mainMenu?.items.first?.submenu?.items.first { $0.action == #selector(AppDelegate.checkForUpdates(_:)) }?.isHidden ?? true,
            "captureQueue": QuickCapture.shared.queue.all().count,
            "pickerVisible": coordinator.isPickerVisible,
            "settingsVisible": coordinator.isSettingsVisible,
            "locale": Locale.current.identifier,
        ]
    }

    private func command(_ request: Request) -> Response {
        guard let id = request.json["id"] as? String else { return .error("command needs id") }
        guard let controller = browser(request) else { return .error("no window", status: 409) }
        controller.sendCommand(id)
        return .json(["ok": true])
    }

    private func reload(_ request: Request) async -> Response {
        guard let controller = browser(request) else { return .error("no window", status: 409) }
        controller.reload()
        try? await Task.sleep(nanoseconds: 200_000_000)
        await controller.waitForLoad(timeout: 60)
        return .json(["ok": true, "loaded": controller.pageLoaded, "url": controller.webView.url?.absoluteString ?? ""])
    }

    private func bridgeLog(_ request: Request) -> Response {
        var entries = services.bridgeLog.json()
        if let type = request.query["type"] {
            entries = entries.filter { ($0["type"] as? String) == type }
        }
        if let direction = request.query["dir"] {
            entries = entries.filter { ($0["dir"] as? String) == direction }
        }
        return .json(["ok": true, "entries": entries])
    }

    /// { erase?: true } also removes what the run left outside the data
    /// directory (web data stores, the defaults suite).
    private func quit(_ request: Request) -> Response {
        quitRequested = true
        eraseOnQuit = (request.json["erase"] as? Bool) ?? false
        return .json(["ok": true])
    }

    private func eraseEverything() async {
        for controller in coordinator.browsers {
            controller.window?.close()
        }
        try? await Task.sleep(nanoseconds: 300_000_000)
        var folders: [URL] = []
        for profile in services.profiles.profiles {
            folders.append(services.webDataDirectory(profileId: profile.id))
            await services.eraseLocalData(profileId: profile.id)
        }
        // the process is about to exit: what WebKit still holds open can go
        for folder in folders where folder.path.contains("/WebsiteDataStore/") {
            try? FileManager.default.removeItem(at: folder)
        }
        try? FileManager.default.removeItem(at: services.paths.root.appendingPathComponent("stores-to-remove.json"))
        if let suite = services.paths.defaultsSuiteName {
            UserDefaults.standard.removePersistentDomain(forName: suite)
            services.defaults.removePersistentDomain(forName: suite)
            services.defaults.synchronize()
            // the emptied file of the test suite goes too
            let file = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Preferences/\(suite).plist")
            try? FileManager.default.removeItem(at: file)
        }
    }

    private func navigate(_ request: Request) async -> Response {
        guard let path = request.json["path"] as? String else { return .error("navigate needs path") }
        guard let controller = browser(request) else { return .error("no window", status: 409) }
        if (request.json["load"] as? Bool) == true {
            controller.pageLoaded = false
            controller.webView.load(URLRequest(url: controller.session.appURL(path: path)))
            try? await Task.sleep(nanoseconds: 200_000_000)
            await controller.waitForLoad(timeout: 60)
        } else {
            controller.navigate(to: path)
        }
        return .json(["ok": true, "url": controller.webView.url?.absoluteString ?? ""])
    }

    /// { accessToken, expiresIn? }: replaces only the stored access token of
    /// the front account, to exercise the refresh path.
    private func overwriteToken(_ request: Request) async -> Response {
        guard let controller = browser(request) else { return .error("no window", status: 409) }
        let profileId = controller.session.profileId
        guard let current = services.tokenStore.load(profileId: profileId) else { return .error("no tokens stored", status: 409) }
        let access = request.json["accessToken"] as? String ?? current.accessToken
        let refresh = request.json["refreshToken"] as? String ?? current.refreshToken
        let lifetime = (request.json["expiresIn"] as? Double) ?? 3600
        do {
            try await services.tokens.save(TokenSet(accessToken: access, refreshToken: refresh, expiresAt: Date().addingTimeInterval(lifetime)), profileId: profileId)
        } catch {
            return .error(error.localizedDescription, status: 500)
        }
        return .json(["ok": true])
    }

    private func deepLink(_ request: Request) -> Response {
        guard let text = request.json["url"] as? String, let url = URL(string: text) else { return .error("deeplink needs url") }
        guard DeepLink.parse(url) != nil else { return .error("not a docmore link the app understands") }
        coordinator.handleDeepLink(url)
        return .json(["ok": true])
    }

    private func bundleCheck(_ request: Request) async -> Response {
        guard let controller = browser(request) else { return .error("no window", status: 409) }
        let session = controller.session
        let before = session.bundle.current?.hash ?? ""
        do {
            let installed = try await session.installLatestBundle()
            return .json([
                "ok": true,
                "updated": installed,
                "before": before,
                "hash": session.bundle.current?.hash ?? "",
                "previousHash": (session.bundle.current?.previousHash as Any?) ?? NSNull(),
            ])
        } catch {
            return .error(error.localizedDescription, status: 500)
        }
    }

    /// { action: "new-tab" | "new-window" | "close" | "front" | "settings" | "picker", window? }
    private func window(_ request: Request) async -> Response {
        let action = request.json["action"] as? String ?? ""
        switch action {
        case "new-tab":
            guard let controller = browser(request) else { return .error("no window", status: 409) }
            let tab = coordinator.openTab(in: controller, path: request.json["path"] as? String ?? "/home")
            await tab?.waitForLoad(timeout: 60)
        case "new-window":
            guard let profile = coordinator.activeProfile else { return .error("no account", status: 409) }
            let opened = coordinator.openWindow(profileId: request.json["profileId"] as? String ?? profile.id, path: request.json["path"] as? String ?? "/home")
            await opened?.waitForLoad(timeout: 60)
        case "close":
            browser(request)?.window?.close()
        case "front":
            browser(request)?.window?.makeKeyAndOrderFront(nil)
        case "settings":
            coordinator.showSettings(tab: (request.json["tab"] as? String).flatMap(SettingsTab.init(rawValue:)))
            // { scroll: 0...1 }: how far down the tab is scrolled, for a snapshot of its lower part
            if let fraction = request.json["scroll"] as? Double, let content = coordinator.settingsWindowForAutomation?.contentView {
                try? await Task.sleep(nanoseconds: 300_000_000)
                Self.scrollViews(in: content).forEach { scroll in
                    guard let document = scroll.documentView else { return }
                    let distance = max(0, document.frame.height - scroll.contentView.bounds.height)
                    let y = document.isFlipped ? distance * fraction : distance * (1 - fraction)
                    scroll.contentView.scroll(to: NSPoint(x: 0, y: y))
                    scroll.reflectScrolledClipView(scroll.contentView)
                }
            }
        case "picker":
            coordinator.showPicker()
        case "switch":
            guard let profileId = request.json["profileId"] as? String else { return .error("switch needs profileId") }
            coordinator.switchAccount(to: profileId)
            await coordinator.browsers(for: profileId).first?.waitForLoad(timeout: 60)
        default:
            return .error("unknown window action")
        }
        return .json(["ok": true, "windows": coordinator.browsers.count])
    }

    private static func scrollViews(in view: NSView) -> [NSScrollView] {
        var found: [NSScrollView] = []
        if let scroll = view as? NSScrollView { found.append(scroll) }
        for child in view.subviews { found.append(contentsOf: scrollViews(in: child)) }
        return found
    }

    /// { type, payload }: dispatches a native event in the front page.
    private func emit(_ request: Request) -> Response {
        guard let type = request.json["type"] as? String else { return .error("emit needs type") }
        guard let controller = browser(request) else { return .error("no window", status: 409) }
        controller.session.emit(type, request.json["payload"] ?? [:], to: controller.webView)
        return .json(["ok": true])
    }

    /// { title }: this app's entries in the system search whose title contains it.
    private func spotlightFind(_ request: Request) async -> Response {
        guard let title = request.json["title"] as? String, !title.isEmpty else { return .error("spotlight-find needs title") }
        let found = await services.spotlight.find(titleContaining: title)
        return .json(["identifiers": found, "real": services.spotlight is SystemSpotlightSink])
    }

    /// The real system index, whatever sink this run uses. { phase: "add" }
    /// puts a made-up entry in and waits until a query finds it;
    /// { phase: "remove", title } takes it out and waits until it is gone.
    private func spotlightSelfTest(_ request: Request) async -> Response {
        let sink = SystemSpotlightSink()
        let domain = "selftest"
        let identifier = SpotlightMap.identifier(profileId: domain, itemId: "probe")
        let wait: (@escaping ([String]) -> Bool, String) async -> Int? = { done, title in
            let start = Date()
            for _ in 0..<60 {
                if done(await sink.find(titleContaining: title)) { return Int(Date().timeIntervalSince(start) * 1000) }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            return nil
        }
        if request.json["phase"] as? String == "remove" {
            guard let title = request.json["title"] as? String, !title.isEmpty else { return .error("remove needs title") }
            sink.clear(profileId: domain)
            let gone = await wait({ !$0.contains(identifier) }, title)
            return .json(["removed": gone != nil, "afterMs": gone ?? -1])
        }
        let title = "docmoreselftest\(UUID().uuidString.prefix(8).lowercased())"
        sink.index(profileId: domain, items: [SpotlightEntry(id: "probe", title: title, text: "probe text of \(title)", detail: "Self test")])
        let found = await wait({ $0.contains(identifier) }, title)
        return .json(["found": found != nil, "afterMs": found ?? -1, "title": title, "identifier": identifier])
    }

    private func spotlightOpen(_ request: Request) -> Response {
        guard let identifier = request.json["identifier"] as? String else { return .error("spotlight-open needs identifier") }
        let opened = (NSApp.delegate as? AppDelegate)?.openSpotlightResult(identifier) ?? false
        return .json(["ok": opened])
    }

    /// ?which=front|settings|picker|panel|meeting: a native window drawn into a PNG,
    /// chrome included, without touching the screen.
    private func nativeSnapshot(_ request: Request) -> Response {
        let which = request.query["which"] ?? "front"
        let window: NSWindow?
        switch which {
        case "settings": window = coordinator.settingsWindowForAutomation
        case "picker": window = coordinator.pickerWindowForAutomation
        case "panel": window = NSApp.windows.first { $0 is NSPanel && $0.isVisible }
        case "meeting": window = MeetingController.shared.isPanelVisible ? MeetingController.shared.panelForAutomation : nil
        default: window = browser(request)?.window
        }
        guard let window, let view = window.contentView?.superview ?? window.contentView else {
            return .error("no such window", status: 404)
        }
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            return .error("snapshot failed", status: 500)
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            return .error("snapshot failed", status: 500)
        }
        return Response(status: 200, contentType: "image/png", body: png)
    }

    /// { profileId }: the same path as the page's own Sign out.
    private func signOut(_ request: Request) async -> Response {
        guard let profileId = request.json["profileId"] as? String ?? coordinator.frontBrowser?.session.profileId else {
            return .error("no account", status: 409)
        }
        await coordinator.signOut(profileId: profileId)
        return .json(["ok": true, "profiles": services.profiles.profiles.count])
    }
}

/// Endpoints of the meeting and polish stages.
@MainActor
enum AutomationExtras {
    typealias Request = AutomationServer.Request
    typealias Response = AutomationServer.Response

    /// { path, pageId?, spaceId?, title?, model?, profileId?, mode?, names? }:
    /// a recording through the final pass and the queue, the way one goes
    /// after Stop. `mode` defaults to what the file tells (two channels are
    /// a virtual meeting); `names` are names for its speakers by id.
    static func transcribeFile(_ request: Request) async -> Response {
        let body = request.json
        guard let path = body["path"] as? String else { return .error("transcribe-file needs path") }
        guard let profileId = body["profileId"] as? String ?? AppCoordinator.shared.activeProfile?.id,
              let profile = Services.shared.profiles.profile(id: profileId) else { return .error("no account", status: 409) }
        let pageId = body["pageId"] as? String
        let target = MeetingDestination(
            profileId: profileId,
            pageId: pageId,
            spaceId: body["spaceId"] as? String ?? (pageId == nil ? profile.defaultSpaceId : nil),
            title: body["title"] as? String
        )
        var mode: MeetingMode?
        if let text = body["mode"] as? String {
            guard let known = MeetingMode(rawValue: text) else { return .error("mode is in_person or virtual") }
            mode = known
        }
        do {
            var answer = try await MeetingController.shared.processFile(
                path: path, target: target, model: body["model"] as? String,
                mode: mode, names: body["names"] as? [String: String] ?? [:]
            )
            answer["ok"] = true
            return .json(answer)
        } catch {
            return .error(error.localizedDescription, status: 500)
        }
    }

    /// The meeting engine as the app sees it: state, queue, models.
    /// `?flush=1` sends what waits first.
    static func meetings(_ request: Request) async -> Response {
        let controller = MeetingController.shared
        let engine = controller.engine
        if request.query["flush"] == "1" {
            controller.flushQueue()
            await controller.settle()
        }
        let jobs = await engine.jobs()
        return .json([
            "ok": true,
            "available": engine.isAvailable,
            "reason": engine.isAvailable ? "" : engine.unavailableReason,
            "state": controller.statePayload,
            "panelVisible": controller.isPanelVisible,
            "jobs": jobs.map(\.json),
            // the transcripts the server took in this run: which meeting each job became
            "delivered": controller.deliveries.map(\.json),
            "speakerModel": [
                "present": engine.speakerModel != nil,
                "id": engine.speakerModel?.id ?? "",
                "downloaded": engine.isSpeakerModelDownloaded,
                "sizeOnDisk": engine.speakerModelSizeOnDisk,
            ],
            "models": engine.models.map { ["id": $0.id, "name": $0.name, "sizeBytes": $0.sizeBytes, "downloaded": engine.isDownloaded($0.id)] },
            "selectedModel": Services.shared.settings.meetingModel,
        ])
    }

    /// { text, spaceId?, profileId? }: the same path as Save in the panel.
    /// { action: "show" | "close" | "flush" | "list" } for the rest.
    static func quickCapture(_ request: Request) async -> Response {
        let services = Services.shared
        let capture = QuickCapture.shared
        let body = request.json
        switch body["action"] as? String ?? "save" {
        case "show":
            capture.showPanel()
        case "close":
            capture.closePanel()
        case "flush":
            capture.flush()
            await capture.settle()
        case "list":
            break
        default:
            guard let text = body["text"] as? String else { return .error("quick-capture needs text") }
            guard let profileId = body["profileId"] as? String ?? AppCoordinator.shared.activeProfile?.id,
                  let profile = services.profiles.profile(id: profileId) else { return .error("no account", status: 409) }
            guard let spaceId = body["spaceId"] as? String ?? profile.defaultSpaceId else { return .error("no space", status: 409) }
            guard let note = capture.submit(text: text, profileId: profileId, spaceId: spaceId) else {
                return .error("nothing to save")
            }
            await capture.settle()
            return .json(["ok": true, "id": note.id, "title": note.title, "queue": notes(capture)])
        }
        return .json([
            "ok": true,
            "queue": notes(capture),
            "panelVisible": capture.isPanelVisible,
            "hotKeyRegistered": capture.hotKeyRegistered,
            "hotKey": services.settings.quickCaptureHotKey.displayString,
        ])
    }

    private static func notes(_ capture: QuickCapture) -> [[String: Any]] {
        capture.queue.all().map { note in
            var entry: [String: Any] = ["id": note.id, "title": note.title, "profileId": note.profileId, "attempts": note.attempts]
            if let failure = note.failure { entry["failure"] = failure }
            return entry
        }
    }

    /// { action: "enable" | "disable" | "lock" | "unlock" }. "unlock" stands
    /// in for the Touch ID prompt nobody can answer in a scripted run.
    static func lock(_ request: Request) -> Response {
        let services = Services.shared
        switch request.json["action"] as? String ?? "state" {
        case "enable":
            services.settings.lockEnabled = true
        case "disable":
            services.settings.lockEnabled = false
        case "lock":
            AppLock.shared.lock(force: request.json["force"] as? Bool ?? false)
        case "unlock":
            AppLock.shared.unlock()
        default:
            break
        }
        return .json([
            "ok": true,
            "enabled": services.settings.lockEnabled,
            "locked": AppLock.shared.isLocked,
            "windowsLocked": AppCoordinator.shared.browsers.map(\.isLocked),
        ])
    }

    /// { inUse: Bool }: what the microphone watcher would report.
    static func microphoneActivity(_ request: Request) -> Response {
        MeetingDetector.shared.evaluate(inUse: request.json["inUse"] as? Bool ?? false)
        return .json(["ok": true])
    }
}
#endif
