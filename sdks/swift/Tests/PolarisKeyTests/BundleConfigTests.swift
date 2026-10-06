// @pkey-feature core.discover
//
// `PolarisKeyClient.fromBundle()`'s parser (notes/SDK-PARITY-PASS.md §2.4): the generated
// `PolarisKey.plist` keys become client options, with the version from the bundle, and a bad key
// is refused by name.

import Foundation
import PolarisKey
import PolarisKeyCore
import XCTest

final class BundleConfigTests: XCTestCase {
    func testParsesTheGeneratedKeys() throws {
        let config = try PolarisKeyBundleConfig(plist: [
            "product": "djdl", "baseUrl": "https://key.example",
            "pinnedKeys": ["k1": "abc"], "pinnedReleaseKeys": ["r1": "def"],
            "expectedServices": ["license", "config", "update"], "channel": "beta",
            "refreshIntervalSeconds": NSNumber(value: 900),
        ])
        XCTAssertEqual(config.product, "djdl")
        XCTAssertEqual(config.pinnedKeys, ["k1": "abc"])
        XCTAssertEqual(config.pinnedReleaseKeys, ["r1": "def"])
        XCTAssertEqual(config.expectedServices, [.license, .config, .update])
        XCTAssertEqual(config.channel, "beta")
        XCTAssertEqual(config.refreshIntervalSeconds, 900)

        let options = PolarisKeyClient.options(from: config, version: "2.1.0")
        XCTAssertEqual(options.core.productSlug, "djdl")
        XCTAssertEqual(options.core.version, "2.1.0")
        XCTAssertEqual(options.core.channel, "beta")
        XCTAssertEqual(options.pinnedReleaseKeys, ["r1": "def"])
    }

    func testDefaultsAndAliases() throws {
        let config = try PolarisKeyBundleConfig(plist: [
            "productSlug": "djdl", "pinnedKeys": ["k1": "abc"],
        ])
        XCTAssertEqual(config.baseUrl, "https://key.plrs.im")
        XCTAssertNil(config.expectedServices)
        XCTAssertEqual(config.pinnedReleaseKeys, [:])
    }

    func testRefusesBadKeysByName() {
        func code(_ plist: [String: Any]) -> String? {
            do {
                _ = try PolarisKeyBundleConfig(plist: plist)
                return nil
            } catch let e as PolarisError {
                XCTAssertTrue(e.message.contains("PolarisKey.plist"))
                return e.code
            } catch { return "other" }
        }
        XCTAssertEqual(code(["pinnedKeys": ["k": "v"]]), ErrorCode.invalidOptions)
        XCTAssertEqual(code(["product": "djdl"]), ErrorCode.invalidOptions)
        XCTAssertEqual(
            code(["product": "djdl", "pinnedKeys": ["k": "v"], "expectedServices": ["nope"]]),
            ErrorCode.invalidOptions)
    }

    func testAMissingPlistIsNotConfigured() async {
        do {
            _ = try await PolarisKeyClient.fromBundle(Foundation.Bundle(for: BundleConfigTests.self))
            XCTFail("expected not-configured")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.notConfigured)
        } catch {
            XCTFail("\(error)")
        }
    }
}
