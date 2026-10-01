// @pkey-feature identity.devicecode config.mint
//
// Device-code sign-in pacing and the edge-mint cache — the client-side rules a transcript cannot
// show, because a recorded conversation has no clock between its requests:
//
//   * no poll comes earlier than `interval` after the previous one (or after the prompt);
//   * a `slow_down` lengthens the interval for every later poll and never shortens it;
//   * a failed poll is retried at the SAME interval, never faster;
//   * the prompt's expiry and task cancellation both stop polling;
//   * a second `mintToken` inside the lifetime makes no request, and nothing minted is stored;
//   * a cached token is bound to the device token it was minted with: after `deactivate()` the
//     next mint is `unauthorized` without a request, and a different device token re-mints;
//   * a disabled service refuses before any request.
//
// The clock is `CoreOptions.clock`, advanced by the injected sleep, so every wait is exact and
// instant.

import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyIdentity
import XCTest

private let product = "djdl"
private let base = "https://k.test"
private let t0 = 1_700_000_000
private let startPath = "/\(product)/identity/auth/device/start"
private let pollPath = "/\(product)/identity/auth/device/poll"
private let mintPath = "/\(product)/config/mint/musickit/token"
private let reacquirePath = "/\(product)/license/token"

/// A control plane answering each path from a queue (the last answer repeats), recording when
/// each request arrived on the test clock.
private final class Plane: PolarisTransport, @unchecked Sendable {
    enum Answer {
        case reply(Int, String)
        case fail
    }
    struct Call {
        let path: String
        let at: Int
        let authorization: String?
        let body: [String: String]?
    }

    private let lock = NSLock()
    private var answers: [String: [Answer]]
    private var callsValue: [Call] = []
    let clock: ReplayClock
    /// Called after each request is recorded (used to cancel mid-wait).
    var onRequest: (@Sendable () -> Void)?

    init(clock: ReplayClock, _ answers: [String: [Answer]]) {
        self.clock = clock
        self.answers = answers
    }

    var calls: [Call] { lock.withLock { callsValue } }
    func at(_ path: String) -> [Int] { calls.filter { $0.path == path }.map(\.at) }

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        let path = request.url.path
        let body = request.body.flatMap { try? JSONDecoder().decode([String: String].self, from: $0) }
        let answer: Answer? = lock.withLock {
            callsValue.append(
                Call(
                    path: path, at: clock.now,
                    authorization: request.headers["authorization"], body: body))
            guard var queue = answers[path], !queue.isEmpty else { return nil }
            let next = queue.count > 1 ? queue.removeFirst() : queue[0]
            answers[path] = queue
            return next
        }
        onRequest?()
        switch answer {
        case .none:
            return PolarisResponse(status: 404, body: Data("{}".utf8))
        case .fail:
            throw URLError(.networkConnectionLost)
        case .reply(let status, let json):
            return PolarisResponse(
                status: status, body: Data(json.utf8),
                headers: ["content-type": "application/json"])
        }
    }
}

private func started(expiresIn: Int = 600, interval: Int = 2) -> Plane.Answer {
    .reply(
        200,
        """
        {"status":"pending","deviceCode":"device-code-1","userCode":"WDJB-MJHT",\
        "verificationUri":"\(base)/\(product)/identity/auth/device",\
        "verificationUriComplete":"\(base)/\(product)/identity/auth/device?user_code=WDJB-MJHT",\
        "expiresIn":\(expiresIn),"interval":\(interval)}
        """)
}

