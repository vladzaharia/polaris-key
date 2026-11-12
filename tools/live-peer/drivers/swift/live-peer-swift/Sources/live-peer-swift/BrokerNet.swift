// What the driver's client sees of the network: real loopback TCP, adverts through the harness.
// The harness is the mDNS broker: our adverts go to it, the other drivers' adverts come back. Found
// hosts are always 127.0.0.1.

import Foundation
import Network
import PolarisKey
import PolarisKeyPlatform

final class Broker: @unchecked Sendable {
    private let lock = NSLock()
    private var adverts: [String: (owner: ObjectIdentifier, slot: Int, found: BonjourFound, remote: Bool)] = [:]
    private var browsers: [Int: (up: @Sendable (BonjourFound) -> Void, down: @Sendable (String) -> Void)] = [:]
    private var next = 0

    private func found(_ a: BonjourAdvert, port: UInt16) -> BonjourFound {
        BonjourFound(
            instance: a.instance, txt: a.txt,
            endpoint: BonjourEndpoint(
                name: a.instance, network: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)))
    }

    /// Make `owner`'s adverts in `slot` exactly `list`, on `port`, and tell the harness and every browser.
    func set(owner: ObjectIdentifier, slot: Int, adverts list: [BonjourAdvert], port: UInt16) {
        let (gone, ups, bs) = lock.withLock {
            () -> ([String], [BonjourFound], [(@Sendable (BonjourFound) -> Void, @Sendable (String) -> Void)]) in
            let old = adverts.filter { $0.value.owner == owner && $0.value.slot == slot && !$0.value.remote }.map(\.key)
            for k in old { adverts[k] = nil }
            var fs: [BonjourFound] = []
            for a in list {
                let f = found(a, port: port)
                adverts[a.instance] = (owner, slot, f, false)
                fs.append(f)
            }
            return (old, fs, browsers.values.map { ($0.up, $0.down) })
        }
        let now = Set(list.map(\.instance))
        for g in gone where !now.contains(g) { send(["mdns": "withdraw", "instance": g]) }
        for a in list {
            send(["mdns": "advertise", "advert": ["instance": a.instance, "port": Int(port), "txt": a.txt]])
        }
        for b in bs {
            for g in gone { b.1(g) }
            for u in ups { b.0(u) }
        }
    }

    func remoteUp(instance: String, port: UInt16, txt: [String]) {
        let f = found(BonjourAdvert(instance: instance, txt: txt), port: port)
        let bs = lock.withLock { () -> [@Sendable (BonjourFound) -> Void] in
            adverts[instance] = (ObjectIdentifier(self), -1, f, true)
            return browsers.values.map(\.up)
        }
        for b in bs { b(f) }
    }

    func remoteDown(_ instance: String) {
        let bs = lock.withLock { () -> [@Sendable (String) -> Void] in
            guard adverts.removeValue(forKey: instance) != nil else { return [] }
            return browsers.values.map(\.down)
        }
        for b in bs { b(instance) }
    }

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

/// One LAN network: its own TCP listener, its adverts in the broker.
final class BrokerNet: ConnectLanNetwork, @unchecked Sendable {
    let broker: Broker
    private let lock = NSLock()
    private var listenerBox = BonjourListener(policy: BonjourDialPolicy(allowLoopback: true))
    private var port: UInt16 = 0
    private let dialOptions = BonjourDialOptions(policy: BonjourDialPolicy(allowLoopback: true), timeout: 5)

    init(_ broker: Broker) { self.broker = broker }

    private var listener: BonjourListener { lock.withLock { listenerBox } }

    func listen(
        onPipe: @escaping @Sendable (NWPipe) -> Void, onEvent: @escaping @Sendable (BonjourListenerEvent) -> Void
    ) async throws -> UInt16 {
        let p = try await listener.start(advert: nil, onPipe: onPipe, onEvent: onEvent)
        lock.withLock { port = p }
        return p
    }

    func advertise(_ advert: BonjourAdvert?) async {
        broker.set(
            owner: ObjectIdentifier(self), slot: 0, adverts: advert.map { [$0] } ?? [], port: lock.withLock { port })
    }

    func advertiseContacts(_ adverts: [BonjourAdvert]) async {
        broker.set(owner: ObjectIdentifier(self), slot: 1, adverts: adverts, port: lock.withLock { port })
    }

    func browse(
        onUp: @escaping @Sendable (BonjourFound) -> Void, onDown: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (BonjourBrowseError) -> Void
    ) throws -> @Sendable () -> Void { broker.browse(up: onUp, down: onDown) }

    func resolve(_ endpoint: BonjourEndpoint) async throws -> [BonjourEndpoint] { [endpoint] }

    func dial(_ endpoint: BonjourEndpoint) async throws -> NWPipe {
        try await BonjourPipes.dial(endpoint, options: dialOptions)
    }

    func rescan() { broker.replay() }

    /// A window that closed and one that opens after it may share one network: the listener is replaced.
    func stop() async {
        lock.withLock {
            listenerBox.stop()
            listenerBox = BonjourListener(policy: BonjourDialPolicy(allowLoopback: true))
        }
        broker.set(owner: ObjectIdentifier(self), slot: 0, adverts: [], port: 0)
        broker.set(owner: ObjectIdentifier(self), slot: 1, adverts: [], port: 0)
    }
}
