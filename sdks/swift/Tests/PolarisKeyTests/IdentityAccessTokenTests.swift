// @pkey-feature identity.accesstoken
//
// I-21b: `identity.accessToken(refresh:)` (WIRE-CONTRACT-V5 §12.13.10) over a stubbed Worker. The recorded
// conversation (identity-access-token) is replayed by `TranscriptTests`; these cover what a transcript
// cannot: the gate, the exact form, the cache bound to the device token with the 60 second margin, one
// request at a time, a 429's wait, the endpoint pinned to the Worker's origin, no redirect and the 8 KiB cap.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
import XCTest

@testable import PolarisKeyIdentity

private let jwt = "aaaa.bbbb.cccc"
private let tokenPath = "/djdl/identity/token"

private func grant(
    _ token: String = jwt, tokenType: String = "Bearer", issued: String = "urn:ietf:params:oauth:token-type:access_token",
    expiresIn: String = "600"
) -> String {
    """
    {"access_token":"\(token)","issued_token_type":"\(issued)","token_type":"\(tokenType)",\
    "expires_in":\(expiresIn),"scope":""}
    """
}

/// An exchange the test releases by hand.
private actor Gate {
    private var open = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var entered: [CheckedContinuation<Void, Never>] = []
    private var didEnter = false

    func wait() async {
        didEnter = true
        for c in entered { c.resume() }
        entered = []
        if open { return }
        await withCheckedContinuation { waiting.append($0) }
    }

    func untilEntered() async {
        if didEnter { return }
        await withCheckedContinuation { entered.append($0) }
    }

    func release() {
        open = true
        for c in waiting { c.resume() }
        waiting = []
    }
}

private final class ExchangeCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        n += 1
        return n
    }
}

final class IdentityAccessTokenTests: XCTestCase {
    private var server = StubServer()
    private let now = LockedValue<Int>(1_700_000_000)

    override func setUp() {
        super.setUp()
        server = StubServer()
        now.with { $0 = 1_700_000_000 }
    }

    private func discovery(accessToken: Bool = true, tokenURL: String? = "https://key.example/djdl/identity/token") -> String {
        let endpoint = tokenURL.map { "\"endpoints\":{\"token\":\"\($0)\"}," } ?? ""
        return """
            {"product":"djdl","services":{"license":{"enabled":true},\
            "identity":{"enabled":true,\(endpoint)"accessToken":\(accessToken)}}}
            """
    }

