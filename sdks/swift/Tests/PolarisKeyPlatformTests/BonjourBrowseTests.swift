// @pkey-feature connect.lan
// CC-11.7: Bonjour browse against a fake driver (no network). The live browse runs only under
// PKEY_LIVE_BONJOUR=1.

import Foundation
import XCTest

@testable import PolarisKeyPlatform

private final class FakeDriver: BonjourBrowseDriver, @unchecked Sendable {
    private let lock = NSLock()
    private var _emit: (@Sendable (BonjourDriverEvent) -> Void)?
    private(set) var p2p: Bool?
    private(set) var starts = 0
    private(set) var stops = 0

    func start(includePeerToPeer: Bool, emit: @escaping @Sendable (BonjourDriverEvent) -> Void) -> @Sendable () -> Void
    {
        lock.withLock {
            _emit = emit
            p2p = includePeerToPeer
            starts += 1
        }
        return { [self] in lock.withLock { stops += 1 } }
    }

    private var _snap: [BonjourFound] = []
    func send(_ e: BonjourDriverEvent) {
        if case .upserted(let f) = e { lock.withLock { _snap += f } }
        lock.withLock { _emit }?(e)
    }
    func snapshot() -> [BonjourFound] { lock.withLock { _snap } }
}

private final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var _up: [BonjourFound] = []
    private var _down: [String] = []
    private var _err: [BonjourBrowseError] = []
    var up: [BonjourFound] { lock.withLock { _up } }
    var down: [String] { lock.withLock { _down } }
    var err: [BonjourBrowseError] { lock.withLock { _err } }
    func add(up f: BonjourFound) { lock.withLock { _up.append(f) } }
    func add(down n: String) { lock.withLock { _down.append(n) } }
    func add(err e: BonjourBrowseError) { lock.withLock { _err.append(e) } }
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

private func found(_ i: Int, txt: [String] = ["v=1", "m=a"]) -> BonjourFound {
    BonjourFound(instance: inst(i), txt: txt, endpoint: BonjourEndpoint(name: inst(i)))
}

final class BonjourBrowseTests: XCTestCase {
    private func make(_ d: FakeDriver, p2p: Bool = false, config: BonjourBrowseError? = nil) -> (BonjourBrowse, Log) {
        let b = BonjourBrowse(
            options: BonjourBrowseOptions(peerToPeer: p2p), driver: d, configurationCheck: { config })
        return (b, Log())
    }

    private func start(_ b: BonjourBrowse, _ l: Log) throws {
        try b.start(onUp: { l.add(up: $0) }, onDown: { l.add(down: $0) }, onError: { l.add(err: $0) })
    }

    func testPeerToPeerIsOffByDefaultAndOptIn() throws {
        let d = FakeDriver()
        var (b, l) = make(d)
        try start(b, l)
        XCTAssertEqual(d.p2p, false)
        let d2 = FakeDriver()
        (b, l) = make(d2, p2p: true)
        try start(b, l)
        XCTAssertEqual(d2.p2p, true)
    }

    func testAHitIsReportedOnceAndWithdrawnWhenItGoes() throws {
        let d = FakeDriver()
        let (b, l) = make(d)
        try start(b, l)
        d.send(.upserted([found(1)]))
        d.send(.upserted([found(1)]))  // identical: no second event
        XCTAssertEqual(l.up, [found(1)])
        d.send(.upserted([found(1, txt: ["v=1", "m=v", "h=0123456789abcdef"])]))
        XCTAssertEqual(l.up.count, 2, "a changed TXT is a new hit")
        d.send(.removed([inst(1), inst(2)]))
        XCTAssertEqual(l.down, [inst(1)], "only a known instance goes down")
    }

    func testAnInstanceNameOfAnotherShapeIsDropped() throws {
        let d = FakeDriver()
        let (b, l) = make(d)
        try start(b, l)
        let bad = [
            "", "p1-", "p2-aaaaaaaaaaaaaaaa", "p1-AAAAAAAAAAAAAAAA", "p1-aaaaaaaaaaaaaaa1", "p1-aaaaaaaaaaaaaaaaa",
            "MacBook",
        ]
        d.send(.upserted(bad.map { BonjourFound(instance: $0, txt: [], endpoint: BonjourEndpoint(name: $0)) }))
        XCTAssertTrue(l.up.isEmpty)
    }

    func testTxtIsCutToEightEntries() throws {
        let d = FakeDriver()
        let (b, l) = make(d)
        try start(b, l)
        d.send(.upserted([found(1, txt: (0..<20).map { "k\($0)=v" })]))
        XCTAssertEqual(l.up.first?.txt.count, 8)
    }

    func testTheTableHoldsAtMost256AndEvictsTheLeastRecentlyRefreshed() throws {
        let d = FakeDriver()
        let (b, l) = make(d)
        try start(b, l)
        d.send(.upserted((0..<256).map { found($0) }))
        XCTAssertEqual(l.up.count, 256)
        // Refresh instance 0 so instance 1 is now the oldest.
        d.send(.upserted([found(0, txt: ["v=1", "m=a", "x=y"])]))
        d.send(.upserted([found(1000)]))
        XCTAssertEqual(l.down, [inst(1)])
        XCTAssertEqual(l.up.last, found(1000))
        // The evicted one comes back as a new hit once seen again, evicting the next oldest.
        d.send(.upserted([found(1)]))
        XCTAssertEqual(l.down, [inst(1), inst(2)])
    }

