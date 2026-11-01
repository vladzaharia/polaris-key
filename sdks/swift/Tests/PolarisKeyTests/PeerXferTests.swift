// @pkey-feature connect.transfer
// CC-20.6: Direct Transfer in the core (WIRE-CONTRACT-V5 §15.11): every row of the `xfer` section of
// `peer-matrix.json` (codecs, window, offer order, hash, ending, resume, name, limits). Mirrors client-core's
// `peerXfer.test.ts` and the Node runner's `xferRun`. One side of a session is a machine over its steps.

import Foundation
import XCTest

@testable import PolarisKeyCore
#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

private func unhex(_ s: String) -> Data {
    let c = Array(s.utf8)
    func nib(_ b: UInt8) -> UInt8 { b >= 97 ? b - 87 : b - 48 }
    return Data(stride(from: 0, to: c.count, by: 2).map { nib(c[$0]) << 4 | nib(c[$0 + 1]) })
}

private func rowBytes(_ r: [String: JSONValue]) -> Data {
    if let h = r["bodyHex"]?.stringValue { return unhex(h) }
    if let p = r["bodyPad"]?.objectValue {
        return Data(
            (p["prefix"]!.stringValue! + String(repeating: p["fill"]!.stringValue!, count: p["count"]!.intValue!)
                + p["suffix"]!.stringValue!).utf8)
    }
    return Data(r["body"]!.stringValue!.utf8)
}

/// The content every `xfer` row transfers: byte i is (7 i + 13) mod 256 (`corrupt` flips each).
func xferContent(_ from: Int, _ to: Int, flip: Bool = false) -> Data {
    Data((from..<to).map { UInt8(truncatingIfNeeded: $0 &* 7 &+ 13) ^ (flip ? 0xff : 0) })
}

private final class RefCounter: @unchecked Sendable {
    private let l = NSLock()
    private var n = 0
    func next() -> Int {
        l.withLock {
            n += 1
            return n
        }
    }
}

// MARK: - The machine's output as a row's `want`

private func obj(_ pairs: [(String, JSONValue?)]) -> JSONValue {
    var o: [String: JSONValue] = [:]
    for (k, v) in pairs { if let v { o[k] = v } }
    return .object(o)
}

private func sendJSON(_ s: XferSend) -> JSONValue {
    switch s {
    case .offer(let o):
        return obj([
            ("t", .string("OFFER")), ("id", .string(o.id)), ("size", .int(o.size)), ("chunk", .int(o.chunk)),
            ("sha256", .string(o.sha256)), ("cat", o.cat.map { .string($0) }), ("name", o.name.map { .string($0) }),
            ("type", o.type.map { .string($0) }),
        ])
    case .accept(let id, let off): return obj([("t", .string("ACCEPT")), ("id", .string(id)), ("offset", .int(off))])
    case .chunks(let id, let off, let n):
        return obj([("t", .string("CHUNKS")), ("id", .string(id)), ("offset", .int(off)), ("bytes", .int(n))])
    case .ack(let id, let off): return obj([("t", .string("ACK")), ("id", .string(id)), ("offset", .int(off))])
    case .done(let id, let sha):
        return obj([("t", .string("DONE")), ("id", .string(id)), ("sha256", sha.map { .string($0) })])
    case .cancel(let id, let r):
        return obj([("t", .string("CANCEL")), ("id", .string(id)), ("reason", .string(r.rawValue))])
    }
}

private func partialJSON(_ e: XferPartialEffect) -> JSONValue? {
    switch e {
    case .create(let r): return obj([("create", .string(r))])
    case .truncate(let r, let to): return obj([("truncate", .string(r)), ("to", .int(to))])
    case .discard(let r): return obj([("discard", .string(r))])
    case .evict(let r): return obj([("evict", .string(r))])
    case .keep(let r): return obj([("keep", .string(r))])
    case .delete(let r): return obj([("delete", .string(r))])
    case .finalize(let r): return obj([("finalize", .string(r))])
    case .write: return nil
    }
}

