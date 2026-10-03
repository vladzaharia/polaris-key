// `applyChunk`, chunk sync from seeds (plans/P4-10.md §2.5; notes/A7 §3.4; P4-11), over injected
// ports. `content/cases.json#applyCases` (`strategy: chunk`) pins every verdict and counter.
// client-core `packs/chunkApply.ts` is the reference.
//
//  1. The target index is read by its ref and parsed bound to the variant's payload
//     (`parseChunkIndex`'s codes).
//  2. The seed map S: id → (seed, offset), first occurrence over seeds in order, then over each
//     seed's records in order.
//  3. The request runs, the planner's rule exactly (`chunkRuns`): the records neither seeded nor
//     already fetched, in payload order; a fetched record joins the current run when it is in the
//     same bundle at `offset == prev.offset + prev.clen`. Each run is one single-range request.
//  4. For each target record in order: copy from a seed (not re-hashed: seeds were verified at
//     install), else copy from the output when the id was already written, else take the next
//     `clen` bytes of its run: fewer than `clen` → `chunk-bundle-truncated {chunk}`; a decode
//     error, a wrong length or a wrong SHA-256 → `chunk-corrupt {chunk}`.
//  5. The payload's SHA-256 → `payload-hash-mismatch`; with `repair`, A7's repair pass first:
//     every seed-sourced record whose bytes no longer hash to its id is refetched (one request per
//     record, not counted in `requests`) and reported in `repairedChunks`.
//
// Memory: the parsed index, the seed map and one chunk (`clen + len`, at most 2 ×
// `MAX_CHUNK_BYTES`); the output goes to the host's positional sink, never a buffer, and a run's
// body is read as it arrives. Nothing throws: a port that throws is the step's verdict, and a
// transport that refuses or fails is `network-error` with `detail` (`range-refused` makes the
// engine fall back to the next strategy; `interrupted` keeps the run journal for a resume).

import Foundation
import PolarisKeyCore

/// One seed: an installed (or embedded) container payload whose chunk index is kept.
public struct ChunkSeed: Sendable {
    public var index: ChunkIndexDoc
    public var payload: any ByteSource

    public init(index: ChunkIndexDoc, payload: any ByteSource) {
        self.index = index
        self.payload = payload
    }
}

/// One single-range request: `length` bytes of the bundle whose SHA-256 is `bundle`, from `offset`.
public struct ChunkRangeRequest: Sendable, Equatable {
    public var bundle: String
    public var offset: Int
    public var length: Int

    public init(bundle: String, offset: Int, length: Int) {
        self.bundle = bundle
        self.offset = offset
        self.length = length
    }
}

/// A range request's answer, as the applier reads it. `ok`: the body (shorter than asked when the
/// object ends inside the range, or the transfer was cut short). `refused`: the server answered
/// with anything but the exact range of the same object (a `200`, another `Content-Range`, another
/// `ETag`), so the strategy stops and the host falls back. A throw is an interrupted transfer.
public enum ChunkRangeResponse: Sendable {
    case ok(AsyncThrowingStream<[UInt8], Error>)
    case refused
}

public typealias ChunkRangeFetch = @Sendable (ChunkRangeRequest) async throws -> ChunkRangeResponse

/// The output: a positional sink the applier can read back (duplicate copies, the repair pass, a
/// resumed run's re-hash). `read` returns at most `length` bytes (fewer past the end).
public protocol ChunkOutput: Sendable {
    func write(_ offset: Int, _ bytes: [UInt8]) throws
    func read(_ offset: Int, _ length: Int) throws -> [UInt8]
}

/// What `applyChunk` reads from and writes to.
public struct ApplyChunkPorts: Sendable {
    /// The stored target index, by the SHA-256 of its stored bytes.
    public var objects: @Sendable (String) throws -> (any ByteSource)?
    public var zstd: any ZstdPort
    public var fetchRange: ChunkRangeFetch
    public var output: any ChunkOutput

    public init(
        objects: @escaping @Sendable (String) throws -> (any ByteSource)?, zstd: any ZstdPort,
        fetchRange: @escaping ChunkRangeFetch, output: any ChunkOutput
    ) {
        self.objects = objects
        self.zstd = zstd
        self.fetchRange = fetchRange
        self.output = output
    }
}

/// The counters of a successful chunk apply (the corpus compares every one).
public struct ChunkCounters: Sendable, Equatable {
    public var sha256: String
    public var size: Int
    public var fetchedChunks: Int
    public var fetchedBytes: Int
    /// The single-range requests sent for runs (the planner adds one for the index).
    public var requests: Int
    public var seedChunks: Int
    public var selfChunks: Int
    public var repairedChunks: [Int]
}

