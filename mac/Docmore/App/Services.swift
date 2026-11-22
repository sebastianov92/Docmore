import AppKit
import WebKit

extension Notification.Name {
    static let docmoreProfilesChanged = Notification.Name("docmoreProfilesChanged")
    static let docmoreSyncStateChanged = Notification.Name("docmoreSyncStateChanged")
    static let docmoreNeedsSignIn = Notification.Name("docmoreNeedsSignIn")
    static let docmoreBundleProgress = Notification.Name("docmoreBundleProgress")
}

/// Recent bridge traffic, for the automation server and for debugging.
final class BridgeLog {
    struct Entry {
        let time: Date
        let direction: String
        let profileId: String
        let type: String
        let detail: String
    }

    private(set) var entries: [Entry] = []
    private let limit = 500

    func add(direction: String, profileId: String, type: String, payload: Any?) {
        var detail = ""
        if let payload, !(payload is NSNull),
           JSONSerialization.isValidJSONObject(["p": payload]),
           let data = try? JSONSerialization.data(withJSONObject: ["p": payload], options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            detail = text.count > 600 ? String(text.prefix(600)) + "..." : text
        }
        entries.append(Entry(time: Date(), direction: direction, profileId: profileId, type: type, detail: detail))
        if entries.count > limit { entries.removeFirst(entries.count - limit) }
    }

    func json() -> [[String: Any]] {
        entries.map {
            ["t": $0.time.timeIntervalSince1970, "dir": $0.direction, "profileId": $0.profileId, "type": $0.type, "payload": $0.detail]
        }
    }
}

/// The long-lived objects of the app, created once at launch.
@MainActor
final class Services {
    static let shared = Services()

    let paths: AppPaths
    let defaults: UserDefaults
    let device: DeviceIdentity
    let profiles: ProfileStore
    let tokenStore: TokenStore
    let tokens: TokenManager
    let plainSession: URLSession
    let proxyEngine = ProxyEngine()
    let notifications: NotificationSink
    let spotlight: SpotlightSink
    let bridgeLog = BridgeLog()
    let settings: AppSettings
    private var sessions: [String: ProfileSession] = [:]

    var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    /// True while automation or tests moved the data directory.
    var isTestRun: Bool { paths.isOverridden }

    private init() {
        paths = AppPaths.shared
        paths.ensure(paths.root)
        defaults = paths.makeDefaults()
        settings = AppSettings(defaults: defaults)
        device = DeviceIdentity.load(from: paths.deviceFile, defaultName: Host.current().localizedName ?? "Mac")
        profiles = ProfileStore(file: paths.profilesFile)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 60
        configuration.httpMaximumConnectionsPerHost = 8
        plainSession = URLSession(configuration: configuration)

        if paths.isOverridden {
            tokenStore = FileTokenStore(file: paths.tokensFile)
            notifications = RecordingNotificationSink()
            spotlight = RecordingSpotlightSink()
        } else {
            tokenStore = KeychainTokenStore()
            notifications = SystemNotificationSink()
            spotlight = SystemSpotlightSink()
        }

        let profileStore = profiles
        let transport = URLSessionTransport(session: plainSession)
        tokens = TokenManager(store: tokenStore) { profileId, current in
            guard let profile = profileStore.profile(id: profileId) else { throw TokenError.signedOut }
            if NetworkOverride.shared.forcedUnreachable {
                throw OAuthError.unreachable(L("The server cannot be reached"))
            }
            let client = OAuthClient(serverURL: profile.server, transport: transport)
            return try await client.refresh(refreshToken: current.refreshToken, clientId: profile.clientId)
        }
    }

