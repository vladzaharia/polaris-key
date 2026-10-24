// The SwiftUI kit in a macOS window (UI-KITS §7.1; UK-08.2): each preview state launched in the
// Mac sample (TidewaterKitMac) at a window size, under both presets and both schemes. Every render:
//
//   * is a screenshot of the app's window, written to
//     $PKEY_KIT_SHOTS/mac<OS>-<W>x<H>-<state>-<preset>-<scheme>[-inactive].png (the OS major is in
//     the name, so a render from one macOS never compares against another's);
//   * runs `performAccessibilityAudit`, whose issues are recorded per render;
//   * is listed in $PKEY_KIT_SHOTS/renders-mac.json.
//
// Launch arguments are the iOS harness's (-pkeyState, -pkeyScheme, -pkeyPreset, -pkeyAccent,
// -pkeyLocale) plus -pkeyWindow WxH and -pkeyInactive (see App/TidewaterKitApp.swift).
//
// Inputs (read as TEST_RUNNER_<NAME> too, which is how run.sh passes them):
//   PKEY_KIT_SHOTS      where the renders go (unset: attachments only)
//   PKEY_KIT_ONLY       comma-separated states (default: the Mac set)
//   PKEY_KIT_QUICK=1    Welcome.default in both schemes at one size, nothing else
//   PKEY_KIT_WINDOWS    comma-separated WxH list (default 900x640; the full run adds 480x520)
//   PKEY_KIT_INACTIVE   1: also render each default-row state with the window inactive
//   PKEY_KIT_BASELINES / PKEY_KIT_RECORD   compare with / record baselines as on iOS
//   PKEY_KIT_EXTRA_ARGS extra launch arguments
//
// Needs UI automation allowed for the test runner (System Settings > Privacy & Security >
// Accessibility), which CI's macOS images grant.

import AppKit
import SnapshotTesting
import XCTest

final class KitRenderMacTests: XCTestCase {
    struct Render: Codable {
        var name: String
        var os: Int
        var window: String
        var state: String
        var preset: String
        var scheme: String
        var inactive: Bool
        var audit: [String]
    }

    /// The states the Mac slices render; the rest of the catalog is the iOS harness's.
    static let all = [
        "Welcome.default", "Activate.parsed", "Activate.device-limit", "SignIn.methods",
        "SignInHandoff.code", "LicenseChoice.many", "DeviceLimit.default", "StatusScreen.revoked",
    ]

    static func env(_ name: String) -> String? {
        let env = ProcessInfo.processInfo.environment
        let value = env[name] ?? env["TEST_RUNNER_\(name)"]
        return value?.isEmpty == false ? value : nil
    }

    var out: URL? { Self.env("PKEY_KIT_SHOTS").map { URL(fileURLWithPath: $0) } }
    var baselineFailures: [String] = []

    @MainActor
    func testRenders() throws {
        let quick = Self.env("PKEY_KIT_QUICK") == "1"
        let states =
            Self.env("PKEY_KIT_ONLY").map { $0.split(separator: ",").map(String.init) }
            ?? (quick ? ["Welcome.default"] : Self.all)
        let windows =
            Self.env("PKEY_KIT_WINDOWS").map { $0.split(separator: ",").map(String.init) }
            ?? (quick ? ["900x640"] : ["900x640", "480x520"])
        let inactive = Self.env("PKEY_KIT_INACTIVE") == "1"
        var renders: [Render] = []
        for window in windows {
            for state in states {
                for scheme in ["dark", "light"] {
                    renders.append(try render(state, window: window, scheme: scheme))
                }
                guard !quick else { continue }
                for scheme in ["dark", "light"] {
                    renders.append(
                        try render(state, window: window, scheme: scheme, preset: "native"))
                }
                if inactive {
                    renders.append(
                        try render(state, window: window, scheme: "light", inactive: true))
                }
            }
        }
        if let out {
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            try JSONEncoder.pretty.encode(renders).write(
                to: out.appendingPathComponent("renders-mac.json"))
        }
        // "Nearly passed" is the audit's warning; it stays in the JSON and does not fail the run.
        let kitIssues = renders.flatMap { r in
            r.audit.filter { !$0.contains("nearly passed") }.map { "\(r.name): \($0)" }
        }
        XCTAssertEqual(kitIssues, [], "accessibility audit issues")
        XCTAssertEqual(baselineFailures, [], "renders that differ from their baselines")
    }

