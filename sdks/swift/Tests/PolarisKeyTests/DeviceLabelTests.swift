// @pkey-feature identity.devicelabel
// The device label (WIRE-CONTRACT-V4 §12.7.1, plans/PX-W13.md §4), driven off
// `conformance/corpus/v2`'s `device-label.json`, read from the checkout through `CorpusLocator`.
// Labels compare as Unicode scalars, never with `String ==` (which is
// canonical equivalence and would merge a decomposed accent with a composed one).

import Foundation
import XCTest

@testable import PolarisKeyCore

final class DeviceLabelTests: XCTestCase {
    private struct Row: Decodable {
        let id: String
        let raw: String
        let expect: String?
    }
    private struct Corpus: Decodable {
        let deviceLabelVersion: Int
        let cases: [Row]
    }

    private func scalars(_ s: String?) -> [UInt32]? { s.map { $0.unicodeScalars.map(\.value) } }

    func testCorpusRows() throws {
        let corpus = try CorpusLocator.load(Corpus.self, "device-label")
        XCTAssertEqual(corpus.deviceLabelVersion, DEVICE_LABEL_VERSION)
        XCTAssertGreaterThanOrEqual(corpus.cases.count, 20)
        for row in corpus.cases {
            XCTAssertEqual(scalars(normalizeDeviceLabel(row.raw)), scalars(row.expect), row.id)
        }
    }

    func testPrecedence() async {
        let host: () async -> String? = { " host\t" }
        let a = await resolveDeviceLabel(override: "Den PC", configured: "TV", platformDefault: host)
        XCTAssertEqual(a, "Den PC")
        let b = await resolveDeviceLabel(override: nil, configured: "TV", platformDefault: host)
        XCTAssertEqual(b, "TV")
        let c = await resolveDeviceLabel(override: nil, configured: nil, platformDefault: host)
        XCTAssertEqual(c, "host")
        let d = await resolveDeviceLabel(override: "", configured: "TV", platformDefault: host)
        XCTAssertNil(d)
        let e = await resolveDeviceLabel(override: nil, configured: "", platformDefault: host)
        XCTAssertNil(e)
    }
}
