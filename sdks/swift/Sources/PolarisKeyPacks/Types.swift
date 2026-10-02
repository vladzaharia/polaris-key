// The typed views of packs on the wire (`@polaris-key/protocol/packs`; plans/P4-01.md §2.3–§2.8).
// Each is built from a `JSONValue` that already passed its claims (the record's step 14, the
// files index's member rules, the stamp's `contentClaims`); the views are SHAPE only and keep
// unknown vocabulary values as strings, so an unusable codec, layout, method or scope stays
// visible to the selection and planning rules rather than being dropped at parse.

import Foundation
import PolarisKeyCore

/// An object ref `{sha256, bytes, size, codec}` over the stored bytes.
public struct PackObjectRef: Sendable, Equatable {
    public var sha256: String
    public var bytes: Int
    public var size: Int
    public var codec: String

    public init(sha256: String, bytes: Int, size: Int, codec: String) {
        self.sha256 = sha256
        self.bytes = bytes
        self.size = size
        self.codec = codec
    }

    public init?(json: JSONValue?) {
        guard let o = json?.objectValue, let sha = o["sha256"]?.stringValue,
            let bytes = o["bytes"]?.intValue, let size = o["size"]?.intValue,
            let codec = o["codec"]?.stringValue
        else { return nil }
        self.init(sha256: sha, bytes: bytes, size: size, codec: codec)
    }

    public var json: JSONValue {
        .object([
            "sha256": .string(sha256), "bytes": .int(bytes), "size": .int(size),
            "codec": .string(codec),
        ])
    }
}

/// A `{sha256, bytes}` member: a payload delta's `artifact`, a files delta's `data`.
public struct PackHashBytes: Sendable, Equatable {
    public var sha256: String
    public var bytes: Int

    public init(sha256: String, bytes: Int) {
        self.sha256 = sha256
        self.bytes = bytes
    }

    public init?(json: JSONValue?) {
        guard let o = json?.objectValue, let sha = o["sha256"]?.stringValue,
            let bytes = o["bytes"]?.intValue
        else { return nil }
        self.init(sha256: sha, bytes: bytes)
    }
}

/// A variant's `files` member: an object ref plus `format`, `layout` and (a container's) `gaps`.
public struct PackFilesRef: Sendable, Equatable {
    public var format: String?
    public var layout: String
    public var sha256: String
    public var bytes: Int
    public var size: Int
    public var codec: String
    /// A container's gaps ref; nil when absent or without a `size`.
    public var gaps: PackObjectRef?

    public init(
        format: String?, layout: String, sha256: String, bytes: Int, size: Int, codec: String,
        gaps: PackObjectRef?
    ) {
        self.format = format
        self.layout = layout
        self.sha256 = sha256
        self.bytes = bytes
        self.size = size
        self.codec = codec
        self.gaps = gaps
    }

    public init?(json: JSONValue?) {
        guard let o = json?.objectValue, let layout = o["layout"]?.stringValue,
            let sha = o["sha256"]?.stringValue, let bytes = o["bytes"]?.intValue,
            let size = o["size"]?.intValue, let codec = o["codec"]?.stringValue
        else { return nil }
        self.init(
            format: o["format"]?.stringValue, layout: layout, sha256: sha, bytes: bytes, size: size,
            codec: codec, gaps: PackObjectRef(json: o["gaps"]))
    }

    public var ref: PackObjectRef { PackObjectRef(sha256: sha256, bytes: bytes, size: size, codec: codec) }
}

/// One entry of `deltas[]`.
public enum PackDelta: Sendable, Equatable {
    /// `scope: "payload"`: one raw-prefix frame over the whole installed payload.
    case payload(method: String, from: String, memBytes: Int, artifact: PackHashBytes)
    /// `scope: "files"`: the `pkey-patch/1` descriptor and its packed data object.
    case files(method: String, from: String, memBytes: Int, patch: PackObjectRef, data: PackHashBytes)
    /// Any other scope (unusable in v1).
    case other(scope: String, method: String, from: String, memBytes: Int)

    public init?(json: JSONValue) {
        guard let o = json.objectValue, let scope = o["scope"]?.stringValue,
            let method = o["method"]?.stringValue, let from = o["from"]?.stringValue,
            let mem = o["memBytes"]?.intValue
        else { return nil }
        if scope == "payload", let a = PackHashBytes(json: o["artifact"]) {
            self = .payload(method: method, from: from, memBytes: mem, artifact: a)
        } else if scope == "files", let p = PackObjectRef(json: o["patch"]),
            let d = PackHashBytes(json: o["data"])
        {
            self = .files(method: method, from: from, memBytes: mem, patch: p, data: d)
        } else {
            self = .other(scope: scope, method: method, from: from, memBytes: mem)
        }
    }

    public var scope: String {
        switch self {
        case .payload: return "payload"
        case .files: return "files"
        case .other(let s, _, _, _): return s
        }
    }

