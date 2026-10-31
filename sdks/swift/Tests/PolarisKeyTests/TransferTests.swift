// @pkey-feature connect.transfer
// CC-20.6: Direct Transfer end to end (WIRE-CONTRACT-V5 §15.11) between two in-process sessions: offer, accept,
// deliver; decline; consent timeout; cancel from either side; resume after a dropped session; a hash that does
// not match; names that look like paths stay display data; the partial store's layout and purge. The pipes are
// in memory; no socket is opened.

import CryptoKit
import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey

private let sub = "ps_AAAAAAAAAAAAAAAAAAAAAA"
private let idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
private let idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
private let signer = TestSigner(kid: "peer-test-2026")
private func nowSeconds() -> Int { Int(Date().timeIntervalSince1970) }
private func rnd() -> Data { Curve25519.KeyAgreement.PrivateKey().rawRepresentation }

private func content(_ n: Int) -> Data { xferContent(0, n) }

// MARK: In-memory pipes, with a gate on the writes

private final class TPipe: PeerBytePipe, @unchecked Sendable {
    private let incoming: AsyncStream<Data>
    private let incomingCont: AsyncStream<Data>.Continuation
    private let outgoing: AsyncStream<Data>.Continuation
    private let iterator = LockedValue<AsyncStream<Data>.Iterator?>(nil)
    private struct Gate {
        var after: Int?
        var writes = 0
        var waiting: [CheckedContinuation<Void, Never>] = []
    }
    private let gate = LockedValue(Gate())
    let remoteAddress = "10.0.0.2"
    let bytes = LockedValue(0)

    init(
        incoming: AsyncStream<Data>, incomingCont: AsyncStream<Data>.Continuation,
        outgoing: AsyncStream<Data>.Continuation
    ) {
        self.incoming = incoming
        self.incomingCont = incomingCont
        self.outgoing = outgoing
        iterator.set(incoming.makeAsyncIterator())
    }

    static func pair() -> (TPipe, TPipe) {
        let (s1, c1) = AsyncStream<Data>.makeStream()
        let (s2, c2) = AsyncStream<Data>.makeStream()
        return (
            TPipe(incoming: s1, incomingCont: c1, outgoing: c2), TPipe(incoming: s2, incomingCont: c2, outgoing: c1)
        )
    }

    /// Hold every write after the next `n` until `release()`.
    func stall(after n: Int) { gate.with { $0.after = $0.writes + n } }

    var stalled: Bool { gate.with { g in g.after.map { g.writes >= $0 } ?? false } }

    func release() {
        let w = gate.with { g -> [CheckedContinuation<Void, Never>] in
            g.after = nil
            let x = g.waiting
            g.waiting = []
            return x
        }
        for c in w { c.resume() }
    }

    func read() async throws -> Data? {
        var it = iterator.with { i -> AsyncStream<Data>.Iterator? in
            let r = i
            i = nil
            return r
        }
        guard it != nil else { return nil }
        let d = await it!.next()
        iterator.set(it)
        return d
    }

    func write(_ b: Data) async throws {
        let hold = gate.with { g -> Bool in
            if let a = g.after, g.writes >= a { return true }
            g.writes += 1
            return false
        }
        if hold { await withCheckedContinuation { c in gate.with { $0.waiting.append(c) } } }
        bytes.with { $0 += b.count }
        outgoing.yield(b)
    }

    func close() async {
        release()
        outgoing.finish()
        incomingCont.finish()
    }
}

private struct Dev {
    let id: String
    let priv = Curve25519.KeyAgreement.PrivateKey()
    let signKey: String

    init(_ id: String, signByte: UInt8) {
        self.id = id
        signKey = Base64URL.encode(Data(repeating: signByte, count: 32))
    }

    var cert: String {
        let agree = Base64URL.encode(priv.publicKey.rawRepresentation)
        return signer.sign(
            payloadJSON:
                #"{"iss":"key.plrs.im","aud":"djdl","sub":"\#(sub)","deviceId":"\#(id)","signKey":"\#(signKey)","agreeKey":"\#(agree)","ringEpoch":1,"issuedAt":\#(nowSeconds() - 10),"expiresAt":\#(nowSeconds() + 1000)}"#,
            typ: "pkey-peer+jws")
    }
}

private func options(_ role: PeerChannel.Role, _ d: Dev, _ keys: [Data?], caps: [String]) -> PeerChannelOptions {
    PeerChannelOptions(
        role: role, slug: "djdl", staticKey: try! PeerNoiseRawStaticKey(privateKey: d.priv.rawRepresentation),
        account: PeerAccountContext(
            trust: signer.trust, expectedAud: "djdl", certJws: d.cert, ownSub: sub, ownDeviceId: d.id,
            heldRing: { nil }, discKeys: keys),
        caps: caps, hello: ("Laptop", "test", "djdl", nil))
}

private struct Pair {
    let a: ConnectSession
    let b: ConnectSession
    let pa: TPipe
    let pb: TPipe
}

private let devA = Dev(idA, signByte: 1)
private let devB = Dev(idB, signByte: 2)

