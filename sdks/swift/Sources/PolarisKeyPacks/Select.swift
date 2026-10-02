// Variant selection and target mapping (plans/P4-01.md §2.9; WIRE-CONTRACT-V4 §11.4).
// `plan-matrix.json#variantCases` pins `selectVariant` and `#targetCases` pins `planTarget`.
// client-core `packs/select.ts` is the reference. Pure.

import Foundation
import PolarisKeyCore

/// An object ref is usable when its codec is `zstd` or `none` (§2.9).
public func usableCodec(_ codec: String?) -> Bool { codec == "zstd" || codec == "none" }

/// The index is readable when `files.format` is `pkey-files/1`, its ref is usable and
/// `files.size` ≤ `MAX_FILES_INDEX_BYTES` (§2.9).
public func indexReadable(_ files: JSONValue?) -> Bool {
    guard let f = files?.objectValue else { return false }
    guard f["format"]?.stringValue == FILES_FORMAT, usableCodec(f["codec"]?.stringValue) else {
        return false
    }
    guard let size = f["size"]?.doubleValue else { return false }
    return size <= Double(MAX_FILES_INDEX_BYTES)
}

public func indexReadable(_ files: PackFilesRef) -> Bool {
    files.format == FILES_FORMAT && usableCodec(files.codec) && files.size <= MAX_FILES_INDEX_BYTES
}

/// A container's index and gaps together are rebuildable: a readable index and a usable gaps
/// ref. A tree needs only the readable index.
public func indexRebuildable(_ files: PackFilesRef) -> Bool {
    guard indexReadable(files) else { return false }
    if files.layout != "container" { return true }
    return usableCodec(files.gaps?.codec)
}

/// A variant is usable when its layout is `container`, or `tree` with a readable index.
public func variantUsable(_ variant: JSONValue) -> Bool {
    guard let v = variant.objectValue, let f = v["files"]?.objectValue else { return false }
    let layout = f["layout"]?.stringValue
    if layout == "container" { return true }
    return layout == "tree" && indexReadable(v["files"])
}

public func variantUsable(_ variant: PackVariant) -> Bool {
    if variant.files.layout == "container" { return true }
    return variant.files.layout == "tree" && indexReadable(variant.files)
}

/// What the host prefers: its engine (`godot-<major>.<minor>`, nil outside Godot) and, per
/// axis, its values in preference order.
public struct VariantPrefs: Sendable, Equatable {
    public var engine: String?
    public var axes: [String: [String]]

    public init(engine: String? = nil, axes: [String: [String]] = [:]) {
        self.engine = engine
        self.axes = axes
    }
}

/// What `selectVariant` reports.
public enum SelectVariantResult: Sendable, Equatable {
    case index(Int)
    /// `pack-no-variant`.
    case noVariant

    public var json: JSONValue {
        switch self {
        case .index(let i): return .object(["index": .int(i)])
        case .noVariant: return .object(["error": .string(ErrorCode.packNoVariant)])
        }
    }
}

/// `selectVariant(variants, {engine, axes})` (§2.9): a variant is eligible when it is usable,
/// its `requires.engine` is absent or equals the host's `engine`, and every axis it declares has
/// a host preference list containing its value (compared by bytes). The lowest tuple of
/// preference indexes over the axis names in byte order wins; ties keep the earlier variant.
public func selectVariant(_ variants: [JSONValue], _ prefs: VariantPrefs) -> SelectVariantResult {
    var best: (index: Int, key: [Int])?
    for (i, v) in variants.enumerated() {
        guard variantUsable(v), let variant = v.objectValue else { continue }
        if let req = variant["requires"]?.objectValue, let engine = req["engine"] {
            // A present engine must equal the host's (strict equality, as client-core's `!==`).
            let host: JSONValue = prefs.engine.map { .string($0) } ?? .null
            if engine != host { continue }
        }
        let sel = variant["variant"]?.objectValue ?? [:]
        var key: [Int] = []
        var eligible = true
        for axis in sel.keys.sorted(by: { compareUTF8Bytes($0, $1) < 0 }) {
            guard let list = prefs.axes[axis], let value = sel[axis]?.stringValue,
                let k = list.firstIndex(of: value)
            else {
                eligible = false
                break
            }
            key.append(k)
        }
        if !eligible { continue }
        if best == nil || key.lexicographicallyPrecedes(best!.key) { best = (i, key) }
    }
    return best.map { .index($0.index) } ?? .noVariant
}

