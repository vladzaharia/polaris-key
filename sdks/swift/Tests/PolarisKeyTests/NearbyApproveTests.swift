// @pkey-feature identity.nearby
//
// Nearby sign-in on the approving device M (I-44.13; WIRE-CONTRACT-V5 §12.11.5, §15.6.1): `nearby/approve`
// behind number matching, the licence choice, the answer given to the LAN session, and the wrap sent to the new
// device. M and D run the real engines over the in-memory LAN of the CC-15 fixtures; the Worker is a fake that
// answers `nearby/approve` and the key routes.

import Foundation
import PolarisKeyPlatform
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore
@testable import PolarisKeyIdentity

private let product = nearbySlug
private let base = "https://key.plrs.im"
private let approvePath = "/\(product)/identity/nearby/approve"
private let keysPath = "/\(product)/devices/keys"
private let discoveryPath = "/\(product)/.well-known/polaris.json"
private let mDeviceId = "dev_" + String(repeating: "M", count: 28)
private let mToken = "pkeyt_" + String(repeating: "m", count: 28)

// MARK: - The Worker

private final class Worker: PolarisTransport, @unchecked Sendable {
    struct Call {
        let path: String
        let body: [String: JSONValue]?
        let authorization: String?
        let device: String?
    }

    private let lock = NSLock()
    private var approveAnswers: [(Int, String)] = []
    private var callsValue: [Call] = []
    private var namesNearby = true
    var keysStatus = 200
    var down = false

