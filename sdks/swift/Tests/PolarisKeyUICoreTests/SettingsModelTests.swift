// @pkey-feature ui.settings ui.devices
// The settings drop-in's model: the ChannelPicker's locked reasons (decision 6), host-dependent
// rows only with a handler (decision 7), and the catalog's typed rows.

import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyUICore
import XCTest

@MainActor
final class SettingsModelTests: XCTestCase {
    func testTheStoreFixesTheChannelAndSaysSo() {
        let state = KitChannelState.resolve(
            current: "stable", entitled: ["stable", "beta"], store: "App Store", canSelect: true)
        XCTAssertEqual(
            state,
            .locked(
                current: "stable",
                reason: CopyLine("channel.locked", ["store": .text("App Store")])))
    }

    func testALicenseWithOneChannelLocksTheRow() {
        let state = KitChannelState.resolve(
            current: "stable", entitled: ["stable"], store: nil, canSelect: true)
        XCTAssertEqual(state, .locked(current: "stable", reason: CopyLine("channel.lockedLicense")))
    }

    func testAChoiceNeedsAHostHandlerElseItIsAValue() {
        XCTAssertEqual(
            KitChannelState.resolve(
                current: "stable", entitled: ["stable", "beta"], store: nil, canSelect: true),
            .choose(current: "stable", options: ["stable", "beta"]))
        XCTAssertEqual(
            KitChannelState.resolve(
                current: "stable", entitled: ["stable", "beta"], store: nil, canSelect: false),
            .value("stable"))
    }

    func testAnUnknownLicenseDrawsNoChannelRow() {
        XCTAssertEqual(
            KitChannelState.resolve(current: "stable", entitled: nil, store: nil, canSelect: true),
            .hidden)
    }

    func testTheRunningChannelIsAlwaysAnOption() {
        XCTAssertEqual(
            KitChannelState.resolve(
                current: "beta", entitled: ["stable"], store: nil, canSelect: true),
            .choose(current: "beta", options: ["beta", "stable"]))
    }

    func testHandlersAreEmptyUntilTheHostPassesOne() {
        XCTAssertTrue(KitSettingsHandlers().isEmpty)
        let model = PolarisKeySettingsModel(
            preview: PolarisKeyPreviewState.base(),
            handlers: KitSettingsHandlers(manage: {}))
        XCTAssertTrue(model.canManage)
        XCTAssertFalse(model.canSetAutoUpdate)
        XCTAssertFalse(
            PolarisKeySettingsModel(preview: PolarisKeyPreviewState.base()).canManage)
    }

    func testAutoUpdateReportsToTheHost() {
        var seen: Bool?
        let model = PolarisKeySettingsModel(
            preview: PolarisKeyPreviewState.base(),
            handlers: KitSettingsHandlers(autoUpdate: { seen = $0 }))
        model.setAutoUpdate(false)
        XCTAssertEqual(seen, false)
        XCTAssertFalse(model.autoUpdate)
    }

    private func entry(_ json: String) throws -> ConfigCatalogEntry {
        try JSONDecoder().decode(ConfigCatalogEntry.self, from: Data(json.utf8))
    }

    func testCatalogEntriesBecomeTypedRows() throws {
        let slider = try entry(
            #"{"key":"audio.volume","kind":"config","category":"audio","label":"Volume","description":"","schema":{"type":"integer","minimum":0,"maximum":100}}"#
        )
        let row = PolarisKeySettingsModel.row(
            slider, state: ConfigSettingState(value: .int(80), source: .local, locked: false),
            org: "Harbor Audio")
        XCTAssertEqual(row?.type, "number")
        XCTAssertEqual(row?.min, 0)
        XCTAssertEqual(row?.max, 100)
        XCTAssertEqual(row?.value, .number(80))
        XCTAssertEqual(row?.source, "local")
        XCTAssertEqual(row?.label, "Volume")
        XCTAssertNil(row?.org)

        let pick = try entry(
            #"{"key":"render.quality","kind":"config","category":"video","label":"Quality","description":"","schema":{"type":"string","enum":["Low","High"]}}"#
        )
        let locked = PolarisKeySettingsModel.row(
            pick, state: ConfigSettingState(value: .string("High"), source: .enforced, locked: true),
            org: "Harbor Audio")
        XCTAssertEqual(locked?.type, "select")
        XCTAssertEqual(locked?.locked, true)
        XCTAssertEqual(locked?.org, "Harbor Audio")
        XCTAssertEqual(locked?.source, "enforced")

        let object = try entry(
            #"{"key":"x.blob","kind":"config","category":"x","label":"Blob","description":"","schema":{"type":"object"}}"#
        )
        XCTAssertNil(
            PolarisKeySettingsModel.row(
                object, state: ConfigSettingState(value: nil, source: .fallback, locked: false),
                org: "a"))
    }

    func testPreviewDevicesAreReadBack() {
        let model = PolarisKeySettingsModel(
            preview: PolarisKeyPreviewState.base { $0.devices = PolarisKeyPreviewState.devices })
        XCTAssertEqual(model.deviceRows.count, 3)
        XCTAssertEqual(model.deviceIds.count, 3)
    }
}
