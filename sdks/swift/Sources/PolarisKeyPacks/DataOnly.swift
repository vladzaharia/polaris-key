// The data-only rule for delegated installs (plans/P4-19.md §2.5 and Amendment A1,
// WIRE-CONTRACT-V4 §2.8). A port of client-core's `packs/dataonly.ts`.
//
// A pack release signed by a delegated content key may hold only files this rule admits. The
// extension allow-list is the real control (Godot chooses its resource loader by extension); the
// head and tail sniffs and the text rule are defence in depth that fail closed. The engine runs the
// extension rule over the files index before any payload object is fetched and the whole rule on
// each file's decoded bytes as the applier writes it. Release-signed packs keep their own rules.
// Pure; never throws.

import PolarisKeyCore

/// Which rule refused a file (`pack-not-data-only`'s detail).
public enum DataOnlyRule: String, Sendable, Equatable {
    case `extension`, content
}

private func ascii(_ s: String) -> [UInt8] { Array(s.utf8) }

/// The refused heads (rule 3), after a UTF-8 BOM and ASCII whitespace are skipped: Godot
/// resource, pack and script formats; archives and native code; scripts. With `WORD_HEADS` (each
/// followed by a space or a tab) these are the 20 entries.
private let HEADS: [[UInt8]] = [
    // Godot.
    ascii("RSRC"), ascii("RSCC"), ascii("GDPC"), ascii("GDEC"), ascii("GCPF"), ascii("GDSC"),
    ascii("[gd_"),
    // Archives and native code.
    [0x50, 0x4b, 0x03, 0x04], [0x7f, 0x45, 0x4c, 0x46], ascii("MZ"),
    [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], [0x00, 0x61, 0x73, 0x6d],
    // Scripts.
    ascii("#!"), ascii("@tool"),
]
private let WORD_HEADS: [[UInt8]] = [ascii("extends"), ascii("class_name")]

/// `PK\x05\x06`: a zip end-of-central-directory record (rule 4).
private let ZIP_EOCD: [UInt8] = [0x50, 0x4b, 0x05, 0x06]
private let GDPC: [UInt8] = ascii("GDPC")

/// The extensions whose files are text a VariantParser reader could parse (Amendment A1): the
/// whole decoded file passes the text rule.
public let DATA_ONLY_TEXT_EXTENSIONS: [String] = ["json", "csv", "tsv", "po", "txt"]

/// The script markers a text file may not hold (Amendment A1): the script types, then the
/// properties that hold a script's source. The same list as P4-08's `packLint` `SCRIPT_MARKERS`.
public let DATA_ONLY_SCRIPT_MARKERS: [String] = [
    "GDScript", "CSharpScript", "ScriptExtension", "script/source", "source_code",
]

private func isWs(_ b: UInt8) -> Bool { b == 0x20 || (b >= 0x09 && b <= 0x0d) }

private func startsWith(_ bytes: ArraySlice<UInt8>, _ at: Int, _ magic: [UInt8]) -> Bool {
    let base = bytes.startIndex + at
    if at + magic.count > bytes.count { return false }
    for k in 0..<magic.count where bytes[base + k] != magic[k] { return false }
    return true
}

/// True when the window ends inside `magic` read from `at`: what is visible is its prefix.
private func straddles(_ bytes: ArraySlice<UInt8>, _ at: Int, _ magic: [UInt8]) -> Bool {
    if at + magic.count <= bytes.count { return false }
    for k in at..<bytes.count where bytes[bytes.startIndex + k] != magic[k - at] { return false }
    return true
}

private func contains(_ hay: [UInt8], _ needle: [UInt8]) -> Bool {
    if needle.isEmpty { return true }
    if hay.count < needle.count { return false }
    let first = needle[0]
    var i = 0
    let last = hay.count - needle.count
    while i <= last {
        if hay[i] == first {
            var k = 1
            while k < needle.count && hay[i + k] == needle[k] { k += 1 }
            if k == needle.count { return true }
        }
        i += 1
    }
    return false
}