/// `applyChunk`'s verdict.
public enum ChunkVerdict: Sendable, Equatable {
    case ok(ChunkCounters)
    /// `detail` is `range-refused` (fall back) or `interrupted` (resume later), for
    /// `network-error` only.
    case failed(error: String, chunk: Int?, bundle: Int?, detail: String?)

    public var ok: Bool {
        if case .ok = self { return true }
        return false
    }

    /// The verdict as the corpus writes it.
    public var json: JSONValue {
        switch self {
        case .ok(let c):
            return .object([
                "ok": .bool(true), "sha256": .string(c.sha256), "size": .int(c.size),
                "fetchedChunks": .int(c.fetchedChunks), "fetchedBytes": .int(c.fetchedBytes),
                "requests": .int(c.requests), "seedChunks": .int(c.seedChunks),
                "selfChunks": .int(c.selfChunks), "repairedChunks": .array(c.repairedChunks.map { .int($0) }),
            ])
        case .failed(let error, let chunk, let bundle, let detail):
            var o: [String: JSONValue] = ["ok": .bool(false), "error": .string(error)]
            if let chunk { o["chunk"] = .int(chunk) }
            if let bundle { o["bundle"] = .int(bundle) }
            if let detail { o["detail"] = .string(detail) }
            return .object(o)
        }
    }
}

/// `applyChunk`'s answer: the verdict, and the target index when it parsed.
public struct ChunkApplyResult: Sendable, Equatable {
    public var verdict: ChunkVerdict
    public var index: ChunkIndexDoc?
}

/// One request run: its bundle index, byte range and the target records it carries, in order.
public struct ChunkRun: Sendable, Equatable {
    public var bundle: Int
    public var offset: Int
    public var length: Int
    public var records: [Int]
}

/// The request runs over a target index given the seeded ids (plans/P4-10.md §2.5; the planner's
/// rule in `plan`): the records neither seeded nor already fetched, grouped while the bundle stays
/// the same and `offset == prev.offset + prev.clen`.
public func chunkRuns(_ records: [ChunkRecord], seeded: (String) -> Bool) -> [ChunkRun] {
    var runs: [ChunkRun] = []
    var seen = Set<String>()
    var prev: ChunkRecord?
    for (i, r) in records.enumerated() {
        if seeded(r.id) || seen.contains(r.id) { continue }
        seen.insert(r.id)
        if prev == nil || r.bundle != prev!.bundle || r.offset != prev!.offset + prev!.clen {
            runs.append(ChunkRun(bundle: r.bundle, offset: r.offset, length: 0, records: []))
        }
        runs[runs.count - 1].length = r.offset + r.clen - runs[runs.count - 1].offset
        runs[runs.count - 1].records.append(i)
        prev = r
    }
    return runs
}

/// The seed map: id → (seed, offset), first occurrence over seeds in order, then records.
public func seedMap(_ seeds: [ChunkSeed]) -> [String: (seed: Int, offset: Int)] {
    var s: [String: (seed: Int, offset: Int)] = [:]
    for (si, seed) in seeds.enumerated() {
        var off = 0
        for r in seed.index.records {
            if s[r.id] == nil { s[r.id] = (si, off) }
            off += r.len
        }
    }
    return s
}

private func chunkFail(
    _ error: String, chunk: Int? = nil, bundle: Int? = nil, detail: String? = nil
) -> ChunkVerdict {
    .failed(error: error, chunk: chunk, bundle: bundle, detail: detail)
}

/// Reads a run's body record by record, holding only the record being read.
private final class RunReader {
    private var it: AsyncThrowingStream<[UInt8], Error>.AsyncIterator?
    private var pending: [UInt8] = []
    private var at = 0

    init(_ body: AsyncThrowingStream<[UInt8], Error>) { it = body.makeAsyncIterator() }

    /// Exactly `n` bytes, or fewer when the body ends first. Throws when the transfer fails.
    func take(_ n: Int) async throws -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(n)
        while out.count < n {
            if at >= pending.count {
                guard it != nil else { break }
                guard let next = try await it!.next() else {
                    close()
                    break
                }
                pending = next
                at = 0
                continue
            }
            let k = Swift.min(n - out.count, pending.count - at)
            out += pending[at..<(at + k)]
            at += k
        }
        return out
    }

    /// Stop reading: dropping the iterator releases (cancels) the body.
    func close() {
        it = nil
        pending = []
        at = 0
    }
}

