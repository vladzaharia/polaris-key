// @pkey-feature core.verify
// WIRE-CONTRACT-V4 §4.1 — the non-wire-integer pointer sets, over the seven JWS families of
// `conformance/corpus/v2/cases.json` (the feed and record families included). Every family's
// JWS goes through this SDK's own `JWSVerifier.verify` with the family's keys, `typ` and cap.
// Whenever it accepts, `nonWireIntegers` must equal the case's member as a set of Unicode-scalar
// arrays (an absent member is the empty set), and a case that carries the member must verify.
// So Swift's pointer set cannot drift from Node's, Python's and Godot's.

import Foundation
import PolarisKeyCore
import XCTest

private struct PointerCase: Decodable {
    let id: String
    let jws: String?
    let manifestJws: String?
    let bundleJws: String?
    let trust: TrustSet?
    let pinned: TrustSet?
    let releaseKeys: TrustSet?
    let typ: String?
    let maxPayloadBytes: Int?
    let nonWireIntegers: [String]?
}

private struct PointerCorpus: Decodable {
    let jwsCases: [PointerCase]
    let licenseDocCases: [PointerCase]
    let configDocCases: [PointerCase]
    let trustCases: [PointerCase]
    let bundleCases: [PointerCase]
    let feedCases: [PointerCase]
    let releaseRecordCases: [PointerCase]
}

final class PointerSetTests: XCTestCase {
    func testEveryCaseOfTheSevenFamilies() throws {
        let corpus = try CorpusBundleLoader.load(PointerCorpus.self, "cases")
        typealias View = (jws: String, keys: TrustSet, typ: JwsTyp, cap: Int?)
        let families: [(String, [PointerCase], (PointerCase) -> View)] = [
            ("jwsCases", corpus.jwsCases, { ($0.jws!, $0.trust!, JwsTyp(rawValue: $0.typ!)!, $0.maxPayloadBytes) }),
            ("licenseDocCases", corpus.licenseDocCases, { ($0.jws!, $0.trust!, .license, nil) }),
            ("configDocCases", corpus.configDocCases, { ($0.jws!, $0.trust!, .config, nil) }),
            ("trustCases", corpus.trustCases, { ($0.manifestJws!, $0.pinned!, .trust, nil) }),
            ("bundleCases", corpus.bundleCases, { ($0.bundleJws!, $0.pinned!, .bundle, MAX_BUNDLE_BYTES) }),
            ("feedCases", corpus.feedCases, { ($0.jws!, $0.trust!, .feed, nil) }),
            ("releaseRecordCases", corpus.releaseRecordCases, { ($0.jws!, $0.releaseKeys!, .release, nil) }),
        ]
        var checked = 0
        for (family, cases, view) in families {
            XCTAssertFalse(cases.isEmpty, "\(family) is empty")
            for c in cases {
                let v = view(c)
                let result = JWSVerifier.verify(
                    v.jws, trust: v.keys, typ: v.typ, requireTyp: true, maxPayloadBytes: v.cap)
                if c.nonWireIntegers != nil {
                    XCTAssertNotNil(result, "\(family)/\(c.id) carries nonWireIntegers, so it must verify")
                }
                guard let result else { continue }
                let expected = Set((c.nonWireIntegers ?? []).map { Array($0.unicodeScalars) })
                XCTAssertEqual(result.nonWireIntegers, expected, "\(family)/\(c.id)")
                checked += 1
            }
        }
        XCTAssertGreaterThan(checked, 200)
    }

    /// The pattern helper refuses a valid value followed by any line terminator (V4 §3).
    func testWholeMatchesRefusesEveryLineTerminator() {
        XCTAssertNotNil(wholeMatches("[a-z][a-z0-9-]{0,63}", "direct"))
        for t in ["\n", "\r\n", "\r", "\u{0085}", "\u{2028}", "\u{2029}"] {
            XCTAssertNil(wholeMatches("[a-z][a-z0-9-]{0,63}", "direct" + t), "terminator \(t.unicodeScalars.map(\.value))")
        }
        XCTAssertNil(Semver.parse("1.2.3\n"))
        XCTAssertNil(Semver.parse("١.٢.٣"))
        XCTAssertNotNil(Semver.parse("1.2.3-beta.1"))
    }

    /// `wireInteger` is the token rule, the bound and the minimum.
    func testWireInteger() {
        XCTAssertTrue(wireInteger(0, pointer: "/issuedAt", min: 0, in: []))
        XCTAssertTrue(wireInteger(MAX_WIRE_INTEGER, pointer: "/seq", min: 1, in: []))
        XCTAssertFalse(wireInteger(MAX_WIRE_INTEGER + 1, pointer: "/seq", min: 1, in: []))
        XCTAssertFalse(wireInteger(0, pointer: "/seq", min: 1, in: []))
        XCTAssertFalse(wireInteger(nil, pointer: "/seq", min: 1, in: []))
        XCTAssertFalse(wireInteger(7, pointer: "/seq", min: 1, in: [Array("/seq".unicodeScalars)]))
    }
}
