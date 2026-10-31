// Direct Transfer for the app (CC-20.6; WIRE-CONTRACT-V5 §15.11): `client.cloudConnect.transfer`. Sends a file, a
// block of bytes or a stream to one of the person's devices or to a link, and answers the offers other devices
// make. Mirrors sdk-node's `connect/transfer.ts`.
//
//  - `send(_:source:options:)` opens a session to the peer (or takes one you pass), offers the content with its
//    hash, streams the chunks inside the window and returns when the receiver answered `DONE`. It throws
//    `TransferError`: `transfer-cancelled` with the wire `reason`, `peer-closed` when the session ended first (the
//    receiver keeps its partial file; send again with the same `id` to resume) or `link-unknown`;
//  - `onOffer(_:)` is the consent: every offer goes to the handler, which answers `.decline` or `.accept(to:)`.
//    Without a handler every offer is declined. The handler may take its time (up to 120 s). A mode-`c` offer is
//    judged against the link's categories before the handler hears of it;
//  - the received bytes live in a partial file inside the SDK's state directory until the hash matched, and move
//    to the destination the handler named (never over an existing file). The offered `name` is display data: it
//    is cleaned and shown, and never becomes part of a path;
//  - sign-out deletes every partial file; removing a link deletes the partial files of that link.
//
// Nothing here logs a name, a path or a byte of content.

import CryptoKit
import Foundation
import PolarisKeyCore

/// Where a transfer goes: one of the person's own devices, or a link made with `cloudConnect.links`.
public enum TransferPeer: Sendable, Equatable, ExpressibleByStringLiteral {
    case device(String)
    case link(String)

    public init(stringLiteral value: String) { self = .device(value) }
}

/// Who an offer comes from. `label` is authenticated for a device (`authenticated`); for a link it is the label
/// this device stored for the contact.
public struct TransferPeerInfo: Sendable, Equatable {
    public let label: String?
    public let deviceId: String?
    public let linkId: String?
    public let authenticated: Bool
}

/// An offer, as the host is asked about it. `name` and `type` are display data the sender chose.
public struct TransferOffer: Sendable, Equatable {
    public let id: String
    public let peer: TransferPeerInfo
    public let name: String?
    public let type: String?
    public let size: Int
    public let category: String?
}

public enum TransferDecision: Sendable, Equatable {
    case decline
    /// Accept, and deliver the content to this path (a file that does not exist yet, in a directory that does).
    case accept(to: URL)
}

public enum TransferSource: Sendable {
    case file(URL)
    case data(Data)
    /// A stream is spooled to the state directory and hashed first, because the offer carries the hash.
    case stream(AsyncThrowingStream<Data, Error>)
}

public struct TransferSendOptions: Sendable {
    public var name: String?
    public var type: String?
    public var category: String?
    public var chunk: Int?
    /// A transfer id (22 base64url characters of 16 bytes). Repeat the id of an interrupted transfer, with the same
    /// content, to resume it.
    public var id: String?
    public var relay: Bool

    public init(
        name: String? = nil, type: String? = nil, category: String? = nil, chunk: Int? = nil, id: String? = nil,
        relay: Bool = true
    ) {
        self.name = name
        self.type = type
        self.category = category
        self.chunk = chunk
        self.id = id
        self.relay = relay
    }
}

public struct TransferSent: Sendable, Equatable {
    public let id: String
    public let size: Int
    public let sha256: String
}

public struct TransferError: Error, Sendable, Equatable, CustomStringConvertible {
    /// `transfer-cancelled`, `peer-closed`, `link-unknown`, `unsupported` or `invalid-options`.
    public let code: String
    /// For `transfer-cancelled`: `declined`, `cancelled`, `hash`, `size`, `category`, `busy`, `quota` or `timeout`.
    public let reason: String?
    /// The transfer's id, when it got as far as having one: the handle to resume with.
    public let id: String?
    public let message: String

    public var description: String { "TransferError(\(code)\(reason.map { ", " + $0 } ?? ""))" }
}

/// What became of a transfer this device received.
public enum TransferReceipt: Sendable, Equatable {
    case delivered(id: String, to: URL)
    case failed(id: String, error: TransferError)
}

/// Answers an offer. A throw closes that session (`peer_bye`) and nothing else.
public typealias TransferOfferHandler = @Sendable (TransferOffer) async throws -> TransferDecision

// MARK: - The source

final class TransferReader: @unchecked Sendable {
    let size: Int
    let sha256: String
    private let lock = NSLock()
    private let data: Data?
    private let handle: FileHandle?
    private let cleanup: URL?

