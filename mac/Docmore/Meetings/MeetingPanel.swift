import AppKit
import SwiftUI

/// The floating window of a meeting. It takes typing (a name, an entry of
/// the list) without making the app's windows jump forward.
final class MeetingPanel: NSPanel, NSWindowDelegate {
    var onEscape: (() -> Void)?
    /// The smallest content the person can drag the panel down to. Kept
    /// here and enforced in `windowWillResize`: the hosting view rewrites
    /// the window's own minimum from its SwiftUI content.
    var minimumContentSize = NSSize.zero

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, backing backingStoreType: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: style, backing: backingStoreType, defer: flag)
        delegate = self
    }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }

    func windowWillResize(_ sender: NSWindow, to frameSize: NSSize) -> NSSize {
        let minimum = frameRect(forContentRect: NSRect(origin: .zero, size: minimumContentSize)).size
        return NSSize(width: max(frameSize.width, minimum.width), height: max(frameSize.height, minimum.height))
    }
}

/// One colour per voice, the same for the whole meeting: it follows the
/// speaker's number, which never changes.
enum MeetingPalette {
    static let colors: [Color] = [.blue, .orange, .green, .purple, .pink, .teal, .indigo, .brown]

    static func color(for speaker: MeetingSpeaker) -> Color {
        colors[(max(1, speaker.number) - 1) % colors.count]
    }

    /// A chip stays a chip: a very long name is cut in it (the full name is
    /// in the editor and in the notes).
    static func chipText(_ label: String, limit: Int = 26) -> String {
        label.count > limit ? String(label.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "\u{2026}" : label
    }
}

extension MeetingMode {
    var title: String {
        switch self {
        case .inPerson: return L("In person")
        case .virtual: return L("Virtual")
        }
    }

    var symbol: String {
        switch self {
        case .inPerson: return "person.3.fill"
        case .virtual: return "video.fill"
        }
    }

    var explanation: String {
        switch self {
        case .inPerson: return L("Everybody is in the room. Only the microphone is recorded.")
        case .virtual: return L("You and whoever sits with you through the microphone; the others through the sound of the call.")
        }
    }
}

extension MeetingSide {
    /// The microphone for the room, the Mac's sound for the far side.
    var symbol: String {
        switch self {
        case .room: return "mic.fill"
        case .remote: return "speaker.wave.2.fill"
        }
    }
}

extension MeetingItem.Kind {
    var title: String {
        switch self {
        case .agreement: return L("Agreement")
        case .task: return L("Task")
        }
    }

    var symbol: String {
        switch self {
        case .agreement: return "checkmark.seal.fill"
        case .task: return "checklist"
        }
    }

    var tint: Color {
        switch self {
        case .agreement: return .green
        case .task: return .accentColor
        }
    }
}

extension MeetingController {
    func beginRename(_ speakerId: String) {
        renamingSpeakerId = speakerId
        focusPanel()
    }

    func beginAdd() {
        guard canEditList else { return }
        editingItemId = nil
        addingItem = true
        listCollapsed = false
        focusPanel()
    }

    func beginEdit(_ itemId: String) {
        guard canEditList else { return }
        addingItem = false
        editingItemId = itemId
        focusPanel()
    }
}

/// What the panel shows: the chooser first, then the meeting.
struct MeetingPanelView: View {
    @ObservedObject var controller: MeetingController

