// The SwiftUI kit on the iOS simulator (UI-KITS §7.1, §7.2; the UK-07 row of the language matrix):
// each preview state launched full-screen in the sample, in both schemes, at Dynamic Type L, AX3
// and AX5, in portrait and landscape, and under both presets. Every render:
//
//   * is written as a PNG to $PKEY_KIT_SHOTS/<state>/<device>-<orientation>-<type>-<preset>-<scheme>.png;
//   * runs `performAccessibilityAudit`, whose issues are recorded per render in audit.json (the
//     run fails on any issue the kit owns; system-owned ones are listed with their reason);
//   * records what VoiceOver reads (each element's type and label) in voiceover.json.
//
// run.sh drives it: `PKEY_KIT_SHOTS=<dir> ./run.sh` (CI passes TEST_RUNNER_PKEY_KIT_SHOTS).

import SnapshotTesting
import UIKit
import XCTest

final class KitRenderTests: XCTestCase {
    struct Render: Codable {
        var state: String
        var device: String
        var orientation: String
        var type: String
        var preset: String
        var scheme: String
        var audit: [String]
        var voiceOver: [String]
    }

    /// Audit findings the spec asks for, each with its reason; everything else fails the run.
    static let exempt: [(audit: String, element: String, reason: String)] = [
        (
            "Text clipped", "'License key'",
            "A license key gives way in the middle at rest, keeping the prefix and the last six (UI-KITS §4.3, DL11); VoiceOver reads the whole key."
        )
    ]

    /// The states the matrix renders in full; the rest render at the default row only.
    static let full = [
        "Welcome.default", "Activate.parsed", "Activate.device-limit", "SignIn.methods",
        "SignInHandoff.code", "StatusScreen.revoked",
    ]

    static let all = [
        "PolarisKeyGate.booting", "Welcome.default", "Welcome.default.extras",
        "Welcome.default.drift-kart", "Welcome.default.no-presentation", "Welcome.busy",
        "Welcome.capability-limited", "Activate.empty", "Activate.typing", "Activate.parsed",
        "Activate.cut-short", "Activate.busy", "Activate.rejected", "Activate.device-limit",
        "Activate.done", "SignIn.methods", "SignIn.handoff", "SignIn.finishing", "SignIn.choose",
        "SignIn.replace", "SignIn.key", "SignIn.done", "SignIn.error", "SignIn.expired",
        "SignInHandoff.no-browser", "SignInHandoff.starting", "SignInHandoff.code",
        "SignInHandoff.denied", "SignInHandoff.expired", "LicenseChoice.many", "LicenseChoice.one",
        "LicenseChoice.all-full", "LicenseChoice.replace-open", "LicenseChoice.none-keys",
        "DeviceLimit.browser-mode", "DeviceLimit.default", "StatusScreen.revoked",
        "StatusScreen.expired", "StatusScreen.version-too-old", "StatusScreen.version-too-new",
        "StatusScreen.channel-not-entitled", "GraceBanner.days-left", "GraceBanner.last-day",
        "UpdatePrompt.available", "UpdatePrompt.mandatory", "UpdatePrompt.store",
        "UpdatePrompt.ready", "UpdateProgress.downloading", "ReleaseNotes.list",
        "AccountAndLicense.signed-in", "AccountAndLicense.key-only", "AccountAndLicense.offline",
        "Settings.list", "Settings.locked", "Devices.list", "Devices.empty", "Devices.error",
        "Devices.browser-mode", "Paywall.offers", "Paywall.not-available",
        "EntitlementGate.not-entitled",
    ]

    /// The states rendered again in a launch pack, for the catalog's i18n proof.
    static let localized = ["Welcome.default", "Activate.device-limit", "SignInHandoff.code"]

    var out: URL? {
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["PKEY_KIT_SHOTS"] ?? env["TEST_RUNNER_PKEY_KIT_SHOTS"] else {
            return nil
        }
        return URL(fileURLWithPath: dir)
    }

