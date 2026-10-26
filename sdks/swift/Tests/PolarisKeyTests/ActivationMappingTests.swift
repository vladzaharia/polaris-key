// @pkey-feature license.activate license.enroll core.errors
//
// The typed activation ladder (notes/SDK-PARITY-PASS.md §3.1): every kind is chosen by the body's
// error CODE, an unknown 403 is never a device limit, and every kind carries a code and the
// shared person-facing copy (never the raw body).

import Foundation
import PolarisKeyCore
@testable import PolarisKeyLicense
import XCTest

final class ActivationMappingTests: XCTestCase {
    private func map(
        _ status: Int, _ body: String, enroll: Bool = false, headers: [String: String] = [:]
    ) -> ActivationResult {
        LicenseEndpoints.mapActivationResponse(
            PolarisResponse(status: status, body: Data(body.utf8), headers: headers),
            enroll: enroll)
    }

    func testOk() {
        XCTAssertEqual(
            map(200, #"{"token":"pkeyt_x","schemaVersion":3}"#),
            .ok(token: "pkeyt_x", schemaVersion: 3))
        XCTAssertEqual(map(200, "{}").code, ErrorCode.badResponse)
    }

    // I-10b.8: key-entry counts and the two I-09 refusals (WIRE-CONTRACT-V4 §12.2).
    func testOkCarriesKeyEntriesWhenSent() {
        XCTAssertEqual(
            map(200, #"{"token":"pkeyt_x","schemaVersion":3,"keyEntries":{"used":2,"limit":10}}"#),
            .ok(token: "pkeyt_x", schemaVersion: 3, keyEntries: KeyEntries(used: 2, limit: 10)))
        // A malformed count never costs the token.
        for bad in [#""x""#, #"{"used":-1,"limit":3}"#, #"{"used":1,"limit":0}"#, #"{"used":1}"#] {
            XCTAssertEqual(
                map(200, #"{"token":"pkeyt_x","schemaVersion":3,"keyEntries":\#(bad)}"#),
                .ok(token: "pkeyt_x", schemaVersion: 3), bad)
        }
    }

    func testKeyEntryLimitAndLicenseOwned() {
        let manage = "https://key.plrs.im/activate?product=djdl"
        let limit = map(
            403,
            #"{"error":"key_entry_limit","manageUrl":"\#(manage)","keyEntries":{"used":2,"limit":2}}"#
        )
        XCTAssertEqual(
            limit, .keyEntryLimit(manageUrl: manage, keyEntries: KeyEntries(used: 2, limit: 2)))
        XCTAssertEqual(limit.kind, "key-entry-limit")
        XCTAssertEqual(limit.code, ErrorCode.keyEntryLimit)
        XCTAssertNotNil(limit.message)
        // A portal that is off sends no link; an unsafe link is dropped.
        XCTAssertEqual(
            map(403, #"{"error":"key_entry_limit","manageUrl":"javascript:alert(1)"}"#),
            .keyEntryLimit(manageUrl: nil, keyEntries: nil))
        let signIn = "https://key.plrs.im/signin?product=djdl"
        let owned = map(403, #"{"error":"license_owned","signInUrl":"\#(signIn)"}"#)
        XCTAssertEqual(owned, .licenseOwned(signInUrl: signIn))
        XCTAssertEqual(owned.kind, "license-owned")
        XCTAssertEqual(owned.code, ErrorCode.licenseOwned)
        XCTAssertNotNil(owned.message)
        XCTAssertEqual(
            map(403, #"{"error":{"code":"license_owned"}}"#), .licenseOwned(signInUrl: nil))
    }

    func testEveryKindByCode() {
        let rows: [(Int, String, ActivationResult)] = [
            (403, #"{"error":"device_limit","limit":3,"deviceCount":3}"#,
             .deviceLimit(limit: 3, deviceCount: 3)),
            (403, #"{"error":{"code":"device_limit","limit":2}}"#,
             .deviceLimit(limit: 2, deviceCount: nil)),
            (403, #"{"error":"fingerprint_required"}"#, .fingerprintRequired),
            (403, #"{"error":"enroll_claimed","message":"sign in to use it"}"#, .enrollClaimed),
            (403, #"{"error":"license_disabled"}"#, .licenseDisabled),
            (403, #"{"error":"license_expired"}"#, .licenseExpired),
            (403, #"{"error":{"code":"attestation_required"}}"#, .attestationRequired),
            (409, #"{"error":"hardware_mismatch","drift":2,"changed":["disk"]}"#,
             .hardwareMismatch(drift: 2, changed: ["disk"])),
            (401, #"{"error":"unauthorized"}"#, .unauthorized),
            (404, #"{"error":"enroll_disabled","message":"enrollment is disabled"}"#,
             .enrollDisabled),
            (429, #"{"error":"rate_limited"}"#, .rateLimited(retryAfterSeconds: nil)),
        ]
        for (status, body, want) in rows {
            XCTAssertEqual(map(status, body), want, body)
        }
    }

    /// Anything this build predates is `refused` with the server's own code — never
    /// `deviceLimit`, which used to swallow every unknown 403.
    func testAnUnknown403IsRefusedWithItsCode() {
        XCTAssertEqual(
            map(403, #"{"error":"some_future_code","message":"later"}"#),
            .refused(code: "some_future_code", status: 403, message: "later"))
        XCTAssertEqual(
            map(403, #"{"error":{"code":"another_future_code"}}"#),
            .refused(code: "another_future_code", status: 403, message: nil))
        XCTAssertEqual(map(403, "").code, ErrorCode.forbidden)
        XCTAssertEqual(map(403, "not json").kind, "refused")
    }

    func testA404OnActivateIsNotEnrollDisabled() {
        XCTAssertEqual(
            map(404, #"{"error":"not_found"}"#),
            .refused(code: "not_found", status: 404, message: nil))
        XCTAssertEqual(map(404, "", enroll: true), .enrollDisabled)
        XCTAssertEqual(map(404, ""), .refused(code: "not_found", status: 404, message: nil))
    }

    func testRateLimitReadsRetryAfter() {
        XCTAssertEqual(
            map(429, "{}", headers: ["Retry-After": "30"]), .rateLimited(retryAfterSeconds: 30))
        XCTAssertEqual(
            map(429, "{}", headers: ["retry-after": "Wed, 21 Oct 2015 07:28:00 GMT"]),
            .rateLimited(retryAfterSeconds: nil))
    }

    func testOther4xxAnd5xx() {
        XCTAssertEqual(
            map(400, #"{"error":"bad_request","message":"missing device id"}"#),
            .refused(code: "bad_request", status: 400, message: "missing device id"))
        let server = map(503, "upstream")
        XCTAssertEqual(server.code, ErrorCode.serverError)
        XCTAssertEqual(server.kind, "error")
    }

    func testEveryKindCarriesCodeAndCopy() {
        let kinds: [ActivationResult] = [
            .deviceLimit(limit: nil, deviceCount: nil), .unauthorized, .fingerprintRequired,
            .hardwareMismatch(drift: nil, changed: nil), .enrollDisabled, .enrollClaimed,
            .licenseDisabled, .licenseExpired, .attestationRequired,
            .rateLimited(retryAfterSeconds: nil),
            .refused(code: "license_owned", status: 403, message: "raw body"),
            .error(code: ErrorCode.network, message: "offline"),
        ]
        for k in kinds {
            XCTAssertFalse(k.code.isEmpty, "\(k)")
            let message = try? XCTUnwrap(k.message)
            XCTAssertNotNil(message)
            XCTAssertFalse(message?.contains("raw body") ?? true, "copy, never the body")
            XCTAssertTrue(ErrorCopy.has(k.code), "\(k.code) has its own line")
        }
        XCTAssertNil(ActivationResult.ok(token: "t", schemaVersion: 1).message)
        XCTAssertEqual(
            ActivationResult.hardwareMismatch(drift: 1, changed: ["disk", "cpu"]).message?
                .contains("(disk, cpu)"), true)
    }
}
