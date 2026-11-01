// @pkey-feature identity.nearby
//
// Nearby sign-in on the new device D (I-44.12; WIRE-CONTRACT-V5 §12.11.5, §15.6.1 rule 12): the unconfirmed
// mark in Core, the `nearby/start` and `nearby/poll` routes, and the session that joins them to the LAN request.
// The LAN request is a fake handle; the engine itself is NearbyRequesterTests'.

import Foundation
import XCTest

@testable import PolarisKeyCore
@testable import PolarisKeyIdentity

private let product = "djdl"
private let base = "https://key.plrs.im"
private let t0 = 1_700_000_000
private let subject = "ps_" + String(repeating: "A", count: 22)
private let handle = "nr_" + String(repeating: "B", count: 22)
private let startPath = "/\(product)/identity/nearby/start"
private let pollPath = "/\(product)/identity/nearby/poll"
private let signoutPath = "/\(product)/identity/signout"
private let discoveryPath = "/\(product)/.well-known/polaris.json"

// MARK: - A store that logs what is written

/// A store that records the order of its token and mark writes, and can refuse a mark.
private final class LoggedStore: Store, @unchecked Sendable {
    let inner: InMemoryStore
    private let lock = NSLock()
    private var events: [String] = []
    var failMark = false

    init() { inner = InMemoryStore(productSlug: product, deviceId: String(repeating: "D", count: 32)) }

    var log: [String] { lock.withLock { events } }
    private func note(_ s: String) { lock.withLock { events.append(s) } }

    func getToken() async throws -> String? { try await inner.getToken() }
    func setToken(_ token: String) async throws {
        note("token:set")
        await inner.setToken(token)
    }
    func clearToken() async throws {
        note("token:clear")
        await inner.clearToken()
    }
    func getDeviceId() async throws -> String { await inner.getDeviceId() }
    func readCache() async -> CacheRecord? { await inner.readCache() }
    func writeCache(_ record: CacheRecord) async throws { await inner.writeCache(record) }
    func clearCache() async throws { await inner.clearCache() }
    func readRecord(_ name: String) async -> Data? { await inner.readRecord(name) }
    func writeRecord(_ name: String, _ data: Data?) async { await inner.writeRecord(name, data) }
    func writeRecordChecked(_ name: String, _ data: Data?) async throws {
        if name == "token-unconfirmed" {
            if failMark && data != nil { throw StoreError.io(path: "mark", code: 5) }
            note(data == nil ? "mark:clear" : "mark:set")
        }
        await inner.writeRecord(name, data)
    }
}

// MARK: - The control plane

private final class Plane: PolarisTransport, @unchecked Sendable {
    struct Call {
        let path: String
        let body: [String: JSONValue]?
        let authorization: String?
    }

    private let lock = NSLock()
    private var answers: [String: [(Int, String)]] = [:]
    private var callsValue: [Call] = []

    var calls: [Call] { lock.withLock { callsValue } }
    func count(_ path: String) -> Int { calls.filter { $0.path == path }.count }
    func set(_ path: String, _ answers: [(Int, String)]) { lock.withLock { self.answers[path] = answers } }

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        let path = request.url.path
        let body = request.body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }?.objectValue
        let answer: (Int, String)? = lock.withLock {
            callsValue.append(Call(path: path, body: body, authorization: request.headers["authorization"]))
            guard var queue = answers[path], !queue.isEmpty else { return nil }
            let next = queue.count > 1 ? queue.removeFirst() : queue[0]
            answers[path] = queue
            return next
        }
        guard let answer else { return PolarisResponse(status: 404, body: Data("{}".utf8)) }
        return PolarisResponse(
            status: answer.0, body: Data(answer.1.utf8), headers: ["content-type": "application/json"])
    }
}

private func readyBody(token: String = "pkeyt_nearby_token") -> String {
    """
    {"access_token":"\(token)","token_type":"Bearer","scope":"email","schemaVersion":1,\
    "device":{"id":"x"},"license":{"id":"lic_1","name":"Ada Lovelace","email":"ada@example.com"},\
    "subject":"\(subject)"}
    """
}

private let startedBody = #"{"request":"\#(handle)","expiresIn":300,"interval":3}"#

