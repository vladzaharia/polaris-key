// @pkey-feature crash.tags
//
// `crashTags()` (notes/SDK-PARITY-PASS.md §3.14) over the vectors of packages/worker/test/
// sentry.test.ts: a release is `<deliverable>@<version>[+<build>]` (parseSentryRelease reads
// `app@1.4.0+12` and `levels.a@2.0.0` back), the channel is `environment`, the outlet
// `pkey.outlet`, left out while unknown (the hook matches it exactly).

import Foundation
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

final class CrashTagsTests: XCTestCase {
    func testTheSentryVectors() {
        let a = crashTagsFor(version: "1.4.0", channel: "stable", outlet: "itch", build: "12")
        XCTAssertEqual(a.release, "app@1.4.0+12")
        XCTAssertEqual(
            a.dictionary,
            ["release": "app@1.4.0+12", "environment": "stable", "pkey.outlet": "itch"])
        let b = crashTagsFor(
            version: "2.0.0", channel: "beta", outlet: "steam", deliverable: "levels.a")
        XCTAssertEqual(
            b.dictionary,
            ["release": "levels.a@2.0.0", "environment": "beta", "pkey.outlet": "steam"])
        // An empty build writes no `+`.
        XCTAssertEqual(crashTagsFor(version: "1.0.0", channel: "stable", build: "").release, "app@1.0.0")
        // An unknown outlet is left out, never sent as `unknown`.
        XCTAssertNil(crashTagsFor(version: "1.0.0", channel: "stable", outlet: OUTLET_UNKNOWN).outlet)
        XCTAssertEqual(
            crashTagsFor(version: "1.0.0", channel: "stable", outlet: "").dictionary,
            ["release": "app@1.0.0", "environment": "stable"])
    }

    func testTheClientFillsVersionChannelAndOutlet() throws {
        let client = try PolarisKeyClient(
            options: PolarisKeyClientOptions(
                core: CoreOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.2.3",
                    pinnedKeys: [:], store: InMemoryStore(deviceId: "d"),
                    transport: StubServer().transport)))
        XCTAssertEqual(
            client.crashTags(build: "77").dictionary,
            ["release": "app@1.2.3+77", "environment": "stable"])
        client.core.journal.outlet.set("direct")
        XCTAssertEqual(
            client.crashTags().dictionary,
            ["release": "app@1.2.3", "environment": "stable", "pkey.outlet": "direct"])
        let beta = try PolarisKeyClient(
            options: PolarisKeyClientOptions(
                core: CoreOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "2.0.0",
                    channel: "beta", pinnedKeys: [:], store: InMemoryStore(deviceId: "d"),
                    transport: StubServer().transport)))
        XCTAssertEqual(beta.crashTags(deliverable: "levels.a").release, "levels.a@2.0.0")
        XCTAssertEqual(beta.crashTags().environment, "beta")
    }
}
