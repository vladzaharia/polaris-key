// Cross-SDK gate parity — wire contract v3 §5, driven off `conformance/corpus/v2`'s
// `gate-matrix.json` (version 2, 21 rows).
//
// Each row carries the BUILD-gate inputs (version/channel/compat window/entitlements) and the
// LICENSE-state inputs, paired with one expected decision. Rows 1–15 are corpus v1's matrix
// carried verbatim under the smallest possible shim — `licenseServiceEnabled: true` and
// `hasToken → activation` — so a v3 gate that changes any v2 decision goes red here. Rows 16–21
// pin what v1 could not express: `not-applicable` (D-08), `activation: "bundle"` (§7), and the
// one ordering v3 changed — the activation guard runs BEFORE the unsigned `blocked` hint.
//
// The build-gate half is a PORT: `checkBuildGate` mirrors the Worker's, rebuilt from `Semver.*`,
// with the fixture as the oracle. The Node runner ports the same forty lines. That duplication
// is deliberate — the point of the matrix is that four independent implementations agree, and a
// shared helper would prove only that they share a helper.

import Foundation
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class GateMatrixTests: XCTestCase {
    private struct GateMatrix: Decodable {
        let gateMatrixVersion: Int
        let rows: [Row]
    }
    private struct Row: Decodable {
        let name: String
        let gate: GateInputs
        let license: LicenseInputs
        let expect: ExpectDecision
    }
    private struct GateInputs: Decodable {
        let version: String
        let channel: String?
        let compatMin: String
        let compatMax: String
        let entitlements: [String: ManagedEntry]
    }
    private struct LicenseInputs: Decodable {
        let licenseServiceEnabled: Bool
        let activation: ActivationSource?
        let issuedAt: Int?
        let expiresAt: Int?
        let graceUntil: Int?
        let now: Int
        let lastSyncUnauthorized: Bool?
        let lastVerifiedAt: Int?
    }
    private struct ExpectDecision: Decodable {
        let status: String
        let ok: Bool
        let reason: BlockReason?
        let allowedRange: AllowedRange?
    }

    private func loadMatrix() throws -> GateMatrix {
        try CorpusBundleLoader.load(GateMatrix.self, "gate-matrix")
    }

    // ── The Worker's build gate, ported ──────────────────────────────────────────────
    private func strEnt(_ e: ManagedEntry?) -> String? { e?.value.stringValue }
    private func arrEnt(_ e: ManagedEntry?) -> [String]? {
        e?.value.arrayValue?.compactMap(\.stringValue)
    }
    private func tighterMin(_ a: String?, _ b: String?) -> String? {
        guard let a else { return b }
        guard let b else { return a }
        return Semver.compare(a, b) >= 0 ? a : b
    }
    private func tighterMax(_ a: String?, _ b: String?) -> String? {
        guard let a else { return b }
        guard let b else { return a }
        return Semver.compare(a, b) <= 0 ? a : b
    }
    private func normalizeChannel(_ header: String) -> Channel {
        if header == "staging" { return .staging }
        if header == "pr" || header.hasPrefix("pr") { return .pr }
        if header == "dev" { return .dev }
        return .stable
    }

    private func checkBuildGate(_ g: GateInputs) -> BlockInfo? {
        if Semver.isDevBuild(g.version) { return nil }
        let minV = tighterMin(g.compatMin, strEnt(g.entitlements["app.minVersion"]))
        let maxV = tighterMax(g.compatMax, strEnt(g.entitlements["app.maxVersion"]))
        let range = AllowedRange(min: minV, max: maxV)
        if let minV, Semver.compare(g.version, minV) < 0 {
            return BlockInfo(reason: .versionTooOld, allowedRange: range)
        }
        if let maxV, Semver.compare(g.version, maxV) > 0 {
            return BlockInfo(reason: .versionTooNew, allowedRange: range)
        }
        let channel = normalizeChannel(g.channel ?? Semver.channelForVersion(g.version).rawValue)
        if channel != .stable && channel != .dev {
            let granted = arrEnt(g.entitlements["channels"]) ?? ["stable"]
            if !granted.contains(channel.rawValue) {
                return BlockInfo(reason: .channelNotEntitled)
            }
        }
        return nil
    }

    /// `nil` unless all three timestamps are present — the "token held, nothing cached yet" rows.
    private func buildDoc(_ l: LicenseInputs) -> LicenseDoc? {
        guard let issuedAt = l.issuedAt, let expiresAt = l.expiresAt,
            let graceUntil = l.graceUntil
        else { return nil }
        return LicenseDoc(
            aud: "djdl", deviceId: "dev_matrix", issuedAt: issuedAt, expiresAt: expiresAt,
            graceUntil: graceUntil, licenseId: "lic_matrix")
    }

    // ── The parity assertions ────────────────────────────────────────────────────────
    func testGateMatrixIsV2AndPopulated() throws {
        let matrix = try loadMatrix()
        XCTAssertEqual(matrix.gateMatrixVersion, 2)
        XCTAssertFalse(matrix.rows.isEmpty)
    }

    func testGateMatrixParityAcrossEveryRow() throws {
        for row in try loadMatrix().rows {
            let blocked = checkBuildGate(row.gate)
            let state = licenseState(
                GateInput(
                    licenseServiceEnabled: row.license.licenseServiceEnabled,
                    activation: row.license.activation,
                    doc: buildDoc(row.license),
                    now: row.license.now,
                    lastSyncUnauthorized: row.license.lastSyncUnauthorized ?? false,
                    blocked: blocked,
                    lastVerifiedAt: row.license.lastVerifiedAt))

            XCTAssertEqual(state.status.rawValue, row.expect.status, row.name)
            XCTAssertEqual(isUsable(state), row.expect.ok, "\(row.name) usable")
            if let reason = row.expect.reason {
                // `expect.reason` names the build-gate hint that was DERIVED, which on the last
                // row is deliberately NOT the status — that is the ordering v3 changed.
                XCTAssertEqual(blocked?.reason, reason, "\(row.name) reason")
            }
            XCTAssertEqual(
                state.allowedRange, row.expect.allowedRange, "\(row.name) allowedRange")
        }
    }

    /// The rows that only v2 could express, asserted by NAME so a corpus that quietly dropped
    /// one is caught rather than silently passing a smaller matrix.
    func testMatrixCoversTheV3Additions() throws {
        let names = Set(try loadMatrix().rows.map(\.name))
        for fragment in [
            "not-applicable — license service disabled, nothing cached",
            "not-applicable — license service disabled even with a valid document cached",
            "ok — bundle activation inside the document window",
            "grace — bundle activation past expiresAt, inside graceUntil",
            "expired — bundle activation past graceUntil (the air-gapped install runs out)",
            "needs-activation — unactivated device with a build block (activation precedes blocked)",
        ] {
            XCTAssertTrue(names.contains(fragment), "gate-matrix v2 must carry: \(fragment)")
        }
    }
}
