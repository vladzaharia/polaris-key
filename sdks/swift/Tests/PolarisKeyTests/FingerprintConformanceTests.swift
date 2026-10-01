// @pkey-feature devices.fingerprint
// The Swift conformance runner for the fingerprint + device-id formulas. Mirrors
// conformance/runners/node/fingerprint.test.ts and the Python runner against the SAME corpus,
// bundled here as a test resource (the Swift test target can't reach up the monorepo at test
// time — tools/sign-corpus.ts mirrors the file and `--check` guards the copy).
//
// Reads `Resources/v2/fingerprint.json`, which is byte-identical to v1's: `fingerprintVersion`
// stays 1 and the `pkey-hw:`/`pkey-device:` hash prefixes are deliberately NOT rebranded. They
// are hash DOMAINS baked into every enrolled digest, not user-visible identifiers — renaming
// them would orphan every fingerprint on record for a cosmetic gain.
//
// P1b-09 added three SOURCE-rule sections (WIRE-CONTRACT-V3 §6.1). Swift reads no Windows or
// Linux hardware, so of those it runs only `ramBuckets` (`windowsCim` and `linuxAnchor` apply to
// SDKs that read those platforms).

import PolarisKeyCore
import XCTest

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

private struct RamBucketCase: Decodable {
    let id: String
    let description: String
    let bytes: UInt64
    let bucket: String?
}

private struct FingerprintCorpus: Decodable {
    let fingerprintVersion: Int
    let componentOrder: [String]
    let componentHashLength: Int
    let hwidLength: Int
    let deviceIds: [DeviceIdVector]
    let vectors: [FingerprintVector]
    let ramBuckets: [RamBucketCase]
}

final class FingerprintConformanceTests: XCTestCase {
    private func loadCorpus() throws -> FingerprintCorpus {
        try CorpusBundleLoader.load(FingerprintCorpus.self, "fingerprint")
    }

    func testCorpusHasVectors() throws {
        let corpus = try loadCorpus()
        XCTAssertEqual(
            corpus.fingerprintVersion, 1,
            "the fingerprint formulas are unchanged in wire v3 — a bump here orphans every "
                + "enrolled digest")
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
                productSlug: vector.product, raw: vector.raw)
            XCTAssertEqual(actual.components, vector.components, "components for \(vector.id)")
            XCTAssertEqual(actual.hwid, vector.hwid, "hwid for \(vector.id)")
            for (_, digest) in actual.components {
                XCTAssertEqual(
                    digest.count, corpus.componentHashLength,
                    "component digest length for \(vector.id)")
            }
            XCTAssertEqual(actual.hwid.count, corpus.hwidLength, "hwid length for \(vector.id)")
        }
    }

    func testDeviceIdVectors() throws {
        let corpus = try loadCorpus()
        for vector in corpus.deviceIds {
            XCTAssertEqual(
                DeviceID.fromRaw(productSlug: vector.product, raw: vector.raw),
                vector.expected,
                "device id for \(vector.id)")
        }
    }

    /// Rule 3 (`ramBuckets`): integer-exact, omitted below 1 GiB, and the just-under-1-PiB case
    /// a float `log2` would round up.
    func testRamBucketCases() throws {
        let corpus = try loadCorpus()
        XCTAssertFalse(corpus.ramBuckets.isEmpty)
        for c in corpus.ramBuckets {
            XCTAssertEqual(
                Fingerprint.ramBucket(bytes: c.bytes), c.bucket, "ramBuckets \(c.id): \(c.description)")
        }
    }
}
