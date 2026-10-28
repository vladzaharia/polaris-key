// WIRE-CONTRACT-V5 §15.6: a `PeerChannel` bound to one byte pipe (CC-11.10). Mirrors `SocketLink` in
// sdk-node's `connect/session.ts` and the Python port's `core/peer_link.py`.
//
// The channel owns the handshake, admission, records, MORE reassembly and rekey; this file owns the
// bytes: it cuts TCP frames with `PeerFrameReader`, writes the channel's Noise messages as frames,
// drives its deadlines from the clock, and turns its events into callbacks.
//
// Rules this file keeps:
//  - a frame is at most 65,535 bytes; before the session is admitted a frame over 16 KiB ends it, and
//    so does a socket still unadmitted after 30 s;
//  - every failure ends the link and says why; nothing reaches the host before the session is open;
//  - `pause(true)` stops reading from the pipe, so a peer that sends faster than the host reads is
//    held back by TCP (the host-side queue caps live in `ConnectSession`);
//  - nothing here knows an error taxonomy: a refused handshake throws `PeerLinkRefused` with the code
//    the channel closed with.

import Foundation

/// A duplex byte stream: a TCP connection, or a test's in-memory pair.
public protocol PeerBytePipe: Sendable {
    /// The next chunk; nil at the end of the stream.
    func read() async throws -> Data?
    func write(_ bytes: Data) async throws
    func close() async
    var remoteAddress: String { get }
}

/// The peer was not admitted. `closeCode` is the session's close code.
public struct PeerLinkRefused: Error, Sendable, Equatable {
    public let closeCode: String
}

/// How a link ended: a session close code, or `connection_lost` when the pipe went away.
public struct PeerLinkClosed: Sendable, Equatable {
    public let code: String
    public let byPeer: Bool
}

/// What a link reports. All are optional; they run on the link's event task, in order.
public struct PeerLinkHandlers: Sendable {
    public var onEstablished: (@Sendable (PeerEstablished, _ remoteAddress: String) -> Void)?
    public var onRecord: (@Sendable (_ type: Int, _ body: Data) -> Void)?
    public var onRing: (@Sendable (_ jws: String, _ epoch: Int) -> Void)?
    public var onTrust: (@Sendable (_ jws: String) -> Void)?
    public var onRingWanted: (@Sendable () -> Void)?
    public var onClosed: (@Sendable (PeerLinkClosed) -> Void)?
    public var onEnded: (@Sendable () -> Void)?

    public init(
        onEstablished: (@Sendable (PeerEstablished, String) -> Void)? = nil,
        onRecord: (@Sendable (Int, Data) -> Void)? = nil, onRing: (@Sendable (String, Int) -> Void)? = nil,
        onTrust: (@Sendable (String) -> Void)? = nil, onRingWanted: (@Sendable () -> Void)? = nil,
        onClosed: (@Sendable (PeerLinkClosed) -> Void)? = nil, onEnded: (@Sendable () -> Void)? = nil
    ) {
        self.onEstablished = onEstablished
        self.onRecord = onRecord
        self.onRing = onRing
        self.onTrust = onTrust
        self.onRingWanted = onRingWanted
        self.onClosed = onClosed
        self.onEnded = onEnded
    }
}

/// Everything a `PeerChannel` is built from except the two callbacks the link supplies.
public struct PeerChannelOptions: Sendable {
    public var role: PeerChannel.Role
    public var slug: String
    public var staticKey: any PeerNoiseStaticKey
    public var account: PeerAccountContext?
    public var admission: HandshakeLimiter?
    public var caps: [String]
    public var hello: (label: String?, platform: String, app: String, maxMessage: Int?)
    public var mode: PeerNoiseMode
    public var now: (@Sendable () -> Int)?
    public var mono: (@Sendable () -> TimeInterval)?
    public var rekeyMessages: Int
    public var rekeySeconds: TimeInterval

    public init(
        role: PeerChannel.Role, slug: String, staticKey: any PeerNoiseStaticKey, account: PeerAccountContext? = nil,
        admission: HandshakeLimiter? = nil, caps: [String] = [],
        hello: (label: String?, platform: String, app: String, maxMessage: Int?), mode: PeerNoiseMode = .a,
        now: (@Sendable () -> Int)? = nil, mono: (@Sendable () -> TimeInterval)? = nil,
        rekeyMessages: Int = 1 << 20, rekeySeconds: TimeInterval = 3600
    ) {
        self.role = role
        self.slug = slug
        self.staticKey = staticKey
        self.account = account
        self.admission = admission
        self.caps = caps
        self.hello = hello
        self.mode = mode
        self.now = now
        self.mono = mono
        self.rekeyMessages = rekeyMessages
        self.rekeySeconds = rekeySeconds
    }
}

/// Bytes the link may hold for a pipe that is not taking them (S5): beyond this the peer is closed with
/// `peer_busy`. A roster device that sends PINGs and never reads would otherwise grow the buffer forever.
public let peerLinkWriteMaxBytes = 8 * 1024 * 1024

