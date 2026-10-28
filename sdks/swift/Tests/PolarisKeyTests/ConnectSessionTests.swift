// @pkey-feature connect.app
// CC-11.10: the host side of a Cloud Connect session: `PeerLink` over a byte pipe, `ConnectSession`
// (queue bounds, the shared budget, APP routing) and `ConnectPeerDocs` (pushed RING and TRUST).
// Mirrors the Python port's `test_connect_session.py` and sdk-node's `connect.test.ts`. The pipes are
// in memory; no socket is opened.

import CryptoKit
import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey

private let sub = "ps_AAAAAAAAAAAAAAAAAAAAAA"
private let idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
private let idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
private let signer = TestSigner(kid: "peer-test-2026")
private func nowSeconds() -> Int { Int(Date().timeIntervalSince1970) }
private func rnd() -> Data { Curve25519.KeyAgreement.PrivateKey().rawRepresentation }

// MARK: In-memory pipes

private final class MemPipe: PeerBytePipe, @unchecked Sendable {
    private let incoming: AsyncStream<Data>
    private let incomingCont: AsyncStream<Data>.Continuation
    private let outgoing: AsyncStream<Data>.Continuation
    private let iterator = LockedValue<AsyncStream<Data>.Iterator?>(nil)
    let remoteAddress = "10.0.0.2"
    private(set) var written = LockedValue<[Data]>([])

    init(incoming: AsyncStream<Data>, incomingCont: AsyncStream<Data>.Continuation, outgoing: AsyncStream<Data>.Continuation) {
        self.incoming = incoming
        self.incomingCont = incomingCont
        self.outgoing = outgoing
        iterator.set(incoming.makeAsyncIterator())
    }

    static func pair() -> (MemPipe, MemPipe) {
        let (s1, c1) = AsyncStream<Data>.makeStream()
        let (s2, c2) = AsyncStream<Data>.makeStream()
        return (
            MemPipe(incoming: s1, incomingCont: c1, outgoing: c2), MemPipe(incoming: s2, incomingCont: c2, outgoing: c1)
        )
    }

    func read() async throws -> Data? {
        var it = iterator.with { i -> AsyncStream<Data>.Iterator? in
            let r = i
            i = nil
            return r
        }
        guard it != nil else { return nil }
        let d = await it!.next()
        iterator.set(it)
        return d
    }

    func write(_ bytes: Data) async throws {
        written.with { $0.append(bytes) }
        outgoing.yield(bytes)
    }

    func close() async {
        outgoing.finish()
        incomingCont.finish()
    }
}

// MARK: Devices

private struct Dev {
    let id: String
    let priv = Curve25519.KeyAgreement.PrivateKey()
    let signKey: String
    var exp = nowSeconds() + 1000

    init(_ id: String, signByte: UInt8, exp: Int? = nil) {
        self.id = id
        signKey = Base64URL.encode(Data(repeating: signByte, count: 32))
        if let exp { self.exp = exp }
    }

    var cert: String {
        let agree = Base64URL.encode(priv.publicKey.rawRepresentation)
        return signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","deviceId":"\#(id)","signKey":"\#(signKey)","agreeKey":"\#(agree)","ringEpoch":1,"issuedAt":\#(nowSeconds() - 10),"expiresAt":\#(exp)}"#,
            typ: "pkey-peer+jws")
    }
}

private func options(_ role: PeerChannel.Role, _ d: Dev, _ keys: [Data?], rekey: Int = 1 << 20) -> PeerChannelOptions {
    PeerChannelOptions(
        role: role, slug: "djdl", staticKey: try! PeerNoiseRawStaticKey(privateKey: d.priv.rawRepresentation),
        account: PeerAccountContext(
            trust: signer.trust, expectedAud: "djdl", certJws: d.cert, ownSub: sub, ownDeviceId: d.id,
            heldRing: { nil }, discKeys: keys),
        caps: ["app/1"], hello: (nil, "test", "djdl", nil), rekeyMessages: rekey)
}

private struct Open {
    let a: ConnectSession
    let b: ConnectSession
    let la: PeerLink
    let lb: PeerLink
    let pa: MemPipe
    let pb: MemPipe
}

