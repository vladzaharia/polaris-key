// @pkey-feature connect.lan
// CC-11.11: Bonjour pipes over real loopback TCP (no Bonjour registration is needed or made).

import Foundation
import XCTest

@testable import PolarisKeyPlatform

#if canImport(Network)
    import Network
#endif

#if canImport(Network)
    private final class Sink: @unchecked Sendable {
        private let lock = NSLock()
        private var _pipes: [NWPipe] = []
        var pipes: [NWPipe] { lock.withLock { _pipes } }
        func add(_ p: NWPipe) { lock.withLock { _pipes.append(p) } }
    }

#endif

final class BonjourPipesTests: XCTestCase {
    // MARK: policy (G6, D-10)

    func testDialPolicy() {
        let p = BonjourDialPolicy()
        XCTAssertTrue(p.allows(addressBytes: [10, 1, 2, 3]))
        XCTAssertTrue(p.allows(addressBytes: [172, 16, 0, 1]))
        XCTAssertTrue(p.allows(addressBytes: [172, 31, 255, 255]))
        XCTAssertTrue(p.allows(addressBytes: [192, 168, 1, 9]))
        XCTAssertFalse(p.allows(addressBytes: [172, 15, 0, 1]))
        XCTAssertFalse(p.allows(addressBytes: [172, 32, 0, 1]))
        XCTAssertFalse(p.allows(addressBytes: [192, 169, 0, 1]))
        XCTAssertFalse(p.allows(addressBytes: [169, 254, 1, 1]))
        XCTAssertFalse(p.allows(addressBytes: [100, 64, 0, 1]))
        XCTAssertFalse(p.allows(addressBytes: [8, 8, 8, 8]))
        XCTAssertFalse(p.allows(addressBytes: [127, 0, 0, 1]))
        XCTAssertTrue(BonjourDialPolicy(allowLoopback: true).allows(addressBytes: [127, 0, 0, 1]))
        XCTAssertFalse(BonjourDialPolicy(allowLoopback: true).allows(addressBytes: [8, 8, 8, 8]))

        func v6(_ head: [UInt8], last: UInt8 = 1) -> [UInt8] {
            head + [UInt8](repeating: 0, count: 16 - head.count - 1) + [last]
        }
        XCTAssertTrue(p.allows(addressBytes: v6([0xFE, 0x80])))
        XCTAssertTrue(p.allows(addressBytes: v6([0xFE, 0xBF])))
        XCTAssertFalse(p.allows(addressBytes: v6([0xFE, 0xC0])))
        XCTAssertTrue(p.allows(addressBytes: v6([0xFC, 0x00])))
        XCTAssertTrue(p.allows(addressBytes: v6([0xFD, 0x12])))
        XCTAssertFalse(p.allows(addressBytes: v6([0xFE, 0x00])))
        XCTAssertFalse(p.allows(addressBytes: v6([0x20, 0x01])))  // global unicast
        XCTAssertFalse(p.allows(addressBytes: v6([])))  // ::1
        XCTAssertTrue(BonjourDialPolicy(allowLoopback: true).allows(addressBytes: v6([])))
        // IPv4-mapped follows the IPv4 rule.
        let mapped: (UInt8, UInt8, UInt8, UInt8) -> [UInt8] = { a, b, c, d in
            [UInt8](repeating: 0, count: 10) + [0xFF, 0xFF, a, b, c, d]
        }
        XCTAssertTrue(p.allows(addressBytes: mapped(192, 168, 0, 1)))
        XCTAssertFalse(p.allows(addressBytes: mapped(8, 8, 8, 8)))
        XCTAssertFalse(p.allows(addressBytes: [1, 2, 3]))
    }

    // MARK: limiter (G7)

