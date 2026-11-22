import AppKit
import ServiceManagement
import SwiftUI

enum SettingsTab: String, CaseIterable, Identifiable {
    case general, accounts, offline, meetings, security
    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: return L("General")
        case .accounts: return L("Accounts")
        case .offline: return L("Offline")
        case .meetings: return L("Meetings")
        case .security: return L("Security")
        }
    }

    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .accounts: return "person.2"
        case .offline: return "icloud.and.arrow.down"
        case .meetings: return "waveform"
        case .security: return "lock"
        }
    }
}

struct OfflineUsage: Equatable {
    var bundleBytes: Int64 = 0
    var fileBytes: Int64 = 0
    var fileCount = 0
    var pageDataBytes: Int64 = 0
    var total: Int64 { bundleBytes + fileBytes + pageDataBytes }
}

@MainActor
final class SettingsModel: ObservableObject {
    static let shared = SettingsModel()

    @Published var tab: SettingsTab = .general
    @Published var profiles: [Profile] = []
    @Published var selectedProfileId: String = ""
    @Published var usage = OfflineUsage()
    @Published var measuring = false
    @Published var launchAtLogin = false
    @Published var launchAtLoginError: String?
    @Published var meetingModel: String
    @Published var meetingLanguage: String
    @Published var meetingDetection: Bool
    @Published var lockEnabled: Bool
    @Published var quickCaptureEnabled: Bool
    @Published var hotKey: HotKeyCombo
    @Published var recordingHotKey = false
    /// The kind of meeting the chooser preselects.
    @Published var meetingMode: MeetingMode
    /// Model id -> download progress, while a download runs.
    @Published var modelDownloads: [String: Double] = [:]
    @Published var modelError: String?
    /// Download progress of the model that tells voices apart.
    @Published var speakerModelDownload: Double?
    @Published var speakerModelError: String?
    /// Bumped to redraw the model list after a download or a delete.
    @Published var modelRevision = 0

    private var services: Services { .shared }
    private var tokens: [NSObjectProtocol] = []

    private init() {
        let settings = Services.shared.settings
        meetingModel = settings.meetingModel
        meetingLanguage = settings.meetingLanguage
        meetingDetection = settings.meetingDetection
        meetingMode = settings.meetingMode
        lockEnabled = settings.lockEnabled
        quickCaptureEnabled = settings.quickCaptureEnabled
        hotKey = settings.quickCaptureHotKey
        tokens.append(NotificationCenter.default.addObserver(forName: .docmoreProfilesChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        })
    }

    func refresh() {
        profiles = services.profiles.profiles
        if !profiles.contains(where: { $0.id == selectedProfileId }) {
            selectedProfileId = AppCoordinator.shared.activeProfile?.id ?? profiles.first?.id ?? ""
        }
        launchAtLogin = SMAppService.mainApp.status == .enabled
        meetingMode = services.settings.meetingMode
        modelRevision += 1
        measure()
    }