    init(size: Int, sha256: String, data: Data?, handle: FileHandle?, cleanup: URL?) {
        self.size = size
        self.sha256 = sha256
        self.data = data
        self.handle = handle
        self.cleanup = cleanup
    }

    func read(_ offset: Int, _ length: Int) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        if let data {
            guard offset >= 0, offset + length <= data.count else { throw XferStoreError(.io) }
            return data.subdata(in: (data.startIndex + offset)..<(data.startIndex + offset + length))
        }
        guard let handle else { throw XferStoreError(.io) }
        try handle.seek(toOffset: UInt64(offset))
        var out = Data()
        while out.count < length {
            guard let d = try handle.read(upToCount: length - out.count), !d.isEmpty else { break }
            out.append(d)
        }
        return out
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        try? handle?.close()
        if let cleanup { try? FileManager.default.removeItem(at: cleanup) }
    }

    private static func fail(_ message: String) -> TransferError {
        TransferError(code: ErrorCode.invalidOptions, reason: nil, id: nil, message: message)
    }

    static func make(_ source: TransferSource, store: XferStore) async throws -> TransferReader {
        switch source {
        case .data(let d):
            guard d.count <= xferMaxSize else { throw fail("The content is larger than a transfer may be.") }
            return TransferReader(size: d.count, sha256: hex(SHA256.hash(data: d)), data: d, handle: nil, cleanup: nil)
        case .file(let url):
            return try hashFile(url, cleanup: nil)
        case .stream(let stream):
            let spool = try store.newSpool()
            do {
                let h = try FileHandle(forWritingTo: spool)
                var hasher = SHA256()
                var total = 0
                for try await piece in stream {
                    total += piece.count
                    guard total <= xferMaxSize else { throw fail("The stream is larger than a transfer may be.") }
                    hasher.update(data: piece)
                    try h.write(contentsOf: piece)
                }
                try h.close()
                let r = try FileHandle(forReadingFrom: spool)
                return TransferReader(size: total, sha256: hex(hasher.finalize()), data: nil, handle: r, cleanup: spool)
            } catch {
                try? FileManager.default.removeItem(at: spool)
                throw error
            }
        }
    }

    private static func hex<D: Sequence>(_ d: D) -> String where D.Element == UInt8 {
        d.map { String(format: "%02x", $0) }.joined()
    }

    private static func hashFile(_ url: URL, cleanup: URL?) throws -> TransferReader {
        guard url.isFileURL,
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
            attrs[.type] as? FileAttributeType == .typeRegular,
            let size = (attrs[.size] as? NSNumber)?.intValue, size <= xferMaxSize,
            let h = try? FileHandle(forReadingFrom: url)
        else { throw fail("The source is not a readable file.") }
        var hasher = SHA256()
        var left = size
        while left > 0 {
            guard let d = try h.read(upToCount: min(left, 1 << 20)), !d.isEmpty else { break }
            hasher.update(data: d)
            left -= d.count
        }
        guard left == 0 else {
            try? h.close()
            throw fail("The file changed while it was read.")
        }
        return TransferReader(size: size, sha256: hex(hasher.finalize()), data: nil, handle: h, cleanup: cleanup)
    }
}

// MARK: - One session's endpoint

final class TransferWaiter: @unchecked Sendable {
    private let lock = NSLock()
    private var outcome: Result<Void, TransferError>?
    private var cont: CheckedContinuation<Void, Error>?

    func resolve(_ r: Result<Void, TransferError>) {
        let c: CheckedContinuation<Void, Error>? = lock.withLock {
            if outcome != nil { return nil }
            outcome = r
            let c = cont
            cont = nil
            return c
        }
        if let c { c.resume(with: r.mapError { $0 as Error }) }
    }

    func wait() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            let done: Result<Void, TransferError>? = lock.withLock {
                if let o = outcome { return o }
                cont = c
                return nil
            }
            if let done { c.resume(with: done.mapError { $0 as Error }) }
        }
    }
}

final class TransferAdopted: @unchecked Sendable {
    let session: ConnectSession
    var endpoint: XferEndpoint!
    private let lock = NSLock()
    private var dest: [String: URL] = [:]
    private var asks: [String: Task<Void, Never>] = [:]
    private var senders: [String: (reader: TransferReader, waiter: TransferWaiter)] = [:]
    private var delivered: Set<String> = []

    init(session: ConnectSession) { self.session = session }

