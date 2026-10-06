// User-facing copy for the registry's error codes (notes/SDK-PARITY-PASS.md §3.2).
//
// One English sentence per code a person can meet, keyed by the codes in
// `conformance/parity/errors.json` (the generated `ErrorCode` constants), so every surface that
// shows an error — `PolarisError.errorDescription`, `ActivationResult.message`, the SwiftUI kit —
// says the same thing for the same code. The shared base, `conformance/parity/copy.en.json`, is
// SP-03's; until it lands this table is that base for Swift, and it is checked against the
// registry by `ErrorCopyTests` (every code a person can meet has its own line).
//
// The rules (§3.2):
//
//   * a code with no line of its own falls back to a generic sentence PLUS the code, never the raw
//     server body, so a support request still carries something a developer can look up;
//   * the copy names no platform ("this Mac") unless it is one: `deviceNoun` is "this Mac" on
//     macOS and "this device" everywhere else.

import Foundation

public enum ErrorCopy {
    /// "this Mac" on macOS, "this device" on every other platform.
    public static var deviceNoun: String {
        #if os(macOS)
            return "this Mac"
        #else
            return "this device"
        #endif
    }

    /// `deviceNoun` at the start of a sentence: "This Mac" or "This device".
    public static var deviceNounCapitalized: String {
        #if os(macOS)
            return "This Mac"
        #else
            return "This device"
        #endif
    }

    /// The generic sentence for a code with no line of its own.
    public static let genericMessage = "Something went wrong."

    /// The sentence for `code`, with `detail` appended when given. A code with no line of its own
    /// answers `genericMessage` followed by the code in parentheses.
    public static func message(_ code: String, detail: String? = nil) -> String {
        let base = messages[code] ?? "\(genericMessage) (\(code))"
        guard let detail, !detail.isEmpty else { return base }
        return "\(base) \(detail)"
    }

    /// A short title for `code` (a dialog or card heading).
    public static func title(_ code: String) -> String {
        titles[code] ?? "Something went wrong"
    }

    /// Whether `code` has a line of its own.
    public static func has(_ code: String) -> Bool { messages[code] != nil }

