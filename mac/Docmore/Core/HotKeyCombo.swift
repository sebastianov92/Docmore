import Foundation

/// A global shortcut: a virtual key code plus modifiers, stored as
/// "cmd+opt+45" so it survives in the defaults and reads well in a diff.
public struct HotKeyCombo: Equatable, Sendable {
    public var keyCode: UInt32
    public var command: Bool
    public var option: Bool
    public var control: Bool
    public var shift: Bool

    public init(keyCode: UInt32, command: Bool = false, option: Bool = false, control: Bool = false, shift: Bool = false) {
        self.keyCode = keyCode
        self.command = command
        self.option = option
        self.control = control
        self.shift = shift
    }

    /// Option-Command-N (kVK_ANSI_N is 45).
    public static let defaultQuickCapture = HotKeyCombo(keyCode: 45, command: true, option: true)

    public var storageValue: String {
        var parts: [String] = []
        if control { parts.append("ctrl") }
        if option { parts.append("opt") }
        if shift { parts.append("shift") }
        if command { parts.append("cmd") }
        parts.append(String(keyCode))
        return parts.joined(separator: "+")
    }

    public init?(storageValue: String) {
        let parts = storageValue.lowercased().split(separator: "+").map(String.init)
        guard let last = parts.last, let code = UInt32(last), code < 128 else { return nil }
        self.init(keyCode: code)
        for part in parts.dropLast() {
            switch part {
            case "cmd": command = true
            case "opt": option = true
            case "ctrl": control = true
            case "shift": shift = true
            default: return nil
            }
        }
        // a global shortcut without Command, Option or Control would swallow typing
        guard command || option || control else { return nil }
    }

    /// Carbon modifier mask (cmdKey 0x100, shiftKey 0x200, optionKey 0x800, controlKey 0x1000).
    public var carbonModifiers: UInt32 {
        var mask: UInt32 = 0
        if command { mask |= 0x0100 }
        if shift { mask |= 0x0200 }
        if option { mask |= 0x0800 }
        if control { mask |= 0x1000 }
        return mask
    }

    private static let keyNames: [UInt32: String] = [
        0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V", 11: "B", 12: "Q",
        13: "W", 14: "E", 15: "R", 16: "Y", 17: "T", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5",
        25: "9", 26: "7", 28: "8", 29: "0", 31: "O", 32: "U", 34: "I", 35: "P", 37: "L", 38: "J", 40: "K",
        45: "N", 46: "M", 49: "Space", 36: "Return", 48: "Tab", 53: "Esc",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9",
        109: "F10", 103: "F11", 111: "F12",
    ]

    /// How the shortcut is shown: the usual modifier glyphs and the key.
    public var displayString: String {
        var text = ""
        if control { text += "\u{2303}" }
        if option { text += "\u{2325}" }
        if shift { text += "\u{21E7}" }
        if command { text += "\u{2318}" }
        return text + (HotKeyCombo.keyNames[keyCode] ?? "Key \(keyCode)")
    }
}

public enum MeetingModels {
    public struct Model: Equatable, Sendable {
        public let id: String
        public let name: String
        public let sizeHint: String
    }

    /// WhisperKit model folders, best first. Sizes are what gets downloaded.
    public static let all: [Model] = [
        Model(id: "openai_whisper-large-v3-v20240930_turbo_632MB", name: "Large v3 Turbo (compressed)", sizeHint: "630 MB"),
        Model(id: "openai_whisper-large-v3-v20240930_turbo", name: "Large v3 Turbo", sizeHint: "1.6 GB"),
        Model(id: "openai_whisper-small", name: "Small", sizeHint: "480 MB"),
        Model(id: "openai_whisper-base", name: "Base", sizeHint: "150 MB"),
        Model(id: "openai_whisper-tiny", name: "Tiny", sizeHint: "80 MB"),
    ]

    public static let defaultModel = "openai_whisper-large-v3-v20240930_turbo_632MB"

    public static func model(id: String) -> Model? {
        all.first { $0.id == id }
    }
}
