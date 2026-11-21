import AppKit
import WebKit

/// What the page last reported about its own syncing.
struct SyncState: Equatable {
    var online = true
    var pending = 0
    var syncing = false
    var conflicts = 0
    /// False until the page has said anything.
    var reported = false
}

/// Everything live for one account: its web data store, the scheme handler
/// that feeds its pages, the web client on disk, the offline files and the
/// reachability of its server.
@MainActor
final class ProfileSession: NSObject {
    let profileId: String
    private let initialProfile: Profile
    unowned let services: Services
    let bundle: BundleStore
    let files: FileCache
    let reachability: ServerReachability
    let spotlightMap: SpotlightMap
    let dataStore: WKWebsiteDataStore
    private(set) var schemeHandler: SchemeHandler!
    private var receiver: BridgeReceiver!
    private let webViews = NSHashTable<WKWebView>.weakObjects()
    private var bundleCheck: Task<Void, Never>?
    private(set) var syncState = SyncState()
    var badgeCount = 0
    /// Set while the first copy of the web client downloads.
    private(set) var bundleProgress: BundleStore.Progress?
    private(set) var lastBundleError: String?

    init(profile: Profile, services: Services) {
        self.profileId = profile.id
        self.initialProfile = profile
        self.services = services
        let paths = services.paths
        bundle = BundleStore(directory: paths.bundleDir(profile.id))
        files = FileCache(directory: paths.filesDir(profile.id))
        reachability = ServerReachability(serverURL: profile.server)
        spotlightMap = SpotlightMap(file: paths.profileDir(profile.id).appendingPathComponent("spotlight.json"))
        let uuid = ProfileID.dataStoreUUID(profileId: profile.id, dataRoot: paths.isOverridden ? paths.root.path : nil)
        dataStore = WKWebsiteDataStore(forIdentifier: uuid)
        super.init()

        let context = ProxyContext(
            profileId: profile.id,
            serverURL: profile.server,
            tokens: services.tokens,
            reachability: reachability,
            files: files,
            bundle: bundle,
            engine: services.proxyEngine
        )
        schemeHandler = SchemeHandler(context: context)
        receiver = BridgeReceiver(session: self)

        reachability.onChange = { [weak self] reachable in
            Task { @MainActor in
                guard let self else { return }
                self.emit("net.changed", ["reachable": reachable])
                NotificationCenter.default.post(name: .docmoreSyncStateChanged, object: self)
                if reachable {
                    self.refreshBundleInBackground()
                    BackgroundQueues.shared.kick()
                }
            }
        }
        reachability.startMonitoring()
        bundle.prune()
    }

    var profile: Profile { services.profiles.profile(id: profileId) ?? initialProfile }
    var serverURL: URL { initialProfile.server }
    var appOrigin: String { "\(AppScheme.name)://\(profileId)" }

    func appURL(path: String) -> URL {
        let clean = path.hasPrefix("/") ? path : "/" + path
        return URL(string: appOrigin + clean) ?? URL(string: appOrigin + "/")!
    }

    var api: ServerAPI {
        ServerAPI(profileId: profileId, serverURL: serverURL, tokens: services.tokens, reachability: reachability, session: services.plainSession)
    }

    func shutdown() {
        bundleCheck?.cancel()
        for webView in webViews.allObjects {
            webView.configuration.userContentController.removeAllScriptMessageHandlers()
        }
    }

    // MARK: Web views

