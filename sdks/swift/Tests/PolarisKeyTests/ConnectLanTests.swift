// @pkey-feature connect.lan
// CC-11.12: the LAN service. Two services over real loopback TCP (`BonjourListener` and `BonjourPipes`)
// with a fake directory in place of Bonjour. Mirrors the Python port's `test_connect_lan.py`.

import CryptoKit
import Foundation
import PolarisKeyCore
import PolarisKeyPlatform
import XCTest

@testable import PolarisKey

#if canImport(Network)
import Network

private let sub = "ps_AAAAAAAAAAAAAAAAAAAAAA"
private let idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
private let idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
private let idC = "CCCCDDDDEEEEFFFFGGGGHHHHAAAABBBB"
private let signer = TestSigner(kid: "peer-test-2026")
private let t0 = Int(Date().timeIntervalSince1970) / 900 * 900 + 100

private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var t = t0
    var now: Int { lock.withLock { t } }
    func advance(_ s: Int) { lock.withLock { t += s } }
}

private func discKey() -> DiscoveryKey { DiscoveryKey(base64url: Base64URL.encode(Data((0..<32).map { _ in UInt8.random(in: 0...255) })))! }

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

    func cert(exp: Int) -> String {
        signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","deviceId":"\#(id)","signKey":"\#(signKey)","agreeKey":"\#(agreeKey)","ringEpoch":1,"issuedAt":\#(t0 - 10),"expiresAt":\#(exp)}"#,
            typ: "pkey-peer+jws")
    }

    var entry: String { #"{"deviceId":"\#(id)","signKey":"\#(signKey)","agreeKey":"\#(agreeKey)"}"# }
}

private func ringJws(_ devs: [Dev]) -> String {
    let entries = devs.sorted { $0.id < $1.id }.map(\.entry).joined(separator: ",")
    return signer.sign(
        payloadJSON:
            #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","epoch":1,"issuedAt":\#(t0 - 10),"expiresAt":\#(t0 + 100000),"devices":[\#(entries)]}"#,
        typ: "pkey-ring+jws")
}

/// The fake mDNS network: adverts and browsers of every service, at 127.0.0.1.
private final class Directory: @unchecked Sendable {
    private let lock = NSLock()
    private var adverts: [String: (owner: ObjectIdentifier, found: BonjourFound)] = [:]
    private var browsers: [Int: (up: @Sendable (BonjourFound) -> Void, down: @Sendable (String) -> Void)] = [:]
    private var next = 0
    var log: [String] { lock.withLock { _log } }
    private var _log: [String] = []

    func set(owner: ObjectIdentifier, advert: BonjourAdvert?, port: UInt16) {
        let (gone, up, bs): ([String], BonjourFound?, [(@Sendable (BonjourFound) -> Void, @Sendable (String) -> Void)]) = lock.withLock {
            let old = adverts.filter { $0.value.owner == owner }.map(\.key)
            for k in old { adverts[k] = nil }
            var f: BonjourFound?
            if let a = advert {
                f = BonjourFound(
                    instance: a.instance, txt: a.txt,
                    endpoint: BonjourEndpoint(
                        name: a.instance, network: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)))
                adverts[a.instance] = (owner, f!)
                _log.append("up " + a.instance)
            }
            for o in old { _log.append("down " + o) }
            return (old, f, browsers.values.map { ($0.up, $0.down) })
        }
        for b in bs {
            for g in gone { b.1(g) }
            if let up { b.0(up) }
        }
    }

    func names() -> Set<String> { lock.withLock { Set(adverts.keys) } }

    func browse(up: @escaping @Sendable (BonjourFound) -> Void, down: @escaping @Sendable (String) -> Void) -> @Sendable () -> Void {
        let (id, existing) = lock.withLock { () -> (Int, [BonjourFound]) in
            next += 1
            browsers[next] = (up, down)
            return (next, adverts.values.map(\.found))
        }
        for f in existing { up(f) }
        return { [self] in lock.withLock { browsers[id] = nil } }
    }

    /// What a real browser does on `rescan()`: offer every current result again.
    func replay() {
        let (fs, bs) = lock.withLock { (adverts.values.map(\.found), browsers.values.map(\.up)) }
        for b in bs { for f in fs { b(f) } }
    }

    func inject(_ f: BonjourFound) {
        let bs = lock.withLock { browsers.values.map(\.up) }
        for b in bs { b(f) }
    }
}

