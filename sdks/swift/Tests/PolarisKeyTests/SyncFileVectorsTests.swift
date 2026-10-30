// @pkey-feature sync.files sync.files.delta
// The synced-file primitives against `conformance/corpus/v2/sync-vectors.json` (U-23.S1;
// WIRE-CONTRACT-V5 §13.8.3): cdcCases, cdcEditCases, deltaCases, chunkCases and manifestCases, and
// (U-23.S2) fileStreamCases and transferPlanCases.

import CryptoKit
import Foundation
import PolarisKeyPacks
import Testing

@testable import PolarisKeyCore

private struct FileVectors: Decodable {
    struct CdcInput: Decodable {
        let kind: String
        let length: Int
        let value: Int?
        let label: String?
    }
    struct Cdc: Decodable {
        let id: String
        let avg, min, max: Int
        let input: CdcInput
        let lens: [Int]
    }
    struct Edit: Decodable {
        let op, label: String
        let at, length: Int
    }
    struct CdcEdit: Decodable {
        let id, rootHex, collection: String
        let avg: Int
        let base: CdcInput
        let edit: Edit
        let baseLens, editedLens: [Int]
        let baseIdsHex, editedIdsHex: [String]
        let keptIndexes, changedIndexes: [Int]
        let baseManifestHex, editedManifestHex: String
    }
    struct Side: Decodable {
        let row: String?
        let side: String?
        let idsHex: [String]?
    }
    struct Delta: Decodable {
        let id: String
        let have, want: Side
        let moveIdsHex: [String]
        let moveBytes: Int
    }
    struct Chunk: Decodable {
        struct Expect: Decodable {
            let result: String
            let plainHex: String?
            let codec: Int?
            let reason: String?
        }
        struct Seal: Decodable {
            let codec: Int
            let bodyHex: String
        }
        let id, kind, rootHex, collection: String
        let plainHex, e2eIdHex, serverIdHex, idHex, objectHex: String?
        let seal: Seal?
        let expect: Expect?
        let rawObjectHex, zstdObjectHex, rawNonceHex, zstdNonceHex: String?
    }
    struct ManifestRecord: Decodable, Equatable {
        let idHex: String
        let plainLen: Int
    }
    struct Manifest: Decodable {
        struct Expect: Decodable {
            let result: String
            let reason: String?
            let plainSize: Int?
            let plainSha256Hex: String?
            let records: [ManifestRecord]?
        }
        let id, manifestHex: String
        let expect: Expect
    }
    struct FileOp: Decodable {
        let op: String
        let length, index, a, b, from, offset, value: Int?
        let hex: String?
    }
    struct FileRow: Decodable {
        struct Plain: Decodable {
            let label: String
            let length: Int
        }
        struct Expect: Decodable {
            let result, reason, plainSha256Hex, sha256Hex, headerHex, sealedSha256Hex: String?
            let sealedSize, length: Int?
            let reads: [[Int]]?
        }
        let id, kind: String
        let rootHex, collection, saltHex, base, openCollection, expectKidHex: String?
        let plain: Plain?
        let mutate: [FileOp]?
        let start, end: Int?
        let plainToSealed: [[Int]]?
        let sealedToPlain: [[Int?]]?
        let expect: Expect?
    }
    struct PlanCase: Decodable {
        struct Expect: Decodable {
            let mode: String
            let partBytes, parts: Int?
        }
        let id: String
        let size: Int
        let delta: Bool
        let expect: Expect
    }
    let cdcCases: [Cdc]
    let cdcEditCases: [CdcEdit]
    let deltaCases: [Delta]
    let chunkCases: [Chunk]
    let manifestCases: [Manifest]
    let fileStreamCases: [FileRow]
    let transferPlanCases: [PlanCase]
}

private func hex(_ s: String) -> Data {
    var d = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        d.append(UInt8(s[i..<j], radix: 16)!)
        i = j
    }
    return d
}

