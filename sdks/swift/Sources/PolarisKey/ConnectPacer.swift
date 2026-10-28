// Outgoing pacing for the relay socket (CC-11.14, decision D-9; WIRE-CONTRACT-V5 §15.7, G17). The room allows a
// client 200 messages a second with a burst of 400 and answers a client that exceeds it with LIMIT 1 and, if it
// persists, a close; this client stays under it:
//
//  - a token bucket on every outgoing envelope: 180 a second with a burst of 360 (0.9 of the room's numbers);
//  - LIMIT 1 halves the rate for 10 seconds;
//  - the queue behind the socket holds at most 8 MiB. A host send that would go beyond it is refused with
//    `rate_limited` before anything is encrypted, so the session's keys never advance for a message that was
//    not queued.
//
// Pure bookkeeping over an injected clock and sleep: nothing here touches a socket.

import Foundation

public let connectPacerRate: Double = 180
public let connectPacerBurst: Double = 360
public let connectPacerHalvedSeconds: TimeInterval = 10
public let connectOutboxMaxBytes = 8 * 1024 * 1024

/// A token bucket. `acquire` waits until one token is available.
public final class ConnectPacer: Sendable {
    private struct State {
        var tokens: Double
        var at: TimeInterval
        var halvedUntil: TimeInterval = -.infinity
    }

    private let baseRate: Double
    private let burst: Double
    private let clock: @Sendable () -> TimeInterval
    private let sleeper: @Sendable (TimeInterval) async throws -> Void
    private let state: LockedValue<State>

    public init(
        rate: Double = connectPacerRate, burst: Double = connectPacerBurst,
        clock: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        sleep: (@Sendable (TimeInterval) async throws -> Void)? = nil
    ) {
        baseRate = rate
        self.burst = burst
        self.clock = clock
        sleeper = sleep ?? { s in try await Task.sleep(nanoseconds: UInt64(max(0, s) * 1_000_000_000)) }
        state = LockedValue(State(tokens: burst, at: clock()))
    }

    /// The rate in force now: half the base rate while a LIMIT 1 is being honoured.
    public var rate: Double { state.with { rateLocked($0) } }

    private func rateLocked(_ s: State) -> Double { clock() < s.halvedUntil ? baseRate / 2 : baseRate }

    /// LIMIT 1: send at half the rate for `seconds`.
    public func halve(seconds: TimeInterval = connectPacerHalvedSeconds) {
        state.with { s in
            refill(&s)
            s.halvedUntil = clock() + seconds
            s.tokens = min(s.tokens, burst / 2)
        }
    }

    private func refill(_ s: inout State) {
        let now = clock()
        if now > s.at { s.tokens = min(burst, s.tokens + (now - s.at) * rateLocked(s)) }
        s.at = now
    }

    /// 0 when a token was taken; else how many seconds until one is available.
    public func tryTake() -> TimeInterval {
        state.with { s in
            refill(&s)
            if s.tokens >= 1 {
                s.tokens -= 1
                return 0
            }
            return (1 - s.tokens) / rateLocked(s)
        }
    }

    public func acquire() async throws {
        while true {
            let w = tryTake()
            if w <= 0 { return }
            try await sleeper(w)
        }
    }
}

/// The envelopes waiting for the socket, with their byte count. `put` refuses (false) a non-forced item that
/// would take the queue past `maxBytes`; handshake and control envelopes are forced, since refusing one would
/// stall a session without telling the host.
public final class ConnectOutbox: Sendable {
    private struct State {
        var q: [Data] = []
        var tags: [Int?] = []
        var byTag: [Int: Int] = [:]
        var bytes = 0
        var inflight = false
        var waiter: CheckedContinuation<Data?, Never>?
        var closed = false
    }

    public let maxBytes: Int
    private let state = LockedValue(State())

    public init(maxBytes: Int = connectOutboxMaxBytes) { self.maxBytes = maxBytes }

    public var queued: Int { state.with { $0.bytes } }
    public var count: Int { state.with { $0.q.count } }
    public func roomFor(_ n: Int) -> Bool { state.with { $0.bytes + n <= maxBytes } }

    @discardableResult
    public func put(_ data: Data, force: Bool = false, tag: Int? = nil) -> Bool {
        enum Put {
            case refused
            case queued
            case handed(CheckedContinuation<Data?, Never>)
        }
        let r: Put = state.with { s in
            if s.closed || (!force && s.bytes + data.count > maxBytes) { return .refused }
            if let w = s.waiter {
                s.waiter = nil
                s.inflight = true
                return .handed(w)
            }
            s.q.append(data)
            s.tags.append(tag)
            if let tag { s.byTag[tag, default: 0] += data.count }
            s.bytes += data.count
            return .queued
        }
        switch r {
        case .refused: return false
        case .queued: return true
        case .handed(let w):
            w.resume(returning: data)
            return true
        }
    }

    /// The next envelope; nil once closed.
    public func get() async -> Data? {
        await withCheckedContinuation { (c: CheckedContinuation<Data?, Never>) in
            let ready: Data?? = state.with { s in
                if s.closed { return .some(nil) }
                if !s.q.isEmpty {
                    let d = s.q.removeFirst()
                    if let t = s.tags.removeFirst() { Self.take(&s, t, d.count) }
                    s.bytes -= d.count
                    s.inflight = true
                    return .some(d)
                }
                s.waiter = c
                return nil
            }
            if let ready { c.resume(returning: ready) }
        }
    }

    private static func take(_ s: inout State, _ tag: Int, _ n: Int) {
        let left = (s.byTag[tag] ?? 0) - n
        s.byTag[tag] = left > 0 ? left : nil
    }

    /// Bytes queued under `tag` (per-session accounting).
    public func queued(tag: Int) -> Int { state.with { $0.byTag[tag] ?? 0 } }

    /// The tag with the most bytes queued, and how many.
    public func largest() -> (tag: Int, bytes: Int)? {
        state.with { s in s.byTag.max { $0.value < $1.value }.map { ($0.key, $0.value) } }
    }

    /// Drop everything queued under `tag` (its session was closed).
    public func purge(tag: Int) {
        state.with { s in
            var q: [Data] = []
            var tags: [Int?] = []
            for (d, t) in zip(s.q, s.tags) {
                if t == tag { s.bytes -= d.count } else {
                    q.append(d)
                    tags.append(t)
                }
            }
            s.q = q
            s.tags = tags
            s.byTag[tag] = nil
        }
    }

    /// The item `get` returned has been written (or given up on).
    public func sent() { state.with { $0.inflight = false } }

    public func close() {
        let w = state.with { s -> CheckedContinuation<Data?, Never>? in
            s.closed = true
            s.q = []
            s.tags = []
            s.byTag = [:]
            s.bytes = 0
            defer { s.waiter = nil }
            return s.waiter
        }
        w?.resume(returning: nil)
    }

    /// Wait (polling) until nothing is queued, or `timeout` seconds. True when drained.
    public func drained(timeout: TimeInterval) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while state.with({ !$0.q.isEmpty || $0.inflight }) {
            if Date() >= end { return false }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return true
    }
}
