// @pkey-feature packs.apply.chunk packs.index.chunks
//
// P4-11's engine integration in Swift (design: plans/P4-10.md §2.5; CONTENT §8.1, §10): the chunk
// strategy end to end over a fake blob server that honours bounded `Range`, `If-Range` and
// `ETag: "<sha256>"`, records every request, and can answer `200` to a range request or cut the
// body of the Nth one. The corpus (`content/cases.json`, `applyCases` and `chunkIndexCases`) pins
// the applier's verdicts and counters; these pin the I/O around it: the seed-index store, the
// fetch rule, cross-pack seeds, the fallback on a refused range, the run journal's resume, and the
// delegated tree that never plans chunk.
//
// Fixtures are synthetic `pkey-chunks/1` containers: 64 KiB chunks of deterministic pseudo-random
// bytes, stored raw (`clen == len`), so the planner's request weight (16 KiB per request) leaves
// chunk the cheapest strategy once a seed exists.

import CryptoKit
import Foundation
import PolarisKeyCore
@testable import PolarisKeyPacks
import XCTest

let CHUNK = 64 * 1024

/// 64 KiB of xorshift bytes seeded by `label`.
private func chunkBytes(_ label: String) -> [UInt8] {
    var x: UInt64 = 0x9e37_79b9_7f4a_7c15
    for b in label.utf8 { x = (x ^ UInt64(b)) &* 0x100_0000_01b3 }
    var out = [UInt8](repeating: 0, count: CHUNK)
    for i in 0..<CHUNK {
        x ^= x << 13
        x ^= x >> 7
        x ^= x << 17
        out[i] = UInt8(truncatingIfNeeded: x >> 24)
    }
    return out
}

private func le32(_ v: Int) -> [UInt8] { (0..<4).map { UInt8((v >> (8 * $0)) & 0xff) } }
private func le64(_ v: Int) -> [UInt8] { le32(v & 0xffff_ffff) + le32(v >> 32) }

/// A `pkey-chunks/1` writer: header, 48-byte records, bundle table (raw chunks, `clen == len`).
private func writeChunkIndex(
    payload: [UInt8], records: [(id: [UInt8], len: Int, bundle: Int, offset: Int)], bundles: [[UInt8]]
) -> [UInt8] {
    var b: [UInt8] = Array("PKEYCHNK".utf8)
    b += [1, 0, 48, 0] + le32(0) + le32(records.count) + le32(bundles.count) + le64(payload.count)
    b += Array(SHA256.hash(data: payload))
    for r in records { b += r.id + le32(r.len) + le32(r.len) + le32(r.bundle) + le32(r.offset) }
    for bundle in bundles { b += Array(SHA256.hash(data: bundle)) + le64(bundle.count) + le64(0) }
    return b
}

/// A `test.blob` container pack release whose payload is `chunks` (by label) and whose chunk
/// index places them in `bundles` (each a list of labels, laid out raw in order). Every label the
/// payload uses must appear in some bundle.
struct ChunkPack: Sendable {
    let packId: String
    let version: String
    let seq: Int
    let jws: String
    let recordSha256: String
    let payload: [UInt8]
    let payloadSha256: String
    let chunksSha256: String
    let fullSha256: String
    let bundleShas: [String]
    /// Each bundle's byte offset of each label.
    let bundleLayout: [[String: Int]]
    let objects: [String: [UInt8]]
    let chunkIndex: [UInt8]
    let labels: [String]

    var target: PackTarget {
        PackTarget(pack: packId, release: ReleasePin(sha256: recordSha256, seq: seq, version: version))
    }
    var pin: ContentPin { ContentPin(pack: packId, sha256: recordSha256, seq: seq, version: version) }
}