/// A delta of the planner's input (A7 §4.1).
public struct PlanDelta: Sendable, Equatable {
    public var id: String
    public var method: String
    public var from: String
    public var memBytes: Int
    public var artifacts: [PackHashBytes]

    public init(id: String, method: String, from: String, memBytes: Int, artifacts: [PackHashBytes]) {
        self.id = id
        self.method = method
        self.from = from
        self.memBytes = memBytes
        self.artifacts = artifacts
    }
}

/// One chunk record `[id, len, clen, bundle, offset]` (P4-10, P4-11).
public struct PlanChunkRecord: Sendable, Equatable {
    public var id: String
    public var len: Int
    public var clen: Int
    public var bundle: Int
    public var offset: Int

    public init(id: String, len: Int, clen: Int, bundle: Int, offset: Int) {
        self.id = id
        self.len = len
        self.clen = clen
        self.bundle = bundle
        self.offset = offset
    }
}

/// The planner's target (A7 §4.1, with `full.requests`; plans/P4-01.md §2.9).
public struct PlanTarget: Sendable, Equatable {
    public struct Full: Sendable, Equatable {
        public var bytes: Int
        public var requests: Int?
    }
    public struct Chunks: Sendable, Equatable {
        public var indexBytes: Int
        public var records: [PlanChunkRecord]
    }
    public struct FileBlob: Sendable, Equatable {
        public var sha256: String
        public var blobBytes: Int
    }
    public struct Files: Sendable, Equatable {
        public var indexBytes: Int
        public var gapsBytes: Int
        public var files: [FileBlob]
    }

    public var release: String
    public var payload: PackPayload
    public var full: Full?
    public var platform: String?
    public var chunks: Chunks?
    public var files: Files?
    public var deltas: [PlanDelta]

    public init(
        release: String, payload: PackPayload, full: Full?, platform: String?, chunks: Chunks?,
        files: Files?, deltas: [PlanDelta]
    ) {
        self.release = release
        self.payload = payload
        self.full = full
        self.platform = platform
        self.chunks = chunks
        self.files = files
        self.deltas = deltas
    }

    /// The target as the corpus writes it.
    public var json: JSONValue {
        var full: JSONValue = .null
        if let f = self.full {
            var o: [String: JSONValue] = ["bytes": .int(f.bytes)]
            if let r = f.requests { o["requests"] = .int(r) }
            full = .object(o)
        }
        var chunks: JSONValue = .null
        if let c = self.chunks {
            chunks = .object([
                "indexBytes": .int(c.indexBytes),
                "records": .array(
                    c.records.map {
                        .array([.string($0.id), .int($0.len), .int($0.clen), .int($0.bundle), .int($0.offset)])
                    }),
            ])
        }
        var files: JSONValue = .null
        if let f = self.files {
            files = .object([
                "indexBytes": .int(f.indexBytes), "gapsBytes": .int(f.gapsBytes),
                "files": .array(
                    f.files.map {
                        .object(["sha256": .string($0.sha256), "blobBytes": .int($0.blobBytes)])
                    }),
            ])
        }
        return .object([
            "release": .string(release), "payload": payload.json, "full": full,
            "platform": platform.map { .object(["transport": .string($0)]) } ?? .null,
            "chunks": chunks, "files": files,
            "deltas": .array(
                deltas.map {
                    .object([
                        "id": .string($0.id), "method": .string($0.method), "from": .string($0.from),
                        "memBytes": .int($0.memBytes),
                        "artifacts": .array(
                            $0.artifacts.map {
                                .object(["sha256": .string($0.sha256), "bytes": .int($0.bytes)])
                            }),
                    ])
                }),
        ])
    }

