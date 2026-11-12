// The Swift live-peer driver (CC-29X.2): PolarisKey's local links behind the JSON-lines contract in
// tools/live-peer/README.md. One client, no account, local pairing on; discovery is answered by a local
// transport, mDNS by the harness's broker; every dial is real TCP on 127.0.0.1.

import Foundation
import PolarisKey
import PolarisKeyCore

private let product = "djdl"
private let categories = ["notes"]

/// Discovery says `localPairing: true`; every other call is a 404.
struct LocalDiscovery: PolarisTransport {
    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        guard request.url.absoluteString.hasSuffix("/.well-known/polaris.json") else {
            return PolarisResponse(status: 404, body: Data("{}".utf8))
        }
        let doc = #"{"product":"djdl","protocolVersion":5,"services":{"connect":{"enabled":true,"localPairing":true}}}"#
        return PolarisResponse(status: 200, body: Data(doc.utf8), headers: ["content-type": "application/json"])
    }
}

private final class Held: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [JSON] = []
    private var sessions: [String: ConnectSession] = [:]
    private var received: [JSON] = []
    private var waiting: [CheckedContinuation<JSON, Never>] = []
    private var latestCode: LocalCode?
    private var pairHandle: LocalPairHandle?
    private var offers = 0

    func event(_ e: JSON) { lock.withLock { queue.append(e) } }
    func drain() -> [JSON] {
        lock.withLock {
            let q = queue
            queue = []
            return q
        }
    }
    func hold(_ id: String, _ s: ConnectSession) { lock.withLock { sessions[id] = s } }
    func session(_ id: String) -> ConnectSession? { lock.withLock { sessions[id] } }
    var code: LocalCode? {
        get { lock.withLock { latestCode } }
        set { lock.withLock { latestCode = newValue } }
    }
    var handle: LocalPairHandle? {
        get { lock.withLock { pairHandle } }
        set { lock.withLock { pairHandle = newValue } }
    }
    func nextOffer() -> Int {
        lock.withLock {
            offers += 1
            return offers
        }
    }

    func deliver(_ r: JSON) {
        let w = lock.withLock { () -> CheckedContinuation<JSON, Never>? in
            if waiting.isEmpty {
                received.append(r)
                return nil
            }
            return waiting.removeFirst()
        }
        w?.resume(returning: r)
    }

    func receive() async -> JSON {
        await withCheckedContinuation { c in
            let hit = lock.withLock { () -> JSON? in
                if received.isEmpty {
                    waiting.append(c)
                    return nil
                }
                return received.removeFirst()
            }
            if let hit { c.resume(returning: hit) }
        }
    }
}

final class Driver: @unchecked Sendable {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("pkey-live-swift-\(UUID().uuidString)")
    let broker = Broker()
    private let held = Held()
    private var client: PolarisKeyClient!
    private var links: LocalLinks { client.cloudConnect.localLinks }