private func wantJSON(_ o: XferOut) throws -> [String: JSONValue] {
    var w: [String: JSONValue] = [:]
    if !o.send.isEmpty { w["send"] = .array(o.send.map(sendJSON)) }
    if let c = o.close { w["close"] = .string(c.rawValue) }
    if let a = o.ask {
        w["ask"] = obj([
            ("id", .string(a.id)), ("name", a.name.map { .string($0) }), ("type", a.type.map { .string($0) }),
            ("size", .int(a.size)), ("cat", a.cat.map { .string($0) }),
        ])
    }
    if !o.withdraw.isEmpty {
        XCTAssertEqual(o.withdraw.count, 1)
        w["withdraw"] = .string(o.withdraw[0])
    }
    if !o.results.isEmpty {
        XCTAssertEqual(o.results.count, 1)
        switch o.results[0] {
        case .delivered(let id): w["result"] = obj([("id", .string(id)), ("outcome", .string("delivered"))])
        case .closed(let id): w["result"] = obj([("id", .string(id)), ("outcome", .string("closed"))])
        case .cancelled(let id, let r):
            w["result"] = obj([("id", .string(id)), ("outcome", .string("cancelled")), ("reason", .string(r.rawValue))])
        }
    }
    let partial = o.partial.compactMap(partialJSON)
    if !partial.isEmpty { w["partial"] = .array(partial) }
    if o.refusedBusy { w["refused"] = .string("busy") }
    if o.drop { w["drop"] = .bool(true) }
    return w
}

/// Sum the consecutive `CHUNKS` of one step that continue each other.
private func merge(_ want: [String: JSONValue]) -> [String: JSONValue] {
    guard case .array(let sends)? = want["send"] else { return want }
    var out: [[String: JSONValue]] = []
    for s in sends {
        guard var cur = s.objectValue else { continue }
        if cur["t"]?.stringValue == "CHUNKS", var last = out.last, last["t"]?.stringValue == "CHUNKS",
            last["id"] == cur["id"], last["offset"]!.intValue! + last["bytes"]!.intValue! == cur["offset"]!.intValue!
        {
            last["bytes"] = .int(last["bytes"]!.intValue! + cur["bytes"]!.intValue!)
            out[out.count - 1] = last
        } else {
            cur["t"] = cur["t"]
            out.append(cur)
        }
    }
    var w = want
    w["send"] = .array(out.map { .object($0) })
    return w
}

final class PeerXferCorpusTests: XCTestCase {
    private let x: [String: JSONValue] = {
        let v = try! CorpusLocator.load(JSONValue.self, "peer-matrix")
        return v.objectValue!["xfer"]!.objectValue!
    }()

    private func rows(_ key: String) -> [[String: JSONValue]] { x[key]!.arrayValue!.map { $0.objectValue! } }
    private func sub(_ a: String, _ b: String) -> [[String: JSONValue]] {
        x[a]!.objectValue![b]!.arrayValue!.map { $0.objectValue! }
    }

    func testConstants() {
        let c = x["constants"]!.objectValue!
        XCTAssertEqual(c["maxControlBytes"]?.intValue, xferMaxControlBytes)
        XCTAssertEqual(c["maxSize"]?.intValue, xferMaxSize)
        XCTAssertEqual(c["defaultChunk"]?.intValue, xferDefaultChunk)
        XCTAssertEqual(c["maxChunk"]?.intValue, xferMaxChunk)
        XCTAssertEqual(c["window"]?.intValue, xferWindow)
        XCTAssertEqual(c["ackEvery"]?.intValue, xferAckEvery)
        XCTAssertEqual(c["maxTransfers"]?.intValue, xferMaxTransfers)
        XCTAssertEqual(c["consentSeconds"]?.doubleValue, xferConsentSeconds)
        XCTAssertEqual(c["idleSeconds"]?.doubleValue, xferIdleSeconds)
        XCTAssertEqual(c["partialSeconds"]?.doubleValue, xferPartialSeconds)
        XCTAssertEqual(c["maxPartialsPerPeer"]?.intValue, xferMaxPartialsPerPeer)
        XCTAssertEqual(c["endedIds"]?.intValue, xferEndedIds)
    }

    // MARK: Codecs

    func testOfferCodec() {
        for r in sub("codecs", "offer") {
            let b = rowBytes(r)
            let id = r["id"]!.stringValue!
            XCTAssertEqual(b.count, r["length"]!.intValue, id)
            let got = XferCodec.parseOffer(b, maxMessage: r["maxMessage"]!.intValue!)
            let want = r["want"]!.objectValue!
            if want["ok"]?.boolValue == true {
                let w = want["offer"]!.objectValue!
                guard let got else {
                    XCTFail(id)
                    continue
                }
                XCTAssertEqual(got.id, w["id"]?.stringValue, id)
                XCTAssertEqual(got.name, w["name"]?.stringValue, id)
                XCTAssertEqual(got.type, w["type"]?.stringValue, id)
                XCTAssertEqual(got.size, w["size"]?.intValue, id)
                XCTAssertEqual(got.sha256, w["sha256"]?.stringValue, id)
                XCTAssertEqual(got.cat, w["cat"]?.stringValue, id)
                XCTAssertEqual(got.chunk, w["chunk"]?.intValue, id)
            } else {
                XCTAssertNil(got, id)
            }
        }
    }

