// @pkey-feature connect.links
// CC-19.7: inter-account links in the core (WIRE-CONTRACT-V5 §15.10): the `contact` section of
// `peer-matrix.json` (secret, CONTACT body, categories, exchange, store, pin, advert, room, ticket
// body, the shared listener's trial order) and two real `PeerChannel`s pairing in mode p and then
// meeting in mode c. Mirrors client-core's `peerContact.test.ts` and `peerListener.test.ts`.
// The listener rows' "tried" counts are not asserted: the AEAD port is not injectable here, so the
// trial order is proven by which key opens, which slot is held and what is sent.

import Foundation
import XCTest

@testable import PolarisKeyCore

private func unhex(_ s: String) -> Data {
    let c = Array(s.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    return Data(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
}
private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
private func rnd() -> Data { Data((0..<32).map { _ in UInt8.random(in: 0...255) }) }

private final class Box<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    func mutate(_ f: (inout T) -> Void) { lock.withLock { f(&v) } }
    var value: T { lock.withLock { v } }
}

private func rowBytes(_ r: [String: JSONValue]) -> Data {
    if let h = r["bodyHex"]?.stringValue { return unhex(h) }
    if let p = r["bodyPad"]?.objectValue {
        return Data(
            (p["prefix"]!.stringValue! + String(repeating: p["fill"]!.stringValue!, count: p["count"]!.intValue!)
                + p["suffix"]!.stringValue!).utf8)
    }
    return Data(r["body"]!.stringValue!.utf8)
}

final class PeerContactCorpusTests: XCTestCase {
    private let c: [String: JSONValue] = {
        let v = try! CorpusLocator.load(JSONValue.self, "peer-matrix")
        return v.objectValue!["contact"]!.objectValue!
    }()

    private func rows(_ key: String) -> [[String: JSONValue]] { c[key]!.arrayValue!.map { $0.objectValue! } }

    func testConstants() {
        let k = c["constants"]!.objectValue!
        XCTAssertEqual(k["maxContacts"]?.intValue, maxContacts)
        XCTAssertEqual(k["maxCats"]?.intValue, maxContactCats)
        XCTAssertEqual(k["maxPending"]?.intValue, maxPendingContacts)
        XCTAssertEqual(k["maxSecrets"]?.intValue, maxContactSecrets)
        XCTAssertEqual(k["pendingSeconds"]?.intValue, pendingContactSeconds)
        XCTAssertEqual(k["bodyMax"]?.intValue, contactBodyMax)
        XCTAssertEqual(k["ticketBodyMax"]?.intValue, contactTicketBodyMax)
        XCTAssertEqual(k["maxLiveAdverts"]?.intValue, maxLiveContactAdverts)
        XCTAssertEqual(k["leaseBytes"]?.intValue, contactLeaseBytes)
        XCTAssertEqual(k["roomIdleSeconds"]?.intValue, contactRoomIdleSeconds)
        XCTAssertEqual(k["exchangeSeconds"]?.intValue, contactExchangeSeconds)
    }

    func testSecrets() throws {
        for r in rows("secrets") {
            let got = try PeerContacts.secret(
                h: unhex(r["h"]!.stringValue!), nD: unhex(r["nD"]!.stringValue!), nM: unhex(r["nM"]!.stringValue!),
                agreeKeyA: Base64URL.decodeStrict(r["agreeKeyA"]!.stringValue!)!,
                agreeKeyB: Base64URL.decodeStrict(r["agreeKeyB"]!.stringValue!)!)
            XCTAssertEqual(hex(got), r["secret"]!.stringValue, r["id"]!.stringValue!)
        }
    }

    func testBodies() {
        for r in rows("bodies") {
            let b = rowBytes(r)
            let id = r["id"]!.stringValue!
            XCTAssertEqual(b.count, r["length"]!.intValue, id)
            let want = r["want"]!.objectValue!
            let got = PeerContacts.parseContact(b, own: r["own"]?.stringValue)
            if want["ok"]?.boolValue == true {
                guard case .ok(let body) = got else { return XCTFail("\(id): refused") }
                XCTAssertEqual(body.agreeKey, want["agreeKey"]!.stringValue, id)
                XCTAssertEqual(body.label, want["label"]?.stringValue, id)
                XCTAssertEqual(body.cats, want["cats"]!.arrayValue!.map { $0.stringValue! }, id)
            } else {
                XCTAssertEqual(got, .no, id)
            }
        }
    }

    func testCategories() {
        for r in rows("categories") {
            XCTAssertEqual(
                PeerContacts.categories(
                    r["local"]!.arrayValue!.map { $0.stringValue! }, r["remote"]!.arrayValue!.map { $0.stringValue! }),
                r["want"]!.arrayValue!.map { $0.stringValue! }, r["id"]!.stringValue!)
        }
    }

    func testExchange() {
        for r in rows("exchange") {
            var x = PeerContacts.Exchange(
                own: r["own"]!.stringValue, held: r["held"]!.arrayValue!.map { $0.stringValue! })
            let steps = r["steps"]!.arrayValue!.map { $0.objectValue! }
            let want = r["want"]!.arrayValue!.map { $0.objectValue! }
            XCTAssertEqual(want.count, steps.count, r["id"]!.stringValue!)
            for (i, s) in steps.enumerated() {
                let e: ContactExchangeEvent
                switch s["event"]!.stringValue! {
                case "own-confirm": e = .ownConfirm
                case "peer-confirm": e = .peerConfirm
                case "timeout": e = .timeout
                default: e = .peerContact(Data(s["body"]!.stringValue!.utf8))
                }
                let got = x.step(e)
                let w = want[i]
                let tag = "\(r["id"]!.stringValue!) step \(i)"
                XCTAssertEqual(got.sends, w["sends"]!.arrayValue!.map { $0.stringValue! }, tag)
                XCTAssertEqual(got.close?.rawValue, w["close"]?.stringValue, tag)
                if let st = w["stored"]?.objectValue {
                    XCTAssertEqual(got.stored?.body.agreeKey, st["agreeKey"]!.stringValue, tag)
                    XCTAssertEqual(got.stored?.body.label, st["label"]?.stringValue, tag)
                    XCTAssertEqual(got.stored?.body.cats, st["cats"]!.arrayValue!.map { $0.stringValue! }, tag)
                    XCTAssertEqual(got.stored?.pending, st["pending"]!.boolValue, tag)
                } else {
                    XCTAssertNil(got.stored, tag)
                }
            }
        }
    }

    func testStore() {
        func fill(_ n: Int) -> Data { Data(repeating: UInt8(n), count: 32) }
        func key(_ n: Int) -> String { Base64URL.encode(fill(n)) }
        for r in rows("store") {
            var list = r["start"]!.arrayValue!.map { p -> StoredContact in
                let a = p.arrayValue!
                return StoredContact(agreeKey: key(a[0].intValue!), secret: fill(a[1].intValue!), cats: [])
            }
            let ops = r["ops"]!.arrayValue!.map { $0.objectValue! }
            let want = r["want"]!.arrayValue!.map { $0.objectValue! }
            for (i, o) in ops.enumerated() {
                var result: String?
                switch o["op"]!.stringValue! {
                case "pair":
                    let inc = StoredContact(
                        agreeKey: key(o["key"]!.intValue!), secret: fill(o["secret"]!.intValue!),
                        label: o["label"]?.stringValue, cats: [])
                    switch PeerContacts.store(list, incoming: inc, now: o["now"]!.intValue!) {
                    case .stored(let l, let pending):
                        list = l
                        result = pending ? "pending" : "active"
                    case .full: result = "full"
                    }
                case "promote": list = PeerContacts.promote(list, agreeKey: key(o["key"]!.intValue!))
                default: list = PeerContacts.dropStalePending(list, now: o["now"]!.intValue!)
                }
                func ids(_ l: [StoredContact]) -> [Int] { l.map { Int($0.secret[0]) } }
                let w = want[i]
                let tag = "\(r["id"]!.stringValue!) op \(i)"
                XCTAssertEqual(result, w["result"]?.stringValue, tag)
                XCTAssertEqual(
                    ids(list.filter { $0.pendingSince == nil }), w["active"]!.arrayValue!.map { $0.intValue! }, tag)
                XCTAssertEqual(
                    ids(list.filter { $0.pendingSince != nil }), w["pending"]!.arrayValue!.map { $0.intValue! }, tag)
                XCTAssertEqual(ids(PeerContacts.trialOrder(list)), w["order"]!.arrayValue!.map { $0.intValue! }, tag)
            }
        }
    }

    func testPin() {
        for r in rows("pin") {
            let held = r["held"]!.arrayValue!.map { $0.stringValue! }
            let ok = PeerContacts.pin(
                held: held[r["matched"]!.intValue!],
                remoteStatic: Base64URL.decodeStrict(r["remoteStatic"]!.stringValue!)!)
            XCTAssertEqual(ok, r["want"]!.objectValue!["ok"]!.boolValue, r["id"]!.stringValue!)
        }
    }

    func testAdvertNamesTxtBrowse() {
        let a = c["adverts"]!.objectValue!
        XCTAssertEqual(a["epochSeconds"]?.intValue, 900)
        for r in a["names"]!.arrayValue!.map({ $0.objectValue! }) {
            XCTAssertEqual(
                PeerContacts.instance(
                    secret: unhex(r["secret"]!.stringValue!),
                    advertiserAgreeKey: Base64URL.decodeStrict(r["agreeKey"]!.stringValue!)!,
                    epoch: r["epoch"]!.intValue!),
                r["instance"]!.stringValue, r["id"]!.stringValue!)
        }
        for r in a["txt"]!.arrayValue!.map({ $0.objectValue! }) {
            let want = r["want"]!.objectValue!
            let got = PeerContacts.parseTxt(r["entries"]!.arrayValue!.map { $0.stringValue! })
            if want["ok"]?.boolValue == true {
                XCTAssertEqual(got, .ok, r["id"]!.stringValue!)
            } else {
                XCTAssertEqual(got, .refused(want["reason"]!.stringValue!), r["id"]!.stringValue!)
            }
        }
        for r in a["browse"]!.arrayValue!.map({ $0.objectValue! }) {
            let keys = r["contacts"]!.arrayValue!.map { k -> ContactAdvertKey in
                let o = k.objectValue!
                return ContactAdvertKey(
                    secret: unhex(o["secret"]!.stringValue!),
                    agreeKey: Base64URL.decodeStrict(o["agreeKey"]!.stringValue!)!)
            }
            let hit = PeerContacts.browse(
                instance: r["instance"]!.stringValue!, contacts: keys, now: r["now"]!.intValue!)
            if let w = r["want"]?.objectValue {
                XCTAssertEqual(hit?.contact, w["contact"]?.intValue, r["id"]!.stringValue!)
                XCTAssertEqual(hit?.epochBack, w["epochBack"]?.intValue, r["id"]!.stringValue!)
            } else {
                XCTAssertNil(hit, r["id"]!.stringValue!)
            }
        }
    }

    func testRoomsAndTickets() throws {
        let rooms = c["rooms"]!.objectValue!
        for r in rooms["rid"]!.arrayValue!.map({ $0.objectValue! }) {
            XCTAssertEqual(
                PeerContacts.rid(secret: unhex(r["secret"]!.stringValue!)), r["rid"]!.stringValue, r["id"]!.stringValue!
            )
        }
        for r in rooms["alias"]!.arrayValue!.map({ $0.objectValue! }) {
            XCTAssertEqual(
                hex(try PeerContacts.alias(rid: r["rid"]!.stringValue!, deviceId: r["deviceId"]!.stringValue!)),
                r["alias"]!.stringValue, r["id"]!.stringValue!)
        }
        for r in rows("tickets") {
            let b = rowBytes(r)
            XCTAssertEqual(b.count, r["length"]!.intValue, r["id"]!.stringValue!)
            let want = r["want"]!.objectValue!
            let got = PeerContacts.parseTicketBody(b)
            XCTAssertEqual(got, want["ok"]?.boolValue == true ? want["rid"]!.stringValue : nil, r["id"]!.stringValue!)
        }
        XCTAssertEqual(
            String(decoding: try PeerContacts.ticketBody(rid: "lXg0MgIHVN5qAmGFUen7vA"), as: UTF8.self),
            #"{"room":"c","rid":"lXg0MgIHVN5qAmGFUen7vA"}"#)
    }

    /// The shared listener's trial order through a real responder: which key opens message 1, what is
    /// answered, what closes, and whether the contact trial holds its limiter slot.
    func testListener() async throws {
        let slug = "djdl"
        for r in rows("listener") {
            let id = r["id"]!.stringValue!
            let account = r["account"]?.arrayValue
            let keys: [Data] = (account ?? []).map { _ in rnd() }
            let secrets: [Data] = r["contacts"]!.arrayValue!.map { _ in rnd() }
            var mode = PeerNoiseMode.c
            var psk: Data? = rnd()
            if let o = r["opens"]?.objectValue {
                if o["mode"]!.stringValue == "a" {
                    mode = .a
                    psk = try peerPsk(discoveryKey: keys[o["key"]!.intValue!], slug: slug)
                } else {
                    psk = secrets[o["contact"]!.intValue!]
                }
            }
            let limiter = HandshakeLimiter(
                maxPerMinute: r["limiter"]!.stringValue == "refuse" ? 0 : 99, maxPending: 1, mono: { 0 })
            let out = Box<[Data]>([])
            let events = Box<[PeerSessionEvent]>([])
            let acct = account.map { a in
                PeerAccountContext(
                    trust: TrustSet(), expectedAud: slug, certJws: "", ownSub: "ps_x",
                    ownDeviceId: String(repeating: "x", count: 32),
                    heldRing: { nil },
                    discKeys: a.enumerated().map { $0.element.stringValue == nil ? nil : keys[$0.offset] })
            }
            let ch = try PeerChannel(
                role: .responder, slug: slug, staticKey: PeerNoiseRawStaticKey(privateKey: rnd()), account: acct,
                admission: limiter,
                contacts: secrets.map { PeerContactLink(secret: $0, agreeKey: Base64URL.encode(rnd())) },
                hello: (nil, "t", "a", nil), send: { d in out.mutate { $0.append(d) } },
                onEvent: { e in events.mutate { $0.append(e) } }, mode: acct != nil ? .a : .c)
            let handshakeInit = try PeerNoiseHandshake(
                role: .initiator, protocol: peerNoiseProtocol(mode), prologue: peerPrologue(slug: slug, mode: mode),
                staticKey: PeerNoiseRawStaticKey(privateKey: rnd()), psk: psk)
            await ch.receive(try await handshakeInit.writeMessage(PeerPayload.payload1()))
            let want = r["want"]!.objectValue!
            let closed = events.value.compactMap { e -> String? in
                if case .closed(let c, _) = e { return c.rawValue } else { return nil }
            }.first
            XCTAssertEqual(closed, want["close"]?.stringValue, "\(id) close")
            XCTAssertEqual(out.value.count, want["hit"]?.stringValue == nil ? 0 : 1, "\(id) answered")
            if r["limiter"]!.stringValue == "admit" {
                XCTAssertEqual(limiter.begin() == nil, want["slot"]!.boolValue, "\(id) slot")
            }
        }
    }
}

// MARK: - Two channels

private final class Side: @unchecked Sendable {
    let events = Box<[PeerSessionEvent]>([])
    let out = Box<[Data]>([])
    var ch: PeerChannel!
    let clock = Box<TimeInterval>(0)
    let key: PeerNoiseRawStaticKey
    let pub: Data

    init(
        _ mode: PeerNoiseMode, _ role: PeerChannel.Role, key: Data = rnd(), contacts: [PeerContactLink] = [],
        exchange: PeerContactOffer? = nil, nonce: Data? = nil
    ) async {
        self.key = try! PeerNoiseRawStaticKey(privateKey: key)
        pub = try! await self.key.publicKey()
        let (events, out, clock) = (self.events, self.out, self.clock)
        ch = try! PeerChannel(
            role: role, slug: "djdl", staticKey: self.key,
            admission: role == .responder ? HandshakeLimiter() : nil, caps: ["app/1"], contacts: contacts,
            exchange: exchange, hello: ("Anna", "test", "demo", nil), send: { d in out.mutate { $0.append(d) } },
            onEvent: { e in events.mutate { $0.append(e) } }, mode: mode,
            random: nonce.map { n in { @Sendable len in len == 32 ? n : rnd() } }, mono: { clock.value })
    }

    var closed: [(PeerClosedReason, Bool)] {
        events.value.compactMap { if case .closed(let c, let b) = $0 { return (c, b) } else { return nil } }
    }
    var established: [PeerEstablished] {
        events.value.compactMap { if case .established(let e) = $0 { return e } else { return nil } }
    }
    var contacts: [(Data, ContactBody, Bool)] {
        events.value.compactMap { if case .contact(let s, let b, let p) = $0 { return (s, b, p) } else { return nil } }
    }
    func take() -> [Data] {
        var d: [Data] = []
        out.mutate {
            d = $0
            $0 = []
        }
        return d
    }
}

private func pump(_ a: Side, _ b: Side) async {
    for _ in 0..<200 {
        let ao = a.take()
        let bo = b.take()
        if ao.isEmpty && bo.isEmpty { return }
        for m in ao { await b.ch.receive(m) }
        for m in bo { await a.ch.receive(m) }
    }
}

final class PeerContactSessionTests: XCTestCase {
    private func key(_ d: Data) -> String { Base64URL.encode(d) }

    /// Pair two devices (mode p with the exchange), return both secrets and the keys.
    private func pair(
        cats a: [String] = ["docs"], b: [String] = ["docs", "photos"], heldA: [String] = []
    ) async throws -> (
        secretA: Data, secretB: Data, keyA: Data, keyB: Data, privA: Data, privB: Data, bodyA: ContactBody
    ) {
        let privA = rnd()
        let privB = rnd()
        let pubA = try await PeerNoiseRawStaticKey(privateKey: privA).publicKey()
        let pubB = try await PeerNoiseRawStaticKey(privateKey: privB).publicKey()
        let d = await Side(
            .p, .initiator, exchange: PeerContactOffer(agreeKey: key(pubA), held: heldA, label: "Ana", cats: a))
        let m = await Side(.p, .responder, exchange: PeerContactOffer(agreeKey: key(pubB), label: "Ben", cats: b))
        await d.ch.start()
        await pump(d, m)
        await d.ch.confirmSas()
        await m.ch.confirmSas()
        await pump(d, m)
        let cd = try XCTUnwrap(d.contacts.first)
        let cm = try XCTUnwrap(m.contacts.first)
        XCTAssertEqual(cd.0, cm.0, "both sides derive the same secret")
        XCTAssertEqual(cd.1.agreeKey, key(pubB))
        XCTAssertEqual(cd.1.label, "Ben")
        XCTAssertEqual(cm.1.agreeKey, key(pubA))
        XCTAssertFalse(cd.2)
        XCTAssertEqual(d.contacts.count, 1)
        return (cd.0, cm.0, pubA, pubB, privA, privB, cm.1)
    }

    func testPairingThenModeC() async throws {
        let p = try await pair()
        XCTAssertEqual(p.bodyA.cats, ["docs"])
        // Mode c: A dials B under the shared secret, each pinned to the other's key.
        let a = await Side(
            .c, .initiator, key: p.privA, contacts: [PeerContactLink(secret: p.secretA, agreeKey: key(p.keyB))])
        let b = await Side(
            .c, .responder, key: p.privB, contacts: [PeerContactLink(secret: p.secretB, agreeKey: key(p.keyA))])
        await a.ch.start()
        await pump(a, b)
        let ea = try XCTUnwrap(a.established.first)
        let eb = try XCTUnwrap(b.established.first)
        XCTAssertEqual(ea.contactIndex, 0)
        XCTAssertEqual(eb.contactIndex, 0)
        XCTAssertFalse(ea.helloAuthenticated)
        XCTAssertFalse(eb.helloAuthenticated)
        XCTAssertNil(ea.peerDeviceId)
        // RING and TRUST are not allowed in mode c.
        let aClosed = await a.ch.isOpen
        XCTAssertTrue(aClosed)
        try await a.ch.sendRecord(type: 0x0100, body: Data("hi".utf8))
        await pump(a, b)
        XCTAssertTrue(b.events.value.contains { if case .record(0x0100, _) = $0 { return true } else { return false } })
    }

    func testPinRefusesAWrongKeyAndSendsNothing() async throws {
        let p = try await pair()
        let wrong = key(rnd())
        let a = await Side(
            .c, .initiator, key: p.privA, contacts: [PeerContactLink(secret: p.secretA, agreeKey: wrong)])
        let b = await Side(
            .c, .responder, key: p.privB, contacts: [PeerContactLink(secret: p.secretB, agreeKey: key(p.keyA))])
        await a.ch.start()
        await pump(a, b)
        XCTAssertEqual(a.closed.first?.0, .peerRevoked)
        XCTAssertTrue(a.established.isEmpty)
        XCTAssertTrue(b.established.isEmpty)
    }

    func testResponderPicksTheRightSecret() async throws {
        let p = try await pair()
        let others = (0..<5).map { _ in PeerContactLink(secret: rnd(), agreeKey: key(rnd())) }
        let b = await Side(
            .c, .responder, key: p.privB, contacts: others + [PeerContactLink(secret: p.secretB, agreeKey: key(p.keyA))]
        )
        let a = await Side(
            .c, .initiator, key: p.privA, contacts: [PeerContactLink(secret: p.secretA, agreeKey: key(p.keyB))])
        await a.ch.start()
        await pump(a, b)
        XCTAssertEqual(b.established.first?.contactIndex, 5)
    }

    func testRePairOfAHeldPeerIsPending() async throws {
        let privB = rnd()
        let pubB = try await PeerNoiseRawStaticKey(privateKey: privB).publicKey()
        let privA = rnd()
        let pubA = try await PeerNoiseRawStaticKey(privateKey: privA).publicKey()
        let d = await Side(.p, .initiator, exchange: PeerContactOffer(agreeKey: key(pubA), held: [key(pubB)], cats: []))
        let m = await Side(.p, .responder, exchange: PeerContactOffer(agreeKey: key(pubB), cats: []))
        await d.ch.start()
        await pump(d, m)
        await d.ch.confirmSas()
        await m.ch.confirmSas()
        await pump(d, m)
        XCTAssertEqual(d.contacts.first?.2, true)
        XCTAssertEqual(m.contacts.first?.2, false)
    }

    func testContactBeforeOwnConfirmClosesBadFrame() async throws {
        let pubA = try await PeerNoiseRawStaticKey(privateKey: rnd()).publicKey()
        let d = await Side(.p, .initiator, exchange: PeerContactOffer(agreeKey: key(pubA), cats: []))
        let m = await Side(.p, .responder)
        await d.ch.start()
        await pump(d, m)
        // The peer is a plain host: it confirms and sends CONTACT before d's person has confirmed.
        await m.ch.confirmSas()
        try await m.ch.sendRecord(
            type: PeerRecordType.contact, body: PeerContacts.buildContact(agreeKey: key(rnd()), label: nil, cats: []))
        await pump(d, m)
        XCTAssertEqual(d.closed.first?.0, .peerBadFrame)
        XCTAssertTrue(d.contacts.isEmpty)
    }

    func testExchangeTimeoutClosesPeerTimeout() async throws {
        let pubA = try await PeerNoiseRawStaticKey(privateKey: rnd()).publicKey()
        let d = await Side(.p, .initiator, exchange: PeerContactOffer(agreeKey: key(pubA), cats: []))
        let m = await Side(.p, .responder)
        await d.ch.start()
        await pump(d, m)
        await d.ch.confirmSas()
        d.clock.mutate { $0 += 31 }
        await d.ch.tick()
        XCTAssertEqual(d.closed.first?.0, .peerTimeout)
    }
}

final class PeerContactRedactionTests: XCTestCase {
    func testContactAdvertKeyAndPeerContactLinkAreRedactedInDescriptionDebugDescriptionAndDump() {
        let secret = Data(repeating: 0xAB, count: 32)
        let key = Data(repeating: 0xCD, count: 32)
        let a = ContactAdvertKey(secret: secret, agreeKey: key)
        let l = PeerContactLink(secret: secret, agreeKey: String(repeating: "A", count: 43))
        var out = ""
        dump(a, to: &out)
        dump([a], to: &out)
        dump(l, to: &out)
        dump([l], to: &out)
        out += "\(a) \(l) \(String(reflecting: a)) \(String(reflecting: l))"
        XCTAssertFalse(out.contains("171"), "no byte of the secret (0xAB)")
        XCTAssertFalse(out.contains("205"), "no byte of the key (0xCD)")
        XCTAssertFalse(out.contains("32 bytes"))
    }
}
