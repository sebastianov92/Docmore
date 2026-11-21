import AppKit
import Carbon.HIToolbox
import SwiftUI

/// A system-wide shortcut through the Carbon hot key API, which needs no
/// accessibility permission.
final class GlobalHotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let action: () -> Void

    init?(combo: HotKeyCombo, action: @escaping () -> Void) {
        self.action = action
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            let hotKey = Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { hotKey.action() }
            return noErr
        }, 1, &eventType, pointer, &handlerRef)
        guard installed == noErr else { return nil }
        // 'DMQN': Docmore quick note
        let identifier = EventHotKeyID(signature: OSType(0x444D_514E), id: 1)
        let registered = RegisterEventHotKey(combo.keyCode, combo.carbonModifiers, identifier, GetApplicationEventTarget(), 0, &hotKeyRef)
        guard registered == noErr else {
            if let handlerRef { RemoveEventHandler(handlerRef) }
            return nil
        }
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }
}

extension HotKeyCombo {
    /// The shortcut a key press describes, or nil when it has no Command,
    /// Option or Control.
    init?(event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        self.init(
            keyCode: UInt32(event.keyCode),
            command: flags.contains(.command),
            option: flags.contains(.option),
            control: flags.contains(.control),
            shift: flags.contains(.shift)
        )
        guard command || option || control, keyCode < 128 else { return nil }
    }
}

/// A button that shows the shortcut and, once clicked, takes the next key
/// press with a modifier as the new one. Escape leaves it as it was.
struct HotKeyRecorder: View {
    @Binding var combo: HotKeyCombo
    @Binding var recording: Bool
    let onChange: () -> Void
    @State private var monitor: Any?

    var body: some View {
        Button {
            recording.toggle()
        } label: {
            Text(recording ? L("Type the shortcut") : combo.displayString)
                .frame(minWidth: 120)
        }
        .onChange(of: recording) { _, active in
            if active { install() } else { remove() }
        }
        .onDisappear {
            remove()
            recording = false
        }
    }

    private func install() {
        remove()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == UInt16(kVK_Escape) {
                recording = false
                return nil
            }
            guard let typed = HotKeyCombo(event: event) else { return nil }
            combo = typed
            recording = false
            onChange()
            return nil
        }
    }

    private func remove() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}
