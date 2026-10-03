// The JSON value tree every C-surface request, result and event is made of. Its leaves are all
// Sendable, so a result can cross from a StoreKit or Background Assets task to the event callback
// under Swift 6 strict concurrency without `[String: Any]` ever leaving this file.
//
// It is deliberately separate from PolarisKeyCore's `JSONValue`: this target depends on nothing
// else in the package (Unity, MAUI and Tauri hosts link it alone), and a module that imports both
// would otherwise see two `JSONValue`s.

import Foundation

/// One JSON value.
public enum PlatformJSON: Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    case array([PlatformJSON])
    case object([String: PlatformJSON])

    /// The string, when this is one.
    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// The number as a Double, when this is one.
    public var doubleValue: Double? {
        switch self {
        case .int(let i): return Double(i)
        case .double(let d): return d
        default: return nil
        }
    }

    /// The Bool, when this is one.
    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    var foundation: Any {
        switch self {
        case .string(let s): return s
        case .int(let i): return i
        case .double(let d): return d
        case .bool(let b): return b
        case .null: return NSNull()
        case .array(let a): return a.map(\.foundation)
        case .object(let o): return o.mapValues(\.foundation)
        }
    }

    static func from(_ any: Any?) -> PlatformJSON {
        switch any {
        case nil, is NSNull:
            return .null
        case let s as String:
            return .string(s)
        case let n as NSNumber:
            return number(n)
        case let a as [Any]:
            return .array(a.map { from($0) })
        case let o as [String: Any]:
            return .object(o.mapValues { from($0) })
        default:
            return .null
        }
    }

    private static func number(_ n: NSNumber) -> PlatformJSON {
        #if canImport(Darwin)
        // NSNumber bridges to Bool, Int and Double alike; CoreFoundation knows which it holds.
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
        if CFNumberIsFloatType(n) { return .double(n.doubleValue) }
        return .int(n.intValue)
        #else
        let d = n.doubleValue
        if d == d.rounded(), abs(d) < 9_007_199_254_740_992 { return .int(n.intValue) }
        return .double(d)
        #endif
    }
}

extension PlatformJSON: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .int(value) }
}

/// A JSON object of Sendable leaves.
public typealias PlatformObject = [String: PlatformJSON]

/// `{"k":…}` with sorted keys and unescaped slashes (paths stay readable). Never throws: an
/// unencodable value (a non-finite Double) yields an `encode` error object instead.
public func encodePlatformJSON(_ object: PlatformObject) -> String {
    let any = object.mapValues(\.foundation)
    guard JSONSerialization.isValidJSONObject(any),
        let data = try? JSONSerialization.data(withJSONObject: any, options: [.sortedKeys, .withoutEscapingSlashes]),
        let text = String(data: data, encoding: .utf8)
    else { return #"{"error":"encode","ok":false}"# }
    return text
}

/// The object `text` holds, or nil when it is not a JSON object.
public func decodePlatformJSON(_ text: String) -> PlatformObject? {
    guard let data = text.data(using: .utf8),
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return nil }
    return object.mapValues { PlatformJSON.from($0) }
}
