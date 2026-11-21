import AppKit
import Sparkle

/// Software update through Sparkle. It stays off until the build names an
/// appcast: the `SPARKLE_FEED_URL` build setting fills `SUFeedURL` in
/// Info.plist, and with that empty nothing starts and the menu item is hidden.
@MainActor
final class Updater {
    static let shared = Updater()

    private var controller: SPUStandardUpdaterController?

    private var feedURL: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              !value.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return value
    }

    var isConfigured: Bool { feedURL != nil }

    func start() {
        // never from a test run: it would talk to the network and show windows
        guard isConfigured, !Services.shared.isTestRun, controller == nil else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    }

    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }
}
