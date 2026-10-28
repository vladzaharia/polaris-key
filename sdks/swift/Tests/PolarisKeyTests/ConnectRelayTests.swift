// @pkey-feature connect.relay
// CC-11.13: the relay socket (WIRE-CONTRACT-V5 §15.7, G13 to G15): ticket offer, open, reconnect policy, LIMIT
// and close codes, status. The room is the in-process `FakeRoom`; the default opener (`URLSessionWebSocketTask`,
// D-4) is proven against a real loopback WebSocket server on `NWListener` + `NWProtocolWebSocket`. Mirrors the
// socket half of Python's `test_connect_relay.py` and Node's `relay.test.ts`.

import CryptoKit
import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey

#if canImport(Network)
    import Network
#endif

private let idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
private let idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
private let ping: TimeInterval = 1000

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

private func until(_ what: String, _ cond: @Sendable () async -> Bool) async {
    for _ in 0..<500 {
        if await cond() { return }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("timed out waiting for \(what)")
}

private func heldSource(epoch: Int, refreshes: Box<Int>, now: @escaping @Sendable () -> Int) async throws
    -> ConnectLanSource
{
    let store = try DeviceKeyStore.inMemory()
    let agree = try await store.ensure().agreeKey
    let key = DiscoveryKey(base64url: Base64URL.encode(Data(repeating: 7, count: 32)))!
    let ps = PeerSource(
        slug: "djdl", trust: [:], sub: "ps_AAAAAAAAAAAAAAAAAAAAAA", deviceId: idA, certJws: "",
        certExpiresAt: Int.max / 2,
        ringJws: "", ringEpoch: epoch, roster: [idA, idB], keys: DiscoveryKeys(current: key, previous: nil),
        agreePublic: Base64URL.decodeStrict(agree)!, staticKey: PeerNoiseDeviceKey(store))
    return ConnectLanSource(load: { ps }, now: now, refresh: { refreshes.mutate { $0 += 1 } })
}

private final class Rig: @unchecked Sendable {
    let room: FakeRoom
    let sleep = ManualSleep()
    let clock = Box<TimeInterval>(100)
    let refreshes = Box<Int>(0)
    let tickets = Box<[ConnectRelayTicketResult]>([])
    let states = Box<[ConnectRelayState]>([])
    let device: String
    var svc: ConnectRelayService!

    init(device: String = idA, members: Set<String>? = nil) {
        self.device = device
        room = FakeRoom(members: members ?? [idA, idB])
    }

    func start(epoch: Int = 1, _ tweak: (inout ConnectRelayOptions) -> Void = { _ in }) async throws
        -> ConnectRelayService
    {
        let nowSec: @Sendable () -> Int = { [clock] in Int(clock.value) + 1_000_000 }
        let src = try await heldSource(epoch: epoch, refreshes: refreshes, now: nowSec)
        var o = ConnectRelayOptions(
            opener: room.opener, sleep: { [sleep] s in try await sleep.sleep(s) }, random: { 0.5 },
            clock: { [clock] in clock.value }, pingSeconds: ping)
        tweak(&o)
        let s = ConnectRelayService(
            source: src,
            ticket: { [self] in
                if let r = tickets.mutate2({ $0.isEmpty ? nil : $0.removeFirst() }) { return r }
                return .granted(room.issue(device: device))
            }, options: o)
        s.onState { [states] st in states.mutate { a in a.append(st.state) } }
        svc = s
        await s.start()
        return s
    }

    func ready() async throws -> ConnectRelayService {
        let s = try await start()
        try await s.ready(timeout: 5)
        return s
    }

    func backoffDelays() -> [TimeInterval] { sleep.delays.filter { $0 != ping } }

    func wake() async {
        await until("a backoff sleep") { sleep.pendingSeconds.contains { $0 != ping } }
        sleep.fire { $0 != ping }
    }

    func close() async { await svc?.stop() }
}

extension Box {
    fileprivate func mutate2<R>(_ f: (inout T) -> R) -> R {
        var out: R!
        mutate { out = f(&$0) }
        return out
    }
}

final class ConnectRelayTests: XCTestCase {
    // MARK: ticket and open

    func testTheSocketOffersTheProtocolThenTheTicketAndANewTicketEachConnect() async throws {
        let r = Rig()
        _ = try await r.ready()
        XCTAssertEqual(r.room.offers.count, 1)
        XCTAssertEqual(r.room.offers[0].first, "pkey-relay.1")
        XCTAssertTrue(r.room.offers[0][1].hasPrefix("pkeyrt_"))
        r.room.dropAll(1006)
        await r.wake()
        await until("second socket") { r.room.offers.count == 2 }
        XCTAssertNotEqual(r.room.offers[0][1], r.room.offers[1][1])
        XCTAssertEqual(r.room.issuedCount, 2)
        await r.close()
    }

    func testOnOpenItAsksForTheMembersAndReportsThem() async throws {
        let r = Rig()
        let got = Box<[[String]]>([])
        let s = try await r.start()
        s.onMembers { m in got.mutate { $0.append(m) } }
        try await s.ready(timeout: 5)
        await until("members") { await s.members() == [idA] }
        let b = try await Rig(device: idB).startAgainst(r.room)
        _ = b
        let m = await s.refreshMembers(timeout: 3)
        XCTAssertEqual(m, [idA, idB].sorted())
        await r.close()
    }

    func testAPingIsAnsweredAndListedOnEveryInterval() async throws {
        let r = Rig()
        _ = try await r.ready()
        XCTAssertEqual(r.room.count(idA) { if case .ping = $0 { return true } else { return false } }, 0)
        await until("ping timer") { r.sleep.pendingSeconds.contains(ping) }
        r.sleep.fire { $0 == ping }
        await until("ping sent") { r.room.count(idA) { if case .ping = $0 { return true } else { return false } } == 1 }
        XCTAssertGreaterThanOrEqual(r.room.count(idA) { $0 == .list }, 2)
        await r.close()
    }

    func testMembersChangesAndGoneAreReported() async throws {
        let r = Rig()
        let s = try await r.ready()
        await until("the first MEMBERS") { await s.members() == [idA] }
        let b = Base64URL.decode(idB)!
        r.room.push(idA, .members([Base64URL.decode(idA)!, b]))
        await until("two members") { await s.members().count == 2 }
        r.room.push(idA, .gone(b))
        await until("one member") { await s.members() == [idA] }
        await r.close()
    }

    // MARK: reconnect policy

    func testReconnectsWithAGrowingJitteredBackoffThatResetsOnlyAfterAStableOpen() async throws {
        let r = Rig()
        let s = try await r.ready()
        // random 0.5: delay = cap/2 + 0.5*cap/2 = 0.75 * cap
        r.room.dropAll(1006)
        await until("first backoff") { r.backoffDelays().count == 1 }
        XCTAssertEqual(r.backoffDelays()[0], 0.75, accuracy: 0.001)
        await r.wake()
        await until("reopened") { await s.status.state == .open }
        r.room.dropAll(1006)  // open for 0 s: not stable
        await until("second backoff") { r.backoffDelays().count == 2 }
        XCTAssertEqual(r.backoffDelays()[1], 1.5, accuracy: 0.001)
        await r.wake()
        await until("reopened 2") { await s.status.state == .open }
        r.clock.value += 31  // stayed up
        r.room.dropAll(1006)
        await until("third backoff") { r.backoffDelays().count == 3 }
        XCTAssertEqual(r.backoffDelays()[2], 0.75, accuracy: 0.001, "the backoff reset after a stable open")
        await r.close()
    }

    func testARoomCloseBeforeOpenWith4001GetsANewTicketAfterTheBackoff() async throws {
        let r = Rig()
        r.room.rejectWith = 4001
        let s = try await r.start()
        await until("backoff") { r.backoffDelays().count == 1 }
        await r.wake()
        try await s.ready(timeout: 5)
        XCTAssertEqual(r.room.issuedCount, 2)
        await r.close()
    }

    func test4009StopsWithoutFightingBack() async throws {
        let r = Rig()
        let s = try await r.ready()
        r.room.dropAll(4009)
        await until("blocked") { await s.status.state == .blocked }
        let st = await s.status
        XCTAssertEqual(st.error?.reason, .replaced)
        XCTAssertEqual(st.error?.closeCode, 4009)
        XCTAssertEqual(r.room.offers.count, 1)
        do {
            try await s.ready(timeout: 1)
            XCTFail("blocked")
        } catch { XCTAssertEqual((error as? ConnectRelayError)?.reason, .replaced) }
        await r.close()
    }

    func testTheThirdSocketOfADeviceReplacesTheOldestWith4009() async throws {
        let r = Rig()
        let first = try await r.ready()
        _ = first
        let g1 = r.room.issue(device: idA)
        let g2 = r.room.issue(device: idA)
        let s2 = try await r.room.opener(g1.url, ["pkey-relay.1", g1.ticket]) as! FakeSocket
        _ = try await r.room.opener(g2.url, ["pkey-relay.1", g2.ticket])
        do {
            _ = try await r.room.opener(g1.url, ["pkey-relay.1", g1.ticket])
            XCTFail("single use")
        } catch {
            XCTAssertEqual((error as? RelaySocketClosed)?.code, 4001)
        }
        XCTAssertEqual(s2.closeCode, nil)
        await until("the service's socket was replaced") { await first.status.state == .blocked }
        await r.close()
    }

    func testAProductThatTurnedTheRelayOffOrASpentQuotaEndsTheLoopAndResumeTriesAgain() async throws {
        for (reason, scope) in [(ConnectRelayReason.disabled, String?.none), (.quota, "person")] {
            let r = Rig()
            r.tickets.value = [.relay(ConnectRelayError(reason, "x", scope: scope))]
            let s = try await r.start()
            await until("blocked") { await s.status.state == .blocked }
            let st = await s.status
            XCTAssertEqual(st.error?.reason, reason)
            XCTAssertEqual(st.error?.scope, scope)
            await s.resume()
            try await s.ready(timeout: 5)
            await r.close()
        }
    }

    func testAPausedRelayWaitsForRetryAfterCappedAtAnHour() async throws {
        let r = Rig()
        r.tickets.value = [.relay(ConnectRelayError(.paused, "x", retryAfterSeconds: 90_000))]
        _ = try await r.start()
        await until("backoff") { r.backoffDelays().count == 1 }
        XCTAssertEqual(r.backoffDelays()[0], 3600, accuracy: 0.001)
        await r.close()
    }

    func testALimitForTheProductThen4008IsATypedQuotaStop() async throws {
        let r = Rig()
        let s = try await r.ready()
        r.room.push(idA, .limit(reason: 3))
        await until("limit seen") { await s.status.error?.scope == "product" }
        r.room.dropAll(4008)
        await until("blocked") { await s.status.state == .blocked }
        let st = await s.status
        XCTAssertEqual(st.error?.reason, .quota)
        XCTAssertEqual(st.error?.scope, "product")
        await r.close()
    }

    func testA4008AfterARateLimitOrWithNoLimitBacksOffInstead() async throws {
        let r = Rig()
        let s = try await r.ready()
        r.room.push(idA, .limit(reason: 1))
        await until("rate limited") { await s.status.error?.reason == .rateLimited }
        r.room.dropAll(4008)
        await until("backoff") { r.backoffDelays().count == 1 }
        await r.wake()
        await until("open") { await s.status.state == .open }
        r.room.dropAll(4008)
        await until("backoff 2") { r.backoffDelays().count == 2 }
        let st = await s.status
        XCTAssertNotEqual(st.state, .blocked)
        await r.close()
    }

    func testAPausedLimitIsReportedAndTheSocketStays() async throws {
        let r = Rig()
        let s = try await r.ready()
        r.room.push(idA, .limit(reason: 4))
        await until("paused") { await s.status.error?.reason == .paused }
        let st = await s.status
        XCTAssertEqual(st.state, .open)
        await r.close()
    }

    func test4003FetchesTheRosterAndStopsAfterThreeInARow() async throws {
        let r = Rig(members: [idB])
        let s = try await r.start()
        for n in 1...2 {
            await until("backoff \(n)") { r.backoffDelays().count == n }
            await r.wake()
        }
        await until("blocked") { await s.status.state == .blocked }
        let st = await s.status
        XCTAssertEqual(st.error?.reason, .notMember)
        XCTAssertEqual(st.error?.closeCode, 4003)
        await until("a roster fetch") { r.refreshes.value >= 1 }
        await r.close()
    }

    func testFiveAttemptsThatNeverOpenMakeTheRelayUnavailableAndSlowTheRetries() async throws {
        let r = Rig()
        let s = try await r.start()
        r.room.rejectWith = 1006
        for n in 1...5 {
            await until("backoff \(n)") { r.backoffDelays().count == n }
            if n < 5 {
                r.room.rejectWith = 1006
                await r.wake()
            }
        }
        let st = await s.status
        XCTAssertEqual(st.state, .unavailable)
        XCTAssertGreaterThanOrEqual(r.backoffDelays().last!, 300)
        XCTAssertEqual(st.attempts, 5)
        await r.close()
    }

    // MARK: framing

    func testAnEnvelopeThatDoesNotMatchItsLayoutOrATextFrameCloses1002AndNothingIsAnswered() async throws {
        let r = Rig()
        let s = try await r.ready()
        let sock = r.room.liveSockets[0]
        await until("first LIST") { r.room.count(idA) { _ in true } >= 1 }
        let before = r.room.count(idA) { _ in true }
        sock.deliverRaw(.binary(Data([0x99, 1, 2])))
        await until("closed 1002") { sock.closeCode == 1002 }
        XCTAssertEqual(r.room.count(idA) { _ in true }, before)
        await until("reconnect backoff") { r.backoffDelays().count == 1 }
        await r.wake()
        await until("reopened") { await s.status.state == .open }
        r.room.liveSockets[0].deliverRaw(.text)
        await until("text refused") { r.room.everSockets[1].closeCode == 1002 }
        await r.close()
    }

    func testARelayRingAboveTheHeldEpochFetchesTheRosterAndOneAtItDoesNot() async throws {
        let r = Rig()
        _ = try await r.start(epoch: 5)
        try await r.svc.ready(timeout: 5)
        r.room.pushRing(5)
        r.room.pushRing(9)
        await until("fetch for 9") { r.refreshes.value == 1 }
        await r.close()
    }

    // MARK: lifecycle

    func testStopClosesTheSocketAndReadyThenThrowsStopped() async throws {
        let r = Rig()
        let s = try await r.ready()
        await s.stop()
        XCTAssertNotNil(r.room.everSockets[0].closeCode)
        do {
            try await s.ready(timeout: 1)
            XCTFail("stopped")
        } catch { XCTAssertEqual((error as? ConnectRelayError)?.reason, .stopped) }
    }

    func testReadyTimesOutWithNotConnectedWhenNothingOpens() async throws {
        let r = Rig()
        r.tickets.value = [.error(code: "network", message: "x")]
        let s = try await r.start()
        do {
            try await s.ready(timeout: 0.2)
            XCTFail("never opens")
        } catch {
            XCTAssertEqual((error as? ConnectRelayError)?.reason, .unavailable)
        }
        await r.close()
    }

    func testOnlyModeAMayCrossTheRelayAndTheServiceLeaksNothing() async throws {
        XCTAssertNoThrow(try assertRelayMode(.a))
        for m in [PeerNoiseMode.v, .p] {
            XCTAssertThrowsError(try assertRelayMode(m)) {
                XCTAssertEqual(($0 as? ConnectRelayError)?.reason, .modeNotAllowed)
            }
        }
        let r = Rig()
        let s = try await r.ready()
        var dumped = ""
        dump(s, to: &dumped)
        XCTAssertEqual("\(s)", "ConnectRelayService()")
        XCTAssertFalse(dumped.contains("pkeyrt_"))
        await r.close()
    }

    // MARK: the default opener (D-4)

    #if canImport(Network)
        func testTheURLSessionOpenerRefusesAnythingButWss() async throws {
            let open = urlSessionRelayOpener()
            for u in ["ws://example.com/x", "http://example.com", "ws://192.168.1.2/x"] {
                do {
                    _ = try await open(URL(string: u)!, ["pkey-relay.1", "t"])
                    XCTFail(u)
                } catch { XCTAssertTrue(error is RelaySocketClosed) }
            }
        }

        func testTheURLSessionOpenerNegotiatesTheProtocolCarriesBinaryAndSeesTheCustomCloseCodes() async throws {
            let server = try await WSServer.start(echoProtocol: true)
            defer { server.stop() }
            let open = urlSessionRelayOpener(openSeconds: 5, allowInsecureLoopback: true)
            // Binary both ways.
            let c = try await open(server.url, ["pkey-relay.1", "pkeyrt_" + String(repeating: "A", count: 32)])
            try await c.send(Data([1, 2, 3]))
            let back = try await c.receive()
            XCTAssertEqual(back, .binary(Data([1, 2, 3])))
            await until("offered") { server.offered.count == 1 }
            XCTAssertEqual(server.offered[0].first, "pkey-relay.1")
            await c.close(code: 1000)
            // 4001, 4003, 4008 and 4009 reach the client.
            for code in [4001, 4003, 4008, 4009] {
                server.closeWith = code
                let s = try await open(server.url, ["pkey-relay.1", "t"])
                do {
                    _ = try await s.receive()
                    XCTFail("closed")
                } catch {
                    XCTAssertEqual((error as? RelaySocketClosed)?.code, code, "close code \(code)")
                }
            }
        }

        func testTheURLSessionOpenerRefusesAServerThatDoesNotEchoTheProtocolAndAnOversizeMessage() async throws {
            let plain = try await WSServer.start(echoProtocol: false)
            defer { plain.stop() }
            let open = urlSessionRelayOpener(openSeconds: 5, allowInsecureLoopback: true)
            do {
                _ = try await open(plain.url, ["pkey-relay.1", "t"])
                XCTFail("no echo")
            } catch { XCTAssertTrue(error is RelaySocketClosed) }
            let big = try await WSServer.start(echoProtocol: true)
            defer { big.stop() }
            big.sendOnOpen = Data(repeating: 0, count: peerRelayMaxMessage + 1)
            let s = try await open(big.url, ["pkey-relay.1", "t"])
            do {
                _ = try await s.receive()
                XCTFail("oversize")
            } catch { XCTAssertTrue(error is RelaySocketClosed) }
        }

        /// B1: a redirect on the upgrade never carries the ticket to another origin.
        func testARedirectOnTheUpgradeIsNotFollowedAndTheRelayReportsATypedFailure() async throws {
            let target = try await HTTPStub.start(reply: nil)
            defer { target.stop() }
            let first = try await HTTPStub.start(
                reply:
                    "HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:\(target.port)/elsewhere\r\nContent-Length: 0\r\n\r\n"
            )
            defer { first.stop() }
            let url = URL(string: "ws://127.0.0.1:\(first.port)/relay")!
            let open = urlSessionRelayOpener(openSeconds: 5, allowInsecureLoopback: true)
            do {
                _ = try await open(url, ["pkey-relay.1", "pkeyrt_" + String(repeating: "B", count: 32)])
                XCTFail("redirect")
            } catch {
                XCTAssertTrue(error is RelaySocketClosed)
            }
            XCTAssertEqual(first.requests.count, 1)
            XCTAssertTrue(first.requests[0].contains("pkeyrt_"), "the origin it was meant for saw the offer")
            try await Task.sleep(nanoseconds: 300_000_000)
            XCTAssertEqual(target.requests.count, 0, "no second request reached the other origin")
            // Through the service: a typed failure and a backoff, not a hang.
            let src = try await heldSource(epoch: 1, refreshes: Box(0), now: { 1_000_000 })
            let svc = ConnectRelayService(
                source: src,
                ticket: {
                    .granted(
                        RelayGrant(
                            ticket: "pkeyrt_" + String(repeating: "C", count: 32), url: url,
                            protocolName: "pkey-relay.1", expiresAt: 2_000_000_000))
                },
                options: ConnectRelayOptions(
                    opener: open, sleep: { _ in try await Task.sleep(nanoseconds: 60_000_000_000) }))
            await svc.start()
            await until("backoff with a typed error") {
                let st = await svc.status
                return st.state == .backoff && st.error?.reason == .unavailable
            }
            XCTAssertEqual(target.requests.count, 0)
            await svc.stop()
        }
    #endif
}

#if canImport(Network)
    /// A bare HTTP responder on loopback: records each request's text and answers `reply` (nothing when nil).
    private final class HTTPStub: @unchecked Sendable {
        private let lock = NSLock()
        private var _requests: [String] = []
        private var conns: [NWConnection] = []
        private var listener: NWListener!
        private(set) var port: UInt16 = 0
        var requests: [String] { lock.withLock { _requests } }

        static func start(reply: String?) async throws -> HTTPStub {
            let s = HTTPStub()
            let l = try NWListener(using: .tcp)
            s.listener = l
            let q = DispatchQueue(label: "http-stub")
            l.newConnectionHandler = { c in
                s.lock.withLock { s.conns.append(c) }
                c.start(queue: q)
                c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
                    if let data { s.lock.withLock { s._requests.append(String(decoding: data, as: UTF8.self)) } }
                    if let reply { c.send(content: Data(reply.utf8), completion: .contentProcessed { _ in }) }
                }
            }
            try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
                let once = Box(false)
                l.stateUpdateHandler = { st in
                    switch st {
                    case .ready:
                        if !once.mutate2({
                            let w = $0
                            $0 = true
                            return w
                        }) {
                            s.port = l.port!.rawValue
                            k.resume()
                        }
                    case .failed(let e):
                        if !once.mutate2({
                            let w = $0
                            $0 = true
                            return w
                        }) {
                            k.resume(throwing: e)
                        }
                    default: break
                    }
                }
                l.start(queue: q)
            }
            return s
        }

        func stop() {
            listener.cancel()
            for c in lock.withLock({ conns }) { c.cancel() }
        }
    }