private struct PortFailure: Error {}

/// `applyChunk(variant, seeds, ports, repair, completedRuns, onRunDone, onProgress)`
/// (plans/P4-10.md §2.5): the payload rebuilt into `ports.output`, or the first failure.
/// `completedRuns` are runs an earlier attempt completed (the run journal): each record of such a
/// run is read back from the output and re-hashed before reuse, and one that differs refetches the
/// whole run. `onRunDone` is called after every record of a run has been written; `onProgress`
/// with the fetched bytes so far after every run. Never throws.
public func applyChunk(
    _ variant: PackVariant, seeds: [ChunkSeed], _ ports: ApplyChunkPorts, repair: Bool = false,
    completedRuns: Set<Int> = [], onRunDone: (@Sendable (Int) async -> Void)? = nil,
    onProgress: (@Sendable (Int) -> Void)? = nil
) async -> ChunkApplyResult {
    let payload = variant.payload
    guard let ref = variant.chunks?.ref else {
        return ChunkApplyResult(verdict: chunkFail(ErrorCode.chunksRefMismatch), index: nil)
    }
    // 1. The target index, bounded before a byte is read (parseChunkIndex step 0 again).
    var stored: [UInt8] = []
    if ref.bytes >= 0, ref.size >= 0, ref.bytes <= MAX_CHUNK_INDEX_BYTES, ref.size <= MAX_CHUNK_INDEX_BYTES,
        let src = (try? ports.objects(ref.sha256)) ?? nil, src.size == ref.bytes
    {
        stored = (try? readAll(src)) ?? []
    }
    let zstd = ports.zstd
    let T: ChunkIndexDoc
    switch parseChunkIndex(stored, ref: ref, payload: payload, decode: { try zstd.decode($0, size: $1) }) {
    case .ok(let i): T = i
    case .failed(let e, let c, let b):
        return ChunkApplyResult(verdict: chunkFail(e, chunk: c, bundle: b), index: nil)
    }
    func done(_ v: ChunkVerdict) -> ChunkApplyResult { ChunkApplyResult(verdict: v, index: T) }
    // A chunk longer than `MAX_CHUNK_BYTES` makes the strategy unusable (planTarget); refuse it
    // before anything is fetched or allocated.
    for (i, r) in T.records.enumerated() where r.len > MAX_CHUNK_BYTES {
        return done(chunkFail(ErrorCode.chunkCorrupt, chunk: i))
    }

    // 2–3. The seed map and the runs.
    let S = seedMap(seeds)
    let runs = chunkRuns(T.records) { S[$0] != nil }
    var runOf: [Int: Int] = [:]
    var lastOfRun: [Int: Int] = [:]
    for (k, run) in runs.enumerated() {
        for i in run.records { runOf[i] = k }
        lastOfRun[run.records[run.records.count - 1]] = k
    }
    let posOf: [Int] = {
        var out: [Int] = []
        out.reserveCapacity(T.records.count)
        var p = 0
        for r in T.records {
            out.append(p)
            p += r.len
        }
        return out
    }()

    /// Decode and verify one fetched record's stored bytes: the data, or the verdict.
    func verify(_ i: Int, _ raw: [UInt8]) -> Result<[UInt8], ChunkFailureBox> {
        let r = T.records[i]
        if raw.count < r.clen { return .failure(ChunkFailureBox(chunkFail(ErrorCode.chunkBundleTruncated, chunk: i))) }
        let data: [UInt8]
        if r.clen == r.len {
            data = raw
        } else {
            guard let d = try? zstd.decode(raw, size: r.len) else {
                return .failure(ChunkFailureBox(chunkFail(ErrorCode.chunkCorrupt, chunk: i)))
            }
            data = d
        }
        if data.count != r.len || sha256Of(data) != r.id {
            return .failure(ChunkFailureBox(chunkFail(ErrorCode.chunkCorrupt, chunk: i)))
        }
        return .success(data)
    }

    /// One single-range request; a refusal or a throw is the verdict.
    func open(_ bundle: Int, _ offset: Int, _ length: Int) async -> Result<RunReader, ChunkFailureBox> {
        let res: ChunkRangeResponse
        do {
            res = try await ports.fetchRange(
                ChunkRangeRequest(bundle: T.bundles[bundle].sha256, offset: offset, length: length))
        } catch {
            return .failure(ChunkFailureBox(chunkFail(ErrorCode.networkError, detail: "interrupted")))
        }
        guard case .ok(let body) = res else {
            return .failure(ChunkFailureBox(chunkFail(ErrorCode.networkError, detail: "range-refused")))
        }
        return .success(RunReader(body))
    }

    /// Whether every record of a journalled run still hashes to its id in the output.
    func runIntact(_ k: Int) throws -> Bool {
        for i in runs[k].records {
            let r = T.records[i]
            let got = try ports.output.read(posOf[i], r.len)
            if got.count != r.len || sha256Of(got) != r.id { return false }
        }
        return true
    }

    // 4. Every record, in payload order.
    var current: (error: String, chunk: Int?) = (ErrorCode.chunksRefMismatch, nil)
    var reader: RunReader?
    defer { reader?.close() }
    do {
        var hasher = PackHasher()
        var kinds: [UInt8] = []  // 0 seed, 1 self, 2 fetch
        kinds.reserveCapacity(T.records.count)
        var first: [String: Int] = [:]
        var fetchedChunks = 0
        var fetchedBytes = 0
        var seedChunks = 0
        var selfChunks = 0
        var requests = 0
        var openRun = -1
        var resumedRun = -1
        for i in 0..<T.records.count {
            let r = T.records[i]
            let pos = posOf[i]
            current = (ErrorCode.chunkCorrupt, i)
            var data: [UInt8]
            if let hit = S[r.id] {
                let got = try seeds[hit.seed].payload.read(hit.offset, r.len)
                if got.count == r.len {
                    data = got
                } else {
                    // A short seed keeps its place; the payload hash (or the repair pass) catches it.
                    data = [UInt8](repeating: 0, count: r.len)
                    let k = Swift.min(r.len, got.count)
                    data.replaceSubrange(0..<k, with: got[0..<k])
                }
                kinds.append(0)
                seedChunks += 1
            } else if let f = first[r.id] {
                data = try ports.output.read(f, r.len)
                kinds.append(1)
                selfChunks += 1
            } else {
                let k = runOf[i]!
                if k != openRun && k != resumedRun {
                    reader?.close()
                    reader = nil
                    if completedRuns.contains(k), try runIntact(k) {
                        resumedRun = k
                    } else {
                        let run = runs[k]
                        switch await open(run.bundle, run.offset, run.length) {
                        case .failure(let f): return done(f.verdict)
                        case .success(let rd):
                            reader = rd
                            openRun = k
                            requests += 1
                        }
                    }
                }
                if k == resumedRun {
                    data = try ports.output.read(pos, r.len)
                } else {
                    let raw: [UInt8]
                    do {
                        raw = try await reader!.take(r.clen)
                    } catch {
                        return done(chunkFail(ErrorCode.networkError, detail: "interrupted"))
                    }
                    switch verify(i, raw) {
                    case .failure(let f): return done(f.verdict)
                    case .success(let d): data = d
                    }
                }
                kinds.append(2)
                fetchedChunks += 1
                fetchedBytes += r.clen
            }
            if first[r.id] == nil { first[r.id] = pos }
            if kinds[i] != 2 || runOf[i] != resumedRun { try ports.output.write(pos, data) }
            hasher.update(data)
            if let k = lastOfRun[i] {
                if openRun == k {
                    reader?.close()
                    reader = nil
                }
                await onRunDone?(k)
                onProgress?(fetchedBytes)
            }
        }

        // 5. The payload hash, with the repair pass.
        var repaired: [Int] = []
        if hasher.digest() != payload.sha256 {
            if !repair { return done(chunkFail(ErrorCode.payloadHashMismatch)) }
            for i in 0..<T.records.count where kinds[i] == 0 {
                let r = T.records[i]
                current = (ErrorCode.chunkCorrupt, i)
                let back = try ports.output.read(posOf[i], r.len)
                if back.count == r.len && sha256Of(back) == r.id { continue }
                let rd: RunReader
                switch await open(r.bundle, r.offset, r.clen) {
                case .failure(let f): return done(f.verdict)
                case .success(let x): rd = x
                }
                let raw: [UInt8]
                do {
                    raw = try await rd.take(r.clen)
                    rd.close()
                } catch {
                    rd.close()
                    return done(chunkFail(ErrorCode.networkError, detail: "interrupted"))
                }
                switch verify(i, raw) {
                case .failure(let f): return done(f.verdict)
                case .success(let d): try ports.output.write(posOf[i], d)
                }
                repaired.append(i)
            }
            current = (ErrorCode.payloadHashMismatch, nil)
            var again = PackHasher()
            var at = 0
            while at < T.payloadSize {
                let part = try ports.output.read(at, Swift.min(READ_CHUNK, T.payloadSize - at))
                if part.isEmpty { break }
                again.update(part)
                at += part.count
            }
            if again.digest() != payload.sha256 { return done(chunkFail(ErrorCode.payloadHashMismatch)) }
        }
        return done(
            .ok(
                ChunkCounters(
                    sha256: payload.sha256, size: T.payloadSize, fetchedChunks: fetchedChunks,
                    fetchedBytes: fetchedBytes, requests: requests, seedChunks: seedChunks,
                    selfChunks: selfChunks, repairedChunks: repaired)))
    } catch {
        return ChunkApplyResult(verdict: chunkFail(current.error, chunk: current.chunk), index: nil)
    }
}