/// Strict UTF-8 (the WHATWG decoder with `fatal: true`, client-core's `TextDecoder`): no overlong
/// form, no surrogate, nothing above U+10FFFF, no truncated sequence.
func isStrictUTF8(_ b: [UInt8]) -> Bool {
    var i = 0
    let n = b.count
    func cont(_ k: Int, _ lo: UInt8 = 0x80, _ hi: UInt8 = 0xbf) -> Bool {
        k < n && b[k] >= lo && b[k] <= hi
    }
    while i < n {
        let c = b[i]
        if c < 0x80 {
            i += 1
        } else if c >= 0xc2 && c <= 0xdf {
            guard cont(i + 1) else { return false }
            i += 2
        } else if c >= 0xe0 && c <= 0xef {
            let lo: UInt8 = c == 0xe0 ? 0xa0 : 0x80
            let hi: UInt8 = c == 0xed ? 0x9f : 0xbf
            guard cont(i + 1, lo, hi), cont(i + 2) else { return false }
            i += 3
        } else if c >= 0xf0 && c <= 0xf4 {
            let lo: UInt8 = c == 0xf0 ? 0x90 : 0x80
            let hi: UInt8 = c == 0xf4 ? 0x8f : 0xbf
            guard cont(i + 1, lo, hi), cont(i + 2), cont(i + 3) else { return false }
            i += 4
        } else {
            return false
        }
    }
    return true
}

private func isHex(_ b: UInt8) -> Bool {
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)
}

/// True when the text holds a `\u` or `\U` escape that could spell ASCII (Amendment A1): `\u` not
/// followed by exactly 4 hex digits, or `\U` not followed by exactly 6 (VariantParser's form), or
/// either decoding below 0x80. Escapes of non-ASCII characters (surrogate halves included) pass.
/// Over valid UTF-8 bytes: a hex digit is one ASCII byte, so reading `n` bytes gives the same
/// verdict as client-core reading `n` UTF-16 units.
private func asciiEscape(_ b: [UInt8]) -> Bool {
    var at = 0
    while at < b.count {
        if b[at] == 0x5c, at + 1 < b.count, b[at + 1] == 0x75 || b[at + 1] == 0x55 {
            let n = b[at + 1] == 0x75 ? 4 : 6
            let start = at + 2
            guard start + n <= b.count else { return true }
            var value = 0
            for k in start..<(start + n) {
                guard isHex(b[k]) else { return true }
                value = value * 16 + Int(hexValue(b[k]))
            }
            if value < 0x80 { return true }
        }
        at += 1
    }
    return false
}

private func hexValue(_ b: UInt8) -> UInt8 {
    if b >= 0x30 && b <= 0x39 { return b - 0x30 }
    if b >= 0x41 && b <= 0x46 { return b - 0x41 + 10 }
    return b - 0x61 + 10
}

/// Rule 5 (Amendment A1), over a text file's whole decoded bytes: `content` when the bytes are not
/// valid UTF-8 or hold a NUL; when the text, or the text with every backslash removed, holds a
/// script marker; or when it holds a `\u` or `\U` escape that could spell ASCII. Nil when
/// admitted.
public func dataOnlyTextRefusal(_ bytes: [UInt8]) -> DataOnlyRule? {
    guard isStrictUTF8(bytes) else { return .content }
    if bytes.contains(0) { return .content }
    if asciiEscape(bytes) { return .content }
    let bare = bytes.filter { $0 != 0x5c }
    for m in DATA_ONLY_SCRIPT_MARKERS {
        let needle = Array(m.utf8)
        if contains(bytes, needle) || contains(bare, needle) { return .content }
    }
    return nil
}

/// Rule 2: the final segment's text after its last `.`, ASCII-lowercased; nil without one.
public func dataOnlyExtension(_ path: String) -> String? {
    let last = path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? path
    guard let dot = last.lastIndex(of: ".") else { return nil }
    return asciiLower(String(last[last.index(after: dot)...]))
}

/// Rules 1 and 2 alone, over a path: `extension` when the path is not already normalised (it fails
/// the files index's path rules) or its extension is not in `DATA_ONLY_EXTENSIONS`.
public func dataOnlyPathRefusal(_ path: String) -> DataOnlyRule? {
    guard pathSafe(path), let ext = dataOnlyExtension(path), DATA_ONLY_EXTENSION_VALUES.contains(ext)
    else { return .extension }
    return nil
}

