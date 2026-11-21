import AppKit
import LocalAuthentication
import SwiftUI

/// Optional lock: Touch ID or the Mac password before the app shows anything,
/// at launch and after the Mac wakes. The pages keep running underneath (sync
/// goes on); they are only hidden.
@MainActor
final class AppLock {
    static let shared = AppLock()

    private(set) var isLocked = false
    private var authenticating = false
    private var observers: [NSObjectProtocol] = []
    private var services: Services { .shared }

    func start() {
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.lock(force: false) }
            })
        }
        observers.append(center.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in
            // hide the content before the display comes back
            Task { @MainActor in self?.lock(force: false, prompt: false) }
        })
        lock(force: false)
    }

    /// Hides every window behind the lock. `force` locks even when the
    /// setting is off (the Lock menu item).
    func lock(force: Bool, prompt: Bool = true) {
        guard services.settings.lockEnabled || force else { return }
        if !isLocked {
            isLocked = true
            AppCoordinator.shared.applyLock(true)
        }
        if prompt { authenticate() }
    }

    /// Asks macOS to check who is there. Touch ID when the Mac has it, the
    /// account password otherwise.
    func authenticate() {
        guard isLocked, !authenticating else { return }
        // a test run has nobody to answer the system prompt
        if services.isTestRun { return }
        let context = LAContext()
        context.localizedCancelTitle = L("Cancel")
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // no password on this Mac: there is nothing to check against
            unlock()
            return
        }
        authenticating = true
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: L("unlock Docmore")) { [weak self] success, _ in
            Task { @MainActor in
                self?.authenticating = false
                if success { self?.unlock() }
            }
        }
    }

    func unlock() {
        guard isLocked else { return }
        isLocked = false
        AppCoordinator.shared.applyLock(false)
    }

    /// Turning the lock off takes the same proof as unlocking.
    func confirmIdentity(reason: String) async -> Bool {
        if services.isTestRun { return true }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return true }
        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
                continuation.resume(returning: success)
            }
        }
    }
}

/// What a locked window shows instead of its page.
struct LockView: View {
    var body: some View {
        ZStack {
            Rectangle().fill(.regularMaterial)
            VStack(spacing: 14) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 38, weight: .light))
                    .foregroundStyle(.secondary)
                Text(L("Docmore is locked"))
                    .font(.title3.weight(.semibold))
                Button(L("Unlock")) { AppLock.shared.authenticate() }
                    .keyboardShortcut(.defaultAction)
                    .controlSize(.large)
            }
        }
    }
}
