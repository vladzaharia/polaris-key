// Feed derivation — the pure half of PolarisKeyUpdate.
//
// Everything in this file is a value → value function over a discovery document, a licence's
// entitlements, and this machine's architecture. That is deliberate: it is the part CI can test
// exhaustively without instantiating Sparkle, launching an updater, or touching a network, and
// it is the part where a mistake is silent (a host that quietly checks the wrong feed simply
// never sees an update).
//
// Deliberately NOT `#if os(macOS)`-guarded, even though the target is macOS-only in practice:
// nothing here imports Sparkle, so it compiles anywhere and the derivations stay testable on
// any host the test suite happens to run on.

import Foundation
import PolarisKeyCore

/// Architectures the appcast can target (`?arch=` on `/update/appcast.xml`).
///
/// The unparameterized feed serves `arm64` for continuity with already-shipped `SUFeedURL`s —
/// which is exactly why this SDK always sends the parameter explicitly rather than relying on
/// the default: an Intel Mac that omits it silently checks the wrong feed.
public enum UpdateArch: String, Sendable, Equatable, CaseIterable {
    case arm64
    case x86_64

    /// This machine's architecture, or nil on a platform with no appcast to fetch.
    public static var current: UpdateArch? {
        UpdateArch(rawValue: ArchFamily.current)
    }

    /// Normalize the spellings a host might supply. The Worker accepts `aarch64`/`amd64` as
    /// aliases and silently falls back to `arm64` on anything else; refusing here instead means
    /// a typo surfaces as nil rather than as an unnoticed wrong-feed check.
    public static func normalize(_ raw: String) -> UpdateArch? {
        switch raw.lowercased() {
        case "arm64", "aarch64": return .arm64
        case "x86_64", "amd64", "x64": return .x86_64
        default: return nil
        }
    }
}

/// Everything a Sparkle host needs to point its updater at the right feed, derived from the
/// product's own discovery document plus its licence.
public struct UpdateFeed: Sendable, Equatable {
    /// The absolute appcast URL, `?arch=` already applied.
    public let url: URL
    /// The channel this feed serves.
    public let channel: String
    public let arch: UpdateArch?
    /// The channels the licence entitles, for `SPUUpdaterDelegate.allowedChannels`. Empty means
    /// "stable only" — see `allowedChannels(from:)`.
    public let allowedChannels: Set<String>

    public init(url: URL, channel: String, arch: UpdateArch?, allowedChannels: Set<String>) {
        self.url = url
        self.channel = channel
        self.arch = arch
        self.allowedChannels = allowedChannels
    }
}

public enum UpdateFeedBuilder {
    /// Build the feed for a channel, from the DISCOVERY document rather than by string-building.
    ///
    /// §R1 moved these paths and left permanent aliases; a host that hard-codes one is a host
    /// that breaks the next time they move, whereas the discovery document is the product's own
    /// statement of where its feed lives. Returns nil when Update is disabled or publishes no
    /// feed — the fail-closed posture (D-21) expressed as a value, because asking "where is my
    /// feed?" before discovery has run is a sequencing question, not an error.
    public static func feed(
        from document: ProductDiscoveryDocument,
        channel: String = "stable",
        arch: UpdateArch? = UpdateArch.current,
        entitlements: [String: JSONValue] = [:]
    ) -> UpdateFeed? {
        guard
            let url = appcastUrl(from: document, channel: channel, arch: arch?.rawValue)
        else { return nil }
        return UpdateFeed(
            url: url, channel: channel, arch: arch,
            allowedChannels: allowedChannels(from: entitlements))
    }

    /// Derive `allowedChannels` from the licence's `channels` entitlement (D-13).
    ///
    /// Sparkle asks a delegate which channels an installation may see, and the honest answer is
    /// whatever the signed licence granted — not whatever the host hard-coded, which is how a
    /// stable-only customer ends up being offered a beta build the server would then refuse to
    /// serve (the R3 gap). `stable` is always included: it is the unnamed default channel, and
    /// a licence that grants nothing still gets the release build.
    ///
    /// Note this is a UX narrowing, not an enforcement point. The server enforces the same
    /// window in `entitled` mode; if these two ever disagree, the server wins and the user sees
    /// a 403 instead of a download. Making the client the enforcement point would be the mistake
    /// §5.5 of the anti-piracy review warns about.
    ///
    /// `staging` is the legacy spelling of `beta` (WIRE-CONTRACT-V3 §5.1): a `staging` grant also
    /// allows `beta`, and a `beta` grant also allows `staging`, as the server's `entitled` feed
    /// check treats them.
    public static func allowedChannels(from entitlements: [String: JSONValue]) -> Set<String> {
        var out: Set<String> = ["stable"]
        if let granted = entitlements["channels"]?.arrayValue {
            for value in granted {
                if let name = value.stringValue, !name.isEmpty { out.insert(name) }
            }
        }
        if out.contains("staging") || out.contains("beta") {
            out.insert("beta")
            out.insert("staging")
        }
        return out
    }

    /// The HTTP headers an `entitled`-mode feed request must carry (D-13).
    ///
    /// In `entitled` mode the appcast itself is behind the device credential, so Sparkle's own
    /// requests need the bearer token — that is what `SPUUpdater.httpHeaders` is for. A `public`
    /// product returns an empty dictionary and Sparkle fetches anonymously, exactly as it does
    /// today; the client metadata headers ride along either way so the Worker's device-row
    /// bookkeeping sees update traffic too.
    public static func feedHeaders(
        token: String?, version: String, channel: String, deviceId: String
    ) -> [String: String] {
        var headers: [String: String] = [
            HEADER_DEVICE: deviceId,
            HEADER_VERSION: version,
            HEADER_CHANNEL: channel,
            HEADER_SDK_NAME: POLARIS_SDK_NAME,
            HEADER_SDK_VERSION: POLARIS_SDK_VERSION,
        ]
        // WIRE-CONTRACT-V3 §5.2: canonical values, omitted when this binary's has none.
        if let platform = PlatformFamily.headerValue { headers[HEADER_PLATFORM] = platform }
        if let arch = ArchFamily.headerValue { headers[HEADER_ARCH] = arch }
        if let token, !token.isEmpty { headers["Authorization"] = "Bearer \(token)" }
        return headers
    }
}
