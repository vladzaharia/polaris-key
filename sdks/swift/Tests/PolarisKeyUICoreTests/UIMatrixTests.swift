// @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall ui.theme ui.i18n
//
// The Swift presentation core against conformance/corpus/v2/ui-matrix.json (plans/UK-02b.md §5):
// every row of all ten families, never skipping one. Component rows compare the component, the
// state, the sorted copy keys and the sorted actions; a `mustNot` row also asserts that none of its
// forbidden states, copy keys or actions appear. `theme` rows compare the resolved name, accent
// source, scheme, icon and preset; `i18n` rows the formatted string.
//
// Families: gate, activate, signIn, deviceLimit, devices, update, settings, paywall, theme, i18n.

import Foundation
import PolarisKeyUICore
import XCTest

final class UIMatrixTests: XCTestCase {
    /// A row the generator wrote against its own vocabulary and the wire: reported, never adopted.
    /// Each entry must still differ from the row exactly as recorded, so a corrected corpus fails
    /// here until the entry goes.
    ///
    /// - `Activate/parsed`: the row's key `pkey_tidewater_Q2xvdWRzT3ZlclRoZUhp` has a 20-character
    ///   secret, but the vocabulary ("a 22-character secret") and the Worker's
    ///   `LICENSE_KEY_SHAPE` (`[A-Za-z0-9_-]{22}`) need 22, so the field is still `typing`
    ///   (Node's `keyVerdict` agrees). The fix is a 22-character `KEY` in `tools/ui-matrix.ts`.
    static let knownCorpusDefects: [String: (state: String, copy: [String])] = [
        "Activate/parsed": (state: "typing", copy: ["activate.submit", "part.keyField.label"])
    ]

    static let families = [
        "gate", "activate", "signIn", "deviceLimit", "devices", "update", "settings", "paywall",
    ]

    func testTheMatrixIsTheVersionTheCoreImplements() throws {
        let matrix = try UIMatrix.load()
        XCTAssertEqual(matrix.version, PolarisKeyUICore.uiMatrixVersion)
    }

    func testGateFamily() throws { try runFamily("gate") }
    func testActivateFamily() throws { try runFamily("activate") }
    func testSignInFamily() throws { try runFamily("signIn") }
    func testDeviceLimitFamily() throws { try runFamily("deviceLimit") }
    func testDevicesFamily() throws { try runFamily("devices") }
    func testUpdateFamily() throws { try runFamily("update") }
    func testSettingsFamily() throws { try runFamily("settings") }
    func testPaywallFamily() throws { try runFamily("paywall") }

