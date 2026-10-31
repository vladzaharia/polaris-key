// @pkey-feature connect.lan
// CC-14b.4: the Bonjour browse and advertise ops of the binary entry, against a fake browse driver
// (no network). The live advertise, browse and dial round trip runs only under PKEY_LIVE_BONJOUR=1.

import Foundation
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
            for op in ["bj_browse_start", "bj_browse_stop", "bj_accept", "bj_advertise_start", "bj_advertise_update", "bj_advertise_stop", "bj_stop_all"] {
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
    }

#endif