    func setDest(_ id: String, _ u: URL?) { lock.withLock { dest[id] = u } }
    func dest(_ id: String) -> URL? { lock.withLock { dest[id] } }
    func takeDest(_ id: String) -> URL? { lock.withLock { dest.removeValue(forKey: id) } }
    func setAsk(_ id: String, _ t: Task<Void, Never>) { lock.withLock { asks[id] = t } }
    func takeAsk(_ id: String) -> Task<Void, Never>? { lock.withLock { asks.removeValue(forKey: id) } }
    func setSender(_ id: String, _ r: TransferReader, _ w: TransferWaiter) { lock.withLock { senders[id] = (r, w) } }
    func sender(_ id: String) -> (reader: TransferReader, waiter: TransferWaiter)? { lock.withLock { senders[id] } }
    func takeSender(_ id: String) -> (reader: TransferReader, waiter: TransferWaiter)? {
        lock.withLock { senders.removeValue(forKey: id) }
    }
    func markDelivered(_ id: String) { lock.withLock { _ = delivered.insert(id) } }
    func wasDelivered(_ id: String) -> Bool { lock.withLock { delivered.contains(id) } }
    func allSenders() -> [(reader: TransferReader, waiter: TransferWaiter)] { lock.withLock { Array(senders.values) } }
    func allAsks() -> [Task<Void, Never>] { lock.withLock { Array(asks.values) } }
}

// MARK: - The service

public final class CloudTransfer: Sendable {
    private struct State {
        var handler: TransferOfferHandler?
        var receipts: [(Int, @Sendable (TransferReceipt) -> Void)] = []
        var next = 0
        var adopted: [ObjectIdentifier: Task<TransferAdopted?, Never>] = [:]
        var maxSize: Int?
        var openDevice: (@Sendable (String, Bool) async throws -> ConnectSession)?
        var openLink: (@Sendable (String, Bool) async throws -> ConnectSession)?
        var hasLink: (@Sendable (String) async -> Bool)?
    }

    private let state = LockedValue(State())
    private let store: XferStore
    private let mono: @Sendable () -> Double
    private let sleep: (@Sendable (Double) async -> Void)?
    private let queue = DispatchQueue(label: "im.plrs.key.transfer.callbacks")

    /// `directory` holds the partial files. `mono` is a monotonic clock in seconds.
    public convenience init(directory: URL) { self.init(directory: directory, mono: nil, free: nil, sleep: nil) }

    init(
        directory: URL, mono: (@Sendable () -> Double)?, free: (@Sendable () -> Int?)?,
        sleep: (@Sendable (Double) async -> Void)?, quota: Int? = XferStore.defaultQuotaBytes,
        diskReserve: Int = XferStore.defaultDiskReserveBytes
    ) {
        store = XferStore(directory: directory, free: free, quota: quota, diskReserve: diskReserve)
        self.mono = mono ?? { ProcessInfo.processInfo.systemUptime }
        self.sleep = sleep
    }

    // MARK: The host's calls

    /// Called for each offer another device or link makes, with the question the person answers. One handler:
    /// a second call replaces the first. Returns the unsubscribe. With no handler every offer is declined.
    @discardableResult
    public func onOffer(_ handler: @escaping TransferOfferHandler) -> @Sendable () -> Void {
        state.with { $0.handler = handler }
        return { [state] in state.with { $0.handler = nil } }
    }

    /// Called when a transfer this device received is delivered or ends without the content. Returns the
    /// unsubscribe.
    @discardableResult
    public func onReceived(_ fn: @escaping @Sendable (TransferReceipt) -> Void) -> @Sendable () -> Void {
        let id = state.with { s -> Int in
            s.next += 1
            s.receipts.append((s.next, fn))
            return s.next
        }
        return { [state] in state.with { $0.receipts.removeAll { $0.0 == id } } }
    }

    /// The largest content this device accepts; larger offers are refused with `size`. nil for no limit beyond the
    /// protocol's 2^40 bytes.
    public func setMaxSize(_ bytes: Int?) { state.with { $0.maxSize = bytes } }

    /// Cancel the transfer with this id, whichever side of it this device is (a no-op for an unknown id). The other
    /// side hears `cancelled`; a partial file this device was receiving into is deleted.
    public func cancel(_ id: String) async {
        let tasks = state.with { Array($0.adopted.values) }
        for t in tasks { await t.value?.endpoint.cancel(id: id) }
    }

    /// Whether an offer handler is set.
    var listening: Bool { state.with { $0.handler != nil } }

