// @pkey-feature core.discover
// `JSONValue` number handling.
//
// Swift's `Int(_: Double)` TRAPS on an out-of-range conversion: an uncatchable `fatalError`, not
// an error a fail-closed caller could return nil on. `intValue` must therefore never use it, since
// a JSON number the decoder accepts happily — `1e30` is well-formed JSON — would otherwise kill the
// host process the moment anything read it as an Int. `Discovery.parse` reads `protocolVersion`
// that way on every document it is handed, which makes it remote: whoever answers
// `/<product>/.well-known/polaris.json` picks the number.
//
// Every test below is written so that reverting `Int(exactly:)` to `Int(_:)` CRASHES THE TEST
// RUNNER rather than merely failing an assertion. That is the honest shape for a trap: there is
// no XCTest expectation that can catch one, so the whole suite going down IS the failure signal.

import Foundation
import PolarisKeyCore
import XCTest

final class JSONValueTests: XCTestCase {
    // ── The crash vectors ──────────────────────────────────────────────────────────
    /// Numbers outside `Int`'s range must read as "not an integer", not as a process kill.
    ///
    /// The infinities are in here deliberately: `d == d.rounded()` is TRUE for them, so an
    /// integrality guard on its own waves them through; only the range-checked conversion refuses
    /// them. A "fix" that kept the trapping conversion behind a tightened guard would still die
    /// here.
    func testOutOfRangeNumbersYieldNilRatherThanTrapping() {
        let hostile: [(String, Double)] = [
            ("1e400 (overflows to +inf)", .infinity),
            ("-1e400 (overflows to -inf)", -.infinity),
            ("NaN", .nan),
            ("1e30", 1e30),
            ("-1e30", -1e30),
            ("9.3e18 (just past Int64 max)", 9.3e18),
            ("-9.3e18 (just past Int64 min)", -9.3e18),
            ("Double.greatestFiniteMagnitude", .greatestFiniteMagnitude),
        ]
        for (label, value) in hostile {
            XCTAssertNil(
                JSONValue.double(value).intValue,
                "\(label) must read as nil, and must not trap on the way there")
        }
    }

    /// A non-integral number is not an integer: `3.7` must not silently read as `3`.
    func testNonIntegralNumbersAreNotIntegers() {
        for value in [3.7, -3.7, 0.5, -0.5, 2.000_000_1] {
            XCTAssertNil(JSONValue.double(value).intValue, "\(value) is not an integer")
        }
    }

    /// The happy path, unchanged. `Int(exactly:)` is a narrowing refusal, not a narrowing of what
    /// legitimately converts: every value a real config entry carries still reads.
    func testLegitimateIntegersStillConvert() {
        XCTAssertEqual(JSONValue.int(0).intValue, 0)
        XCTAssertEqual(JSONValue.int(-1).intValue, -1)
        XCTAssertEqual(JSONValue.int(2_147_483_647).intValue, 2_147_483_647)
        XCTAssertEqual(JSONValue.int(Int.max).intValue, Int.max)
        XCTAssertEqual(JSONValue.int(Int.min).intValue, Int.min)

        XCTAssertEqual(JSONValue.double(0).intValue, 0)
        XCTAssertEqual(JSONValue.double(-0.0).intValue, 0)
        XCTAssertEqual(JSONValue.double(-1).intValue, -1)
        XCTAssertEqual(JSONValue.double(2_147_483_647).intValue, 2_147_483_647)
        XCTAssertEqual(JSONValue.double(-2_147_483_648).intValue, -2_147_483_648)
        // The boundaries, which is where an off-by-one in a range check would show. `-2^63` is
        // exactly representable as a `Double` and is a valid `Int`; `+2^63` is representable and
        // is NOT, being one past `Int.max` — the pair that a naive `d <= Double(Int.max)` bound
        // gets wrong, since that comparison rounds `Int.max` UP to `2^63`.
        XCTAssertEqual(JSONValue.double(-9_223_372_036_854_775_808).intValue, Int.min)
        XCTAssertNil(JSONValue.double(9_223_372_036_854_775_808).intValue)
        // The largest `Double` that IS a valid `Int`: `Int.max` rounded down to 53 bits.
        XCTAssertEqual(
            JSONValue.double(9_223_372_036_854_774_784).intValue, 9_223_372_036_854_774_784)

        // Non-numbers are still non-numbers.
        XCTAssertNil(JSONValue.string("7").intValue)
        XCTAssertNil(JSONValue.bool(true).intValue)
        XCTAssertNil(JSONValue.null.intValue)
    }

