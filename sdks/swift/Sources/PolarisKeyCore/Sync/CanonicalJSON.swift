// Canonical JSON (WIRE-CONTRACT-V5 §13.10.3, §13.10.8): sorted keys at every level (UTF-16
// code-unit order), no whitespace, non-ASCII text as itself, strings escaped as ECMAScript
// `JSON.stringify` does, numbers as ECMAScript `Number::toString`.
//
// Neither `JSONSerialization` nor `Double.description` spells numbers that way, so the number
// printer is written out here. A writer refuses, rather than spells differently: a number that is
// not finite, a string or key with a lone surrogate, and an integer over 2^53 in magnitude.

import Foundation

public enum CanonicalJSON {
    /// The largest magnitude of an integer every SDK holds exactly.
    public static let maxSafeInteger: Int = 1 << 53

    /// The canonical text of `value`. Throws `SyncCryptoError.unspellable` for a value the
    /// contract refuses.
    public static func encode(_ value: JSONValue) throws -> String {
        var out = ""
        try write(value, into: &out)
        return out
    }

    public static func encodeBytes(_ value: JSONValue) throws -> Data { Data(try encode(value).utf8) }

    /// Parses JSON text as `JSON.parse` does (every number an IEEE double) and writes it
    /// canonically. A `\uD800`-style escape that is not half of a pair is refused.
    public static func canonicalize(jsonText: String) throws -> String {
        try encode(try parse(jsonText, numbersAsDoubles: true))
    }

    // ── Writer ───────────────────────────────────────────────────────────────────────────────

