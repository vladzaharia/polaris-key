// The zstd window check (plans/P4-01.md §2.7 rule 3; WIRE-CONTRACT-V4 §2.6), `packSetId`
// (§2.9) and the content stamp (§2.8). client-core `packs/window.ts`, `set.ts` and `stamp.ts`
// are the reference.
//
// Before an applier decodes a `zstd-patch-from` frame it reads the frame's window from the
// header bytes alone (`frameWindow`) and refuses the frame as `delta-apply-failed` when that is
// nil or above 2^`windowLogMax(memBytes)`. No decoder parameter replaces the check: libzstd
// enforces its own window limit only when it streams through a small buffer.

import Foundation
import PolarisKeyCore

/// 2^32: the saturation point of `frameWindow`, above every `windowLogMax`.
private let WINDOW_CEILING: Int = 1 << 32

/// `frameWindow(bytes)` (plans/P4-01.md §2.7): the window of the zstd frame whose header starts
/// `bytes`, per RFC 8878 §3.1.1. Nil unless bytes 0–3 are `28 B5 2F FD`, the reserved bit
/// (`0x08`) of the descriptor is clear, and `bytes` hold the whole header. With
/// Single_Segment_flag the window is Frame_Content_Size (plus 256 for a 2-byte field); otherwise
/// `b + (b >> 3) × (w & 7)` with `b = 2^(10 + (w >> 3))`. Saturates at 2^32. Never throws.
public func frameWindow(_ bytes: [UInt8]) -> Int? {
    guard bytes.count >= 5, bytes[0] == 0x28, bytes[1] == 0xb5, bytes[2] == 0x2f, bytes[3] == 0xfd
    else { return nil }
    let d = Int(bytes[4])
    if d & 0x08 != 0 { return nil }
    let single = d & 0x20 != 0
    let dictBytes = [0, 1, 2, 4][d & 0x03]
    let fcsFlag = d >> 6
    let fcsBytes = fcsFlag == 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    let headerBytes = 5 + (single ? 0 : 1) + dictBytes + fcsBytes
    if bytes.count < headerBytes { return nil }
    if !single {
        let w = Int(bytes[5])
        let exp = 10 + (w >> 3)
        if exp >= 32 { return WINDOW_CEILING }
        let b = 1 << exp
        return Swift.min(b + (b / 8) * (w & 7), WINDOW_CEILING)
    }
    let at = 5 + dictBytes
    if fcsBytes == 8 {
        for i in 4..<8 where bytes[at + i] != 0 { return WINDOW_CEILING }
    }
    var v = 0
    var i = Swift.min(fcsBytes, 4) - 1
    while i >= 0 {
        v = v * 256 + Int(bytes[at + i])
        i -= 1
    }
    if fcsBytes == 2 { v += 256 }
    return Swift.min(v, WINDOW_CEILING)
}

/// `windowLogMax = max(10, min(P, ⌈log2(memBytes)⌉))` (plans/P4-01.md §2.7 rule 3), in integers:
/// ⌈log2(m)⌉ is the bit length of m − 1. `p` is 31 for a 64-bit decoder and 30 for a 32-bit one.
/// Nil when `memBytes` is negative or above 2^53 − 1, or `p` is not 30 or 31.
public func windowLogMax(_ memBytes: Int, _ p: Int = 31) -> Int? {
    guard memBytes >= 0, memBytes <= MAX_WIRE_INTEGER, p == 30 || p == 31 else { return nil }
    var n = 0
    var v = memBytes - 1
    while v > 0 {
        n += 1
        v /= 2
    }
    return Swift.max(10, Swift.min(p, n))
}

/// The window check itself: true when `frame`'s header window is known and at most
/// 2^`windowLogMax(memBytes, p)`.
public func windowAllowed(_ frame: [UInt8], memBytes: Int, p: Int = 31) -> Bool {
    guard let limit = windowLogMax(memBytes, p), let window = frameWindow(frame) else {
        return false
    }
    return window <= (1 << limit)
}

// ── packSetId (plans/P4-01.md §2.9) ──────────────────────────────────────────────────────────

/// One member of a pack set: the pack id and the record hash of its release.
public struct PackSetEntry: Sendable, Equatable {
    public var packId: String
    public var releaseSha256: String

    public init(packId: String, releaseSha256: String) {
        self.packId = packId
        self.releaseSha256 = releaseSha256
    }
}

/// The lowercase hex SHA-256 of the UTF-8 lines `<packId> <releaseSha256>\n`, sorted by pack-id
/// bytes. Nil when a pack id is invalid, a release is not 64 lowercase hex, or a pack is listed
/// twice. The empty set hashes the empty string. Never throws.
public func packSetId(_ entries: [PackSetEntry]) -> String? {
    var seen = Set<String>()
    for e in entries {
        guard isPackId(e.packId), isSha256Hex(e.releaseSha256), seen.insert(e.packId).inserted
        else { return nil }
    }
    var h = PackHasher()
    for e in entries.sorted(by: { compareUTF8Bytes($0.packId, $1.packId) < 0 }) {
        h.update(Array("\(e.packId) \(e.releaseSha256)\n".utf8))
    }
    return h.digest()
}

// ── The content stamp, `pkey-content/1` (plans/P4-01.md §2.6, §2.8) ──────────────────────────

/// What `parseContentStamp` reports.
public enum ParseContentStampResult: Sendable, Equatable {
    case ok(AppContent)
    /// `content-stamp-invalid`.
    case invalid

    public var content: AppContent? {
        if case .ok(let c) = self { return c }
        return nil
    }

    public var json: JSONValue {
        switch self {
        case .ok(let c): return .object(["ok": .bool(true), "content": c.json])
        case .invalid:
            return .object(["ok": .bool(false), "error": .string(ErrorCode.contentStampInvalid)])
        }
    }
}

/// Parse a content stamp file's bytes: strict JSON (WIRE-CONTRACT-V4 §1.2), `format ==
/// "pkey-content/1"`, and §2.4's `content` claims with pointers at the stamp's top level.
/// Unknown members are ignored. Never throws.
public func parseContentStamp(_ input: [UInt8]) -> ParseContentStampResult {
    guard let (doc, nonWire) = strictParse(input), let o = doc.objectValue,
        o["format"]?.stringValue == CONTENT_STAMP_FORMAT,
        contentClaims(doc, nonWire: nonWire, pointer: ""),
        let content = AppContent(json: doc)
    else { return .invalid }
    return .ok(content)
}

public func parseContentStamp(_ text: String) -> ParseContentStampResult {
    parseContentStamp(Array(text.utf8))
}