    /// Send `source` to `peer`. Opens a session (LAN first, then the relay) and closes it when the transfer is over.
    /// Returns when the receiver has verified the hash and answered; throws `TransferError` otherwise.
    public func send(
        _ peer: TransferPeer, source: TransferSource, options: TransferSendOptions = TransferSendOptions()
    ) async throws -> TransferSent {
        let (dev, lnk, has) = state.with { ($0.openDevice, $0.openLink, $0.hasLink) }
        let session: ConnectSession
        do {
            switch peer {
            case .device(let id):
                guard let dev else { throw Self.error(ErrorCode.invalidOptions, "Cloud Connect is not set up.") }
                session = try await dev(id, options.relay)
            case .link(let id):
                guard let lnk, let has else {
                    throw Self.error(ErrorCode.invalidOptions, "Cloud Connect is not set up.")
                }
                guard await has(id) else {
                    throw Self.error(ErrorCode.linkUnknown, "That is not a link on this device.")
                }
                session = try await lnk(id, options.relay)
            }
        }
        do {
            let sent = try await send(over: session, source: source, options: options)
            await session.close()
            return sent
        } catch {
            if (error as? TransferError)?.code != ErrorCode.peerClosed { await session.close() }
            throw error
        }
    }

    /// Send over a session you already hold (one from `open`, `onChannel` or `links.open`).
    public func send(
        over session: ConnectSession, source: TransferSource, options: TransferSendOptions = TransferSendOptions()
    ) async throws -> TransferSent {
        guard session.caps.contains(xferCap) else {
            throw Self.error(ErrorCode.unsupported, "The other device does not offer Direct Transfer.")
        }
        if let id = options.id, !isXferId(id) {
            throw Self.error(ErrorCode.invalidOptions, "The transfer id is not 22 base64url characters of 16 bytes.")
        }
        if let t = options.type, !Self.wellFormedType(t) {
            throw Self.error(ErrorCode.invalidOptions, "The media type is malformed.")
        }
        if let c = options.category, !Self.wellFormedCategory(c) {
            throw Self.error(ErrorCode.invalidOptions, "The category is malformed.")
        }
        guard let a = await adopt(session) else {
            throw Self.error(ErrorCode.unsupported, "This session cannot carry a transfer.")
        }
        let reader = try await TransferReader.make(source, store: store)
        defer { reader.close() }
        let id = options.id ?? Base64URL.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255) }))
        let peerMax = session.hello.maxMessage
        let chunk = min(options.chunk ?? xferDefaultChunk, xferMaxChunk, peerMax - xferChunkHead)
        guard chunk >= 1 else { throw Self.error(ErrorCode.invalidOptions, "The other device accepts no chunks.") }
        let waiter = TransferWaiter()
        a.setSender(id, reader, waiter)
        defer { _ = a.takeSender(id) }
        let name = options.name.flatMap { cleanDisplayName($0) }.map(Self.cutName)
        do {
            try a.endpoint.offer(
                XferOfferArgs(
                    id: id, size: reader.size, chunk: chunk, sha256: reader.sha256, cat: options.category, name: name,
                    type: options.type))
        } catch {
            throw Self.error(ErrorCode.invalidOptions, "That transfer id was already used on this session.", id: id)
        }
        let endpoint = a.endpoint!
        try await withTaskCancellationHandler {
            try await waiter.wait()
        } onCancel: {
            endpoint.cancel(id: id)
        }
        return TransferSent(id: id, size: reader.size, sha256: reader.sha256)
    }

    // MARK: Wiring (CloudConnect)

    func bind(
        openDevice: @escaping @Sendable (String, Bool) async throws -> ConnectSession,
        openLink: @escaping @Sendable (String, Bool) async throws -> ConnectSession,
        hasLink: @escaping @Sendable (String) async -> Bool
    ) {
        state.with {
            $0.openDevice = openDevice
            $0.openLink = openLink
            $0.hasLink = hasLink
        }
    }

    /// Delete every partial file (sign-out, forget).
    func purgeAll() { store.purgeAll() }

    /// Delete the partial files of the link whose `agreeKey` this is (43 base64url characters).
    func purge(agreeKey: String) {
        if let k = Base64URL.decodeStrict(agreeKey), k.count == 32 { store.purge(key: k) }
    }

    /// Take a session in: its transfer records go to an endpoint of this service. Idempotent; a session without
    /// the capability is left alone.
    @discardableResult
    func adopt(_ session: ConnectSession) async -> TransferAdopted? {
        guard session.caps.contains(xferCap), let key = session.remoteStatic, key.count == 32 else { return nil }
        let oid = ObjectIdentifier(session)
        let task: Task<TransferAdopted?, Never> = state.with { s in
            if let t = s.adopted[oid] { return t }
            let t = Task { await self.build(session, key) }
            s.adopted[oid] = t
            return t
        }
        return await task.value
    }

    // MARK: Internals

    private static func error(_ code: String, _ message: String, reason: String? = nil, id: String? = nil)
        -> TransferError
    {
        TransferError(code: code, reason: reason, id: id, message: message)
    }

    private static func cutName(_ s: String) -> String {
        var out = ""
        var n = 0
        for ch in s.unicodeScalars {
            let w = String(ch).utf8.count
            if n + w > 255 { break }
            out.unicodeScalars.append(ch)
            n += w
        }
        return out
    }

    private static func wellFormedCategory(_ s: String) -> Bool {
        let u = Array(s.utf8)
        return (1...32).contains(u.count)
            && u.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2d }
    }

    private static func wellFormedType(_ s: String) -> Bool {
        XferCodec.parseOffer(
            XferCodec.offerBody(
                XferOfferBody(
                    id: "AAAAAAAAAAAAAAAAAAAAAA", type: s, size: 0,
                    sha256: String(repeating: "0", count: 64), chunk: 1)),
            maxMessage: 1 << 20) != nil
    }

    private func notify(_ r: TransferReceipt) {
        let fns = state.with { $0.receipts.map(\.1) }
        for f in fns { queue.async { f(r) } }
    }

    private func build(_ session: ConnectSession, _ key: Data) async -> TransferAdopted? {
        let a = TransferAdopted(session: session)
        let store = self.store
        let mono = self.mono
        let state = self.state
        // Effects queued before a purge carry this and are refused after it.
        let epoch = store.epoch
        let contact = session.contact
        let peerInfo = TransferPeerInfo(
            label: contact != nil ? contact?.label : session.hello.label,
            deviceId: contact == nil ? session.peerDeviceId : nil, linkId: contact?.id, authenticated: contact == nil)
        let options = XferMachineOptions(
            mode: contact != nil ? .c : .a, caps: session.caps, maxMessage: peerMaxMessageBytes,
            hostLimit: state.with { $0.maxSize }, free: { store.free },
            handler: { _ in state.with { $0.handler != nil } ? .ask : .decline },
            categories: contact?.categories ?? [], peerKey: key,
            partials: store.partials(key: key, mono: mono()),
            rehash: { ref, offset in store.rehash(ref: ref, offset: offset) })
        let ports = XferEndpointPorts(
            send: { [weak a] type, body in
                guard let a else { throw XferStoreError(.io) }
                try await a.session.sendXfer(type: type, body: body)
            },
            close: { [weak a] code in a?.session.closeSoon(code) },
            read: { [weak a] id, offset, length in
                guard let r = a?.sender(id)?.reader else { throw XferStoreError(.io) }
                return try r.read(offset, length)
            },
            apply: { [weak a] op in try Self.apply(op, store: store, key: key, epoch: epoch, adopted: a) },
            account: { op in Self.account(op, store: store) })
        let events = XferEvents(
            ask: { [weak self, weak a] ask in
                guard let self, let a else { return }
                self.ask(a, ask, peerInfo)
            },
            withdraw: { [weak a] id in
                a?.takeAsk(id)?.cancel()
                _ = a?.takeDest(id)
            },
            result: { [weak self, weak a] r in
                guard let self, let a else { return }
                self.result(a, r)
            },
            refused: { [weak a] id in
                a?.sender(id)?.waiter.resolve(
                    .failure(
                        Self.error(
                            ErrorCode.transferCancelled, "Too many transfers are running.", reason: "busy", id: id)))
            },
            error: { _ in })
        a.endpoint = XferEndpoint(options: options, ports: ports, events: events, now: mono, sleep: sleep)
        do {
            try await session.attachXfer { [weak a] type, body in a?.endpoint.receive(type: type, body: body) }
        } catch {
            return nil
        }
        session.onClose { [weak a, weak self] _ in
            guard let a else { return }
            a.endpoint.closed()
            for t in a.allAsks() { t.cancel() }
            self?.forget(session)
        }
        return a
    }

    private func forget(_ session: ConnectSession) {
        let oid = ObjectIdentifier(session)
        state.with { $0.adopted[oid] = nil }
    }

    /// Called as the machine decides, before the file work: reserve what an accepted transfer will take, release
    /// it when the transfer ends.
    private static func account(_ op: XferOp, store: XferStore) {
        switch op.effect {
        case .create(let ref):
            if let m = op.meta { store.reserve(ref, declared: m.size, written: 0) }
        case .truncate(let ref, let to):
            if let m = op.meta { store.reserve(ref, declared: m.size, written: to) }
        case .keep(let ref), .discard(let ref), .delete(let ref), .finalize(let ref):
            store.release(ref)
        case .write, .evict:
            break
        }
    }

    private static func apply(
        _ op: XferOp, store: XferStore, key: Data, epoch: Int, adopted: TransferAdopted?
    ) throws {
        switch op.effect {
        case .create:
            guard let meta = op.meta else { throw XferStoreError(.io) }
            try store.create(meta, peer: key, epoch: epoch)
        case .truncate(let ref, let to):
            try store.truncate(ref, to: to, meta: op.meta, peer: key, epoch: epoch)
        case .write(let ref, let offset, let data):
            try store.write(ref, offset: offset, data: data, epoch: epoch)
        case .keep(let ref):
            store.keep(ref)
        case .evict(let ref):
            // A partial a live transfer holds is never another peer's to remove.
            if !store.isHeld(ref) { store.remove(ref) }
        case .discard(let ref), .delete(let ref):
            store.remove(ref)
        case .finalize(let ref):
            guard let id = op.id, let to = adopted?.dest(id) else { throw XferStoreError(.io) }
            try store.deliver(ref, to: to, epoch: epoch)
            adopted?.markDelivered(id)
        }
    }

    private func ask(_ a: TransferAdopted, _ ask: XferAsk, _ peer: TransferPeerInfo) {
        let handler = state.with { $0.handler }
        let offer = TransferOffer(
            id: ask.id, peer: peer, name: ask.name, type: ask.type, size: ask.size, category: ask.cat)
        let t = Task { [weak a] in
            let decision: TransferDecision
            do {
                decision = try await handler?(offer) ?? .decline
            } catch {
                // A handler that throws ends this session, and nothing else.
                if !Task.isCancelled { a?.session.closeSoon(.peerBye) }
                return
            }
            guard let a, !Task.isCancelled else { return }
            _ = a.takeAsk(ask.id)
            switch decision {
            case .decline:
                a.endpoint.consent(id: ask.id, accept: false)
            case .accept(let to):
                // The destination must be a path in a directory that exists, with nothing there yet.
                let parent = to.deletingLastPathComponent()
                var isDir: ObjCBool = false
                let ok =
                    to.isFileURL && FileManager.default.fileExists(atPath: parent.path, isDirectory: &isDir)
                    && isDir.boolValue && !FileManager.default.fileExists(atPath: to.path)
                if ok { a.setDest(ask.id, to) }
                a.endpoint.consent(id: ask.id, accept: ok)
            }
        }
        a.setAsk(ask.id, t)
    }

    private func result(_ a: TransferAdopted, _ r: XferResult) {
        let id = r.id
        if let s = a.sender(id) {
            switch r {
            case .delivered: s.waiter.resolve(.success(()))
            case .cancelled(_, let reason):
                s.waiter.resolve(
                    .failure(
                        Self.error(
                            ErrorCode.transferCancelled, "The transfer ended without the content delivered.",
                            reason: reason.rawValue, id: id)))
            case .closed:
                s.waiter.resolve(
                    .failure(
                        Self.error(ErrorCode.peerClosed, "The session ended before the transfer finished.", id: id)))
            }
            return
        }
        guard let to = a.takeDest(id) else { return }
        switch r {
        case .delivered:
            if !a.wasDelivered(id) {
                // A transfer of no bytes has no partial file: the destination is created empty.
                do { try store.deliverEmpty(to: to) } catch {
                    notify(
                        .failed(
                            id: id,
                            error: Self.error(
                                ErrorCode.transferCancelled, "The file could not be written.", reason: "cancelled",
                                id: id)))
                    return
                }
            }
            notify(.delivered(id: id, to: to))
        case .cancelled(_, let reason):
            notify(
                .failed(
                    id: id,
                    error: Self.error(
                        ErrorCode.transferCancelled, "The transfer ended without the content delivered.",
                        reason: reason.rawValue, id: id)))
        case .closed:
            notify(
                .failed(
                    id: id,
                    error: Self.error(ErrorCode.peerClosed, "The session ended before the transfer finished.", id: id)))
        }
    }
}