private func openPair(capsA: [String] = ["app/1", xferCap], capsB: [String] = ["app/1", xferCap]) async throws -> Pair {
    let (pa, pb) = TPipe.pair()
    let k = rnd()
    let ha = ConnectSessionHandlers(role: "initiator")
    let hb = ConnectSessionHandlers(role: "responder")
    let la = try await PeerLink.make(
        pipe: pa, options: options(.initiator, devA, [k], caps: capsA), handlers: ha.handlers)
    let lb = try await PeerLink.make(
        pipe: pb, options: options(.responder, devB, [k], caps: capsB), handlers: hb.handlers)
    ha.attach(la)
    hb.attach(lb)
    Task { await la.run() }
    Task { await lb.run() }
    await la.start()
    async let sa = ha.opened(la)
    async let sb = hb.opened(lb)
    return try await Pair(a: sa, b: sb, pa: pa, pb: pb)
}

private func tempDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("pkey-xfer-test-" + UUID().uuidString)
    try! FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

private func eventually(_ what: String = "", _ cond: @escaping () -> Bool) async {
    for _ in 0..<500 where !cond() { try? await Task.sleep(nanoseconds: 10_000_000) }
    XCTAssertTrue(cond(), what)
}

/// A clock and a sleep the test moves.
private final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t: Double = 1000
    private var sleepers: [CheckedContinuation<Void, Never>] = []
    var now: Double { lock.withLock { t } }
    func sleep(_ s: Double) async {
        await withCheckedContinuation { c in lock.withLock { sleepers.append(c) } }
    }
    func advance(_ s: Double) {
        let w = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            t += s
            let x = sleepers
            sleepers = []
            return x
        }
        for c in w { c.resume() }
    }
}

private struct Side {
    let transfer: CloudTransfer
    let dir: URL
    let session: ConnectSession
    var store: URL { dir.appendingPathComponent("xfer") }
}

private func side(
    _ s: ConnectSession, dir: URL? = nil, clock: FakeClock? = nil, maxSize: Int? = nil, quota: Int? = nil
) async -> Side {
    let d = dir ?? tempDir()
    var mono: (@Sendable () -> Double)?
    var sleeper: (@Sendable (Double) async -> Void)?
    if let clock {
        mono = { clock.now }
        sleeper = { await clock.sleep($0) }
    }
    let t =
        quota == nil
        ? CloudTransfer(directory: d.appendingPathComponent("xfer"), mono: mono, free: nil, sleep: sleeper)
        : CloudTransfer(
            directory: d.appendingPathComponent("xfer"), mono: mono, free: { 1 << 40 }, sleep: sleeper, quota: quota,
            diskReserve: 0)
    t.setMaxSize(maxSize)
    _ = await t.adopt(s)
    return Side(transfer: t, dir: d, session: s)
}

private func xferFiles(_ dir: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted()
}

/// 64 lowercase hex characters, optionally followed by `.json`: the only names the store makes.
private func isStoreName(_ n: String) -> Bool {
    let base = n.hasSuffix(".json") ? String(n.dropLast(5)) : n
    let u = Array(base.utf8)
    return u.count == 64 && u.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
}

extension XferStore {
    /// Claim and create, as an accepted transfer does.
    fileprivate func make(_ meta: XferPartial, _ t: Token) throws {
        reserve(meta.ref, declared: meta.size, written: 0, token: t)
        try create(meta, token: t)
    }
}

final class TransferTests: XCTestCase {
    private func accept(_ t: CloudTransfer, to url: URL, seen: LockedValue<[TransferOffer]>? = nil) {
        t.onOffer { o in
            seen?.with { $0.append(o) }
            return .accept(to: url)
        }
    }

    // MARK: Delivery