    var device: String {
        let env = ProcessInfo.processInfo.environment
        if let label = env["PKEY_KIT_DEVICE"] ?? env["TEST_RUNNER_PKEY_KIT_DEVICE"], !label.isEmpty
        {
            return label
        }
        return env["SIMULATOR_DEVICE_NAME"]?.lowercased().replacingOccurrences(of: " ", with: "-")
            ?? "device"
    }

    @MainActor
    func testRenders() throws {
        let only =
            ProcessInfo.processInfo.environment["PKEY_KIT_ONLY"]
            ?? ProcessInfo.processInfo.environment["TEST_RUNNER_PKEY_KIT_ONLY"]
        let states =
            only.flatMap { $0.isEmpty ? nil : $0.split(separator: ",").map(String.init) }
            ?? Self.all
        var renders: [Render] = []
        for state in states {
            for scheme in ["dark", "light"] {
                renders.append(try render(state, scheme: scheme))
            }
            let env = ProcessInfo.processInfo.environment
            let quick = (env["PKEY_KIT_QUICK"] ?? env["TEST_RUNNER_PKEY_KIT_QUICK"]) == "1"
            guard Self.full.contains(state), !quick else { continue }
            for type in ["AX3", "AX5"] {
                renders.append(try render(state, scheme: "dark", type: type))
            }
            renders.append(try render(state, scheme: "light", orientation: .landscapeLeft))
            renders.append(try render(state, scheme: "dark", preset: "native"))
            renders.append(try render(state, scheme: "light", preset: "native"))
            // The designed iOS 18 fallback, drawn on 26 (no iOS 18 runtime is installed here).
            renders.append(try render(state, scheme: "dark", preset: "material"))
            renders.append(try render(state, scheme: "light", preset: "material"))
        }
        let env = ProcessInfo.processInfo.environment
        if (env["PKEY_KIT_QUICK"] ?? env["TEST_RUNNER_PKEY_KIT_QUICK"]) != "1" {
            for state in Self.localized where states.contains(state) {
                for locale in ["de", "ja"] {
                    renders.append(try render(state, scheme: "dark", locale: locale))
                }
            }
        }
        XCUIDevice.shared.orientation = .portrait
        if let out {
            let data = try JSONEncoder.pretty.encode(renders)
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            try data.write(to: out.appendingPathComponent("renders-\(device).json"))
        }
        // "Nearly passed" is the audit's warning, and a measured pass overrules the audit's
        // contrast heuristic; both stay in the JSON, neither fails the run.
        let kitIssues = renders.flatMap { r in
            r.audit.filter { !$0.contains("nearly passed") && !$0.hasPrefix("measured ") }
                .map { "\(r.state) \(r.scheme) \(r.type) \(r.orientation) \(r.preset): \($0)" }
        }
        XCTAssertEqual(kitIssues, [], "accessibility audit issues")
        XCTAssertEqual(baselineFailures, [], "renders that differ from their baselines")
    }

