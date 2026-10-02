// Typed "unsupported here" (PARITY §2.2, P1b-10): `supports(feature)` and the capability list.
//
// The capability table is GENERATED from `sdks/swift/parity.json` into
// `Constants.generated.swift` (`CAPABILITIES`, `pnpm gen:constants`), so what this SDK answers
// is what its parity row says. The table is data; this file is the one engine that reads it.
//
// The order every SDK applies:
//
//   1. an unknown feature id                         → `version` (a newer feature)
//   2. a `runtime` N/A on this runtime               → `runtime`
//      (or any N/A on this runtime when the row is `na`)
//   3. a `planned` feature                           → `version` (this SDK does not have it yet)
//   4. an opt-in service discovery says is off       → `product`
//   5. any other declared N/A on this runtime        → its detector decides (`outlet`, …)
//   6. otherwise                                     → supported
//
// `supports()` never probes by calling: it reads the table, the client's resolved services and
// detectors that answer from state already held. It is side-effect free and offline.

import Foundation

/// Why a feature is unsupported here.
public struct Unsupported: Sendable, Equatable, CustomStringConvertible {
    /// The parity feature id (`Feature.configSecret`, …).
    public let feature: String
    /// One of `UNSUPPORTED_REASON_VALUES`: `runtime`, `outlet`, `product`, `dependency`, `version`.
    public let reason: String
    /// Human text: what is missing. Never a credential.
    public let detail: String

    public init(feature: String, reason: String, detail: String) {
        self.feature = feature
        self.reason = reason
        self.detail = detail
    }

    public var description: String { "\(feature) is not supported here (\(reason)): \(detail)" }
}

/// `supports(feature)`'s answer.
public enum Support: Sendable, Equatable {
    case supported(feature: String)
    case unsupported(Unsupported)

    public var isSupported: Bool {
        if case .supported = self { return true }
        return false
    }

    /// The `Unsupported` value, or nil when supported.
    public var unsupported: Unsupported? {
        if case let .unsupported(value) = self { return value }
        return nil
    }
}

/// What a call into an unsupported feature throws: the same fields `supports()` reports, with
/// the registry's `unsupported` code.
public struct UnsupportedError: Error, Sendable, Equatable, CustomStringConvertible {
    /// Always `ErrorCode.unsupported`.
    public let code: String
    public let unsupported: Unsupported

    public init(_ unsupported: Unsupported) {
        self.code = ErrorCode.unsupported
        self.unsupported = unsupported
    }

    public var feature: String { unsupported.feature }
    public var reason: String { unsupported.reason }
    public var detail: String { unsupported.detail }
    public var description: String { unsupported.description }
}

/// The table's runtime id for this build: `macos`, or `ios` (iPadOS included).
public var capabilityRuntime: String {
    #if os(macOS)
        return "macos"
    #else
        return "ios"
    #endif
}

/// A detector for one conditional (non-`runtime`) N/A: a detail when the feature is unsupported
/// right now, nil when it is supported. Must answer from state already held.
public typealias CapabilityDetector = @Sendable () -> String?

/// The detector key: `"<feature>#<reason>"`.
public func capabilityDetectorKey(_ feature: String, _ reason: String) -> String {
    "\(feature)#\(reason)"
}

/// A mismatch between a detector set and the capability table: a programming error.
public struct CapabilityTableError: Error, Sendable, Equatable, CustomStringConvertible {
    public let problems: [String]
    public var description: String { problems.joined(separator: "; ") }
}

/// The capability engine: the generated table, the runtime and the detectors.
public struct Capabilities: Sendable {
    public let table: [String: CapabilityRow]
    public let runtime: String
    public let runtimes: [String]
    public let detectors: [String: CapabilityDetector]