    func start() {
        let profileStore = profiles
        Task {
            await tokens.onNeedsSignIn { profileId in
                profileStore.update(id: profileId) { $0.needsSignIn = true }
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: .docmoreNeedsSignIn, object: nil, userInfo: ["profileId": profileId])
                }
            }
        }
        profiles.onChange = {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .docmoreProfilesChanged, object: nil)
            }
        }
        PathWatcher.shared.start()
        Task { await removePendingDataStores() }
    }

    func oauthClient(server: URL) -> OAuthClient {
        OAuthClient(serverURL: server, transport: URLSessionTransport(session: plainSession))
    }

    /// The live objects of one account, made on first use.
    func session(for profileId: String) -> ProfileSession? {
        if let existing = sessions[profileId] { return existing }
        guard let profile = profiles.profile(id: profileId) else { return nil }
        let session = ProfileSession(profile: profile, services: self)
        sessions[profileId] = session
        return session
    }

    var liveSessions: [ProfileSession] { Array(sessions.values) }

    func dropSession(_ profileId: String) {
        sessions.removeValue(forKey: profileId)
    }

    /// Links that leave the app go to the default browser. A test run only
    /// records them, so automation never opens the person's browser.
    private(set) var externalOpened: [String] = []

    func openExternal(_ url: URL) {
        if isTestRun {
            externalOpened.append(url.absoluteString)
            if externalOpened.count > 50 { externalOpened.removeFirst() }
            return
        }
        NSWorkspace.shared.open(url)
    }

    func updateBadge() {
        let total = sessions.values.reduce(0) { $0 + $1.badgeCount }
        NSApp.dockTile.badgeLabel = total > 0 ? "\(total)" : nil
    }

    /// Where WebKit keeps the data of an account's web data store.
    func webDataDirectory(profileId: String) -> URL {
        let uuid = ProfileID.dataStoreUUID(profileId: profileId, dataRoot: paths.isOverridden ? paths.root.path : nil)
        let bundleId = Bundle.main.bundleIdentifier ?? "com.dezik.docmore"
        return FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("WebKit/\(bundleId)/WebsiteDataStore/\(uuid.uuidString)", isDirectory: true)
    }

    /// Removes everything the Mac holds for an account: web data, web client,
    /// files, Spotlight entries and the sign-in. Its windows must be closed.
    func eraseLocalData(profileId: String) async {
        let uuid = ProfileID.dataStoreUUID(profileId: profileId, dataRoot: paths.isOverridden ? paths.root.path : nil)
        // 1. empty the web data through WebKit itself (IndexedDB, localStorage,
        //    caches): this works even while WebKit still holds the store
        let store = sessions[profileId]?.dataStore ?? WKWebsiteDataStore(forIdentifier: uuid)
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)

        // 2. let go of the account's live objects and files
        sessions[profileId]?.shutdown()
        sessions.removeValue(forKey: profileId)
        spotlight.clear(profileId: profileId)
        await tokens.delete(profileId: profileId)
        try? FileManager.default.removeItem(at: paths.profileDir(profileId))
        profiles.remove(id: profileId)
        updateBadge()

        // 3. remove the (now empty) store. WebKit refuses while its network
        //    process still has it open; then it is removed at the next launch.
        var removed = false
        for attempt in 0..<4 {
            if await removeDataStore(uuid) {
                removed = true
                break
            }
            try? await Task.sleep(nanoseconds: UInt64(150_000_000 * (attempt + 1)))
        }
        if !removed {
            var pending = pendingStoreRemovals
            pending[uuid.uuidString] = profileId
            pendingStoreRemovals = pending
        }
    }

    private func removeDataStore(_ uuid: UUID) async -> Bool {
        // WebKit must be up before this call: at launch, before any web view
        // exists, it crashes otherwise (its main run loop is not set up yet).
        _ = WKWebsiteDataStore.nonPersistent()
        return await withCheckedContinuation { continuation in
            WKWebsiteDataStore.remove(forIdentifier: uuid) { error in
                continuation.resume(returning: error == nil)
            }
        }
    }

    private var pendingStoreFile: URL { paths.root.appendingPathComponent("stores-to-remove.json") }

    /// Data store UUID -> profile id of stores that could not be removed yet.
    private var pendingStoreRemovals: [String: String] {
        get {
            guard let data = try? Data(contentsOf: pendingStoreFile) else { return [:] }
            return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
        }
        set {
            if newValue.isEmpty {
                try? FileManager.default.removeItem(at: pendingStoreFile)
            } else if let data = try? JSONEncoder().encode(newValue) {
                try? AtomicFile.write(data, to: pendingStoreFile)
            }
        }
    }

    /// At launch nothing holds the stores of signed-out accounts any more.
    func removePendingDataStores() async {
        var pending = pendingStoreRemovals
        guard !pending.isEmpty else { return }
        for (text, profileId) in pending {
            // the same person signed in again since: that store is in use
            if profiles.profile(id: profileId) != nil {
                pending.removeValue(forKey: text)
                continue
            }
            guard let uuid = UUID(uuidString: text) else {
                pending.removeValue(forKey: text)
                continue
            }
            if await removeDataStore(uuid) {
                pending.removeValue(forKey: text)
            }
        }
        pendingStoreRemovals = pending
    }

    /// An account came back before its old store was removed: keep the store.
    func keepDataStore(profileId: String) {
        var pending = pendingStoreRemovals
        let before = pending.count
        pending = pending.filter { $0.value != profileId }
        if pending.count != before { pendingStoreRemovals = pending }
    }

    /// Sign out: revoke on the server when it answers, then erase.
    func signOut(profileId: String) async {
        if let profile = profiles.profile(id: profileId),
           !NetworkOverride.shared.forcedUnreachable,
           let refresh = await tokens.refreshToken(profileId: profileId) {
            await oauthClient(server: profile.server).revoke(token: refresh)
        }
        await eraseLocalData(profileId: profileId)
    }
}