    private func client(
        discovery doc: String? = nil, token: String? = "pkeyt_a"
    ) async throws -> PolarisKeyClient {
        await server.reply("/djdl/.well-known/polaris.json", body: doc ?? discovery())
        let store = InMemoryStore(deviceId: "dev")
        if let token { await store.setToken(token) }
        let now = self.now
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                core: CoreOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: [:],
                    trustRefresh: false, store: store, transport: server.transport,
                    requestTimeoutSeconds: 0, expectedServices: [.license, .identity],
                    clock: { now.with { $0 } }),
                license: LicenseClientOptions(fingerprint: false)))
    }

    private func exchanges() async -> [PolarisRequest] { await server.requests(forPath: tokenPath) }

    private func advance(_ seconds: Int) { now.with { $0 += seconds } }

    private func code(_ body: () async throws -> Void) async -> PolarisError? {
        do { try await body() } catch let e as PolarisError { return e } catch {}
        return nil
    }

    // ── Gate ─────────────────────────────────────────────────────────────────────────────

    func testWithoutDiscoveryNamingItTheCallIsServiceUnavailableAndSendsNothing() async throws {
        for doc in [
            discovery(accessToken: false), discovery(tokenURL: nil),
            "{\"product\":\"djdl\",\"services\":{\"license\":{\"enabled\":true},\"identity\":{\"enabled\":false}}}",
        ] {
            server = StubServer()
            let c = try await client(discovery: doc)
            let e = await code { _ = try await c.identity.accessToken() }
            XCTAssertEqual(e?.code, PolarisError.serviceUnavailable)
            XCTAssertNotNil(e?.unsupported)
            let sent = await exchanges()
            XCTAssertTrue(sent.isEmpty)
        }
    }

    func testNoDeviceTokenIsNoTokenAndSendsNothing() async throws {
        let c = try await client(token: nil)
        let e = await code { _ = try await c.identity.accessToken() }
        XCTAssertEqual(e?.code, ErrorCode.noToken)
        let sent = await exchanges()
        XCTAssertTrue(sent.isEmpty)
    }

    func testAnEndpointOnAnotherOriginIsServiceUnavailableAndSendsNothing() async throws {
        let c = try await client(discovery: discovery(tokenURL: "https://evil.example/djdl/identity/token"))
        let e = await code { _ = try await c.identity.accessToken() }
        XCTAssertEqual(e?.code, PolarisError.serviceUnavailable)
        let sent = await exchanges()
        XCTAssertTrue(sent.isEmpty)
        let evil = await server.requests.filter { $0.url.host == "evil.example" }
        XCTAssertTrue(evil.isEmpty)
    }

    // ── The request and the answer ───────────────────────────────────────────────────────

    func testTheExchangeIsTheFixedFormWithTheDeviceHeaderAndNoAuthorization() async throws {
        await server.reply(tokenPath, body: grant())
        let c = try await client()
        let at = try await c.identity.accessToken()
        XCTAssertEqual(at.accessToken, jwt)
        XCTAssertEqual(at.tokenType, "Bearer")
        XCTAssertEqual(at.expiresIn, 600)
        XCTAssertEqual(at.expiresAt, 1_700_000_600)
        XCTAssertFalse("\(at)".contains(jwt))
        let sent = await exchanges()
        XCTAssertEqual(sent.count, 1)
        let req = try XCTUnwrap(sent.first)
        XCTAssertEqual(req.method, "POST")
        XCTAssertFalse(req.followRedirects)
        XCTAssertEqual(req.headers["content-type"], "application/x-www-form-urlencoded")
        XCTAssertNil(req.headers["authorization"])
        XCTAssertNotNil(req.headers["X-PKey-Device"] ?? req.headers["x-pkey-device"])
        XCTAssertEqual(
            String(decoding: req.body ?? Data(), as: UTF8.self),
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&client_id=djdl"
                + "&subject_token=pkeyt_a&subject_token_type=urn%3Apolaris-key%3Atoken-type%3Adevice"
                + "&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token")
    }

    func testA200ThatIsNotTheGrantIsBadResponse() async throws {
        let long = "a.b." + String(repeating: "c", count: 8192 - 3)
        let bad = [
            grant("not-a-jws"), grant(long), grant(tokenType: "mac"), grant(issued: "urn:x"),
            grant(expiresIn: "0"), grant(expiresIn: "600.5"), grant(expiresIn: "\"600\""), "[]",
        ]
        for body in bad {
            server = StubServer()
            await server.reply(tokenPath, body: body)
            let c = try await client()
            let e = await code { _ = try await c.identity.accessToken() }
            XCTAssertEqual(e?.code, ErrorCode.badResponse, body)
        }
    }

    func testATokenOfExactly8KiBIsAccepted() async throws {
        let token = "a.b." + String(repeating: "c", count: 8192 - 4)
        await server.reply(tokenPath, body: grant(token))
        let c = try await client()
        let at = try await c.identity.accessToken()
        XCTAssertEqual(at.accessToken, token)
    }

    // ── The cache ────────────────────────────────────────────────────────────────────────

    func testReusesUntil60SecondsBeforeExpiryThenAsksAgain() async throws {
        await server.reply(tokenPath, body: grant())
        let c = try await client()
        _ = try await c.identity.accessToken()
        advance(539)
        let again = try await c.identity.accessToken()
        let first = await exchanges().count
        XCTAssertEqual(first, 1)
        XCTAssertEqual(again.expiresIn, 61)
        advance(1)
        _ = try await c.identity.accessToken()
        let second = await exchanges().count
        XCTAssertEqual(second, 2)
    }

    func testRefreshAsksAgainInsideTheWindow() async throws {
        await server.reply(tokenPath, body: grant())
        let c = try await client()
        _ = try await c.identity.accessToken()
        _ = try await c.identity.accessToken(refresh: true)
        let sent = await exchanges().count
        XCTAssertEqual(sent, 2)
    }

    func testFailuresAreNotCached() async throws {
        let n = ExchangeCounter()
        await server.route(tokenPath) { _ in
            n.next() == 1
                ? StubServer.Reply(status: 500, body: "{\"error\":\"server_error\"}")
                : StubServer.Reply(body: grant())
        }
        let c = try await client()
        let e = await code { _ = try await c.identity.accessToken() }
        XCTAssertEqual(e?.code, IdentityClient.serverError)
        let at = try await c.identity.accessToken()
        XCTAssertEqual(at.accessToken, jwt)
        let sent = await exchanges().count
        XCTAssertEqual(sent, 2)
    }

    func testARefusalKeepsItsWireCodeAndIsNotCached() async throws {
        let n = ExchangeCounter()
        await server.route(tokenPath) { _ in
            n.next() == 1
                ? StubServer.Reply(status: 400, body: "{\"error\":\"invalid_grant\"}")
                : StubServer.Reply(body: grant())
        }
        let c = try await client()
        let e = await code { _ = try await c.identity.accessToken() }
        XCTAssertEqual(e?.code, ErrorCode.invalidGrant)
        XCTAssertEqual(e?.status, 400)
        let at = try await c.identity.accessToken()
        XCTAssertEqual(at.accessToken, jwt)
        let sent = await exchanges().count
        XCTAssertEqual(sent, 2)
    }

    func testALateInvalidGrantForAReplacedTokenLeavesTheNewOneAlone() async throws {
        let cache = AccessTokenCache()
        let gate = Gate()
        let now: @Sendable () async -> Int = { 1_700_000_000 }
        async let old: AccessToken = cache.get(
            key: "A", refresh: false, now: now,
            exchange: {
                await gate.wait()
                throw PolarisError(code: ErrorCode.invalidGrant, message: "refused", status: 400)
            })
        await gate.untilEntered()
        _ = try await cache.get(key: "B", refresh: false, now: now, exchange: { ("aaaa.bbbb.new1", 600) })
        await gate.release()
        do {
            _ = try await old
            XCTFail("the old exchange was refused")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.invalidGrant)
        }
        let ran = ExchangeCounter()
        let kept = try await cache.get(
            key: "B", refresh: false, now: now, exchange: { _ = ran.next(); return ("x.y.z", 600) })
        XCTAssertEqual(kept.accessToken, "aaaa.bbbb.new1")  // still held
        XCTAssertEqual(ran.next(), 1)  // nothing asked again
    }

    func testAnImmediateRetryAfterAFailureMakesANewRequest() async throws {
        let cache = AccessTokenCache()
        let gate = Gate()
        let now: @Sendable () async -> Int = { 1_700_000_000 }
        async let first: AccessToken = cache.get(
            key: "k", refresh: false, now: now,
            exchange: {
                await gate.wait()
                throw PolarisError(code: IdentityClient.serverError, message: "down", status: 500)
            })
        await gate.untilEntered()
        let ran = ExchangeCounter()
        // A joiner that asks again the moment it hears the failure.
        let joiner = Task { () -> AccessToken? in
            let exchange: @Sendable () async throws -> (token: String, expiresIn: Int) = {
                _ = ran.next()
                return ("aaaa.bbbb.new1", 600)
            }
            do {
                _ = try await cache.get(key: "k", refresh: false, now: now, exchange: exchange)
                return nil
            } catch {
                return try? await cache.get(key: "k", refresh: false, now: now, exchange: exchange)
            }
        }
        try await Task.sleep(nanoseconds: 50_000_000)  // the joiner reaches the cache while the first is in flight
        await gate.release()
        _ = try? await first
        let retried = await joiner.value
        XCTAssertEqual(retried?.accessToken, "aaaa.bbbb.new1")  // a new request, not the dead flight's failure
        XCTAssertEqual(ran.next(), 2)
    }

    func testClearDropsTheHeldToken() async throws {
        await server.reply(tokenPath, body: grant())
        let c = try await client()
        _ = try await c.identity.accessToken()
        await c.identity.clearAccessToken()
        _ = try await c.identity.accessToken()
        let sent = await exchanges().count
        XCTAssertEqual(sent, 2)
    }

    // ── The cache is bound to the device token ───────────────────────────────────────────

    func testAReplacedDeviceTokenIsAMiss() async throws {
        await server.reply(tokenPath, body: grant())
        let c = try await client()
        _ = try await c.identity.accessToken()
        try await c.core.setToken("pkeyt_b", source: .activate, provenance: .signin)
        _ = try await c.identity.accessToken()
        let sent = await exchanges()
        XCTAssertEqual(sent.count, 2)
        XCTAssertTrue(String(decoding: sent[1].body ?? Data(), as: UTF8.self).contains("subject_token=pkeyt_b"))
        _ = try await c.identity.accessToken()
        let after = await exchanges().count
        XCTAssertEqual(after, 2)
    }

    func testConcurrentCallsShareOneExchange() async throws {
        let cache = AccessTokenCache()
        let gate = Gate()
        let n = ExchangeCounter()
        let exchange: @Sendable () async throws -> (token: String, expiresIn: Int) = {
            _ = n.next()
            await gate.wait()
            return (jwt, 600)
        }
        let now: @Sendable () async -> Int = { 1_700_000_000 }
        async let a = cache.get(key: "k", refresh: false, now: now, exchange: exchange)
        await gate.untilEntered()
        async let b = cache.get(key: "k", refresh: false, now: now, exchange: exchange)
        async let c = cache.get(key: "k", refresh: false, now: now, exchange: exchange)
        try await Task.sleep(nanoseconds: 50_000_000)
        await gate.release()
        let all = try await [a, b, c]
        XCTAssertEqual(all.map(\.accessToken), [jwt, jwt, jwt])
        XCTAssertEqual(n.next(), 2)  // one exchange ran before this call
    }

    func testATokenChangeWhileAnExchangeIsInFlightDoesNotJoinOrKeepIt() async throws {
        let cache = AccessTokenCache()
        let gate = Gate()
        let now: @Sendable () async -> Int = { 1_700_000_000 }
        async let old = cache.get(
            key: "A", refresh: false, now: now,
            exchange: {
                await gate.wait()
                return ("aaaa.bbbb.old1", 600)
            })
        await gate.untilEntered()
        let fresh = try await cache.get(
            key: "B", refresh: false, now: now, exchange: { ("aaaa.bbbb.new1", 600) })
        XCTAssertEqual(fresh.accessToken, "aaaa.bbbb.new1")
        await gate.release()
        let late = try await old
        XCTAssertEqual(late.accessToken, "aaaa.bbbb.old1")
        let ran = ExchangeCounter()
        let kept = try await cache.get(
            key: "B", refresh: false, now: now, exchange: { _ = ran.next(); return ("x.y.z", 600) })
        XCTAssertEqual(kept.accessToken, "aaaa.bbbb.new1")  // the late answer was not kept
        XCTAssertEqual(ran.next(), 1)  // and nothing was asked again
    }

    func testAClearWhileAnExchangeIsInFlightKeepsNothing() async throws {
        let cache = AccessTokenCache()
        let gate = Gate()
        let now: @Sendable () async -> Int = { 1_700_000_000 }
        async let first = cache.get(
            key: "k", refresh: false, now: now,
            exchange: {
                await gate.wait()
                return (jwt, 600)
            })
        await gate.untilEntered()
        await cache.clear()
        await gate.release()
        _ = try await first
        let ran = ExchangeCounter()
        _ = try await cache.get(
            key: "k", refresh: false, now: now, exchange: { _ = ran.next(); return (jwt, 600) })
        XCTAssertEqual(ran.next(), 2)  // it asked again
    }

    // ── 429 ──────────────────────────────────────────────────────────────────────────────

    func testA429KeepsTheWaitFromTheBodyAndHoldsOffUntilItPasses() async throws {
        let n = ExchangeCounter()
        await server.route(tokenPath) { _ in
            n.next() == 1
                ? StubServer.Reply(status: 429, body: "{\"error\":\"rate_limited\",\"retryAfter\":60}")
                : StubServer.Reply(body: grant())
        }
        let c = try await client()
        let e = await code { _ = try await c.identity.accessToken() }
        XCTAssertEqual(e?.code, ErrorCode.rateLimited)
        XCTAssertEqual(e?.status, 429)
        XCTAssertEqual(e?.retryAfterSeconds, 60)
        advance(20)
        for refresh in [false, true] {
            let held = await code { _ = try await c.identity.accessToken(refresh: refresh) }
            XCTAssertEqual(held?.code, ErrorCode.rateLimited)
            XCTAssertEqual(held?.retryAfterSeconds, 40)
        }
        let during = await exchanges().count
        XCTAssertEqual(during, 1)  // nothing was sent while it held off
        advance(40)
        let at = try await c.identity.accessToken()
        XCTAssertEqual(at.accessToken, jwt)
        let after = await exchanges().count
        XCTAssertEqual(after, 2)
    }

    func testAHeldTokenIsStillHandedOutWhileTheLimitHolds() async throws {
        let n = ExchangeCounter()
        await server.route(tokenPath) { _ in
            n.next() == 1
                ? StubServer.Reply(body: grant())
                : StubServer.Reply(
                    status: 429, body: "{\"error\":\"rate_limited\",\"retryAfter\":60}")
        }
        let c = try await client()
        _ = try await c.identity.accessToken()
        _ = await code { _ = try await c.identity.accessToken(refresh: true) }
        let at = try await c.identity.accessToken()
        XCTAssertEqual(at.accessToken, jwt)
        let sent = await exchanges().count
        XCTAssertEqual(sent, 2)
    }

    func testA429ReadsTheBodyFirstThenTheHeader() async throws {
        await server.route(tokenPath) { _ in
            StubServer.Reply(
                status: 429, body: "{\"error\":\"rate_limited\",\"retryAfter\":60}",
                headers: ["Retry-After": "7"])
        }
        let c = try await client()
        let both = await code { _ = try await c.identity.accessToken() }
        XCTAssertEqual(both?.retryAfterSeconds, 60)
        server = StubServer()
        await server.route(tokenPath) { _ in
            StubServer.Reply(status: 429, body: "{\"error\":\"rate_limited\"}", headers: ["Retry-After": "7"])
        }
        let c2 = try await client()
        let header = await code { _ = try await c2.identity.accessToken() }
        XCTAssertEqual(header?.retryAfterSeconds, 7)
    }

    func testTheWaitIsPerDeviceTokenAndClearLiftsIt() async throws {
        let cache = AccessTokenCache()
        let now: @Sendable () async -> Int = { 1_700_000_000 }
        let limited: @Sendable () async throws -> (token: String, expiresIn: Int) = {
            throw PolarisError(code: ErrorCode.rateLimited, message: "slow", status: 429, retryAfterSeconds: 60)
        }
        let ran = ExchangeCounter()
        let fine: @Sendable () async throws -> (token: String, expiresIn: Int) = {
            _ = ran.next()
            return (jwt, 600)
        }
        _ = try? await cache.get(key: "A", refresh: false, now: now, exchange: limited)
        let held = await code { _ = try await cache.get(key: "A", refresh: true, now: now, exchange: fine) }
        XCTAssertEqual(held?.retryAfterSeconds, 60)
        _ = try await cache.get(key: "B", refresh: false, now: now, exchange: fine)  // another key is not held off
        XCTAssertEqual(ran.next(), 2)
        await cache.clear()
        _ = try await cache.get(key: "A", refresh: false, now: now, exchange: fine)  // clear lifted the wait
        XCTAssertEqual(ran.next(), 4)
    }

    // ── Redirects ────────────────────────────────────────────────────────────────────────

    func testARedirectAnswerIsNotFollowedAndIsNetworkError() async throws {
        await server.route(tokenPath) { _ in
            StubServer.Reply(status: 307, headers: ["Location": "https://evil.example/steal"])
        }
        let c = try await client()
        let e = await code { _ = try await c.identity.accessToken() }
        XCTAssertEqual(e?.code, IdentityClient.networkError)
        let sent = await exchanges()
        XCTAssertEqual(sent.count, 1)
        XCTAssertFalse(sent[0].followRedirects)
    }
}
