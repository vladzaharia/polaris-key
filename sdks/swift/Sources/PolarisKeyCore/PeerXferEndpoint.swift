// WIRE-CONTRACT-V5 §15.11: runs an `XferMachine` over a session. The machine decides; this layer performs what it
// asks, in order: effects on the partial files, then the records, then the events for the host. It reads the
// sender's bytes and stores the receiver's through ports. Swift mirror of client-core's `peer/xferEndpoint.ts`.
//
// A source failure cancels the transfer and sends no DONE. A store failure closes the session `peer_bye` and
// keeps the partials. Every call is serialised: a step's work is queued behind the one before it.

import Foundation

/// One effect on a partial file, with what the store needs to carry it out.
public struct XferOp: Sendable {
    public let effect: XferPartialEffect
    /// For `create`: the entry as the machine made it.
    public let meta: XferPartial?
    /// The transfer the effect belongs to, when it names one (`create`, `truncate`, `finalize`, `write`).
    public let id: String?
}

/// What the host sees of a transfer.
public struct XferEvents: Sendable {
    /// The host is asked about an `OFFER`; it answers with `consent`.
    public var ask: @Sendable (XferAsk) -> Void
    /// The question for this id is withdrawn (the peer or a timer ended the transfer).
    public var withdraw: @Sendable (String) -> Void
    public var result: @Sendable (XferResult) -> Void
    /// The host's own `offer` was refused locally: too many live transfers.
    public var refused: @Sendable (String) -> Void
    /// A port failed; the session is being closed and the partials are kept.
    public var error: @Sendable (Error) -> Void

    public init(
        ask: @escaping @Sendable (XferAsk) -> Void, withdraw: @escaping @Sendable (String) -> Void,
        result: @escaping @Sendable (XferResult) -> Void, refused: @escaping @Sendable (String) -> Void,
        error: @escaping @Sendable (Error) -> Void
    ) {
        self.ask = ask
        self.withdraw = withdraw
        self.result = result
        self.refused = refused
        self.error = error
    }
}

public struct XferEndpointPorts: Sendable {
    public var send: @Sendable (Int, Data) async throws -> Void
    public var close: @Sendable (PeerCloseCode) -> Void
    /// The sender's source: bytes `[offset, offset + length)` of the transfer `id`.
    public var read: @Sendable (String, Int, Int) async throws -> Data
    /// The receiver's store.
    public var apply: @Sendable (XferOp) async throws -> Void
    /// Called at once, in order, as the machine decides, before `apply` runs: the store reserves the bytes of a
    /// transfer that was accepted and releases them when it ends, so the next offer sees them taken.
    public var account: @Sendable (XferOp) -> Void

    public init(
        send: @escaping @Sendable (Int, Data) async throws -> Void, close: @escaping @Sendable (PeerCloseCode) -> Void,
        read: @escaping @Sendable (String, Int, Int) async throws -> Data,
        apply: @escaping @Sendable (XferOp) async throws -> Void,
        account: @escaping @Sendable (XferOp) -> Void = { _ in }
    ) {
        self.send = send
        self.close = close
        self.read = read
        self.apply = apply
        self.account = account
    }
}

public final class XferEndpoint: @unchecked Sendable {
    private struct State {
        var machine: XferMachine
        var dead = false
        var chunk: [String: Int] = [:]
        var refId: [String: String] = [:]
        var timer: Task<Void, Never>?
    }

    private let state: LockedValue<State>
    private let chain = LockedValue<Task<Void, Never>>(Task {})
    private let ports: XferEndpointPorts
    private let events: XferEvents
    private let now: @Sendable () -> Double
    private let sleep: @Sendable (Double) async -> Void