    var body: some View {
        Group {
            if controller.phase == .choosing {
                MeetingChooserView(controller: controller)
            } else {
                MeetingLiveView(controller: controller)
            }
        }
        // the (empty, transparent) title bar above is already kept clear
        .padding(.horizontal, 14)
        .padding(.top, 4)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

// MARK: The chooser

/// "What kind of meeting is it?": two cards, the whole card clicks, the kind
/// used last is marked and Return starts it.
struct MeetingChooserView: View {
    @ObservedObject var controller: MeetingController

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L("What kind of meeting is it?"))
                    .font(.title2.weight(.semibold))
                Text(L("One click starts the recording."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            // side by side when there is room, one above the other when not
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    card(.inPerson)
                    card(.virtual)
                }
                .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 12) {
                    card(.inPerson)
                    card(.virtual)
                }
            }
            if let error = controller.chooserError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            HStack(alignment: .bottom, spacing: 12) {
                Text(L("Audio never leaves this Mac. Only the transcript is sent to your server to write the notes."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button(L("Cancel")) { controller.cancelChoice() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(controller.startingMode != nil)
            }
        }
    }

    private func card(_ mode: MeetingMode) -> some View {
        MeetingKindCard(
            mode: mode,
            preselected: controller.preselectedMode == mode,
            starting: controller.startingMode == mode,
            disabled: controller.startingMode != nil
        ) {
            controller.choose(mode)
        }
        .frame(minWidth: 196, idealWidth: 196, maxWidth: .infinity)
    }
}

private struct MeetingKindCard: View {
    let mode: MeetingMode
    let preselected: Bool
    let starting: Bool
    let disabled: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .center) {
                    Image(systemName: mode.symbol)
                        .font(.system(size: 24, weight: .regular))
                        .foregroundStyle(preselected ? Color.accentColor : Color.secondary)
                        .frame(height: 30)
                    Spacer(minLength: 4)
                    if starting {
                        ProgressView().controlSize(.small)
                    } else if preselected {
                        Image(systemName: "return")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.accentColor)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(Color.accentColor.opacity(0.16)))
                            .help(L("The kind used last time: Return starts it"))
                    }
                }
                Text(mode.title)
                    .font(.title3.weight(.semibold))
                Text(mode.explanation)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 2)
                VStack(alignment: .leading, spacing: 3) {
                    source(MeetingSide.room.symbol, L("Microphone"))
                    if mode == .virtual { source(MeetingSide.remote.symbol, L("Sound of the call")) }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.primary.opacity(hovering && !disabled ? 0.10 : 0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(preselected ? Color.accentColor : Color.primary.opacity(0.10), lineWidth: preselected ? 2 : 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .keyboardShortcut(preselected ? .defaultAction : nil)
        .disabled(disabled)
        .onHover { hovering = $0 }
        .accessibilityLabel("\(mode.title). \(mode.explanation)")
    }

    private func source(_ symbol: String, _ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.caption)
                .frame(width: 16)
            Text(text)
                .font(.caption)
        }
        .foregroundStyle(.secondary)
    }
}

// MARK: The meeting

struct MeetingLiveView: View {
    @ObservedObject var controller: MeetingController

    /// An entry of the list is being typed.
    private var editingList: Bool { controller.addingItem || controller.editingItemId != nil }

    var body: some View {
        GeometryReader { geometry in
            content(short: geometry.size.height < 520)
        }
    }

    private func content(short: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            MeetingHeader(controller: controller, meter: controller.meter)
            // in a short panel the form of an entry needs the room of the
            // transcript: its lines step aside until the form closes
            MeetingTranscriptSection(controller: controller, linesHidden: short && editingList && !controller.listCollapsed)
            MeetingListSection(controller: controller)
            if controller.transcriptCollapsed && controller.listCollapsed {
                Spacer(minLength: 0)
            }
            ForEach(controller.notices, id: \.self) { notice in
                Label(notice, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            bottomBar
        }
    }

    @ViewBuilder
    private var bottomBar: some View {
        if controller.confirmingDiscard {
            VStack(alignment: .leading, spacing: 6) {
                Text(L("Throw this recording away? Nothing of it is kept."))
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button(role: .destructive) {
                        Task { await controller.discardRecording() }
                    } label: {
                        Text(L("Discard"))
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity)
                            .contentShape(Rectangle())
                    }
                    Button {
                        controller.confirmingDiscard = false
                    } label: {
                        Text(L("Keep recording"))
                            .frame(maxWidth: .infinity)
                            .contentShape(Rectangle())
                    }
                }
                .controlSize(.large)
            }
        } else {
            HStack(spacing: 8) {
                Button {
                    Task { await controller.stop() }
                } label: {
                    Label(L("Stop"), systemImage: "stop.fill")
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                }
                Button {
                    controller.confirmingDiscard = true
                } label: {
                    Image(systemName: "trash")
                        .frame(width: 20)
                        .contentShape(Rectangle())
                }
                .help(L("Discard the recording"))
                .accessibilityLabel(L("Discard the recording"))
            }
            .controlSize(.large)
            .disabled(controller.phase != .recording)
        }
    }
}

private struct MeetingHeader: View {
    @ObservedObject var controller: MeetingController
    @ObservedObject var meter: MeetingMeter

    private var recording: Bool { controller.phase == .recording }