    func measure() {
        let profileId = selectedProfileId
        guard !profileId.isEmpty else {
            usage = OfflineUsage()
            return
        }
        measuring = true
        let paths = services.paths
        let webData = services.webDataDirectory(profileId: profileId)
        let files = services.session(for: profileId)?.files.usage()
        Task.detached(priority: .utility) {
            let bundle = DiskUsage.size(of: paths.bundleDir(profileId))
            let pageData = DiskUsage.size(of: webData)
            await MainActor.run {
                guard self.selectedProfileId == profileId else { return }
                self.usage = OfflineUsage(
                    bundleBytes: bundle,
                    fileBytes: files?.bytes ?? 0,
                    fileCount: files?.count ?? 0,
                    pageDataBytes: pageData
                )
                self.measuring = false
            }
        }
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            launchAtLoginError = nil
        } catch {
            launchAtLoginError = error.localizedDescription
        }
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    /// Erases the files kept offline and tells the open pages of the account
    /// to drop their offline page data too.
    func clearOfflineData() {
        guard let session = services.session(for: selectedProfileId) else { return }
        session.files.clear()
        session.emit("command", ["id": "clear-offline-data"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.measure() }
    }

    #if DEBUG
    /// Lets a scripted run look at Settings with an engine double.
    var engineOverride: MeetingEngine? {
        didSet { modelRevision += 1 }
    }
    var meetingEngine: MeetingEngine { engineOverride ?? MeetingController.shared.engine }
    #else
    var meetingEngine: MeetingEngine { MeetingController.shared.engine }
    #endif

    func applyMeetingSettings() {
        let settings = services.settings
        settings.meetingModel = meetingModel
        settings.meetingLanguage = meetingLanguage
        settings.meetingDetection = meetingDetection
        settings.meetingMode = meetingMode
        MeetingDetector.shared.setEnabled(meetingDetection)
    }

    func downloadSpeakerModel() {
        guard speakerModelDownload == nil else { return }
        speakerModelDownload = 0
        speakerModelError = nil
        Task { @MainActor in
            do {
                try await meetingEngine.downloadSpeakerModel { fraction in
                    Task { @MainActor in
                        if self.speakerModelDownload != nil { self.speakerModelDownload = fraction }
                    }
                }
            } catch {
                speakerModelError = error.localizedDescription
            }
            speakerModelDownload = nil
            modelRevision += 1
        }
    }

    func deleteSpeakerModel() {
        do {
            try meetingEngine.deleteSpeakerModel()
        } catch {
            speakerModelError = error.localizedDescription
        }
        modelRevision += 1
    }

    func downloadModel(_ modelId: String) {
        guard modelDownloads[modelId] == nil else { return }
        modelDownloads[modelId] = 0
        modelError = nil
        Task { @MainActor in
            do {
                try await meetingEngine.download(modelId) { fraction in
                    Task { @MainActor in
                        if self.modelDownloads[modelId] != nil { self.modelDownloads[modelId] = fraction }
                    }
                }
            } catch {
                modelError = error.localizedDescription
            }
            modelDownloads[modelId] = nil
            modelRevision += 1
        }
    }

    func deleteModel(_ modelId: String) {
        do {
            try meetingEngine.delete(modelId)
        } catch {
            modelError = error.localizedDescription
        }
        modelRevision += 1
    }

    /// Turning the lock on is free; turning it off takes Touch ID or the
    /// password, like unlocking.
    func setLockEnabled(_ enabled: Bool) {
        if enabled {
            lockEnabled = true
            services.settings.lockEnabled = true
            return
        }
        Task { @MainActor in
            let confirmed = await AppLock.shared.confirmIdentity(reason: L("turn off the Docmore lock"))
            lockEnabled = !confirmed
            services.settings.lockEnabled = !confirmed
        }
    }

    func applyQuickCapture() {
        services.settings.quickCaptureEnabled = quickCaptureEnabled
        services.settings.quickCaptureHotKey = hotKey
        QuickCapture.shared.registerHotKey()
    }
}

struct SettingsView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach(SettingsTab.allCases) { tab in
                    SettingsTabButton(tab: tab, selected: model.tab == tab) { model.tab = tab }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 8)
            Divider()
            Group {
                switch model.tab {
                case .general: GeneralSettings(model: model)
                case .accounts: AccountSettings(model: model).padding(18)
                case .offline: OfflineSettings(model: model)
                case .meetings: MeetingSettings(model: model)
                case .security: SecuritySettings(model: model)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(width: 620, height: 480)
        .onAppear { model.refresh() }
    }
}

/// One entry of the Settings toolbar: icon over title, the whole tile clicks.
private struct SettingsTabButton: View {
    let tab: SettingsTab
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: tab.symbol)
                    .font(.system(size: 18, weight: .regular))
                    .frame(height: 22)
                Text(tab.title)
                    .font(.system(size: 11, weight: selected ? .semibold : .regular))
                    .lineLimit(1)
            }
            .foregroundStyle(selected ? Color.accentColor : Color.primary.opacity(0.8))
            .frame(width: 92, height: 52)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(selected ? 0.10 : (hovering ? 0.05 : 0)))
            )
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

