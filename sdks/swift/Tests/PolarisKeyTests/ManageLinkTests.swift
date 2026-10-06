// @pkey-feature license.manage
// PX-W8: the refusal link helpers (WIRE-CONTRACT-V4 §5.3). The same table as client-core's
// `test/manage.test.ts`, so the links a Swift host builds are byte-identical to every other
// SDK's.

import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class ManageLinkTests: XCTestCase {
    static let free =
        "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=Linux%20x86_64"
    static let activate = "https://key.plrs.im/activate?product=djdl"

    func testReadKeepsOnlyValidLinks() {
        let cases: [(String, String?, String?, String?)] = [
            ("a free-device link", Self.free, nil, Self.free),
            ("an activate link", Self.activate, nil, Self.activate),
            (
                "a loopback http link", "http://localhost:8787/activate?product=djdl", nil,
                "http://localhost:8787/activate?product=djdl"
            ),
            ("a nested member", nil, Self.free, Self.free),
            ("javascript:", "javascript:alert(1)", nil, nil),
            ("plain http", "http://key.plrs.im/activate", nil, nil),
            ("userinfo", "https://user:pw@key.plrs.im/activate", nil, nil),
            ("relative", "/activate?product=djdl", nil, nil),
            ("no //", "https:key.plrs.im/activate", nil, nil),
            ("a backslash in the authority", "https://key.plrs.im\\@evil.example/activate", nil, nil),
            ("a backslash as a separator", "https://key.plrs.im\\evil/activate", nil, nil),
            ("whitespace", "https://key.plrs.im/a b", nil, nil),
            ("absent", nil, nil, nil),
        ]
        for (name, top, nested, want) in cases {
            XCTAssertEqual(ManageLink.read(top, nested), want, name)
        }
    }

    func testReadDropsAnOverlongLink() {
        XCTAssertEqual(ManageLink.maxLength, 2048)
        let base = "https://key.plrs.im/activate?product="
        let exact = base + String(repeating: "a", count: ManageLink.maxLength - base.count)
        XCTAssertTrue(ManageLink.isValid(exact))
        XCTAssertNil(ManageLink.read(exact + "a"))
    }

    func testWithReturn() {
        XCTAssertEqual(
            ManageLink.withReturn(Self.free, "myapp://done"),
            "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=Linux%20x86_64&return=myapp%3A%2F%2Fdone"
        )
        XCTAssertEqual(
            ManageLink.withReturn(Self.activate, "https://app.example/a b"),
            "https://key.plrs.im/activate?product=djdl&return=https%3A%2F%2Fapp.example%2Fa+b")
        XCTAssertEqual(
            ManageLink.withReturn(Self.activate + "#key=k", "x"),
            "https://key.plrs.im/activate?product=djdl&return=x#key=k")
        XCTAssertEqual(
            ManageLink.withReturn("https://key.plrs.im/#/p/djdl/free-device?return=old", "new"),
            "https://key.plrs.im/#/p/djdl/free-device?return=new")
        XCTAssertEqual(
            ManageLink.withReturn("https://key.plrs.im/#/p/djdl/free-device", "new"),
            "https://key.plrs.im/#/p/djdl/free-device?return=new")
        XCTAssertEqual(ManageLink.withReturn("javascript:alert(1)", "x"), "javascript:alert(1)")
        XCTAssertEqual(ManageLink.withReturn(Self.free, ""), Self.free)
    }

    func testWithKey() {
        XCTAssertEqual(
            ManageLink.withKey(Self.activate, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV"),
            "https://key.plrs.im/activate?product=djdl#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV")
        XCTAssertEqual(
            ManageLink.withKey(
                "https://key.plrs.im/activate?product=djdl&next=free-device#key=old", "k y"),
            "https://key.plrs.im/activate?product=djdl&next=free-device#key=k+y")
        XCTAssertEqual(ManageLink.withKey(Self.free, "pkey_x"), Self.free)
        XCTAssertEqual(
            ManageLink.withKey("https://key.plrs.im/signin?product=djdl", "k"),
            "https://key.plrs.im/signin?product=djdl")
        XCTAssertEqual(ManageLink.withKey("javascript:alert(1)", "k"), "javascript:alert(1)")
        XCTAssertEqual(ManageLink.withKey(Self.activate, ""), Self.activate)
    }

    func testFormEncode() {
        XCTAssertEqual(ManageLink.formEncode("aZ09*-._ ~/:é"), "aZ09*-._+%7E%2F%3A%C3%A9")
    }

    /// The 403 ladder reads the member from both envelopes, drops an invalid one without losing
    /// `limit`/`deviceCount`, and an old body with no member (or an unknown one) still yields
    /// device-limit: the link is never an auth failure.
    func testDeviceLimitCarriesTheManageURL() async throws {
        let cases: [(String, ActivationResult)] = [
            (
                #"{"error":"device_limit","limit":1,"deviceCount":1,"manageUrl":"\#(Self.activate)"}"#,
                .deviceLimit(limit: 1, deviceCount: 1, manageURL: Self.activate)
            ),
            (
                #"{"error":{"code":"device_limit","limit":2,"deviceCount":2,"manageUrl":"\#(Self.free)"}}"#,
                .deviceLimit(limit: 2, deviceCount: 2, manageURL: Self.free)
            ),
            (
                #"{"error":"device_limit","limit":3,"deviceCount":3,"manageUrl":"javascript:x"}"#,
                .deviceLimit(limit: 3, deviceCount: 3, manageURL: nil)
            ),
            (
                #"{"error":"device_limit","limit":4,"deviceCount":4,"manageUrl":7,"future":true}"#,
                .deviceLimit(limit: 4, deviceCount: 4, manageURL: nil)
            ),
        ]
        for (body, expected) in cases {
            let server = StubServer()
            await server.reply("/djdl/license/activate", status: 403, body: body)
            let core = try CoreContext(
                options: CoreOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"),
                    transport: server.transport))
            try await core.start()
            let result = await LicenseEndpoints.activate(core, key: "PKEY-KEY")
            XCTAssertEqual(result, expected, body)
        }
    }
}
