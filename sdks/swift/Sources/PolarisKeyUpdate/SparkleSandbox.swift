// The sandbox check for `PolarisSparkle.start` (DB-3).
//
// A sandboxed Developer ID app that skips Sparkle's installer setup starts Sparkle without a
// word and fails only when it installs. Sparkle 2 needs, in a sandboxed app:
//
//   - `SUEnableInstallerLauncherService = YES` in Info.plist;
//   - a `com.apple.security.temporary-exception.mach-lookup.global-name` entitlement naming
//     `<bundle id>-spks` and `<bundle id>-spki`;
//   - `SUEnableDownloaderService = YES` when the app lacks `com.apple.security.network.client`.
//
// `SparkleSandbox.assertConfigured` reads the entitlements through an injected reader (the
// running task's, by default), so every branch is testable without a sandboxed process. Like the
// anchor check it is platform-free and does not import Sparkle.

import Foundation

#if os(macOS)
    import Security
#endif

/// Why a sandboxed app cannot install a Sparkle update. Thrown by `PolarisSparkle.start`, so the
/// failure is on the first run and not at install time.
public enum SparkleSandboxError: Error, Sendable, Equatable, CustomStringConvertible {
    /// The app is sandboxed and something Sparkle's installer needs is missing. `missing` names
    /// each item: an Info.plist key or an entitlement value.
    case notConfigured(bundleIdentifier: String?, missing: [String])

    public var description: String {
        switch self {
        case .notConfigured(let bundle, let missing):
            return
                "\(bundle ?? "The host app") is sandboxed, and Sparkle cannot install an update "
                + "without: \(missing.joined(separator: ", ")). "
                + "Add the Info.plist keys and the mach-lookup entitlement from Sparkle's "
                + "sandboxing guide (SUEnableInstallerLauncherService, and the "
                + "`<bundle id>-spks` and `<bundle id>-spki` names under "
                + "com.apple.security.temporary-exception.mach-lookup.global-name)."
        }
    }
}

public enum SparkleSandbox {
    /// Reads one entitlement of the running task; `nil` when it is not set.
    public typealias EntitlementReader = @Sendable (_ key: String) -> Any?

    public static let appSandboxEntitlement = "com.apple.security.app-sandbox"
    public static let machLookupEntitlement =
        "com.apple.security.temporary-exception.mach-lookup.global-name"
    public static let networkClientEntitlement = "com.apple.security.network.client"
    public static let installerLauncherInfoKey = "SUEnableInstallerLauncherService"
    public static let downloaderInfoKey = "SUEnableDownloaderService"

    /// The running task's entitlements (`SecTaskCopyValueForEntitlement`). Everywhere but macOS
    /// it reads nothing, so the app counts as unsandboxed.
    public static let currentTask: EntitlementReader = { key in
        #if os(macOS)
            guard let task = SecTaskCreateFromSelf(nil) else { return nil }
            return SecTaskCopyValueForEntitlement(task, key as CFString, nil)
        #else
            return nil
        #endif
    }

    /// Throw `SparkleSandboxError.notConfigured` when the app is sandboxed and lacks what
    /// Sparkle's installer needs. An unsandboxed app always passes.
    public static func assertConfigured(
        infoDictionary: [String: Any]?, bundleIdentifier: String?,
        entitlements read: EntitlementReader = currentTask
    ) throws {
        guard truthy(read(appSandboxEntitlement)) else { return }
        var missing: [String] = []
        if !truthy(infoDictionary?[installerLauncherInfoKey]) {
            missing.append("\(installerLauncherInfoKey) = YES in Info.plist")
        }
        let names = (read(machLookupEntitlement) as? [String]) ?? []
        let id = bundleIdentifier ?? ""
        for suffix in ["-spks", "-spki"] where !names.contains(id + suffix) {
            missing.append("mach-lookup name \(id)\(suffix)")
        }
        if !truthy(read(networkClientEntitlement)), !truthy(infoDictionary?[downloaderInfoKey]) {
            missing.append(
                "\(downloaderInfoKey) = YES in Info.plist (the app lacks \(networkClientEntitlement))")
        }
        if !missing.isEmpty {
            throw SparkleSandboxError.notConfigured(
                bundleIdentifier: bundleIdentifier, missing: missing)
        }
    }

    /// The same check for a real bundle.
    public static func assertConfigured(
        in bundle: Foundation.Bundle = .main, entitlements read: EntitlementReader = currentTask
    ) throws {
        try assertConfigured(
            infoDictionary: bundle.infoDictionary, bundleIdentifier: bundle.bundleIdentifier,
            entitlements: read)
    }

    private static func truthy(_ value: Any?) -> Bool {
        if let flag = value as? Bool { return flag }
        if let number = value as? NSNumber { return number.boolValue }
        if let text = value as? String { return ["yes", "true", "1"].contains(text.lowercased()) }
        return false
    }
}
