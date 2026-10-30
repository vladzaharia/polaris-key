// Fixtures for the nearby (mode v) tests (CC-15.S2 to S4): in-memory pipes, a fake approver network, a
// bare device D that speaks mode v with the real engine, a manual timer, and a fake of the Worker's
// `nearby/approve` that holds the key-binding rule of WIRE-CONTRACT-V5 §12.11.5 rule 3.

import Foundation
import XCTest

@testable import PolarisKeyCore

let nearbySlug = "djdl"
let nearbyDeviceId = "NEARBYDEVICE0000000000000000000D"
let nearbyRequestHandle = "nr_0IvbE7YHMGPBP0VAfZDQhg"

final class NBox<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T {
        get { lock.withLock { v } }
        set { lock.withLock { v = newValue } }
    }
    func mutate(_ f: (inout T) -> Void) { lock.withLock { f(&v) } }
}

/// Poll `cond` until it holds, for at most `seconds`.
func nearbyUntil(
    _ what: String = "", seconds: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line,
    _ cond: @escaping () -> Bool
) async {
    let end = Date().addingTimeInterval(seconds)
    while !cond() {
        if Date() > end {
            XCTFail("timed out: \(what)", file: file, line: line)
            return
        }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
}

/// Let in-flight work settle, for a thing that must NOT happen.
func nearbySettle(_ ms: UInt64 = 80) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

// MARK: - Timers

final class ManualTimers: @unchecked Sendable {
    private struct Entry {
        let id: Int
        let seconds: TimeInterval
        let fn: @Sendable () -> Void
    }
    private let lock = NSLock()
    private var next = 0
    private var entries: [Entry] = []
    private var log: [TimeInterval] = []

    var timer: NearbyTimer {
        { [self] seconds, fn in
            let id = lock.withLock { () -> Int in
                next += 1
                entries.append(Entry(id: next, seconds: seconds, fn: fn))
                log.append(seconds)
                return next
            }
            return { [self] in lock.withLock { entries.removeAll { $0.id == id } } }
        }
    }

    /// How many timers of `seconds` are armed now.
    func armed(_ seconds: TimeInterval) -> Int { lock.withLock { entries.filter { $0.seconds == seconds }.count } }

    /// Every timer scheduled so far, by seconds (cancelled ones too).
    var scheduled: [TimeInterval] { lock.withLock { log } }

    /// Fire (and drop) every armed timer of `seconds`.
    func fire(_ seconds: TimeInterval) {
        let due = lock.withLock { () -> [Entry] in
            let d = entries.filter { $0.seconds == seconds }
            entries.removeAll { $0.seconds == seconds }
            return d
        }
        for e in due { e.fn() }
    }
}

// MARK: - Pipes

/// One end of an in-memory duplex pipe. Closing either end ends both.
final class MemEnd: NearbyInboundPipe, @unchecked Sendable {
    private let inbox: AsyncStream<Data>
    private let inboxCont: AsyncStream<Data>.Continuation
    private var iterator: AsyncStream<Data>.Iterator
    private let lock = NSLock()
    private var peer: MemEnd?
    private var isClosed = false
    let remoteAddress: String
    /// The approver told the gate the transport is up.
    let establishedCalls = NBox(0)
    /// The approver released the slot.
    let settleCalls = NBox(0)

    init(remote: String) {
        let (s, c) = AsyncStream<Data>.makeStream()
        inbox = s
        inboxCont = c
        iterator = s.makeAsyncIterator()
        remoteAddress = remote
    }

    static func pair(clientAddress: String = "127.0.0.1") -> (client: MemEnd, server: MemEnd) {
        let c = MemEnd(remote: "127.0.0.1")
        let s = MemEnd(remote: clientAddress)
        c.peer = s
        s.peer = c
        return (c, s)
    }

    var closed: Bool { lock.withLock { isClosed } }

    func read() async throws -> Data? { await iterator.next() }

    func write(_ bytes: Data) async throws {
        let p = lock.withLock { isClosed ? nil : peer }
        guard let p else { throw BonjourFake.closed }
        p.inboxCont.yield(bytes)
    }

    func close() async {
        let p = lock.withLock { () -> MemEnd? in
            if isClosed { return nil }
            isClosed = true
            return peer
        }
        inboxCont.finish()
        if let p { await p.peerClosed() }
    }

    fileprivate func peerClosed() async {
        let first = lock.withLock { () -> Bool in
            if isClosed { return false }
            isClosed = true
            return true
        }
        if first { inboxCont.finish() }
    }

    func established() { establishedCalls.mutate { $0 += 1 } }
    func settle() { settleCalls.mutate { $0 += 1 } }
}

enum BonjourFake: Error { case closed }

// MARK: - The fake approver network

final class FakeAdvertHandle: NearbyAdvertHandle, @unchecked Sendable {
    let instance: String
    let txt: [String]
    let port: Int
    let onPipe: @Sendable (any NearbyInboundPipe) -> Void
    let stops = NBox(0)
    /// `stop()` never returns while set.
    let hang = NBox(false)

    init(instance: String, txt: [String], port: Int, onPipe: @escaping @Sendable (any NearbyInboundPipe) -> Void) {
        self.instance = instance
        self.txt = txt
        self.port = port
        self.onPipe = onPipe
    }

    func stop() async {
        stops.mutate { $0 += 1 }
        while hang.value { try? await Task.sleep(nanoseconds: 10_000_000) }
    }

    var stopped: Bool { stops.value > 0 }
}

final class FakeApproverNet: NearbyApproverNetwork, @unchecked Sendable {
    let handles = NBox<[FakeAdvertHandle]>([])
    let failNext = NBox<NearbyError?>(nil)
    private let nextPort = NBox(40000)

    func open(
        instance: String, txt: [String], onPipe: @escaping @Sendable (any NearbyInboundPipe) -> Void
    ) async throws -> any NearbyAdvertHandle {
        if let e = failNext.value {
            failNext.value = nil
            throw e
        }
        let port = nextPort.value
        nextPort.mutate { $0 += 1 }
        let h = FakeAdvertHandle(instance: instance, txt: txt, port: port, onPipe: onPipe)
        handles.mutate { $0.append(h) }
        return h
    }

    /// The adverts that stand now (not stopped).
    var live: [FakeAdvertHandle] { handles.value.filter { !$0.stopped } }

    /// A client end connected to the newest advert's listener (or the given one).
    func connect(to handle: FakeAdvertHandle? = nil, from address: String = "127.0.0.1") -> (
        client: MemEnd, server: MemEnd
    ) {
        let h = handle ?? handles.value.last!
        let (c, s) = MemEnd.pair(clientAddress: address)
        h.onPipe(s)
        return (c, s)
    }
}

// MARK: - A bare device D

/// D at the record level: the real engine over a pipe, and what came back.
final class RawD: @unchecked Sendable {
    let link: PeerLink
    private let eventsBox: NBox<[PeerSessionEvent]>
    private let closedBox: NBox<PeerLinkClosed?>
    let keys: any DeviceKeyPort
    let label: String?
    let platform: String
    let request: String
    let deviceId: String

    private init(
        link: PeerLink, keys: any DeviceKeyPort, label: String?, platform: String, request: String,
        deviceId: String, events: NBox<[PeerSessionEvent]>, closed: NBox<PeerLinkClosed?>
    ) {
        self.link = link
        self.keys = keys
        self.label = label
        self.platform = platform
        self.request = request
        self.deviceId = deviceId
        eventsBox = events
        closedBox = closed
    }

    static func over(
        _ pipe: any PeerBytePipe, label: String? = nil, hold: Bool = true, request: String = nearbyRequestHandle,
        deviceId: String = nearbyDeviceId, keys: (any DeviceKeyPort)? = nil, slug: String = nearbySlug,
        platform: String = "macos"
    ) async throws -> RawD {
        let ev = NBox<[PeerSessionEvent]>([])
        let cl = NBox<PeerLinkClosed?>(nil)
        let opts = PeerChannelOptions(
            role: .initiator, slug: slug, staticKey: try PeerOneTimeKey(),
            hello: (label, platform, slug, nil), mode: .v, holdSas: hold)
        let link = try await PeerLink.make(
            pipe: pipe, options: opts,
            handlers: PeerLinkHandlers(
                onClosed: { cl.value = $0 }, onSession: { e in ev.mutate { $0.append(e) } }))
        let k: any DeviceKeyPort
        if let keys { k = keys } else { k = try DeviceKeyStore.inMemory() }
        _ = try await k.ensure()
        let d = RawD(
            link: link, keys: k, label: label, platform: platform, request: request, deviceId: deviceId, events: ev,
            closed: cl)
        Task { await link.run() }
        await link.start()
        return d
    }

    var channel: PeerChannel { link.channel }

    var allEvents: [PeerSessionEvent] { eventsBox.value }
    var closed: PeerLinkClosed? { closedBox.value }

    var hello: PeerHello? {
        for e in allEvents { if case .established(let est) = e { return est.hello } }
        return nil
    }
    var code: Int? {
        for e in allEvents { if case .sas(let c, _) = e { return c } }
        return nil
    }
    var records: [(type: Int, body: Data)] {
        allEvents.compactMap { if case .record(let t, let b) = $0 { return (t, b) } else { return nil } }
    }

    func startSas() async { await link.startSas() }

    /// Show the code (D's confirmation) and send `VOUCH_REQ`.
    func showAndRequest(label sent: String?? = nil) async throws {
        guard let flow = channel.vouch else { throw NearbyError.closed }
        flow.codeShown()
        await channel.confirmSas()
        let h = try await channel.handshakeHash()
        let body = try await PeerVouch.buildRequest(
            port: keys, slug: nearbySlug, h: h, request: request, deviceId: deviceId,
            hello: VouchHello(label: sent ?? label, platform: platform))
        let rec = VouchRecord(type: PeerRecordType.vouchReq, body: body)
        guard case .ok = flow.send(rec) else { throw NearbyError.closed }
        try await link.sendRecord(type: rec.type, body: rec.body)
    }
}

// MARK: - A fake of nearby/approve

/// The Worker's side of `approve`, enough to hold the key-binding rule: it compares the request, the
/// device id and both keys with what D sent on `start`.
final class FakeApprove: @unchecked Sendable {
    let started: (request: String, deviceId: String, signKey: String, agreeKey: String)
    let calls = NBox<[VouchRequest]>([])

    init(request: String, deviceId: String, keys: DevicePublicKeys) {
        started = (request, deviceId, keys.signKey, keys.agreeKey)
    }

    func answer(_ r: VouchRequest) -> VouchApproveAnswer {
        calls.mutate { $0.append(r) }
        let ok =
            r.request == started.request && r.deviceId == started.deviceId && r.signKey == started.signKey
            && r.agreeKey == started.agreeKey
        return ok
            ? VouchApproveAnswer(http: 200, body: #"{"status":"approved","deviceLabel":null}"#, discoveryNearby: true)
            : VouchApproveAnswer(http: 404, body: nil, discoveryNearby: true)
    }
}
