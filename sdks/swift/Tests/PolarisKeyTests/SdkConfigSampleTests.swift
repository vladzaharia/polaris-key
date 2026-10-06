// `pkey sdk --lang swift --write` (SDK parity pass §3.19, SP-02). SdkConfigSample.swift is the
// file the CLI writes, committed and pinned to the renderer by packages/cli/test/sdkConfig.test.ts.
// Compiling this target is half the proof; the test checks the options it builds.

import XCTest

import PolarisKey

final class SdkConfigSampleTests: XCTestCase {
    func testGeneratedConfigBuildsClientOptions() {
        let options = PolarisConfig.clientOptions(version: "1.2.3")
        XCTAssertEqual(options.core.productSlug, "acme")
        XCTAssertEqual(options.core.baseUrl, "https://key.plrs.im")
        XCTAssertEqual(options.core.version, "1.2.3")
        XCTAssertEqual(options.core.pinnedKeys, ["pkey-test-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"])
        XCTAssertEqual(options.core.expectedServices, [.license, .config, .release, .update])
        XCTAssertEqual(PolarisConfig.pinnedReleaseKeys, ["acme-release-2026": "Z6FCkd1K7Om4lxUk4og_J0m73saH4BrrLk8igXzwcJM"])
    }
}