    @MainActor
    private func render(
        _ state: String, window: String, scheme: String, preset: String = "polaris-key",
        inactive: Bool = false
    ) throws -> Render {
        let os = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        let name =
            "mac\(os)-\(window)-\(state)-\(preset)-\(scheme)\(inactive ? "-inactive" : "")"
        let app = XCUIApplication()
        var args = [
            "-pkeyState", state, "-pkeyScheme", scheme, "-pkeyFreezeTime", "-pkeyWindow", window,
        ]
        if preset == "native" { args += ["-pkeyPreset", "native"] }
        if inactive { args += ["-pkeyInactive"] }
        if let extra = Self.env("PKEY_KIT_EXTRA_ARGS") {
            args += extra.split(separator: " ").map(String.init)
        }
        app.launchArguments = args
        app.launch()
        _ = app.wait(for: .runningForeground, timeout: 10)
        let win = app.windows.firstMatch
        XCTAssertTrue(win.waitForExistence(timeout: 10), "\(name): no window")
        // The 250 ms loading grace and the first layout.
        Thread.sleep(forTimeInterval: 0.9)
        if inactive {
            // A real inactive window: the app hands the activation to Finder itself
            // (-pkeyInactive); this does the same from the runner, whichever lands first.
            XCUIApplication(bundleIdentifier: "com.apple.finder").activate()
            Thread.sleep(forTimeInterval: 0.8)
        }

        let shot = win.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let out {
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            try shot.pngRepresentation.write(to: out.appendingPathComponent("\(name).png"))
        }
        try baseline(shot.image, state: state, name: name)

        var issues: [String] = []
        // The audit needs the app frontmost to reach its elements.
        if inactive { app.activate() }
        try app.performAccessibilityAudit(for: .all) { issue in
            let label = issue.element.map { "'\($0.label)'" } ?? "-"
            issues.append("\(issue.compactDescription) [\(label)]")
            return true
        }
        app.terminate()
        return Render(
            name: name, os: os, window: window, state: state, preset: preset, scheme: scheme,
            inactive: inactive, audit: issues)
    }

    /// `<component>-<state>` as the iOS harness names a baseline directory.
    static func baselineName(_ state: String) -> String {
        let parts = state.split(separator: ".", maxSplits: 1).map(String.init)
        let component = parts[0].replacingOccurrences(
            of: "([a-z0-9])([A-Z])", with: "$1-$2", options: .regularExpression
        ).lowercased()
        return parts.count > 1
            ? "\(component)-\(parts[1].replacingOccurrences(of: ".", with: "-"))" : component
    }

    /// Compare a render with its baseline at 1x (a Retina window is redrawn to its point size),
    /// or record it under PKEY_KIT_RECORD=1. Baselines live in
    /// `<root>/<component>-<state>/<name>.png`.
    @MainActor
    func baseline(_ image: NSImage, state: String, name: String) throws {
        guard let root = Self.env("PKEY_KIT_BASELINES") else { return }
        let url = URL(fileURLWithPath: root)
            .appendingPathComponent(Self.baselineName(state))
            .appendingPathComponent("\(name).png")
        let small = Self.oneX(image)
        if Self.env("PKEY_KIT_RECORD") == "1" {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Self.png(small).write(to: url)
            return
        }
        guard let reference = NSImage(contentsOf: url) else {
            baselineFailures.append(
                "\(url.lastPathComponent): no baseline (record with PKEY_KIT_RECORD=1)")
            return
        }
        let diffing = Diffing<NSImage>.image(precision: 0.995, perceptualPrecision: 0.98)
        if let (message, _) = diffing.diff(Self.oneX(reference), small) {
            baselineFailures.append("\(Self.baselineName(state))/\(name): \(message)")
        }
    }

    /// `image` drawn into a bitmap one pixel per point.
    static func oneX(_ image: NSImage) -> NSImage {
        let w = Int(image.size.width)
        let h = Int(image.size.height)
        guard
            let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8,
                samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return image }
        rep.size = NSSize(width: w, height: h)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: w, height: h))
        NSGraphicsContext.restoreGraphicsState()
        let result = NSImage(size: rep.size)
        result.addRepresentation(rep)
        return result
    }

    static func png(_ image: NSImage) throws -> Data {
        guard let tiff = image.tiffRepresentation,
            let data = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        else { throw CocoaError(.fileWriteUnknown) }
        return data
    }
}

extension JSONEncoder {
    static var pretty: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }
}