/// Settings the person changes in the Settings window.
final class AppSettings {
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
        defaults.register(defaults: [
            Key.meetingModel: MeetingModels.defaultModel,
            Key.meetingLanguage: "auto",
            Key.meetingDetection: true,
            Key.meetingMode: MeetingMode.virtual.rawValue,
            Key.lockEnabled: false,
            Key.quickCaptureEnabled: true,
            Key.quickCaptureHotKey: HotKeyCombo.defaultQuickCapture.storageValue,
        ])
    }

    enum Key {
        static let meetingModel = "meetings.model"
        static let meetingLanguage = "meetings.language"
        static let meetingDetection = "meetings.detect"
        static let meetingMode = "meetings.mode"
        static let meetingPanelFrame = "meetings.panelFrame"
        static let lockEnabled = "security.lock"
        static let quickCaptureEnabled = "capture.enabled"
        static let quickCaptureHotKey = "capture.hotkey"
        static let quickCaptureSpace = "capture.space"
        static let lastServer = "signin.lastServer"
    }

    var store: UserDefaults { defaults }

    var meetingModel: String {
        get { defaults.string(forKey: Key.meetingModel) ?? MeetingModels.defaultModel }
        set { defaults.set(newValue, forKey: Key.meetingModel) }
    }

    /// "auto" or a language code ("en", "es"...).
    var meetingLanguage: String {
        get { defaults.string(forKey: Key.meetingLanguage) ?? "auto" }
        set { defaults.set(newValue, forKey: Key.meetingLanguage) }
    }

    var meetingDetection: Bool {
        get { defaults.bool(forKey: Key.meetingDetection) }
        set { defaults.set(newValue, forKey: Key.meetingDetection) }
    }

    /// The kind of meeting the chooser preselects: the default of Settings,
    /// replaced by whatever the person picks when a recording starts. Until
    /// they pick one it is the virtual kind, which records both sources (an
    /// in-person meeting recorded that way loses nothing).
    var meetingMode: MeetingMode {
        get { defaults.string(forKey: Key.meetingMode).flatMap(MeetingMode.init(rawValue:)) ?? .virtual }
        set { defaults.set(newValue.rawValue, forKey: Key.meetingMode) }
    }

    /// Where the person left the recording panel ("x y width height").
    var meetingPanelFrame: String {
        get { defaults.string(forKey: Key.meetingPanelFrame) ?? "" }
        set { defaults.set(newValue, forKey: Key.meetingPanelFrame) }
    }

    var lockEnabled: Bool {
        get { defaults.bool(forKey: Key.lockEnabled) }
        set { defaults.set(newValue, forKey: Key.lockEnabled) }
    }

    var quickCaptureEnabled: Bool {
        get { defaults.bool(forKey: Key.quickCaptureEnabled) }
        set { defaults.set(newValue, forKey: Key.quickCaptureEnabled) }
    }

    var quickCaptureHotKey: HotKeyCombo {
        get { HotKeyCombo(storageValue: defaults.string(forKey: Key.quickCaptureHotKey) ?? "") ?? .defaultQuickCapture }
        set { defaults.set(newValue.storageValue, forKey: Key.quickCaptureHotKey) }
    }

    /// "<profile id>|<space id>|<space name>" of the space quick notes go to.
    var quickCaptureSpace: String {
        get { defaults.string(forKey: Key.quickCaptureSpace) ?? "" }
        set { defaults.set(newValue, forKey: Key.quickCaptureSpace) }
    }

    var lastServer: String {
        get { defaults.string(forKey: Key.lastServer) ?? "" }
        set { defaults.set(newValue, forKey: Key.lastServer) }
    }
}
