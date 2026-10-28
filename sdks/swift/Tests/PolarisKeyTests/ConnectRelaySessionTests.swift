// @pkey-feature connect.relay
// CC-11.14: sessions over the relay and the outgoing pacing (WIRE-CONTRACT-V5 §15.7, G8, G16, G17, D-9). Two
// `ConnectRelayService`s share one in-process `FakeRoom`; the sessions are real mode-a engines. Mirrors the
// Python port's `test_connect_relay_sessions.py`.

import CryptoKit
import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey

private let sub = "ps_AAAAAAAAAAAAAAAAAAAAAA"
private let idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
private let idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
private let idC = "CCCCDDDDEEEEFFFFGGGGHHHHAAAABBBB"
private let signer = TestSigner(kid: "peer-test-2026")
private let t0 = Int(Date().timeIntervalSince1970)

private struct Dev {
    let id: String
    let store: DeviceKeyStore
    let signKey: String
    let agreeKey: String

    init(_ id: String, signByte: UInt8) async throws {
        self.id = id
        store = try DeviceKeyStore.inMemory()
        agreeKey = try await store.ensure().agreeKey
        signKey = Base64URL.encode(Data(repeating: signByte, count: 32))
    }

    var cert: String {
        signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","deviceId":"\#(id)","signKey":"\#(signKey)","agreeKey":"\#(agreeKey)","ringEpoch":1,"issuedAt":\#(t0 - 10),"expiresAt":\#(t0 + 5000)}"#,
            typ: "pkey-peer+jws")
    }

    var entry: String { #"{"deviceId":"\#(id)","signKey":"\#(signKey)","agreeKey":"\#(agreeKey)"}"# }
}

private final class Tally: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    private var bytes = 0
    private var _sizes: [Int] = []
    var count: Int { lock.withLock { n } }
    var total: Int { lock.withLock { bytes } }
    var sizes: [Int] { lock.withLock { _sizes } }
    func add(_ b: Int) {
        lock.withLock {
            n += 1
            bytes += b
            _sizes.append(b)
        }
    }
}

private final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t: TimeInterval = 1000
    var now: TimeInterval { lock.withLock { t } }
    func advance(_ s: TimeInterval) { lock.withLock { t += s } }
}

private final class World: @unchecked Sendable {
    let a: Dev, b: Dev, c: Dev
    let room: FakeRoom
    let key = DiscoveryKey(base64url: Base64URL.encode(Data((0..<32).map { _ in UInt8.random(in: 0...255) })))!
    let ring: String
    var services: [ConnectRelayService] = []

    init(members: Set<String> = [idA, idB]) async throws {
        room = FakeRoom(members: members)
        a = try await Dev(idA, signByte: 1)
        b = try await Dev(idB, signByte: 2)
        c = try await Dev(idC, signByte: 3)
        let entries = [a, b, c].sorted { $0.id < $1.id }.map(\.entry).joined(separator: ",")
        ring = signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","epoch":1,"issuedAt":\#(t0 - 10),"expiresAt":\#(t0 + 100000),"devices":[\#(entries)]}"#,
            typ: "pkey-ring+jws")
    }

    func source(_ d: Dev) -> ConnectLanSource {
        let ps = PeerSource(
            slug: "djdl", trust: signer.trust, sub: sub, deviceId: d.id, certJws: d.cert, certExpiresAt: t0 + 5000,
            ringJws: ring, ringEpoch: 1, roster: [idA, idB, idC], keys: DiscoveryKeys(current: key, previous: nil),
            agreePublic: Base64URL.decodeStrict(d.agreeKey)!, staticKey: PeerNoiseDeviceKey(d.store))
        return ConnectLanSource(load: { ps }, now: { t0 })
    }

    func start(_ d: Dev, _ tweak: (inout ConnectRelayOptions) -> Void = { _ in }) async throws -> ConnectRelayService {
        var o = ConnectRelayOptions(opener: room.opener, random: { 0.5 }, pingSeconds: 1000)
        tweak(&o)
        let s = ConnectRelayService(
            source: source(d), ticket: { [room] in .granted(room.issue(device: d.id)) }, options: o)
        await s.start()
        try await s.ready(timeout: 5)
        services.append(s)
        return s
    }

    func close() async { for s in services { await s.stop() } }
}

