// The upload planner (WIRE-CONTRACT-V5 §13.8.1): from a stored size and the collection's
// `files.delta`, the mode of a file transfer, the part size of a multipart one and its part count.
// `begin` answers the same numbers; a client plans first so it can pick `format` and slice parts.
//
//   tooLarge   over SYNC_FILE_MAX_BYTES (1 GiB)
//   chunks     files.delta and at least 1 MiB (chunked, never multipart)
//   single     at most SYNC_SINGLE_PUT_MAX_BYTES (16 MiB): one PUT
//   multipart  otherwise: partBytes = clamp(8 MiB .. 64 MiB, ceil(size / 9,999) up to a MiB)

import Foundation

public enum SyncTransferPlan {
    /// A file below this is never chunked, even when its collection has `files.delta`.
    public static let chunkedMinBytes = 1_048_576

    /// The wire words are `single`, `multipart`, `chunks` and `too_large`.
    public enum Mode: String, Sendable, Equatable {
        case single, multipart, chunks
        case tooLarge = "too_large"
    }

    public struct Plan: Equatable, Sendable {
        public let mode: Mode
        /// The size of every part but the last; only for `multipart`.
        public let partBytes: Int?
        /// The part count; only for `multipart`.
        public let parts: Int?
    }

    /// The plan for a stored file of `size` bytes (the sealed size in E2E mode, `SyncFileStream.sealedSize`).
    /// Nil for a negative size.
    public static func plan(size: Int, delta: Bool) -> Plan? {
        guard size >= 0 else { return nil }
        if size > SYNC_FILE_MAX_BYTES { return Plan(mode: .tooLarge, partBytes: nil, parts: nil) }
        if delta && size >= chunkedMinBytes { return Plan(mode: .chunks, partBytes: nil, parts: nil) }
        if size <= SYNC_SINGLE_PUT_MAX_BYTES { return Plan(mode: .single, partBytes: nil, parts: nil) }
        let perPart = (size + SYNC_MAX_PARTS - 1) / SYNC_MAX_PARTS
        let rounded = (perPart + SYNC_PART_ROUND_BYTES - 1) / SYNC_PART_ROUND_BYTES * SYNC_PART_ROUND_BYTES
        let partBytes = min(max(SYNC_PART_MIN_BYTES, rounded), SYNC_PART_MAX_BYTES)
        return Plan(mode: .multipart, partBytes: partBytes, parts: (size + partBytes - 1) / partBytes)
    }

    /// Part `n` (from 1) of a multipart plan as a half-open byte range of the stored file; nil for a
    /// plan that is not multipart or a part number outside it.
    public static func partRange(_ plan: Plan, size: Int, part n: Int) -> Range<Int>? {
        guard plan.mode == .multipart, let partBytes = plan.partBytes, let parts = plan.parts,
            n >= 1, n <= parts
        else { return nil }
        let start = (n - 1) * partBytes
        return start..<min(size, start + partBytes)
    }
}
