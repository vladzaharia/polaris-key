// @pkey-feature connect.links
// CC-19.7: inter-account links through the Swift SDK (WIRE-CONTRACT-V5 §15.4, §15.7, §15.10): the contact rows in the
// Connect record, the typed gate, the contact ticket, two accounts meeting in mode `c` over the LAN (a fake
// directory, real loopback TCP) and through a contact room (an in-process room that speaks aliases). The
// corpus `contact` rows and the two-channel pairing are in `PeerContactTests.swift`; the transcripts replay in
// `TranscriptTests.swift`. Mirrors the Node package's `test/connect/links.test.ts`.

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

    private let idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    private let idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
    private let t0 = Int(Date().timeIntervalSince1970) / 900 * 900 + 100

    private func rnd(_ n: Int = 32) -> Data { Data((0..<n).map { _ in UInt8.random(in: 0...255) }) }

    private struct Dev {
        let id: String
        let store: DeviceKeyStore
        let agreeKey: String
        init(_ id: String) async throws {
            self.id = id
            store = try DeviceKeyStore.inMemory()
            agreeKey = try await store.ensure().agreeKey
        }
        func source() -> PeerSource {
            PeerSource(
                slug: "djdl", trust: [:], sub: "ps_\(id.prefix(22))", deviceId: id, certJws: "",
                certExpiresAt: t0 + 100_000,
                ringJws: "", ringEpoch: 1, roster: [id],
                keys: DiscoveryKeys(current: DiscoveryKey(base64url: Base64URL.encode(rnd()))!, previous: nil),
                agreePublic: Base64URL.decodeStrict(agreeKey)!, staticKey: PeerNoiseDeviceKey(store))
        }
    }

    /// Two devices of two accounts and the contact between them (what a pairing would have stored).
    private struct Link {
        let a: Dev, b: Dev
        let secret = rnd()
        func contactForA(reachable: Bool = true, pending: Bool = false, agreeKey: String? = nil) -> ConnectLiveContact {
            live(agreeKey ?? b.agreeKey, reachable, pending)
        }
        func contactForB(reachable: Bool = true) -> ConnectLiveContact { live(a.agreeKey, reachable, false) }
        private func live(_ key: String, _ reachable: Bool, _ pending: Bool) -> ConnectLiveContact {
            ConnectLiveContact(
                id: ConnectContacts.id(key), agreeKey: key, agreeKeyBytes: Base64URL.decodeStrict(key)!, secret: secret,
                label: "Peer", cats: ["docs"], reachable: reachable, pending: pending)
        }
    }

    // ── The fake directory: many adverts per owner ───────────────────────────────────────────────

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

        func names() -> Set<String> { lock.withLock { Set(adverts.keys) } }

        func endpoints() -> [BonjourEndpoint] { lock.withLock { adverts.values.map(\.found.endpoint) } }

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
        private var listened = false
        init(_ dir: Directory) { self.dir = dir }

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
            try await BonjourPipes.dial(endpoint, options: dialOptions)
        }
        func rescan() { dir.replay() }
        func stop() async {
            listener.stop()
            dir.set(owner: ObjectIdentifier(self), slot: 0, adverts: [], port: 0)
            dir.set(owner: ObjectIdentifier(self), slot: 1, adverts: [], port: 0)
        }
    }

    private final class Contacts: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [ConnectLiveContact]
        private let signal = ConnectSignal()
        private var _promoted: [ConnectContactRef] = []
        init(_ l: [ConnectLiveContact]) { list = l }
        var current: [ConnectLiveContact] { lock.withLock { list } }
        func set(_ l: [ConnectLiveContact]) {
            lock.withLock { list = l }
            signal.fire()
        }
        func onChange(_ fn: @escaping @Sendable () -> Void) -> @Sendable () -> Void { signal.add(fn) }
        var promoted: [ConnectContactRef] { lock.withLock { _promoted } }
        func promote(_ r: ConnectContactRef) { lock.withLock { _promoted.append(r) } }
    }

    private func until(_ what: String, _ cond: @Sendable () async -> Bool) async {
        for _ in 0..<400 {
            if await cond() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for \(what)")
    }

    private func lanSource(_ d: Dev, _ c: Contacts) -> ConnectLanSource {
        let src = d.source()
        return ConnectLanSource(
            load: { src }, now: { t0 }, contacts: { c.current }, onContacts: { fn in c.onChange(fn) },
            contactEstablished: { c.promote($0) })
    }

    // ── LAN ──────────────────────────────────────────────────────────────────────────────────────

    final class ConnectLinksLanTests: XCTestCase {
        private func start(_ d: Dev, _ c: Contacts, _ dir: Directory) async throws -> ConnectLanService {
            try await ConnectLanService.start(
                lanSource(d, c), options: ConnectLanOptions(network: FakeNet(dir)))
        }

        func testTwoAccountsMeetInModeCAndTheContactIsCarried() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let dir = Directory()
            let ca = Contacts([link.contactForA()])
            let cb = Contacts([link.contactForB()])
            let a = try await start(link.a, ca, dir)
            let b = try await start(link.b, cb, dir)
            let inbound = LockedValue<ConnectSession?>(nil)
            b.onContactSession { inbound.set($0) }
            let plain = LockedValue(0)
            b.onSession { _ in plain.with { $0 += 1 } }
            // Account adverts plus one contact advert each: the names differ per advertiser.
            XCTAssertEqual(dir.names().count, 4)
            await until("A sees B's contact advert") { await !a.currentContactPeers().isEmpty }
            let s = try await a.connectContact(link.contactForA().id)
            XCTAssertEqual(s.contact?.id, link.contactForA().id)
            XCTAssertEqual(s.contact?.label, "Peer")
            XCTAssertEqual(s.contact?.categories, ["docs"])
            XCTAssertEqual(s.peerDeviceId, "", "mode c has no device id")
            await until("inbound") { inbound.current != nil }
            let r = inbound.current!
            XCTAssertEqual(r.contact?.id, link.contactForB().id)
            XCTAssertEqual(plain.current, 0, "a contact session is not handed to the account listener")
            try await s.send(Data("ping".utf8))
            let m = try await r.receive()
            XCTAssertEqual(m.body, Data("ping".utf8))
            await s.close()
            await until("closed") { r.closed != nil }
            await a.stop()
            await b.stop()
        }

        func testNothingIsAdvertisedOrAnsweredWhileLinksAreOff() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let dir = Directory()
            // The gate is off: the source hands out no contacts.
            let a = try await start(link.a, Contacts([]), dir)
            let b = try await start(link.b, Contacts([]), dir)
            XCTAssertEqual(dir.names().count, 2, "account adverts only")
            let peers = await a.currentContactPeers()
            XCTAssertTrue(peers.isEmpty)
            await a.stop()
            await b.stop()
        }

        func testAContactNotMarkedReachableIsNotAdvertised() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let dir = Directory()
            let a = try await start(link.a, Contacts([link.contactForA(reachable: false)]), dir)
            XCTAssertEqual(dir.names().count, 1)
            await a.stop()
        }

        func testTheLiveAdvertsAreCappedAtEight() async throws {
            let a = try await Dev(idA)
            let many = (0..<12).map { i -> ConnectLiveContact in
                let key = Base64URL.encode(rnd())
                _ = i
                return ConnectLiveContact(
                    id: ConnectContacts.id(key), agreeKey: key, agreeKeyBytes: Base64URL.decodeStrict(key)!,
                    secret: rnd(),
                    label: nil, cats: [], reachable: true, pending: false)
            }
            let dir = Directory()
            let s = try await start(a, Contacts(many), dir)
            XCTAssertEqual(dir.names().count, 1 + maxLiveContactAdverts)
            await s.stop()
        }

        func testRemovingAContactWithdrawsItsAdvertAndStopsAnsweringIt() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let dir = Directory()
            let ca = Contacts([link.contactForA()])
            let cb = Contacts([link.contactForB()])
            let a = try await start(link.a, ca, dir)
            let b = try await start(link.b, cb, dir)
            await until("A sees B") { await !a.currentContactPeers().isEmpty }
            XCTAssertEqual(dir.names().count, 4)
            cb.set([])
            await until("B's contact advert is gone") { dir.names().count == 3 }
            // B no longer holds the secret: a dial from A fails the handshake silently.
            do {
                _ = try await a.connectContact(link.contactForA().id)
                XCTFail("B answered a removed contact")
            } catch {}
            await a.stop()
            await b.stop()
        }

        func testAHandshakeInFlightWhenTheContactIsRemovedIsEnded() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let dir = Directory()
            let ca = Contacts([link.contactForA()])
            let cb = Contacts([link.contactForB()])
            let a = try await start(link.a, ca, dir)
            let b = try await start(link.b, cb, dir)
            await until("A sees B") { await !a.currentContactPeers().isEmpty }
            // A raw connection to B's listener that sends nothing: B holds its contacts for this handshake.
            let endpoints = dir.endpoints().filter { $0.name.hasSuffix("#1") }
            XCTAssertEqual(endpoints.count, 2)
            let ended = expectation(description: "B ended the handshake")
            ended.assertForOverFulfill = false
            var conns: [NWConnection] = []
            for e in endpoints {
                let conn = NWConnection(to: e.network!, using: .tcp)
                let ready = expectation(description: "ready")
                conn.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
                conn.start(queue: .global())
                await fulfillment(of: [ready], timeout: 5)
                conns.append(conn)
            }
            try await Task.sleep(nanoseconds: 500_000_000)
            cb.set([])
            for conn in conns {
                conn.receive(minimumIncompleteLength: 1, maximumLength: 16) { _, _, complete, error in
                    if complete || error != nil { ended.fulfill() }
                }
            }
            await fulfillment(of: [ended], timeout: 4)
            for conn in conns { conn.cancel() }
            await a.stop()
            await b.stop()
        }

        func testThePinRefusesAPeerThatIsNotTheContactsKey() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let dir = Directory()
            // A believes the contact's agreeKey is somebody else's.
            let wrong = Base64URL.encode(rnd())
            let ca = Contacts([link.contactForA(agreeKey: wrong)])
            let cb = Contacts([link.contactForB()])
            let a = try await start(link.a, ca, dir)
            let b = try await start(link.b, cb, dir)
            let inbound = LockedValue(0)
            b.onContactSession { _ in inbound.with { $0 += 1 } }
            // The names A browses for use `wrong`, so A never finds B's advert: nothing to dial.
            try await Task.sleep(nanoseconds: 200_000_000)
            let peers = await a.currentContactPeers()
            XCTAssertTrue(peers.isEmpty)
            XCTAssertEqual(inbound.current, 0)
            await a.stop()
            await b.stop()
        }

        func testAPendingContactIsPromotedByItsFirstHandshake() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let dir = Directory()
            let ca = Contacts([link.contactForA(pending: true)])
            let cb = Contacts([link.contactForB()])
            let a = try await start(link.a, ca, dir)
            let b = try await start(link.b, cb, dir)
            await until("A sees B") { await !a.currentContactPeers().isEmpty }
            let s = try await a.connectContact(link.contactForA().id, pending: true)
            XCTAssertEqual(s.contact?.pending, true)
            await until("promoted") { !ca.promoted.isEmpty }
            XCTAssertEqual(ca.promoted.first?.agreeKey, link.b.agreeKey)
            await s.close()
            await a.stop()
            await b.stop()
        }

        func testAContactAdvertIsNeverDialledAsAnAccountDevice() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let dir = Directory()
            let a = try await start(link.a, Contacts([link.contactForA()]), dir)
            let b = try await start(link.b, Contacts([link.contactForB()]), dir)
            await until("A sees B's contact advert") { await !a.currentContactPeers().isEmpty }
            let accountPeers = await a.currentPeers()
            XCTAssertTrue(accountPeers.isEmpty, "m=c is judged by the contact parser only")
            await a.stop()
            await b.stop()
        }
    }

    // ── The contact room ─────────────────────────────────────────────────────────────────────────

    private final class RoomSocket: ConnectRelaySocket, @unchecked Sendable {
        let alias: Data
        let room: ContactFakeRoom
        let stream: AsyncStream<Data>
        let cont: AsyncStream<Data>.Continuation
        init(alias: Data, room: ContactFakeRoom) {
            self.alias = alias
            self.room = room
            (stream, cont) = AsyncStream<Data>.makeStream()
        }
        func send(_ data: Data) async throws { room.fromClient(self, data) }
        func receive() async throws -> RelayFrame {
            for await d in stream { return .binary(d) }
            throw RelaySocketClosed(code: 1000)
        }
        func close(code: Int) async {
            cont.finish()
            room.drop(self)
        }
    }

    /// A contact room as the Worker's DO runs it: it knows only aliases.
    private final class ContactFakeRoom: @unchecked Sendable {
        private let lock = NSLock()
        private var socks: [RoomSocket] = []
        var seen: [String] = []
        var members: Int { lock.withLock { socks.count } }

        func opener(alias: Data) -> ConnectRelayOpener {
            { [self] _, _ in
                let s = RoomSocket(alias: alias, room: self)
                lock.withLock { socks.append(s) }
                return s
            }
        }
        func drop(_ s: RoomSocket) {
            let rest = lock.withLock { () -> [RoomSocket] in
                socks.removeAll { $0 === s }
                return socks
            }
            for r in rest { r.cont.yield(try! PeerRelayEnvelope.encode(.gone(s.alias))) }
        }
        func fromClient(_ s: RoomSocket, _ data: Data) {
            guard let m = PeerRelayEnvelope.decode(.toRoom, data) else { return }
            switch m {
            case .list:
                let all = lock.withLock { socks.map(\.alias) }
                s.cont.yield(try! PeerRelayEnvelope.encode(.members(all)))
            case .send(let to, let session, let noise):
                lock.withLock { seen.append("send") }
                let target = lock.withLock { socks.first { $0.alias == to } }
                target?.cont.yield(try! PeerRelayEnvelope.encode(.recv(from: s.alias, session: session, noise: noise)))
            case .ping(let p):
                s.cont.yield(try! PeerRelayEnvelope.encode(.pong(p)))
            default: break
            }
        }
    }

    final class ConnectContactRelayTests: XCTestCase {
        private func relay(
            _ d: Dev, _ link: Link, _ contacts: Contacts, room: ContactFakeRoom, alias: Data, tickets: Counter
        )
            -> ConnectContactRelay
        {
            let src = lanSource(d, contacts)
            let grant = RelayGrant(
                ticket: "pkeyrt_" + String(repeating: "a", count: 32),
                url: URL(string: "wss://key.example/djdl/connect/relay")!,
                protocolName: connectRelayProtocol, expiresAt: t0 + 60)
            return ConnectContactRelay(
                source: ConnectContactRelaySource(
                    lan: src,
                    ticket: { _ in
                        _ = tickets.bump()
                        return .granted(grant)
                    }),
                options: ConnectRelayOptions(opener: room.opener(alias: alias)))
        }

        func testTwoAccountsMeetInAContactRoomBySpeakingAliasesOnly() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let rid = PeerContacts.rid(secret: link.secret)
            let aliasA = try PeerContacts.alias(rid: rid, deviceId: idA)
            let aliasB = try PeerContacts.alias(rid: rid, deviceId: idB)
            XCTAssertNotEqual(aliasA, aliasB)
            let room = ContactFakeRoom()
            let ticketsA = Counter()
            let ticketsB = Counter()
            let ra = relay(link.a, link, Contacts([link.contactForA()]), room: room, alias: aliasA, tickets: ticketsA)
            let rb = relay(link.b, link, Contacts([link.contactForB()]), room: room, alias: aliasB, tickets: ticketsB)
            let inbound = LockedValue<ConnectSession?>(nil)
            rb.onSession { inbound.set($0) }
            await rb.start()
            await ra.start()
            // `start` returns before the sockets open: dial once both are in the room, or the member
            // list can miss the peer.
            await until("both in the room") { room.members == 2 }
            let s = try await ra.dial(link.contactForA().id)
            XCTAssertEqual(s.path, "relay")
            XCTAssertEqual(s.contact?.id, link.contactForA().id)
            await until("inbound") { inbound.current != nil }
            let r = inbound.current!
            XCTAssertEqual(r.contact?.id, link.contactForB().id)
            XCTAssertEqual(r.path, "relay")
            try await s.send(Data("over the room".utf8))
            let m = try await r.receive()
            XCTAssertEqual(m.body, Data("over the room".utf8))
            XCTAssertGreaterThan(ticketsA.bump(), 1, "a ticket was asked for")
            // Nothing on the wire names a device id: the room saw aliases and Noise messages.
            XCTAssertFalse(room.seen.isEmpty)
            await s.close()
            await ra.stop()
            await rb.stop()
        }

        func testADialToAPeerThatIsNotInTheRoomIsUnknownPeer() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let rid = PeerContacts.rid(secret: link.secret)
            let ra = relay(
                link.a, link, Contacts([link.contactForA()]), room: ContactFakeRoom(),
                alias: try PeerContacts.alias(rid: rid, deviceId: idA), tickets: Counter())
            await ra.start()
            do {
                _ = try await ra.dial(link.contactForA().id)
                XCTFail("dialled an offline contact")
            } catch let e as ConnectRelayError {
                XCTAssertEqual(e.reason, .unknownPeer)
            }
            await ra.stop()
        }

        func testALinksDisabledTicketStopsTheRoomWithATypedError() async throws {
            let link = Link(a: try await Dev(idA), b: try await Dev(idB))
            let src = lanSource(link.a, Contacts([link.contactForA()]))
            let r = ConnectContactRelay(
                source: ConnectContactRelaySource(
                    lan: src,
                    ticket: { _ in
                        .relay(ConnectRelayError(.linksDisabled, "off", status: 403))
                    }),
                options: ConnectRelayOptions())
            await r.start()
            await until("room blocked") { await r.status().values.first?.state == .blocked }
            let st = await r.status().values.first
            XCTAssertEqual(st?.error?.reason, .linksDisabled)
            XCTAssertEqual(st?.error?.code, ErrorCode.connectLinksDisabled)
            await r.stop()
        }
    }

    // ── The client: rows, the gate, the ticket ───────────────────────────────────────────────────

    final class ConnectLinksClientTests: XCTestCase {
        private let signer = TestSigner(kid: "connect-kid")
        private let selfId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        private var server = StubServer()
        private var port: DeviceKeyStore!
        private var state = ConnectStateStore.inMemory()
        private let now = Int(Date().timeIntervalSince1970)

        override func setUp() async throws {
            server = StubServer()
            state = ConnectStateStore.inMemory()
            port = try DeviceKeyStore(productSlug: "djdl", vault: MemoryDeviceKeyVault(), wrapper: nil, kind: .durable)
        }

        private func client() async throws -> PolarisKeyClient {
            let store = InMemoryStore(deviceId: selfId)
            await store.setToken("pkeyt_dev")
            return try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: signer.trust,
                    trustRefresh: false, store: store, transport: server.transport,
                    expectedServices: [.license, .config, .connect], fingerprint: false,
                    connect: ConnectOptions(keys: port, store: state)))
        }

        private func serveIdentity(_ keys: DevicePublicKeys) async {
            let me = #"{"deviceId":"\#(selfId)","signKey":"\#(keys.signKey)","agreeKey":"\#(keys.agreeKey)"}"#
            let ring = signer.sign(
                payloadJSON:
                    #"{"iss":"key.plrs.im","aud":"djdl","sub":"ps_AbCdEfGhIjKlMnOpQrStUv","epoch":5,"issuedAt":\#(now),"expiresAt":\#(now + 604_800),"devices":[\#(me)]}"#,
                typ: JwsTyp.ring.rawValue)
            let cert = signer.sign(
                payloadJSON:
                    #"{"iss":"key.plrs.im","aud":"djdl","sub":"ps_AbCdEfGhIjKlMnOpQrStUv","deviceId":"\#(selfId)","signKey":"\#(keys.signKey)","agreeKey":"\#(keys.agreeKey)","ringEpoch":5,"issuedAt":\#(now),"expiresAt":\#(now + 604_800)}"#,
                typ: JwsTyp.peer.rawValue)
            await server.reply(
                "/djdl/connect/identity",
                body: #"{"ring":"\#(ring)","certificate":"\#(cert)","discKeys":["\#(Base64URL.encode(rnd()))"]}"#)
            await server.reply("/djdl/devices/keys", body: #"{"keySeq":1}"#)
        }

        func testRowsAreStoredListedMarkedPromotedRemovedAndSurviveARefresh() async throws {
            let c = try await client()
            let keys = try await port.ensure()
            await serveIdentity(keys)
            guard case .ready = await c.connect.identity(refresh: true) else { return XCTFail("identity") }
            let peerKey = Base64URL.encode(rnd())
            let secret = rnd()
            let stored = try await c.connect.updateContacts { rows, now in
                ConnectContacts.store(rows, agreeKey: peerKey, secret: secret, label: "Ben", cats: ["docs"], now: now)?
                    .rows
            }
            XCTAssertEqual(stored.count, 1)
            let id = ConnectContacts.id(peerKey)
            let list = await c.cloudConnect.links.list()
            XCTAssertEqual(list.map(\.id), [id])
            XCTAssertEqual(list.first?.label, "Ben")
            XCTAssertEqual(list.first?.categories, ["docs"])
            XCTAssertEqual(list.first?.reachable, true)
            XCTAssertEqual(id.count, 16)
            // No key or secret in anything printable.
            XCTAssertFalse("\(list)".contains(peerKey))
            XCTAssertFalse(String(describing: stored).contains(Base64URL.encode(secret)))
            let marked = await c.cloudConnect.links.setReachable(id, false)
            XCTAssertTrue(marked)
            let after = await c.cloudConnect.links.list()
            XCTAssertEqual(after.first?.reachable, false)
            let none = await c.cloudConnect.links.setReachable("nope", true)
            XCTAssertFalse(none)
            // A refresh of the identity keeps the links.
            _ = await c.connect.identity(refresh: true)
            let kept = await c.cloudConnect.links.list()
            XCTAssertEqual(kept.map(\.id), [id])
            // A re-pair of the same peer is pending and takes no slot.
            _ = try await c.connect.updateContacts { rows, now in
                ConnectContacts.store(rows, agreeKey: peerKey, secret: rnd(), label: "Ben2", cats: [], now: now)?.rows
            }
            let rp = await c.cloudConnect.links.list()
            XCTAssertEqual(rp.count, 1)
            XCTAssertEqual(rp.first?.rePairPending, true)
            XCTAssertEqual(rp.first?.label, "Ben", "the held contact is untouched until the first handshake")
            _ = try await c.connect.updateContacts { rows, _ in ConnectContacts.promote(rows, agreeKey: peerKey) }
            let promoted = await c.cloudConnect.links.list()
            XCTAssertEqual(promoted.first?.label, "Ben2")
            XCTAssertEqual(promoted.first?.rePairPending, false)
            let removed = await c.cloudConnect.links.remove(id)
            XCTAssertTrue(removed)
            let gone = await c.cloudConnect.links.list()
            XCTAssertTrue(gone.isEmpty)
            let again = await c.cloudConnect.links.remove(id)
            XCTAssertFalse(again)
        }

        func testLeavingWipesTheLinks() async throws {
            let c = try await client()
            await serveIdentity(try await port.ensure())
            _ = await c.connect.identity(refresh: true)
            _ = try await c.connect.updateContacts { rows, now in
                ConnectContacts.store(
                    rows, agreeKey: Base64URL.encode(rnd()), secret: rnd(), label: nil, cats: [], now: now)?.rows
            }
            try await c.connect.leave()
            let rows = await c.connect.contactRows()
            XCTAssertTrue(rows.isEmpty)
            XCTAssertNil(try state.load())
        }

        func testABadRowMakesTheRecordUnusableNotSilentlyReset() throws {
            let rec = ConnectRecord(
                ring: "r", certificate: "c", discKeys: [Base64URL.encode(rnd())], registered: nil, storedAt: 1,
                contacts: [
                    ConnectContactRow(
                        agreeKey: "short", secret: "short", label: nil, cats: [], createdAt: 1, reachable: true)
                ])
            XCTAssertThrowsError(
                try {
                    try state.save(rec)
                    _ = try state.load()
                }()
            ) { XCTAssertEqual($0 as? ConnectStateError, .unreadable) }
        }

        func testACategoryOutsideTheRuleMakesTheRecordUnusable() throws {
            // `^[a-z0-9-]{1,32}$`, as in Node, Python and Kotlin: upper case, a space, a dot and a non-ASCII letter fail.
            let key = Base64URL.encode(Data(repeating: 7, count: 32))
            func row(_ cats: [String]) -> ConnectContactRow {
                ConnectContactRow(
                    agreeKey: key, secret: key, label: nil, cats: cats, createdAt: 1, reachable: true)
            }
            XCTAssertTrue(row(["photos", "a-b-9"]).valid)
            for bad in ["Photos", "a b", "a.b", "caf\u{e9}", "", String(repeating: "a", count: 33)] {
                XCTAssertFalse(row([bad]).valid, bad)
            }
        }

        func testADiscoveryThatIsNotFoundClosesTheGate() async throws {
            let c = try await client()
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body: #"{"product":"djdl","services":{"connect":{"enabled":true,"interAccount":true}}}"#)
            await c.discover()
            let on = await c.cloudConnect.links.interAccount()
            XCTAssertTrue(on)
            await server.reply("/djdl/.well-known/polaris.json", status: 404, body: "")
            await c.discover()
            let off = await c.cloudConnect.links.interAccount()
            XCTAssertFalse(off)
        }

        func testADiscoveryAnswerOlderThanADayNoLongerCounts() async throws {
            let c = try await client()
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body: #"{"product":"djdl","services":{"connect":{"enabled":true,"interAccount":true}}}"#)
            await c.discover()
            let on = await c.cloudConnect.links.interAccount()
            XCTAssertTrue(on)
            c.connect.linksUntil.set(1)
            let lapsed = await c.cloudConnect.links.interAccount()
            XCTAssertFalse(lapsed)
        }

        func testASessionUnderAReplacedPendingSecretDoesNotPromoteTheNewerPendingRow() {
            let key = Base64URL.encode(Data(repeating: 7, count: 32))
            let s1 = Data(repeating: 1, count: 32)
            let s2 = Data(repeating: 2, count: 32)
            func row(_ secret: Data, _ pending: Int?) -> ConnectContactRow {
                ConnectContactRow(
                    agreeKey: key, secret: Base64URL.encode(secret), label: nil, cats: ["docs"], createdAt: 1,
                    reachable: true, pendingSince: pending)
            }
            let rows = [row(s1, nil), row(s2, 5)]
            XCTAssertEqual(
                ConnectContacts.promote(rows, agreeKey: key, tag: ConnectContacts.tag(s1)).map(\.secret),
                rows.map(\.secret))
            let after = ConnectContacts.promote(rows, agreeKey: key, tag: ConnectContacts.tag(s2))
            XCTAssertEqual(after.map(\.secret), [Base64URL.encode(s2)])
            XCTAssertTrue(after.allSatisfy { $0.pendingSince == nil })
        }

        func testPairAndOpenAreTheTypedNAWhileLinksAreOff() async throws {
            let c = try await client()
            let off = await c.cloudConnect.links.interAccount()
            XCTAssertFalse(off)
            do {
                _ = try await c.cloudConnect.links.pair(LinkPairOptions(categories: [], onCode: { _ in }))
                XCTFail("pair ran while links are off")
            } catch let e as CloudLinksDisabled {
                XCTAssertEqual(e.code, ErrorCode.connectLinksDisabled)
                XCTAssertEqual(e.unsupported.feature, Feature.connectLinks)
            }
            do {
                _ = try await c.cloudConnect.links.open("x")
                XCTFail("open ran while links are off")
            } catch is CloudLinksDisabled {}
        }

        func testTheContactTicketBodyAndTheRoomEcho() async throws {
            let c = try await client()
            let rid = "lXg0MgIHVN5qAmGFUen7vA"
            let ok =
                #"{"ticket":"pkeyrt_\#(String(repeating: "a", count: 32))","url":"wss://key.example/djdl/connect/relay","protocol":"pkey-relay.1","expiresAt":\#(now + 60),"room":"c"}"#
            await server.reply("/djdl/connect/relay/ticket", body: ok)
            guard case .granted = await c.connect.relayTicket(room: "c", rid: rid) else { return XCTFail("granted") }
            let sent = await server.requests(forPath: "/djdl/connect/relay/ticket").last
            XCTAssertEqual(sent?.headers["content-type"], "application/json")
            XCTAssertEqual(String(decoding: sent?.body ?? Data(), as: UTF8.self), #"{"rid":"\#(rid)","room":"c"}"#)
            // An older Worker ignores the body and answers an account ticket: unsupported, never used.
            let old =
                #"{"ticket":"pkeyrt_\#(String(repeating: "a", count: 32))","url":"wss://key.example/djdl/connect/relay","protocol":"pkey-relay.1","expiresAt":\#(now + 60)}"#
            await server.reply("/djdl/connect/relay/ticket", body: old)
            guard case .relay(let e) = await c.connect.relayTicket(room: "c", rid: rid) else { return XCTFail("relay") }
            XCTAssertEqual(e.reason, .contactUnsupported)
            // An account request that answers a room is not in the contract shape.
            await server.reply("/djdl/connect/relay/ticket", body: ok)
            guard case .relay(let e2) = await c.connect.relayTicket() else { return XCTFail("relay") }
            XCTAssertEqual(e2.reason, .ticketInvalid)
            await server.reply(
                "/djdl/connect/relay/ticket", status: 403, body: #"{"error":{"code":"connect_links_disabled"}}"#)
            guard case .relay(let e3) = await c.connect.relayTicket(room: "c", rid: rid) else {
                return XCTFail("relay")
            }
            XCTAssertEqual(e3.reason, .linksDisabled)
            XCTAssertEqual(e3.status, 403)
        }
    }

    // ── The pairing window, two devices end to end ───────────────────────────────────────────────

    /// One person's device: its contact rows and the `PairSource` that stores into them.
    private final class PairDevice: @unchecked Sendable {
        let agreeKey: String
        let rows = LockedValue<[ConnectContactRow]>([])
        let linked = LockedValue<[PairedLink]>([])
        let failed = LockedValue<[PairFailure]>([])
        let codes = LockedValue<[String]>([])
        init(_ d: Dev) { agreeKey = d.agreeKey }
        var source: PairSource {
            PairSource(
                slug: "djdl", now: { Int(Date().timeIntervalSince1970) }, agreeKey: { self.agreeKey },
                held: { self.rows.with { $0.filter { $0.pendingSince == nil }.map(\.agreeKey) } },
                store: { key, secret, label, cats in
                    self.rows.with { rows in
                        guard
                            let v = ConnectContacts.store(
                                rows, agreeKey: key, secret: secret, label: label, cats: cats,
                                now: Int(Date().timeIntervalSince1970))
                        else { return nil }
                        rows = v.rows
                        return (ConnectContacts.id(key), v.pending)
                    }
                },
                allowed: { true })
        }
        func options(_ dir: Directory, label: String, confirm: Bool) -> LinkPairOptions {
            LinkPairOptions(
                categories: ["docs"], label: label,
                onCode: { offer in
                    self.codes.with { $0.append(offer.code) }
                    Task { confirm ? await offer.confirm() : await offer.decline() }
                },
                onLinked: { l in self.linked.with { $0.append(l) } },
                onFailed: { f in self.failed.with { $0.append(f) } },
                seconds: 30, network: FakeNet(dir))
        }
    }

    final class ConnectLinksPairingWindowTests: XCTestCase {
        func testTwoDevicesPairAndBothStoreTheSameContactSecret() async throws {
            let a = PairDevice(try await Dev(idA))
            let b = PairDevice(try await Dev(idB))
            let dir = Directory()
            let ha = try await LinkPairing.start(a.source, a.options(dir, label: "Ana", confirm: true))
            let hb = try await LinkPairing.start(b.source, b.options(dir, label: "Ben", confirm: true))
            await until("both devices linked") {
                a.linked.with { !$0.isEmpty } && b.linked.with { !$0.isEmpty }
            }
            // Each person saw the same code, and each stored the other's key and name.
            XCTAssertEqual(a.codes.with { $0 }.first, b.codes.with { $0 }.first)
            XCTAssertEqual(a.rows.with { $0.map(\.agreeKey) }, [b.agreeKey])
            XCTAssertEqual(b.rows.with { $0.map(\.agreeKey) }, [a.agreeKey])
            XCTAssertEqual(a.rows.with { $0.first?.secret }, b.rows.with { $0.first?.secret })
            XCTAssertEqual(a.rows.with { $0.first?.label }, "Ben")
            XCTAssertEqual(b.rows.with { $0.first?.label }, "Ana")
            XCTAssertEqual(a.linked.with { $0.first?.categories }, ["docs"])
            XCTAssertTrue(a.failed.with { $0.isEmpty } && b.failed.with { $0.isEmpty })
            await ha.stop()
            await hb.stop()
        }

        func testOneDeclineStoresNothingOnEitherDevice() async throws {
            let a = PairDevice(try await Dev(idA))
            let b = PairDevice(try await Dev(idB))
            let dir = Directory()
            let ha = try await LinkPairing.start(a.source, a.options(dir, label: "Ana", confirm: true))
            let hb = try await LinkPairing.start(b.source, b.options(dir, label: "Ben", confirm: false))
            await until("both devices report the failure") {
                a.failed.with { !$0.isEmpty } && b.failed.with { !$0.isEmpty }
            }
            XCTAssertTrue(a.rows.with { $0.isEmpty } && b.rows.with { $0.isEmpty })
            XCTAssertTrue(a.linked.with { $0.isEmpty } && b.linked.with { $0.isEmpty })
            XCTAssertEqual(b.failed.with { $0.first?.reason }, .declined)
            await ha.stop()
            await hb.stop()
        }
    }
#endif
