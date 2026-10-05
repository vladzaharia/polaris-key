// @pkey-feature identity.devicecode config.mint
//
// Device-code sign-in pacing and the edge-mint cache — the client-side rules a transcript cannot
// show, because a recorded conversation has no clock between its requests:
//
//   * no poll comes earlier than `interval` after the previous one (or after the prompt);
//   * a `slow_down` lengthens the interval for every later poll and never shortens it;
//   * repeated interval-less `slow_down`s each add five seconds to the CURRENT interval;
//   * the sleep is clamped to [1, expiresIn] seconds — a negative, fractional or huge interval
//     neither spins, traps nor outlives the code;
//   * a failed poll is retried at the SAME interval, never faster;
//   * a printed prompt or minted token never shows the device code or the token;
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
@testable import PolarisKeyIdentity
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

/// A start answer. The numbers are JSON literals, so a test can send `0.5` or `1e12`.
private func started(
    expiresIn: String = "600", interval: String = "2",
    verificationUri: String = "\(base)/\(product)/identity/auth/device",
    verificationUriComplete: String =
        "\(base)/\(product)/identity/auth/device?user_code=WDJB-MJHT"
) -> Plane.Answer {
    .reply(
        200,
        """
        {"status":"pending","deviceCode":"device-code-1","userCode":"WDJB-MJHT",\
        "verificationUri":"\(verificationUri)",\
        "verificationUriComplete":"\(verificationUriComplete)",\
        "expiresIn":\(expiresIn),"interval":\(interval)}
        """)
}

