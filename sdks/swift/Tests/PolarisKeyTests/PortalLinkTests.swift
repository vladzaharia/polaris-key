// @pkey-feature ui.kit.holders
//
// UK-43.4: the product page link (WIRE-CONTRACT-V4 §5.7) over every row of
// conformance/corpus/v2/portal-matrix.json: parseCases (`PortalLink.parse`) and linkCases
// (`PortalLink.link`).

import Foundation
import PolarisKeyCore
import XCTest

final class PortalLinkTests: XCTestCase {
    private func matrix() throws -> [String: JSONValue] {
        let data = try Data(contentsOf: try CorpusLocator.url("portal-matrix"))
        return try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: data).objectValue)
    }

    private func member(_ value: JSONValue?) -> PortalMember? {
        guard let o = value?.objectValue else { return nil }
        return PortalMember(enabled: o["enabled"]?.boolValue == true, activate: o["activate"]?.stringValue)
    }

    private func rows(_ key: String) throws -> [[String: JSONValue]] {
        guard case .array(let list)? = try matrix()[key] else { throw XCTSkip("no \(key)") }
        return list.compactMap(\.objectValue)
    }

    func testTheVersionIsTheOneTheSdkWasBuiltAgainst() throws {
        XCTAssertEqual(try matrix()["portalMatrixVersion"], .int(PORTAL_MATRIX_VERSION))
    }

    func testParseCases() throws {
        let cases = try rows("parseCases")
        XCTAssertGreaterThanOrEqual(cases.count, 10)
        for row in cases {
            XCTAssertEqual(
                PortalLink.parse(core: row["core"]), member(row["expect"]), row["name"]?.stringValue ?? "?")
        }
    }

    func testLinkCases() throws {
        let cases = try rows("linkCases")
        XCTAssertGreaterThanOrEqual(cases.count, 10)
        for row in cases {
            XCTAssertEqual(
                PortalLink.link(
                    served: row["served"]?.stringValue, portal: member(row["portal"]),
                    baseUrl: row["baseUrl"]?.stringValue ?? "", product: row["product"]?.stringValue ?? ""),
                row["expect"]?.stringValue, row["name"]?.stringValue ?? "?")
        }
    }
}
