// @pkey-feature packs.index.files packs.apply.full packs.apply.file packs.apply.delta packs.state packs.record update.content packs.index.chunks packs.apply.chunk packs.delta.feed
//
// The content corpus (`conformance/corpus/v2/content/cases.json`, plans/P4-01.md §4.4, P4-04)
// through PolarisKeyPacks' production code:
//
//   blobs             every file under content/blobs/ against the `blobs` table (harness check)
//   pathCases         §2.7's path rules                        → checkPaths
//   filesIndexCases   §2.7's parseFilesIndex, steps 1–5         → parseFilesIndex
//   packSetIdCases    §2.9's packSetId                          → packSetId
//   stampCases        §2.8's content stamp                      → parseContentStamp, and
//                     `expect.holds` (when present)             → holdsOf (stampHolds)
//   frameWindowCases  §2.7 rule 3's header window               → frameWindow
//   applyCases        §2.9's appliers, verdicts and counters    → applyFull, applyDelta, applyFile,
//                                                                  applyChunk
//   chunkIndexCases   plans/P4-10.md §2.3's parser               → parseChunkIndex
//   feedDeltaApplyCases plans/P4-29.md §4.4's merged feed delta   → withFeedDeltas, applyDelta
//
// Content corpus v2 (plans/P4-10.md §4.3) adds `chunkIndexCases` and eight `strategy: chunk`
// apply cases, run through P4-11's `parseChunkIndex` and `applyChunk`: seeds parsed unbound
// (`parseChunkIndexBytes`), a fetcher that answers each single-range request with
// `objects[sha256]` sliced to the range and clipped at the object's end, and an in-memory output.
//
// `content/` is read from the checkout through `CorpusLocator` (plans/P4-01.md §4.1, §8.4), like
// the rest of the corpus. Verdicts are compared as JSON values with integral floats normalised,
// exactly as the Node runner compares them.

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

/// The checkout's `conformance/corpus/v2/content/`.
enum ContentCorpus {
    static var dir: URL { CorpusLocator.contentDir }

    static func load() throws -> [String: JSONValue] {
        let data = try Data(contentsOf: dir.appendingPathComponent("cases.json"))
        return try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: data).objectValue)
    }

    /// Every file under `content/blobs/`, keyed by its path there.
    static func blobs() throws -> [String: [UInt8]] {
        let root = dir.appendingPathComponent("blobs", isDirectory: true).standardizedFileURL
        var out: [String: [UInt8]] = [:]
        let e = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]))
        for case let url as URL in e {
            guard (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { continue }
            let rel = String(url.standardizedFileURL.path.dropFirst(root.path.count + 1))
            out[rel] = [UInt8](try Data(contentsOf: url))
        }
        return out
    }
}

/// A JSON value with integral doubles as ints, for comparisons.
func normalisedJSON(_ v: JSONValue) -> JSONValue {
    switch v {
    case .double(let d) where d == d.rounded() && abs(d) < 9.007_199_254_740_992e15: return .int(Int(d))
    case .array(let a): return .array(a.map(normalisedJSON))
    case .object(let o): return .object(o.mapValues(normalisedJSON))
    default: return v
    }
}

/// libzstd without its streaming decode: `applyFull` then takes its one-buffer path.
struct OneShotZstd: ZstdPort {
    let base = LibZstd()
    var pointerBits: Int { base.pointerBits }
    func decode(_ frame: [UInt8], size: Int) throws -> [UInt8] { try base.decode(frame, size: size) }
    func decodeWithPrefix(_ frame: [UInt8], prefix: [UInt8], size: Int, windowLogMax: Int) throws -> [UInt8] {
        try base.decodeWithPrefix(frame, prefix: prefix, size: size, windowLogMax: windowLogMax)
    }
}

final class ContentConformanceTests: XCTestCase {
    static let zstd = LibZstd()
    /// The backends the decoding sections run under, as the Node runner runs one per decoder.
    static let backends: [(label: String, zstd: any ZstdPort)] = [
        ("libzstd (streaming full)", LibZstd()), ("libzstd (one-shot)", OneShotZstd()),
    ]

    override class func setUp() {
        print(
            "content corpus runner: Swift \(swiftVersionString), \(libzstdVersion.isEmpty ? "libzstd ?" : "libzstd \(libzstdVersion)")"
        )
    }

    static var swiftVersionString: String {
        #if swift(>=6.4)
        return ">= 6.4"
        #elseif swift(>=6.0)
        return "6.x"
        #else
        return "< 6"
        #endif
    }