    public var method: String {
        switch self {
        case .payload(let m, _, _, _), .files(let m, _, _, _, _), .other(_, let m, _, _): return m
        }
    }

    public var from: String {
        switch self {
        case .payload(_, let f, _, _), .files(_, let f, _, _, _), .other(_, _, let f, _): return f
        }
    }

    public var memBytes: Int {
        switch self {
        case .payload(_, _, let m, _), .files(_, _, let m, _, _), .other(_, _, _, let m): return m
        }
    }

    /// The delta's id: a payload delta's artifact hash, a files delta's patch hash.
    public var id: String? {
        switch self {
        case .payload(_, _, _, let a): return a.sha256
        case .files(_, _, _, let p, _): return p.sha256
        case .other: return nil
        }
    }
}

/// `payload {size, sha256}`.
public struct PackPayload: Sendable, Equatable {
    public var size: Int
    public var sha256: String

    public init(size: Int, sha256: String) {
        self.size = size
        self.sha256 = sha256
    }

    public init?(json: JSONValue?) {
        guard let o = json?.objectValue, let size = o["size"]?.intValue,
            let sha = o["sha256"]?.stringValue
        else { return nil }
        self.init(size: size, sha256: sha)
    }

    public var json: JSONValue { .object(["size": .int(size), "sha256": .string(sha256)]) }
}

/// One variant of a pack record.
/// A variant's chunk-index reference (plans/P4-10.md §2.2): `format` plus an object ref.
/// `params` and other members are informative and not kept.
public struct PackChunksRef: Sendable, Equatable {
    public var format: String?
    public var ref: PackObjectRef

    public init(format: String?, ref: PackObjectRef) {
        self.format = format
        self.ref = ref
    }

    public init?(json: JSONValue?) {
        guard let o = json?.objectValue, let ref = PackObjectRef(json: json) else { return nil }
        self.init(format: o["format"]?.stringValue, ref: ref)
    }
}

public struct PackVariant: Sendable, Equatable {
    public var variant: [String: String]
    public var payload: PackPayload
    public var full: PackObjectRef?
    public var files: PackFilesRef
    public var deltas: [PackDelta]
    public var requires: [String: JSONValue]?
    /// plans/P4-10.md §2.2: the chunk index, valid but ignored on a `tree`.
    public var chunks: PackChunksRef?

    public init?(json: JSONValue) {
        guard let o = json.objectValue, let payload = PackPayload(json: o["payload"]) else {
            return nil
        }
        // A variant a claim check passed always has `files`; a fragment without one (a corpus
        // apply case for a payload delta) reads as an empty layout, which no rule can use.
        let files =
            PackFilesRef(json: o["files"])
            ?? PackFilesRef(format: nil, layout: "", sha256: "", bytes: 0, size: 0, codec: "", gaps: nil)
        var sel: [String: String] = [:]
        for (k, v) in o["variant"]?.objectValue ?? [:] { sel[k] = v.stringValue ?? "" }
        self.variant = sel
        self.payload = payload
        self.full = PackObjectRef(json: o["full"])
        self.files = files
        self.deltas = (o["deltas"]?.arrayValue ?? []).compactMap { PackDelta(json: $0) }
        self.requires = o["requires"]?.objectValue
        self.chunks = PackChunksRef(json: o["chunks"])
    }
}

/// A verified `kind: pack` record (plans/P4-01.md §2.3).
public struct PackRecordDoc: Sendable, Equatable {
    public let deliverable: String
    public let version: String
    public let seq: Int
    public let issuedAt: Int
    public let type: String
    public let formatVersion: Int
    /// `handler.activation`, when the record names one.
    public let activation: String?
    public let entitlement: String?
    public let variants: [PackVariant]
    /// The payload as verified.
    public let json: JSONValue

    public init?(json: JSONValue) {
        guard let o = json.objectValue, o["kind"]?.stringValue == "pack",
            let deliverable = o["deliverable"]?.stringValue, let version = o["version"]?.stringValue,
            let seq = o["seq"]?.intValue, let issuedAt = o["issuedAt"]?.intValue,
            let type = o["type"]?.stringValue, let fv = o["formatVersion"]?.intValue,
            let raw = o["variants"]?.arrayValue
        else { return nil }
        var variants: [PackVariant] = []
        for v in raw {
            guard let pv = PackVariant(json: v) else { return nil }
            variants.append(pv)
        }
        self.deliverable = deliverable
        self.version = version
        self.seq = seq
        self.issuedAt = issuedAt
        self.type = type
        self.formatVersion = fv
        self.activation = o["handler"]?.objectValue?["activation"]?.stringValue
        self.entitlement = o["entitlement"]?.stringValue
        self.variants = variants
        self.json = json
    }
}

/// One entry of a `pkey-files/1` index.
public struct FilesIndexEntry: Sendable, Equatable {
    public struct Blob: Sendable, Equatable {
        public var sha256: String
        public var bytes: Int
        public var codec: String
    }
    public var path: String
    public var size: Int
    public var sha256: String
    public var blob: Blob
    public var offset: Int?
}