/// A verdict carried through a `Result`'s failure side.
private struct ChunkFailureBox: Error {
    let verdict: ChunkVerdict
    init(_ v: ChunkVerdict) { verdict = v }
}

// ── The exact Content-Range adapter ─────────────────────────────────────────────────────────

/// `bytes <o>-<e>/<size>`, each 1–16 ASCII digits, after trimming whitespace; nil otherwise.
func parseContentRange(_ value: String) -> (start: Int, end: Int, size: Int)? {
    let s = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard s.hasPrefix("bytes ") else { return nil }
    let rest = Array(s.utf8.dropFirst(6))
    var nums: [Int] = []
    var cur = 0
    var digits = 0
    let seps: [UInt8] = [UInt8(ascii: "-"), UInt8(ascii: "/")]
    for c in rest {
        if c >= 0x30 && c <= 0x39 {
            digits += 1
            if digits > 16 { return nil }
            cur = cur * 10 + Int(c - 0x30)
        } else if nums.count < 2 && c == seps[nums.count] && digits > 0 {
            nums.append(cur)
            cur = 0
            digits = 0
        } else {
            return nil
        }
    }
    guard nums.count == 2, digits > 0 else { return nil }
    return (nums[0], nums[1], cur)
}

/// At most `n` bytes of a body, then the body is released.
private final class CappedBody: @unchecked Sendable {
    private var it: AsyncThrowingStream<[UInt8], Error>.AsyncIterator?
    private var left: Int

