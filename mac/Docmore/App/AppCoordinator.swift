import AppKit
import SwiftUI

/// Windows, accounts and links: the part of the app that is not one window.
@MainActor
final class AppCoordinator: NSObject, NSWindowDelegate {
    static let shared = AppCoordinator()

    private(set) var browsers: [BrowserWindowController] = []
    private weak var lastKey: BrowserWindowController?
    private var pickerWindow: NSWindow?
    private var settingsWindow: NSWindow?
    private var saveTask: Task<Void, Never>?
    private var terminating = false
    let signIn = SignInFlow()
    private var services: Services { .shared }

    struct SavedWindow: Codable {
        var profileId: String
        var path: String
        var frame: [Double]
        var group: Int
        var selected: Bool
    }

    /// The window menu commands and links act on.
    var frontBrowser: BrowserWindowController? {
        if let key = NSApp.keyWindow?.windowController as? BrowserWindowController { return key }
        if let main = NSApp.mainWindow?.windowController as? BrowserWindowController { return main }
        return lastKey ?? browsers.last
    }

    var activeProfile: Profile? {
        frontBrowser?.session.profile ?? services.profiles.activeProfile
    }

    // MARK: Windows

    @discardableResult
    func openWindow(profileId: String, path: String? = nil, frame: NSRect? = nil, show: Bool = true) -> BrowserWindowController? {
        guard let session = services.session(for: profileId) else { return nil }
        var rect = frame
        if rect == nil, let front = frontBrowser?.window {
            rect = front.frame.offsetBy(dx: 28, dy: -28)
        }
        let controller = BrowserWindowController(session: session, path: path, frame: rect)
        browsers.append(controller)
        services.profiles.setActive(profileId)
        if show {
            // a new window, not a tab of the front one
            controller.window?.tabbingMode = .disallowed
            controller.showWindow(nil)
            controller.window?.tabbingMode = .preferred
            controller.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        controller.start()
        closePicker()
        scheduleStateSave()
        return controller
    }

    @discardableResult
    func openTab(in parent: BrowserWindowController, path: String) -> BrowserWindowController? {
        guard let parentWindow = parent.window else { return nil }
        let controller = BrowserWindowController(session: parent.session, path: path, frame: parentWindow.frame)
        browsers.append(controller)
        if let window = controller.window {
            parentWindow.addTabbedWindow(window, ordered: .above)
            window.makeKeyAndOrderFront(nil)
        }
        controller.start()
        scheduleStateSave()
        return controller
    }

    func newWindow() {
        guard let profile = activeProfile else {
            showPicker()
            return
        }
        openWindow(profileId: profile.id, path: "/home")
    }

    func newTab() {
        if let front = frontBrowser {
            openTab(in: front, path: "/home")
        } else {
            newWindow()
        }
    }

    func windowBecameKey(_ controller: BrowserWindowController) {
        lastKey = controller
        if services.profiles.activeProfileId != controller.session.profileId {
            services.profiles.setActive(controller.session.profileId)
        }
    }

    func windowClosed(_ controller: BrowserWindowController) {
        browsers.removeAll { $0 === controller }
        if !terminating { scheduleStateSave() }
    }

    func browsers(for profileId: String) -> [BrowserWindowController] {
        browsers.filter { $0.session.profileId == profileId }
    }

    /// At launch and when the Dock icon is clicked with nothing open.
    func openInitialWindows() {
        if restoreWindows() { return }
        if let profile = services.profiles.activeProfile {
            openWindow(profileId: profile.id, path: "/home")
        } else {
            showPicker()
        }
    }

    // MARK: Lock

    /// Hides or shows the content of every window. Native panels that show
    /// account data close when the app locks.
    func applyLock(_ locked: Bool) {
        for controller in browsers {
            controller.setLocked(locked)
        }
        if locked {
            settingsWindow?.close()
            QuickCapture.shared.closePanel()
        }
    }

    // MARK: State restoration

    func scheduleStateSave() {
        guard !terminating else { return }
        saveTask?.cancel()
        saveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled else { return }
            self?.saveStateNow()
        }
    }

    func saveStateNow() {
        var saved: [SavedWindow] = []
        var groups: [ObjectIdentifier: Int] = [:]
        var nextGroup = 0
        var seen = Set<ObjectIdentifier>()
        for controller in browsers {
            guard let window = controller.window, window.isVisible || window.tabbedWindows != nil else { continue }
            let members = window.tabbedWindows ?? [window]
            for member in members {
                guard seen.insert(ObjectIdentifier(member)).inserted,
                      let owner = member.windowController as? BrowserWindowController else { continue }
                let key = ObjectIdentifier(members[0])
                let group = groups[key] ?? {
                    nextGroup += 1
                    groups[key] = nextGroup
                    return nextGroup
                }()
                let frame = member.frame
                saved.append(SavedWindow(
                    profileId: owner.session.profileId,
                    path: owner.currentPath,
                    frame: [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height].map(Double.init),
                    group: group,
                    selected: member.tabGroup?.selectedWindow === member || members.count == 1
                ))
            }
        }
        if let data = try? JSONEncoder().encode(saved) {
            try? AtomicFile.write(data, to: services.paths.windowsFile)
        }
    }