    var calls: [Call] { lock.withLock { callsValue } }
    func calls(_ path: String) -> [Call] { calls.filter { $0.path == path } }
    func answers(_ a: [(Int, String)]) { lock.withLock { approveAnswers = a } }
    func lose(nearby: Bool) { lock.withLock { namesNearby = !nearby } }

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        let path = request.url.path
        let body = request.body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }?.objectValue
        let (named, next, isDown): (Bool, (Int, String)?, Bool) = lock.withLock {
            callsValue.append(
                Call(
                    path: path, body: body,
                    authorization: request.headers.first { $0.key.lowercased() == "authorization" }?.value,
                    device: request.headers.first { $0.key.lowercased() == "x-pkey-device" }?.value))
            var next: (Int, String)?
            if path == approvePath, !approveAnswers.isEmpty {
                next = approveAnswers.count > 1 ? approveAnswers.removeFirst() : approveAnswers[0]
            }
            return (namesNearby, next, down)
        }
        if path == discoveryPath {
            return PolarisResponse(
                status: 200, body: Data(try discovery(naming: named).utf8),
                headers: ["content-type": "application/json"])
        }
        if path == keysPath {
            return PolarisResponse(
                status: keysStatus, body: Data(#"{"keySeq":1}"#.utf8), headers: ["content-type": "application/json"])
        }
        if path == approvePath {
            if isDown { throw PolarisError(code: ErrorCode.networkError, message: "down") }
            guard let next else { return PolarisResponse(status: 404, body: Data(#"{"error":"not_found"}"#.utf8)) }
            return PolarisResponse(
                status: next.0, body: Data(next.1.utf8), headers: ["content-type": "application/json"])
        }
        return PolarisResponse(status: 404, body: Data("{}".utf8))
    }

    private func discovery(naming: Bool) throws -> String {
        let all = try TranscriptFiles.load()
        let t = try XCTUnwrap(all.first { $0.id == (naming ? "nearby-happy" : "nearby-disabled") })
        let step = try XCTUnwrap(t.steps.first { $0.action == "discover" })
        return String(
            decoding: try JSONEncoder().encode(try XCTUnwrap(step.exchanges.items.first?.response.body)),
            as: UTF8.self)
    }
}

private let approved = #"{"status":"approved","deviceLabel":"Living-room console"}"#
private func chooseBody(ids: [String] = ["lic_a", "lic_b"], create: Bool = false) -> String {
    let rows = ids.map {
        #"{"id":"\#($0)","tierName":"djdl","name":null,"origin":"key","access":"seats","seats":{"used":0,"limit":5},"current":false,"expiresAt":null,"state":"free","replace":null,"freeDeviceUrl":null}"#
    }.joined(separator: ",")
    let createOffer = create ? #"{"tierName":"djdl","access":"seats"}"# : "null"
    return
        #"{"status":"choose","choices":{"state":"choose","choices":[\#(rows)],"keep":false,"preselected":"\#(ids[0])","create":\#(createOffer),"getLicense":null}}"#
}

// MARK: - A key ring that logs

/// M's key ring: logs the order of seal, send and put; its `put` can be held until the test lets it go.
private final class LoggingRing: NearbyKeyring, @unchecked Sendable {
    private let lock = NSLock()
    private var events: [String] = []
    private var sealed: [(String, String)] = []
    var holds = false
    var sealFails = false
    var putFails = false
    var isUnlocked = true
    private var gate: CheckedContinuation<Void, Never>?
    private var open = false

    var unlocked: Bool { isUnlocked }
    var log: [String] { lock.withLock { events } }
    var arguments: [(String, String)] { lock.withLock { sealed } }

    func sealWrapTo(deviceId: String, agreeKey: String) async throws -> Data {
        lock.withLock {
            events.append("seal")
            sealed.append((deviceId, agreeKey))
        }
        if sealFails { throw PolarisError(code: ErrorCode.syncLocked, message: "locked") }
        return Data(#"{"ringId":"rg_x"}"#.utf8)
    }

    func putWrap(deviceId: String, record: Data) async throws {
        if holds {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                let now = lock.withLock { () -> Bool in
                    if open { return true }
                    gate = c
                    return false
                }
                if now { c.resume() }
            }
        }
        lock.withLock { events.append("put") }
        if putFails { throw PolarisError(code: ErrorCode.keyringConflict, message: "conflict") }
    }

    func adoptWrap(_ record: Data) async throws -> Bool { false }

    func release() {
        let g = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            open = true
            defer { gate = nil }
            return gate
        }
        g?.resume()
    }
}

// MARK: - The rig

private final class World: @unchecked Sendable {
    let worker = Worker()
    let approverNet = FakeApproverNet()
    let requesterNet = FakeRequesterNet()
    let dKeys: DeviceKeyStore
    let mKeys = FixtureKeyPort()
    let mCore: CoreContext
    let identity: IdentityClient
    let dCloud: CloudConnect
    let asks = NBox<[NearbyAsk]>([])
    let ring: LoggingRing
    let mSignedIn = NBox(true)

    init(ring: LoggingRing = LoggingRing(), token: String? = mToken) async throws {
        self.ring = ring
        dKeys = try DeviceKeyStore.inMemory()
        mKeys.use(label: "transcript-nearby-m-1")
        let store = InMemoryStore(productSlug: product, deviceId: mDeviceId)
        if let token { await store.setToken(token) }
        mCore = try CoreContext(
            options: CoreOptions(
                productSlug: product, baseUrl: base, version: "1.0.0", pinnedKeys: [:], trustRefresh: false,
                store: store, transport: worker, requestTimeoutSeconds: 0,
                expectedServices: [.license, .config, .identity], clock: { 1_700_000_000 }))
        try await mCore.start()
        identity = IdentityClient(core: mCore, onAcquired: {}, sleep: { _ in })
        let core = mCore
        let signed = mSignedIn
        let keys = dKeys
        let an = approverNet
        let rn = requesterNet
        func deps(
            signer: @escaping @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String)
        ) -> NearbyDeps {
            NearbyDeps(
                slug: product, now: { 1_800_000_000 }, requireIdentity: {},
                identity: { fresh in
                    if fresh { _ = await core.discover() }
                    return await core.discoveryDocument?.identity
                }, signedIn: { signed.value }, signer: signer, approverNetwork: an,
                requesterNetwork: rn)
        }
        let mk = mKeys
        let mCloud = CloudConnect(
            connect: try await World.connect(), nearby: deps(signer: { (mk, mDeviceId) }))
        dCloud = CloudConnect(
            connect: try await World.connect(),
            nearby: deps(signer: {
                _ = try await keys.ensure()
                return (keys, nearbyDeviceId)
            }))
        let lan: any NearbyApproverLan = mCloud.nearby
        let ringRef = ring
        identity.installNearby(
            NearbyBinding(
                signer: { (mk, mDeviceId) }, lan: nil, approver: { lan },
                keyring: { @Sendable () -> (any NearbyKeyring)? in ringRef }))
        _ = await mCore.discover()
    }

    /// A Connect client the clouds hang on; nothing here starts it.
    private static func connect() async throws -> ConnectClient {
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: product, baseUrl: base, version: "1.0.0", pinnedKeys: [:], trustRefresh: false,
                store: InMemoryStore(productSlug: product, deviceId: String(repeating: "C", count: 32)),
                transport: Worker(), requestTimeoutSeconds: 0))
        return ConnectClient(
            core: core,
            options: ConnectOptions(
                keys: try DeviceKeyStore.inMemory(), store: ConnectStateStore.inMemory(), allowEphemeralKeys: true),
            accessGroup: nil)
    }

    func startApprover(prompt: Bool = true) async throws -> NearbyApprover {
        let asks = asks
        return try await identity.nearby.onRequest(
            NearbyApproverOptions(prompt: prompt, background: !prompt, label: "Ana's Mac")
        ) { ask in asks.mutate { $0.append(ask) } }
    }

    /// D's person taps M's advert; D shows `code`.
    func dial() async throws -> (requester: NearbyRequester, code: String) {
        let d = try await dCloud.nearby.request(
            NearbyRequestOptions(request: nearbyRequestHandle, label: "Ben's Switch", redialSeconds: 0.05))
        requesterNet.up(approverNet)
        await nearbyUntil("listed") { await d.approvers().count == 1 }
        return (d, try await d.choose(try await d.approvers()[0].id))
    }

    /// D shows `code`; M raises an ask.
    func reachTheCode() async throws -> (ask: NearbyAsk, requester: NearbyRequester, code: String) {
        let (d, code) = try await dial()
        await nearbyUntil("prompt") { self.asks.value.count == 1 }
        return (asks.value[0], d, code)
    }
}

