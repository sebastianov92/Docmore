import AppKit
import SwiftUI

struct SpaceChoice: Codable, Equatable, Identifiable {
    let id: String
    let name: String
}

/// Quick note: a shortcut from anywhere opens a small panel; what is typed
/// becomes a page in the chosen space. With the server out of reach the note
/// waits on disk and is sent when it answers again.
@MainActor
final class QuickCapture {
    static let shared = QuickCapture()

    let queue: CaptureQueue
    let model = QuickCaptureModel()
    private var panel: NSPanel?
    private var hotKey: GlobalHotKey?
    private(set) var hotKeyRegistered = false
    private var flushing = false
    private var services: Services { .shared }

    private init() {
        queue = CaptureQueue(directory: Services.shared.paths.captureQueueDir)
    }

    func start() {
        registerHotKey()
        flush()
    }

    /// Registers the shortcut of the settings (or drops it when turned off).
    func registerHotKey() {
        hotKey = nil
        hotKeyRegistered = false
        guard services.settings.quickCaptureEnabled else { return }
        // a test run does not grab a system-wide shortcut unless asked to
        if services.isTestRun, ProcessInfo.processInfo.environment["DOCMORE_AUTOMATION_HOTKEY"] != "1" { return }
        hotKey = GlobalHotKey(combo: services.settings.quickCaptureHotKey) { [weak self] in
            Task { @MainActor in self?.showPanel() }
        }
        hotKeyRegistered = hotKey != nil
    }

    var isPanelVisible: Bool { panel?.isVisible ?? false }

    func showPanel() {
        guard !services.profiles.profiles.isEmpty else {
            AppCoordinator.shared.showPicker()
            return
        }
        if AppLock.shared.isLocked {
            AppLock.shared.authenticate()
            return
        }
        model.prepare()
        if panel == nil {
            let created = CapturePanel(
                contentRect: NSRect(x: 0, y: 0, width: 480, height: 250),
                styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            created.title = L("Quick Note")
            created.titleVisibility = .hidden
            created.titlebarAppearsTransparent = true
            created.isFloatingPanel = true
            created.level = .floating
            created.hidesOnDeactivate = false
            created.isReleasedWhenClosed = false
            created.isMovableByWindowBackground = true
            created.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            created.tabbingMode = .disallowed
            created.contentViewController = NSHostingController(rootView: QuickCaptureView(model: model))
            created.setContentSize(NSSize(width: 480, height: 250))
            panel = created
        }
        if let panel, let screen = NSScreen.main {
            let frame = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: frame.midX - panel.frame.width / 2, y: frame.minY + frame.height * 0.62))
        }
        panel?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func closePanel() {
        panel?.orderOut(nil)
    }

    /// Queues the note and tries to send it at once. Returns nil when there
    /// is nothing to save or nowhere to put it.
    @discardableResult
    func submit(text: String, profileId: String, spaceId: String) -> CaptureNote? {
        guard let parts = CaptureNote.split(text), !spaceId.isEmpty,
              services.profiles.profile(id: profileId) != nil else { return nil }
        let note = CaptureNote(profileId: profileId, spaceId: spaceId, title: parts.title, content: parts.content)
        do {
            try queue.enqueue(note)
        } catch {
            return nil
        }
        flush()
        return note
    }

    /// Sends what waits on disk. Called after a note is added, at launch and
    /// whenever a server becomes reachable.
    func flush() {
        guard !flushing, !queue.pending().isEmpty else { return }
        flushing = true
        Task { @MainActor in
            defer { flushing = false }
            await queue.flush { [weak self] note in
                guard let self else { return .retryLater }
                return await self.send(note)
            }
        }
    }

    /// Waits for the flush under way (automation).
    func settle() async {
        for _ in 0..<200 where flushing {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    private func send(_ note: CaptureNote) async -> CaptureSendResult {
        guard let session = services.session(for: note.profileId) else {
            return .refused(L("The account of this note was signed out"))
        }
        if session.profile.needsSignIn { return .retryLater }
        do {
            // the note's id makes a repeated attempt harmless on the server
            let (data, response) = try await session.api.send(
                "POST",
                "/api/pages/create",
                body: try JSONSerialization.data(withJSONObject: note.requestBody),
                timeout: 30,
                headers: ["Idempotency-Key": "quicknote-\(note.id)"]
            )
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            switch response.statusCode {
            case 200..<300:
                let page = (object?["data"] as? [String: Any]) ?? object
                return .sent(pageId: page?["id"] as? String)
            case 401, 408, 429, 500...599:
                return .retryLater
            default:
                let reason = object?["message"] as? String ?? L("The server answered %lld", response.statusCode)
                services.notifications.post(
                    title: L("A quick note could not be saved"),
                    body: "\(note.title): \(reason)",
                    profileId: note.profileId,
                    path: nil,
                    kind: "capture-failed"
                )
                return .refused(reason)
            }
        } catch {
            // no answer, or the account has to sign in again: the note waits
            return .retryLater
        }
    }

    // MARK: Spaces to choose from

    private func spacesKey(_ profileId: String) -> String { "capture.spaces.\(profileId)" }

    func cachedSpaces(profileId: String) -> [SpaceChoice] {
        guard let data = services.defaults.data(forKey: spacesKey(profileId)),
              let spaces = try? JSONDecoder().decode([SpaceChoice].self, from: data) else { return [] }
        return spaces
    }

    /// The spaces of an account: asked from the server, remembered for the
    /// times it does not answer.
    func loadSpaces(profileId: String) async -> [SpaceChoice] {
        guard let session = services.session(for: profileId) else { return [] }
        if let result = try? await session.api.json("POST", "/api/spaces", ["page": 1, "limit": 100], timeout: 10),
           let items = (result as? [String: Any])?["items"] as? [[String: Any]] {
            let spaces = items.compactMap { item -> SpaceChoice? in
                guard let id = item["id"] as? String else { return nil }
                return SpaceChoice(id: id, name: item["name"] as? String ?? "")
            }
            if !spaces.isEmpty, let data = try? JSONEncoder().encode(spaces) {
                services.defaults.set(data, forKey: spacesKey(profileId))
                return spaces
            }
        }
        let cached = cachedSpaces(profileId: profileId)
        if !cached.isEmpty { return cached }
        if let fallback = session.profile.defaultSpaceId {
            return [SpaceChoice(id: fallback, name: L("Default space"))]
        }
        return []
    }
}

/// A panel that takes typing without making the app's windows jump forward.
final class CapturePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        orderOut(nil)
    }
}

