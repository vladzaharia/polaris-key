// The Sparkle trust anchor assertion (D-24).
//
// ── WHY THIS IS AN ASSERTION AND NOT AN IMPLEMENTATION ──────────────────────────────────────
//
// Sparkle's update signature is verified against `SUPublicEDKey` in the HOST APPLICATION's
// code-signed `Info.plist`. That key is the terminal anchor for update integrity, and it is
// deliberately outside this SDK's reach: an anchor an ordinary file could add to is worse than
// every comparator in the field (docs/security/arch/anti-piracy-realism.md §5.3), and Sparkle
// gets this right precisely because the key ships inside the signed bundle where an attacker
// replacing an update cannot also replace the thing that checks it.
//
// So PolarisKeyUpdate does exactly one thing about it: it CHECKS THE KEY IS THERE, loudly, at
// construction — and never, under any circumstance, verifies an update itself. A Polaris-side
// EdDSA check would be a second, weaker anchor sitting next to the real one, and the failure
// mode of "two anchors, one of them ours" is that the weaker one is what an attacker attacks.
//
// The failure it catches is real and silent: an app that ships Sparkle without `SUPublicEDKey`
// does not fail to build, does not fail to launch, and does not fail to check for updates — it
// simply installs unsigned payloads. Failing at `PolarisSparkleUpdater(...)` turns that into a
// crash in the developer's first run instead of a supply-chain incident in production.
//
// Deliberately NOT `#if os(macOS)`-guarded and deliberately not importing Sparkle: it is a
// dictionary lookup, and keeping it platform-free is what lets CI test every branch without
// instantiating an updater.

import Foundation

/// Why the host bundle is not fit to receive Sparkle updates.
public enum SparkleAnchorError: Error, Sendable, Equatable, CustomStringConvertible {
    /// No `SUPublicEDKey` in the bundle's Info.plist. Sparkle would accept an unsigned update.
    case missingPublicEDKey(bundleIdentifier: String?)
    /// `SUPublicEDKey` is present but empty or not a string — the same outcome as absent, with
    /// a more confusing plist.
    case malformedPublicEDKey(bundleIdentifier: String?)

    public var description: String {
        switch self {
        case .missingPublicEDKey(let bundle):
            return
                "SUPublicEDKey is missing from \(bundle ?? "the host bundle")'s Info.plist. "
                + "Sparkle would accept an unsigned update. Add the EdDSA public key printed by "
                + "Sparkle's `generate_keys` tool; PolarisKeyUpdate deliberately does not verify "
                + "updates itself, so this key is the only thing that does."
        case .malformedPublicEDKey(let bundle):
            return
                "SUPublicEDKey in \(bundle ?? "the host bundle")'s Info.plist is empty or not a "
                + "string. Sparkle cannot verify updates with it."
        }
    }
}

public enum SparkleAnchor {
    /// The Info.plist key Sparkle reads its EdDSA public key from. Spelled literally rather than
    /// imported from `SUConstants.h`, which is not part of Sparkle's public module — and because
    /// the key belongs to the HOST bundle, not to Sparkle.
    public static let publicEDKeyInfoKey = "SUPublicEDKey"

    /// Assert the anchor is present in an already-read info dictionary. The testable core.
    public static func assertPresent(
        infoDictionary: [String: Any]?, bundleIdentifier: String? = nil
    ) throws {
        guard let value = infoDictionary?[publicEDKeyInfoKey] else {
            throw SparkleAnchorError.missingPublicEDKey(bundleIdentifier: bundleIdentifier)
        }
        guard let key = value as? String,
            !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw SparkleAnchorError.malformedPublicEDKey(bundleIdentifier: bundleIdentifier)
        }
    }

    /// Assert the anchor is present in a real bundle. Defaults to `.main` — the application
    /// being updated, which is the only bundle whose signature covers the key.
    public static func assertPresent(in bundle: Foundation.Bundle = .main) throws {
        try assertPresent(
            infoDictionary: bundle.infoDictionary, bundleIdentifier: bundle.bundleIdentifier)
    }
}
