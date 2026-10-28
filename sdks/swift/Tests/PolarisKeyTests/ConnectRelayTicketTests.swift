// @pkey-feature connect.relay
// CC-11.4: the client side of the relay and the transport's reads of the held identity: the ticket
// (G13), the typed refusals, `peerSource()`, `adoptRing()` and `keysStale` (G11, G12), the error
// taxonomy (G20) and the no-leak checks (G19). The ticket route is a stub Worker.

import CryptoKit
import Foundation
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

private let selfId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
private let otherId = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
private let thirdId = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
private let subA = "ps_AbCdEfGhIjKlMnOpQrStUv"
private let subB = "ps_ZyXwVuTsRqPoNmLkJiHgFe"
private let ticket = "pkeyrt_" + String(repeating: "A", count: 32)

private func randomKey() -> String { Base64URL.encode(Data((0..<32).map { _ in UInt8.random(in: 0...255) })) }

private func member(_ id: String) -> PeerDeviceKeys {
    PeerDeviceKeys(
        deviceId: id, signKey: Base64URL.encode(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation),
        agreeKey: Base64URL.encode(Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation))
}

final class ConnectRelayTicketTests: XCTestCase {
    private let signer = TestSigner(kid: "connect-kid")
    private var server = StubServer()
    private var port: DeviceKeyStore!
    private var state = ConnectStateStore.inMemory()
    private let now = Int(Date().timeIntervalSince1970)
    private let other = member(otherId)
    private let third = member(thirdId)

    override func setUp() async throws {
        server = StubServer()
        state = ConnectStateStore.inMemory()
        port = try DeviceKeyStore(productSlug: "djdl", vault: MemoryDeviceKeyVault(), wrapper: nil, kind: .durable)
    }