public actor PeerLink: CustomStringConvertible, CustomReflectable {
    public static let handshakeFrameMax = 16_384
    public static let handshakeSeconds: TimeInterval = 30
    /// How long a finished link gives its writer to flush the CLOSE record before the pipe is closed anyway.
    public static let pipeGraceSeconds: TimeInterval = 3
    /// The least a deadline timer waits, so a deadline that is due now cannot spin.
    private static let minWake: TimeInterval = 0.05

    public nonisolated let channel: PeerChannel
    private let pipe: any PeerBytePipe
    private let handlers: PeerLinkHandlers
    private let outbound: AsyncStream<Data>.Continuation
    private let inbound: AsyncStream<PeerSessionEvent>.Continuation
    private var eventTask: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var wake: Task<Void, Never>?
    private var frames = PeerFrameReader()
    private var ended = false
    private var lost = false
    private var open = false
    private var paused = false
    private var pauseWaiters: [CheckedContinuation<Void, Never>] = []
    private let backlog: LockedValue<Int>
    private let overflowHook: LockedValue<(@Sendable () -> Void)?>
    private var overflowed = false
    private var openedResult: Result<PeerEstablished, PeerLinkRefused>?
    private var openedWaiters: [CheckedContinuation<Result<PeerEstablished, PeerLinkRefused>, Never>] = []

    private let events: AsyncStream<PeerSessionEvent>
    private let handshakeLimit: TimeInterval
    private let pipeGrace: TimeInterval

    /// Bind a channel to a pipe. The link's event and deadline tasks start here.
    public static func make(
        pipe: any PeerBytePipe, options: PeerChannelOptions, handlers: PeerLinkHandlers = PeerLinkHandlers(),
        handshakeSeconds: TimeInterval = PeerLink.handshakeSeconds,
        pipeGraceSeconds: TimeInterval = PeerLink.pipeGraceSeconds
    ) async throws -> PeerLink {
        let l = try PeerLink(
            pipe: pipe, options: options, handlers: handlers, handshakeSeconds: handshakeSeconds,
            pipeGraceSeconds: pipeGraceSeconds)
        await l.begin()
        return l
    }

    private init(
        pipe: any PeerBytePipe, options o: PeerChannelOptions, handlers: PeerLinkHandlers,
        handshakeSeconds: TimeInterval, pipeGraceSeconds: TimeInterval
    ) throws {
        pipeGrace = pipeGraceSeconds
        let (ostream, ocont) = AsyncStream<Data>.makeStream()
        let (estream, econt) = AsyncStream<PeerSessionEvent>.makeStream()
        let bl = LockedValue(0)
        let oh = LockedValue<(@Sendable () -> Void)?>(nil)
        backlog = bl
        overflowHook = oh
        self.pipe = pipe
        self.handlers = handlers
        self.outbound = ocont
        self.inbound = econt
        channel = try PeerChannel(
            role: o.role, slug: o.slug, staticKey: o.staticKey, account: o.account, admission: o.admission,
            caps: o.caps, hello: o.hello,
            send: { d in
                ocont.yield(d)
                if bl.with({
                    $0 += d.count + 2
                    return $0
                }) > peerLinkWriteMaxBytes {
                    oh.current?()
                }
            }, onEvent: { econt.yield($0) }, mode: o.mode,
            now: o.now, mono: o.mono, rekeyMessages: o.rekeyMessages, rekeySeconds: o.rekeySeconds)
        // The writer drains in order and closes the pipe once the link ends, so a CLOSE record is
        // flushed before the pipe goes.
        let p = pipe
        Task {
            for await d in ostream {
                bl.with { $0 = max(0, $0 - d.count - 2) }
                guard let f = try? PeerFrame.encode(d) else { continue }
                try? await p.write(f)
            }
            await p.close()
        }
        events = estream
        handshakeLimit = handshakeSeconds
    }

    private func begin() {
        overflowHook.set { [weak self] in
            guard let self else { return }
            Task { await self.writeOverflow() }
        }
        let estream = events
        let limit = handshakeLimit
        eventTask = Task { [weak self] in
            for await e in estream { await self?.handle(e) }
        }
        deadline = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000))
            if !Task.isCancelled { await self?.fail("handshake_failed") }
        }
    }

    /// The pipe is not taking what we write: close the pipe (which also unblocks the writer) and end the
    /// link with `peer_busy`.
    private func writeOverflow() async {
        if ended || overflowed { return }
        overflowed = true
        await pipe.close()
    }

    public nonisolated var description: String { "PeerLink()" }
    public nonisolated var customMirror: Mirror { Mirror(self, children: [:]) }

    public var remoteAddress: String { pipe.remoteAddress }

    // MARK: The loop

    /// Read until the pipe ends. The caller starts it as a task; for an initiator, call `start()`
    /// first.
    public func run() async {
        while !ended {
            await waitUnpaused()
            guard let chunk = try? await pipe.read(), !chunk.isEmpty else { break }
            await data(chunk)
        }
        lost = true
        // Frames that arrived before the FIN were handled above; now end the session.
        await channel.close(overflowed ? .peerBusy : .peerBye)
        inbound.finish()
        await eventTask?.value
        finish(PeerLinkClosed(code: overflowed ? "peer_busy" : "connection_lost", byPeer: false))
    }

    /// Initiator: write message 1.
    public func start() async {
        await channel.start()
        await arm()
    }

    /// Await admission: the established peer, or `PeerLinkRefused` when it was not admitted.
    public func opened() async throws -> PeerEstablished {
        let r: Result<PeerEstablished, PeerLinkRefused>
        if let done = openedResult {
            r = done
        } else {
            r = await withCheckedContinuation { openedWaiters.append($0) }
        }
        return try r.get()
    }

    /// Stop (true) or resume (false) reading from the pipe. Safe from any context.
    public nonisolated func pause(_ on: Bool) {
        Task { await self.setPaused(on) }
    }

    private func setPaused(_ on: Bool) {
        paused = on
        if !on {
            let w = pauseWaiters
            pauseWaiters = []
            for c in w { c.resume() }
        }
    }

    private func waitUnpaused() async {
        while paused && !ended { await withCheckedContinuation { pauseWaiters.append($0) } }
    }

    // MARK: Calls

    public func sendRecord(type: Int, body: Data) async throws { try await channel.sendRecord(type: type, body: body) }

    /// End the session with a code (a CLOSE record when the transport exists).
    public func close(_ code: PeerCloseCode = .peerBye) async { await channel.close(code) }

    /// The same, for a callback that cannot await.
    public nonisolated func closeSoon(_ code: PeerCloseCode) {
        let c = channel
        Task { await c.close(code) }
    }

    // MARK: Internals

    private func data(_ chunk: Data) async {
        if ended { return }
        let got: [Data]
        do { got = try frames.push(chunk) } catch { return fail("peer_bad_frame") }
        for f in got {
            if ended { return }
            if !open && f.count > Self.handshakeFrameMax { return fail("handshake_failed") }
            await channel.receive(f)
        }
        await arm()
    }

    private func arm() async {
        wake?.cancel()
        wake = nil
        if ended { return }
        guard let w = await channel.wakeIn() else { return }
        wake = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(w, Self.minWake) * 1_000_000_000))
            if !Task.isCancelled { await self?.tick() }
        }
    }

    private func tick() async {
        wake = nil
        await channel.tick()
        await arm()
    }

    private func fail(_ code: String) {
        if ended { return }
        // Not a live session: the channel has nothing to send.
        if !open { finish(PeerLinkClosed(code: code, byPeer: false)) }
        closeSoon(.peerBye)
    }

    private func handle(_ e: PeerSessionEvent) {
        switch e {
        case .established(let est):
            guard est.peerDeviceId != nil else { return }
            deadline?.cancel()
            deadline = nil
            open = true
            handlers.onEstablished?(est, pipe.remoteAddress)
            resolve(.success(est))
        case .record(let t, let b):
            handlers.onRecord?(t, b)
        case .ring(let j, let n):
            handlers.onRing?(j, n)
        case .trustUnverified(let j):
            handlers.onTrust?(j)
        case .ringWanted:
            handlers.onRingWanted?()
        case .sas:
            break
        case .closed(let reason, let byPeer):
            finish(
                PeerLinkClosed(
                    code: lost && !byPeer && !overflowed ? "connection_lost" : reason.rawValue, byPeer: byPeer))
        }
    }

    private func resolve(_ r: Result<PeerEstablished, PeerLinkRefused>) {
        if openedResult != nil { return }
        openedResult = r
        let w = openedWaiters
        openedWaiters = []
        for c in w { c.resume(returning: r) }
    }

    private func finish(_ c: PeerLinkClosed) {
        if ended { return }
        ended = true
        deadline?.cancel()
        wake?.cancel()
        deadline = nil
        wake = nil
        handlers.onClosed?(c)
        resolve(.failure(PeerLinkRefused(closeCode: c.code)))
        // Finishing the outbound stream flushes what the CLOSE record wrote, then drops the pipe.
        outbound.finish()
        // A writer stuck in a write never reaches the end of its stream: close the pipe ourselves, at once for
        // `peer_busy` (the peer is not reading), after a short grace otherwise so the CLOSE record can go.
        let p = pipe
        let grace = c.code == "peer_busy" ? 0 : pipeGrace
        Task {
            if grace > 0 { try? await Task.sleep(nanoseconds: UInt64(grace * 1_000_000_000)) }
            await p.close()
        }
        inbound.finish()
        setPaused(false)
        handlers.onEnded?()
    }
}
