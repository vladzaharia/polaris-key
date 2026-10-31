// @pkey-feature identity.nearby
// CC-15.S4: `client.cloudConnect.nearby` end to end (WIRE-CONTRACT-V5 §15.6.1): two devices in one process
// over an in-memory LAN (the fake networks of the S2 and S3 tests), each behind its own `CloudConnect` with the
// Identity gating and a stub `approve`. Connect is never started: nearby approval works with it off (Q6). Mirrors
// sdk-node's `nearby.e2e.test.ts`, including the sign-out races of its fix round (B1, B2).

import Foundation
import PolarisKeyPlatform
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

private let sub = "ps_AbCdEfGhIjKlMnOpQrStUv"
private let selfId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

private final class World: @unchecked Sendable {
    let approverNet = FakeApproverNet()
    let requesterNet = FakeRequesterNet()
    let served = NBox(true)
    let mSignedIn = NBox(true)
    let identityFragment = NBox<IdentityDiscovery?>(
        IdentityDiscovery(
            endpoints: ["nearbyStart": "/s", "nearbyPoll": "/p", "nearbyApprove": "/a"], nearby: true))
    let identityOn = NBox(true)
    let dKeys: DeviceKeyStore
    let hangSigner = NBox(false)
    let mApprovals = NBox<[NearbyApproval]>([])
    let mCloud: CloudConnect
    let dCloud: CloudConnect
    let client: PolarisKeyClient

    init(client: PolarisKeyClient) throws {
        self.client = client
        dKeys = try DeviceKeyStore.inMemory()
        let an = approverNet
        let rn = requesterNet
        let fragment = identityFragment
        let on = identityOn
        let signed = mSignedIn
        func deps(
            approver: Bool, signer: @escaping @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String)
        )
            -> NearbyDeps
        {
            NearbyDeps(
                slug: nearbySlug, now: { 1_800_000_000 },
                requireIdentity: {
                    if !on.value {
                        throw PolarisError(
                            code: PolarisError.serviceUnavailable, message: "The identity service is off.",
                            unsupported: Unsupported(
                                feature: Feature.identityNearby, reason: UnsupportedReason.product, detail: "off"))
                    }
                },
                identity: { _ in fragment.value }, signedIn: { signed.value }, signer: signer,
                approverNetwork: an, requesterNetwork: rn)
        }
        let keys = dKeys
        let hang = hangSigner
        let dSigner: @Sendable () async throws -> (port: any DeviceKeyPort, deviceId: String) = {
            while hang.value { try await Task.sleep(nanoseconds: 10_000_000) }
            _ = try await keys.ensure()
            return (keys, nearbyDeviceId)
        }
        mCloud = CloudConnect(connect: client.connect, nearby: deps(approver: true, signer: dSigner))
        dCloud = CloudConnect(connect: client.connect, nearby: deps(approver: false, signer: dSigner))
    }

    func startApprover(prompt: Bool = true) async throws -> NearbyApprover {
        let approvals = mApprovals
        return try await mCloud.nearby.onRequest(
            { a in approvals.mutate { $0.append(a) } },
            options: NearbyApproverOptions(prompt: prompt, background: !prompt, label: "Ana's Mac"))
    }

    func request() async throws -> NearbyRequester {
        try await dCloud.nearby.request(
            NearbyRequestOptions(request: nearbyRequestHandle, label: "Ben's Switch", redialSeconds: 0.05))
    }
}

final class NearbyE2ETests: XCTestCase {
    private let signer = TestSigner(kid: "connect-kid")
    private var server = StubServer()

    override func setUp() async throws { server = StubServer() }

