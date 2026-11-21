import XCTest

final class RoutingTests: XCTestCase {
    func testContentTypes() {
        XCTAssertEqual(ContentTypes.type(forPath: "index.html"), "text/html; charset=utf-8")
        XCTAssertEqual(ContentTypes.type(forPath: "assets/index-CTKzGTYT.js"), "text/javascript; charset=utf-8")
        XCTAssertEqual(ContentTypes.type(forPath: "assets/index-BRoFlBhf.css"), "text/css; charset=utf-8")
        XCTAssertEqual(ContentTypes.type(forPath: "locales/en-US/translation.json"), "application/json; charset=utf-8")
        XCTAssertEqual(ContentTypes.type(forPath: "assets/font.WOFF2"), "font/woff2")
        XCTAssertEqual(ContentTypes.type(forPath: "assets/font.woff"), "font/woff")
        XCTAssertEqual(ContentTypes.type(forPath: "assets/font.ttf"), "font/ttf")
        XCTAssertEqual(ContentTypes.type(forPath: "vite.svg"), "image/svg+xml")
        XCTAssertEqual(ContentTypes.type(forPath: "icons/a.png"), "image/png")
        XCTAssertEqual(ContentTypes.type(forPath: "a/b.webp"), "image/webp")
        XCTAssertEqual(ContentTypes.type(forPath: "a/b.wasm"), "application/wasm")
        XCTAssertEqual(ContentTypes.type(forPath: "unknown.xyz"), "application/octet-stream")
        XCTAssertEqual(ContentTypes.type(forPath: "noextension"), "application/octet-stream")
    }

    func testFileExtension() {
        XCTAssertEqual(ContentTypes.fileExtension(of: "/s/general/p/my-page-abc123"), "")
        XCTAssertEqual(ContentTypes.fileExtension(of: "/assets/x.min.js"), "js")
        XCTAssertEqual(ContentTypes.fileExtension(of: "/v1.2/page"), "")
        XCTAssertEqual(ContentTypes.fileExtension(of: "/.hidden"), "")
        XCTAssertEqual(ContentTypes.fileExtension(of: "/"), "")
    }

    func testApiRoutes() {
        XCTAssertEqual(RequestRouter.route(method: "POST", path: "/api/pages/create"), .api)
        XCTAssertEqual(RequestRouter.route(method: "GET", path: "/api/health/live"), .api)
        XCTAssertEqual(RequestRouter.route(method: "GET", path: "/api"), .api)
        // uploads and other writes under /api/files are plain API calls
        XCTAssertEqual(RequestRouter.route(method: "POST", path: "/api/files/upload"), .api)
        XCTAssertEqual(RequestRouter.route(method: "POST", path: "/api/attachments/upload-image"), .api)
    }

    func testCachedFileRoutes() {
        XCTAssertEqual(
            RequestRouter.route(method: "GET", path: "/api/files/0195-abc/My%20file.png"),
            .cachedFile(key: "/api/files/0195-abc/My file.png")
        )
        XCTAssertEqual(
            RequestRouter.route(method: "get", path: "/api/attachments/img/avatar/x.png"),
            .cachedFile(key: "/api/attachments/img/avatar/x.png")
        )
    }

    func testStaticRoutes() {
        XCTAssertEqual(RequestRouter.route(method: "GET", path: "/"), .staticFile(path: "index.html"))
        XCTAssertEqual(RequestRouter.route(method: "GET", path: ""), .staticFile(path: "index.html"))
        XCTAssertEqual(RequestRouter.route(method: "GET", path: "/assets/index-abc.js"), .staticFile(path: "assets/index-abc.js"))
        XCTAssertEqual(RequestRouter.route(method: "GET", path: "/s/general/p/page-1"), .staticFile(path: "s/general/p/page-1"))
        XCTAssertEqual(RequestRouter.route(method: "GET", path: "/apiary"), .staticFile(path: "apiary"))
        XCTAssertEqual(RequestRouter.route(method: "GET", path: "/assets/../../secret"), .invalid)
        XCTAssertEqual(RequestRouter.route(method: "GET", path: "/assets/%2e%2e/secret"), .invalid)
    }

    func testIndexFallbackOnlyForExtensionlessMissingPaths() {
        XCTAssertTrue(RequestRouter.servesIndexFallback(path: "s/general/p/page-1", fileExists: false))
        XCTAssertTrue(RequestRouter.servesIndexFallback(path: "home", fileExists: false))
        XCTAssertFalse(RequestRouter.servesIndexFallback(path: "assets/missing.js", fileExists: false))
        XCTAssertFalse(RequestRouter.servesIndexFallback(path: "manifest.json", fileExists: true))
        XCTAssertFalse(RequestRouter.servesIndexFallback(path: "LICENSE", fileExists: true))
    }

    func testFileCacheKeys() {
        XCTAssertEqual(FileCacheKey.key(for: "/api/files/abc/name.png"), "/api/files/abc/name.png")
        XCTAssertEqual(FileCacheKey.key(for: "/api/files/abc/name.png?t=123#frag"), "/api/files/abc/name.png")
        XCTAssertEqual(FileCacheKey.key(for: "docmore-app://0123456789abcdef/api/files/abc/a%20b.png"), "/api/files/abc/a b.png")
        XCTAssertEqual(FileCacheKey.key(for: "http://localhost:3100/api/attachments/img/avatar/x.png"), "/api/attachments/img/avatar/x.png")
        XCTAssertNil(FileCacheKey.key(for: "/api/pages/info"))
        XCTAssertNil(FileCacheKey.key(for: "files/abc"))
        XCTAssertNil(FileCacheKey.key(for: "/api/files/../../etc/passwd"))
        XCTAssertNil(FileCacheKey.key(for: "http://localhost:3100"))
    }

    func testByteRanges() {
        XCTAssertEqual(ByteRange.parse("bytes=0-99", fileSize: 1000), 0...99)
        XCTAssertEqual(ByteRange.parse("bytes=500-", fileSize: 1000), 500...999)
        XCTAssertEqual(ByteRange.parse("bytes=-100", fileSize: 1000), 900...999)
        XCTAssertEqual(ByteRange.parse("bytes=900-5000", fileSize: 1000), 900...999)
        XCTAssertNil(ByteRange.parse("bytes=1000-", fileSize: 1000))
        XCTAssertNil(ByteRange.parse("bytes=5-2", fileSize: 1000))
        XCTAssertNil(ByteRange.parse("bytes=0-1,5-9", fileSize: 1000))
        XCTAssertNil(ByteRange.parse("items=0-1", fileSize: 1000))
        XCTAssertNil(ByteRange.parse(nil, fileSize: 1000))
    }
}