func chunkPack(
    _ packId: String, version: String, seq: Int, chunks labels: [String], bundles: [[String]]
) -> ChunkPack {
    let payload = labels.flatMap(chunkBytes)
    var bundleBytes: [[UInt8]] = []
    var layout: [[String: Int]] = []
    for b in bundles {
        var bytes: [UInt8] = []
        var at: [String: Int] = [:]
        for l in b {
            at[l] = bytes.count
            bytes += chunkBytes(l)
        }
        bundleBytes.append(bytes)
        layout.append(at)
    }
    let records = labels.map { l -> (id: [UInt8], len: Int, bundle: Int, offset: Int) in
        let j = layout.firstIndex { $0[l] != nil }!
        return (Array(SHA256.hash(data: chunkBytes(l))), CHUNK, j, layout[j][l]!)
    }
    let index = writeChunkIndex(payload: payload, records: records, bundles: bundleBytes)
    let sha = PackFixtures.sha as ([UInt8]) -> String
    let filesIndex = Array(
        canonicalJSON(
            .object([
                "format": .string("pkey-files/1"), "layout": .string("container"),
                "payload": .object(["size": .int(payload.count), "sha256": .string(sha(payload))]),
                "files": .array([
                    .object([
                        "path": .string("payload.bin"), "size": .int(payload.count), "sha256": .string(sha(payload)),
                        "offset": .int(0),
                        "blob": .object([
                            "sha256": .string(sha(payload)), "bytes": .int(payload.count), "codec": .string("none"),
                        ]),
                    ])
                ]),
            ])
        ).utf8)
    var objects: [String: [UInt8]] = [sha(payload): payload, sha(index): index, sha(filesIndex): filesIndex, sha([]): []]
    for b in bundleBytes { objects[sha(b)] = b }
    let variant: JSONValue = .object([
        "variant": .object([:]),
        "payload": .object(["size": .int(payload.count), "sha256": .string(sha(payload))]),
        "full": .object([
            "sha256": .string(sha(payload)), "bytes": .int(payload.count), "size": .int(payload.count),
            "codec": .string("none"),
        ]),
        "files": .object([
            "format": .string("pkey-files/1"), "layout": .string("container"), "sha256": .string(sha(filesIndex)),
            "bytes": .int(filesIndex.count), "size": .int(filesIndex.count), "codec": .string("none"),
            "gaps": .object(["sha256": .string(sha([])), "bytes": .int(0), "size": .int(0), "codec": .string("none")]),
        ]),
        "chunks": .object([
            "format": .string(CHUNKS_FORMAT), "sha256": .string(sha(index)), "bytes": .int(index.count),
            "size": .int(index.count), "codec": .string("none"),
        ]),
    ])
    let record: JSONValue = .object([
        "schemaVersion": .int(1), "aud": .string(PackFixtures.product), "deliverable": .string(packId),
        "kind": .string("pack"), "version": .string(version), "seq": .int(seq), "issuedAt": .int(1_759_300_000 + seq),
        "type": .string("test.blob"), "formatVersion": .int(1), "handler": .object(["activation": .string("hot")]),
        "variants": .array([variant]),
    ])
    let jws = PackFixtures.sign(record)
    return ChunkPack(
        packId: packId, version: version, seq: seq, jws: jws, recordSha256: recordHash(jws), payload: payload,
        payloadSha256: sha(payload), chunksSha256: sha(index), fullSha256: sha(payload),
        bundleShas: bundleBytes.map(sha), bundleLayout: layout, objects: objects, chunkIndex: index, labels: labels)
}

/// A hot container handler for `test.blob`.
struct BlobHandler: PackHandler {
    var type: String { "test.blob" }
    var layout: String { "container" }
    var activation: String { "hot" }
    func supports(_ formatVersion: Int) -> Bool { formatVersion == 1 }
}

/// The fake blob server: records and objects, bounded `Range` with `If-Range`, `ETag` on every
/// answer. `rangeAs200` answers a range request with the whole object; `cutRange` cuts the body
/// of the Nth range request (1-based) half-way by throwing.
final class ChunkServer: @unchecked Sendable {
    private let lock = NSLock()
    private var records: [String: String] = [:]
    private var objects: [String: [UInt8]] = [:]
    private var _calls: [ObjectRequest] = []
    private var _rangeAs200 = false
    private var _cutRange: Int?
    private var _otherEtag = false
    private var rangeCount = 0

    init(_ packs: [ChunkPack], trees: [TreePack] = []) {
        for p in packs {
            records[p.recordSha256] = p.jws
            for (h, b) in p.objects { objects[h] = b }
        }
        for t in trees {
            records[t.recordSha256] = t.jws
            for (h, b) in t.objects { objects[h] = b }
        }
    }

    private func locked<R>(_ f: () -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return f()
    }