// MARK: - The tests

final class NearbyApproveTests: XCTestCase {
    func testTheRightCodeApprovesWithExactlyTheVerifiedRequestsKeysAndIds() async throws {
        let w = try await World()
        w.worker.answers([(200, approved)])
        let approver = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        XCTAssertEqual(ask.device, "Ben's Switch")
        XCTAssertEqual(ask.codes.count, 3)
        XCTAssertTrue(ask.codes.contains(code))
        let results = NBox<[VouchStatus]>([])
        d.onResult { s in results.mutate { $0.append(s) } }
        let keys = try await w.dKeys.ensure()
        let step = try await ask.pick(code)
        guard case .approved = step else { return XCTFail("\(step)") }
        let calls = w.worker.calls(approvePath)
        XCTAssertEqual(calls.count, 1)
        let body = try XCTUnwrap(calls[0].body)
        XCTAssertEqual(body["request"]?.stringValue, nearbyRequestHandle)
        XCTAssertEqual(body["deviceId"]?.stringValue, nearbyDeviceId, "D's deviceId from VOUCH_REQ, not M's own")
        XCTAssertEqual(body["signKey"]?.stringValue, keys.signKey)
        XCTAssertEqual(body["agreeKey"]?.stringValue, keys.agreeKey)
        XCTAssertEqual(body["decision"]?.stringValue, "approve")
        XCTAssertNil(body["choice"])
        XCTAssertFalse((body["proof"]?.stringValue ?? "").isEmpty)
        XCTAssertEqual(calls[0].authorization, "Bearer \(mToken)")
        XCTAssertEqual(calls[0].device, mDeviceId)
        await nearbyUntil("the result") { results.value == [.approved] }
        await approver.stop()
        await d.close()
    }

