// @pkey-feature connect.identity
// CC-11.1: Cloud Connect identity (WIRE-CONTRACT-V5 §15.2, §15.3). The first half runs the
// corpus sections `peerCertCases`, `ringCases` (verify and replace) and `peerAdmissionCases`
// through the Swift verifier; the second half drives `client.connect` against a stub Worker:
// keys registered on first need, a memory-only store refused, the roster and the certificate
// verified and bound to this device, a stale or foreign roster refused, K_disc replaced and
// never logged, the previous key gone after a leave, and the typed refusals.

import CryptoKit
import Foundation
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

// ── Corpus ───────────────────────────────────────────────────────────────────────────

private struct SessionRow: Decodable {
    let mode: String
    let remoteStatic: String
    let ownSub: String?
    let ownDeviceId: String?
}

private struct CertRow: Decodable {
    struct Expect: Decodable {
        let valid: Bool
        let reason: String?
        let cert: JSONValue?
    }
    let id: String
    let jws: String
    let trust: TrustSet
    let expectedAud: String
    let now: Int
    let session: SessionRow?
    let expect: Expect
}

private struct RingRow: Decodable {
    struct Expect: Decodable {
        let valid: Bool?
        let reason: String?
        let epoch: Int?
        let devices: Int?
        let expired: Bool?
        let replace: Bool?
    }
    let kind: String
    let id: String
    let jws: String
    let heldJws: String?
    let trust: TrustSet
    let expectedAud: String
    let now: Int
    let expect: Expect
}

private struct AdmitRow: Decodable {
    struct Expect: Decodable {
        let admit: Bool
        let reason: String?
        let ringSync: String?
    }
    let id: String
    let certJws: String
    let ringJws: String?
    let trust: TrustSet
    let expectedAud: String
    let now: Int
    let expect: Expect
}

private struct PeerCorpus: Decodable {
    let peerCertCases: [CertRow]
    let ringCases: [RingRow]
    let peerAdmissionCases: [AdmitRow]
}

final class ConnectCorpusTests: XCTestCase {
    private func corpus() throws -> PeerCorpus { try CorpusLocator.load(PeerCorpus.self, "cases") }

    func testPeerCertCases() throws {
        let rows = try corpus().peerCertCases
        XCTAssertGreaterThan(rows.count, 100)
        for r in rows {
            let session = r.session.map {
                PeerSession(
                    mode: PeerSession.Mode(rawValue: $0.mode)!, remoteStatic: $0.remoteStatic,
                    ownSub: $0.ownSub, ownDeviceId: $0.ownDeviceId)
            }
            let result = PeerDocs.verifyPeerCert(
                r.jws,
                options: VerifyPeerCertOptions(
                    trust: r.trust, expectedAud: r.expectedAud, now: r.now, session: session))
            switch result {
            case .ok(let cert):
                XCTAssertTrue(r.expect.valid, "\(r.id) verified but should be refused")
                guard case .object(let want)? = r.expect.cert else { return XCTFail("\(r.id) no cert") }
                XCTAssertEqual(cert.sub, want["sub"]?.stringValue, r.id)
                XCTAssertEqual(cert.deviceId, want["deviceId"]?.stringValue, r.id)
                XCTAssertEqual(cert.signKey, want["signKey"]?.stringValue, r.id)
                XCTAssertEqual(cert.agreeKey, want["agreeKey"]?.stringValue, r.id)
                XCTAssertEqual(cert.ringEpoch, want["ringEpoch"]?.intValue, r.id)
                XCTAssertEqual(cert.issuedAt, want["issuedAt"]?.intValue, r.id)
                XCTAssertEqual(cert.expiresAt, want["expiresAt"]?.intValue, r.id)
            case .refused(let why):
                XCTAssertFalse(r.expect.valid, "\(r.id) refused (\(why.rawValue)) but should verify")
                XCTAssertEqual(why.rawValue, r.expect.reason, r.id)
            }
        }
    }

