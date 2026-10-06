// @pkey-feature core.copy
// @pkey-feature core.errors
//
// `ErrorCopy` over the generated tables (core.copy, notes/SDK-PARITY-PASS.md §3.2): every
// error code, gate status and activation result reads its line from Copy.generated.swift
// (copy.en.json); a code with none reads COPY_FALLBACK naming it; placeholders are filled or
// dropped; activation results read the activation table only; the host override layer wins per
// key; and `PolarisError` is a `LocalizedError`.

import Foundation
import XCTest

@testable import PolarisKeyCore
@testable import PolarisKeyLicense

final class ErrorCopyTests: XCTestCase {
    override func tearDown() {
        ErrorCopy.setOverrides()
        super.tearDown()
    }

    /// COPY_CODES: every registry code is served from the generated table, placeholders aside.
    func testEveryErrorCodeReadsTheGeneratedTable() {
        XCTAssertEqual(Set(COPY_CODES.keys), Set(ERROR_CODE_VALUES))
        for code in ERROR_CODE_VALUES {
            let entry = COPY_CODES[code]!
            XCTAssertTrue(ErrorCopy.has(code), code)
            XCTAssertEqual(ErrorCopy.title(code), entry.title, code)
            XCTAssertEqual(
                ErrorCopy.message(code), ErrorCopy.fill(entry.message, code: code, params: [:]),
                code)
            XCTAssertFalse(ErrorCopy.message(code).contains("{"), code)
        }
    }

    /// COPY_GATE: every licenseStatus.
    func testEveryGateStatusReadsTheGateTable() {
        let statuses: [LicenseStatus] = [
            .ok, .grace, .expired, .revoked, .needsActivation, .versionTooOld, .versionTooNew,
            .channelNotEntitled, .notApplicable,
        ]
        XCTAssertEqual(Set(COPY_GATE.keys), Set(statuses.map(\.rawValue)))
        for status in statuses {
            let entry = COPY_GATE[status.rawValue]!
            // `ok` is also an activation result; the gate table answers first.
            XCTAssertEqual(ErrorCopy.message(status.rawValue), entry.message, status.rawValue)
            XCTAssertEqual(ErrorCopy.title(status.rawValue), entry.title, status.rawValue)
        }
    }

    /// COPY_ACTIVATION: every activationResult, by its spelling and by its camelCase kind.
    func testEveryActivationResultReadsTheActivationTable() {
        for (result, entry) in COPY_ACTIVATION {
            XCTAssertEqual(
                ErrorCopy.activationMessage(result, code: "x"),
                ErrorCopy.fill(entry.message, code: "x", params: [:]), result)
            XCTAssertEqual(ErrorCopy.activationTitle(result), entry.title, result)
            let kind = ErrorCopy.camelCase(result)
            XCTAssertEqual(ErrorCopy.activationTitle(kind), entry.title, kind)
        }
    }

    /// The split: the error code `unauthorized` is "Not signed in", the activation result
    /// `unauthorized` is "Key not accepted". `message(code)` tries the code table first;
    /// an activation result reads the activation table only.
    func testActivationVersusCodeSplit() {
        XCTAssertEqual(ErrorCopy.title("unauthorized"), "Not signed in")
        XCTAssertEqual(ErrorCopy.activationTitle("unauthorized"), "Key not accepted")
        XCTAssertEqual(
            ErrorCopy.message("unauthorized"), COPY_CODES["unauthorized"]!.message)
        XCTAssertEqual(
            ErrorCopy.activationMessage("unauthorized"), COPY_ACTIVATION["unauthorized"]!.message)
        // A code only the activation table knows is still found by `message(code)`.
        XCTAssertNil(COPY_CODES["refused"])
        XCTAssertEqual(ErrorCopy.title("refused"), COPY_ACTIVATION["refused"]!.title)
        XCTAssertEqual(ErrorCopy.title("deviceLimit"), COPY_ACTIVATION["device-limit"]!.title)
        // The typed result: activation table, never the code table.
        XCTAssertEqual(ActivationResult.unauthorized.message, "That license key wasn't accepted. Check it and try again.")
        XCTAssertEqual(ActivationResult.unauthorized.title, "Key not accepted")
        XCTAssertEqual(
            ActivationResult.error(code: ErrorCode.network, message: "offline").message,
            COPY_ACTIVATION["error"]!.message)
        XCTAssertEqual(
            ActivationResult.attestationRequired.message,
            COPY_ACTIVATION["attestation-required"]!.message)
        XCTAssertNotEqual(
            ActivationResult.attestationRequired.message,
            COPY_CODES["attestation_required"]!.message)
    }