    /// Materialise a `<ref>`: the blob (decoded when `codec` is `zstd`) or the text, then mutated.
    func materialise(_ ref: JSONValue, _ blobs: [String: [UInt8]]) throws -> [UInt8] {
        let o = try XCTUnwrap(ref.objectValue)
        var bytes: [UInt8]
        if let text = o["text"]?.stringValue {
            bytes = Array(text.utf8)
        } else {
            let name = try XCTUnwrap(o["blob"]?.stringValue)
            let raw = try XCTUnwrap(blobs[name], "no blob \(name)")
            bytes = o["codec"]?.stringValue == "zstd"
                ? try Self.zstd.decode(raw, size: XCTUnwrap(o["size"]?.intValue)) : raw
        }
        for m in o["mutate"]?.arrayValue ?? [] {
            let mo = try XCTUnwrap(m.objectValue)
            switch mo["op"]?.stringValue {
            case "truncate": bytes = Array(bytes.prefix(try XCTUnwrap(mo["length"]?.intValue)))
            case "xor":
                let at = try XCTUnwrap(mo["offset"]?.intValue)
                bytes[at] ^= UInt8(try XCTUnwrap(mo["value"]?.intValue))
            case "putU16", "putU32", "putU64":
                // plans/P4-10.md §4.2: little-endian; a putU64 value is below 2^53.
                let at = try XCTUnwrap(mo["offset"]?.intValue)
                let value = UInt64(try XCTUnwrap(mo["value"]?.intValue))
                let width = mo["op"]?.stringValue == "putU16" ? 2 : mo["op"]?.stringValue == "putU32" ? 4 : 8
                for k in 0..<width { bytes[at + k] = UInt8((value >> (8 * UInt64(k))) & 0xff) }
            default: throw NSError(domain: "content", code: 1, userInfo: [NSLocalizedDescriptionKey: "unknown mutation \(m)"])
            }
        }
        return bytes
    }

    func testVersionAndSections() throws {
        let c = try ContentCorpus.load()
        XCTAssertEqual(c["contentCorpusVersion"], .int(2))
        XCTAssertEqual(c["pathCases"]?.arrayValue?.count, 18)
        XCTAssertEqual(c["filesIndexCases"]?.arrayValue?.count, 15)
        XCTAssertEqual(c["chunkIndexCases"]?.arrayValue?.count, 22)
        XCTAssertEqual(c["packSetIdCases"]?.arrayValue?.count, 7)
        XCTAssertEqual(c["stampCases"]?.arrayValue?.count, 10)
        XCTAssertEqual(c["frameWindowCases"]?.arrayValue?.count, 13)
        XCTAssertEqual(c["applyCases"]?.arrayValue?.count, 27)
    }

    /// plans/P4-10.md §4.3: the eight chunk apply cases, every one run (never skipped).
    static let chunkApplyCases = [
        "chunk-v1-to-v2", "chunk-no-seed", "chunk-tampered-zstd", "chunk-tampered-raw",
        "chunk-bundle-truncated", "chunk-seed-tampered", "chunk-seed-tampered-repair",
        "chunk-index-for-other-payload",
    ]

    func testChunkApplyCaseIdsAreExactlyTheCorpusChunkCases() throws {
        let c = try ContentCorpus.load()
        let apply = try XCTUnwrap(c["applyCases"]?.arrayValue).compactMap { $0.objectValue }
            .filter { $0["strategy"]?.stringValue == "chunk" }.compactMap { $0["id"]?.stringValue }
        XCTAssertEqual(apply, Self.chunkApplyCases)
    }

    // @pkey-feature packs.index.chunks
    /// plans/P4-10.md §2.3: every `chunkIndexCases` vector through `parseChunkIndex`, under every
    /// zstd backend.
    func testChunkIndexCases() throws {
        let blobs = try ContentCorpus.blobs()
        let cases = try XCTUnwrap(ContentCorpus.load()["chunkIndexCases"]?.arrayValue)
        XCTAssertEqual(cases.count, 22)
        for (label, zstd) in Self.backends {
            for c in cases {
                let o = try XCTUnwrap(c.objectValue)
                let stored = try materialise(o["stored"]!, blobs)
                let r = parseChunkIndex(
                    stored, ref: PackObjectRef(json: o["chunks"]), payload: PackPayload(json: o["payload"]),
                    decode: { try zstd.decode($0, size: $1) })
                XCTAssertEqual(r.json, normalisedJSON(o["expect"]!), "[\(label)] \(o["id"]!): \(o["description"]!)")
            }
        }
    }

