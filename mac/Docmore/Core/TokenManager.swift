import Foundation

public enum TokenError: Error, Equatable {
    /// There is nothing stored for this account.
    case signedOut
    /// The refresh token was refused: the account needs a new sign-in.
    case needsSignIn
}

/// Hands out access tokens and renews them. However many requests discover an
/// expired token at once, only one refresh reaches the server per account
/// (the refresh token rotates, a second concurrent refresh would be refused).
public actor TokenManager {
    public typealias Refresher = @Sendable (_ profileId: String, _ current: TokenSet) async throws -> TokenSet

    private let store: TokenStore
    private let refresher: Refresher
    private let now: @Sendable () -> Date
    private var inflight: [String: Task<TokenSet, Error>] = [:]
    private var needsSignInHandler: (@Sendable (String) -> Void)?
    /// How long before expiry a token is renewed ahead of use.
    private let leeway: TimeInterval

    public init(
        store: TokenStore,
        leeway: TimeInterval = 60,
        now: @escaping @Sendable () -> Date = { Date() },
        refresher: @escaping Refresher
    ) {
        self.store = store
        self.leeway = leeway
        self.now = now
        self.refresher = refresher
    }

    public func onNeedsSignIn(_ handler: @escaping @Sendable (String) -> Void) {
        needsSignInHandler = handler
    }

    /// A token to put on a request. Renews it first when it is about to expire.
    public func accessToken(profileId: String) async throws -> String {
        guard let tokens = store.load(profileId: profileId) else { throw TokenError.signedOut }
        if tokens.expiresAt.timeIntervalSince(now()) > leeway {
            return tokens.accessToken
        }
        return try await refresh(profileId: profileId).accessToken
    }

    /// The token as stored, without renewing it. For offline answers.
    public func storedAccessToken(profileId: String) -> String? {
        store.load(profileId: profileId)?.accessToken
    }

    /// Called after the server answered 401 to `failedToken`. If somebody else
    /// already renewed it, the newer token comes back without a second refresh.
    public func accessTokenAfterUnauthorized(profileId: String, failedToken: String) async throws -> String {
        if inflight[profileId] == nil,
           let tokens = store.load(profileId: profileId),
           tokens.accessToken != failedToken {
            return tokens.accessToken
        }
        return try await refresh(profileId: profileId).accessToken
    }

    /// Renews the token now, whatever its expiry says. Shares the refresh
    /// already under way, if any.
    @discardableResult
    public func forceRefresh(profileId: String) async throws -> String {
        try await refresh(profileId: profileId).accessToken
    }

    public func save(_ tokens: TokenSet, profileId: String) throws {
        try store.save(tokens, profileId: profileId)
    }

    public func delete(profileId: String) {
        inflight[profileId]?.cancel()
        inflight[profileId] = nil
        store.delete(profileId: profileId)
    }

    public func refreshToken(profileId: String) -> String? {
        store.load(profileId: profileId)?.refreshToken
    }

    private func refresh(profileId: String) async throws -> TokenSet {
        if let running = inflight[profileId] {
            return try await running.value
        }
        guard let current = store.load(profileId: profileId) else { throw TokenError.signedOut }
        let refresher = self.refresher
        let store = self.store
        let refused = needsSignInHandler
        let task = Task<TokenSet, Error> {
            do {
                let renewed = try await refresher(profileId, current)
                try store.save(renewed, profileId: profileId)
                return renewed
            } catch let error as OAuthError {
                if case .invalidGrant = error {
                    refused?(profileId)
                    throw TokenError.needsSignIn
                }
                throw error
            }
        }
        inflight[profileId] = task
        defer { inflight[profileId] = nil }
        return try await task.value
    }
}
