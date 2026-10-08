// @pkey-feature license.gate
// Cross-SDK gate parity — wire contract v3 §5, driven off `conformance/corpus/v2`'s
// `gate-matrix.json` (version 2, 38 rows).
//
// Each row carries the BUILD-gate inputs (version/channel/compat window/entitlements) and the
// LICENSE-state inputs, paired with one expected decision. The first fourteen rows are corpus
// v1's matrix carried verbatim under the smallest possible shim — `licenseServiceEnabled: true`
// and `hasToken → activation` — so a v3 gate that changes any v2 decision goes red here (P0-04
// retired a fifteenth, the pre-R3-01 dev bypass). The next six pin what v1 could not express:
// `not-applicable` (D-08), `activation: "bundle"` (§7), and the one ordering v3 changed — the
// activation guard runs BEFORE the unsigned `blocked` hint. The last eighteen pin the channel
// vocabulary of WIRE-CONTRACT-V3 §5.1 (P0-04).
//
// The build-gate half is a PORT: `checkBuildGate` mirrors the Worker's, rebuilt from `Semver.*`,
// with the fixture as the oracle (the Worker replays the same rows through its real gate in
// `packages/worker/test/gateMatrixCorpus.test.ts`). The Node and Python runners port the same
// lines. That duplication is deliberate — the point of the matrix is that independent
// implementations agree, and a shared helper would prove only that they share a helper.

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
        try CorpusLocator.load(GateMatrix.self, "gate-matrix")
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
    // WIRE-CONTRACT-V3 §5.1 rules 2–5, over plain strings (not `Channel`, which is the coarse
    // family an SDK sends).
    private static let channelAliases = ["staging": "beta", "latest": "stable"]
    private static let prNumberMaxDigits = 7

    private func firstGroup(_ pattern: String, _ s: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern),
            let m = re.firstMatch(in: s, range: NSRange(s.startIndex..<s.endIndex, in: s)),
            let r = Range(m.range(at: 1), in: s)
        else { return nil }
        return String(s[r])
    }
    private func matches(_ pattern: String, _ s: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }
    private func prChannel(_ digits: String) -> String {
        digits.count > Self.prNumberMaxDigits ? "pr" : "pr-\(digits)"
    }
    /// §5.1 rule 2: the family, with a PR build narrowed to its own `pr-<n>`.
    private func impliedChannel(_ version: String) -> String {
        let family = Semver.channelForVersion(version).rawValue
        guard family == "pr" else { return family }
        return firstGroup(#"^0\.0\.0-pr-?([0-9]+)"#, version).map(prChannel) ?? "pr"
    }
    /// §5.1 rule 3: `nil` is a malformed header, which the gate refuses.
    private func normalizeChannelHeader(_ header: String, _ version: String) -> String? {
        if let alias = Self.channelAliases[header] { return alias }
        if header == "pr" {
            let implied = impliedChannel(version)
            return matches(#"^pr-[0-9]+$"#, implied) ? implied : "pr"
        }
        if let digits = firstGroup(#"^pr-?([0-9]+)$"#, header) { return prChannel(digits) }
        return matches(#"^[a-z0-9][a-z0-9-]{0,63}$"#, header) ? header : nil
    }
    /// §5.1 rule 4: `stable` always; exact name; `staging` covers `beta`; `pr` covers `pr-<n>`.
    private func channelEntitled(_ granted: [String], _ channel: String) -> Bool {
        if channel == "stable" || granted.contains(channel) { return true }
        if channel == "beta" && granted.contains("staging") { return true }
        return matches(#"^pr-[0-9]+$"#, channel) && granted.contains("pr")
    }

    /// §5.1 rule 5, in order: dev bypass by grant, version window, malformed header, channels.
    private func checkBuildGate(_ g: GateInputs) -> BlockInfo? {
        let granted = arrEnt(g.entitlements["channels"]) ?? ["stable"]
        if Semver.isDevBuild(g.version) && granted.contains("dev") { return nil }
        let minV = tighterMin(g.compatMin, strEnt(g.entitlements["app.minVersion"]))
        let maxV = tighterMax(g.compatMax, strEnt(g.entitlements["app.maxVersion"]))
        let range = AllowedRange(min: minV, max: maxV)
        if let minV, Semver.compare(g.version, minV) < 0 {
            return BlockInfo(reason: .versionTooOld, allowedRange: range)
        }
        if let maxV, Semver.compare(g.version, maxV) > 0 {
            return BlockInfo(reason: .versionTooNew, allowedRange: range)
        }
        var declared: String?
        if let header = g.channel {
            guard let normalized = normalizeChannelHeader(header, g.version) else {
                return BlockInfo(reason: .channelNotEntitled)
            }
            declared = normalized
        }
        for channel in Set([impliedChannel(g.version), declared].compactMap { $0 }) {
            if !channelEntitled(granted, channel) {
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
                // `expect.reason` names the build-gate hint that was DERIVED, which on the
                // activation-precedes-blocked row is deliberately NOT the status — that is the
                // ordering v3 changed.
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

    /// The channel rows P0-04 appended (WIRE-CONTRACT-V3 §5.1), asserted by NAME, and the
    /// carried pre-R3-01 dev-bypass row it retired.
    func testMatrixCoversTheP004ChannelRows() throws {
        let rows = try loadMatrix().rows
        let names = Set(rows.map(\.name))
        XCTAssertEqual(rows.count, 38)
        for name in [
            "ok — beta header, channels [stable, beta]",
            "ok — beta header, channels [stable, staging] (alias)",
            "ok — staging header, channels [stable, beta] (alias)",
            "channel-not-entitled — beta header, channels [stable]",
            "ok — manual channel header, entitled by name",
            "channel-not-entitled — manual channel header, not entitled",
            "channel-not-entitled — malformed channel header",
            "ok — 0.0.0-beta build with beta entitlement",
            "channel-not-entitled — 0.0.0-beta build without a beta entitlement",
            "ok — 0.0.0-staging build is the beta channel, channels [stable, beta]",
            "ok — latest header is the stable channel",
            "ok — pr-42 header, channels grant the pr family",
            "ok — pr header on a 0.0.0-pr-42 build, channels [stable, pr-42]",
            "channel-not-entitled — pr-7 header, channels grant only pr-42",
            "channel-not-entitled — stable header cannot loosen a 0.0.0-pr-42 build",
            "channel-not-entitled — dev header without the dev entitlement",
            "version-too-old — dev build without the dev entitlement gets no bypass (R3-01)",
            "ok — dev build with the dev entitlement bypasses the window (R3-01)",
        ] {
            XCTAssertTrue(names.contains(name), "gate-matrix v2 must carry: \(name)")
        }
        XCTAssertFalse(
            names.contains(
                "ok — dev build bypasses the gate despite an out-of-range window + non-entitled channel"
            ))
    }
}
