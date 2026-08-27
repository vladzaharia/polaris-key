// The Sparkle wiring — the ONLY file in this package that imports Sparkle (D-24).
//
// Everything here is `#if os(macOS)`-guarded, and the package manifest conditions the Sparkle
// product on `.when(platforms: [.macOS])`. Both halves are needed: a conditioned product with an
// unguarded `import Sparkle` fails to compile on iOS, and a guarded import with an unconditioned
// product still drags a macOS XCFramework onto an iOS link line.
//
// ── WHAT THIS DOES, AND THE ONE THING IT REFUSES TO DO ──────────────────────────────────────
//
// It carries three facts from Polaris to Sparkle, all of them derived in `UpdateFeed.swift`:
//
//   feedURLString      the appcast URL from DISCOVERY, `?arch=` applied — never string-built,
//                      because §R1 moved these paths and left aliases behind.
//   httpHeaders        the device bearer token, so an `entitled` product's feed (D-13) is
//                      reachable at all. Sparkle makes its own HTTP requests; without this they
//                      are anonymous and answer 401.
//   allowedChannels    from the licence's `channels` entitlement — a UX narrowing so a
//                      stable-only customer is not offered a beta the server will then refuse.
//
// It does NOT verify updates. `SUPublicEDKey` in the host app's code-signed Info.plist is the
// terminal anchor, this asserts it is present, and that is the whole of Polaris's involvement
// in update integrity. See `SparkleAnchor.swift` for why.

import Foundation
import PolarisCore

#if os(macOS)
import Sparkle

/// Bridges a `PolarisCore`-derived `UpdateFeed` into Sparkle's delegate protocol.
///
/// Deliberately holds only `let`s: `SPUUpdaterDelegate` methods are called by Sparkle on its own
/// schedule, and immutable state is what makes that safe without a lock or an actor hop in the
/// middle of an update check. To change feed or entitlements, build a new one — which is what a
/// licence change means anyway.
public final class PolarisSparkleUpdaterDelegate: NSObject, SPUUpdaterDelegate {
    private let feedURL: String?
    private let allowed: Set<String>

    /// - Parameter feed: the derived feed, or nil to leave Sparkle on the `SUFeedURL` in the
    ///   host's Info.plist. Nil is a legitimate configuration — a `public`-access product that
    ///   shipped its feed URL statically needs nothing from Polaris but the channel filter.
    public init(feed: UpdateFeed?) {
        self.feedURL = feed?.url.absoluteString
        self.allowed = feed?.allowedChannels ?? ["stable"]
        super.init()
    }

    public func feedURLString(for updater: SPUUpdater) -> String? { feedURL }

    public func allowedChannels(for updater: SPUUpdater) -> Set<String> { allowed }
}

/// The one-call Sparkle integration: assert the anchor, point the updater at the product's feed,
/// and attach the credential its requests need.
public enum PolarisSparkleUpdater {
    /// Configure an existing `SPUUpdater`.
    ///
    /// Throws `SparkleAnchorError` when the host bundle carries no `SUPublicEDKey`. Throwing —
    /// rather than logging, or quietly continuing — is the point: an app that ships Sparkle
    /// without the key installs unsigned payloads and shows no symptom until it matters.
    ///
    /// Returns the delegate, which the caller must RETAIN: `SPUUpdater.delegate` is weak, and a
    /// delegate that deallocates takes the feed URL and the channel filter with it.
    ///
    /// `@MainActor` because `SPUUpdater` is: Sparkle drives its whole lifecycle on the main
    /// thread, so configuring it from anywhere else is a data race the compiler can and does
    /// catch.
    @MainActor
    @discardableResult
    public static func configure(
        _ updater: SPUUpdater,
        feed: UpdateFeed?,
        headers: [String: String] = [:],
        bundle: Foundation.Bundle = .main
    ) throws -> PolarisSparkleUpdaterDelegate {
        try SparkleAnchor.assertPresent(in: bundle)
        // `httpHeaders` is how an `entitled` feed becomes reachable at all: Sparkle fetches the
        // appcast (and the enclosure) itself, so the bearer token has to travel on ITS requests,
        // not on ours. An empty dictionary is left as nil so a `public` product's requests stay
        // byte-identical to a Sparkle integration that never met Polaris.
        updater.httpHeaders = headers.isEmpty ? nil : headers
        return PolarisSparkleUpdaterDelegate(feed: feed)
    }
}
#endif