    /// S2: match first, then store. Forged names never take a slot, so they cannot evict a real peer.
    func testOnlyAcceptedNamesEnterTheTable() throws {
        let d = FakeDriver()
        let real = inst(7)
        let b = BonjourBrowse(driver: d, configurationCheck: { nil }, accept: { $0 == real })
        let l = Log()
        try start(b, l)
        d.send(.upserted([found(7)]))
        d.send(.upserted((1000..<1600).map { found($0) }))
        XCTAssertEqual(l.up, [found(7)])
        XCTAssertEqual(l.down, [], "the real peer is not evicted")
    }

    /// A peer seen before the roster listed it enters the table on `rescan`, with no new browse event.
    func testRescanAdmitsAPeerSeenBeforeItWasKnown() throws {
        let d = FakeDriver()
        let known = PlatformLock(Set<String>())
        let b = BonjourBrowse(
            driver: d, configurationCheck: { nil }, accept: { name in known.withLock { s in s.contains(name) } })
        let l = Log()
        try start(b, l)
        d.send(.upserted([found(7), found(8)]))
        XCTAssertEqual(l.up, [])
        b.rescan()
        XCTAssertEqual(l.up, [], "still unknown")
        known.withLock { $0 = [inst(7)] }
        b.rescan()
        XCTAssertEqual(l.up, [found(7)])
        b.rescan()
        XCTAssertEqual(l.up, [found(7)], "reported once")
        b.stop()
        known.withLock { $0 = [inst(7), inst(8)] }
        b.rescan()
        XCTAssertEqual(l.up, [found(7)], "nothing after stop")
    }

    func testPolicyDeniedAndNoAuthAreClassified() {
        XCTAssertEqual(BonjourErrors.classify(dnsError: -65570), .permissionDenied)
        XCTAssertEqual(BonjourErrors.classify(dnsError: -65555), .notConfigured)
        XCTAssertEqual(BonjourErrors.classify(dnsError: -65563), .unavailable("dns-sd error -65563"))
    }

    func testAFailureFromTheDriverReachesOnError() throws {
        let d = FakeDriver()
        let (b, l) = make(d)
        try start(b, l)
        d.send(.failed(.permissionDenied))
        XCTAssertEqual(l.err, [.permissionDenied])
    }

    func testAMissingPlistEntryThrowsBeforeTheDriverStarts() {
        let d = FakeDriver()
        let (b, l) = make(d, config: .notConfigured)
        XCTAssertThrowsError(try start(b, l)) { XCTAssertEqual($0 as? BonjourBrowseError, .notConfigured) }
        XCTAssertEqual(d.starts, 0)
    }

    func testThePlistCheck() {
        let ok: [String: Any] = [
            "NSBonjourServices": ["_pkeypeer._tcp"], "NSLocalNetworkUsageDescription": "Find your other devices.",
        ]
        XCTAssertNil(BonjourErrors.configurationError(infoDictionary: ok, requiresPlist: true))
        XCTAssertNil(
            BonjourErrors.configurationError(infoDictionary: nil, requiresPlist: false), "macOS needs neither key")
        XCTAssertEqual(BonjourErrors.configurationError(infoDictionary: nil, requiresPlist: true), .notConfigured)
        XCTAssertEqual(
            BonjourErrors.configurationError(
                infoDictionary: ["NSBonjourServices": ["_other._tcp"], "NSLocalNetworkUsageDescription": "x"],
                requiresPlist: true),
            .notConfigured)
        XCTAssertEqual(
            BonjourErrors.configurationError(
                infoDictionary: ["NSBonjourServices": ["_pkeypeer._tcp"]], requiresPlist: true), .notConfigured)
        XCTAssertEqual(
            BonjourErrors.configurationError(
                infoDictionary: ["NSBonjourServices": ["_pkeypeer._tcp"], "NSLocalNetworkUsageDescription": "  "],
                requiresPlist: true), .notConfigured)
    }

    func testNothingIsDeliveredAfterStop() throws {
        let d = FakeDriver()
        let (b, l) = make(d)
        try start(b, l)
        b.stop()
        XCTAssertEqual(d.stops, 1)
        d.send(.upserted([found(1)]))
        d.send(.failed(.permissionDenied))
        XCTAssertTrue(l.up.isEmpty)
        XCTAssertTrue(l.err.isEmpty)
        b.stop()
        XCTAssertEqual(d.stops, 1, "stop is idempotent")
    }

    func testASecondStartIsIgnored() throws {
        let d = FakeDriver()
        let (b, l) = make(d)
        try start(b, l)
        try start(b, l)
        XCTAssertEqual(d.starts, 1)
    }

    #if canImport(Network)
        func testLiveBrowseStartsAndStops() throws {
            try XCTSkipUnless(
                ProcessInfo.processInfo.environment["PKEY_LIVE_BONJOUR"] == "1", "set PKEY_LIVE_BONJOUR=1")
            let b = BonjourBrowse(configurationCheck: { nil })
            let l = Log()
            try start(b, l)
            Thread.sleep(forTimeInterval: 2)
            b.stop()
            XCTAssertTrue(l.err.isEmpty, "\(l.err)")
        }
    #endif
}