private struct GeneralSettings: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        Form {
            Section {
                Toggle(L("Open Docmore at login"), isOn: Binding(
                    get: { model.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }
                ))
                if let error = model.launchAtLoginError {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
            Section(L("Quick note")) {
                Toggle(L("Open a quick note with a shortcut from anywhere"), isOn: $model.quickCaptureEnabled)
                    .onChange(of: model.quickCaptureEnabled) { _, _ in model.applyQuickCapture() }
                HStack {
                    Text(L("Shortcut"))
                    Spacer()
                    HotKeyRecorder(combo: $model.hotKey, recording: $model.recordingHotKey) { model.applyQuickCapture() }
                }
                .disabled(!model.quickCaptureEnabled)
            }
            Section(L("Data")) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("Data folder"))
                        Text(Services.shared.paths.root.path)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer()
                    Button(L("Show in Finder")) {
                        NSWorkspace.shared.activateFileViewerSelecting([Services.shared.paths.root])
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}

private struct AccountSettings: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.profiles.isEmpty {
                Spacer()
                Text(L("No accounts yet"))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(model.profiles) { profile in
                            HStack(spacing: 12) {
                                Image(systemName: profile.needsSignIn ? "person.crop.circle.badge.exclamationmark" : "person.crop.circle")
                                    .font(.system(size: 28, weight: .light))
                                    .foregroundStyle(profile.needsSignIn ? Color.orange : Color.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(profile.userName.isEmpty ? profile.userEmail : profile.userName)
                                        .font(.body.weight(.medium))
                                    Text("\(profile.userEmail)  \u{00B7}  \(profile.server.host ?? profile.serverURL)")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                    if profile.needsSignIn {
                                        Text(L("Sign in again to sync"))
                                            .font(.footnote)
                                            .foregroundStyle(.orange)
                                    }
                                }
                                Spacer()
                                Button(profile.needsSignIn ? L("Sign In") : L("Open")) {
                                    if profile.needsSignIn {
                                        Task { await AppCoordinator.shared.signInAgain(profileId: profile.id, anchor: NSApp.keyWindow) }
                                    } else {
                                        AppCoordinator.shared.switchAccount(to: profile.id)
                                    }
                                }
                                Button(L("Sign Out...")) {
                                    AppCoordinator.shared.confirmSignOut(profileId: profile.id, anchor: NSApp.keyWindow)
                                }
                            }
                            .padding(10)
                            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.primary.opacity(0.05)))
                        }
                    }
                }
            }
            HStack {
                Spacer()
                Button(L("Add Account...")) { AppCoordinator.shared.showPicker() }
            }
        }
        .padding(.top, 6)
    }
}

private struct OfflineSettings: View {
    @ObservedObject var model: SettingsModel
    @State private var confirming = false