private final class FakeNet: ConnectLanNetwork, @unchecked Sendable {
    let dir: Directory
    let listener = BonjourListener(policy: BonjourDialPolicy(allowLoopback: true))
    let dialOptions: BonjourDialOptions
    var failListen: BonjourPipeError?
    private let lock = NSLock()
    private var port: UInt16 = 0

    init(_ dir: Directory, loopback: Bool = true) {
        self.dir = dir
        dialOptions = BonjourDialOptions(policy: BonjourDialPolicy(allowLoopback: loopback), timeout: 5)
    }

    func listen(
        onPipe: @escaping @Sendable (NWPipe) -> Void, onEvent: @escaping @Sendable (BonjourListenerEvent) -> Void
    ) async throws -> UInt16 {
        if let e = failListen { throw e }
        let p = try await listener.start(advert: nil, onPipe: onPipe, onEvent: onEvent)
        lock.withLock { port = p }
        return p
    }

    func advertise(_ advert: BonjourAdvert?) async {
        dir.set(owner: ObjectIdentifier(self), advert: advert, port: lock.withLock { port })
    }

    func browse(
        onUp: @escaping @Sendable (BonjourFound) -> Void, onDown: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (BonjourBrowseError) -> Void
    ) throws -> @Sendable () -> Void { dir.browse(up: onUp, down: onDown) }

    func dial(_ endpoint: BonjourEndpoint) async throws -> NWPipe { try await BonjourPipes.dial(endpoint, options: dialOptions) }

    func rescan() { dir.replay() }

    func stop() async {
        listener.stop()
        dir.set(owner: ObjectIdentifier(self), advert: nil, port: 0)
    }
}

private final class Timers: @unchecked Sendable {
    private let lock = NSLock()
    private var fns: [Int: @Sendable () -> Void] = [:]
    private var n = 0
    var last: [TimeInterval] = []
    var timer: ConnectPeerDocs.Timer {
        { [self] s, fn in
            let id = lock.withLock { () -> Int in n += 1; fns[n] = fn; last.append(s); return n }
            return { [self] in lock.withLock { fns[id] = nil } }
        }
    }
    func fireAll() {
        let all = lock.withLock { () -> [@Sendable () -> Void] in let a = Array(fns.values); fns = [:]; return a }
        for f in all { f() }
    }
}

private final class World: @unchecked Sendable {
    let a: Dev, b: Dev
    let dir = Directory()
    let clock = Clock()
    let key = LockedValue(DiscoveryKeys(current: discKey(), previous: nil))
    let ring: String
    var services: [ConnectLanService] = []

    init() async throws {
        a = try await Dev(idA, signByte: 1)
        b = try await Dev(idB, signByte: 2)
        ring = ringJws([a, b])
    }

    func peerSource(_ d: Dev, roster: [String]? = nil, keys: DiscoveryKeys? = nil) -> PeerSource {
        PeerSource(
            slug: "djdl", trust: signer.trust, sub: sub, deviceId: d.id, certJws: d.cert(exp: t0 + 5000),
            certExpiresAt: t0 + 5000, ringJws: ring, ringEpoch: 1, roster: roster ?? [idA, idB],
            keys: keys ?? self.key.current, agreePublic: Base64URL.decodeStrict(d.agreeKey)!,
            staticKey: PeerNoiseDeviceKey(d.store))
    }

    func source(_ d: Dev, roster: [String]? = nil) -> ConnectLanSource {
        ConnectLanSource(load: { [self] in peerSource(d, roster: roster) }, now: { [clock] in clock.now })
    }

    func start(
        _ d: Dev, roster: [String]? = nil, timers: Timers? = nil, net: FakeNet? = nil, source: ConnectLanSource? = nil
    ) async throws -> ConnectLanService {
        let o = ConnectLanOptions(network: net ?? FakeNet(dir), timer: timers?.timer)
        let s = try await ConnectLanService.start(source ?? self.source(d, roster: roster), options: o)
        services.append(s)
        return s
    }

