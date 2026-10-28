// @pkey-feature identity.redirect.web identity.signin.hints
//
// I-10b.11: the redirect channel of `identity.signIn.start` beyond what a recording shows: the
// session is single use, a refusal never wipes the device's token, a bad callback sends nothing,
// and the endpoints come from discovery or not at all. The wire conversation itself is the
// transcripts' (`redirect-web-*`, `locker-redirect-web`, `identity-request-hints`).

import Foundation
import PolarisKey
import PolarisKeyCore
import XCTest

@testable import PolarisKeyIdentity

final class RedirectSessionTests: XCTestCase {
    private var server = StubServer()
    private let api = "https://key.example/djdl"
    private let redirect = "https://app.example/cb"
    private let tokenPath = "/djdl/identity/token"

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func discovery(identity: String? = nil) async {
        let fragment =
            identity
            ?? #"{"enabled":true,"configured":true,"issuer":"\#(api)/identity","endpoints":{"authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token"}}"#
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body: #"{"product":"djdl","services":{"identity":\#(fragment)}}"#)
    }

    private let tokenOk =
        #"{"access_token":"pkeyt_new","token_type":"Bearer","scope":"profile email","schemaVersion":1,"device":{"id":"D"},"license":{"id":"lic_1"},"subject":"ps_abc"}"#