/// The discovery document of the recorded happy path (it names nearby approval), with the sign-out endpoint.
private func discovery(naming: Bool = true) throws -> String {
    let all = try TranscriptFiles.load()
    let t = try XCTUnwrap(all.first { $0.id == (naming ? "nearby-happy" : "nearby-disabled") })
    let step = try XCTUnwrap(t.steps.first { $0.action == "discover" })
    var doc = try XCTUnwrap(step.exchanges.items.first?.response.body.objectValue)
    var services = doc["services"]?.objectValue ?? [:]
    var identity = services["identity"]?.objectValue ?? [:]
    var endpoints = identity["endpoints"]?.objectValue ?? [:]
    endpoints["signout"] = .string("\(base)\(signoutPath)")
    identity["endpoints"] = .object(endpoints)
    services["identity"] = .object(identity)
    doc["services"] = .object(services)
    return String(decoding: try JSONEncoder().encode(JSONValue.object(doc)), as: UTF8.self)
}

// MARK: - A fake LAN request

private final class FakeRequest: NearbyRequestHandle, @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    var list: [NearbyApproverInfo] = []
    var listeners: [@Sendable ([NearbyApproverInfo]) -> Void] = []
    var code = "482913"

    func count(_ k: String) -> Int { lock.withLock { counts[k] ?? 0 } }
    private func bump(_ k: String) { lock.withLock { counts[k, default: 0] += 1 } }

    func approvers() async -> [NearbyApproverInfo] { list }
    func result() async -> VouchStatus? { nil }
    func choose(_ id: String) async throws -> String {
        bump("choose")
        return code
    }
    func confirmAccount() async throws { bump("confirm") }
    func declineAccount() async { bump("decline") }
    func close() async { bump("close") }
    func onApprovers(_ fn: @escaping @Sendable ([NearbyApproverInfo]) -> Void) -> @Sendable () -> Void {
        listeners.append(fn)
        return {}
    }
    func onResult(_ fn: @escaping @Sendable (VouchStatus) -> Void) -> @Sendable () -> Void { {} }
}

private final class FakeLan: NearbySignInLan, @unchecked Sendable {
    let request = FakeRequest()
    private let lock = NSLock()
    private var optionsValue: [NearbyRequestOptions] = []
    var options: [NearbyRequestOptions] { lock.withLock { optionsValue } }
    func request(_ options: NearbyRequestOptions) async throws -> any NearbyRequestHandle {
        lock.withLock { optionsValue.append(options) }
        return request
    }
}

private final class Events: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [IdentityChange] = []
    func add(_ c: IdentityChange) { lock.withLock { items.append(c) } }
    var kinds: [String] { lock.withLock { items.map(\.kind) } }
}

// MARK: - The rig

private struct Rig {
    let core: CoreContext
    let store: LoggedStore
    let plane: Plane
    let identity: IdentityClient
    let lan: FakeLan
    let timers: ManualTimers
    let events: Events
    let acquired: NBox<Int>
    let clock: ReplayClock
    let sleeps: NBox<[Double]>
}

