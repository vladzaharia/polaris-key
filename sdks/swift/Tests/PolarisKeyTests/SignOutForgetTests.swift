// @pkey-feature identity.account
//
// U-39.S: every identity sign-out, released or not, stops Cloud Connect, drops the roster and
// K_disc, and makes the Cloud Sync key ring forget its root and pin. A root that cannot be
// deleted stops the sign-out.

import CryptoKit
import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

final class SignOutForgetTests: XCTestCase {
    private let signer = TestSigner(kid: "connect-kid")
    private var server = StubServer()
    private let now = Int(Date().timeIntervalSince1970)
    private let selfId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    private let sub = "ps_AbCdEfGhIjKlMnOpQrStUv"

    override func setUp() async throws { server = StubServer() }

    private struct Rig {
        let client: PolarisKeyClient
        let connectStore: ConnectStateStore
        let roots: RingRootStore
    }

    /// Throws on `delete`: a locked Keychain.
    private struct LockedVault: DeviceKeyVault {
        func read() throws -> Data? { nil }
        func insert(_ blob: Data) throws -> Bool { true }
        func upsert(_ blob: Data) throws {}
        func delete() throws { throw DeviceKeyError.keychain(-25308) }
    }

    private func rig(roots: RingRootStore = .inMemory()) async throws -> Rig {
        let store = InMemoryStore(deviceId: selfId)
        await store.setToken("pkeyt_dev")
        let keys = try DeviceKeyStore.inMemory(productSlug: "djdl")
        _ = try await keys.ensure()
        let connectStore = ConnectStateStore.inMemory()
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body: """
                {"product":"djdl","services":{"license":{"enabled":true},"connect":{"enabled":true},\
                "identity":{"enabled":true,"account":true,"issuer":"https://key.example/djdl/identity",\
                "endpoints":{"signout":"https://key.example/djdl/identity/signout"}}}}
                """)
        let client = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: signer.trust,
                trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.license, .connect, .identity], fingerprint: false,
                connect: ConnectOptions(keys: keys, store: connectStore, allowEphemeralKeys: true)))
        try client.configureKeyring(SyncKeyringOptions(keys: keys, rootStore: roots))
        // A held root, as after an unlock.
        try roots.save(
            StoredRingRoot(
                ringId: "rg_" + String(repeating: "A", count: 22), epoch: 1,
                kid: String(repeating: "ab", count: 8),
                root: Base64URL.encode(Data(repeating: 7, count: 32))))
        try await serveConnect(keys: keys)
        try await client.cloudConnect.start(
            options: CloudConnectOptions(
                lan: true, relay: false,
                lanOptions: ConnectLanOptions(advertise: false, browse: false, allowLoopback: true)))
        return Rig(client: client, connectStore: connectStore, roots: roots)
    }

    private func serveConnect(keys: DeviceKeyStore) async throws {
        let k = try await keys.ensure()
        let me = PeerDeviceKeys(deviceId: selfId, signKey: k.signKey, agreeKey: k.agreeKey)
        let devs = #"{"deviceId":"\#(me.deviceId)","signKey":"\#(me.signKey)","agreeKey":"\#(me.agreeKey)"}"#
        let ring = signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","epoch":5,"issuedAt":\#(now),"expiresAt":\#(now + 604_800),"devices":[\#(devs)]}"#,
            typ: JwsTyp.ring.rawValue)
        let cert = signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","deviceId":"\#(selfId)","signKey":"\#(me.signKey)","agreeKey":"\#(me.agreeKey)","ringEpoch":5,"issuedAt":\#(now),"expiresAt":\#(now + 604_800)}"#,
            typ: JwsTyp.peer.rawValue)
        let disc = Base64URL.encode(Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
        await server.reply(
            "/djdl/connect/identity", body: #"{"ring":"\#(ring)","certificate":"\#(cert)","discKeys":["\#(disc)"]}"#)
        await server.reply("/djdl/devices/keys", body: #"{"keySeq":1}"#)
    }

    private func assertForgotten(_ r: Rig, file: StaticString = #filePath, line: UInt = #line) async throws {
        XCTAssertNil(try r.roots.load(), "ring root left behind", file: file, line: line)
        let pin = await r.client.core.store.readRecord("sync-ring-pin")
        XCTAssertNil(pin, "ring pin left behind", file: file, line: line)
        XCTAssertFalse(try r.connectStore.exists(), "roster left behind", file: file, line: line)
        XCTAssertFalse(r.client.cloudConnect.status().running, "Connect still running", file: file, line: line)
    }

    private func signOut(released: Bool) async throws {
        await server.reply("/djdl/identity/signout", body: #"{"released":\#(released)}"#)
    }

    func testReleasedSignOutLeavesNoRootPinRosterAndStopsConnect() async throws {
        let r = try await rig()
        XCTAssertTrue(try r.connectStore.exists())
        XCTAssertNotNil(try r.roots.load())
        XCTAssertTrue(r.client.cloudConnect.status().running)
        try await signOut(released: true)
        let out = try await r.client.identity.signOut()
        XCTAssertTrue(out.released)
        try await assertForgotten(r)
    }

    func testUnreleasedSignOutLeavesNoRootPinRosterAndStopsConnect() async throws {
        let r = try await rig()
        try await signOut(released: false)
        let out = try await r.client.identity.signOut()
        XCTAssertFalse(out.released)
        // The device stays activated by key.
        let token = await r.client.core.token
        XCTAssertEqual(token, "pkeyt_dev")
        try await assertForgotten(r)
    }

    func testARingThatCannotForgetStopsTheSignOut() async throws {
        let r = try await rig(roots: RingRootStore(vault: LockedVault()))
        try await signOut(released: true)
        do {
            _ = try await r.client.identity.signOut()
            XCTFail("a root that could not be deleted did not stop the sign-out")
        } catch {}
        let log = await server.requests.map(\.url.absoluteString)
        XCTAssertFalse(log.contains { $0.contains("identity/signout") })
        let token = await r.client.core.token
        XCTAssertEqual(token, "pkeyt_dev")
    }
}