    /// Validates the detectors against the table and throws `CapabilityTableError` on any
    /// mismatch: every conditional N/A on `runtime` needs a detector, and every detector must
    /// name a conditional N/A on one of `runtimes`.
    public init(
        table: [String: CapabilityRow] = CAPABILITIES,
        runtime: String = capabilityRuntime,
        runtimes: [String] = CAPABILITY_RUNTIMES,
        detectors: [String: CapabilityDetector]
    ) throws {
        var problems: [String] = []
        var declared = Set<String>()
        for (feature, row) in table where row.status != "na" {
            for na in row.na where na.reason != UnsupportedReason.runtime {
                let key = capabilityDetectorKey(feature, na.reason)
                if runtimes.contains(na.runtime) { declared.insert(key) }
                if na.runtime == runtime && detectors[key] == nil {
                    problems.append("no detector for \(feature) \(na.reason) on \(runtime)")
                }
            }
        }
        for key in detectors.keys.sorted() where !declared.contains(key) {
            problems.append("detector \(key) names no conditional N/A in the table")
        }
        if !problems.isEmpty { throw CapabilityTableError(problems: problems.sorted()) }
        self.table = table
        self.runtime = runtime
        self.runtimes = runtimes
        self.detectors = detectors
    }

    /// The answer for one feature, given the services the client believes the product runs.
    public func supports(_ feature: String, services: ServicesMap) -> Support {
        func no(_ reason: String, _ detail: String) -> Support {
            .unsupported(Unsupported(feature: feature, reason: reason, detail: detail))
        }
        guard let row = table[feature] else {
            return no(
                UnsupportedReason.version,
                "PolarisKey \(POLARIS_SDK_VERSION) does not know the feature \(feature)")
        }
        let here = row.na.filter { $0.runtime == runtime }
        if row.status == "na", let na = here.first {
            return no(na.reason, "\(feature) is not available on \(runtime)")
        }
        if let na = here.first(where: { $0.reason == UnsupportedReason.runtime }) {
            return no(na.reason, "\(feature) is not available on \(runtime)")
        }
        if row.status == "na" {
            // The manifest covers every runtime it lists (parity rule 3); a runtime it does not
            // list cannot run this SDK's N/A feature either.
            return no(UnsupportedReason.runtime, "\(feature) is not available on \(runtime)")
        }
        if row.status == "planned" {
            return no(
                UnsupportedReason.version,
                "PolarisKey \(POLARIS_SDK_VERSION) does not implement \(feature) yet")
        }
        if let slug = ServiceSlug(rawValue: row.service), services[slug] != true {
            return no(
                UnsupportedReason.product,
                "the product does not run the \(row.service) service")
        }
        for na in here where na.reason != UnsupportedReason.runtime {
            if let detail = detectors[capabilityDetectorKey(feature, na.reason)]?() {
                return no(na.reason, detail)
            }
        }
        return .supported(feature: feature)
    }

    /// The supported feature ids, in registry order: the `caps` telemetry value.
    public func caps(services: ServicesMap) -> [String] {
        FEATURE_VALUES.filter { supports($0, services: services).isSupported }
    }
}

extension Capabilities {
    /// This SDK's detectors. The one conditional N/A in `parity.json` is `update.driver` on iOS
    /// (`except ios:outlet`): iOS forbids self-update, so the SDK offers a store link only.
    public static let sdkDetectors: [String: CapabilityDetector] = [
        // Consulted only where the table declares the N/A (iOS), so it always answers.
        capabilityDetectorKey(Feature.updateDriver, UnsupportedReason.outlet): {
            "iOS apps update through their outlet (the App Store, TestFlight or an alternative marketplace); the SDK offers a store link only"
        },
    ]

    /// The engine for this build. The generated table and `sdkDetectors` are checked against each
    /// other by the test suite, so a failure here is a build that changed one without the other.
    public static func sdk() -> Capabilities {
        do {
            return try Capabilities(detectors: sdkDetectors)
        } catch {
            preconditionFailure("PolarisKey capability table and detectors disagree: \(error)")
        }
    }
}
