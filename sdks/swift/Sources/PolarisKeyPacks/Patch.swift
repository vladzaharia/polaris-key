// `pkey-patch/1`, the descriptor of a `files`-scope delta set (plans/P4-01.md §2.7;
// WIRE-CONTRACT-V4 §2.6), and the one object-ref opener every applier shares. client-core
// `packs/patch.ts` is the reference.

import Foundation
import PolarisKeyCore

/// A stored object against its ref, then its decoded bytes (§2.7 step 1): the stored length and
/// SHA-256 must equal the ref's, the codec be `zstd` (decoded to exactly `size`) or `none`. Nil
/// on any failure, the caller's code. `maxSize`, when given, refuses a larger `ref.size` before
/// a byte is read.
public func openObject(
    _ stored: (any ByteSource)?, _ ref: PackObjectRef, zstd: any ZstdPort, maxSize: Int? = nil
) -> [UInt8]? {
    guard let stored else { return nil }
    if let maxSize, !(ref.size <= maxSize) { return nil }
    if ref.codec != "zstd" && ref.codec != "none" { return nil }
    if stored.size != ref.bytes { return nil }
    guard let bytes = try? readAll(stored), bytes.count == ref.bytes else { return nil }
    if sha256Of(bytes) != ref.sha256 { return nil }
    let out: [UInt8]
    if ref.codec == "none" {
        out = bytes
    } else {
        guard let d = try? zstd.decode(bytes, size: ref.size) else { return nil }
        out = d
    }
    return out.count == ref.size ? out : nil
}

/// One entry of a parsed `pkey-patch/1` descriptor.
public struct PatchEntry: Sendable, Equatable {
    public var path: String
    public var op: String
    public var from: String?
    public var to: String
    public var size: Int
    public var codec: String?
    public var offset: Int
    public var length: Int
}

/// A parsed `pkey-patch/1` descriptor.
public struct PatchDoc: Sendable, Equatable {
    public var entries: [PatchEntry]
}

/// `parsePatch(stored, delta, targetPayloadSha256, targetIndex)` (§2.7): the descriptor of a
/// `files` delta set, or nil — the caller's `delta-artifact-mismatch`. Refused: a descriptor
/// whose `patch` ref fails `openObject` (`MAX_FILES_INDEX_BYTES` included), that is not strict
/// JSON or breaks the integer rule, whose `format`, `scope`, `method`, `from`, `to` or `data`
/// differ from the record's delta and the target, or whose entries break the member rules.
/// Never throws.
public func parsePatch(
    _ stored: (any ByteSource)?, method: String, from: String, patch: PackObjectRef,
    data: PackHashBytes, targetPayloadSha256: String, target: FilesIndexDoc, zstd: any ZstdPort
) -> PatchDoc? {
    guard let decoded = openObject(stored, patch, zstd: zstd, maxSize: MAX_FILES_INDEX_BYTES),
        let (doc, nonWire) = strictParse(decoded), let o = doc.objectValue
    else { return nil }
    guard o["format"]?.stringValue == PATCH_FORMAT, o["scope"]?.stringValue == "files" else {
        return nil
    }
    guard o["method"]?.stringValue == method, o["from"]?.stringValue == from else { return nil }
    guard o["to"]?.stringValue == targetPayloadSha256 else { return nil }
    guard let d = o["data"]?.objectValue, d["sha256"]?.stringValue == data.sha256 else {
        return nil
    }
    guard packWireInt(d["bytes"], "/data/bytes", 0, nonWire), d["bytes"]?.packInt == data.bytes
    else { return nil }
    guard let list = o["entries"]?.arrayValue, list.count <= MAX_INDEX_FILES else { return nil }
    var byPath: [String: Int] = [:]
    for (i, f) in target.files.enumerated() where byPath[f.path] == nil { byPath[f.path] = i }
    var seen = Set<String>()
    var lastIndex = -1
    var end = 0
    var entries: [PatchEntry] = []
    for (i, raw) in list.enumerated() {
        let at = "/entries/\(i)"
        guard let e = raw.objectValue, let path = e["path"]?.stringValue,
            seen.insert(path).inserted
        else { return nil }
        guard let ti = byPath[path], ti > lastIndex else { return nil }
        lastIndex = ti
        let tf = target.files[ti]
        guard e["to"]?.stringValue == tf.sha256 else { return nil }
        guard packWireInt(e["size"], "\(at)/size", 0, nonWire), e["size"]?.packInt == tf.size
        else { return nil }
        guard packWireInt(e["offset"], "\(at)/offset", 0, nonWire),
            packWireInt(e["length"], "\(at)/length", 0, nonWire),
            let offset = e["offset"]?.packInt, let length = e["length"]?.packInt
        else { return nil }
        if offset < end { return nil }
        end = saturatingAdd(offset, length)
        let op = e["op"]?.stringValue
        var fromHash: String?
        var codec: String?
        if op == "delta" {
            guard let f = e["from"]?.stringValue, isSha256Hex(f) else { return nil }
            fromHash = f
        } else if op == "blob" {
            codec = e["codec"]?.stringValue
            if codec == "none" {
                if length != tf.size { return nil }
            } else if codec != "zstd" {
                return nil
            }
        } else {
            return nil
        }
        entries.append(
            PatchEntry(
                path: path, op: op!, from: fromHash, to: tf.sha256, size: tf.size, codec: codec,
                offset: offset, length: length))
    }
    if end > data.bytes { return nil }
    return PatchDoc(entries: entries)
}
