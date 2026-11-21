#if DEBUG
import AppKit
import Network
import WebKit

/// A small HTTP server for scripted end-to-end checks. Compiled only in DEBUG
/// builds and started only when `DOCMORE_AUTOMATION_PORT` is set. It listens
/// on 127.0.0.1 and refuses any request whose `X-Automation-Token` header is
/// not the value of `DOCMORE_AUTOMATION_TOKEN`.
@MainActor
final class AutomationServer {
    struct Request {
        let method: String
        let path: String
        let query: [String: String]
        let headers: [String: String]
        let body: Data

        var json: [String: Any] {
            ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any]) ?? [:]
        }
    }

    struct Response {
        var status = 200
        var contentType = "application/json"
        var body = Data()

        static func json(_ object: Any, status: Int = 200) -> Response {
            let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
            return Response(status: status, contentType: "application/json", body: data)
        }

        static func error(_ message: String, status: Int = 400) -> Response {
            json(["ok": false, "error": message], status: status)
        }
    }

    nonisolated static let configuredPort: UInt16? = {
        ProcessInfo.processInfo.environment["DOCMORE_AUTOMATION_PORT"].flatMap { UInt16($0) }
    }()

    nonisolated static let configuredToken: String = {
        ProcessInfo.processInfo.environment["DOCMORE_AUTOMATION_TOKEN"] ?? ""
    }()

    nonisolated static var isEnabled: Bool {
        configuredPort != nil && !configuredToken.isEmpty
    }

    private(set) static var shared: AutomationServer?

    static func startIfConfigured() {
        guard isEnabled, let port = configuredPort, shared == nil else { return }
        // start as if the server were out of reach (cold offline launch)
        if ProcessInfo.processInfo.environment["DOCMORE_AUTOMATION_OFFLINE"] == "1" {
            NetworkOverride.shared.forcedUnreachable = true
        }
        do {
            let server = try AutomationServer(port: port, token: configuredToken)
            server.start()
            shared = server
            NSLog("Docmore: automation server on 127.0.0.1:\(port)")
        } catch {
            NSLog("Docmore: automation server failed to start: \(error.localizedDescription)")
        }
    }

    private let listener: NWListener
    private let token: String
    private let queue = DispatchQueue(label: "com.dezik.docmore.automation")
    let routes = AutomationRoutes()

    private init(port: UInt16, token: String) throws {
        self.token = token
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: parameters)
    }

    private func start() {
        let token = self.token
        let queue = self.queue
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: queue)
            AutomationServer.receive(connection, buffer: Data()) { request in
                guard let request else {
                    AutomationServer.send(.error("bad request", status: 400), on: connection)
                    return
                }
                guard AutomationServer.constantTimeEquals(request.headers["x-automation-token"] ?? "", token) else {
                    AutomationServer.send(.error("missing or wrong X-Automation-Token", status: 401), on: connection)
                    return
                }
                Task { @MainActor in
                    guard let self else { return }
                    let response = await self.routes.handle(request)
                    AutomationServer.send(response, on: connection)
                    self.routes.afterResponse(request)
                }
            }
        }
        listener.start(queue: queue)
    }

    nonisolated private static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let left = Array(a.utf8), right = Array(b.utf8)
        guard left.count == right.count, !left.isEmpty else { return false }
        var difference: UInt8 = 0
        for index in left.indices { difference |= left[index] ^ right[index] }
        return difference == 0
    }

    nonisolated private static func receive(_ connection: NWConnection, buffer: Data, completion: @escaping (Request?) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, isComplete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = parse(buffer) {
                completion(request)
                return
            }
            if isComplete || error != nil || buffer.count > 256 << 20 {
                completion(nil)
                return
            }
            receive(connection, buffer: buffer, completion: completion)
        }
    }

    /// A complete HTTP/1.1 request with a Content-Length body, or nil while
    /// more bytes are needed.
    nonisolated private static func parse(_ buffer: Data) -> Request? {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerEnd = buffer.range(of: separator) else { return nil }
        guard let head = String(data: buffer[buffer.startIndex..<headerEnd.lowerBound], encoding: .utf8) else { return nil }
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let bodyStart = headerEnd.upperBound
        guard buffer.count - bodyStart >= length else { return nil }
        let body = buffer.subdata(in: bodyStart..<(bodyStart + length))
        let target = String(requestLine[1])
        let components = URLComponents(string: target)
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return Request(method: String(requestLine[0]).uppercased(), path: components?.path ?? target, query: query, headers: headers, body: body)
    }

    nonisolated private static func send(_ response: Response, on connection: NWConnection) {
        let reason = response.status == 200 ? "OK" : "Error"
        var head = "HTTP/1.1 \(response.status) \(reason)\r\n"
        head += "Content-Type: \(response.contentType)\r\n"
        head += "Content-Length: \(response.body.count)\r\n"
        head += "Connection: close\r\n\r\n"
        var data = Data(head.utf8)
        data.append(response.body)
        connection.send(content: data, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
#endif