    /// The u64 rule (plans/P4-10.md §2.3): low word first, saturated at 2^53, at any offset.
    func testChunkU64RuleAtUnalignedOffsets() {
        for pad in 0..<8 {
            var b = [UInt8](repeating: 0xee, count: pad)
            b += [0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]
            XCTAssertEqual(readChunkU64(b, pad), 2 * 4_294_967_296 + 1)
            b = [UInt8](repeating: 0, count: pad) + [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00]
            XCTAssertEqual(readChunkU64(b, pad), 9_007_199_254_740_991)
            b = [UInt8](repeating: 0, count: pad) + [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00]
            XCTAssertEqual(readChunkU64(b, pad), CHUNKS_U64_MAX)
            b = [UInt8](repeating: 0, count: pad) + [UInt8](repeating: 0xff, count: 8)
            XCTAssertEqual(readChunkU64(b, pad), CHUNKS_U64_MAX)
        }
    }

    // @pkey-feature packs.apply.chunk
    /// plans/P4-10.md §2.5: the eight `strategy: chunk` apply cases through `applyChunk`, under
    /// every zstd backend. Seeds are parsed unbound; the fetcher answers each range with
    /// `objects[bundle]` sliced to it and clipped at the object's end; the output is memory.
    func testChunkApplyCases() async throws {
        let blobs = try ContentCorpus.blobs()
        let cases = try XCTUnwrap(ContentCorpus.load()["applyCases"]?.arrayValue).compactMap(\.objectValue)
            .filter { $0["strategy"]?.stringValue == "chunk" }
        XCTAssertEqual(cases.count, 8)
        for (label, zstd) in Self.backends {
            for o in cases {
                let id = o["id"]!.stringValue!
                var store: [String: [UInt8]] = [:]
                for (h, src) in o["objects"]?.objectValue ?? [:] { store[h] = try materialise(src, blobs) }
                var seeds: [ChunkSeed] = []
                for sd in o["seeds"]?.arrayValue ?? [] {
                    let so = try XCTUnwrap(sd.objectValue)
                    if case .ok(let index) = parseChunkIndexBytes(try materialise(so["index"]!, blobs), payload: nil) {
                        seeds.append(ChunkSeed(index: index, payload: MemorySource(try materialise(so["payload"]!, blobs))))
                    }
                }
                let variant = try XCTUnwrap(PackVariant(json: o["variant"]!), id)
                let objects = store
                let output = MemoryChunkOutput(size: variant.payload.size)
                let r = await applyChunk(
                    variant, seeds: seeds,
                    ApplyChunkPorts(
                        objects: { h in objects[h].map { MemorySource($0) } }, zstd: zstd,
                        fetchRange: { req in
                            let b = objects[req.bundle] ?? []
                            let lo = min(req.offset, b.count)
                            let hi = min(req.offset + req.length, b.count)
                            let part = Array(b[lo..<max(lo, hi)])
                            return .ok(AsyncThrowingStream { c in
                                c.yield(part)
                                c.finish()
                            })
                        },
                        output: output),
                    repair: o["repair"]?.boolValue == true)
                XCTAssertEqual(r.verdict.json, normalisedJSON(o["expect"]!), "[\(label)] \(id): \(o["description"]!)")
            }
        }
    }

    /// The `<ref>` inputs (the `put*` mutations included) materialise to the bytes each case's
    /// `chunks` ref names, except in `chunks-ref-tampered`.
    func testChunkIndexCaseInputs() throws {
        let blobs = try ContentCorpus.blobs()
        for c in try XCTUnwrap(ContentCorpus.load()["chunkIndexCases"]?.arrayValue) {
            let o = try XCTUnwrap(c.objectValue)
            let id = o["id"]!.stringValue!
            let stored = try materialise(o["stored"]!, blobs)
            let ref = try XCTUnwrap(o["chunks"]?.objectValue)
            let matches = stored.count == ref["bytes"]?.intValue && sha256Of(stored) == ref["sha256"]?.stringValue
            XCTAssertEqual(matches, id != "chunks-ref-tampered", id)
        }
    }

    func testBlobsMatchTheTableAndNothingElseIsThere() throws {
        let c = try ContentCorpus.load()
        let table = try XCTUnwrap(c["blobs"]?.objectValue)
        let blobs = try ContentCorpus.blobs()
        XCTAssertEqual(blobs.keys.sorted(), table.keys.sorted())
        for (name, want) in table {
            let got = try XCTUnwrap(blobs[name], name)
            XCTAssertEqual(got.count, want.objectValue?["size"]?.intValue, name)
            XCTAssertEqual(sha256Of(got), want.objectValue?["sha256"]?.stringValue, name)
        }
    }

