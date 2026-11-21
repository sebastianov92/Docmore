import AppKit
import AuthenticationServices

enum SignInError: LocalizedError {
    case notDocmore(String)
    case cancelled
    case couldNotStart
    case stateMismatch
    case refused(String)
    case profileUnavailable(String)

    var errorDescription: String? {
        switch self {
        case .notDocmore(let detail): return detail
        case .cancelled: return L("Sign-in was cancelled")
        case .couldNotStart: return L("The sign-in window could not be opened")
        case .stateMismatch: return L("The sign-in answer did not match the request. Try again.")
        case .refused(let detail): return detail
        case .profileUnavailable(let detail): return detail
        }
    }
}

/// Server check and OAuth 2.1 + PKCE sign-in in the system browser sheet.
@MainActor
final class SignInFlow: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var authSession: ASWebAuthenticationSession?
    private weak var anchor: NSWindow?
    private var callbackWaiter: ((URL) -> Void)?
    private var services: Services { .shared }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            anchor ?? NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
        }
    }

    /// Finds the server behind what was typed: the first candidate address
    /// that answers `/api/sync/info` as a Docmore server.
    func validate(_ input: String) async throws -> URL {
        let candidates = ServerAddress.candidates(input)
        guard !candidates.isEmpty else {
            throw SignInError.notDocmore(L("Type the address of your Docmore server, for example wiki.example.com"))
        }
        var lastError: Error = SignInError.notDocmore(L("No Docmore server answered at that address"))
        for candidate in candidates {
            do {
                let info = try await services.oauthClient(server: candidate).serverInfo()
                guard info.sync >= 1 else {
                    throw SignInError.notDocmore(L("That server is too old for this app. Update the server first."))
                }
                return candidate
            } catch let error as OAuthError {
                switch error {
                case .unreachable(let detail):
                    lastError = SignInError.notDocmore(L("Could not reach %@: %@", candidate.host ?? candidate.absoluteString, detail))
                case .http(let status, _):
                    lastError = SignInError.notDocmore(L("%@ answered %lld. Is it a Docmore server, and is it up to date?", candidate.host ?? candidate.absoluteString, status))
                default:
                    lastError = SignInError.notDocmore(L("%@ is not a Docmore server", candidate.host ?? candidate.absoluteString))
                }
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    /// The whole sign-in: register the app once per server, consent in the
    /// browser sheet, exchange the code, read who signed in.
    func signIn(server: URL, anchor: NSWindow?) async throws -> Profile {
        self.anchor = anchor
        let client = services.oauthClient(server: server)
        let serverKey = server.absoluteString

        let clientId: String
        if let known = services.profiles.clientId(forServer: serverKey) {
            clientId = known
        } else {
            clientId = try await client.register(deviceName: services.device.deviceName)
            services.profiles.setClientId(clientId, forServer: serverKey)
        }

        let pkce = PKCE.generate()
        let state = PKCE.randomURLSafe(byteCount: 16)
        let url = client.authorizeURL(clientId: clientId, challenge: pkce.challenge, state: state)
        let callback = try await runBrowserSession(url: url)

        let parsed = OAuthClient.parseCallback(callback)
        if let error = parsed.error, parsed.code == nil {
            throw SignInError.refused(error)
        }
        guard parsed.state == state, let code = parsed.code else {
            throw SignInError.stateMismatch
        }
        do {
            let tokens = try await client.exchange(code: code, clientId: clientId, verifier: pkce.verifier)
            return try await complete(server: server, clientId: clientId, tokens: tokens)
        } catch let error as OAuthError {
            if case .http(let status, _) = error, status == 401 {
                // the server no longer knows this registration: start clean next time
                services.profiles.setClientId("", forServer: serverKey)
            }
            throw error
        }
    }

    private func runBrowserSession(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            var finished = false
            let finish: (Result<URL, Error>) -> Void = { [weak self] result in
                guard !finished else { return }
                finished = true
                self?.callbackWaiter = nil
                self?.authSession = nil
                continuation.resume(with: result)
            }
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme(AppScheme.deepLink)) { callbackURL, error in
                DispatchQueue.main.async {
                    if let callbackURL {
                        finish(.success(callbackURL))
                    } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                        finish(.failure(SignInError.cancelled))
                    } else {
                        finish(.failure(error ?? SignInError.couldNotStart))
                    }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            authSession = session
            // the callback may also arrive as an ordinary docmore:// link
            callbackWaiter = { [weak session] callbackURL in
                session?.cancel()
                finish(.success(callbackURL))
            }
            if !session.start() {
                finish(.failure(SignInError.couldNotStart))
            }
        }
    }

    /// `docmore://oauth/callback?...` opened from outside the browser sheet.
    func handleCallback(_ url: URL) -> Bool {
        guard let waiter = callbackWaiter else { return false }
        waiter(url)
        return true
    }

    /// With tokens in hand: ask the server who this is, derive the account id
    /// and store everything. Also the entry point of the automation server.
    func complete(server: URL, clientId: String, tokens initial: TokenSet) async throws -> Profile {
        var tokens = initial
        let client = services.oauthClient(server: server)

        func whoAmI(_ accessToken: String) async throws -> (Int, [String: Any]) {
            var request = URLRequest(url: URL(string: server.absoluteString + "/api/users/me")!)
            request.httpMethod = "POST"
            request.timeoutInterval = 20
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            request.httpBody = Data("{}".utf8)
            let (data, response) = try await services.plainSession.data(for: request)
            let object = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, object)
        }

        var (status, body) = try await whoAmI(tokens.accessToken)
        if status == 401 {
            tokens = try await client.refresh(refreshToken: tokens.refreshToken, clientId: clientId)
            (status, body) = try await whoAmI(tokens.accessToken)
        }
        let payload = (body["data"] as? [String: Any]) ?? body
        guard status == 200, let user = payload["user"] as? [String: Any], let userId = user["id"] as? String else {
            throw SignInError.profileUnavailable(L("The server did not say who signed in (status %lld)", status))
        }
        let workspace = payload["workspace"] as? [String: Any]
        let serverKey = server.absoluteString
        let profile = Profile(
            id: ProfileID.make(serverURL: serverKey, userId: userId),
            serverURL: serverKey,
            clientId: clientId,
            userId: userId,
            userName: user["name"] as? String ?? "",
            userEmail: user["email"] as? String ?? "",
            workspaceName: workspace?["name"] as? String ?? "",
            needsSignIn: false,
            defaultSpaceId: workspace?["defaultSpaceId"] as? String
        )
        try await services.tokens.save(tokens, profileId: profile.id)
        services.profiles.upsert(profile)
        services.keepDataStore(profileId: profile.id)
        if services.profiles.clientId(forServer: serverKey)?.isEmpty != false {
            services.profiles.setClientId(clientId, forServer: serverKey)
        }
        return profile
    }
}