    func prepareForTermination() {
        saveTask?.cancel()
        saveStateNow()
        terminating = true
    }

    private func restoreWindows() -> Bool {
        guard let data = try? Data(contentsOf: services.paths.windowsFile),
              let saved = try? JSONDecoder().decode([SavedWindow].self, from: data), !saved.isEmpty else { return false }
        var firstOfGroup: [Int: BrowserWindowController] = [:]
        var previousOfGroup: [Int: BrowserWindowController] = [:]
        var selected: [BrowserWindowController] = []
        var opened = 0
        for entry in saved {
            guard services.profiles.profile(id: entry.profileId) != nil, entry.frame.count == 4 else { continue }
            let frame = visibleFrame(NSRect(x: entry.frame[0], y: entry.frame[1], width: entry.frame[2], height: entry.frame[3]))
            if let previous = previousOfGroup[entry.group], let previousWindow = previous.window,
               let session = services.session(for: entry.profileId) {
                let controller = BrowserWindowController(session: session, path: entry.path, frame: frame)
                browsers.append(controller)
                if let window = controller.window {
                    previousWindow.addTabbedWindow(window, ordered: .above)
                }
                controller.start()
                previousOfGroup[entry.group] = controller
                if entry.selected { selected.append(controller) }
                opened += 1
            } else if let controller = openWindow(profileId: entry.profileId, path: entry.path, frame: frame) {
                firstOfGroup[entry.group] = controller
                previousOfGroup[entry.group] = controller
                if entry.selected { selected.append(controller) }
                opened += 1
            }
        }
        for controller in selected {
            controller.window?.tabGroup?.selectedWindow = controller.window
        }
        return opened > 0
    }

    /// Keeps a restored window on a screen that still exists.
    private func visibleFrame(_ frame: NSRect) -> NSRect {
        let screens = NSScreen.screens
        if screens.contains(where: { $0.visibleFrame.intersects(frame) }) { return frame }
        guard let main = NSScreen.main?.visibleFrame else { return frame }
        let size = NSSize(width: min(frame.width, main.width), height: min(frame.height, main.height))
        return NSRect(x: main.midX - size.width / 2, y: main.midY - size.height / 2, width: size.width, height: size.height)
    }

    // MARK: Accounts