    var calls: [ObjectRequest] {
        get { locked { _calls } }
        set { locked { _calls = newValue } }
    }
    var rangeCalls: [ObjectRequest] { calls.filter { $0.length != nil } }
    var rangeAs200: Bool {
        get { locked { _rangeAs200 } }
        set { locked { _rangeAs200 = newValue } }
    }
    /// Answer range requests with a `206` carrying another object's `ETag`.
    var otherEtag: Bool {
        get { locked { _otherEtag } }
        set { locked { _otherEtag = newValue } }
    }
    var cutRange: Int? {
        get { locked { _cutRange } }
        set { locked { _cutRange = newValue; rangeCount = 0 } }
    }

    var fetchRecord: RecordFetch {
        { [self] h in locked { records[h] }.map { .ok($0) } ?? .failed("not_found") }
    }

    var fetchObject: ObjectFetch { { [self] req in serve(req) } }

    private static func body(_ bytes: [UInt8], cutAt: Int? = nil) -> AsyncThrowingStream<[UInt8], Error> {
        AsyncThrowingStream { c in
            var at = 0
            let stop = cutAt ?? bytes.count
            while at < stop {
                let n = min(4096, stop - at)
                c.yield(Array(bytes[at..<(at + n)]))
                at += n
            }
            if cutAt != nil {
                c.finish(throwing: URLError(.networkConnectionLost))
            } else {
                c.finish()
            }
        }
    }

    func serve(_ req: ObjectRequest) -> ObjectResponse {
        let (b, as200, cut, other): ([UInt8]?, Bool, Bool, Bool) = locked {
            _calls.append(req)
            var cut = false
            if req.length != nil {
                rangeCount += 1
                cut = _cutRange == rangeCount
            }
            return (objects[req.sha256], _rangeAs200, cut, _otherEtag)
        }
        let tag = "\"\(req.sha256)\""
        guard let b else {
            return ObjectResponse(status: 404, contentRange: nil, chunks: AsyncThrowingStream { $0.finish() })
        }
        let validated = req.ifRange == tag
        if let length = req.length {
            if as200 || !validated {
                return ObjectResponse(status: 200, contentRange: nil, etag: tag, chunks: Self.body(b))
            }
            let lo = min(req.offset, b.count)
            let hi = min(req.offset + length, b.count)
            let part = Array(b[lo..<max(lo, hi)])
            return ObjectResponse(
                status: 206, contentRange: "bytes \(lo)-\(max(lo, hi) - 1)/\(b.count)",
                etag: other ? "\"\(String(repeating: "0", count: 64))\"" : tag,
                chunks: Self.body(part, cutAt: cut ? part.count / 2 : nil))
        }
        if req.offset > 0 && validated {
            return ObjectResponse(
                status: 206, contentRange: "bytes \(req.offset)-\(b.count - 1)/\(b.count)", etag: tag,
                chunks: Self.body(Array(b[req.offset...])))
        }
        return ObjectResponse(status: 200, contentRange: nil, etag: tag, chunks: Self.body(b))
    }
}

private let chunkPlans = Locked2(0)

private func chunkEngine(
    _ server: ChunkServer, storage: any PackStorage, pins: [ContentPin],
    state: any PackStateStore = memoryPackStateStore()
) -> PackEngine {
    PackEngine(
        PackEngineOptions(
            product: PackFixtures.product, releaseKeys: PackFixtures.releaseKeys,
            productTrust: { PackFixtures.productTrust },
            stamp: AppContent(contentApi: 1, pins: pins, expects: []), zstd: LibZstd(), patchMethods: [],
            memBudget: 1 << 30, storage: storage, state: state, fetchRecord: server.fetchRecord,
            fetchObject: server.fetchObject, now: { 1_759_400_000 },
            newPlanId: { "cplan-\(chunkPlans.with { $0 += 1; return $0 })" }, handlers: [BlobHandler()]))
}

