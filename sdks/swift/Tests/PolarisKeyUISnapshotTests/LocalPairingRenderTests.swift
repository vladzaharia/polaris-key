// @pkey-feature connect.local ui.kit
// Pair with a Code, drawn (CC-29K.2): every non-hidden `local` row of the ui-matrix through LocalPairingView and
// PairedDevicesView, in both schemes, at an iPhone's size and at a Mac window's. The renders run on this Mac (AppKit hosting)
// and assert the screen draws something (not blank); set `PKEY_LOCAL_SHOTS=<dir>` to write them as PNGs for the UX review.
// They are layout checks, not baselines: the iOS baselines are recorded by examples/ui/swiftui/run.sh on the runtime the
// committed ones use, and CI records the first set.

#if os(macOS)
    import AppKit
    import Foundation
    import PolarisKeyUICore
    import SwiftUI
    import UniformTypeIdentifiers
    import XCTest

    @testable import PolarisKeyUI

    @MainActor
    final class LocalPairingRenderTests: XCTestCase {
        private struct Row {
            let id: String
            let component: KitComponent
            let inputs: KitInputs
        }

        private func rows() throws -> [Row] {
            var url = URL(fileURLWithPath: #filePath)
            for _ in 0..<5 { url.deleteLastPathComponent() }
            url.appendPathComponent("conformance/corpus/v2/ui-matrix.json")
            let raw = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            let vocabulary = try XCTUnwrap(raw["vocabulary"] as? [String: Any])
            let defaults = try XCTUnwrap(vocabulary["defaults"] as? [String: Any])
            let family = try XCTUnwrap(raw["local"] as? [[String: Any]])
            var out: [Row] = []
            for (index, row) in family.enumerated() {
                var merged = defaults
                for (key, value) in row["input"] as? [String: Any] ?? [:] { merged[key] = value }
                let inputs = try JSONDecoder().decode(
                    KitInputs.self, from: JSONSerialization.data(withJSONObject: merged))
                let expect = try XCTUnwrap(row["expect"] as? [String: Any])
                let component = try XCTUnwrap(
                    KitComponent(rawValue: expect["component"] as? String ?? ""))
                guard expect["state"] as? String != "hidden" else { continue }
                out.append(
                    Row(
                        id: String(
                            format: "%02d-%@-%@", index, component.rawValue.lowercased(),
                            expect["state"] as? String ?? ""),
                        component: component, inputs: inputs))
            }
            return out
        }

        @ViewBuilder private func view(_ row: Row) -> some View {
            switch row.component {
            case .localPairing:
                LocalPairingView(
                    model: LocalPairingModel(inputs: row.inputs),
                    categoryLabels: ["crates": "Crates", "cues": "Cues"])
            default:
                PairedDevicesView(model: PairedDevicesModel(inputs: row.inputs))
            }
        }

        private func render(_ row: Row, size: CGSize, dark: Bool) -> NSBitmapImageRep? {
            // glassEffect draws blank under cacheDisplay on macOS 26: the material fallback draws the same screens opaque.
            let root = PolarisKeyScope(model: PolarisKeyGateModel(preview: row.inputs)) { self.view(row) }
                .environment(\.polarisKeyMaterialFallback, true)
                .frame(width: size.width, height: size.height)
                .polarisKeyTheme(PolarisKeyTheme(colorScheme: dark ? .dark : .light))
                .environment(\.colorScheme, dark ? .dark : .light)
            let host = NSHostingView(rootView: root)
            host.frame = CGRect(origin: .zero, size: size)
            // A window of its own (never shown): the scroll views lay out and draw once they have one.
            let window = NSWindow(
                contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless],
                backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = host
            window.layoutIfNeeded()
            for _ in 0..<3 {
                RunLoop.main.run(until: Date().addingTimeInterval(0.1))
                host.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
            }
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
            host.cacheDisplay(in: host.bounds, to: rep)
            return rep
        }

        /// Sample points below the product header (the top tenth) that differ from the page colour: text, controls and
        /// code tiles all count; a header gradient on an empty page counts nothing.
        private func contentPoints(_ rep: NSBitmapImageRep) -> Int {
            guard let page = rep.colorAt(x: 2, y: rep.pixelsHigh - 2)?.usingColorSpace(.sRGB) else { return 0 }
            let step = max(1, rep.pixelsWide / 80)
            var points = 0
            for x in stride(from: 0, to: rep.pixelsWide, by: step) {
                for y in stride(from: rep.pixelsHigh / 10, to: rep.pixelsHigh, by: step) {
                    guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                    let d =
                        abs(c.redComponent - page.redComponent) + abs(c.greenComponent - page.greenComponent)
                        + abs(c.blueComponent - page.blueComponent)
                    if d > 0.15 { points += 1 }
                }
            }
            return points
        }

        private func write(_ rep: NSBitmapImageRep, _ name: String) {
            guard let dir = ProcessInfo.processInfo.environment["PKEY_LOCAL_SHOTS"],
                let data = rep.representation(using: .png, properties: [:])
            else { return }
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            try? data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }

        func testEveryRowDrawsAtAnIPhoneAndAMacWindowInBothSchemes() throws {
            let all = try rows()
            XCTAssertGreaterThan(all.count, 50)
            // Set PKEY_LOCAL_ONLY=<substring> to draw a few rows while working on a screen.
            let only = ProcessInfo.processInfo.environment["PKEY_LOCAL_ONLY"]
            for row in all where only.map({ row.id.contains($0) }) ?? true {
                // A Mac window only where the layout differs (the show screen's two panes, the list); every row at an iPhone's size.
                let mac =
                    ProcessInfo.processInfo.environment["PKEY_LOCAL_MAC"] != nil
                    || row.id.contains("-localpairing-show") || row.id.contains("-paireddevices-list")
                var sizes = [("iphone", CGSize(width: 390, height: 844))]
                if mac { sizes.append(("mac", CGSize(width: 900, height: 640))) }
                for (label, size) in sizes {
                    for dark in [false, true] {
                        let rep = try XCTUnwrap(
                            render(row, size: size, dark: dark), "\(row.id) \(label) renders")
                        XCTAssertGreaterThan(
                            contentPoints(rep), 25,
                            "\(row.id) \(label) \(dark ? "dark" : "light") is not blank")
                        write(rep, "swiftui.\(row.id).\(label)-\(dark ? "dark" : "light")")
                    }
                }
            }
        }
    }
#endif