    func showPicker() {
        if let window = pickerWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let model = WelcomeModel()
        let host = NSHostingController(rootView: WelcomeView(model: model))
        let window = NSWindow(contentViewController: host)
        window.title = L("Docmore Accounts")
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.isReleasedWhenClosed = false
        window.setContentSize(NSSize(width: 460, height: 560))
        window.tabbingMode = .disallowed
        window.center()
        window.delegate = self
        model.window = window
        pickerWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    var settingsWindowForAutomation: NSWindow? { settingsWindow }
    var pickerWindowForAutomation: NSWindow? { pickerWindow }
    var isPickerVisible: Bool { pickerWindow?.isVisible ?? false }
    var isSettingsVisible: Bool { settingsWindow?.isVisible ?? false }

    func closePicker() {
        pickerWindow?.close()
        pickerWindow = nil
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        if window === pickerWindow { pickerWindow = nil }
        if window === settingsWindow { settingsWindow = nil }
    }

    func showSettings(tab: SettingsTab? = nil) {
        if AppLock.shared.isLocked {
            AppLock.shared.authenticate()
            return
        }
        if let tab { SettingsModel.shared.tab = tab }
        if let window = settingsWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let host = NSHostingController(rootView: SettingsView(model: SettingsModel.shared))
        let window = NSWindow(contentViewController: host)
        window.title = L("Settings")
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.setContentSize(NSSize(width: 620, height: 480))
        window.center()
        window.delegate = self
        settingsWindow = window
        SettingsModel.shared.refresh()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// After a sign-in: make the account current and show it.
    func adopt(_ profile: Profile, path: String = "/home") {
        services.profiles.setActive(profile.id)
        if let existing = browsers(for: profile.id).first {
            existing.reload()
            existing.window?.makeKeyAndOrderFront(nil)
            closePicker()
        } else {
            openWindow(profileId: profile.id, path: path)
        }
    }

    /// Shows another account in place of the front window.
    func switchAccount(to profileId: String) {
        guard services.profiles.profile(id: profileId) != nil else { return }
        if let existing = browsers(for: profileId).first {
            services.profiles.setActive(profileId)
            existing.window?.makeKeyAndOrderFront(nil)
            return
        }
        let front = frontBrowser
        let frame = front?.window?.frame
        openWindow(profileId: profileId, path: "/home", frame: frame)
        front?.window?.close()
    }

    private var lastAuthRecovery: [String: Date] = [:]

    /// The page reported a 401 it could not recover from. One refresh is
    /// tried; when that is refused, or when a token renewed moments ago is
    /// refused again, the account is marked and the sign-in sheet comes up.
    /// The local data stays.
    func authRequired(profileId: String) async {
        guard let profile = services.profiles.profile(id: profileId) else { return }
        if profile.needsSignIn {
            let open = browsers(for: profileId)
            (open.first { $0.window?.isKeyWindow == true } ?? open.first)?.presentSignInSheetIfNeeded()
            return
        }
        let renewedRecently = lastAuthRecovery[profileId].map { Date().timeIntervalSince($0) < 60 } ?? false
        if !renewedRecently {
            do {
                try await services.tokens.forceRefresh(profileId: profileId)
                lastAuthRecovery[profileId] = Date()
                // fresh sign-in in place: let the page try again
                services.session(for: profileId)?.emit("command", ["id": "sync-now"])
                return
            } catch let error as TokenError where error == .needsSignIn {
                // the token manager already marked the account and told the windows
                return
            } catch {
                // server out of reach or another passing failure: nothing to decide now
                return
            }
        }
        services.profiles.update(id: profileId) { $0.needsSignIn = true }
        NotificationCenter.default.post(name: .docmoreNeedsSignIn, object: nil, userInfo: ["profileId": profileId])
    }

    func signInAgain(profileId: String, anchor: NSWindow?) async {
        guard let profile = services.profiles.profile(id: profileId) else { return }
        do {
            let signedIn = try await signIn.signIn(server: profile.server, anchor: anchor)
            if signedIn.id == profileId {
                browsers(for: profileId).forEach { $0.reload() }
            } else {
                // somebody else signed in on that server: that is another account
                adopt(signedIn)
            }
        } catch SignInError.cancelled {
            return
        } catch {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = L("Sign-in failed")
            alert.informativeText = error.localizedDescription
            alert.addButton(withTitle: L("OK"))
            if let anchor { alert.beginSheetModal(for: anchor, completionHandler: nil) } else { alert.runModal() }
        }
    }

    /// Sign out and erase: revoke, close the account's windows, wipe its data.
    func signOut(profileId: String) async {
        for controller in browsers(for: profileId) {
            controller.window?.close()
        }
        MeetingController.shared.accountRemoved(profileId)
        QuickCapture.shared.queue.removeAll(profileId: profileId)
        await services.signOut(profileId: profileId)
        saveStateNow()
        if browsers.isEmpty {
            showPicker()
        }
    }

    func confirmSignOut(profileId: String, anchor: NSWindow?) {
        guard let profile = services.profiles.profile(id: profileId) else { return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L("Sign out of %@?", profile.server.host ?? profile.serverURL)
        alert.informativeText = L("Pages, files and changes kept on this Mac for this account are erased. Changes that were not synced yet are lost.")
        alert.addButton(withTitle: L("Sign Out and Erase"))
        alert.addButton(withTitle: L("Cancel"))
        let handler: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .alertFirstButtonReturn else { return }
            Task { @MainActor in await self.signOut(profileId: profileId) }
        }
        if let anchor { alert.beginSheetModal(for: anchor, completionHandler: handler) } else { handler(alert.runModal()) }
    }

    // MARK: Links

    func handleDeepLink(_ url: URL) {
        guard let target = DeepLink.parse(url) else { return }
        switch target {
        case .oauthCallback:
            _ = signIn.handleCallback(url)
        case .path(let path):
            navigate(profileId: nil, path: path)
        }
    }

    /// Brings the app forward on a path, in the front window of the account
    /// (the active account when none is named).
    func navigate(profileId: String?, path: String) {
        NSApp.activate(ignoringOtherApps: true)
        let targetId = profileId ?? activeProfile?.id
        guard let targetId, services.profiles.profile(id: targetId) != nil else {
            showPicker()
            return
        }
        let candidates = browsers(for: targetId)
        if let front = frontBrowser, front.session.profileId == targetId {
            front.window?.makeKeyAndOrderFront(nil)
            front.navigate(to: path)
        } else if let existing = candidates.last {
            existing.window?.makeKeyAndOrderFront(nil)
            existing.navigate(to: path)
        } else {
            openWindow(profileId: targetId, path: path)
        }
    }

    func sendCommand(_ id: String) {
        frontBrowser?.sendCommand(id)
    }
}