    // ── The decoder path ───────────────────────────────────────────────────────────
    /// The reachability half: these are numbers `JSONDecoder` actually produces from wire bytes,
    /// so the trap was not hypothetical. `1e30` and friends decode cleanly to `.double` — the
    /// `Int` branch of `init(from:)` declines them — and then `intValue` has to survive them.
    func testOutOfRangeNumbersDecodedFromWireBytesDoNotTrap() throws {
        for literal in ["1e30", "-1e30", "9.3e18", "1.7976931348623157e308", "3.7"] {
            let value = try JSONDecoder().decode(
                JSONValue.self, from: Data(#"{"n":\#(literal)}"#.utf8))
            let n = try XCTUnwrap(value.objectValue?["n"])
            XCTAssertNil(n.intValue, "decoded \(literal) must read as nil, not trap")
            XCTAssertNotNil(n.doubleValue, "\(literal) is still a perfectly good Double")
        }
        // A literal past `Double`'s range is refused at DECODE, before `intValue` is reachable —
        // asserted so the layering is on the record rather than assumed.
        XCTAssertThrowsError(
            try JSONDecoder().decode(JSONValue.self, from: Data(#"{"n":1e400}"#.utf8)),
            "a number no Double can hold is not a JSONValue")
    }

    /// Integers still round-trip as `.int`, never as `.double` — the property the corpus's
    /// structural equality depends on, and the one a change to this accessor could quietly break.
    func testIntegersStillDecodeAsIntAndRoundTrip() throws {
        let decoded = try JSONDecoder().decode(
            JSONValue.self, from: Data(#"{"a":4,"b":4.5,"c":-7}"#.utf8))
        XCTAssertEqual(decoded.objectValue?["a"], .int(4))
        XCTAssertEqual(decoded.objectValue?["b"], .double(4.5))
        XCTAssertEqual(decoded.objectValue?["c"], .int(-7))
        let reencoded = try JSONDecoder().decode(
            JSONValue.self, from: try JSONEncoder().encode(decoded))
        XCTAssertEqual(reencoded, decoded)
    }

    // ── The reachable path ─────────────────────────────────────────────────────────
    /// `Discovery.parse`, line for line: a hostile control plane publishing a huge
    /// `protocolVersion` must produce a document with `protocolVersion == nil`, not a dead host.
    ///
    /// The rest of the document still parses. That is the right degradation — an unreadable
    /// version field is not grounds to discard the services map, and discarding it would hand the
    /// same attacker a way to turn every client's capabilities off.
    func testDiscoveryDegradesOnAnOutOfRangeProtocolVersion() {
        for literal in ["1e30", "-1e30", "9.3e18", "3.7"] {
            let json = #"""
                {"product":"djdl","protocolVersion":\#(literal),
                 "services":{"license":{"enabled":true}}}
                """#
            guard case .ok(let doc) = Discovery.parse(Data(json.utf8), expectedProduct: "djdl")
            else { return XCTFail("protocolVersion \(literal) must degrade, not reject") }
            XCTAssertNil(doc.protocolVersion, "an unreadable protocolVersion reads as absent")
            XCTAssertEqual(doc.servicesMap[.license], true, "the rest of the document still parses")
            XCTAssertEqual(doc.servicesMap[.update], false, "and absent slugs still fail closed")
        }
        // A version literal no `Double` can hold fails the document's own decode, so the parser
        // returns `.invalid` — fail-closed, and still not a trap.
        let unparseable = #"{"product":"djdl","protocolVersion":1e400,"services":{}}"#
        guard case .invalid = Discovery.parse(Data(unparseable.utf8), expectedProduct: "djdl")
        else { return XCTFail("a document that does not decode must be rejected") }
        // The ordinary case is untouched.
        let good = #"{"product":"djdl","protocolVersion":3,"services":{}}"#
        guard case .ok(let doc) = Discovery.parse(Data(good.utf8), expectedProduct: "djdl") else {
            return XCTFail("should parse")
        }
        XCTAssertEqual(doc.protocolVersion, 3)
    }
}
