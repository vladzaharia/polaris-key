// @pkey-feature connect.lan
// CC-14b.4: the Bonjour browse and advertise ops of the binary entry, against a fake browse driver
// (no network). The live advertise, browse and dial round trip runs only under PKEY_LIVE_BONJOUR=1.

import Foundation
import Network
import XCTest

@testable import PolarisKeyPlatform

#if canImport(Network)

    private final class Driver: BonjourBrowseDriver, @unchecked Sendable {
        private let lock = NSLock()
        private var emit: (@Sendable (BonjourDriverEvent) -> Void)?
        private var snap: [BonjourFound] = []
        private(set) var stops = 0

        func start(includePeerToPeer: Bool, emit: @escaping @Sendable (BonjourDriverEvent) -> Void) -> @Sendable () -> Void {
            lock.withLock { self.emit = emit }
            return { [self] in lock.withLock { stops += 1 } }
        }

        func send(_ e: BonjourDriverEvent) {
            if case .upserted(let f) = e { lock.withLock { snap += f } }
            lock.withLock { emit }?(e)
        }

        func snapshot() -> [BonjourFound] { lock.withLock { snap } }
    }

    private final class ConnBox: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [NWConnection] = []
        func add(_ c: NWConnection) { lock.withLock { all.append(c) } }
        func cancelAll() { lock.withLock { all.forEach { $0.cancel() } } }
    }

    private final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var v = false
        var value: Bool { lock.withLock { v } }
        func set() { lock.withLock { v = true } }
    }

    private func inst(_ i: Int) -> String {
        let a = Array("abcdefghijklmnopqrstuvwxyz234567")
        var s = "p1-"
        var n = i
        for _ in 0..<16 {
            s.append(a[n % 32])
            n /= 32
        }
        return s
    }

    private func row(_ i: Int) -> BonjourFound {
        BonjourFound(instance: inst(i), txt: ["v=1", "m=a"], endpoint: BonjourEndpoint(name: inst(i)))
    }

    final class BonjourHostTests: XCTestCase {
        private func run(_ ops: [String: PlatformBinaryOp], _ op: String, _ bytes: [UInt8]) -> [UInt8] {
            bytes.withUnsafeBufferPointer { ops[op]!($0) }
        }

        private func json(_ o: [String: Any]) -> [UInt8] { [UInt8](try! JSONSerialization.data(withJSONObject: o)) }

        private func make(
            _ driver: Driver = Driver(), check: BonjourBrowseError? = nil
        ) -> (ops: [String: PlatformBinaryOp], sink: PlatformEventSink, driver: Driver) {
            let sink = PlatformEventSink()
            let host = BonjourHost(sink: sink, makeDriver: { driver }, configurationCheck: { check })
            var ops: [String: PlatformBinaryOp] = [:]
            host.register(into: &ops)
            return (ops, sink, driver)
        }

        private func events(_ sink: PlatformEventSink) -> [(String, [String: Any])] {
            sink.drainBinary().map { k, d in
                (k, (try? JSONSerialization.jsonObject(with: Data(d)) as? [String: Any]) ?? [:])
            }
        }

        private func names(_ ids: [Int]) -> [UInt8] { ids.flatMap { Array(inst($0).utf8) } }

        func testFoundAndLostForAcceptedNamesOnly() {
            let m = make()
            XCTAssertEqual(run(m.ops, "bj_browse_start", json(["p2p": false])), [1])
            XCTAssertEqual(run(m.ops, "bj_browse_start", json([:])), [7], "one browse")
            // Nothing is accepted until the roster names arrive.
            m.driver.send(.upserted([row(1), row(2)]))
            XCTAssertTrue(events(m.sink).isEmpty)
            XCTAssertEqual(run(m.ops, "bj_accept", names([1])), [1])
            // The rescan offers the browser's current results: peer 1 appears, peer 2 does not.
            var ev = events(m.sink)
            XCTAssertEqual(ev.map(\.0), ["bj_found"])
            XCTAssertEqual(ev[0].1["instance"] as? String, inst(1))
            XCTAssertEqual(ev[0].1["txt"] as? [String], ["v=1", "m=a"])
            m.driver.send(.upserted([row(3)]))
            XCTAssertTrue(events(m.sink).isEmpty, "a forged name costs nothing")
            m.driver.send(.removed([inst(1)]))
            ev = events(m.sink)
            XCTAssertEqual(ev.map(\.0), ["bj_lost"])
            XCTAssertEqual(ev[0].1["instance"] as? String, inst(1))
        }

        func testBrowseStopStopsTheDriverAndSilencesIt() {
            let m = make()
            _ = run(m.ops, "bj_accept", names([1]))
            _ = run(m.ops, "bj_browse_start", json([:]))
            XCTAssertEqual(run(m.ops, "bj_browse_stop", []), [1])
            XCTAssertEqual(m.driver.stops, 1)
            m.driver.send(.upserted([row(1)]))
            XCTAssertTrue(events(m.sink).isEmpty)
            XCTAssertEqual(run(m.ops, "bj_browse_stop", []), [0])
            // It can start again.
            XCTAssertEqual(run(m.ops, "bj_browse_start", json([:])), [1])
        }

        func testErrorsAreMapped() {
            XCTAssertEqual(run(make(check: .notConfigured).ops, "bj_browse_start", json([:])), [5])
            XCTAssertEqual(run(make(check: .permissionDenied).ops, "bj_browse_start", json([:])), [4])
            XCTAssertEqual(run(make(check: .unavailable("x")).ops, "bj_browse_start", json([:])), [6])
            // A start that failed leaves room for the next one.
            let m = make(check: .notConfigured)
            XCTAssertEqual(run(m.ops, "bj_browse_start", json([:])), [5])
            XCTAssertEqual(run(m.ops, "bj_browse_start", json([:])), [5])
            // A permission refusal arrives later, as an event.
            let live = make()
            _ = run(live.ops, "bj_browse_start", json([:]))
            live.driver.send(.failed(.permissionDenied))
            let ev = events(live.sink)
            XCTAssertEqual(ev.map(\.0), ["bj_error"])
            XCTAssertEqual(ev[0].1["scope"] as? String, "browse")
            XCTAssertEqual(ev[0].1["error"] as? String, "permission_denied")
            XCTAssertEqual(BonjourHost.name(.notConfigured), "not_configured")
        }

        func testAdvertiseConfigurationErrorsAreSynchronous() {
            let advert = json(["instance": inst(1), "txt": ["v=1", "m=a"]])
            XCTAssertEqual(run(make(check: .notConfigured).ops, "bj_advertise_start", advert), [5])
            XCTAssertEqual(run(make(check: .permissionDenied).ops, "bj_advertise_start", advert), [4])
        }

        func testBadInputsAreRefused() {
            let m = make()
            let bad: [[UInt8]] = [
                [], Array("not json".utf8), Array("[1]".utf8), json(["instance": "p1-short", "txt": []]),
                json(["instance": inst(1)]), json(["instance": inst(1), "txt": Array(repeating: "a=b", count: 9)]),
                json(["instance": inst(1), "txt": [String(repeating: "x", count: 256)]]),
                json(["instance": inst(1), "txt": [""]]), json(["instance": inst(1), "txt": [5]]),
                [UInt8](repeating: 0x20, count: BonjourHost.maxControlBytes + 1),
            ]
            for b in bad {
                XCTAssertEqual(run(m.ops, "bj_advertise_start", b), [3], "\(b.count)")
                XCTAssertEqual(run(m.ops, "bj_advertise_update", b), [3])
            }
            XCTAssertEqual(run(m.ops, "bj_browse_start", []), [3])
            // Roster names: a wrong length, a bad character, too many.
            XCTAssertEqual(run(m.ops, "bj_accept", Array("p1-".utf8)), [3])
            XCTAssertEqual(run(m.ops, "bj_accept", Array("p1-AAAAAAAAAAAAAAAA".utf8)), [3])
            XCTAssertEqual(run(m.ops, "bj_accept", names(Array(0...BonjourHost.maxAccepted))), [3])
            XCTAssertEqual(run(m.ops, "bj_accept", names(Array(0..<BonjourHost.maxAccepted))), [1])
            XCTAssertEqual(run(m.ops, "bj_accept", []), [1], "an empty roster accepts nothing")
        }

        func testNothingRunningAnswersNone() {
            let m = make()
            XCTAssertEqual(run(m.ops, "bj_advertise_update", json(["instance": inst(1), "txt": []])), [0])
            XCTAssertEqual(run(m.ops, "bj_advertise_stop", []), [0])
            XCTAssertEqual(run(m.ops, "bj_stop_all", []), [1])
        }

        func testOpsAreRegisteredInTheSystemTable() {
            let ops = PlatformBinaryOps.system(sink: PlatformEventSink(), environment: [:])
            for op in ["bj_browse_start", "bj_browse_stop", "bj_accept", "bj_advertise_start", "bj_advertise_update", "bj_advertise_stop", "bj_stop_all", "bj_dial", "bj_send", "bj_credit", "bj_admit", "bj_close"] {
                XCTAssertNotNil(ops[op], op)
            }
        }

        func testLiveAdvertiseAndBrowse() async throws {
            try XCTSkipUnless(
                ProcessInfo.processInfo.environment["PKEY_LIVE_BONJOUR"] == "1", "set PKEY_LIVE_BONJOUR=1")
            let sink = PlatformEventSink()
            let host = BonjourHost(sink: sink, configurationCheck: { nil })
            var ops: [String: PlatformBinaryOp] = [:]
            host.register(into: &ops)
            let me = inst(31)
            _ = run(ops, "bj_accept", names([31]))
            XCTAssertEqual(run(ops, "bj_browse_start", json([:])), [1])
            XCTAssertEqual(run(ops, "bj_advertise_start", json(["instance": me, "txt": ["v=1", "m=a"]])), [1])
            var seen: [String] = []
            var advertised = false
            let end = Date().addingTimeInterval(15)
            while Date() < end, !(advertised && seen.contains("bj_found")) {
                for (k, p) in events(sink) {
                    seen.append(k)
                    if k == "bj_advertise" { advertised = p["ok"] as? Bool == true }
                }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            _ = run(ops, "bj_stop_all", [])
            XCTAssertTrue(advertised, "\(seen)")
            XCTAssertTrue(seen.contains("bj_found"), "\(seen)")
        }

        // MARK: pipes (CC-14b.5)

        private func idBytes(_ id: UInt32) -> [UInt8] { [UInt8(id >> 24 & 255), UInt8(id >> 16 & 255), UInt8(id >> 8 & 255), UInt8(id & 255)] }

        func testPipeOpsRefuseBadInputAndUnknownIds() {
            let m = make()
            XCTAssertEqual(run(m.ops, "bj_dial", json(["instance": "nope"])), [3])
            XCTAssertEqual(run(m.ops, "bj_dial", json(["instance": inst(1)])), [0], "not in the browse table")
            XCTAssertEqual(run(m.ops, "bj_send", [1, 2]), [3])
            XCTAssertEqual(run(m.ops, "bj_send", idBytes(77) + [1]), [0])
            XCTAssertEqual(run(m.ops, "bj_credit", idBytes(77)), [3])
            XCTAssertEqual(run(m.ops, "bj_credit", idBytes(77) + idBytes(5)), [0])
            XCTAssertEqual(run(m.ops, "bj_admit", [1]), [3])
            XCTAssertEqual(run(m.ops, "bj_admit", idBytes(77)), [0])
            XCTAssertEqual(run(m.ops, "bj_close", idBytes(77)), [3])
            XCTAssertEqual(run(m.ops, "bj_close", idBytes(77) + [2]), [3])
            XCTAssertEqual(run(m.ops, "bj_close", idBytes(77) + [0]), [0])
        }

        func testDialOfAnUnresolvableHitReportsClosedAndFreesTheSlot() async throws {
            let m = make()
            _ = run(m.ops, "bj_accept", names([1]))
            _ = run(m.ops, "bj_browse_start", json([:]))
            m.driver.send(.upserted([row(1)]))  // an endpoint with no network endpoint
            _ = events(m.sink)
            let r = run(m.ops, "bj_dial", json(["instance": inst(1)]))
            XCTAssertEqual(r.count, 5)
            XCTAssertEqual(r[0], 1)
            var got: [(String, [String: Any])] = []
            let end = Date().addingTimeInterval(5)
            while Date() < end, got.isEmpty {
                got = events(m.sink)
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            XCTAssertEqual(got.first?.0, "bj_closed")
            XCTAssertEqual(got.first?.1["reason"] as? String, "unresolvable")
            XCTAssertEqual(got.first?.1["id"] as? Int, Int(r[1]) << 24 | Int(r[2]) << 16 | Int(r[3]) << 8 | Int(r[4]))
            // The id is gone.
            XCTAssertEqual(run(m.ops, "bj_send", Array(r[1...4]) + [1]), [0])
        }

        func testThePipeTableIsBounded() {
            let host = BonjourHost(sink: PlatformEventSink(), configurationCheck: { nil })
            var held: [PipeState] = []
            for _ in 0..<BonjourHost.maxPipes { held.append(host.reserve()!) }
            XCTAssertNil(host.reserve())
            XCTAssertEqual(Set(held.map(\.id)).count, BonjourHost.maxPipes, "ids are unique")
        }

        func testSendQueueIsBoundedAndEndsWithThePipe() {
            let s = PipeState(id: 1)
            let chunk = Data(count: 1 << 20)
            for _ in 0..<4 { XCTAssertEqual(s.enqueue(chunk), .queued) }
            XCTAssertEqual(s.enqueue(Data([1])), .full, "4 MiB queued")
            XCTAssertTrue(s.finish())
            XCTAssertFalse(s.finish(), "once")
            XCTAssertEqual(s.enqueue(Data([1])), .closed)
            XCTAssertFalse(s.received(5))
        }

        func testReadingPausesAtTheWindowAndResumesOnCredit() async {
            let s = PipeState(id: 1)
            XCTAssertTrue(s.received(BonjourHost.readWindow))
            let resumed = Box()
            let task = Task {
                await s.waitForCredit()
                resumed.set()
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertFalse(resumed.value, "paused with a full window unread")
            s.credit(1000)
            await task.value
            XCTAssertTrue(resumed.value)
            // A pipe that ends releases a waiter too.
            XCTAssertTrue(s.received(BonjourHost.readWindow))
            let t2 = Task { await s.waitForCredit() }
            try? await Task.sleep(nanoseconds: 50_000_000)
            _ = s.finish()
            await t2.value
        }

        func testLivePipeRoundTrip() async throws {
            try XCTSkipUnless(
                ProcessInfo.processInfo.environment["PKEY_LIVE_BONJOUR"] == "1", "set PKEY_LIVE_BONJOUR=1")
            let sinkA = PlatformEventSink(), sinkB = PlatformEventSink()
            let a = BonjourHost(sink: sinkA, allowLoopback: true, configurationCheck: { nil })
            let b = BonjourHost(sink: sinkB, allowLoopback: true, configurationCheck: { nil })
            var oa: [String: PlatformBinaryOp] = [:], ob: [String: PlatformBinaryOp] = [:]
            a.register(into: &oa)
            b.register(into: &ob)
            let me = inst(29)
            _ = run(ob, "bj_accept", names([29]))
            XCTAssertEqual(run(ob, "bj_browse_start", json([:])), [1])
            XCTAssertEqual(run(oa, "bj_advertise_start", json(["instance": me, "txt": ["v=1", "m=a"]])), [1])
            func wait(_ sink: PlatformEventSink, _ kind: String) async throws -> (String, [UInt8])? {
                let end = Date().addingTimeInterval(20)
                while Date() < end {
                    for e in sink.drainBinary() {
                        if e.0 == kind { return e }
                        FileHandle.standardError.write(Data("LIVE other event \(e.0) \(String(decoding: e.1.prefix(120), as: UTF8.self))\n".utf8))
                    }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                return nil
            }
            let adv = try await wait(sinkA, "bj_advertise")
            let port = (try JSONSerialization.jsonObject(with: Data(adv!.1)) as! [String: Any])["port"] as! Int
            // The pipe path over the listener's own port. The OS-resolved dial of the browse hit is
            // exercised on two Macs; here the same process cannot be relied on to reach itself through
            // the service (a CGNAT or VPN interface address is refused by the LAN policy, G6).
            let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port))!)
            b.learn(me, BonjourEndpoint(name: me, network: endpoint))
            let d = run(ob, "bj_dial", json(["instance": me]))
            XCTAssertEqual(d.first, 1, "\(d)")
            let idB = Array(d[1...4])
            let open = try await wait(sinkB, "bj_open")
            XCTAssertNotNil(open)
            let acc = try await wait(sinkA, "bj_accepted")
            let accJSON = try JSONSerialization.jsonObject(with: Data(acc!.1)) as! [String: Any]
            let idA = idBytes(UInt32(accJSON["id"] as! Int))
            XCTAssertEqual(run(oa, "bj_admit", idA), [1])
            XCTAssertEqual(run(ob, "bj_send", idB + Array("hello".utf8)), [1])
            let got = try await wait(sinkA, "bj_data")
            XCTAssertEqual(Array(got!.1.dropFirst(4)), Array("hello".utf8))
            XCTAssertEqual(run(oa, "bj_credit", idA + [0, 0, 0, 5]), [1])
            XCTAssertEqual(run(oa, "bj_send", idA + Array("world".utf8)), [1])
            let back = try await wait(sinkB, "bj_data")
            XCTAssertEqual(Array(back!.1.dropFirst(4)), Array("world".utf8))
            XCTAssertEqual(run(ob, "bj_close", idB + [0]), [1])
            let closed = try await wait(sinkA, "bj_closed")
            XCTAssertNotNil(closed)
            _ = run(oa, "bj_stop_all", [])
            _ = run(ob, "bj_stop_all", [])
        }

        // MARK: write drain, pipe deadlines, roster shrink

        func testASendBetweenTheLastChunkAndTheEndOfTheDrainStartsANewDrainer() {
            let s = PipeState(id: 1)
            let nw = host.reserve()  // a table slot only; the state under test is standalone
            XCTAssertNotNil(nw)
            // PipeState.startDrain needs a pipe; the interleaving is the queue and flag, so use the flags.
            XCTAssertEqual(s.enqueue(Data([1])), .queued)
            XCTAssertTrue(s.testStartDrain())
            XCTAssertNotNil(s.nextChunk())
            XCTAssertNil(s.nextChunk(), "queue empty: the drainer is told so and the flag is cleared together")
            // The send that lands now must start a drainer of its own.
            XCTAssertEqual(s.enqueue(Data([2])), .queued)
            XCTAssertTrue(s.testStartDrain(), "no lost wake-up")
            XCTAssertNotNil(s.nextChunk())
            XCTAssertFalse(s.testStartDrain(), "one drainer at a time while a chunk is out")
        }

        private let host = BonjourHost(sink: PlatformEventSink(), configurationCheck: { nil })

        func testAGracefulCloseThatNeverDrainsIsReclaimed() async throws {
            let sink = PlatformEventSink()
            let h = BonjourHost(sink: sink, closeSeconds: 0.2, configurationCheck: { nil })
            var ops: [String: PlatformBinaryOp] = [:]
            h.register(into: &ops)
            var held: [PipeState] = []
            for _ in 0..<BonjourHost.maxPipes { held.append(h.reserve()!) }
            XCTAssertNil(h.reserve(), "the table is full")
            let id = idBytes(held[0].id)
            // Queued bytes and no pipe to send them on: the close cannot complete by itself.
            XCTAssertEqual(run(ops, "bj_send", id + [1, 2, 3]), [1])
            XCTAssertEqual(run(ops, "bj_close", id + [0]), [1])
            XCTAssertEqual(run(ops, "bj_send", id + [4]), [0], "closing takes no more writes")
            try await Task.sleep(nanoseconds: 500_000_000)
            XCTAssertTrue(held[0].isFinished)
            XCTAssertNotNil(h.reserve(), "the slot came back")
        }

        func testAStalledWriteIsAbandonedAfterItsDeadline() async throws {
            let listener = try NWListener(using: .tcp, on: .any)
            let conns = ConnBox()
            listener.newConnectionHandler = { c in
                conns.add(c)
                c.start(queue: .global())  // accepted and never read
            }
            let ready = DispatchSemaphore(value: 0)
            listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
            listener.start(queue: .global())
            XCTAssertEqual(ready.wait(timeout: .now() + 5), .success)
            let port = listener.port!
            let pipe = try await BonjourPipes.dial(
                .hostPort(host: "127.0.0.1", port: port),
                options: BonjourDialOptions(policy: BonjourDialPolicy(allowLoopback: true)))
            let t0 = Date()
            let ok = await BonjourHost.write(pipe, Data(count: 64 << 20), seconds: 0.5)
            XCTAssertFalse(ok)
            XCTAssertLessThan(Date().timeIntervalSince(t0), 5)
            listener.cancel()
            conns.cancelAll()
        }

        func testARosterShrinkRetiresFoundRows() {
            let m = make()
            _ = run(m.ops, "bj_accept", names([1, 2]))
            _ = run(m.ops, "bj_browse_start", json([:]))
            m.driver.send(.upserted([row(1), row(2)]))
            XCTAssertEqual(events(m.sink).map(\.0), ["bj_found", "bj_found"])
            XCTAssertEqual(run(m.ops, "bj_accept", names([1])), [1])
            let ev = events(m.sink)
            XCTAssertEqual(ev.map(\.0), ["bj_lost"])
            XCTAssertEqual(ev[0].1["instance"] as? String, inst(2))
            XCTAssertEqual(run(m.ops, "bj_dial", json(["instance": inst(2)])), [0], "no longer dialable")
        }
    }

#endif
