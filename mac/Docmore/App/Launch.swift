import AppKit

// AppKit life cycle: windows, tabs and menus are AppKit; the content of the
// native panels is SwiftUI.
@main
enum Launch {
    @MainActor private static var delegate: AppDelegate?

    @MainActor
    static func main() {
        let delegate = AppDelegate()
        Launch.delegate = delegate
        NSApplication.shared.delegate = delegate
        NSApplication.shared.run()
    }
}