    private var clock: String {
        let total = Int(meter.elapsed)
        return String(format: "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle()
                    .fill(recording ? Color.red : Color.secondary)
                    .frame(width: 10, height: 10)
                Text(recording ? L("Recording") : controller.statusLine)
                    .font(.headline)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
                if recording { MeetingKindTag(mode: controller.mode) }
                Spacer(minLength: 4)
                Text(clock)
                    .font(.system(.title3, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
            if recording {
                if let remote = meter.levels.remote {
                    // one meter per track: the room and the far side
                    HStack(spacing: 12) {
                        sideMeter(.room, level: meter.levels.room)
                        sideMeter(.remote, level: remote)
                    }
                } else {
                    LevelMeter(level: meter.levels.room)
                        .frame(height: 8)
                }
            } else if let progress = controller.progress {
                ProgressView(value: progress)
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }

    private func sideMeter(_ side: MeetingSide, level: Float) -> some View {
        HStack(spacing: 5) {
            Image(systemName: side.symbol)
                .font(.caption2)
                .frame(width: 14)
            Text(side.label)
                .font(.caption2)
                .fixedSize()
            LevelMeter(level: level)
                .frame(height: 6)
        }
        .foregroundStyle(.secondary)
    }
}

/// "In person" / "Virtual", small.
struct MeetingKindTag: View {
    let mode: MeetingMode

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: mode.symbol)
                .font(.caption2)
            Text(mode.title)
                .font(.caption.weight(.medium))
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(Capsule().fill(Color.primary.opacity(0.08)))
        .fixedSize()
    }
}

/// The title row of a part of the panel: the whole row folds or unfolds it.
private struct MeetingSectionHeader<Trailing: View>: View {
    let title: String
    let count: Int
    @Binding var collapsed: Bool
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 6) {
            Button {
                collapsed.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(collapsed ? 0 : 90))
                        .frame(width: 10)
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    if count > 0 {
                        Text("\(count)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                }
                .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(collapsed ? L("Show") : L("Hide"))
            trailing
        }
    }
}

// MARK: Transcript

private struct MeetingTranscriptSection: View {
    @ObservedObject var controller: MeetingController
    /// Keeps the title and the voices, hides the lines for a moment.
    var linesHidden = false
    @State private var following = true
    @State private var lastAutoScroll = Date.distantPast

    /// Brings the last line into view. Twice: the heights of lines not
    /// drawn yet are estimates, and earlier lines change height when their
    /// speaker changes, so the first jump can land short.
    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        lastAutoScroll = Date()
        proxy.scrollTo("end", anchor: .bottom)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            lastAutoScroll = Date()
            proxy.scrollTo("end", anchor: .bottom)
        }
    }

    private var virtual: Bool { controller.mode == .virtual }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MeetingSectionHeader(title: L("Transcript"), count: 0, collapsed: $controller.transcriptCollapsed) {
                EmptyView()
            }
            if !controller.transcriptCollapsed {
                if !controller.live.speakers.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(controller.live.speakers) { speaker in
                                MeetingSpeakerChip(speaker: speaker, sideSymbol: virtual) {
                                    controller.beginRename(speaker.id)
                                }
                            }
                        }
                        .padding(.vertical, 1)
                    }
                }
                if let speaker = controller.live.speaker(controller.renamingSpeakerId) {
                    MeetingRenameEditor(speaker: speaker) { name in
                        controller.rename(speakerId: speaker.id, to: name)
                    } cancel: {
                        controller.renamingSpeakerId = nil
                    }
                    .id(speaker.id)
                }
                if !linesHidden {
                    // a line that tells the voices above from the lines that scroll under them
                    Rectangle()
                        .fill(Color.primary.opacity(0.08))
                        .frame(height: 1)
                    transcript
                }
            }
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if controller.turns.isEmpty {
                        Text(L("What is said appears here."))
                            .font(.callout)
                            .foregroundStyle(.tertiary)
                    }
                    ForEach(controller.turns) { turn in
                        MeetingTurnRow(turn: turn, virtual: virtual) { speakerId in
                            controller.beginRename(speakerId)
                        }
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("end")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 8)
            }
            // new text keeps the end in view, unless the person scrolled up
            // to read: only a move with nothing new said is theirs
            .onScrollGeometryChange(for: ScrollPosition.self) { geometry in
                ScrollPosition(offset: geometry.contentOffset.y, content: geometry.contentSize.height, container: geometry.containerSize.height)
            } action: { old, new in
                if abs(new.content - old.content) < 0.5, abs(new.container - old.container) < 0.5 {
                    // the view settling after our own scroll is not the person reading back
                    if Date().timeIntervalSince(lastAutoScroll) > 0.6 { following = new.atEnd }
                } else if following {
                    scrollToEnd(proxy)
                }
            }
            .onChange(of: controller.turns) { _, _ in
                if following { scrollToEnd(proxy) }
            }
            .onAppear {
                scrollToEnd(proxy)
            }
        }
        .frame(minHeight: 54, maxHeight: .infinity)
    }
}