    init(_ body: AsyncThrowingStream<[UInt8], Error>, _ n: Int) {
        it = body.makeAsyncIterator()
        left = n
    }

    func next() async throws -> [UInt8]? {
        while left > 0, it != nil {
            guard let c = try await it!.next() else {
                it = nil
                return nil
            }
            if c.isEmpty { continue }
            if c.count >= left {
                let out = Array(c[0..<left])
                left = 0
                it = nil
                return out
            }
            left -= c.count
            return c
        }
        it = nil
        return nil
    }
}

/// The chunk strategy's `fetchRange` over the host's object fetch (plans/P4-10.md §2.5): one
/// single-range request per run, `Range: bytes=<o>-<o+len-1>` (the request's `length`) with
/// `If-Range: "<bundle sha256>"` (the host also sends `Accept-Encoding: identity`). Only a `206`
/// whose `Content-Range` is exactly `bytes o-e/<size>` for the request is read, or one that starts
/// at `o` and ends at `<size> − 1 < e` (clipped at the object's end: the records past it are then
/// `chunk-bundle-truncated`); an `ETag`, when present, must be exactly the quoted bundle hash.
/// Anything else (a `200`, another range, another tag) is `refused`, and the body is never read.
/// The body is cut at the range's length. Never a multi-range.
public func chunkRangeFetch(_ fetch: @escaping ObjectFetch) -> ChunkRangeFetch {
    { req in
        let tag = "\"\(req.bundle)\""
        let res = try await fetch(
            ObjectRequest(sha256: req.bundle, offset: req.offset, ifRange: tag, length: req.length))
        let end = req.offset + req.length - 1
        var take = -1
        if req.length > 0, res.status == 206, let cr = res.contentRange, let m = parseContentRange(cr),
            res.etag == nil || res.etag == tag
        {
            if m.start == req.offset && m.end == end && end < m.size {
                take = req.length
            } else if m.start == req.offset && m.end < end && m.end == m.size - 1 && m.end >= m.start {
                take = m.end - m.start + 1
            }
        }
        // A refused body is never read: dropping the stream releases it.
        if take < 0 { return .refused }
        let capped = CappedBody(res.chunks, take)
        return .ok(AsyncThrowingStream(unfolding: { try await capped.next() }))
    }
}
