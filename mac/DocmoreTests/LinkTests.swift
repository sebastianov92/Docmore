import XCTest

final class LinkTests: XCTestCase {
    func testPageLinks() {
        XCTAssertEqual(DeepLink.parse(URL(string: "docmore://page/my-page-abc123")!), .path("/p/my-page-abc123"))
        XCTAssertEqual(DeepLink.parse(URL(string: "docmore://page/0195d3a2-1111-7222-8333-444455556666")!), .path("/p/0195d3a2-1111-7222-8333-444455556666"))
        XCTAssertEqual(DeepLink.parse(URL(string: "DOCMORE://page/abc")!), .path("/p/abc"))
        XCTAssertNil(DeepLink.parse(URL(string: "docmore://page/")!))
        XCTAssertNil(DeepLink.parse(URL(string: "docmore://page/a/b")!))
    }

    func testOpenLinks() {
        XCTAssertEqual(DeepLink.parse(URL(string: "docmore://open?path=/s/general/p/page-1")!), .path("/s/general/p/page-1"))
        XCTAssertEqual(DeepLink.parse(URL(string: "docmore://open?path=%2Fsettings%2Faccount%2Fprofile%3Ftab%3D1")!), .path("/settings/account/profile?tab=1"))
        XCTAssertNil(DeepLink.parse(URL(string: "docmore://open")!))
        XCTAssertNil(DeepLink.parse(URL(string: "docmore://open?path=settings")!))
        XCTAssertNil(DeepLink.parse(URL(string: "docmore://open?path=//evil.example.com/x")!), "must not become a link to another host")
        XCTAssertNil(DeepLink.parse(URL(string: "docmore://open?path=https://evil.example.com")!))
    }

    func testOtherLinks() {
        XCTAssertEqual(DeepLink.parse(URL(string: "docmore://oauth/callback?code=1&state=2")!), .oauthCallback)
        XCTAssertNil(DeepLink.parse(URL(string: "docmore://unknown/thing")!))
        XCTAssertNil(DeepLink.parse(URL(string: "https://example.com/page/x")!))
    }

    func testSpotlightIdentifiers() {
        let identifier = SpotlightMap.identifier(profileId: "0123456789abcdef", itemId: "page|with|bars")
        XCTAssertEqual(identifier, "0123456789abcdef|page|with|bars")
        let split = SpotlightMap.split(identifier)
        XCTAssertEqual(split?.profileId, "0123456789abcdef")
        XCTAssertEqual(split?.itemId, "page|with|bars")
        XCTAssertNil(SpotlightMap.split("not-a-profile|x"))
        XCTAssertNil(SpotlightMap.split("0123456789abcdef|"))
        XCTAssertNil(SpotlightMap.split("0123456789abcdef"))
    }

    func testSpotlightMapPersists() throws {
        let file = try TestSupport.temporaryDirectory().appendingPathComponent("spotlight.json")
        let map = SpotlightMap(file: file)
        map.set([(id: "a", path: "/s/x/p/a"), (id: "b", path: "/s/x/p/b")])
        XCTAssertEqual(map.path(for: "a"), "/s/x/p/a")
        XCTAssertEqual(SpotlightMap(file: file).count, 2)
        map.remove(["a"])
        XCTAssertNil(SpotlightMap(file: file).path(for: "a"))
        XCTAssertEqual(SpotlightMap(file: file).path(for: "b"), "/s/x/p/b")
        map.clear()
        XCTAssertEqual(SpotlightMap(file: file).count, 0)
    }

    func testHotKeyCombo() {
        let standard = HotKeyCombo.defaultQuickCapture
        XCTAssertEqual(standard.storageValue, "opt+cmd+45")
        XCTAssertEqual(HotKeyCombo(storageValue: "opt+cmd+45"), standard)
        XCTAssertEqual(HotKeyCombo(storageValue: "CMD+OPT+45"), standard)
        XCTAssertEqual(standard.displayString, "\u{2325}\u{2318}N")
        XCTAssertEqual(standard.carbonModifiers, 0x0100 | 0x0800)
        let all = HotKeyCombo(keyCode: 49, command: true, option: true, control: true, shift: true)
        XCTAssertEqual(HotKeyCombo(storageValue: all.storageValue), all)
        XCTAssertEqual(all.displayString, "\u{2303}\u{2325}\u{21E7}\u{2318}Space")
        XCTAssertNil(HotKeyCombo(storageValue: ""))
        XCTAssertNil(HotKeyCombo(storageValue: "cmd+banana"))
        XCTAssertNil(HotKeyCombo(storageValue: "hyper+45"))
        XCTAssertNil(HotKeyCombo(storageValue: "45"), "a shortcut needs a modifier")
        XCTAssertNil(HotKeyCombo(storageValue: "shift+45"), "shift alone would swallow typing")
    }

    func testRequestPathForCacheKey() {
        XCTAssertEqual(FileCacheKey.requestPath(forKey: "/api/files/abc/My file (1).png"), "/api/files/abc/My%20file%20(1).png")
        XCTAssertEqual(FileCacheKey.requestPath(forKey: "/api/files/abc/100%.png"), "/api/files/abc/100%25.png")
        XCTAssertEqual(FileCacheKey.requestPath(forKey: "/api/files/abc/a?b#c.png"), "/api/files/abc/a%3Fb%23c.png")
        // and back again to the same key
        XCTAssertEqual(FileCacheKey.key(for: "/api/files/abc/My%20file%20(1).png"), "/api/files/abc/My file (1).png")
    }

    func testDeviceIdentityIsStable() throws {
        let file = try TestSupport.temporaryDirectory().appendingPathComponent("device.json")
        let first = DeviceIdentity.load(from: file, defaultName: "Test Mac")
        let second = DeviceIdentity.load(from: file, defaultName: "Renamed Mac")
        XCTAssertEqual(first.deviceId, second.deviceId)
        XCTAssertEqual(second.deviceName, "Renamed Mac")
        XCTAssertEqual(first.deviceId, first.deviceId.lowercased())
    }

    func testMeetingModels() {
        XCTAssertNotNil(MeetingModels.model(id: MeetingModels.defaultModel))
        XCTAssertTrue(MeetingModels.defaultModel.contains("large-v3"))
        XCTAssertTrue(MeetingModels.defaultModel.contains("turbo"))
        XCTAssertNotNil(MeetingModels.model(id: "openai_whisper-tiny"))
        XCTAssertEqual(Set(MeetingModels.all.map(\.id)).count, MeetingModels.all.count)
    }
}
