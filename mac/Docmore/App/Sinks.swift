import AppKit
import CoreSpotlight
import UserNotifications

/// Where notifications go. Test runs record them instead of asking macOS, so
/// automation never raises a permission prompt.
protocol NotificationSink: AnyObject {
    func post(title: String, body: String, profileId: String?, path: String?, kind: String)
    var recorded: [[String: Any]] { get }
}

final class RecordingNotificationSink: NotificationSink {
    private(set) var recorded: [[String: Any]] = []

    func post(title: String, body: String, profileId: String?, path: String?, kind: String) {
        var entry: [String: Any] = ["title": title, "body": body, "kind": kind]
        if let profileId { entry["profileId"] = profileId }
        if let path { entry["path"] = path }
        recorded.append(entry)
        if recorded.count > 100 { recorded.removeFirst(recorded.count - 100) }
    }
}

final class SystemNotificationSink: NSObject, NotificationSink, UNUserNotificationCenterDelegate {
    static let recordCategory = "DOCMORE_MEETING_DETECTED"
    static let recordAction = "DOCMORE_RECORD"
    private var asked = false
    private(set) var recorded: [[String: Any]] = []
    /// Called on the main thread when a notification is clicked.
    var onOpen: ((_ profileId: String?, _ path: String?, _ action: String?) -> Void)?

    override init() {
        super.init()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let record = UNNotificationAction(identifier: Self.recordAction, title: L("Record"), options: [.foreground])
        let category = UNNotificationCategory(identifier: Self.recordCategory, actions: [record], intentIdentifiers: [])
        center.setNotificationCategories([category])
    }

    func post(title: String, body: String, profileId: String?, path: String?, kind: String) {
        let center = UNUserNotificationCenter.current()
        let deliver = {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            var info: [String: Any] = ["kind": kind]
            if let profileId { info["profileId"] = profileId }
            if let path { info["path"] = path }
            content.userInfo = info
            if kind == "meeting-detected" { content.categoryIdentifier = Self.recordCategory }
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
        if asked {
            deliver()
            return
        }
        asked = true
        // the system asks the person once; the answer is theirs
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in deliver() }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let profileId = info["profileId"] as? String
        let path = info["path"] as? String
        let kind = info["kind"] as? String
        let action = response.actionIdentifier == Self.recordAction || kind == "meeting-detected" ? "record" : nil
        DispatchQueue.main.async { [weak self] in
            self?.onOpen?(profileId, path, action)
        }
        completionHandler()
    }
}

/// One page as the system search knows it: `text` is empty for a page whose
/// body is not on this Mac (it is found by its title), `detail` is the space.
struct SpotlightEntry {
    let id: String
    let title: String
    let text: String
    let detail: String
}

/// Where pages go to be found by Spotlight. Test runs record instead of
/// touching the real index.
protocol SpotlightSink: AnyObject {
    func index(profileId: String, items: [SpotlightEntry])
    func remove(profileId: String, ids: [String])
    func clear(profileId: String)
    /// Identifiers of this app's entries whose title contains `text`.
    func find(titleContaining text: String) async -> [String]
    var recorded: [[String: Any]] { get }
}

final class RecordingSpotlightSink: SpotlightSink {
    private(set) var recorded: [[String: Any]] = []
    private var titles: [String: String] = [:]

    func index(profileId: String, items: [SpotlightEntry]) {
        recorded.append([
            "op": "index", "profileId": profileId, "ids": items.map(\.id), "titles": items.map(\.title),
            "withText": items.filter { !$0.text.isEmpty }.map(\.id), "details": items.map(\.detail),
        ])
        for item in items { titles[SpotlightMap.identifier(profileId: profileId, itemId: item.id)] = item.title }
    }

    func remove(profileId: String, ids: [String]) {
        recorded.append(["op": "remove", "profileId": profileId, "ids": ids])
        for id in ids { titles.removeValue(forKey: SpotlightMap.identifier(profileId: profileId, itemId: id)) }
    }

    func clear(profileId: String) {
        recorded.append(["op": "clear", "profileId": profileId])
        titles = titles.filter { !$0.key.hasPrefix("\(profileId)|") }
    }

    func find(titleContaining text: String) async -> [String] {
        titles.filter { $0.value.localizedCaseInsensitiveContains(text) }.map(\.key).sorted()
    }
}

final class SystemSpotlightSink: SpotlightSink {
    let recorded: [[String: Any]] = []
    private let index = CSSearchableIndex.default()

    func index(profileId: String, items: [SpotlightEntry]) {
        let searchable = items.map { item -> CSSearchableItem in
            let attributes = CSSearchableItemAttributeSet(contentType: .text)
            attributes.title = item.title
            attributes.displayName = item.title
            // under the title: the start of the page, or the space it lives in
            let summary = item.text.isEmpty ? item.detail : String(item.text.prefix(300))
            if !summary.isEmpty { attributes.contentDescription = summary }
            if !item.text.isEmpty { attributes.textContent = item.text }
            attributes.kind = "Docmore"
            if !item.detail.isEmpty { attributes.containerTitle = item.detail }
            let entry = CSSearchableItem(
                uniqueIdentifier: SpotlightMap.identifier(profileId: profileId, itemId: item.id),
                domainIdentifier: profileId,
                attributeSet: attributes
            )
            entry.expirationDate = .distantFuture
            return entry
        }
        index.indexSearchableItems(searchable) { error in
            if let error { NSLog("Docmore: Spotlight indexing failed: \(error.localizedDescription)") }
        }
    }

    func remove(profileId: String, ids: [String]) {
        index.deleteSearchableItems(withIdentifiers: ids.map { SpotlightMap.identifier(profileId: profileId, itemId: $0) }, completionHandler: nil)
    }

    func clear(profileId: String) {
        index.deleteSearchableItems(withDomainIdentifiers: [profileId], completionHandler: nil)
    }

    func find(titleContaining text: String) async -> [String] {
        let escaped = text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let context = CSSearchQueryContext()
        context.fetchAttributes = ["title"]
        let query = CSSearchQuery(queryString: "title == \"*\(escaped)*\"cd", queryContext: context)
        return await withCheckedContinuation { continuation in
            var found: [String] = []
            query.foundItemsHandler = { items in found.append(contentsOf: items.map(\.uniqueIdentifier)) }
            query.completionHandler = { error in
                if let error { NSLog("Docmore: Spotlight query failed: \(error.localizedDescription)") }
                continuation.resume(returning: found.sorted())
            }
            query.start()
        }
    }
}