    func testLimiterTotalAndPerAddress() {
        let l = UnauthenticatedLimiter()
        var slots: [UnauthenticatedLimiter.Slot] = []
        for _ in 0..<4 { slots.append(l.admit(address: "192.168.1.5")!) }
        XCTAssertNil(l.admit(address: "192.168.1.5"), "5th from one address")
        XCTAssertNil(l.admit(address: "192.168.1.5%en0"), "the scope id is not part of the address")
        l.release(slots[0])
        l.release(slots[0])  // idempotent
        XCTAssertEqual(l.count, 3)
        XCTAssertNotNil(l.admit(address: "192.168.1.5"))
        XCTAssertNil(l.admit(address: "192.168.1.5"))
        // 28 more addresses fill the 32 total.
        for i in 0..<28 { XCTAssertNotNil(l.admit(address: "10.0.0.\(i)")) }
        XCTAssertEqual(l.count, 32)
        XCTAssertNil(l.admit(address: "10.9.9.9"), "33rd socket")
    }

    // MARK: rename (never kept under another name)

    func testRenamedRegistrationIsWithdrawn() {
        XCTAssertEqual(
            BonjourRegistration.action(requested: "p1-aaaaaaaaaaaaaaaa", registeredAs: "p1-aaaaaaaaaaaaaaaa"), .keep)
        XCTAssertEqual(
            BonjourRegistration.action(requested: "p1-aaaaaaaaaaaaaaaa", registeredAs: "p1-aaaaaaaaaaaaaaaa (2)"),
            .withdraw(got: "p1-aaaaaaaaaaaaaaaa (2)"))
    }

    #if canImport(Network)
        private let loop = BonjourDialOptions(policy: BonjourDialPolicy(allowLoopback: true), timeout: 5)

        private func listen(
            _ l: BonjourListener, _ sink: Sink, onPipe: (@Sendable (NWPipe) -> Void)? = nil
        ) async throws -> UInt16 {
            try await l.start(onPipe: { p in
                sink.add(p)
                onPipe?(p)
            })
        }

        private func waitFor(_ what: String, _ cond: () -> Bool) async throws {
            for _ in 0..<200 {
                if cond() { return }
                try await Task.sleep(nanoseconds: 25_000_000)
            }
            XCTFail("timed out waiting for \(what)")
        }

        private func endpoint(_ port: UInt16) -> NWEndpoint {
            .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        }

        func testLoopbackRoundTripAndEnd() async throws {
            let sink = Sink()
            let l = BonjourListener(policy: BonjourDialPolicy(allowLoopback: true))
            defer { l.stop() }
            let port = try await listen(l, sink)
            XCTAssertNotEqual(port, 0)
            let c = try await BonjourPipes.dial(endpoint(port), options: loop)
            try await waitFor("accept") { !sink.pipes.isEmpty }
            let s = sink.pipes[0]
            XCTAssertTrue(s.remoteAddress.hasPrefix("127.0.0.1"))

            try await c.write(Data("hello".utf8))
            let got = try await s.read()
            XCTAssertEqual(got, Data("hello".utf8))
            try await s.write(Data([1, 2, 3]))
            let back = try await c.read()
            XCTAssertEqual(back, Data([1, 2, 3]))

            await c.close()
            let eof = try await s.read()
            XCTAssertNil(eof, "the peer's close ends the stream")
            do {
                try await c.write(Data([1]))
                XCTFail("write after close")
            } catch { XCTAssertEqual(error as? BonjourPipeError, .closed) }
            await s.close()
        }

        func testCloseWakesAPendingRead() async throws {
            let sink = Sink()
            let l = BonjourListener(policy: BonjourDialPolicy(allowLoopback: true))
            defer { l.stop() }
            let port = try await listen(l, sink)
            let c = try await BonjourPipes.dial(endpoint(port), options: loop)
            let reader = Task { try await c.read() }
            try await Task.sleep(nanoseconds: 100_000_000)
            await c.close()
            let r = try await reader.value
            XCTAssertNil(r)
        }

        func testBackpressureIsPullBased() async throws {
            // The writer sends far more than the socket buffers hold; the reader stays idle, so the
            // writes cannot all complete until it reads.
            let sink = Sink()
            let l = BonjourListener(policy: BonjourDialPolicy(allowLoopback: true))
            defer { l.stop() }
            let port = try await listen(l, sink)
            let c = try await BonjourPipes.dial(endpoint(port), options: loop)
            try await waitFor("accept") { !sink.pipes.isEmpty }
            let s = sink.pipes[0]
            let chunk = Data(repeating: 7, count: 1 << 20)
            let total = 64
            let counter = Counter()
            let writer = Task {
                for _ in 0..<total {
                    try await c.write(chunk)
                    counter.bump()
                }
            }
            try await Task.sleep(nanoseconds: 700_000_000)
            XCTAssertLessThan(counter.value, total, "writes are held back while the peer does not read")
            var received = 0
            while received < total << 20 {
                guard let d = try await s.read() else { break }
                received += d.count
            }
            try await writer.value
            XCTAssertEqual(received, total << 20)
            XCTAssertEqual(counter.value, total)
            await c.close()
            await s.close()
        }

