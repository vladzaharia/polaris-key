// The concurrency patterns PolarisKeyPlatform uses, minus Apple-only frameworks, so that older
// Swift 6 compilers (Linux images) can type-check them in Swift 6 language mode.
import Foundation

public typealias PKEventCallback = @convention(c) (UnsafePointer<CChar>) -> Void

func requireSendable<T: Sendable>(_: T.Type) {}
func checks() { requireSendable(PKEventCallback?.self) }  // a C function pointer is Sendable

public enum JSONValue: Sendable { case string(String), int(Int), object([String: JSONValue]) }
public typealias JSONObject = [String: JSONValue]

/// NSLock-guarded sink (OSAllocatedUnfairLock on Apple platforms; same Sendable shape).
public final class EventSink: @unchecked Sendable {
    public static let shared = EventSink()
    private let lock = NSLock()
    private var cb: PKEventCallback?
    public func set(_ c: PKEventCallback?) { lock.lock(); cb = c; lock.unlock() }
    public func emit(_ s: String) { lock.lock(); let c = cb; lock.unlock(); s.withCString { c?($0) } }
}

final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}

public enum PKError: Error, Sendable { case timeout(Double) }

public func withDeadline<T: Sendable>(_ seconds: Double, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { (k: CheckedContinuation<T, any Error>) in
        let once = Once()
        Task.detached {
            do { let v = try await body(); if once.claim() { k.resume(returning: v) } } catch { if once.claim() { k.resume(throwing: error) } }
        }
        Task.detached {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
            if once.claim() { k.resume(throwing: PKError.timeout(seconds)) }
        }
    }
}

public actor StoreService {
    public static let shared = StoreService()
    private var products: [String: String] = [:]
    public func product(_ id: String) -> String? { products[id] }
}

@MainActor public func purchase(_ id: String) async -> JSONObject {
    let p = await StoreService.shared.product(id)
    return ["ok": .string(p ?? "none")]
}

private func async(_ op: String, _ work: @escaping @Sendable () async -> JSONObject) -> JSONObject {
    Task.detached {
        var o = await work()
        o["ev"] = .string(op)
        EventSink.shared.emit("\(o.count)")
    }
    return ["ok": .string("queued")]
}

@_cdecl("pkp_call")
public func pkp_call(_ json: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar> {
    let s = String(cString: json)
    let id = s  // only Sendable values cross into the task
    _ = async("purchase") { await purchase(id) }
    return strdup("{}")!
}

// The two shortcuts that look tempting and what each compiler says about them:
#if SHORTCUTS
// (a) a plain global var holding the callback, no lock
public var gCallback: PKEventCallback?
// (b) hopping to the main actor by capturing a non-Sendable dictionary
public func hopWithAny(_ q: [String: Any]) { Task { @MainActor in print(q.count) } }
// (c) assuming main-actor isolation synchronously from a C entry point
@_cdecl("pkp_sync_main") public func pkp_sync_main() { MainActor.assumeIsolated { _ = 1 } }
#endif