    func testOffsetCodec() {
        for r in sub("codecs", "offsetBodies") {
            let id = r["id"]!.stringValue!
            let got = XferCodec.parseOffset(
                ack: r["kind"]!.stringValue! == "ACK", rowBytes(r), size: r["size"]!.intValue!,
                chunk: r["chunk"]!.intValue!)
            let want = r["want"]!.objectValue!
            if want["ok"]?.boolValue == true {
                XCTAssertEqual(got?.id, want["id"]?.stringValue, id)
                XCTAssertEqual(got?.offset, want["offset"]?.intValue, id)
            } else {
                XCTAssertNil(got, id)
            }
        }
    }

    func testDoneCodec() {
        for r in sub("codecs", "done") {
            let id = r["id"]!.stringValue!
            let got = XferCodec.parseDone(rowBytes(r), towardSender: r["toward"]!.stringValue! == "sender")
            let want = r["want"]!.objectValue!
            if want["ok"]?.boolValue == true {
                XCTAssertNotNil(got, id)
                XCTAssertEqual(got?.id, want["id"]?.stringValue, id)
                XCTAssertEqual(got?.sha256, want["sha256"]?.stringValue, id)
            } else {
                XCTAssertNil(got, id)
            }
        }
    }

    func testCancelCodec() {
        for r in sub("codecs", "cancel") {
            let id = r["id"]!.stringValue!
            let got = XferCodec.parseCancel(rowBytes(r))
            let want = r["want"]!.objectValue!
            if want["ok"]?.boolValue == true {
                XCTAssertEqual(got?.id, want["id"]?.stringValue, id)
                XCTAssertEqual(got?.reason.rawValue, want["reason"]?.stringValue, id)
            } else {
                XCTAssertNil(got, id)
            }
        }
    }

    func testChunkCodec() {
        for r in sub("codecs", "chunk") {
            let id = r["id"]!.stringValue!
            var body = unhex(r["head"]!.stringValue!)
            body.append(Data(repeating: 0xab, count: r["dataLength"]!.intValue!))
            let got = XferCodec.parseChunk(
                body, size: r["size"]!.intValue!, chunk: r["chunk"]!.intValue!, expect: r["expect"]!.intValue!)
            let want = r["want"]!.objectValue!
            if want["ok"]?.boolValue == true {
                XCTAssertEqual(got?.id, want["id"]?.stringValue, id)
                XCTAssertEqual(got?.offset, want["offset"]?.intValue, id)
                XCTAssertEqual(got?.length, want["length"]?.intValue, id)
            } else {
                XCTAssertNil(got, id)
            }
        }
    }

    // MARK: The partial file's path and the shown name

    func testPartialPathsAndNames() {
        let n = x["name"]!.objectValue!
        for r in n["paths"]!.arrayValue!.map({ $0.objectValue! }) {
            let got = xferPartialPath(
                key: unhex(r["key"]!.stringValue!), id: r["xferId"]!.stringValue!, sha256: r["sha256"]!.stringValue!)
            XCTAssertEqual(got, r["path"]!.stringValue, r["id"]!.stringValue!)
        }
        let key = unhex(n["key"]!.stringValue!)
        for r in n["rows"]!.arrayValue!.map({ $0.objectValue! }) {
            let id = r["id"]!.stringValue!
            guard let offer = XferCodec.parseOffer(Data(r["body"]!.stringValue!.utf8), maxMessage: 1_048_576) else {
                XCTFail(id)
                continue
            }
            XCTAssertEqual(cleanDisplayName(offer.name), r["display"]?.stringValue, id)
            XCTAssertEqual(offer.type, r["type"]?.stringValue, id)
            XCTAssertEqual(xferPartialPath(key: key, id: offer.id, sha256: offer.sha256), r["path"]!.stringValue, id)
        }
    }

    // MARK: The machine rows

    func testWindowRows() throws { try run("window") }
    func testOfferRows() throws { try run("offer") }
    func testHashRows() throws { try run("hash") }
    func testEndingRows() throws { try run("ending") }
    func testResumeRows() throws { try run("resume") }
    func testLimitRows() throws { try run("limits") }

    private func run(_ section: String) throws {
        var count = 0
        for row in rows(section) {
            try runRow(row)
            count += 1
        }
        XCTAssertGreaterThan(count, 0, section)
    }

