// A faithful in-process relay room for the Cloud Connect tests (CC-11.13): it re-implements the room's
// observable framing (WIRE-CONTRACT-V5 §15.7) over the SDK's own envelope codec. A ticket is single use and
// names the device; `from` is stamped from the admission; SEND reaches the sockets of `to`; LIST answers
// MEMBERS; PING answers PONG; an envelope that fails its layout closes 1008. Mirrors Python's
// `connect_relay_fake.py`. Not a test case.

import Foundation
import PolarisKeyCore

@testable import PolarisKey

final class FakeSocket: ConnectRelaySocket, @unchecked Sendable {
    enum Item: Sendable {
        case frame(RelayFrame)
        case close(Int?)
    }
    private let lock = NSLock()
    private var items: [Item] = []
    private var waiter: CheckedContinuation<Item, Never>?
    let room: FakeRoom
    let url: URL
    let protocols: [String]
    var device: String?
    private(set) var closed = false
    private(set) var closeCode: Int?

    init(room: FakeRoom, url: URL, protocols: [String]) {
        self.room = room
        self.url = url
        self.protocols = protocols
    }

    func send(_ data: Data) async throws {
        if lock.withLock({ closed }) { throw RelaySocketClosed(code: lock.withLock { closeCode }) }
        room.fromClient(self, data)
    }

    func receive() async throws -> RelayFrame {
        let item: Item = await withCheckedContinuation { c in
            let ready = lock.withLock { () -> Item? in
                if let first = items.first {
                    if case .close = first { return first }  // a close stays
                    items.removeFirst()
                    return first
                }
                waiter = c
                return nil
            }
            if let ready { c.resume(returning: ready) }
        }
        switch item {
        case .frame(let f): return f
        case .close(let code): throw RelaySocketClosed(code: code)
        }
    }

    func close(code: Int) async { shut(code) }

    /// Either side closes: the client's next `receive` throws with `code`.
    func shut(_ code: Int?) {
        let first = lock.withLock { () -> Bool in
            if closed { return false }
            closed = true
            closeCode = code
            return true
        }
        guard first else { return }
        room.remove(self)
        put(.close(code))
    }

    private func put(_ item: Item) {
        let w = lock.withLock { () -> CheckedContinuation<Item, Never>? in
            if let w = waiter {
                waiter = nil
                return w
            }
            items.append(item)
            return nil
        }
        w?.resume(returning: item)
    }

    func deliver(_ m: PeerRelayMessage) {
        if lock.withLock({ closed }) { return }
        if let d = try? PeerRelayEnvelope.encode(m) { put(.frame(.binary(d))) }
    }

    func deliverRaw(_ f: RelayFrame) {
        if lock.withLock({ closed }) { return }
        put(.frame(f))
    }
}

final class FakeRoom: @unchecked Sendable {
    private let lock = NSLock()
    private var members_: Set<String>
    private var tickets: [String: String] = [:]
    private(set) var sockets: [FakeSocket] = []
    private(set) var ever: [FakeSocket] = []
    private(set) var received: [(device: String, message: PeerRelayMessage)] = []
    private(set) var offered: [[String]] = []
    private(set) var issued = 0
    var rejectWith: Int?
    /// Stamp `from` as another device for a sender (the room lying about who sent a message).
    var stampAs: [String: String] = [:]
    /// Deliver messages addressed to a device to another one.
    var redirect: [String: String] = [:]

    init(members: Set<String>) { members_ = members }

    func issue(device: String, url: String = "wss://k.test/djdl/connect/relay") -> RelayGrant {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        let t = "pkeyrt_" + String((0..<32).map { _ in alphabet.randomElement()! })
        lock.withLock {
            issued += 1
            tickets[t] = device
        }
        return RelayGrant(ticket: t, url: URL(string: url)!, protocolName: "pkey-relay.1", expiresAt: 2_000_000_000)
    }

