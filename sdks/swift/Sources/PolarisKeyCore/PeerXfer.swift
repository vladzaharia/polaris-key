// WIRE-CONTRACT-V5 §15.11: Direct Transfer (`xfer/1`). The control-body codecs, the partial-file path and
// `XferMachine`, one side of one session as a state machine. Swift mirror of client-core's `peer/xfer.ts`.
//
// A machine does no I/O. It reads records, the host's calls and a clock, and answers each with an `XferOut`:
// records to send, a question for the host, effects on the kept partial files. `XferEndpoint` runs a machine
// over a session. `peer-matrix.json` `xfer` is the conformance check.
//
// Nothing here prints a body, a name or a key.

import CryptoKit
import Foundation

public let xferMaxControlBytes = 4096
public let xferMaxSize = 1 << 40
public let xferDefaultChunk = 61_440
public let xferMaxChunk = 65_492
public let xferWindow = 16
public let xferAckEvery = 8
public let xferMaxTransfers = 4
public let xferConsentSeconds: Double = 120
public let xferIdleSeconds: Double = 60
public let xferPartialSeconds: Double = 86_400
public let xferMaxPartialsPerPeer = 8
public let xferEndedIds = 64
public let xferChunkHead = 24
public let xferCap = "xfer/1"

/// The six record types of `xfer/1`.
public enum XferType {
    public static let offer = 0x0020
    public static let accept = 0x0021
    public static let chunk = 0x0022
    public static let ack = 0x0023
    public static let done = 0x0024
    public static let cancel = 0x0025
}

public enum XferReason: String, Sendable, Equatable, CaseIterable {
    case declined, cancelled, hash, size, category, busy, quota, timeout
}

/// True for the six xfer record types.
public func isXferType(_ type: Int) -> Bool { type >= XferType.offer && type <= XferType.cancel }

// MARK: - Validators (whole-string; no regular expressions)

private func isHex64(_ s: String) -> Bool {
    let u = Array(s.utf8)
    return u.count == 64 && u.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
}

private func isCategory(_ s: String) -> Bool {
    let u = Array(s.utf8)
    return (1...32).contains(u.count)
        && u.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2d }
}

private func isMediaType(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard u.count <= 127 else { return false }
    let parts = u.split(separator: 0x2f, omittingEmptySubsequences: false)
    guard parts.count == 2 else { return false }
    let extra = Set("!#$&^_.+-".utf8)
    return parts.allSatisfy { p in
        guard let f = p.first, (f >= 0x61 && f <= 0x7a) || (f >= 0x30 && f <= 0x39) else { return false }
        return p.dropFirst().allSatisfy {
            ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || extra.contains($0)
        }
    }
}

/// A transfer id: 22 canonical base64url characters of 16 bytes.
public func isXferId(_ s: String) -> Bool {
    s.utf8.count == 22 && Base64URL.isCanonical(s) && Base64URL.decodeStrict(s)?.count == 16
}

// MARK: - Control bodies

private struct Control {
    let o: [String: JSONValue]
    let nonWire: NonWireIntegers
}

private func control(_ body: Data) -> Control? {
    guard body.count <= xferMaxControlBytes, let (o, nw) = PeerPayload.parseStrictObject(body) else { return nil }
    return Control(o: o, nonWire: nw)
}

/// An integer token in [min, max]: a number not written with a fraction or an exponent.
private func intOf(_ c: Control, _ name: String, _ lo: Int, _ hi: Int) -> Int? {
    guard case .int(let v)? = c.o[name], !c.nonWire.contains("/" + name) else { return nil }
    return v >= lo && v <= hi ? v : nil
}

private func idOf(_ c: Control?) -> String? {
    guard let c, case .string(let s)? = c.o["id"], isXferId(s) else { return nil }
    return s
}

private func reasonOf(_ r: String) -> XferReason { XferReason(rawValue: r) ?? .cancelled }

public struct XferOfferBody: Sendable, Equatable {
    public var id: String
    public var name: String?
    public var type: String?
    public var size: Int
    public var sha256: String
    public var cat: String?
    public var chunk: Int

    public init(
        id: String, name: String? = nil, type: String? = nil, size: Int, sha256: String, cat: String? = nil,
        chunk: Int
    ) {
        self.id = id
        self.name = name
        self.type = type
        self.size = size
        self.sha256 = sha256
        self.cat = cat
        self.chunk = chunk
    }
}

