// @pkey-feature connect.protocol
// CC-11.8: `PeerChannel` in mode a (WIRE-CONTRACT-V5 §15.5, §15.6): two sessions wired in memory,
// the refusals the matrix cannot show, the records layer against `peer-matrix.json` (`records`,
// read in place), and the mode-a `records.sessions` rows driven through a real session. Mirrors
// client-core's `peerSession.test.ts` and the Python port's `test_connect_peer_session.py`.

import CryptoKit
import Foundation
import XCTest

@testable import PolarisKeyCore

private let sub = "ps_AAAAAAAAAAAAAAAAAAAAAA"
private let nowT = 1_700_001_000
private let idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
private let idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
private let signer = TestSigner(kid: "peer-test-2026")

private func unhex(_ s: String) -> Data {
    let c = Array(s.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    return Data(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
}

private func sha(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
private func rnd() -> Data { Curve25519.KeyAgreement.PrivateKey().rawRepresentation }

private final class Box<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T {
        get { lock.withLock { v } }
        set { lock.withLock { v = newValue } }
    }
    func mutate(_ f: (inout T) -> Void) { lock.withLock { f(&v) } }
}

private struct HeldRing: Sendable {
    let jws: String
    let epoch: Int
}

private struct Dev {
    let id: String
    let priv = Curve25519.KeyAgreement.PrivateKey()
    let signKey: String
    var exp = nowT + 1000
    var epoch = 1

    init(_ id: String, signByte: UInt8, exp: Int = nowT + 1000, epoch: Int = 1) {
        self.id = id
        self.signKey = Base64URL.encode(Data(repeating: signByte, count: 32))
        self.exp = exp
        self.epoch = epoch
    }

    var agreeKey: String { Base64URL.encode(priv.publicKey.rawRepresentation) }

    var cert: String {
        signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","deviceId":"\#(id)","signKey":"\#(signKey)","agreeKey":"\#(agreeKey)","ringEpoch":\#(epoch),"issuedAt":\#(nowT - 10),"expiresAt":\#(exp)}"#,
            typ: "pkey-peer+jws")
    }

    var entry: String { #"{"deviceId":"\#(id)","signKey":"\#(signKey)","agreeKey":"\#(agreeKey)"}"# }
}

private func ring(_ devs: [Dev], epoch: Int, sub s: String = sub) -> String {
    let entries = devs.sorted { $0.id < $1.id }.map(\.entry).joined(separator: ",")
    return signer.sign(
        payloadJSON:
            #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(s)","epoch":\#(epoch),"issuedAt":\#(nowT - 10),"expiresAt":\#(nowT + 1000),"devices":[\#(entries)]}"#,
        typ: "pkey-ring+jws")
}

private final class Side: @unchecked Sendable {
    let events = Box<[PeerSessionEvent]>([])
    let out = Box<[Data]>([])
    let clock = Box<TimeInterval>(0)
    let now = Box<Int>(nowT)
    let held = Box<HeldRing?>(nil)
    var s: PeerChannel!

    init(
        _ role: PeerChannel.Role, _ dev: Dev, _ disc: [Data?], held h: (String, Int)? = nil,
        label: String? = nil, app: String = "demo", rekeyMessages: Int = 1 << 20, rekeySeconds: TimeInterval = 3600
    ) {
        if let h { held.value = HeldRing(jws: h.0, epoch: h.1) }
        let held = self.held
        let clock = self.clock
        let now = self.now
        let events = self.events
        let out = self.out
        let acct = PeerAccountContext(
            trust: signer.trust, expectedAud: "djdl", certJws: dev.cert, ownSub: sub, ownDeviceId: dev.id,
            heldRing: { held.value.map { (jws: $0.jws, epoch: $0.epoch) } }, discKeys: disc)
        s = try! PeerChannel(
            role: role, slug: "djdl", staticKey: try! PeerNoiseRawStaticKey(privateKey: dev.priv.rawRepresentation),
            account: acct, caps: ["app/1", "ring/1"], hello: (label, "test", app, nil),
            send: { d in out.mutate { $0.append(d) } },
            onEvent: { e in events.mutate { $0.append(e) } },
            now: { now.value }, mono: { clock.value }, rekeyMessages: rekeyMessages, rekeySeconds: rekeySeconds)
    }

    var closed: [PeerSessionEvent] {
        events.value.filter { if case .closed = $0 { return true } else { return false } }
    }
    var established: [PeerEstablished] {
        events.value.compactMap { if case .established(let e) = $0 { return e } else { return nil } }
    }
    var records: [(type: Int, body: Data)] {
        events.value.compactMap { if case .record(let t, let b) = $0 { return (t, b) } else { return nil } }
    }
    var ringWanted: Int { events.value.filter { $0 == .ringWanted }.count }
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
        for m in ao { await b.s.receive(m) }
        for m in bo { await a.s.receive(m) }
    }
}

private func pair(rekeyMessages: Int = 1 << 20, rekeySeconds: TimeInterval = 3600) -> (Side, Side, Dev, Dev) {
    let A = Dev(idA, signByte: 1)
    let B = Dev(idB, signByte: 2)
    let k = rnd()
    return (
        Side(.initiator, A, [k], rekeyMessages: rekeyMessages, rekeySeconds: rekeySeconds),
        Side(.responder, B, [k]), A, B
    )
}

private func transport(_ s: Side) async throws -> PeerNoiseTransport {
    guard let tp = await s.s.transportForTesting else {
        XCTFail("no transport")
        throw NSError(domain: "nil", code: 0)
    }
    return tp
}

final class PeerSessionTests: XCTestCase {
    func testAdmitsBothCertificatesAnswersPingRekeysAndCloses() async throws {
        let (a, b, A, B) = pair(rekeyMessages: 2)
        await a.s.start()
        await pump(a, b)
        let est = try XCTUnwrap(a.established.first)
        XCTAssertEqual(est.peerDeviceId, B.id)
        XCTAssertTrue(est.helloAuthenticated)
        XCTAssertEqual(est.caps, ["app/1", "ring/1"])
        XCTAssertEqual(est.hello.platform, "test")
        XCTAssertEqual(b.established.first?.peerDeviceId, A.id)
        for body in ["one", "two", "three"] { try await a.s.sendRecord(type: 0x0100, body: Data(body.utf8)) }
        await pump(a, b)
        XCTAssertEqual(b.records.map(\.body.count), [3, 3, 5])
        try await b.s.sendRecord(type: PeerRecordType.ping, body: Data(count: 8))
        await pump(a, b)
        XCTAssertEqual(b.records.count, 3, "the PONG is the session's, not the host's")
        await a.s.close()
        await pump(a, b)
        XCTAssertEqual(b.closed, [.closed(.peerBye, byPeer: true)])
        XCTAssertEqual(a.closed, [.closed(.peerBye, byPeer: false)])
        let ac = await a.s.closed
        let bc = await b.s.closed
        XCTAssertTrue(ac && bc)
    }

    func testAWrongDiscoveryKeyEndsTheResponderSilently() async {
        let A = Dev(idA, signByte: 1)
        let B = Dev(idB, signByte: 2)
        let a = Side(.initiator, A, [rnd()])
        let b = Side(.responder, B, [rnd()])
        await a.s.start()
        await pump(a, b)
        XCTAssertTrue(b.out.value.isEmpty)
        XCTAssertEqual(b.closed, [.closed(.handshakeFailed, byPeer: false)])
    }

    func testTheResponderAlsoTriesThePreviousDiscoveryKey() async {
        let A = Dev(idA, signByte: 1)
        let B = Dev(idB, signByte: 2)
        let old = rnd()
        let a = Side(.initiator, A, [old])
        let b = Side(.responder, B, [rnd(), old])
        await a.s.start()
        await pump(a, b)
        XCTAssertEqual(b.established.count, 1)
    }

    func testAnAbsentPreviousKeyIsSkippedAndAWrongCurrentKeyFailsCleanly() async {
        let A = Dev(idA, signByte: 1)
        let B = Dev(idB, signByte: 2)
        let k = rnd()
        let a = Side(.initiator, A, [k])
        let b = Side(.responder, B, [k, nil])
        await a.s.start()
        await pump(a, b)
        XCTAssertEqual(b.established.count, 1)
        let c = Side(.initiator, A, [rnd()])
        let d = Side(.responder, B, [k, nil])
        await c.s.start()
        await pump(c, d)
        XCTAssertEqual(d.closed.count, 1)
        XCTAssertTrue(d.established.isEmpty)
    }

    func testTheInitiatorWithoutACurrentKeyCloses() async {
        let a = Side(.initiator, Dev(idA, signByte: 1), [nil])
        await a.s.start()
        XCTAssertEqual(a.closed, [.closed(.handshakeFailed, byPeer: false)])
        XCTAssertTrue(a.out.value.isEmpty)
    }

    func testAnUnusableHeldRosterRefusesAndAsksForAFreshOneButNoneAtAllAdmits() async {
        let A = Dev(idA, signByte: 1)
        let B = Dev(idB, signByte: 2)
        let k = rnd()
        let a = Side(.initiator, A, [k])
        let b = Side(.responder, B, [k], held: ("not-a-roster", 1))
        await a.s.start()
        await pump(a, b)
        XCTAssertEqual(b.ringWanted, 1)
        XCTAssertTrue(b.established.isEmpty)
        XCTAssertEqual(b.closed.count, 1)
        let c = Side(.initiator, A, [k])
        let d = Side(.responder, B, [k])
        await c.s.start()
        await pump(c, d)
        XCTAssertEqual(d.established.count, 1)
        XCTAssertEqual(d.ringWanted, 1)
    }

    func testAPeerMissingFromANewerRosterIsRevoked() async {
        let A = Dev(idA, signByte: 1)
        let B = Dev(idB, signByte: 2)
        let k = rnd()
        let a = Side(.initiator, A, [k])
        let b = Side(.responder, B, [k], held: (ring([B], epoch: 2), 2))
        await a.s.start()
        await pump(a, b)
        XCTAssertEqual(b.closed, [.closed(.peerRevoked, byPeer: false)])
    }

    func testANewerRosterIsPushedVerifiedAndApplied() async {
        let A = Dev(idA, signByte: 1)
        let B = Dev(idB, signByte: 2)
        let k = rnd()
        let a = Side(.initiator, A, [k], held: (ring([A, B], epoch: 3), 3))
        let b = Side(.responder, B, [k], held: (ring([A, B], epoch: 2), 2))
        await a.s.start()
        await pump(a, b)
        let got = b.events.value.compactMap { e -> Int? in if case .ring(_, let n) = e { return n } else { return nil }
        }
        XCTAssertEqual(got, [3])
        let ao = await a.s.isOpen
        let bo = await b.s.isOpen
        XCTAssertTrue(ao && bo)
    }

    func testARosterOfAnotherSubjectChangesNothing() async throws {
        let A = Dev(idA, signByte: 1)
        let B = Dev(idB, signByte: 2)
        let k = rnd()
        let a = Side(.initiator, A, [k])
        let b = Side(.responder, B, [k], held: (ring([A, B], epoch: 2), 2))
        await a.s.start()
        await pump(a, b)
        let tp = try await transport(a)
        let other = ring([A, B], epoch: 9, sub: "ps_BBBBBBBBBBBBBBBBBBBBBB")
        let body = Data(#"{"ring":"\#(other)"}"#.utf8)
        let rec = PeerRecord(type: PeerRecordType.ring, flags: 0, body: body)
        await b.s.receive(try tp.send.encrypt(ad: Data(), PeerRecords.encode(rec)))
        XCTAssertTrue(b.closed.isEmpty)
        XCTAssertFalse(b.events.value.contains { if case .ring = $0 { return true } else { return false } })
    }

    func testAPeerOnANewerRosterThanTheHeldOneAsksForIt() async {
        let A = Dev(idA, signByte: 1, epoch: 5)
        let B = Dev(idB, signByte: 2)
        let k = rnd()
        let a = Side(.initiator, A, [k], held: (ring([A, B], epoch: 5), 5))
        let b = Side(.responder, B, [k], held: (ring([A, B], epoch: 2), 2))
        await a.s.start()
        await pump(a, b)
        XCTAssertEqual(b.ringWanted, 1)
        XCTAssertEqual(b.established.count, 1)
    }

    func testTrustAndBadRingRecords() async throws {
        let (a, b, _, _) = pair()
        await a.s.start()
        await pump(a, b)
        let tp = try await transport(a)
        func wire(_ type: Int, _ body: String) throws -> Data {
            try tp.send.encrypt(ad: Data(), PeerRecords.encode(PeerRecord(type: type, flags: 0, body: Data(body.utf8))))
        }
        await b.s.receive(try wire(PeerRecordType.trust, #"{"trust":"x.y.z"}"#))
        XCTAssertTrue(b.events.value.contains(.trustUnverified(jws: "x.y.z")))
        await b.s.receive(try wire(PeerRecordType.trust, #"{"nope":1}"#))
        XCTAssertEqual(b.closed, [.closed(.peerBadFrame, byPeer: false)])
    }

    func testHelloDisplayDataIsCleaned() async {
        let A = Dev(idA, signByte: 1)
        let B = Dev(idB, signByte: 2)
        let k = rnd()
        let a = Side(.initiator, A, [k], label: "  Cafe\u{301} \u{202E}TV\u{0}  ")
        let b = Side(.responder, B, [k])
        await a.s.start()
        await pump(a, b)
        XCTAssertEqual(b.established.first?.hello.label, "Caf\u{E9} TV")
    }

    /// §15.6: the 4 KiB HELLO bound is for modes v and p; the account mode's HELLO is authenticated.
    /// Its `app` is still cleaned to 64 code points.
    func testModeAHelloIsNotCappedAtFourKiBButAppIsCleaned() async {
        let devA = Dev(idA, signByte: 1)
        let devB = Dev(idB, signByte: 2)
        let k = rnd()
        let a = Side(.initiator, devA, [k], app: String(repeating: "a", count: 5000))
        let b = Side(.responder, devB, [k])
        await a.s.start()
        await pump(a, b)
        XCTAssertTrue(b.closed.isEmpty)
        XCTAssertEqual(b.established.first?.hello.app, String(repeating: "a", count: 64))
    }

    func testTheFirstRecordMustBeHelloAndTheRefusalIsSaid() async throws {
        let A = Dev(idA, signByte: 1)
        let B = Dev(idB, signByte: 2)
        let k = rnd()
        let b = Side(.responder, B, [k])
        let raw = try PeerNoiseHandshake(
            role: .initiator, protocol: peerNoiseProtocol(.a), prologue: peerPrologue(slug: "djdl", mode: .a),
            staticKey: PeerNoiseRawStaticKey(privateKey: A.priv.rawRepresentation),
            psk: peerPsk(discoveryKey: k, slug: "djdl"))
        await b.s.receive(try await raw.writeMessage(PeerPayload.payload1()))
        _ = try await raw.readMessage(b.take()[0])
        await b.s.receive(
            try await raw.writeMessage(PeerPayload.payload23(mode: .a, caps: [], account: (A.cert, 1))))
        let tp = try await raw.transport()
        // The responder's HELLO is out; answer with a PING instead of HELLO.
        let ping = PeerRecord(type: PeerRecordType.ping, flags: 0, body: Data(count: 8))
        await b.s.receive(try tp.send.encrypt(ad: Data(), PeerRecords.encode(ping)))
        XCTAssertEqual(b.closed, [.closed(.peerBadFrame, byPeer: false)])
        let out = b.take()
        _ = try tp.receive.decrypt(ad: Data(), out[0])  // HELLO
        let close = try tp.receive.decrypt(ad: Data(), out[1])
        XCTAssertEqual(String(decoding: close.dropFirst(3), as: UTF8.self), #"{"code":"peer_bad_frame"}"#)
    }

    func testMessagesTwoAndThreeAreCheckedInOrder() async {
        let (a, b, _, _) = pair()
        await a.s.start()
        let m1 = a.take()[0]
        await b.s.receive(m1)
        await b.s.receive(m1)
        XCTAssertEqual(b.closed, [.closed(.handshakeFailed, byPeer: false)])
    }

    func testDeadlinesAreEnforcedByTickOnInjectedClocks() async {
        let (a, _, _, _) = pair()
        await a.s.start()
        var w = await a.s.wakeIn()
        XCTAssertEqual(w, peerTransportDeadlineSeconds)
        a.clock.value = peerTransportDeadlineSeconds - 1
        await a.s.tick()
        XCTAssertTrue(a.closed.isEmpty)
        w = await a.s.wakeIn()
        XCTAssertEqual(w, 1)
        a.clock.value = peerTransportDeadlineSeconds
        await a.s.tick()
        XCTAssertEqual(a.closed, [.closed(.peerTimeout, byPeer: false)])
        w = await a.s.wakeIn()
        XCTAssertNil(w)
        // A responder's clock starts at its first byte, and ends at the transport.
        let (c, d, _, _) = pair()
        w = await d.s.wakeIn()
        XCTAssertNil(w)
        await c.s.start()
        await pump(c, d)
        let open = await d.s.isOpen
        w = await d.s.wakeIn()
        XCTAssertTrue(open)
        XCTAssertNotNil(w, "the peer certificate's expiry")
        d.clock.value = 10_000
        await d.s.tick()
        XCTAssertTrue(d.closed.isEmpty)
    }

    func testAPeerCertificateThatRunsOutClosesTheSession() async {
        let A = Dev(idA, signByte: 1, exp: nowT + 50)
        let B = Dev(idB, signByte: 2)
        let k = rnd()
        let a = Side(.initiator, A, [k])
        let b = Side(.responder, B, [k])
        await a.s.start()
        await pump(a, b)
        let w = await b.s.wakeIn()
        XCTAssertEqual(w, 50)
        b.now.value = nowT + 50
        await b.s.tick()
        XCTAssertEqual(b.closed, [.closed(.peerExpired, byPeer: false)])
        await pump(a, b)
        XCTAssertEqual(a.closed, [.closed(.peerExpired, byPeer: true)])
    }

    func testAnAlreadyExpiredPeerCertificateIsRefusedAtTheHandshake() async {
        let A = Dev(idA, signByte: 1, exp: nowT - 1000)
        let B = Dev(idB, signByte: 2)
        let k = rnd()
        let a = Side(.initiator, A, [k])
        let b = Side(.responder, B, [k])
        await a.s.start()
        await pump(a, b)
        XCTAssertEqual(b.closed, [.closed(.handshakeFailed, byPeer: false)])
        XCTAssertTrue(b.established.isEmpty)
    }

    func testTheAgeOfAKeyRekeysToo() async throws {
        let (a, b, _, _) = pair(rekeySeconds: 10)
        await a.s.start()
        await pump(a, b)
        a.clock.value = 11
        try await a.s.sendRecord(type: 0x0100, body: Data("late".utf8))
        XCTAssertEqual(a.out.value.count, 2, "REKEY, then the record")
        await pump(a, b)
        XCTAssertEqual(b.records.map(\.body), [Data("late".utf8)])
        try await a.s.sendRecord(type: 0x0100, body: Data("again".utf8))
        XCTAssertEqual(a.out.value.count, 1)
    }

    func testSendRecordRefusesWhatTheSessionOwnsOrCannotCarry() async throws {
        let (a, b, _, _) = pair()
        do {
            try await a.s.sendRecord(type: 0x0100, body: Data("early".utf8))
            XCTFail("sent before open")
        } catch { XCTAssertEqual(error as? PeerChannelError, .notOpen) }
        await a.s.start()
        await pump(a, b)
        for t in [PeerRecordType.hello, PeerRecordType.close, PeerRecordType.rekey, PeerRecordType.sasCommit] {
            do {
                try await a.s.sendRecord(type: t, body: Data())
                XCTFail("sent an owned record")
            } catch { XCTAssertEqual(error as? PeerChannelError, .ownedRecord) }
        }
        do {
            try await a.s.sendRecord(type: 0x0100, body: Data(count: peerMaxMessageBytes + 1))
            XCTFail("sent too much")
        } catch { XCTAssertEqual(error as? PeerChannelError, .messageTooLarge) }
    }

    func testTheAccountContextMustFitTheMode() throws {
        let acct = PeerAccountContext(
            trust: [:], expectedAud: "djdl", certJws: "x", ownSub: sub, ownDeviceId: idA, heldRing: { nil },
            discKeys: [])
        let key = try PeerNoiseRawStaticKey(privateKey: rnd())
        // Mode a needs an account; v and p take none; an approver needs a limiter.
        XCTAssertThrowsError(
            try PeerChannel(
                role: .initiator, slug: "djdl", staticKey: key, hello: (nil, "t", "a", nil), send: { _ in },
                onEvent: { _ in }, mode: .a))
        XCTAssertThrowsError(
            try PeerChannel(
                role: .initiator, slug: "djdl", staticKey: key, account: acct, hello: (nil, "t", "a", nil),
                send: { _ in }, onEvent: { _ in }, mode: .v))
        XCTAssertThrowsError(
            try PeerChannel(
                role: .responder, slug: "djdl", staticKey: key, hello: (nil, "t", "a", nil), send: { _ in },
                onEvent: { _ in }, mode: .v)
        ) { XCTAssertEqual($0 as? PeerChannelError, .mode) }
    }

    func testNoSecretInADescription() async throws {
        let (a, b, A, _) = pair()
        await a.s.start()
        await pump(a, b)
        try await a.s.sendRecord(type: 0x0100, body: Data("secret-body".utf8))
        await pump(a, b)
        let acct = PeerAccountContext(
            trust: [:], expectedAud: "x", certJws: A.cert, ownSub: sub, ownDeviceId: A.id, heldRing: { nil },
            discKeys: [rnd()])
        var text = "\(a.s) \(String(reflecting: a.s)) \(a.events.value) \(b.events.value) \(acct)"
        Swift.dump(b.events.value, to: &text)
        Swift.dump(acct, to: &text)
        XCTAssertFalse(text.contains("secret-body"))
        XCTAssertFalse(text.contains(A.cert))
        XCTAssertFalse(text.contains(sub), "the account's subject is not printed")
    }

    // MARK: Records against the matrix

    private struct Matrix: Decodable {
        struct Parse: Decodable {
            struct Want: Decodable {
                let error: String?
                let type: String?
                let more: Bool?
                let body: String?
            }
            let plaintext: String
            let want: Want
        }
        struct Body: Decodable {
            let data: Data
            init(from d: Decoder) throws {
                let c = try d.singleValueContainer()
                if let s = try? c.decode(String.self) {
                    data = unhex(s)
                } else {
                    struct F: Decodable { let fill: String, count: Int }
                    let f = try c.decode(F.self)
                    data = Data(repeating: unhex(f.fill)[0], count: f.count)
                }
            }
        }
        struct Rec: Decodable {
            let type: String
            let flags: Int?
            let body: Body
        }
        struct Delivered: Decodable, Equatable {
            let type: String
            let length: Int
            let sha256: String
        }
        struct Want: Decodable {
            let close: String?
            let at: Int?
            let delivered: [Delivered]?
        }
        struct Sess: Decodable {
            let id, mode: String
            let records: [Rec]
            let want: Want
        }
        struct Records: Decodable {
            let parse: [Parse]
            let sessions: [Sess]
        }
        let records: Records
    }

    private let m = try! CorpusLocator.load(Matrix.self, "peer-matrix")

    private func h4(_ n: Int) -> String { String(format: "%04x", n) }

    func testRecordParse() {
        for r in m.records.parse {
            let got = PeerRecords.parse(unhex(r.plaintext))
            if r.want.error != nil {
                XCTAssertNil(got, r.plaintext)
            } else {
                XCTAssertEqual(got.map { h4($0.type) }, r.want.type)
                XCTAssertEqual(got.map { $0.flags & 1 != 0 }, r.want.more)
                XCTAssertEqual(got.map { $0.body.map { String(format: "%02x", $0) }.joined() }, r.want.body)
            }
        }
    }

    func testRecordSessionsThroughTheAssemblerForEveryMode() {
        XCTAssertFalse(m.records.sessions.isEmpty)
        for s in m.records.sessions {
            var asm = PeerRecordAssembler(mode: PeerRecordMode(rawValue: s.mode)!)
            var delivered: [Matrix.Delivered] = []
            var close: (String, Int)?
            for (i, rec) in s.records.enumerated() where close == nil {
                let r = asm.push(
                    PeerRecord(type: Int(rec.type, radix: 16)!, flags: UInt8(rec.flags ?? 0), body: rec.body.data))
                switch r {
                case .close(let c): close = (c.rawValue, i)
                case .message(let t, let body):
                    delivered.append(.init(type: h4(t), length: body.count, sha256: sha(body)))
                default: break
                }
            }
            if let want = s.want.close {
                XCTAssertEqual(close?.0, want, s.id)
                XCTAssertEqual(close?.1, s.want.at, s.id)
            } else {
                XCTAssertNil(close, s.id)
                XCTAssertEqual(delivered, s.want.delivered, s.id)
            }
        }
    }

    // The session answers or consumes these itself; the assembler rows cover them.
    private static let internalTypes: Set<Int> = [0x0002, 0x0003, 0x0004, 0x0005, 0x80FE, 0x80FF, 0x8001]

    func testModeARowsThroughARealSession() async throws {
        var ran = 0
        for s in m.records.sessions where s.mode == "a" {
            let types = Set(s.records.map { Int($0.type, radix: 16)! })
            if !types.isDisjoint(with: Self.internalTypes) { continue }
            let (a, b, _, _) = pair()
            await a.s.start()
            await pump(a, b)
            let tp = try await transport(a)
            let open = await b.s.isOpen
            XCTAssertTrue(open, s.id)
            var skipped = false
            for rec in s.records {
                let plain = PeerRecords.encode(
                    PeerRecord(type: Int(rec.type, radix: 16)!, flags: UInt8(rec.flags ?? 0), body: rec.body.data))
                guard let wire = try? tp.send.encrypt(ad: Data(), plain) else {
                    skipped = true  // a single Noise message cannot carry this record
                    break
                }
                await b.s.receive(wire)
                if await b.s.closed { break }
            }
            if skipped { continue }
            ran += 1
            if let want = s.want.close {
                XCTAssertEqual(b.closed, [.closed(PeerClosedReason(rawValue: want)!, byPeer: false)], s.id)
            } else {
                let got = b.records.map {
                    Matrix.Delivered(type: h4($0.type), length: $0.body.count, sha256: sha($0.body))
                }
                XCTAssertEqual(got, s.want.delivered, s.id)
                XCTAssertTrue(b.closed.isEmpty, s.id)
            }
        }
        XCTAssertGreaterThan(ran, 10, "the mode-a rows that reach the host")
    }
}
