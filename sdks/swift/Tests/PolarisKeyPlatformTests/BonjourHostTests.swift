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

        func start(includePeerToPeer: Bool, emit: @escaping @Sendable (BonjourDriverEvent) -> Void)
            -> @Sendable () -> Void
        {
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
        func cancelAll() {
            lock.withLock {
                for conn in all { conn.cancel() }
            }
        }
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
            for op in [
                "bj_browse_start", "bj_browse_stop", "bj_accept", "bj_advertise_start", "bj_advertise_update",
                "bj_advertise_stop", "bj_contacts", "bj_locals", "bj_accept_tags", "bj_caps", "bj_stop_all", "bj_dial", "bj_send",
                "bj_credit", "bj_admit", "bj_close",
            ] {
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

        private func idBytes(_ id: UInt32) -> [UInt8] {
            [UInt8(id >> 24 & 255), UInt8(id >> 16 & 255), UInt8(id >> 8 & 255), UInt8(id & 255)]
        }

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
            let sinkA = PlatformEventSink()
            let sinkB = PlatformEventSink()
            let a = BonjourHost(sink: sinkA, allowLoopback: true, configurationCheck: { nil })
            let b = BonjourHost(sink: sinkB, allowLoopback: true, configurationCheck: { nil })
            var oa: [String: PlatformBinaryOp] = [:]
            var ob: [String: PlatformBinaryOp] = [:]
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
                        FileHandle.standardError.write(
                            Data("LIVE other event \(e.0) \(String(decoding: e.1.prefix(120), as: UTF8.self))\n".utf8))
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

        // MARK: discovery slots (CC-15b.GA)

        private func tagged(_ i: Int, m: String, h: String) -> BonjourFound {
            BonjourFound(
                instance: inst(i), txt: ["v=1", "m=\(m)", "h=\(h)"], endpoint: BonjourEndpoint(name: inst(i)))
        }

        func testCapsAnswerOneSlotPerKind() {
            let m = make()
            XCTAssertEqual(String(decoding: run(m.ops, "bj_caps", []), as: UTF8.self), #"{"slots":1,"local":1}"#)
        }

        func testSlotsAreValidatedAndEachHasItsOwnListener() {
            let m = make()
            let bad = json(["slot": "x", "instance": inst(1), "txt": []])
            XCTAssertEqual(run(m.ops, "bj_advertise_start", bad), [3])
            XCTAssertEqual(run(m.ops, "bj_advertise_update", bad), [3])
            XCTAssertEqual(run(m.ops, "bj_advertise_stop", json(["slot": "c0"])), [3])
            XCTAssertEqual(run(m.ops, "bj_advertise_stop", json(["slot": 5])), [3])
            for slot in ["a", "v", "p"] {
                let body = json(["slot": slot, "instance": inst(1), "txt": ["v=1"]])
                XCTAssertEqual(run(m.ops, "bj_advertise_start", body), [1], slot)
                XCTAssertEqual(run(m.ops, "bj_advertise_start", body), [7], "one advert per slot: \(slot)")
            }
            XCTAssertEqual(run(m.ops, "bj_advertise_stop", json(["slot": "v"])), [1])
            XCTAssertEqual(run(m.ops, "bj_advertise_stop", json(["slot": "v"])), [0])
            XCTAssertEqual(run(m.ops, "bj_advertise_start", json(["slot": "v", "instance": inst(2), "txt": []])), [1])
            XCTAssertEqual(run(m.ops, "bj_stop_all", []), [1])
            XCTAssertEqual(run(m.ops, "bj_advertise_stop", json(["slot": "p"])), [0])
        }

        func testContactsAreBoundedAndFollowSlotAsPort() {
            let contacts = BonjourContactAdverts()
            let sink = PlatformEventSink()
            let host = BonjourHost(
                sink: sink, makeDriver: { Driver() }, configurationCheck: { nil }, contacts: contacts)
            var ops: [String: PlatformBinaryOp] = [:]
            host.register(into: &ops)
            defer { _ = run(ops, "bj_stop_all", []) }
            let base = Int(UInt32.random(in: 1000...1_000_000))
            func advert(_ i: Int) -> [String: Any] { ["instance": inst(base + i), "txt": ["v=1", "m=c"]] }
            func set(_ n: Int) -> [UInt8] { run(ops, "bj_contacts", json(["adverts": (0..<n).map(advert)])) }
            XCTAssertEqual(run(ops, "bj_contacts", []), [3])
            XCTAssertEqual(run(ops, "bj_contacts", json(["adverts": 5])), [3])
            XCTAssertEqual(set(9), [3], "at most 8")
            XCTAssertEqual(run(ops, "bj_contacts", json(["adverts": [advert(1), advert(1)]])), [3], "no repeats")
            XCTAssertEqual(run(ops, "bj_contacts", json(["adverts": [["instance": "x", "txt": []]]])), [3])
            // No slot-a port: the set is held, nothing is registered.
            XCTAssertEqual(set(3), [1])
            XCTAssertTrue(contacts.names.isEmpty)
            host.learnPort("a", 40_201)
            XCTAssertEqual(contacts.names.count, 3)
            XCTAssertEqual(Set(contacts.ports.values), [40_201])
            // A smaller set replaces the whole; a new port moves what is kept.
            XCTAssertEqual(set(2), [1])
            XCTAssertEqual(contacts.names.count, 2)
            host.learnPort("a", 40_202)
            XCTAssertEqual(Set(contacts.ports.values), [40_202])
            // Stopping slot a withdraws them; slot a coming back registers the same set again.
            XCTAssertEqual(run(ops, "bj_advertise_stop", []), [0])
            XCTAssertTrue(contacts.names.isEmpty)
            host.learnPort("a", 40_203)
            XCTAssertEqual(Set(contacts.ports.values), [40_203])
            XCTAssertEqual(set(0), [1])
            XCTAssertTrue(contacts.names.isEmpty)
            XCTAssertEqual(set(1), [1])
            XCTAssertEqual(contacts.names.count, 1)
            // bj_stop_all withdraws them and forgets the set.
            XCTAssertEqual(run(ops, "bj_stop_all", []), [1])
            XCTAssertTrue(contacts.names.isEmpty)
            host.learnPort("a", 40_204)
            XCTAssertTrue(contacts.names.isEmpty)
        }

        func testLocalSlotsAndTheirExtraNamesFollowSlotLPort() {
            let locals = BonjourContactAdverts()
            let sink = PlatformEventSink()
            let host = BonjourHost(
                sink: sink, makeDriver: { Driver() }, configurationCheck: { nil }, locals: locals)
            var ops: [String: PlatformBinaryOp] = [:]
            host.register(into: &ops)
            defer { _ = run(ops, "bj_stop_all", []) }
            let caps = try? JSONSerialization.jsonObject(with: Data(run(ops, "bj_caps", []))) as? [String: Int]
            XCTAssertEqual(caps?["local"], 1)
            let base = Int(UInt32.random(in: 1000...1_000_000))
            func advert(_ i: Int) -> [String: Any] { ["instance": inst(base + i), "txt": ["v=1", "m=l"]] }
            func set(_ n: Int) -> [UInt8] { run(ops, "bj_locals", json(["adverts": (0..<n).map(advert)])) }
            XCTAssertEqual(run(ops, "bj_locals", []), [3])
            XCTAssertEqual(set(8), [3], "at most 7 beside slot l's own name")
            XCTAssertEqual(run(ops, "bj_locals", json(["adverts": [advert(1), advert(1)]])), [3], "no repeats")
            XCTAssertEqual(set(3), [1])
            XCTAssertTrue(locals.names.isEmpty, "no slot-l port yet")
            host.learnPort("l", 40_301)
            XCTAssertEqual(locals.names.count, 3)
            XCTAssertEqual(Set(locals.ports.values), [40_301])
            host.learnPort("a", 40_302)
            XCTAssertEqual(Set(locals.ports.values), [40_301], "slot a's port does not move them")
            XCTAssertEqual(run(ops, "bj_advertise_stop", json(["slot": "l"])), [0])
            XCTAssertTrue(locals.names.isEmpty)
            XCTAssertEqual(run(ops, "bj_advertise_stop", json(["slot": "q"])), [0], "slot q is a known slot")
            XCTAssertEqual(run(ops, "bj_advertise_stop", json(["slot": "x"])), [3])
            host.learnPort("l", 40_303)
            XCTAssertEqual(Set(locals.ports.values), [40_303])
            XCTAssertEqual(run(ops, "bj_stop_all", []), [1])
            XCTAssertTrue(locals.names.isEmpty)
            host.learnPort("l", 40_304)
            XCTAssertTrue(locals.names.isEmpty)
            let tag = "0123456789abcdef"
            XCTAssertEqual(run(ops, "bj_accept_tags", json(["q": [tag]])), [1])
            XCTAssertEqual(run(ops, "bj_accept_tags", json(["l": [tag]])), [3], "l has no tag kind")
        }

        func testTagsAdmitAResultByItsTxtAndAreBounded() {
            let m = make()
            let h1 = "0123456789abcdef"
            let h2 = "fedcba9876543210"
            _ = run(m.ops, "bj_browse_start", json([:]))
            m.driver.send(
                .upserted([
                    tagged(1, m: "v", h: h1), tagged(2, m: "v", h: h2), tagged(3, m: "p", h: h1),
                    tagged(4, m: "a", h: h1),
                ]))
            XCTAssertTrue(events(m.sink).isEmpty, "no tags, no roster: nothing enters")
            XCTAssertEqual(run(m.ops, "bj_accept_tags", json(["v": [h1], "p": []])), [1])
            var ev = events(m.sink)
            XCTAssertEqual(ev.map(\.0), ["bj_found"], "the rescan admits the match only")
            XCTAssertEqual(ev[0].1["instance"] as? String, inst(1))
            m.driver.send(.upserted([tagged(5, m: "v", h: h1), tagged(6, m: "v", h: "ffffffffffffffff")]))
            XCTAssertEqual(events(m.sink).compactMap { $0.1["instance"] as? String }, [inst(5)])
            // The previous tag too; a kind does not borrow the other's tag.
            XCTAssertEqual(run(m.ops, "bj_accept_tags", json(["v": [h1, h2], "p": [h1]])), [1])
            XCTAssertEqual(Set(events(m.sink).compactMap { $0.1["instance"] as? String }), [inst(2), inst(3)])
            // A roster name still enters whatever its TXT.
            _ = run(m.ops, "bj_accept", names([4]))
            XCTAssertEqual(events(m.sink).compactMap { $0.1["instance"] as? String }, [inst(4)])
            // Dropping a tag retires what only it admitted; the roster's row stays.
            XCTAssertEqual(run(m.ops, "bj_accept_tags", json(["v": [h2]])), [1])
            ev = events(m.sink)
            XCTAssertEqual(Set(ev.compactMap { $0.1["instance"] as? String }), [inst(1), inst(3), inst(5)])
            XCTAssertEqual(Set(ev.map(\.0)), ["bj_lost"])
        }

        func testBadTagListsAreRefusedAndClearTheTags() {
            let m = make()
            let h = "0123456789abcdef"
            _ = run(m.ops, "bj_browse_start", json([:]))
            XCTAssertEqual(run(m.ops, "bj_accept_tags", json(["v": [h]])), [1])
            m.driver.send(.upserted([tagged(1, m: "v", h: h)]))
            XCTAssertEqual(events(m.sink).map(\.0), ["bj_found"])
            let bad: [[UInt8]] = [
                [], Array("[]".utf8), json(["v": [h, h, h]]), json(["v": ["0123"]]), json(["v": ["0123456789ABCDEF"]]),
                json(["v": [5]]), json(["v": h]), json(["x": [h]]),
                [UInt8](repeating: 0x20, count: BonjourHost.maxControlBytes + 1),
            ]
            for b in bad {
                XCTAssertEqual(run(m.ops, "bj_accept_tags", b), [3], "\(b.count)")
            }
            XCTAssertEqual(events(m.sink).map(\.0), ["bj_lost"], "a bad list leaves no tag in force")
            m.driver.send(.upserted([tagged(2, m: "v", h: h)]))
            XCTAssertTrue(events(m.sink).isEmpty)
        }

        func testTagRowsHaveTheirOwnBoundedPartition() {
            let m = make()
            let h = "0123456789abcdef"
            _ = run(m.ops, "bj_browse_start", json([:]))
            _ = run(m.ops, "bj_accept_tags", json(["v": [h]]))
            m.driver.send(.upserted((0..<(BonjourTable.maxTagged + 20)).map { tagged($0, m: "v", h: h) }))
            let ev = events(m.sink)
            XCTAssertEqual(ev.filter { $0.0 == "bj_found" }.count, BonjourTable.maxTagged + 20)
            XCTAssertEqual(ev.filter { $0.0 == "bj_lost" }.count, 20, "the oldest tag rows leave: 32 at most")
        }

        func testTaggedRowsNeverEvictARosterRow() {
            let m = make()
            let h = "0123456789abcdef"
            _ = run(m.ops, "bj_browse_start", json([:]))
            XCTAssertEqual(run(m.ops, "bj_accept", names([1])), [1])
            _ = run(m.ops, "bj_accept_tags", json(["v": [h]]))
            m.driver.send(.upserted([tagged(1, m: "a", h: "ffffffffffffffff")]))
            XCTAssertEqual(events(m.sink).compactMap { $0.1["instance"] as? String }, [inst(1)])
            var lost: [String] = []
            for start in stride(from: 100, to: 100 + BonjourTable.maxInstances + 50, by: 50) {
                m.driver.send(.upserted((start..<(start + 50)).map { tagged($0, m: "v", h: h) }))
                lost += events(m.sink).filter { $0.0 == "bj_lost" }.compactMap { $0.1["instance"] as? String }
            }
            XCTAssertFalse(lost.contains(inst(1)), "the roster peer stays")
            // A later tagged approver still enters once the partition is full of older strangers.
            m.driver.send(.upserted([tagged(900, m: "v", h: h)]))
            XCTAssertEqual(
                events(m.sink).filter { $0.0 == "bj_found" }.compactMap { $0.1["instance"] as? String }, [inst(900)])
        }

        // MARK: the table itself (presence is read from the table, not from the event sink)

        private func found(_ i: Int, txt: [String] = []) -> BonjourFound {
            BonjourFound(instance: inst(i), txt: txt, endpoint: BonjourEndpoint(name: inst(i)))
        }

        func testTableTaggedRowsNeverEvictRosterRowsAndTheReverse() {
            var table = BonjourTable()
            _ = table.upsert(found(0))
            for i in 1...300 { _ = table.upsert(found(1000 + i), tagged: true) }
            XCTAssertNotNil(table.row(inst(0)), "300 tagged strangers leave the roster row in the table")
            XCTAssertEqual(table.count, 1 + BonjourTable.maxTagged)
            for i in 1...300 { _ = table.upsert(found(2000 + i)) }
            XCTAssertEqual(table.count, BonjourTable.maxInstances + BonjourTable.maxTagged)
            for i in 269...300 { XCTAssertNotNil(table.row(inst(1000 + i)), "roster rows never evict tagged rows") }
        }

        func testTableRefreshOfAKnownRowEvictsNothing() {
            var table = BonjourTable()
            for i in 0..<BonjourTable.maxInstances { _ = table.upsert(found(i)) }
            for i in 0..<BonjourTable.maxTagged { _ = table.upsert(found(5000 + i), tagged: true) }
            let before = table.instances
            XCTAssertTrue(table.upsert(found(7)).isEmpty, "an unchanged roster refresh changes nothing")
            let changed = table.upsert(found(8, txt: ["m=a"]))
            XCTAssertEqual(changed, [.up(found(8, txt: ["m=a"]))], "a changed refresh reports only its own row")
            XCTAssertTrue(table.upsert(found(5003), tagged: true).isEmpty)
            XCTAssertEqual(Set(table.instances), Set(before))
            XCTAssertEqual(table.count, BonjourTable.maxInstances + BonjourTable.maxTagged)
            // A row that moves from the tag partition to the roster takes a roster place, evicting the oldest roster row.
            let moved = table.upsert(found(5004))
            XCTAssertEqual(moved.filter { if case .down = $0 { return true } else { return false } }.count, 1)
        }
    }

#endif