    private func world() async throws -> World {
        let store = InMemoryStore(deviceId: selfId)
        let keys = try DeviceKeyStore.inMemory(productSlug: "djdl")
        let client = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: signer.trust,
                trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.license, .config, .connect], fingerprint: false,
                connect: ConnectOptions(keys: keys, store: ConnectStateStore.inMemory(), allowEphemeralKeys: true)))
        return try World(client: client)
    }

    // MARK: A full vouch with Connect off

    func testRunsAFullVouchWithConnectOffListTapCodesPickApproveResultWrap() async throws {
        let w = try await world()
        let approver = try await w.startApprover()
        let d = try await w.request()
        let results = NBox<[VouchStatus]>([])
        let records = NBox<[NearbyRecord]>([])
        d.onResult { s in results.mutate { $0.append(s) } }
        d.onRecord { r in records.mutate { $0.append(r) } }
        w.requesterNet.up(w.approverNet)
        await nearbyUntil("listed") { await d.approvers().count == 1 }
        let listed = await d.approvers()[0]
        XCTAssertEqual(listed.label, "Ana's Mac")
        XCTAssertEqual(listed.platform, connectPlatformName)
        // D's person taps; D shows its code and sends VOUCH_REQ; M shows three codes.
        let code = try await d.choose(listed.id)
        await nearbyUntil("prompt") { w.mApprovals.value.count == 1 }
        let a = w.mApprovals.value[0]
        XCTAssertEqual(a.label, "Ben's Switch")
        XCTAssertEqual(a.platform, connectPlatformName)
        XCTAssertEqual(a.codes.count, 3)
        XCTAssertTrue(a.codes.contains(code))
        // M's person picks D's code; the verified request is exactly what `approve` gets.
        let keys = try await w.dKeys.ensure()
        let worker = FakeApprove(request: nearbyRequestHandle, deviceId: nearbyDeviceId, keys: keys)
        guard case .request(let req) = try await a.pick(code) else { return XCTFail("no request") }
        XCTAssertEqual(req.signKey, keys.signKey)
        XCTAssertEqual(req.agreeKey, keys.agreeKey)
        XCTAssertEqual(req.deviceId, nearbyDeviceId)
        let out = try await a.finish(worker.answer(req))
        XCTAssertEqual(out, .sent(.approved))
        await nearbyUntil("result") { results.value == [.approved] }
        // The wrap is carried, and D holds it until its person confirms the account.
        try await a.sendRecord(type: PeerRecordType.keyringWrap, body: Data("wrap".utf8))
        await nearbySettle()
        XCTAssertTrue(records.value.isEmpty)
        try await d.confirmAccount()
        await nearbyUntil("wrap") { records.value.count == 1 }
        XCTAssertEqual(records.value[0].type, PeerRecordType.keyringWrap)
        XCTAssertEqual(worker.calls.value.count, 1)
        await approver.stop()
        await d.close()
    }

    func testAWrongPickCallsNoRouteAndDeliversNothing() async throws {
        let w = try await world()
        _ = try await w.startApprover()
        let d = try await w.request()
        w.requesterNet.up(w.approverNet)
        await nearbyUntil("listed") { await d.approvers().count == 1 }
        let code = try await d.choose(try await d.approvers()[0].id)
        await nearbyUntil("prompt") { w.mApprovals.value.count == 1 }
        let a = w.mApprovals.value[0]
        let keys = try await w.dKeys.ensure()
        let worker = FakeApprove(request: nearbyRequestHandle, deviceId: nearbyDeviceId, keys: keys)
        let got = try await a.pick(a.codes.first { $0 != code }!)
        XCTAssertEqual(got, .mismatch)
        XCTAssertTrue(worker.calls.value.isEmpty)
        let result = await d.result()
        XCTAssertNil(result)
        await w.mCloud.stopForSignOut()
        await w.dCloud.stopForSignOut()
    }

    // MARK: Sign-out

    func testSignOutStopsTheAdvertAndTheSessionsInTheRightOrder() async throws {
        let w = try await world()
        let approver = try await w.startApprover()
        let d = try await w.request()
        w.requesterNet.up(w.approverNet)
        await nearbyUntil("listed") { await d.approvers().count == 1 }
        XCTAssertEqual(w.approverNet.live.count, 1)
        await w.mCloud.stopForSignOut()
        XCTAssertTrue(w.approverNet.live.isEmpty)
        XCTAssertEqual(approver.status().state, .stopped)
        await w.dCloud.stopForSignOut()
        let closed = await d.isClosed()
        XCTAssertTrue(closed)
        XCTAssertEqual(w.requesterNet.browseStops.value, 1)
        // The handles are final: nothing brings the advert back.
        try await approver.resume()
        try await approver.setPrompt(true)
        XCTAssertEqual(approver.status().state, .stopped)
        XCTAssertTrue(w.approverNet.live.isEmpty)
    }

    func testAStopAllThatLandsWhileOnRequestIsStillStartingLeavesNoAdvert() async throws {
        let w = try await world()
        let gate = NBox(true)
        // The advert network holds `open` until released: the sign-out lands inside the start.
        let slow = SlowOpenNet(inner: w.approverNet, hold: gate)
        let cloud = CloudConnect(
            connect: w.client.connect,
            nearby: NearbyDeps(
                slug: nearbySlug, now: { 1_800_000_000 }, requireIdentity: {},
                identity: { _ in w.identityFragment.value }, signedIn: { true },
                signer: { (w.dKeys, nearbyDeviceId) }, approverNetwork: slow, requesterNetwork: w.requesterNet))
        let outcome = NBox<Error?>(nil)
        let done = NBox(false)
        Task {
            do {
                _ = try await cloud.nearby.onRequest(
                    { _ in }, options: NearbyApproverOptions(prompt: true))
            } catch { outcome.value = error }
            done.value = true
        }
        await nearbyUntil("open called") { slow.opens.value == 1 }
        await cloud.stopForSignOut()
        gate.value = false
        await nearbyUntil("onRequest returned") { done.value }
        XCTAssertEqual((outcome.value as? PolarisError)?.code, ErrorCode.accountRequired)
        XCTAssertTrue(w.approverNet.live.isEmpty, "the advert that was starting is torn down")
    }

    func testAStopAllThatLandsWhileRequestIsStartingClosesTheRequest() async throws {
        let w = try await world()
        w.hangSigner.value = true
        let outcome = NBox<Error?>(nil)
        let done = NBox(false)
        Task {
            do { _ = try await w.request() } catch { outcome.value = error }
            done.value = true
        }
        await nearbySettle(50)
        await w.dCloud.stopForSignOut()
        w.hangSigner.value = false
        await nearbyUntil("request returned") { done.value }
        XCTAssertEqual(outcome.value as? NearbyError, .closed)
        XCTAssertFalse(w.requesterNet.browsing, "nothing is left browsing")
    }

    func testSignOutClosesTheSessionsEvenWhenTheAdvertsStopHangs() async throws {
        let w = try await world()
        let approver = try await w.startApprover()
        let d = try await w.request()
        w.requesterNet.up(w.approverNet)
        await nearbyUntil("listed") { await d.approvers().count == 1 }
        let handle = try XCTUnwrap(w.approverNet.live.first)
        handle.hang.value = true
        Task { await approver.stop() }
        await nearbyUntil("D closed") { await d.approvers().isEmpty }
        approver.destroy()
        await nearbyUntil("stopped") { approver.status().state == .stopped }
        handle.hang.value = false
        await d.close()
    }

    func testTheSignOutBoundForcesAdvertsWhoseWithdrawalHangs() async throws {
        let w = try await world()
        let approver = try await w.startApprover()
        let d = try await w.request()
        w.requesterNet.up(w.approverNet)
        await nearbyUntil("listed") { await d.approvers().count == 1 }
        let handle = try XCTUnwrap(w.approverNet.live.first)
        handle.hang.value = true
        // `stopAll` is held by the hanging withdrawal; the bound ends it and the force path drops the advert.
        await w.mCloud.stopForSignOut(bound: 0.3)
        XCTAssertTrue(handle.cancelled.value, "the force path reached the advert a hanging stop was holding")
        XCTAssertEqual(approver.status().state, .stopped)
        handle.hang.value = false
        await d.close()
    }

    // MARK: Gating

    func testAnswersTheTypedNotApplicableWhenDiscoveryDoesNotNameNearby() async throws {
        let w = try await world()
        w.identityFragment.value = IdentityDiscovery(endpoints: ["nearbyStart": "/s"], nearby: false)
        for call in [
            { _ = try await w.request() },
            { _ = try await w.startApprover() },
        ] as [@Sendable () async throws -> Void] {
            do {
                try await call()
                XCTFail("ran")
            } catch let e as PolarisError {
                XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
                XCTAssertEqual(e.unsupported?.feature, Feature.identityNearby)
                XCTAssertEqual(e.unsupported?.reason, UnsupportedReason.product)
            }
        }
        // The service table says no: the same typed answer.
        w.identityFragment.value = IdentityDiscovery(
            endpoints: ["nearbyStart": "/s", "nearbyPoll": "/p", "nearbyApprove": "/a"], nearby: true)
        w.identityOn.value = false
        do {
            _ = try await w.request()
            XCTFail("ran")
        } catch let e as PolarisError { XCTAssertEqual(e.unsupported?.reason, UnsupportedReason.product) }
        XCTAssertTrue(w.approverNet.handles.value.isEmpty)
        XCTAssertFalse(w.requesterNet.browsing)
    }

    func testAClientWithoutNearbyWiringAnswersNearbyUnsupportedRuntime() async throws {
        let w = try await world()
        let bare = CloudConnect(connect: w.client.connect).nearby
        do {
            _ = try await bare.request(NearbyRequestOptions(request: nearbyRequestHandle))
            XCTFail("ran")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.nearbyUnsupported)
            XCTAssertEqual(e.unsupported?.reason, UnsupportedReason.runtime)
        }
        _ = w
    }

    func testRefusesToApproveWhileSignedOut() async throws {
        let w = try await world()
        w.mSignedIn.value = false
        do {
            _ = try await w.startApprover()
            XCTFail("ran")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.accountRequired) }
        XCTAssertTrue(w.approverNet.handles.value.isEmpty)
    }

    func testPermissionDeniedAndMissingPlistAreTheTypedErrors() async throws {
        let w = try await world()
        w.requesterNet.failBrowse.value = .permissionDenied
        do {
            _ = try await w.request()
            XCTFail("ran")
        } catch { XCTAssertEqual(error as? NearbyError, .permissionDenied) }
        XCTAssertEqual(NearbyError.permissionDenied.code, ErrorCode.nearbyPermissionDenied)
        w.approverNet.failNext.value = .notConfigured
        do {
            _ = try await w.startApprover()
            XCTFail("ran")
        } catch { XCTAssertEqual(error as? NearbyError, .notConfigured) }
    }
}

// MARK: - Helpers

/// An approver network that holds `open` until the test lets go.
private final class SlowOpenNet: NearbyApproverNetwork, @unchecked Sendable {
    let inner: FakeApproverNet
    let hold: NBox<Bool>
    let opens = NBox(0)
    init(inner: FakeApproverNet, hold: NBox<Bool>) {
        self.inner = inner
        self.hold = hold
    }
    func open(
        instance: String, txt: [String], onPipe: @escaping @Sendable (any NearbyInboundPipe) -> Void
    ) async throws -> any NearbyAdvertHandle {
        opens.mutate { $0 += 1 }
        while hold.value { try? await Task.sleep(nanoseconds: 10_000_000) }
        return try await inner.open(instance: instance, txt: txt, onPipe: onPipe)
    }
}