    var opener: ConnectRelayOpener {
        { [self] url, protocols in
            let s = FakeSocket(room: self, url: url, protocols: protocols)
            let (reject, device, member): (Int?, String?, Bool) = lock.withLock {
                ever.append(s)
                offered.append(protocols)
                if let r = rejectWith {
                    rejectWith = nil
                    return (r, nil, false)
                }
                let t = protocols.count > 1 ? protocols[1] : nil
                guard protocols.first == "pkey-relay.1", let t, let d = tickets[t] else { return (4001, nil, false) }
                tickets[t] = nil  // single use
                return (nil, d, members_.contains(d))
            }
            if let reject { throw RelaySocketClosed(code: reject) }
            guard let device else { throw RelaySocketClosed(code: 4001) }
            if !member { throw RelaySocketClosed(code: 4003) }
            s.device = device
            let old: FakeSocket? = lock.withLock {
                let mine = sockets.filter { $0.device == device }
                sockets.append(s)
                return mine.count >= 2 ? mine[0] : nil  // a third socket of a device replaces the oldest
            }
            old?.shut(4009)
            return s
        }
    }

    func remove(_ s: FakeSocket) { lock.withLock { sockets.removeAll { $0 === s } } }

    func fromClient(_ s: FakeSocket, _ data: Data) {
        guard let m = PeerRelayEnvelope.decode(.toRoom, data), let dev = s.device else { return s.shut(1008) }
        lock.withLock { received.append((dev, m)) }
        switch m {
        case .send(let to, let session, let noise):
            let target = lock.withLock { redirect[Base64URL.encode(to)] } ?? Base64URL.encode(to)
            let (ts, stamp) = lock.withLock { (sockets.filter { $0.device == target }, stampAs[dev] ?? dev) }
            for t in ts { t.deliver(.recv(from: Base64URL.decode(stamp)!, session: session, noise: noise)) }
        case .list: s.deliver(membersMessage())
        case .ping(let d): s.deliver(.pong(d))
        default: break
        }
    }

    func membersMessage() -> PeerRelayMessage {
        let ids = lock.withLock { Set(sockets.compactMap(\.device)) }.sorted()
        return .members(ids.map { Base64URL.decode($0)! })
    }

    func dropAll(_ code: Int?) { for s in lock.withLock({ sockets }) { s.shut(code) } }
    func pushRing(_ epoch: UInt64) { for s in lock.withLock({ sockets }) { s.deliver(.ring(epoch: epoch)) } }
    func push(_ device: String, _ m: PeerRelayMessage) {
        for s in lock.withLock({ sockets.filter { $0.device == device } }) { s.deliver(m) }
    }
    func sends(_ device: String) -> [PeerRelayMessage] {
        lock.withLock {
            received.filter { $0.device == device }.map(\.message).filter {
                if case .send = $0 { return true } else { return false }
            }
        }
    }
    func count(_ device: String, where f: (PeerRelayMessage) -> Bool) -> Int {
        lock.withLock { received.filter { $0.device == device && f($0.message) }.count }
    }
    var everSockets: [FakeSocket] { lock.withLock { ever } }
    var liveSockets: [FakeSocket] { lock.withLock { sockets } }
    var offers: [[String]] { lock.withLock { offered } }
    var issuedCount: Int { lock.withLock { issued } }
}

/// A sleep the test drives: nothing wakes until `fire` picks it.
final class ManualSleep: @unchecked Sendable {
    private let lock = NSLock()
    private var nextId = 0
    private var pending: [Int: (seconds: TimeInterval, c: CheckedContinuation<Void, Error>)] = [:]
    private var _delays: [TimeInterval] = []
    var delays: [TimeInterval] { lock.withLock { _delays } }
    var pendingSeconds: [TimeInterval] { lock.withLock { pending.values.map(\.seconds) } }

    func sleep(_ seconds: TimeInterval) async throws {
        let id = lock.withLock { () -> Int in
            nextId += 1
            return nextId
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                let cancelled = lock.withLock { () -> Bool in
                    if Task.isCancelled { return true }
                    pending[id] = (seconds, c)
                    _delays.append(seconds)
                    return false
                }
                if cancelled { c.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let c = lock.withLock { pending.removeValue(forKey: id)?.c }
            c?.resume(throwing: CancellationError())
        }
    }

    /// True when a pending sleep matched and was woken.
    @discardableResult
    func fire(_ match: (TimeInterval) -> Bool) -> Bool {
        let hit = lock.withLock { () -> CheckedContinuation<Void, Error>? in
            guard let k = pending.first(where: { match($0.value.seconds) })?.key else { return nil }
            return pending.removeValue(forKey: k)?.c
        }
        hit?.resume()
        return hit != nil
    }
}
