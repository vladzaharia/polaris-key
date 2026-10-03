// `l10n.table` payloads (CONTENT §4.2; P4-16): PO, CSV or JSON tables, read by plain parsers, a
// port of client-core's `packs/handlers/l10n.ts` held to the same cases
// (`packages/client-core/test/fixtures/pack-type-cases.json`). Nothing here evaluates a byte: a
// table is text split into messages, never a script, a resource or an object graph. Under
// content-key delegation (plans/P4-19.md §8.5) an `l10n.table` is effectively text, because
// `.translation` fails the data-only allow-list; this handler never loads one at all.
//
// The format of a file is judged by its bytes, never its name: after a UTF-8 BOM and ASCII
// whitespace, `{` is a JSON table, `#`, `msgid` or `msgctxt` a PO file, anything else CSV. Text
// is scanned as Unicode scalars, never `Character`s: Swift reads "\r\n" as one Character, which
// would change where a CSV record or a PO line ends.

import Foundation
import PolarisKeyCore

/// One message of a table. `strings` has one entry, or one per plural form (PO `msgstr[N]`).
public struct L10nMessage: Sendable, Equatable {
    public var context: String?
    public var id: String
    public var plural: String?
    public var strings: [String]

    public init(context: String?, id: String, plural: String?, strings: [String]) {
        self.context = context
        self.id = id
        self.plural = plural
        self.strings = strings
    }
}

/// One locale's messages from one file (a CSV file with N locale columns gives N tables).
public struct L10nTable: Sendable, Equatable {
    public var path: String
    /// The canonical tag (`_` written as `-`, case kept).
    public var locale: String
    public var messages: [L10nMessage]

    public init(path: String, locale: String, messages: [L10nMessage]) {
        self.path = path
        self.locale = locale
        self.messages = messages
    }
}

private let bcp47Pattern =
    "^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$"

private func l10nAsciiLower(_ s: String) -> String {
    String(
        String.UnicodeScalarView(
            s.unicodeScalars.map { ($0.value >= 65 && $0.value <= 90) ? Unicode.Scalar($0.value + 32)! : $0 }))
}

private func underscoresToHyphens(_ s: String) -> String {
    String(String.UnicodeScalarView(s.unicodeScalars.map { $0 == "_" ? "-" : $0 }))
}

