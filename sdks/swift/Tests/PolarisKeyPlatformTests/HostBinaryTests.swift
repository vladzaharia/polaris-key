import Foundation
import XCTest

@testable import PolarisKeyPlatform
import PolarisKeyPlatformC

/// What the binary event callback received (a `@convention(c)` function cannot capture).
private let seen = PlatformLock<[(String, [UInt8])]>([])

private let onBinary: PlatformEventSink.BinaryCallback = { kind, p, n in
    let k = String(cString: kind)
    let bytes = p.map { Array(UnsafeBufferPointer(start: $0, count: n)) } ?? []
    seen.withLock { $0.append((k, bytes)) }
}

/// The binary entry (CC-14b.2, D-13): `PlatformHost.callBinary` over injected ops, and the three C
/// functions as a host calls them (null and length checks, ownership of the result, events).
final class HostBinaryTests: XCTestCase {
    private func host(_ ops: [String: PlatformBinaryOp]) -> PlatformHost {
        PlatformHost(services: .system(), binaryOps: ops)
    }

    private func run(_ h: PlatformHost, _ op: String, _ bytes: [UInt8]) -> [UInt8] {
        bytes.withUnsafeBufferPointer { h.callBinary(op, $0) }
    }

    func testUnknownOpAnswersEmpty() {
        let h = host(["rev": { Array($0.reversed()) }])
        XCTAssertEqual(run(h, "nope", [1, 2, 3]), [])
        XCTAssertEqual(run(h, "", [1]), [])
        XCTAssertEqual(run(h, "rev", [1, 2, 3]), [3, 2, 1])
        XCTAssertEqual(run(h, "rev", []), [])
    }

    func testInputAndOutputAreBounded() {
        let big = [UInt8](repeating: 7, count: PlatformHost.maxBinaryBytes)
        let h = host(["same": { Array($0) }, "grow": { _ in [UInt8](repeating: 1, count: PlatformHost.maxBinaryBytes + 1) }])
        XCTAssertEqual(run(h, "same", big).count, PlatformHost.maxBinaryBytes)
        XCTAssertEqual(run(h, "same", big + [0]), [])
        XCTAssertEqual(run(h, "grow", [1]), [])
    }

    func testBinaryBytesAreNotJSON() {
        let h = host(["same": { Array($0) }])
        let all = (0...255).map { UInt8($0) }
        XCTAssertEqual(run(h, "same", all), all)
        // A JSON call never reaches a binary op, and an unknown binary op is not a JSON op.
        XCTAssertEqual(h.handle(["op": "same"])["error"], "unknown_op")
    }

    func testCSurfaceChecksNullsAndLengths() {
        var outN = 99
        // The shared host has no binary ops yet: every op is unknown, answered NULL with 0 bytes.
        let unknown = "no_such_op".withCString { pkp_call_bin($0, [1, 2, 3], 3, &outN) }
        XCTAssertNil(unknown)
        XCTAssertEqual(outN, 0)
        outN = 99
        XCTAssertNil(pkp_call_bin(nil, [1], 1, &outN))
        XCTAssertEqual(outN, 0)
        XCTAssertNil("x".withCString { pkp_call_bin($0, nil, 5, &outN) })
        XCTAssertEqual(outN, 0)
        XCTAssertNil("x".withCString { pkp_call_bin($0, [1], -1, &outN) })
        XCTAssertNil("x".withCString { pkp_call_bin($0, [1], PlatformHost.maxBinaryBytes + 1, &outN) })
        XCTAssertNil("x".withCString { pkp_call_bin($0, nil, 0, &outN) })
        // A NULL out_n is refused, not dereferenced.
        XCTAssertNil("x".withCString { pkp_call_bin($0, [1], 1, nil) })
        pkp_free_bin(nil)
    }

    func testSelftestOpsExistOnlyWhenSwitchedOn() {
        let sink = PlatformEventSink()
        for env in [[:], ["PKEY_APPLE_SELFTEST": "0"]] as [[String: String]] {
            let ops = PlatformBinaryOps.system(sink: sink, environment: env)
            XCTAssertNil(ops["selftest_echo"])
            XCTAssertNil(ops["selftest_event"])
        }
        let h = PlatformHost(
            services: .system(), sink: sink,
            binaryOps: PlatformBinaryOps.system(sink: sink, environment: ["PKEY_APPLE_SELFTEST": "1"]))
        XCTAssertEqual(run(h, "selftest_echo", [4, 5, 6]), [4, 5, 6])
        XCTAssertEqual(run(h, "selftest_event", [1, 0, 2]), [])
        XCTAssertEqual(sink.drainBinary().map(\.0), ["selftest"])
    }

    func testBinaryEventsReachTheCallbackOrTheBuffer() {
        let sink = PlatformEventSink()
        sink.emitBinary("a", [1, 2])
        sink.emitBinary("b", [])
        let drained = sink.drainBinary()
        XCTAssertEqual(drained.map(\.0), ["a", "b"])
        XCTAssertEqual(drained[0].1, [1, 2])
        XCTAssertTrue(sink.drainBinary().isEmpty)
        for i in 0..<(PlatformEventSink.bufferLimit + 5) { sink.emitBinary("e\(i)", [UInt8(i % 256)]) }
        XCTAssertEqual(sink.drainBinary().count, PlatformEventSink.bufferLimit)

        seen.withLock { $0 = [] }
        pkp_set_bin_event_callback(onBinary)
        defer { pkp_set_bin_event_callback(nil) }
        PlatformHost.shared.sink.emitBinary("bj_data", [9, 8, 7])
        PlatformHost.shared.sink.emitBinary("bj_closed", [])
        let got = seen.withLock { $0 }
        XCTAssertEqual(got.map(\.0), ["bj_data", "bj_closed"])
        XCTAssertEqual(got[0].1, [9, 8, 7])
        XCTAssertEqual(got[1].1, [])
    }
}
