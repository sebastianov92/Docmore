import Foundation
import WebKit

/// A `WKURLSchemeTask` may only be touched on the main thread, never after
/// WebKit stopped it and never after it finished (WebKit raises an exception
/// otherwise). This wrapper enforces all three.
final class SchemeTaskBox: @unchecked Sendable {
    private let task: WKURLSchemeTask
    private var done = false
    private var stopHandler: (() -> Void)?
    let request: URLRequest

    init(_ task: WKURLSchemeTask) {
        self.task = task
        self.request = task.request
    }

    var isDone: Bool { done }

    func onStop(_ handler: @escaping () -> Void) {
        stopHandler = handler
    }

    /// WebKit no longer wants this answer.
    func stop() {
        dispatchPrecondition(condition: .onQueue(.main))
        done = true
        stopHandler?()
        stopHandler = nil
    }

    func respond(_ block: (WKURLSchemeTask) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !done else { return }
        block(task)
    }

    /// Last call for this task (`didFinish` or `didFailWithError`).
    func finish(_ block: (WKURLSchemeTask) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !done else { return }
        done = true
        stopHandler = nil
        block(task)
    }
}

/// What a proxied request needs, safe to use from any thread.
struct ProxyContext: Sendable {
    let profileId: String
    let serverURL: URL
    let tokens: TokenManager
    let reachability: ServerReachability
    let files: FileCache
    let bundle: BundleStore
    let engine: ProxyEngine
}

/// The `URLSession` behind every proxied `/api` request. Responses are
/// delivered through the delegate so they can be forwarded as they arrive
/// (the AI chat streams server-sent events).
final class ProxyEngine: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private var session: URLSession!
    private let lock = NSLock()
    private var exchanges: [Int: ProxyExchange] = [:]

    override init() {
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        // the sign-in is the bearer token: no cookie ever leaves or stays
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 6 * 60 * 60
        configuration.waitsForConnectivity = false
        configuration.httpMaximumConnectionsPerHost = 12
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "com.dezik.docmore.proxy"
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }

    func start(_ request: URLRequest, for exchange: ProxyExchange) -> URLSessionDataTask {
        let task = session.dataTask(with: request)
        lock.lock()
        exchanges[task.taskIdentifier] = exchange
        lock.unlock()
        task.resume()
        return task
    }

    /// Forget a task whose remaining callbacks are of no interest.
    func detach(_ task: URLSessionTask) {
        lock.lock()
        exchanges.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
    }

    private func exchange(for task: URLSessionTask) -> ProxyExchange? {
        lock.lock(); defer { lock.unlock() }
        return exchanges[task.taskIdentifier]
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let exchange = exchange(for: dataTask) else {
            completionHandler(.cancel)
            return
        }
        exchange.received(response: response, task: dataTask, completion: completionHandler)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        exchange(for: dataTask)?.received(data: data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let exchange = exchange(for: task) else { return }
        detach(task)
        exchange.completed(error: error)
    }
}

/// One request of the page on its way to the server and back.
final class ProxyExchange: @unchecked Sendable {
    private let context: ProxyContext
    private let box: SchemeTaskBox
    private let original: URLRequest
    private let appURL: URL
    /// Set for `GET /api/files/...` and `GET /api/attachments/...`.
    private let cacheKey: String?

    private let lock = NSLock()
    private var body: Data?
    private var usedToken: String?
    private var retried = false
    private var connectionRetried = false
    private var forwarded = false
    private var cancelled = false
    private var current: URLSessionDataTask?
    private var tee: (handle: FileHandle, url: URL, contentType: String)?

    static let hopByHopRequestHeaders: Set<String> = [
        "cookie", "host", "content-length", "connection", "accept-encoding", "authorization",
        "proxy-authorization", "te", "upgrade", "keep-alive", "transfer-encoding",
    ]
    static let droppedResponseHeaders: Set<String> = [
        "set-cookie", "set-cookie2", "content-encoding", "transfer-encoding", "connection", "keep-alive",
        "proxy-authenticate", "trailer", "upgrade",
    ]

    init(context: ProxyContext, box: SchemeTaskBox, cacheKey: String?) {
        self.context = context
        self.box = box
        self.original = box.request
        self.appURL = box.request.url ?? context.serverURL
        self.cacheKey = cacheKey
    }

    func start() {
        Task.detached(priority: .userInitiated) { await self.run() }
    }

    /// WebKit stopped the task (navigation, abort): drop the upstream request.
    func cancel() {
        lock.lock()
        cancelled = true
        let task = current
        lock.unlock()
        if let task {
            context.engine.detach(task)
            task.cancel()
        }
        closeTee(keep: false)
    }