    func testAWrongCodeCallsNoRouteAndNothingIsDelivered() async throws {
        let w = try await World()
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        let step = try await ask.pick(ask.codes.first { $0 != code }!)
        guard case .mismatch = step else { return XCTFail("\(step)") }
        XCTAssertTrue(w.worker.calls(approvePath).isEmpty)
        let result = await d.result()
        XCTAssertNil(result)
        await w.mCoreSignOutStops()
    }

    func testNoneOfTheseMatchCallsNoRouteAndClosesTheSession() async throws {
        let w = try await World()
        _ = try await w.startApprover()
        let (ask, d, _) = try await w.reachTheCode()
        let ended = NBox(0)
        ask.onEnd { ended.mutate { $0 += 1 } }
        await ask.deny()
        await nearbyUntil("the session ends") { ended.value == 1 }
        XCTAssertTrue(w.worker.calls(approvePath).isEmpty)
        // After it, a pick is refused: the answer was "none of these".
        do {
            _ = try await ask.pick("000 000")
            XCTFail("a pick after the deny must not reach the route")
        } catch {}
        XCTAssertTrue(w.worker.calls(approvePath).isEmpty)
        await d.close()
    }

    func testAskingTwiceGivesTheFirstAnswerAndNeverASecondApprove() async throws {
        let w = try await World()
        w.worker.answers([(200, approved)])
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        async let first = ask.pick(code)
        async let second = ask.pick(code)
        let (a, b) = try await (first, second)
        guard case .approved = a, case .approved = b else { return XCTFail("\(a) \(b)") }
        XCTAssertEqual(w.worker.calls(approvePath).count, 1)
        await d.close()
    }

