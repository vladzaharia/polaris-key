// `pkey-chunks/1`, the binary chunk index (plans/P4-10.md §2.3; WIRE-CONTRACT-V4 §2.6), and its
// parser. `content/cases.json#chunkIndexCases` pins `parseChunkIndex`. Pure, never throws.
// client-core `packs/chunks.ts` is the reference.
//
// Layout (all little-endian), exactly A7 §3.1:
//
//   header   64 B   "PKEYCHNK" | version u16 = 1 | recordSize u16 = 48 | flags u32 (bit 0
//                   fileAware) | chunkCount u32 | bundleCount u32 | payloadSize u64 |
//                   payloadSha256[32]
//   chunks   48 B   id[32] | len u32 | clen u32 | bundle u32 | offset u32, in payload order
//   bundles  48 B   sha256[32] | size u64 | reserved u64
//
// The u64 rule: a u64 is `hi × 2^32 + lo` from two u32 reads (low word first), saturated at
// 2^53, never a native 64-bit load, so every SDK (GDScript's `int`, a JS double) reaches the same
// value. Every multi-byte read here is composed from single bytes by index, so no read is ever an
// aligned load at an unaligned offset. Swift's `Int` is 64 bits on every platform this package
// builds for (macOS and iOS are 64-bit only), so every intermediate below is exact.

import Foundation
import PolarisKeyCore

/// `PKEYCHNK`.
private let CHUNKS_MAGIC: [UInt8] = [0x50, 0x4b, 0x45, 0x59, 0x43, 0x48, 0x4e, 0x4b]
private let CHUNKS_HEADER_BYTES = 64
private let CHUNKS_RECORD_BYTES = 48
private let CHUNKS_FLAG_FILE_AWARE = 1
/// 2^53, the u64 saturation point.
public let CHUNKS_U64_MAX = 9_007_199_254_740_992

/// One chunk record `[id, len, clen, bundle, offset]` of a parsed index (the planner's record).
public typealias ChunkRecord = PlanChunkRecord

/// One bundle `[sha256, size]` of a parsed index (`size` saturated at 2^53).
public struct ChunkBundle: Sendable, Equatable {
    public var sha256: String
    public var size: Int

    public init(sha256: String, size: Int) {
        self.sha256 = sha256
        self.size = size
    }
}

/// A parsed `pkey-chunks/1` index.
public struct ChunkIndexDoc: Sendable, Equatable {
    public var fileAware: Bool
    public var payloadSize: Int
    public var payloadSha256: String
    public var records: [ChunkRecord]
    public var bundles: [ChunkBundle]

    public init(
        fileAware: Bool, payloadSize: Int, payloadSha256: String, records: [ChunkRecord],
        bundles: [ChunkBundle]
    ) {
        self.fileAware = fileAware
        self.payloadSize = payloadSize
        self.payloadSha256 = payloadSha256
        self.records = records
        self.bundles = bundles
    }

    /// What `planTarget` reads of it.
    public var planIndex: PlanChunkIndex {
        PlanChunkIndex(payloadSize: payloadSize, payloadSha256: payloadSha256, records: records)
    }
}

/// `parseChunkIndex`'s answer: the index, or the first failure with its `chunk` / `bundle`.
public enum ParseChunkIndexResult: Sendable, Equatable {
    case ok(ChunkIndexDoc)
    case failed(error: String, chunk: Int?, bundle: Int?)

    public var index: ChunkIndexDoc? {
        if case .ok(let i) = self { return i }
        return nil
    }

    /// The failure as the corpus writes it (`{ok: false, error, chunk?, bundle?}`); for success,
    /// `{ok: true, chunks, bundleSizes}` (the content runner's verdict).
    public var json: JSONValue {
        switch self {
        case .ok(let i):
            return .object([
                "ok": .bool(true), "chunks": .int(i.records.count),
                "bundleSizes": .array(i.bundles.map { .int($0.size) }),
            ])
        case .failed(let error, let chunk, let bundle):
            var o: [String: JSONValue] = ["ok": .bool(false), "error": .string(error)]
            if let chunk { o["chunk"] = .int(chunk) }
            if let bundle { o["bundle"] = .int(bundle) }
            return .object(o)
        }
    }
}