    func start() async throws {
        let recv = root.appendingPathComponent("recv")
        try FileManager.default.createDirectory(at: recv, withIntermediateDirectories: true)
        let id = String((0..<32).map { _ in "ABCDEFGHIJKLMNOPQRSTUVWXYZ".randomElement()! })
        let broker = self.broker
        client = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: product, baseUrl: "https://k.test", version: "1.0.0", pinnedKeys: [:],
                trustRefresh: false, store: InMemoryStore(deviceId: id), transport: LocalDiscovery(),
                expectedServices: [.license, .config, .connect], fingerprint: false,
                connect: ConnectOptions(
                    keys: try DeviceKeyStore.inMemory(productSlug: product), store: ConnectStateStore.inMemory(),
                    allowEphemeralKeys: true)))
        await client.discover()
        let held = self.held
        _ = links.onChange { held.event(["kind": "change"]) }
        _ = links.onLink { s in
            Driver.track(held, s, "in")
            held.event(["kind": "link", "id": s.local?.id ?? NSNull()])
        }
        client.cloudConnect.transfer.onOffer { o in
            .accept(to: recv.appendingPathComponent("\(held.nextOffer())-\(o.id).bin"))
        }
        client.cloudConnect.transfer.onResult { r in
            guard case .delivered(_, let url) = r, let data = try? Data(contentsOf: url) else { return }
            held.deliver(["sha256": sha256Hex(data), "bytes": data.count])
        }
        try await client.cloudConnect.start(
            options: CloudConnectOptions(
                relay: false,
                lanOptions: ConnectLanOptions(makeNetwork: { BrokerNet(broker) }, handshakeSeconds: 10)))
    }

    private static func track(_ held: Held, _ s: ConnectSession, _ dir: String) {
        let id = s.local?.id
        if let id { held.hold(id, s) }
        _ = s.onClose { c in
            held.event(["kind": "session-end", "dir": dir, "id": id ?? NSNull(), "code": c.code, "byPeer": c.byPeer])
        }
    }

    // MARK: Commands

    func show(_ a: JSON) async throws -> JSON {
        // After a pairing the window closes on its own; a fresh one waits for that.
        if a["fresh"] as? Bool == true {
            for _ in 0..<400 where held.handle?.isOpen == true { try await Task.sleep(nanoseconds: 50_000_000) }
        }
        var h = held.handle
        if h == nil || h?.isOpen == false {
            held.code = nil
            let held = self.held
            h = try await links.pair(
                LocalPairOptions(
                    categories: categories, label: "swift", onCode: { held.code = $0 },
                    onConfirm: { offer in Task { await offer.confirm() } }, network: BrokerNet(broker),
                    allowLoopback: true))
            held.handle = h
        }
        guard let c = h?.code() ?? held.code else {
            throw Refusal(error: errorJSON(message: "the window shows no code"))
        }
        return ["code": c.code, "qr": c.qr]
    }

    func join(_ a: JSON) async throws -> JSON {
        let code = string(a, "code")
        let dialsLeft: () -> Any = { code.flatMap { self.links.dialsLeft($0) } ?? NSNull() }
        do {
            let p = try await links.join(
                LocalJoinOptions(
                    categories: categories, label: "swift", code: code, qr: string(a, "qr"),
                    onConfirm: { offer in Task { await offer.confirm() } },
                    // The joiner waits out its browse after a failed dial in case a second device answers.
                    browseSeconds: 4, network: BrokerNet(broker), allowLoopback: true))
            return ["link": p.id, "dialsLeft": dialsLeft()]
        } catch {
            throw Refusal(error: Driver.errorOf(error), extra: ["dialsLeft": dialsLeft()])
        }
    }

    func list() async throws -> JSON {
        let infos = try await links.list()
        return [
            "links": infos.map { l -> JSON in
                [
                    "id": l.id, "label": l.label ?? NSNull(), "platform": l.platform ?? NSNull(),
                    "categories": l.categories, "reachable": l.reachable,
                ]
            }
        ]
    }

    /// A link not seen on the network yet is not an attempt: keep looking until the hang guard.
    private func openLink(_ id: String, wait: Bool) async throws -> ConnectSession {
        let until = Date().addingTimeInterval(wait ? 20 : 0)
        while true {
            do {
                let s = try await links.open(id)
                Driver.track(held, s, "out")
                return s
            } catch let e as ConnectLanError where e.reason == .unknownPeer && Date() < until {
                try await Task.sleep(nanoseconds: 50_000_000)
            } catch {
                throw Refusal(error: Driver.errorOf(error))
            }
        }
    }

    func open(_ a: JSON) async throws -> JSON {
        guard let id = string(a, "id") else { throw Refusal(error: errorJSON(message: "open needs an id")) }
        _ = try await openLink(id, wait: a["wait"] as? Bool ?? true)
        return ["link": id]
    }

    func sendBytes(_ a: JSON) async throws -> JSON {
        guard let id = string(a, "id"), let n = a["bytes"] as? Int else {
            throw Refusal(error: errorJSON(message: "send needs an id and bytes"))
        }
        let data = pattern(n)
        guard sha256Hex(data) == string(a, "sha256") else {
            throw Refusal(error: errorJSON(message: "the sender's pattern hashes differently"))
        }
        let session: ConnectSession
        if let s = held.session(id), s.closed == nil {
            session = s
        } else {
            session = try await openLink(id, wait: true)
        }
        do {
            let sent = try await client.cloudConnect.transfer.send(
                over: session, source: .data(data),
                options: TransferSendOptions(name: "live.bin", category: categories[0]))
            return ["sha256": sent.sha256, "bytes": sent.size]
        } catch {
            throw Refusal(error: Driver.errorOf(error))
        }
    }

    func recv() async -> JSON { await held.receive() }

    func forget(_ a: JSON) async throws -> JSON {
        guard let id = string(a, "id") else { throw Refusal(error: errorJSON(message: "forget needs an id")) }
        return ["removed": try await links.remove(id)]
    }

    func events() -> JSON { ["events": held.drain()] }

    func shutdown() async {
        await held.handle?.stop()
        await client.cloudConnect.stop()
        try? FileManager.default.removeItem(at: root)
    }

    static func errorOf(_ e: Error) -> JSON {
        switch e {
        case let e as Refusal: return e.error
        case let e as LocalPairingError:
            return errorJSON(code: e.code, reason: e.reason?.rawValue, cap: e.cap?.rawValue, message: e.message)
        case let e as ConnectLanError: return errorJSON(code: e.code, reason: e.reason.rawValue, message: e.message)
        case let e as DirectTransferError: return errorJSON(code: e.code, reason: e.reason, message: e.message)
        default: return errorJSON(message: String(describing: e))
        }
    }
}