    @MainActor
    private func render(
        _ state: String, scheme: String, type: String = "L",
        orientation: UIDeviceOrientation = .portrait, preset: String = "polaris-key",
        locale: String? = nil
    ) throws -> Render {
        XCUIDevice.shared.orientation = orientation
        let app = XCUIApplication()
        var args = ["-pkeyState", state, "-pkeyScheme", scheme, "-pkeyFreezeTime"]
        if preset == "native" { args += ["-pkeyPreset", "native"] }
        if preset == "material" { args += ["-pkeyMaterial"] }
        if let locale { args += ["-pkeyLocale", locale] }
        let category: String
        switch type {
        case "AX3": category = "UICTContentSizeCategoryAccessibilityExtraLarge"
        case "AX5": category = "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge"
        default: category = "UICTContentSizeCategoryL"
        }
        args += ["-UIPreferredContentSizeCategoryName", category]
        let env = ProcessInfo.processInfo.environment
        if let extra = env["PKEY_KIT_EXTRA_ARGS"] ?? env["TEST_RUNNER_PKEY_KIT_EXTRA_ARGS"],
            !extra.isEmpty
        {
            args += extra.split(separator: " ").map(String.init)
        }
        app.launchArguments = args
        app.launch()
        // The 250 ms loading grace and the first layout.
        _ = app.wait(for: .runningForeground, timeout: 10)
        Thread.sleep(forTimeInterval: 0.9)

        let orientationName = orientation == .portrait ? "portrait" : "landscape"
        let name =
            "\(device)-\(orientationName)-\(type)-\(preset)\(locale.map { "-\($0)" } ?? "")-\(scheme)"
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "\(state) \(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let out {
            let dir = out.appendingPathComponent(state)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try shot.pngRepresentation.write(to: dir.appendingPathComponent("\(name).png"))
        }
        try baseline(
            shot.image, state: state, name: name,
            isDefault: locale == nil && isDefaultRow(type, orientation, preset))

        var issues: [String] = []
        let pixels = shot.image.cgImage
        let scale = shot.image.scale
        try app.performAccessibilityAudit(for: .all) { issue in
            let label = issue.element.map { "'\($0.label)'" } ?? "-"
            let exempt = Self.exempt.contains {
                issue.compactDescription.contains($0.audit) && $0.element == label
            }
            let type = issue.element.map { Self.typeName($0.elementType) } ?? "-"
            // The audit's contrast check misreads wrapped text (it flags 12:1 body copy); measure
            // the render itself, and keep the finding only when the pixels fail too (BRAND §9:
            // contrast is measured on the render).
            if issue.compactDescription.contains("Contrast"), let element = issue.element,
                let pixels,
                let ratio = Self.measuredContrast(pixels, in: element.frame, scale: scale)
            {
                let floor = element.elementType == .staticText ? 4.5 : 3.0
                if ratio >= floor {
                    issues.append(
                        "measured \(String(format: "%.1f", ratio)):1 (audit said \(issue.compactDescription)) [\(type) \(label)]"
                    )
                    return true
                }
            }
            if !exempt {
                issues.append("\(issue.compactDescription) [\(type) \(label)]")
            }
            return true
        }

