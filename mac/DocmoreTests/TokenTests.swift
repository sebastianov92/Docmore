import XCTest

final class TokenTests: XCTestCase {
    private func store() throws -> FileTokenStore {
        FileTokenStore(file: try TestSupport.temporaryDirectory().appendingPathComponent("tokens.json"))
    }

    func testFileTokenStoreRoundTripAndPermissions() throws {
        let dir = try TestSupport.temporaryDirectory()
        let file = dir.appendingPathComponent("tokens.json")
        let store = FileTokenStore(file: file)
        XCTAssertNil(store.load(profileId: "p1"))
        let tokens = TokenSet(accessToken: "a", refreshToken: "r", expiresAt: Date(timeIntervalSince1970: 2_000_000_000))
        try store.save(tokens, profileId: "p1")
        try store.save(TokenSet(accessToken: "a2", refreshToken: "r2", expiresAt: Date(timeIntervalSince1970: 2_000_000_100)), profileId: "p2")
        XCTAssertEqual(FileTokenStore(file: file).load(profileId: "p1"), tokens)
        let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o600)
        store.delete(profileId: "p1")
        XCTAssertNil(store.load(profileId: "p1"))
        XCTAssertNotNil(store.load(profileId: "p2"))
    }

    func testFreshTokenIsUsedWithoutRefresh() async throws {
        let store = try store()
        try store.save(TokenSet(accessToken: "fresh", refreshToken: "r", expiresAt: Date().addingTimeInterval(3000)), profileId: "p")
        let calls = Recorder()
        let manager = TokenManager(store: store) { _, _ in
            calls.add("refresh")
            return TokenSet(accessToken: "new", refreshToken: "r2", expiresAt: Date().addingTimeInterval(3600))
        }
        let token = try await manager.accessToken(profileId: "p")
        XCTAssertEqual(token, "fresh")
        XCTAssertTrue(calls.values.isEmpty)
    }

    func testExpiringTokenIsRenewedAndRotatedRefreshTokenStored() async throws {
        let store = try store()
        try store.save(TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: Date().addingTimeInterval(10)), profileId: "p")
        let seen = Recorder()
        let manager = TokenManager(store: store) { _, current in
            seen.add(current.refreshToken)
            return TokenSet(accessToken: "new", refreshToken: "r2", expiresAt: Date().addingTimeInterval(3600))
        }
        let token = try await manager.accessToken(profileId: "p")
        XCTAssertEqual(token, "new")
        XCTAssertEqual(seen.values, ["r1"])
        XCTAssertEqual(store.load(profileId: "p")?.refreshToken, "r2")
    }

    func testConcurrentUnauthorizedCallersShareOneRefresh() async throws {
        let store = try store()
        try store.save(TokenSet(accessToken: "stale", refreshToken: "r1", expiresAt: Date().addingTimeInterval(3000)), profileId: "p")
        let calls = Recorder()
        let manager = TokenManager(store: store) { _, current in
            calls.add(current.refreshToken)
            try await Task.sleep(nanoseconds: 150_000_000)
            return TokenSet(accessToken: "renewed", refreshToken: "r2", expiresAt: Date().addingTimeInterval(3600))
        }
        let results = try await withThrowingTaskGroup(of: String.self) { group -> [String] in
            for _ in 0..<25 {
                group.addTask { try await manager.accessTokenAfterUnauthorized(profileId: "p", failedToken: "stale") }
            }
            var collected: [String] = []
            for try await value in group { collected.append(value) }
            return collected
        }
        XCTAssertEqual(results.count, 25)
        XCTAssertTrue(results.allSatisfy { $0 == "renewed" })
        XCTAssertEqual(calls.values, ["r1"], "exactly one refresh, with the token that was stored")
    }

    func testLateUnauthorizedCallerGetsTheAlreadyRenewedToken() async throws {
        let store = try store()
        try store.save(TokenSet(accessToken: "stale", refreshToken: "r1", expiresAt: Date().addingTimeInterval(3000)), profileId: "p")
        let calls = Recorder()
        let manager = TokenManager(store: store) { _, _ in
            calls.add("refresh")
            return TokenSet(accessToken: "renewed", refreshToken: "r2", expiresAt: Date().addingTimeInterval(3600))
        }
        let first = try await manager.accessTokenAfterUnauthorized(profileId: "p", failedToken: "stale")
        // a request that was sent with the stale token and failed after the refresh
        let second = try await manager.accessTokenAfterUnauthorized(profileId: "p", failedToken: "stale")
        XCTAssertEqual(first, "renewed")
        XCTAssertEqual(second, "renewed")
        XCTAssertEqual(calls.values.count, 1)
    }

    func testRefusedRefreshMarksTheAccountAndKeepsTokens() async throws {
        let store = try store()
        try store.save(TokenSet(accessToken: "stale", refreshToken: "dead", expiresAt: Date().addingTimeInterval(3000)), profileId: "p")
        let flagged = Recorder()
        let manager = TokenManager(store: store) { _, _ in
            throw OAuthError.invalidGrant("Unknown refresh token")
        }
        await manager.onNeedsSignIn { flagged.add($0) }
        do {
            _ = try await manager.accessTokenAfterUnauthorized(profileId: "p", failedToken: "stale")
            XCTFail("expected needsSignIn")
        } catch let error as TokenError {
            XCTAssertEqual(error, .needsSignIn)
        }
        XCTAssertEqual(flagged.values, ["p"])
        XCTAssertNotNil(store.load(profileId: "p"), "local data is kept until the person decides")
    }

    func testNetworkFailureDuringRefreshIsNotASignOut() async throws {
        let store = try store()
        try store.save(TokenSet(accessToken: "stale", refreshToken: "r1", expiresAt: Date().addingTimeInterval(3000)), profileId: "p")
        let flagged = Recorder()
        let manager = TokenManager(store: store) { _, _ in
            throw OAuthError.unreachable("offline")
        }
        await manager.onNeedsSignIn { flagged.add($0) }
        do {
            _ = try await manager.accessTokenAfterUnauthorized(profileId: "p", failedToken: "stale")
            XCTFail("expected an error")
        } catch let error as OAuthError {
            XCTAssertEqual(error, .unreachable("offline"))
        }
        XCTAssertTrue(flagged.values.isEmpty)
    }

    func testSignedOutAccountHasNoToken() async throws {
        let manager = TokenManager(store: try store()) { _, current in current }
        do {
            _ = try await manager.accessToken(profileId: "nobody")
            XCTFail("expected signedOut")
        } catch let error as TokenError {
            XCTAssertEqual(error, .signedOut)
        }
    }

    func testOAuthClientCalls() async throws {
        let transport = StubTransport()
        let fixed = Date(timeIntervalSince1970: 1_800_000_000)
        let client = OAuthClient(serverURL: URL(string: "http://localhost:3100")!, transport: transport, now: { fixed })

        transport.enqueue(status: 200, body: #"{"data":{"app":"docmore","version":"0.97.0","clientHash":"abc","sync":1},"success":true,"status":200}"#)
        let info = try await client.serverInfo()
        XCTAssertEqual(info, ServerInfo(app: "docmore", version: "0.97.0", clientHash: "abc", sync: 1))

        transport.enqueue(status: 201, body: #"{"client_id":"client-9","client_name":"x"}"#)
        let clientId = try await client.register(deviceName: "Test Mac")
        XCTAssertEqual(clientId, "client-9")

        transport.enqueue(status: 200, body: #"{"access_token":"at","refresh_token":"rt","expires_in":3600,"scope":"app"}"#)
        let tokens = try await client.exchange(code: "code-1", clientId: clientId, verifier: "ver")
        XCTAssertEqual(tokens, TokenSet(accessToken: "at", refreshToken: "rt", expiresAt: fixed.addingTimeInterval(3600)))

        transport.enqueue(status: 400, body: #"{"error":"invalid_grant","error_description":"Unknown refresh token","message":"Unknown refresh token"}"#)
        do {
            _ = try await client.refresh(refreshToken: "bad", clientId: clientId)
            XCTFail("expected invalidGrant")
        } catch let error as OAuthError {
            XCTAssertEqual(error, .invalidGrant("Unknown refresh token"))
        }

        let recorded = transport.recorded
        XCTAssertEqual(recorded.map { $0.url!.path }, ["/api/sync/info", "/api/oauth/register", "/api/oauth/token", "/api/oauth/token"])
        let register = try XCTUnwrap(JSONSerialization.jsonObject(with: recorded[1].httpBody!) as? [String: Any])
        XCTAssertEqual(register["client_name"] as? String, "Docmore for Mac (Test Mac)")
        XCTAssertEqual(register["redirect_uris"] as? [String], ["docmore://oauth/callback"])
        XCTAssertEqual(register["token_endpoint_auth_method"] as? String, "none")
        XCTAssertEqual(register["scope"] as? String, "app")
        let exchange = try XCTUnwrap(JSONSerialization.jsonObject(with: recorded[2].httpBody!) as? [String: String])
        XCTAssertEqual(exchange, ["grant_type": "authorization_code", "code": "code-1", "redirect_uri": "docmore://oauth/callback", "client_id": "client-9", "code_verifier": "ver"])
        let refresh = try XCTUnwrap(JSONSerialization.jsonObject(with: recorded[3].httpBody!) as? [String: String])
        XCTAssertEqual(refresh, ["grant_type": "refresh_token", "refresh_token": "bad", "client_id": "client-9"])
    }

    func testServerInfoRejectsOtherServers() async throws {
        let transport = StubTransport()
        let client = OAuthClient(serverURL: URL(string: "http://localhost:3100")!, transport: transport)
        transport.enqueue(status: 200, body: "<html>hello</html>")
        do {
            _ = try await client.serverInfo()
            XCTFail("expected malformedResponse")
        } catch let error as OAuthError {
            XCTAssertEqual(error, .malformedResponse)
        }
        transport.enqueue(status: 404, body: "{}")
        do {
            _ = try await client.serverInfo()
            XCTFail("expected http error")
        } catch let error as OAuthError {
            XCTAssertEqual(error, .http(404, ""))
        }
    }
}