private func tempDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("pkey-chunk-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

/// The installed payload's bytes, through the storage.
private func installedBytes(_ storage: any PackStorage, _ i: PackInstall) throws -> [UInt8] {
    try readAll(try XCTUnwrap(try storage.installed(i)?.payload))
}

final class ChunkSyncTests: XCTestCase {
    /// v1 = a b c d e f in bundle B1; v2 = a g c h i f j, whose bundle B2 holds g x h i y j
    /// (x and y unused filler), so v2's runs are [g], [h i], [j].
    private func releases() -> (v1: ChunkPack, v2: ChunkPack) {
        let v1 = chunkPack(
            "djdl.music", version: "1.0.0", seq: 1, chunks: ["a", "b", "c", "d", "e", "f"],
            bundles: [["a", "b", "c", "d", "e", "f"]])
        let v2 = chunkPack(
            "djdl.music", version: "1.1.0", seq: 2, chunks: ["a", "g", "c", "h", "i", "f", "j"],
            bundles: [["a", "b", "c", "d", "e", "f"], ["g", "x", "h", "i", "y", "j"]])
        return (v1, v2)
    }

    /// The planner's chunk requests for v2 over v1's seed (the index plus one per run).
    private func plannedChunkRequests(_ v1: ChunkPack, _ v2: ChunkPack) throws -> Int {
        let rec = try XCTUnwrap(PackRecordDoc(json: XCTUnwrap(verifiedPayloadOf(v2.jws))))
        let variant = rec.variants[0]
        let idx = try XCTUnwrap(parseChunkIndexBytes(v2.chunkIndex, payload: variant.payload).index)
        let seed = try XCTUnwrap(parseChunkIndexBytes(v1.chunkIndex, payload: nil).index)
        let t = planTarget(variant, recordSha256: v2.recordSha256, filesIndex: nil, chunkIndex: idx.planIndex)
        let p = plan(
            target: t, installed: [PlanInstalled(release: v1.recordSha256, payloadSha256: v1.payloadSha256, chunks: seed.records.map(\.id))],
            caps: PlanCaps(strategies: PACK_DEFAULT_STRATEGIES, patchMethods: [], transports: [], memBudget: 1 << 30, freeDisk: 1 << 30))
        guard case .chosen(let c, _, _) = p else { throw XCTSkip("no plan") }
        XCTAssertEqual(c.strategy, "chunk")
        return c.requests
    }

    // 1 + 2: v1 installs by full and becomes a seed; v2 installs by chunk with one range per run.
    func testFullFirstThenChunkFromTheStoredSeedIndex() async throws {
        let (v1, v2) = releases()
        let server = ChunkServer([v1, v2])
        let root = tempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = DirPackStorage(root: root)
        let e = chunkEngine(server, storage: storage, pins: [v1.pin])
        _ = try await e.load()

        let i1 = try await e.ensure([v1.packId])[0]
        XCTAssertEqual(try installedBytes(storage, i1), v1.payload)
        // No seed yet: no range request, the full object was fetched, and v1's index is now kept.
        XCTAssertTrue(server.rangeCalls.isEmpty)
        XCTAssertTrue(server.calls.contains { $0.sha256 == v1.fullSha256 })
        XCTAssertEqual(try storage.chunkIndexes?.get(v1.chunksSha256), v1.chunkIndex)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("index/\(v1.chunksSha256)").path))

        server.calls = []
        let i2 = try await e.ensureReleases([v2.target])[0]
        XCTAssertEqual(i2.payloadSha256, v2.payloadSha256)
        XCTAssertEqual(sha256Of(try installedBytes(storage, i2)), v2.payloadSha256)
        // Never the full object; one bounded range per run, validated on the bundle's hash.
        XCTAssertFalse(server.calls.contains { $0.sha256 == v2.fullSha256 })
        let ranges = server.rangeCalls
        XCTAssertEqual(ranges.count, try plannedChunkRequests(v1, v2) - 1)
        XCTAssertEqual(ranges.count, 3)
        let b2 = v2.bundleShas[1]
        let lay = v2.bundleLayout[1]
        XCTAssertEqual(ranges.map(\.sha256), [b2, b2, b2])
        XCTAssertEqual(ranges.map(\.offset), [lay["g"]!, lay["h"]!, lay["j"]!])
        XCTAssertEqual(ranges.map(\.length), [CHUNK, 2 * CHUNK, CHUNK])
        XCTAssertTrue(ranges.allSatisfy { $0.ifRange == "\"\($0.sha256)\"" })
        // v2's own index is a seed now; both stay while v1 is `previous`.
        let kept = Set(try XCTUnwrap(storage.chunkIndexes).list())
        XCTAssertEqual(kept, [v1.chunksSha256, v2.chunksSha256])
        // The plan's staging (journal included) is gone after the commit.
        XCTAssertTrue(try storage.list().plans.isEmpty)
    }

    // 3: a 200 to a range request refuses the strategy; the install falls back and succeeds.
    func testARangeAnsweredWith200FallsBackAndSucceeds() async throws {
        let (v1, v2) = releases()
        let server = ChunkServer([v1, v2])
        let storage = memoryPackStorage()
        let e = chunkEngine(server, storage: storage, pins: [v1.pin])
        _ = try await e.load()
        _ = try await e.ensure([v1.packId])
        server.calls = []
        server.rangeAs200 = true
        let i2 = try await e.ensureReleases([v2.target])[0]
        XCTAssertEqual(sha256Of(try installedBytes(storage, i2)), v2.payloadSha256)
        // The chunk strategy tried exactly one range, then the next candidate (`full`) ran.
        XCTAssertEqual(server.rangeCalls.count, 1)
        XCTAssertTrue(server.calls.contains { $0.sha256 == v2.fullSha256 && $0.length == nil })
        let after = try await e.state()
        XCTAssertNil(after.inflight[v2.packId])
    }

    // 3b: a 206 carrying another ETag is refused the same way (falls back).
    func testA206WithAnotherETagFallsBack() async throws {
        let (v1, v2) = releases()
        let server = ChunkServer([v1, v2])
        let storage = memoryPackStorage()
        let e = chunkEngine(server, storage: storage, pins: [v1.pin])
        _ = try await e.load()
        _ = try await e.ensure([v1.packId])
        server.calls = []
        server.otherEtag = true
        let i2 = try await e.ensureReleases([v2.target])[0]
        XCTAssertEqual(sha256Of(try installedBytes(storage, i2)), v2.payloadSha256)
        XCTAssertEqual(server.rangeCalls.count, 1)
        XCTAssertTrue(server.calls.contains { $0.sha256 == v2.fullSha256 && $0.length == nil })
    }

    // 4: an interrupted run raises network-error and keeps the journal; the next ensure resumes,
    // reusing the completed first run.
    func testAnInterruptedRunResumesFromTheRunJournal() async throws {
        let (v1, v2) = releases()
        let server = ChunkServer([v1, v2])
        let root = tempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = DirPackStorage(root: root)
        let e = chunkEngine(server, storage: storage, pins: [v1.pin])
        _ = try await e.load()
        _ = try await e.ensure([v1.packId])
        server.calls = []
        server.cutRange = 2
        do {
            _ = try await e.ensureReleases([v2.target])
            XCTFail("expected network-error")
        } catch let err as PackError {
            XCTAssertEqual(err.code, ErrorCode.networkError)
            XCTAssertEqual(err.detail, "chunk")
        }
        let lay = v2.bundleLayout[1]
        XCTAssertEqual(server.rangeCalls.map(\.offset), [lay["g"]!, lay["h"]!])
        let inflight = try await e.state().inflight[v2.packId]
        let planId = try XCTUnwrap(inflight?.planId)
        XCTAssertEqual(inflight?.strategy, "chunk")
        let journal = try XCTUnwrap(try storage.runJournal?.read(planId))
        XCTAssertEqual(
            parseJSON(journal),
            .object(["v": .int(1), "index": .string(v2.chunksSha256), "runs": .int(3), "bitmap": .string("01")]))

        server.calls = []
        server.cutRange = nil
        let i2 = try await e.ensureReleases([v2.target])[0]
        XCTAssertEqual(sha256Of(try installedBytes(storage, i2)), v2.payloadSha256)
        // Only runs 2 and 3 are requested again; the staged index is not fetched again either.
        XCTAssertEqual(server.rangeCalls.map(\.offset), [lay["h"]!, lay["j"]!])
        XCTAssertFalse(server.calls.contains { $0.sha256 == v2.chunksSha256 })
        let after = try await e.state()
        XCTAssertNil(after.inflight[v2.packId])
    }

    // 4b: a journalled run whose bytes in the output no longer hash is refetched, not trusted.
    func testAJournalledRunWhoseOutputChangedIsRefetched() async throws {
        let (v1, v2) = releases()
        let server = ChunkServer([v1, v2])
        let storage = memoryPackStorage()
        let e = chunkEngine(server, storage: storage, pins: [v1.pin])
        _ = try await e.load()
        _ = try await e.ensure([v1.packId])
        server.cutRange = 2
        _ = try? await e.ensureReleases([v2.target])
        let mid = try await e.state()
        let planId = try XCTUnwrap(mid.inflight[v2.packId]?.planId)
        // Corrupt the first run's bytes in the kept output (g sits at payload offset 64 KiB).
        let out = try storage.output(planId, "container", resume: true)
        try out.sink?.write(CHUNK, [0xff, 0xfe])
        server.calls = []
        server.cutRange = nil
        let i2 = try await e.ensureReleases([v2.target])[0]
        XCTAssertEqual(sha256Of(try installedBytes(storage, i2)), v2.payloadSha256)
        let lay = v2.bundleLayout[1]
        XCTAssertEqual(server.rangeCalls.map(\.offset), [lay["g"]!, lay["h"]!, lay["j"]!])
    }

    // 5: a chunk another pack holds is copied from that pack's payload, never fetched.
    func testCrossPackSeedsCopyAChunkFromAnotherPack() async throws {
        let a = chunkPack("djdl.alpha", version: "1.0.0", seq: 1, chunks: ["y", "p", "q"], bundles: [["y", "p", "q"]])
        let b1 = chunkPack("djdl.beta", version: "1.0.0", seq: 1, chunks: ["m", "n"], bundles: [["m", "n"]])
        let b2 = chunkPack(
            "djdl.beta", version: "1.1.0", seq: 2, chunks: ["m", "y", "r"], bundles: [["m", "n"], ["y", "r"]])
        let server = ChunkServer([a, b1, b2])
        let storage = memoryPackStorage()
        let e = chunkEngine(server, storage: storage, pins: [a.pin, b1.pin])
        _ = try await e.load()
        _ = try await e.ensure([a.packId, b1.packId])
        XCTAssertNotNil(storage.indexes[a.chunksSha256])
        XCTAssertNotNil(storage.indexes[b1.chunksSha256])
        server.calls = []
        let i = try await e.ensureReleases([b2.target])[0]
        XCTAssertEqual(sha256Of(try installedBytes(storage, i)), b2.payloadSha256)
        // y (offset 0 of B2's second bundle) came from djdl.alpha's payload: only r is requested.
        let ranges = server.rangeCalls
        XCTAssertEqual(ranges.count, 1)
        XCTAssertEqual(ranges.first?.sha256, b2.bundleShas[1])
        XCTAssertEqual(ranges.first?.offset, b2.bundleLayout[1]["r"])
        XCTAssertEqual(ranges.first?.length, CHUNK)
        XCTAssertFalse(server.calls.contains { $0.sha256 == b2.fullSha256 })
    }

    // 6: a delegated tree whose variant carries `chunks` never plans chunk (its index is never
    // fetched, even with seeds available), and every file still passes the data-only sink.
    func testADelegatedTreeWithChunksNeverPlansChunkAndKeepsTheDataOnlyRule() async throws {
        let seedPack = chunkPack(
            "djdl.music", version: "1.0.0", seq: 1, chunks: ["a", "b"], bundles: [["a", "b"]])
        let ck = contentKeyPair()
        let d = delegationFor(deliverable: "djdl.events", publicKey: ck.pub)
        let chunksRef: JSONValue = .object([
            "format": .string(CHUNKS_FORMAT), "sha256": .string(seedPack.chunksSha256),
            "bytes": .int(seedPack.chunkIndex.count), "size": .int(seedPack.chunkIndex.count),
            "codec": .string("none"),
        ])
        let tree = treePack(
            packId: "djdl.events.halloween", version: "1.0.0", seq: 1,
            files: ["a.json": "{}", "b.json": "[gd_resource]"], signer: (ck.key, d.kid), issuedAt: 1_759_250_000,
            variantExtra: ["chunks": chunksRef])
        let server = ChunkServer([seedPack], trees: [tree])
        let storage = memoryPackStorage()
        let records = server.fetchRecord
        let e = PackEngine(
            PackEngineOptions(
                product: PackFixtures.product, releaseKeys: PackFixtures.releaseKeys,
                productTrust: { PackFixtures.productTrust },
                stamp: AppContent(contentApi: 1, pins: [seedPack.pin], expects: []), zstd: LibZstd(),
                patchMethods: [], memBudget: 1 << 30, storage: storage, state: memoryPackStateStore(),
                fetchRecord: { h in h == d.sha256 ? .ok(d.jws) : await records(h) },
                fetchObject: server.fetchObject, now: { 1_759_400_000 },
                newPlanId: { "dcplan-\(chunkPlans.with { $0 += 1; return $0 })" }, handlers: [BlobHandler()]))
        _ = try await e.load()
        _ = try await e.ensure([seedPack.packId])
        XCTAssertNotNil(storage.indexes[seedPack.chunksSha256])
        server.calls = []
        do {
            _ = try await e.ensureReleases([
                PackTarget(pack: tree.packId, release: ReleasePin(sha256: tree.recordSha256, seq: 1, version: "1.0.0"))
            ])
            XCTFail("expected pack-not-data-only")
        } catch let err as PackError {
            XCTAssertEqual(err.code, ErrorCode.packNotDataOnly)
            XCTAssertEqual(err.path, "b.json")
        }
        XCTAssertTrue(server.rangeCalls.isEmpty)
        XCTAssertFalse(server.calls.contains { $0.sha256 == seedPack.chunksSha256 })
    }

    // GC: a seed index no root install names is removed.
    func testGarbageCollectionDropsSeedIndexesNoRootNames() async throws {
        let (v1, v2) = releases()
        let server = ChunkServer([v1, v2])
        let storage = memoryPackStorage()
        storage.indexes["ab" + String(repeating: "0", count: 62)] = [1, 2, 3]
        let e = chunkEngine(server, storage: storage, pins: [v1.pin])
        _ = try await e.load()
        XCTAssertTrue(storage.indexes.isEmpty)
        _ = try await e.ensure([v1.packId])
        XCTAssertEqual(Set(storage.indexes.keys), [v1.chunksSha256])
    }

    // A stored seed index is re-verified at every use: a tampered one is no seed (full again).
    func testATamperedStoredSeedIndexIsNoSeed() async throws {
        let (v1, v2) = releases()
        let server = ChunkServer([v1, v2])
        let storage = memoryPackStorage()
        let e = chunkEngine(server, storage: storage, pins: [v1.pin])
        _ = try await e.load()
        _ = try await e.ensure([v1.packId])
        var bad = v1.chunkIndex
        bad[100] ^= 1
        storage.indexes[v1.chunksSha256] = bad
        server.calls = []
        let i2 = try await e.ensureReleases([v2.target])[0]
        XCTAssertEqual(sha256Of(try installedBytes(storage, i2)), v2.payloadSha256)
        XCTAssertTrue(server.rangeCalls.isEmpty)
        XCTAssertTrue(server.calls.contains { $0.sha256 == v2.fullSha256 })
    }

    // The run journal's codec: bit k is byte[k >> 3] & (1 << (k & 7)); anything else is ignored.
    func testRunJournalBitmap() {
        let idx = String(repeating: "c", count: 64)
        let text = runJournalText(idx, 10, [0, 3, 9])
        XCTAssertEqual(parseJSON(text)?.objectValue?["bitmap"], .string("0902"))
        XCTAssertEqual(runJournalDone(text, idx, 10), [0, 3, 9])
        XCTAssertEqual(runJournalDone(text, idx, 11), [])
        XCTAssertEqual(runJournalDone(text, String(repeating: "d", count: 64), 10), [])
        XCTAssertEqual(runJournalDone("{", idx, 10), [])
        XCTAssertEqual(runJournalDone(#"{"v":1,"index":"\#(idx)","runs":10,"bitmap":"09"}"#, idx, 10), [])
        XCTAssertEqual(runJournalDone(#"{"v":1,"index":"\#(idx)","runs":10,"bitmap":"09G2"}"#, idx, 10), [])
        XCTAssertEqual(runJournalDone(#"{"v":2,"index":"\#(idx)","runs":10,"bitmap":"0902"}"#, idx, 10), [])
    }

    // The URLSession transport never carries Authorization across a redirect to another origin.
    func testARedirectToAnotherOriginDropsAuthorization() async throws {
        let origin = try XCTUnwrap(URL(string: "https://key.example/djdl/distribution/blobs/sha256/x"))
        let guardian = RedirectAuthGuard(origin: origin)
        let task = URLSession.shared.dataTask(with: origin)
        defer { task.cancel() }
        let response = try XCTUnwrap(HTTPURLResponse(url: origin, statusCode: 302, httpVersion: nil, headerFields: nil))
        func follow(_ to: String) async throws -> String? {
            var req = URLRequest(url: try XCTUnwrap(URL(string: to)))
            req.setValue("Bearer pkeyt_test", forHTTPHeaderField: "Authorization")
            let next = await guardian.urlSession(
                URLSession.shared, task: task, willPerformHTTPRedirection: response, newRequest: req)
            return next?.value(forHTTPHeaderField: "Authorization")
        }
        let same = try await follow("https://key.example/other")
        XCTAssertEqual(same, "Bearer pkeyt_test")
        for to in ["https://cdn.example/blob", "http://key.example/blob", "https://key.example:8443/blob"] {
            let other = try await follow(to)
            XCTAssertNil(other, to)
        }
    }

    // chunkRangeFetch's exact Content-Range and ETag rule.
    func testChunkRangeFetchAcceptsOnlyTheExactRange() async throws {
        let sha = String(repeating: "a", count: 64)
        func run(_ status: Int, _ cr: String?, _ etag: String? = nil, offset: Int = 10, length: Int = 5)
            async throws -> [UInt8]?
        {
            let seen = Locked2<ObjectRequest?>(nil)
            let f = chunkRangeFetch { req in
                seen.with { $0 = req }
                return ObjectResponse(
                    status: status, contentRange: cr, etag: etag,
                    chunks: AsyncThrowingStream { c in
                        c.yield([1, 2, 3])
                        c.yield([4, 5, 6, 7])
                        c.finish()
                    })
            }
            let r = try await f(ChunkRangeRequest(bundle: sha, offset: offset, length: length))
            let req = seen.with { $0 }
            XCTAssertEqual(req?.length, length)
            XCTAssertEqual(req?.offset, offset)
            XCTAssertEqual(req?.ifRange, "\"\(sha)\"")
            guard case .ok(let body) = r else { return nil }
            var out: [UInt8] = []
            for try await c in body { out += c }
            return out
        }
        let exact = try await run(206, "bytes 10-14/100")
        XCTAssertEqual(exact, [1, 2, 3, 4, 5])
        let tagged = try await run(206, " bytes 10-14/100 ", "\"\(sha)\"")
        XCTAssertEqual(tagged, [1, 2, 3, 4, 5])
        // Clipped at the object's end: only the bytes up to it.
        let clipped = try await run(206, "bytes 10-12/13")
        XCTAssertEqual(clipped, [1, 2, 3])
        for (status, cr, etag) in [
            (200, nil, nil), (200, "bytes 10-14/100", nil), (206, nil, nil), (206, "bytes 11-14/100", nil),
            (206, "bytes 10-13/100", nil), (206, "bytes 10-15/100", nil), (206, "bytes 10-14/14", nil),
            (206, "bytes 10-14/*", nil), (206, "bytes=10-14/100", nil), (206, "bytes 10-14/100", "W/\"\(sha)\""),
            (206, "bytes 10-14/100", "\"other\""), (206, "bytes 10-12/14", nil),
            (206, "bytes 10-14/12345678901234567", nil), (206, "bytes ١٠-14/100", nil),
        ] as [(Int, String?, String?)] {
            let r = try await run(status, cr, etag)
            XCTAssertNil(r, "\(status) \(cr ?? "nil") \(etag ?? "nil") must be refused")
        }
    }
}

/// The engine's run-journal codec.
private func runJournalText(_ index: String, _ runs: Int, _ done: Set<Int>) -> String {
    writeRunJournal(index: index, runs: runs, done: done)
}

private func runJournalDone(_ text: String, _ index: String, _ runs: Int) -> Set<Int> {
    readRunJournal(text, index: index, runs: runs)
}