/// A locale as a well-formed BCP-47 tag (RFC 5646 `langtag` and private use; no grandfathered
/// tags), with `_` accepted as Godot writes it (`pt_BR`) and written `-`; nil when it is not one.
/// Case is kept; comparisons are ASCII-case-insensitive.
public func bcp47Canonical(_ tag: String) -> String? {
    let canonical = underscoresToHyphens(tag)
    let scalars = Array(canonical.unicodeScalars)
    guard scalars.count >= 2, scalars.count <= 35 else { return nil }
    for s in scalars {
        let v = s.value
        let ok = (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || (v >= 48 && v <= 57) || v == 45
        if !ok { return nil }
    }
    // The characters are ASCII letters, digits and `-` only, so `$` cannot meet a line end.
    let lower = l10nAsciiLower(canonical)
    guard let re = try? NSRegularExpression(pattern: bcp47Pattern) else { return nil }
    let range = NSRange(lower.startIndex..., in: lower)
    guard let m = re.firstMatch(in: lower, range: range), m.range == range else { return nil }
    return canonical
}

/// Whether two tags name the same locale (ASCII-case-insensitive, after canonicalisation).
public func sameLocale(_ a: String, _ b: String) -> Bool {
    // By bytes: Swift's `==` on String is canonical equivalence, which no other SDK applies.
    Array(l10nAsciiLower(underscoresToHyphens(a)).utf8) == Array(l10nAsciiLower(underscoresToHyphens(b)).utf8)
}

/// The result of parsing one file of an `l10n.table` payload.
public enum L10nParse: Sendable, Equatable {
    case ok([L10nTable])
    /// `table` (unreadable) or `locale` (a locale that is not a well-formed tag).
    case failed(String)
}

private typealias RawTable = (locale: String, messages: [L10nMessage])

/// Parse one file of an `l10n.table` payload (the check's rules 2–5; the size rule is the
/// handler's). Locales are canonicalised and checked for well-formedness here; the variant match
/// is the handler's.
public func parseL10nFile(_ path: String, _ bytes: [UInt8]) -> L10nParse {
    // Strict UTF-8: the lenient decode replaces any invalid sequence, so a round trip that
    // changes the bytes means they were not UTF-8.
    let decoded = String(decoding: bytes, as: UTF8.self)
    guard Array(decoded.utf8) == bytes else { return .failed("table") }
    var scalars = Array(decoded.unicodeScalars)
    if scalars.contains("\u{0}") { return .failed("table") }
    if scalars.first == "\u{FEFF}" { scalars.removeFirst() }
    var at = 0
    while at < scalars.count, [" ", "\t", "\n", "\r"].contains(scalars[at]) { at += 1 }
    if at == scalars.count { return .failed("table") }
    let raw: [RawTable]?
    if scalars[at] == "{" {
        raw = parseJsonTable(scalars)
    } else if startsWith(scalars, at, "#") || startsWith(scalars, at, "msgid")
        || startsWith(scalars, at, "msgctxt")
    {
        raw = parsePo(scalars)
    } else {
        raw = parseCsv(scalars)
    }
    guard let raw else { return .failed("table") }
    var tables: [L10nTable] = []
    for t in raw {
        guard let locale = bcp47Canonical(t.locale) else { return .failed("locale") }
        tables.append(L10nTable(path: path, locale: locale, messages: t.messages))
    }
    return .ok(tables)
}

private func startsWith(_ s: [Unicode.Scalar], _ at: Int, _ prefix: String) -> Bool {
    let p = Array(prefix.unicodeScalars)
    guard at + p.count <= s.count else { return false }
    for k in 0..<p.count where s[at + k] != p[k] { return false }
    return true
}

private func str(_ s: ArraySlice<Unicode.Scalar>) -> String {
    String(String.UnicodeScalarView(s))
}

// ── JSON ───────────────────────────────────────────────────────────────────────────────────

private func parseJsonTable(_ scalars: [Unicode.Scalar]) -> [RawTable]? {
    let bytes = Array(str(scalars[...]).utf8)
    // Strictness (V4 §1.2: duplicates by scalars, no trailing comma, …) is `strictParse`'s; the
    // members are then read in order by `OrderedJSON`, because `JSONValue` keys a Swift
    // dictionary, whose String equality is canonical equivalence: two ids every other SDK keeps
    // apart (`"\u{E9}"` and `"e\u{301}"`) would merge into one message.
    guard strictParse(bytes) != nil, case .object(let o)? = OrderedJSON.parse(bytes),
        case .string(let locale)? = o.first(where: { sameBytes($0.key, "locale") })?.value,
        case .object(let m)? = o.first(where: { sameBytes($0.key, "messages") })?.value
    else { return nil }
    // Member order is not portable, so a JSON table's messages are in UTF-8 byte order of ids.
    var messages: [L10nMessage] = []
    for (id, v) in m.sorted(by: { compareUTF8Bytes($0.key, $1.key) < 0 }) {
        guard case .string(let s) = v else { return nil }
        messages.append(L10nMessage(context: nil, id: id, plural: nil, strings: [s]))
    }
    return [(locale, messages)]
}

/// A JSON value with its object members in document order and their names exactly as written
/// (Unicode scalars, no normalisation). Only for text `strictParse` already accepted.
enum OrderedJSON {
    case object([(key: String, value: OrderedJSON)])
    case array([OrderedJSON])
    case string(String)
    case other

    static func parse(_ b: [UInt8]) -> OrderedJSON? {
        var i = 0
        guard let v = value(b, &i) else { return nil }
        ws(b, &i)
        return i == b.count ? v : nil
    }

    private static func ws(_ b: [UInt8], _ i: inout Int) {
        while i < b.count, b[i] == 0x20 || b[i] == 0x09 || b[i] == 0x0a || b[i] == 0x0d { i += 1 }
    }

    private static func value(_ b: [UInt8], _ i: inout Int) -> OrderedJSON? {
        ws(b, &i)
        guard i < b.count else { return nil }
        switch b[i] {
        case UInt8(ascii: "{"):
            i += 1
            var members: [(key: String, value: OrderedJSON)] = []
            ws(b, &i)
            if i < b.count, b[i] == UInt8(ascii: "}") {
                i += 1
                return .object(members)
            }
            while true {
                ws(b, &i)
                guard let k = string(b, &i) else { return nil }
                ws(b, &i)
                guard i < b.count, b[i] == UInt8(ascii: ":") else { return nil }
                i += 1
                guard let v = value(b, &i) else { return nil }
                members.append((k, v))
                ws(b, &i)
                guard i < b.count else { return nil }
                if b[i] == UInt8(ascii: ",") {
                    i += 1
                    continue
                }
                guard b[i] == UInt8(ascii: "}") else { return nil }
                i += 1
                return .object(members)
            }
        case UInt8(ascii: "["):
            i += 1
            var items: [OrderedJSON] = []
            ws(b, &i)
            if i < b.count, b[i] == UInt8(ascii: "]") {
                i += 1
                return .array(items)
            }
            while true {
                guard let v = value(b, &i) else { return nil }
                items.append(v)
                ws(b, &i)
                guard i < b.count else { return nil }
                if b[i] == UInt8(ascii: ",") {
                    i += 1
                    continue
                }
                guard b[i] == UInt8(ascii: "]") else { return nil }
                i += 1
                return .array(items)
            }
        case UInt8(ascii: "\""):
            return string(b, &i).map { .string($0) }
        default:
            // A number, `true`, `false` or `null`: skip to the next structural byte.
            while i < b.count, ![UInt8(ascii: ","), UInt8(ascii: "}"), UInt8(ascii: "]"), 0x20, 0x09, 0x0a, 0x0d]
                .contains(b[i])
            {
                i += 1
            }
            return .other
        }
    }

    private static func hex4(_ b: [UInt8], _ at: Int) -> UInt32? {
        guard at + 4 <= b.count else { return nil }
        var v: UInt32 = 0
        for k in at..<at + 4 {
            let c = b[k]
            let d: UInt32
            switch c {
            case 48...57: d = UInt32(c - 48)
            case 65...70: d = UInt32(c - 55)
            case 97...102: d = UInt32(c - 87)
            default: return nil
            }
            v = v * 16 + d
        }
        return v
    }

    private static func string(_ b: [UInt8], _ i: inout Int) -> String? {
        guard i < b.count, b[i] == UInt8(ascii: "\"") else { return nil }
        i += 1
        var out = String.UnicodeScalarView()
        var run: [UInt8] = []
        func flush() {
            if !run.isEmpty {
                out.append(contentsOf: String(decoding: run, as: UTF8.self).unicodeScalars)
                run = []
            }
        }
        while i < b.count {
            let c = b[i]
            if c == UInt8(ascii: "\"") {
                i += 1
                flush()
                return String(out)
            }
            if c != UInt8(ascii: "\\") {
                run.append(c)
                i += 1
                continue
            }
            flush()
            guard i + 1 < b.count else { return nil }
            let e = b[i + 1]
            i += 2
            switch e {
            case UInt8(ascii: "\""): out.append("\"")
            case UInt8(ascii: "\\"): out.append("\\")
            case UInt8(ascii: "/"): out.append("/")
            case UInt8(ascii: "b"): out.append("\u{8}")
            case UInt8(ascii: "f"): out.append("\u{C}")
            case UInt8(ascii: "n"): out.append("\n")
            case UInt8(ascii: "r"): out.append("\r")
            case UInt8(ascii: "t"): out.append("\t")
            case UInt8(ascii: "u"):
                guard var v = hex4(b, i) else { return nil }
                i += 4
                if v >= 0xD800, v <= 0xDBFF, i + 6 <= b.count, b[i] == UInt8(ascii: "\\"),
                    b[i + 1] == UInt8(ascii: "u"), let lo = hex4(b, i + 2), lo >= 0xDC00, lo <= 0xDFFF
                {
                    v = 0x10000 + ((v - 0xD800) << 10) + (lo - 0xDC00)
                    i += 6
                }
                // A lone surrogate (which strictParse admits only as JSON allows) reads as U+FFFD.
                out.append(Unicode.Scalar(v) ?? "\u{FFFD}")
            default: return nil
            }
        }
        return nil
    }
}

// ── PO ─────────────────────────────────────────────────────────────────────────────────────

/// A PO string literal (`"…"` and trailing spaces or tabs), unescaped; nil when malformed.
private func poString(_ s: ArraySlice<Unicode.Scalar>) -> String? {
    var i = s.startIndex
    guard i < s.endIndex, s[i] == "\"" else { return nil }
    var out = String.UnicodeScalarView()
    i += 1
    var closed = false
    while i < s.endIndex {
        let c = s[i]
        if c == "\"" {
            closed = true
            break
        }
        if c != "\\" {
            out.append(c)
            i += 1
            continue
        }
        i += 1
        guard i < s.endIndex else { return nil }
        switch s[i] {
        case "\\": out.append("\\")
        case "\"": out.append("\"")
        case "n": out.append("\n")
        case "t": out.append("\t")
        case "r": out.append("\r")
        default: return nil
        }
        i += 1
    }
    guard closed else { return nil }
    var j = i + 1
    while j < s.endIndex {
        if s[j] != " " && s[j] != "\t" { return nil }
        j += 1
    }
    return String(out)
}

private struct PoEntry {
    var context: String?
    var id: String?
    var plural: String?
    var strings: [String] = []
    var complete: Bool { id != nil && !strings.isEmpty }
}

private enum PoPart { case ctxt, id, plural, str }

/// A keyword line: the keyword, its `[N]` index (msgstr only) and the rest after the spaces.
private func poKeyword(_ line: ArraySlice<Unicode.Scalar>) -> (kw: String, index: Int?, rest: ArraySlice<Unicode.Scalar>)? {
    let lineArr = Array(line)
    var kw: String?
    var at = 0
    var index: Int?
    for k in ["msgctxt", "msgid_plural", "msgid"] where startsWith(lineArr, 0, k) {
        kw = k
        at = k.unicodeScalars.count
        break
    }
    if kw == nil, startsWith(lineArr, 0, "msgstr") {
        kw = "msgstr"
        at = 6
        if at < lineArr.count, lineArr[at] == "[" {
            var j = at + 1
            var digits = 0
            var n = 0
            while j < lineArr.count, digits < 3, let d = asciiDigit(lineArr[j]) {
                n = n * 10 + d
                digits += 1
                j += 1
            }
            if digits >= 1, digits <= 2, j < lineArr.count, lineArr[j] == "]" {
                index = n
                at = j + 1
            }
        }
    }
    guard let kw else { return nil }
    var j = at
    while j < lineArr.count, lineArr[j] == " " || lineArr[j] == "\t" { j += 1 }
    guard j > at else { return nil }
    return (kw, index, line[(line.startIndex + j)...])
}

private func asciiDigit(_ s: Unicode.Scalar) -> Int? {
    (s.value >= 48 && s.value <= 57) ? Int(s.value - 48) : nil
}

private func splitLines(_ s: [Unicode.Scalar]) -> [ArraySlice<Unicode.Scalar>] {
    var out: [ArraySlice<Unicode.Scalar>] = []
    var start = 0
    for (i, c) in s.enumerated() where c == "\n" {
        out.append(s[start..<i])
        start = i + 1
    }
    out.append(s[start..<s.count])
    return out
}

private func parsePo(_ text: [Unicode.Scalar]) -> [RawTable]? {
    var entries: [PoEntry] = []
    var cur: PoEntry?
    // Which string a continuation line extends.
    var last: PoPart?
    for var line in splitLines(text) {
        if line.last == "\r" { line = line.dropLast() }
        if line.allSatisfy({ $0 == " " || $0 == "\t" }) {
            last = nil
            continue
        }
        if line.first == "#" {
            last = nil
            continue
        }
        if line.first == "\"" {
            guard let s = poString(line), cur != nil, let part = last else { return nil }
            switch part {
            case .ctxt: cur!.context! += s
            case .id: cur!.id! += s
            case .plural: cur!.plural! += s
            case .str: cur!.strings[cur!.strings.count - 1] += s
            }
            continue
        }
        guard let (kw, index, rest) = poKeyword(line), let s = poString(rest) else { return nil }
        if kw == "msgctxt" || kw == "msgid" {
            // A new entry starts at msgctxt, or at msgid when the current one has none open.
            let opensNew =
                cur == nil || cur!.complete || (kw == "msgid" && cur!.id != nil) || kw == "msgctxt"
            if opensNew {
                if let c = cur {
                    if !c.complete { return nil }
                    entries.append(c)
                }
                cur = PoEntry()
            }
            if kw == "msgctxt" {
                cur!.context = s
                last = .ctxt
            } else {
                cur!.id = s
                last = .id
            }
            continue
        }
        guard cur != nil, cur!.id != nil else { return nil }
        if kw == "msgid_plural" {
            if cur!.plural != nil || !cur!.strings.isEmpty { return nil }
            cur!.plural = s
            last = .plural
            continue
        }
        // msgstr or msgstr[N]
        if let index {
            if cur!.plural == nil || index != cur!.strings.count { return nil }
        } else {
            if cur!.plural != nil || !cur!.strings.isEmpty { return nil }
        }
        cur!.strings.append(s)
        last = .str
    }
    if let c = cur {
        if !c.complete { return nil }
        entries.append(c)
    }
    var locale: String?
    var headers = 0
    var messages: [L10nMessage] = []
    // Keys by UTF-8 bytes: Swift's String equality is canonical equivalence, which would merge
    // two ids every other SDK keeps apart.
    var seen = Set<[UInt8]>()
    for e in entries {
        if e.id == "" && e.context == nil {
            headers += 1
            if headers > 1 || e.plural != nil { return nil }
            for l in splitLines(Array(e.strings[0].unicodeScalars)) where startsWith(Array(l), 0, "Language:") {
                if locale == nil {
                    var v = Array(l.dropFirst(9))
                    while let f = v.first, f == " " || f == "\t" { v.removeFirst() }
                    while let b = v.last, b == " " || b == "\t" { v.removeLast() }
                    locale = str(v[...])
                }
            }
            continue
        }
        let key = (e.context.map { "1" + $0 } ?? "0") + "\u{0}" + e.id!
        if !seen.insert(Array(key.utf8)).inserted { return nil }
        messages.append(L10nMessage(context: e.context, id: e.id!, plural: e.plural, strings: e.strings))
    }
    guard headers > 0, let locale, !locale.isEmpty else { return nil }
    return [(locale, messages)]
}

// ── CSV ────────────────────────────────────────────────────────────────────────────────────

/// RFC 4180 records (comma only); nil when a quote is malformed.
private func csvRecords(_ t: [Unicode.Scalar]) -> [[String]]? {
    var records: [[String]] = []
    var record: [String] = []
    var i = 0
    let n = t.count
    func recordEnd(_ k: Int) -> Bool { t[k] == "\n" || (t[k] == "\r" && k + 1 < n && t[k + 1] == "\n") }
    // Whether the current record has any characters (an empty line is no record).
    var started = false
    while i < n {
        var field = String.UnicodeScalarView()
        if t[i] == "\"" {
            started = true
            i += 1
            while true {
                if i >= n { return nil }
                let c = t[i]
                if c == "\"" {
                    if i + 1 < n, t[i + 1] == "\"" {
                        field.append("\"")
                        i += 2
                        continue
                    }
                    i += 1
                    break
                }
                field.append(c)
                i += 1
            }
            if i < n, t[i] != ",", !recordEnd(i) { return nil }
        } else {
            while i < n, t[i] != ",", !recordEnd(i) {
                if t[i] == "\"" { return nil }
                field.append(t[i])
                i += 1
            }
            if !field.isEmpty { started = true }
        }
        record.append(String(field))
        if i >= n { break }
        if t[i] == "," {
            started = true
            i += 1
            if i >= n { record.append("") }
            continue
        }
        // A record end.
        i += t[i] == "\r" ? 2 : 1
        if started { records.append(record) }
        record = []
        started = false
    }
    if started { records.append(record) }
    return records
}

private func parseCsv(_ text: [Unicode.Scalar]) -> [RawTable]? {
    guard let records = csvRecords(text), let header = records.first, header.count >= 2 else { return nil }
    let locales = Array(header.dropFirst())
    var lower = Set<[UInt8]>()
    for l in locales where !lower.insert(Array(l10nAsciiLower(underscoresToHyphens(l)).utf8)).inserted {
        return nil
    }
    var tables: [RawTable] = locales.map { ($0, []) }
    var keys = Set<[UInt8]>()
    for r in records.dropFirst() {
        guard r.count == header.count else { return nil }
        let key = r[0]
        if key.isEmpty || !keys.insert(Array(key.utf8)).inserted { return nil }
        for c in 1..<r.count {
            tables[c - 1].messages.append(L10nMessage(context: nil, id: key, plural: nil, strings: [r[c]]))
        }
    }
    return tables
}
