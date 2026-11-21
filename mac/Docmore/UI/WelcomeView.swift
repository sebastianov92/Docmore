import AppKit
import SwiftUI

/// First run and "Switch Account": pick an account or add a server.
@MainActor
final class WelcomeModel: ObservableObject {
    enum Status: Equatable {
        case idle
        case working(String)
        case failed(String)
    }

    @Published var address: String
    @Published var status: Status = .idle
    @Published var profiles: [Profile] = []
    weak var window: NSWindow?
    private var token: NSObjectProtocol?

    init() {
        address = Services.shared.settings.lastServer
        profiles = Services.shared.profiles.profiles
        token = NotificationCenter.default.addObserver(forName: .docmoreProfilesChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.profiles = Services.shared.profiles.profiles }
        }
    }

    deinit {
        if let token { NotificationCenter.default.removeObserver(token) }
    }

    var isWorking: Bool {
        if case .working = status { return true }
        return false
    }

    func open(_ profile: Profile) {
        if profile.needsSignIn {
            signIn(server: profile.server)
        } else {
            AppCoordinator.shared.adopt(profile)
        }
    }

    func submit() {
        let typed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty, !isWorking else { return }
        status = .working(L("Checking the server"))
        Task { @MainActor in
            do {
                let server = try await AppCoordinator.shared.signIn.validate(typed)
                Services.shared.settings.lastServer = server.absoluteString
                address = server.absoluteString
                signIn(server: server)
            } catch {
                status = .failed(error.localizedDescription)
            }
        }
    }

    private func signIn(server: URL) {
        status = .working(L("Finish signing in in the browser window"))
        Task { @MainActor in
            do {
                let profile = try await AppCoordinator.shared.signIn.signIn(server: server, anchor: window)
                status = .idle
                AppCoordinator.shared.adopt(profile)
            } catch SignInError.cancelled {
                status = .idle
            } catch {
                status = .failed(error.localizedDescription)
            }
        }
    }
}

struct WelcomeView: View {
    @ObservedObject var model: WelcomeModel

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 72, height: 72)
                Text("Docmore")
                    .font(.system(size: 26, weight: .semibold))
                Text(L("Your wiki, on this Mac. Works without a connection."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 28)
            .padding(.bottom, 20)

            if !model.profiles.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(L("Accounts"))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ScrollView {
                        VStack(spacing: 6) {
                            ForEach(model.profiles) { profile in
                                AccountRow(profile: profile) { model.open(profile) }
                            }
                        }
                    }
                    .frame(maxHeight: 190)
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 18)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(model.profiles.isEmpty ? L("Server address") : L("Add another server"))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    TextField("wiki.example.com", text: $model.address)
                        .textFieldStyle(.roundedBorder)
                        .disabled(model.isWorking)
                        .onSubmit { model.submit() }
                    Button(L("Continue")) { model.submit() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(model.isWorking || model.address.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                statusLine
            }
            .padding(.horizontal, 28)

            Spacer(minLength: 16)

            Text(L("Sign-in happens in a browser window of your own server. Docmore never sees your password."))
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 36)
                .padding(.bottom, 18)
        }
        .frame(width: 460, height: 560)
    }

    @ViewBuilder
    private var statusLine: some View {
        switch model.status {
        case .idle:
            Text(L("The address you open in the browser, for example https://wiki.example.com"))
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .working(let text):
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(text).font(.footnote).foregroundStyle(.secondary)
            }
        case .failed(let text):
            Label {
                Text(text).font(.footnote)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
            }
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A whole-row button for one account.
struct AccountRow: View {
    let profile: Profile
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: profile.needsSignIn ? "person.crop.circle.badge.exclamationmark" : "person.crop.circle")
                    .font(.system(size: 26, weight: .light))
                    .foregroundStyle(profile.needsSignIn ? Color.orange : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(profile.userName.isEmpty ? profile.userEmail : profile.userName)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    Text(profile.needsSignIn ? L("Sign in again to sync") : (profile.server.host ?? profile.serverURL))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color.primary.opacity(hovering ? 0.09 : 0.05))
            )
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