    func testRingCases() throws {
        let rows = try corpus().ringCases
        var lifetime = 0
        for r in rows {
            if r.id.hasPrefix("ring-lifetime-") { lifetime += 1 }
            if r.kind == "verify" {
                switch PeerDocs.verifyRing(r.jws, trust: r.trust, expectedAud: r.expectedAud) {
                case .ok(let ring):
                    XCTAssertEqual(r.expect.valid, true, "\(r.id) verified but should be refused")
                    XCTAssertEqual(ring.epoch, r.expect.epoch, r.id)
                    XCTAssertEqual(ring.devices.count, r.expect.devices, r.id)
                    XCTAssertEqual(PeerDocs.ringExpired(ring, now: r.now), r.expect.expired, r.id)
                case .refused(let why):
                    XCTAssertEqual(r.expect.valid, false, "\(r.id) refused (\(why.rawValue))")
                    XCTAssertEqual(why.rawValue, r.expect.reason, r.id)
                }
            } else {
                XCTAssertEqual(r.kind, "replace", r.id)
                let out = PeerDocs.replaceRing(
                    held: r.heldJws, new: r.jws, trust: r.trust, expectedAud: r.expectedAud, now: r.now)
                switch out {
                case .replace: XCTAssertEqual(r.expect.replace, true, r.id)
                case .keep(let why):
                    XCTAssertEqual(r.expect.replace, false, r.id)
                    XCTAssertEqual(why.rawValue, r.expect.reason, r.id)
                }
            }
        }
        XCTAssertEqual(lifetime, 4, "ring-lifetime-over-max, -zero, -negative and -huge all run")
    }

    func testPeerAdmissionCases() throws {
        let rows = try corpus().peerAdmissionCases
        XCTAssertGreaterThan(rows.count, 10)
        for r in rows {
            let out = PeerDocs.admitPeer(
                certJws: r.certJws, heldRing: r.ringJws,
                options: VerifyPeerCertOptions(trust: r.trust, expectedAud: r.expectedAud, now: r.now))
            switch out {
            case .admit(_, let sync):
                XCTAssertTrue(r.expect.admit, r.id)
                XCTAssertEqual(sync.rawValue, r.expect.ringSync, r.id)
            case .refused(let reason):
                XCTAssertFalse(r.expect.admit, r.id)
                XCTAssertEqual(reason, r.expect.reason, r.id)
            }
        }
    }
}

// ── The client ───────────────────────────────────────────────────────────────────────

private let selfId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
private let otherId = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
private let subA = "ps_AbCdEfGhIjKlMnOpQrStUv"
private let subB = "ps_ZyXwVuTsRqPoNmLkJiHgFe"

private func b64(_ d: Data) -> String { Base64URL.encode(d) }
private func randomKey() -> String { b64(Data((0..<32).map { _ in UInt8.random(in: 0...255) })) }

final class ConnectClientTests: XCTestCase {
    private let signer = TestSigner(kid: "connect-kid")
    private var server = StubServer()
    private var port: DeviceKeyStore!
    private var state = ConnectStateStore.inMemory()
    private let now = Int(Date().timeIntervalSince1970)

    override func setUp() async throws {
        server = StubServer()
        state = ConnectStateStore.inMemory()
        port = try DeviceKeyStore(
            productSlug: "djdl", vault: MemoryDeviceKeyVault(), wrapper: nil, kind: .durable)
    }

