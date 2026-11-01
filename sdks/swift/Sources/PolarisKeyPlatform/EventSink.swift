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
    /// Binary events (the Godot binary entry, D-13): `kind` names the event; `data` is the payload.
    /// The pointers are valid only for the call.
    public typealias BinaryCallback = @convention(c) (UnsafePointer<CChar>, UnsafePointer<UInt8>?, Int) -> Void

    private let binaryCallback = PlatformLock<BinaryCallback?>(nil)
    private let binaryBuffer = PlatformLock<[(String, [UInt8])]>([])

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

    public func setBinaryCallback(_ cb: BinaryCallback?) { binaryCallback.withLock { $0 = cb } }

    /// The binary events buffered while no callback is installed (capped like `buffer`).
    public func drainBinary() -> [(String, [UInt8])] {
        binaryBuffer.withLock { b in
            defer { b = [] }
            return b
        }
    }

    /// One binary event: to the C callback when one is installed, else the bounded buffer.
    public func emitBinary(_ kind: String, _ data: [UInt8]) {
        if let cb = binaryCallback.withLock({ $0 }) {
            kind.withCString { k in data.withUnsafeBufferPointer { cb(k, $0.baseAddress, $0.count) } }
        } else {
            binaryBuffer.withLock { b in
                b.append((kind, data))
                if b.count > PlatformEventSink.bufferLimit { b.removeFirst(b.count - PlatformEventSink.bufferLimit) }
            }
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
