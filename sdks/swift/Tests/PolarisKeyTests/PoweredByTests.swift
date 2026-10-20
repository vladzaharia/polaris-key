// @pkey-feature ui.kit ui.theme
//
// The Polaris Locker attribution (LK-16, UI-KITS §1.6): the line draws the Locker micro mark and the
// phrase, the badge draws at 320 × 104 and only where 320 points are free (else the line), and Key's
// own "Powered by" artwork is not offered. Renders go through `ImageRenderer`; set
// `PKEY_SHOTS=<dir>` to also write them as PNGs.

#if canImport(SwiftUI)
import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import XCTest

@testable import PolarisKeyUI

@MainActor
final class PoweredByTests: XCTestCase {
    private func render<V: View>(_ view: V, width: CGFloat, height: CGFloat, scheme: ColorScheme, name: String)
        -> CGImage?
    {
        let content = view.padding(16).frame(width: width, height: height)
            .background(scheme == .dark ? Color(red: 0.024, green: 0.035, blue: 0.071) : Color.white)
            .environment(\.colorScheme, scheme)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        guard let image = renderer.cgImage else { return nil }
        if let dir = ProcessInfo.processInfo.environment["PKEY_SHOTS"],
            let dest = CGImageDestinationCreateWithURL(
                URL(fileURLWithPath: dir).appendingPathComponent("swift.\(name).png") as CFURL,
                UTType.png.identifier as CFString, 1, nil)
        {
            CGImageDestinationAddImage(dest, image, nil)
            CGImageDestinationFinalize(dest)
        }
        return image
    }

    /// Pixels whose red channel dominates (the Locker coral is `#ff7869` on dark, `#c44438` on light).
    private func coralPixels(_ image: CGImage) -> Int {
        let w = image.width, h = image.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        guard
            let ctx = CGContext(
                data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return 0 }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        var n = 0
        for i in stride(from: 0, to: data.count, by: 4)
        where Int(data[i]) > Int(data[i + 1]) + 50 && Int(data[i]) > Int(data[i + 2]) + 30 { n += 1 }
        return n
    }

    func testTheLineDrawsTheLockerMarkAndThePhrase() throws {
        for scheme in [ColorScheme.dark, .light] {
            let image = try XCTUnwrap(
                render(
                    PolarisPoweredByAttribution(style: .line), width: 300, height: 56, scheme: scheme,
                    name: "line-\(scheme == .dark ? "dark" : "light")"))
            XCTAssertEqual(image.width, 600)
            XCTAssertGreaterThan(coralPixels(image), 20, "the micro mark's coral body is drawn (\(scheme))")
        }
    }

    func testTheBadgeDrawsWhere320PointsAreFreeAndTheLineElsewhere() throws {
        let wide = try XCTUnwrap(
            render(
                PolarisPoweredByAttribution(style: .badge), width: 400, height: 140, scheme: .dark,
                name: "badge-400-dark"))
        let narrow = try XCTUnwrap(
            render(
                PolarisPoweredByAttribution(style: .badge), width: 300, height: 140, scheme: .dark,
                name: "badge-300-dark"))
        _ = try XCTUnwrap(
            render(
                PolarisPoweredByAttribution(style: .badge), width: 400, height: 140, scheme: .light,
                name: "badge-400-light"))
        // The badge's mark is 32 pt at 1x: far more coral than the 16 pt micro mark in the line.
        XCTAssertGreaterThan(coralPixels(wide), coralPixels(narrow) * 2)
        XCTAssertGreaterThan(coralPixels(narrow), 20, "under 320 pt the line is drawn")
    }

    func testKeyArtworkIsNotBundledForIntegrators() {
        for path in ["powered-by/transparent/compact-dark", "powered-by/sticker/stacked-light"] {
            XCTAssertNil(brandResourceURL(path + ".png"), path)
        }
    }

    func testTheKitsPoweredByPartFollowsTheTheme() throws {
        var line = KitResolvedStyle.fallback
        line.poweredBy = .line
        var badge = KitResolvedStyle.fallback
        badge.poweredBy = .badge
        for (style, name) in [(line, "kit-line"), (badge, "kit-badge")] {
            let view = PoweredBy().environment(\.polarisKeyStyle, style)
            XCTAssertNotNil(render(view, width: 400, height: 140, scheme: .dark, name: "\(name)-dark"), name)
            XCTAssertNotNil(render(view, width: 400, height: 140, scheme: .light, name: "\(name)-light"), name)
        }
    }
}
#endif