private func failed(_ error: String, chunk: Int? = nil, bundle: Int? = nil) -> ParseChunkIndexResult {
    .failed(error: error, chunk: chunk, bundle: bundle)
}

@inline(__always) private func u16(_ b: [UInt8], _ at: Int) -> Int {
    Int(b[at]) | Int(b[at + 1]) << 8
}

@inline(__always) private func u32(_ b: [UInt8], _ at: Int) -> Int {
    Int(b[at]) | Int(b[at + 1]) << 8 | Int(b[at + 2]) << 16 | Int(b[at + 3]) << 24
}

/// A u64 at `at` by the u64 rule: two u32 reads, low word first, `hi × 2^32 + lo`, saturated at
/// 2^53. Never a native 64-bit load.
public func readChunkU64(_ b: [UInt8], _ at: Int) -> Int {
    let lo = u32(b, at)
    let hi = u32(b, at + 4)
    // hi ≥ 2^21 already puts the value at or above 2^53; below that the product is exact.
    if hi >= 1 << 21 { return CHUNKS_U64_MAX }
    return Swift.min(hi * 4_294_967_296 + lo, CHUNKS_U64_MAX)
}

private func hexAt(_ b: [UInt8], _ at: Int, _ n: Int) -> String { hexString(b[at..<(at + n)]) }

/// `parseChunkIndex(stored, ref, payload | nil, decode, maxBytes)` (plans/P4-10.md §2.3): the
/// index, or the first failure in this order:
///
///  0. no ref, `ref.size` above `maxBytes` (before anything is decoded), the stored length or
///     SHA-256 differs from the ref, a `zstd` ref without a decoder or failing to decode, any
///     other codec, or a decoded length other than `ref.size` → `chunks-ref-mismatch`;
///  1–10. `parseChunkIndexBytes`.
///
/// Never throws.
public func parseChunkIndex(
    _ stored: [UInt8], ref: PackObjectRef?, payload: PackPayload?,
    decode: (([UInt8], Int) throws -> [UInt8])?, maxBytes: Int = MAX_CHUNK_INDEX_BYTES
) -> ParseChunkIndexResult {
    guard let ref, ref.size <= maxBytes, ref.size >= 0 else { return failed(ErrorCode.chunksRefMismatch) }
    if stored.count != ref.bytes { return failed(ErrorCode.chunksRefMismatch) }
    if sha256Of(stored) != ref.sha256 { return failed(ErrorCode.chunksRefMismatch) }
    let b: [UInt8]
    switch ref.codec {
    case "none": b = stored
    case "zstd":
        guard let decode, let d = try? decode(stored, ref.size) else {
            return failed(ErrorCode.chunksRefMismatch)
        }
        b = d
    default: return failed(ErrorCode.chunksRefMismatch)
    }
    if b.count != ref.size { return failed(ErrorCode.chunksRefMismatch) }
    return parseChunkIndexBytes(b, payload: payload)
}

