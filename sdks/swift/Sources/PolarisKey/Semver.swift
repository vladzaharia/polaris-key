// Client-side semver + channel helpers — mirrors sdk-node's semver.ts (itself pinned by the
// conformance corpus so all SDKs agree). Used to derive the default channel from a build
// version and to compare versions against an allowed window.

import Foundation

public struct ParsedSemver: Sendable, Equatable {
    public let major: Int
    public let minor: Int
    public let patch: Int
    public let prerelease: [String]
}

public enum Channel: String, Sendable, Equatable {
    case stable
    case staging
    case pr
    case dev
}

public enum Semver {
    /// Parse `MAJOR.MINOR.PATCH[-prerelease][+build]`. Returns nil if it doesn't match.
    public static func parse(_ v: String) -> ParsedSemver? {
        // ^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$
        let pattern = #"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(v.startIndex..<v.endIndex, in: v)
        guard let m = re.firstMatch(in: v, range: range) else { return nil }

        func group(_ i: Int) -> String? {
            let r = m.range(at: i)
            guard r.location != NSNotFound, let rr = Range(r, in: v) else { return nil }
            return String(v[rr])
        }
        guard
            let majS = group(1), let maj = Int(majS),
            let minS = group(2), let min = Int(minS),
            let patS = group(3), let pat = Int(patS)
        else { return nil }
        let pre = group(4).map { $0.split(separator: ".").map(String.init) } ?? []
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

    /// Derive the release channel from a build version string.
    public static func channelForVersion(_ version: String) -> Channel {
        if version.hasPrefix("0.0.0-dev") { return .dev }
        if version.hasPrefix("0.0.0-staging") { return .staging }
        if version.range(of: #"^0\.0\.0-pr-?\d+"#, options: .regularExpression) != nil { return .pr }
        return .stable
    }

    /// A `0.0.0-dev…` build is the unrestricted local-dev channel.
    public static func isDevBuild(_ version: String) -> Bool {
        version.hasPrefix("0.0.0-dev")
    }
}