/// Holds the polling task so a request hook installed BEFORE the task exists can cancel it.
private final class TaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<SignInResult, Error>?
    private var cancelRequested = false

    func set(_ task: Task<SignInResult, Error>) {
        let cancel: Bool = lock.withLock {
            self.task = task
            return cancelRequested
        }
        if cancel { task.cancel() }
    }

    func cancel() {
        let task: Task<SignInResult, Error>? = lock.withLock {
            cancelRequested = true
            return self.task
        }
        task?.cancel()
    }
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
        XCTAssertTrue(result.isReady, "\(result)")
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

    func testRepeatedSlowDownsWithoutIntervalStepFromTheCurrentInterval() async throws {
        let limited = Plane.Answer.reply(429, #"{"error":"rate_limited"}"#)
        let plane = Plane(
            clock: ReplayClock(t0),
            [startPath: [started()], pollPath: [limited, limited, limited, ready]])
        let (core, _) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        _ = try await client.waitForSignIn(try await client.beginSignIn())
        XCTAssertEqual(gaps(plane.at(pollPath), from: t0), [2, 7, 12, 17])
    }

    func testANegativeIntervalIsClampedToOneSecond() async throws {
        let plane = Plane(clock: ReplayClock(t0), [pollPath: [pending, ready]])
        let (core, _) = try await core(plane, services: [.identity])
        let prompt = SignInPrompt(
            deviceCode: "device-code-1", userCode: "WDJB-MJHT", verificationUri: "u",
            verificationUriComplete: "u?user_code=WDJB-MJHT", expiresIn: 600, interval: -3,
            expiresAt: t0 + 600)
        let result = try await identity(core, plane).waitForSignIn(prompt)
        XCTAssertTrue(result.isReady, "\(result)")
        XCTAssertEqual(gaps(plane.at(pollPath), from: t0), [1, 1])
    }

    func testAHalfSecondIntervalRoundsUpToOne() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [startPath: [started(interval: "0.5")], pollPath: [pending, ready]])
        let (core, _) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        let prompt = try await client.beginSignIn()
        XCTAssertEqual(prompt.interval, 1)
        let result = try await client.waitForSignIn(prompt)
        XCTAssertTrue(result.isReady, "\(result)")
        XCTAssertEqual(gaps(plane.at(pollPath), from: t0), [1, 1])
    }

    func testAHugeIntervalIsClampedToTheCodesLifetime() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [startPath: [started(expiresIn: "60", interval: "1e12")], pollPath: [pending]])
        let (core, _) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        let result = try await client.waitForSignIn(try await client.beginSignIn())
        XCTAssertEqual(result, .expired)
        // One 60 s sleep, then expiry: no poll.
        XCTAssertTrue(plane.at(pollPath).isEmpty)
        XCTAssertEqual(plane.clock.now - t0, 60)
    }

    func testTheDefaultSleepNeverTrapsOnAnOutOfRangeInterval() {
        XCTAssertEqual(IdentityClient.sleepNanoseconds(-5), 0)
        XCTAssertEqual(IdentityClient.sleepNanoseconds(.nan), 0)
        XCTAssertEqual(IdentityClient.sleepNanoseconds(-.infinity), 0)
        XCTAssertEqual(IdentityClient.sleepNanoseconds(0.5), 500_000_000)
        XCTAssertEqual(
            IdentityClient.sleepNanoseconds(1e300), UInt64(Double(Int32.max) * 1_000_000_000))
        XCTAssertEqual(
            IdentityClient.sleepNanoseconds(Double(Int.max)),
            UInt64(Double(Int32.max) * 1_000_000_000))
    }

    func testBeginRejectsAnEmptyVerificationUri() async throws {
        for answer in [started(verificationUri: ""), started(verificationUriComplete: "")] {
            let plane = Plane(clock: ReplayClock(t0), [startPath: [answer]])
            let (core, _) = try await core(plane, services: [.identity])
            do {
                _ = try await identity(core, plane).beginSignIn()
                XCTFail("expected bad_response")
            } catch let error as PolarisError {
                XCTAssertEqual(error.code, "bad_response")
            }
        }
    }

    func testAPrintedPromptHidesTheDeviceCode() async throws {
        let plane = Plane(clock: ReplayClock(t0), [startPath: [started()]])
        let (core, _) = try await core(plane, services: [.identity])
        let prompt = try await identity(core, plane).beginSignIn()
        XCTAssertEqual(prompt.deviceCode, "device-code-1")
        var dumped = ""
        dump(prompt, to: &dumped)
        for printed in [String(describing: prompt), String(reflecting: prompt), "\(prompt)", dumped] {
            XCTAssertFalse(printed.contains("device-code-1"), printed)
            XCTAssertTrue(printed.contains("WDJB-MJHT"), printed)
            XCTAssertTrue(printed.contains("[redacted]"), printed)
        }
    }

    func testAFailedPollIsRetriedAtTheSameInterval() async throws {
        let plane = Plane(
            clock: ReplayClock(t0),
            [startPath: [started()], pollPath: [.fail, .reply(503, "{}"), ready]])
        let (core, _) = try await core(plane, services: [.identity])
        let client = identity(core, plane)
        let result = try await client.waitForSignIn(try await client.beginSignIn())
        XCTAssertTrue(result.isReady, "\(result)")
        XCTAssertEqual(gaps(plane.at(pollPath), from: t0), [2, 2, 2])
    }

    func testExpiryStopsPollingWithoutAskingAgain() async throws {
        let plane = Plane(
            clock: ReplayClock(t0), [startPath: [started(expiresIn: "5")], pollPath: [pending]])
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
        // The hook is in place before the task can make its first request, and the gate keeps
        // the task from polling until the box holds it, so the first poll always cancels.
        let box = TaskBox()
        plane.onRequest = { box.cancel() }
        let (gate, open) = AsyncStream<Void>.makeStream()
        let task = Task {
            for await _ in gate { break }
            return try await client.waitForSignIn(prompt)
        }
        box.set(task)
        open.yield()
        open.finish()
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
            reacquire: { current, _ in
                guard
                    let response = try? await core.request(
                        core.endpoints.licenseToken, method: "POST",
                        headers: ["authorization": "Bearer \(current)"]),
                    response.status == 200,
                    let body = try? JSONDecoder().decode([String: JSONValue].self, from: response.body),
                    let token = body["token"]?.stringValue
                else { return nil }
                return Reacquired(token: token, source: .reacquire)
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

    func testAPrintedMintedTokenHidesTheToken() {
        let minted = MintedToken(token: "minted-secret", expiresAt: t0 + 600)
        var dumped = ""
        dump(minted, to: &dumped)
        for printed in [String(describing: minted), String(reflecting: minted), "\(minted)", dumped] {
            XCTAssertFalse(printed.contains("minted-secret"), printed)
            XCTAssertTrue(printed.contains(String(t0 + 600)), printed)
            XCTAssertTrue(printed.contains("[redacted]"), printed)
        }
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
        for bad in ["../license", "Music", "a/b", "", "musickit\n", "a\n"] {
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
