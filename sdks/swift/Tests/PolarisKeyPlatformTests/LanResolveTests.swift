// @pkey-feature connect.lan
// CC-IPV6.FB: the resolve-then-judge rule for a Bonjour browse hit (WIRE-CONTRACT-V5 §15.4, §15.4.1), pure.

import XCTest

@testable import PolarisKeyPlatform

final class LanResolveTests: XCTestCase {
    private func v6(_ s: String) -> [UInt8] {
        let g = LanAddr.parseV6(Array(s.utf8))!
        return g.flatMap { [UInt8($0 >> 8), UInt8($0 & 255)] }
    }

    private let en0 = LanInterface(
        index: 7, name: "en0",
        addresses: [
            LanInterfaceAddress(bytes: [192, 168, 1, 10], prefix: 24),
            LanInterfaceAddress(bytes: [0xFE, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], prefix: 64),
            LanInterfaceAddress(
                bytes: [0xFD, 0, 0, 1, 0, 2, 0, 3, 0, 0, 0, 0, 0, 0, 0, 9], prefix: 64),
        ])

    private func resolved(_ b: [UInt8], _ index: Int = 7) -> LanResolvedAddress {
        LanResolvedAddress(bytes: b, interfaceIndex: index)
    }

    private func run(_ rs: [LanResolvedAddress], _ ifaces: [LanInterface]? = nil, loopback: Bool = false) -> [String] {
        LanResolve.dialable(rs, interfaces: ifaces ?? [en0], allowLoopback: loopback).map(\.text)
    }

    func testAnAddressInAConnectedSubnetPasses() {
        XCTAssertEqual(run([resolved([192, 168, 1, 77])]), ["192.168.1.77"])
        XCTAssertEqual(
            run([resolved(v6("fe80::abcd"))]), ["fe80::abcd%en0"], "link-local is on-link, zone is the interface")
        XCTAssertEqual(run([resolved(v6("fd00:1:2:3::77"))]), ["fd00:1:2:3::77"])
    }

    func testAnAddressOutsideTheConnectedSubnetIsRefused() {
        // RFC 1918, so lanVerdict allows it; but another subnet than the interface's.
        XCTAssertEqual(run([resolved([10, 0, 0, 5]), resolved([192, 168, 2, 5])]), [])
        // A ULA of another /64 than the interface's own.
        XCTAssertEqual(run([resolved(v6("fd00:1:2:4::77"))]), [])
        // A global address with no own address in its /64.
        XCTAssertEqual(run([resolved(v6("2001:db8:1:2::5"))]), [])
    }

    func testLanVerdictStillDecides() {
        let wide = LanInterface(
            index: 7, name: "en0", addresses: [LanInterfaceAddress(bytes: [100, 64, 0, 1], prefix: 10)])
        XCTAssertEqual(run([resolved([100, 64, 3, 3])], [wide]), [], "CGNAT is in the subnet but not a LAN address")
        let ll = LanInterface(
            index: 7, name: "en0", addresses: [LanInterfaceAddress(bytes: [169, 254, 1, 1], prefix: 16)])
        XCTAssertEqual(run([resolved([169, 254, 9, 9])], [ll]), [])
    }

    func testTheAnswerMustComeBackOnAnInterfaceThatCounts() {
        XCTAssertEqual(run([resolved([192, 168, 1, 77], 99)]), [], "an interface the table does not know")
        let tun = LanInterface(index: 9, name: "utun3", tunnel: true, addresses: en0.addresses)
        XCTAssertEqual(run([resolved([192, 168, 1, 77], 9)], [tun]), [], "a tunnel never counts")
        let down = LanInterface(index: 7, name: "en0", up: false, addresses: en0.addresses)
        XCTAssertEqual(run([resolved([192, 168, 1, 77])], [down]), [])
        // The same address answered on interface 8 is judged against interface 8's subnets.
        let en1 = LanInterface(
            index: 8, name: "en1", addresses: [LanInterfaceAddress(bytes: [10, 0, 0, 2], prefix: 8)])
        XCTAssertEqual(run([resolved([192, 168, 1, 77], 8)], [en0, en1]), [])
        XCTAssertEqual(run([resolved([10, 4, 4, 4], 8)], [en0, en1]), ["10.4.4.4"])
    }

    func testLoopbackOnlyOnTheTestOptIn() {
        let lo = LanInterface(
            index: 1, name: "lo0", loopback: true, addresses: [LanInterfaceAddress(bytes: [127, 0, 0, 1], prefix: 8)])
        XCTAssertEqual(run([resolved([127, 0, 0, 1], 1)], [lo]), [])
        XCTAssertEqual(run([resolved([127, 0, 0, 1], 1)], [lo], loopback: true), ["127.0.0.1"])
    }

    func testFirstSeenOrderDeduplicatedAtMostFour() {
        let rs = (1...6).map { resolved([192, 168, 1, UInt8($0)]) }
        XCTAssertEqual(run([rs[0], rs[0]] + rs), ["192.168.1.1", "192.168.1.2", "192.168.1.3", "192.168.1.4"])
        XCTAssertEqual(run([resolved(v6("::ffff:192.168.1.5"))]), [], "a resolver answers IPv4 as A")
    }

    func testTheSrvPortRule() {
        XCTAssertFalse(LanResolve.portAllowed(0))
        XCTAssertFalse(LanResolve.portAllowed(1))
        XCTAssertFalse(LanResolve.portAllowed(1023))
        XCTAssertTrue(LanResolve.portAllowed(1024))
        XCTAssertTrue(LanResolve.portAllowed(65535))
        XCTAssertFalse(LanResolve.portAllowed(65536))
    }

    func testSubnetMath() {
        XCTAssertTrue(LanResolve.inSubnet([10, 1, 2, 3], LanInterfaceAddress(bytes: [10, 0, 0, 1], prefix: 8)))
        XCTAssertFalse(LanResolve.inSubnet([11, 1, 2, 3], LanInterfaceAddress(bytes: [10, 0, 0, 1], prefix: 8)))
        XCTAssertTrue(LanResolve.inSubnet([172, 16, 5, 5], LanInterfaceAddress(bytes: [172, 16, 0, 1], prefix: 20)))
        XCTAssertFalse(LanResolve.inSubnet([172, 16, 16, 5], LanInterfaceAddress(bytes: [172, 16, 0, 1], prefix: 20)))
        XCTAssertFalse(
            LanResolve.inSubnet([1, 2, 3, 4], LanInterfaceAddress(bytes: [1, 2, 3], prefix: 8)), "length mismatch")
        XCTAssertFalse(LanResolve.inSubnet([1, 2, 3, 4], LanInterfaceAddress(bytes: [1, 2, 3, 4], prefix: 33)))
    }
}