/// The data-only rule over one file (plans/P4-19.md §2.5): `path` its index path, `head` its first
/// `DATA_ONLY_HEAD_BYTES` decoded bytes (fewer for a shorter file), `tail` its last
/// `DATA_ONLY_TAIL_BYTES` (fewer for a shorter file; the two may overlap), `full` the whole
/// decoded file. In order:
///
///  1. the path is already normalised, else `extension`;
///  2. its extension is in `DATA_ONLY_EXTENSIONS`, else `extension`;
///  3. after a UTF-8 BOM and then ASCII whitespace inside `head`, what remains starts with none of
///     the refused heads, else `content`. When `head` is a full window (it may cut the file), the
///     skip reaching its end, or a refused head that the window's end cuts, is `content` too
///     (Amendment A1);
///  4. `tail` does not end with `GDPC` and holds no `PK\x05\x06`, else `content`;
///  5. a text file (`DATA_ONLY_TEXT_EXTENSIONS`) passes `dataOnlyTextRefusal` over `full`; without
///     `full` such a file is refused (`content`).
///
/// Nil when the file is admitted.
public func dataOnlyRefusal(
    _ path: String, head: [UInt8], tail: [UInt8], full: [UInt8]? = nil
) -> DataOnlyRule? {
    if let p = dataOnlyPathRefusal(path) { return p }
    let h = head.prefix(DATA_ONLY_HEAD_BYTES)
    var at = 0
    if h.count >= 3, h[h.startIndex] == 0xef, h[h.startIndex + 1] == 0xbb, h[h.startIndex + 2] == 0xbf {
        at = 3
    }
    while at < h.count && isWs(h[h.startIndex + at]) { at += 1 }
    // A full window may cut the file: what it cannot see is refused (fails closed).
    let cut = h.count == DATA_ONLY_HEAD_BYTES
    if cut && at == h.count { return .content }
    for m in HEADS where startsWith(h, at, m) || (cut && straddles(h, at, m)) { return .content }
    for m in WORD_HEADS {
        if startsWith(h, at, m) {
            let k = at + m.count
            if k < h.count {
                let next = h[h.startIndex + k]
                if next == 0x20 || next == 0x09 { return .content }
            } else if cut {
                return .content
            }
        } else if cut && straddles(h, at, m) {
            return .content
        }
    }
    let t = Array(tail.suffix(DATA_ONLY_TAIL_BYTES))
    if t.count >= 4 && Array(t.suffix(4)) == GDPC { return .content }
    if contains(t, ZIP_EOCD) { return .content }
    if let ext = dataOnlyExtension(path), DATA_ONLY_TEXT_EXTENSIONS.contains(ext) {
        guard let full else { return .content }
        return dataOnlyTextRefusal(full)
    }
    return nil
}

/// `dataOnlyRefusal` over a whole file's decoded bytes.
public func dataOnlyFileRefusal(_ path: String, _ bytes: [UInt8]) -> DataOnlyRule? {
    dataOnlyRefusal(
        path, head: Array(bytes.prefix(DATA_ONLY_HEAD_BYTES)),
        tail: Array(bytes.suffix(DATA_ONLY_TAIL_BYTES)), full: bytes)
}

/// A refusal the data-only tree sink saw: the first file it refused.
public struct DataOnlyRefusalSeen: Sendable, Equatable {
    public let path: String
    public let rule: DataOnlyRule
}

struct DataOnlyRefused: Error {}

/// A tree sink that passes every file a delegated install writes through `dataOnlyRefusal` before
/// it reaches the inner sink. The first refusal is recorded in `seen` and the write throws, which
/// fails the applier; the engine then aborts the plan with `pack-not-data-only`.
final class DataOnlyTreeSink: TreeSink, @unchecked Sendable {
    private let inner: any TreeSink
    let seen = Locked<DataOnlyRefusalSeen?>(nil)

    init(_ inner: any TreeSink) { self.inner = inner }

    func writeFile(_ path: String, _ bytes: [UInt8]) throws {
        if let rule = dataOnlyFileRefusal(path, bytes) {
            seen.with { if $0 == nil { $0 = DataOnlyRefusalSeen(path: path, rule: rule) } }
            throw DataOnlyRefused()
        }
        try inner.writeFile(path, bytes)
    }
}