    private func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    var body: some View {
        Form {
            if model.profiles.count > 1 {
                Picker(L("Account"), selection: $model.selectedProfileId) {
                    ForEach(model.profiles) { profile in
                        Text(profile.displayName).tag(profile.id)
                    }
                }
                .onChange(of: model.selectedProfileId) { _, _ in model.measure() }
            }
            Section(L("Space used on this Mac")) {
                usageRow("app.badge", L("App (web client)"), size(model.usage.bundleBytes))
                usageRow("paperclip", L("Files and images"), size(model.usage.fileBytes) + "  \u{00B7}  " + L("%lld files", model.usage.fileCount))
                usageRow("doc.text", L("Pages and offline changes"), size(model.usage.pageDataBytes))
                HStack {
                    Text(L("Total")).fontWeight(.semibold)
                    Spacer()
                    if model.measuring { ProgressView().controlSize(.small) }
                    Text(size(model.usage.total)).fontWeight(.semibold).monospacedDigit()
                }
            }
            Section {
                HStack {
                    Text(L("Clearing removes the files and pages kept for offline use. Nothing is deleted on the server."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(L("Clear Offline Data..."), role: .destructive) { confirming = true }
                        .disabled(model.selectedProfileId.isEmpty)
                }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog(L("Clear the offline data of this account?"), isPresented: $confirming) {
            Button(L("Clear Offline Data"), role: .destructive) { model.clearOfflineData() }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("Changes that were not synced yet may be lost."))
        }
    }

    private func usageRow(_ symbol: String, _ title: String, _ value: String) -> some View {
        HStack {
            Label(title, systemImage: symbol)
            Spacer()
            Text(value).foregroundStyle(.secondary).monospacedDigit()
        }
    }
}

private struct MeetingSettings: View {
    @ObservedObject var model: SettingsModel

    private let languages: [(String, String)] = [
        ("auto", ""), ("en", "English"), ("es", "Espa\u{00F1}ol"), ("pt", "Portugu\u{00EA}s"), ("fr", "Fran\u{00E7}ais"),
        ("de", "Deutsch"), ("it", "Italiano"), ("nl", "Nederlands"), ("ja", "Japanese"), ("zh", "Chinese"),
    ]

    private func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    var body: some View {
        let engine = model.meetingEngine
        Form {
            if !engine.isAvailable {
                Section {
                    Label(engine.unavailableReason, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
            }
            Section(L("Kind of meeting")) {
                ForEach(MeetingMode.allCases, id: \.self) { mode in
                    MeetingKindRow(mode: mode, selected: model.meetingMode == mode) {
                        model.meetingMode = mode
                        model.applyMeetingSettings()
                    }
                }
                Text(L("The kind a new recording proposes. Picking the other one when a recording starts changes it."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section(L("Transcription model, kept on this Mac")) {
                ForEach(engine.models) { entry in
                    ModelRow(
                        entry: entry,
                        selected: model.meetingModel == entry.id,
                        downloaded: engine.isDownloaded(entry.id),
                        sizeText: engine.isDownloaded(entry.id) ? size(engine.sizeOnDisk(entry.id)) : size(entry.sizeBytes),
                        progress: model.modelDownloads[entry.id],
                        select: {
                            model.meetingModel = entry.id
                            model.applyMeetingSettings()
                        },
                        download: { model.downloadModel(entry.id) },
                        delete: { model.deleteModel(entry.id) }
                    )
                }
                .id(model.modelRevision)
                if let error = model.modelError {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                Picker(L("Language"), selection: $model.meetingLanguage) {
                    ForEach(languages, id: \.0) { code, name in
                        Text(code == "auto" ? L("Detect automatically") : name).tag(code)
                    }
                }
                .onChange(of: model.meetingLanguage) { _, _ in model.applyMeetingSettings() }
            }
            if let speakerModel = engine.speakerModel {
                Section(L("Speaker identification model, kept on this Mac")) {
                    SpeakerModelRow(
                        entry: speakerModel,
                        downloaded: engine.isSpeakerModelDownloaded,
                        sizeText: engine.isSpeakerModelDownloaded ? size(engine.speakerModelSizeOnDisk) : size(speakerModel.sizeBytes),
                        progress: model.speakerModelDownload,
                        download: { model.downloadSpeakerModel() },
                        delete: { model.deleteSpeakerModel() }
                    )
                    .id(model.modelRevision)
                    if let error = model.speakerModelError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                    Text(L("Tells the voices of a meeting apart, on this Mac. Without it the transcript has no speakers."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                Toggle(L("Offer to record when another app starts using the microphone"), isOn: $model.meetingDetection)
                    .onChange(of: model.meetingDetection) { _, _ in model.applyMeetingSettings() }
                Text(L("Audio never leaves this Mac. Only the transcript is sent to your server to write the notes."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

/// One model: the whole row selects it; the trailing button downloads or
/// deletes it.
private struct ModelRow: View {
    let entry: MeetingModelChoice
    let selected: Bool
    let downloaded: Bool
    let sizeText: String
    let progress: Double?
    let select: () -> Void
    let download: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: select) {
                HStack(spacing: 10) {
                    Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(entry.name)
                        Text(downloaded ? L("On this Mac, %@", sizeText) : L("Download of about %@", sizeText))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let progress {
                ProgressView(value: progress)
                    .frame(width: 90)
                Text("\(Int(progress * 100))%")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(width: 36, alignment: .trailing)
            } else if downloaded {
                Button(L("Delete"), action: delete)
            } else {
                Button(L("Download"), action: download)
            }
        }
    }
}

/// The model that tells voices apart: no choice to make, only whether it is
/// on this Mac.
private struct SpeakerModelRow: View {
    let entry: MeetingModelChoice
    let downloaded: Bool
    let sizeText: String
    let progress: Double?
    let download: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "person.wave.2")
                .foregroundStyle(downloaded ? Color.accentColor : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.name)
                Text(downloaded ? L("On this Mac, %@", sizeText) : L("Download of about %@", sizeText))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if let progress {
                ProgressView(value: progress)
                    .frame(width: 90)
                Text("\(Int(progress * 100))%")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(width: 36, alignment: .trailing)
            } else if downloaded {
                Button(L("Delete"), action: delete)
            } else {
                Button(L("Download"), action: download)
            }
        }
    }
}

/// One kind of meeting as the default: the whole row selects it.
private struct MeetingKindRow: View {
    let mode: MeetingMode
    let selected: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(mode.title)
                    Text(mode.explanation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Image(systemName: mode.symbol)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

private struct SecuritySettings: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        Form {
            Section {
                Toggle(L("Require Touch ID or password to open Docmore"), isOn: Binding(
                    get: { model.lockEnabled },
                    set: { model.setLockEnabled($0) }
                ))
                Text(L("Docmore locks when it starts and when the Mac wakes from sleep."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section {
                Text(L("Your sign-in is kept in the Keychain. Pages kept for offline use are stored on this Mac and are protected by FileVault when it is on."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}
