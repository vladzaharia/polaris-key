// The one place asynchronous results and events leave the target.
//
// A host registers one C callback (`pkp_set_event_callback`). It may be called on ANY thread, so
// a host whose engine is single-threaded (Godot) only copies the string into a locked queue and
// drains it on its own main thread; no Swift code here ever calls into a host engine. The
// callback sits behind a lock: a plain global `var` holding it is a Swift 6 error ("not
// concurrency-safe because it is nonisolated global shared mutable state", S-09).

import Foundation

/// The host's event callback: one UTF-8 JSON object per call, valid only for the call.
public typealias PlatformEventCallback = @convention(c) (UnsafePointer<CChar>) -> Void

/// Where events go: the C callback when one is installed, else an in-process observer (Swift
/// hosts and tests), else a bounded in-memory buffer that `drain()` empties.
public final class PlatformEventSink: Sendable {
    /// Events buffered while nobody listens are capped, oldest dropped, so a host that never
    /// registers a callback cannot grow memory without bound.
    public static let bufferLimit = 512

    private let callback = PlatformLock<PlatformEventCallback?>(nil)
    private let observer = PlatformLock<(@Sendable (PlatformObject) -> Void)?>(nil)
    private let buffer = PlatformLock<[PlatformObject]>([])

    public init() {}

    public func setCallback(_ cb: PlatformEventCallback?) { callback.withLock { $0 = cb } }

    /// A Swift-side observer, used when no C callback is installed.
    public func setObserver(_ fn: (@Sendable (PlatformObject) -> Void)?) { observer.withLock { $0 = fn } }

    /// The buffered events (only filled while neither a callback nor an observer is installed).
    public func drain() -> [PlatformObject] {
        buffer.withLock { b in
            defer { b = [] }
            return b
        }
    }

    public func emit(_ event: PlatformObject) {
        if let cb = callback.withLock({ $0 }) {
            encodePlatformJSON(event).withCString { cb($0) }
        } else if let fn = observer.withLock({ $0 }) {
            fn(event)
        } else {
            buffer.withLock { b in
                b.append(event)
                if b.count > PlatformEventSink.bufferLimit { b.removeFirst(b.count - PlatformEventSink.bufferLimit) }
            }
        }
    }
}