private func openPair(
    keysA: [Data?]? = nil, keysB: [Data?]? = nil, budget: ConnectQueueBudget? = nil, handshakeSeconds: TimeInterval = 30
) async throws -> Open {
    let (pa, pb) = MemPipe.pair()
    let k = rnd()
    let A = Dev(idA, signByte: 1), B = Dev(idB, signByte: 2)
    let ha = ConnectSessionHandlers(role: "initiator", budget: budget)
    let hb = ConnectSessionHandlers(role: "responder", budget: budget)
    let la = try await PeerLink.make(
        pipe: pa, options: options(.initiator, A, keysA ?? [k]), handlers: ha.handlers, handshakeSeconds: handshakeSeconds)
    let lb = try await PeerLink.make(
        pipe: pb, options: options(.responder, B, keysB ?? [k]), handlers: hb.handlers, handshakeSeconds: handshakeSeconds)
    ha.attach(la)
    hb.attach(lb)
    Task { await la.run() }
    Task { await lb.run() }
    await la.start()
    async let sa = ha.opened(la)
    async let sb = hb.opened(lb)
    return try await Open(a: sa, b: sb, la: la, lb: lb, pa: pa, pb: pb)
}

private final class Fake: ConnectSessionLink, @unchecked Sendable {
    let log = LockedValue<[String]>([])
    func sendRecord(type: Int, body: Data) async throws { log.with { $0.append("send") } }
    func close(_ code: PeerCloseCode) async { log.with { $0.append("close:" + code.rawValue) } }
    func closeSoon(_ code: PeerCloseCode) { log.with { $0.append("close:" + code.rawValue) } }
    func pause(_ on: Bool) { log.with { $0.append(on ? "pause" : "resume") } }
}

private func fakeSession(_ link: Fake, budget: ConnectQueueBudget? = nil) -> ConnectSession {
    ConnectSession(
        link: link, peerDeviceId: idB, caps: [], hello: PeerHello(label: nil, platform: "t", app: "a", maxMessage: 1 << 20),
        role: "initiator", remoteAddress: "10.0.0.2", budget: budget)
}

private func eventually(_ what: String = "", _ cond: @escaping () -> Bool) async {
    for _ in 0..<200 where !cond() { try? await Task.sleep(nanoseconds: 10_000_000) }
    XCTAssertTrue(cond(), what)
}

/// A pipe that stops taking writes once told to: the peer that never reads (S5).
private final class StallPipe: PeerBytePipe, @unchecked Sendable {
    let inner: MemPipe
    let stalled = LockedValue(false)
    private let gate = LockedValue<[CheckedContinuation<Void, Never>]>([])
    let closeCalls = LockedValue(0)
    init(_ inner: MemPipe) { self.inner = inner }
    var remoteAddress: String { inner.remoteAddress }
    func read() async throws -> Data? { try await inner.read() }
    func write(_ bytes: Data) async throws {
        if stalled.current {
            await withCheckedContinuation { c in gate.with { $0.append(c) } }
            throw CancellationError()
        }
        try await inner.write(bytes)
    }
    func close() async {
        closeCalls.with { $0 += 1 }
        await inner.close()
        let w = gate.with { g -> [CheckedContinuation<Void, Never>] in let x = g; g = []; return x }
        for c in w { c.resume() }
    }
}

