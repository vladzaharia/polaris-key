import Foundation
import os
#if canImport(MarketplaceKit)
    import MarketplaceKit
#endif

/// Raw install-source signal, never mapped to an outlet here (that is P3-11's job).
public protocol DistributorSource: Sendable {
    /// "appStore" | "testFlight" | "marketplace:<bundleID>" | "web" | "other"; throws when the
    /// system answers with an error.
    func current() async throws -> String
}

public struct SystemDistributor: DistributorSource {
    public init() {}
    public func current() async throws -> String {
        #if os(iOS) && canImport(MarketplaceKit)
            if #available(iOS 17.4, *) {
                let d = try await AppDistributor.current
                switch d {
                case .appStore: return "appStore"
                case .testFlight: return "testFlight"
                case .marketplace(let id): return "marketplace:\(id)"
                case .other: return "other"
                default:
                    // `.web` exists from iOS 17.5; naming it in a `case` below that floor does not
                    // compile, so it is matched behind its own availability check.
                    if #available(iOS 17.5, *), case .web = d { return "web" }
                    return "other"
                }
            }
            throw PKError.unavailable("iOS < 17.4")
        #else
            throw PKError.unavailable("not iOS")
        #endif
    }
}

public enum PKError: Error, Sendable {
    case unavailable(String)
    case timeout(Double)
    case failed(String)
}

/// Single-shot latch: the first `claim()` wins.
final class Once: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: false)
    func claim() -> Bool { state.withLock { done in if done { return false }; done = true; return true } }
}

/// Races `body` against a deadline. A task group would wait for a child that ignores
/// cancellation (AppDistributor.current never resolves on the simulator, S-06), so the loser is
/// left running and its result dropped.
public func withDeadline<T: Sendable>(
    _ seconds: Double, _ body: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withCheckedThrowingContinuation { (k: CheckedContinuation<T, any Error>) in
        let once = Once()
        Task.detached {
            do {
                let v = try await body()
                if once.claim() { k.resume(returning: v) }
            } catch {
                if once.claim() { k.resume(throwing: error) }
            }
        }
        Task.detached {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
            if once.claim() { k.resume(throwing: PKError.timeout(seconds)) }
        }
    }
}

/// What P5-05's `distributor` op returns: the raw signal or `unavailable` (= no evidence).
public func readDistributor(
    _ source: any DistributorSource = SystemDistributor(), deadline: Double = 2.0
) async -> JSONObject {
    let t0 = Date()
    var out: JSONObject
    do {
        let s = try await withDeadline(deadline) { try await source.current() }
        out = ["signal": .string(s)]
    } catch PKError.timeout(let d) {
        out = ["signal": "unavailable", "reason": .string("timeout after \(d)s")]
    } catch {
        out = ["signal": "unavailable", "reason": .string("\(error)")]
    }
    out["ms"] = .int(Int(Date().timeIntervalSince(t0) * 1000))
    return out
}

/// iOS 26.4 adds `AppDistributor.eligibilityRegion` (read raw from the iOS 27 SDK interface).
public func readEligibilityRegion(deadline: Double = 2.0) async -> JSONObject {
    #if os(iOS) && canImport(MarketplaceKit)
        if #available(iOS 26.4, *) {
            let t0 = Date()
            do {
                let r = try await withDeadline(deadline) { await AppDistributor.eligibilityRegion }
                return ["region": r.map { .string($0) } ?? .null, "ms": .int(Int(Date().timeIntervalSince(t0) * 1000))]
            } catch {
                return ["region": "unavailable", "reason": .string("\(error)")]
            }
        }
        return ["region": "unavailable", "reason": "iOS < 26.4"]
    #else
        return ["region": "unavailable", "reason": "not iOS"]
    #endif
}