/// Where the transcript is scrolled to.
private struct ScrollPosition: Equatable {
    var offset: CGFloat
    var content: CGFloat
    var container: CGFloat

    var atEnd: Bool { offset + container >= content - 40 }
}

/// A voice as a coloured chip. Clicking it lets the person type its name.
private struct MeetingSpeakerChip: View {
    let speaker: MeetingSpeaker
    /// Shows the side as a small symbol inside the chip.
    var sideSymbol = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        let color = MeetingPalette.color(for: speaker)
        Button(action: action) {
            HStack(spacing: 5) {
                Circle()
                    .fill(color)
                    .frame(width: 7, height: 7)
                Text(MeetingPalette.chipText(speaker.shortLabel))
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                if sideSymbol, let side = speaker.side {
                    Image(systemName: side.symbol)
                        .font(.system(size: 8))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .fixedSize()
            .background(color.opacity(hovering ? 0.30 : 0.18), in: Capsule(style: .circular))
            .overlay(Capsule(style: .circular).strokeBorder(color.opacity(0.40), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(L("Click to name this voice"))
        .accessibilityLabel(speaker.label)
    }
}

/// "Room" / "Remote" next to a chip of a virtual meeting.
private struct MeetingSideTag: View {
    let side: MeetingSide

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: side.symbol)
                .font(.system(size: 8))
            Text(side.label)
                .font(.caption2)
        }
        .foregroundStyle(.secondary)
        .fixedSize()
    }
}

private struct MeetingTurnRow: View {
    let turn: MeetingTurn
    let virtual: Bool
    let rename: (String) -> Void

    private var timecode: String {
        let total = Int(turn.start)
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if let speaker = turn.speaker {
                    MeetingSpeakerChip(speaker: speaker) { rename(speaker.id) }
                }
                if virtual, let side = turn.side {
                    MeetingSideTag(side: side)
                }
                Text(timecode)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            }
            Text(turn.text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Typing the name of a voice. An empty name brings the default label back.
private struct MeetingRenameEditor: View {
    let speaker: MeetingSpeaker
    let save: (String?) -> Void
    let cancel: () -> Void
    @State private var name: String
    @FocusState private var focused: Bool

    init(speaker: MeetingSpeaker, save: @escaping (String?) -> Void, cancel: @escaping () -> Void) {
        self.speaker = speaker
        self.save = save
        self.cancel = cancel
        _name = State(initialValue: speaker.name ?? "")
    }

    /// The default label, side included: what the voice is called without a name.
    private var defaultLabel: String {
        MeetingSpeaker(id: speaker.id, number: speaker.number, side: speaker.side).label
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(MeetingPalette.color(for: speaker))
                .frame(width: 9, height: 9)
            TextField(L("Name of %@", defaultLabel), text: $name)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { save(name) }
            Button(L("Save")) { save(name) }
            if speaker.name != nil {
                Button {
                    save(nil)
                } label: {
                    Image(systemName: "arrow.uturn.backward")
                }
                .help(L("Back to %@", defaultLabel))
                .accessibilityLabel(L("Back to %@", defaultLabel))
            }
            Button(action: cancel) {
                Image(systemName: "xmark")
            }
            .help(L("Close"))
            .accessibilityLabel(L("Close"))
        }
        .controlSize(.small)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.primary.opacity(0.06)))
        .onAppear { focused = true }
    }
}

// MARK: Agreements and tasks

private struct MeetingListSection: View {
    @ObservedObject var controller: MeetingController

