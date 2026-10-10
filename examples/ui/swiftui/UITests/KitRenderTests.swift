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
        "Activate.done", "SignIn.methods", "SignIn.handoff", "SignIn.finishing", "SignIn.done",
        "SignIn.error", "SignIn.expired", "SignInHandoff.no-browser", "SignInHandoff.starting",
        "SignInHandoff.code", "SignInHandoff.denied", "SignInHandoff.expired",
        "DeviceLimit.browser-mode", "DeviceLimit.default", "StatusScreen.revoked",
        "StatusScreen.expired", "StatusScreen.version-too-old", "StatusScreen.version-too-new",
        "StatusScreen.channel-not-entitled", "GraceBanner.days-left", "GraceBanner.last-day",
    ]

    var out: URL? {
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["PKEY_KIT_SHOTS"] ?? env["TEST_RUNNER_PKEY_KIT_SHOTS"] else {
            return nil
        }
        return URL(fileURLWithPath: dir)
    }

    var device: String {
        let env = ProcessInfo.processInfo.environment
        if let label = env["PKEY_KIT_DEVICE"] ?? env["TEST_RUNNER_PKEY_KIT_DEVICE"], !label.isEmpty {
            return label
        }
        return env["SIMULATOR_DEVICE_NAME"]?.lowercased().replacingOccurrences(of: " ", with: "-")
            ?? "device"
    }

    @MainActor
    func testRenders() throws {
        let only = ProcessInfo.processInfo.environment["PKEY_KIT_ONLY"]
            ?? ProcessInfo.processInfo.environment["TEST_RUNNER_PKEY_KIT_ONLY"]
        let states = only.map { $0.split(separator: ",").map(String.init) } ?? Self.all
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
        }
        XCUIDevice.shared.orientation = .portrait
        if let out {
            let data = try JSONEncoder.pretty.encode(renders)
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            try data.write(to: out.appendingPathComponent("renders-\(device).json"))
        }
        let kitIssues = renders.flatMap { r in r.audit.map { "\(r.state) \(r.scheme) \(r.type): \($0)" } }
        XCTAssertEqual(kitIssues, [], "accessibility audit issues")
    }

    @MainActor
    private func render(
        _ state: String, scheme: String, type: String = "L",
        orientation: UIDeviceOrientation = .portrait, preset: String = "polaris-key"
    ) throws -> Render {
        XCUIDevice.shared.orientation = orientation
        let app = XCUIApplication()
        var args = ["-pkeyState", state, "-pkeyScheme", scheme]
        if preset == "native" { args += ["-pkeyPreset", "native"] }
        let category: String
        switch type {
        case "AX3": category = "UICTContentSizeCategoryAccessibilityExtraLarge"
        case "AX5": category = "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge"
        default: category = "UICTContentSizeCategoryL"
        }
        args += ["-UIPreferredContentSizeCategoryName", category]
        let env = ProcessInfo.processInfo.environment
        if let extra = env["PKEY_KIT_EXTRA_ARGS"] ?? env["TEST_RUNNER_PKEY_KIT_EXTRA_ARGS"] {
            args += extra.split(separator: " ").map(String.init)
        }
        app.launchArguments = args
        app.launch()
        // The 250 ms loading grace and the first layout.
        _ = app.wait(for: .runningForeground, timeout: 10)
        Thread.sleep(forTimeInterval: 0.9)

        let orientationName = orientation == .portrait ? "portrait" : "landscape"
        let name = "\(device)-\(orientationName)-\(type)-\(preset)-\(scheme)"
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

        var issues: [String] = []
        try app.performAccessibilityAudit(for: .all) { issue in
            let label = issue.element.map { "'\($0.label)'" } ?? "-"
            let exempt = Self.exempt.contains {
                issue.compactDescription.contains($0.audit) && $0.element == label
            }
            if !exempt {
                let type = issue.element.map { Self.typeName($0.elementType) } ?? "-"
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
