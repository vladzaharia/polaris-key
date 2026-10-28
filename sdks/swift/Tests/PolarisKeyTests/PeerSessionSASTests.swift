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
        nonce: Data? = nil
    ) {
        let clock = self.clock
        let events = self.events
        let out = self.out
        let lim = admission ?? (role == .responder ? HandshakeLimiter() : nil)
        s = try! PeerChannel(
            role: role, slug: "djdl", staticKey: try! PeerNoiseRawStaticKey(privateKey: rnd()), admission: lim,
            caps: ["app/1", "ring/1"], hello: (label, "test", "demo", nil),
            send: { d in out.mutate { $0.append(d) } }, onEvent: { e in events.mutate { $0.append(e) } },
            mode: mode, random: nonce.map { n in { @Sendable len in len == 32 ? n : rnd() } },
            mono: { clock.value })
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
private func rawPeer(_ mode: PeerNoiseMode, to m: Side, payload3: String = #"{"v":1,"caps":[]}"#) async throws
    -> PeerNoiseTransport
{
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
            XCTAssertEqual(est.caps, ["app/1", "ring/1"])
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
}