    private func client(token: String? = nil) async throws -> PolarisKeyClient {
        let store = InMemoryStore(deviceId: "dev")
        if let token { await store.setToken(token) }
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.identity], fingerprint: false))
        c.identity.redirectAcquisitionSync.set(false)
        return c
    }

    private func begin(_ c: PolarisKeyClient, hints: Bool = false) async throws -> (SignInSession, String) {
        let s = try await c.identity.signIn.start(
            SignInOptions(
                channel: .redirect, redirectUri: redirect, loginHint: hints ? "ada@example.com" : nil))
        let url = try XCTUnwrap(s.authorizeUrl)
        let state = try XCTUnwrap(
            URLComponents(string: url)?.queryItems?.first(where: { $0.name == "state" })?.value)
        return (s, state)
    }

    private func callback(_ state: String, _ q: String = "code=C0DE") -> String {
        "\(redirect)?\(q)&state=\(state)&iss=https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity"
    }

    private func tokenCalls() async -> [PolarisRequest] { await server.requests(forPath: tokenPath) }

    func testBuildsTheAuthorizeUrlFromDiscoveryAndRedeemsTheCodeWithAForm() async throws {
        await discovery()
        await server.reply(tokenPath, body: tokenOk)
        let c = try await client()
        let (s, state) = try await begin(c, hints: true)
        XCTAssertEqual(s.channel, .redirect)
        let url = try XCTUnwrap(URLComponents(string: try XCTUnwrap(s.authorizeUrl)))
        XCTAssertEqual("\(url.scheme!)://\(url.host!)\(url.path)", "\(api)/identity/authorize")
        func param(_ n: String) -> String? { url.queryItems?.first(where: { $0.name == n })?.value }
        XCTAssertEqual(param("client_id"), "djdl")
        XCTAssertEqual(param("code_challenge_method"), "S256")
        XCTAssertEqual(param("login_hint"), "ada@example.com")
        XCTAssertNil(param("code_verifier"))
        XCTAssertEqual(s.outcome, .pending)

        let outcome = try await s.complete(callbackUrl: callback(state))
        guard case .signedIn(let ready) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(ready.subject, "ps_abc")
        XCTAssertEqual(ready.scope, "profile email")
        XCTAssertEqual(ready.licenseId, "lic_1")
        XCTAssertEqual(s.outcome, outcome)
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_new")
        let calls = await tokenCalls()
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].headers["content-type"], "application/x-www-form-urlencoded")
        let body = String(decoding: try XCTUnwrap(calls[0].body), as: UTF8.self)
        XCTAssertTrue(body.hasPrefix("grant_type=authorization_code&client_id=djdl&code=C0DE&code_verifier="))
        XCTAssertTrue(body.contains("&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"), body)
        XCTAssertNil(calls[0].headers["authorization"])
    }

    func testTheSessionIsSingleUse() async throws {
        await discovery()
        await server.reply(tokenPath, body: tokenOk)
        let c = try await client()
        let (s, state) = try await begin(c)
        _ = try await s.complete(callbackUrl: callback(state))
        do {
            _ = try await s.complete(callbackUrl: callback(state))
            XCTFail("a replayed callback was accepted")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
        let calls = await tokenCalls()
        XCTAssertEqual(calls.count, 1, "the replay never reached the token endpoint")
    }

    func testABadCallbackSendsNothingAndKeepsTheToken() async throws {
        await discovery()
        let c = try await client(token: "pkeyt_old")
        for url in [
            "\(redirect)?code=c&state=wrong-state-0123456789&iss=https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity",
            "https://evil.example/cb?code=c",
        ] {
            let (s, _) = try await begin(c)
            do {
                _ = try await s.complete(callbackUrl: url)
                XCTFail("accepted \(url)")
            } catch let e as SignInError {
                XCTAssertEqual(e.code, ErrorCode.signInFailed)
            }
        }
        let calls = await tokenCalls()
        XCTAssertTrue(calls.isEmpty)
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_old")
    }

    func testAccessDeniedIsACancelledOutcome() async throws {
        await discovery()
        let c = try await client()
        let (s, state) = try await begin(c)
        let outcome = try await s.complete(
            callbackUrl: callback(state, "error=access_denied"))
        XCTAssertEqual(outcome, .cancelled)
        let calls = await tokenCalls()
        XCTAssertTrue(calls.isEmpty)
    }

    func testTheWorkersRefusalIsTypedAndKeepsTheToken() async throws {
        await discovery()
        await server.reply(tokenPath, status: 400, body: #"{"error":"invalid_grant"}"#)
        let c = try await client(token: "pkeyt_old")
        let (s, state) = try await begin(c)
        do {
            _ = try await s.complete(callbackUrl: callback(state))
            XCTFail("expected invalid_grant")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, "invalid_grant")
        }
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_old")
    }

    func testARateLimitCarriesItsRetryAfter() async throws {
        await discovery()
        await server.route(tokenPath) { _ in
            StubServer.Reply(
                status: 429, body: #"{"error":"rate_limited"}"#, headers: ["Retry-After": "7"])
        }
        let c = try await client()
        let (s, state) = try await begin(c)
        do {
            _ = try await s.complete(callbackUrl: callback(state))
            XCTFail("expected rate_limited")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, "rate_limited")
            XCTAssertEqual(e.retryAfterSeconds, 7)
        }
    }

    func testAFiveHundredIsServerError() async throws {
        await discovery()
        await server.reply(tokenPath, status: 502, body: "bad gateway")
        let c = try await client()
        let (s, state) = try await begin(c)
        do {
            _ = try await s.complete(callbackUrl: callback(state))
            XCTFail("expected server-error")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, ErrorCode.serverError)
        }
    }

    func testCancelDropsThePendingRequest() async throws {
        await discovery()
        let c = try await client()
        let (s, state) = try await begin(c)
        s.cancel()
        XCTAssertEqual(s.outcome, .cancelled)
        do {
            _ = try await s.complete(callbackUrl: callback(state))
            XCTFail("a cancelled session completed")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
        let calls = await tokenCalls()
        XCTAssertTrue(calls.isEmpty)
    }

    func testWithoutEndpointsInDiscoveryThereIsNoRedirectSignIn() async throws {
        await discovery(identity: #"{"enabled":true,"configured":true}"#)
        let c = try await client()
        do {
            _ = try await c.identity.signIn.start(SignInOptions(channel: .redirect, redirectUri: redirect))
            XCTFail("expected sign-in-unavailable")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.signInUnavailable)
        }
    }

    func testATokenEndpointOffTheProductIsRefused() async throws {
        await discovery(
            identity:
                #"{"enabled":true,"configured":true,"issuer":"\#(api)/identity","endpoints":{"authorize":"\#(api)/identity/authorize","token":"https://evil.example/token"}}"#
        )
        let c = try await client()
        do {
            _ = try await c.identity.signIn.start(SignInOptions(channel: .redirect, redirectUri: redirect))
            XCTFail("expected bad_response")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.badResponse)
        }
    }

    func testAProductWithoutIdentityRefusesBeforeAnyRequest() async throws {
        await server.reply(
            "/djdl/.well-known/polaris.json", body: #"{"product":"djdl","services":{}}"#)
        let c = try await client()
        do {
            _ = try await c.identity.signIn.start(SignInOptions(channel: .redirect, redirectUri: redirect))
            XCTFail("expected service-unavailable")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
        }
    }

    func testAMissingOrBadRedirectUriIsInvalidArgument() async throws {
        await discovery()
        let c = try await client()
        for uri in [nil, "http://app.example/cb"] {
            do {
                _ = try await c.identity.signIn.start(SignInOptions(channel: .redirect, redirectUri: uri))
                XCTFail("accepted \(uri ?? "nil")")
            } catch let e as PolarisError {
                XCTAssertEqual(e.code, ErrorCode.invalidArgument)
            }
        }
    }

    func testCompleteBelongsToTheRedirectChannel() async throws {
        await server.reply(
            "/djdl/identity/auth/device/start",
            body:
                #"{"deviceCode":"dc","userCode":"ABCD-EFGH","verificationUri":"https://key.example/d","verificationUriComplete":"https://key.example/d?user_code=ABCD-EFGH","expiresIn":600,"interval":1}"#
        )
        let c = try await client()
        let s = try await c.identity.signIn.start()
        XCTAssertEqual(s.channel, .deviceCode)
        XCTAssertNil(s.authorizeUrl)
        do {
            _ = try await s.complete(callbackUrl: redirect)
            XCTFail("expected invalid-argument")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.invalidArgument)
        }
    }
}