private let pending = Plane.Answer.reply(200, #"{"status":"pending"}"#)
private let ready = Plane.Answer.reply(
    200, #"{"status":"ready","token":"pkeyt_signed_in","schemaVersion":1}"#)

private func gaps(_ times: [Int], from start: Int) -> [Int] {
    times.enumerated().map { i, t in t - (i == 0 ? start : times[i - 1]) }
}

final class IdentityMintTests: XCTestCase {
    private func core(
        _ plane: Plane, services: [ServiceSlug], token: String? = nil
    ) async throws -> (CoreContext, InMemoryStore) {
        let store = InMemoryStore(productSlug: product, deviceId: String(repeating: "D", count: 32))
        if let token { await store.setToken(token) }
        let clock = plane.clock
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: product, baseUrl: base, version: "1.0.0", pinnedKeys: [:],
                trustRefresh: false, store: store, transport: plane, requestTimeoutSeconds: 0,
                expectedServices: services, clock: { clock.now }))
        try await core.start()
        return (core, store)
    }

    /// An identity client whose sleep advances the test clock.
    private func identity(_ core: CoreContext, _ plane: Plane, acquired: (@Sendable () async -> Void)? = nil)
        -> IdentityClient
    {
        let clock = plane.clock
        return IdentityClient(core: core, onAcquired: acquired) { seconds in
            try Task.checkCancellation()
            clock.now += Int(seconds)
        }
    }

    // ── Device-code sign-in ──────────────────────────────────────────────────────────────

    func testBeginRefusesBeforeAnyRequestWhenIdentityIsOff() async throws {
        let plane = Plane(clock: ReplayClock(t0), [startPath: [started()]])
        let (core, _) = try await core(plane, services: [.license, .config])
        do {
            _ = try await identity(core, plane).beginSignIn()
            XCTFail("expected service-unavailable")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, PolarisError.serviceUnavailable)
        }
        XCTAssertTrue(plane.calls.isEmpty)
    }

    func testBeginPostsDeviceIdAndNameWithoutABearer() async throws {
        let plane = Plane(clock: ReplayClock(t0), [startPath: [started()]])
        let (core, _) = try await core(plane, services: [.identity], token: "pkeyt_anonymous")
        let prompt = try await identity(core, plane).beginSignIn(deviceName: " Deck ")
        XCTAssertEqual(
            plane.calls.first?.body,
            ["deviceId": String(repeating: "D", count: 32), "deviceName": "Deck"])
        XCTAssertNil(plane.calls.first?.authorization)
        XCTAssertEqual(prompt.userCode, "WDJB-MJHT")
        XCTAssertEqual(prompt.expiresAt, t0 + 600)
        XCTAssertEqual(prompt.interval, 2)
    }

    func testNeverPollsEarlierThanTheIntervalAndStoresTheToken() async throws {
        let plane = Plane(
            clock: ReplayClock(t0), [startPath: [started()], pollPath: [pending, pending, ready]])
        let (core, store) = try await core(plane, services: [.identity])
        let acquired = expectation(description: "acquisition event")
        let client = identity(core, plane) { acquired.fulfill() }
        let result = try await client.waitForSignIn(try await client.beginSignIn())
        XCTAssertEqual(result, .ready)
        let times = plane.at(pollPath)
        XCTAssertEqual(times.count, 3)
        XCTAssertTrue(gaps(times, from: t0).allSatisfy { $0 >= 2 })
        let token = await store.getToken()
        XCTAssertEqual(token, "pkeyt_signed_in")
        await fulfillment(of: [acquired], timeout: 1)
    }

    func testSlowDownLengthensTheIntervalForEveryLaterPoll() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [
                startPath: [started()],
                pollPath: [
                    .reply(429, #"{"status":"slow_down","interval":7}"#), pending, pending, ready,
                ],
            ])
        let (core, _) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        _ = try await client.waitForSignIn(try await client.beginSignIn())
        XCTAssertEqual(gaps(plane.at(pollPath), from: t0), [2, 7, 7, 7])
    }

    func testSlowDownWithoutIntervalAddsFiveAndNeverShortens() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [
                startPath: [started()],
                pollPath: [
                    .reply(429, #"{"error":"rate_limited"}"#),
                    .reply(429, #"{"status":"slow_down","interval":1}"#), ready,
                ],
            ])
        let (core, _) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        _ = try await client.waitForSignIn(try await client.beginSignIn())
        XCTAssertEqual(gaps(plane.at(pollPath), from: t0), [2, 7, 7])
    }

    func testAFailedPollIsRetriedAtTheSameInterval() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [startPath: [started()], pollPath: [.fail, .reply(503, "{}"), ready]])
        let (core, _) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        let result = try await client.waitForSignIn(try await client.beginSignIn())
        XCTAssertEqual(result, .ready)
        XCTAssertEqual(gaps(plane.at(pollPath), from: t0), [2, 2, 2])
    }

    func testExpiryStopsPollingWithoutAskingAgain() async throws {
        let plane = Plane(
            clock: ReplayClock(t0), [startPath: [started(expiresIn: 5)], pollPath: [pending]])
        let (core, _) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        let result = try await client.waitForSignIn(try await client.beginSignIn())
        XCTAssertEqual(result, .expired)
        XCTAssertEqual(plane.at(pollPath).map { $0 - t0 }, [2, 4])
    }

    func testTheServersTimeoutIsExpired() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [startPath: [started()], pollPath: [pending, .reply(200, #"{"status":"timeout"}"#)]])
        let (core, _) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        let result = try await client.waitForSignIn(try await client.beginSignIn())
        XCTAssertEqual(result, .expired)
    }

    func testCancellationStopsPolling() async throws {
        let plane = Plane(clock: ReplayClock(t0), [startPath: [started()], pollPath: [pending]])
        let (core, _) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        let prompt = try await client.beginSignIn()
        let task = Task { try await client.waitForSignIn(prompt) }
        plane.onRequest = { task.cancel() }
        do {
            _ = try await task.value
            XCTFail("expected CancellationError")
        } catch is CancellationError {}
        XCTAssertEqual(plane.at(pollPath).count, 1)
    }

    func testADeviceMismatchEndsTheWaitWithoutAToken() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [startPath: [started()], pollPath: [.reply(401, #"{"error":"unauthorized"}"#)]])
        let (core, store) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        let result = try await client.waitForSignIn(try await client.beginSignIn())
        guard case .error = result else { return XCTFail("expected .error, got \(result)") }
        let token = await store.getToken()
        XCTAssertNil(token)
    }

    // ── Edge-mint ────────────────────────────────────────────────────────────────────────

    private func mintClient(_ plane: Plane, services: [ServiceSlug], token: String?) async throws
        -> (ConfigClient, InMemoryStore)
    {
        let (core, store) = try await core(plane, services: services, token: token)
        let config = ConfigClient(
            core: core,
            reacquire: { current in
                guard
                    let response = try? await core.request(
                        core.endpoints.licenseToken, method: "POST",
                        headers: ["authorization": "Bearer \(current)"]),
                    response.status == 200,
                    let body = try? JSONDecoder().decode([String: JSONValue].self, from: response.body)
                else { return nil }
                return body["token"]?.stringValue
            })
        return (config, store)
    }

    private static func minted(_ token: String, _ expiresAt: Int) -> Plane.Answer {
        .reply(200, #"{"token":"\#(token)","expiresAt":\#(expiresAt)}"#)
    }

    func testASecondMintInsideTheLifetimeMakesNoRequest() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [mintPath: [Self.minted("m1", t0 + 600), Self.minted("m2", t0 + 1200)]])
        let (config, store) = try await mintClient(
            plane, services: [.license, .config], token: "pkeyt_device")
        let first = try await config.mintToken("musickit")
        XCTAssertEqual(first, MintedToken(token: "m1", expiresAt: t0 + 600))
        XCTAssertEqual(plane.calls.first?.authorization, "Bearer pkeyt_device")
        plane.clock.now = t0 + 569
        let cached = try await config.mintToken("musickit")
        XCTAssertEqual(cached.token, "m1")
        XCTAssertEqual(plane.calls.count, 1)
        plane.clock.now = t0 + 570
        let fresh = try await config.mintToken("musickit")
        XCTAssertEqual(fresh.token, "m2")
        XCTAssertEqual(plane.calls.count, 2)
        // Memory only: the store never sees a minted token.
        let token = await store.getToken()
        XCTAssertEqual(token, "pkeyt_device")
        let cache = await store.readCache()
        XCTAssertFalse(String(describing: cache).contains("m1"))
    }

    func testDeactivateDropsTheCachedMintedToken() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [
                mintPath: [Self.minted("m1", t0 + 600)],
                "/\(product)/license/deauthorize": [.reply(200, #"{"ok":true}"#)],
            ])
        let (core, _) = try await core(plane, services: [.license, .config], token: "pkeyt_device")
        let config = ConfigClient(core: core)
        let license = LicenseClient(core: core, options: LicenseClientOptions(fingerprint: false))
        let first = try await config.mintToken("musickit")
        XCTAssertEqual(first.token, "m1")
        try await license.deactivate()
        XCTAssertEqual(plane.calls.filter { $0.path == mintPath }.count, 1)
        do {
            _ = try await config.mintToken("musickit")
            XCTFail("expected unauthorized")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, "unauthorized")
        }
        XCTAssertEqual(plane.calls.filter { $0.path == mintPath }.count, 1)
    }

    func testADifferentDeviceTokenReMints() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [mintPath: [Self.minted("m1", t0 + 600), Self.minted("m2", t0 + 600)]])
        let (core, _) = try await core(plane, services: [.license, .config], token: "pkeyt_device")
        let config = ConfigClient(core: core)
        let first = try await config.mintToken("musickit")
        XCTAssertEqual(first.token, "m1")
        try await core.setToken("pkeyt_other")
        let second = try await config.mintToken("musickit")
        XCTAssertEqual(second.token, "m2")
        XCTAssertEqual(
            plane.calls.map(\.authorization), ["Bearer pkeyt_device", "Bearer pkeyt_other"])
    }

    func testMintRefusesBeforeAnyRequestWhenConfigIsOff() async throws {
        let plane = Plane(clock: ReplayClock(t0), [mintPath: [Self.minted("m", t0 + 600)]])
        let (config, _) = try await mintClient(plane, services: [.license], token: "pkeyt_device")
        do {
            _ = try await config.mintToken("musickit")
            XCTFail("expected service-unavailable")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, PolarisError.serviceUnavailable)
        }
        XCTAssertTrue(plane.calls.isEmpty)
    }

    func testMintRefusesARecipeIdOutsideTheRoutersAlphabet() async throws {
        let plane = Plane(clock: ReplayClock(t0), [:])
        let (config, _) = try await mintClient(plane, services: [.config], token: "pkeyt_device")
        for bad in ["../license", "Music", "a/b", ""] {
            do {
                _ = try await config.mintToken(bad)
                XCTFail("expected bad_request for \(bad)")
            } catch let error as PolarisError {
                XCTAssertEqual(error.code, "bad_request")
            }
        }
        XCTAssertTrue(plane.calls.isEmpty)
    }

    func testMintWithoutATokenIsUnauthorizedWithoutARequest() async throws {
        let plane = Plane(clock: ReplayClock(t0), [:])
        let (config, _) = try await mintClient(plane, services: [.config], token: nil)
        do {
            _ = try await config.mintToken("musickit")
            XCTFail("expected unauthorized")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, "unauthorized")
        }
        XCTAssertTrue(plane.calls.isEmpty)
    }

    func testMintReacquiresOnceOn401AndRetries() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [
                mintPath: [.reply(401, #"{"error":"unauthorized"}"#), Self.minted("m", t0 + 600)],
                reacquirePath: [.reply(200, #"{"token":"pkeyt_rotated","schemaVersion":1}"#)],
            ])
        let (config, store) = try await mintClient(
            plane, services: [.license, .config], token: "pkeyt_device")
        let minted = try await config.mintToken("musickit")
        XCTAssertEqual(minted.token, "m")
        XCTAssertEqual(
            plane.calls.map { "\($0.path) \($0.authorization ?? "-")" },
            [
                "\(mintPath) Bearer pkeyt_device", "\(reacquirePath) Bearer pkeyt_device",
                "\(mintPath) Bearer pkeyt_rotated",
            ])
        let token = await store.getToken()
        XCTAssertEqual(token, "pkeyt_rotated")
    }

    func testMintFailsAfterOneReacquire() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [
                mintPath: [.reply(401, #"{"error":"unauthorized"}"#)],
                reacquirePath: [.reply(401, #"{"error":"unauthorized"}"#)],
            ])
        let (config, _) = try await mintClient(
            plane, services: [.license, .config], token: "pkeyt_device")
        do {
            _ = try await config.mintToken("musickit")
            XCTFail("expected unauthorized")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, "unauthorized")
        }
        XCTAssertEqual(plane.calls.map(\.path), [mintPath, reacquirePath])
    }
}