    func testPathCases() throws {
        for c in try XCTUnwrap(ContentCorpus.load()["pathCases"]?.arrayValue) {
            let o = try XCTUnwrap(c.objectValue)
            let paths = try XCTUnwrap(o["paths"]?.arrayValue).map { $0.stringValue ?? "" }
            XCTAssertEqual(checkPaths(paths).json, normalisedJSON(o["expect"]!), "\(o["id"]!): \(o["description"]!)")
        }
    }

    func testFilesIndexCases() throws {
        let blobs = try ContentCorpus.blobs()
        for c in try XCTUnwrap(ContentCorpus.load()["filesIndexCases"]?.arrayValue) {
            let o = try XCTUnwrap(c.objectValue)
            let stored = try materialise(o["stored"]!, blobs)
            let ref = try XCTUnwrap(PackFilesRef(json: o["files"]))
            let payload = try XCTUnwrap(PackPayload(json: o["payload"]))
            let r = parseFilesIndex(stored, ref: ref, payload: payload, decode: { try Self.zstd.decode($0, size: $1) })
            let verdict: JSONValue
            switch r {
            case .ok(let i): verdict = .object(["ok": .bool(true), "files": .int(i.files.count)])
            case .refused(let e, let p):
                var v: [String: JSONValue] = ["ok": .bool(false), "error": .string(e)]
                if let p { v["path"] = .string(p) }
                verdict = .object(v)
            }
            XCTAssertEqual(verdict, normalisedJSON(o["expect"]!), "\(o["id"]!): \(o["description"]!)")
        }
    }

    func testApplyCases() throws {
        let blobs = try ContentCorpus.blobs()
        let cases = try XCTUnwrap(ContentCorpus.load()["applyCases"]?.arrayValue)
        XCTAssertEqual(cases.count, 27)
        for (label, zstd) in Self.backends {
        for c in cases {
            let o = try XCTUnwrap(c.objectValue)
            let id = o["id"]!.stringValue!
            // Run by testChunkApplyCases (async), whose ids are asserted exact.
            if o["strategy"]?.stringValue == "chunk" { continue }
            var store: [String: [UInt8]] = [:]
            for (h, src) in o["objects"]?.objectValue ?? [:] { store[h] = try materialise(src, blobs) }
            let objects: ObjectPort = { h in store[h].map { MemorySource($0) } }
            var base: [UInt8] = []
            var installed: [InstalledFile] = []
            if let inst = o["installed"]?.objectValue {
                base = try materialise(inst["payload"]!, blobs)
                let idxBytes = try materialise(inst["files"]!, blobs)
                let idx = try XCTUnwrap(FilesIndexDoc(json: JSONDecoder().decode(JSONValue.self, from: Data(idxBytes))))
                let whole = MemorySource(base)
                installed = idx.files.map {
                    InstalledFile(path: $0.path, sha256: $0.sha256, size: $0.size, source: sliceSource(whole, $0.offset ?? 0, $0.size))
                }
            }
            let variant = try XCTUnwrap(PackVariant(json: o["variant"]!), id)
            let ports = ApplyPorts(objects: objects, zstd: zstd)
            let r: ApplyResult
            switch o["strategy"]?.stringValue {
            case "full": r = applyFull(variant, ports)
            case "delta":
                r = applyDelta(
                    variant, try XCTUnwrap(o["delta"]?.intValue), base: MemorySource(base), ports,
                    skipBaseCheck: o["skipBaseCheck"]?.boolValue == true)
            case "file": r = applyFile(variant, o["delta"]?.intValue, installed: installed, ports)
            default:
                XCTFail("\(id): unknown strategy \(String(describing: o["strategy"]))")
                continue
            }
            XCTAssertEqual(r.verdict.json, normalisedJSON(o["expect"]!), "[\(label)] \(id): \(o["description"]!)")
        }
        }
    }