    private func client(
        keys: (any DeviceKeyPort)? = nil, services: [ServiceSlug] = [.license, .config, .connect],
        token: Bool = true, transport: (any PolarisTransport)? = nil, allowEphemeral: Bool = false,
        state override: ConnectStateStore? = nil
    ) async throws -> PolarisKeyClient {
        let store = InMemoryStore(deviceId: selfId)
        if token { await store.setToken("pkeyt_dev") }
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store, transport: transport ?? server.transport,
                expectedServices: services, fingerprint: false,
                connect: ConnectOptions(
                    keys: keys ?? port, store: override ?? state, allowEphemeralKeys: allowEphemeral)))
    }

    private func ringJws(
        sub: String = subA, epoch: Int = 5, aud: String = "djdl", members: [PeerDeviceKeys],
        issuedAt: Int? = nil
    ) -> String {
        let at = issuedAt ?? now
        let devices = members.sorted { $0.deviceId < $1.deviceId }.map {
            #"{"deviceId":"\#($0.deviceId)","signKey":"\#($0.signKey)","agreeKey":"\#($0.agreeKey)"}"#
        }.joined(separator: ",")
        return signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"\#(aud)","sub":"\#(sub)","epoch":\#(epoch),"issuedAt":\#(at),"expiresAt":\#(at + 604_800),"devices":[\#(devices)]}"#,
            typ: JwsTyp.ring.rawValue)
    }

    private func certJws(
        sub: String = subA, deviceId: String = selfId, keys: DevicePublicKeys, epoch: Int = 5
    ) -> String {
        signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","deviceId":"\#(deviceId)","signKey":"\#(keys.signKey)","agreeKey":"\#(keys.agreeKey)","ringEpoch":\#(epoch),"issuedAt":\#(now),"expiresAt":\#(now + 604_800)}"#,
            typ: JwsTyp.peer.rawValue)
    }

    private let other = PeerDeviceKeys(
        deviceId: otherId, signKey: Base64URL.encode(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation),
        agreeKey: Base64URL.encode(Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation))

    private func serve(
        keys: DevicePublicKeys, sub: String = subA, epoch: Int = 5, disc: [String]? = nil,
        ring: String? = nil, cert: String? = nil
    ) async {
        let me = PeerDeviceKeys(deviceId: selfId, signKey: keys.signKey, agreeKey: keys.agreeKey)
        let r = ring ?? ringJws(sub: sub, epoch: epoch, members: [me, other])
        let c = cert ?? certJws(sub: sub, keys: keys, epoch: epoch)
        let d = (disc ?? [randomKey()]).map { "\"\($0)\"" }.joined(separator: ",")
        await server.reply(
            "/djdl/connect/identity", body: #"{"ring":"\#(r)","certificate":"\#(c)","discKeys":[\#(d)]}"#)
        await server.reply("/djdl/devices/keys", body: #"{"keySeq":1}"#)
    }

    func testRegistersKeysOnFirstNeedAndStoresTheVerifiedIdentity() async throws {
        let c = try await client()
        let none = try await port.publicKeys()
        XCTAssertNil(none, "no key exists before the first need")
        let keys = try await port.ensure()
        await serve(keys: keys)

        let result = await c.connect.identity(refresh: true)
        guard case .ready(let id) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(id.subject, subA)
        XCTAssertEqual(id.deviceId, selfId)
        XCTAssertEqual(id.ring.epoch, 5)
        XCTAssertEqual(id.ring.devices.count, 2)
        XCTAssertEqual(id.certificate.agreeKey, keys.agreeKey)
        XCTAssertEqual(id.discKeys.count, 1)

        let puts = await server.requests(forPath: "/djdl/devices/keys")
        XCTAssertEqual(puts.count, 1)
        XCTAssertEqual(puts.first?.method, "PUT")
        XCTAssertEqual(puts.first?.headers["authorization"], "Bearer pkeyt_dev")
        let sent = try JSONDecoder().decode(DeviceKeysRequest.self, from: puts.first!.body!)
        XCTAssertEqual(sent.signKey, keys.signKey)
        XCTAssertEqual(sent.agreeKey, keys.agreeKey)
        let get = await server.requests(forPath: "/djdl/connect/identity")
        XCTAssertEqual(get.first?.headers["authorization"], "Bearer pkeyt_dev")

        // The keys are registered once: the second call goes straight to the identity.
        _ = await c.connect.identity(refresh: true)
        let putsAfter = await server.requests(forPath: "/djdl/devices/keys").count
        XCTAssertEqual(putsAfter, 1)

        let held = await c.connect.held()
        XCTAssertEqual(held?.ring.epoch, 5)
        XCTAssertEqual(held?.discKeys.count, 1)
    }

    func testKeysAreMadeOnFirstNeed() async throws {
        let c = try await client()
        let before = try await port.publicKeys()
        XCTAssertNil(before)
        await server.reply("/djdl/devices/keys", body: #"{"keySeq":1}"#)
        // The identity answer is for other keys, so it is refused, but the keys were made and sent.
        await server.reply("/djdl/connect/identity", status: 403, body: #"{"error":{"code":"account_required"}}"#)
        _ = await c.connect.identity(refresh: true)
        let made = try await port.publicKeys()
        XCTAssertNotNil(made)
        let puts = await server.requests(forPath: "/djdl/devices/keys").count
        XCTAssertEqual(puts, 1)
    }

    func testAMemoryOnlyKeyStoreIsInvalidOptionsUnlessAllowed() async throws {
        let memory = try DeviceKeyStore.inMemory(productSlug: "djdl")
        let c = try await client(keys: memory)
        let r = await c.connect.identity(refresh: true)
        guard case .error(let code, _) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(code, ErrorCode.invalidOptions)
        let none = try await memory.publicKeys()
        XCTAssertNil(none)
        let sent = await server.requests.count
        XCTAssertEqual(sent, 0)

        // Allowed, the keys are made and registered; the identity then verifies as usual.
        let c2 = try await client(keys: memory, allowEphemeral: true)
        let keys = try await memory.ensure()
        await serve(keys: keys)
        let ok = await c2.connect.identity()
        XCTAssertNotNil(ok.identity)
        let puts = await server.requests(forPath: "/djdl/devices/keys").count
        XCTAssertEqual(puts, 1)
    }

    func testTheServiceOffIsTheTypedProductNA() async throws {
        let c = try await client(services: [.license, .config])
        let r = await c.connect.identity(refresh: true)
        guard case .unsupported(let u) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(u.feature, Feature.connectIdentity)
        XCTAssertEqual(u.reason, UnsupportedReason.product)
        let d = await c.connect.listDevices()
        guard case .unsupported = d else { return XCTFail("\(d)") }
        let sent = await server.requests.count
        XCTAssertEqual(sent, 0)
    }

    func testNoTokenIsAnError() async throws {
        let c = try await client(token: false)
        let r = await c.connect.identity(refresh: true)
        XCTAssertEqual(r, .error(code: ErrorCode.noToken, message: "Activate or register before using Cloud Connect."))
    }

    func testWorkerRefusalsComeBackVerbatim() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        await serve(keys: keys)
        await server.reply(
            "/djdl/connect/identity", status: 403,
            body:
                #"{"error":{"code":"account_required","message":"Sign in to link this device.","signInUrl":"https://key.example/signin"}}"#
        )
        var r = await c.connect.identity(refresh: true)
        guard case .refused(let a) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(a.code, ErrorCode.accountRequired)
        XCTAssertEqual(a.status, 403)
        XCTAssertEqual(a.signInUrl, "https://key.example/signin")

        await server.reply("/djdl/connect/identity", status: 409, body: #"{"error":{"code":"ring_too_large"}}"#)
        r = await c.connect.identity(refresh: true)
        guard case .refused(let b) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(b.code, ErrorCode.ringTooLarge)
        XCTAssertEqual(b.status, 409)
        let held = await c.connect.held()
        XCTAssertNil(held, "a refusal stores nothing")
    }

    func testDeviceKeysRequiredAfterRegistrationRegistersOnceMore() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        await serve(keys: keys)
        _ = await c.connect.identity(refresh: true)
        // The Worker lost the keys: 409 once, then the roster again.
        let me = PeerDeviceKeys(deviceId: selfId, signKey: keys.signKey, agreeKey: keys.agreeKey)
        let good =
            #"{"ring":"\#(ringJws(epoch: 6, members: [me, other]))","certificate":"\#(certJws(keys: keys, epoch: 6))","discKeys":["\#(randomKey())"]}"#
        let calls = Counter()
        await server.route("/djdl/connect/identity") { _ in
            calls.bump() == 1
                ? StubServer.Reply(status: 409, body: #"{"error":{"code":"device_keys_required"}}"#)
                : StubServer.Reply(body: good)
        }
        let r = await c.connect.identity(refresh: true)
        XCTAssertEqual(r.identity?.ring.epoch, 6)
        let puts = await server.requests(forPath: "/djdl/devices/keys").count
        XCTAssertEqual(puts, 2)
    }

    func testAStaleRosterIsRefusedAndTheHeldOneStays() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        let me = PeerDeviceKeys(deviceId: selfId, signKey: keys.signKey, agreeKey: keys.agreeKey)
        await serve(keys: keys, epoch: 5)
        let t0 = await c.connect.identity(refresh: true).identity
        XCTAssertNotNil(t0)

        await serve(keys: keys, epoch: 4)
        let older = await c.connect.identity(refresh: true)
        guard case .error(let code, let message) = older else { return XCTFail("\(older)") }
        XCTAssertEqual(code, ErrorCode.peerCertInvalid)
        XCTAssertTrue(message.contains("stale roster"), message)

        // The same epoch with other members is also stale; the same members is a re-issue.
        await serve(keys: keys, ring: ringJws(epoch: 5, members: [me]), cert: certJws(keys: keys, epoch: 5))
        let changed = await c.connect.identity(refresh: true)
        guard case .error = changed else { return XCTFail("\(changed)") }
        await serve(keys: keys, epoch: 5)
        let t1 = await c.connect.identity(refresh: true).identity
        XCTAssertNotNil(t1)

        await serve(keys: keys, epoch: 6)
        let t2 = await c.connect.identity(refresh: true).identity?.ring.epoch
        XCTAssertEqual(t2, 6)
        let t3 = await c.connect.held()?.ring.epoch
        XCTAssertEqual(t3, 6)
    }

    func testAForeignRosterIsRefused() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        await serve(keys: keys, sub: subA, epoch: 5)
        let t4 = await c.connect.identity(refresh: true).identity
        XCTAssertNotNil(t4)

        // A higher epoch for another account does not replace the held roster.
        await serve(keys: keys, sub: subB, epoch: 9)
        let g9 = await c.connect.identity(refresh: true)
        guard case .error(_, let message) = g9 else { return XCTFail("foreign accepted") }
        XCTAssertTrue(message.contains("another account"), message)
        let t5 = await c.connect.held()?.subject
        XCTAssertEqual(t5, subA)

        // A roster for another product.
        let me = PeerDeviceKeys(deviceId: selfId, signKey: keys.signKey, agreeKey: keys.agreeKey)
        await serve(keys: keys, ring: ringJws(epoch: 9, aud: "other", members: [me]))
        let g10 = await c.connect.identity(refresh: true)
        guard case .error = g10 else { return XCTFail("foreign product accepted") }
        let t6 = await c.connect.held()?.ring.epoch
        XCTAssertEqual(t6, 5)
    }

    func testTheRosterAndCertificateMustBelongToThisDevice() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        let me = PeerDeviceKeys(deviceId: selfId, signKey: keys.signKey, agreeKey: keys.agreeKey)
        // The roster does not list this device.
        await serve(keys: keys, ring: ringJws(members: [other]))
        let g11 = await c.connect.identity(refresh: true)
        guard case .error(_, let m1) = g11 else { return XCTFail("accepted") }
        XCTAssertTrue(m1.contains("not in the roster"), m1)
        // The certificate names another device.
        await serve(keys: keys, cert: certJws(deviceId: otherId, keys: keys))
        let g12 = await c.connect.identity(refresh: true)
        guard case .error(_, let m2) = g12 else { return XCTFail("accepted") }
        XCTAssertTrue(m2.contains("another device"), m2)
        // The certificate carries other keys.
        let foreignKeys = DevicePublicKeys(signKey: other.signKey, agreeKey: other.agreeKey, generation: 1)
        await serve(keys: keys, cert: certJws(keys: foreignKeys))
        let g13 = await c.connect.identity(refresh: true)
        guard case .error = g13 else { return XCTFail("accepted") }
        // The certificate is another account's.
        await serve(keys: keys, cert: certJws(sub: subB, keys: keys))
        let g14 = await c.connect.identity(refresh: true)
        guard case .error(_, let m3) = g14 else { return XCTFail("accepted") }
        XCTAssertTrue(m3.contains("another account"), m3)
        // The roster is signed by a key the app does not pin.
        let rogue = TestSigner(kid: "connect-kid")
        let forged = rogue.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(subA)","epoch":5,"issuedAt":\#(now),"expiresAt":\#(now + 604_800),"devices":[{"deviceId":"\#(selfId)","signKey":"\#(me.signKey)","agreeKey":"\#(me.agreeKey)"}]}"#,
            typ: JwsTyp.ring.rawValue)
        await serve(keys: keys, ring: forged)
        let g15 = await c.connect.identity(refresh: true)
        guard case .error = g15 else { return XCTFail("forged roster accepted") }
        let held = await c.connect.held()
        XCTAssertNil(held, "nothing was stored")
    }

    func testDiscoveryKeysAreReplacedWholesaleAndGoneAfterALeave() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        let k1 = randomKey()
        let k2 = randomKey()
        let k3 = randomKey()
        await serve(keys: keys, epoch: 5, disc: [k2, k1])
        var held = await c.connect.identity(refresh: true).identity
        XCTAssertEqual(held?.discKeys.map(\.base64url), [k2, k1])
        // The next bump removed a device: the Worker sends the current key only.
        await serve(keys: keys, epoch: 6, disc: [k3])
        held = await c.connect.identity(refresh: true).identity
        XCTAssertEqual(held?.discKeys.map(\.base64url), [k3], "no previous key survives")
        let t7 = await c.connect.held()?.discKeys.map(\.base64url)
        XCTAssertEqual(t7, [k3])

        try await c.connect.leave()
        let after = await c.connect.held()
        XCTAssertNil(after)
        XCTAssertNil(try state.load(), "the record, K_disc included, is deleted")
        // The device keys are the device's own and stay.
        let still = try await port.publicKeys()
        XCTAssertNotNil(still)
    }

    func testMalformedDiscoveryKeysRefuseTheAnswer() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        for bad in [[], [randomKey(), randomKey(), randomKey()], ["short"], ["A", "A"]] {
            await serve(keys: keys, disc: bad)
            let g16 = await c.connect.identity(refresh: true)
            guard case .error = g16 else { return XCTFail("accepted \(bad.count)") }
        }
        let dup = randomKey()
        await serve(keys: keys, disc: [dup, dup])
        let g17 = await c.connect.identity(refresh: true)
        guard case .error = g17 else { return XCTFail("duplicate keys accepted") }
        let held = await c.connect.held()
        XCTAssertNil(held)
    }

    func testDiscoveryKeysNeverAppearInADescription() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        let k = randomKey()
        await serve(keys: keys, disc: [k])
        let got = await c.connect.identity(refresh: true).identity
        let id = try XCTUnwrap(got)
        for text in ["\(id)", String(describing: id.discKeys), String(reflecting: id.discKeys), "\(id.discKeys[0])"] {
            XCTAssertFalse(text.contains(k), "K_disc leaked into a description")
        }
        let dumped = dumpString(id.discKeys[0])
        XCTAssertFalse(dumped.contains(k))
        let record = try XCTUnwrap(try state.load())
        XCTAssertFalse("\(record)".contains(k))
    }

    private func dumpString(_ v: Any) -> String {
        var out = ""
        dump(v, to: &out)
        return out
    }

    func testListDevices() async throws {
        let c = try await client()
        await server.reply(
            "/djdl/connect/devices",
            body:
                #"{"devices":[{"deviceId":"\#(selfId)","label":"Mac","platform":"macos","lastSeen":1700000000,"self":true},{"deviceId":"\#(otherId)","label":null,"platform":null,"lastSeen":1,"self":false}]}"#
        )
        let r = await c.connect.listDevices()
        XCTAssertEqual(r.list?.count, 2)
        XCTAssertEqual(r.list?.first?.isSelf, true)
        XCTAssertEqual(r.list?.first?.label, "Mac")
        XCTAssertNil(r.list?.last?.label)
        let req = await server.requests(forPath: "/djdl/connect/devices").first
        XCTAssertEqual(req?.headers["authorization"], "Bearer pkeyt_dev")

        await server.reply("/djdl/connect/devices", status: 403, body: #"{"error":{"code":"account_required"}}"#)
        let g18 = await c.connect.listDevices()
        guard case .refused(let a) = g18 else { return XCTFail("not refused") }
        XCTAssertEqual(a.code, ErrorCode.accountRequired)
        await server.reply("/djdl/connect/devices", status: 409, body: #"{"error":{"code":"ring_too_large"}}"#)
        let g19 = await c.connect.listDevices()
        guard case .refused(let b) = g19 else { return XCTFail("not refused") }
        XCTAssertEqual(b.code, ErrorCode.ringTooLarge)
    }

    // ── R-6a fix round ───────────────────────────────────────────────────────────────────

    func testAnUnreadableRecordIsAnErrorAndIsNeverOverwritten() async throws {
        let vault = MemoryDeviceKeyVault()
        _ = try vault.insert(Data("not json".utf8))
        let store = ConnectStateStore(vault: vault)
        let c = try await client(state: store)
        let keys = try await port.ensure()
        await serve(keys: keys)
        let r = await c.connect.identity(refresh: true)
        guard case .error(let code, _) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(code, "store-failed")
        XCTAssertEqual(try vault.read(), Data("not json".utf8), "the record is left as it was")
        let puts = await server.requests(forPath: "/djdl/devices/keys").count
        XCTAssertEqual(puts, 0)

        // A future version is unreadable too; only a leave removes it.
        try vault.upsert(Data(#"{"v":99}"#.utf8))
        XCTAssertThrowsError(try store.load()) { XCTAssertEqual($0 as? ConnectStateError, .unreadable) }
        try await c.connect.leave()
        XCTAssertNil(try vault.read())
        let ok = await c.connect.identity(refresh: true)
        XCTAssertNotNil(ok.identity)
    }

    func testHeldIdentityIsServedWhileTheCertificateIsFresh() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        await serve(keys: keys)
        _ = await c.connect.identity()
        let again = await c.connect.identity()
        XCTAssertNotNil(again.identity)
        var gets = await server.requests(forPath: "/djdl/connect/identity").count
        XCTAssertEqual(gets, 1, "the second call is served from the held identity")
        _ = await c.connect.identity(refresh: true)
        gets = await server.requests(forPath: "/djdl/connect/identity").count
        XCTAssertEqual(gets, 2)
    }

    func testThePreviousKeyIsDroppedAfter24HoursOnLossAndOnLeave() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        let me = PeerDeviceKeys(deviceId: selfId, signKey: keys.signKey, agreeKey: keys.agreeKey)
        let cur = randomKey()
        let prev = randomKey()
        // First seen: kept, and the held view honours the 24 hours.
        await serve(keys: keys, epoch: 5, disc: [cur, prev])
        var id = await c.connect.identity(refresh: true).identity
        XCTAssertEqual(id?.discKeys.map(\.base64url), [cur, prev])
        // The epoch moved and nobody was lost (epoch 6): the previous key stays and keeps its first-seen time.
        await serve(keys: keys, epoch: 6, disc: [cur, prev])
        id = await c.connect.identity(refresh: true).identity
        XCTAssertEqual(id?.discKeys.count, 2)
        var rec = try XCTUnwrap(try state.load())
        let firstSeen = try XCTUnwrap(rec.prevFirstSeen)
        XCTAssertLessThanOrEqual(firstSeen, now + 120)

        // Older than 24 hours: the held view drops it, and so does the next fetch.
        rec.prevFirstSeen = now - 90_000
        try state.save(rec)
        var held = await c.connect.held()
        XCTAssertEqual(held?.discKeys.map(\.base64url), [cur])
        await serve(keys: keys, epoch: 7, disc: [cur, prev])
        id = await c.connect.identity(refresh: true).identity
        XCTAssertEqual(id?.discKeys.map(\.base64url), [cur], "the old previous key is not re-armed")

        // A device lost in the bump: the previous key goes at once.
        let withOther = ringJws(epoch: 8, members: [me, other])
        await serve(keys: keys, epoch: 8, disc: [cur, prev], ring: withOther, cert: certJws(keys: keys, epoch: 8))
        id = await c.connect.identity(refresh: true).identity
        XCTAssertEqual(id?.discKeys.count, 2)
        let alone = ringJws(epoch: 9, members: [me])
        await serve(keys: keys, epoch: 9, disc: [cur, prev], ring: alone, cert: certJws(keys: keys, epoch: 9))
        id = await c.connect.identity(refresh: true).identity
        XCTAssertEqual(id?.discKeys.map(\.base64url), [cur], "a lost device drops the previous key")

        // And a leave removes everything.
        try await c.connect.leave()
        held = await c.connect.held()
        XCTAssertNil(held)
    }

    func testALeaveDuringAFetchIsNotUndoneByIt() async throws {
        let gate = ConnectGate()
        let c = try await client(transport: GateTransport(server: server, gate: gate))
        let keys = try await port.ensure()
        await serve(keys: keys)
        let fetch = Task { await c.connect.identity(refresh: true) }
        while await gate.arrived == 0 { await Task.yield() }
        let leave = Task { try await c.connect.leave() }
        for _ in 0..<50 { await Task.yield() }
        await gate.openAll()
        _ = await fetch.value
        try await leave.value
        let held = await c.connect.held()
        XCTAssertNil(held, "the leave ran after the fetch and cleared its save")
        XCTAssertNil(try state.load())
    }

    func testConcurrentIdentityCallsNeverSaveOlderOverNewer() async throws {
        let gate = ConnectGate()
        await gate.openAll()
        let c = try await client(transport: GateTransport(server: server, gate: gate))
        let keys = try await port.ensure()
        let me = PeerDeviceKeys(deviceId: selfId, signKey: keys.signKey, agreeKey: keys.agreeKey)
        let calls = Counter()
        let ringers = (5...8).map { ringJws(epoch: $0, members: [me, other]) }
        let certs = (5...8).map { certJws(keys: keys, epoch: $0) }
        let disc = randomKey()
        await server.reply("/djdl/devices/keys", body: #"{"keySeq":1}"#)
        await server.route("/djdl/connect/identity") { _ in
            let n = calls.bump() - 1
            return StubServer.Reply(
                body: #"{"ring":"\#(ringers[n])","certificate":"\#(certs[n])","discKeys":["\#(disc)"]}"#)
        }
        async let a = c.connect.identity(refresh: true)
        async let b = c.connect.identity(refresh: true)
        async let d = c.connect.identity(refresh: true)
        let results = await [a, b, d]
        for r in results { XCTAssertNotNil(r.identity, "\(r)") }
        let held = await c.connect.held()
        XCTAssertEqual(held?.ring.epoch, 7, "the last answer served is the one held")
        let most = await gate.maxInFlight
        XCTAssertEqual(most, 1, "the fetches never overlap")
    }

    func testALeaveWithNothingHeldTouchesNothing() async throws {
        let vault = CountingVault()
        let c = try await client(state: ConnectStateStore(vault: vault))
        try await c.connect.leave()
        XCTAssertEqual(vault.writes, 0)
        XCTAssertEqual(vault.deletes, 0)
    }

    func testAnUnremovableRecordStopsTheRelease() async throws {
        let vault = CountingVault()
        _ = try vault.insert(Data("held".utf8))
        vault.deleteError = .keychain(errSecInteractionNotAllowed)
        let c = try await client(state: ConnectStateStore(vault: vault))
        do {
            try await c.connect.leave()
            XCTFail("a locked Keychain must stop the leave")
        } catch {
            XCTAssertEqual(error as? ConnectStateError, .keychain(errSecInteractionNotAllowed))
        }
        // The release path fails closed with it: no deauthorize request, and the token stays.
        do {
            try await c.license.deactivate()
            XCTFail("deactivate must stop")
        } catch {
            XCTAssertEqual(error as? ConnectStateError, .keychain(errSecInteractionNotAllowed))
        }
        let sent = await server.requests(forPath: "/djdl/license/deauthorize").count
        XCTAssertEqual(sent, 0)
        let token = await c.core.token
        XCTAssertNotNil(token)
    }

    func testARecordNeverDumpsItsKeys() throws {
        let k = randomKey()
        let record = ConnectRecord(ring: "r", certificate: "c", discKeys: [k], registered: nil, storedAt: 1)
        XCTAssertFalse(dumpString(record).contains(k))
        XCTAssertFalse("\(record)".contains(k))
    }

    func testTheKeychainRecordUsesItsOwnItemAndIsNeverSynced() throws {
        let kc = ConnectFakeKeychain()
        let store = ConnectStateStore(
            vault: KeychainDeviceKeyVault(
                keychain: kc, service: "pkey:djdl", accessGroup: nil, account: "connect-state"))
        try store.save(
            ConnectRecord(ring: "r", certificate: "c", discKeys: [randomKey()], registered: nil, storedAt: 1))
        let add = try XCTUnwrap(kc.adds.first)
        XCTAssertEqual(add[kSecAttrAccount as String] as? String, "connect-state")
        XCTAssertEqual(add[kSecAttrService as String] as? String, "pkey:djdl")
        XCTAssertEqual(add[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(
            add[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertNotNil(try store.load())
        try store.clear()
        XCTAssertNil(try store.load())
    }

    func testAKeychainErrorIsThrownNotTakenForNoState() throws {
        let kc = ConnectFakeKeychain()
        kc.readStatus = errSecInteractionNotAllowed
        let store = ConnectStateStore(
            vault: KeychainDeviceKeyVault(
                keychain: kc, service: "pkey:djdl", accessGroup: nil, account: "connect-state"))
        XCTAssertThrowsError(try store.load()) {
            XCTAssertEqual($0 as? ConnectStateError, .keychain(errSecInteractionNotAllowed))
        }
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() -> Int {
        lock.withLock {
            n += 1
            return n
        }
    }
}

/// One data-protection item, like the fake in `DeviceKeysTests`.
private final class ConnectFakeKeychain: KeychainAPI, @unchecked Sendable {
    private let lock = NSLock()
    var item: Data?
    var readStatus: OSStatus?
    private(set) var adds: [[String: Any]] = []
    func copyMatching(_ q: [String: Any]) -> (OSStatus, Data?) {
        lock.withLock {
            if let readStatus { return (readStatus, nil) }
            return item.map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil)
        }
    }
    func add(_ a: [String: Any]) -> OSStatus {
        lock.withLock {
            adds.append(a)
            item = a[kSecValueData as String] as? Data
            return errSecSuccess
        }
    }
    func update(_ q: [String: Any], _ a: [String: Any]) -> OSStatus {
        lock.withLock {
            guard (q[kSecUseDataProtectionKeychain as String] as? Bool) == true, item != nil else {
                return errSecItemNotFound
            }
            item = a[kSecValueData as String] as? Data
            return errSecSuccess
        }
    }
    func delete(_ q: [String: Any]) -> OSStatus {
        lock.withLock {
            // Only the data-protection item exists here; the legacy keychain is empty.
            guard (q[kSecUseDataProtectionKeychain as String] as? Bool) == true else { return errSecItemNotFound }
            let had = item != nil
            item = nil
            return had ? errSecSuccess : errSecItemNotFound
        }
    }
}

actor ConnectGate {
    private(set) var arrived = 0
    private(set) var inFlight = 0
    private(set) var maxInFlight = 0
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func enter() async {
        arrived += 1
        inFlight += 1
        maxInFlight = max(maxInFlight, inFlight)
        if !open { await withCheckedContinuation { waiters.append($0) } }
        await Task.yield()
        inFlight -= 1
    }

    func openAll() {
        open = true
        for w in waiters { w.resume() }
        waiters = []
    }
}

struct GateTransport: PolarisTransport {
    let server: StubServer
    let gate: ConnectGate

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        if request.url.path == "/djdl/connect/identity" { await gate.enter() }
        return try await StubTransport(server: server).send(request)
    }
}

final class CountingVault: DeviceKeyVault, @unchecked Sendable {
    private let lock = NSLock()
    private var blob: Data?
    private(set) var writes = 0
    private(set) var deletes = 0
    var deleteError: DeviceKeyError?
    func read() throws -> Data? { lock.withLock { blob } }
    func insert(_ b: Data) throws -> Bool {
        lock.withLock {
            writes += 1
            blob = b
            return true
        }
    }
    func upsert(_ b: Data) throws {
        lock.withLock {
            writes += 1
            blob = b
        }
    }
    func delete() throws {
        try lock.withLock {
            deletes += 1
            if let deleteError { throw deleteError }
            blob = nil
        }
    }
}