    private var items: [MeetingItem] { controller.live.items }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MeetingSectionHeader(title: L("Agreements and tasks"), count: items.count, collapsed: $controller.listCollapsed) {
                Button {
                    controller.beginAdd()
                } label: {
                    Label(L("Add"), systemImage: "plus")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(Color.primary.opacity(0.08)))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!controller.canEditList)
                .opacity(controller.canEditList ? 1 : 0.4)
                .help(L("Add an agreement or a task by hand"))
            }
            if !controller.listCollapsed {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            if controller.addingItem {
                                editor(for: nil)
                                    .id("new")
                            }
                            // (when the list is made at the end, the status line below says so)
                            if items.isEmpty, !controller.addingItem, controller.listStatus != .atEnd {
                                Text(L("Agreements and tasks appear here while the meeting goes on."))
                                    .font(.callout)
                                    .foregroundStyle(.tertiary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            ForEach(items) { item in
                                if controller.editingItemId == item.id {
                                    editor(for: item)
                                        .id("edit-\(item.id)")
                                } else {
                                    MeetingItemRow(
                                        item: item,
                                        waiting: controller.live.pendingOps.contains { $0.provisionalId == item.id || $0.op.itemId == item.id },
                                        enabled: controller.canEditList
                                    ) {
                                        controller.beginEdit(item.id)
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.trailing, 8)
                    }
                    .onChange(of: controller.addingItem) { _, adding in
                        if adding { proxy.scrollTo("new", anchor: .top) }
                    }
                    .onChange(of: controller.editingItemId) { _, editing in
                        if let editing { proxy.scrollTo("edit-\(editing)", anchor: .center) }
                    }
                }
                // an empty list leaves its room to the transcript
                .frame(minHeight: 54, maxHeight: items.isEmpty && !controller.addingItem ? 54 : .infinity)
                MeetingListStatusLine(status: controller.listStatus)
            }
        }
    }

    private func editor(for item: MeetingItem?) -> some View {
        MeetingItemEditor(
            item: item,
            suggestions: controller.live.speakers.map(\.label),
            save: { kind, text, owner, due in
                if let item {
                    controller.editItem(.update(id: item.id, text: text, owner: owner, due: due))
                    controller.editingItemId = nil
                } else if controller.editItem(.add(kind: kind, text: text, owner: owner, due: due)) {
                    controller.addingItem = false
                }
            },
            toggleCancelled: {
                guard let item else { return }
                controller.editItem(item.isCancelled ? .restore(id: item.id) : .cancel(id: item.id))
                controller.editingItemId = nil
            },
            remove: {
                guard let item else { return }
                controller.editItem(.remove(id: item.id))
                controller.editingItemId = nil
            },
            close: {
                controller.editingItemId = nil
                controller.addingItem = false
            }
        )
    }
}

/// One entry of the list. The whole row opens its editor.
private struct MeetingItemRow: View {
    let item: MeetingItem
    /// An edit of it has not reached the server yet.
    let waiting: Bool
    let enabled: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        // not editable (no live meeting on the server): the row is plain
        // text, as readable as ever, and nothing pretends to be a button
        if enabled {
            Button(action: action) { row }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
        } else {
            row
        }
    }

    private var row: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: item.kind.symbol)
                .font(.callout)
                .foregroundStyle(item.isCancelled ? AnyShapeStyle(.tertiary) : AnyShapeStyle(item.kind.tint))
                .frame(width: 18, alignment: .center)
                .padding(.top, 1)
                .accessibilityLabel(item.kind.title)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.text)
                    .font(.callout)
                    .strikethrough(item.isCancelled)
                    .foregroundStyle(item.isCancelled ? .secondary : .primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if item.owner != nil || item.due != nil || item.isCancelled {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) { details }
                        VStack(alignment: .leading, spacing: 2) { details }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                if let before = item.previousText {
                    Text(L("before: %@", before))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 4)
            if waiting {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .help(L("Waiting for the server"))
                    .accessibilityLabel(L("Waiting for the server"))
            }
            if item.locked {
                Image(systemName: "lock.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                    .help(L("Edited by hand: the assistant leaves it as it is"))
                    .accessibilityLabel(L("Edited by hand: the assistant leaves it as it is"))
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.primary.opacity(hovering && enabled ? 0.09 : 0.05))
        )
        .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    @ViewBuilder
    private var details: some View {
        if let owner = item.owner {
            Label(owner, systemImage: "person")
                .lineLimit(1)
        }
        if let due = item.due {
            Label(due, systemImage: "calendar")
                .lineLimit(1)
        }
        if item.isCancelled {
            Label(L("Cancelled"), systemImage: "xmark.circle")
                .lineLimit(1)
        }
    }
}

