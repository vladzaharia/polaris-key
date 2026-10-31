// @pkey-feature connect.protocol
// CC-11.9: `PeerChannel` in modes v and p (WIRE-CONTRACT-V5 §15.5, §15.6): the commit-reveal SAS,
// the corpus `sas` rows through a real session, the approver's limiter and the deadlines. Mirrors
// the modes v and p half of client-core's `peerSession.test.ts` and the Python port's
// `test_connect_peer_sas.py`.

import Foundation
import XCTest

@testable import PolarisKeyCore

private func unhex(_ s: String) -> Data {
    let c = Array(s.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    return Data(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
}

private func rnd() -> Data { Data((0..<32).map { _ in UInt8.random(in: 0...255) }) }

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

private final class Side: @unchecked Sendable {
    let events = Box<[PeerSessionEvent]>([])
    let out = Box<[Data]>([])
    let clock = Box<TimeInterval>(0)
    var s: PeerChannel!

    init(
        _ mode: PeerNoiseMode, _ role: PeerChannel.Role, admission: HandshakeLimiter? = nil, label: String? = nil,
        nonce: Data? = nil, holdSas: Bool = false, caps: [String] = ["app/1", "ring/1"]
    ) {
        let clock = self.clock
        let events = self.events
        let out = self.out
        let lim = admission ?? (role == .responder ? HandshakeLimiter() : nil)
        s = try! PeerChannel(
            role: role, slug: "djdl", staticKey: try! PeerNoiseRawStaticKey(privateKey: rnd()), admission: lim,
            caps: caps, hello: (label, "test", "demo", nil),
            send: { d in out.mutate { $0.append(d) } }, onEvent: { e in events.mutate { $0.append(e) } },
            mode: mode, random: nonce.map { n in { @Sendable len in len == 32 ? n : rnd() } },
            mono: { clock.value }, holdSas: holdSas)
    }

    var closed: [PeerSessionEvent] {
        events.value.filter { if case .closed = $0 { return true } else { return false } }
    }
    var sas: [(code: Int, display: String)] {
        events.value.compactMap { if case .sas(let c, let d) = $0 { return (c, d) } else { return nil } }
    }
    var established: [PeerEstablished] {
        events.value.compactMap { if case .established(let e) = $0 { return e } else { return nil } }
    }
    var types: [Int] { events.value.compactMap { if case .record(let t, _) = $0 { return t } else { return nil } } }
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

/// A raw initiator, past message 3, for the refusals only a hand-built peer can show.
private func rawPeer(_ mode: PeerNoiseMode, to m: Side, payload3: String? = nil) async throws
    -> PeerNoiseTransport
{
    // Mode v lists `vouch/1` itself (§15.6.1 rule 1), so a raw mode-v peer must too.
    let payload3 = payload3 ?? (mode == .v ? #"{"v":1,"caps":["vouch/1"]}"# : #"{"v":1,"caps":[]}"#)
    let raw = try PeerNoiseHandshake(
        role: .initiator, protocol: peerNoiseProtocol(mode), prologue: peerPrologue(slug: "djdl", mode: mode),
        staticKey: PeerNoiseRawStaticKey(privateKey: Data(repeating: 7, count: 32)))
    await m.s.receive(try await raw.writeMessage(PeerPayload.payload1()))
    _ = try await raw.readMessage(m.take()[0])
    await m.s.receive(try await raw.writeMessage(Data(payload3.utf8)))
    return try await raw.transport()
}

private func put(_ tp: PeerNoiseTransport, _ m: Side, _ type: Int, _ body: Data) async throws {
    await m.s.receive(try tp.send.encrypt(ad: Data(), PeerRecords.encode(PeerRecord(type: type, flags: 0, body: body))))
}

private let helloBody = Data(#"{"platform":"t","app":"a","maxMessage":1048576}"#.utf8)

final class PeerSessionSASTests: XCTestCase {
    private struct Matrix: Decodable {
        struct Commit: Decodable {
            let c, nD, commitBody, revealBody: String
        }
        struct Code: Decodable {
            let h, nD, nM, mode, display: String
            let code: Int
        }
        struct SAS: Decodable {
            let commits: [Commit]
            let codes: [Code]
        }
        let sas: SAS
    }
    private let m = try! CorpusLocator.load(Matrix.self, "peer-matrix")

    func testBothSidesShowTheSameCodeThenRecordsFlow() async throws {
        for mode in [PeerNoiseMode.v, .p] {
            let d = Side(mode, .initiator)
            let a = Side(mode, .responder)
            await d.s.start()
            await pump(d, a)
            let sd = try XCTUnwrap(d.sas.first)
            let sm = try XCTUnwrap(a.sas.first)
            XCTAssertEqual(sd.display, PeerSAS.display(sd.code))
            XCTAssertEqual(sd.display.count, 7)
            XCTAssertEqual(sd.code, sm.code)
            let est = try XCTUnwrap(d.established.first)
            // Mode v adds `vouch/1` itself (rule 1).
            XCTAssertEqual(est.caps, mode == .v ? ["app/1", "ring/1", "vouch/1"] : ["app/1", "ring/1"])
            XCTAssertFalse(est.helloAuthenticated)
            // Nothing flows until the person confirms.
            do {
                try await d.s.sendRecord(type: PeerRecordType.vouchResult, body: Data())
                XCTFail("sent before confirm")
            } catch { XCTAssertEqual(error as? PeerChannelError, .notOpen) }
            await d.s.confirmSas()
            await pump(d, a)
            XCTAssertEqual(a.types, [])
            await a.s.confirmSas()
            await pump(d, a)
            let expect = mode == .p ? [PeerRecordType.confirm] : []
            XCTAssertEqual(a.types, expect)
            XCTAssertEqual(d.types, expect)
            let open = await d.s.isOpen
            let aopen = await a.s.isOpen
            XCTAssertTrue(open && aopen)
            XCTAssertTrue(d.closed.isEmpty)
        }
    }

    func testAHostRecordIsHeldUntilThisSideConfirms() async throws {
        let d = Side(.v, .initiator)
        let a = Side(.v, .responder)
        await d.s.start()
        await pump(d, a)
        await d.s.confirmSas()
        try await d.s.sendRecord(type: PeerRecordType.vouchReq, body: Data("{}".utf8))
        await pump(d, a)
        XCTAssertEqual(a.types, [])
        XCTAssertTrue(a.closed.isEmpty)
        await a.s.confirmSas()
        XCTAssertEqual(a.types, [PeerRecordType.vouchReq])
    }

    func testAtMostSixteenRecordsAreHeld() async throws {
        let d = Side(.v, .initiator)
        let a = Side(.v, .responder)
        await d.s.start()
        await pump(d, a)
        await d.s.confirmSas()
        for _ in 0..<16 { try await d.s.sendRecord(type: PeerRecordType.vouchReq, body: Data("{}".utf8)) }
        await pump(d, a)
        XCTAssertTrue(a.closed.isEmpty)
        try await d.s.sendRecord(type: PeerRecordType.vouchReq, body: Data("{}".utf8))
        await pump(d, a)
        XCTAssertEqual(a.closed, [.closed(.peerBusy, byPeer: false)])
    }

    func testConfirmBeforeACodeCloses() async {
        let d = Side(.v, .initiator)
        await d.s.start()
        await d.s.confirmSas()
        XCTAssertEqual(d.closed, [.closed(.peerNotAllowed, byPeer: false)])
    }

    func testHelloDisplayDataIsUnauthenticatedAndCleaned() async throws {
        let d = Side(.v, .initiator, label: "  Cafe\u{301} \u{202E}TV\u{0}  ")
        let a = Side(.v, .responder)
        await d.s.start()
        await pump(d, a)
        let est = try XCTUnwrap(a.established.first)
        XCTAssertFalse(est.helloAuthenticated)
        XCTAssertEqual(est.hello.label, "Caf\u{E9} TV")
    }

    /// §15.6: held host records are bounded by bytes (16 KiB) as well as by count.
    func testHeldRecordsAreBoundedByBytes() async throws {
        let d = Side(.v, .initiator)
        let a = Side(.v, .responder)
        await d.s.start()
        await pump(d, a)
        await d.s.confirmSas()
        let big = Data(#"{"pad":""#.utf8) + Data(repeating: 0x61, count: 8000) + Data(#""}"#.utf8)
        try await d.s.sendRecord(type: PeerRecordType.vouchReq, body: big)
        await pump(d, a)
        XCTAssertTrue(a.closed.isEmpty, "8 KB is held")
        try await d.s.sendRecord(type: PeerRecordType.vouchReq, body: big)
        await pump(d, a)
        XCTAssertTrue(a.closed.isEmpty, "16 KB in two records is still within the bound")
        let more = Data(#"{"pad":""#.utf8) + Data(repeating: 0x61, count: 400) + Data(#""}"#.utf8)
        try await d.s.sendRecord(type: PeerRecordType.vouchReq, body: more)
        await pump(d, a)
        XCTAssertEqual(a.closed, [.closed(.peerBusy, byPeer: false)], "past 16 KiB held")
        XCTAssertEqual(a.types, [])
    }

    private func helloEstablished(_ mode: PeerNoiseMode, _ hello: String) async throws -> (Side, PeerHello?) {
        let a = Side(mode, .responder)
        let tp = try await rawPeer(mode, to: a)
        try await put(tp, a, PeerRecordType.hello, Data(hello.utf8))
        return (a, a.established.first?.hello)
    }

    /// §15.6: `platform` is shown as sent only in [A-Za-z0-9 ._+-], 1 to 32 characters.
    func testHelloPlatformIsShownOnlyInTheNarrowSet() async throws {
        func platform(_ p: String) async throws -> String? {
            let json = try String(
                decoding: JSONSerialization.data(
                    withJSONObject: ["platform": p, "app": "a", "maxMessage": 1_048_576]), as: UTF8.self)
            return try await helloEstablished(.v, json).1?.platform
        }
        let ok = "Mac OS+X 14.5_a-b"
        for good in [ok, "x", String(repeating: "a", count: 32)] {
            let shown = try await platform(good)
            XCTAssertEqual(shown, good)
        }
        for bad in [
            "", String(repeating: "a", count: 33), "Mac<script>", "Caf\u{E9}", "a\nb", "a\u{202E}b", "a/b", "a%b",
        ] {
            let shown = try await platform(bad)
            XCTAssertEqual(shown, "Unknown", bad)
        }
    }

    /// §15.6: `app` is cleaned like `label` (NFC, controls and bidi stripped, 64 code points).
    func testHelloAppIsCleanedLikeTheLabel() async throws {
        func app(_ p: String) async throws -> String? {
            let json = try String(
                decoding: JSONSerialization.data(
                    withJSONObject: ["platform": "t", "app": p, "maxMessage": 1_048_576]), as: UTF8.self)
            return try await helloEstablished(.p, json).1?.app
        }
        let cleaned = try await app("  Cafe\u{301} \u{202E}Demo\u{0}  ")
        XCTAssertEqual(cleaned, "Caf\u{E9} Demo")
        let none = try await app("\u{202E}\u{0}  ")
        XCTAssertEqual(none, "Unknown")
        let long = try await app(String(repeating: "\u{1F600}", count: 100))
        XCTAssertEqual(long?.unicodeScalars.count, 64)
    }

    /// §15.6: a HELLO in mode v or p is at most 4 KiB.
    func testHelloOverFourKiBIsRefusedInModesVAndP() async throws {
        func hello(padded to: Int) -> String {
            let base = #"{"platform":"t","app":"a","maxMessage":1048576,"x":""#
            return base + String(repeating: "a", count: to - base.utf8.count - 2) + #""}"#
        }
        for mode in [PeerNoiseMode.v, .p] {
            let exact = hello(padded: 4096)
            XCTAssertEqual(exact.utf8.count, 4096)
            let (ok, helloOK) = try await helloEstablished(mode, exact)
            XCTAssertNotNil(helloOK, "4096 bytes is within the bound")
            XCTAssertTrue(ok.closed.isEmpty)
            let (bad, none) = try await helloEstablished(mode, hello(padded: 4097))
            XCTAssertNil(none)
            XCTAssertEqual(bad.closed, [.closed(.peerBadFrame, byPeer: false)])
        }
    }

    func testTheLimiterCountsFiveAMinuteOnAMonotonicClock() {
        let t = Box<TimeInterval>(0)
        let lim = HandshakeLimiter(maxPerMinute: 5, maxPending: 99, mono: { t.value })
        XCTAssertEqual((0..<6).map { _ in lim.begin() != nil }, [true, true, true, true, true, false])
        t.value = 61
        XCTAssertNotNil(lim.begin())
    }

    func testTheLimiterRefusesPastThePendingCapAndReleasesOnConfirm() async {
        let t = Box<TimeInterval>(0)
        let lim = HandshakeLimiter(maxPerMinute: 5, maxPending: 2, mono: { t.value })
        func hello() async -> (Side, Side) {
            let a = Side(.v, .responder, admission: lim)
            let d = Side(.v, .initiator)
            await d.s.start()
            await pump(d, a)
            return (d, a)
        }
        let (d1, a1) = await hello()
        _ = await hello()
        let third = Side(.v, .responder, admission: lim)
        let d3 = Side(.v, .initiator)
        await d3.s.start()
        await pump(d3, third)
        XCTAssertTrue(third.out.value.isEmpty)
        XCTAssertEqual(third.closed, [.closed(.peerBusy, byPeer: false)])
        await d1.s.confirmSas()
        await a1.s.confirmSas()
        XCTAssertNotNil(lim.begin())
    }

    func testAReleaseRunsOnceAndAClosedSessionFreesItsSlot() async {
        let lim = HandshakeLimiter(maxPerMinute: 99, maxPending: 1)
        let a = Side(.v, .responder, admission: lim)
        let d = Side(.v, .initiator)
        await d.s.start()
        await pump(d, a)
        XCTAssertNil(lim.begin())
        await a.s.close()
        let rel = lim.begin()
        XCTAssertNotNil(rel)
        rel?()
        rel?()  // idempotent
        XCTAssertNotNil(lim.begin())
        XCTAssertNil(lim.begin())
    }

    func testTheCodeDeadlineEndsAnUnconfirmedSession() async {
        let d = Side(.v, .initiator)
        let a = Side(.v, .responder)
        await d.s.start()
        await pump(d, a)
        var w = await a.s.wakeIn()
        XCTAssertEqual(w, peerSasDeadlineSeconds)
        a.clock.value = peerSasDeadlineSeconds - 1
        await a.s.tick()
        XCTAssertTrue(a.closed.isEmpty)
        a.clock.value = peerSasDeadlineSeconds
        await a.s.tick()
        XCTAssertEqual(a.closed, [.closed(.peerTimeout, byPeer: false)])
        await pump(d, a)
        XCTAssertEqual(d.closed, [.closed(.peerTimeout, byPeer: true)])
        // Confirming ends the deadline.
        let d2 = Side(.v, .initiator)
        let a2 = Side(.v, .responder)
        await d2.s.start()
        await pump(d2, a2)
        await a2.s.confirmSas()
        w = await a2.s.wakeIn()
        XCTAssertNil(w)
    }

    func testTheTransportDeadlineClosesAStalledHandshake() async {
        let d = Side(.v, .initiator)
        let a = Side(.v, .responder)
        await d.s.start()
        await a.s.receive(d.take()[0])
        a.clock.value = 30
        await a.s.tick()
        XCTAssertEqual(a.closed, [.closed(.peerTimeout, byPeer: false)])
    }

    func testTheFirstRecordMustBeHelloAndTheRefusalIsSaid() async throws {
        let a = Side(.p, .responder)
        let tp = try await rawPeer(.p, to: a)
        try await put(tp, a, PeerRecordType.ping, Data(count: 8))
        XCTAssertEqual(a.closed, [.closed(.peerBadFrame, byPeer: false)])
        let out = a.take()
        _ = try tp.receive.decrypt(ad: Data(), out[0])
        let close = try tp.receive.decrypt(ad: Data(), out[1])
        XCTAssertEqual(String(decoding: close.dropFirst(3), as: UTF8.self), #"{"code":"peer_bad_frame"}"#)
    }

    func testACertificateInAVOrPPayloadIsRefused() async throws {
        let a = Side(.v, .responder)
        let raw = try PeerNoiseHandshake(
            role: .initiator, protocol: peerNoiseProtocol(.v), prologue: peerPrologue(slug: "djdl", mode: .v),
            staticKey: PeerNoiseRawStaticKey(privateKey: Data(repeating: 7, count: 32)))
        await a.s.receive(try await raw.writeMessage(PeerPayload.payload1()))
        _ = try await raw.readMessage(a.take()[0])
        await a.s.receive(try await raw.writeMessage(Data(#"{"v":1,"caps":[],"cert":"x","ring":1}"#.utf8)))
        XCTAssertEqual(a.closed, [.closed(.handshakeFailed, byPeer: false)])
    }

    // MARK: The corpus sas rows

    func testCorpusCommitAndRevealBodiesThroughASession() async throws {
        XCTAssertFalse(m.sas.commits.isEmpty)
        for row in m.sas.commits {
            let a = Side(.v, .responder)
            let tp = try await rawPeer(.v, to: a)
            _ = try tp.receive.decrypt(ad: Data(), a.take()[0])  // the approver's HELLO
            try await put(tp, a, PeerRecordType.hello, helloBody)
            XCTAssertEqual(String(decoding: try PeerSAS.body(.c, unhex(row.c)), as: UTF8.self), row.commitBody)
            try await put(tp, a, PeerRecordType.sasCommit, Data(row.commitBody.utf8))
            let nm = try tp.receive.decrypt(ad: Data(), a.take()[0])
            XCTAssertEqual(Array(nm.prefix(3)), [0x80, 0x15, 0x00])
            try await put(tp, a, PeerRecordType.sasReveal, Data(row.revealBody.utf8))
            XCTAssertEqual(a.sas.count, 1, row.c)
            XCTAssertTrue(a.closed.isEmpty, row.c)
            XCTAssertEqual(PeerSAS.commit(unhex(row.nD)), unhex(row.c))
        }
    }

    func testARevealThatDoesNotMatchTheCommitmentCloses() async throws {
        for (i, row) in m.sas.commits.enumerated() {
            let other = m.sas.commits[(i + 1) % m.sas.commits.count]
            let a = Side(.v, .responder)
            let tp = try await rawPeer(.v, to: a)
            try await put(tp, a, PeerRecordType.hello, helloBody)
            try await put(tp, a, PeerRecordType.sasCommit, Data(row.commitBody.utf8))
            try await put(tp, a, PeerRecordType.sasReveal, Data(other.revealBody.utf8))
            XCTAssertEqual(a.closed, [.closed(.peerBadFrame, byPeer: false)], row.c)
            XCTAssertTrue(a.sas.isEmpty)
        }
    }

    func testPinnedNoncesGiveTheCodeTheCorpusFunctionPins() async throws {
        let nd = unhex(m.sas.commits[0].nD)
        let nm = Data(repeating: 9, count: 32)
        let d = Side(.v, .initiator, nonce: nd)
        let a = Side(.v, .responder, nonce: nm)
        await d.s.start()
        await pump(d, a)
        let got = try XCTUnwrap(d.sas.first)
        XCTAssertEqual(got.code, try XCTUnwrap(a.sas.first).code)
        for r in m.sas.codes {
            let c = PeerSAS.value(
                handshakeHash: unhex(r.h), nD: unhex(r.nD), nM: unhex(r.nM), mode: PeerNoiseMode(rawValue: r.mode)!)
            XCTAssertEqual(PeerSAS.display(c), r.display)
        }
    }

    func testOutOfOrderSasRecordsClose() async throws {
        let cases: [[(Int, PeerSasMember)]] = [
            [(PeerRecordType.sasNonce, .nM)],
            [(PeerRecordType.sasReveal, .nD)],
            [(PeerRecordType.sasCommit, .c), (PeerRecordType.sasCommit, .c)],
        ]
        for records in cases {
            let a = Side(.v, .responder)
            let tp = try await rawPeer(.v, to: a)
            try await put(tp, a, PeerRecordType.hello, helloBody)
            for (t, member) in records { try await put(tp, a, t, try PeerSAS.body(member, Data(count: 32))) }
            XCTAssertEqual(a.closed, [.closed(.peerBadFrame, byPeer: false)])
        }
    }

    func testNoHostRecordIsDeliveredBeforeTheCodeIsConfirmed() async {
        let d = Side(.p, .initiator)
        let a = Side(.p, .responder)
        await d.s.start()
        await pump(d, a)
        XCTAssertTrue(d.types.isEmpty && a.types.isEmpty)
    }

    // MARK: Mode v hooks for the vouch (CC-15.S1)

    func testModeVListsVouchItselfAndExposesTheOrderGuard() async throws {
        let v = Side(.v, .initiator)
        let p = Side(.p, .initiator)
        XCTAssertEqual(v.s.vouch?.role, .requester)
        XCTAssertEqual(Side(.v, .responder).s.vouch?.role, .approver)
        XCTAssertNil(p.s.vouch)
    }

    func testHandshakeHashIsTheSameOnBothEndsOnceEstablished() async throws {
        let d = Side(.v, .initiator)
        let a = Side(.v, .responder)
        do {
            _ = try await d.s.handshakeHash()
            XCTFail("before established")
        } catch { XCTAssertEqual(error as? PeerChannelError, .notEstablished) }
        await d.s.start()
        await pump(d, a)
        let h = try await d.s.handshakeHash()
        XCTAssertEqual(h.count, 32)
        let ah = try await a.s.handshakeHash()
        XCTAssertEqual(h, ah)
    }

    func testHoldSasStopsAfterHelloAndStartSasSendsTheCommit() async throws {
        let d = Side(.v, .initiator, holdSas: true)
        let a = Side(.v, .responder)
        await d.s.start()
        await pump(d, a)
        XCTAssertEqual(d.established.count, 1)
        XCTAssertEqual(a.established.count, 1)
        XCTAssertTrue(d.sas.isEmpty && a.sas.isEmpty)
        XCTAssertTrue(d.closed.isEmpty && a.closed.isEmpty)
        await d.s.startSas()
        await pump(d, a)
        XCTAssertEqual(try XCTUnwrap(d.sas.first).code, try XCTUnwrap(a.sas.first).code)
        // A second start is refused and closes the session.
        await d.s.startSas()
        XCTAssertEqual(d.closed, [.closed(.peerNotAllowed, byPeer: false)])
    }

    func testChoosingOneOfTwoHeldApproversStartsTheSasOnThatSessionOnly() async throws {
        let d1 = Side(.v, .initiator, holdSas: true)
        let m1 = Side(.v, .responder)
        let d2 = Side(.v, .initiator, holdSas: true)
        let m2 = Side(.v, .responder)
        await d1.s.start()
        await d2.s.start()
        await pump(d1, m1)
        await pump(d2, m2)
        await d1.s.startSas()
        await pump(d1, m1)
        await d2.s.close(.peerBye)
        await pump(d2, m2)
        XCTAssertEqual(m1.sas.count, 1)
        XCTAssertEqual(m2.sas.count, 0)
        XCTAssertEqual(m2.closed, [.closed(.peerBye, byPeer: true)])
    }

    func testStartSasIsRefusedEarlyWithoutHoldAndOutsideModeVInitiator() async throws {
        let early = Side(.v, .initiator, holdSas: true)
        await early.s.start()
        await early.s.startSas()
        XCTAssertEqual(early.closed, [.closed(.peerNotAllowed, byPeer: false)])
        let plain = Side(.v, .initiator)
        let a = Side(.v, .responder)
        await plain.s.start()
        await pump(plain, a)
        await plain.s.startSas()
        XCTAssertEqual(plain.closed, [.closed(.peerNotAllowed, byPeer: false)])
        for (mode, role) in [(PeerNoiseMode.p, PeerChannel.Role.initiator), (.v, .responder)] {
            XCTAssertThrowsError(
                try PeerChannel(
                    role: role, slug: "djdl", staticKey: PeerNoiseRawStaticKey(privateKey: rnd()),
                    admission: role == .responder ? HandshakeLimiter() : nil, hello: (nil, "t", "a", nil),
                    send: { _ in }, onEvent: { _ in }, mode: mode, holdSas: true)
            ) { XCTAssertEqual($0 as? PeerChannelError, .mode) }
        }
    }

    func testAPeerWithoutVouch1IsClosedPeerNotAllowedBeforeAnySasRecord() async throws {
        let a = Side(.v, .responder)
        let tp = try await rawPeer(.v, to: a, payload3: #"{"v":1,"caps":["app/1"]}"#)
        try await put(tp, a, PeerRecordType.hello, helloBody)
        XCTAssertTrue(a.established.isEmpty)
        XCTAssertEqual(a.closed, [.closed(.peerNotAllowed, byPeer: false)])
        // Its own HELLO, then CLOSE: no SAS record.
        let types = try a.take().map { out -> Int in
            let rec = try tp.receive.decrypt(ad: Data(), out)
            return Int(rec[rec.startIndex]) << 8 | Int(rec[rec.startIndex + 1])
        }
        XCTAssertEqual(types, [PeerRecordType.hello, PeerRecordType.close])
    }

    /// M's 120 s code deadline restarts once when `SAS_COMMIT` arrives (§15.6, mode v): a session held while
    /// D's person looked at the list keeps its whole 120 s after the choice.
    func testTheApproversCodeDeadlineRestartsOnceAtSasCommit() async throws {
        let d = Side(.v, .initiator, holdSas: true)
        let a = Side(.v, .responder)
        await d.s.start()
        await pump(d, a)
        a.clock.value = 100
        d.clock.value = 100
        await a.s.tick()
        XCTAssertTrue(a.closed.isEmpty)
        await d.s.startSas()
        await pump(d, a)
        // M's deadline is now 100 + 120 and D's too; neither fires at the original 120.
        a.clock.value = 119
        d.clock.value = 119
        await a.s.tick()
        await d.s.tick()
        XCTAssertTrue(a.closed.isEmpty && d.closed.isEmpty)
        let wa = await a.s.wakeIn()
        let wd = await d.s.wakeIn()
        XCTAssertEqual(wa, 101)
        XCTAssertEqual(wd, 101)
        a.clock.value = 220
        await a.s.tick()
        XCTAssertEqual(a.closed, [.closed(.peerTimeout, byPeer: false)])
    }

    /// The restart is once: a second `SAS_COMMIT` is out of order and closes, it never moves the deadline.
    func testASecondSasCommitClosesAndDoesNotMoveTheDeadline() async throws {
        let a = Side(.v, .responder)
        let tp = try await rawPeer(.v, to: a)
        try await put(tp, a, PeerRecordType.hello, helloBody)
        let c = try PeerSAS.body(.c, PeerSAS.commit(Data(repeating: 1, count: 32)))
        a.clock.value = 50
        try await put(tp, a, PeerRecordType.sasCommit, c)
        let w = await a.s.wakeIn()
        XCTAssertEqual(w, 120)
        a.clock.value = 60
        try await put(tp, a, PeerRecordType.sasCommit, c)
        XCTAssertEqual(a.closed, [.closed(.peerBadFrame, byPeer: false)])
    }
}
