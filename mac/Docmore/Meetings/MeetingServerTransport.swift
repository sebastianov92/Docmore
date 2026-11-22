import Foundation

/// The live meeting calls of an account, made the way the rest of the app
/// talks to its server: `ServerAPI` adds the sign-in, renews it once after a
/// 401 and honours the forced-offline switch.
struct MeetingServerTransport: MeetingLiveTransport {
    let api: ServerAPI

    func post(_ route: String, body: Data, timeout: TimeInterval, idempotencyKey: String?) async throws -> Data {
        let data: Data
        let response: HTTPURLResponse
        var headers: [String: String] = [:]
        if let idempotencyKey, idempotencyKey.count <= 100,
           idempotencyKey.range(of: "^[A-Za-z0-9_.:-]+$", options: .regularExpression) != nil {
            headers["Idempotency-Key"] = idempotencyKey
        }
        do {
            (data, response) = try await api.send("POST", "/api/ai/meetings/\(route)", body: body, timeout: timeout, headers: headers)
        } catch let error as URLError {
            throw MeetingLiveFailure.unreachable(reason: "network \(error.code.rawValue)")
        } catch {
            // a sign-in that has to be renewed by the person
            throw MeetingLiveFailure.unreachable(reason: "sign-in")
        }
        let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        switch response.statusCode {
        case 200..<300:
            // the payload is the `data` member of the server's envelope
            if let inner = parsed?["data"], JSONSerialization.isValidJSONObject(inner),
               let unwrapped = try? JSONSerialization.data(withJSONObject: inner) {
                return unwrapped
            }
            return data
        case 401, 408, 429, 500...599:
            throw MeetingLiveFailure.unreachable(reason: "status \(response.statusCode)")
        default:
            let message = (parsed?["message"] as? String) ?? (parsed?["message"] as? [String])?.joined(separator: "; ") ?? ""
            throw MeetingLiveFailure.refused(status: response.statusCode, message: message)
        }
    }
}