private func rig(
    lanAvailable: Bool = true, token: String? = nil, naming: Bool = true, keys: String = "nearby-d-1"
) async throws -> Rig {
    let store = LoggedStore()
    if let token { await store.inner.setToken(token) }
    let plane = Plane()
    plane.set(discoveryPath, [(200, try discovery(naming: naming))])
    plane.set(startPath, [(201, startedBody)])
    plane.set(signoutPath, [(200, #"{"released":true}"#)])
    let clock = ReplayClock(t0)
    let core = try CoreContext(
        options: CoreOptions(
            productSlug: product, baseUrl: base, version: "1.0.0", pinnedKeys: [:], trustRefresh: false,
            store: store, transport: plane, requestTimeoutSeconds: 0,
            expectedServices: [.license, .config, .identity], clock: { clock.now }))
    try await core.start()
    let acquired = NBox(0)
    let sleeps = NBox<[Double]>([])
    let identity = IdentityClient(
        core: core, onAcquired: { acquired.mutate { $0 += 1 } },
        sleep: { seconds in
            try Task.checkCancellation()
            sleeps.mutate { $0.append(seconds) }
            clock.now += Int(seconds.rounded(.up))
        })
    let events = Events()
    identity.installIdentityEvents { events.add($0) }
    identity.installSignOut { try await core.clearAll() }
    let port = FixtureKeyPort()
    port.use(label: keys)
    let lan = FakeLan()
    let timers = ManualTimers()
    let deviceId = await core.deviceId
    let signer: @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String) = { (port, deviceId) }
    let lanProbe: (@Sendable () -> (any NearbySignInLan)?)? =
        lanAvailable ? { @Sendable () -> (any NearbySignInLan)? in lan } : nil
    identity.installNearby(NearbyBinding(signer: signer, lan: lanProbe, timer: timers.timer))
    return Rig(
        core: core, store: store, plane: plane, identity: identity, lan: lan, timers: timers, events: events,
        acquired: acquired, clock: clock, sleeps: sleeps)
}

/// A session whose first poll is ready.
private func ready(_ r: Rig) async throws -> (NearbySignInSession, SignInOutcome) {
    r.plane.set(pollPath, [(200, readyBody())])
    let session = try await r.identity.signIn.startNearby()
    let outcome = try await session.wait()
    return (session, outcome)
}

// MARK: - Core: the unconfirmed mark

final class NearbyUnconfirmedMarkTests: XCTestCase {
    func testTheMarkIsWrittenBeforeTheTokenAndIsNoSignIn() async throws {
        let r = try await rig()
        try await r.core.setUnconfirmedToken("pkeyt_a")
        XCTAssertEqual(r.store.log, ["mark:set", "token:set"])
        let held = await r.core.tokenUnconfirmed
        XCTAssertTrue(held)
        let provenance = await r.core.tokenProvenance()
        XCTAssertNil(provenance, "an unconfirmed token is not a sign-in")
    }

    func testAMarkThatCannotBeWrittenStoresNoToken() async throws {
        let r = try await rig()
        r.store.failMark = true
        do {
            try await r.core.setUnconfirmedToken("pkeyt_a")
            XCTFail("expected a store failure")
        } catch {}
        let token = await r.core.token
        let stored = try await r.store.getToken()
        XCTAssertNil(token)
        XCTAssertNil(stored)
    }

    func testAStartDropsAnUnconfirmedToken() async throws {
        let r = try await rig()
        try await r.core.setUnconfirmedToken("pkeyt_a")
        let again = try CoreContext(
            options: CoreOptions(
                productSlug: product, baseUrl: base, version: "1.0.0", pinnedKeys: [:], trustRefresh: false,
                store: r.store, transport: r.plane, requestTimeoutSeconds: 0,
                expectedServices: [.license, .identity]))
        try await again.start()
        let token = await again.token
        let stored = try await r.store.getToken()
        let mark = await r.store.readRecord("token-unconfirmed")
        XCTAssertNil(token)
        XCTAssertNil(stored)
        XCTAssertNil(mark)
    }

    func testConfirmingMakesItASignInAndEndsTheSignedOutState() async throws {
        let r = try await rig()
        await r.core.setExplicitSignOut(true)
        try await r.core.setUnconfirmedToken("pkeyt_a")
        let stillOut = await r.core.explicitSignOut()
        XCTAssertTrue(stillOut, "an unconfirmed token never clears the signed-out flag")
        try await r.core.confirmToken()
        let provenance = await r.core.tokenProvenance()
        let flag = await r.core.explicitSignOut()
        let held = await r.core.tokenUnconfirmed
        XCTAssertEqual(provenance, .signin)
        XCTAssertFalse(flag)
        XCTAssertFalse(held)
    }

    func testAnotherSignInDropsTheMarkBeforeTheToken() async throws {
        let r = try await rig()
        try await r.core.setUnconfirmedToken("pkeyt_a")
        try await r.core.setToken("pkeyt_b", source: .register)
        XCTAssertEqual(r.store.log, ["mark:set", "token:set", "mark:clear", "token:set"])
        let held = await r.core.tokenUnconfirmed
        XCTAssertFalse(held)
    }

    func testAReacquireKeepsTheMark() async throws {
        let r = try await rig()
        try await r.core.setUnconfirmedToken("pkeyt_a")
        try await r.core.setToken("pkeyt_b", source: .reacquire)
        let held = await r.core.tokenUnconfirmed
        XCTAssertTrue(held)
    }

    func testClearingRemovesTheTokenBeforeTheMark() async throws {
        let r = try await rig()
        try await r.core.setUnconfirmedToken("pkeyt_a")
        try await r.core.clearAll()
        XCTAssertEqual(r.store.log.suffix(2), ["token:clear", "mark:clear"])
        let r2 = try await rig()
        try await r2.core.setUnconfirmedToken("pkeyt_a")
        try await r2.core.clearCredential()
        XCTAssertEqual(r2.store.log.suffix(2), ["token:clear", "mark:clear"])
    }

    func testRungOneAndTheCurrentIdentityNeverCountAnUnconfirmedToken() async throws {
        let r = try await rig()
        try await r.core.setUnconfirmedToken("pkeyt_a")
        let result = try await r.identity.autoSignIn()
        guard case .needsSignIn = result else { return XCTFail("rung 1 counted an unconfirmed token: \(result)") }
        let current = await r.identity.current()
        XCTAssertNil(current)
    }
}

// MARK: - The routes

final class NearbyRoutesTests: XCTestCase {
    func testAnUnsupportedRuntimeCallsNoRoute() async throws {
        let r = try await rig(lanAvailable: false)
        do {
            _ = try await r.identity.signIn.startNearby()
            XCTFail("expected nearby-unsupported")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.nearbyUnsupported)
            XCTAssertEqual(e.unsupported?.reason, UnsupportedReason.runtime)
        }
        XCTAssertEqual(r.plane.count(startPath), 0)
        XCTAssertEqual(r.plane.count(discoveryPath), 0)
    }

    func testAProductThatNamesNoNearbyApprovalSendsNothing() async throws {
        let r = try await rig(naming: false)
        do {
            _ = try await r.identity.signIn.startNearby()
            XCTFail("expected service-unavailable")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
            XCTAssertEqual(e.unsupported?.feature, Feature.identityNearby)
        }
        XCTAssertEqual(r.plane.count(startPath), 0)
    }

    func testStartSendsBothKeysAndAProofThenTheLanRequest() async throws {
        let r = try await rig()
        _ = try await r.core.setToken("pkeyt_held", source: .register)
        let session = try await r.identity.signIn.startNearby(NearbySignInOptions(deviceName: "Living-room console"))
        let call = try XCTUnwrap(r.plane.calls.first { $0.path == startPath })
        let body = try XCTUnwrap(call.body)
        let keys = FixtureKeyPort()
        keys.use(label: "nearby-d-1")
        let pub = try await keys.ensure()
        XCTAssertEqual(body["signKey"]?.stringValue, pub.signKey)
        XCTAssertEqual(body["agreeKey"]?.stringValue, pub.agreeKey)
        XCTAssertEqual(body["deviceName"]?.stringValue, "Living-room console")
        XCTAssertNotNil(body["proof"]?.stringValue)
        XCTAssertEqual(call.authorization, "Bearer pkeyt_held", "a held credential is the bearer; none is invented")
        XCTAssertEqual(r.lan.options.count, 1)
        XCTAssertEqual(r.lan.options.first?.request, handle)
        XCTAssertEqual(r.lan.options.first?.label, "Living-room console")
        XCTAssertEqual(r.lan.options.first?.expiresIn, 300)
        XCTAssertFalse("\(session)".contains(handle), "the request handle is not printed")
    }

    func testStartWithNoCredentialSendsNoBearer() async throws {
        let r = try await rig()
        _ = try await r.identity.signIn.startNearby()
        XCTAssertNil(r.plane.calls.first { $0.path == startPath }?.authorization)
    }

    func testARefusedStartCarriesTheWorkersCodeAndStatus() async throws {
        let r = try await rig()
        r.plane.set(startPath, [(400, #"{"error":{"code":"invalid_grant"}}"#)])
        do {
            _ = try await r.identity.signIn.startNearby()
            XCTFail("expected a refusal")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, "invalid_grant")
            XCTAssertEqual(e.status, 400)
        }
        XCTAssertTrue(r.lan.options.isEmpty, "no LAN request for a refused start")
    }

    func testAPollAfterTheKeysChangedIsNotSent() async throws {
        let r = try await rig()
        _ = try await r.identity.signIn.startNearby()
        let other = FixtureKeyPort()
        other.use(label: "nearby-other-1")
        let id = await r.core.deviceId
        r.identity.installNearby(NearbyBinding(signer: { (other, id) }, lan: { r.lan }))
        let session = NearbyStarted(request: handle, expiresIn: 300, interval: 3, signKey: "AAAA")
        do {
            _ = try await r.identity.nearbyPoll(session)
            XCTFail("expected a refusal")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
        XCTAssertEqual(r.plane.count(pollPath), 0)
    }

    func testA404AfterAFreshReadThatLostNearbyIsUnavailable() async throws {
        let r = try await rig()
        let session = try await r.identity.nearbyStart(deviceName: nil)
        r.plane.set(pollPath, [(404, #"{"error":{"code":"not_found"}}"#)])
        r.plane.set(discoveryPath, [(200, try discovery(naming: false))])
        let answer = try await r.identity.nearbyPoll(session)
        XCTAssertEqual(answer, .unavailable)
    }

    func testA404WhileDiscoveryStillNamesNearbyIsARefusal() async throws {
        let r = try await rig()
        let session = try await r.identity.nearbyStart(deviceName: nil)
        r.plane.set(pollPath, [(404, #"{"error":{"code":"not_found"}}"#)])
        do {
            _ = try await r.identity.nearbyPoll(session)
            XCTFail("expected a refusal")
        } catch let e as PolarisError {
            XCTAssertEqual(e.status, 404)
        }
    }

    func testAServerErrorIsTransientAndKeepsTheRetryAfter() async throws {
        let r = try await rig()
        let session = try await r.identity.nearbyStart(deviceName: nil)
        r.plane.set(pollPath, [(503, "{}")])
        do {
            _ = try await r.identity.nearbyPoll(session)
            XCTFail("expected a transient failure")
        } catch let e as NearbyTransient {
            XCTAssertNil(e.retryAfterSeconds)
        }
    }

    func testAReadyPollHoldsTheTokenUnconfirmedAndNamesNoSubjectYet() async throws {
        let r = try await rig()
        let session = try await r.identity.nearbyStart(deviceName: nil)
        r.plane.set(pollPath, [(200, readyBody())])
        guard case .ready(let ready) = try await r.identity.nearbyPoll(session) else { return XCTFail("not ready") }
        XCTAssertEqual(ready.subject, subject)
        XCTAssertEqual(ready.licenseId, "lic_1")
        XCTAssertEqual(ready.identity, SignInIdentity(name: "Ada Lovelace", email: "ada@example.com"))
        XCTAssertFalse("\(ready)".contains("pkeyt_nearby_token"))
        let held = await r.core.tokenUnconfirmed
        let token = await r.core.token
        XCTAssertTrue(held)
        XCTAssertEqual(token, "pkeyt_nearby_token")
        XCTAssertNil(r.identity.account, "the subject waits for the confirmation")
        XCTAssertEqual(r.acquired.value, 1)
        XCTAssertFalse(r.events.kinds.contains("signedIn"))
        let poll = try XCTUnwrap(r.plane.calls.first { $0.path == pollPath })
        XCTAssertNil(poll.authorization, "a poll carries no bearer")
    }
}

// MARK: - The session

final class NearbySignInSessionTests: XCTestCase {
    func testTheFirstPollIsOneIntervalAfterStartAndSlowDownLengthensIt() async throws {
        let r = try await rig()
        r.plane.set(
            pollPath,
            [
                (200, #"{"status":"pending"}"#), (429, #"{"status":"slow_down","interval":9}"#),
                (200, #"{"status":"timeout"}"#),
            ])
        let session = try await r.identity.signIn.startNearby()
        let outcome = try await session.wait()
        XCTAssertEqual(outcome, .expired)
        XCTAssertEqual(r.plane.count(pollPath), 3)
        let waits = r.sleeps.value
        XCTAssertEqual(waits.count, 3)
        XCTAssertTrue(waits[0] > 2.5 && waits[0] <= 3, "the first poll is one interval after start")
        XCTAssertTrue(waits[2] > 8.5 && waits[2] <= 9, "a slow_down lengthens every later wait")
        XCTAssertEqual(session.interval, 9)
        XCTAssertEqual(r.lan.request.count("close"), 1, "a lapse closes the LAN half")
    }

    func testADenialThrowsAndIsKept() async throws {
        let r = try await rig()
        r.plane.set(pollPath, [(200, #"{"status":"error","reason":"access_denied"}"#)])
        let session = try await r.identity.signIn.startNearby()
        for _ in 0..<2 {
            do {
                _ = try await session.wait()
                XCTFail("expected sign-in-denied")
            } catch let e as SignInError {
                XCTAssertEqual(e.code, ErrorCode.signInDenied)
            }
        }
        XCTAssertEqual(r.plane.count(pollPath), 1, "the first terminal answer is kept")
    }

    func testAReadyPollSignsNobodyInUntilTheConfirmation() async throws {
        let r = try await rig()
        let (session, outcome) = try await ready(r)
        guard case .signedIn(let signedIn) = outcome else { return XCTFail("expected signedIn, got \(outcome)") }
        XCTAssertEqual(signedIn.subject, subject)
        XCTAssertEqual(signedIn.identity?.email, "ada@example.com")
        XCTAssertEqual(r.events.kinds, [], "no signedIn event before the confirmation")
        XCTAssertNil(r.identity.account)
        let provenance = await r.core.tokenProvenance()
        XCTAssertNil(provenance)
        let again = try await session.wait()
        XCTAssertEqual(again, outcome, "a second wait gets the same answer")
        XCTAssertEqual(r.plane.count(pollPath), 1)

        try await session.confirmAccount()
        XCTAssertEqual(r.events.kinds, ["subjectChanged", "signedIn"])
        XCTAssertEqual(r.identity.account, subject)
        let after = await r.core.tokenProvenance()
        let held = await r.core.tokenUnconfirmed
        XCTAssertEqual(after, .signin)
        XCTAssertFalse(held)
        XCTAssertEqual(r.lan.request.count("confirm"), 1)
        XCTAssertEqual(r.plane.count(signoutPath), 0)
    }

    func testADeclineSignsOutAndDropsEverythingOnce() async throws {
        let r = try await rig()
        let (session, _) = try await ready(r)
        await session.declineAccount()
        await session.declineAccount()
        XCTAssertEqual(r.plane.count(signoutPath), 1, "one idempotent discard")
        XCTAssertEqual(r.plane.calls.first { $0.path == signoutPath }?.authorization, "Bearer pkeyt_nearby_token")
        let token = await r.core.token
        let mark = await r.store.readRecord("token-unconfirmed")
        let flag = await r.core.explicitSignOut()
        XCTAssertNil(token)
        XCTAssertNil(mark)
        XCTAssertTrue(flag, "the decline signed the device out")
        XCTAssertTrue(session.ended)
        XCTAssertEqual(r.lan.request.count("decline"), 1)
        XCTAssertGreaterThanOrEqual(r.lan.request.count("close"), 1)
        XCTAssertFalse(r.events.kinds.contains("signedIn"))
        XCTAssertNil(r.identity.account)
    }

    func testTheTokenGoesLocallyWhenTheWorkerCannotBeReached() async throws {
        let r = try await rig()
        r.plane.set(signoutPath, [(500, "{}")])
        let (session, _) = try await ready(r)
        await session.declineAccount()
        let token = await r.core.token
        let mark = await r.store.readRecord("token-unconfirmed")
        XCTAssertNil(token)
        XCTAssertNil(mark)
    }

    func testAHostEndDiscardsAndAConfirmAfterItThrows() async throws {
        let r = try await rig()
        let (session, _) = try await ready(r)
        session.cancel()
        await nearbyUntil("the discard") { r.plane.count(signoutPath) == 1 }
        let token = await r.core.token
        XCTAssertNil(token)
        do {
            try await session.confirmAccount()
            XCTFail("expected sign-in-failed")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
        let held = await r.core.tokenUnconfirmed
        XCTAssertFalse(held)
        XCTAssertFalse(r.events.kinds.contains("signedIn"))
    }

    func testTheDeadlineRunsFromTheReadyPollAndDiscards() async throws {
        let r = try await rig()
        let (session, _) = try await ready(r)
        XCTAssertEqual(r.timers.armed(300), 1)
        r.timers.fire(300)
        await nearbyUntil("the discard") { r.plane.count(signoutPath) == 1 }
        XCTAssertTrue(session.ended)
        let token = await r.core.token
        XCTAssertNil(token)
        do {
            try await session.confirmAccount()
            XCTFail("a confirm after the deadline throws")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
    }

    func testAConfirmCancelsTheDeadline() async throws {
        let r = try await rig()
        let (session, _) = try await ready(r)
        try await session.confirmAccount()
        XCTAssertEqual(r.timers.armed(300), 0)
        r.timers.fire(300)
        await nearbySettle()
        XCTAssertEqual(r.plane.count(signoutPath), 0)
        let token = await r.core.token
        XCTAssertEqual(token, "pkeyt_nearby_token")
        XCTAssertFalse(session.ended)
    }

    func testADeadlineThatFiresBeforeTheConfirmWinsAndTheConfirmThrows() async throws {
        let r = try await rig()
        let (session, _) = try await ready(r)
        r.timers.fire(300)
        do {
            try await session.confirmAccount()
            XCTFail("expected sign-in-failed")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
        await nearbyUntil("the discard") { r.plane.count(signoutPath) == 1 }
        XCTAssertFalse(r.events.kinds.contains("signedIn"))
    }

    func testAnAbandonedSessionsDeadlineLeavesALaterSignInAlone() async throws {
        let r = try await rig()
        let (session, _) = try await ready(r)
        // Another sign-in replaces the token before the deadline.
        try await r.core.setToken("pkeyt_later", source: .signin, person: true)
        r.timers.fire(300)
        await nearbyUntil("the end") { session.ended }
        await nearbySettle()
        XCTAssertEqual(r.plane.count(signoutPath), 0, "the later sign-in is not signed out")
        let token = await r.core.token
        XCTAssertEqual(token, "pkeyt_later")
    }

    func testAConfirmAfterALaterSignInReplacedTheTokenWritesNothing() async throws {
        let r = try await rig()
        let (session, _) = try await ready(r)
        try await r.core.setToken("pkeyt_later", source: .signin, person: true)
        do {
            try await session.confirmAccount()
            XCTFail("expected sign-in-failed")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
        XCTAssertNil(r.identity.account)
        XCTAssertFalse(r.events.kinds.contains("signedIn"))
        let token = await r.core.token
        XCTAssertEqual(token, "pkeyt_later")
        XCTAssertEqual(r.plane.count(signoutPath), 0)
    }

    func testAReadyPollAfterTheEndDiscardsAtOnce() async throws {
        let r = try await rig()
        r.plane.set(pollPath, [(200, readyBody())])
        let session = try await r.identity.signIn.startNearby()
        session.cancel()
        let outcome = try await session.wait()
        XCTAssertEqual(outcome, .cancelled)
        XCTAssertEqual(r.plane.count(pollPath), 0, "a cancelled session makes no poll")
        // The late case: the answer lands after the end.
        let r2 = try await rig()
        r2.plane.set(pollPath, [(200, readyBody())])
        let late = try await r2.identity.signIn.startNearby()
        let waiting = Task { try await late.wait() }
        await nearbyUntil("the poll") { r2.plane.count(pollPath) >= 1 }
        late.cancel()
        _ = try await waiting.value
        await nearbyUntil("the discard") { r2.plane.count(signoutPath) == 1 }
        let token = await r2.core.token
        XCTAssertNil(token)
        XCTAssertFalse(r2.events.kinds.contains("signedIn"))
    }

    func testTheEndListenersHearOnceAndALateOneAtOnce() async throws {
        let r = try await rig()
        let (session, _) = try await ready(r)
        let heard = NBox(0)
        session.onEnd { heard.mutate { $0 += 1 } }
        await session.declineAccount()
        await session.declineAccount()
        XCTAssertEqual(heard.value, 1)
        let late = NBox(0)
        session.onEnd { late.mutate { $0 += 1 } }
        XCTAssertEqual(late.value, 1)
    }

    func testAConfirmBeforeAnySignInThrows() async throws {
        let r = try await rig()
        let session = try await r.identity.signIn.startNearby()
        do {
            try await session.confirmAccount()
            XCTFail("expected sign-in-failed")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.signInFailed)
        }
    }

    func testTheRoutesGoingAwayEndsTheWaitWithServiceUnavailable() async throws {
        let r = try await rig()
        r.plane.set(pollPath, [(404, "{}")])
        let session = try await r.identity.signIn.startNearby()
        r.plane.set(discoveryPath, [(200, try discovery(naming: false))])
        do {
            _ = try await session.wait()
            XCTFail("expected service-unavailable")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
        }
    }

    func testApproverLabelsAreCleanedAndTheCodeIsKept() async throws {
        let r = try await rig()
        r.lan.request.list = [NearbyApproverInfo(id: "a1", label: "Ada\u{202E}'s phone", platform: "ios\u{0}")]
        let session = try await r.identity.signIn.startNearby()
        let list = await session.approvers()
        XCTAssertEqual(list.count, 1)
        XCTAssertFalse(list[0].label?.contains("\u{202E}") ?? false)
        XCTAssertEqual(list[0].platform, "Unknown")
        let code = try await session.choose("a1")
        XCTAssertEqual(code, "482913")
        XCTAssertEqual(session.code, "482913")
        XCTAssertFalse("\(session)".contains("482913"))
    }
}

// MARK: - The kit

#if canImport(SwiftUI)
    import PolarisKey
    import PolarisKeyUICore

    @MainActor
    final class NearbyKitTests: XCTestCase {
        private struct Kit {
            let model: PolarisKeyGateModel
            let client: PolarisKeyClient
            let plane: Plane
            let lan: FakeLan
        }

        private func kit(lanAvailable: Bool = true) async throws -> Kit {
            let plane = Plane()
            plane.set(discoveryPath, [(200, try discovery())])
            plane.set(startPath, [(201, #"{"request":"\#(handle)","expiresIn":300,"interval":1}"#)])
            plane.set(signoutPath, [(200, #"{"released":true}"#)])
            let client = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: product, baseUrl: base, version: "1.0.0", pinnedKeys: [:], trustRefresh: false,
                    store: InMemoryStore(productSlug: product, deviceId: String(repeating: "D", count: 32)),
                    transport: plane, expectedServices: [.license, .config, .identity], fingerprint: false))
            let port = FixtureKeyPort()
            port.use(label: "nearby-d-1")
            let deviceId = await client.core.deviceId
            let lan = FakeLan()
            let signer: @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String) = { (port, deviceId) }
            let probe: (@Sendable () -> (any NearbySignInLan)?)? =
                lanAvailable ? { @Sendable () -> (any NearbySignInLan)? in lan } : nil
            client.identity.installNearby(NearbyBinding(signer: signer, lan: probe))
            _ = await client.core.discover()
            let model = PolarisKeyGateModel(client: client, options: KitGateOptions(autoSignIn: false))
            return Kit(model: model, client: client, plane: plane, lan: lan)
        }

        private func until(
            _ what: String, seconds: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line,
            _ cond: @MainActor () -> Bool
        ) async {
            let end = Date().addingTimeInterval(seconds)
            while !cond() {
                if Date() > end { return XCTFail("timed out: \(what)", file: file, line: line) }
                try? await Task.sleep(nanoseconds: 5_000_000)
            }
        }

        func testThePromptShowsOnlyWhenThisDeviceCanLookAndTheProductServesIt() async throws {
            let off = try await kit(lanAvailable: false)
            await off.model.offerNearby()
            XCTAssertNil(off.model.inputs.autoSignIn)
            let on = try await kit()
            await on.model.offerNearby()
            XCTAssertEqual(on.model.inputs.autoSignIn?.step, .nearbyPrompt)
            XCTAssertEqual(on.plane.count(startPath), 0, "nothing starts until the person taps Continue")
        }

        func testThePhoneFlowFromTheTapToSignedIn() async throws {
            let k = try await kit()
            k.lan.request.list = [NearbyApproverInfo(id: "a1", label: "Ada's phone", platform: "ios")]
            k.plane.set(pollPath, [(200, readyBody())])
            await k.model.offerNearby()
            await k.model.nearbyContinue()
            XCTAssertEqual(k.model.inputs.autoSignIn?.step, .nearbyWait)
            await until("the list") { k.model.nearbyApprovers.count == 1 }
            XCTAssertNil(k.model.inputs.autoSignIn?.code)
            await k.model.nearbyChoose("a1")
            XCTAssertEqual(k.model.inputs.autoSignIn?.code, "482913")
            XCTAssertEqual(k.lan.request.count("choose"), 1)
            await until("the done step") { k.model.inputs.autoSignIn?.step == .nearbyDone }
            XCTAssertEqual(k.model.inputs.autoSignIn?.email, "ada@example.com")
            let held = await k.client.core.tokenUnconfirmed
            XCTAssertTrue(held, "nothing is signed in until the person confirms")
            await k.model.nearbyConfirm()
            let after = await k.client.core.tokenUnconfirmed
            let provenance = await k.client.core.tokenProvenance()
            XCTAssertFalse(after)
            XCTAssertEqual(provenance, .signin)
            XCTAssertNil(k.model.inputs.autoSignIn)
            XCTAssertEqual(k.plane.count(signoutPath), 0)
        }

        func testNotYouDeclinesAndSignsTheDeviceOut() async throws {
            let k = try await kit()
            k.plane.set(pollPath, [(200, readyBody())])
            await k.model.offerNearby()
            await k.model.nearbyContinue()
            await until("the done step") { k.model.inputs.autoSignIn?.step == .nearbyDone }
            await k.model.nearbyNotYou()
            XCTAssertEqual(k.plane.count(signoutPath), 1)
            XCTAssertEqual(k.lan.request.count("decline"), 1)
            let token = await k.client.core.token
            XCTAssertNil(token)
            XCTAssertNil(k.model.inputs.autoSignIn)
        }

        func testLeavingTheWaitByAnyRouteCancelsTheRequest() async throws {
            let k = try await kit()
            k.plane.set(pollPath, [(200, #"{"status":"pending"}"#)])
            await k.model.offerNearby()
            await k.model.nearbyContinue()
            await until("the wait") { k.model.inputs.autoSignIn?.step == .nearbyWait }
            k.model.cancelSignIn()
            await until("the LAN request closes") { k.lan.request.count("close") >= 1 }
            XCTAssertNil(k.model.inputs.autoSignIn)
            XCTAssertEqual(k.plane.count(signoutPath), 0, "nothing was signed in")
        }

        func testLeavingTheConfirmScreenSignsTheDeviceOutAgain() async throws {
            let k = try await kit()
            k.plane.set(pollPath, [(200, readyBody())])
            await k.model.offerNearby()
            await k.model.nearbyContinue()
            await until("the done step") { k.model.inputs.autoSignIn?.step == .nearbyDone }
            k.model.cancelSignIn()
            await until("the discard") { k.plane.count(signoutPath) == 1 }
            for _ in 0..<400 where await k.client.core.token != nil {
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
            let token = await k.client.core.token
            XCTAssertNil(token)
        }

        func testARefusedStartShowsTheCodeOfTheRefusal() async throws {
            let k = try await kit()
            k.plane.set(startPath, [(400, #"{"error":{"code":"rate_limited"}}"#)])
            await k.model.offerNearby()
            await k.model.nearbyContinue()
            XCTAssertEqual(k.model.inputs.error?.code, "rate_limited")
            XCTAssertNil(k.model.inputs.autoSignIn)
        }
    }
#endif