    private var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }

    private func run() async {
        body = ProxyExchange.readBody(original)
        #if DEBUG
        if ProcessInfo.processInfo.environment["DOCMORE_PROXY_DEBUG"] != nil {
            NSLog("Docmore proxy: %@ %@ httpBody=%d stream=%@ read=%d type=%@", original.httpMethod ?? "?", appURL.path, original.httpBody?.count ?? -1, original.httpBodyStream == nil ? "no" : "yes", body?.count ?? -1, original.value(forHTTPHeaderField: "Content-Type") ?? "-")
        }
        #endif
        guard await context.reachability.gate() else {
            connectionFailed(NetworkOverride.unreachableError)
            return
        }
        var token: String?
        do {
            token = try await context.tokens.accessToken(profileId: context.profileId)
        } catch let error as OAuthError {
            if case .unreachable = error {
                connectionFailed(URLError(.cannotConnectToHost))
                return
            }
            token = await context.tokens.storedAccessToken(profileId: context.profileId)
        } catch {
            // signed out or waiting for a new sign-in: let the server say 401
            token = await context.tokens.storedAccessToken(profileId: context.profileId)
        }
        send(token: token)
    }

    static func readBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let size = 64 * 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
        defer { buffer.deallocate() }
        while true {
            let count = stream.read(buffer, maxLength: size)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    static func upstreamURL(server: URL, appURL: URL) -> URL? {
        let components = URLComponents(url: appURL, resolvingAgainstBaseURL: false)
        var text = server.absoluteString + (components?.percentEncodedPath ?? appURL.path)
        if let query = components?.percentEncodedQuery, !query.isEmpty {
            text += "?" + query
        }
        return URL(string: text)
    }

    private func send(token: String?) {
        guard let url = ProxyExchange.upstreamURL(server: context.serverURL, appURL: appURL) else {
            fail(URLError(.badURL))
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = original.httpMethod ?? "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let appOrigin = "\(AppScheme.name)://\(appURL.host ?? "")"
        let serverOrigin = context.serverURL.absoluteString
        var wantsStream = false
        for (name, value) in original.allHTTPHeaderFields ?? [:] {
            let lower = name.lowercased()
            if ProxyExchange.hopByHopRequestHeaders.contains(lower) { continue }
            switch lower {
            case "origin":
                // for the server this is a same-origin request
                request.setValue(serverOrigin, forHTTPHeaderField: name)
            case "referer":
                request.setValue(value.replacingOccurrences(of: appOrigin, with: serverOrigin), forHTTPHeaderField: name)
            default:
                if lower == "accept", value.contains("text/event-stream") { wantsStream = true }
                request.setValue(value, forHTTPHeaderField: name)
            }
        }
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = body
        // a streamed answer, or any answer written by a model, may stay silent
        // for a long while before the first byte
        let slowAnswer = wantsStream || url.path.hasPrefix("/api/ai/")
        request.timeoutInterval = slowAnswer ? 900 : 120

        lock.lock()
        if cancelled {
            lock.unlock()
            return
        }
        usedToken = token
        current = context.engine.start(request, for: self)
        lock.unlock()
    }

    // MARK: URLSession callbacks (proxy delegate queue)

    func received(response: URLResponse, task: URLSessionDataTask, completion: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            completion(.allow)
            return
        }
        #if DEBUG
        if http.statusCode >= 400, ProcessInfo.processInfo.environment["DOCMORE_PROXY_DEBUG"] != nil {
            NSLog("Docmore proxy: %@ %@ answered %d", original.httpMethod ?? "?", appURL.path, http.statusCode)
        }
        #endif
        context.reachability.reportAnswered()

        lock.lock()
        let failedToken = usedToken
        let canRetry = !retried
        lock.unlock()

        if http.statusCode == 401, canRetry, let failedToken {
            lock.lock()
            retried = true
            lock.unlock()
            context.engine.detach(task)
            completion(.cancel)
            let headers = http.allHeaderFields
            Task.detached { [self] in
                do {
                    let renewed = try await context.tokens.accessTokenAfterUnauthorized(
                        profileId: context.profileId,
                        failedToken: failedToken
                    )
                    send(token: renewed)
                } catch let error as OAuthError {
                    if case .unreachable = error {
                        connectionFailed(URLError(.cannotConnectToHost))
                    } else {
                        respondUnauthorized(upstreamHeaders: headers)
                    }
                } catch {
                    respondUnauthorized(upstreamHeaders: headers)
                }
            }
            return
        }

        forward(http)
        completion(.allow)
    }

    private func forward(_ http: HTTPURLResponse) {
        var headers: [String: String] = [:]
        var wasEncoded = false
        for (key, value) in http.allHeaderFields {
            guard let name = key as? String else { continue }
            let lower = name.lowercased()
            if lower == "content-encoding" { wasEncoded = true }
            if ProxyExchange.droppedResponseHeaders.contains(lower) { continue }
            headers[name] = "\(value)"
        }
        if wasEncoded {
            // URLSession already decoded the body: the length no longer matches
            for name in headers.keys where name.lowercased() == "content-length" {
                headers.removeValue(forKey: name)
            }
        }

        if let cacheKey {
            let ranged = original.value(forHTTPHeaderField: "Range") != nil
            if http.statusCode == 200, !ranged, context.files.has(cacheKey) {
                openTee(contentType: http.value(forHTTPHeaderField: "Content-Type") ?? ContentTypes.type(forPath: cacheKey))
            } else if http.statusCode == 404 || http.statusCode == 403 {
                // gone or no longer allowed: the offline copy goes too
                context.files.remove(keys: [cacheKey])
            }
        }

        let response = HTTPURLResponse(url: appURL, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: headers)
            ?? HTTPURLResponse(url: appURL, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: nil)!
        lock.lock()
        forwarded = true
        lock.unlock()
        let box = self.box
        DispatchQueue.main.async {
            box.respond { $0.didReceive(response) }
        }
    }

    func received(data: Data) {
        lock.lock()
        let handle = tee?.handle
        lock.unlock()
        if let handle {
            do {
                try handle.write(contentsOf: data)
            } catch {
                closeTee(keep: false)
            }
        }
        let box = self.box
        DispatchQueue.main.async {
            box.respond { $0.didReceive(data) }
        }
    }

    func completed(error: Error?) {
        #if DEBUG
        if let error, ProcessInfo.processInfo.environment["DOCMORE_PROXY_DEBUG"] != nil {
            NSLog("Docmore proxy: %@ %@ failed: %@", original.httpMethod ?? "?", appURL.path, String(describing: error))
        }
        #endif
        if let error {
            closeTee(keep: false)
            if isCancelled { return }
            lock.lock()
            let alreadyForwarded = forwarded
            // A kept-alive connection the server had already closed: nothing
            // of the answer arrived. Browsers send such a request once more
            // on a fresh connection; so does the proxy.
            let retryOnce = !alreadyForwarded && !connectionRetried && (error as? URLError)?.code == .networkConnectionLost
            if retryOnce { connectionRetried = true }
            let token = usedToken
            lock.unlock()
            if retryOnce {
                send(token: token)
            } else if alreadyForwarded {
                fail(error)
            } else {
                connectionFailed(error)
            }
            return
        }
        closeTee(keep: true)
        let box = self.box
        DispatchQueue.main.async {
            box.finish { $0.didFinish() }
        }
    }

    // MARK: Answers made here

    private func fail(_ error: Error) {
        let box = self.box
        DispatchQueue.main.async {
            box.finish { $0.didFailWithError(error) }
        }
    }

    /// The server did not answer at all. For a file kept offline that is the
    /// moment the cache answers; anything else fails as a network error so the
    /// page can tell "offline" from "the server said no".
    private func connectionFailed(_ error: Error) {
        #if DEBUG
        if ProcessInfo.processInfo.environment["DOCMORE_PROXY_DEBUG"] != nil {
            NSLog("Docmore proxy: %@ %@ no answer: %@", original.httpMethod ?? "?", appURL.path, (error as NSError).domain + " \((error as NSError).code)")
        }
        #endif
        context.reachability.reportFailure()
        guard let cacheKey else {
            fail(error)
            return
        }
        serveFromCache(cacheKey)
    }

    private func serveFromCache(_ key: String) {
        guard let entry = context.files.entry(key), let fileURL = context.files.fileURL(key),
              let handle = try? FileHandle(forReadingFrom: fileURL) else {
            respond(status: 404, headers: ["Content-Type": "text/plain; charset=utf-8", "X-Docmore-Source": "offline-cache"], body: Data("Not available offline".utf8))
            return
        }
        defer { try? handle.close() }
        let size = entry.size
        var headers = [
            "Content-Type": entry.contentType,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
            "X-Docmore-Source": "offline-cache",
        ]
        if let range = ByteRange.parse(original.value(forHTTPHeaderField: "Range"), fileSize: size) {
            try? handle.seek(toOffset: UInt64(range.lowerBound))
            let data = (try? handle.read(upToCount: Int(range.upperBound - range.lowerBound + 1))) ?? Data()
            headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound)/\(size)"
            headers["Content-Length"] = "\(data.count)"
            respond(status: 206, headers: headers, body: data)
        } else {
            let data = (try? handle.readToEnd()) ?? Data()
            headers["Content-Length"] = "\(data.count)"
            respond(status: 200, headers: headers, body: data)
        }
    }

    private func respondUnauthorized(upstreamHeaders: [AnyHashable: Any]) {
        let body = Data(#"{"statusCode":401,"error":"Unauthorized","message":"Unauthorized"}"#.utf8)
        respond(status: 401, headers: ["Content-Type": "application/json; charset=utf-8", "Content-Length": "\(body.count)"], body: body)
    }

    private func respond(status: Int, headers: [String: String], body: Data) {
        let response = HTTPURLResponse(url: appURL, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        let box = self.box
        DispatchQueue.main.async {
            box.respond { $0.didReceive(response) }
            box.respond { $0.didReceive(body) }
            box.finish { $0.didFinish() }
        }
    }

    // MARK: Refreshing the offline copy while the file streams by

    private func openTee(contentType: String) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("docmore-file-\(UUID().uuidString).part")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        lock.lock()
        tee = (handle, url, contentType)
        lock.unlock()
    }

    private func closeTee(keep: Bool) {
        lock.lock()
        let active = tee
        tee = nil
        lock.unlock()
        guard let active else { return }
        try? active.handle.close()
        if keep, let cacheKey {
            try? context.files.store(key: cacheKey, movingFileAt: active.url, contentType: active.contentType)
        }
        try? FileManager.default.removeItem(at: active.url)
    }
}