#endif

extension Rig {
    /// A second device on the same room, for MEMBERS.
    fileprivate func startAgainst(_ room: FakeRoom) async throws -> FakeSocket {
        let g = room.issue(device: device)
        return try await room.opener(g.url, ["pkey-relay.1", g.ticket]) as! FakeSocket
    }
}

#if canImport(Network)
    /// A loopback WebSocket server: accepts the client's offer (optionally echoing `pkey-relay.1`), echoes binary
    /// messages, and closes with `closeWith` on connect when set.
    private final class WSServer: @unchecked Sendable {
        private var listener: NWListener!
        private let queue = DispatchQueue(label: "ws-server")
        private let lock = NSLock()
        private var _offered: [[String]] = []
        private var conns: [NWConnection] = []
        var offered: [[String]] { lock.withLock { _offered } }
        var closeWith: Int?
        var sendOnOpen: Data?
        private(set) var port: UInt16 = 0
        var url: URL { URL(string: "ws://127.0.0.1:\(port)/relay")! }

        private init() {}

        static func start(echoProtocol: Bool) async throws -> WSServer {
            let s = WSServer()
            let ws = NWProtocolWebSocket.Options()
            ws.autoReplyPing = true
            ws.setClientRequestHandler(s.queue) { subprotocols, _ in
                s.lock.withLock { s._offered.append(subprotocols) }
                return NWProtocolWebSocket.Response(status: .accept, subprotocol: echoProtocol ? "pkey-relay.1" : nil)
            }
            // The options are configured before they join the stack: the stack copies them.
            let params = NWParameters.tcp
            params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
            let l = try NWListener(using: params)
            s.listener = l
            l.newConnectionHandler = { c in
                s.lock.withLock { s.conns.append(c) }
                c.stateUpdateHandler = { st in
                    if case .ready = st { s.opened(c) }
                }
                c.start(queue: s.queue)
            }
            try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
                let once = Box(false)
                l.stateUpdateHandler = { st in
                    switch st {
                    case .ready:
                        if !once.mutate2({
                            let w = $0
                            $0 = true
                            return w
                        }) {
                            s.port = l.port!.rawValue
                            k.resume()
                        }
                    case .failed(let e):
                        if !once.mutate2({
                            let w = $0
                            $0 = true
                            return w
                        }) {
                            k.resume(throwing: e)
                        }
                    default: break
                    }
                }
                l.start(queue: s.queue)
            }
            return s
        }

        private func opened(_ c: NWConnection) {
            if let code = closeWith {
                let md = NWProtocolWebSocket.Metadata(opcode: .close)
                md.closeCode = .applicationCode(UInt16(code))
                c.send(
                    content: nil, contentContext: NWConnection.ContentContext(identifier: "close", metadata: [md]),
                    isComplete: true, completion: .contentProcessed { _ in })
                return
            }
            if let d = sendOnOpen { send(c, d) }
            echo(c)
        }

        private func send(_ c: NWConnection, _ d: Data) {
            let md = NWProtocolWebSocket.Metadata(opcode: .binary)
            c.send(
                content: d, contentContext: NWConnection.ContentContext(identifier: "m", metadata: [md]),
                isComplete: true, completion: .contentProcessed { _ in })
        }

        private func echo(_ c: NWConnection) {
            c.receiveMessage { [self] data, _, _, error in
                if let data, !data.isEmpty { send(c, data) }
                if error == nil { echo(c) }
            }
        }

        func stop() {
            listener.cancel()
            for c in lock.withLock({ conns }) { c.cancel() }
        }
    }
#endif

final class RelayPipeBudgetTests: XCTestCase {
    func testRelayInboundReservesAgainstTheSharedBudgetAndReleasesOnReadAndLoss() async throws {
        let budget = ConnectQueueBudget(limit: 1000)
        let a = RelayPipe(budget: budget)
        let b = RelayPipe(budget: budget)
        let over = LockedValue(0)
        a.onOverflow = { over.with { $0 += 1 } }
        b.onOverflow = { over.with { $0 += 1 } }
        let msg = Data(count: 400)  // framed: 402
        a.push(msg)
        b.push(msg)
        XCTAssertEqual(budget.used, 804)
        a.push(msg)  // would take the total past 1000, though the pipe itself is far under its cap
        XCTAssertEqual(over.current, 1)
        XCTAssertEqual(budget.used, 804)
        _ = try await a.read()
        XCTAssertEqual(budget.used, 402)
        b.lose()
        XCTAssertEqual(budget.used, 0)
    }
}
