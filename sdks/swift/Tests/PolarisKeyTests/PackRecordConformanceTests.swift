// @pkey-feature packs.record
//
// `cases.json`'s `packRecordCases` and `markerCases` (plans/P4-01.md §4.6) through the Swift
// verifiers:
//
//   packRecordCases  step 14 over every case that reaches it      → releaseRecordClaims
//   packRecordCases  steps 12–15 with `pin.kind`, every case        → verifyReleaseRecord
//   markerCases      step 14 over every marker release reaching it → releaseRecordClaims
//   markerCases      V4 §3.7, every case                           → verifyMarker
//
// The pointer sets over both families are `PointerSetTests.swift`.

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

private struct PackCorpus: Decodable {
    struct Pin: Decodable {
        let kind: String?
        let deliverable: String
        let version: String
        let seq: Int
    }
    struct Expect: Decodable {
        let verify: String
        let step: String?
        let kind: String?
        let doc: JSONValue?
        let packId: String?
        let version: String?
        let recordSha256: String?
    }
    struct RecordCase: Decodable {
        let id: String
        let description: String
        let jws: String
        let releaseKeys: TrustSet
        let productTrust: TrustSet
        let expectedAud: String
        let expectedHash: String
        let pin: Pin?
        let expect: Expect
    }
    struct MarkerCase: Decodable {
        let id: String
        let description: String
        let marker: String
        let releaseKeys: TrustSet
        let productTrust: TrustSet
        let expectedAud: String
        let expect: Expect
    }
    let packRecordCases: [RecordCase]
    let markerCases: [MarkerCase]
}

final class PackRecordConformanceTests: XCTestCase {
    private func corpus() throws -> PackCorpus { try CorpusBundleLoader.load(PackCorpus.self, "cases") }

    /// Step 13's key selection from the pinned release keys, then the signature: the payload the
    /// claims see.
    private func reachClaims(_ jws: String, _ keys: TrustSet) throws -> (JSONValue, NonWireIntegers) {
        let header = try JSONDecoder().decode(
            JSONValue.self, from: try XCTUnwrap(Base64URL.decode(String(jws.split(separator: ".")[0]))))
        let kid = try XCTUnwrap(header.objectValue?["kid"]?.stringValue)
        let v = try XCTUnwrap(JWSVerifier.verify(jws, trust: [kid: try XCTUnwrap(keys[kid])], typ: .release))
        return (try JSONDecoder().decode(JSONValue.self, from: v.payload), v.nonWireIntegers)
    }

    private func markerRelease(_ marker: String) -> String? {
        parseJSON(marker)?.objectValue?["release"]?.stringValue
    }

    func testCounts() throws {
        let c = try corpus()
        XCTAssertEqual(c.packRecordCases.count, 159)
        XCTAssertEqual(c.markerCases.count, 17)
    }

    func testPackRecordClaimsOverEveryCaseThatReachesThem() throws {
        var checked = 0
        for c in try corpus().packRecordCases {
            let step = c.expect.verify == "ok" ? nil : c.expect.step
            if let step, step != "claims", step != "cross-check" { continue }
            let (payload, nonWire) = try reachClaims(c.jws, c.releaseKeys)
            XCTAssertEqual(
                releaseRecordClaims(payload, expectedAud: c.expectedAud, nonWire: nonWire), step != "claims",
                "\(c.id): \(c.description)")
            checked += 1
        }
        XCTAssertGreaterThan(checked, 150)
    }

    func testMarkerReleaseClaimsOverEveryCaseThatReachesThem() throws {
        for c in try corpus().markerCases {
            let step = c.expect.verify == "ok" ? nil : c.expect.step
            if let step, step != "claims", step != "cross-check" { continue }
            let release = try XCTUnwrap(markerRelease(c.marker), "\(c.id) carries a release")
            let (payload, nonWire) = try reachClaims(release, c.releaseKeys)
            XCTAssertEqual(
                releaseRecordClaims(payload, expectedAud: c.expectedAud, nonWire: nonWire), step != "claims",
                "marker \(c.id): \(c.description)")
        }
    }

    func testAllPackRecordCases() throws {
        for c in try corpus().packRecordCases {
            let r = verifyReleaseRecord(
                c.jws,
                options: VerifyReleaseRecordOptions(
                    releaseKeys: c.releaseKeys, productTrust: c.productTrust, expectedAud: c.expectedAud,
                    expectedHash: c.expectedHash,
                    pin: c.pin.map {
                        ReleaseRecordPin(kind: $0.kind ?? "app", deliverable: $0.deliverable, version: $0.version, seq: $0.seq)
                    }))
            if c.expect.verify == "ok" {
                guard let record = r.record else {
                    XCTFail("\(c.id) → ok, got \(String(describing: r.step)): \(c.description)")
                    continue
                }
                XCTAssertEqual(record.kind, c.expect.kind, c.id)
                if let doc = c.expect.doc { XCTAssertEqual(record.json, doc, c.id) }
                if record.kind == "pack" { XCTAssertNotNil(PackRecordDoc(json: record.json), c.id) }
            } else {
                XCTAssertEqual(r.step?.rawValue, c.expect.step, "\(c.id): \(c.description)")
            }
        }
    }

    func testAllMarkerCases() throws {
        for c in try corpus().markerCases {
            let r = verifyMarker(
                c.marker, releaseKeys: c.releaseKeys, productTrust: c.productTrust, expectedAud: c.expectedAud)
            switch r {
            case .ok(let packId, let version, _, let record, let recordSha256):
                XCTAssertEqual(c.expect.verify, "ok", "marker \(c.id): \(c.description)")
                XCTAssertEqual(packId, c.expect.packId, c.id)
                XCTAssertEqual(version, c.expect.version, c.id)
                XCTAssertEqual(recordSha256, c.expect.recordSha256, c.id)
                XCTAssertEqual(record.deliverable, packId, c.id)
            case .rejected(let step):
                XCTAssertEqual(c.expect.verify, "fail", "marker \(c.id): \(c.description)")
                XCTAssertEqual(step, c.expect.step, "marker \(c.id): \(c.description)")
            }
        }
    }
}