        var voiceOver: [String] = []
        for element in app.descendants(matching: .any).allElementsBoundByIndex
        where element.exists && element.isHittable && !element.label.isEmpty {
            voiceOver.append("\(Self.typeName(element.elementType)): \(element.label)")
        }
        app.terminate()
        return Render(
            state: state, device: device, orientation: orientationName, type: type, preset: preset,
            scheme: scheme, audit: issues, voiceOver: voiceOver)
    }

    var baselineFailures: [String] = []

    /// The default row (portrait, L, the Polaris Key preset): the docs subset, flat at the top of
    /// the baseline directory as `<component>-<state>[-variant]-<scheme>.png` (ui-qa's and the docs'
    /// layout); every other row in `<component>-<state>/<device>-…-<scheme>.png`.
    func isDefaultRow(_ type: String, _ orientation: UIDeviceOrientation, _ preset: String) -> Bool
    {
        type == "L" && orientation == .portrait && preset == "polaris-key"
    }

    static func baselineName(_ state: String) -> String {
        // "SignInHandoff.code" → "sign-in-handoff-code"; "Welcome.default.drift-kart" keeps its variant.
        let parts = state.split(separator: ".", maxSplits: 1).map(String.init)
        let component = parts[0].replacingOccurrences(
            of: "([a-z0-9])([A-Z])", with: "$1-$2", options: .regularExpression
        ).lowercased()
        return parts.count > 1
            ? "\(component)-\(parts[1].replacingOccurrences(of: ".", with: "-"))" : component
    }

    /// Compare a render with its committed baseline (swift-snapshot-testing's image diffing), at
    /// 1x so the baselines stay small; record it instead under PKEY_KIT_RECORD=1.
    @MainActor
    func baseline(_ image: UIImage, state: String, name: String, isDefault: Bool) throws {
        let env = ProcessInfo.processInfo.environment
        guard let root = (env["PKEY_KIT_BASELINES"] ?? env["TEST_RUNNER_PKEY_KIT_BASELINES"]),
            !root.isEmpty
        else { return }
        let record = (env["PKEY_KIT_RECORD"] ?? env["TEST_RUNNER_PKEY_KIT_RECORD"]) == "1"
        let base = Self.baselineName(state)
        let scheme = name.hasSuffix("-dark") ? "dark" : "light"
        let url: URL =
            isDefault && device.hasPrefix("iphone-440")
            ? URL(fileURLWithPath: root).appendingPathComponent("\(base)-\(scheme).png")
            : URL(fileURLWithPath: root).appendingPathComponent(base).appendingPathComponent(
                "\(name).png")
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let size = CGSize(width: image.size.width, height: image.size.height)
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        if record {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try small.pngData()?.write(to: url)
            return
        }
        guard let reference = UIImage(contentsOfFile: url.path) else {
            baselineFailures.append(
                "\(url.lastPathComponent): no baseline (record with PKEY_KIT_RECORD=1)")
            return
        }
        let diffing = Diffing<UIImage>.image(precision: 0.995, perceptualPrecision: 0.98, scale: 1)
        if let (message, _) = diffing.diff(reference, small) {
            baselineFailures.append("\(base)/\(name): \(message)")
        }
    }

    /// The contrast of a text run against its ground, from the render's pixels inside `frame`:
    /// the ground is the most common colour, the text the colour farthest from it in luminance
    /// among those covering at least 2 % of the non-ground pixels (antialiasing is ignored).
    static func measuredContrast(_ image: CGImage, in frame: CGRect, scale: CGFloat) -> Double? {
        let rect = CGRect(
            x: frame.minX * scale, y: frame.minY * scale, width: frame.width * scale,
            height: frame.height * scale
        ).integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard rect.width > 2, rect.height > 2, let crop = image.cropping(to: rect) else {
            return nil
        }
        let w = crop.width
        let h = crop.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        guard
            let ctx = CGContext(
                data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
        var counts: [UInt32: Int] = [:]
        for i in stride(from: 0, to: bytes.count, by: 4) {
            // Quantise to 4 bits per channel so antialiasing and gradients pool together.
            let key =
                UInt32(bytes[i] >> 4) << 8 | UInt32(bytes[i + 1] >> 4) << 4
                | UInt32(bytes[i + 2] >> 4)
            counts[key, default: 0] += 1
        }
        guard let ground = counts.max(by: { $0.value < $1.value })?.key else { return nil }
        func luminance(_ key: UInt32) -> Double {
            func channel(_ v: UInt32) -> Double {
                let c = (Double(v) * 17 + 8) / 255
                return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channel(key >> 8 & 0xF) + 0.7152 * channel(key >> 4 & 0xF)
                + 0.0722 * channel(key & 0xF)
        }
        let rest = counts.filter { $0.key != ground }
        let total = rest.values.reduce(0, +)
        guard total > 0 else { return nil }
        let lg = luminance(ground)
        let candidates = rest.filter { Double($0.value) >= Double(total) * 0.02 }.map(\.key)
        guard
            let ink = candidates.max(by: { abs(luminance($0) - lg) < abs(luminance($1) - lg) })
        else { return nil }
        let li = luminance(ink)
        return (max(lg, li) + 0.05) / (min(lg, li) + 0.05)
    }

    static func typeName(_ t: XCUIElement.ElementType) -> String {
        switch t {
        case .button: return "button"
        case .staticText: return "text"
        case .textField: return "field"
        case .image: return "image"
        case .other: return "other"
        default: return "type\(t.rawValue)"
        }
    }
}

extension JSONEncoder {
    static var pretty: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }
}
