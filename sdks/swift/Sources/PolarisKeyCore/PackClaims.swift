// The pack claims shared by the release record (step 14) and the content stamp (plans/P4-01.md
// §2.3, §2.4, §2.8; WIRE-CONTRACT-V4 §2.5.1, §2.5.2). client-core's `packs/claims.ts`,
// `packs/variant.ts` and the pack half of `record.ts` are the reference. Pure, never throws.
//
// These live in PolarisKeyCore, not PolarisKeyPacks, because `releaseRecordClaims` applies them
// at step 14 and Core cannot depend on the packs target. One `objectRef` checks every object ref
// (`full`, `files`, `gaps`, `patch`); `isPackId` is the one pack-id rule.

import Foundation

/// The pack patterns of `packages/shared-protocol/src/packs.ts` (plans/P4-01.md §2.3), restated
/// here because the constants generator does not carry regular expressions. Each is matched
/// against the WHOLE string (`wholeMatches`), never with `^…$`.
public enum PackPatterns {
    /// `PACK_TYPE_PATTERN`: `<family>.<kind>`, e.g. `godot.pck`, `files.tree`.
    public static let packType = #"[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}"#
    /// `VOCAB_TOKEN_PATTERN`: activation, layout, codec, delta method and scope, delivery.
    public static let vocabToken = #"[a-z][a-z0-9-]{0,31}"#
    /// `OBJECT_FORMAT_PATTERN`: `<name>/<version>`, e.g. `pkey-files/1`.
    public static let objectFormat = #"[a-z][a-z0-9-]{0,31}/[1-9][0-9]{0,8}"#
    /// `HANDLER_PREFIX_PATTERN`: `res://…/`.
    public static let handlerPrefix = #"res://([A-Za-z0-9_][A-Za-z0-9 ._@+-]*/)+"#
    /// `ENTITLEMENT_PATTERN`.
    public static let entitlement = #"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}"#
    /// `VARIANT_AXIS_PATTERN`.
    public static let variantAxis = #"[a-z][a-z0-9-]{0,15}"#
    /// `VARIANT_VALUE_PATTERN`.
    public static let variantValue = #"[A-Za-z0-9][A-Za-z0-9-]{0,34}"#
    /// `ENGINE_PATTERN`: `godot-<major>.<minor>`.
    public static let engine = #"godot-[0-9]+\.[0-9]+"#
    /// `@polaris-key/manifest`'s `DELIVERABLE_ID_PATTERN`.
    public static let deliverable = #"[a-z][a-z0-9-]*(\.[a-z0-9-]+)*"#
    /// P2-04's `VERSION_RE`.
    public static let version = #"[0-9A-Za-z][0-9A-Za-z.+-]{0,63}"#
}

/// Compiled once: `wholeMatches` compiles per call, which a files index of 100,000 entries
/// cannot afford for its hashes, so the hot checks below are hand-written.
private final class PatternCache: @unchecked Sendable {
    private let lock = NSLock()
    private var compiled: [String: NSRegularExpression] = [:]