    /// A target from the corpus's JSON (`plan-matrix.json#rows[].input.target`).
    public init?(json: JSONValue) {
        guard let o = json.objectValue, let release = o["release"]?.stringValue,
            let payload = PackPayload(json: o["payload"])
        else { return nil }
        self.release = release
        self.payload = payload
        if let f = o["full"]?.objectValue, let b = f["bytes"]?.intValue {
            self.full = Full(bytes: b, requests: f["requests"]?.intValue)
        } else {
            self.full = nil
        }
        self.platform = o["platform"]?.objectValue?["transport"]?.stringValue
        if let c = o["chunks"]?.objectValue, let ib = c["indexBytes"]?.intValue {
            var recs: [PlanChunkRecord] = []
            for r in c["records"]?.arrayValue ?? [] {
                guard let a = r.arrayValue, a.count == 5, let id = a[0].stringValue,
                    let len = a[1].intValue, let clen = a[2].intValue, let bundle = a[3].intValue,
                    let off = a[4].intValue
                else { return nil }
                recs.append(PlanChunkRecord(id: id, len: len, clen: clen, bundle: bundle, offset: off))
            }
            self.chunks = Chunks(indexBytes: ib, records: recs)
        } else {
            self.chunks = nil
        }
        if let f = o["files"]?.objectValue, let ib = f["indexBytes"]?.intValue,
            let gb = f["gapsBytes"]?.intValue
        {
            var list: [FileBlob] = []
            for x in f["files"]?.arrayValue ?? [] {
                guard let xo = x.objectValue, let s = xo["sha256"]?.stringValue,
                    let b = xo["blobBytes"]?.intValue
                else { return nil }
                list.append(FileBlob(sha256: s, blobBytes: b))
            }
            self.files = Files(indexBytes: ib, gapsBytes: gb, files: list)
        } else {
            self.files = nil
        }
        var deltas: [PlanDelta] = []
        for d in o["deltas"]?.arrayValue ?? [] {
            guard let dobj = d.objectValue, let id = dobj["id"]?.stringValue,
                let m = dobj["method"]?.stringValue, let from = dobj["from"]?.stringValue,
                let mem = dobj["memBytes"]?.intValue
            else { return nil }
            let arts = (dobj["artifacts"]?.arrayValue ?? []).compactMap { PackHashBytes(json: $0) }
            deltas.append(PlanDelta(id: id, method: m, from: from, memBytes: mem, artifacts: arts))
        }
        self.deltas = deltas
    }
}

/// `planTarget(variant, recordSha256, filesIndex | nil)` (§2.9): a variant onto the planner's
/// input. An unusable variant maps to no candidate at all. `full` needs a usable ref whose size
/// is the payload's (a tree's costs its index too, in two requests); `files` needs the index, a
/// readable one (a container: rebuildable); a `payload` delta is kept on a container, a `files`
/// delta when `files` is kept and its `patch` ref is usable; anything else is dropped. The
/// method is passed through for the planner's `caps.patchMethods` to decide.
public func planTarget(
    _ variant: PackVariant, recordSha256: String, filesIndex: FilesIndexDoc?
) -> PlanTarget {
    let payload = variant.payload
    if !variantUsable(variant) {
        return PlanTarget(
            release: recordSha256, payload: payload, full: nil, platform: nil, chunks: nil,
            files: nil, deltas: [])
    }
    let files = variant.files
    let container = files.layout == "container"
    var fullT: PlanTarget.Full?
    if let full = variant.full, usableCodec(full.codec), full.size == payload.size {
        fullT =
            container
            ? .init(bytes: full.bytes, requests: 1)
            : .init(bytes: full.bytes + files.bytes, requests: 2)
    }
    var filesT: PlanTarget.Files?
    if let filesIndex, indexRebuildable(files) {
        filesT = .init(
            indexBytes: files.bytes, gapsBytes: container ? (files.gaps?.bytes ?? 0) : 0,
            files: filesIndex.files.map { .init(sha256: $0.sha256, blobBytes: $0.blob.bytes) })
    }
    var deltas: [PlanDelta] = []
    for d in variant.deltas {
        switch d {
        case .payload(let method, let from, let mem, let a) where container:
            deltas.append(
                PlanDelta(id: a.sha256, method: method, from: from, memBytes: mem, artifacts: [a]))
        case .files(let method, let from, let mem, let patch, let data)
        where filesT != nil && usableCodec(patch.codec):
            var arts = [PackHashBytes(sha256: files.sha256, bytes: files.bytes)]
            if container, let g = files.gaps { arts.append(PackHashBytes(sha256: g.sha256, bytes: g.bytes)) }
            arts.append(PackHashBytes(sha256: patch.sha256, bytes: patch.bytes))
            arts.append(data)
            deltas.append(
                PlanDelta(id: patch.sha256, method: method, from: from, memBytes: mem, artifacts: arts))
        default:
            break
        }
    }
    return PlanTarget(
        release: recordSha256, payload: payload, full: fullT, platform: nil, chunks: nil,
        files: filesT, deltas: deltas)
}
