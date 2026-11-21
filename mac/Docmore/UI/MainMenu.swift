import AppKit

/// The menu bar, built in code so every title goes through the catalog.
@MainActor
enum MainMenu {
    static func build() -> NSMenu {
        let main = NSMenu()
        main.addItem(submenu(appMenu()))
        main.addItem(submenu(fileMenu()))
        main.addItem(submenu(editMenu()))
        main.addItem(submenu(viewMenu()))
        main.addItem(submenu(goMenu()))
        main.addItem(submenu(accountMenu()))
        let window = windowMenu()
        main.addItem(submenu(window))
        NSApp.windowsMenu = window
        let help = helpMenu()
        main.addItem(submenu(help))
        NSApp.helpMenu = help
        return main
    }

    private static func submenu(_ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }

    @discardableResult
    private static func add(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = target
        menu.addItem(item)
        return item
    }

    private static func appMenu() -> NSMenu {
        let menu = NSMenu(title: "Docmore")
        add(menu, L("About Docmore"), #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
        let updates = add(menu, L("Check for Updates..."), #selector(AppDelegate.checkForUpdates(_:)))
        updates.isHidden = !Updater.shared.isConfigured
        menu.addItem(.separator())
        add(menu, L("Settings..."), #selector(AppDelegate.showSettings(_:)), ",")
        menu.addItem(.separator())
        let services = NSMenu(title: L("Services"))
        let servicesItem = add(menu, L("Services"), nil)
        servicesItem.submenu = services
        NSApp.servicesMenu = services
        menu.addItem(.separator())
        add(menu, L("Hide Docmore"), #selector(NSApplication.hide(_:)), "h")
        add(menu, L("Hide Others"), #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        add(menu, L("Show All"), #selector(NSApplication.unhideAllApplications(_:)))
        menu.addItem(.separator())
        add(menu, L("Lock Docmore"), #selector(AppDelegate.lockNow(_:)), "l", [.command, .control])
        add(menu, L("Quit Docmore"), #selector(NSApplication.terminate(_:)), "q")
        return menu
    }

    private static func fileMenu() -> NSMenu {
        let menu = NSMenu(title: L("File"))
        add(menu, L("New Page"), #selector(BrowserWindowController.newPage(_:)), "n")
        add(menu, L("New Tab"), #selector(AppDelegate.newTab(_:)), "t")
        add(menu, L("New Window"), #selector(AppDelegate.newWindow(_:)), "n", [.command, .shift])
        add(menu, L("Quick Note..."), #selector(AppDelegate.quickCapture(_:)))
        menu.addItem(.separator())
        add(menu, L("Close"), #selector(NSWindow.performClose(_:)), "w")
        menu.addItem(.separator())
        add(menu, L("Print..."), #selector(BrowserWindowController.printPage(_:)), "p")
        return menu
    }

    private static func editMenu() -> NSMenu {
        let menu = NSMenu(title: L("Edit"))
        add(menu, L("Undo"), Selector(("undo:")), "z")
        add(menu, L("Redo"), Selector(("redo:")), "z", [.command, .shift])
        menu.addItem(.separator())
        add(menu, L("Cut"), #selector(NSText.cut(_:)), "x")
        add(menu, L("Copy"), #selector(NSText.copy(_:)), "c")
        add(menu, L("Paste"), #selector(NSText.paste(_:)), "v")
        add(menu, L("Paste and Match Style"), #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift])
        add(menu, L("Delete"), #selector(NSText.delete(_:)))
        add(menu, L("Select All"), #selector(NSText.selectAll(_:)), "a")
        return menu
    }

    private static func viewMenu() -> NSMenu {
        let menu = NSMenu(title: L("View"))
        add(menu, L("Toggle Sidebar"), #selector(BrowserWindowController.toggleSidebar(_:)), "s", [.command, .control])
        menu.addItem(.separator())
        add(menu, L("Reload"), #selector(BrowserWindowController.reloadPage(_:)), "r")
        menu.addItem(.separator())
        add(menu, L("Actual Size"), #selector(BrowserWindowController.resetZoom(_:)), "0")
        add(menu, L("Zoom In"), #selector(BrowserWindowController.zoomIn(_:)), "+")
        // Command-= without Shift zooms too, like in every browser
        let plain = add(menu, L("Zoom In"), #selector(BrowserWindowController.zoomIn(_:)), "=")
        plain.isHidden = true
        plain.allowsKeyEquivalentWhenHidden = true
        add(menu, L("Zoom Out"), #selector(BrowserWindowController.zoomOut(_:)), "-")
        menu.addItem(.separator())
        add(menu, L("Enter Full Screen"), #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        return menu
    }

    private static func goMenu() -> NSMenu {
        let menu = NSMenu(title: L("Go"))
        add(menu, L("Back"), #selector(BrowserWindowController.goBack(_:)), "[")
        add(menu, L("Forward"), #selector(BrowserWindowController.goForward(_:)), "]")
        add(menu, L("Home"), #selector(BrowserWindowController.goHome(_:)), "h", [.command, .shift])
        menu.addItem(.separator())
        add(menu, L("Search"), #selector(BrowserWindowController.searchPages(_:)), "f", [.command, .shift])
        return menu
    }

    private static func accountMenu() -> NSMenu {
        let menu = NSMenu(title: L("Account"))
        menu.delegate = AccountMenuDelegate.shared
        AccountMenuDelegate.shared.populate(menu)
        return menu
    }

    private static func windowMenu() -> NSMenu {
        let menu = NSMenu(title: L("Window"))
        add(menu, L("Minimize"), #selector(NSWindow.performMiniaturize(_:)), "m")
        add(menu, L("Zoom"), #selector(NSWindow.performZoom(_:)))
        menu.addItem(.separator())
        add(menu, L("Show Previous Tab"), #selector(NSWindow.selectPreviousTab(_:)), "\t", [.control, .shift])
        add(menu, L("Show Next Tab"), #selector(NSWindow.selectNextTab(_:)), "\t", [.control])
        add(menu, L("Move Tab to New Window"), #selector(NSWindow.moveTabToNewWindow(_:)))
        add(menu, L("Merge All Windows"), #selector(NSWindow.mergeAllWindows(_:)))
        menu.addItem(.separator())
        add(menu, L("Bring All to Front"), #selector(NSApplication.arrangeInFront(_:)))
        return menu
    }

    private static func helpMenu() -> NSMenu {
        let menu = NSMenu(title: L("Help"))
        add(menu, L("Open Server in Browser"), #selector(AppDelegate.openServerInBrowser(_:)))
        add(menu, L("Show Data Folder"), #selector(AppDelegate.showDataFolder(_:)))
        return menu
    }
}

/// The Account menu changes with the accounts and the sync state, so it is
/// rebuilt each time it opens.
@MainActor
final class AccountMenuDelegate: NSObject, NSMenuDelegate {
    static let shared = AccountMenuDelegate()

    func menuNeedsUpdate(_ menu: NSMenu) {
        populate(menu)
    }

    func populate(_ menu: NSMenu) {
        menu.removeAllItems()
        let coordinator = AppCoordinator.shared
        let services = Services.shared
        let front = coordinator.frontBrowser

        if let session = front?.session {
            let status = SyncStatus.describe(session: session)
            let line = NSMenuItem(title: status.text, action: nil, keyEquivalent: "")
            line.image = NSImage(systemSymbolName: status.symbol, accessibilityDescription: nil)
            line.isEnabled = false
            menu.addItem(line)
            let who = NSMenuItem(title: session.profile.displayName, action: nil, keyEquivalent: "")
            who.isEnabled = false
            menu.addItem(who)
            menu.addItem(.separator())
        }

        let offline = NSMenuItem(title: L("Work Offline"), action: #selector(BrowserWindowController.toggleWorkOffline(_:)), keyEquivalent: "")
        menu.addItem(offline)
        let sync = NSMenuItem(title: L("Sync Now"), action: #selector(BrowserWindowController.syncNow(_:)), keyEquivalent: "s")
        sync.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(sync)
        menu.addItem(NSMenuItem(title: L("Offline Storage..."), action: #selector(BrowserWindowController.offlineStorage(_:)), keyEquivalent: ""))
        menu.addItem(.separator())

        let record = NSMenuItem(
            title: MeetingController.shared.isRecording ? L("Stop Recording") : L("Record Meeting"),
            action: #selector(AppDelegate.toggleRecording(_:)),
            keyEquivalent: "r"
        )
        record.keyEquivalentModifierMask = [.command, .shift]
        menu.addItem(record)
        menu.addItem(.separator())

        let switchItem = NSMenuItem(title: L("Switch Account"), action: nil, keyEquivalent: "")
        let switchMenu = NSMenu(title: L("Switch Account"))
        let activeId = coordinator.activeProfile?.id
        for profile in services.profiles.profiles {
            let item = NSMenuItem(title: profile.displayName, action: #selector(AppDelegate.switchAccount(_:)), keyEquivalent: "")
            item.representedObject = profile.id
            item.state = profile.id == activeId ? .on : .off
            if profile.needsSignIn {
                item.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: L("Sign in again to sync"))
            }
            switchMenu.addItem(item)
        }
        if !services.profiles.profiles.isEmpty { switchMenu.addItem(.separator()) }
        switchMenu.addItem(NSMenuItem(title: L("Add Account..."), action: #selector(AppDelegate.addAccount(_:)), keyEquivalent: ""))
        switchItem.submenu = switchMenu
        menu.addItem(switchItem)

        let signOut = NSMenuItem(title: L("Sign Out..."), action: #selector(AppDelegate.signOutCurrent(_:)), keyEquivalent: "")
        menu.addItem(signOut)
    }
}