public enum XferCodec {
    /// An `OFFER` body; `maxMessage` is the reader's own HELLO value. nil is a `peer_bad_frame`.
    public static func parseOffer(_ body: Data, maxMessage: Int) -> XferOfferBody? {
        guard let c = control(body), let id = idOf(c) else { return nil }
        var out = XferOfferBody(id: id, size: 0, sha256: "", chunk: 0)
        if let n = c.o["name"] {
            guard case .string(let s) = n, s.utf8.count <= 255 else { return nil }
            out.name = s
        }
        if let t = c.o["type"] {
            guard case .string(let s) = t, isMediaType(s) else { return nil }
            out.type = s
        }
        guard let size = intOf(c, "size", 0, xferMaxSize) else { return nil }
        out.size = size
        guard case .string(let sha)? = c.o["sha256"], isHex64(sha) else { return nil }
        out.sha256 = sha
        if let k = c.o["cat"] {
            guard case .string(let s) = k, isCategory(s) else { return nil }
            out.cat = s
        }
        guard let chunk = intOf(c, "chunk", 1, xferMaxChunk), chunk + xferChunkHead <= maxMessage else { return nil }
        out.chunk = chunk
        return out
    }

    private static func quoted(_ s: String) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        return String(decoding: (try? enc.encode(s)) ?? Data(), as: UTF8.self)
    }

    /// The sender's `OFFER` body, members in the order of the table.
    public static func offerBody(_ o: XferOfferBody) -> Data {
        var s = #"{"id":\#(quoted(o.id))"#
        if let n = o.name { s += #","name":\#(quoted(n))"# }
        if let t = o.type { s += #","type":\#(quoted(t))"# }
        s += #","size":\#(o.size),"sha256":\#(quoted(o.sha256))"#
        if let k = o.cat { s += #","cat":\#(quoted(k))"# }
        s += #","chunk":\#(o.chunk)}"#
        return Data(s.utf8)
    }

    public static func offsetBody(id: String, offset: Int) -> Data {
        Data(#"{"id":\#(quoted(id)),"offset":\#(offset)}"#.utf8)
    }

    public static func doneBody(id: String, sha256: String? = nil) -> Data {
        Data((sha256.map { #"{"id":\#(quoted(id)),"sha256":\#(quoted($0))}"# } ?? #"{"id":\#(quoted(id))}"#).utf8)
    }

    public static func cancelBody(id: String, reason: XferReason) -> Data {
        Data(#"{"id":\#(quoted(id)),"reason":\#(quoted(reason.rawValue))}"#.utf8)
    }

    /// A `CHUNK` body: `id(16) ‖ u64be offset ‖ data`.
    public static func chunkBody(id: String, offset: Int, data: Data) -> Data {
        var b = Data(capacity: xferChunkHead + data.count)
        b.append(Base64URL.decodeStrict(id) ?? Data(count: 16))
        var be = UInt64(offset).bigEndian
        withUnsafeBytes(of: &be) { b.append(contentsOf: $0) }
        b.append(data)
        return b
    }

    /// An offset for `ACCEPT` (a multiple of chunk) or `ACK` (also `size` itself).
    private static func offsetOk(_ v: Int, size: Int, chunk: Int, ack: Bool) -> Bool {
        v >= 0 && v <= size && (v % chunk == 0 || (ack && v == size))
    }

    /// An `ACCEPT` or `ACK` body judged against its `OFFER`. nil is a fault.
    public static func parseOffset(ack: Bool, _ body: Data, size: Int, chunk: Int) -> (id: String, offset: Int)? {
        let c = control(body)
        guard let c, let id = idOf(c), let off = intOf(c, "offset", 0, xferMaxSize),
            offsetOk(off, size: size, chunk: chunk, ack: ack)
        else { return nil }
        return (id, off)
    }

    /// A `DONE` body: `{id, sha256}` toward the receiver, `{id}` toward the sender.
    public static func parseDone(_ body: Data, towardSender: Bool) -> (id: String, sha256: String?)? {
        let c = control(body)
        guard let c, let id = idOf(c) else { return nil }
        if towardSender { return c.o["sha256"] == nil ? (id, nil) : nil }
        guard case .string(let sha)? = c.o["sha256"], isHex64(sha) else { return nil }
        return (id, sha)
    }

    /// A `CANCEL` body. A string outside the eight reasons reads as `cancelled`.
    public static func parseCancel(_ body: Data) -> (id: String, reason: XferReason)? {
        let c = control(body)
        guard let c, let id = idOf(c), case .string(let r)? = c.o["reason"] else { return nil }
        return (id, reasonOf(r))
    }

    /// A `CHUNK` body judged against its offer and the next offset the receiver expects.
    public static func parseChunk(_ body: Data, size: Int, chunk: Int, expect: Int) -> (
        id: String, offset: Int, length: Int
    )? {
        guard body.count >= xferChunkHead else { return nil }
        let b = [UInt8](body)
        let id = Base64URL.encode(Data(b[0..<16]))
        var at: UInt64 = 0
        for i in 16..<24 { at = at << 8 | UInt64(b[i]) }
        let length = b.count - xferChunkHead
        guard length > 0, length <= chunk, at == UInt64(expect), expect + length <= size else { return nil }
        guard length == chunk || expect + length == size else { return nil }
        return (id, expect, length)
    }
}

/// The partial file's name (§15.11 "The name is display data"): derived from the resume key only.
public func xferPartialPath(key: Data, id: String, sha256: String) -> String {
    var h = SHA256()
    h.update(data: Data("pkey-xfer/1 partial".utf8))
    h.update(data: Data([0]))
    h.update(data: key)
    h.update(data: Base64URL.decodeStrict(id) ?? Data())
    let u = Array(sha256.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    h.update(data: Data(stride(from: 0, to: u.count - 1, by: 2).map { nib(u[$0]) << 4 | nib(u[$0 + 1]) }))
    return h.finalize().map { String(format: "%02x", $0) }.joined()
}

/// Lowercase hex of a digest.
public func xferHex(_ h: SHA256) -> String { h.finalize().map { String(format: "%02x", $0) }.joined() }

// MARK: - The machine's types

/// A kept partial file of the peer key (§15.11 "Resume").
public struct XferPartial: Sendable, Equatable {
    public var ref: String
    public var id: String
    public var sha256: String
    public var size: Int
    public var chunk: Int
    /// Bytes on disk.
    public var bytes: Int
    /// Seconds (the machine's clock) of the last write.
    public var writtenAt: Double
    /// A live transfer in another session holds it.
    public var held: Bool
    /// Bytes re-read and hashed since the session began; nil means `bytes`.
    public var reread: Int?

    public init(
        ref: String, id: String, sha256: String, size: Int, chunk: Int, bytes: Int, writtenAt: Double,
        held: Bool = false, reread: Int? = nil
    ) {
        self.ref = ref
        self.id = id
        self.sha256 = sha256
        self.size = size
        self.chunk = chunk
        self.bytes = bytes
        self.writtenAt = writtenAt
        self.held = held
        self.reread = reread
    }
}

/// What the host is asked about an `OFFER`. `name` is already cleaned display data.
public struct XferAsk: Sendable, Equatable {
    public var id: String
    public var name: String?
    public var type: String?
    public var size: Int
    public var cat: String?
}

public enum XferAnswer: Sendable, Equatable { case accept, decline, ask }

public enum XferSend: Sendable, Equatable {
    case offer(XferOfferBody)
    case accept(id: String, offset: Int)
    /// The consecutive `CHUNK` records one step sends: `chunk` bytes each, the last the remainder.
    case chunks(id: String, offset: Int, bytes: Int)
    case ack(id: String, offset: Int)
    case done(id: String, sha256: String?)
    case cancel(id: String, reason: XferReason)
}

/// An effect on the kept partial files, or bytes for one; the driver applies them in order.
public enum XferPartialEffect: Sendable, Equatable {
    case create(String)
    case truncate(String, to: Int)
    case discard(String)
    case evict(String)
    case keep(String)
    case delete(String)
    case finalize(String)
    case write(String, offset: Int, data: Data)
}

public enum XferResult: Sendable, Equatable {
    case delivered(id: String)
    case cancelled(id: String, reason: XferReason)
    case closed(id: String)

    public var id: String {
        switch self {
        case .delivered(let i), .cancelled(let i, _), .closed(let i): return i
        }
    }
}

public struct XferOut: Sendable, Equatable {
    public var send: [XferSend] = []
    public var close: PeerCloseCode?
    public var ask: XferAsk?
    public var withdraw: [String] = []
    public var results: [XferResult] = []
    public var partial: [XferPartialEffect] = []
    /// The host's own send was refused locally: too many live transfers.
    public var refusedBusy = false
    /// A late record for an ended id, dropped without effect.
    public var drop = false
}

public struct XferMachineOptions: Sendable {
    /// The session's mode: transfers run in `a` and `c` only.
    public var mode: PeerNoiseMode
    /// The session's capabilities (the intersection of both payloads).
    public var caps: [String]
    /// This side's own `HELLO` `maxMessage`.
    public var maxMessage: Int
    public var hostLimit: Int?
    /// Bytes the store can still take; nil for unlimited.
    public var free: (@Sendable () -> Int?)?
    /// No handler: every `OFFER` is declined.
    public var handler: (@Sendable (XferAsk) -> XferAnswer)?
    /// The link's categories (mode c).
    public var categories: [String]
    /// The remote static key: 32 raw bytes.
    public var peerKey: Data
    public var partials: [XferPartial]
    /// A hasher fed with the first `offset` bytes of a kept partial the store re-read. Without it, or when it
    /// answers nil (the file is gone or shorter than it was), a resume starts at 0.
    public var rehash: (@Sendable (String, Int) -> SHA256?)?
    /// A name for a new partial file; default `xferPartialPath`.
    public var newRef: (@Sendable (String, String) -> String)?
    /// The window is judged from the last `ACK` actually sent.
    public var withholdAcks: Bool

    public init(
        mode: PeerNoiseMode, caps: [String], maxMessage: Int, hostLimit: Int? = nil,
        free: (@Sendable () -> Int?)? = nil, handler: (@Sendable (XferAsk) -> XferAnswer)?, categories: [String] = [],
        peerKey: Data, partials: [XferPartial] = [], rehash: (@Sendable (String, Int) -> SHA256?)? = nil,
        newRef: (@Sendable (String, String) -> String)? = nil, withholdAcks: Bool = false
    ) {
        self.mode = mode
        self.caps = caps
        self.maxMessage = maxMessage
        self.hostLimit = hostLimit
        self.free = free
        self.handler = handler
        self.categories = categories
        self.peerKey = peerKey
        self.partials = partials
        self.rehash = rehash
        self.newRef = newRef
        self.withholdAcks = withholdAcks
    }
}

public struct XferOfferArgs: Sendable {
    public var id: String
    public var size: Int
    public var chunk: Int
    public var sha256: String
    public var cat: String?
    public var name: String?
    public var type: String?
    /// False when the source cannot restart at an `ACCEPT` offset above 0.
    public var seekable: Bool

    public init(
        id: String, size: Int, chunk: Int, sha256: String, cat: String? = nil, name: String? = nil,
        type: String? = nil, seekable: Bool = true
    ) {
        self.id = id
        self.size = size
        self.chunk = chunk
        self.sha256 = sha256
        self.cat = cat
        self.name = name
        self.type = type
        self.seekable = seekable
    }
}

// MARK: - The machine

public struct XferMachine {
    private enum Dir { case incoming, outgoing }
    private enum St { case asking, offered, active, doneSent }

    private struct Tr {
        let id: String
        let dir: Dir
        var st: St = .asking
        let size: Int
        let chunk: Int
        let sha: String
        var since: Double
        var recv = 0
        var sinceAck = 0
        var ackedEnd = 0
        var hash: SHA256?
        var partial: String?
        var accepted = false
        var sentEnd = 0
        var ackEnd = 0
        var seekable = true
        var full = false
    }

    private struct Ended {
        let id: String
        let dir: Dir
        /// Lets a late `DONE` count as delivery.
        var cancelledHere: Bool
    }

    private var tr: [String: Tr] = [:]
    private var order: [String] = []
    private var ended: [Ended] = []
    private var closed = false
    private var parts: [XferPartial]
    private var clock: Double = 0
    private var out = XferOut()
    private let o: XferMachineOptions

    public init(_ options: XferMachineOptions) {
        precondition(options.peerKey.count == 32, "peerKey")
        o = options
        parts = options.partials
    }

    /// The kept partials now.
    public var partials: [XferPartial] { parts }

    /// The number of live transfers.
    public var live: Int { tr.count }

    /// The clock value at which the next wait runs out, or nil when none is running.
    public func nextDeadline() -> Double? {
        var best: Double?
        for t in tr.values {
            guard let lim = limit(t) else { continue }
            let at = t.since + lim
            if best == nil || at < best! { best = at }
        }
        return best
    }

    // MARK: Events

    public mutating func tick(_ at: Double) -> XferOut { begin(at) { _ in } }

    /// A record the session read: one of the six xfer types, with `more` its flag.
    public mutating func receive(_ at: Double, type: Int, body: Data, more: Bool = false) -> XferOut {
        begin(at) { $0.onRecord(type, body, more) }
    }

    /// The host sends: `OFFER`. Throws `XferMachineError.offer` for arguments the wire cannot carry or an id
    /// used before.
    public mutating func offer(_ at: Double, _ a: XferOfferArgs) throws -> XferOut {
        guard isXferId(a.id), a.size >= 0, a.size <= xferMaxSize, a.chunk >= 1, a.chunk <= xferMaxChunk,
            isHex64(a.sha256)
        else { throw XferMachineError.offer }
        if tr[a.id] != nil || ended.contains(where: { $0.id == a.id }) { throw XferMachineError.idUsed }
        return begin(at) { m in
            if m.tr.count >= xferMaxTransfers {
                m.out.refusedBusy = true
                return
            }
            var t = m.newTr(a.id, .outgoing, a.size, a.chunk, a.sha256)
            t.st = .offered
            t.seekable = a.seekable
            m.put(t)
            m.out.send.append(
                .offer(
                    XferOfferBody(
                        id: a.id, name: a.name, type: a.type, size: a.size, sha256: a.sha256, cat: a.cat,
                        chunk: a.chunk)))
        }
    }

    /// The host's answer to an `ask`.
    public mutating func consent(_ at: Double, id: String, accept: Bool) -> XferOut {
        begin(at) { m in
            guard var t = m.tr[id], t.st == .asking else { return }
            if !accept {
                m.out.send.append(.cancel(id: id, reason: .declined))
                m.end(t, cancelledHere: true)
                return
            }
            m.accept(&t)
            m.tr[id] = t
        }
    }

    /// The host cancels a transfer.
    public mutating func cancel(_ at: Double, id: String) -> XferOut {
        begin(at) { m in
            guard let t = m.tr[id] else { return }
            // After its DONE a sender sends no CANCEL other than timeout.
            if t.dir == .outgoing && t.st == .doneSent { return }
            m.out.send.append(.cancel(id: id, reason: .cancelled))
            if t.st == .asking {
                m.out.withdraw.append(id)
            } else if t.dir == .incoming, let p = t.partial {
                m.eff(.delete(p))
            }
            m.result(t, .cancelled(id: id, reason: .cancelled))
            m.end(t, cancelledHere: true)
        }
    }

    /// The host's source failed before the transfer's `DONE` went out: cancel an outgoing transfer in any state.
    public mutating func fail(_ at: Double, id: String) -> XferOut {
        begin(at) { m in
            guard let t = m.tr[id], t.dir == .outgoing else { return }
            m.out.send.append(.cancel(id: id, reason: .cancelled))
            m.result(t, .cancelled(id: id, reason: .cancelled))
            m.end(t, cancelledHere: true)
        }
    }

    /// The session ended. Does nothing when a fault already ended it; see `abandon`.
    public mutating func close(_ at: Double) -> XferOut {
        if closed { return XferOut() }
        return begin(at) { $0.shutdown() }
    }

    /// The session closed (for any reason): report every live transfer `closed` and keep the partials.
    /// Idempotent, and it also answers after a fault the machine itself raised.
    public mutating func abandon(_ at: Double) -> XferOut {
        out = XferOut()
        clock = at
        shutdown()
        closed = true
        return out
    }

    /// A new session on the same machine keeps the partials, none held and none re-read.
    public mutating func newSession(_ at: Double) -> XferOut {
        out = XferOut()
        clock = at
        tr = [:]
        order = []
        ended = []
        closed = false
        parts = parts.map {
            var p = $0
            p.reread = nil
            p.held = false
            return p
        }
        return out
    }

    // MARK: Internals

    private mutating func begin(_ at: Double, _ fn: (inout XferMachine) -> Void) -> XferOut {
        out = XferOut()
        if closed { return out }
        clock = at
        expire(at)
        fn(&self)
        return out
    }

    private mutating func put(_ t: Tr) {
        if tr[t.id] == nil { order.append(t.id) }
        tr[t.id] = t
    }

    private mutating func shutdown() {
        for id in order {
            guard let t = tr[id] else { continue }
            if t.st == .asking {
                out.withdraw.append(t.id)
            } else if t.dir == .incoming, let p = t.partial {
                out.partial.append(.keep(p))
            }
            result(t, .closed(id: t.id))
        }
        tr = [:]
        order = []
        closed = true
    }

    private mutating func eff(_ e: XferPartialEffect) {
        out.partial.append(e)
        switch e {
        case .delete(let r), .finalize(let r): parts.removeAll { $0.ref == r }
        default: break
        }
    }

    private mutating func fault() {
        out.close = .peerBadFrame
        closed = true
    }

    /// A transfer the host was never told about (still asking) reports no result.
    private mutating func result(_ t: Tr, _ r: XferResult) {
        if t.st == .asking { return }
        out.results.append(r)
    }

    private mutating func remember(_ id: String, _ dir: Dir, cancelledHere: Bool) {
        ended.append(Ended(id: id, dir: dir, cancelledHere: cancelledHere))
        while ended.count > xferEndedIds { ended.removeFirst() }
    }

    private mutating func end(_ t: Tr, cancelledHere: Bool) {
        tr[t.id] = nil
        order.removeAll { $0 == t.id }
        remember(t.id, t.dir, cancelledHere: cancelledHere)
    }

    private func newTr(_ id: String, _ dir: Dir, _ size: Int, _ chunk: Int, _ sha: String) -> Tr {
        Tr(id: id, dir: dir, size: size, chunk: chunk, sha: sha, since: clock)
    }

    // MARK: The clock

    /// Seconds this transfer may wait in its current state; nil while nothing is awaited.
    private func limit(_ t: Tr) -> Double? {
        if t.dir == .incoming { return t.st == .asking ? xferConsentSeconds : xferIdleSeconds }
        if t.st == .offered { return xferConsentSeconds + xferIdleSeconds }
        if t.st == .doneSent { return xferIdleSeconds }
        return t.full ? xferIdleSeconds : nil
    }

    /// Every wait that ran out by `at` ends with `CANCEL timeout`; the partial is kept.
    private mutating func expire(_ at: Double) {
        for id in order {
            guard let t = tr[id], let lim = limit(t), at - t.since >= lim else { continue }
            out.send.append(.cancel(id: t.id, reason: .timeout))
            if t.st == .asking {
                out.withdraw.append(t.id)
            } else if t.dir == .incoming, let p = t.partial {
                out.partial.append(.keep(p))
            }
            result(t, .cancelled(id: t.id, reason: .timeout))
            end(t, cancelledHere: true)
        }
    }

    // MARK: Records

    private mutating func onRecord(_ type: Int, _ body: Data, _ more: Bool) {
        // Step 1: the mode and the capability.
        if (o.mode != .a && o.mode != .c) || !o.caps.contains(xferCap) {
            out.close = .peerNotAllowed
            closed = true
            return
        }
        if more || !isXferType(type) { return fault() }
        if type == XferType.offer { return onOffer(body) }
        if type == XferType.chunk { return onChunk(body) }
        let c = control(body)
        guard let c, let id = idOf(c) else { return fault() }
        // The generic member checks, before the id is looked up.
        var offset = 0
        var sha: String?
        var reason = XferReason.cancelled
        if type == XferType.accept || type == XferType.ack {
            guard let v = intOf(c, "offset", 0, xferMaxSize) else { return fault() }
            offset = v
        } else if type == XferType.done {
            if let s = c.o["sha256"] {
                guard case .string(let str) = s, isHex64(str) else { return fault() }
                sha = str
            }
        } else {
            guard case .string(let r)? = c.o["reason"] else { return fault() }
            reason = reasonOf(r)
        }
        guard var t = tr[id] else { return late(id, type, sha) }
        if type == XferType.accept {
            onAccept(&t, offset)
        } else if type == XferType.ack {
            onAck(&t, offset)
        } else if type == XferType.done {
            onDone(&t, sha)
        } else {
            onCancel(t, reason)
        }
    }

    /// A record for an id that is not live: dropped when remembered, else a fault.
    private mutating func late(_ id: String, _ type: Int, _ sha: String?) {
        guard let i = ended.firstIndex(where: { $0.id == id }) else { return fault() }
        if type == XferType.done, ended[i].dir == .outgoing, ended[i].cancelledHere, sha == nil {
            out.results.append(.delivered(id: id))
            ended[i].cancelledHere = false
            return
        }
        out.drop = true
    }

    private func resumable(size: Int, chunk: Int, _ p: XferPartial?) -> Bool {
        guard let p else { return false }
        return p.size == size && p.chunk == chunk && clock - p.writtenAt <= xferPartialSeconds
    }

    private mutating func onOffer(_ body: Data) {
        guard let f = XferCodec.parseOffer(body, maxMessage: o.maxMessage) else { return fault() }
        if tr[f.id] != nil || ended.contains(where: { $0.id == f.id }) { return fault() }
        let t = newTr(f.id, .incoming, f.size, f.chunk, f.sha256)
        func refuse(_ m: inout XferMachine, _ reason: XferReason) {
            m.out.send.append(.cancel(id: f.id, reason: reason))
            m.remember(f.id, .incoming, cancelledHere: true)
        }
        // Step 4: busy.
        let kept = parts.first { $0.id == f.id && $0.sha256 == f.sha256 }
        // A new partial needs a place: with the peer's eight all held by live transfers, none can be evicted.
        let noRoom =
            kept == nil && parts.count >= xferMaxPartialsPerPeer && f.size > 0 && parts.allSatisfy { $0.held }
        if tr.count >= xferMaxTransfers || tr.values.contains(where: { $0.st == .asking }) || kept?.held == true
            || noRoom
        {
            return refuse(&self, .busy)
        }
        // Step 5: the category, before the person is asked.
        if o.mode == .c, f.cat == nil || !o.categories.contains(f.cat!) { return refuse(&self, .category) }
        // Step 6: size and quota; a resume counts only the bytes still to come.
        if let limit = o.hostLimit, f.size > limit { return refuse(&self, .size) }
        if let free = o.free?() {
            let need = f.size - (resumable(size: f.size, chunk: f.chunk, kept) ? kept!.bytes : 0)
            if need > free { return refuse(&self, .quota) }
        }
        // Step 7: consent.
        var ask = XferAsk(id: f.id, name: nil, type: f.type, size: f.size, cat: f.cat)
        if let n = f.name { ask.name = cleanDisplayName(n) }
        let answer = o.handler?(ask) ?? .decline
        if answer == .decline { return refuse(&self, .declined) }
        put(t)
        if answer == .ask {
            out.ask = ask
            return
        }
        var t2 = t
        accept(&t2)
        tr[t2.id] = t2
    }

    /// Step 8: the resume lookup, then `ACCEPT`.
    private mutating func accept(_ t: inout Tr) {
        let m = parts.first { $0.id == t.id && $0.sha256 == t.sha }
        var offset = 0
        var hash = SHA256()
        var resume = false
        var want = 0
        if let m, resumable(size: t.size, chunk: t.chunk, m) {
            let read = min(m.reread ?? m.bytes, m.bytes)
            want = min(read / t.chunk * t.chunk, t.size)
            if let rehash = o.rehash, want > 0 {
                // A partial that cannot be re-read (gone, short, held elsewhere) is not resumed: start afresh.
                if let h = rehash(m.ref, want) {
                    offset = want
                    hash = h
                    resume = true
                }
            } else {
                resume = true
            }
        }
        if let m, resume {
            t.partial = m.ref
            eff(.truncate(m.ref, to: offset))
            if let i = parts.firstIndex(where: { $0.ref == m.ref }) {
                parts[i].bytes = offset
                parts[i].writtenAt = clock
                parts[i].reread = nil
            }
        } else {
            if let m {
                eff(.discard(m.ref))
                parts.removeAll { $0.ref == m.ref }
            }
            if t.size > 0 {
                if parts.count >= xferMaxPartialsPerPeer {
                    // The oldest that no live transfer holds: a partial another session is writing stays.
                    let free = parts.filter { !$0.held }
                    if var oldest = free.first {
                        for p in free where p.writtenAt < oldest.writtenAt { oldest = p }
                        eff(.evict(oldest.ref))
                        parts.removeAll { $0.ref == oldest.ref }
                    }
                }
                let ref = o.newRef?(t.id, t.sha) ?? xferPartialPath(key: o.peerKey, id: t.id, sha256: t.sha)
                eff(.create(ref))
                parts.append(
                    XferPartial(
                        ref: ref, id: t.id, sha256: t.sha, size: t.size, chunk: t.chunk, bytes: 0, writtenAt: clock))
                t.partial = ref
            }
        }
        t.hash = hash
        t.recv = offset
        t.ackedEnd = offset
        t.st = .active
        t.accepted = true
        t.since = clock
        out.send.append(.accept(id: t.id, offset: offset))
    }

    private mutating func onAccept(_ t: inout Tr, _ offset: Int) {
        if t.dir != .outgoing || t.accepted || t.st != .offered { return fault() }
        guard offset >= 0, offset <= t.size, offset % t.chunk == 0 else { return fault() }
        t.accepted = true
        if offset > 0 && !t.seekable {
            out.send.append(.cancel(id: t.id, reason: .cancelled))
            result(t, .cancelled(id: t.id, reason: .cancelled))
            end(t, cancelledHere: true)
            return
        }
        t.st = .active
        t.sentEnd = offset
        t.ackEnd = offset
        t.since = clock
        pump(&t, first: true)
        tr[t.id] = t
    }

    /// The sender sends what the window allows, then `DONE` once the last byte is out.
    private mutating func pump(_ t: inout Tr, first: Bool) {
        let from = t.sentEnd
        let room = xferWindow * t.chunk - (t.sentEnd - t.ackEnd)
        let upTo = min(t.size, t.sentEnd + max(0, room))
        var end = t.sentEnd
        while end < upTo { end = min(t.size, end + t.chunk) }
        if end > from {
            out.send.append(.chunks(id: t.id, offset: from, bytes: end - from))
            t.sentEnd = end
        }
        if t.sentEnd == t.size {
            out.send.append(.done(id: t.id, sha256: t.sha))
            t.st = .doneSent
            t.full = false
            t.since = clock
            return
        }
        // The idle wait for an `ACK` starts when the window fills, and again on progress.
        let full = t.sentEnd - t.ackEnd >= xferWindow * t.chunk
        if full && (!t.full || end > from || first) { t.since = clock }
        t.full = full
    }

    private mutating func onAck(_ t: inout Tr, _ offset: Int) {
        if t.dir != .outgoing || !t.accepted { return fault() }
        guard offset >= t.ackEnd, offset <= t.sentEnd, offset <= t.size,
            offset % t.chunk == 0 || offset == t.size
        else { return fault() }
        t.ackEnd = offset
        if t.st == .active { pump(&t, first: false) }
        tr[t.id] = t
    }

    private mutating func onChunk(_ body: Data) {
        if body.count < xferChunkHead { return fault() }
        let id = Base64URL.encode(body.prefix(16))
        guard var t = tr[id] else { return late(id, XferType.chunk, nil) }
        if t.dir != .incoming || t.st != .active { return fault() }
        guard let v = XferCodec.parseChunk(body, size: t.size, chunk: t.chunk, expect: t.recv) else { return fault() }
        // The window: more than `xferWindow` chunks past the last `ACK` this side sent.
        if v.offset + v.length - t.ackedEnd > xferWindow * t.chunk { return fault() }
        let data = Data(body.suffix(from: body.startIndex + xferChunkHead))
        let end = v.offset + v.length
        t.hash?.update(data: data)
        let offset = t.recv
        t.recv = end
        t.sinceAck += 1
        t.since = clock
        if let ref = t.partial, let i = parts.firstIndex(where: { $0.ref == ref }) {
            parts[i].bytes = end
            parts[i].writtenAt = clock
            out.partial.append(.write(ref, offset: offset, data: data))
        }
        if t.sinceAck >= xferAckEvery || end == t.size {
            t.sinceAck = 0
            if !o.withholdAcks {
                out.send.append(.ack(id: t.id, offset: end))
                t.ackedEnd = end
            }
        }
        tr[t.id] = t
    }

    private mutating func onDone(_ t: inout Tr, _ sha: String?) {
        if t.dir == .outgoing {
            // A `DONE` toward the sender carries no hash, and only follows its own `DONE`.
            if sha != nil || t.st != .doneSent { return fault() }
            result(t, .delivered(id: t.id))
            end(t, cancelledHere: false)
            return
        }
        guard let sha, t.st == .active else { return fault() }
        func cancel(_ m: inout XferMachine, _ reason: XferReason) {
            m.out.send.append(.cancel(id: t.id, reason: reason))
            if let p = t.partial { m.eff(.delete(p)) }
            m.result(t, .cancelled(id: t.id, reason: reason))
            m.end(t, cancelledHere: true)
        }
        if t.recv < t.size { return cancel(&self, .size) }
        if sha != t.sha || xferHex(t.hash ?? SHA256()) != t.sha { return cancel(&self, .hash) }
        out.send.append(.done(id: t.id, sha256: nil))
        if let p = t.partial { eff(.finalize(p)) }
        result(t, .delivered(id: t.id))
        end(t, cancelledHere: false)
    }

    private mutating func onCancel(_ t: Tr, _ reason: XferReason) {
        if t.st == .asking {
            out.withdraw.append(t.id)
        } else if t.dir == .incoming, let p = t.partial {
            eff(reason == .timeout ? .keep(p) : .delete(p))
        }
        result(t, .cancelled(id: t.id, reason: reason))
        end(t, cancelledHere: false)
    }
}

public enum XferMachineError: Error, Sendable, Equatable {
    /// The arguments are outside the wire's bounds.
    case offer
    /// The id was already used in this session.
    case idUsed
}
