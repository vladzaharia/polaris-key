// @pkey-feature connect.local
// The shared categories' wrap: the rows counted for the height are the rows placed, including when two pills exactly fill the
// width and the width a stack hands the second pass is a fraction short (at accessibility sizes this hid the last pill).

#if os(macOS)
    import XCTest

    @testable import PolarisKeyUI

    final class KitWrapTests: XCTestCase {
        private let pill = CGSize(width: 100, height: 32)

        func testTwoPillsThatExactlyFillTheWidthStayOnOneRow() {
            let width = pill.width * 2 + 8
            let laid = KitWrap.flow(sizes: [pill, pill], width: width, spacing: 8)
            XCTAssertEqual(laid.size.height, 32)
            XCTAssertEqual(laid.origins.map(\.y), [0, 0])
        }

        func testAWidthAFractionShortKeepsThemOnOneRowAndAHalfPointDoesNot() {
            let exact = pill.width * 2 + 8
            XCTAssertEqual(KitWrap.flow(sizes: [pill, pill], width: exact - 0.3, spacing: 8).origins.map(\.y), [0, 0])
            let two = KitWrap.flow(sizes: [pill, pill], width: exact - 1, spacing: 8)
            XCTAssertEqual(two.origins.map(\.y), [0, 40])
            XCTAssertEqual(two.size.height, 72)
        }

        /// A row counted at its own natural width stays one row when the second pass gets the pixel-rounded width.
        func testARowCountedAtItsNaturalWidthIsPlacedAsOneRow() {
            for count in 1...4 {
                let sizes = (0..<count).map { CGSize(width: 60 + CGFloat($0) * 13.3, height: 32) }
                let natural = KitWrap.flow(sizes: sizes, width: .infinity, spacing: 8)
                XCTAssertEqual(natural.size.height, 32)
                for short in [0.0, 0.1, 0.25, 0.4] {
                    let placed = KitWrap.flow(sizes: sizes, width: natural.size.width - short, spacing: 8)
                    XCTAssertEqual(placed.size.height, 32, "\(count) pills, \(short) short")
                }
            }
        }
    }
#endif
