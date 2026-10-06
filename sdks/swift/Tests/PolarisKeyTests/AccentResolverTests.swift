// @pkey-feature ui.kit
// The Swift port of the accent resolver (UI-KITS.md §3.3) against the shared vectors
// (AccentVectors.generated.swift, from packages/brand/fixtures/accent-vectors.json), and the kit
// tokens (KitTokens.generated.swift) against the generator's tokens.json.

import Foundation
@testable import PolarisKeyUI
import XCTest

final class AccentResolverTests: XCTestCase {
    func testDeriveVectors() {
        for v in AccentVectors.derive {
            var rgba: [UInt8] = []
            for run in v.pixels {
                for _ in 0..<run[4] { rgba += [UInt8(run[0]), UInt8(run[1]), UInt8(run[2]), UInt8(run[3])] }
            }
            XCTAssertEqual(PolarisAccent.derive(rgba: rgba), v.expect, v.name)
        }
    }

    func testResolveVectors() throws {
        for v in AccentVectors.resolve {
            let r = try XCTUnwrap(PolarisAccent.resolve(v.input, dark: v.dark), v.name)
            let scheme = v.dark ? "dark" : "light"
            XCTAssertEqual(r.solid, v.solid, "\(v.name) \(scheme) solid")
            XCTAssertEqual(r.on, v.on, "\(v.name) \(scheme) on")
            XCTAssertEqual(r.fg, v.fg, "\(v.name) \(scheme) fg")
            XCTAssertEqual(r.subtle, v.subtle, "\(v.name) \(scheme) subtle")
            XCTAssertEqual(r.focus, v.focus, "\(v.name) \(scheme) focus")
        }
    }

    func testDangerSolidKeepsAWhiteLabel() {
        for v in AccentVectors.danger {
            XCTAssertEqual(PolarisAccent.solid(v.input, dark: v.dark, label: .white), v.solid)
        }
        XCTAssertEqual(PolarisKit.Dark.dangerSolid.hex, 0xdb3a2b)
        XCTAssertEqual(PolarisKit.Light.dangerSolid.hex, 0xbe2323)
    }

    /// The pinned rule: a product's primary label is the same colour in both schemes.
    func testOnIsTheSameInBothSchemes() throws {
        for v in AccentVectors.resolve {
            let dark = try XCTUnwrap(PolarisAccent.resolve(v.input, dark: true))
            let light = try XCTUnwrap(PolarisAccent.resolve(v.input, dark: false))
            XCTAssertEqual(dark.on, light.on, v.name)
        }
    }

    func testInvalidInputResolvesToNil() {
        XCTAssertNil(PolarisAccent.resolve("teal", dark: true))
        XCTAssertNil(PolarisAccent.resolve("#12345", dark: true))
        XCTAssertNotNil(PolarisAccent.resolve("#F60", dark: true))
    }

    /// The committed kit tokens are the generator's: the values agree with packages/brand/tokens.json.
    func testKitTokensMatchTheGenerator() throws {
        let json = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("packages/brand/tokens.json")
        guard FileManager.default.fileExists(atPath: json.path) else {
            throw XCTSkip("packages/brand is not beside this package (a standalone copy)")
        }
        let root = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(contentsOf: json)) as? [String: Any])
        let kit = try XCTUnwrap(root["kit"] as? [String: Any])
        let components = try XCTUnwrap(kit["components"] as? [String: [String: Any]])
        func number(_ platform: String, _ group: String, _ key: String) throws -> Double {
            let g = try XCTUnwrap(components[platform]?[group] as? [String: Any])
            return try XCTUnwrap(g[key] as? Double)
        }
        XCTAssertEqual(PolarisKit.IOS.controlHeight, try number("ios", "controlHeight", "default"))
        XCTAssertEqual(PolarisKit.IOS.radiusSheet, try number("ios", "radiusSurface", "sheet"))
        XCTAssertEqual(PolarisKit.IOS.cardPad, try number("ios", "cardPad", "default"))
        XCTAssertEqual(PolarisKit.MacOS.controlHeightHero, try number("macos", "controlHeight", "hero"))
        XCTAssertEqual(PolarisKit.MacOS.radiusSheet, try number("macos", "radiusSurface", "sheet"))
        XCTAssertEqual(PolarisKit.IOS.radiusControl, .capsule)
        let type = try XCTUnwrap(kit["typeScale"] as? [String: [String: [String: Any]]])
        let title = try XCTUnwrap(type["ios"]?["title"])
        XCTAssertEqual(PolarisKit.IOS.Typography.title.size, title["size"] as? Double)
        XCTAssertEqual(PolarisKit.IOS.Typography.title.weight, title["weight"] as? Int)
        let danger = try XCTUnwrap(kit["danger"] as? [String: [String: String]])
        XCTAssertEqual(PolarisAccent.hexString(PolarisKit.Dark.dangerSolid.hex), danger["dark"]?["solid"])
        XCTAssertEqual(PolarisAccent.hexString(PolarisKit.Light.dangerSolid.hex), danger["light"]?["solid"])
        let surfaces = try XCTUnwrap(kit["accentSurfaces"] as? [String: [String]])
        XCTAssertEqual(PolarisAccent.surfaces(dark: true), surfaces["dark"])
        XCTAssertEqual(PolarisAccent.surfaces(dark: false), surfaces["light"])
    }

    func testConcentricRule() {
        XCTAssertEqual(PolarisKit.concentricRadius(outer: 22, inset: 6), 16)
        XCTAssertEqual(PolarisKit.concentricRadius(outer: 10, inset: 6), 8)
    }
}
