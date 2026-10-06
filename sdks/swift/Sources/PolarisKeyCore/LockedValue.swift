// A value behind a lock, for the synchronous `nonisolated` members the SDK's actors expose
// (listener tables, hooks set once at wiring time). Public so every module shares one.

import Foundation

public final class LockedValue<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T

    public init(_ value: T) { self.value = value }

    /// Run `body` with exclusive access to the value.
    public func with<R>(_ body: (inout T) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body(&value)
    }

    public var current: T { with { $0 } }

    public func set(_ newValue: T) { with { $0 = newValue } }
}
