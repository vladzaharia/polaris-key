// A JSON value enum mirroring the protocol's `JSONValue` (string | number | bool | null |
// array | object). Managed entries carry arbitrary JSON values (a concurrency int, a
// channel string array, a secret URL string, an entitlement bool), so config/secret/
// entitlement values are decoded into this rather than a fixed Swift type.
//
// Number handling: JSON has one number type. We decode integers as `.int` when they round-
// trip losslessly (so `4` stays `4`, never `4.0`), else `.double`. `Codable` round-trips
// the value unchanged, which keeps the corpus's structural equality intact.

import Foundation

public enum JSONValue: Sendable, Equatable, Codable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? c.decode(Int.self) {
            self = .int(i)
        } else if let d = try? c.decode(Double.self) {
            self = .double(d)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(
                in: c, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    // ── Ergonomic accessors (mirror how the Node client reads `.value`) ──────────
    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var intValue: Int? {
        switch self {
        case .int(let i): return i
        case .double(let d) where d == d.rounded(): return Int(d)
        default: return nil
        }
    }

    public var doubleValue: Double? {
        switch self {
        case .double(let d): return d
        case .int(let i): return Double(i)
        default: return nil
        }
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }
}

// Reads as JSON in logs and `print`: `{"limit": 3, "tags": ["a", "b"]}` rather than the enum's
// `object(["limit": PolarisKeyCore.JSONValue.int(3)])`. Keys are sorted so the text is stable.
extension JSONValue: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String {
        switch self {
        case .string(let s): return Self.quoted(s)
        case .int(let i): return String(i)
        case .double(let d): return d.isFinite ? String(d) : "null"
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let a): return "[" + a.map(\.description).joined(separator: ", ") + "]"
        case .object(let o):
            return "{"
                + o.keys.sorted().map { "\(Self.quoted($0)): \(o[$0]!.description)" }
                .joined(separator: ", ") + "}"
        }
    }

    public var debugDescription: String { description }

    private static func quoted(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}
