import AppKit
import WebKit

/// The web -> native half of the bridge: one case per message type.
@MainActor
enum Bridge {
    struct BridgeError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func handle(type: String, payload: [String: Any], id: String?, webView: WKWebView?, session: ProfileSession) async {
        session.services.bridgeLog.add(direction: "in", profileId: session.profileId, type: type, payload: type == "files.put" ? ["url": payload["url"] ?? ""] : payload)
        do {
            let result = try await perform(type: type, payload: payload, webView: webView, session: session)
            if let id { session.reply(to: id, error: nil, result: result, in: webView) }
        } catch {
            if let id { session.reply(to: id, error: error.localizedDescription, result: nil, in: webView) }
        }
    }

    private static func strings(_ value: Any?) -> [String] {
        (value as? [Any])?.compactMap { $0 as? String } ?? []
    }

    private static func perform(type: String, payload: [String: Any], webView: WKWebView?, session: ProfileSession) async throws -> Any {
        let services = session.services
        switch type {
        case "net.probe":
            return ["reachable": await session.reachability.probe()]

        case "files.ensure":
            let limit = (payload["maxBytes"] as? NSNumber)?.intValue ?? 0
            return await ensureFiles(strings(payload["urls"]), maxBytes: max(0, limit), session: session)

        case "files.put":
            guard let url = payload["url"] as? String, let key = FileCacheKey.key(for: url) else {
                throw BridgeError(message: "files.put needs a /api/files or /api/attachments url")
            }
            guard let base64 = payload["base64"] as? String,
                  let data = Data(base64Encoded: base64, options: [.ignoreUnknownCharacters]) else {
                throw BridgeError(message: "files.put needs base64 data")
            }
            let type = (payload["contentType"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? ContentTypes.type(forPath: key)
            try session.files.store(key: key, data: data, contentType: type)
            return ["ok": true, "bytes": data.count]

        case "files.has":
            let present = strings(payload["urls"]).filter { url in
                FileCacheKey.key(for: url).map(session.files.has) ?? false
            }
            return ["present": present]

        case "files.remove":
            session.files.remove(keys: strings(payload["urls"]).compactMap(FileCacheKey.key(for:)))
            return ["ok": true]

        case "files.clear":
            session.files.clear()
            return ["ok": true]

        case "files.usage":
            let usage = session.files.usage()
            return ["bytes": usage.bytes, "count": usage.count]

        case "notify":
            let title = payload["title"] as? String ?? "Docmore"
            let body = payload["body"] as? String ?? ""
            let path = (payload["path"] as? String).flatMap(DeepLink.sanitize(path:))
            services.notifications.post(title: title, body: body, profileId: session.profileId, path: path, kind: "page")
            return ["ok": true]

        case "badge":
            session.badgeCount = max(0, payload["count"] as? Int ?? 0)
            services.updateBadge()
            return ["ok": true]

        case "openExternal":
            guard let text = payload["url"] as? String, let url = URL(string: text),
                  let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel"].contains(scheme) else {
                throw BridgeError(message: "openExternal needs an http, https, mailto or tel url")
            }
            services.openExternal(url)
            return ["ok": true]

        case "spotlight.index":
            var items: [(id: String, title: String, text: String)] = []
            var paths: [(id: String, path: String)] = []
            for raw in (payload["items"] as? [[String: Any]]) ?? [] {
                guard let id = raw["id"] as? String, !id.isEmpty,
                      let path = (raw["path"] as? String).flatMap(DeepLink.sanitize(path:)) else { continue }
                items.append((id, raw["title"] as? String ?? "", raw["text"] as? String ?? ""))
                paths.append((id, path))
            }
            session.spotlightMap.set(paths)
            services.spotlight.index(profileId: session.profileId, items: items)
            return ["indexed": items.count]

        case "spotlight.remove":
            let ids = strings(payload["ids"])
            session.spotlightMap.remove(ids)
            services.spotlight.remove(profileId: session.profileId, ids: ids)
            return ["ok": true]

        case "spotlight.clear":
            session.spotlightMap.clear()
            services.spotlight.clear(profileId: session.profileId)
            return ["ok": true]

        case "state":
            session.updateSyncState(payload)
            return ["ok": true]

        case "signOut":
            let profileId = session.profileId
            // answer first: the page is about to go away
            Task { @MainActor in
                await AppCoordinator.shared.signOut(profileId: profileId)
            }
            return ["ok": true]

        case "authRequired":
            // the page met a 401 it could not get past
            let profileId = session.profileId
            Task { @MainActor in
                await AppCoordinator.shared.authRequired(profileId: profileId)
            }
            return ["ok": true]

        case "meeting.start":
            // with "mode" ("in_person" or "virtual") the recording starts at
            // once and the answer says so; without it the panel asks for the
            // kind and the answer comes at once with `choosing: true`
            var mode: MeetingMode?
            if let text = payload["mode"] as? String {
                guard let known = MeetingMode(rawValue: text) else {
                    throw BridgeError(message: "meeting.start: mode is \"in_person\" or \"virtual\"")
                }
                mode = known
            }
            try await MeetingController.shared.start(
                profileId: session.profileId,
                pageId: payload["pageId"] as? String,
                spaceId: payload["spaceId"] as? String,
                title: payload["title"] as? String,
                mode: mode
            )
            return MeetingController.shared.statePayload

        case "meeting.stop":
            await MeetingController.shared.stop()
            return MeetingController.shared.statePayload

        case "meeting.state":
            return MeetingController.shared.statePayload

        case "print":
            if let webView, let controller = webView.window?.windowController as? BrowserWindowController {
                controller.printPage(nil)
            }
            return ["ok": true]

        case "debug.log":
            return ["ok": true]

        default:
            throw BridgeError(message: "Unknown message type \"\(type)\"")
        }
    }

    /// Downloads files into the offline cache, a few at a time. A file larger
    /// than `maxBytes` (0 = no limit) is skipped and reported as failed.
    static func ensureFiles(_ urls: [String], maxBytes: Int = 0, session: ProfileSession) async -> [String: Any] {
        let api = session.api
        let files = session.files
        var ok: [String] = []
        var failed: [String] = []
        await withTaskGroup(of: (String, Bool).self) { group in
            var iterator = urls.makeIterator()
            func next() -> Bool {
                guard let url = iterator.next() else { return false }
                group.addTask {
                    guard let key = FileCacheKey.key(for: url) else { return (url, false) }
                    do {
                        guard case .ok(let data, let contentType) = try await api.download(FileCacheKey.requestPath(forKey: key), maxBytes: maxBytes) else {
                            return (url, false)
                        }
                        try files.store(key: key, data: data, contentType: contentType ?? ContentTypes.type(forPath: key))
                        return (url, true)
                    } catch {
                        return (url, false)
                    }
                }
                return true
            }
            var running = 0
            while running < 4, next() { running += 1 }
            for await (url, success) in group {
                if success { ok.append(url) } else { failed.append(url) }
                _ = next()
            }
        }
        return ["ok": ok, "failed": failed]
    }
}