/// Steps 1–10 of `parseChunkIndex` over the decoded index bytes (no ref):
///
///  1. length < 64 → `chunks-bad-length`; 2. magic → `chunks-bad-magic`; 3. version ≠ 1 →
///     `chunks-unsupported-version`; 4. recordSize ≠ 48 → `chunks-bad-record-size`;
///     5. `flags & ~1` → `chunks-bad-flags`;
///  6. length ≠ 64 + 48 × (chunkCount + bundleCount), exact → `chunks-bad-length`;
///  7. bundle records in order: reserved ≠ 0 → `chunks-reserved-nonzero {bundle}`;
///  8. chunk records in order: `len == 0` → `chunks-zero-length`; `clen == 0 || clen > len` →
///     `chunks-bad-clen`; `bundle ≥ bundleCount` → `chunks-bad-bundle-ref`;
///     `offset + clen > bundles[bundle].size` → `chunks-bad-bundle-range`, each `{chunk}`;
///  9. Σ len ≠ payloadSize → `chunks-size-mismatch`;
/// 10. with `payload`, (`payloadSha256`, `payloadSize`) ≠ the payload's → `chunks-payload-mismatch`.
///
/// Never throws.
public func parseChunkIndexBytes(_ b: [UInt8], payload: PackPayload?) -> ParseChunkIndexResult {
    if b.count < CHUNKS_HEADER_BYTES { return failed(ErrorCode.chunksBadLength) }
    for i in 0..<CHUNKS_MAGIC.count where b[i] != CHUNKS_MAGIC[i] {
        return failed(ErrorCode.chunksBadMagic)
    }
    if u16(b, 8) != 1 { return failed(ErrorCode.chunksUnsupportedVersion) }
    if u16(b, 10) != CHUNKS_RECORD_BYTES { return failed(ErrorCode.chunksBadRecordSize) }
    let flags = u32(b, 12)
    if flags & ~CHUNKS_FLAG_FILE_AWARE != 0 { return failed(ErrorCode.chunksBadFlags) }
    let n = u32(b, 16)
    let nb = u32(b, 20)
    // Both counts are below 2^32, so 64 + 48 × (n + nb) < 2^39: exact in a 64-bit Int.
    if b.count != CHUNKS_HEADER_BYTES + CHUNKS_RECORD_BYTES * (n + nb) {
        return failed(ErrorCode.chunksBadLength)
    }
    let payloadSize = readChunkU64(b, 24)
    let payloadSha256 = hexAt(b, 32, 32)

    var bundles: [ChunkBundle] = []
    bundles.reserveCapacity(nb)
    for j in 0..<nb {
        let o = CHUNKS_HEADER_BYTES + CHUNKS_RECORD_BYTES * (n + j)
        if u32(b, o + 40) != 0 || u32(b, o + 44) != 0 {
            return failed(ErrorCode.chunksReservedNonzero, bundle: j)
        }
        bundles.append(ChunkBundle(sha256: hexAt(b, o, 32), size: readChunkU64(b, o + 32)))
    }
    var records: [ChunkRecord] = []
    records.reserveCapacity(n)
    var total = 0
    for i in 0..<n {
        let o = CHUNKS_HEADER_BYTES + CHUNKS_RECORD_BYTES * i
        let len = u32(b, o + 32)
        let clen = u32(b, o + 36)
        let bundle = u32(b, o + 40)
        let offset = u32(b, o + 44)
        if len == 0 { return failed(ErrorCode.chunksZeroLength, chunk: i) }
        if clen == 0 || clen > len { return failed(ErrorCode.chunksBadClen, chunk: i) }
        if bundle >= nb { return failed(ErrorCode.chunksBadBundleRef, chunk: i) }
        if offset + clen > bundles[bundle].size { return failed(ErrorCode.chunksBadBundleRange, chunk: i) }
        // Kept just above 2^53 once past it: a saturated `payloadSize` (at most 2^53) can then
        // never compare equal by accident, and the sum never overflows.
        total = Swift.min(total + len, CHUNKS_U64_MAX + 1)
        records.append(ChunkRecord(id: hexAt(b, o, 32), len: len, clen: clen, bundle: bundle, offset: offset))
    }
    if total != payloadSize { return failed(ErrorCode.chunksSizeMismatch) }
    if let payload, payloadSha256 != payload.sha256 || payloadSize != payload.size {
        return failed(ErrorCode.chunksPayloadMismatch)
    }
    return .ok(
        ChunkIndexDoc(
            fileAware: flags & CHUNKS_FLAG_FILE_AWARE != 0, payloadSize: payloadSize,
            payloadSha256: payloadSha256, records: records, bundles: bundles))
}
