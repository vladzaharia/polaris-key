// The files index, `pkey-files/1`, its path rules and `treeDigest` (plans/P4-01.md §2.7;
// WIRE-CONTRACT-V4 §2.6). client-core `packs/files.ts` is the reference.

import Foundation
import PolarisKeyCore

/// What `checkPaths` reports.
public enum CheckPathsResult: Sendable, Equatable {
    case ok
    /// `files-unsafe-path`, `files-duplicate-path`, `files-case-collision` or
    /// `files-path-conflict`, with the later path.
    case refused(error: String, path: String)

    public var json: JSONValue {
        switch self {
        case .ok: return .object(["ok": .bool(true)])
        case .refused(let e, let p):
            return .object(["ok": .bool(false), "error": .string(e), "path": .string(p)])
        }
    }
}

private let BAD_CHARS: Set<UInt8> = Set("\\:*?\"<>|".utf8)
private let DEVICES: Set<String> = {
    var s: Set<String> = ["con", "prn", "aux", "nul"]
    for d in 1...9 {
        s.insert("com\(d)")
        s.insert("lpt\(d)")
    }
    return s
}()

/// ASCII-only lowercase: paths are ASCII by rule 2, so nothing else needs folding.
func asciiLower(_ s: String) -> String {
    String(decoding: s.utf8.map { $0 >= 0x41 && $0 <= 0x5a ? $0 + 32 : $0 }, as: UTF8.self)
}

/// Path rules 1–3 (A7 §3.3) and the `.pkey` addition (plans/P4-01.md §2.7).
func pathSafe(_ path: String) -> Bool {
    let n = path.utf8.count
    if n < 1 || n > MAX_PACK_PATH_BYTES { return false }
    for c in path.utf8 where c < 0x20 || c > 0x7e || BAD_CHARS.contains(c) { return false }
    let segments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    if asciiLower(segments[0]) == ".pkey" { return false }
    for s in segments {
        if s.isEmpty || s == "." || s == ".." { return false }
        if s.hasSuffix(" ") || s.hasSuffix(".") { return false }
        let stem = String(s.split(separator: ".", omittingEmptySubsequences: false)[0])
        if DEVICES.contains(asciiLower(stem)) { return false }
    }
    return true
}

/// The path rules, in order (plans/P4-01.md §2.7, A7 §3.3): a path that breaks rules 1–3 or
/// whose first segment is `.pkey` (any case) is `files-unsafe-path`; an exact duplicate is
/// `files-duplicate-path`; an ASCII-case-insensitive duplicate `files-case-collision`; a path
/// that is a directory prefix of another, or has one as its prefix (case-insensitively),
/// `files-path-conflict`. The later path is reported. Run before any byte is written.
public func checkPaths(_ paths: [String]) -> CheckPathsResult {
    var seen = Set<String>()
    var lower = Set<String>()
    var dirs = Set<String>()
    for path in paths {
        if !pathSafe(path) { return .refused(error: ErrorCode.filesUnsafePath, path: path) }
        if seen.contains(path) { return .refused(error: ErrorCode.filesDuplicatePath, path: path) }
        let lp = asciiLower(path)
        if lower.contains(lp) { return .refused(error: ErrorCode.filesCaseCollision, path: path) }
        let parts = lp.split(separator: "/", omittingEmptySubsequences: false)
        var prefixes: [String] = []
        if parts.count > 1 {
            for k in 1..<parts.count { prefixes.append(parts[0..<k].joined(separator: "/")) }
        }
        if dirs.contains(lp) || prefixes.contains(where: { lower.contains($0) }) {
            return .refused(error: ErrorCode.filesPathConflict, path: path)
        }
        seen.insert(path)
        lower.insert(lp)
        for x in prefixes { dirs.insert(x) }
    }
    return .ok
}

/// One file as `treeDigest` reads it.
public struct TreeFile: Sendable, Equatable {
    public var path: String
    public var size: Int
    public var sha256: String

    public init(path: String, size: Int, sha256: String) {
        self.path = path
        self.size = size
        self.sha256 = sha256
    }
}

/// `treeDigest` (plans/P4-01.md §2.7): the lowercase hex SHA-256 of the UTF-8 text made of one
/// line `<sha256hex> <size> <path>\n` per file, sorted by path bytes; size in decimal without
/// leading zeros. An empty tree hashes the empty string.
public func treeDigest(_ files: [TreeFile]) -> String {
    var h = PackHasher()
    for f in files.sorted(by: { compareUTF8Bytes($0.path, $1.path) < 0 }) {
        h.update(Array("\(f.sha256) \(f.size) \(f.path)\n".utf8))
    }
    return h.digest()
}

public func treeDigest(_ entries: [FilesIndexEntry]) -> String {
    treeDigest(entries.map { TreeFile(path: $0.path, size: $0.size, sha256: $0.sha256) })
}

/// What `parseFilesIndex` reports.
public enum ParseFilesIndexResult: Sendable, Equatable {
    case ok(FilesIndexDoc)
    case refused(error: String, path: String?)

    public var index: FilesIndexDoc? {
        if case .ok(let i) = self { return i }
        return nil
    }
}

private let invalidIndex = ParseFilesIndexResult.refused(
    error: ErrorCode.filesIndexInvalid, path: nil)