private func until(_ what: String, _ cond: @Sendable () async -> Bool) async {
    for _ in 0..<500 {
        if await cond() { return }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("timed out waiting for \(what)")
}

final class ConnectRelaySessionTests: XCTestCase {
    func testTwoDevicesHandshakeExchangeAndCloseOverTheRoom() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        let b = try await w.start(w.b)
        let inbound = LockedValue<ConnectSession?>(nil)
        b.onSession { inbound.set($0) }
        let s = try await a.dial(idB)
        XCTAssertEqual(s.path, "relay")
        XCTAssertEqual(s.peerDeviceId, idB)
        await until("inbound") { inbound.current != nil }
        let r = inbound.current!
        XCTAssertEqual(r.peerDeviceId, idA)
        try await s.send(Data("ping".utf8))
        let got = try await r.receive()
        XCTAssertEqual(got.body, Data("ping".utf8))
        try await r.send(Data("pong".utf8))
        let back = try await s.receive()
        XCTAssertEqual(back.body, Data("pong".utf8))
        // A message of several records crosses.
        let big = Data(repeating: 9, count: 200_000)
        try await s.send(big)
        let bigGot = try await r.receive()
        XCTAssertEqual(bigGot.body, big)
        await s.close()
        await until("closed") { r.closed != nil }
        await w.close()
    }

    func testTheSocketLossOrAGoneEndsTheSessionsWithoutAWord() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        _ = try await w.start(w.b)
        let s = try await a.dial(idB)
        w.room.push(idA, .gone(Base64URL.decode(idB)!))
        await until("closed by gone") { s.closed != nil }
        XCTAssertEqual(s.closed?.code, "connection_lost")
        await w.close()
    }

    func testTheCertificateDeviceMustBeTheStampedFrom() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        _ = try await w.start(w.b)
        // The room stamps B's messages as C's.
        w.room.stampAs[idB] = idC
        w.room.redirect[idC] = idB
        do {
            _ = try await a.dial(idC)
            XCTFail("B answered for C")
        } catch { XCTAssertEqual((error as? ConnectRelayError)?.reason, .wrongPeer) }
        await w.close()
    }

    func testOnlyTheRostersOtherDevicesMayDialAndTheDeviceMustBeKnown() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        for id in [idA, "ZZZZ", "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"] {
            do {
                _ = try await a.dial(id)
                XCTFail(id)
            } catch { XCTAssertEqual((error as? ConnectRelayError)?.reason, .unknownPeer) }
        }
        // A first message from a device outside the roster opens nothing.
        let b = try await w.start(w.b)
        let seen = Tally()
        b.onSession { _ in seen.add(1) }
        w.room.push(
            idB,
            .recv(
                from: Base64URL.decode("ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")!, session: 5,
                noise: Data(repeating: 1, count: 48)))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(seen.count, 0)
        await w.close()
    }

    func testTheSessionTableIsBounded() async throws {
        let w = try await World()
        let a = try await w.start(w.a) { $0.maxSessions = 1 }
        _ = try await w.start(w.b)
        let first = try await a.dial(idB)
        do {
            _ = try await a.dial(idB)
            XCTFail("full")
        } catch { XCTAssertEqual((error as? ConnectRelayError)?.reason, .busy) }
        await first.close()
        await w.close()
    }

    func testAResponderThatTakesNoMorePendingFromAPeerLeavesTheDialerToTimeOut() async throws {
        let w = try await World()
        let a = try await w.start(w.a) { $0.handshakeSeconds = 0.5 }
        _ = try await w.start(w.b) { $0.maxPendingPerPeer = 0 }
        do {
            _ = try await a.dial(idB)
            XCTFail("not answered")
        } catch {
            XCTAssertEqual((error as? ConnectRelayError)?.reason, .handshakeFailed)
        }
        await w.close()
    }

    func testOnlyModeAAndAnEndedSessionIsNotRevived() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        let b = try await w.start(w.b)
        let n = Tally()
        b.onSession { _ in n.add(1) }
        let s = try await a.dial(idB)
        await until("admitted") { n.count == 1 }
        await s.close()
        await until("ended") { s.closed != nil }
        // A late message for the ended session does not open another.
        let key = w.room.sends(idA).first
        if case .send(_, let session, let noise)? = key {
            w.room.push(idB, .recv(from: Base64URL.decode(idA)!, session: session, noise: noise))
        }
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(n.count, 1)
        await w.close()
    }

    // MARK: pacing (D-9)

    func testThePacerAllowsABurstThenTheRateAndHalvesOnLimit1ForTenSeconds() async throws {
        let clock = FakeClock()
        let p = ConnectPacer(clock: { clock.now })
        for _ in 0..<360 { XCTAssertEqual(p.tryTake(), 0) }
        let wait = p.tryTake()
        XCTAssertEqual(wait, 1.0 / 180, accuracy: 1e-6)
        clock.advance(1)
        var taken = 0
        while p.tryTake() == 0 { taken += 1 }
        XCTAssertEqual(taken, 180, "a second refills 180 tokens")
        XCTAssertEqual(p.rate, 180)
        p.halve()
        XCTAssertEqual(p.rate, 90)
        clock.advance(10.1)
        XCTAssertEqual(p.rate, 180)
    }

    func testAcquireSleepsUntilATokenIsAvailable() async throws {
        let clock = FakeClock()
        let slept = LockedValue<[TimeInterval]>([])
        let p = ConnectPacer(
            rate: 10, burst: 1, clock: { clock.now },
            sleep: { s in
                slept.with { $0.append(s) }
                clock.advance(s)
            })
        try await p.acquire()
        try await p.acquire()
        XCTAssertEqual(slept.current.count, 1)
        XCTAssertEqual(slept.current[0], 0.1, accuracy: 1e-6)
    }

    func testTheOutboxRefusesAnItemPastItsCapButForcedItemsGoThrough() async throws {
        let q = ConnectOutbox(maxBytes: 100)
        XCTAssertTrue(q.put(Data(count: 60)))
        XCTAssertFalse(q.put(Data(count: 60)))
        XCTAssertTrue(q.put(Data(count: 60), force: true))
        XCTAssertEqual(q.queued, 120)
        XCTAssertFalse(q.roomFor(1))
        let first = await q.get()
        XCTAssertEqual(first?.count, 60)
        XCTAssertEqual(q.queued, 60)
        q.close()
        let none = await q.get()
        XCTAssertNil(none)
    }

    func testLimit1HalvesTheLiveRateAndAFullQueueClosesTheSessionPeerBusyBeforeEncryption() async throws {
        let w = try await World()
        let clock = FakeClock()
        let sleeper = ManualSleep()
        let pacer = ConnectPacer(rate: 180, burst: 360, clock: { clock.now }, sleep: { try await sleeper.sleep($0) })
        let a = try await w.start(w.a) { $0.pacer = { pacer } }
        let b = try await w.start(w.b)
        let got = Tally()
        let inbound = LockedValue<ConnectSession?>(nil)
        b.onSession { s in
            s.onMessage { got.add($0.body.count) }
            inbound.set(s)
        }
        let s = try await a.dial(idB)
        w.room.push(idA, .limit(reason: 1))
        await until("halved") { pacer.rate == 90 }
        // Drain every token: the writer now waits on the pacer, so the queue fills.
        while pacer.tryTake() == 0 {}
        let msg = Data(repeating: 3, count: 1 << 20)
        var sent = 0
        for _ in 0..<12 {
            do {
                try await s.send(msg)  // a full queue is not an error: the host sees the close (D-9)
            } catch let e as ConnectLanError {
                XCTAssertEqual(e.reason, .closed)  // only once the close has landed
                break
            }
            if s.closed != nil { break }
            sent += 1
        }
        await until("the session is closed peer_busy") { s.closed != nil }
        XCTAssertEqual(s.closed?.code, "peer_busy")
        XCTAssertEqual(s.closed?.byPeer, false)
        XCTAssertGreaterThanOrEqual(sent, 7)
        XCTAssertLessThanOrEqual(sent, 9, "the queue holds about 8 MiB")
        await w.close()
    }

    func testASessionWhoseOutboxIsOverTheCapIsClosedAndTheOthersGoOn() async throws {
        let w = try await World()
        let clock = FakeClock()
        let sleeper = ManualSleep()
        let pacer = ConnectPacer(rate: 180, burst: 360, clock: { clock.now }, sleep: { try await sleeper.sleep($0) })
        let a = try await w.start(w.a) { $0.pacer = { pacer } }
        let b = try await w.start(w.b)
        b.onSession { _ in }
        let s = try await a.dial(idB)
        while pacer.tryTake() == 0 {}  // the writer now waits on the pacer, so the outbox fills
        let ids = await a.openLinkIds()
        let id = try XCTUnwrap(ids.first)
        for _ in 0..<200 { await a.sendSession(peer: id.peer, session: id.session, noise: Data(count: 60_000)) }
        await until("the session is closed for being over the outbox cap") { s.closed != nil }
        await until("the session left the table") { await a.openLinkIds().isEmpty }
        await w.close()
    }

    /// R3: with the outbox full the session holding the most queued bytes is closed, not whichever session
    /// writes next.
    func testTheOutboxCapClosesTheSessionOverItsOwnShareNotTheNextWriter() async throws {
        let w = try await World(members: [idA, idB, idC])
        let clock = FakeClock()
        let sleeper = ManualSleep()
        let pacer = ConnectPacer(rate: 180, burst: 360, clock: { clock.now }, sleep: { try await sleeper.sleep($0) })
        let a = try await w.start(w.a) { $0.pacer = { pacer } }
        let b = try await w.start(w.b)
        let c = try await w.start(w.c)
        b.onSession { _ in }
        c.onSession { _ in }
        let sb = try await a.dial(idB)
        let sc = try await a.dial(idC)
        while pacer.tryTake() == 0 {}  // the writer waits on the pacer, so the outbox fills
        let ids = await a.openLinkIds()
        let peerC = try XCTUnwrap(Base64URL.decodeStrict(idC))
        let heavy = try XCTUnwrap(ids.first { $0.peer != peerC })
        let light = try XCTUnwrap(ids.first { $0.peer == peerC })
        var n = 0
        while await a.hasRoom(60_200), n < 400 {
            await a.sendSession(peer: heavy.peer, session: heavy.session, noise: Data(count: 60_000))
            n += 1
        }
        XCTAssertNil(sb.closed, "the heavy session is still open while there is room")
        // The light session now writes into a full outbox: the heavy one goes, the light one stays.
        await a.sendSession(peer: light.peer, session: light.session, noise: Data(count: 60_000))
        await until("the heavy session is closed") { sb.closed != nil }
        XCTAssertNil(sc.closed)
        let left = await a.openLinkIds()
        XCTAssertTrue(left.contains { $0.peer == peerC })
        await w.close()
    }
}
