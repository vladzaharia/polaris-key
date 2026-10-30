// @pkey-feature sync.files.delta
// The synced-file primitives against `conformance/corpus/v2/sync-vectors.json` (U-23.S1;
// WIRE-CONTRACT-V5 §13.8.3): cdcCases, cdcEditCases, deltaCases, chunkCases and manifestCases.
// fileStreamCases and transferPlanCases belong to U-23.S2.

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
    let cdcCases: [Cdc]
    let cdcEditCases: [CdcEdit]
    let deltaCases: [Delta]
    let chunkCases: [Chunk]
    let manifestCases: [Manifest]
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
}
