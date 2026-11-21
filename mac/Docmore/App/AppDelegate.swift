import AppKit
import CoreSpotlight

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var services: Services { .shared }
    private var coordinator: AppCoordinator { .shared }
    private var pendingLinks: [URL] = []
    private var launched = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSWindow.allowsAutomaticWindowTabbing = true
        services.start()
        NSApp.mainMenu = MainMenu.build()

        if let sink = services.notifications as? SystemNotificationSink {
            sink.onOpen = { profileId, path, action in
                if action == "record" {
                    AppCoordinator.shared.navigate(profileId: profileId, path: path ?? "/home")
                    MeetingController.shared.startFromMenu()
                } else if let path {
                    AppCoordinator.shared.navigate(profileId: profileId, path: path)
                } else {
                    NSApp.activate(ignoringOtherApps: true)
                }
            }
        }

        #if DEBUG
        AutomationServer.startIfConfigured()
        #endif

        coordinator.openInitialWindows()
        launched = true
        pendingLinks.forEach(coordinator.handleDeepLink)
        pendingLinks.removeAll()

        AppLock.shared.start()
        QuickCapture.shared.start()
        MeetingController.shared.resumePendingJobs()
        MeetingDetector.shared.setEnabled(services.settings.meetingDetection)
        Updater.shared.start()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { coordinator.openInitialWindows() }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if MeetingController.shared.isRecording {
            // keep what was recorded: stop cleanly, then quit
            Task { @MainActor in
                await MeetingController.shared.stop()
                NSApp.reply(toApplicationShouldTerminate: true)
            }
            return .terminateLater
        }
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        coordinator.prepareForTermination()
    }

    /// `docmore://page/<slug>`, `docmore://open?path=/...` and the OAuth callback.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme?.lowercased() == AppScheme.deepLink {
            if launched {
                coordinator.handleDeepLink(url)
            } else {
                pendingLinks.append(url)
            }
        }
    }

    /// A Spotlight result was opened.
    func application(_ application: NSApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([NSUserActivityRestoring]) -> Void) -> Bool {
        guard userActivity.activityType == CSSearchableItemActionType,
              let identifier = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return false }
        return openSpotlightResult(identifier)
    }

    @discardableResult
    func openSpotlightResult(_ identifier: String) -> Bool {
        guard let (profileId, itemId) = SpotlightMap.split(identifier),
              let session = services.session(for: profileId),
              let path = session.spotlightMap.path(for: itemId) else { return false }
        coordinator.navigate(profileId: profileId, path: path)
        return true
    }

    // MARK: Menu actions

    @objc func newWindow(_ sender: Any?) { coordinator.newWindow() }
    @objc func newTab(_ sender: Any?) { coordinator.newTab() }
    @objc func showSettings(_ sender: Any?) { coordinator.showSettings() }
    @objc func addAccount(_ sender: Any?) { coordinator.showPicker() }
    @objc func quickCapture(_ sender: Any?) { QuickCapture.shared.showPanel() }
    @objc func lockNow(_ sender: Any?) { AppLock.shared.lock(force: true) }
    @objc func checkForUpdates(_ sender: Any?) { Updater.shared.checkForUpdates() }
    @objc func toggleRecording(_ sender: Any?) { MeetingController.shared.toggleFromMenu() }

    @objc func switchAccount(_ sender: NSMenuItem) {
        guard let profileId = sender.representedObject as? String else { return }
        coordinator.switchAccount(to: profileId)
    }

    @objc func signOutCurrent(_ sender: Any?) {
        guard let front = coordinator.frontBrowser else { return }
        coordinator.confirmSignOut(profileId: front.session.profileId, anchor: front.window)
    }

    @objc func openServerInBrowser(_ sender: Any?) {
        guard let profile = coordinator.activeProfile else { return }
        NSWorkspace.shared.open(profile.server)
    }

    @objc func showDataFolder(_ sender: Any?) {
        NSWorkspace.shared.activateFileViewerSelecting([services.paths.root])
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(newTab(_:)), #selector(newWindow(_:)), #selector(openServerInBrowser(_:)):
            return coordinator.activeProfile != nil
        case #selector(signOutCurrent(_:)):
            return coordinator.frontBrowser != nil
        case #selector(toggleRecording(_:)), #selector(quickCapture(_:)):
            return coordinator.activeProfile != nil
        case #selector(lockNow(_:)):
            return services.settings.lockEnabled
        case #selector(checkForUpdates(_:)):
            return Updater.shared.isConfigured
        default:
            return true
        }
    }
}
