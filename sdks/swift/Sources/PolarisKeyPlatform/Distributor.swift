// The install source: MarketplaceKit's AppDistributor plus static bundle evidence, as RAW signals.
// Mapping them to an outlet is not done here: that is `detectOutlet` (PolarisKeyCore,
// outlet-matrix.json) in every SDK.
//
// The order (notes/S-09 §Results 2):
//
//   1. `AppDistributor.current` behind iOS 17.4, raced against a 2 s deadline, at EVERY launch
//      and never cached (Apple: "check the current source at each launch"). It never resolved on
//      the iOS 26.5 simulator in 2, 5, 10, 30 or 100 s (S-06 §1, S-09), so a timeout, an error or
//      an OS below 17.4 returns `unavailable`, which means "no evidence". The `web` case exists
//      from iOS 17.5 only.
//   2. Static bundle evidence, read in the same call and always returned: `provisioned`
//      (`embedded.mobileprovision` is present: development, ad hoc, AltStore, SideStore; never
//      App Store or TestFlight), `altBundleIdentifier` (AltStore's rewrite) and the running
//      `bundleIdentifier`. It can VETO a store outlet; it never selects one.
//
// Never used for outlet detection: `AppDistributor.eligibilityRegion` (iOS 26.4, marketplace
// transaction reporting only; it never resolves on the simulator either) and AppTransaction
// (commerce only; it may need the network and a signed-in account).

import Foundation

#if os(iOS) && canImport(MarketplaceKit)
import MarketplaceKit
#endif

/// The distributor exactly as the system reports it.
public enum DistributorCase: Sendable, Equatable {
    case appStore
    case testFlight
    case marketplace(String)
    case web
    case other
}

/// Where `AppDistributor.current` comes from (a fake in tests).
public protocol DistributorSource: Sendable {
    /// The distributor. Throws when the system answers with an error. May never return.
    func current() async throws -> DistributorCase
}

/// The bundle facts that can veto a store outlet (a fake in tests).
public struct BundleEvidence: Sendable, Equatable {
    public var provisioned: Bool
    public var altBundleIdentifier: String?
    public var bundleIdentifier: String?

    public init(provisioned: Bool, altBundleIdentifier: String? = nil, bundleIdentifier: String? = nil) {
        self.provisioned = provisioned
        self.altBundleIdentifier = altBundleIdentifier
        self.bundleIdentifier = bundleIdentifier
    }

    /// This process's main bundle.
    public static func mainBundle() -> BundleEvidence {
        let main = Bundle.main
        return BundleEvidence(
            provisioned: main.path(forResource: "embedded", ofType: "mobileprovision") != nil,
            altBundleIdentifier: main.object(forInfoDictionaryKey: "ALTBundleIdentifier") as? String,
            bundleIdentifier: main.bundleIdentifier)
    }
}

/// The system's AppDistributor. Callers check `PlatformAvailability.appDistributor` first;
/// this throws `PlatformUnavailable` where the API does not exist.
public struct SystemDistributor: DistributorSource {
    public init() {}

    public func current() async throws -> DistributorCase {
        #if os(iOS) && canImport(MarketplaceKit)
        if #available(iOS 17.4, *) {
            let d = try await AppDistributor.current
            switch d {
            case .appStore: return .appStore
            case .testFlight: return .testFlight
            case .marketplace(let id): return .marketplace(id)
            case .other: return .other
            default:
                // `.web` is iOS 17.5: naming it in a `case` does not compile at a 17.0 floor.
                if #available(iOS 17.5, *), case .web = d { return .web }
                return .other
            }
        }
        #endif
        throw PlatformUnavailable(reason: "version", detail: "AppDistributor needs iOS 17.4")
    }
}

/// An API this OS or build does not have. `reason` is a PARITY §2.2 unsupported reason
/// (`runtime`, `outlet`, `version`, `dependency`).
public struct PlatformUnavailable: Error, Sendable, Equatable {
    public let reason: String
    public let detail: String

    public init(reason: String, detail: String) {
        self.reason = reason
        self.detail = detail
    }
}

/// The default deadline for `AppDistributor.current` (`OUTLET_PLATFORM_DATA.deadlineMs`).
public let defaultDistributorDeadline: Double = 2.0

/// The `distributor` op: `{ok, signal, reason?, ms, provisioned, altBundleIdentifier,
/// bundleIdentifier}`. `signal` is `appStore`, `testFlight`, `marketplace:<bundle id>`, `web`,
/// `other` or `unavailable`; `reason` says why it is `unavailable` (`version`, `runtime`,
/// `timeout`, or `error: …`).
public func readDistributor(
    source: any DistributorSource = SystemDistributor(),
    evidence: BundleEvidence = .mainBundle(),
    availability: PlatformAvailability = .current,
    deadline: Double = defaultDistributorDeadline
) async -> PlatformObject {
    let start = Date()
    var out: PlatformObject = ["ok": true]
    if !availability.appDistributor {
        out["signal"] = "unavailable"
        #if os(iOS)
        out["reason"] = "version"
        #else
        out["reason"] = "runtime"
        #endif
    } else {
        do {
            let d = try await withPlatformDeadline(deadline) { try await source.current() }
            out["signal"] = .string(signal(for: d, availability: availability))
        } catch let t as PlatformTimeout {
            out["signal"] = "unavailable"
            out["reason"] = "timeout"
            out["deadline"] = .double(t.seconds)
        } catch let u as PlatformUnavailable {
            out["signal"] = "unavailable"
            out["reason"] = .string(u.reason)
        } catch {
            out["signal"] = "unavailable"
            out["reason"] = .string("error: \(error)")
        }
    }
    out["ms"] = .int(elapsedMs(since: start))
    out["provisioned"] = .bool(evidence.provisioned)
    out["altBundleIdentifier"] = evidence.altBundleIdentifier.map(PlatformJSON.string) ?? .null
    out["bundleIdentifier"] = evidence.bundleIdentifier.map(PlatformJSON.string) ?? .null
    return out
}

/// The signal string for a distributor case. `web` is only reported where the case exists
/// (iOS 17.5); below it the same answer reads `other`.
public func signal(for d: DistributorCase, availability: PlatformAvailability) -> String {
    switch d {
    case .appStore: return "appStore"
    case .testFlight: return "testFlight"
    case .marketplace(let id): return "marketplace:\(id)"
    case .web: return availability.appDistributorWeb ? "web" : "other"
    case .other: return "other"
    }
}