private func layoutMismatch() -> ParseFilesIndexResult {
    .refused(error: ErrorCode.filesLayoutMismatch, path: nil)
}

/// The member rules of one entry (plans/P4-01.md §2.7), integer rule included.
private func entryOk(_ e: JSONValue, _ i: Int, _ container: Bool, _ nonWire: NonWireIntegers)
    -> Bool
{
    guard let o = e.objectValue else { return false }
    let at = "/files/\(i)"
    guard o["path"]?.stringValue != nil else { return false }
    guard packWireInt(o["size"], "\(at)/size", 0, nonWire) else { return false }
    guard let sha = o["sha256"]?.stringValue, isSha256Hex(sha) else { return false }
    guard let b = o["blob"]?.objectValue else { return false }
    guard let bs = b["sha256"]?.stringValue, isSha256Hex(bs) else { return false }
    guard packWireInt(b["bytes"], "\(at)/blob/bytes", 0, nonWire) else { return false }
    let codec = b["codec"]?.stringValue
    if codec == "none" {
        if b["bytes"]?.packInt != o["size"]?.packInt || bs != sha { return false }
    } else if codec != "zstd" {
        return false
    }
    if container, !packWireInt(o["offset"], "\(at)/offset", 0, nonWire) { return false }
    return true
}

/// `parseFilesIndex(stored, ref, variant)` (plans/P4-01.md §2.7): the first failure, in order:
///
///  1. `ref.size` above the limit (checked before anything is decoded), the stored SHA-256 or
///     length differs from the ref, the decode fails, or the decoded length is not `ref.size`
///     → `files-index-invalid`;
///  2. strict JSON or the integer rule → `files-index-invalid`;
///  3. `format`, `layout` (the ref's), `payload` (the variant's), `files` and the entry member
///     rules → `files-index-invalid`;
///  4. the path rules in index order → the path code, with `path`;
///  5. a container that breaks the layout rule → `files-layout-mismatch`; a tree whose paths
///     are not strictly ascending, whose sizes do not sum to `payload.size`, or whose
///     `treeDigest` differs from `payload.sha256` → `files-index-invalid`.
///
/// `decode` decodes a `codec: "zstd"` index (without it a zstd index is invalid). Never throws.
public func parseFilesIndex(
    _ stored: [UInt8], ref: PackFilesRef, payload: PackPayload,
    decode: ((_ frame: [UInt8], _ size: Int) throws -> [UInt8])?,
    maxBytes: Int = MAX_FILES_INDEX_BYTES
) -> ParseFilesIndexResult {
    // 1. The stored object against its ref, then the decode.
    if ref.size > maxBytes { return invalidIndex }
    if stored.count != ref.bytes { return invalidIndex }
    if sha256Of(stored) != ref.sha256 { return invalidIndex }
    let decoded: [UInt8]
    if ref.codec == "none" {
        decoded = stored
    } else if ref.codec == "zstd", let decode {
        guard let d = try? decode(stored, ref.size) else { return invalidIndex }
        decoded = d
    } else {
        return invalidIndex
    }
    if decoded.count != ref.size { return invalidIndex }

    // 2. Strict JSON; the integer rule runs with the member rules.
    guard let (doc, nonWire) = strictParse(decoded), let o = doc.objectValue else {
        return invalidIndex
    }

    // 3. The member rules.
    guard o["format"]?.stringValue == FILES_FORMAT, o["layout"]?.stringValue == ref.layout else {
        return invalidIndex
    }
    guard let p = o["payload"]?.objectValue else { return invalidIndex }
    guard packWireInt(p["size"], "/payload/size", 0, nonWire) else { return invalidIndex }
    guard let psha = p["sha256"]?.stringValue, isSha256Hex(psha) else { return invalidIndex }
    guard let psize = p["size"]?.packInt, psize == payload.size, psha == payload.sha256 else {
        return invalidIndex
    }
    guard let files = o["files"]?.arrayValue, files.count <= MAX_INDEX_FILES else {
        return invalidIndex
    }
    let container = ref.layout == "container"
    for (i, e) in files.enumerated() where !entryOk(e, i, container, nonWire) {
        return invalidIndex
    }
    guard let index = FilesIndexDoc(json: doc) else { return invalidIndex }
    let entries = index.files

    // 4. The path rules.
    if case .refused(let error, let path) = checkPaths(entries.map(\.path)) {
        return .refused(error: error, path: path)
    }

    // 5. The layout.
    var total = 0
    for e in entries { total = saturatingAdd(total, e.size) }
    if container {
        var end = 0
        for e in entries {
            let offset = e.offset ?? 0
            if offset < end { return layoutMismatch() }
            end = saturatingAdd(offset, e.size)
        }
        if end > psize { return layoutMismatch() }
        guard let gaps = ref.gaps else { return layoutMismatch() }
        if psize - total != gaps.size { return layoutMismatch() }
    } else if ref.layout == "tree" {
        if entries.count > 1 {
            for i in 1..<entries.count
            where compareUTF8Bytes(entries[i - 1].path, entries[i].path) >= 0 {
                return invalidIndex
            }
        }
        if total != psize { return invalidIndex }
        if treeDigest(entries) != psha { return invalidIndex }
    }
    return .ok(index)
}