    // ── The table ────────────────────────────────────────────────────────────────────────
    static let messages: [String: String] = [
        // Licence and activation (§3.1).
        ErrorCode.unauthorized: "That license key wasn't accepted.",
        ErrorCode.deviceLimit:
            "This license has reached its device limit. Free a device to use it here.",
        ErrorCode.fingerprintRequired:
            "This license needs a hardware fingerprint, which couldn't be read on \(deviceNoun).",
        ErrorCode.hardwareMismatch:
            "\(deviceNounCapitalized)'s hardware changed. "
            + "The previous authorization was released; activate again to re-bind.",
        ErrorCode.enrollDisabled: "This product doesn't offer a free license.",
        ErrorCode.enrollClaimed:
            "The free license for \(deviceNoun) belongs to an account now. Sign in to use it.",
        ErrorCode.enrollFailed: "A free license couldn't be issued. Try again later.",
        ErrorCode.licenseDisabled: "This license has been disabled.",
        ErrorCode.licenseExpired: "This license has expired.",
        ErrorCode.licenseOwned:
            "This license belongs to another account. Sign in to that account to use it.",
        ErrorCode.attestationRequired:
            "This product only runs on verified installs, and \(deviceNoun) couldn't be verified.",
        ErrorCode.attestationRejected: "\(deviceNounCapitalized) couldn't be verified.",
        ErrorCode.attestationUnavailable: "Install verification isn't set up for this product.",
        ErrorCode.rateLimited: "Too many attempts. Wait a moment and try again.",
        ErrorCode.registrationClosed: "This product isn't accepting new devices.",
        ErrorCode.notEntitled: "Your license doesn't include this.",
        ErrorCode.versionBlocked: "This version isn't permitted to run.",
        ErrorCode.channelNotAllowed: "Your license doesn't include this release channel.",
        ErrorCode.forbidden: "That isn't allowed.",
        ErrorCode.notFound: "That couldn't be found.",
        ErrorCode.badRequest: "The request was refused as invalid.",
        ErrorCode.managedByAdmin: "This setting is managed by your administrator.",
        // Identity.
        ErrorCode.disabled: "Sign-in isn't available for this product.",
        ErrorCode.oidcError: "Sign-in failed at the identity provider. Try again.",
        ErrorCode.unavailable: "Sign-in is busy right now. Try again.",
        ErrorCode.signInFailed: "Sign-in didn't complete.",
        ErrorCode.signOutFailed: "Sign-out didn't complete.",
        ErrorCode.signInExpired: "The sign-in code expired. Start again.",
        ErrorCode.signInDenied: "Sign-in was refused. Start again.",
        ErrorCode.signInUnavailable: "Sign-in couldn't start.",
        ErrorCode.cancelled: "Cancelled.",
        // Client-side.
        ErrorCode.serviceUnavailable: "This product doesn't offer that service.",
        ErrorCode.serviceDisabled: "This product doesn't offer that service.",
        ErrorCode.localOnly: "This app is running offline-only, so it can't reach the server.",
        ErrorCode.insecureBaseUrl: "The server address isn't secure.",
        ErrorCode.network: "The server couldn't be reached. Check your connection.",
        ErrorCode.networkError: "The server couldn't be reached. Check your connection.",
        ErrorCode.transport: "The server couldn't be reached. Check your connection.",
        ErrorCode.timeout: "The server took too long to answer.",
        ErrorCode.serverError: "The server had a problem. Try again later.",
        ErrorCode.internalError: "The server had a problem. Try again later.",
        ErrorCode.httpError: "The server refused the request.",
        ErrorCode.badResponse: "The server's answer couldn't be read.",
        ErrorCode.invalidResponse: "The server's answer couldn't be read.",
        ErrorCode.syncFailed: "Your license couldn't be checked.",
        ErrorCode.fetchFailed: "Required content couldn't be downloaded.",
        ErrorCode.refreshFailed: "Your license couldn't be refreshed.",
        ErrorCode.storeFailed: "Your license couldn't be saved on \(deviceNoun).",
        ErrorCode.noToken: "Activate or sign in first.",
        ErrorCode.deviceManagementUnsupported: "Activate or sign in to manage devices.",
        ErrorCode.deviceListFailed: "Your devices couldn't be listed.",
        ErrorCode.deviceRenameFailed: "The device couldn't be renamed.",
        ErrorCode.deviceDeauthorizeFailed: "The device couldn't be removed.",
        ErrorCode.unsupported: "That isn't supported here.",
        ErrorCode.notConfigured: "That isn't set up in this app.",
        ErrorCode.invalidOptions: "This app's Polaris Key setup is invalid.",
        ErrorCode.platformError: "The system refused the request.",
        ErrorCode.mintUnavailable: "That isn't available for this product.",
        // Offline bundles.
        ErrorCode.bundle: "That activation file couldn't be used.",
        ErrorCode.bundleRejected: "That activation file couldn't be used.",
        ErrorCode.bundleJwsRejected: "That activation file isn't valid.",
        ErrorCode.bundleClaimsRejected: "That activation file is for another device or has expired.",
        ErrorCode.bundleTrustRejected: "That activation file isn't from this product.",
        ErrorCode.innerDocRejected: "That activation file isn't from this product.",
        ErrorCode.bundleImportUnsupported: "Activation files can't be used here.",
        // Updates and downloads.
        ErrorCode.downloadAuthRequired: "Activate or sign in to download this.",
        ErrorCode.feedRejected: "The update information couldn't be verified.",
        ErrorCode.feedRollback: "The update information is older than what's installed.",
        ErrorCode.recordRejected: "The update couldn't be verified.",
        ErrorCode.recordMismatch: "The update couldn't be verified.",
        ErrorCode.payloadMismatch: "The download was damaged. Try again.",
        ErrorCode.releaseRefused: "Your license doesn't include this release.",
        ErrorCode.upstreamRateLimited: "Downloads are busy right now. Try again later.",
        // Packs.
        ErrorCode.packNotEntitled: "Your license doesn't include this content.",
        ErrorCode.packRevoked: "This content has been withdrawn.",
        ErrorCode.packStateUnreadable: "Installed content couldn't be read.",
        ErrorCode.planInsufficientDisk: "There isn't enough free space to download this content.",
        ErrorCode.deliveryGateMissing: "This content isn't available yet.",
    ]

    static let titles: [String: String] = [
        ErrorCode.unauthorized: "Key not accepted",
        ErrorCode.deviceLimit: "Device limit reached",
        ErrorCode.fingerprintRequired: "Hardware check needed",
        ErrorCode.hardwareMismatch: "Hardware changed",
        ErrorCode.enrollDisabled: "No free license",
        ErrorCode.enrollClaimed: "Sign in to continue",
        ErrorCode.licenseDisabled: "License disabled",
        ErrorCode.licenseExpired: "License expired",
        ErrorCode.licenseOwned: "License belongs to another account",
        ErrorCode.attestationRequired: "Verification needed",
        ErrorCode.rateLimited: "Too many attempts",
        ErrorCode.network: "You're offline",
        ErrorCode.networkError: "You're offline",
        ErrorCode.serverError: "Server problem",
        ErrorCode.localOnly: "Offline only",
        ErrorCode.notEntitled: "Not included",
        ErrorCode.signInExpired: "Code expired",
        ErrorCode.signInDenied: "Sign-in refused",
    ]
}

extension PolarisError: LocalizedError {
    /// The person-facing sentence for `code` (`ErrorCopy.message`); `message` stays the
    /// developer-facing detail.
    public var errorDescription: String? { ErrorCopy.message(code) }
    public var failureReason: String? { message }
}