    func testTheLicenceChoiceIsOneTapPerLicenceAndEachChoiceAnswersOnce() async throws {
        let w = try await World()
        w.worker.answers([(200, chooseBody(create: true)), (200, approved)])
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        let step = try await ask.pick(code)
        guard case .choose(let choose) = step else { return XCTFail("\(step)") }
        XCTAssertEqual(choose.choices.choices.map(\.id), ["lic_a", "lic_b"])
        XCTAssertNotNil(choose.choices.create)
        let done = try await choose.choose(.license("lic_b"))
        guard case .approved = done else { return XCTFail("\(done)") }
        let calls = w.worker.calls(approvePath)
        XCTAssertEqual(calls.count, 2)
        XCTAssertNil(calls[0].body?["choice"], "the first ask carries no choice")
        XCTAssertEqual(calls[1].body?["decision"]?.stringValue, "approve")
        XCTAssertEqual(
            calls[1].body?["choice"], .object(["kind": .string("license"), "licenseId": .string("lic_b")]))
        do {
            _ = try await choose.choose(.license("lic_a"))
            XCTFail("a second tap on the same choice must not reach the route")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.invalidOptions)
        }
        XCTAssertEqual(w.worker.calls(approvePath).count, 2)
        await d.close()
    }

    func testDenyAtTheChoiceTellsTheWorkerAndTheNewDevice() async throws {
        let w = try await World()
        w.worker.answers([(200, chooseBody()), (204, "")])
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        let results = NBox<[VouchStatus]>([])
        d.onResult { s in results.mutate { $0.append(s) } }
        guard case .choose(let choose) = try await ask.pick(code) else { return XCTFail("no choice") }
        let done = try await choose.cancel()
        guard case .denied = done else { return XCTFail("\(done)") }
        let calls = w.worker.calls(approvePath)
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[1].body?["decision"]?.stringValue, "deny")
        XCTAssertNil(calls[1].body?["choice"])
        await nearbyUntil("the result") { results.value == [.denied] }
        await d.close()
    }

    func testTheWorkersRefusalsAreTheScreensSteps() async throws {
        let cases: [(Int, String, String)] = [
            (403, "not_nearby", "notNearby"), (409, "device_limit", "deviceLimit"),
            (401, "unauthorized", "accountRequired"), (403, "account_required", "accountRequired"),
            (429, "rate_limited", "rateLimited"), (400, "invalid_grant", "expired"),
        ]
        for (status, code, want) in cases {
            let w = try await World()
            w.worker.answers([(status, #"{"error":{"code":"\#(code)"}}"#)])
            _ = try await w.startApprover()
            let (ask, d, picked) = try await w.reachTheCode()
            let step = try await ask.pick(picked)
            let got: String
            switch step {
            case .notNearby: got = "notNearby"
            case .deviceLimit: got = "deviceLimit"
            case .accountRequired: got = "accountRequired"
            case .rateLimited: got = "rateLimited"
            case .expired: got = "expired"
            default: got = "\(step)"
            }
            XCTAssertEqual(got, want, "\(status) \(code)")
            await d.close()
        }
    }

    func testADeviceKeysRequiredRegistersTheKeysOnceAndRetries() async throws {
        let w = try await World()
        w.worker.answers([(409, #"{"error":{"code":"device_keys_required"}}"#), (200, approved)])
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        let step = try await ask.pick(code)
        guard case .approved = step else { return XCTFail("\(step)") }
        XCTAssertEqual(w.worker.calls(keysPath).count, 1)
        XCTAssertEqual(w.worker.calls(approvePath).count, 2)
        XCTAssertEqual(w.worker.calls(keysPath)[0].authorization, "Bearer \(mToken)")
        await d.close()
    }

    func testASecondDeviceKeysRequiredEndsTheSessionInsteadOfLooping() async throws {
        let w = try await World()
        w.worker.answers([(409, #"{"error":{"code":"device_keys_required"}}"#)])
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        let step = try await ask.pick(code)
        guard case .expired = step else { return XCTFail("\(step)") }
        XCTAssertEqual(w.worker.calls(keysPath).count, 1)
        XCTAssertEqual(w.worker.calls(approvePath).count, 2)
        await d.close()
    }

    func testAnApproveThatGetsNoAnswerClosesTheSession() async throws {
        let w = try await World()
        w.worker.down = true
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        let ended = NBox(0)
        ask.onEnd { ended.mutate { $0 += 1 } }
        let step = try await ask.pick(code)
        guard case .expired = step else { return XCTFail("\(step)") }
        await nearbyUntil("the session closes") { ended.value == 1 }
        await d.close()
    }

    func testA404IsUnavailableOnlyAfterAFreshReadLostNearby() async throws {
        // Discovery still names nearby: the 404 is a refusal (an unknown request), not "the routes went away".
        let named = try await World()
        named.worker.answers([(404, #"{"error":"not_found"}"#)])
        let vouch = VerifiedVouch(
            request: nearbyRequestHandle, deviceId: nearbyDeviceId, signKey: "a", agreeKey: "b")
        guard
            case .refused(let status, let code, _, let finish) = try await named.identity.nearbyApprove(
                vouch, decision: "approve")
        else { return XCTFail("expected a refusal") }
        XCTAssertEqual(status, 404)
        XCTAssertEqual(code, "not_found")
        XCTAssertTrue(finish.discoveryNearby)
        let lost = try await World()
        lost.worker.answers([(404, #"{"error":"not_found"}"#)])
        lost.worker.lose(nearby: true)
        guard case .unavailable(let gone) = try await lost.identity.nearbyApprove(vouch, decision: "approve")
        else { return XCTFail("expected unavailable") }
        XCTAssertFalse(gone.discoveryNearby)
    }

    func testApproveNeedsASignInAndAProductThatServesIt() async throws {
        let signedOut = try await World(token: nil)
        let vouch = VerifiedVouch(
            request: nearbyRequestHandle, deviceId: nearbyDeviceId, signKey: "a", agreeKey: "b")
        do {
            _ = try await signedOut.identity.nearbyApprove(vouch, decision: "approve")
            XCTFail("expected account-required")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.accountRequired)
        }
        XCTAssertTrue(signedOut.worker.calls(approvePath).isEmpty)
        // A signed-out device cannot start the approver either.
        signedOut.mSignedIn.value = false
        do {
            _ = try await signedOut.startApprover()
            XCTFail("expected account-required")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.accountRequired)
        }
        let off = try await World()
        off.worker.lose(nearby: true)
        _ = await off.mCore.discover()
        do {
            _ = try await off.identity.nearbyApprove(vouch, decision: "approve")
            XCTFail("expected the typed N/A")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
            XCTAssertEqual(e.unsupported?.feature, Feature.identityNearby)
        }
        XCTAssertTrue(off.worker.calls(approvePath).isEmpty)
    }

    func testARuntimeThatCannotAdvertiseAnswersNearbyUnsupportedBeforeAnyRequest() async throws {
        let w = try await World()
        w.identity.installNearby(NearbyBinding(signer: { (w.mKeys, mDeviceId) }, lan: nil))
        do {
            _ = try await w.startApprover()
            XCTFail("expected nearby-unsupported")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.nearbyUnsupported)
            XCTAssertEqual(e.unsupported?.reason, UnsupportedReason.runtime)
        }
        let approver = await w.identity.nearby.available(role: .approver)
        XCTAssertFalse(approver)
    }

    func testAvailableNamesTheRolesEndpoints() async throws {
        let w = try await World()
        let approver = await w.identity.nearby.available(role: .approver)
        let requester = await w.identity.nearby.available(role: .requester)
        XCTAssertTrue(approver)
        XCTAssertFalse(requester, "M's binding has no request side")
    }

    // MARK: The wrap

    func testTheWrapIsSealedSentOverTheChannelAndOnlyThenStored() async throws {
        let ring = LoggingRing()
        ring.holds = true
        let w = try await World(ring: ring)
        w.worker.answers([(200, approved)])
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        let results = NBox<[VouchStatus]>([])
        let records = NBox<[NearbyRecord]>([])
        d.onResult { s in results.mutate { $0.append(s) } }
        d.onRecord { r in records.mutate { $0.append(r) } }
        let keys = try await w.dKeys.ensure()
        let stepTask = Task { try await ask.pick(code) }
        await nearbyUntil("the result") { results.value == [.approved] }
        // D's person confirms, so the channel copy reaches `onRecord` the moment it is sent.
        try await d.confirmAccount()
        await nearbyUntil("the wrap arrives") { records.value.count == 1 }
        XCTAssertEqual(w.ring.log, ["seal"], "the channel copy went out while the PUT had not happened")
        XCTAssertEqual(records.value[0].type, 0x0030)
        let sealed = try XCTUnwrap(w.ring.arguments.first)
        XCTAssertEqual(sealed.0, nearbyDeviceId, "sealed for the device in VOUCH_REQ")
        XCTAssertEqual(sealed.1, keys.agreeKey, "sealed to the agreement key in VOUCH_REQ and no other")
        w.ring.release()
        let step = try await stepTask.value
        guard case .approved = step else { return XCTFail("\(step)") }
        XCTAssertEqual(w.ring.log, ["seal", "put"])
        XCTAssertEqual(records.value.count, 1, "the wrap is sent once")
        await d.close()
    }

    func testNoWrapIsSentWhenTheRingIsLockedOrSealingFails() async throws {
        for mode in ["locked", "seal"] {
            let ring = LoggingRing()
            if mode == "locked" { ring.isUnlocked = false } else { ring.sealFails = true }
            let w = try await World(ring: ring)
            w.worker.answers([(200, approved)])
            _ = try await w.startApprover()
            let (ask, d, code) = try await w.reachTheCode()
            let records = NBox<[NearbyRecord]>([])
            d.onRecord { r in records.mutate { $0.append(r) } }
            let step = try await ask.pick(code)
            guard case .approved = step else { return XCTFail("\(mode): \(step)") }
            try await d.confirmAccount()
            await nearbySettle()
            XCTAssertTrue(records.value.isEmpty, mode)
            XCTAssertFalse(ring.log.contains("put"), mode)
            await d.close()
        }
    }

    func testAFailedStoreLeavesTheApprovalAndTheChannelCopyAsTheyAre() async throws {
        let ring = LoggingRing()
        ring.putFails = true
        let w = try await World(ring: ring)
        w.worker.answers([(200, approved)])
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        let records = NBox<[NearbyRecord]>([])
        d.onRecord { r in records.mutate { $0.append(r) } }
        let step = try await ask.pick(code)
        guard case .approved = step else { return XCTFail("\(step)") }
        try await d.confirmAccount()
        await nearbyUntil("the wrap arrives") { records.value.count == 1 }
        XCTAssertEqual(ring.log, ["seal", "put"])
        await d.close()
    }

    func testNoWrapGoesOutForADenialOrAChoice() async throws {
        let ring = LoggingRing()
        let w = try await World(ring: ring)
        w.worker.answers([(200, chooseBody()), (204, "")])
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        guard case .choose(let choose) = try await ask.pick(code) else { return XCTFail("no choice") }
        XCTAssertTrue(ring.log.isEmpty, "a choice is not an approval")
        _ = try await choose.cancel()
        XCTAssertTrue(ring.log.isEmpty, "a denial is not an approval")
        await d.close()
    }

    func testNothingPrintsTheHandleTheKeysOrTheProofs() async throws {
        let w = try await World()
        _ = try await w.startApprover()
        let (ask, d, code) = try await w.reachTheCode()
        let vouch = VerifiedVouch(request: nearbyRequestHandle, deviceId: nearbyDeviceId, signKey: "S", agreeKey: "A")
        for text in ["\(ask)", String(reflecting: ask), "\(vouch)", String(reflecting: vouch)] {
            XCTAssertFalse(text.contains(nearbyRequestHandle))
            XCTAssertFalse(text.contains(code.replacingOccurrences(of: " ", with: "")))
        }
        await d.close()
    }
}

extension World {
    fileprivate func mCoreSignOutStops() async {
        await dCloud.stopForSignOut()
    }
}

// MARK: - The model

#if canImport(SwiftUI)
    import PolarisKeyUICore

    @MainActor
    final class NearbyApprovalModelTests: XCTestCase {
        private func model(_ w: World) -> NearbyApprovalModel {
            NearbyApprovalModel(
                identity: w.identity, inputs: KitInputs(bundle: KitBundle(slug: product), services: [.identity]))
        }

        private func until(_ what: String, _ cond: @MainActor () -> Bool) async {
            for _ in 0..<500 where !cond() { try? await Task.sleep(nanoseconds: 10_000_000) }
            XCTAssertTrue(cond(), "timed out waiting for \(what)")
        }

        func testTheScreenOpensTheApproverShowsTheCodesAndTheRightOneApproves() async throws {
            let w = try await World()
            w.worker.answers([(200, approved)])
            let m = model(w)
            XCTAssertEqual(m.screen.state, .entry)
            await m.open()
            XCTAssertTrue(m.presented)
            XCTAssertEqual(m.screen.state, .entry, "waiting for a session")
            let (d, code) = try await w.dial()
            await until("the ask") { m.screen.state == .ask }
            XCTAssertEqual(m.inputs.nearbyApproval?.device, "Ben's Switch")
            XCTAssertEqual(m.codes.count, 3)
            XCTAssertTrue(m.codes.contains(code))
            await m.pick(code)
            XCTAssertEqual(m.screen.state, .approved)
            XCTAssertFalse(m.pending)
            XCTAssertEqual(w.worker.calls(approvePath).count, 1)
            await m.close()
            XCTAssertFalse(m.presented)
            await d.close()
        }

        func testAWrongCodeShowsTheMismatchAndCallsNoRoute() async throws {
            let w = try await World()
            let m = model(w)
            await m.open()
            let (d, code) = try await w.dial()
            await until("the ask") { m.screen.state == .ask }
            await m.pick(m.codes.first { $0 != code }!)
            XCTAssertEqual(m.screen.state, .mismatch)
            XCTAssertTrue(w.worker.calls(approvePath).isEmpty)
            await m.close()
            await d.close()
        }

        func testLeavingTheAskAnswersNoneOfTheseAndCallsNoRoute() async throws {
            let w = try await World()
            let m = model(w)
            await m.open()
            let (d, _) = try await w.dial()
            await until("the ask") { m.screen.state == .ask }
            let results = NBox<[VouchStatus]>([])
            d.onResult { s in results.mutate { $0.append(s) } }
            await m.close()
            XCTAssertTrue(w.worker.calls(approvePath).isEmpty)
            XCTAssertFalse(m.presented)
            XCTAssertTrue(w.approverNet.live.isEmpty, "the advert stopped")
            await d.close()
        }

        func testOneTapPerLicenceAndLeavingTheChoiceAnswersDeny() async throws {
            let w = try await World()
            w.worker.answers([(200, chooseBody(create: true)), (200, approved)])
            let m = model(w)
            await m.open()
            let (d, code) = try await w.dial()
            await until("the ask") { m.screen.state == .ask }
            await m.pick(code)
            XCTAssertEqual(m.screen.state, .choose)
            XCTAssertEqual(m.choices?.choices.map(\.id), ["lic_a", "lic_b"])
            XCTAssertNotNil(m.choices?.create)
            await m.chooseLicense("lic_a")
            XCTAssertEqual(m.screen.state, .approved)
            XCTAssertEqual(w.worker.calls(approvePath).count, 2)
            XCTAssertEqual(
                w.worker.calls(approvePath)[1].body?["choice"],
                .object(["kind": .string("license"), "licenseId": .string("lic_a")]))
            // A tap after the outcome does nothing.
            await m.chooseLicense("lic_b")
            XCTAssertEqual(w.worker.calls(approvePath).count, 2)
            await m.close()
            await d.close()
        }

        func testLeavingTheChoiceAnswersDenyOnTheWorker() async throws {
            let w = try await World()
            w.worker.answers([(200, chooseBody()), (204, "")])
            let m = model(w)
            await m.open()
            let (d, code) = try await w.dial()
            await until("the ask") { m.screen.state == .ask }
            await m.pick(code)
            XCTAssertEqual(m.screen.state, .choose)
            await m.close()
            let calls = w.worker.calls(approvePath)
            XCTAssertEqual(calls.count, 2)
            XCTAssertEqual(calls[1].body?["decision"]?.stringValue, "deny")
            await d.close()
        }

        func testDenyAtTheChoiceShowsTheDeniedStep() async throws {
            let w = try await World()
            w.worker.answers([(200, chooseBody()), (204, "")])
            let m = model(w)
            await m.open()
            let (d, code) = try await w.dial()
            await until("the ask") { m.screen.state == .ask }
            await m.pick(code)
            await m.deny()
            XCTAssertEqual(m.screen.state, .denied)
            await m.close()
            await d.close()
        }

        func testASignedOutDeviceAndAProductThatServesNothingAreSteps() async throws {
            let out = try await World(token: nil)
            out.mSignedIn.value = false
            let m1 = model(out)
            await m1.open()
            XCTAssertEqual(m1.screen.state, .accountRequired)
            let off = try await World()
            off.worker.lose(nearby: true)
            _ = await off.mCore.discover()
            let m2 = model(off)
            await m2.open()
            XCTAssertEqual(m2.screen.state, .notNearby)
        }
    }
#endif
