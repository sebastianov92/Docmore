import XCTest

final class ProfileTests: XCTestCase {
    func testProfileIdIsStableAndSixteenHex() {
        let first = ProfileID.make(serverURL: "https://wiki.example.com", userId: "user-1")
        let second = ProfileID.make(serverURL: "https://wiki.example.com", userId: "user-1")
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.count, 16)
        XCTAssertTrue(ProfileID.isValid(first))
        // sha256("https://wiki.example.com\nuser-1") computed independently
        XCTAssertEqual(first, String(Hashing.sha256Hex("https://wiki.example.com\nuser-1").prefix(16)))
    }

    func testProfileIdDiffersByServerAndUser() {
        let base = ProfileID.make(serverURL: "https://a.example.com", userId: "u1")
        XCTAssertNotEqual(base, ProfileID.make(serverURL: "https://b.example.com", userId: "u1"))
        XCTAssertNotEqual(base, ProfileID.make(serverURL: "https://a.example.com", userId: "u2"))
    }

    func testProfileIdIgnoresSpellingOfTheServer() {
        let canonical = ProfileID.make(serverURL: "https://wiki.example.com", userId: "u")
        XCTAssertEqual(canonical, ProfileID.make(serverURL: "https://WIKI.example.com/", userId: "u"))
        XCTAssertEqual(canonical, ProfileID.make(serverURL: "https://wiki.example.com:443", userId: "u"))
    }

    func testIsValid() {
        XCTAssertTrue(ProfileID.isValid("0123456789abcdef"))
        XCTAssertFalse(ProfileID.isValid("0123456789ABCDEF"))
        XCTAssertFalse(ProfileID.isValid("0123"))
        XCTAssertFalse(ProfileID.isValid("0123456789abcdeg"))
    }

    func testDataStoreUUIDIsDeterministicAndIsolatedByDataRoot() {
        let real = ProfileID.dataStoreUUID(profileId: "0123456789abcdef", dataRoot: nil)
        XCTAssertEqual(real, ProfileID.dataStoreUUID(profileId: "0123456789abcdef", dataRoot: nil))
        let test = ProfileID.dataStoreUUID(profileId: "0123456789abcdef", dataRoot: "/tmp/run-1")
        XCTAssertNotEqual(real, test)
        XCTAssertNotEqual(test, ProfileID.dataStoreUUID(profileId: "0123456789abcdef", dataRoot: "/tmp/run-2"))
        XCTAssertNotEqual(real, ProfileID.dataStoreUUID(profileId: "fedcba9876543210", dataRoot: nil))
    }

    func testNormalizeServerAddress() {
        XCTAssertEqual(ServerAddress.normalize("wiki.example.com")?.absoluteString, "https://wiki.example.com")
        XCTAssertEqual(ServerAddress.normalize(" HTTP://Localhost:3100/ ")?.absoluteString, "http://localhost:3100")
        XCTAssertEqual(ServerAddress.normalize("https://wiki.example.com/s/general?x=1#y")?.absoluteString, "https://wiki.example.com")
        XCTAssertEqual(ServerAddress.normalize("http://host:80")?.absoluteString, "http://host")
        XCTAssertNil(ServerAddress.normalize(""))
        XCTAssertNil(ServerAddress.normalize("ftp://host"))
    }

    func testCandidatesPreferHTTPForLocalHosts() {
        XCTAssertEqual(ServerAddress.candidates("localhost:3100").map(\.absoluteString), ["http://localhost:3100", "https://localhost:3100"])
        XCTAssertEqual(ServerAddress.candidates("192.168.1.20:3000").first?.absoluteString, "http://192.168.1.20:3000")
        XCTAssertEqual(ServerAddress.candidates("wiki.example.com").map(\.absoluteString), ["https://wiki.example.com", "http://wiki.example.com"])
        XCTAssertEqual(ServerAddress.candidates("http://wiki.example.com").map(\.absoluteString), ["http://wiki.example.com"])
    }

    func testProfileStorePersists() throws {
        let dir = try TestSupport.temporaryDirectory()
        let file = dir.appendingPathComponent("profiles.json")
        let store = ProfileStore(file: file)
        XCTAssertNil(store.activeProfile)
        let profile = Profile(id: "0123456789abcdef", serverURL: "http://localhost:3100", clientId: "c", userId: "u", userName: "Ana", userEmail: "ana@example.com", workspaceName: "W")
        store.upsert(profile)
        store.setActive(profile.id)
        store.setClientId("client-1", forServer: "http://localhost:3100")
        store.update(id: profile.id) { $0.needsSignIn = true }

        let reopened = ProfileStore(file: file)
        XCTAssertEqual(reopened.profiles.count, 1)
        XCTAssertEqual(reopened.activeProfile?.id, profile.id)
        XCTAssertEqual(reopened.profile(id: profile.id)?.needsSignIn, true)
        XCTAssertEqual(reopened.clientId(forServer: "http://localhost:3100"), "client-1")
        XCTAssertEqual(reopened.activeProfile?.appOrigin, "docmore-app://0123456789abcdef")

        reopened.remove(id: profile.id)
        XCTAssertTrue(ProfileStore(file: file).profiles.isEmpty)
    }

    func testAppPathsHonourTheOverride() {
        let overridden = AppPaths.resolve(environment: ["DOCMORE_DATA_DIR": "/tmp/docmore-x"])
        XCTAssertTrue(overridden.isOverridden)
        XCTAssertEqual(overridden.root.path, "/tmp/docmore-x")
        XCTAssertNotNil(overridden.defaultsSuiteName)
        XCTAssertEqual(overridden.bundleDir("abc").path, "/tmp/docmore-x/profiles/abc/bundle")
        XCTAssertEqual(overridden.filesDir("abc").path, "/tmp/docmore-x/profiles/abc/files")

        let normal = AppPaths.resolve(environment: [:])
        XCTAssertFalse(normal.isOverridden)
        XCTAssertNil(normal.defaultsSuiteName)
        XCTAssertTrue(normal.root.path.hasSuffix("Application Support/Docmore"))
    }
}

enum TestSupport {
    static func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("docmore-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
