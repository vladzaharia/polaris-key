import Foundation
import os

/// One C callback for every asynchronous result and event. It may be called on any thread; a
/// host that needs its main thread (Godot does) queues the string and drains it there.
public typealias PKEventCallback = @convention(c) (UnsafePointer<CChar>) -> Void

/// A JSON object made only of Sendable leaves, so events can cross isolation domains in Swift 6.
public typealias JSONObject = [String: JSONValue]

public enum JSONValue: Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    var any: Any {
        switch self {
        case .string(let s): return s
        case .int(let i): return i
        case .double(let d): return d
        case .bool(let b): return b
        case .null: return NSNull()
        case .array(let a): return a.map(\.any)
        case .object(let o): return o.mapValues(\.any)
        }
    }

    static func from(_ any: Any?) -> JSONValue {
        switch any {
        case nil: return .null
        case let s as String: return .string(s)
        case let n as NSNumber:
            // NSNumber bridges to Bool, Int and Double alike; ask CoreFoundation which it is.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            if CFNumberIsFloatType(n) { return .double(n.doubleValue) }
            return .int(n.intValue)
        case let a as [Any]: return .array(a.map { from($0) })
        case let o as [String: Any]: return .object(o.mapValues { from($0) })
        default: return .string(String(describing: any!))
        }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .int(value) }
}

public func encodeJSON(_ obj: JSONObject) -> String {
    let any = obj.mapValues(\.any)
    guard let data = try? JSONSerialization.data(withJSONObject: any, options: [.sortedKeys]),
        let s = String(data: data, encoding: .utf8)
    else { return #"{"ok":false,"error":"encode"}"# }
    return s
}

public func decodeJSON(_ s: String) -> JSONObject? {
    guard let d = s.data(using: .utf8),
        let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
    else { return nil }
    return o.mapValues { JSONValue.from($0) }
}

/// The process-wide event sink. `OSAllocatedUnfairLock` (iOS 16 / macOS 13) instead of
/// `Synchronization.Mutex`, which is iOS 18 / macOS 15 and so above the package floor.
public final class EventSink: Sendable {
    public static let shared = EventSink()
    private let callback = OSAllocatedUnfairLock<PKEventCallback?>(initialState: nil)
    private let recorder = OSAllocatedUnfairLock<[String]>(initialState: [])

    public func set(_ cb: PKEventCallback?) { callback.withLock { $0 = cb } }

    /// Tests read events here when no C callback is installed.
    public func drainRecorded() -> [String] { recorder.withLock { r in defer { r = [] }; return r } }

    public func emit(_ obj: JSONObject) {
        var o = obj
        o["main_thread"] = .bool(Thread.isMainThread)
        let s = encodeJSON(o)
        if let cb = callback.withLock({ $0 }) {
            s.withCString { cb($0) }
        } else {
            recorder.withLock { $0.append(s) }
        }
    }
}