        func testPolicyRefusesLoopbackByDefaultBeforeAnyByte() async throws {
            let sink = Sink()
            let l = BonjourListener(policy: BonjourDialPolicy(allowLoopback: true))
            defer { l.stop() }
            let port = try await listen(l, sink)
            do {
                _ = try await BonjourPipes.dial(endpoint(port), options: BonjourDialOptions(timeout: 5))
                XCTFail("loopback is refused unless opted in")
            } catch { XCTAssertEqual(error as? BonjourPipeError, .addressRefused) }
            // The accepted side saw a connection but no byte, and then the end.
            try await waitFor("accept") { !sink.pipes.isEmpty }
            let r = try await sink.pipes[0].read()
            XCTAssertNil(r, "nothing was sent")
        }

        func testDialToAClosedPortFailsAndAnEndpointlessRowIsUnresolvable() async throws {
            let l = BonjourListener(policy: BonjourDialPolicy(allowLoopback: true))
            let port = try await listen(l, Sink())
            l.stop()
            try await Task.sleep(nanoseconds: 100_000_000)
            do {
                _ = try await BonjourPipes.dial(
                    endpoint(port),
                    options: BonjourDialOptions(policy: BonjourDialPolicy(allowLoopback: true), timeout: 3))
                XCTFail("nobody is listening")
            } catch {
                XCTAssertTrue(error is BonjourPipeError)
            }
            do {
                _ = try await BonjourPipes.dial(BonjourEndpoint(name: "p1-aaaaaaaaaaaaaaaa"), options: loop)
                XCTFail("no network endpoint")
            } catch { XCTAssertEqual(error as? BonjourPipeError, .unresolvable) }
        }

        /// B2: the accept-side policy runs before a slot is taken.
        func testANonLanSourceIsRefusedWithoutTakingASlot() {
            let limiter = UnauthenticatedLimiter(total: 32, perAddress: 4)
            let policy = BonjourDialPolicy()
            func ep(_ h: NWEndpoint.Host) -> NWEndpoint { .hostPort(host: h, port: 1) }
            for h: NWEndpoint.Host in [
                "8.8.8.8", "100.64.0.1", "169.254.1.1", "2001:db8::1", "127.0.0.1", "::ffff:8.8.8.8",
            ] {
                XCTAssertNil(BonjourListener.gate(ep(h), policy: policy, limiter: limiter), "\(h)")
            }
            XCTAssertNil(
                BonjourListener.gate(
                    .service(name: "x", type: "_t._tcp", domain: "local", interface: nil), policy: policy,
                    limiter: limiter))
            XCTAssertEqual(limiter.count, 0, "no slot was taken")
            let ok = BonjourListener.gate(ep("192.168.1.5"), policy: policy, limiter: limiter)
            XCTAssertEqual(ok?.address, "192.168.1.5")
            XCTAssertEqual(limiter.count, 1)
            // The IPv4-mapped form shares the IPv4 count.
            XCTAssertEqual(
                BonjourListener.gate(ep("::ffff:192.168.1.5"), policy: policy, limiter: limiter)?.address, "192.168.1.5"
            )
            XCTAssertNotNil(BonjourListener.gate(ep("fe80::1%en0"), policy: policy, limiter: limiter))
            XCTAssertNotNil(
                BonjourListener.gate(ep("127.0.0.1"), policy: BonjourDialPolicy(allowLoopback: true), limiter: limiter))
        }

