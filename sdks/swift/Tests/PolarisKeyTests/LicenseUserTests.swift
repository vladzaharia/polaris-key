// @pkey-feature license.signedinuser
import Foundation
import PolarisKeyCore
import XCTest

/// The signed-in user reader (V4 §3.2, plans/SP-54.md): total, never throws. The corpus rows
/// replay in `ConformanceTests.testAllLicenseUserCases`.
final class LicenseUserTests: XCTestCase {
    private let subject = "ps_" + String(repeating: "a", count: 22)

    private func profile(_ user: String) throws -> DocProfile {
        let json = #"{"name":"N","email":"holder@x.io","user":\#(user)}"#
        return try JSONDecoder().decode(DocProfile.self, from: Data(json.utf8))
    }

    func testValidSubjectIsRead() throws {
        let p = try profile(#"{"subject":"\#(subject)","extra":1}"#)
        XCTAssertEqual(licenseUser(p), SignedInUser(subject: subject))
    }

    func testMalformedMembersAreNil() throws {
        let bad = [
            "null", "[]", #""\#(subject)""#, "{}", #"{"subject":7}"#,
            #"{"subject":"ps_\#(String(repeating: "a", count: 21))"}"#,
            #"{"subject":"ps_\#(String(repeating: "a", count: 23))"}"#,
            #"{"subject":"\#(subject)\n"}"#,
            #"{"subject":"ps_\#(String(repeating: "é", count: 22))"}"#,
            #"{"subject":"us_\#(String(repeating: "a", count: 22))"}"#,
        ]
        for b in bad { XCTAssertNil(licenseUser(try profile(b)), b) }
    }

    func testKeyActivatedHolderEmailIsNotSignedIn() throws {
        let p = try JSONDecoder().decode(
            DocProfile.self, from: Data(#"{"name":"N","email":"holder@x.io"}"#.utf8))
        XCTAssertNil(p.user)
        XCTAssertNil(licenseUser(p))
        XCTAssertNil(licenseUser(nil as LicenseDoc?))
    }

    func testProfileRoundTrips() throws {
        let p = DocProfile(name: "N", firstName: "N", email: "e", activatedAt: 1, user: SignedInUser(subject: subject))
        let back = try JSONDecoder().decode(DocProfile.self, from: JSONEncoder().encode(p))
        XCTAssertEqual(back, p)
    }
}
