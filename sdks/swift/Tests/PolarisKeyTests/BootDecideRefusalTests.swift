// @pkey-feature update.bootguard
//
// B-141: a boot whose update configuration is refused (unusable pinned release keys) still
// decides `none`, and now says why: `BootRun.decideRefusal` carries the error's code.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyUpdate
import XCTest

final class BootDecideRefusalTests: XCTestCase {
    private func client(pins: TrustSet, product: TrustSet = [:]) async throws -> PolarisKeyClient {
        try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: product, trustRefresh: false,
                store: InMemoryStore(deviceId: "dev"), transport: StubServer().transport,
                expectedServices: [.config, .update], fingerprint: false, pinnedReleaseKeys: pins))
    }

    func testARefusedUpdateConfigurationIsNamedByTheBoot() async throws {
        // A release key is never a product key: the same key in both sets is refused.
        let key = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"
        let c = try await client(pins: ["rel": key], product: ["prod": key])
        _ = c.update  // builds the update client and installs its boot hooks
        let run = await c.boot(confirmAfterReady: false)
        XCTAssertEqual(run.decideRefusal, ErrorCode.invalidOptions)
        XCTAssertEqual(run.outcome, .ready, "the decision stays none")
    }

    func testABootWithoutPinsReportsNoRefusal() async throws {
        let c = try await client(pins: [:])
        let run = await c.boot(confirmAfterReady: false)
        XCTAssertNil(run.decideRefusal)
    }
}