        /// B2: a live listener without the loopback opt-in serves no loopback source.
        func testALoopbackSourceIsCancelledByTheDefaultPolicy() async throws {
            let sink = Sink()
            let l = BonjourListener()
            defer { l.stop() }
            let port = try await listen(l, sink)
            let c = try await BonjourPipes.dial(endpoint(port), options: loop)
            let got = try? await c.read()
            XCTAssertNil(got ?? nil, "the socket is closed without a word")
            XCTAssertTrue(sink.pipes.isEmpty)
            await c.close()
        }

        /// B2: a silent accepted socket is closed at the pre-auth bound, from accept.
        func testASilentAcceptedSocketClosesAtThePreAuthBound() async throws {
            let sink = Sink()
            let limiter = UnauthenticatedLimiter()
            let l = BonjourListener(
                limiter: limiter, policy: BonjourDialPolicy(allowLoopback: true), preAuthSeconds: 0.4)
            defer { l.stop() }
            let port = try await listen(l, sink)
            let silent = try await BonjourPipes.dial(endpoint(port), options: loop)
            let admitted = try await BonjourPipes.dial(endpoint(port), options: loop)
            try await waitFor("two accepted") { sink.pipes.count >= 2 }
            sink.pipes[1].markAuthenticated()  // this one is a session by the deadline
            let t0 = Date()
            let end = try? await silent.read()
            XCTAssertNil(end ?? nil, "the silent socket was closed by the listener")
            XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(t0), 0.2)
            XCTAssertLessThan(Date().timeIntervalSince(t0), 5)
            try await waitFor("slot freed") { limiter.count == 0 }
            try await sink.pipes[1].write(Data([9]))
            let still = try await admitted.read()
            XCTAssertEqual(still, Data([9]), "an admitted session is left alone")
            await silent.close()
            await admitted.close()
        }

        /// S6 (listener half): a permission refusal while waiting fails `start`; other waits are bounded.
        func testAListenerWaitingErrorIsClassified() {
            XCTAssertEqual(
                BonjourListener.waitingFailure(.dns(BonjourErrors.dnsPolicyDenied)), .permissionDenied)
            XCTAssertEqual(BonjourListener.waitingFailure(.dns(BonjourErrors.dnsNoAuth)), .notConfigured)
            XCTAssertNil(BonjourListener.waitingFailure(.dns(-1)))
            XCTAssertNil(BonjourListener.waitingFailure(.posix(.ENETDOWN)))
        }

        func testUnauthenticatedSocketsAreCappedPerAddressUntilAuthenticated() async throws {
            let sink = Sink()
            let l = BonjourListener(
                limiter: UnauthenticatedLimiter(total: 32, perAddress: 2),
                policy: BonjourDialPolicy(allowLoopback: true))
            defer { l.stop() }
            let port = try await listen(l, sink)
            var clients: [NWPipe] = []
            for _ in 0..<3 { clients.append(try await BonjourPipes.dial(endpoint(port), options: loop)) }
            try await waitFor("two accepted") { sink.pipes.count >= 2 }
            try await Task.sleep(nanoseconds: 300_000_000)
            XCTAssertEqual(sink.pipes.count, 2, "the third socket from one address is refused")
            // Admitting one frees its slot for a new socket.
            sink.pipes[0].markAuthenticated()
            let fourth = try await BonjourPipes.dial(endpoint(port), options: loop)
            clients.append(fourth)
            try await waitFor("third accepted") { sink.pipes.count >= 3 }
            for c in clients { await c.close() }
            for p in sink.pipes { await p.close() }
        }

        func testAdvertTxtBuildsAService() {
            let a = BonjourAdvert(instance: "p1-aaaaaaaaaaaaaaaa", txt: ["v=1", "m=a", "flag"])
            let s = BonjourListener.service(a)
            let r = BonjourListener.txtRecord(a)
            XCTAssertEqual(s.name, "p1-aaaaaaaaaaaaaaaa")
            XCTAssertEqual(s.type, bonjourPeerServiceType)
            XCTAssertEqual(r.getEntry(for: "v"), .string("1"))
            XCTAssertEqual(r.getEntry(for: "flag"), NWTXTRecord.Entry.none)
        }
    #endif
}

#if canImport(Network)
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        var value: Int { lock.withLock { n } }
        func bump() { lock.withLock { n += 1 } }
    }
#endif