    func matches(_ pattern: String, _ value: String) -> Bool {
        lock.lock()
        var re = compiled[pattern]
        if re == nil {
            re = try? NSRegularExpression(pattern: #"\A(?:"# + pattern + #")\z"#)
            compiled[pattern] = re
        }
        lock.unlock()
        guard let re else { return false }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let m = re.firstMatch(in: value, range: range) else { return false }
        return m.range == range
    }
}

private let patternCache = PatternCache()

/// Whole-string match through a cached compiled pattern (the same `\A(?:…)\z` rule as
/// `wholeMatches`).
package func packMatch(_ pattern: String, _ value: String) -> Bool {
    patternCache.matches(pattern, value)
}

/// 64 lowercase hex digits.
public func isSha256Hex(_ value: String) -> Bool {
    var n = 0
    for b in value.utf8 {
        guard (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66) else { return false }
        n += 1
    }
    return n == 64
}

extension JSONValue {
    /// The integer of a plain `.int` token (see `Feed.swift`'s `exactInt`), for the packs target.
    package var packInt: Int? {
        if case .int(let i) = self { return i }
        return nil
    }
}

/// An integer claim at `pointer` (WIRE-CONTRACT-V4 §3), decided from the token.
package func packWireInt(
    _ v: JSONValue?, _ pointer: String, _ min: Int, _ nonWire: NonWireIntegers
) -> Bool {
    guard let i = v?.packInt else { return false }
    return wireInteger(i, pointer: pointer, min: min, in: nonWire)
}

/// Compare two strings by their UTF-8 bytes (equal to code-point order).
public func compareUTF8Bytes(_ a: String, _ b: String) -> Int {
    if a == b { return 0 }
    var x = a.utf8.makeIterator()
    var y = b.utf8.makeIterator()
    while true {
        switch (x.next(), y.next()) {
        case (nil, nil): return 0
        case (nil, _): return -1
        case (_, nil): return 1
        case (let p?, let q?): if p != q { return Int(p) - Int(q) }
        }
    }
}

/// The variant key (plans/P4-01.md §2.3; WIRE-CONTRACT-V4 §8): the variant's `axis=value` pairs
/// sorted by axis-name bytes and joined with `;` (`locale=fr;texture=astc`); `""` for `{}`.
public func variantKey(_ variant: [String: String]) -> String {
    variant.keys.sorted { compareUTF8Bytes($0, $1) < 0 }.map { "\($0)=\(variant[$0]!)" }
        .joined(separator: ";")
}

/// A pack id (plans/P4-01.md §2.3): `DELIVERABLE_ID_PATTERN`, at most 64 bytes, and not `app`.
public func isPackId(_ value: JSONValue?) -> Bool {
    guard let s = value?.stringValue else { return false }
    return isPackId(s)
}

public func isPackId(_ value: String) -> Bool {
    value != "app" && value.utf8.count <= 64 && packMatch(PackPatterns.deliverable, value)
}

/// An object ref `{sha256, bytes, size, codec}` at `pointer` (plans/P4-01.md §2.3): `sha256` 64
/// lowercase hex; `bytes` and `size` integer claims from `minBytes` and `minSize`; `codec` a
/// `VOCAB_TOKEN_PATTERN` string; `codec: "none"` only with `bytes == size`. An unknown codec
/// verifies (the object is unusable, never the record invalid).
public func objectRef(
    _ value: JSONValue?, pointer: String, minBytes: Int, minSize: Int,
    nonWire: NonWireIntegers = []
) -> Bool {
    guard let o = value?.objectValue else { return false }
    guard let sha = o["sha256"]?.stringValue, isSha256Hex(sha) else { return false }
    guard packWireInt(o["bytes"], "\(pointer)/bytes", minBytes, nonWire),
        packWireInt(o["size"], "\(pointer)/size", minSize, nonWire)
    else { return false }
    guard let codec = o["codec"]?.stringValue, packMatch(PackPatterns.vocabToken, codec) else {
        return false
    }
    if codec == "none", o["bytes"]?.packInt != o["size"]?.packInt { return false }
    return true
}

/// The `content` claims (plans/P4-01.md §2.4): an object with an integer `contentApi` ≥ 1,
/// `pins` (0–256 objects, `pack` a unique pack id, `release {sha256, seq ≥ 1, version}`) and
/// `expects` (0–256 objects, `pack` a unique pack id, a boolean `required`, a
/// `VOCAB_TOKEN_PATTERN` `delivery`). Unknown members are ignored. `pointer` is `/content` in an
/// app record and `""` in a content stamp. Never throws.
public func contentClaims(
    _ value: JSONValue?, nonWire: NonWireIntegers = [], pointer: String = "/content"
) -> Bool {
    guard let o = value?.objectValue else { return false }
    guard packWireInt(o["contentApi"], "\(pointer)/contentApi", 1, nonWire) else { return false }
    guard let pins = o["pins"]?.arrayValue, pins.count <= MAX_CONTENT_PINS else { return false }
    var pinned = Set<String>()
    for (i, raw) in pins.enumerated() {
        guard let pin = raw.objectValue, isPackId(pin["pack"]),
            let pack = pin["pack"]?.stringValue, pinned.insert(pack).inserted
        else { return false }
        guard let r = pin["release"]?.objectValue else { return false }
        guard let sha = r["sha256"]?.stringValue, isSha256Hex(sha) else { return false }
        guard packWireInt(r["seq"], "\(pointer)/pins/\(i)/release/seq", 1, nonWire) else {
            return false
        }
        guard let v = r["version"]?.stringValue, packMatch(PackPatterns.version, v) else {
            return false
        }
    }
    guard let expects = o["expects"]?.arrayValue, expects.count <= MAX_CONTENT_PINS else {
        return false
    }
    var expected = Set<String>()
    for raw in expects {
        guard let e = raw.objectValue, isPackId(e["pack"]),
            let pack = e["pack"]?.stringValue, expected.insert(pack).inserted
        else { return false }
        guard e["required"]?.boolValue != nil else { return false }
        guard let d = e["delivery"]?.stringValue, packMatch(PackPatterns.vocabToken, d) else {
            return false
        }
    }
    return true
}

/// `builds[].embeds` (plans/P4-01.md §2.4): 0–64 unique pack ids.
package func embedsClaims(_ value: JSONValue) -> Bool {
    guard let list = value.arrayValue, list.count <= MAX_BUILD_EMBEDS else { return false }
    var seen = Set<String>()
    for id in list {
        guard isPackId(id), let s = id.stringValue, seen.insert(s).inserted else { return false }
    }
    return true
}

/// An optional member that must match `pattern` when present (a present `null` is refused).
private func optPattern(_ o: [String: JSONValue], _ key: String, _ pattern: String) -> Bool {
    guard let v = o[key] else { return true }
    guard let s = v.stringValue else { return false }
    return packMatch(pattern, s)
}

/// A `{sha256, bytes}` member (a delta's `artifact` or `data`): bytes ≥ 1.
private func hashBytesOk(_ v: JSONValue?, _ pointer: String, _ nonWire: NonWireIntegers) -> Bool {
    guard let o = v?.objectValue, let sha = o["sha256"]?.stringValue, isSha256Hex(sha) else {
        return false
    }
    return packWireInt(o["bytes"], "\(pointer)/bytes", 1, nonWire)
}

/// The pack record's claims (plans/P4-01.md §2.3), after the common ones: the `kind: pack`
/// checks of §4.6 and the integer rule at §2.5's paths. A value outside a v1 vocabulary is never
/// refused here; it only makes the governed thing unusable (§2.2).
package func packRecordClaims(_ doc: [String: JSONValue], nonWire: NonWireIntegers) -> Bool {
    func int(_ v: JSONValue?, _ p: String, _ min: Int) -> Bool { packWireInt(v, p, min, nonWire) }
    if doc["deliverable"]?.stringValue == "app" { return false }
    if doc["builds"] != nil { return false }
    guard let type = doc["type"]?.stringValue, packMatch(PackPatterns.packType, type) else {
        return false
    }
    guard int(doc["formatVersion"], "/formatVersion", 1) else { return false }
    if let rawHandler = doc["handler"] {
        guard let h = rawHandler.objectValue else { return false }
        if h["mountOrder"] != nil, !int(h["mountOrder"], "/handler/mountOrder", 0) { return false }
        if let rawPrefixes = h["prefixes"] {
            guard let p = rawPrefixes.arrayValue, p.count >= 1, p.count <= 32 else { return false }
            var seen = Set<String>()
            for prefix in p {
                guard let s = prefix.stringValue, packMatch(PackPatterns.handlerPrefix, s),
                    s.utf8.count <= 256, seen.insert(s).inserted
                else { return false }
            }
        }
        guard optPattern(h, "activation", PackPatterns.vocabToken) else { return false }
    }
    guard optPattern(doc, "entitlement", PackPatterns.entitlement) else { return false }

    guard let variants = doc["variants"]?.arrayValue, variants.count >= 1,
        variants.count <= MAX_PACK_VARIANTS
    else { return false }
    var keys = Set<String>()
    var axes: [String]?
    for (i, raw) in variants.enumerated() {
        guard let v = raw.objectValue else { return false }
        let at = "/variants/\(i)"
        guard let sel = v["variant"]?.objectValue else { return false }
        if sel.count > 4 { return false }
        var selection: [String: String] = [:]
        for (name, value) in sel {
            guard packMatch(PackPatterns.variantAxis, name), let s = value.stringValue,
                packMatch(PackPatterns.variantValue, s)
            else { return false }
            selection[name] = s
        }
        guard let p = v["payload"]?.objectValue else { return false }
        guard int(p["size"], "\(at)/payload/size", 0) else { return false }
        guard let psha = p["sha256"]?.stringValue, isSha256Hex(psha) else { return false }
        guard objectRef(v["full"], pointer: "\(at)/full", minBytes: 0, minSize: 0, nonWire: nonWire)
        else { return false }
        guard let f = v["files"]?.objectValue else { return false }
        guard let format = f["format"]?.stringValue, packMatch(PackPatterns.objectFormat, format)
        else { return false }
        guard let layout = f["layout"]?.stringValue, packMatch(PackPatterns.vocabToken, layout)
        else { return false }
        guard
            objectRef(
                v["files"], pointer: "\(at)/files", minBytes: 1, minSize: 1, nonWire: nonWire)
        else { return false }
        if let gaps = f["gaps"] {
            guard gaps.objectValue != nil else { return false }
            if layout == "tree" { return false }
            guard
                objectRef(
                    gaps, pointer: "\(at)/files/gaps", minBytes: 0, minSize: 0, nonWire: nonWire)
            else { return false }
        } else if layout == "container" {
            return false
        }
        if let rawDeltas = v["deltas"] {
            guard let deltas = rawDeltas.arrayValue, deltas.count <= MAX_VARIANT_DELTAS else {
                return false
            }
            var ids = Set<String>()
            for (j, rd) in deltas.enumerated() {
                guard let d = rd.objectValue else { return false }
                let dt = "\(at)/deltas/\(j)"
                guard let method = d["method"]?.stringValue,
                    packMatch(PackPatterns.vocabToken, method)
                else { return false }
                guard let scope = d["scope"]?.stringValue,
                    packMatch(PackPatterns.vocabToken, scope)
                else { return false }
                if scope == "payload", layout == "tree" { return false }
                guard let from = d["from"]?.stringValue, isSha256Hex(from) else { return false }
                guard int(d["memBytes"], "\(dt)/memBytes", 1) else { return false }
                var id: String?
                if scope == "payload" {
                    guard hashBytesOk(d["artifact"], "\(dt)/artifact", nonWire) else { return false }
                    id = d["artifact"]?.objectValue?["sha256"]?.stringValue
                } else if scope == "files" {
                    guard
                        objectRef(
                            d["patch"], pointer: "\(dt)/patch", minBytes: 1, minSize: 1,
                            nonWire: nonWire),
                        hashBytesOk(d["data"], "\(dt)/data", nonWire)
                    else { return false }
                    id = d["patch"]?.objectValue?["sha256"]?.stringValue
                }
                if let id {
                    guard ids.insert(id).inserted else { return false }
                }
            }
        }
        if let rawRequires = v["requires"] {
            guard let r = rawRequires.objectValue, optPattern(r, "engine", PackPatterns.engine)
            else { return false }
        }
        guard keys.insert(variantKey(selection)).inserted else { return false }
        let names = sel.keys.sorted()
        if let axes {
            if axes != names { return false }
        } else {
            axes = names
        }
    }
    return true
}
