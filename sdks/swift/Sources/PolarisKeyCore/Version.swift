// Version ordering under a product's scheme — plans/P3-01.md §2.8 "Versions" (WIRE-CONTRACT-V4
// §11). P2-05's rules made exact: every comparison is on ASCII digit strings, so no SDK loses
// precision past 2^53, and every grammar goes through `wholeMatches` with ASCII classes (a
// trailing line terminator does not parse). `update-matrix.json#/versionCases` pins it in every
// SDK; client-core's `version.ts` is the reference, ported here independently.
//
// The version schemes are not an `enums.json` enum (`semver+build` and `4part` are not valid
// identifiers), so they are this hand-written list, which `UpdateMatrixTests` asserts against
// `update-matrix.json#/vocabulary/schemes`.

import Foundation

/// The version schemes a feed may name (`FEED_VERSION_SCHEMES`), in this order.
public let FEED_VERSION_SCHEMES: [String] = ["semver", "semver+build", "4part"]

/// SemVer 2.0's own grammar with ASCII classes: no empty identifier, no leading zero in a
/// numeric prerelease identifier.
private let SEMVER_PATTERN =
    #"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"#

/// P2-04's `FOUR_PART_RE`.
private let FOUR_PART_PATTERN = #"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"#

/// A version parsed under its scheme.
public enum ParsedVersion: Sendable, Equatable {
    /// `semver` and `semver+build`: the three core parts as digit strings, the prerelease
    /// identifiers (nil when there is none), and the build metadata (nil when there is none).
    case semver(core: [String], prerelease: [String]?, build: String?)
    /// `4part`: the four parts as digit strings.
    case fourPart(core: [String])
}

/// Parse `version` under `scheme`, or nil when it does not parse (or the scheme is unknown).
public func parseVersion(_ scheme: String, _ version: String) -> ParsedVersion? {
    switch scheme {
    case "semver", "semver+build":
        guard let g = wholeMatches(SEMVER_PATTERN, version),
            let major = g[1], let minor = g[2], let patch = g[3]
        else { return nil }
        let pre = g[4].map { $0.split(separator: ".", omittingEmptySubsequences: false).map(String.init) }
        return .semver(core: [major, minor, patch], prerelease: pre, build: g[5])
    case "4part":
        guard let g = wholeMatches(FOUR_PART_PATTERN, version),
            let a = g[1], let b = g[2], let c = g[3], let d = g[4]
        else { return nil }
        return .fourPart(core: [a, b, c, d])
    default:
        return nil
    }
}

private func isDigits(_ s: String) -> Bool {
    !s.isEmpty && s.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
}

/// Byte-order comparison of two ASCII strings (Swift's `<` on `String` is a Unicode ordering).
private func compareBytes(_ a: String, _ b: String) -> Int {
    let x = Array(a.utf8)
    let y = Array(b.utf8)
    if x == y { return 0 }
    return x.lexicographicallyPrecedes(y) ? -1 : 1
}

/// Compare two unbounded non-negative integers given as ASCII digit strings: leading zeros
/// removed, then by length, then by ASCII order.
private func compareDigits(_ a: String, _ b: String) -> Int {
    func strip(_ s: String) -> String {
        let t = s.drop { $0 == "0" }
        return t.isEmpty ? "0" : String(t)
    }
    let x = strip(a)
    let y = strip(b)
    if x.utf8.count != y.utf8.count { return x.utf8.count < y.utf8.count ? -1 : 1 }
    return compareBytes(x, y)
}

/// SemVer 2.0 §11 precedence; build metadata is ignored.
private func comparePrecedence(
    _ a: [String], _ pa: [String]?, _ b: [String], _ pb: [String]?
) -> Int {
    for k in 0..<3 {
        let c = compareDigits(a[k], b[k])
        if c != 0 { return c }
    }
    switch (pa, pb) {
    case (nil, nil): return 0
    case (nil, _): return 1
    case (_, nil): return -1
    case (let x?, let y?):
        for k in 0..<Swift.min(x.count, y.count) {
            let xn = isDigits(x[k])
            let yn = isDigits(y[k])
            let c: Int
            if xn && yn {
                c = compareDigits(x[k], y[k])
            } else if xn {
                c = -1
            } else if yn {
                c = 1
            } else {
                c = compareBytes(x[k], y[k])
            }
            if c != 0 { return c }
        }
        // A shorter list that is a prefix of a longer one is lower.
        return x.count == y.count ? 0 : (x.count < y.count ? -1 : 1)
    }
}

/// `cmp(a, b)` under `scheme`: -1, 0 or 1, or nil when either side does not parse.
/// `semver+build` breaks a precedence tie with build metadata that is ASCII digits only,
/// compared as an unbounded integer; a version without such metadata is lower than one with it.
public func compareVersions(_ scheme: String, _ a: String, _ b: String) -> Int? {
    guard let pa = parseVersion(scheme, a), let pb = parseVersion(scheme, b) else { return nil }
    switch (pa, pb) {
    case (.fourPart(let x), .fourPart(let y)):
        for k in 0..<4 {
            let c = compareDigits(x[k], y[k])
            if c != 0 { return c }
        }
        return 0
    case (.semver(let x, let px, let bx), .semver(let y, let py, let by)):
        let c = comparePrecedence(x, px, y, py)
        if c != 0 || scheme != "semver+build" { return c }
        let na = bx.flatMap { isDigits($0) ? $0 : nil }
        let nb = by.flatMap { isDigits($0) ? $0 : nil }
        switch (na, nb) {
        case (nil, nil): return 0
        case (nil, _): return -1
        case (_, nil): return 1
        case (let p?, let q?): return compareDigits(p, q)
        }
    default:
        return nil
    }
}