    func close() async { for s in services { await s.stop() } }
}

private func until(_ what: String, _ cond: @Sendable () async -> Bool) async {
    for _ in 0..<400 {
        if await cond() { return }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    XCTFail("timed out waiting for \(what)")
}

final class ConnectLanTests: XCTestCase {
    func testTwoServicesFindEachOtherHandshakeExchangeAndClose() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        let b = try await w.start(w.b)
        let inbound = LockedValue<ConnectSession?>(nil)
        b.onSession { inbound.set($0) }
        await until("A sees B") { await a.currentPeers().map(\.deviceId) == [idB] }
        await until("B sees A") { await b.currentPeers().map(\.deviceId) == [idA] }

        let s = try await a.connect(idB)
        XCTAssertEqual(s.peerDeviceId, idB)
        XCTAssertEqual(s.path, "lan")
        await until("inbound") { inbound.current != nil }
        let r = inbound.current!
        XCTAssertEqual(r.peerDeviceId, idA)
        try await s.send(Data("ping".utf8))
        let m = try await r.receive()
        XCTAssertEqual(m.body, Data("ping".utf8))
        try await r.send(Data("pong".utf8))
        let back = try await s.receive()
        XCTAssertEqual(back.body, Data("pong".utf8))
        await s.close()
        await until("closed") { r.closed != nil }
        await w.close()
    }

    func testAdvertRotatesAtTheEpochBoundaryAndDropsTheOldOne() async throws {
        let w = try await World()
        let timers = Timers()
        _ = try await w.start(w.a, timers: timers)
        let first = w.dir.names()
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(timers.last.first, 800, "the timer is set for the epoch boundary")
        w.clock.advance(800)
        timers.fireAll()
        await until("new advert") { w.dir.names().count == 1 && w.dir.names() != first }
        XCTAssertTrue(w.dir.log.contains("down " + first.first!))
        await w.close()
    }

    func testANewDiscoveryKeyChangesTheAdvertInsideTheEpoch() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        let first = w.dir.names()
        w.key.set(DiscoveryKeys(current: discKey(), previous: w.key.current.current))
        await a.stored()
        await until("rotated") { w.dir.names().count == 1 && w.dir.names() != first }
        await w.close()
    }

    func testForgedUnrelatedAndPreviousKeyAdverts() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        let ep = BonjourEndpoint(name: "x", network: .hostPort(host: "127.0.0.1", port: 9))
        func inject(_ name: String, txt: [String] = ["v=1", "m=a"]) {
            w.dir.inject(BonjourFound(instance: name, txt: txt, endpoint: ep))
        }
        inject("p1-aaaaaaaaaaaaaaaa")  // forged
        inject("not-an-instance")
        let k = w.key.current
        let epoch = peerAdvertEpoch(w.clock.now)
        let own = try PeerAdvert.accountInstance(discoveryKey: k.current.bytes, epoch: epoch, deviceId: idA)
        inject(own)  // this device itself
        let other = try PeerAdvert.accountInstance(discoveryKey: k.current.bytes, epoch: epoch, deviceId: idB)
        inject(other, txt: ["v=2", "m=a"])  // wrong version
        inject(other, txt: ["v=1", "m=v"])  // not mode a
        try await Task.sleep(nanoseconds: 200_000_000)
        let none = await a.currentPeers()
        XCTAssertEqual(none, [])
        // The previous epoch under the previous key is accepted.
        let old = try PeerAdvert.accountInstance(discoveryKey: k.current.bytes, epoch: epoch - 1, deviceId: idB)
        inject(old)
        await until("previous epoch accepted") { await a.currentPeers().map(\.deviceId) == [idB] }
        await w.close()
    }

    /// S1: a forged name is one dictionary lookup; HMACs run only when the dictionary is built.
    func testForgedNamesCostNoHmacBeyondThePrecompute() {
        let calls = LockedValue(0)
        let index = ConnectBrowseIndex(name: { key, epoch, id in
            calls.with { $0 += 1 }
            let tag = String(format: "%02x%d", key[0], epoch % 10) + id
            let a = Array("abcdefghijklmnopqrstuvwxyz234567")
            var h = tag.utf8.reduce(UInt64(1469598103934665603)) { ($0 ^ UInt64($1)) &* 1099511628211 }
            var out = "p1-"
            for _ in 0..<16 { out.append(a[Int(h % 32)]); h = h / 32 &+ 7919 }
            return out
        })
        let roster = (0..<127).map { "dev\($0)" }
        let k1 = Data(repeating: 1, count: 32), k2 = Data(repeating: 2, count: 32)
        index.update(keys: [k1, k2], roster: roster)
        let now = t0
        XCTAssertNil(index.lookup("p1-aaaaaaaaaaaaaaaa", now: now))
        XCTAssertEqual(calls.current, 2 * 2 * 127, "the precompute: epochs x keys x roster")
        for i in 0..<500 {
            let forged = "p1-" + String(String(i + 100_000, radix: 32).map { $0 == "0" ? "a" : $0 == "1" ? "b" : $0 }.prefix(16)).padding(toLength: 16, withPad: "a", startingAt: 0)
            _ = index.lookup(forged, now: now)
        }
        XCTAssertEqual(calls.current, 508, "500 forged names did no HMAC work")
        XCTAssertEqual(index.builds.current, 1)
        // Unchanged inputs do not rebuild; the next epoch rebuilds once; a changed roster rebuilds.
        index.update(keys: [k1, k2], roster: roster)
        _ = index.lookup("p1-aaaaaaaaaaaaaaaa", now: now)
        XCTAssertEqual(index.builds.current, 1, "unchanged inputs do not rebuild")
        _ = index.lookup("p1-aaaaaaaaaaaaaaaa", now: now + 900)
        XCTAssertEqual(index.builds.current, 2)
        index.update(keys: [k1, k2], roster: Array(roster.dropLast()))
        _ = index.lookup("p1-aaaaaaaaaaaaaaaa", now: now + 900)
        XCTAssertEqual(index.builds.current, 3)
    }

    /// The epoch turning over is an index change too, so the browse filter re-runs.
    func testRefreshReportsAnEpochRebuild() {
        let index = ConnectBrowseIndex(name: { _, e, id in "p1-" + String(repeating: "a", count: 14) + "\(e % 10)\(id.count % 10)" })
        XCTAssertFalse(index.refresh(now: t0), "nothing loaded")
        XCTAssertTrue(index.update(keys: [Data(repeating: 1, count: 32)], roster: ["x"]))
        XCTAssertFalse(index.update(keys: [Data(repeating: 1, count: 32)], roster: ["x"]))
        XCTAssertTrue(index.refresh(now: t0), "first build")
        XCTAssertFalse(index.refresh(now: t0 + 10), "same epoch")
        XCTAssertTrue(index.refresh(now: t0 + 900), "next epoch")
        XCTAssertFalse(index.refresh(now: t0 + 901))
        XCTAssertTrue(index.update(keys: [Data(repeating: 2, count: 32)], roster: ["x"]), "a new key")
        XCTAssertTrue(index.refresh(now: t0 + 901))
    }

    func testTheIndexFindsRealNamesInPriorityOrder() throws {
        let index = ConnectBrowseIndex()
        let k = Data((0..<32).map { UInt8($0) })
        index.update(keys: [k], roster: [idB])
        let epoch = peerAdvertEpoch(t0)
        let cur = try PeerAdvert.accountInstance(discoveryKey: k, epoch: epoch, deviceId: idB)
        let old = try PeerAdvert.accountInstance(discoveryKey: k, epoch: epoch - 1, deviceId: idB)
        XCTAssertEqual(index.lookup(cur, now: t0), ConnectBrowseIndex.Hit(deviceId: idB, epochBack: 0, keyIndex: 0))
        XCTAssertEqual(index.lookup(old, now: t0), ConnectBrowseIndex.Hit(deviceId: idB, epochBack: 1, keyIndex: 0))
        XCTAssertNil(index.lookup("not-an-instance", now: t0))
    }

    func testItRefusesToStartWithoutAnIdentityAndReleasesWhatItOpened() async throws {
        let w = try await World()
        let bad = ConnectLanSource(
            load: { throw ConnectLanError(.noIdentity, "none") }, now: { [clock = w.clock] in clock.now })
        do {
            _ = try await w.start(w.a, source: bad)
            XCTFail("no identity")
        } catch { XCTAssertEqual((error as? ConnectLanError)?.reason, .noIdentity) }
        XCTAssertEqual(w.dir.names(), [])
    }

    func testPermissionDeniedIsTheNearbyCode() async throws {
        let w = try await World()
        let net = FakeNet(w.dir)
        net.failListen = .browse(.permissionDenied)
        do {
            _ = try await w.start(w.a, net: net)
            XCTFail("refused")
        } catch let e as ConnectLanError {
            XCTAssertEqual(e.reason, .permissionDenied)
            XCTAssertEqual(e.code, ErrorCode.nearbyPermissionDenied)
        }
        XCTAssertEqual(
            ConnectLanService.lanError(BonjourBrowseError.permissionDenied).code, "nearby-permission-denied")
        XCTAssertEqual(ConnectLanService.lanError(BonjourBrowseError.notConfigured).reason, .notConfigured)
    }

    func testUnknownDeviceAndLoopbackNotDialledUnlessAllowed() async throws {
        let w = try await World()
        let a = try await w.start(w.a, net: FakeNet(w.dir, loopback: false))
        let b = try await w.start(w.b)
        _ = b
        do {
            _ = try await a.connect("ZZZZ")
            XCTFail("unknown")
        } catch { XCTAssertEqual((error as? ConnectLanError)?.reason, .unknownPeer) }
        await until("A sees B") { await a.currentPeers().map(\.deviceId) == [idB] }
        do {
            _ = try await a.connect(idB)
            XCTFail("loopback refused")
        } catch { XCTAssertEqual((error as? ConnectLanError)?.reason, .connectFailed) }
        await w.close()
    }

    func testTheDeviceThatAnswersMustBeTheOneDialled() async throws {
        let w = try await World()
        let a = try await w.start(w.a, roster: [idA, idB, idC])
        let b = try await w.start(w.b)
        let bPort = await b.listenPort()
        // C's advert, under the real key, points at B's port.
        let name = try PeerAdvert.accountInstance(
            discoveryKey: w.key.current.current.bytes, epoch: peerAdvertEpoch(w.clock.now), deviceId: idC)
        w.dir.inject(
            BonjourFound(
                instance: name, txt: ["v=1", "m=a"],
                endpoint: BonjourEndpoint(
                    name: name, network: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: bPort)!))))
        await until("C seen") { await a.currentPeers().map(\.deviceId).contains(idC) }
        do {
            _ = try await a.connect(idC)
            XCTFail("B answered for C")
        } catch { XCTAssertEqual((error as? ConnectLanError)?.reason, .wrongPeer) }
        await w.close()
    }

    func testAWrongDiscoveryKeyIsRefusedWithoutASession() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        let b = try await w.start(
            w.b, source: ConnectLanSource(
                load: { [w] in w.peerSource(w.b, keys: DiscoveryKeys(current: discKey(), previous: nil)) },
                now: { [clock = w.clock] in clock.now }))
        let bPort = await b.listenPort()
        // A is told B's address under a name A can resolve, but B holds another K_disc.
        let name = try PeerAdvert.accountInstance(
            discoveryKey: w.key.current.current.bytes, epoch: peerAdvertEpoch(w.clock.now), deviceId: idB)
        w.dir.inject(
            BonjourFound(
                instance: name, txt: ["v=1", "m=a"],
                endpoint: BonjourEndpoint(
                    name: name, network: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: bPort)!))))
        await until("B seen") { await a.currentPeers().map(\.deviceId) == [idB] }
        do {
            _ = try await a.connect(idB)
            XCTFail("tag mismatch")
        } catch { XCTAssertEqual((error as? ConnectLanError)?.reason, .handshakeFailed) }
        await w.close()
    }

    func testStopClosesSessionsAndTheListener() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        let b = try await w.start(w.b)
        await until("A sees B") { await a.currentPeers().map(\.deviceId) == [idB] }
        let s = try await a.connect(idB)
        await b.stop()
        await until("session ended") { s.closed != nil }
        do {
            _ = try await b.connect(idA)
            XCTFail("stopped")
        } catch { XCTAssertEqual((error as? ConnectLanError)?.reason, .notListening) }
        await a.stop()
        XCTAssertEqual(w.dir.names(), [])
    }

    func testServiceLeaksNothingThroughDescriptionOrMirror() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        var dumped = ""
        dump(a, to: &dumped)
        XCTAssertEqual("\(a)", "ConnectLanService()")
        XCTAssertFalse(dumped.contains(w.ring))
        await w.close()
    }

    /// R1: a browse-only service still wakes at the epoch boundary, so a peer that was seen under the next
    /// epoch before this clock turned is found then.
    func testABrowseOnlyServiceFindsAPeerSeenUnderTheNextEpochAtTheBoundary() async throws {
        let w = try await World()
        let timers = Timers()
        let net = FakeNet(w.dir)
        let a = try await ConnectLanService.start(
            w.source(w.a), options: ConnectLanOptions(advertise: false, network: net, timer: timers.timer))
        XCTAssertEqual(timers.last.first, 800, "the epoch timer is armed with no advert")
        // B's clock is already in the next epoch.
        let ahead = ConnectLanSource(load: { [w] in w.peerSource(w.b) }, now: { [clock = w.clock] in clock.now + 800 })
        let b = try await ConnectLanService.start(ahead, options: ConnectLanOptions(network: FakeNet(w.dir)))
        try await Task.sleep(nanoseconds: 200_000_000)
        let seen = await a.currentPeers()
        XCTAssertTrue(seen.isEmpty, "the next epoch's name is not in the index yet")
        w.clock.advance(800)
        timers.fireAll()
        await until("A finds B at the boundary") { await a.currentPeers().map(\.deviceId) == [idB] }
        await a.stop()
        await b.stop()
    }

    /// R2: the discovery-key bytes are dropped on stop and on abort.
    func testTheBrowseIndexDropsItsKeysOnStopAndAbort() async throws {
        let w = try await World()
        let a = try await w.start(w.a)
        XCTAssertTrue(a.index.holdsKeys)
        await a.stop()
        XCTAssertFalse(a.index.holdsKeys)
        let b = try await w.start(w.b)
        XCTAssertTrue(b.index.holdsKeys)
        b.abort()
        XCTAssertFalse(b.index.holdsKeys)
        await w.close()
    }

    /// N8: one identity change reaches both services' 30 s caches.
    func testAnIdentityChangeDropsTheCachedIdentityInTheLanAndRelayServices() async throws {
        let w = try await World()
        let changes = ConnectIdentityEpoch()
        let lanLoads = LockedValue(0), relayLoads = LockedValue(0)
        func src(_ n: LockedValue<Int>) -> ConnectLanSource {
            ConnectLanSource(
                load: { [w] in
                    n.with { $0 += 1 }
                    return w.peerSource(w.a)
                }, now: { [clock = w.clock] in clock.now }, changes: changes)
        }
        let lan = try await ConnectLanService.start(src(lanLoads), options: ConnectLanOptions(network: FakeNet(w.dir)))
        let relay = ConnectRelayService(source: src(relayLoads), ticket: { .error(code: "x", message: "x") })
        _ = try await relay.identity(force: false)
        _ = try await relay.identity(force: false)
        XCTAssertEqual(relayLoads.current, 1, "cached")
        let l0 = lanLoads.current
        changes.bump()
        _ = try await relay.identity(force: false)
        XCTAssertEqual(relayLoads.current, 2, "the bump dropped the relay's copy")
        // The LAN service's own reload on a stored roster moves the shared counter, so the relay follows.
        await lan.stored()
        await until("the LAN service reloaded") { lanLoads.current > l0 }
        _ = try await relay.identity(force: false)
        XCTAssertEqual(relayLoads.current, 3)
        await lan.stop()
    }
}
#endif
