import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// One window (or tab) showing the web client of one account.
@MainActor
final class BrowserWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate, NSToolbarItemValidation, NSMenuItemValidation {
    let session: ProfileSession
    let webView: WKWebView
    private let overlayModel = OverlayModel()
    private var overlayView: NSView?
    private var lockView: NSView?
    private(set) var isLocked = false
    private var lastTitle = "Docmore"
    private var observations: [NSKeyValueObservation] = []
    private var notificationTokens: [NSObjectProtocol] = []
    private var statusItem: NSToolbarItem?
    var pageLoaded = false
    private var initialPath: String
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]
    private(set) var signInSheetShown = false
    private var signInAlert: NSAlert?

    private static let backItem = NSToolbarItem.Identifier("docmore.back")
    private static let forwardItem = NSToolbarItem.Identifier("docmore.forward")
    private static let statusItemId = NSToolbarItem.Identifier("docmore.status")

    init(session: ProfileSession, path: String?, frame: NSRect?) {
        self.session = session
        self.webView = session.makeWebView()
        self.initialPath = path ?? "/home"
        let rect = frame ?? NSRect(x: 0, y: 0, width: 1240, height: 820)
        let window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init(window: window)
        window.title = "Docmore"
        window.minSize = NSSize(width: 520, height: 400)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.tabbingMode = .preferred
        window.tabbingIdentifier = "docmore-browser"
        window.toolbarStyle = .unified
        window.titleVisibility = .visible
        if frame == nil { window.center() }

        let toolbar = NSToolbar(identifier: "docmore.browser")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar

        let container = NSView(frame: rect)
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        let overlay = NSHostingView(rootView: OverlayView(model: overlayModel))
        overlay.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: container.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        overlay.isHidden = true
        overlayView = overlay
        let lock = NSHostingView(rootView: LockView())
        lock.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(lock)
        NSLayoutConstraint.activate([
            lock.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            lock.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            lock.topAnchor.constraint(equalTo: container.topAnchor),
            lock.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        lock.isHidden = true
        lockView = lock
        window.contentView = container

        webView.navigationDelegate = self
        webView.uiDelegate = self

        observations.append(webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            Task { @MainActor in self?.titleChanged(view.title) }
        })
        observations.append(webView.observe(\.url, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in
                self?.window?.toolbar?.validateVisibleItems()
                AppCoordinator.shared.scheduleStateSave()
            }
        })
        observations.append(webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.window?.toolbar?.validateVisibleItems() }
        })
        observations.append(webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.window?.toolbar?.validateVisibleItems() }
        })

        let center = NotificationCenter.default
        notificationTokens.append(center.addObserver(forName: .docmoreSyncStateChanged, object: session, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refreshStatusItem() }
        })
        notificationTokens.append(center.addObserver(forName: .docmoreBundleProgress, object: session, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.bundleProgressChanged() }
        })
        notificationTokens.append(center.addObserver(forName: .docmoreNeedsSignIn, object: nil, queue: .main) { [weak self] note in
            let profileId = note.userInfo?["profileId"] as? String
            Task { @MainActor in
                guard let self, profileId == self.session.profileId else { return }
                self.presentSignInSheetIfNeeded()
            }
        })

        notificationTokens.append(center.addObserver(forName: .docmoreProfilesChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.dismissSignInSheetIfSignedIn()
                self?.refreshStatusItem()
            }
        })

        overlayModel.onRetry = { [weak self] in self?.start() }
        overlayModel.onSwitch = { AppCoordinator.shared.showPicker() }
        if AppLock.shared.isLocked { setLocked(true) }
    }

    /// Covers the page (and its title) while the app is locked. The page
    /// keeps running, so syncing goes on.
    func setLocked(_ locked: Bool) {
        isLocked = locked
        lockView?.isHidden = !locked
        webView.isHidden = locked
        window?.title = locked ? "Docmore" : lastTitle
        window?.tab.title = locked ? "Docmore" : lastTitle
        window?.toolbar?.validateVisibleItems()
        if !locked { window?.makeFirstResponder(webView) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    deinit {
        notificationTokens.forEach(NotificationCenter.default.removeObserver)
    }

    // MARK: Loading

    /// Makes sure the web client is on disk, then opens the page.
    func start() {
        Task { @MainActor in
            if session.bundle.current == nil {
                showOverlay(.preparing(fraction: nil, detail: L("Downloading the app from your server")))
            }
            do {
                try await session.prepareBundle()
                hideOverlay()
                webView.load(URLRequest(url: session.appURL(path: initialPath)))
            } catch {
                showOverlay(.failed(
                    title: L("Docmore could not download the app from your server"),
                    detail: error.localizedDescription
                ))
            }
        }
    }

    private func bundleProgressChanged() {
        guard session.bundle.current == nil, let progress = session.bundleProgress else { return }
        showOverlay(.preparing(
            fraction: progress.fraction,
            detail: L("Downloading the app from your server") + " (\(progress.completedFiles)/\(progress.totalFiles))"
        ))
    }

    private func showOverlay(_ state: OverlayModel.State) {
        overlayModel.state = state
        overlayView?.isHidden = false
    }

    private func hideOverlay() {
        overlayModel.state = .hidden
        overlayView?.isHidden = true
    }

    /// Returns when the page currently loading has finished (or failed).
    func waitForLoad(timeout: TimeInterval = 120) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if pageLoaded, !webView.isLoading { return }
            if case .failed = overlayModel.state { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    var loadFailure: String? {
        if case .failed(let title, let detail) = overlayModel.state { return "\(title): \(detail)" }
        return nil
    }

    /// Path, query and fragment of the page shown now.
    var currentPath: String {
        guard let url = webView.url, url.scheme == AppScheme.name,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return initialPath }
        var path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        if let query = components.percentEncodedQuery, !query.isEmpty { path += "?" + query }
        if let fragment = components.percentEncodedFragment, !fragment.isEmpty { path += "#" + fragment }
        return path
    }

    /// Goes to a path: through the page's own router when it is up, by
    /// loading the address otherwise.
    func navigate(to path: String) {
        guard let safe = DeepLink.sanitize(path: path) else { return }
        if pageLoaded, webView.url?.scheme == AppScheme.name {
            session.emit("navigate", ["path": safe], to: webView)
        } else {
            initialPath = safe
            if session.bundle.current != nil {
                webView.load(URLRequest(url: session.appURL(path: safe)))
            }
        }
    }

    func sendCommand(_ id: String) {
        session.emit("command", ["id": id], to: webView)
    }

    func reload() {
        pageLoaded = false
        if webView.url == nil {
            start()
        } else {
            webView.reload()
        }
    }

    private func titleChanged(_ title: String?) {
        let text = (title?.isEmpty == false) ? title! : "Docmore"
        lastTitle = text
        guard !isLocked else { return }
        window?.title = text
        window?.tab.title = text
    }

    // MARK: Sign-in again

    func presentSignInSheetIfNeeded() {
        guard session.profile.needsSignIn, !signInSheetShown, let window, window.isVisible else { return }
        // one sheet per account is enough, on the window in front
        if AppCoordinator.shared.browsers(for: session.profileId).contains(where: { $0.signInSheetShown }) { return }
        signInSheetShown = true
        let profile = session.profile
        let alert = NSAlert()
        alert.messageText = L("Sign in again")
        alert.informativeText = L("Your sign-in to %@ is no longer valid. Your pages and changes on this Mac are kept. Sign in again to continue syncing.", profile.server.host ?? profile.serverURL)
        alert.addButton(withTitle: L("Sign In"))
        alert.addButton(withTitle: L("Later"))
        alert.addButton(withTitle: L("Sign Out and Erase"))
        signInAlert = alert
        alert.beginSheetModal(for: window) { [weak self] response in
            Task { @MainActor in
                guard let self else { return }
                self.signInSheetShown = false
                self.signInAlert = nil
                switch response {
                case .alertFirstButtonReturn:
                    await AppCoordinator.shared.signInAgain(profileId: profile.id, anchor: self.window)
                case .alertThirdButtonReturn:
                    AppCoordinator.shared.confirmSignOut(profileId: profile.id, anchor: self.window)
                default:
                    break
                }
            }
        }
    }

    /// The account signed in again some other way: the sheet has no purpose.
    func dismissSignInSheetIfSignedIn() {
        guard signInSheetShown, !session.profile.needsSignIn, let window, let sheet = signInAlert?.window else { return }
        window.endSheet(sheet, returnCode: .abort)
    }

    // MARK: Window

    func windowDidBecomeKey(_ notification: Notification) {
        AppCoordinator.shared.windowBecameKey(self)
        presentSignInSheetIfNeeded()
    }

    func windowWillClose(_ notification: Notification) {
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
        AppCoordinator.shared.windowClosed(self)
    }

    func windowDidMove(_ notification: Notification) {
        AppCoordinator.shared.scheduleStateSave()
    }

    func windowDidResize(_ notification: Notification) {
        AppCoordinator.shared.scheduleStateSave()
    }

    /// The "+" of the tab bar and File > New Tab.
    override func newWindowForTab(_ sender: Any?) {
        AppCoordinator.shared.openTab(in: self, path: "/home")
    }

    // MARK: Toolbar

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.backItem, Self.forwardItem, .flexibleSpace, Self.statusItemId]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        item.target = self
        item.isBordered = true
        switch itemIdentifier {
        case Self.backItem:
            item.label = L("Back")
            item.toolTip = L("Back")
            item.image = NSImage(systemSymbolName: "chevron.left", accessibilityDescription: L("Back"))
            item.action = #selector(goBack(_:))
            item.isNavigational = true
        case Self.forwardItem:
            item.label = L("Forward")
            item.toolTip = L("Forward")
            item.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: L("Forward"))
            item.action = #selector(goForward(_:))
            item.isNavigational = true
        case Self.statusItemId:
            item.label = L("Sync")
            item.action = #selector(offlineStorage(_:))
            statusItem = item
            refreshStatusItem()
        default:
            return nil
        }
        return item
    }

    func validateToolbarItem(_ item: NSToolbarItem) -> Bool {
        if isLocked { return false }
        switch item.itemIdentifier {
        case Self.backItem: return webView.canGoBack
        case Self.forwardItem: return webView.canGoForward
        default: return true
        }
    }

    private func refreshStatusItem() {
        let status = SyncStatus.describe(session: session)
        statusItem?.image = NSImage(systemSymbolName: status.symbol, accessibilityDescription: status.text)
        statusItem?.toolTip = status.text
    }

    // MARK: Menu actions (reached through the responder chain)

    @objc func newPage(_ sender: Any?) { sendCommand("new-page") }
    @objc func searchPages(_ sender: Any?) { sendCommand("search") }
    @objc func toggleSidebar(_ sender: Any?) { sendCommand("toggle-sidebar") }
    @objc func toggleWorkOffline(_ sender: Any?) { sendCommand("work-offline") }
    @objc func syncNow(_ sender: Any?) { sendCommand("sync-now") }
    @objc func offlineStorage(_ sender: Any?) { sendCommand("offline-settings") }
    @objc func openWebSettings(_ sender: Any?) { sendCommand("settings") }
    @objc func goHome(_ sender: Any?) {
        if pageLoaded { sendCommand("home") } else { navigate(to: "/home") }
    }
    @objc func goBack(_ sender: Any?) { webView.goBack() }
    @objc func goForward(_ sender: Any?) { webView.goForward() }
    @objc func reloadPage(_ sender: Any?) { reload() }
    @objc func zoomIn(_ sender: Any?) { webView.pageZoom = min(3.0, webView.pageZoom + 0.1) }
    @objc func zoomOut(_ sender: Any?) { webView.pageZoom = max(0.5, webView.pageZoom - 0.1) }
    @objc func resetZoom(_ sender: Any?) { webView.pageZoom = 1.0 }

    @objc func printPage(_ sender: Any?) {
        guard let window else { return }
        let info = NSPrintInfo.shared.copy() as? NSPrintInfo ?? NSPrintInfo.shared
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        let operation = webView.printOperation(with: info)
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        operation.view?.frame = webView.bounds
        operation.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if isLocked {
            // nothing of the page is reachable from the menus while locked
            return false
        }
        switch menuItem.action {
        case #selector(goBack(_:)):
            return webView.canGoBack
        case #selector(goForward(_:)):
            return webView.canGoForward
        case #selector(toggleWorkOffline(_:)):
            let state = session.syncState
            menuItem.state = (state.reported && !state.online && session.reachability.reachable) ? .on : .off
            return pageLoaded
        case #selector(newPage(_:)), #selector(searchPages(_:)), #selector(toggleSidebar(_:)),
             #selector(syncNow(_:)), #selector(offlineStorage(_:)), #selector(openWebSettings(_:)):
            return pageLoaded
        default:
            return true
        }
    }
}

