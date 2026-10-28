// @pkey-feature connect.app
// CC-11.15: the Cloud Connect facade (`client.cloudConnect`): start over a real client against a stub Worker, the
// off switches (G21), inbound sessions with no listener (G9), the bounded stop (S6) and the LAN-then-relay
// race. Mirrors the Python port's `test_cloud_connect.py`.

import CryptoKit
import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey

private let selfId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
private let otherId = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
private let sub = "ps_AbCdEfGhIjKlMnOpQrStUv"

private final class Link: ConnectSessionLink, @unchecked Sendable {
    let log = LockedValue<[String]>([])
    func sendRecord(type: Int, body: Data) async throws {}
    func close(_ code: PeerCloseCode) async { log.with { $0.append("close") } }
    func closeSoon(_ code: PeerCloseCode) { log.with { $0.append("close") } }
    func pause(_ on: Bool) {}
}

private func session(_ link: Link) -> ConnectSession {
    ConnectSession(
        link: link, peerDeviceId: otherId, caps: [], hello: PeerHello(label: nil, platform: "t", app: "djdl", maxMessage: 65_536),
        role: "responder", remoteAddress: "10.0.0.2")
}

final class CloudConnectTests: XCTestCase {
    private let signer = TestSigner(kid: "connect-kid")
    private var server = StubServer()
    private let now = Int(Date().timeIntervalSince1970)
    private var port: DeviceKeyStore!

    override func setUp() async throws { server = StubServer() }

