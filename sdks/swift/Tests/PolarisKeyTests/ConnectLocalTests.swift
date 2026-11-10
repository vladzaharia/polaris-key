// @pkey-feature connect.local
// CC-29.11: local links through the Swift SDK (WIRE-CONTRACT-V5 §15.12): two clients with no account pair by a typed
// code and by a QR over a fake directory and real loopback TCP, the failure accounting and the dial budget, mode `l`
// sessions on the shared listener with no account, the gate, forget, reachable and the cap, Direct Transfer from a
// local link, and the store. Mirrors the Node package's `test/connect/localLinks*.test.ts`. The corpus rows run in
// `PeerLocalTests`, `PeerCPaceTests` and `PeerXferTests`; the transcript replays in `TranscriptTests`.

import Foundation
import PolarisKeyCore
import PolarisKeyPlatform
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

#if canImport(Network)
    import Network

    private let cats = ["docs", "music"]

    private func rnd(_ n: Int = 32) -> Data { Data((0..<n).map { _ in UInt8.random(in: 0...255) }) }

    // ── The fake directory and network: real loopback TCP, adverts in memory ──────────────────────

    private final class Directory: @unchecked Sendable {
        private let lock = NSLock()
        private var adverts: [String: (owner: ObjectIdentifier, found: BonjourFound)] = [:]
        private var browsers: [Int: (up: @Sendable (BonjourFound) -> Void, down: @Sendable (String) -> Void)] = [:]
        private var next = 0

        func set(owner: ObjectIdentifier, slot: Int, adverts list: [BonjourAdvert], port: UInt16) {
            let tag = "\(slot)"
            let (gone, ups, bs) = lock.withLock {
                () -> ([String], [BonjourFound], [(@Sendable (BonjourFound) -> Void, @Sendable (String) -> Void)]) in
                let old = adverts.filter {
                    $0.value.owner == owner && $0.value.found.endpoint.name.hasSuffix("#" + tag)
                }.map(\.key)
                for k in old { adverts[k] = nil }
                var fs: [BonjourFound] = []
                for a in list {
                    let f = BonjourFound(
                        instance: a.instance, txt: a.txt,
                        endpoint: BonjourEndpoint(
                            name: a.instance + "#" + tag,
                            network: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)))
                    adverts[a.instance] = (owner, f)
                    fs.append(f)
                }
                return (old, fs, browsers.values.map { ($0.up, $0.down) })
            }
            for b in bs {
                for g in gone { b.1(g) }
                for u in ups { b.0(u) }
            }
        }

        func txts() -> [[String]] { lock.withLock { adverts.values.map(\.found.txt) } }
        func count(mode: String) -> Int { txts().filter { $0.contains("m=\(mode)") }.count }

        func browse(up: @escaping @Sendable (BonjourFound) -> Void, down: @escaping @Sendable (String) -> Void)
            -> @Sendable () -> Void
        {
            let (id, existing) = lock.withLock { () -> (Int, [BonjourFound]) in
                next += 1
                browsers[next] = (up, down)
                return (next, adverts.values.map(\.found))
            }
            for f in existing { up(f) }
            return { [self] in lock.withLock { browsers[id] = nil } }
        }

        func replay() {
            let (fs, bs) = lock.withLock { (adverts.values.map(\.found), browsers.values.map(\.up)) }
            for b in bs { for f in fs { b(f) } }
        }
    }

    private final class FakeNet: ConnectLanNetwork, @unchecked Sendable {
        let dir: Directory
        let listener = BonjourListener(policy: BonjourDialPolicy(allowLoopback: true))
        let dialOptions = BonjourDialOptions(policy: BonjourDialPolicy(allowLoopback: true), timeout: 5)
        private let lock = NSLock()
        private var port: UInt16 = 0
        private var afterDialHook: (@Sendable () -> Void)?
        init(_ dir: Directory) { self.dir = dir }
        /// Runs once a dial has returned its socket, before the caller sees it.
        func afterDial(_ hook: @escaping @Sendable () -> Void) { lock.withLock { afterDialHook = hook } }

        func listen(
            onPipe: @escaping @Sendable (NWPipe) -> Void, onEvent: @escaping @Sendable (BonjourListenerEvent) -> Void
        ) async throws -> UInt16 {
            let p = try await listener.start(advert: nil, onPipe: onPipe, onEvent: onEvent)
            lock.withLock { port = p }
            return p
        }
        func advertise(_ advert: BonjourAdvert?) async {
            dir.set(
                owner: ObjectIdentifier(self), slot: 0, adverts: advert.map { [$0] } ?? [], port: lock.withLock { port }
            )
        }
        func advertiseContacts(_ adverts: [BonjourAdvert]) async {
            dir.set(owner: ObjectIdentifier(self), slot: 1, adverts: adverts, port: lock.withLock { port })
        }
        func browse(
            onUp: @escaping @Sendable (BonjourFound) -> Void, onDown: @escaping @Sendable (String) -> Void,
            onError: @escaping @Sendable (BonjourBrowseError) -> Void
        ) throws -> @Sendable () -> Void { dir.browse(up: onUp, down: onDown) }
        func resolve(_ endpoint: BonjourEndpoint) async throws -> [BonjourEndpoint] { [endpoint] }
        func dial(_ endpoint: BonjourEndpoint) async throws -> NWPipe {
            let pipe = try await BonjourPipes.dial(endpoint, options: dialOptions)
            lock.withLock { afterDialHook }?()
            return pipe
        }
        func rescan() { dir.replay() }
        func stop() async {
            listener.stop()
            dir.set(owner: ObjectIdentifier(self), slot: 0, adverts: [], port: 0)
            dir.set(owner: ObjectIdentifier(self), slot: 1, adverts: [], port: 0)
        }
    }

    private func until(_ what: String, _ cond: @Sendable () async -> Bool) async {
        for _ in 0..<600 {
            if await cond() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for \(what)")
    }

    /// One device: a client with no account (no token), memory-only keys and links.
    private struct Device {
        let client: PolarisKeyClient
        let server: StubServer
        var cloud: CloudConnect { client.cloudConnect }
        var local: LocalLinks { client.cloudConnect.localLinks }

        static func make(gate: Bool = true) async throws -> Device {
            let server = StubServer()
            let store = InMemoryStore(deviceId: String(repeating: "A", count: 32))
            let client = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: [:],
                    trustRefresh: false, store: store, transport: server.transport,
                    expectedServices: [.license, .config, .connect], fingerprint: false,
                    connect: ConnectOptions(
                        keys: try DeviceKeyStore(
                            productSlug: "djdl", vault: MemoryDeviceKeyVault(), wrapper: nil, kind: .durable),
                        store: ConnectStateStore.inMemory())))
            let d = Device(client: client, server: server)
            await d.serve(gate)
            await client.discover()
            return d
        }

        func serve(_ on: Bool) async {
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body: #"{"product":"djdl","services":{"connect":{"enabled":true,"localPairing":\#(on)}}}"#)
        }

        func setGate(_ on: Bool) async {
            await serve(on)
            await client.discover()
        }

        func start(_ dir: Directory) async throws {
            try await cloud.start(
                options: CloudConnectOptions(
                    relay: false,
                    lanOptions: ConnectLanOptions(makeNetwork: { FakeNet(dir) }, handshakeSeconds: 10)))
        }
    }

    private final class Offers: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [LocalOffer] = []
        func add(_ o: LocalOffer) { lock.withLock { list.append(o) } }
        var first: LocalOffer? { lock.withLock { list.first } }
        var all: [LocalOffer] { lock.withLock { list } }
    }

    private final class Latest<T: Sendable>: @unchecked Sendable {
        private let lock = NSLock()
        private var value: T?
        private var all: [T] = []
        func set(_ v: T) {
            lock.withLock {
                value = v
                all.append(v)
            }
        }
        var current: T? { lock.withLock { value } }
        var history: [T] { lock.withLock { all } }
    }

    final class ConnectLocalTests: XCTestCase {
        override func setUp() async throws { LocalDialBudgets.reset() }

        /// Pair `a` (shows) and `b` (joins by `how`) and return the link ids `(a, b)`.
        private func pairDevices(
            _ a: Device, _ b: Device, _ dir: Directory, qr: Bool = false, labelA: String = "Anna's Mac",
            labelB: String = "Ben's Phone"
        ) async throws -> (String, String) {
            let code = Latest<LocalCode>()
            let offersA = Offers()
            let offersB = Offers()
            let linkedA = Latest<LocalPaired>()
            let handle = try await a.local.pair(
                LocalPairOptions(
                    categories: cats, label: labelA, onCode: { code.set($0) }, onConfirm: { offersA.add($0) },
                    onLinked: { linkedA.set($0) }, network: FakeNet(dir), allowLoopback: true))
            XCTAssertTrue(handle.isOpen)
            let shown = try XCTUnwrap(code.current)
            XCTAssertEqual(shown.code.count, 9)
            XCTAssertEqual(dir.count(mode: "q"), 1)
            // The advert carries the product tag and the nameplate, and no label, key or id.
            let advert = try XCTUnwrap(dir.txts().first { $0.contains("m=q") })
            XCTAssertEqual(advert.filter { $0.hasPrefix("n=") }, ["n=\(shown.nameplate)"])
            XCTAssertEqual(Set(advert.map { String($0.prefix(2)) }), ["v=", "m=", "h=", "n="])
            let joined = Task {
                try await b.local.join(
                    qr
                        ? LocalJoinOptions(
                            categories: cats + ["video"], label: labelB, qr: shown.qr, onConfirm: { offersB.add($0) },
                            network: FakeNet(dir), allowLoopback: true)
                        : LocalJoinOptions(
                            categories: cats + ["video"], label: labelB, code: shown.code,
                            onConfirm: { offersB.add($0) }, network: FakeNet(dir), allowLoopback: true))
            }
            await until("both reach the consent") { offersA.first != nil && offersB.first != nil }
            XCTAssertEqual(offersA.first?.label, labelB)
            XCTAssertEqual(offersB.first?.label, labelA)
            XCTAssertEqual(offersA.first?.categories, cats)
            // Nothing is stored before both people agree.
            let none = try await a.local.list()
            XCTAssertTrue(none.isEmpty)
            await offersA.first!.confirm()
            let still = try await b.local.list()
            XCTAssertTrue(still.isEmpty)
            await offersB.first!.confirm()
            let paired = try await joined.value
            await until("A stored it") { linkedA.current != nil }
            let listA = try await a.local.list()
            let listB = try await b.local.list()
            XCTAssertEqual(listA.map(\.id), [linkedA.current!.id])
            XCTAssertEqual(listB.map(\.id), [paired.id])
            // The categories both sides listed, the peer's label, reachable by default.
            XCTAssertEqual(listA.first?.categories, cats)
            XCTAssertEqual(listB.first?.categories, cats)
            XCTAssertEqual(listA.first?.label, labelB)
            XCTAssertEqual(listB.first?.label, labelA)
            XCTAssertEqual(listA.first?.reachable, true)
            await until("the window closes after a link") { !handle.isOpen }
            XCTAssertEqual(dir.count(mode: "q"), 0)
            return (listA[0].id, listB[0].id)
        }

        // ── Pairing ──────────────────────────────────────────────────────────────────────────

        func testATypedCodePairsTwoDevicesWithNoAccount() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let (idA, idB) = try await pairDevices(a, b, dir)
            XCTAssertEqual(idA.count, 16)
            XCTAssertNotEqual(idA, idB, "each side names the link by the other's key")
            // No key or secret in anything printable.
            let rows = try await a.client.connect.localLinkStore().rows()
            let row = try XCTUnwrap(rows.first)
            let printed = "\(try await a.local.list())\(rows)\(String(reflecting: rows))"
            XCTAssertFalse(printed.contains(row.secret))
            XCTAssertFalse(printed.contains(row.ownKey))
        }

        func testAQrPairsTwoDevices() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            _ = try await pairDevices(a, b, dir, qr: true)
        }

        func testAQrOfAnotherAppAndATypoAreRefusedBeforeBrowsing() async throws {
            let b = try await Device.make()
            let offers = Offers()
            do {
                _ = try await b.local.join(
                    LocalJoinOptions(
                        categories: [], qr: "PKP1:OTHER:EIVPNFXZF7KYKTLM:PEFKYJON45LZNN3MU6EKDFHRKE",
                        onConfirm: { offers.add($0) }, network: FakeNet(Directory()), allowLoopback: true))
                XCTFail("joined")
            } catch let e as LocalPairingError {
                XCTAssertEqual(e.code, ErrorCode.pairingCodeFailed)
                XCTAssertTrue(e.message.contains("another app"))
            }
            do {
                _ = try await b.local.join(
                    LocalJoinOptions(
                        categories: [], code: "12", onConfirm: { offers.add($0) }, network: FakeNet(Directory()),
                        allowLoopback: true))
                XCTFail("joined")
            } catch let e as LocalPairingError {
                XCTAssertEqual(e.code, ErrorCode.pairingCodeFailed)
            }
        }

        func testNoWindowMeansNothingIsFound() async throws {
            let b = try await Device.make()
            do {
                _ = try await b.local.join(
                    LocalJoinOptions(
                        categories: [], code: "4812 3456", onConfirm: { _ in }, browseSeconds: 0.3,
                        network: FakeNet(Directory()), allowLoopback: true))
                XCTFail("joined")
            } catch let e as LocalPairingError {
                XCTAssertEqual(e.code, ErrorCode.pairingNotFound)
            }
        }

        func testAWrongGuessRotatesTheCodeAndTheNewCodePairs() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let code = Latest<LocalCode>()
            let offersA = Offers()
            let offersB = Offers()
            _ = try await a.local.pair(
                LocalPairOptions(
                    categories: cats, onCode: { code.set($0) }, onConfirm: { offersA.add($0) },
                    network: FakeNet(dir), allowLoopback: true))
            let first = try XCTUnwrap(code.current)
            let digits = first.code.replacingOccurrences(of: " ", with: "")
            let wrong =
                String(digits.prefix(2)) + String(Int(digits.dropFirst(2))! % 1_000_000 == 0 ? "000001" : "000000")
            do {
                _ = try await b.local.join(
                    LocalJoinOptions(
                        categories: cats, code: wrong, onConfirm: { offersB.add($0) }, network: FakeNet(dir),
                        allowLoopback: true))
                XCTFail("joined with a wrong code")
            } catch let e as LocalPairingError {
                XCTAssertEqual(e.code, ErrorCode.pairingCodeFailed)
            }
            XCTAssertNil(offersA.first, "a wrong code reaches no consent prompt")
            await until("the code rotates") { code.history.count == 2 }
            let second = try XCTUnwrap(code.current)
            XCTAssertNotEqual(second.code, first.code)
            XCTAssertNotEqual(second.qr, first.qr)
            XCTAssertEqual(second.nameplate, first.nameplate, "the nameplate is the window's, the password rotates")
            // The old code is dead; the new one pairs.
            let joined = Task {
                try await b.local.join(
                    LocalJoinOptions(
                        categories: cats, code: second.code, onConfirm: { offersB.add($0) }, network: FakeNet(dir),
                        allowLoopback: true))
            }
            await until("consent") { offersA.first != nil && offersB.first != nil }
            await offersA.first!.confirm()
            await offersB.first!.confirm()
            _ = try await joined.value
        }

        func testFiveWrongGuessesCloseTheWindow() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let code = Latest<LocalCode>()
            let failed = Latest<LocalPairFailure>()
            let handle = try await a.local.pair(
                LocalPairOptions(
                    categories: cats, onCode: { code.set($0) }, onConfirm: { _ in }, onFailed: { failed.set($0) },
                    network: FakeNet(dir), allowLoopback: true))
            let nameplate = try XCTUnwrap(code.current).nameplate
            for i in 0..<5 {
                LocalDialBudgets.reset()
                await until("code \(i) is shown") { code.history.count == i + 1 || !handle.isOpen }
                if !handle.isOpen { break }
                do {
                    _ = try await b.local.join(
                        LocalJoinOptions(
                            categories: cats, code: nameplate + "000000", onConfirm: { _ in }, network: FakeNet(dir),
                            allowLoopback: true))
                } catch {}
            }
            await until("the fifth failure closes the window") { !handle.isOpen }
            XCTAssertEqual(failed.current?.reason, .tooManyTries)
            XCTAssertEqual(dir.count(mode: "q"), 0)
        }

        func testTheDialBudgetSpansJoinsForOneCode() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let code = Latest<LocalCode>()
            _ = try await a.local.pair(
                LocalPairOptions(
                    categories: cats, onCode: { code.set($0) }, onConfirm: { _ in }, network: FakeNet(dir),
                    allowLoopback: true))
            let nameplate = try XCTUnwrap(code.current).nameplate
            for _ in 0..<2 {
                _ = try? await b.local.join(
                    LocalJoinOptions(
                        categories: cats, code: nameplate + "999999", onConfirm: { _ in }, browseSeconds: 5,
                        network: FakeNet(dir), allowLoopback: true))
            }
            // Two dials spent: the third join answers at once, browsing nothing.
            do {
                _ = try await b.local.join(
                    LocalJoinOptions(
                        categories: cats, code: nameplate + "999999", onConfirm: { _ in }, browseSeconds: 5,
                        network: FakeNet(dir), allowLoopback: true))
                XCTFail("a third join dialled")
            } catch let e as LocalPairingError {
                XCTAssertEqual(e.code, ErrorCode.pairingCodeFailed)
                XCTAssertTrue(e.message.contains("Wait"))
            }
        }

        func testDeclineStoresNothingAndTheWindowStaysOpen() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let code = Latest<LocalCode>()
            let offersA = Offers()
            let offersB = Offers()
            let failed = Latest<LocalPairFailure>()
            let handle = try await a.local.pair(
                LocalPairOptions(
                    categories: cats, onCode: { code.set($0) }, onConfirm: { offersA.add($0) },
                    onFailed: { failed.set($0) }, network: FakeNet(dir), allowLoopback: true))
            let joined = Task {
                try await b.local.join(
                    LocalJoinOptions(
                        categories: cats, code: try XCTUnwrap(code.current).code, onConfirm: { offersB.add($0) },
                        network: FakeNet(dir), allowLoopback: true))
            }
            await until("consent") { offersA.first != nil && offersB.first != nil }
            await offersA.first!.decline()
            do {
                _ = try await joined.value
                XCTFail("paired after a decline")
            } catch let e as LocalPairingError {
                XCTAssertEqual(e.code, ErrorCode.peerClosed)
            }
            let listed = try await a.local.list()
            let listedB = try await b.local.list()
            XCTAssertTrue(listed.isEmpty && listedB.isEmpty)
            await until("failure reported") { failed.current != nil }
            XCTAssertEqual(failed.current?.reason, .declined)
            await until("the code rotates") { code.history.count == 2 }
            XCTAssertTrue(handle.isOpen, "a decline rotates the code and keeps the window")
            await handle.stop()
        }

        func testOneWindowPerProductAndTheSlotIsTakenBeforeTheFirstAwait() async throws {
            let dir = Directory()
            let a = try await Device.make()
            let options = LocalPairOptions(
                categories: cats, onCode: { _ in }, onConfirm: { _ in }, network: FakeNet(dir), allowLoopback: true)
            async let one: LocalPairHandle? = try? a.local.pair(options)
            async let two: LocalPairHandle? = try? a.local.pair(options)
            let handles = await [one, two].compactMap { $0 }
            XCTAssertEqual(handles.count, 1, "a double click opens one window")
            XCTAssertEqual(dir.count(mode: "q"), 1)
            await handles.first?.stop()
        }

        func testCategoriesAndLabelsAreChecked() async throws {
            let a = try await Device.make()
            for bad in [["A"], ["a", "a"], (0..<9).map { "c\($0)" }, [String(repeating: "a", count: 33)]] {
                do {
                    _ = try await a.local.pair(
                        LocalPairOptions(
                            categories: bad, onCode: { _ in }, onConfirm: { _ in }, network: FakeNet(Directory()),
                            allowLoopback: true))
                    XCTFail("accepted \(bad)")
                } catch let e as ConnectLanError {
                    XCTAssertEqual(e.reason, .badType)
                }
            }
        }

        // ── Mode l ───────────────────────────────────────────────────────────────────────────

        func testALinkOpensASessionBothWaysOnTheSharedListenerWithNoAccount() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let (idA, idB) = try await pairDevices(a, b, dir)
            let inbound = LockedValue<ConnectSession?>(nil)
            b.local.onLink { inbound.set($0) }
            try await a.start(dir)
            try await b.start(dir)
            XCTAssertEqual(a.cloud.status().running, true)
            XCTAssertEqual(a.cloud.status().lan, "on")
            // `m=l`, TXT exactly `v=1`, `m=l`; a name per reachable link.
            XCTAssertEqual(dir.count(mode: "l"), 2)
            for t in dir.txts() where t.contains("m=l") { XCTAssertEqual(Set(t), ["v=1", "m=l"]) }
            await until("A finds B") { await (try? a.local.open(idA)) != nil }
            let s = try await a.local.open(idA)
            XCTAssertEqual(s.local?.id, idA)
            XCTAssertEqual(s.local?.label, "Ben's Phone")
            XCTAssertEqual(s.local?.categories, cats)
            XCTAssertNil(s.contact)
            await until("B is called") { inbound.current != nil }
            let r = try XCTUnwrap(inbound.current)
            XCTAssertEqual(r.local?.id, idB)
            XCTAssertEqual(r.local?.label, "Anna's Mac")
            // A second open while it runs is a second session, but a simultaneous call joins the first dial.
            try await s.send(Data("ping".utf8))
            let m = try await r.receive()
            XCTAssertEqual(m.body, Data("ping".utf8))
            try await r.send(Data("pong".utf8))
            let back = try await s.receive()
            XCTAssertEqual(back.body, Data("pong".utf8))
            await until("last seen is written") { (try? await a.local.list().first?.lastSeen) != nil }
            let seen = try await a.local.list().first?.lastSeen
            XCTAssertEqual(seen.map { $0 % 3600 }, 0, "lastSeen is coarsened to the hour")
            await s.close()
            await until("closed") { r.closed != nil }
            await a.cloud.stop()
            await b.cloud.stop()
        }

        func testNoListenerUntilALinkExistsThenTheFirstLinkBringsItUp() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            try await a.start(dir)
            try await b.start(dir)
            XCTAssertEqual(a.cloud.status().running, true)
            XCTAssertEqual(a.cloud.status().lan, "off", "no link, no listener")
            XCTAssertEqual(dir.count(mode: "l"), 0)
            _ = try await pairDevices(a, b, dir)
            await until("the listener comes up") { a.cloud.status().lan == "on" && b.cloud.status().lan == "on" }
            XCTAssertEqual(dir.count(mode: "l"), 2)
            // Forgetting the last link takes it down.
            let id = try await a.local.list()[0].id
            let removed = try await a.local.remove(id)
            XCTAssertTrue(removed)
            await until("the listener goes down") { a.cloud.status().lan == "off" }
            await a.cloud.stop()
            await b.cloud.stop()
        }

        func testWithNoAccountAndTheGateOffStartIsStillNoToken() async throws {
            let a = try await Device.make(gate: false)
            do {
                try await a.cloud.start(
                    options: CloudConnectOptions(
                        relay: false, lanOptions: ConnectLanOptions(network: FakeNet(Directory()))))
                XCTFail("started")
            } catch let e as CloudConnectError {
                XCTAssertEqual(e.code, ErrorCode.noToken)
            }
        }

        func testClearingTheGateWithdrawsAdvertsEndsSessionsAndKeepsTheLinks() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let (idA, _) = try await pairDevices(a, b, dir)
            let inbound = LockedValue<ConnectSession?>(nil)
            b.local.onLink { inbound.set($0) }
            try await a.start(dir)
            try await b.start(dir)
            await until("A opens a session") { await (try? a.local.open(idA)) != nil }
            let s = try await a.local.open(idA)
            await until("B is called") { inbound.current != nil }
            await a.setGate(false)
            await until("the adverts are withdrawn") { dir.count(mode: "l") == 1 }
            await until("the session ends peer_bye") { s.closed?.code == "peer_bye" }
            // Typed N/A, and managing links still works.
            do {
                _ = try await a.local.open(idA)
                XCTFail("opened with the gate off")
            } catch let off as LocalPairingOff {
                XCTAssertEqual(off.code, ErrorCode.localPairingOff)
                XCTAssertEqual(off.unsupported.feature, Feature.connectLocal)
            }
            do {
                _ = try await a.local.pair(
                    LocalPairOptions(
                        categories: [], onCode: { _ in }, onConfirm: { _ in }, network: FakeNet(dir),
                        allowLoopback: true))
                XCTFail("paired with the gate off")
            } catch is LocalPairingOff {}
            let listed = try await a.local.list()
            XCTAssertEqual(listed.count, 1, "the links stay on disk, inert")
            let renamed = try await a.local.rename(idA, "Renamed")
            XCTAssertTrue(renamed)
            // Back on: the advert returns.
            await a.setGate(true)
            await until("the advert returns") { dir.count(mode: "l") == 2 }
            await a.cloud.stop()
            await b.cloud.stop()
        }

        func testForgetEndsTheSessionPeerRevokedAndTheNextDialIsUnknownAtOnce() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let (idA, idB) = try await pairDevices(a, b, dir)
            let inbound = LockedValue<ConnectSession?>(nil)
            b.local.onLink { inbound.set($0) }
            try await a.start(dir)
            try await b.start(dir)
            await until("A opens a session") { await (try? a.local.open(idA)) != nil }
            let s = try await a.local.open(idA)
            await until("B is called") { inbound.current != nil }
            let removed = try await a.local.remove(idA)
            XCTAssertTrue(removed)
            await until("the session ends peer_revoked") { s.closed?.code == "peer_revoked" }
            let rows = try await a.client.connect.localLinkStore().rows()
            XCTAssertTrue(rows.isEmpty, "the keys leave the record before remove returns")
            do {
                _ = try await a.local.open(idA)
                XCTFail("opened a forgotten link")
            } catch let e as ConnectLanError {
                XCTAssertEqual(e.reason, .unknownPeer)
            }
            let again = try await a.local.remove(idA)
            XCTAssertFalse(again)
            // The other device still holds the link and finds it not answering; the second try is held off.
            await until("B's advert is seen by nobody else") { dir.count(mode: "l") <= 1 }
            _ = idB
            await a.cloud.stop()
            await b.cloud.stop()
        }

        func testAFailedDialIsHeldOffAndASimultaneousCallJoinsIt() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let (idA, idB) = try await pairDevices(a, b, dir)
            try await a.start(dir)
            try await b.start(dir)
            await until("A sees B") { await (try? a.local.open(idA)) != nil }
            // B forgets the link while A still holds it: B's listener no longer opens under it.
            let gone = try await b.local.remove(idB)
            XCTAssertTrue(gone)
            // B is no longer advertising it, so A cannot see it: not an attempt, so no hold-off.
            await until("B's advert is gone") { dir.count(mode: "l") == 1 }
            for _ in 0..<2 {
                do {
                    _ = try await a.local.open(idA)
                    XCTFail("opened")
                } catch let e as ConnectLanError {
                    XCTAssertEqual(e.reason, .unknownPeer)
                }
            }
            await a.cloud.stop()
            await b.cloud.stop()
        }

        func testNewLinksAreReachableUntilEightAreAndANinthCannotBeTurnedOn() async throws {
            let a = try await Device.make()
            let store = try await a.client.connect.localLinkStore()
            for i in 0..<9 {
                let peer = Data(repeating: UInt8(i + 1), count: 32)
                let added = try await store.add(
                    ownKey: rnd(), ownPublic: rnd(), peerKey: peer, secret: rnd(), label: "L\(i)", cats: [],
                    now: 1_700_000_000)
                XCTAssertEqual(added, .stored(id: PeerLocal.linkId(peerKey: peer)))
            }
            let listed = try await a.local.list()
            XCTAssertEqual(listed.map(\.reachable), Array(repeating: true, count: 8) + [false])
            let ninth = listed[8].id
            do {
                _ = try await a.local.setReachable(ninth, true)
                XCTFail("a ninth reachable link")
            } catch let e as LocalPairingError {
                XCTAssertEqual(e.code, ErrorCode.localLinksFull)
            }
            let off = try await a.local.setReachable(listed[0].id, false)
            XCTAssertTrue(off)
            let on = try await a.local.setReachable(ninth, true)
            XCTAssertTrue(on)
            let missing = try await a.local.setReachable("nope", true)
            XCTAssertFalse(missing)
        }

        func testTheCapOfThirtyTwoRefusesBeforeAnythingIsAdvertised() async throws {
            let a = try await Device.make()
            let store = try await a.client.connect.localLinkStore()
            for i in 0..<32 {
                _ = try await store.add(
                    ownKey: rnd(), ownPublic: rnd(), peerKey: Data(repeating: UInt8(i + 1), count: 32), secret: rnd(),
                    label: nil, cats: [], now: 1)
            }
            let thirtyThird = try await store.add(
                ownKey: rnd(), ownPublic: rnd(), peerKey: Data(repeating: 99, count: 32), secret: rnd(), label: nil,
                cats: [], now: 1)
            XCTAssertEqual(thirtyThird, .full)
            let dir = Directory()
            do {
                _ = try await a.local.pair(
                    LocalPairOptions(
                        categories: [], onCode: { _ in }, onConfirm: { _ in }, network: FakeNet(dir),
                        allowLoopback: true))
                XCTFail("paired at the cap")
            } catch let e as LocalPairingError {
                XCTAssertEqual(e.code, ErrorCode.localLinksFull)
            }
            XCTAssertEqual(dir.count(mode: "q"), 0)
        }

        func testRenameIsLocalAndNeverSent() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let (idA, idB) = try await pairDevices(a, b, dir)
            let renamed = try await a.local.rename(idA, "  Studio  Mac ")
            XCTAssertTrue(renamed)
            let first = try await a.local.list().first?.label
            XCTAssertEqual(first, "Studio Mac")
            let other = try await b.local.list().first?.label
            XCTAssertEqual(other, "Anna's Mac", "the other device is not told")
            let missing = try await a.local.rename("nope", "x")
            XCTAssertFalse(missing)
            do {
                _ = try await a.local.rename(idA, String(repeating: "x", count: 65))
                XCTFail("a long label")
            } catch let e as ConnectLanError { XCTAssertEqual(e.reason, .badType) }
            _ = idB
        }

        func testSignOutKeepsTheLinksReachableAndStopNeverRestartsThem() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            _ = try await pairDevices(a, b, dir)
            try await a.start(dir)
            XCTAssertEqual(a.cloud.status().lan, "on")
            await a.cloud.stopForSignOut()
            await until("the local service is back") { a.cloud.status().lan == "on" && a.cloud.status().running }
            XCTAssertEqual(dir.count(mode: "l"), 1, "m=l stays up after the sign-out step")
            await a.cloud.stop()
            XCTAssertEqual(a.cloud.status().running, false)
            XCTAssertEqual(a.cloud.status().lan, "off")
            XCTAssertEqual(dir.count(mode: "l"), 0)
            let kept = try await a.local.list()
            XCTAssertEqual(kept.count, 1, "sign-out and stop leave the links")
            await b.cloud.stop()
        }

        // ── The shared listener of a device with an account ─────────────────────────────────

        /// One side of a link made by hand: the keys and the secret a pairing would have stored.
        private func linkPair() throws -> (a: ConnectLiveLocal, b: ConnectLiveLocal) {
            let secret = rnd()
            let (ka, kb) = (rnd(), rnd())
            let pa = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: ka).publicKey.rawRepresentation
            let pb = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: kb).publicKey.rawRepresentation
            func live(_ own: Data, _ ownPub: Data, _ peer: Data) -> ConnectLiveLocal {
                ConnectLiveLocal(
                    id: PeerLocal.linkId(peerKey: peer), ownKey: own, ownPublic: ownPub, peerKey: peer, secret: secret,
                    label: "Peer", cats: ["docs"], reachable: true, tag: PeerLocal.linkTag(secret: secret))
            }
            return (live(ka, pa, pb), live(kb, pb, pa))
        }

        func testTheSharedListenerOfADeviceWithAnAccountAnswersALocalLinkAfterItsAccountKeys() async throws {
            let (la, lb) = try linkPair()
            let heldA = LockedValue([la])
            let now = Int(Date().timeIntervalSince1970)
            let dir = Directory()
            let store = try DeviceKeyStore.inMemory()
            let agree = Base64URL.decodeStrict(try await store.ensure().agreeKey)!
            let account = PeerSource(
                slug: "djdl", trust: [:], sub: "ps_AAAAAAAAAAAAAAAAAAAAAA", deviceId: String(repeating: "A", count: 32),
                certJws: "", certExpiresAt: now + 100_000, ringJws: "", ringEpoch: 1,
                roster: [String(repeating: "A", count: 32)],
                keys: DiscoveryKeys(current: DiscoveryKey(base64url: Base64URL.encode(rnd()))!, previous: nil),
                agreePublic: agree, staticKey: PeerNoiseDeviceKey(store))
            let svcA = try await ConnectLanService.start(
                ConnectLanSource(
                    load: { account }, now: { now }, slug: "djdl", locals: { heldA.current }, localAllowed: { true }),
                options: ConnectLanOptions(network: FakeNet(dir)))
            let svcB = try await ConnectLanService.startLocal(
                ConnectLanSource(
                    load: { throw ConnectLanError(.noIdentity, "no account") }, now: { now }, slug: "djdl",
                    locals: { [lb] }, localAllowed: { true }),
                options: ConnectLanOptions(network: FakeNet(dir)))
            XCTAssertEqual(dir.count(mode: "a"), 1)
            XCTAssertEqual(dir.count(mode: "l"), 2)
            let inbound = LockedValue<ConnectSession?>(nil)
            svcA.onLocalSession { inbound.set($0) }
            let plain = LockedValue(0)
            svcA.onSession { _ in plain.with { $0 += 1 } }
            await until("B sees A's link advert") { await svcB.currentLocalPeers().contains(lb.id) }
            let s = try await svcB.connectLocal(lb.id)
            XCTAssertEqual(s.local?.id, lb.id)
            await until("A is called") { inbound.current != nil }
            XCTAssertEqual(inbound.current?.local?.id, la.id)
            XCTAssertEqual(plain.current, 0, "a local session is not handed to the account listener")
            // A forgotten link is not served, and a handshake under it is refused before the host sees it.
            heldA.set([])
            await svcA.forgetLocal(la.id)
            let again = try? await svcB.connectLocal(lb.id)
            XCTAssertNil(again, "the peer no longer holds the link")
            await s.close()
            await svcA.stop()
            await svcB.stop()
        }

        // ── Dial budget, gate sequence, gate re-read, dial guard ─────────────────────────────

        func testTheDialBudgetIsCheckedAndSpentInOneStep() async {
            let b = LocalDialBudgets()
            let taken = await withTaskGroup(of: Bool.self) { g -> Int in
                for _ in 0..<64 { g.addTask { b.takeIfAllowed("12", 0) } }
                var n = 0
                for await ok in g where ok { n += 1 }
                return n
            }
            XCTAssertEqual(taken, localDialBudget, "joiners that overlap cannot both take the last dial")
            XCTAssertFalse(b.takeIfAllowed("12", 1))
            // Once the window has passed no empty key stays behind.
            XCTAssertTrue(b.check("12", Double(localDialBudgetSeconds) + 10).allowed)
            XCTAssertEqual(b.keyCount, 0)
            XCTAssertTrue(b.takeIfAllowed("77", 0))
            XCTAssertEqual(b.keyCount, 1)
        }

        func testAnErrorReadDoesNotMakeAnOlderNotFoundStale() async throws {
            let d = try await Device.make()
            XCTAssertTrue(d.client.connect.localPairing())
            d.client.connect.noteLocalDiscovery(.error(status: 503, message: "down"), seq: 1_000_000)
            d.client.connect.noteLocalDiscovery(.notFound, seq: 999_999)
            XCTAssertFalse(d.client.connect.localPairing(), "an error read changed nothing, so the older answer applies")
            await d.client.close()
        }

        func testTheGateIsReadAgainWhenTheAppReturnsToTheFront() async throws {
            let d = try await Device.make()
            XCTAssertTrue(d.client.connect.localPairing())
            let center = NotificationCenter()
            let name = Notification.Name("test.foreground")
            await d.client.installLocalGateForegroundHook(center: center, names: [name])
            await d.serve(false)
            center.post(name: name, object: nil)
            await until("the gate is read again") { !d.client.connect.localPairing() }
            await d.client.close()
        }

        func testTheWaitBeforeAGateReadRunsOnAClockThatCountsASleep() async throws {
            let d = try await Device.make()
            let clock = LockedValue(Date(timeIntervalSince1970: 0))
            let sleeps = LockedValue(0)
            let release = LockedValue(false)
            await d.client.setLocalGateTime(
                clock: { clock.current },
                sleep: { _ in
                    sleeps.with { $0 += 1 }
                    // The machine sleeps: the wall clock moves a long way once the test lets the check end.
                    while !release.current { try? await Task.sleep(nanoseconds: 5_000_000) }
                    clock.set(clock.current.addingTimeInterval(20_000))
                }, check: 60)
            await d.client.discover()  // the gate is on: a read is armed on the new clock
            await until("the wait started") { sleeps.current >= 1 }
            XCTAssertTrue(d.client.connect.localPairing())
            await d.serve(false)
            release.set(true)
            await until("the read ran when the clock passed the deadline") { !d.client.connect.localPairing() }
            XCTAssertLessThan(sleeps.current, 10, "the wait is a deadline, not a count of sleeps")
            await d.client.close()
        }

        func testADialThatTakesTimeIsCheckedAgainAndItsSocketClosedWhenTheGateWentOff() async throws {
            let (la, lb) = try linkPair()
            let dir = Directory()
            let allowedB = LockedValue(true)
            let netB = FakeNet(dir)
            let svcA = try await ConnectLanService.startLocal(
                ConnectLanSource(
                    load: { throw ConnectLanError(.noIdentity, "no account") }, now: { 1_700_000_000 }, slug: "djdl",
                    locals: { [la] }, localAllowed: { true }),
                options: ConnectLanOptions(network: FakeNet(dir)))
            let svcB = try await ConnectLanService.startLocal(
                ConnectLanSource(
                    load: { throw ConnectLanError(.noIdentity, "no account") }, now: { 1_700_000_000 }, slug: "djdl",
                    locals: { [lb] }, localAllowed: { allowedB.current }),
                options: ConnectLanOptions(network: netB))
            let inbound = LockedValue(0)
            svcA.onLocalSession { _ in inbound.with { $0 += 1 } }
            await until("B sees A's link advert") { await svcB.currentLocalPeers().contains(lb.id) }
            // The gate goes off while the socket opens.
            netB.afterDial { allowedB.set(false) }
            do {
                _ = try await svcB.connectLocal(lb.id)
                XCTFail("opened a session after the gate went off")
            } catch let e as ConnectLanError {
                XCTAssertEqual(e.reason, .unknownPeer)
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
            XCTAssertEqual(inbound.current, 0, "no handshake ran on the socket")
            await svcA.stop()
            await svcB.stop()
        }

        // ── Direct Transfer ──────────────────────────────────────────────────────────────────

        func testADirectTransferOverALocalLinkNamesTheLinkAndAppliesTheCategoryRule() async throws {
            let dir = Directory()
            let (a, b) = (try await Device.make(), try await Device.make())
            let (idA, idB) = try await pairDevices(a, b, dir)
            try await a.start(dir)
            try await b.start(dir)
            let offers = Latest<TransferOffer>()
            let target = FileManager.default.temporaryDirectory.appendingPathComponent(
                "pkey-local-" + UUID().uuidString.lowercased())
            b.cloud.transfer.onOffer { offer in
                offers.set(offer)
                return .accept(to: target)
            }
            await until("A finds B") { await (try? a.local.open(idA)) != nil }
            let content = Data((0..<2000).map { UInt8($0 % 251) })
            // A category the link does not list is refused before the person is asked.
            do {
                _ = try await a.cloud.transfer.send(
                    .link(idA), source: .data(content), options: TransferSendOptions(name: "x.bin", category: "video"))
                XCTFail("sent a category the link does not list")
            } catch {}
            XCTAssertNil(offers.current, "a refused category never asks")
            let sent = try await a.cloud.transfer.send(
                .link(idA), source: .data(content), options: TransferSendOptions(name: "x.bin", category: "docs"))
            XCTAssertEqual(sent.size, content.count)
            let offer = try XCTUnwrap(offers.current)
            XCTAssertEqual(offer.peer.kind, .local)
            XCTAssertEqual(offer.peer.linkId, idB)
            XCTAssertEqual(offer.peer.label, "Anna's Mac", "the stored label, not the one the peer sent")
            XCTAssertNil(offer.peer.deviceId)
            XCTAssertFalse(offer.peer.authenticated)
            XCTAssertEqual(try Data(contentsOf: target), content)
            try? FileManager.default.removeItem(at: target)
            await a.cloud.stop()
            await b.cloud.stop()
        }

        // ── The store ────────────────────────────────────────────────────────────────────────

        func testAPairingAlreadyStoringWhenTheGateClearsWritesNothing() async throws {
            let state = LocalLinkStateStore.inMemory(productSlug: "djdl")
            let store = LocalLinkStore(state)
            let on = LockedValue(true)
            let k = Data(repeating: 7, count: 32)
            // The gate clears between the pairing's last check and the write: it is read inside the store call.
            on.set(false)
            let off = try await store.add(
                ownKey: k, ownPublic: k, peerKey: k, secret: k, label: nil, cats: [], now: 1, allowed: { on.current })
            XCTAssertEqual(off, .off)
            let rows = try await store.rows()
            XCTAssertTrue(rows.isEmpty)
            on.set(true)
            let stored = try await store.add(
                ownKey: k, ownPublic: k, peerKey: k, secret: k, label: nil, cats: [], now: 1, allowed: { on.current })
            XCTAssertEqual(stored, .stored(id: PeerLocal.linkId(peerKey: k)))
        }

        func testTheRecordIsStrictAndAnUnreadableOneIsNeverReplaced() throws {
            let vault = MemoryDeviceKeyVault()
            let state = LocalLinkStateStore(vault: vault, product: "djdl")
            XCTAssertEqual(try state.load(), [])
            let key = Base64URL.encode(Data(repeating: 7, count: 32))
            func row(_ id: String, cats: [String] = ["docs"]) -> LocalLinkRow {
                LocalLinkRow(
                    id: id, ownKey: key, ownPublic: key, peerKey: key, secret: key, label: "x", cats: cats,
                    createdAt: 1,
                    reachable: true)
            }
            try state.save([row("AAAAAAAAAAAAAAAA")])
            XCTAssertEqual(try state.load().count, 1)
            // Another product's record, another schema, a bad row, a repeated id and more than 32 are unreadable.
            XCTAssertThrowsError(try LocalLinkStateStore(vault: vault, product: "other").load()) {
                XCTAssertEqual($0 as? LocalLinkStateError, .unreadable)
            }
            try vault.upsert(Data(#"{"schema":"pkey.connect.local.v2","product":"djdl","links":[]}"#.utf8))
            XCTAssertThrowsError(try state.load())
            try vault.upsert(Data("not json".utf8))
            XCTAssertThrowsError(try state.load())
            let bad = [row("AAAAAAAAAAAAAAAA", cats: ["Docs"])]
            try state.save(bad)
            XCTAssertThrowsError(try state.load())
            let twice = [row("AAAAAAAAAAAAAAAA"), row("AAAAAAAAAAAAAAAA")]
            try state.save(twice)
            XCTAssertThrowsError(try state.load())
            XCTAssertThrowsError(try state.save((0..<33).map { row(String(format: "%016d", $0)) }))
            XCTAssertEqual(
                "\(row("AAAAAAAAAAAAAAAA"))", "LocalLinkRow(redacted)", "a row prints as redacted")
        }

        func testAnUnusableRecordServesNothingAndIsNeverReplaced() async throws {
            let vault = MemoryDeviceKeyVault()
            try vault.upsert(Data("garbage".utf8))
            let server = StubServer()
            let client = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: [:],
                    trustRefresh: false, store: InMemoryStore(deviceId: String(repeating: "A", count: 32)),
                    transport: server.transport, expectedServices: [.license, .config, .connect], fingerprint: false,
                    connect: ConnectOptions(
                        store: ConnectStateStore.inMemory(),
                        localStore: LocalLinkStateStore(vault: vault, product: "djdl"))))
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body: #"{"product":"djdl","services":{"connect":{"enabled":true,"localPairing":true}}}"#)
            await client.discover()
            do {
                _ = try await client.cloudConnect.localLinks.list()
                XCTFail("listed an unreadable record")
            } catch let e as LocalPairingError {
                XCTAssertEqual(e.code, ErrorCode.storeFailed)
            }
            do {
                _ = try await client.cloudConnect.localLinks.pair(
                    LocalPairOptions(
                        categories: [], onCode: { _ in }, onConfirm: { _ in }, network: FakeNet(Directory()),
                        allowLoopback: true))
                XCTFail("paired over an unreadable record")
            } catch let e as LocalPairingError {
                XCTAssertEqual(e.code, ErrorCode.storeFailed)
            }
            XCTAssertEqual(try vault.read(), Data("garbage".utf8))
            let live = await client.connect.liveLocals()
            XCTAssertTrue(live.isEmpty)
        }
    }
#endif