    private static func write(_ v: JSONValue, into out: inout String) throws {
        switch v {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .string(let s): writeString(s, into: &out)
        case .int(let i):
            guard i.magnitude <= UInt(maxSafeInteger) else {
                throw SyncCryptoError.unspellable("integer over 2^53")
            }
            out += String(i)
        case .double(let d): out += try numberString(d)
        case .array(let a):
            out += "["
            for (i, e) in a.enumerated() {
                if i > 0 { out += "," }
                try write(e, into: &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            let keys = o.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            for (i, k) in keys.enumerated() {
                if i > 0 { out += "," }
                writeString(k, into: &out)
                out += ":"
                try write(o[k]!, into: &out)
            }
            out += "}"
        }
    }

    /// `JSON.stringify` for a string: only `"`, `\` and the C0 controls are escaped.
    private static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{09}": out += "\\t"
            case "\u{0A}": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\u{0D}": out += "\\r"
            default:
                if u.value < 0x20 {
                    let hex = String(u.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
    }

    /// ECMAScript `Number::toString` (ECMA-262 §6.1.6.1.20) for radix 10. Swift's
    /// `Double.description` already yields the shortest digits that round-trip; this takes the
    /// digits and the exponent from it and lays them out as ECMAScript does.
    public static func numberString(_ d: Double) throws -> String {
        guard d.isFinite else { throw SyncCryptoError.unspellable("number is not finite") }
        if d == 0 { return "0" }  // also -0
        var text = d.magnitude.description
        var exp10 = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            exp10 = Int(text[text.index(after: e)...].replacingOccurrences(of: "+", with: "")) ?? 0
            text = String(text[..<e])
        }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        let intPart = String(parts[0])
        let fracPart = parts.count > 1 ? String(parts[1]) : ""
        var digits = Array((intPart + fracPart).utf8)
        var n = intPart.utf8.count + exp10  // the value is 0.<digits> x 10^n
        while let f = digits.first, f == 0x30 {
            digits.removeFirst()
            n -= 1
        }
        while let l = digits.last, l == 0x30 { digits.removeLast() }
        let k = digits.count
        let s = String(decoding: digits, as: UTF8.self)
        var out: String
        if k <= n && n <= 21 {
            out = s + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let i = s.index(s.startIndex, offsetBy: n)
            out = s[..<i] + "." + s[i...]
        } else if -6 < n && n <= 0 {
            out = "0." + String(repeating: "0", count: -n) + s
        } else {
            let e = n - 1
            let sign = e < 0 ? "-" : "+"
            let mant = k == 1 ? s : String(s.prefix(1)) + "." + s.dropFirst()
            out = mant + "e" + sign + String(abs(e))
        }
        return d < 0 ? "-" + out : out
    }

    // ── Reader ───────────────────────────────────────────────────────────────────────────────

    /// A strict JSON reader (RFC 8259, one top-level value, no trailing text). With
    /// `numbersAsDoubles` every number is a `Double`, as `JSON.parse` reads it; otherwise an
    /// integer literal that fits 2^53 is an `Int`. A lone surrogate escape throws.
    public static func parse(_ text: String, numbersAsDoubles: Bool = false) throws -> JSONValue {
        var p = Reader(bytes: Array(text.utf8), asDoubles: numbersAsDoubles)
        return try p.document()
    }

    public static func parse(utf8 data: Data, numbersAsDoubles: Bool = false) throws -> JSONValue {
        guard let s = String(data: data, encoding: .utf8) else {
            throw SyncCryptoError.unspellable("not UTF-8")
        }
        return try parse(s, numbersAsDoubles: numbersAsDoubles)
    }

    private struct Reader {
        let b: [UInt8]
        let asDoubles: Bool
        var i = 0
        var depth = 0
        init(bytes: [UInt8], asDoubles: Bool) {
            b = bytes
            self.asDoubles = asDoubles
        }

        func fail(_ why: String = "malformed JSON") -> SyncCryptoError { .unspellable(why) }

        mutating func ws() {
            while i < b.count, b[i] == 0x20 || b[i] == 0x09 || b[i] == 0x0A || b[i] == 0x0D { i += 1 }
        }

        mutating func document() throws -> JSONValue {
            ws()
            let v = try value()
            ws()
            guard i == b.count else { throw fail() }
            return v
        }

        mutating func literal(_ s: String, _ v: JSONValue) throws -> JSONValue {
            let u = Array(s.utf8)
            guard i + u.count <= b.count, Array(b[i..<i + u.count]) == u else { throw fail() }
            i += u.count
            return v
        }

        mutating func value() throws -> JSONValue {
            guard i < b.count else { throw fail() }
            switch b[i] {
            case 0x6E: return try literal("null", .null)
            case 0x74: return try literal("true", .bool(true))
            case 0x66: return try literal("false", .bool(false))
            case 0x22: return .string(try string())
            case 0x5B:
                depth += 1
                defer { depth -= 1 }
                guard depth <= 256 else { throw fail("too deep") }
                i += 1
                var a: [JSONValue] = []
                ws()
                if i < b.count, b[i] == 0x5D {
                    i += 1
                    return .array(a)
                }
                while true {
                    ws()
                    a.append(try value())
                    ws()
                    guard i < b.count else { throw fail() }
                    if b[i] == 0x2C {
                        i += 1
                        continue
                    }
                    if b[i] == 0x5D {
                        i += 1
                        return .array(a)
                    }
                    throw fail()
                }
            case 0x7B:
                depth += 1
                defer { depth -= 1 }
                guard depth <= 256 else { throw fail("too deep") }
                i += 1
                var o: [String: JSONValue] = [:]
                ws()
                if i < b.count, b[i] == 0x7D {
                    i += 1
                    return .object(o)
                }
                while true {
                    ws()
                    guard i < b.count, b[i] == 0x22 else { throw fail() }
                    let k = try string()
                    ws()
                    guard i < b.count, b[i] == 0x3A else { throw fail() }
                    i += 1
                    ws()
                    o[k] = try value()  // a repeated key: the last wins, as JSON.parse does
                    ws()
                    guard i < b.count else { throw fail() }
                    if b[i] == 0x2C {
                        i += 1
                        continue
                    }
                    if b[i] == 0x7D {
                        i += 1
                        return .object(o)
                    }
                    throw fail()
                }
            default: return try number()
            }
        }

        mutating func number() throws -> JSONValue {
            let start = i
            func digit(_ x: UInt8) -> Bool { x >= 0x30 && x <= 0x39 }
            if i < b.count, b[i] == 0x2D { i += 1 }
            guard i < b.count, digit(b[i]) else { throw fail() }
            if b[i] == 0x30 {
                i += 1
            } else {
                while i < b.count, digit(b[i]) { i += 1 }
            }
            var integral = true
            if i < b.count, b[i] == 0x2E {
                integral = false
                i += 1
                guard i < b.count, digit(b[i]) else { throw fail() }
                while i < b.count, digit(b[i]) { i += 1 }
            }
            if i < b.count, b[i] == 0x65 || b[i] == 0x45 {
                integral = false
                i += 1
                if i < b.count, b[i] == 0x2B || b[i] == 0x2D { i += 1 }
                guard i < b.count, digit(b[i]) else { throw fail() }
                while i < b.count, digit(b[i]) { i += 1 }
            }
            let lit = String(decoding: b[start..<i], as: UTF8.self)
            if integral, !asDoubles, let n = Int(lit), n.magnitude <= UInt(CanonicalJSON.maxSafeInteger) {
                return .int(n)
            }
            guard let d = Double(lit), d.isFinite else { throw fail() }
            return .double(d)
        }

        mutating func hex4() throws -> UInt32 {
            guard i + 4 <= b.count else { throw fail() }
            var v: UInt32 = 0
            for _ in 0..<4 {
                let c = b[i]
                let d: UInt32
                switch c {
                case 0x30...0x39: d = UInt32(c - 0x30)
                case 0x41...0x46: d = UInt32(c - 0x41 + 10)
                case 0x61...0x66: d = UInt32(c - 0x61 + 10)
                default: throw fail()
                }
                v = v << 4 | d
                i += 1
            }
            return v
        }

        mutating func string() throws -> String {
            i += 1  // the opening quote
            var out = String.UnicodeScalarView()
            var run: [UInt8] = []
            func flush(_ out: inout String.UnicodeScalarView, _ run: inout [UInt8]) throws {
                if run.isEmpty { return }
                guard let s = String(validating: run, as: UTF8.self) else {
                    throw SyncCryptoError.unspellable("not UTF-8")
                }
                out.append(contentsOf: s.unicodeScalars)
                run.removeAll(keepingCapacity: true)
            }
            while true {
                guard i < b.count else { throw fail() }
                let c = b[i]
                if c == 0x22 {
                    i += 1
                    try flush(&out, &run)
                    return String(out)
                }
                if c < 0x20 { throw fail() }
                if c != 0x5C {
                    run.append(c)
                    i += 1
                    continue
                }
                try flush(&out, &run)
                i += 1
                guard i < b.count else { throw fail() }
                let e = b[i]
                i += 1
                switch e {
                case 0x22: out.append("\"")
                case 0x5C: out.append("\\")
                case 0x2F: out.append("/")
                case 0x62: out.append("\u{08}")
                case 0x66: out.append("\u{0C}")
                case 0x6E: out.append("\n")
                case 0x72: out.append("\r")
                case 0x74: out.append("\t")
                case 0x75:
                    let u = try hex4()
                    if u >= 0xD800 && u <= 0xDBFF {
                        guard i + 1 < b.count, b[i] == 0x5C, b[i + 1] == 0x75 else {
                            throw SyncCryptoError.unspellable("lone surrogate")
                        }
                        i += 2
                        let lo = try hex4()
                        guard lo >= 0xDC00 && lo <= 0xDFFF else {
                            throw SyncCryptoError.unspellable("lone surrogate")
                        }
                        out.append(Unicode.Scalar(0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00))!)
                    } else if u >= 0xDC00 && u <= 0xDFFF {
                        throw SyncCryptoError.unspellable("lone surrogate")
                    } else {
                        out.append(Unicode.Scalar(u)!)
                    }
                default: throw fail()
                }
            }
        }
    }
}
