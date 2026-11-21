import XCTest

final class PKCETests: XCTestCase {
    func testChallengeMatchesRFC7636Example() {
        // Appendix B of RFC 7636
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        XCTAssertEqual(PKCE.challenge(for: verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(PKCE(verifier: verifier).challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testGeneratedVerifierIsURLSafeAndLongEnough() {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        for _ in 0..<20 {
            let pkce = PKCE.generate()
            XCTAssertGreaterThanOrEqual(pkce.verifier.count, 43)
            XCTAssertLessThanOrEqual(pkce.verifier.count, 128)
            XCTAssertTrue(pkce.verifier.unicodeScalars.allSatisfy { allowed.contains($0) })
            XCTAssertEqual(pkce.challenge.count, 43)
        }
    }

    func testVerifiersDiffer() {
        XCTAssertNotEqual(PKCE.generate().verifier, PKCE.generate().verifier)
    }

    func testBase64URLHasNoPadding() {
        XCTAssertEqual(PKCE.base64URL(Data([0xfb, 0xff])), "-_8")
    }

    func testAuthorizeURL() throws {
        let client = OAuthClient(serverURL: URL(string: "https://wiki.example.com")!, transport: StubTransport())
        let url = client.authorizeURL(clientId: "abc", challenge: "CHAL", state: "st")
        let text = url.absoluteString
        XCTAssertTrue(text.hasPrefix("https://wiki.example.com/oauth/consent?"))
        XCTAssertTrue(text.contains("redirect_uri=docmore%3A%2F%2Foauth%2Fcallback"))
        XCTAssertTrue(text.contains("response_type=code"))
        XCTAssertTrue(text.contains("client_id=abc"))
        XCTAssertTrue(text.contains("code_challenge=CHAL"))
        XCTAssertTrue(text.contains("code_challenge_method=S256"))
        XCTAssertTrue(text.contains("scope=app"))
        XCTAssertTrue(text.contains("state=st"))
    }

    func testParseCallback() {
        let ok = OAuthClient.parseCallback(URL(string: "docmore://oauth/callback?code=xyz&state=s1")!)
        XCTAssertEqual(ok.code, "xyz")
        XCTAssertEqual(ok.state, "s1")
        XCTAssertNil(ok.error)
        let denied = OAuthClient.parseCallback(URL(string: "docmore://oauth/callback?error=access_denied&state=s1")!)
        XCTAssertNil(denied.code)
        XCTAssertEqual(denied.error, "access_denied")
    }
}

/// Answers canned responses and records what was asked.
final class StubTransport: HTTPTransport, @unchecked Sendable {
    struct Canned {
        let status: Int
        let body: String
    }

    private let lock = NSLock()
    private var queue: [Canned] = []
    private(set) var requests: [URLRequest] = []
    var failure: Error?

    func enqueue(status: Int, body: String) {
        lock.lock(); defer { lock.unlock() }
        queue.append(Canned(status: status, body: body))
    }

    var recorded: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return requests
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.lock()
        requests.append(request)
        let next = queue.isEmpty ? nil : queue.removeFirst()
        let failure = self.failure
        lock.unlock()
        if let failure { throw failure }
        guard let next else { throw URLError(.badServerResponse) }
        let response = HTTPURLResponse(url: request.url!, statusCode: next.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (Data(next.body.utf8), response)
    }
}
