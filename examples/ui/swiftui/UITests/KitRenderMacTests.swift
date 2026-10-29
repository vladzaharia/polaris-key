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
// The suites (UK-08.7; each a test method, so CI can run one):
//   testRenders          the eight board screens at the four window rows x both schemes x both
//                        presets, the three sheets, and (PKEY_KIT_INACTIVE=1) the inactive window
//   testStates           every preview state (every components.json state) x both schemes at 900x640
//   testUpdateWindow     the Sparkle update window in each of its fixture states x schemes x presets
//   testAccessibility    the board screens at 900x640 under Increase Contrast, Reduce Transparency,
//                        the custom accent #ff6a3d, a presentation document's accent and icon (no
//                        integrator theme) and the macOS 15 material look (forcesMaterial)
//   testLargeText        the 200 % stand-in (M6): Dynamic Type forced to accessibility3 at 480x520,
//                        900x640 and 1440x900
//
// Every render is also checked for: no element cut off by the window (horizontally everywhere,
// vertically outside a scroll view), and the one primary button inside the window - the first
// viewport - for the screens that have one.
//
// Inputs (read as TEST_RUNNER_<NAME> too, which is how run.sh passes them):
//   PKEY_KIT_SHOTS      where the renders go (unset: attachments only)
//   PKEY_KIT_ONLY       comma-separated states (default: the Mac set)
//   PKEY_KIT_QUICK=1    Welcome.default in both schemes at one size, nothing else
//   PKEY_KIT_WINDOWS    comma-separated WxH list (default 480x520, 900x640, 1440x900 and 1920x1080)
//   PKEY_KIT_INACTIVE   1: also render each default-row state with the window inactive
//   PKEY_KIT_BASELINES / PKEY_KIT_RECORD   compare with / record baselines as on iOS. Record-first
//                       (UK-08.8): when PKEY_KIT_BASELINES holds no mac<OS>-*.png for this OS yet, the
//                       run records them and does not fail on missing ones, so CI's first run on an OS
//                       passes and produces the set to commit.
//   PKEY_KIT_EXTRA_ARGS extra launch arguments
//
// Needs UI automation allowed for the test runner (System Settings > Privacy & Security >
// Accessibility), which CI's macOS images grant.