    private func runRow(_ row: [String: JSONValue]) throws {
        let rid = row["id"]!.stringValue!
        let c = row["ctx"]!.objectValue!
        func strs(_ k: String) -> [String] { c[k]!.arrayValue!.map { $0.stringValue! } }
        var corrupt: [String: Bool] = [:]
        var parts: [XferPartial] = []
        for p in c["partials"]!.arrayValue!.map({ $0.objectValue! }) {
            let ref = p["ref"]!.stringValue!
            corrupt[ref] = p["corrupt"]?.boolValue == true
            if p["otherPeer"]?.boolValue == true { continue }
            parts.append(
                XferPartial(
                    ref: ref, id: p["id"]!.stringValue!, sha256: p["sha256"]!.stringValue!, size: p["size"]!.intValue!,
                    chunk: p["chunk"]!.intValue!, bytes: p["bytes"]!.intValue!, writtenAt: p["writtenAt"]!.doubleValue!,
                    held: p["held"]?.boolValue == true, reread: p["reread"]?.intValue))
        }
        let handlerName = c["handler"]!.stringValue!
        var handler: (@Sendable (XferAsk) -> XferAnswer)?
        switch handlerName {
        case "none": handler = nil
        case "ask": handler = { _ in .ask }
        case "decline": handler = { _ in .decline }
        default: handler = { _ in .accept }
        }
        let counter = RefCounter()
        let flags = corrupt
        let free = c["free"]?.intValue
        var m = XferMachine(
            XferMachineOptions(
                mode: PeerNoiseMode(rawValue: c["mode"]!.stringValue!)!,
                caps: PeerPayload.capsIntersection(strs("capsLocal"), strs("capsRemote")),
                maxMessage: c["maxMessage"]!.intValue!, hostLimit: c["hostLimit"]?.intValue, free: { free },
                handler: handler, categories: strs("cats"), peerKey: unhex(c["peerKey"]!.stringValue!), partials: parts,
                rehash: { ref, offset in
                    var h = SHA256()
                    h.update(data: xferContent(0, offset, flip: flags[ref] == true))
                    return h
                }, newRef: { _, _ in "n\(counter.next())" }, withholdAcks: c["withholdAcks"]?.boolValue == true))
        var got: [[String: JSONValue]] = []
        for st in row["steps"]!.arrayValue!.map({ $0.objectValue! }) {
            let at = st["at"]!.doubleValue!
            let out: XferOut
            if let host = st["host"]?.stringValue {
                switch host {
                case "tick": out = m.tick(at)
                case "offer":
                    out = try m.offer(
                        at,
                        XferOfferArgs(
                            id: st["id"]!.stringValue!, size: st["size"]!.intValue!, chunk: st["chunk"]!.intValue!,
                            sha256: st["sha256"]!.stringValue!, cat: st["cat"]?.stringValue,
                            seekable: st["seekable"]?.boolValue ?? true))
                case "consent":
                    out = m.consent(at, id: st["id"]!.stringValue!, accept: st["answer"]!.stringValue! == "accept")
                case "cancel": out = m.cancel(at, id: st["id"]!.stringValue!)
                case "close": out = m.close(at)
                case "newSession": out = m.newSession(at)
                default:
                    XCTFail("\(rid): host \(host)")
                    return
                }
            } else {
                let more = st["more"]?.boolValue == true
                let id = st["id"]?.stringValue ?? ""
                func off() -> Int { st["offset"]!.intValue! }
                func rec(_ type: Int, _ body: Data) -> XferOut { m.receive(at, type: type, body: body, more: more) }
                switch st["rx"]!.stringValue! {
                case "PING": out = m.tick(at)
                case "OFFER": out = rec(XferType.offer, Data(st["body"]!.stringValue!.utf8))
                case "ACCEPT": out = rec(XferType.accept, XferCodec.offsetBody(id: id, offset: off()))
                case "ACK": out = rec(XferType.ack, XferCodec.offsetBody(id: id, offset: off()))
                case "CHUNK":
                    out = rec(
                        XferType.chunk,
                        XferCodec.chunkBody(
                            id: id, offset: off(),
                            data: xferContent(
                                off(), off() + st["length"]!.intValue!, flip: st["data"]?.stringValue == "corrupt")))
                case "DONE": out = rec(XferType.done, XferCodec.doneBody(id: id, sha256: st["sha256"]?.stringValue))
                case "CANCEL":
                    let enc = JSONEncoder()
                    enc.outputFormatting = [.withoutEscapingSlashes]
                    let reason = String(decoding: try enc.encode(st["reason"]!.stringValue!), as: UTF8.self)
                    out = rec(XferType.cancel, Data("{\"id\":\"\(id)\",\"reason\":\(reason)}".utf8))
                default:
                    XCTFail("\(rid): rx")
                    return
                }
            }
            got.append(merge(try wantJSON(out)))
        }
        let want = row["want"]!.arrayValue!.map { merge($0.objectValue!) }
        XCTAssertEqual(got.count, want.count, rid)
        for (i, (g, w)) in zip(got, want).enumerated() { XCTAssertEqual(g, w, "\(rid) step \(i)") }
    }
}