    /// `now` is a monotonic clock in seconds; `sleep` waits that many seconds (tests drive both).
    public init(
        options: XferMachineOptions, ports: XferEndpointPorts, events: XferEvents,
        now: (@Sendable () -> Double)? = nil, sleep: (@Sendable (Double) async -> Void)? = nil
    ) {
        self.sleep = sleep ?? { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000) + 1_000_000) }
        state = LockedValue(State(machine: XferMachine(options)))
        self.ports = ports
        self.events = events
        self.now = now ?? { ProcessInfo.processInfo.systemUptime }
    }

    /// A record of the session: one of the six types.
    public func receive(type: Int, body: Data) {
        guard isXferType(type) else { return }
        step { m, t in m.receive(t, type: type, body: body) }
    }

    public func offer(_ a: XferOfferArgs) throws {
        var thrown: Error?
        step(offered: a.id) { m, t in
            do {
                return try m.offer(t, a)
            } catch {
                thrown = error
                return XferOut()
            }
        } onOut: { s, out in
            if out.refusedBusy == false { s.chunk[a.id] = a.chunk }
        }
        if let thrown { throw thrown }
    }

    public func consent(id: String, accept: Bool) {
        step { m, t in m.consent(t, id: id, accept: accept) }
    }

    public func cancel(id: String) {
        step { m, t in m.cancel(t, id: id) }
    }

    /// The session closed: every live transfer ends `closed` and the partials stay.
    public func closed() {
        let t = now()
        state.with { s in
            if s.dead { return }
            let out = s.machine.abandon(t)
            enqueue(out, &s, offered: nil)
            s.dead = true
            s.timer?.cancel()
            s.timer = nil
        }
    }

    /// Resolves when everything queued so far has been performed.
    public func idle() async { await chain.current.value }

    // MARK: Internals

    private func step(
        offered: String? = nil, _ f: (inout XferMachine, Double) -> XferOut,
        onOut: ((inout State, XferOut) -> Void)? = nil
    ) {
        let t = now()
        state.with { s in
            if s.dead { return }
            let out = f(&s.machine, t)
            onOut?(&s, out)
            enqueue(out, &s, offered: offered)
            if let code = out.close {
                ports.close(code)
                let o2 = s.machine.abandon(t)
                enqueue(o2, &s, offered: nil)
                s.dead = true
            }
            arm(&s)
        }
    }

    /// Queue what a step asked for. Called with the lock held; the work itself runs later, in order.
    private func enqueue(_ out: XferOut, _ s: inout State, offered: String?) {
        var ops: [XferOp] = []
        var acceptId: String?
        for e in out.send { if case .accept(let id, _) = e { acceptId = id } }
        for e in out.partial {
            switch e {
            case .create(let ref):
                if let id = acceptId { s.refId[ref] = id }
                ops.append(
                    XferOp(
                        effect: e, meta: s.machine.partials.first { $0.ref == ref }, id: s.refId[ref]))
            case .truncate(let ref, _):
                if let id = acceptId { s.refId[ref] = id }
                ops.append(
                    XferOp(
                        effect: e, meta: s.machine.partials.first { $0.ref == ref }, id: s.refId[ref]))
            case .finalize(let ref), .write(let ref, _, _):
                ops.append(XferOp(effect: e, meta: nil, id: s.refId[ref]))
            default:
                ops.append(XferOp(effect: e, meta: nil, id: nil))
            }
        }
        for op in ops { ports.account(op) }
        let frozen = ops
        let sends = out.send
        let withdraw = out.withdraw
        let ask = out.ask
        let refused = out.refusedBusy
        let results = out.results
        let chunks = s.chunk
        queue {
            var failed = Set<String>()
            do {
                for op in frozen { try await self.ports.apply(op) }
                for send in sends { try await self.perform(send, chunks, &failed) }
            } catch {
                self.events.error(error)
                self.ports.close(.peerBye)
                return
            }
            for id in withdraw { self.events.withdraw(id) }
            if let ask { self.events.ask(ask) }
            if refused, let offered { self.events.refused(offered) }
            for r in results { self.events.result(r) }
            for id in failed {
                self.step { m, t in m.fail(t, id: id) }
            }
        }
    }

    private func queue(_ work: @escaping @Sendable () async -> Void) {
        chain.with { prev in
            let p = prev
            prev = Task {
                await p.value
                await work()
            }
        }
    }

    private func perform(_ s: XferSend, _ chunks: [String: Int], _ failed: inout Set<String>) async throws {
        switch s {
        case .chunks(let id, _, _), .done(let id, _):
            if failed.contains(id) { return }
        default: break
        }
        switch s {
        case .offer(let o): try await ports.send(XferType.offer, XferCodec.offerBody(o))
        case .accept(let id, let off): try await ports.send(XferType.accept, XferCodec.offsetBody(id: id, offset: off))
        case .ack(let id, let off): try await ports.send(XferType.ack, XferCodec.offsetBody(id: id, offset: off))
        case .done(let id, let sha): try await ports.send(XferType.done, XferCodec.doneBody(id: id, sha256: sha))
        case .cancel(let id, let r): try await ports.send(XferType.cancel, XferCodec.cancelBody(id: id, reason: r))
        case .chunks(let id, let offset, let bytes):
            guard let chunk = chunks[id] else { return }
            var at = offset
            while at < offset + bytes {
                let len = min(chunk, offset + bytes - at)
                let data: Data
                do {
                    data = try await ports.read(id, at, len)
                    if data.count != len { throw XferStoreError(.io) }
                } catch {
                    // The source failed: the transfer ends here, and its `DONE` never goes out.
                    failed.insert(id)
                    return
                }
                try await ports.send(XferType.chunk, XferCodec.chunkBody(id: id, offset: at, data: data))
                at += len
            }
        }
    }

    /// One timer, set for the machine's next wait. Called with the lock held.
    private func arm(_ s: inout State) {
        s.timer?.cancel()
        s.timer = nil
        if s.dead { return }
        guard let at = s.machine.nextDeadline() else { return }
        let wait = max(0, at - now())
        let sleep = self.sleep
        s.timer = Task { [weak self] in
            await sleep(wait)
            if Task.isCancelled { return }
            self?.step { m, t in m.tick(t) }
        }
    }
}