    private func client(token: Bool = true) async throws -> PolarisKeyClient {
        let store = InMemoryStore(deviceId: selfId)
        if token { await store.setToken("pkeyt_dev") }
        let keys = try DeviceKeyStore.inMemory(productSlug: "djdl")
        _ = try await keys.ensure()
        port = keys
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: signer.trust,
                trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.license, .config, .connect], fingerprint: false,
                connect: ConnectOptions(keys: keys, store: ConnectStateStore.inMemory(), allowEphemeralKeys: true)))
    }

    private func serve() async throws {
        let keys = try await port.ensure()
        let other = PeerDeviceKeys(
            deviceId: otherId, signKey: Base64URL.encode(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation),
            agreeKey: Base64URL.encode(Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation))
        let me = PeerDeviceKeys(deviceId: selfId, signKey: keys.signKey, agreeKey: keys.agreeKey)
        let devs = [me, other].sorted { $0.deviceId < $1.deviceId }.map {
            #"{"deviceId":"\#($0.deviceId)","signKey":"\#($0.signKey)","agreeKey":"\#($0.agreeKey)"}"#
        }.joined(separator: ",")
        let ring = signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","epoch":5,"issuedAt":\#(now),"expiresAt":\#(now + 604_800),"devices":[\#(devs)]}"#,
            typ: JwsTyp.ring.rawValue)
        let cert = signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","deviceId":"\#(selfId)","signKey":"\#(keys.signKey)","agreeKey":"\#(keys.agreeKey)","ringEpoch":5,"issuedAt":\#(now),"expiresAt":\#(now + 604_800)}"#,
            typ: JwsTyp.peer.rawValue)
        let disc = Base64URL.encode(Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
        await server.reply("/djdl/connect/identity", body: #"{"ring":"\#(ring)","certificate":"\#(cert)","discKeys":["\#(disc)"]}"#)
        await server.reply("/djdl/devices/keys", body: #"{"keySeq":1}"#)
    }

    private var lanOnly: CloudConnectOptions {
        CloudConnectOptions(
            lan: true, relay: false,
            lanOptions: ConnectLanOptions(advertise: false, browse: false, allowLoopback: true))
    }

    // MARK: the off switches (G21)

    func testTheRelayStaysOffWhenDiscoverySaysSo() {
        func doc(_ f: ServiceFragment?) -> ProductDiscoveryDocument? {
            f.map { ProductDiscoveryDocument(product: "djdl", services: [.connect: $0]) }
        }
        XCTAssertNil(cloudConnectRelayWanted(nil), "unknown discovery allows it")
        XCTAssertNil(cloudConnectRelayWanted(doc(ServiceFragment(enabled: true))))
        XCTAssertEqual(cloudConnectRelayWanted(doc(ServiceFragment(enabled: true, extras: ["relay": .bool(false)]))), "product")
        XCTAssertEqual(
            cloudConnectRelayWanted(doc(ServiceFragment(enabled: true, endpoints: ["devices": "/x"]))), "no_ticket")
        XCTAssertNil(
            cloudConnectRelayWanted(doc(ServiceFragment(enabled: true, endpoints: ["ticket": "/t"], extras: ["relay": .bool(true)]))))
    }

    // MARK: lifecycle

    func testBeforeStartThereIsNothingToStopAndOpenSaysNotStarted() async throws {
        let c = try await client()
        await c.cloudConnect.stop()
        let st = c.cloudConnect.status()
        XCTAssertFalse(st.running)
        XCTAssertEqual(st.lan, "off")
        XCTAssertEqual(st.relay, "off")
        do { _ = try await c.cloudConnect.open(otherId); XCTFail("not started") } catch {
            XCTAssertEqual((error as? ConnectLanError)?.reason, .notStarted)
        }
    }

    func testStartWithoutATokenThrowsTheIdentitysAnswer() async throws {
        let c = try await client(token: false)
        do { try await c.cloudConnect.start(options: lanOnly); XCTFail("no token") } catch {
            XCTAssertTrue(error is CloudConnectError)
        }
        XCTAssertFalse(c.cloudConnect.status().running)
    }

    func testStartBringsTheLanUpAndTheHostSwitchKeepsTheRelayOff() async throws {
        let c = try await client()
        try await serve()
        try await c.cloudConnect.start(options: lanOnly)
        let st = c.cloudConnect.status()
        XCTAssertTrue(st.running)
        XCTAssertEqual(st.lan, "on")
        XCTAssertEqual(st.relay, "off")
        XCTAssertEqual(st.relayReason, "host")
        let none = await c.cloudConnect.peers()
        XCTAssertEqual(none, [])
        // A device that is not on the network, with the relay off, is not found.
        do { _ = try await c.cloudConnect.open(otherId); XCTFail("unknown") } catch {
            XCTAssertEqual((error as? ConnectLanError)?.reason, .unknownPeer)
        }
        await c.cloudConnect.stop()
        XCTAssertFalse(c.cloudConnect.status().running)
        await c.cloudConnect.stop()  // twice is fine
    }

    // MARK: G9

    func testAnInboundSessionWithNoListenerIsClosedAndWithOneIsHandedOver() async throws {
        let c = try await client()
        try await serve()
        try await c.cloudConnect.start(options: lanOnly)
        let l1 = Link()
        await c.cloudConnect.deliverInbound(session(l1))
        XCTAssertEqual(l1.log.current, ["close"], "nobody to hand it to")
        let got = LockedValue<[String]>([])
        let off = c.cloudConnect.onChannel { s in got.with { $0.append(s.peerDeviceId) } }
        let l2 = Link()
        await c.cloudConnect.deliverInbound(session(l2))
        for _ in 0..<100 where got.current.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(got.current, [otherId])
        XCTAssertEqual(l2.log.current, [])
        off()
        await c.cloudConnect.stop()
    }

    // MARK: S6 and the race

    func testABoundedOperationReturnsAtTheDeadlineAndNormallyWhenItFinishes() async {
        let slow = await connectBounded(0.2) { try? await Task.sleep(nanoseconds: 5_000_000_000) }
        XCTAssertFalse(slow, "a stuck stop does not hold up sign-out")
        let fast = await connectBounded(5) {}
        XCTAssertTrue(fast)
    }

    func testARaceHandsALateValueToTheCleanup() async throws {
        let late = LockedValue<[Int]>([])
        let r: CloudConnectCore.Race<Int> = await CloudConnectCore.race(
            0.05, { try await Task.sleep(nanoseconds: 200_000_000); return 7 }, late: { v in late.with { $0.append(v) } })
        guard case .timedOut = r else { return XCTFail("\(r)") }
        for _ in 0..<100 where late.current.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(late.current, [7])
        let ok: CloudConnectCore.Race<Int> = await CloudConnectCore.race(5, { 3 }, late: { _ in })
        guard case .value(3) = ok else { return XCTFail("\(ok)") }
        struct Boom: Error {}
        let bad: CloudConnectCore.Race<Int> = await CloudConnectCore.race(5, { throw Boom() }, late: { _ in })
        guard case .failed = bad else { return XCTFail("\(bad)") }
    }
}