/// A parsed `pkey-files/1` index.
public struct FilesIndexDoc: Sendable, Equatable {
    public var layout: String
    public var payload: PackPayload
    public var files: [FilesIndexEntry]
    /// The document as parsed (what a host keeps beside an install).
    public var json: JSONValue

    /// The typed view of an index that passed `parseFilesIndex`'s member rules (or a kept copy).
    public init?(json: JSONValue) {
        guard let o = json.objectValue, let layout = o["layout"]?.stringValue,
            let payload = PackPayload(json: o["payload"]), let list = o["files"]?.arrayValue
        else { return nil }
        var files: [FilesIndexEntry] = []
        files.reserveCapacity(list.count)
        for e in list {
            guard let eo = e.objectValue, let path = eo["path"]?.stringValue,
                let size = eo["size"]?.intValue, let sha = eo["sha256"]?.stringValue,
                let b = eo["blob"]?.objectValue, let bs = b["sha256"]?.stringValue,
                let bb = b["bytes"]?.intValue, let bc = b["codec"]?.stringValue
            else { return nil }
            files.append(
                FilesIndexEntry(
                    path: path, size: size, sha256: sha,
                    blob: .init(sha256: bs, bytes: bb, codec: bc), offset: eo["offset"]?.intValue))
        }
        self.layout = layout
        self.payload = payload
        self.files = files
        self.json = json
    }
}

/// One pin of the content stamp / an app record's `content`.
public struct ContentPin: Sendable, Equatable {
    public var pack: String
    public var sha256: String
    public var seq: Int
    public var version: String

    public init(pack: String, sha256: String, seq: Int, version: String) {
        self.pack = pack
        self.sha256 = sha256
        self.seq = seq
        self.version = version
    }
}

/// One `expects` entry.
public struct ContentExpect: Sendable, Equatable {
    public var pack: String
    public var required: Bool
    public var delivery: String

    public init(pack: String, required: Bool, delivery: String) {
        self.pack = pack
        self.required = required
        self.delivery = delivery
    }
}

/// An app's `content` (plans/P4-01.md §2.4): what the running build pins and expects.
public struct AppContent: Sendable, Equatable {
    public var contentApi: Int
    public var pins: [ContentPin]
    public var expects: [ContentExpect]

    public init(contentApi: Int, pins: [ContentPin], expects: [ContentExpect]) {
        self.contentApi = contentApi
        self.pins = pins
        self.expects = expects
    }

    /// The view of a value that passed `contentClaims`.
    public init?(json: JSONValue) {
        guard let o = json.objectValue, let api = o["contentApi"]?.intValue,
            let pins = o["pins"]?.arrayValue, let expects = o["expects"]?.arrayValue
        else { return nil }
        var ps: [ContentPin] = []
        for p in pins {
            guard let po = p.objectValue, let pack = po["pack"]?.stringValue,
                let r = po["release"]?.objectValue, let sha = r["sha256"]?.stringValue,
                let seq = r["seq"]?.intValue, let v = r["version"]?.stringValue
            else { return nil }
            ps.append(ContentPin(pack: pack, sha256: sha, seq: seq, version: v))
        }
        var es: [ContentExpect] = []
        for e in expects {
            guard let eo = e.objectValue, let pack = eo["pack"]?.stringValue,
                let req = eo["required"]?.boolValue, let d = eo["delivery"]?.stringValue
            else { return nil }
            es.append(ContentExpect(pack: pack, required: req, delivery: d))
        }
        self.init(contentApi: api, pins: ps, expects: es)
    }

    public var json: JSONValue {
        .object([
            "contentApi": .int(contentApi),
            "pins": .array(
                pins.map {
                    .object([
                        "pack": .string($0.pack),
                        "release": .object([
                            "sha256": .string($0.sha256), "seq": .int($0.seq),
                            "version": .string($0.version),
                        ]),
                    ])
                }),
            "expects": .array(
                expects.map {
                    .object([
                        "pack": .string($0.pack), "required": .bool($0.required),
                        "delivery": .string($0.delivery),
                    ])
                }),
        ])
    }
}

// ── JSON helpers ─────────────────────────────────────────────────────────────────────────────

/// V4 §1.2's strict JSON over UTF-8 bytes (no BOM, duplicate members refused, an object at the
/// top), with the integer rule's pointers; nil on any failure.
public func strictParse(_ bytes: [UInt8]) -> (value: JSONValue, nonWire: NonWireIntegers)? {
    let data = Data(bytes)
    guard let nonWire = StrictJSON.validate(data) else { return nil }
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
    return (value, nonWire)
}

/// Canonical JSON text of a value (sorted keys), for comparisons and storage.
public func canonicalJSON(_ value: JSONValue) -> String {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return (try? String(decoding: enc.encode(value), as: UTF8.self)) ?? "null"
}

/// A JSON value from text, or nil.
public func parseJSON(_ text: String) -> JSONValue? {
    try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}