/// The line shown in the toolbar and at the top of the Account menu.
enum SyncStatus {
    @MainActor
    static func describe(session: ProfileSession) -> (symbol: String, text: String) {
        let state = session.syncState
        if session.profile.needsSignIn {
            return ("person.crop.circle.badge.exclamationmark", L("Sign in again to sync"))
        }
        if !session.reachability.reachable {
            return ("icloud.slash", L("Offline: the server cannot be reached"))
        }
        if state.reported, !state.online {
            return ("icloud.slash", L("Working offline"))
        }
        if state.conflicts > 0 {
            return ("exclamationmark.icloud", L("%lld changes need review", state.conflicts))
        }
        if state.syncing {
            return ("arrow.triangle.2.circlepath.icloud", L("Syncing"))
        }
        if state.pending > 0 {
            return ("icloud.and.arrow.up", L("%lld changes waiting to sync", state.pending))
        }
        return ("checkmark.icloud", L("Up to date"))
    }
}

// MARK: - Overlay shown while the web client downloads

@MainActor
final class OverlayModel: ObservableObject {
    enum State: Equatable {
        case hidden
        case preparing(fraction: Double?, detail: String)
        case failed(title: String, detail: String)
    }

    @Published var state: State = .hidden
    var onRetry: (() -> Void)?
    var onSwitch: (() -> Void)?
}

struct OverlayView: View {
    @ObservedObject var model: OverlayModel

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            switch model.state {
            case .hidden:
                EmptyView()
            case .preparing(let fraction, let detail):
                VStack(spacing: 14) {
                    Image(systemName: "arrow.down.circle")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(.secondary)
                    Text(detail)
                        .font(.headline)
                    if let fraction {
                        ProgressView(value: fraction)
                            .frame(width: 260)
                    } else {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(L("This happens once. After that Docmore opens without the server."))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding(32)
            case .failed(let title, let detail):
                VStack(spacing: 14) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(.secondary)
                    Text(title)
                        .font(.headline)
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 420)
                    HStack(spacing: 12) {
                        Button(L("Try Again")) { model.onRetry?() }
                            .keyboardShortcut(.defaultAction)
                        Button(L("Accounts")) { model.onSwitch?() }
                    }
                }
                .padding(32)
            }
        }
    }
}