    func testThemeFamily() throws {
        let matrix = try UIMatrix.load()
        let rows = try XCTUnwrap(matrix.raw["theme"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["name"] as? String ?? "?"
            var input = try XCTUnwrap(row["input"] as? [String: Any])
            let kit = try XCTUnwrap(KitKind(rawValue: input.removeValue(forKey: "kit") as? String ?? ""))
            let preset = (input.removeValue(forKey: "preset") as? String).flatMap(KitPreset.init)
            let scheme = (input.removeValue(forKey: "colorScheme") as? String).flatMap(
                KitColorScheme.init)
            let inputs = try matrix.inputs(input)
            let theme = KitIdentity.theme(inputs, kit: kit, preset: preset, colorScheme: scheme)
            let expect = try XCTUnwrap(row["expect"] as? [String: Any])
            XCTAssertEqual(theme.name, expect["name"] as? String, name)
            XCTAssertEqual(theme.accentSource.rawValue, expect["accentSource"] as? String, name)
            XCTAssertEqual(theme.colorScheme.rawValue, expect["colorScheme"] as? String, name)
            XCTAssertEqual(theme.icon.rawValue, expect["icon"] as? String, name)
            XCTAssertEqual(theme.preset.rawValue, expect["preset"] as? String, name)
        }
    }

    func testI18nFamily() throws {
        let matrix = try UIMatrix.load()
        let rows = try XCTUnwrap(matrix.raw["i18n"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["name"] as? String ?? "?"
            let locale = try XCTUnwrap(row["locale"] as? String)
            let key = try XCTUnwrap(row["key"] as? String)
            var args: [String: CopyArgument] = [:]
            for (k, v) in row["args"] as? [String: Any] ?? [:] {
                if let n = v as? Int {
                    args[k] = .number(n)
                } else {
                    args[k] = .text("\(v)")
                }
            }
            let overrides = row["overrides"] as? [String: [String: String]] ?? [:]
            let catalog = KitCopy.bundled.overriding(overrides)
            XCTAssertEqual(
                catalog.format(key, locale: locale, args: args), row["expect"] as? String, name)
        }
    }

    // MARK: - The component families

    private func runFamily(_ family: String) throws {
        let matrix = try UIMatrix.load()
        let rows = try XCTUnwrap(matrix.raw[family] as? [[String: Any]], family)
        XCTAssertFalse(rows.isEmpty, family)
        var defectsSeen: Set<String> = []
        for row in rows {
            let name = row["name"] as? String ?? "?"
            let expect = try XCTUnwrap(row["expect"] as? [String: Any], name)
            let component = try XCTUnwrap(
                KitComponent(rawValue: expect["component"] as? String ?? ""), name)
            let inputs = try matrix.inputs(row["input"] as? [String: Any] ?? [:])
            let got = KitStates.resolve(component, inputs)
            let state = try XCTUnwrap(expect["state"] as? String, name)
            let copy = (expect["copy"] as? [String] ?? []).sorted()
            let actions = (expect["actions"] as? [String] ?? []).sorted()

            if let defect = Self.knownCorpusDefects[name] {
                defectsSeen.insert(name)
                XCTAssertEqual(got.state, defect.state, "\(name): the recorded defect changed")
                XCTAssertEqual(got.copyKeys, defect.copy.sorted(), "\(name): the recorded defect changed")
                XCTAssertNotEqual(
                    got.state, state, "\(name) now passes: remove it from knownCorpusDefects")
                continue
            }

            XCTAssertEqual(got.component, component, name)
            XCTAssertEqual(got.state, state, name)
            XCTAssertEqual(got.copyKeys, copy, name)
            XCTAssertEqual(got.actions.map(\.rawValue).sorted(), actions, name)
            if state == "hidden" {
                XCTAssertTrue(got.copy.isEmpty && got.actions.isEmpty, "\(name): hidden renders nothing")
            }
            if let mustNot = row["mustNot"] as? [String: Any] {
                for forbidden in mustNot["states"] as? [String] ?? [] {
                    XCTAssertNotEqual(got.state, forbidden, "\(name): Must not")
                }
                for forbidden in mustNot["copy"] as? [String] ?? [] {
                    XCTAssertFalse(got.copyKeys.contains(forbidden), "\(name): Must not \(forbidden)")
                }
                for forbidden in mustNot["actions"] as? [String] ?? [] {
                    XCTAssertFalse(
                        got.actions.map(\.rawValue).contains(forbidden), "\(name): Must not \(forbidden)")
                }
            }
        }
        let expectedDefects = Set(
            Self.knownCorpusDefects.keys.filter { key in
                rows.contains { $0["name"] as? String == key }
            })
        XCTAssertEqual(defectsSeen, expectedDefects, family)
    }
}

/// conformance/corpus/v2/ui-matrix.json, read in place (the corpus is never copied).
struct UIMatrix {
    let raw: [String: Any]
    let defaults: [String: Any]

    var version: Int? { raw["uiMatrixVersion"] as? Int }

    static func load() throws -> UIMatrix {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        url.appendPathComponent("conformance/corpus/v2/ui-matrix.json")
        let data = try Data(contentsOf: url)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let vocabulary = try XCTUnwrap(raw["vocabulary"] as? [String: Any])
        let defaults = try XCTUnwrap(vocabulary["defaults"] as? [String: Any])
        return UIMatrix(raw: raw, defaults: defaults)
    }

    /// A row's input over `vocabulary.defaults`: a member the row omits takes the default, and
    /// `capabilities` merges member by member. An explicit `null` (no presentation) stays null.
    func inputs(_ row: [String: Any]) throws -> KitInputs {
        var merged = defaults
        for (key, value) in row {
            if key == "capabilities", let base = defaults[key] as? [String: Any],
                let more = value as? [String: Any]
            {
                merged[key] = base.merging(more) { _, new in new }
            } else {
                merged[key] = value
            }
        }
        let data = try JSONSerialization.data(withJSONObject: merged)
        return try JSONDecoder().decode(KitInputs.self, from: data)
    }
}
