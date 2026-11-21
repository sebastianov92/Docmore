import Foundation
import Network

/// Lets automation pretend the server cannot be reached. Everything that
/// talks to a server asks here first.
final class NetworkOverride: @unchecked Sendable {
    static let shared = NetworkOverride()
    private let lock = NSLock()
    private var forced = false

    var forcedUnreachable: Bool {
        get { lock.lock(); defer { lock.unlock() }; return forced }
        set { lock.lock(); forced = newValue; lock.unlock() }
    }

    static var unreachableError: URLError { URLError(.cannotConnectToHost) }
}

/// One watcher of the Mac's network for the whole app.
final class PathWatcher: @unchecked Sendable {
    static let shared = PathWatcher()
    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var listeners: [UUID: @Sendable () -> Void] = [:]
    private var started = false

    func start() {
        lock.lock()
        let already = started
        started = true
        lock.unlock()
        guard !already else { return }
        monitor.pathUpdateHandler = { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            let callbacks = Array(self.listeners.values)
            self.lock.unlock()
            callbacks.forEach { $0() }
        }
        monitor.start(queue: DispatchQueue(label: "com.dezik.docmore.path"))
    }

    @discardableResult
    func onChange(_ callback: @escaping @Sendable () -> Void) -> UUID {
        let id = UUID()
        lock.lock()
        listeners[id] = callback
        lock.unlock()
        return id
    }

    func remove(_ id: UUID) {
        lock.lock()
        listeners.removeValue(forKey: id)
        lock.unlock()
    }
}

/// Whether one server answers. "Online" in this app means exactly that: a
/// homelab behind a VPN can be out of reach while the Mac has a network.
final class ServerReachability: @unchecked Sendable {
    let serverURL: URL
    private let lock = NSLock()
    private var isReachable = true
    private var probing: Task<Bool, Never>?
    private var retryLoop: Task<Void, Never>?
    private var pathToken: UUID?
    private let session: URLSession
    /// Called on the main thread when the answer changes.
    var onChange: (@Sendable (Bool) -> Void)?

    static let retryInterval: UInt64 = 5_000_000_000

    init(serverURL: URL) {
        self.serverURL = serverURL
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 6
        configuration.waitsForConnectivity = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration)
    }

    deinit {
        if let pathToken { PathWatcher.shared.remove(pathToken) }
        retryLoop?.cancel()
        session.invalidateAndCancel()
    }

    var reachable: Bool {
        lock.lock(); defer { lock.unlock() }
        return isReachable
    }

    func startMonitoring() {
        PathWatcher.shared.start()
        pathToken = PathWatcher.shared.onChange { [weak self] in
            guard let self else { return }
            Task { await self.probe() }
        }
        Task { await probe() }
    }

    /// Asks the server whether it is there (`GET /api/health/live`).
    /// Concurrent callers share one request.
    @discardableResult
    func probe() async -> Bool {
        let task: Task<Bool, Never> = lock.withLock {
            if let running = probing { return running }
            let created = Task<Bool, Never> { [weak self] in
                guard let self else { return false }
                return await self.runProbe()
            }
            probing = created
            return created
        }
        let result = await task.value
        lock.withLock {
            if probing == task { probing = nil }
        }
        update(result)
        return result
    }

    private func runProbe() async -> Bool {
        if NetworkOverride.shared.forcedUnreachable { return false }
        var request = URLRequest(url: URL(string: serverURL.absoluteString + "/api/health/live")!)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 4
        do {
            let (_, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            #if DEBUG
            if status != 200, ProcessInfo.processInfo.environment["DOCMORE_PROXY_DEBUG"] != nil {
                NSLog("Docmore probe: %@ answered %d", serverURL.absoluteString, status)
            }
            #endif
            return status == 200
        } catch {
            #if DEBUG
            if ProcessInfo.processInfo.environment["DOCMORE_PROXY_DEBUG"] != nil {
                NSLog("Docmore probe: %@ failed: %@ %d", serverURL.absoluteString, (error as NSError).domain, (error as NSError).code)
            }
            #endif
            return false
        }
    }

    /// For requests: go ahead when the server was last seen answering,
    /// otherwise check now instead of letting each request wait for its own
    /// connection timeout.
    func gate() async -> Bool {
        if NetworkOverride.shared.forcedUnreachable {
            update(false)
            return false
        }
        if reachable { return true }
        return await probe()
    }

    /// A request got an answer from the server.
    func reportAnswered() {
        if !NetworkOverride.shared.forcedUnreachable { update(true) }
    }

    /// A request died without an answer: confirm with a probe.
    func reportFailure() {
        Task { await probe() }
    }

    private func update(_ value: Bool) {
        lock.lock()
        let changed = isReachable != value
        isReachable = value
        if value {
            retryLoop?.cancel()
            retryLoop = nil
        } else if retryLoop == nil {
            retryLoop = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: ServerReachability.retryInterval)
                    guard let self, !Task.isCancelled else { return }
                    if await self.probe() { return }
                }
            }
        }
        let callback = onChange
        lock.unlock()
        if changed, let callback {
            DispatchQueue.main.async { callback(value) }
        }
    }
}
