// @pkey-feature core.verify
// Base64URL round-trip + edge-case tests. The decoder must accept the URL-safe alphabet
// with or without padding and reject garbage, since it's the first thing the verifier runs
// on attacker-controlled JWS segments.

import Foundation
import XCTest

import PolarisKeyCore

final class Base64URLTests: XCTestCase {
    func testEncodeIsUnpaddedURLSafe() {
        // 0xFB 0xFF encodes to "+/" in standard base64 → "-_" url-safe, and the padding
        // ("=") is stripped.
        let data = Data([0xFB, 0xFF])
        let enc = Base64URL.encode(data)
        XCTAssertFalse(enc.contains("+"))
        XCTAssertFalse(enc.contains("/"))
        XCTAssertFalse(enc.contains("="))
        XCTAssertEqual(enc, "-_8")
    }

    func testRoundTripAllByteValues() {
        let data = Data((0...255).map { UInt8($0) })
        let enc = Base64URL.encode(data)
        XCTAssertEqual(Base64URL.decode(enc), data)
    }

    func testDecodeWithoutPadding() {
        // "AQI" decodes to [1, 2] (length not a multiple of 4 → needs re-padding).
        XCTAssertEqual(Base64URL.decode("AQI"), Data([0x01, 0x02]))
    }

    func testDecodeURLSafeAlphabet() {
        // "-_8" → [0xFB, 0xFF]
        XCTAssertEqual(Base64URL.decode("-_8"), Data([0xFB, 0xFF]))
    }

    func testStringEncodeMatchesUTF8() {
        let s = "{\"alg\":\"EdDSA\"}"
        XCTAssertEqual(Base64URL.encode(string: s), Base64URL.encode(Data(s.utf8)))
        // And it round-trips back to the original bytes.
        XCTAssertEqual(Base64URL.decode(Base64URL.encode(string: s)), Data(s.utf8))
    }

    func testDecodeRejectsInvalidCharacters() {
        // A space is not in the base64url alphabet → nil.
        XCTAssertNil(Base64URL.decode("not valid!!"))
    }

    func testEncodeEmptyIsEmpty() {
        XCTAssertEqual(Base64URL.encode(Data()), "")
        XCTAssertEqual(Base64URL.decode(""), Data())
    }

    func testRoundTripVariableLengthsExerciseAllPaddingCases() {
        // Lengths 1..6 cover the 0/1/2 trailing "=" re-padding branches.
        for len in 1...6 {
            let bytes = Data((0..<len).map { UInt8(($0 * 37 + 11) & 0xff) })
            let enc = Base64URL.encode(bytes)
            XCTAssertFalse(enc.contains("="), "len \(len) must be unpadded")
            XCTAssertEqual(Base64URL.decode(enc), bytes, "len \(len) must round-trip")
        }
    }

    func testDecodeMatchesEncodeForCorpusPubKey() {
        // The 32-byte prod test pubkey decodes to exactly 32 bytes and re-encodes stably.
        let pub = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"
        let decoded = Base64URL.decode(pub)
        XCTAssertEqual(decoded?.count, 32)
        XCTAssertEqual(Base64URL.encode(decoded!), pub)
    }

    func testStringEncodeHandlesUnicode() {
        // Emoji + CJK + diacritics must encode via UTF-8 and round-trip byte-for-byte.
        let s = "Ada 💻 北京 Ångström"
        let enc = Base64URL.encode(string: s)
        XCTAssertEqual(Base64URL.decode(enc), Data(s.utf8))
    }
}
