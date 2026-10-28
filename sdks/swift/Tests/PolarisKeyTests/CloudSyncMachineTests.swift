// @pkey-feature sync.scenarios
//
// Machine-level regressions that are not corpus rows. X-1 (SEC-HOST2): a conflict's `server` copy is
// judged against the push's own in-flight cursor, so a plaintext copy is legacy only while that
// cursor is below `encryptionSince`. When X-1.1 lands, the corpus row
// `e2e-conflict-plaintext-copy-refused` pins the same thing; this stays as a short regression.

import Foundation
import PolarisKeyCore
import XCTest

final class CloudSyncMachineTests: XCTestCase {
    /// An E2E machine for `sub_alice`, the Worker confirmed `e2e`, with one synced string setting. A
    /// first pull answers `cursor` and `encryptionSince: 1`; then `ui.theme` is set and pushed.
    private func pushedMachine(cursor: Int) throws -> CloudSyncMachine {
        var o = SyncMachineOptions(
            product: "demo",
            catalog: SyncMachineCatalog(settings: [
                SettingRoute(key: "ui.theme", route: .synced, scope: .user, policy: .lastWrite)
            ]),
            document: SyncMachineDocument(values: ["ui.theme": .string("doc")]), now: 1_760_000_000_000,
            newClientId: { "c_000000000000000client1" })
        o.subject = "sub_alice"
        o.contacted = true
        o.hasRoot = true
        o.discovery = .e2e
        let m = try CloudSyncMachine(o)
        XCTAssertEqual(m.takeRequests().count, 1, "the first pull")
        try m.receive(
            .answer(
                status: 200,
                body: .object(["encryption": .string("e2e"), "cursor": .int(cursor), "encryptionSince": .int(1)])))
        _ = m.takeRequests()
        XCTAssertEqual(m.set("ui.theme", .string("mine")), .ok)
        m.advance(SYNC_DEBOUNCE_MS)
        XCTAssertEqual(m.takeRequests().count, 1, "the push")
        return m
    }

    private func conflict(_ m: CloudSyncMachine) throws {
        let body: JSONValue = .object([
            "encryption": .string("e2e"),
            "results": .array([
                .object([
                    "mutationId": .int(1), "status": .string("conflict"),
                    "server": .object(["version": .int(0), "value": .string("evil")]),
                ])
            ]),
        ])
        // The host found no `ct` on the copy; it maps the row's sequence to 0, below `encryptionSince`.
        try m.receive(
            .answer(status: 200, body: body),
            opened: SyncOpenedBody(conflicts: [1: SyncOpenedRow(seq: 0)]))
    }

    func testConflictCopyPlaintextNeedsCursorBelowSince() throws {
        let m = try pushedMachine(cursor: 50)
        try conflict(m)
        let v = m.get("ui.theme")
        XCTAssertNotEqual(v.from, .cloud, "a plaintext conflict copy read at cursor 50 is forged")
        XCTAssertEqual(v, SyncEffectiveValue(value: .string("doc"), from: .document))
        XCTAssertTrue(m.settingState("ui.theme").invalid)
    }

    func testConflictCopyPlaintextControlReadsAsLegacyBelowSince() throws {
        let m = try pushedMachine(cursor: 0)
        try conflict(m)
        XCTAssertEqual(m.get("ui.theme"), SyncEffectiveValue(value: .string("evil"), from: .cloud))
    }
}
