import Foundation

/// Calls the app itself makes to a server (not the page): adds the sign-in,
/// renews it once after a 401 and honours the forced-offline switch.
struct ServerAPI: Sendable {
    let profileId: String
    let serverURL: URL
    let tokens: TokenManager
    let reachability: ServerReachability?
    let session: URLSession

    enum APIError: Error, LocalizedError {
        case status(Int, String)
        case notSignedIn

        var errorDescription: String? {
            switch self {
            case .status(let code, let message): return message.isEmpty ? L("The server answered %lld", code) : message
            case .notSignedIn: return L("This account needs to sign in again")
            }
        }
    }

    private func build(_ method: String, _ path: String, body: Data?, contentType: String?, token: String, timeout: TimeInterval, headers: [String: String] = [:]) -> URLRequest {
        var request = URLRequest(url: URL(string: serverURL.absoluteString + path)!)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue(contentType ?? "application/json", forHTTPHeaderField: "Content-Type")
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }

    /// Sends the request and answers whatever the server said (any status).
    func send(_ method: String, _ path: String, body: Data? = nil, contentType: String? = nil, timeout: TimeInterval = 30, headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        if NetworkOverride.shared.forcedUnreachable { throw NetworkOverride.unreachableError }
        let token: String
        do {
            token = try await tokens.accessToken(profileId: profileId)
        } catch is TokenError {
            throw APIError.notSignedIn
        }
        do {
            var data: Data
            var response: URLResponse
            do {
                (data, response) = try await session.data(for: build(method, path, body: body, contentType: contentType, token: token, timeout: timeout, headers: headers))
            } catch let error as URLError where error.code == .networkConnectionLost {
                // a kept-alive connection the server had closed: once more on a fresh one
                (data, response) = try await session.data(for: build(method, path, body: body, contentType: contentType, token: token, timeout: timeout, headers: headers))
            }
            guard var http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            reachability?.reportAnswered()
            if http.statusCode == 401 {
                let renewed: String
                do {
                    renewed = try await tokens.accessTokenAfterUnauthorized(profileId: profileId, failedToken: token)
                } catch is TokenError {
                    throw APIError.notSignedIn
                }
                (data, response) = try await session.data(for: build(method, path, body: body, contentType: contentType, token: renewed, timeout: timeout, headers: headers))
                guard let second = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                http = second
            }
            return (data, http)
        } catch let error as URLError {
            reachability?.reportFailure()
            throw error
        }
    }

    enum DownloadOutcome {
        case ok(Data, contentType: String?)
        case tooLarge
        case status(Int)
    }

    /// Fetches a file, giving up as soon as it is known to be larger than
    /// `maxBytes` (0 = no limit): by its announced length when the server
    /// sends one, by counting otherwise.
    func download(_ path: String, maxBytes: Int, timeout: TimeInterval = 300) async throws -> DownloadOutcome {
        if maxBytes <= 0 {
            let (data, response) = try await send("GET", path, timeout: timeout)
            guard response.statusCode == 200 else { return .status(response.statusCode) }
            return .ok(data, contentType: response.value(forHTTPHeaderField: "Content-Type"))
        }
        if NetworkOverride.shared.forcedUnreachable { throw NetworkOverride.unreachableError }
        var token: String
        do {
            token = try await tokens.accessToken(profileId: profileId)
        } catch is TokenError {
            throw APIError.notSignedIn
        }
        for attempt in 0..<2 {
            let (bytes, response): (URLSession.AsyncBytes, URLResponse)
            do {
                (bytes, response) = try await session.bytes(for: build("GET", path, body: nil, contentType: nil, token: token, timeout: timeout))
            } catch let error as URLError {
                reachability?.reportFailure()
                throw error
            }
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            reachability?.reportAnswered()
            if http.statusCode == 401, attempt == 0 {
                bytes.task.cancel()
                do {
                    token = try await tokens.accessTokenAfterUnauthorized(profileId: profileId, failedToken: token)
                } catch is TokenError {
                    throw APIError.notSignedIn
                }
                continue
            }
            guard http.statusCode == 200 else {
                bytes.task.cancel()
                return .status(http.statusCode)
            }
            if http.expectedContentLength > Int64(maxBytes) {
                bytes.task.cancel()
                return .tooLarge
            }
            var data = Data()
            data.reserveCapacity(max(0, Int(min(http.expectedContentLength, Int64(maxBytes)))))
            for try await byte in bytes {
                data.append(byte)
                if data.count > maxBytes {
                    bytes.task.cancel()
                    return .tooLarge
                }
            }
            return .ok(data, contentType: http.value(forHTTPHeaderField: "Content-Type"))
        }
        return .status(401)
    }

    /// JSON in, the `data` member of the JSON answer out. Throws on any
    /// status that is not 2xx.
    func json(_ method: String, _ path: String, _ payload: Any? = nil, timeout: TimeInterval = 30, headers: [String: String] = [:]) async throws -> Any {
        let body = try payload.map { try JSONSerialization.data(withJSONObject: $0) }
        let (data, response) = try await send(method, path, body: body, timeout: timeout, headers: headers)
        let parsed = try? JSONSerialization.jsonObject(with: data)
        guard (200..<300).contains(response.statusCode) else {
            let message = (parsed as? [String: Any])?["message"] as? String ?? ""
            throw APIError.status(response.statusCode, message)
        }
        if let object = parsed as? [String: Any], let inner = object["data"] {
            return inner
        }
        return parsed ?? [:]
    }
}