    func testFeedDeltaApplyCases() throws {
        let blobs = try ContentCorpus.blobs()
        let cases = try XCTUnwrap(ContentCorpus.load()["feedDeltaApplyCases"]?.arrayValue)
        XCTAssertEqual(cases.count, 4)
        for (label, zstd) in Self.backends {
            for c in cases {
                let o = try XCTUnwrap(c.objectValue)
                let id = o["id"]!.stringValue!
                var store: [String: [UInt8]] = [:]
                for (h, src) in o["objects"]?.objectValue ?? [:] { store[h] = try materialise(src, blobs) }
                let objects: ObjectPort = { h in store[h].map { MemorySource($0) } }
                let variant = try XCTUnwrap(PackVariant(json: o["variant"]!), id)
                let merged = withFeedDeltas(variant, rawFeedDeltas(o["deltas"]))
                XCTAssertEqual(merged.feedIds.count, 1, id)
                let k = try XCTUnwrap(
                    merged.variant.deltas.firstIndex { $0.scope == "payload" && $0.id == merged.feedIds.first }, id)
                let base = try materialise(try XCTUnwrap(o["installed"]?.objectValue?["payload"]), blobs)
                let r = applyDelta(merged.variant, k, base: MemorySource(base), ApplyPorts(objects: objects, zstd: zstd))
                XCTAssertEqual(r.verdict.json, normalisedJSON(o["expect"]!), "[\(label)] \(id): \(o["description"]!)")
            }
        }
    }

    func testPackSetIdCases() throws {
        for c in try XCTUnwrap(ContentCorpus.load()["packSetIdCases"]?.arrayValue) {
            let o = try XCTUnwrap(c.objectValue)
            // A malformed entry (a non-string member) makes the set invalid, as in client-core.
            var entries: [PackSetEntry] = []
            var malformed = false
            for e in o["entries"]?.arrayValue ?? [] {
                guard let eo = e.objectValue, let p = eo["packId"]?.stringValue, let r = eo["releaseSha256"]?.stringValue
                else {
                    malformed = true
                    continue
                }
                entries.append(PackSetEntry(packId: p, releaseSha256: r))
            }
            let got: JSONValue = (malformed ? nil : packSetId(entries)).map { .string($0) } ?? .null
            XCTAssertEqual(
                JSONValue.object(["packSetId": got]), normalisedJSON(o["expect"]!), "\(o["id"]!): \(o["description"]!)")
        }
    }

    func testStampCases() throws {
        for c in try XCTUnwrap(ContentCorpus.load()["stampCases"]?.arrayValue) {
            let o = try XCTUnwrap(c.objectValue)
            // `parseContentStamp`'s result is unchanged by P4-13; holds are read beside it
            // (`holdsOf`, plans/P4-13.md §2.4), and only checked where `expect.holds` is present.
            var expect = try XCTUnwrap(o["expect"]?.objectValue)
            let holds = expect.removeValue(forKey: "holds")
            let stamp = try XCTUnwrap(o["stamp"]?.stringValue)
            XCTAssertEqual(
                parseContentStamp(stamp).json, normalisedJSON(.object(expect)),
                "\(o["id"]!): \(o["description"]!)")
            guard let holds else { continue }
            XCTAssertEqual(
                stampHolds(stamp).map { JSONValue.array($0.map(\.json)) } ?? .null, normalisedJSON(holds),
                "\(o["id"]!) holds: \(o["description"]!)")
        }
    }

    func testFrameWindowCases() throws {
        for c in try XCTUnwrap(ContentCorpus.load()["frameWindowCases"]?.arrayValue) {
            let o = try XCTUnwrap(c.objectValue)
            let w = frameWindow(hexBytes(try XCTUnwrap(o["header"]?.stringValue)))
            XCTAssertEqual(
                JSONValue.object(["window": w.map { .int($0) } ?? .null]), normalisedJSON(o["expect"]!),
                "\(o["id"]!): \(o["description"]!)")
        }
    }
}

/// An in-memory chunk output of a fixed size (the corpus runner's `new Uint8Array(size)`).
final class MemoryChunkOutput: ChunkOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var bytes: [UInt8]

    init(size: Int) { bytes = [UInt8](repeating: 0, count: size) }

    func write(_ offset: Int, _ data: [UInt8]) throws {
        lock.lock()
        defer { lock.unlock() }
        guard offset >= 0, offset + data.count <= bytes.count else { throw PackPortError.short }
        bytes.replaceSubrange(offset..<(offset + data.count), with: data)
    }

    func read(_ offset: Int, _ length: Int) throws -> [UInt8] {
        lock.lock()
        defer { lock.unlock() }
        let lo = min(max(offset, 0), bytes.count)
        let hi = min(max(offset + length, lo), bytes.count)
        return Array(bytes[lo..<hi])
    }
}