private func hexString(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

private let corpus: FileVectors = {
    // swiftlint:disable:next force_try
    try! CorpusLocator.load(FileVectors.self, "sync-vectors")
}()

/// SHA-256 counter blocks of `prefix + label`, then the 4-byte big-endian counter.
private func counterBytes(_ prefix: String, _ label: String, _ length: Int) -> Data {
    var out = Data()
    var n: UInt32 = 0
    while out.count < length {
        var h = SHA256()
        h.update(data: Data((prefix + label).utf8))
        h.update(data: withUnsafeBytes(of: n.bigEndian) { Data($0) })
        out.append(Data(h.finalize()).prefix(min(32, length - out.count)))
        n += 1
    }
    return out
}

private func cdcInput(_ i: FileVectors.CdcInput) -> Data {
    if i.kind == "byte" { return Data(repeating: UInt8(i.value!), count: i.length) }
    return counterBytes("pkey-sync vector cdc ", i.label!, i.length)
}

private func applyEdit(_ base: Data, _ e: FileVectors.Edit) -> Data {
    var out = Data(base.prefix(e.at))
    if e.op != "delete" { out.append(counterBytes("pkey-sync vector cdc-edit ", e.label, e.length)) }
    out.append(base.dropFirst(e.op == "insert" ? e.at : e.at + e.length))
    return out
}

/// The chunk lengths of `data` fed in pieces of `piece` bytes.
private func cut(_ data: Data, avg: Int, piece: Int) -> [Data] {
    var c = SyncCdc.Chunker(params: SyncCdc.params(avg: avg)!)
    var out: [Data] = []
    var at = 0
    while at < data.count {
        out += c.push(data.subdata(in: at..<min(at + piece, data.count)))
        at += piece
    }
    return out + c.finish()
}

private let zstd: SyncChunks.ZstdDecode = { frame, size in
    Data(try LibZstd().decode([UInt8](frame), size: size))
}

@Suite("Synced-file primitives (sync-vectors.json)")
struct SyncFileVectorsTests {
    @Test(arguments: corpus.cdcCases.map(\.id))
    func cdc(id: String) {
        let c = corpus.cdcCases.first { $0.id == id }!
        #expect(SyncCdc.params(avg: c.avg) == SyncCdc.Params(avg: c.avg, min: c.min, max: c.max))
        let input = cdcInput(c.input)
        // Whole, then in awkward pieces: the cuts do not depend on how the input arrives.
        for piece in [max(input.count, 1), 1000, 65537] {
            #expect(cut(input, avg: c.avg, piece: piece).map(\.count) == c.lens)
        }
    }

    @Test func cdcParameters() {
        #expect(SyncCdc.defaultParams == SyncCdc.Params(avg: 262_144, min: 65_536, max: 1_048_576))
        #expect(SyncCdc.params(avg: 1000) == nil)
        #expect(SyncCdc.params(avg: 32) == nil)
        #expect(SyncCdc.params(avg: 0) == nil)
        #expect(SyncCdc.params(avg: -64) == nil)
    }

    @Test(arguments: corpus.chunkCases.map(\.id))
    func chunk(id: String) throws {
        let c = corpus.chunkCases.first { $0.id == id }!
        let root = hex(c.rootHex)
        switch c.kind {
        case "id":
            let plain = hex(c.plainHex!)
            #expect(SyncChunks.chunkIdHex(root: root, collection: c.collection, plain: plain) == c.e2eIdHex)
            #expect(SyncChunks.chunkIdHex(root: nil, collection: c.collection, plain: plain) == c.serverIdHex)
        case "pair":
            #expect(c.rawNonceHex != c.zstdNonceHex)
            for (obj, nonce, codec) in [
                (c.rawObjectHex!, c.rawNonceHex!, UInt8(0)), (c.zstdObjectHex!, c.zstdNonceHex!, UInt8(1)),
            ] {
                let bytes = hex(obj)
                #expect(hexString(bytes.subdata(in: 2..<14)) == nonce)
                let o = SyncChunks.open(
                    root: root, collection: c.collection, id: hex(c.idHex!), object: bytes, decode: zstd)
                #expect(o == .ok(plain: hex(c.plainHex!), codec: codec))
            }
        default:
            let opened = SyncChunks.open(
                root: root, collection: c.collection, id: hex(c.idHex!), object: hex(c.objectHex!),
                decode: zstd)
            let e = c.expect!
            if e.result == "ok" {
                #expect(opened == .ok(plain: hex(e.plainHex!), codec: UInt8(e.codec!)))
            } else {
                #expect(opened.reason?.rawValue == e.reason)
            }
            if let s = c.seal {
                let object = try SyncChunks.seal(
                    root: root, collection: c.collection, id: hex(c.idHex!), codec: UInt8(s.codec),
                    body: hex(s.bodyHex))
                #expect(hexString(object) == c.objectHex)
            }
        }
    }

    @Test func chunkObjectsBeyondTheCorpus() throws {
        let root = Data((0..<32).map { UInt8($0 &* 5 &+ 1) })
        let plain = Data((0..<3000).map { UInt8(truncatingIfNeeded: $0 &* 7 &+ ($0 >> 3)) })
        let id = SyncChunks.chunkId(root: root, collection: "saves", plain: plain)
        let obj = try SyncChunks.seal(root: root, collection: "saves", id: id, codec: 0, body: plain)
        #expect(SyncChunks.open(root: root, collection: "saves", id: id, object: obj) == .ok(plain: plain, codec: 0))
        // The same chunk sealed twice is the same object (the nonce is synthetic).
        #expect(try SyncChunks.seal(root: root, collection: "saves", id: id, codec: 0, body: plain) == obj)
        // Another collection derives another key.
        #expect(SyncChunks.open(root: root, collection: "other", id: id, object: obj).reason == .auth)
        // A codec 1 object with no decoder is `decode`, not a crash.
        let framed = hex("28b52ffd2007")
        let z = try SyncChunks.seal(root: root, collection: "saves", id: id, codec: 1, body: framed)
        #expect(SyncChunks.open(root: root, collection: "saves", id: id, object: z).reason == .decode)
        #expect(
            SyncChunks.open(root: root, collection: "saves", id: id, object: z, decode: { _, _ in Data([1, 2, 3]) })
                .reason == .decode)
        // A slice of a larger Data opens like a copy.
        let padded = Data([9, 9, 9]) + obj
        #expect(
            SyncChunks.open(root: root, collection: "saves", id: id, object: padded.dropFirst(3))
                == .ok(plain: plain, codec: 0))
        #expect(throws: SyncCryptoError.self) {
            try SyncChunks.seal(root: root, collection: "saves", id: id, codec: 2, body: plain)
        }
        #expect(throws: SyncCryptoError.self) {
            try SyncChunks.seal(root: root, collection: "saves", id: id.prefix(31), codec: 0, body: plain)
        }
        #expect(SyncChunks.idBytes(hex: hexString(id)) == id)
        #expect(SyncChunks.idBytes(hex: hexString(id).uppercased()) == nil)
        #expect(SyncChunks.idBytes(hex: hexString(id) + "\n") == nil)
        #expect(SyncChunks.idBytes(hex: "ab") == nil)
        #expect(SyncChunks.zstdContentSize(hex("28b52ffd2007")) == 7)
        #expect(SyncChunks.zstdContentSize(hex("28b52ffd600100")) == 257)
        #expect(SyncChunks.zstdContentSize(hex("28b52ffd000000")) == nil)
        #expect(SyncChunks.zstdContentSize(hex("00b52ffd2007")) == nil)
    }

    @Test(arguments: corpus.manifestCases.map(\.id))
    func manifest(id: String) throws {
        let c = corpus.manifestCases.first { $0.id == id }!
        let bytes = hex(c.manifestHex)
        let parsed = SyncManifest.parse(bytes)
        if c.expect.result == "invalid" {
            #expect(parsed.reason?.rawValue == c.expect.reason)
            return
        }
        guard case .ok(let m) = parsed else {
            Issue.record("expected ok, got \(parsed)")
            return
        }
        #expect(m.plainSize == c.expect.plainSize)
        #expect(hexString(m.plainSha256) == c.expect.plainSha256Hex)
        #expect(
            m.records.map { FileVectors.ManifestRecord(idHex: hexString($0.id), plainLen: $0.plainLen) }
                == c.expect.records)
        #expect(try SyncManifest.encode(m) == bytes)
    }

    @Test func manifestEncodeRefusals() {
        let sha = Data(repeating: 1, count: 32)
        #expect(throws: SyncCryptoError.self) {
            try SyncManifest.encode(.init(plainSize: 0, plainSha256: Data([1]), records: []))
        }
        #expect(throws: SyncCryptoError.self) {
            try SyncManifest.encode(
                .init(plainSize: 1, plainSha256: sha, records: [.init(id: Data([1]), plainLen: 1)]))
        }
    }

    @Test(arguments: corpus.cdcEditCases.map(\.id))
    func cdcEdit(id: String) throws {
        let c = corpus.cdcEditCases.first { $0.id == id }!
        let root = hex(c.rootHex)
        let base = cdcInput(c.base)
        let edited = applyEdit(base, c.edit)
        for (buf, lens, ids, manifestHex) in [
            (base, c.baseLens, c.baseIdsHex, c.baseManifestHex),
            (edited, c.editedLens, c.editedIdsHex, c.editedManifestHex),
        ] {
            let chunks = cut(buf, avg: c.avg, piece: 65537)
            #expect(chunks.map(\.count) == lens)
            #expect(
                chunks.map { SyncChunks.chunkIdHex(root: root, collection: c.collection, plain: $0) } == ids)
            guard case .ok(let m) = SyncManifest.parse(hex(manifestHex)) else {
                Issue.record("manifest refused")
                continue
            }
            #expect(m.plainSize == buf.count)
            #expect(m.plainSha256 == SyncCrypto.sha256(buf))
            #expect(m.records.map { hexString($0.id) } == ids)
            #expect(m.records.map(\.plainLen) == lens)
            #expect(hexString(try SyncManifest.encode(m)) == manifestHex)
        }
        let have = Set(c.baseIdsHex)
        var kept: [Int] = []
        var changed: [Int] = []
        for (i, id) in c.editedIdsHex.enumerated() {
            if have.contains(id) { kept.append(i) } else { changed.append(i) }
        }
        #expect(kept == c.keptIndexes)
        #expect(changed == c.changedIndexes)
    }

    @Test(arguments: corpus.deltaCases.map(\.id))
    func delta(id: String) {
        let c = corpus.deltaCases.first { $0.id == id }!
        func records(_ s: FileVectors.Side) -> [(id: String, len: Int)] {
            let row = corpus.cdcEditCases.first { $0.id == s.row }!
            let text = s.side == "base" ? row.baseManifestHex : row.editedManifestHex
            guard case .ok(let m) = SyncManifest.parse(hex(text)) else { return [] }
            return m.records.map { (hexString($0.id), $0.plainLen) }
        }
        let have = Set(c.have.idsHex ?? records(c.have).map(\.id))
        var move: [String] = []
        var bytes = 0
        for r in records(c.want) where !have.contains(r.id) && !move.contains(r.id) {
            move.append(r.id)
            bytes += r.len
        }
        #expect(move == c.moveIdsHex)
        #expect(bytes == c.moveBytes)
    }

    // ── U-23.S2: the transfer planner and the file stream ───────────────────────────────────

    @Test(arguments: corpus.transferPlanCases.map(\.id))
    func transferPlan(id: String) {
        let c = corpus.transferPlanCases.first { $0.id == id }!
        let p = SyncTransferPlan.plan(size: c.size, delta: c.delta)
        #expect(p?.mode.rawValue == c.expect.mode)
        #expect(p?.partBytes == c.expect.partBytes)
        #expect(p?.parts == c.expect.parts)
        guard let p, p.mode == .multipart, let parts = p.parts, let partBytes = p.partBytes else {
            #expect(SyncTransferPlan.partRange(p!, size: c.size, part: 1) == nil)
            return
        }
        // The parts tile the file: contiguous, every one full but the last, none empty.
        var at = 0
        for n in 1...parts {
            let r = SyncTransferPlan.partRange(p, size: c.size, part: n)!
            #expect(r.lowerBound == at && !r.isEmpty && (n == parts || r.count == partBytes))
            at = r.upperBound
        }
        #expect(at == c.size)
        #expect(SyncTransferPlan.partRange(p, size: c.size, part: 0) == nil)
        #expect(SyncTransferPlan.partRange(p, size: c.size, part: parts + 1) == nil)
    }

    @Test func transferPlanRefusesNegative() {
        #expect(SyncTransferPlan.plan(size: -1, delta: false) == nil)
    }

    private static func applyOps(_ stream: Data, _ ops: [FileVectors.FileOp]) -> Data {
        var b = [UInt8](stream)
        let stride = SyncFileStream.segmentBytes + SyncFileStream.tagBytes
        func seg(_ i: Int) -> Range<Int> {
            let a = 64 + i * stride
            return a..<min(b.count, a + stride)
        }
        for o in ops {
            switch o.op {
            case "truncate": b = Array(b.prefix(o.length!))
            case "dropSegment": b.removeSubrange(seg(o.index!))
            case "swapSegments":
                let (lo, hi) = (min(o.a!, o.b!), max(o.a!, o.b!))
                let r1 = seg(lo)
                let r2 = seg(hi)
                let parts = [
                    Array(b[..<r1.lowerBound]), Array(b[r2]), Array(b[r1.upperBound..<r2.lowerBound]),
                    Array(b[r1]), Array(b[r2.upperBound...]),
                ]
                b = Array(parts.joined())
            case "appendSegment": b += Array(b[seg(o.from!)])
            case "xor": b[o.offset!] ^= UInt8(o.value!)
            case "setHex":
                for (i, v) in hex(o.hex!).enumerated() { b[o.offset! + i] = v }
            case "appendHex": b += [UInt8](hex(o.hex!))
            default: Issue.record("unknown op \(o.op)")
            }
        }
        return Data(b)
    }

    /// The pinned bytes of every `seal` row, sealed once.
    private static let sealed: [String: (bytes: Data, root: Data, collection: String)] = {
        var out: [String: (Data, Data, String)] = [:]
        for r in corpus.fileStreamCases where r.kind == "seal" {
            let root = hex(r.rootHex!)
            let plain = counterBytes("pkey-sync vector file ", r.plain!.label, r.plain!.length)
            // swiftlint:disable:next force_try
            let bytes = try! SyncFileStream.sealFile(
                collKey: SyncCrypto.deriveCollKey(root: root, collection: r.collection!),
                kid: SyncCrypto.deriveKid(root: root), plain: plain, salt: hex(r.saltHex!))
            out[r.id] = (bytes, root, r.collection!)
        }
        return out
    }()

    @Test(arguments: corpus.fileStreamCases.filter { $0.kind == "seal" }.map(\.id))
    func fileSeal(id: String) throws {
        let r = corpus.fileStreamCases.first { $0.id == id }!
        let root = hex(r.rootHex!)
        let collKey = SyncCrypto.deriveCollKey(root: root, collection: r.collection!)
        let kid = SyncCrypto.deriveKid(root: root)
        let plain = counterBytes("pkey-sync vector file ", r.plain!.label, r.plain!.length)
        let e = r.expect!
        #expect(hexString(SyncCrypto.sha256(plain)) == e.plainSha256Hex)
        let sealed = Self.sealed[id]!.bytes
        #expect(sealed.count == e.sealedSize)
        #expect(SyncFileStream.sealedSize(plainSize: plain.count) == sealed.count)
        #expect(SyncFileStream.plainSize(sealedSize: sealed.count) == plain.count)
        #expect(hexString(sealed.prefix(64)) == e.headerHex)
        #expect(hexString(SyncCrypto.sha256(sealed)) == e.sealedSha256Hex)
        // The same bytes from a source that arrives in awkward pieces.
        var s = try SyncFileStream.Sealer(collKey: collKey, kid: kid, salt: hex(r.saltHex!))
        var streamed = s.header
        var at = 0
        while at < plain.count {
            for seg in try s.push(plain.subdata(in: at..<min(at + 100_003, plain.count))) { streamed.append(seg) }
            at += 100_003
        }
        streamed.append(try s.finish())
        #expect(hexString(SyncCrypto.sha256(streamed)) == e.sealedSha256Hex)
    }

    @Test(arguments: corpus.fileStreamCases.filter { $0.kind == "sizes" }.map(\.id))
    func fileSizes(id: String) {
        let r = corpus.fileStreamCases.first { $0.id == id }!
        for p in r.plainToSealed! { #expect(SyncFileStream.sealedSize(plainSize: p[0]) == p[1]) }
        for p in r.sealedToPlain! { #expect(SyncFileStream.plainSize(sealedSize: p[0]!) == p[1]) }
        #expect(SyncFileStream.sealedSize(plainSize: -1) == nil)
    }

    @Test(arguments: corpus.fileStreamCases.filter { $0.kind == "open" }.map(\.id))
    func fileOpen(id: String) {
        let r = corpus.fileStreamCases.first { $0.id == id }!
        let base = Self.sealed[r.base!]!
        let bytes = Self.applyOps(base.bytes, r.mutate!)
        let collKey = SyncCrypto.deriveCollKey(root: base.root, collection: r.openCollection ?? base.collection)
        let kid = r.expectKidHex.map(hex) ?? SyncCrypto.deriveKid(root: base.root)
        let opened = SyncFileStream.openFile(collKey: collKey, kid: kid, sealed: bytes)
        let e = r.expect!
        // The verdict does not depend on how the bytes arrive.
        var o = SyncFileStream.Opener(collKey: collKey, kid: kid)
        var pieces = Data()
        var piecewise: SyncFileStream.Opened
        do {
            var at = 0
            while at < bytes.count {
                for seg in try o.push(bytes.subdata(in: at..<min(at + 300_007, bytes.count))) { pieces.append(seg) }
                at += 300_007
            }
            pieces.append(try o.finish())
            piecewise = .ok(plain: pieces)
        } catch let f as SyncFileStream.Failure {
            piecewise = .invalid(f.reason)
        } catch {
            piecewise = .invalid(.auth)
        }
        if e.result == "ok" {
            guard case .ok(let plain) = opened else {
                Issue.record("\(id): \(opened)")
                return
            }
            #expect(hexString(SyncCrypto.sha256(plain)) == e.plainSha256Hex)
        } else {
            #expect(opened.reason?.rawValue == e.reason)
        }
        #expect(opened == piecewise)
    }

    @Test(arguments: corpus.fileStreamCases.filter { $0.kind == "range" }.map(\.id))
    func fileRange(id: String) {
        let r = corpus.fileStreamCases.first { $0.id == id }!
        let base = Self.sealed[r.base!]!
        let bytes = Self.applyOps(base.bytes, r.mutate!)
        let collKey = SyncCrypto.deriveCollKey(root: base.root, collection: base.collection)
        let kid = SyncCrypto.deriveKid(root: base.root)
        var reads: [[Int]] = []
        let e = r.expect!
        do {
            let got = try SyncFileStream.openRange(
                collKey: collKey, kid: kid,
                read: { offset, length in
                    reads.append([offset, length])
                    return bytes.subdata(in: min(offset, bytes.count)..<min(offset + length, bytes.count))
                }, sealedSize: bytes.count, start: r.start!, end: r.end!)
            #expect(e.result == "ok")
            #expect(got.count == e.length)
            #expect(hexString(SyncCrypto.sha256(got)) == e.sha256Hex)
            #expect(reads == e.reads)
        } catch let f as SyncFileStream.Failure {
            #expect(e.result == "invalid")
            #expect(f.reason.rawValue == e.reason)
        } catch {
            Issue.record("\(error)")
        }
    }

    @Test func fileStreamBeyondTheCorpus() throws {
        let root = Data((0..<32).map { UInt8($0 &* 5 &+ 3) })
        let collKey = SyncCrypto.deriveCollKey(root: root, collection: "saves")
        let kid = SyncCrypto.deriveKid(root: root)
        let plain = Data((0..<300_000).map { UInt8(truncatingIfNeeded: $0 &* 7 &+ ($0 >> 3)) })
        // A seal draws a fresh salt: two seals of one file differ and both open.
        let a = try SyncFileStream.sealFile(collKey: collKey, kid: kid, plain: plain)
        let b = try SyncFileStream.sealFile(collKey: collKey, kid: kid, plain: plain)
        #expect(a != b && a.subdata(in: 32..<64) != b.subdata(in: 32..<64))
        #expect(SyncFileStream.openFile(collKey: collKey, kid: kid, sealed: a) == .ok(plain: plain))
        #expect(throws: SyncCryptoError.self) {
            try SyncFileStream.encodeHeader(kid: kid.prefix(15), salt: Data(count: 32))
        }
        #expect(throws: SyncCryptoError.self) { try SyncFileStream.encodeHeader(kid: kid, salt: Data(count: 31)) }
        #expect(throws: SyncCryptoError.self) { try SyncFileStream.Sealer(collKey: collKey.prefix(31), kid: kid) }
        // A ranged read that answers the wrong size is `size`.
        #expect(throws: SyncFileStream.Failure(.size)) {
            try SyncFileStream.openRange(
                collKey: collKey, kid: kid, read: { o, l in a.subdata(in: o..<(o + l - 1)) }, sealedSize: a.count,
                start: 0, end: 10)
        }
        let got = try SyncFileStream.openRange(
            collKey: collKey, kid: kid, read: { o, l in a.subdata(in: o..<(o + l)) }, sealedSize: a.count,
            start: 1000, end: 2000)
        #expect(got == plain.subdata(in: 1000..<2000))
        // A slice of a larger Data opens like a copy.
        let padded = Data([9, 9, 9]) + a
        #expect(
            SyncFileStream.openFile(collKey: collKey, kid: kid, sealed: padded.dropFirst(3)) == .ok(plain: plain))
        // Reassembly: the manifest's plain size and SHA-256 over the pieces.
        let digest = SyncCrypto.sha256(plain)
        var ra = try SyncFileStream.Reassembly(plainSize: plain.count, plainSha256: digest)
        var at = 0
        while at < plain.count {
            try ra.push(plain.subdata(in: at..<min(at + 70_001, plain.count)))
            at += 70_001
        }
        try ra.finish()
        ra = try SyncFileStream.Reassembly(plainSize: plain.count, plainSha256: digest)
        try ra.push(plain)
        #expect(throws: SyncFileStream.Failure(.plainSize)) { try ra.push(Data([1])) }
        ra = try SyncFileStream.Reassembly(plainSize: plain.count, plainSha256: digest)
        try ra.push(plain.prefix(100))
        #expect(throws: SyncFileStream.Failure(.plainSize)) { try ra.finish() }
        var wrong = plain
        wrong[5] ^= 1
        ra = try SyncFileStream.Reassembly(plainSize: plain.count, plainSha256: digest)
        try ra.push(wrong)
        #expect(throws: SyncFileStream.Failure(.plainSha256)) { try ra.finish() }
        #expect(throws: SyncFileStream.Failure(.plainSize)) {
            try SyncFileStream.Reassembly(plainSize: SYNC_FILE_MAX_BYTES + 1, plainSha256: digest)
        }
        var empty = try SyncFileStream.Reassembly(plainSize: 0, plainSha256: SyncCrypto.sha256(Data()))
        try empty.finish()
    }
}
