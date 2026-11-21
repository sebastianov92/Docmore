import XCTest

final class FileCacheTests: XCTestCase {
    func testStoreReadRemove() throws {
        let dir = try TestSupport.temporaryDirectory()
        let cache = FileCache(directory: dir)
        XCTAssertEqual(cache.usage().count, 0)
        XCTAssertFalse(cache.has("/api/files/a/one.png"))

        try cache.store(key: "/api/files/a/one.png", data: Data(repeating: 1, count: 100), contentType: "image/png")
        try cache.store(key: "/api/files/b/two.pdf", data: Data(repeating: 2, count: 50), contentType: "application/pdf")
        XCTAssertTrue(cache.has("/api/files/a/one.png"))
        XCTAssertEqual(cache.entry("/api/files/b/two.pdf")?.contentType, "application/pdf")
        XCTAssertEqual(cache.usage().bytes, 150)
        XCTAssertEqual(cache.usage().count, 2)
        XCTAssertEqual(try Data(contentsOf: cache.fileURL("/api/files/a/one.png")!), Data(repeating: 1, count: 100))

        // replacing keeps one entry
        try cache.store(key: "/api/files/a/one.png", data: Data(repeating: 3, count: 10), contentType: "image/png")
        XCTAssertEqual(cache.usage().bytes, 60)
        XCTAssertEqual(cache.usage().count, 2)

        cache.remove(keys: ["/api/files/a/one.png", "/api/files/none"])
        XCTAssertFalse(cache.has("/api/files/a/one.png"))
        XCTAssertEqual(cache.usage().count, 1)
    }

    func testIndexSurvivesReopenAndDropsEntriesWithoutBytes() throws {
        let dir = try TestSupport.temporaryDirectory()
        let cache = FileCache(directory: dir)
        try cache.store(key: "/api/files/a/one.png", data: Data("one".utf8), contentType: "image/png")
        try cache.store(key: "/api/files/b/two.png", data: Data("two".utf8), contentType: "image/png")
        let blob = try XCTUnwrap(cache.fileURL("/api/files/b/two.png"))

        let reopened = FileCache(directory: dir)
        XCTAssertEqual(Set(reopened.keys), ["/api/files/a/one.png", "/api/files/b/two.png"])
        XCTAssertEqual(reopened.entry("/api/files/a/one.png")?.size, 3)

        try FileManager.default.removeItem(at: blob)
        let afterLoss = FileCache(directory: dir)
        XCTAssertEqual(afterLoss.keys, ["/api/files/a/one.png"])
    }

    func testStoreByMovingAFile() throws {
        let dir = try TestSupport.temporaryDirectory()
        let cache = FileCache(directory: dir.appendingPathComponent("cache"))
        let source = dir.appendingPathComponent("download.tmp")
        try Data(repeating: 7, count: 2048).write(to: source)
        try cache.store(key: "/api/files/c/big.bin", movingFileAt: source, contentType: "application/octet-stream")
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        XCTAssertEqual(cache.entry("/api/files/c/big.bin")?.size, 2048)

        // again over an existing entry
        try Data(repeating: 8, count: 16).write(to: source)
        try cache.store(key: "/api/files/c/big.bin", movingFileAt: source, contentType: "application/octet-stream")
        XCTAssertEqual(try Data(contentsOf: cache.fileURL("/api/files/c/big.bin")!), Data(repeating: 8, count: 16))
    }

    func testClear() throws {
        let dir = try TestSupport.temporaryDirectory()
        let cache = FileCache(directory: dir)
        try cache.store(key: "/api/files/a/one.png", data: Data("one".utf8), contentType: "image/png")
        cache.clear()
        XCTAssertEqual(cache.usage().count, 0)
        XCTAssertEqual(cache.usage().bytes, 0)
        XCTAssertTrue(FileCache(directory: dir).keys.isEmpty)
        // still usable
        try cache.store(key: "/api/files/a/one.png", data: Data("x".utf8), contentType: "image/png")
        XCTAssertTrue(cache.has("/api/files/a/one.png"))
    }

    func testBlobNamesDoNotCollideOrLeakPaths() {
        let a = FileCache.blobName(for: "/api/files/a/../../etc/passwd")
        XCTAssertEqual(a.count, 40)
        XCTAssertFalse(a.contains("/"))
        XCTAssertNotEqual(a, FileCache.blobName(for: "/api/files/a/other"))
    }
}