final class ConnectSessionTests: XCTestCase {
    func testAPeerThatNeverReadsIsClosedWithPeerBusyAtTheWriteCap() async throws {
        let (pa, pb) = MemPipe.pair()
        let stall = StallPipe(pa)
        let k = rnd()
        let A = Dev(idA, signByte: 1), B = Dev(idB, signByte: 2)
        let ha = ConnectSessionHandlers(role: "initiator")
        let hb = ConnectSessionHandlers(role: "responder")
        let la = try await PeerLink.make(pipe: stall, options: options(.initiator, A, [k]), handlers: ha.handlers)
        let lb = try await PeerLink.make(pipe: pb, options: options(.responder, B, [k]), handlers: hb.handlers)
        ha.attach(la)
        hb.attach(lb)
        Task { await la.run() }
        Task { await lb.run() }
        await la.start()
        async let sa = ha.opened(la)
        async let sb = hb.opened(lb)
        let (a, _) = try await (sa, sb)
        stall.stalled.set(true)
        let chunk = Data(repeating: 1, count: 60_000)
        for _ in 0..<200 {
            if a.closed != nil { break }
            try? await a.send(chunk)
        }
        for _ in 0..<200 where a.closed == nil { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(a.closed?.code, "peer_busy")
        for _ in 0..<100 where stall.closeCalls.current == 0 { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertGreaterThan(stall.closeCalls.current, 0, "a stuck writer's pipe is closed at once on peer_busy")
    }

    /// N11: a link that ends for another reason closes a pipe whose writer is stuck after a short grace.
    func testALinkThatEndsClosesAPipeWhoseWriterIsStuck() async throws {
        let (pa, pb) = MemPipe.pair()
        let stall = StallPipe(pa)
        let k = rnd()
        let A = Dev(idA, signByte: 1), B = Dev(idB, signByte: 2)
        let ha = ConnectSessionHandlers(role: "initiator")
        let hb = ConnectSessionHandlers(role: "responder")
        let la = try await PeerLink.make(
            pipe: stall, options: options(.initiator, A, [k]), handlers: ha.handlers, pipeGraceSeconds: 0.2)
        let lb = try await PeerLink.make(pipe: pb, options: options(.responder, B, [k]), handlers: hb.handlers)
        ha.attach(la)
        hb.attach(lb)
        Task { await la.run() }
        Task { await lb.run() }
        await la.start()
        async let sa = ha.opened(la)
        async let sb = hb.opened(lb)
        let (a, _) = try await (sa, sb)
        stall.stalled.set(true)
        await a.close()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(stall.closeCalls.current, 0, "the grace has not run out")
        for _ in 0..<100 where stall.closeCalls.current == 0 { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertGreaterThan(stall.closeCalls.current, 0)
    }

    // MARK: Two devices

    func testTwoDevicesOpenASessionExchangeMessagesAndClose() async throws {
        let o = try await openPair()
        XCTAssertEqual(o.a.peerDeviceId, idB)
        XCTAssertEqual(o.b.peerDeviceId, idA)
        XCTAssertEqual(o.a.caps, ["app/1"])
        XCTAssertEqual(o.a.remoteAddress, "10.0.0.2")
        try await o.a.send(Data("hello".utf8))
        let m = try await o.b.receive()
        XCTAssertEqual(m, ConnectMessage(type: 0x0100, body: Data("hello".utf8)))
        try await o.b.send(Data("back".utf8), type: 0x0200)
        let r = try await o.a.receive()
        XCTAssertEqual(r.type, 0x0200)
        let closedB = LockedValue<ConnectSessionClosed?>(nil)
        o.b.onClose { closedB.set($0) }
        await o.a.close()
        await eventually("b closed") { closedB.current != nil }
        XCTAssertEqual(closedB.current, ConnectSessionClosed(code: "peer_bye", byPeer: true))
        await eventually("a closed") { o.a.closed != nil }
        XCTAssertEqual(o.a.closed, ConnectSessionClosed(code: "peer_bye", byPeer: false))
    }

    func testALargeMessageIsSplitAndReassembled() async throws {
        let o = try await openPair()
        let big = Data((0..<300_000).map { UInt8($0 % 251) })
        try await o.a.send(big)
        let m = try await o.b.receive()
        XCTAssertEqual(m.body, big)
    }

    func testSendRefusesABadTypeAndAMessageOverThePeersLimit() async throws {
        let o = try await openPair()
        for t in [0x00FF, 0x8000, -1] {
            do {
                try await o.a.send(Data(), type: t)
                XCTFail("sent type \(t)")
            } catch let e as ConnectLanError { XCTAssertEqual(e.reason, .badType) }
        }
        do {
            try await o.a.send(Data(count: peerMaxMessageBytes + 1))
            XCTFail("sent too much")
        } catch let e as ConnectLanError { XCTAssertEqual(e.reason, .tooLarge) }
    }

    func testAWrongDiscoveryKeyIsNotAdmittedAndTheResponderStaysSilent() async throws {
        let (pa, pb) = MemPipe.pair()
        let ha = ConnectSessionHandlers(role: "initiator"), hb = ConnectSessionHandlers(role: "responder")
        let la = try await PeerLink.make(
            pipe: pa, options: options(.initiator, Dev(idA, signByte: 1), [rnd()]), handlers: ha.handlers)
        let lb = try await PeerLink.make(
            pipe: pb, options: options(.responder, Dev(idB, signByte: 2), [rnd()]), handlers: hb.handlers)
        ha.attach(la)
        hb.attach(lb)
        Task { await la.run() }
        Task { await lb.run() }
        await la.start()
        do {
            _ = try await hb.opened(lb)
            XCTFail("admitted")
        } catch let e as ConnectLanError {
            XCTAssertEqual(e.reason, .handshakeFailed)
            XCTAssertEqual(e.closeCode, "handshake_failed")
        }
        XCTAssertTrue(pb.written.current.isEmpty, "a failed tag is never answered")
        do {
            _ = try await ha.opened(la)
            XCTFail("admitted")
        } catch let e as ConnectLanError { XCTAssertEqual(e.closeCode, "connection_lost") }
    }

    func testThePreviousKeyStillAdmits() async throws {
        let old = rnd()
        let o = try await openPair(keysA: [old], keysB: [rnd(), old])
        XCTAssertEqual(o.b.peerDeviceId, idA)
    }

    func testASocketThatNeverFinishesTheHandshakeIsClosed() async throws {
        let (pa, pb) = MemPipe.pair()
        let h = ConnectSessionHandlers(role: "responder")
        let l = try await PeerLink.make(
            pipe: pb, options: options(.responder, Dev(idB, signByte: 2), [rnd()]), handlers: h.handlers, handshakeSeconds: 0.2)
        h.attach(l)
        Task { await l.run() }
        do {
            _ = try await h.opened(l)
            XCTFail("admitted")
        } catch let e as ConnectLanError { XCTAssertEqual(e.closeCode, "handshake_failed") }
        _ = pa
    }

    func testAnOversizeFrameBeforeTheHandshakeClosesTheSocket() async throws {
        let (pa, pb) = MemPipe.pair()
        let h = ConnectSessionHandlers(role: "responder")
        let l = try await PeerLink.make(
            pipe: pb, options: options(.responder, Dev(idB, signByte: 2), [rnd()]), handlers: h.handlers)
        h.attach(l)
        Task { await l.run() }
        try await pa.write(try PeerFrame.encode(Data(count: PeerLink.handshakeFrameMax + 1)))
        do {
            _ = try await h.opened(l)
            XCTFail("admitted")
        } catch let e as ConnectLanError { XCTAssertEqual(e.closeCode, "handshake_failed") }
        let r = try await pa.read()
        XCTAssertNil(r, "the link closed its end")
    }

    func testAZeroLengthFrameClosesTheSocket() async throws {
        let (pa, pb) = MemPipe.pair()
        let h = ConnectSessionHandlers(role: "responder")
        let l = try await PeerLink.make(
            pipe: pb, options: options(.responder, Dev(idB, signByte: 2), [rnd()]), handlers: h.handlers)
        h.attach(l)
        Task { await l.run() }
        try await pa.write(Data([0, 0]))
        do {
            _ = try await h.opened(l)
            XCTFail("admitted")
        } catch let e as ConnectLanError { XCTAssertEqual(e.closeCode, "peer_bad_frame") }
    }

    func testALostConnectionEndsTheSessionWithConnectionLost() async throws {
        let o = try await openPair()
        await o.pb.close()
        await eventually("a closed") { o.a.closed != nil }
        XCTAssertEqual(o.a.closed?.code, "connection_lost")
    }

    func testAnInboundAppCriticalRecordClosesTheSessionUnknownCritical() async throws {
        let o = try await openPair()
        try await o.a.sendRecord(type: 0x8100, body: Data("x".utf8))
        await eventually("b closed") { o.b.closed != nil }
        XCTAssertEqual(o.b.closed, ConnectSessionClosed(code: "peer_unknown_critical", byPeer: false))
        await eventually("a closed") { o.a.closed != nil }
        XCTAssertEqual(o.a.closed, ConnectSessionClosed(code: "peer_unknown_critical", byPeer: true))
    }

    func testANonAppRecordIsIgnoredNotDelivered() async throws {
        let o = try await openPair()
        try await o.a.sendRecord(type: PeerRecordType.candidates, body: Data("{}".utf8))
        try await o.a.send(Data("after".utf8))
        let m = try await o.b.receive()
        XCTAssertEqual(m.body, Data("after".utf8))
        XCTAssertNil(o.b.closed)
    }

    // MARK: Routing and the queue

    func testRoutingDeliversOnlyTheAppRange() async throws {
        let link = Fake()
        let s = fakeSession(link)
        routeConnectRecord(link: link, session: s, type: 0x00FF, body: Data([1]))
        routeConnectRecord(link: link, session: s, type: 0x0100, body: Data([2]))
        routeConnectRecord(link: link, session: s, type: 0x7FFF, body: Data([3]))
        routeConnectRecord(link: link, session: s, type: 0x8000, body: Data([4]))
        XCTAssertTrue(link.log.current.isEmpty)
        routeConnectRecord(link: link, session: s, type: 0x8100, body: Data([5]))
        XCTAssertEqual(link.log.current, ["close:peer_unknown_critical"])
        let a = try await s.receive(), b = try await s.receive()
        XCTAssertEqual([a.body, b.body], [Data([2]), Data([3])])
    }

    func testTheQueueClosesBusyAt256Messages() {
        let link = Fake()
        let s = fakeSession(link, budget: ConnectQueueBudget())
        for _ in 0..<connectMaxQueuedMessages { s.deliver(ConnectMessage(type: 0x0100, body: Data([1]))) }
        XCTAssertTrue(link.log.current.isEmpty)
        s.deliver(ConnectMessage(type: 0x0100, body: Data([1])))
        XCTAssertEqual(link.log.current, ["close:peer_busy"])
    }

    func testTheQueuePausesAt4MiBResumesUnder1MiBAndClosesBusyAt8MiB() async throws {
        let link = Fake()
        let budget = ConnectQueueBudget()
        let s = fakeSession(link, budget: budget)
        let mib = Data(count: 1024 * 1024)
        for _ in 0..<4 { s.deliver(ConnectMessage(type: 0x0100, body: mib)) }
        XCTAssertTrue(link.log.current.isEmpty, "exactly 4 MiB is not over")
        s.deliver(ConnectMessage(type: 0x0100, body: Data([1])))
        XCTAssertEqual(link.log.current, ["pause"])
        for _ in 0..<3 { s.deliver(ConnectMessage(type: 0x0100, body: mib)) }
        XCTAssertEqual(link.log.current, ["pause"])
        s.deliver(ConnectMessage(type: 0x0100, body: mib))
        XCTAssertEqual(link.log.current, ["pause", "close:peer_busy"])
        for _ in 0..<8 { _ = try await s.receive() }
        XCTAssertEqual(link.log.current, ["pause", "close:peer_busy", "resume"])
        XCTAssertEqual(budget.used, 0, "reading returns the bytes")
        s.deliver(ConnectMessage(type: 0x0100, body: mib))
        XCTAssertEqual(budget.used, mib.count)
        s.ended(ConnectSessionClosed(code: "peer_bye", byPeer: true))
        XCTAssertEqual(budget.used, 0, "an ended session returns its bytes")
    }

    func testAllSessionsShareAByteBudget() {
        let budget = ConnectQueueBudget(limit: 3)
        let l1 = Fake(), l2 = Fake()
        let s1 = fakeSession(l1, budget: budget), s2 = fakeSession(l2, budget: budget)
        s1.deliver(ConnectMessage(type: 0x0100, body: Data(count: 2)))
        s2.deliver(ConnectMessage(type: 0x0100, body: Data(count: 1)))
        XCTAssertTrue(l1.log.current.isEmpty && l2.log.current.isEmpty)
        s2.deliver(ConnectMessage(type: 0x0100, body: Data(count: 1)))
        XCTAssertEqual(l2.log.current, ["close:peer_busy"])
        XCTAssertEqual(budget.used, 3)
    }

    func testASubscriberGetsMessagesInsteadOfTheQueue() async throws {
        let link = Fake()
        let s = fakeSession(link, budget: ConnectQueueBudget())
        let got = LockedValue<[Data]>([])
        let off = s.onMessage { m in got.with { $0.append(m.body) } }
        s.deliver(ConnectMessage(type: 0x0100, body: Data([1])))
        XCTAssertEqual(got.current, [Data([1])])
        off()
        s.deliver(ConnectMessage(type: 0x0100, body: Data([2])))
        let m = try await s.receive()
        XCTAssertEqual(m.body, Data([2]))
    }

    func testAClosedSessionWakesABlockedReceiveAndLateSubscribersAreTold() async throws {
        let link = Fake()
        let s = fakeSession(link, budget: ConnectQueueBudget())
        let t = Task { try await s.receive() }
        try await Task.sleep(nanoseconds: 50_000_000)
        s.ended(ConnectSessionClosed(code: "peer_bye", byPeer: true))
        do {
            _ = try await t.value
            XCTFail("received")
        } catch let e as ConnectLanError { XCTAssertEqual(e.reason, .closed) }
        let late = LockedValue<ConnectSessionClosed?>(nil)
        s.onClose { late.set($0) }
        XCTAssertEqual(late.current, ConnectSessionClosed(code: "peer_bye", byPeer: true))
        do {
            try await s.send(Data())
            XCTFail("sent")
        } catch let e as ConnectLanError { XCTAssertEqual(e.reason, .closed) }
    }

    func testAReceiveCanBeCancelled() async throws {
        let s = fakeSession(Fake(), budget: ConnectQueueBudget())
        let t = Task { try await s.receive() }
        try await Task.sleep(nanoseconds: 50_000_000)
        t.cancel()
        do {
            _ = try await t.value
            XCTFail("received")
        } catch { XCTAssertTrue(error is CancellationError) }
    }

    func testASessionNamesNoKey() async throws {
        let o = try await openPair()
        let text = "\(o.a) \(String(reflecting: o.a)) \(o.la) \(o.a.hello)"
        var dump = ""
        Swift.dump(o.a, to: &dump)
        XCTAssertTrue(text.contains(idB))
        XCTAssertFalse((text + dump).contains("pkey-peer"))
    }

    // MARK: Pushed documents

    private final class Calls: @unchecked Sendable {
        let notices = LockedValue<[ConnectNotice]>([])
        let refreshes = LockedValue(0)
        let failRefresh = LockedValue(false)
        let now = LockedValue(1_000)
        let timers = LockedValue<[(TimeInterval, @Sendable () -> Void)]>([])
        let adopted = LockedValue<[String]>([])
    }

    private func docs(_ c: Calls, adopt: Bool = true, trust: Bool = true, refresh: Bool = true) -> ConnectPeerDocs {
        let refreshFn: @Sendable () async throws -> Void = {
            c.refreshes.with { $0 += 1 }
            if c.failRefresh.current { throw ConnectLanError(.closed, "no") }
        }
        let adoptFn: @Sendable (String) async -> RingAdoption = { jws in
            c.adopted.with { $0.append(jws) }
            return jws == "bad"
                ? RingAdoption(stored: false, epoch: nil, reason: "epoch_not_higher")
                : RingAdoption(stored: true, epoch: 4, reason: nil)
        }
        let trustFn: @Sendable (String) async -> PeerTrustResult = { jws in
            jws == "bad" ? PeerTrustResult(applied: false, reason: "invalid") : PeerTrustResult(applied: true, reason: nil)
        }
        let src = ConnectPeerDocsSource(
            now: { c.now.current }, refresh: refresh ? refreshFn : nil, adoptRing: adopt ? adoptFn : nil,
            applyTrust: trust ? trustFn : nil)
        let d = ConnectPeerDocs(source: src, timer: { s, fn in
            c.timers.with { $0.append((s, fn)) }
            return {}
        })
        d.onNotice { n in c.notices.with { $0.append(n) } }
        return d
    }

    func testAStoredRosterIsReportedAndARefreshFollows() async {
        let c = Calls()
        let d = docs(c)
        d.onRing("good", 4)
        await d.drain()
        XCTAssertEqual(c.notices.current, [ConnectNotice(type: "ring", outcome: "stored", epoch: 4)])
        XCTAssertEqual(c.refreshes.current, 1)
        XCTAssertEqual(d.pushed?.epoch, 4)
    }

    func testARefusedRosterAndTrustAreReportedWithTheReason() async {
        let c = Calls()
        let d = docs(c)
        d.ring("bad")
        d.trust("bad")
        d.trust("good")
        await d.drain()
        XCTAssertEqual(
            c.notices.current,
            [
                ConnectNotice(type: "ring", outcome: "refused", reason: "epoch_not_higher"),
                ConnectNotice(type: "trust", outcome: "refused", reason: "invalid"),
                ConnectNotice(type: "trust", outcome: "applied"),
            ])
        XCTAssertEqual(c.refreshes.current, 0)
    }

    func testWithoutASourceMemberTheDocumentIsRefusedUnsupported() async {
        let c = Calls()
        let d = docs(c, adopt: false, trust: false)
        d.ring("x")
        d.trust("y")
        await d.drain()
        XCTAssertEqual(
            c.notices.current,
            [
                ConnectNotice(type: "ring", outcome: "refused", reason: "unsupported"),
                ConnectNotice(type: "trust", outcome: "refused", reason: "unsupported"),
            ])
    }

    func testAtMostEightDocumentsWaitOneSlotIsKeptForRingAndBusyIsReportedOncePerSecond() async {
        let gate = LockedValue(false)
        let trustFn: @Sendable (String) async -> PeerTrustResult = { _ in
            while !gate.current { try? await Task.sleep(nanoseconds: 5_000_000) }
            return PeerTrustResult(applied: true, reason: nil)
        }
        let ringFn: @Sendable (String) async -> RingAdoption = { _ in RingAdoption(stored: true, epoch: 2, reason: nil) }
        let notices = LockedValue<[ConnectNotice]>([])
        let d = ConnectPeerDocs(source: ConnectPeerDocsSource(now: { 0 }, adoptRing: ringFn, applyTrust: trustFn))
        d.onNotice { n in notices.with { $0.append(n) } }
        for i in 0..<10 { d.trust("doc\(i)") }
        d.trust("doc1")
        // 7 TRUST wait; the 8th slot is RING's. The three refused (two over, one duplicate) are one notice.
        XCTAssertEqual(notices.current.filter { $0.reason == "busy" }.count, 1, "busy is reported once a second")
        d.ring("roster")  // takes the reserved slot
        XCTAssertEqual(notices.current.filter { $0.reason == "busy" }.count, 1)
        gate.set(true)
        await d.drain()
        XCTAssertEqual(notices.current.filter { $0.type == "trust" && $0.outcome == "applied" }.count, connectMaxDocsQueued - 1)
        XCTAssertEqual(notices.current.filter { $0.type == "ring" && $0.outcome == "stored" }.count, 1)
        d.trust("doc9")  // the slots are free again
        await d.drain()
        XCTAssertEqual(notices.current.filter { $0.type == "trust" && $0.outcome == "applied" }.count, connectMaxDocsQueued)
    }

    func testCloseStopsQueuedJobsAndLateRefreshes() async {
        let c = Calls()
        let d = docs(c)
        let before = c.refreshes.current
        d.close()
        d.wantRing()
        d.ring("late")
        d.trust("late")
        await d.drain()
        XCTAssertEqual(c.refreshes.current, before, "no refresh after close")
        XCTAssertEqual(c.notices.current, [], "no document is worked on after close")
    }

    func testARefreshRunsAtMostOnceAMinuteAndAFailureRetries() async {
        let c = Calls()
        let d = docs(c)
        d.wantRing()
        await d.drain()
        XCTAssertEqual(c.refreshes.current, 1)
        c.now.set(1_030)
        d.wantRing()
        await d.drain()
        XCTAssertEqual(c.refreshes.current, 1, "inside the minute")
        c.now.set(1_061)
        c.failRefresh.set(true)
        d.onRing("good", 5)  // stored, then a refresh that fails and arms a retry
        await d.drain()
        XCTAssertEqual(c.refreshes.current, 2)
        XCTAssertEqual(c.timers.current.count, 1)
        c.failRefresh.set(false)
        c.now.set(1_125)
        c.timers.current[0].1()
        await d.drain()
        XCTAssertEqual(c.refreshes.current, 3)
    }

    func testNoRefreshMemberMeansNoFetch() async {
        let c = Calls()
        let d = docs(c, refresh: false)
        d.wantRing()
        d.onRing("good", 4)
        await d.drain()
        XCTAssertEqual(c.refreshes.current, 0)
        XCTAssertTrue(c.timers.current.isEmpty)
    }

    func testTheChannelBaseHandsTheChannelAKeyHandleAndTheAccount() throws {
        let d = Dev(idA, signByte: 1)
        let key = try PeerNoiseRawStaticKey(privateKey: d.priv.rawRepresentation)
        let o = PeerChannelOptions(
            role: .initiator, slug: "djdl", staticKey: key,
            account: PeerAccountContext(
                trust: signer.trust, expectedAud: "djdl", certJws: d.cert, ownSub: sub, ownDeviceId: d.id,
                heldRing: { nil }, discKeys: [rnd()]),
            caps: ["app/1"], hello: (nil, connectPlatformName, "djdl", nil))
        XCTAssertEqual(o.mode, .a)
        XCTAssertEqual(o.slug, "djdl")
        XCTAssertFalse("\(o.account!)".contains(d.cert))
        XCTAssertFalse(connectPlatformName.isEmpty)
    }
}
