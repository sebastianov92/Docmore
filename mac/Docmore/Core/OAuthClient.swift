import Foundation

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }
}

public enum OAuthError: Error, Equatable, LocalizedError {
    /// The server refused the code or the refresh token: sign in again.
    case invalidGrant(String)
    case http(Int, String)
    case malformedResponse
    case unreachable(String)

    public var errorDescription: String? {
        switch self {
        case .invalidGrant(let detail): return detail.isEmpty ? L("The sign-in is no longer valid") : detail
        case .http(let status, let detail): return detail.isEmpty ? L("The server answered %lld", status) : detail
        case .malformedResponse: return L("The server sent an answer the app does not understand")
        case .unreachable(let detail): return detail
        }
    }
}

public struct ServerInfo: Equatable, Sendable {
    public let app: String
    public let version: String
    public let clientHash: String
    public let sync: Int
}

/// The OAuth 2.1 + PKCE calls of the sign-in, against one server.
public struct OAuthClient: Sendable {
    public let serverURL: URL
    private let transport: HTTPTransport
    private let now: @Sendable () -> Date

    public init(serverURL: URL, transport: HTTPTransport, now: @escaping @Sendable () -> Date = { Date() }) {
        self.serverURL = serverURL
        self.transport = transport
        self.now = now
    }

    private func endpoint(_ path: String) -> URL {
        URL(string: serverURL.absoluteString + path)!
    }

    private func post(_ path: String, _ body: [String: Any]) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 20
        do {
            return try await transport.send(request)
        } catch let error as OAuthError {
            throw error
        } catch {
            throw OAuthError.unreachable(error.localizedDescription)
        }
    }

    private static func object(_ data: Data) -> [String: Any] {
        ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
    }

    private static func failure(_ data: Data, _ response: HTTPURLResponse) -> OAuthError {
        let body = object(data)
        let code = body["error"] as? String ?? ""
        let detail = (body["error_description"] as? String) ?? (body["message"] as? String) ?? ""
        if code == "invalid_grant" { return .invalidGrant(detail) }
        return .http(response.statusCode, detail)
    }

    /// `GET /api/sync/info`: is this a Docmore server the app can talk to.
    public func serverInfo() async throws -> ServerInfo {
        var request = URLRequest(url: endpoint("/api/sync/info"))
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await transport.send(request)
        } catch {
            throw OAuthError.unreachable(error.localizedDescription)
        }
        guard response.statusCode == 200 else {
            throw OAuthError.http(response.statusCode, "")
        }
        let body = OAuthClient.object(data)
        let payload = (body["data"] as? [String: Any]) ?? body
        guard let app = payload["app"] as? String, app == "docmore",
              let clientHash = payload["clientHash"] as? String else {
            throw OAuthError.malformedResponse
        }
        return ServerInfo(
            app: app,
            version: payload["version"] as? String ?? "",
            clientHash: clientHash,
            sync: payload["sync"] as? Int ?? 0
        )
    }

    public static func registrationBody(deviceName: String) -> [String: Any] {
        [
            "client_name": "Docmore for Mac (\(deviceName))",
            "redirect_uris": [AppScheme.oauthRedirect],
            "token_endpoint_auth_method": "none",
            "scope": "app",
        ]
    }

    /// Dynamic client registration; answers the new `client_id`.
    public func register(deviceName: String) async throws -> String {
        let (data, response) = try await post("/api/oauth/register", OAuthClient.registrationBody(deviceName: deviceName))
        guard response.statusCode == 201 || response.statusCode == 200,
              let clientId = OAuthClient.object(data)["client_id"] as? String, !clientId.isEmpty else {
            throw OAuthClient.failure(data, response)
        }
        return clientId
    }

    /// The consent page opened in the system browser sheet.
    public func authorizeURL(clientId: String, challenge: String, state: String) -> URL {
        var components = URLComponents(url: endpoint("/oauth/consent"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: AppScheme.oauthRedirect),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "scope", value: "app"),
            URLQueryItem(name: "state", value: state),
        ]
        // URLComponents leaves ":" and "/" alone in a query; the server wants
        // the redirect encoded like a form value.
        let encoded = components.percentEncodedQuery?
            .replacingOccurrences(of: "docmore://oauth/callback", with: "docmore%3A%2F%2Foauth%2Fcallback")
        components.percentEncodedQuery = encoded
        return components.url!
    }

    public func exchange(code: String, clientId: String, verifier: String) async throws -> TokenSet {
        let (data, response) = try await post("/api/oauth/token", [
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": AppScheme.oauthRedirect,
            "client_id": clientId,
            "code_verifier": verifier,
        ])
        return try tokens(data, response)
    }

    /// The refresh token rotates: the answer carries the one to store.
    public func refresh(refreshToken: String, clientId: String) async throws -> TokenSet {
        let (data, response) = try await post("/api/oauth/token", [
            "grant_type": "refresh_token",
            "refresh_token": refreshToken,
            "client_id": clientId,
        ])
        return try tokens(data, response)
    }

    public func revoke(token: String) async {
        _ = try? await post("/api/oauth/revoke", ["token": token])
    }

    private func tokens(_ data: Data, _ response: HTTPURLResponse) throws -> TokenSet {
        guard response.statusCode == 200 else { throw OAuthClient.failure(data, response) }
        let body = OAuthClient.object(data)
        guard let access = body["access_token"] as? String, !access.isEmpty,
              let refresh = body["refresh_token"] as? String, !refresh.isEmpty else {
            throw OAuthError.malformedResponse
        }
        let lifetime = (body["expires_in"] as? Double) ?? Double(body["expires_in"] as? Int ?? 3600)
        return TokenSet(accessToken: access, refreshToken: refresh, expiresAt: now().addingTimeInterval(lifetime))
    }

    /// Reads `code` and `state` out of the `docmore://oauth/callback?...` URL.
    public static func parseCallback(_ url: URL) -> (code: String?, state: String?, error: String?) {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        return (value("code"), value("state"), value("error_description") ?? value("error"))
    }
}