    private var nativeInfoScript: String {
        let info: [String: Any] = [
            "platform": "mac",
            "appVersion": services.appVersion,
            "serverUrl": serverURL.absoluteString,
            "deviceId": services.device.deviceId,
            "deviceName": services.device.deviceName,
            "capabilities": ["files", "notify", "badge", "spotlight", "meetings", "state"],
        ]
        let json = (try? JSONSerialization.data(withJSONObject: info)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        var script = """
        (function () {
          window.DOCMORE_NATIVE = \(json);
          var post = function (type, payload) {
            try { window.webkit.messageHandlers.docmore.postMessage({ id: null, type: type, payload: payload || null }); } catch (e) {}
          };
          window.print = function () { post("print"); };
        """
        #if DEBUG
        if AutomationServer.isEnabled {
            script += """

              var describe = function (value) {
                try {
                  if (value instanceof Error) return value.message + (value.stack ? "\\n" + value.stack : "");
                  if (typeof value === "string") return value;
                  return JSON.stringify(value);
                } catch (e) { return String(value); }
              };
              var original = console.error;
              console.error = function () {
                post("debug.log", { level: "error", message: Array.prototype.map.call(arguments, describe).join(" ").slice(0, 2000) });
                return original.apply(console, arguments);
              };
              window.addEventListener("error", function (event) {
                post("debug.log", { level: "uncaught", message: String(event.message) + " @ " + event.filename + ":" + event.lineno });
              });
              window.addEventListener("unhandledrejection", function (event) {
                post("debug.log", { level: "rejection", message: describe(event.reason).slice(0, 2000) });
              });
            """
        }
        #endif
        script += "\n})();"
        return script
    }

    func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: AppScheme.name)
        configuration.userContentController.addUserScript(
            WKUserScript(source: nativeInfoScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        configuration.userContentController.addUserScript(
            WKUserScript(source: PageScripts.bodyShim, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        )
        configuration.userContentController.add(receiver, name: "docmore")
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.applicationNameForUserAgent = "Docmore/\(services.appVersion)"
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760), configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        webViews.add(webView)
        return webView
    }

    var openWebViews: [WKWebView] { webViews.allObjects }

    // MARK: Native -> web

    /// Dispatches `docmore:native` in one web view, or in every web view of
    /// this account when none is given.
    func emit(_ type: String, _ payload: Any, to target: WKWebView? = nil) {
        guard let detail = try? JSONSerialization.data(withJSONObject: ["type": type, "payload": payload]),
              let json = String(data: detail, encoding: .utf8) else { return }
        services.bridgeLog.add(direction: "out", profileId: profileId, type: type, payload: payload)
        let script = "window.dispatchEvent(new CustomEvent(\"docmore:native\", { detail: \(json) }));"
        let targets = target.map { [$0] } ?? webViews.allObjects
        for webView in targets {
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    func reply(to id: String, error: String?, result: Any?, in webView: WKWebView?) {
        guard let webView else { return }
        let arguments: [Any] = [id, error ?? NSNull(), result ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        // json is "[id, error, result]": spread it into the call
        webView.evaluateJavaScript("window.__docmoreNativeReply && window.__docmoreNativeReply.apply(null, \(json));", completionHandler: nil)
    }

    func updateSyncState(_ payload: [String: Any]) {
        var next = syncState
        next.reported = true
        if let online = payload["online"] as? Bool { next.online = online }
        if let pending = payload["pending"] as? Int { next.pending = pending }
        if let syncing = payload["syncing"] as? Bool { next.syncing = syncing }
        if let conflicts = payload["conflicts"] as? Int { next.conflicts = conflicts }
        guard next != syncState else { return }
        syncState = next
        NotificationCenter.default.post(name: .docmoreSyncStateChanged, object: self)
    }

    // MARK: Web client bundle

    /// Makes sure a copy of the web client is on disk. With one already
    /// there it returns at once and checks for a newer one in the background.
    func prepareBundle() async throws {
        if bundle.current != nil {
            refreshBundleInBackground()
            return
        }
        defer { bundleProgress = nil }
        _ = try await installLatestBundle(reportProgress: true)
    }

    /// Downloads the bundle the server serves now. False when it already is
    /// the current one.
    @discardableResult
    func installLatestBundle(reportProgress: Bool = false) async throws -> Bool {
        if NetworkOverride.shared.forcedUnreachable { throw NetworkOverride.unreachableError }
        let server = serverURL.absoluteString
        let session = services.plainSession
        var request = URLRequest(url: URL(string: server + "/api/sync/client-bundle")!)
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw BundleError.invalidManifest("the server answered \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        let manifest = try BundleManifest.decode(data)
        if bundle.current?.hash == manifest.hash { return false }

        var report: (@Sendable (BundleStore.Progress) -> Void)?
        if reportProgress {
            report = { [weak self] progress in
                Task<Void, Never> { @MainActor in
                    guard let self else { return }
                    self.bundleProgress = progress
                    NotificationCenter.default.post(name: .docmoreBundleProgress, object: self)
                }
            }
        }
        do {
            try await bundle.install(manifest: manifest, fetch: { file in
                var allowed = CharacterSet.urlPathAllowed
                allowed.remove(charactersIn: "?#%")
                let encoded = file.path.addingPercentEncoding(withAllowedCharacters: allowed) ?? file.path
                guard let url = URL(string: "\(server)/\(encoded)") else {
                    throw BundleError.download(path: file.path, detail: "bad address")
                }
                var request = URLRequest(url: url)
                request.cachePolicy = .reloadIgnoringLocalCacheData
                request.timeoutInterval = 60
                var lastError: Error = URLError(.unknown)
                for attempt in 0..<3 {
                    do {
                        let (data, response) = try await session.data(for: request)
                        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                            throw BundleError.download(path: file.path, detail: "status \((response as? HTTPURLResponse)?.statusCode ?? 0)")
                        }
                        return data
                    } catch {
                        lastError = error
                        try? await Task.sleep(nanoseconds: UInt64(300_000_000 * (attempt + 1)))
                    }
                }
                throw BundleError.download(path: file.path, detail: lastError.localizedDescription)
            }, progress: report)
            lastBundleError = nil
        } catch {
            lastBundleError = error.localizedDescription
            throw error
        }
        bundle.prune(keeping: schemeHandler.pinnedHashes)
        return true
    }

    /// Asks the server which client it serves and, when it differs from the
    /// copy on disk, downloads the new one for the next page load.
    func refreshBundleInBackground() {
        guard bundleCheck == nil, bundle.current != nil else { return }
        bundleCheck = Task<Void, Never> { @MainActor [weak self] in
            guard let self else { return }
            defer { self.bundleCheck = nil }
            guard let info = try? await self.services.oauthClient(server: self.serverURL).serverInfo(),
                  !NetworkOverride.shared.forcedUnreachable,
                  info.clientHash != self.bundle.current?.hash else { return }
            _ = try? await self.installLatestBundle()
        }
    }

    /// Waits for a running background check (automation).
    func waitForBundleCheck() async {
        await bundleCheck?.value
    }
}

/// Receives `window.webkit.messageHandlers.docmore.postMessage(...)`.
/// The content controller keeps its handlers alive, so this one only holds
/// the session weakly.
final class BridgeReceiver: NSObject, WKScriptMessageHandler {
    private weak var session: ProfileSession?

    init(session: ProfileSession) {
        self.session = session
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let id = body["id"] as? String
        let payload = body["payload"] as? [String: Any] ?? [:]
        let webView = message.webView
        Task { @MainActor [weak session] in
            guard let session else { return }
            await Bridge.handle(type: type, payload: payload, id: id, webView: webView, session: session)
        }
    }
}
