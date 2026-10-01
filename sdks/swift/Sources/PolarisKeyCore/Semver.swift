// Client-side semver + channel helpers — mirrors client-core's semver.ts (itself pinned by the
// conformance corpus so all SDKs agree). Used to derive the default channel from a build
// version and to compare versions against an allowed window. The channel vocabulary is
// WIRE-CONTRACT-V3 §5.1.

import Foundation

public struct ParsedSemver: Sendable, Equatable {
    public let major: Int
    public let minor: Int
    public let patch: Int
    public let prerelease: [String]
}

/// The channel family a build's version implies (WIRE-CONTRACT-V3 §5.1 rule 2), which the SDK
/// sends as its default `X-PKey-Channel`. Only the Worker narrows `pr` to `pr-<n>`.
public enum Channel: String, Sendable, Equatable {
    case stable
    case beta
    /// The legacy spelling of `beta`. `channelForVersion` never returns it; the Worker still
    /// accepts `staging` as a header and a grant.
    @available(*, deprecated, renamed: "beta", message: "staging is the legacy spelling of beta (WIRE-CONTRACT-V3 §5.1)")
    case staging
    case pr
    case dev
}

public enum Semver {
    /// Parse `MAJOR.MINOR.PATCH[-prerelease][+build]`. Returns nil if it doesn't match.
    public static func parse(_ v: String) -> ParsedSemver? {
        // Whole-string, ASCII classes (WIRE-CONTRACT-V4 §3): `1.2.3\n` and `١.٢.٣` do not parse.
        let pattern = #"([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?"#
        guard let groups = wholeMatches(pattern, v) else { return nil }
        guard
            let majS = groups[1], let maj = Int(majS),
            let minS = groups[2], let min = Int(minS),
            let patS = groups[3], let pat = Int(patS)
        else { return nil }
        let pre = groups[4].map { $0.split(separator: ".").map(String.init) } ?? []
        return ParsedSemver(major: maj, minor: min, patch: pat, prerelease: pre)
    }

    /// Compare two semvers: -1 (a<b), 0 (equal/unparseable), 1 (a>b). Prerelease versions
    /// sort BEFORE their release (per semver §11). Unparseable inputs compare equal (0),
    /// matching the Node implementation.
    public static func compare(_ a: String, _ b: String) -> Int {
        guard let pa = parse(a), let pb = parse(b) else { return 0 }
        for kp in [\ParsedSemver.major, \ParsedSemver.minor, \ParsedSemver.patch] {
            let x = pa[keyPath: kp]
            let y = pb[keyPath: kp]
            if x != y { return x < y ? -1 : 1 }
        }
        if pa.prerelease.isEmpty && !pb.prerelease.isEmpty { return 1 }
        if !pa.prerelease.isEmpty && pb.prerelease.isEmpty { return -1 }
        let n = Swift.max(pa.prerelease.count, pb.prerelease.count)
        for i in 0..<n {
            let x = i < pa.prerelease.count ? pa.prerelease[i] : nil
            let y = i < pb.prerelease.count ? pb.prerelease[i] : nil
            if x == nil { return -1 }
            if y == nil { return 1 }
            let xs = x!
            let ys = y!
            let xn = Int(xs)
            let yn = Int(ys)
            if let xi = xn, let yi = yn {
                if xi != yi { return xi < yi ? -1 : 1 }
            } else if xs != ys {
                return xs < ys ? -1 : 1
            }
        }
        return 0
    }

    /// Derive the channel family from a build version string: `.dev` for `0.0.0-dev*`, `.beta`
    /// for `0.0.0-beta*` and the legacy `0.0.0-staging*`, `.pr` for `0.0.0-pr-<n>` (hyphen
    /// optional), `.stable` for anything else. Only the `0.0.0-<word>` sentinels carry a channel.
    public static func channelForVersion(_ version: String) -> Channel {
        if version.hasPrefix("0.0.0-dev") { return .dev }
        if version.hasPrefix("0.0.0-beta") || version.hasPrefix("0.0.0-staging") { return .beta }
        // A prefix match on purpose (`0.0.0-pr-42.1` is still the `pr` family), ASCII digits.
        if version.range(of: #"^0\.0\.0-pr-?[0-9]+"#, options: .regularExpression) != nil { return .pr }
        return .stable
    }

    /// A `0.0.0-dev…` build: the `dev` pseudo-channel. It skips the version window and channel
    /// checks only when the licence is granted `dev` (R3-01); otherwise it is gated like any build.
    public static func isDevBuild(_ version: String) -> Bool {
        version.hasPrefix("0.0.0-dev")
    }
}
