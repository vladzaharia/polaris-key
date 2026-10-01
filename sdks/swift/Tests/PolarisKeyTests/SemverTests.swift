// Semver parse/compare/channel tests. The ordering rules (numeric vs alpha prerelease
// identifiers, prerelease-before-release, fewer-identifiers-lower) are pinned by the
// conformance corpus so every SDK agrees; these assert the Swift implementation matches
// the Node/Python semver helpers exactly.

import XCTest

import PolarisKeyCore

final class SemverTests: XCTestCase {
    func testParseCoreAndPrerelease() {
        let p = Semver.parse("1.2.3-rc.1+build5")
        XCTAssertEqual(p?.major, 1)
        XCTAssertEqual(p?.minor, 2)
        XCTAssertEqual(p?.patch, 3)
        XCTAssertEqual(p?.prerelease, ["rc", "1"])
    }

    func testParseRejectsGarbageAndPartials() {
        XCTAssertNil(Semver.parse("nope"))
        XCTAssertNil(Semver.parse("1.2"))
        XCTAssertNil(Semver.parse("1.2.3.4"))
        XCTAssertNil(Semver.parse("v1.2.3"))
        XCTAssertNil(Semver.parse(""))
    }

    func testCompareCore() {
        XCTAssertEqual(Semver.compare("1.0.0", "1.0.1"), -1)
        XCTAssertEqual(Semver.compare("1.1.0", "1.0.9"), 1)
        XCTAssertEqual(Semver.compare("2.0.0", "1.9.9"), 1)
        XCTAssertEqual(Semver.compare("1.2.3", "1.2.3"), 0)
    }

    func testPrereleaseSortsBeforeRelease() {
        XCTAssertEqual(Semver.compare("1.0.0-rc.1", "1.0.0"), -1)
        XCTAssertEqual(Semver.compare("1.0.0", "1.0.0-rc.1"), 1)
    }

    func testNumericPrereleaseIdentifiersCompareNumerically() {
        // "2" < "10" numerically (NOT lexically, where "10" < "2").
        XCTAssertEqual(Semver.compare("1.0.0-rc.2", "1.0.0-rc.10"), -1)
        XCTAssertEqual(Semver.compare("1.0.0-1", "1.0.0-2"), -1)
    }

    func testAlphaPrereleaseIdentifiersCompareLexically() {
        XCTAssertEqual(Semver.compare("1.0.0-alpha", "1.0.0-beta"), -1)
        XCTAssertEqual(Semver.compare("1.0.0-beta", "1.0.0-alpha"), 1)
    }

    func testFewerPrereleaseIdentifiersHaveLowerPrecedence() {
        // A shorter prerelease run is lower when the common prefix is equal.
        XCTAssertEqual(Semver.compare("1.0.0-rc", "1.0.0-rc.1"), -1)
        XCTAssertEqual(Semver.compare("1.0.0-rc.1", "1.0.0-rc"), 1)
    }

    func testFullPrereleaseOrderingChain() {
        // alpha < alpha.1 < alpha.beta < beta < 1.0.0 (each step strictly increasing).
        let chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0"]
        for i in 0..<(chain.count - 1) {
            XCTAssertEqual(
                Semver.compare(chain[i], chain[i + 1]), -1,
                "\(chain[i]) should be < \(chain[i + 1])")
            XCTAssertEqual(
                Semver.compare(chain[i + 1], chain[i]), 1,
                "\(chain[i + 1]) should be > \(chain[i])")
        }
    }

    func testUnparseableComparesEqual() {
        XCTAssertEqual(Semver.compare("not-a-version", "1.0.0"), 0)
        XCTAssertEqual(Semver.compare("1.0.0", "garbage"), 0)
        XCTAssertEqual(Semver.compare("x", "y"), 0)
    }

    func testChannelForVersion() {
        XCTAssertEqual(Semver.channelForVersion("1.2.3"), .stable)
        XCTAssertEqual(Semver.channelForVersion("0.0.0-dev+abc"), .dev)
        // P0-04: `staging` is the legacy spelling of `beta` (WIRE-CONTRACT-V3 §5.1 rule 2).
        XCTAssertEqual(Semver.channelForVersion("0.0.0-staging.1"), .beta)
        XCTAssertEqual(Semver.channelForVersion("0.0.0-beta.3"), .beta)
        XCTAssertEqual(Semver.channelForVersion("0.0.0-beta.3").rawValue, "beta")
        XCTAssertEqual(Semver.channelForVersion("2.0.0-beta.1"), .stable)
        XCTAssertEqual(Semver.channelForVersion("0.0.0-pr42"), .pr)
        XCTAssertEqual(Semver.channelForVersion("0.0.0-pr-42"), .pr)
        XCTAssertEqual(Semver.channelForVersion("0.0.0-pr1.2"), .pr)
        // A normal prerelease that is not the dev/beta/staging/pr sentinel is still stable.
        XCTAssertEqual(Semver.channelForVersion("1.0.0-rc.1"), .stable)
    }

    func testIsDevBuild() {
        XCTAssertTrue(Semver.isDevBuild("0.0.0-dev+abc"))
        XCTAssertTrue(Semver.isDevBuild("0.0.0-dev"))
        XCTAssertFalse(Semver.isDevBuild("1.0.0"))
        XCTAssertFalse(Semver.isDevBuild("0.0.0-staging"))
    }
}