@MainActor
final class QuickCaptureModel: ObservableObject {
    @Published var text = ""
    @Published var profiles: [Profile] = []
    @Published var profileId = ""
    @Published var spaces: [SpaceChoice] = []
    @Published var spaceId = ""
    @Published var message: String?

    private var services: Services { .shared }

    /// Called each time the panel opens.
    func prepare() {
        message = nil
        profiles = services.profiles.profiles
        let remembered = services.settings.quickCaptureSpace.split(separator: "|", maxSplits: 1).map(String.init)
        if !profiles.contains(where: { $0.id == profileId }) {
            if remembered.count == 2, profiles.contains(where: { $0.id == remembered[0] }) {
                profileId = remembered[0]
            } else {
                profileId = AppCoordinator.shared.activeProfile?.id ?? profiles.first?.id ?? ""
            }
        }
        spaces = QuickCapture.shared.cachedSpaces(profileId: profileId)
        chooseSpace(preferred: remembered.count == 2 && remembered[0] == profileId ? remembered[1] : spaceId)
        refreshSpaces()
    }

    func profileChanged() {
        spaces = QuickCapture.shared.cachedSpaces(profileId: profileId)
        chooseSpace(preferred: "")
        refreshSpaces()
    }

    private func refreshSpaces() {
        let asked = profileId
        Task { @MainActor in
            let loaded = await QuickCapture.shared.loadSpaces(profileId: asked)
            guard asked == profileId, !loaded.isEmpty else { return }
            spaces = loaded
            chooseSpace(preferred: spaceId)
        }
    }

    private func chooseSpace(preferred: String) {
        if spaces.contains(where: { $0.id == preferred }) {
            spaceId = preferred
        } else if let fallback = services.profiles.profile(id: profileId)?.defaultSpaceId,
                  spaces.isEmpty || spaces.contains(where: { $0.id == fallback }) {
            spaceId = fallback
        } else {
            spaceId = spaces.first?.id ?? ""
        }
    }

    var spaceName: String {
        spaces.first { $0.id == spaceId }?.name ?? L("Default space")
    }

    var canSave: Bool {
        CaptureNote.split(text) != nil && !spaceId.isEmpty && !profileId.isEmpty
    }

    func save() {
        guard canSave else { return }
        guard QuickCapture.shared.submit(text: text, profileId: profileId, spaceId: spaceId) != nil else {
            message = L("The note could not be saved on this Mac")
            return
        }
        services.settings.quickCaptureSpace = "\(profileId)|\(spaceId)"
        text = ""
        QuickCapture.shared.closePanel()
    }
}

struct QuickCaptureView: View {
    @ObservedObject var model: QuickCaptureModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "square.and.pencil")
                    .foregroundStyle(.secondary)
                Text(L("Quick Note"))
                    .font(.headline)
                Spacer()
                if model.profiles.count > 1 {
                    Menu {
                        ForEach(model.profiles) { profile in
                            Button(profile.displayName) {
                                model.profileId = profile.id
                                model.profileChanged()
                            }
                        }
                    } label: {
                        Label(model.profiles.first { $0.id == model.profileId }?.server.host ?? "", systemImage: "person.crop.circle")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }
                Menu {
                    ForEach(model.spaces) { space in
                        Button(space.name) { model.spaceId = space.id }
                    }
                } label: {
                    Label(model.spaceName, systemImage: "folder")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(model.spaces.count < 2)
            }
            TextEditor(text: $model.text)
                .font(.body)
                .focused($focused)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.06)))
                .overlay(alignment: .topLeading) {
                    if model.text.isEmpty {
                        Text(L("The first line is the title"))
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 13)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                }
            HStack {
                if let message = model.message {
                    Text(message).font(.footnote).foregroundStyle(.red)
                } else {
                    Text(L("Saved to your server, or kept here until it answers."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(L("Cancel")) { QuickCapture.shared.closePanel() }
                    .keyboardShortcut(.cancelAction)
                Button(L("Save")) { model.save() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!model.canSave)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 30)
        .padding(.bottom, 14)
        .frame(width: 480, height: 250)
        .onAppear { focused = true }
    }
}
