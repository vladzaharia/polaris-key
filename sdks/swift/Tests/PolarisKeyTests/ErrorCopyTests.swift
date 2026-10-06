// @pkey-feature core.errors
//
// `ErrorCopy` (notes/SDK-PARITY-PASS.md §3.2): the person-facing line for a registry code, a
// generic line plus the code for one without, and `PolarisError` as a `LocalizedError`.

import Foundation
@testable import PolarisKeyCore
import XCTest

final class ErrorCopyTests: XCTestCase {
    func testEveryKeyIsARegistryCode() {
        let registry = Set(ERROR_CODE_VALUES)
        for code in ErrorCopy.messages.keys {
            XCTAssertTrue(registry.contains(code), "\(code) is not in errors.json")
        }
    }

    func testTheCodesAPersonMeetsHaveTheirOwnLine() {
        let required = [
            ErrorCode.unauthorized, ErrorCode.deviceLimit, ErrorCode.fingerprintRequired,
            ErrorCode.hardwareMismatch, ErrorCode.enrollDisabled, ErrorCode.enrollClaimed,
            ErrorCode.licenseDisabled, ErrorCode.licenseExpired, ErrorCode.attestationRequired,
            ErrorCode.rateLimited, ErrorCode.registrationClosed, ErrorCode.notEntitled,
            ErrorCode.network, ErrorCode.networkError, ErrorCode.serverError,
            ErrorCode.localOnly, ErrorCode.serviceUnavailable, ErrorCode.licenseOwned,
            ErrorCode.signInExpired, ErrorCode.signInDenied,
        ]
        for code in required { XCTAssertTrue(ErrorCopy.has(code), code) }
    }

    func testAnUnknownCodeFallsBackWithTheCode() {
        XCTAssertEqual(
            ErrorCopy.message("brand_new_code"), "\(ErrorCopy.genericMessage) (brand_new_code)")
        XCTAssertEqual(ErrorCopy.title("brand_new_code"), "Something went wrong")
    }

    func testDetailIsAppended() {
        XCTAssertEqual(
            ErrorCopy.message(ErrorCode.rateLimited, detail: "Try in 30 s."),
            ErrorCopy.message(ErrorCode.rateLimited) + " Try in 30 s.")
    }

    func testPolarisErrorIsLocalized() {
        let e = PolarisError(code: ErrorCode.localOnly, message: "dial refused")
        XCTAssertEqual(e.errorDescription, ErrorCopy.message(ErrorCode.localOnly))
        XCTAssertEqual(e.failureReason, "dial refused")
        XCTAssertEqual((e as Error).localizedDescription, ErrorCopy.message(ErrorCode.localOnly))
    }

    func testTheCopyNamesTheRightDevice() {
        #if os(macOS)
            XCTAssertTrue(ErrorCopy.message(ErrorCode.fingerprintRequired).contains("this Mac"))
        #else
            XCTAssertFalse(ErrorCopy.message(ErrorCode.fingerprintRequired).contains("Mac"))
        #endif
    }
}
