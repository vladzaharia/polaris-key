// @pkey-feature connect.local
// The QR view of a window that ran out (UI-KITS 4.9): the code is blurred past reading, faded and dimmed, so Apple's barcode
// reader (the one behind the iPhone camera) finds nothing, over the light page and the dark one; the live card decodes.
// The link colour keeps 5.0:1 on the page the iOS kit draws.

#if os(macOS)
    import AppKit
    import SwiftUI
    import Vision
    import XCTest

    @testable import PolarisKeyUI

    @MainActor
    final class ExpiredQrTests: XCTestCase {
        private let text = "PKP1:TIDEWATER:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y"

        /// The image with its levels stretched to the full range, the way a camera's auto-exposure would see it.
        private func stretched(_ image: CGImage) throws -> CGImage {
            let width = image.width
            let height = image.height
            var pixels = [UInt8](repeating: 0, count: width * height)
            let gray = CGColorSpaceCreateDeviceGray()
            try pixels.withUnsafeMutableBytes { buffer in
                let ctx = try XCTUnwrap(
                    CGContext(
                        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                        bytesPerRow: width, space: gray, bitmapInfo: CGImageAlphaInfo.none.rawValue))
                ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            }
            let low = Double(pixels.min() ?? 0)
            let span = max(Double(pixels.max() ?? 255) - low, 1)
            pixels = pixels.map { UInt8(min(max((Double($0) - low) / span * 255, 0), 255)) }
            return try pixels.withUnsafeMutableBytes { buffer in
                let ctx = try XCTUnwrap(
                    CGContext(
                        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                        bytesPerRow: width, space: gray, bitmapInfo: CGImageAlphaInfo.none.rawValue))
                return try XCTUnwrap(ctx.makeImage())
            }
        }

        private func decode(_ image: CGImage) throws -> [String] {
            let request = VNDetectBarcodesRequest()
            request.symbologies = [.qr]
            try VNImageRequestHandler(cgImage: image).perform([request])
            return (request.results ?? []).compactMap(\.payloadStringValue)
        }

        private func payloads(faded: Bool, ground: Color, scale: CGFloat = 2, stretch: Bool = false) throws -> [String] {
            let view = ExpiredFadeQR(text: text, label: "QR", faded: faded)
                .frame(width: 320, height: 320)
                .padding(40)
                .background(ground)
            let renderer = ImageRenderer(content: view)
            renderer.scale = scale
            let image = try XCTUnwrap(renderer.cgImage)
            return try decode(stretch ? stretched(image) : image)
        }

        /// The pages the kit draws: light (the grouped page under the accent's wash), dark and plain white.
        private var grounds: [(String, Color)] {
            [
                ("light", Color(.sRGB, red: 236 / 255, green: 240 / 255, blue: 245 / 255, opacity: 1)),
                ("dark", Color.black), ("white", Color.white),
            ]
        }

        func testTheLiveCardDecodes() throws {
            for (name, ground) in grounds {
                XCTAssertEqual(try payloads(faded: false, ground: ground), [text], name)
                XCTAssertEqual(try payloads(faded: false, ground: ground, stretch: true), [text], "\(name) stretched")
            }
        }

        func testTheExpiredCardDoesNotDecodeOverAnyPage() throws {
            for (name, ground) in grounds {
                XCTAssertEqual(try payloads(faded: true, ground: ground), [], name)
                XCTAssertEqual(try payloads(faded: true, ground: ground, scale: 1), [], "\(name) at 1x")
                // And with the levels stretched to the full range (a camera's auto-exposure).
                XCTAssertEqual(try payloads(faded: true, ground: ground, stretch: true), [], "\(name) stretched")
                XCTAssertEqual(try payloads(faded: true, ground: ground, scale: 1, stretch: true), [], "\(name) stretched at 1x")
            }
        }

        /// 5.0:1 for every accent on the washed page, so a link keeps 4.5:1 in the glass primary's shadow.
        func testTheLightLinkColourKeepsFiveToOneOnTheDrawnPage() {
            func lin(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
            func lum(_ r: Double, _ g: Double, _ b: Double) -> Double { 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) }
            for hex: UInt32 in [0x23786e, 0x2f8f83, 0x5b8def, 0xd07a00, 0x7a2fff, 0x3a8a3a] {
                let subtle = BrandColor(hex: 0xe6f1ef)
                let out = KitPaletteResolver.headroom(BrandColor(hex: hex), over: subtle, applies: true)
                func mix(_ a: Double, _ b: Double) -> Double { a * 0.65 + b * 0.35 }
                let page = lum(
                    mix(242.0 / 255, subtle.red), mix(242.0 / 255, subtle.green), mix(247.0 / 255, subtle.blue))
                let ratio = (page + 0.05) / (lum(out.red, out.green, out.blue) + 0.05)
                XCTAssertGreaterThanOrEqual(ratio, 5.0, String(hex, radix: 16))
            }
            XCTAssertEqual(KitPaletteResolver.headroom(BrandColor(hex: 0x23786e), over: BrandColor(hex: 0xe6f1ef), applies: false).hex, 0x23786e)
        }
    }
#endif