    /// A refusal names the server's code: its own line when the catalog has one, else the
    /// activation table's "refused ({code})" — never the raw body.
    func testRefusedNamesTheCode() {
        let owned = ActivationResult.refused(
            code: ErrorCode.licenseOwned, status: 403, message: "{\"error\":\"license_owned\"}")
        XCTAssertEqual(owned.message, ErrorCopy.message(ErrorCode.licenseOwned))
        XCTAssertEqual(owned.title, COPY_CODES["license_owned"]!.title)
        let novel = ActivationResult.refused(code: "key_entry_limit", status: 403, message: "raw")
        XCTAssertEqual(novel.message, "Activation was refused (key_entry_limit).")
        XCTAssertEqual(novel.title, "Activation refused")
        XCTAssertNil(ActivationResult.ok(token: "t", schemaVersion: 1).message)
    }

    /// COPY_FALLBACK names the code, with no raw body.
    func testAnUnknownCodeFallsBackNamingTheCode() {
        XCTAssertFalse(ErrorCopy.has("brand_new_code"))
        XCTAssertEqual(
            ErrorCopy.message("brand_new_code"), "Something went wrong (brand_new_code). Try again.")
        XCTAssertEqual(ErrorCopy.title("brand_new_code"), COPY_FALLBACK.title)
    }

    /// Placeholders: `{product}` is filled from params, dropped (with its space) when absent;
    /// `{code}` defaults to the code; nothing but the registered names is touched.
    func testPlaceholdersAreFilledOrDropped() {
        XCTAssertTrue(COPY_CODES["license_owned"]!.message.contains("{product}"))
        XCTAssertEqual(
            ErrorCopy.message(ErrorCode.licenseOwned, params: ["product": "DJDL"]),
            "This DJDL license is already in another Polaris Key account. A license never moves by its key.")
        XCTAssertEqual(
            ErrorCopy.message(ErrorCode.licenseOwned),
            "This license is already in another Polaris Key account. A license never moves by its key.")
        XCTAssertEqual(
            ErrorCopy.fill("Wait {retryAfterSeconds} s ({code}).", code: "rate_limited", params: [:]),
            "Wait s (rate_limited).")
        XCTAssertEqual(
            ErrorCopy.fill(
                "Wait {retryAfterSeconds} s.", code: "c", params: ["retryAfterSeconds": "30"]),
            "Wait 30 s.")
        XCTAssertEqual(ErrorCopy.fill("a {not closed", code: "c", params: [:]), "a {not closed")
        XCTAssertEqual(ErrorCopy.fill("{ } {x-y}", code: "c", params: [:]), "{ } {x-y}")
        XCTAssertEqual(ErrorCopy.activationMessage("refused", code: "abc"), "Activation was refused (abc).")
        for p in COPY_PLACEHOLDERS {
            XCTAssertEqual(ErrorCopy.fill("x {\(p)}", code: "c", params: [p: "v"]), "x v", p)
        }
    }

    func testDetailIsAppendedInParentheses() {
        XCTAssertEqual(
            ErrorCopy.message(ErrorCode.badRequest, detail: "missing key"),
            ErrorCopy.message(ErrorCode.badRequest) + " (missing key)")
    }

    /// The host's English layer wins per key and leaves the rest generated.
    func testHostOverridesWinPerKey() {
        ErrorCopy.setOverrides(
            messages: ["device_limit": "All seats are taken.", "deviceLimit": "Seats full."],
            titles: ["grace": "Offline"])
        XCTAssertEqual(ErrorCopy.message(ErrorCode.deviceLimit), "All seats are taken.")
        XCTAssertEqual(ErrorCopy.activationMessage("device-limit"), "Seats full.")
        XCTAssertEqual(ErrorCopy.title("grace"), "Offline")
        XCTAssertEqual(ErrorCopy.title("expired"), COPY_GATE["expired"]!.title)
        ErrorCopy.setOverrides()
        XCTAssertEqual(ErrorCopy.message(ErrorCode.deviceLimit), COPY_CODES["device_limit"]!.message)
    }

    func testPolarisErrorIsLocalized() {
        let e = PolarisError(code: ErrorCode.localOnly, message: "dial refused")
        XCTAssertEqual(e.errorDescription, COPY_CODES["local-only"]!.message)
        XCTAssertEqual(e.failureReason, "dial refused")
        XCTAssertEqual((e as Error).localizedDescription, ErrorCopy.message(ErrorCode.localOnly))
    }
}
