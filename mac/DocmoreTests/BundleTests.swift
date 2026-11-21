import XCTest

final class BundleTests: XCTestCase {
    private func file(_ path: String, _ content: String) -> (BundleFile, Data) {
        let data = Data(content.utf8)
        return (BundleFile(path: path, size: data.count, hash: BundleVerifier.hash32(data)), data)
    }

    private func manifest(_ entries: [(BundleFile, Data)], version: String = "1.0.0") -> BundleManifest {
        let files = entries.map(\.0).sorted { $0.path < $1.path }
        let hash = BundleVerifier.hash32(Data(files.map { "\($0.path):\($0.hash)" }.joined(separator: "\n").utf8))
        return BundleManifest(hash: hash, version: version, files: files)
    }

    func testHash32IsTheFirstHalfOfSha256() {
        // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        XCTAssertEqual(BundleVerifier.hash32(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223")
        XCTAssertTrue(BundleVerifier.matches(Data("abc".utf8), expected: "BA7816BF8F01CFEA414140DE5DAE2223"))
        XCTAssertFalse(BundleVerifier.matches(Data("abd".utf8), expected: "ba7816bf8f01cfea414140de5dae2223"))
    }

    func testDecodeWrappedAndBare() throws {
        let bare = #"{"hash":"0123456789abcdef0123456789abcdef","version":"0.97.0","files":[{"path":"index.html","size":3,"hash":"ba7816bf8f01cfea414140de5dae2223"}]}"#
        let wrapped = #"{"data":\#(bare),"success":true,"status":200}"#
        let a = try BundleManifest.decode(Data(bare.utf8))
        let b = try BundleManifest.decode(Data(wrapped.utf8))
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.files.first?.path, "index.html")
        XCTAssertEqual(a.totalSize, 3)
    }

    func testValidateRejectsUnsafeManifests() {
        let good = file("index.html", "<html>")
        XCTAssertNoThrow(try manifest([good]).validate())
        XCTAssertThrowsError(try manifest([file("assets/a.js", "x")]).validate())
        for bad in ["../evil.js", "/abs.js", "a//b.js", "a/./b.js", "a/../b.js", "a\\b.js", ""] {
            XCTAssertFalse(BundleVerifier.isSafePath(bad), bad)
            let files = [good.0, BundleFile(path: bad, size: 1, hash: good.0.hash)]
            XCTAssertThrowsError(try BundleManifest(hash: good.0.hash, version: "1", files: files).validate(), bad)
        }
        XCTAssertThrowsError(try BundleManifest(hash: "nothex", version: "1", files: [good.0]).validate())
        XCTAssertThrowsError(try BundleManifest(hash: good.0.hash, version: "1", files: [good.0, good.0]).validate())
    }

    func testPlanReusesUnchangedFiles() {
        let index = file("index.html", "v2")
        let same = file("assets/app.js", "same")
        let changed = file("assets/style.css", "new")
        let added = file("assets/extra.js", "extra")
        let next = manifest([index, same, changed, added])
        let installed = [
            "index.html": "00000000000000000000000000000000",
            "assets/app.js": same.0.hash,
            "assets/style.css": "11111111111111111111111111111111",
            "assets/gone.js": "22222222222222222222222222222222",
        ]
        let plan = BundlePlan.make(manifest: next, installed: installed)
        XCTAssertEqual(plan.reuse.map(\.path), ["assets/app.js"])
        XCTAssertEqual(Set(plan.download.map(\.path)), ["index.html", "assets/style.css", "assets/extra.js"])
        XCTAssertEqual(plan.downloadSize, index.1.count + changed.1.count + added.1.count)
    }

    func testInstallSwitchKeepPreviousAndReuse() async throws {
        let dir = try TestSupport.temporaryDirectory()
        let store = BundleStore(directory: dir)
        XCTAssertNil(store.current)

        let v1 = [file("index.html", "one"), file("assets/app.js", "app"), file("assets/old.js", "old")]
        let m1 = manifest(v1)
        let fetched1 = Recorder()
        try await store.install(manifest: m1, fetch: { requested in
            fetched1.add(requested.path)
            return v1.first { $0.0.path == requested.path }!.1
        })
        XCTAssertEqual(store.current?.hash, m1.hash)
        XCTAssertNil(store.current?.previousHash)
        XCTAssertEqual(Set(fetched1.values), ["index.html", "assets/app.js", "assets/old.js"])
        XCTAssertEqual(try String(contentsOf: store.fileURL(path: "index.html", pinnedHash: nil)!), "one")

        // second version: app.js unchanged, index changed, old.js gone, new.js added
        let v2 = [file("index.html", "two"), file("assets/app.js", "app"), file("assets/new.js", "new")]
        let m2 = manifest(v2, version: "1.0.1")
        let fetched2 = Recorder()
        try await store.install(manifest: m2, fetch: { requested in
            fetched2.add(requested.path)
            return v2.first { $0.0.path == requested.path }!.1
        })
        XCTAssertEqual(Set(fetched2.values), ["index.html", "assets/new.js"], "the unchanged file is reused, not downloaded")
        XCTAssertEqual(store.current?.hash, m2.hash)
        XCTAssertEqual(store.current?.previousHash, m1.hash)
        XCTAssertEqual(try String(contentsOf: store.fileURL(path: "index.html", pinnedHash: nil)!), "two")
        // a page opened with the first bundle still gets its own files
        XCTAssertEqual(try String(contentsOf: store.fileURL(path: "index.html", pinnedHash: m1.hash)!), "one")
        XCTAssertNotNil(store.fileURL(path: "assets/old.js", pinnedHash: nil), "falls back to the previous bundle")
        XCTAssertNil(store.fileURL(path: "assets/missing.js", pinnedHash: nil))
        XCTAssertNil(store.fileURL(path: "../current.json", pinnedHash: nil))

        // a fresh store on the same folder sees the same state
        XCTAssertEqual(BundleStore(directory: dir).current, store.current)

        // third version: the first one is no longer current nor previous
        let v3 = [file("index.html", "three")]
        let m3 = manifest(v3, version: "1.0.2")
        try await store.install(manifest: m3, fetch: { _ in v3[0].1 })
        store.prune()
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.folder(for: m1.hash).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.folder(for: m2.hash).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.folder(for: m3.hash).path))
    }

    func testInstallRefusesCorruptDownloadAndKeepsCurrent() async throws {
        let dir = try TestSupport.temporaryDirectory()
        let store = BundleStore(directory: dir)
        let v1 = [file("index.html", "one")]
        let m1 = manifest(v1)
        try await store.install(manifest: m1, fetch: { _ in v1[0].1 })

        let v2 = [file("index.html", "two"), file("assets/app.js", "app")]
        let m2 = manifest(v2)
        do {
            try await store.install(manifest: m2, fetch: { requested in
                requested.path == "assets/app.js" ? Data("tampered".utf8) : v2[0].1
            })
            XCTFail("a file with the wrong checksum must not install")
        } catch let error as BundleError {
            XCTAssertEqual(error, .hashMismatch(path: "assets/app.js"))
        }
        XCTAssertEqual(store.current?.hash, m1.hash, "the working bundle stays current")
        XCTAssertEqual(try String(contentsOf: store.fileURL(path: "index.html", pinnedHash: nil)!), "one")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.folder(for: m2.hash).path))
        store.prune()
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".partial") }
        XCTAssertTrue(leftovers.isEmpty)
    }

    func testInstallOfCurrentHashDownloadsNothing() async throws {
        let dir = try TestSupport.temporaryDirectory()
        let store = BundleStore(directory: dir)
        let v1 = [file("index.html", "one")]
        let m1 = manifest(v1)
        try await store.install(manifest: m1, fetch: { _ in v1[0].1 })
        let recorder = Recorder()
        try await store.install(manifest: m1, fetch: { requested in
            recorder.add(requested.path)
            return v1[0].1
        })
        XCTAssertTrue(recorder.values.isEmpty)
    }
}

final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []

    func add(_ value: String) {
        lock.lock(); defer { lock.unlock() }
        items.append(value)
    }

    var values: [String] {
        lock.lock(); defer { lock.unlock() }
        return items
    }
}
