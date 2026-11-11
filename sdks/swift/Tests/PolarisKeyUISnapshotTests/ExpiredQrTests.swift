// @pkey-feature connect.local
// The QR view of a window that ran out (UI-KITS 4.9): the dark modules fade toward the paper, so the dead code does not scan
// (the contrast between ink and paper is gone), while the live one keeps full contrast.

#if os(macOS)
    import AppKit
    import SwiftUI
    import XCTest

    @testable import PolarisKeyUI

    @MainActor
    final class ExpiredQrTests: XCTestCase {
        private let text = "PKP1:TIDEWATER:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y"

        /// The darkest and lightest the card reaches, as a share of full range: a camera needs a real step between ink and paper.
        private func contrast(faded: Bool) throws -> Double {
            let view = ExpiredFadeQR(text: text, label: "QR", faded: faded)
                .frame(width: 320, height: 320)
                .background(Color.white)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.cgImage)
            let width = image.width
            let height = image.height
            var pixels = [UInt8](repeating: 0, count: width * height)
            let space = CGColorSpaceCreateDeviceGray()
            let ctx = try XCTUnwrap(
                CGContext(
                    data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                    space: space, bitmapInfo: CGImageAlphaInfo.none.rawValue))
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            let low = Double(pixels.min() ?? 0)
            let high = Double(pixels.max() ?? 0)
            return (high - low) / 255
        }

        func testTheLiveCardKeepsFullContrast() throws {
            XCTAssertGreaterThan(try contrast(faded: false), 0.8)
        }

        /// CoreImage's detector still reads a card a few per cent apart, so the pin is the step itself: under 6 % of the range,
        /// below what a camera tells apart (the live card is above 80 %).
        func testTheExpiredCardHasNoStepLeftBetweenInkAndPaper() throws {
            XCTAssertLessThan(try contrast(faded: true), 0.06)
        }
    }
#endif
