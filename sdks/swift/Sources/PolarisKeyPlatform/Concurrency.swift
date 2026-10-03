// The concurrency primitives the target is built on, kept to what Swift 6.0 and the iOS 17 /
// macOS 14 floors allow (notes/S-09 §Results 4):
//
//   - `PlatformLock` is `OSAllocatedUnfairLock` (iOS 16 / macOS 13) on Apple platforms.
//     `Synchronization.Mutex` is iOS 18 / macOS 15, above the floor. Elsewhere (the Linux
//     type-check of the non-Apple parts) it is an NSLock.
//   - `withPlatformDeadline` races an operation against a deadline WITHOUT a task group: a group
//     waits for a child that ignores cancellation, and `AppDistributor.current` never resolves on
//     the simulator (notes/S-06 §1, S-09 §Results 2). The losing task is left running and its
//     result dropped.
//
// No Swift 6.2+ language feature (`@concurrent`, `nonisolated(nonsending)`, `Task.immediate`,
// isolated conformances, `@c`) appears in this target: CI's macos-15 job compiles it with
// Xcode 16.4 (Swift 6.1).

import Foundation

#if canImport(os)
import os

/// A lock around `State`.
public struct PlatformLock<State: Sendable>: Sendable {
    private let lock: OSAllocatedUnfairLock<State>

    public init(_ initial: State) { lock = OSAllocatedUnfairLock(initialState: initial) }

    public func withLock<R: Sendable>(_ body: @Sendable (inout State) throws -> R) rethrows -> R {
        try lock.withLock(body)
    }
}
#else
/// A lock around `State`.
public final class PlatformLock<State: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var state: State

    public init(_ initial: State) { state = initial }

    public func withLock<R: Sendable>(_ body: @Sendable (inout State) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body(&state)
    }
}
#endif

/// A one-shot latch: the first `claim()` wins.
final class Once: Sendable {
    private let state = PlatformLock(false)

    func claim() -> Bool {
        state.withLock { done in
            if done { return false }
            done = true
            return true
        }
    }
}

/// Thrown by `withPlatformDeadline` when the deadline passes first.
public struct PlatformTimeout: Error, Sendable, Equatable {
    public let seconds: Double
}

/// `body`'s value, or `PlatformTimeout` when `seconds` pass first. `body` is not awaited past
/// the deadline.
public func withPlatformDeadline<T: Sendable>(
    _ seconds: Double, _ body: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withCheckedThrowingContinuation { (k: CheckedContinuation<T, any Error>) in
        let once = Once()
        let timer = Task.detached {
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            if once.claim() { k.resume(throwing: PlatformTimeout(seconds: seconds)) }
        }
        Task.detached {
            do {
                let value = try await body()
                if once.claim() {
                    timer.cancel()
                    k.resume(returning: value)
                }
            } catch {
                if once.claim() {
                    timer.cancel()
                    k.resume(throwing: error)
                }
            }
        }
    }
}

/// Milliseconds since `start`, for the `ms` field results carry.
func elapsedMs(since start: Date) -> Int { Int(Date().timeIntervalSince(start) * 1000) }