/// The form of one entry: a new one, or one of the list.
private struct MeetingItemEditor: View {
    let item: MeetingItem?
    /// The voices of the meeting, offered as owners.
    let suggestions: [String]
    let save: (MeetingItem.Kind, String, String?, String?) -> Void
    let toggleCancelled: () -> Void
    let remove: () -> Void
    let close: () -> Void

    @State private var kind: MeetingItem.Kind
    @State private var text: String
    @State private var owner: String
    @State private var due: String
    @State private var confirmingRemove = false
    @FocusState private var focused: Bool

    init(
        item: MeetingItem?,
        suggestions: [String],
        save: @escaping (MeetingItem.Kind, String, String?, String?) -> Void,
        toggleCancelled: @escaping () -> Void,
        remove: @escaping () -> Void,
        close: @escaping () -> Void
    ) {
        self.item = item
        self.suggestions = suggestions
        self.save = save
        self.toggleCancelled = toggleCancelled
        self.remove = remove
        self.close = close
        _kind = State(initialValue: item?.kind ?? .task)
        _text = State(initialValue: item?.text ?? "")
        _owner = State(initialValue: item?.owner ?? "")
        _due = State(initialValue: item?.due ?? "")
    }

    private var canSave: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func commit() {
        guard canSave else { return }
        save(kind, text, owner, due)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if item == nil {
                HStack(spacing: 6) {
                    kindButton(.task)
                    kindButton(.agreement)
                }
            }
            TextField(kind == .task ? L("What has to be done") : L("What was agreed"), text: $text, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit(commit)
            HStack(spacing: 6) {
                TextField(L("Who"), text: $owner)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(commit)
                TextField(L("When"), text: $due)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(commit)
            }
            if !suggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 5) {
                        ForEach(suggestions, id: \.self) { name in
                            Button {
                                owner = name
                            } label: {
                                Text(MeetingPalette.chipText(name))
                                    .font(.caption)
                                    .lineLimit(1)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .fixedSize()
                                    .background(Color.primary.opacity(owner == name ? 0.16 : 0.07), in: Capsule())
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            HStack(spacing: 6) {
                if confirmingRemove {
                    Button(role: .destructive, action: remove) {
                        Text(L("Delete for good"))
                            .foregroundStyle(.red)
                    }
                    Button(L("Keep")) { confirmingRemove = false }
                } else {
                    Button(item == nil ? L("Add") : L("Save"), action: commit)
                        .disabled(!canSave)
                    if let item {
                        Button(item.isCancelled ? L("Restore") : L("Mark cancelled"), action: toggleCancelled)
                        Button {
                            confirmingRemove = true
                        } label: {
                            Image(systemName: "trash")
                        }
                        .help(L("Delete"))
                        .accessibilityLabel(L("Delete"))
                    }
                }
                Spacer(minLength: 0)
                Button(action: close) {
                    Image(systemName: "xmark")
                }
                .help(L("Close"))
                .accessibilityLabel(L("Close"))
            }
        }
        .controlSize(.small)
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.accentColor.opacity(0.45), lineWidth: 1))
        .onAppear { focused = true }
    }

    /// Task or agreement: two buttons of our own, the whole button clicks.
    private func kindButton(_ value: MeetingItem.Kind) -> some View {
        Button {
            kind = value
        } label: {
            Label(value.title, systemImage: value.symbol)
                .font(.caption.weight(.semibold))
                .padding(.vertical, 5)
                .frame(maxWidth: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(kind == value ? Color.accentColor.opacity(0.22) : Color.primary.opacity(0.06))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .strokeBorder(kind == value ? Color.accentColor.opacity(0.7) : Color.clear, lineWidth: 1)
                )
                .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(kind == value ? [.isSelected] : [])
    }
}

/// The quiet line under the list: building, updated a moment ago, or made
/// when the meeting ends.
private struct MeetingListStatusLine: View {
    let status: MeetingLiveSync.ListStatus

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 5) {
                switch status {
                case .building:
                    ProgressView()
                        .controlSize(.mini)
                case .updated:
                    Image(systemName: "checkmark.circle")
                case .atEnd:
                    Image(systemName: "clock")
                }
                Text(status.text(now: context.date))
                    .lineLimit(1)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

/// Input level as a bar, 0...1.
struct LevelMeter: View {
    let level: Float

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.10))
                Capsule()
                    .fill(level > 0.9 ? Color.red : Color.green)
                    .frame(width: max(4, geometry.size.width * CGFloat(min(1, max(0, level)))))
                    .animation(.linear(duration: 0.1), value: level)
            }
        }
    }
}