import AppKit
import PolarisKeyUICore
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
        var tag: String
        var audit: [String]
        var layout: [String]
    }

    /// One render: a state (or an update-window fixture) at a window size, with launch arguments.
    struct Variant {
        var state: String
        var window = "900x640"
        var scheme = "dark"
        var preset = "polaris-key"
        var inactive = false
        var sheet = false
        /// Names the extra: `contrast`, `large`, ... (empty: none).
        var tag = ""
        var args: [String] = []
        /// An update-window fixture (`Update.<fixture>`), drawn by the driver's own window.
        var update: String?
    }

    /// The Settings window's Account pane (`-pkeySettings`): the kit's own pane at its own size, so
    /// the window rows do not apply and it renders once per scheme and preset.
    static let settingsPane = "SettingsPane.account"

    /// The eight board screens (UI-KITS §7; the `desktop.html` rows): gate, activate, sign-in,
    /// device limit, update, settings, states, grace.
    static let board = [
        "Welcome.default", "Activate.parsed", "SignIn.methods", "DeviceLimit.default",
        "UpdatePrompt.available", "SettingsPane.account", "StatusScreen.revoked",
        "GraceBanner.days-left",
    ]

    /// Board screens that draw a primary button on every Mac window.
    static let hasPrimary = ["Welcome.default", "Activate.parsed"]

    /// More states the four-window rows also draw (kept from UK-08.2).
    static let extraRows = ["Activate.device-limit", "SignInHandoff.code", "LicenseChoice.many"]

    /// The steps drawn as a sheet.
    static let sheets = ["Activate.parsed", "SignIn.methods", "SignInHandoff.code"]

    /// The update window's fixtures (`UpdateFixture` in PolarisKeyUpdateUI).
    static let updateFixtures = [
        "permission", "checking", "found", "downloading", "downloading-unknown", "extracting",
        "ready", "installing", "downloaded", "quit-to-install", "up-to-date", "error",
        "error-cannot-install",
    ]

    static let windows = ["480x520", "900x640", "1440x900", "1920x1080"]
    static let schemes = ["dark", "light"]

    static func env(_ name: String) -> String? {
        let env = ProcessInfo.processInfo.environment
        let value = env[name] ?? env["TEST_RUNNER_\(name)"]
        return value?.isEmpty == false ? value : nil
    }

    /// PKEY_KIT_SHOTS, or the runner's own temporary directory when the runner (sandboxed) may not write
    /// there (Code=513 on CI); the renders stay in the result bundle's attachments either way.
    var out: URL? {
        guard let dir = Self.env("PKEY_KIT_SHOTS").map({ URL(fileURLWithPath: $0) }) else { return nil }
        let fm = FileManager.default
        let probe = dir.appendingPathComponent(".write-probe")
        if (try? fm.createDirectory(at: dir, withIntermediateDirectories: true)) != nil,
            (try? Data().write(to: probe)) != nil
        {
            try? fm.removeItem(at: probe)
            return dir
        }
        return URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pkey-shots-mac")
    }
    var baselineFailures: [String] = []
    var quick: Bool { Self.env("PKEY_KIT_QUICK") == "1" }

    /// PKEY_KIT_ONLY narrows every suite to these states.
    func only(_ states: [String]) -> [String] {
        guard let only = Self.env("PKEY_KIT_ONLY").map({ Set($0.split(separator: ",").map(String.init)) })
        else { return states }
        return states.filter { only.contains($0) }
    }

    func windowRows() -> [String] {
        Self.env("PKEY_KIT_WINDOWS").map { $0.split(separator: ",").map(String.init) }
            ?? (quick ? ["900x640"] : Self.windows)
    }

    @MainActor
    func testRenders() throws {
        let states =
            Self.env("PKEY_KIT_ONLY") != nil
            ? only(Self.board + Self.extraRows)
            : (quick ? ["Welcome.default"] : Self.board + Self.extraRows)
        let inactive = Self.env("PKEY_KIT_INACTIVE") == "1"
        var variants: [Variant] = []
        // The Mac sheet (`presentation: "sheet"`, UK-08.3): the step as one fitted 440 pt panel
        // over Welcome, at the common window.
        if !quick, Self.env("PKEY_KIT_ONLY") == nil {
            for state in Self.sheets {
                for scheme in Self.schemes {
                    variants.append(Variant(state: state, scheme: scheme, sheet: true))
                }
            }
        }
        for window in windowRows() {
            for state in states {
                for scheme in Self.schemes {
                    variants.append(Variant(state: state, window: window, scheme: scheme))
                }
                guard !quick else { continue }
                for scheme in Self.schemes {
                    variants.append(
                        Variant(state: state, window: window, scheme: scheme, preset: "native"))
                }
                if inactive {
                    variants.append(
                        Variant(state: state, window: window, scheme: "light", inactive: true))
                }
            }
        }
        try run(variants, file: "renders-mac.json")
    }

    /// Every preview state, so every `components.json` state (KitRulesTests proves the mapping),
    /// in both schemes at the common window.
    @MainActor
    func testStates() throws {
        try XCTSkipIf(quick, "quick run")
        let ids = Self.env("PKEY_KIT_ONLY") != nil
            ? only(PolarisKeyPreviewState.all.map(\.id))
            : PolarisKeyPreviewState.all.map(\.id).filter { !Self.board.contains($0) }
        let variants = ids.flatMap { id in
            Self.schemes.map { Variant(state: id, scheme: $0) }
        }
        try run(variants, file: "renders-mac-states.json")
    }

    @MainActor
    func testUpdateWindow() throws {
        try XCTSkipIf(quick || Self.env("PKEY_KIT_ONLY") != nil, "narrowed run")
        var variants: [Variant] = []
        for fixture in Self.updateFixtures {
            for preset in ["polaris-key", "native"] {
                for scheme in Self.schemes {
                    variants.append(
                        Variant(
                            state: "Update.\(fixture)", window: "auto", scheme: scheme,
                            preset: preset, update: fixture))
                }
            }
        }
        try run(variants, file: "renders-mac-update.json")
    }

    /// Increase Contrast, Reduce Transparency, the custom accent, a presentation document's
    /// accent and icon, and the macOS 15 look, on the board screens at 900x640.
    @MainActor
    func testAccessibility() throws {
        try XCTSkipIf(quick, "quick run")
        let extras: [(tag: String, args: [String])] = [
            ("contrast", ["-pkeyContrast", "increased"]),
            ("reduce-transparency", ["-pkeyReduceTransparency"]),
            ("accent", ["-pkeyAccent", "#ff6a3d"]),
            // The product's accent and icon arrive as a presentation document delivers them:
            // no theme from the integrator, no icon passed in.
            ("presentation", ["-pkeyPresentation"]),
            // The macOS 15 look (system materials, solid capsules) on macOS 26, for review.
            ("material", ["-pkeyMaterial"]),
        ]
        var variants: [Variant] = []
        for extra in extras {
            for state in only(Self.board) {
                for scheme in Self.schemes {
                    variants.append(
                        Variant(state: state, scheme: scheme, tag: extra.tag, args: extra.args))
                }
            }
        }
        try run(variants, file: "renders-mac-accessibility.json")
    }

    /// The 200 % stand-in (M6): a Mac has no Dynamic Type slider, so the sample forces
    /// `.dynamicTypeSize(.accessibility3)`.
    @MainActor
    func testLargeText() throws {
        try XCTSkipIf(quick, "quick run")
        var variants: [Variant] = []
        // Not the Settings pane: its native Form keeps the system's text on a Mac (a half-scaled
        // pane is worse than the system's own), so it has no 200 % row until it is redrawn.
        for window in ["480x520", "900x640", "1440x900"] {
            for state in only(Self.board) where state != Self.settingsPane {
                for scheme in Self.schemes {
                    variants.append(
                        Variant(
                            state: state, window: window, scheme: scheme, tag: "large",
                            args: ["-pkeyTypeSize", "ax3"]))
                }
            }
        }
        try run(variants, file: "renders-mac-large.json")
    }

    @MainActor
    private func run(_ variants: [Variant], file: String) throws {
        var renders: [Render] = []
        var seen = Set<String>()
        for var variant in variants {
            // The pane has one size, so it is one render however many window rows ask for it.
            if variant.state == Self.settingsPane { variant.window = "auto" }
            guard seen.insert(Self.name(variant)).inserted else { continue }
            renders.append(try render(variant))
        }
        if let out {
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            try JSONEncoder.pretty.encode(renders).write(to: out.appendingPathComponent(file))
        }
        // "Nearly passed" is the audit's warning; it stays in the JSON and does not fail the run.
        let kitIssues = renders.flatMap { r in
            r.audit.filter { !$0.contains("nearly passed") }.map { "\(r.name): \($0)" }
        }
        XCTAssertEqual(kitIssues, [], "accessibility audit issues")
        XCTAssertEqual(
            renders.flatMap { r in r.layout.map { "\(r.name): \($0)" } }, [],
            "clipped elements, or a primary outside the first viewport")
        XCTAssertEqual(baselineFailures, [], "renders that differ from their baselines")
    }

    static func name(_ v: Variant) -> String {
        let os = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        return
            "mac\(os)-\(v.window)-\(v.state)-\(v.preset)-\(v.scheme)\(v.tag.isEmpty ? "" : "-\(v.tag)")\(v.inactive ? "-inactive" : "")\(v.sheet ? "-sheet" : "")"
    }

    @MainActor
    private func render(_ v: Variant) throws -> Render {
        let os = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        let name = Self.name(v)
        let app = XCUIApplication()
        var args = ["-pkeyScheme", v.scheme, "-pkeyFreezeTime", "-ApplePersistenceIgnoreState", "YES"]
        if let fixture = v.update {
            args += ["-pkeyUpdate", fixture]
        } else if v.state == Self.settingsPane {
            args += ["-pkeySettings"]
        } else {
            args += ["-pkeyState", v.state, "-pkeyWindow", v.window]
        }
        if v.preset == "native" { args += ["-pkeyPreset", "native"] }
        if v.inactive { args += ["-pkeyInactive"] }
        if v.sheet { args += ["-pkeySheet"] }
        args += v.args
        if let extra = Self.env("PKEY_KIT_EXTRA_ARGS") {
            args += extra.split(separator: " ").map(String.init)
        }
        app.launchArguments = args
        app.launch()
        _ = app.wait(for: .runningForeground, timeout: 10)
        let win = app.windows.firstMatch
        if !win.waitForExistence(timeout: 10) {
            // Evidence for the next CI run: the app's state and its whole accessibility tree.
            let note = XCTAttachment(
                string: "state \(app.state.rawValue)\n\(app.debugDescription)")
            note.name = "\(name): no window"
            note.lifetime = .keepAlways
            add(note)
        }
        XCTAssertTrue(win.exists, "\(name): no window")
        // The 250 ms loading grace and the first layout.
        Thread.sleep(forTimeInterval: 0.9)
        if v.inactive {
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
        try baseline(shot.image, state: v.state, name: name)

        let layout = layoutIssues(win, expectPrimary: Self.hasPrimary.contains(v.state) && !v.sheet)
        var issues: [String] = []
        // The audit needs the app frontmost to reach its elements.
        if v.inactive { app.activate() }
        try app.performAccessibilityAudit(for: .all) { issue in
            let label = issue.element.map { "'\($0.label)'" } ?? "-"
            issues.append("\(issue.compactDescription) [\(label)]")
            return true
        }
        app.terminate()
        return Render(
            name: name, os: os, window: v.window, state: v.state, preset: v.preset,
            scheme: v.scheme, inactive: v.inactive, tag: v.tag, audit: issues, layout: layout)
    }

    /// What the layout must satisfy, read from one accessibility snapshot of the window:
    ///   * no text, button or field is cut off by the window: horizontally anywhere, and
    ///     vertically outside a scroll view (a scroll view's rows scroll in);
    ///   * the one primary button (`pkey.primary`) lies wholly inside the window, which is the
    ///     first viewport, on the screens that have one.
    @MainActor
    func layoutIssues(_ win: XCUIElement, expectPrimary: Bool) -> [String] {
        guard let snapshot = try? win.snapshot() else { return ["no accessibility snapshot"] }
        let bounds = snapshot.frame.insetBy(dx: -1.5, dy: -1.5)
        let checked: Set<XCUIElement.ElementType> = [
            .staticText, .button, .textField, .secureTextField, .link, .checkBox, .popUpButton,
            .radioButton, .switch, .slider,
        ]
        var issues: [String] = []
        var primaries = 0
        func walk(_ node: XCUIElementSnapshot, inScroll: Bool) {
            let f = node.frame
            let label = "\(node.elementType.rawValue) '\(node.label)'"
            if node.identifier == "pkey.primary" {
                primaries += 1
                if !bounds.contains(f) { issues.append("primary outside the window: \(f)") }
            }
            if checked.contains(node.elementType), f.width > 0, f.height > 0, !node.label.isEmpty {
                let horizontal = f.minX >= bounds.minX && f.maxX <= bounds.maxX
                if !horizontal || (!inScroll && !bounds.contains(f)) {
                    issues.append("cut off by the window: \(label) \(f)")
                }
            }
            let scroll = inScroll || node.elementType == .scrollView
            for child in node.children { walk(child, inScroll: scroll) }
        }
        walk(snapshot, inScroll: false)
        if expectPrimary && primaries == 0 { issues.append("no primary button in the window") }
        return issues
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

    /// True when `PKEY_KIT_BASELINES` holds no `mac<OS>-*.png` for this OS: the first run on an OS
    /// records instead of comparing. Read once, before the first render writes one.
    static let recordFirst: Bool = {
        guard let root = env("PKEY_KIT_BASELINES") else { return false }
        let prefix = "mac\(ProcessInfo.processInfo.operatingSystemVersion.majorVersion)-"
        let files = FileManager.default.enumerator(atPath: root)
        while let file = files?.nextObject() as? String {
            let name = (file as NSString).lastPathComponent
            if name.hasPrefix(prefix) && name.hasSuffix(".png") { return false }
        }
        return true
    }()

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
        if Self.env("PKEY_KIT_RECORD") == "1" || Self.recordFirst {
            let data = try Self.png(small)
            do {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: url)
            } catch {
                // CI's UI-test runner is sandboxed and may not write into the repo: keep the
                // recorded baseline in the result bundle (CI uploads it) instead of failing.
                let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
                attachment.name = "\(Self.baselineName(state))/\(name).png"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
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
