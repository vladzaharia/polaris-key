// The Swift conformance runner for the fingerprint + device-id formulas. Mirrors
// conformance/runners/node/fingerprint.test.ts and sdks/python/tests/
// test_fingerprint_conformance.py against the SAME corpus, bundled here as a test resource
// (the Swift test target can't reach up the monorepo at test time — tools/sign-corpus.ts
// mirrors the file and `--check` guards the copy).

import XCTest

@testable import PolarisKey

private struct FingerprintVector: Decodable {
    let id: String
    let description: String
    let product: String
    let raw: [String: String]
    let components: [String: String]
    let hwid: String
}

private struct DeviceIdVector: Decodable {
    let id: String
    let product: String
    let raw: String
    let expected: String
}

private struct FingerprintCorpus: Decodable {
    let fingerprintVersion: Int
    let componentOrder: [String]
    let deviceIds: [DeviceIdVector]
    let vectors: [FingerprintVector]
}

final class FingerprintConformanceTests: XCTestCase {
    private func loadCorpus() throws -> FingerprintCorpus {
        guard let url = Bundle.module.url(forResource: "fingerprint", withExtension: "json") else {
            XCTFail("fingerprint.json missing from the test bundle")
            throw NSError(domain: "corpus", code: 1)
        }
        return try JSONDecoder().decode(FingerprintCorpus.self, from: Data(contentsOf: url))
    }

    func testCorpusHasVectors() throws {
        let corpus = try loadCorpus()
        XCTAssertFalse(corpus.vectors.isEmpty)
        XCTAssertFalse(corpus.deviceIds.isEmpty)
    }

    func testComponentOrderMatchesTheCorpus() throws {
        // The hwid digest walks this order; a divergence silently changes every hwid.
        let corpus = try loadCorpus()
        XCTAssertEqual(Fingerprint.componentOrder.map(\.rawValue), corpus.componentOrder)
    }

    func testFingerprintVectors() throws {
        let corpus = try loadCorpus()
        for vector in corpus.vectors {
            let actual = Fingerprint.hashComponents(
                productSlug: vector.product,
                raw: vector.raw
            )
            XCTAssertEqual(actual.components, vector.components, "components for \(vector.id)")
            XCTAssertEqual(actual.hwid, vector.hwid, "hwid for \(vector.id)")
        }
    }

    func testDeviceIdVectors() throws {
        let corpus = try loadCorpus()
        for vector in corpus.deviceIds {
            XCTAssertEqual(
                DeviceID.fromRaw(productSlug: vector.product, raw: vector.raw),
                vector.expected,
                "device id for \(vector.id)"
            )
        }
    }
}