    func testOfferAcceptDeliver() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b)
        let out = b.dir.appendingPathComponent("received.bin")
        let seen = LockedValue<[TransferOffer]>([])
        accept(b.transfer, to: out, seen: seen)
        let receipts = LockedValue<[TransferReceipt]>([])
        b.transfer.onReceived { r in receipts.with { $0.append(r) } }
        let data = content(200_000)
        let sent = try await a.transfer.send(
            over: p.a, source: .data(data),
            options: TransferSendOptions(name: "report.pdf", type: "application/pdf", category: "docs"))
        XCTAssertEqual(sent.size, 200_000)
        XCTAssertEqual(try Data(contentsOf: out), data)
        XCTAssertEqual(seen.current.count, 1)
        XCTAssertEqual(seen.current[0].name, "report.pdf")
        XCTAssertEqual(seen.current[0].type, "application/pdf")
        XCTAssertEqual(seen.current[0].category, "docs")
        XCTAssertEqual(seen.current[0].size, 200_000)
        XCTAssertEqual(seen.current[0].peer.label, "Laptop")
        XCTAssertTrue(seen.current[0].peer.authenticated)
        await eventually("receipt") { !receipts.current.isEmpty }
        XCTAssertEqual(receipts.current, [.delivered(id: sent.id, to: out)])
        // The partial file is gone once the content is delivered.
        XCTAssertEqual(xferFiles(b.store).filter(isStoreName), [])
    }

    func testFileAndStreamSources() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b)
        let src = a.dir.appendingPathComponent("in.bin")
        try content(130_000).write(to: src)
        let out1 = b.dir.appendingPathComponent("one.bin")
        accept(b.transfer, to: out1)
        _ = try await a.transfer.send(over: p.a, source: .file(src))
        XCTAssertEqual(try Data(contentsOf: out1), content(130_000))
        let out2 = b.dir.appendingPathComponent("two.bin")
        accept(b.transfer, to: out2)
        let stream = AsyncThrowingStream<Data, Error> { c in
            c.yield(content(70_000).prefix(30_000))
            c.yield(xferContent(30_000, 70_000))
            c.finish()
        }
        _ = try await a.transfer.send(over: p.a, source: .stream(stream))
        XCTAssertEqual(try Data(contentsOf: out2), content(70_000))
    }

    func testEmptyTransfer() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b)
        let out = b.dir.appendingPathComponent("empty.bin")
        accept(b.transfer, to: out)
        _ = try await a.transfer.send(over: p.a, source: .data(Data()))
        XCTAssertEqual(try Data(contentsOf: out), Data())
    }

    // MARK: Refusals

    func testNoHandlerDeclines() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        _ = await side(p.b)
        do {
            _ = try await a.transfer.send(over: p.a, source: .data(content(10)))
            XCTFail("sent")
        } catch let e as TransferError {
            XCTAssertEqual(e.code, "transfer-cancelled")
            XCTAssertEqual(e.reason, "declined")
        }
    }

    func testHandlerDeclinesAndABadDestinationDeclines() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b)
        b.transfer.onOffer { _ in .decline }
        do {
            _ = try await a.transfer.send(over: p.a, source: .data(content(10)))
            XCTFail("sent")
        } catch let e as TransferError { XCTAssertEqual(e.reason, "declined") }
        // A destination in a directory that does not exist is a refusal, not a write somewhere else.
        accept(b.transfer, to: b.dir.appendingPathComponent("missing/dir/x"))
        do {
            _ = try await a.transfer.send(over: p.a, source: .data(content(10)))
            XCTFail("sent")
        } catch let e as TransferError { XCTAssertEqual(e.reason, "declined") }
        // So is one that exists.
        let there = b.dir.appendingPathComponent("there")
        try Data("x".utf8).write(to: there)
        accept(b.transfer, to: there)
        do {
            _ = try await a.transfer.send(over: p.a, source: .data(content(10)))
            XCTFail("sent")
        } catch let e as TransferError { XCTAssertEqual(e.reason, "declined") }
        XCTAssertEqual(try Data(contentsOf: there), Data("x".utf8))
    }

    func testSizeLimitRefuses() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b, maxSize: 100)
        accept(b.transfer, to: b.dir.appendingPathComponent("big"))
        do {
            _ = try await a.transfer.send(over: p.a, source: .data(content(1000)))
            XCTFail("sent")
        } catch let e as TransferError { XCTAssertEqual(e.reason, "size") }
    }

    func testPeerWithoutTheCapabilityIsUnsupported() async throws {
        let p = try await openPair(capsB: ["app/1"])
        let a = await side(p.a)
        do {
            _ = try await a.transfer.send(over: p.a, source: .data(content(10)))
            XCTFail("sent")
        } catch let e as TransferError { XCTAssertEqual(e.code, "unsupported") }
        // The generic send path refuses the transfer types.
        do {
            try await p.a.sendRecord(type: XferType.offer, body: Data("{}".utf8))
            XCTFail("sent")
        } catch {}
    }

    func testConsentTimeout() async throws {
        let clock = FakeClock()
        let p = try await openPair()
        let a = await side(p.a, clock: clock)
        let b = await side(p.b, clock: clock)
        let asked = LockedValue(false)
        b.transfer.onOffer { _ in
            asked.set(true)
            // Never answers; the receiver's 120 s runs out.
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            return .decline
        }
        let task = Task { try await a.transfer.send(over: p.a, source: .data(content(10))) }
        await eventually("asked") { asked.current }
        // Both sides wait; the receiver's consent clock is the shorter.
        for _ in 0..<5 {
            clock.advance(121)
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        do {
            _ = try await task.value
            XCTFail("sent")
        } catch let e as TransferError {
            XCTAssertEqual(e.code, "transfer-cancelled")
            XCTAssertEqual(e.reason, "timeout")
        }
    }

    // MARK: Cancel

    func testSenderCancelsDuringConsent() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b)
        let asked = LockedValue(false)
        let withdrawn = LockedValue(false)
        b.transfer.onOffer { _ in
            asked.set(true)
            do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { withdrawn.set(true) }
            return .decline
        }
        let task = Task { try await a.transfer.send(over: p.a, source: .data(content(10))) }
        await eventually("asked") { asked.current }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("sent")
        } catch let e as TransferError { XCTAssertEqual(e.reason, "cancelled") }
        await eventually("question withdrawn") { withdrawn.current }
    }

    func testReceiverCancelsMidTransfer() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b)
        let out = b.dir.appendingPathComponent("never.bin")
        let ids = LockedValue<[String]>([])
        b.transfer.onOffer { o in
            ids.with { $0.append(o.id) }
            return .accept(to: out)
        }
        let receipts = LockedValue<[TransferReceipt]>([])
        b.transfer.onReceived { r in receipts.with { $0.append(r) } }
        // Hold the sender's writes after the offer and a few chunks.
        p.pa.stall(after: 6)
        let task = Task { try await a.transfer.send(over: p.a, source: .data(content(1_000_000))) }
        await eventually("stalled") { p.pa.stalled }
        await eventually("asked") { !ids.current.isEmpty }
        // The partial file is named by the derived path only.
        let names = xferFiles(b.store)
        XCTAssertFalse(names.isEmpty)
        XCTAssertTrue(names.allSatisfy(isStoreName), "\(names)")
        await b.transfer.cancel(ids.current[0])
        do {
            // Releasing the gate lets the sender's queued records reach a receiver that has cancelled.
            p.pa.release()
            _ = try await task.value
            XCTFail("sent")
        } catch let e as TransferError {
            XCTAssertEqual(e.code, "transfer-cancelled")
            XCTAssertEqual(e.reason, "cancelled")
        }
        await eventually("receipt") { !receipts.current.isEmpty }
        guard case .failed(_, let err)? = receipts.current.first else { return XCTFail("receipt") }
        XCTAssertEqual(err.reason, "cancelled")
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path))
        await eventually("partial deleted") { xferFiles(b.store).isEmpty }
    }

    func testSenderCancelsMidTransfer() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b)
        let out = b.dir.appendingPathComponent("never.bin")
        accept(b.transfer, to: out)
        let receipts = LockedValue<[TransferReceipt]>([])
        b.transfer.onReceived { r in receipts.with { $0.append(r) } }
        p.pa.stall(after: 6)
        let task = Task { try await a.transfer.send(over: p.a, source: .data(content(1_000_000))) }
        await eventually("stalled") { p.pa.stalled }
        task.cancel()
        p.pa.release()
        do {
            _ = try await task.value
            XCTFail("sent")
        } catch let e as TransferError { XCTAssertEqual(e.reason, "cancelled") }
        await eventually("receiver told") { !receipts.current.isEmpty }
        guard case .failed(_, let err)? = receipts.current.first else { return XCTFail("receipt") }
        XCTAssertEqual(err.reason, "cancelled")
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path))
    }

    // MARK: Resume

    func testResumeAfterADroppedSession() async throws {
        let dirB = tempDir()
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b, dir: dirB)
        let out = dirB.appendingPathComponent("resumed.bin")
        accept(b.transfer, to: out)
        let size = 2_000_000
        let id = Base64URL.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255) }))
        p.pa.stall(after: 12)
        let first = Task {
            try await a.transfer.send(
                over: p.a, source: .data(content(size)), options: TransferSendOptions(chunk: 10_000, id: id))
        }
        await eventually("stalled") { p.pa.stalled }
        // Let the receiver finish what it has been sent, then drop the session.
        try? await Task.sleep(nanoseconds: 300_000_000)
        await p.b.close()
        do {
            _ = try await first.value
            XCTFail("sent")
        } catch let e as TransferError {
            XCTAssertEqual(e.code, "peer-closed")
            XCTAssertEqual(e.id, id)
        }
        let kept = xferFiles(b.store).filter { !$0.hasSuffix(".json") }
        XCTAssertEqual(kept.count, 1)
        XCTAssertTrue(isStoreName(kept[0]))
        // A new session between the same two devices; the receiver's store is the same directory.
        let p2 = try await openPair()
        let a2 = await side(p2.a)
        let b2 = await side(p2.b, dir: dirB)
        accept(b2.transfer, to: out)
        let sent = try await a2.transfer.send(
            over: p2.a, source: .data(content(size)), options: TransferSendOptions(chunk: 10_000, id: id))
        XCTAssertEqual(sent.id, id)
        XCTAssertEqual(try Data(contentsOf: out), content(size))
        // The second session sent less than the whole content: it resumed.
        XCTAssertLessThan(p2.pa.bytes.current, size)
    }

    // MARK: Hash

    func testHashMismatchDeliversNothing() async throws {
        // The sender's source returns other bytes than the ones the hash was made from.
        let key = Data(repeating: 7, count: 32)
        let dirB = tempDir().appendingPathComponent("xfer")
        let store = XferStore(directory: dirB)
        let tk = store.begin(peer: key)
        let id = Base64URL.encode(Data(repeating: 9, count: 16))
        let data = content(50_000)
        let sha = xferHex(
            {
                var h = SHA256()
                h.update(data: data)
                return h
            }())
        let results = LockedValue<[XferResult]>([])
        let aResults = LockedValue<[XferResult]>([])
        let epA = LockedValue<XferEndpoint?>(nil)
        let epB = LockedValue<XferEndpoint?>(nil)
        let events = { (r: LockedValue<[XferResult]>, ep: LockedValue<XferEndpoint?>) in
            XferEvents(
                ask: { a in ep.current?.consent(id: a.id, accept: true) }, withdraw: { _ in },
                result: { x in r.with { $0.append(x) } }, refused: { _ in }, error: { _ in })
        }
        let optsA = XferMachineOptions(
            mode: .a, caps: [xferCap], maxMessage: 1 << 20, handler: nil, peerKey: key)
        let optsB = XferMachineOptions(
            mode: .a, caps: [xferCap], maxMessage: 1 << 20, handler: { _ in .ask }, peerKey: key)
        epA.set(
            XferEndpoint(
                options: optsA,
                ports: XferEndpointPorts(
                    send: { t, b in epB.current?.receive(type: t, body: b) }, close: { _ in },
                    read: { _, off, len in
                        // A flipped byte in every chunk.
                        var d = xferContent(off, off + len)
                        d[0] ^= 0xff
                        return d
                    }, apply: { _ in }),
                events: events(aResults, epA)))
        epB.set(
            XferEndpoint(
                options: optsB,
                ports: XferEndpointPorts(
                    send: { t, b in epA.current?.receive(type: t, body: b) }, close: { _ in },
                    read: { _, _, _ in Data() },
                    apply: { op in
                        switch op.effect {
                        case .create:
                            try store.make(op.meta!, tk)
                        case .write(let ref, let off, let d): try store.write(ref, offset: off, data: d, token: tk)
                        case .delete(let ref): store.remove(ref, token: tk)
                        case .finalize: XCTFail("delivered a mismatch")
                        default: break
                        }
                    }),
                events: events(results, epB)))
        try epA.current!.offer(XferOfferArgs(id: id, size: 50_000, chunk: 10_000, sha256: sha))
        await eventually("both ended") { !results.current.isEmpty && !aResults.current.isEmpty }
        XCTAssertEqual(results.current, [.cancelled(id: id, reason: .hash)])
        XCTAssertEqual(aResults.current, [.cancelled(id: id, reason: .hash)])
        await epB.current!.idle()
        XCTAssertEqual(xferFiles(dirB), [])
    }

    // MARK: Names

    func testNamesThatLookLikePathsStayDisplayData() async throws {
        for name in ["../../etc/passwd", "..\\..\\Windows\\x.exe", "/abs/path", ".hidden", "a/b/../c"] {
            let p = try await openPair()
            let a = await side(p.a)
            let b = await side(p.b)
            let out = b.dir.appendingPathComponent("chosen-by-host.bin")
            let seen = LockedValue<[TransferOffer]>([])
            accept(b.transfer, to: out, seen: seen)
            p.pa.stall(after: 4)
            let task = Task {
                try await a.transfer.send(
                    over: p.a, source: .data(content(300_000)), options: TransferSendOptions(name: name, chunk: 10_000))
            }
            await eventually("stalled") { p.pa.stalled }
            try? await Task.sleep(nanoseconds: 100_000_000)
            // While the partial file exists, its name is the derived path and nothing else is in the directory.
            XCTAssertTrue(xferFiles(b.store).allSatisfy(isStoreName), "\(xferFiles(b.store))")
            XCTAssertEqual(seen.current.first?.name, name)
            p.pa.release()
            _ = try await task.value
            XCTAssertEqual(try Data(contentsOf: out), content(300_000))
            // Nothing was written next to the store or above it.
            XCTAssertEqual(Set(xferFiles(b.dir)), ["chosen-by-host.bin", "xfer"])
        }
    }

    // MARK: The store

    func testStoreLayoutPermissionsAndPurge() async throws {
        let dir = tempDir().appendingPathComponent("xfer")
        let store = XferStore(directory: dir)
        let key = Data(repeating: 3, count: 32)
        let other = Data(repeating: 4, count: 32)
        let sha = String(repeating: "ab", count: 32)
        let id = Base64URL.encode(Data(repeating: 1, count: 16))
        let ref = xferPartialPath(key: key, id: id, sha256: sha)
        let ref2 = xferPartialPath(key: other, id: id, sha256: sha)
        let tk = store.begin(peer: key)
        try store.make(XferPartial(ref: ref, id: id, sha256: sha, size: 10, chunk: 5, bytes: 0, writtenAt: 0), tk)
        try store.make(
            XferPartial(ref: ref2, id: id, sha256: sha, size: 10, chunk: 5, bytes: 0, writtenAt: 0),
            store.begin(peer: other))
        try store.write(ref, offset: 0, data: Data([1, 2, 3, 4, 5]), token: tk)
        XCTAssertEqual(xferFiles(dir).filter(isStoreName).count, 4)
        let mode = { (u: URL) in
            (try! FileManager.default.attributesOfItem(atPath: u.path)[.posixPermissions] as! NSNumber).intValue
        }
        XCTAssertEqual(mode(dir), 0o700)
        XCTAssertEqual(mode(dir.appendingPathComponent(ref)), 0o600)
        XCTAssertEqual(mode(dir.appendingPathComponent(ref + ".json")), 0o600)
        let parts = store.partials(key: key, mono: 100)
        XCTAssertEqual(parts.map(\.ref), [ref])
        XCTAssertEqual(parts[0].bytes, 5)
        // Removing one peer's partials leaves the other's.
        store.purge(key: key)
        XCTAssertEqual(store.partials(key: key, mono: 100).count, 0)
        XCTAssertEqual(store.partials(key: other, mono: 100).count, 1)
        store.purgeAll()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path))
    }

    func testAStoreRefusesANameThatIsNotDerived() throws {
        let store = XferStore(directory: tempDir().appendingPathComponent("xfer"))
        let bad = XferPartial(ref: "../escape", id: "x", sha256: "y", size: 1, chunk: 1, bytes: 0, writtenAt: 0)
        XCTAssertThrowsError(try store.make(bad, store.begin(peer: Data(count: 32))))
    }

    func testDeliveryNeverOverwrites() throws {
        let dir = tempDir().appendingPathComponent("xfer")
        let store = XferStore(directory: dir)
        let key = Data(repeating: 3, count: 32)
        let sha = String(repeating: "cd", count: 32)
        let id = Base64URL.encode(Data(repeating: 2, count: 16))
        let ref = xferPartialPath(key: key, id: id, sha256: sha)
        let tk = store.begin(peer: key)
        try store.make(XferPartial(ref: ref, id: id, sha256: sha, size: 3, chunk: 3, bytes: 0, writtenAt: 0), tk)
        try store.write(ref, offset: 0, data: Data([9, 9, 9]), token: tk)
        let dest = tempDir().appendingPathComponent("x")
        try Data("old".utf8).write(to: dest)
        XCTAssertThrowsError(try store.deliver(ref, to: dest, token: tk))
        XCTAssertEqual(try Data(contentsOf: dest), Data("old".utf8))
        try FileManager.default.removeItem(at: dest)
        try store.deliver(ref, to: dest, token: tk)
        XCTAssertEqual(try Data(contentsOf: dest), Data([9, 9, 9]))
    }

    func testSignOutPurgeDeletesPartials() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b)
        accept(b.transfer, to: b.dir.appendingPathComponent("x"))
        p.pa.stall(after: 4)
        let task = Task { try await a.transfer.send(over: p.a, source: .data(content(500_000))) }
        await eventually("stalled") { p.pa.stalled }
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(xferFiles(b.store).isEmpty)
        await p.b.close()
        p.pa.release()
        _ = try? await task.value
        b.transfer.purgeAll()
        XCTAssertFalse(FileManager.default.fileExists(atPath: b.store.path))
    }

    // MARK: Hardening

    /// A stalled first attempt that leaves one kept partial in `dirB`; the second session adopts before `damage`.
    private func resumeAfter(damage: (URL, [String]) throws -> Void) async throws {
        let dirB = tempDir()
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b, dir: dirB)
        let out = dirB.appendingPathComponent("resumed.bin")
        accept(b.transfer, to: out)
        let size = 1_000_000
        let id = Base64URL.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255) }))
        p.pa.stall(after: 12)
        let first = Task {
            try await a.transfer.send(
                over: p.a, source: .data(content(size)), options: TransferSendOptions(chunk: 10_000, id: id))
        }
        await eventually("stalled") { p.pa.stalled }
        try? await Task.sleep(nanoseconds: 300_000_000)
        await p.b.close()
        _ = try? await first.value
        let kept = xferFiles(b.store)
        XCTAssertEqual(kept.count, 2)
        let p2 = try await openPair()
        let a2 = await side(p2.a)
        // The second session reads the kept partial when it is adopted; then something else changes it.
        let b2 = await side(p2.b, dir: dirB)
        accept(b2.transfer, to: out)
        try damage(b.store, kept)
        let sent = try await a2.transfer.send(
            over: p2.a, source: .data(content(size)), options: TransferSendOptions(chunk: 10_000, id: id))
        XCTAssertEqual(sent.id, id)
        XCTAssertEqual(try Data(contentsOf: out), content(size))
        // It started over: the second session carried the whole content.
        XCTAssertGreaterThanOrEqual(p2.pa.bytes.current, size)
    }

    func testAResumeWhosePartialWasFinishedElsewhereStartsOver() async throws {
        try await resumeAfter { dir, names in
            for n in names { try FileManager.default.removeItem(at: dir.appendingPathComponent(n)) }
        }
    }

    func testAResumeWhosePartialIsShorterThanItWasStartsOver() async throws {
        try await resumeAfter { dir, names in
            let data = names.first { !$0.hasSuffix(".json") }!
            let h = try FileHandle(forWritingTo: dir.appendingPathComponent(data))
            try h.truncate(atOffset: 100)
            try h.close()
        }
    }

    func testAnOfferHandlerThatThrowsClosesOnlyThatSession() async throws {
        struct Boom: Error {}
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b)
        b.transfer.onOffer { _ in throw Boom() }
        do {
            _ = try await a.transfer.send(over: p.a, source: .data(content(10)))
            XCTFail("sent")
        } catch let e as TransferError { XCTAssertEqual(e.code, "peer-closed") }
        await eventually("closed") { p.b.closed != nil }
        // Another session of the same two devices still works.
        let p2 = try await openPair()
        let a2 = await side(p2.a)
        let b2 = await side(p2.b)
        let out = b2.dir.appendingPathComponent("ok.bin")
        accept(b2.transfer, to: out)
        _ = try await a2.transfer.send(over: p2.a, source: .data(content(10)))
        XCTAssertEqual(try Data(contentsOf: out), content(10))
    }

    func testConcurrentOffersCannotOvershootTheQuota() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b, quota: 150_000)
        accept(b.transfer, to: b.dir.appendingPathComponent("one.bin"))
        // Hold the receiver's ACKs so the first transfer stays live while the second is offered.
        p.pb.stall(after: 1)
        let first = Task {
            try await a.transfer.send(
                over: p.a, source: .data(content(100_000)), options: TransferSendOptions(chunk: 1000))
        }
        await eventually("stalled") { p.pb.stalled }
        try? await Task.sleep(nanoseconds: 200_000_000)
        let second = Task { try await a.transfer.send(over: p.a, source: .data(content(100_000))) }
        // The receiver judges the second offer while the first is live; its answer waits behind the held ACKs.
        try? await Task.sleep(nanoseconds: 300_000_000)
        p.pb.release()
        do {
            _ = try await second.value
            XCTFail("the second offer fits only if the first's bytes were not reserved")
        } catch let e as TransferError { XCTAssertEqual(e.reason, "quota") }
        // Once the first is delivered its reservation is released and the same size fits again.
        accept(b.transfer, to: b.dir.appendingPathComponent("two.bin"))
        _ = try await first.value
        let sent = try await a.transfer.send(over: p.a, source: .data(content(100_000)))
        XCTAssertEqual(sent.size, 100_000)
    }

    func testTheStoreRefusesAWritePastWhatWasReserved() throws {
        let store = XferStore(directory: tempDir().appendingPathComponent("xfer"), quota: 1000, diskReserve: 0)
        let key = Data(repeating: 5, count: 32)
        let sha = String(repeating: "ef", count: 32)
        let id = Base64URL.encode(Data(repeating: 3, count: 16))
        let ref = xferPartialPath(key: key, id: id, sha256: sha)
        let meta = XferPartial(ref: ref, id: id, sha256: sha, size: 10, chunk: 5, bytes: 0, writtenAt: 0)
        let tk = store.begin(peer: key)
        try store.make(meta, tk)
        try store.write(ref, offset: 0, data: Data(count: 10), token: tk)
        XCTAssertThrowsError(try store.write(ref, offset: 5, data: Data(count: 6), token: tk)) {
            XCTAssertEqual(($0 as? XferStoreError)?.kind, .quota)
        }
        // Without a reservation there is no claim, so no write.
        store.release(ref, token: tk)
        XCTAssertThrowsError(try store.write(ref, offset: 0, data: Data(count: 1000), token: tk))
        // What a new offer may ask for: the quota less what is on disk and what live transfers still owe.
        XCTAssertEqual(store.free, 990)
        store.reserve(ref, declared: 500, written: 10, token: tk)
        XCTAssertEqual(store.free, 500)
    }

    func testAnEffectQueuedBeforeAPurgeCannotRecreateTheStore() throws {
        let dir = tempDir().appendingPathComponent("xfer")
        let store = XferStore(directory: dir)
        let key = Data(repeating: 6, count: 32)
        let sha = String(repeating: "12", count: 32)
        let id = Base64URL.encode(Data(repeating: 4, count: 16))
        let ref = xferPartialPath(key: key, id: id, sha256: sha)
        let meta = XferPartial(ref: ref, id: id, sha256: sha, size: 10, chunk: 5, bytes: 0, writtenAt: 0)
        let old = store.begin(peer: key)
        try store.make(meta, old)
        store.purgeAll()
        XCTAssertThrowsError(try store.create(meta, token: old))
        XCTAssertThrowsError(try store.write(ref, offset: 0, data: Data([1]), token: old))
        XCTAssertThrowsError(try store.truncate(ref, to: 0, token: old))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path))
        // A new session works again.
        XCTAssertNoThrow(try store.make(meta, store.begin(peer: key)))
    }

    func testAPurgeInTheMiddleOfATransferLeavesNoStoreBehind() async throws {
        let p = try await openPair()
        let a = await side(p.a)
        let b = await side(p.b)
        accept(b.transfer, to: b.dir.appendingPathComponent("x"))
        p.pa.stall(after: 4)
        let task = Task { try await a.transfer.send(over: p.a, source: .data(content(500_000))) }
        await eventually("stalled") { p.pa.stalled }
        try? await Task.sleep(nanoseconds: 100_000_000)
        b.transfer.purgeAll()
        p.pa.release()
        _ = try? await task.value
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(FileManager.default.fileExists(atPath: b.store.path))
    }

    func testTheStoreSaysNilForAPartialItCannotReRead() throws {
        let store = XferStore(directory: tempDir().appendingPathComponent("xfer"))
        let key = Data(repeating: 8, count: 32)
        let sha = String(repeating: "34", count: 32)
        let id = Base64URL.encode(Data(repeating: 5, count: 16))
        let ref = xferPartialPath(key: key, id: id, sha256: sha)
        let tk = store.begin(peer: key)
        XCTAssertNil(store.rehash(ref: ref, offset: 10, token: tk))
        try store.make(XferPartial(ref: ref, id: id, sha256: sha, size: 20, chunk: 10, bytes: 0, writtenAt: 0), tk)
        try store.write(ref, offset: 0, data: Data(count: 5), token: tk)
        XCTAssertNil(store.rehash(ref: ref, offset: 10, token: tk))
        XCTAssertNotNil(store.rehash(ref: ref, offset: 5, token: tk))
    }

    func testEvictionNeverTouchesAPartialALiveTransferHolds() {
        func part(_ i: Int, held: Bool, at: Double) -> XferPartial {
            XferPartial(
                ref: "p\(i)", id: Base64URL.encode(Data(repeating: UInt8(i), count: 16)),
                sha256: String(repeating: "ab", count: 32), size: 100, chunk: 10, bytes: 10, writtenAt: at, held: held)
        }
        let offer =
            #"{"id":"D9FghtxWIhxlaxzwysyg4w","size":100,"sha256":"\#(String(repeating: "cd", count: 32))","chunk":10}"#
        func machine(_ parts: [XferPartial]) -> XferMachine {
            XferMachine(
                XferMachineOptions(
                    mode: .a, caps: [xferCap], maxMessage: 1 << 20, handler: { _ in .accept },
                    peerKey: Data(repeating: 1, count: 32), partials: parts, newRef: { _, _ in "new" }))
        }
        // Eight held: no place for a ninth, and nothing is evicted.
        var all = machine((0..<8).map { part($0, held: true, at: Double($0)) })
        var out = all.receive(100, type: XferType.offer, body: Data(offer.utf8))
        XCTAssertEqual(out.send, [.cancel(id: "D9FghtxWIhxlaxzwysyg4w", reason: .busy)])
        XCTAssertTrue(out.partial.isEmpty)
        // Seven held, the newest free: that one goes, not the oldest held.
        var some = machine((0..<8).map { part($0, held: $0 != 7, at: Double($0)) })
        out = some.receive(100, type: XferType.offer, body: Data(offer.utf8))
        XCTAssertEqual(out.partial, [.evict("p7"), .create("new")])
        _ = all
    }

    // MARK: Ownership

    private func ownedFixture() throws -> (XferStore, Data, XferPartial, URL) {
        let dir = tempDir().appendingPathComponent("xfer")
        let store = XferStore(directory: dir)
        let key = Data(repeating: 9, count: 32)
        let sha = String(repeating: "56", count: 32)
        let id = Base64URL.encode(Data(repeating: 6, count: 16))
        let ref = xferPartialPath(key: key, id: id, sha256: sha)
        return (store, key, XferPartial(ref: ref, id: id, sha256: sha, size: 10, chunk: 5, bytes: 0, writtenAt: 0), dir)
    }

    func testASecondSessionOfThePeerCannotTouchTheFirstOnesPartial() throws {
        let (store, key, meta, dir) = try ownedFixture()
        let a = store.begin(peer: key)
        let b = store.begin(peer: key)
        try store.make(meta, a)
        try store.write(meta.ref, offset: 0, data: Data([1, 2, 3]), token: a)
        // B can neither take it over, write it, cut it, remove it nor deliver it; its release changes nothing.
        store.reserve(meta.ref, declared: 10, written: 0, token: b)
        XCTAssertNil(store.rehash(ref: meta.ref, offset: 3, token: b))
        XCTAssertThrowsError(try store.create(meta, token: b))
        XCTAssertThrowsError(try store.write(meta.ref, offset: 3, data: Data([4]), token: b))
        XCTAssertThrowsError(try store.truncate(meta.ref, to: 0, token: b))
        XCTAssertThrowsError(try store.deliver(meta.ref, to: tempDir().appendingPathComponent("x"), token: b))
        store.remove(meta.ref, token: b)
        store.release(meta.ref, token: b)
        XCTAssertTrue(store.isHeld(meta.ref))
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent(meta.ref)), Data([1, 2, 3]))
        try store.write(meta.ref, offset: 3, data: Data([4]), token: a)
        // Once A has ended, B may take the partial over, and A's late effects are dropped.
        store.close(a)
        XCTAssertThrowsError(try store.write(meta.ref, offset: 4, data: Data([5]), token: a))
        XCTAssertNotNil(store.rehash(ref: meta.ref, offset: 4, token: b))
        XCTAssertTrue(store.isHeld(meta.ref))
        store.keep(meta.ref, token: a)
        store.reserve(meta.ref, declared: 10, written: 4, token: b)
        XCTAssertNoThrow(try store.write(meta.ref, offset: 4, data: Data([5]), token: b))
    }

    func testAPeerPurgeRefusesWhatThatPeersSessionsHaveQueuedAndTruncateNeverRecreates() throws {
        let (store, key, meta, dir) = try ownedFixture()
        let other = Data(repeating: 1, count: 32)
        let a = store.begin(peer: key)
        let o = store.begin(peer: other)
        try store.make(meta, a)
        store.purge(key: key)
        XCTAssertThrowsError(try store.create(meta, token: a))
        XCTAssertThrowsError(try store.write(meta.ref, offset: 0, data: Data([1]), token: a))
        XCTAssertThrowsError(try store.truncate(meta.ref, to: 0, token: a))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent(meta.ref).path))
        // Another peer's session is not affected, and a new session of the purged peer works.
        XCTAssertNoThrow(
            try store.make(
                XferPartial(
                    ref: String(repeating: "a", count: 64), id: meta.id, sha256: meta.sha256, size: 10, chunk: 5,
                    bytes: 0, writtenAt: 0), o))
        let fresh = store.begin(peer: key)
        XCTAssertNoThrow(try store.make(meta, fresh))
        // A partial that is gone is not made again by a cut.
        store.remove(meta.ref, token: fresh)
        store.reserve(meta.ref, declared: 10, written: 0, token: fresh)
        XCTAssertThrowsError(try store.truncate(meta.ref, to: 0, token: fresh))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent(meta.ref).path))
    }

    func testTheDefaultQuotaIsFourGiB() {
        XCTAssertEqual(XferStore.defaultQuotaBytes, 4 * 1024 * 1024 * 1024)
        XCTAssertEqual(XferStore.defaultDiskReserveBytes, 256 * 1024 * 1024)
    }

    // MARK: Session wiring

    func testAnXferRecordWithMoreIsABadFrameAndWithoutTheCapabilityNotAllowed() {
        var asm = PeerRecordAssembler(mode: .a)
        asm.xferAllowed = true
        XCTAssertEqual(
            asm.push(PeerRecord(type: XferType.offer, flags: 1, body: Data("{".utf8))), .close(.peerBadFrame))
        var no = PeerRecordAssembler(mode: .a)
        no.xferAllowed = false
        XCTAssertEqual(
            no.push(PeerRecord(type: XferType.cancel, flags: 0, body: Data("{}".utf8))), .close(.peerNotAllowed))
        var c = PeerRecordAssembler(mode: .c)
        c.xferAllowed = true
        XCTAssertEqual(
            c.push(PeerRecord(type: XferType.ack, flags: 0, body: Data("{}".utf8))),
            .message(type: XferType.ack, body: Data("{}".utf8)))
        var v = PeerRecordAssembler(mode: .v)
        v.xferAllowed = true
        XCTAssertEqual(
            v.push(PeerRecord(type: XferType.ack, flags: 0, body: Data("{}".utf8))), .close(.peerNotAllowed))
    }
}