    private func client(token: Bool = true) async throws -> PolarisKeyClient {
        let store = InMemoryStore(deviceId: selfId)
        if token { await store.setToken("pkeyt_dev") }
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.license, .config, .connect], fingerprint: false,
                connect: ConnectOptions(keys: port, store: state)))
    }

    private func ringJws(sub: String = subA, epoch: Int, members: [PeerDeviceKeys]) -> String {
        let devices = members.sorted { $0.deviceId < $1.deviceId }.map {
            #"{"deviceId":"\#($0.deviceId)","signKey":"\#($0.signKey)","agreeKey":"\#($0.agreeKey)"}"#
        }.joined(separator: ",")
        return signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","epoch":\#(epoch),"issuedAt":\#(now),"expiresAt":\#(now + 604_800),"devices":[\#(devices)]}"#,
            typ: JwsTyp.ring.rawValue)
    }

    private func certJws(keys: DevicePublicKeys, epoch: Int) -> String {
        signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(subA)","deviceId":"\#(selfId)","signKey":"\#(keys.signKey)","agreeKey":"\#(keys.agreeKey)","ringEpoch":\#(epoch),"issuedAt":\#(now),"expiresAt":\#(now + 604_800)}"#,
            typ: JwsTyp.peer.rawValue)
    }

    private func me(_ keys: DevicePublicKeys) -> PeerDeviceKeys {
        PeerDeviceKeys(deviceId: selfId, signKey: keys.signKey, agreeKey: keys.agreeKey)
    }

    /// Serve an identity at `epoch` with these other devices and K_disc keys.
    private func serve(
        _ keys: DevicePublicKeys, epoch: Int = 1, others: [PeerDeviceKeys]? = nil, disc: [String]? = nil
    ) async {
        let r = ringJws(epoch: epoch, members: [me(keys)] + (others ?? [other]))
        let d = (disc ?? [randomKey()]).map { "\"\($0)\"" }.joined(separator: ",")
        await server.reply(
            "/djdl/connect/identity",
            body: #"{"ring":"\#(r)","certificate":"\#(certJws(keys: keys, epoch: epoch))","discKeys":[\#(d)]}"#)
        await server.reply("/djdl/devices/keys", body: #"{"keySeq":1}"#)
    }

    private func pushed(_ keys: DevicePublicKeys, epoch: Int, others: [PeerDeviceKeys], sub: String = subA)
        -> String
    {
        ringJws(sub: sub, epoch: epoch, members: [me(keys)] + others)
    }

    private func grantBody(
        t: String = ticket, url: String = "wss://key.example/djdl/connect/relay",
        proto: String = "pkey-relay.1", expires: String? = nil
    ) -> String {
        #"{"ticket":"\#(t)","url":"\#(url)","protocol":"\#(proto)","expiresAt":\#(expires ?? String(now + 60))}"#
    }

    // ── The ticket ───────────────────────────────────────────────────────────────────

    func testTheTicketIsAPkeyrtForTheWorkersOwnWssHost() async throws {
        let c = try await client()
        await server.reply("/djdl/connect/relay/ticket", body: grantBody())
        let r = await c.connect.relayTicket()
        let g = try XCTUnwrap(r.grant, "\(r)")
        XCTAssertEqual(g.url.absoluteString, "wss://key.example/djdl/connect/relay")
        XCTAssertEqual(g.protocolName, "pkey-relay.1")
        XCTAssertEqual(g.ticket, ticket)
        XCTAssertEqual(g.expiresAt, now + 60)
        let req = await server.requests(forPath: "/djdl/connect/relay/ticket")
        XCTAssertEqual(req.first?.method, "POST")
        XCTAssertTrue(req.first?.headers["authorization"]?.hasPrefix("Bearer ") == true)
        _ = await c.connect.relayTicket()
        let n = await server.requests(forPath: "/djdl/connect/relay/ticket").count
        XCTAssertEqual(n, 2, "every call asks for a new ticket")
    }

    func testTheTicketIsInNoDescriptionOrDump() async throws {
        let c = try await client()
        await server.reply("/djdl/connect/relay/ticket", body: grantBody())
        let gOpt = await c.connect.relayTicket().grant
        let g = try XCTUnwrap(gOpt)
        var dumped = ""
        dump(g, to: &dumped)
        let all = "\(g) \(String(reflecting: g)) \(dumped)"
        XCTAssertFalse(all.contains(ticket))
        XCTAssertFalse(all.contains("pkeyrt_"))
    }

    func testAGrantForAnotherHostSchemeOrShapeIsRefused() async throws {
        let c = try await client()
        let bad = [
            grantBody(url: "wss://evil.example/djdl/connect/relay"),
            grantBody(url: "ws://key.example/djdl/connect/relay"),
            grantBody(url: "https://key.example/djdl/connect/relay"),
            grantBody(url: "wss://key.example:8443/djdl/connect/relay"),
            grantBody(t: "pkeyrt_short"),
            grantBody(t: "pkeyx_" + String(repeating: "A", count: 33)),
            grantBody(t: ticket + "A"),
            grantBody(proto: "pkey-relay.2"),
            grantBody(expires: "1.5"),
            grantBody(expires: "9007199254740993"),
            grantBody(expires: "\"60\""),
            #"["not","an","object"]"#,
            "not json",
        ]
        for body in bad {
            await server.reply("/djdl/connect/relay/ticket", body: body)
            let r = await c.connect.relayTicket()
            guard case .relay(let e) = r else {
                XCTFail("\(body) -> \(r)")
                continue
            }
            XCTAssertEqual(e.reason, .ticketInvalid, body)
            XCTAssertFalse("\(e) \(e.message)".contains("pkeyrt_"))
        }
    }

    func testTheRefusalsAreTyped() async throws {
        let c = try await client()
        func ask(_ status: Int, _ body: String, headers: [String: String] = [:]) async -> ConnectRelayTicketResult {
            await server.route("/djdl/connect/relay/ticket") { _ in
                .init(status: status, body: body, headers: headers)
            }
            return await c.connect.relayTicket()
        }
        var r = await ask(403, #"{"error":{"code":"relay_disabled"}}"#)
        guard case .relay(let d) = r else { return XCTFail("\(r)") }
        XCTAssertEqual([d.reason.rawValue, d.code, "\(d.status!)"], ["disabled", "relay_disabled", "403"])

        r = await ask(503, #"{"error":{"code":"relay_paused"}}"#, headers: ["Retry-After": "300"])
        guard case .relay(let p) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(p.reason, .paused)
        XCTAssertEqual(p.code, "relay_paused")
        XCTAssertEqual(p.retryAfterSeconds, 300)
        XCTAssertEqual(p.status, 503)

        for scope in ["person", "product"] {
            r = await ask(429, #"{"error":{"code":"relay_quota_exceeded"},"scope":"\#(scope)"}"#)
            guard case .relay(let q) = r else { return XCTFail("\(r)") }
            XCTAssertEqual([q.reason.rawValue, q.scope, q.code], ["quota", scope, "relay_quota_exceeded"])
        }
        r = await ask(429, #"{"error":{"code":"relay_quota_exceeded"},"scope":"galaxy"}"#)
        guard case .relay(let q) = r else { return XCTFail("\(r)") }
        XCTAssertNil(q.scope)

        r = await ask(401, #"{"error":{"code":"relay_ticket_invalid"}}"#)
        guard case .relay(let t) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(t.reason, .ticketInvalid)

        // Any other failure is the ordinary refusal, not a relay one.
        r = await ask(401, #"{"error":{"code":"unauthorized"}}"#)
        XCTAssertEqual(r, .refused(ConnectRefusal(code: "unauthorized", status: 401, message: nil, signInUrl: nil)))
        r = await ask(500, "<html>")
        guard case .error(let code, _) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(code, ErrorCode.invalidResponse)
    }

    func testRetryAfterReadsSecondsAndDates() {
        XCTAssertEqual(ConnectClient.retryAfterSeconds("300"), 300)
        XCTAssertEqual(ConnectClient.retryAfterSeconds("1.2"), 2)
        XCTAssertNil(ConnectClient.retryAfterSeconds(nil))
        XCTAssertNil(ConnectClient.retryAfterSeconds("soon"))
        let at = Date(timeIntervalSince1970: 1_800_000_090)
        XCTAssertEqual(
            ConnectClient.retryAfterSeconds("Fri, 15 Jan 2027 08:01:30 GMT", now: at.addingTimeInterval(-90)), 90)
        XCTAssertEqual(
            ConnectClient.retryAfterSeconds("Fri, 15 Jan 2027 08:01:30 GMT", now: at.addingTimeInterval(1e7)), 0)
    }

    func testNoTokenRefusesBeforeAnyRequest() async throws {
        let c = try await client(token: false)
        let r = await c.connect.relayTicket()
        XCTAssertEqual(r, .error(code: ErrorCode.noToken, message: "Activate or register before using Cloud Connect."))
        let n = await server.requests(forPath: "/djdl/connect/relay/ticket").count
        XCTAssertEqual(n, 0)
    }

    func testEveryReasonCarriesARegisteredCode() throws {
        let registry = Set(ERROR_CODE_VALUES)
        for r in ConnectLanReason.allCases { XCTAssertTrue(registry.contains(r.code), r.rawValue) }
        for r in ConnectRelayReason.allCases { XCTAssertTrue(registry.contains(r.code), r.rawValue) }
        XCTAssertEqual(ConnectLanReason.noIdentity.code, "not-configured")
        XCTAssertEqual(ConnectRelayReason.quota.code, "relay_quota_exceeded")
        XCTAssertEqual(ConnectRelayReason.replaced.code, "cancelled")
    }

    // ── Peer source ──────────────────────────────────────────────────────────────────

    func testPeerSourceNeedsAnIdentity() async throws {
        let c = try await client()
        do {
            _ = try await c.connect.peerSource()
            XCTFail("expected a refusal")
        } catch let e as ConnectLanError {
            XCTAssertEqual(e.reason, .noIdentity)
            XCTAssertEqual(e.code, "not-configured")
        }
    }

    func testPeerSourceIsASnapshotOfTheHeldIdentity() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        let d1 = randomKey()
        let d2 = randomKey()
        await serve(keys, disc: [d1, d2])
        let identOpt = await c.connect.identity(refresh: true).identity
        let ident = try XCTUnwrap(identOpt)
        let src = try await c.connect.peerSource()
        XCTAssertEqual(src.slug, "djdl")
        XCTAssertEqual(src.sub, ident.subject)
        XCTAssertEqual(src.deviceId, selfId)
        XCTAssertEqual(src.certJws, ident.certificateJws)
        XCTAssertEqual(src.ringJws, ident.ringJws)
        XCTAssertEqual(src.ringEpoch, ident.ring.epoch)
        XCTAssertEqual(src.certExpiresAt, ident.certificate.expiresAt)
        XCTAssertEqual(Set(src.roster), [selfId, otherId])
        XCTAssertEqual(src.keys.current.base64url, d1)
        XCTAssertEqual(src.keys.previous?.base64url, d2)
        XCTAssertEqual(Base64URL.encode(src.agreePublic), keys.agreeKey)
        let pub = try await src.staticKey.publicKey()
        XCTAssertEqual(pub, src.agreePublic)
        // A DH with a peer's public key, the private half unseen.
        let peer = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        let out = try await src.staticKey.dh(peer)
        XCTAssertEqual(out?.count, 32)
    }

    func testPeerSourceAndKeysPrintNothingSecret() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        let disc = randomKey()
        await serve(keys, disc: [disc])
        let identOpt = await c.connect.identity(refresh: true).identity
        let ident = try XCTUnwrap(identOpt)
        let src = try await c.connect.peerSource()
        for o: Any in [src, src.keys, src.staticKey, ident.discKeys] {
            var dumped = ""
            dump(o, to: &dumped)
            let text = "\(o) \(String(reflecting: o)) \(dumped)"
            for needle in [ident.certificateJws, ident.ringJws, disc] {
                XCTAssertFalse(text.contains(needle), "\(type(of: o))")
            }
        }
    }

    // ── Pushed rosters ───────────────────────────────────────────────────────────────

    func testAdoptRingWithoutAnIdentity() async throws {
        let c = try await client()
        let r = await c.connect.adoptRing("x.y.z")
        XCTAssertEqual(r, RingAdoption(stored: false, epoch: nil, reason: "no_identity"))
    }

    func testAHigherEpochRosterIsStoredAndAJoinKeepsThePreviousKey() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        await serve(keys, epoch: 1, others: [other], disc: [randomKey(), randomKey()])
        _ = await c.connect.identity(refresh: true)
        let r = await c.connect.adoptRing(pushed(keys, epoch: 2, others: [other, third]))
        XCTAssertEqual(r, RingAdoption(stored: true, epoch: 2, reason: nil))
        let heldOpt = await c.connect.held()
        let held = try XCTUnwrap(heldOpt)
        XCTAssertEqual(held.ring.epoch, 2)
        XCTAssertEqual(held.ring.devices.count, 3)
        XCTAssertEqual(held.discKeys.count, 2, "a join keeps the previous key")
        XCTAssertFalse(held.keysStale)
        let fetches = await server.requests(forPath: "/djdl/connect/identity").count
        XCTAssertEqual(fetches, 1, "nothing was fetched for it")
    }

    func testAStaleForeignOrUnverifiedRosterIsRefusedAndNothingChanges() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        await serve(keys, epoch: 5)
        let beforeOpt = await c.connect.identity(refresh: true).identity
        let before = try XCTUnwrap(beforeOpt)
        for (jws, why) in [
            (pushed(keys, epoch: 5, others: [other]), "epoch-not-higher"),
            (pushed(keys, epoch: 4, others: [other]), "epoch-not-higher"),
            ("a.b.c", "new-rejected"),
            (pushed(keys, epoch: 9, others: [other], sub: subB), "other-product-or-subject"),
        ] {
            let r = await c.connect.adoptRing(jws)
            XCTAssertEqual(r, RingAdoption(stored: false, epoch: nil, reason: why), why)
        }
        let afterOpt = await c.connect.held()
        let after = try XCTUnwrap(afterOpt)
        XCTAssertEqual(after.ringJws, before.ringJws)
        XCTAssertEqual(after.ring.epoch, 5)
    }

    func testARosterThatDropsThisDeviceIsRefused() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        await serve(keys)
        _ = await c.connect.identity(refresh: true)
        let without = ringJws(epoch: 2, members: [other])
        let r = await c.connect.adoptRing(without)
        XCTAssertEqual(r, RingAdoption(stored: false, epoch: nil, reason: "device_not_in_roster"))
        // The same device id with other keys is not this device either.
        let rekeyed = ringJws(epoch: 3, members: [member(selfId), other])
        let r2 = await c.connect.adoptRing(rekeyed)
        XCTAssertEqual(r2.reason, "device_not_in_roster")
    }

    func testARosterWithoutADeviceMarksKDiscStaleUntilAFetch() async throws {
        let c = try await client()
        let keys = try await port.ensure()
        await serve(keys, epoch: 1, others: [other, third], disc: [randomKey(), randomKey()])
        _ = await c.connect.identity(refresh: true)
        let r = await c.connect.adoptRing(pushed(keys, epoch: 2, others: [other]))
        XCTAssertTrue(r.stored)
        // The previous key went with the device, and the copy is not used until a fetch.
        let heldOpt = await c.connect.held()
        var held = try XCTUnwrap(heldOpt)
        XCTAssertTrue(held.keysStale)
        XCTAssertTrue(held.discKeys.isEmpty)
        do {
            _ = try await c.connect.peerSource()
            XCTFail("a stale copy is not a peer source")
        } catch let e as ConnectLanError { XCTAssertEqual(e.reason, .noKeys) }
        // The mark stays through a second pushed roster.
        let r3 = await c.connect.adoptRing(pushed(keys, epoch: 3, others: [other]))
        XCTAssertTrue(r3.stored)
        let heldOpt2 = await c.connect.held()
        held = try XCTUnwrap(heldOpt2)
        XCTAssertTrue(held.keysStale)
        // identity() fetches again though the held identity looks fresh, and clears the mark.
        let fresh = randomKey()
        await serve(keys, epoch: 4, others: [other], disc: [fresh])
        let n = await server.requests(forPath: "/djdl/connect/identity").count
        let gotOpt = await c.connect.identity().identity
        let got = try XCTUnwrap(gotOpt)
        XCTAssertEqual(got.ring.epoch, 4)
        XCTAssertFalse(got.keysStale)
        XCTAssertEqual(got.discKeys.map(\.base64url), [fresh])
        let after = await server.requests(forPath: "/djdl/connect/identity").count
        XCTAssertEqual(after, n + 1)
        _ = try await c.connect.peerSource()
    }

    func testTheStateRecordRoundTripsKeysStale() throws {
        let stale = ConnectRecord(
            ring: "r", certificate: "c", discKeys: [randomKey()], registered: nil, storedAt: 5, keysStale: true)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(stale)) as? [String: Any]
        XCTAssertEqual(json?["keysStale"] as? Bool, true)
        let back = try JSONDecoder().decode(ConnectRecord.self, from: JSONEncoder().encode(stale))
        XCTAssertEqual(back.keysStale, true)
        let plain = ConnectRecord(ring: "r", certificate: "c", discKeys: [randomKey()], registered: nil, storedAt: 5)
        let pj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plain)) as? [String: Any]
        XCTAssertNil(pj?["keysStale"])
        // A record written before this slice still reads.
        let old = Data(#"{"v":1,"ring":"r","certificate":"c","discKeys":[],"storedAt":1}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(ConnectRecord.self, from: old).keysStale)
    }

    func testKeysAfterRing() {
        func ring(_ d: [PeerDeviceKeys]) -> DeviceRing {
            DeviceRing(sub: subA, epoch: 1, issuedAt: 0, expiresAt: 1, devices: d)
        }
        let a = member(selfId)
        let b = member(otherId)
        XCTAssertEqual(connectKeysAfterRing(["n"], prior: ring([a, b]), next: ring([a])), ["n"])
        XCTAssertEqual(connectKeysAfterRing(["n", "p"], prior: ring([a]), next: ring([a, b])), ["n", "p"])
        XCTAssertEqual(connectKeysAfterRing(["n", "p"], prior: ring([a, b]), next: ring([a])), ["n"])
        let rekeyed = PeerDeviceKeys(deviceId: otherId, signKey: a.signKey, agreeKey: a.agreeKey)
        XCTAssertEqual(connectKeysAfterRing(["n", "p"], prior: ring([a, b]), next: ring([a, rekeyed])), ["n"])
    }
}
