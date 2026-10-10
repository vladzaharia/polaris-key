// The presentation core's state machines (UI-KITS §1.3 layer c, §5.2): one pure function per
// component from `KitInputs` to its `KitScreen`. Every kit in every language runs the same rows of
// conformance/corpus/v2/ui-matrix.json, so a SwiftUI screen, a React screen and a Godot scene fed
// the same inputs show the same state with the same copy keys.
//
// The functions are pure and SwiftUI-free: a host that draws its own UI calls them, and the
// @Observable models call them on every change.

import Foundation

/// The state machines, one per UI-KITS §4.1 component.
public enum KitStates {
    /// The answer for `component`, type-erased (the conformance runner's entry point).
    public static func resolve(_ component: KitComponent, _ inputs: KitInputs) -> AnyKitScreen {
        switch component {
        case .gate: return gate(inputs).erased
        case .boot: return boot(inputs).erased
        case .welcome: return welcome(inputs).erased
        case .signIn: return signIn(inputs).erased
        case .signInHandoff: return signInHandoff(inputs).erased
        case .activate: return activate(inputs).erased
        case .offlineActivation: return offlineActivation(inputs).erased
        case .deviceLimit: return deviceLimit(inputs).erased
        case .licenseChoice: return licenseChoice(inputs).erased
        case .devices: return devices(inputs).erased
        case .updatePrompt: return updatePrompt(inputs).erased
        case .updateProgress: return updateProgress(inputs).erased
        case .releaseNotes: return releaseNotes(inputs).erased
        case .statusScreen: return statusScreen(inputs).erased
        case .graceBanner: return graceBanner(inputs).erased
        case .accountAndLicense: return accountAndLicense(inputs).erased
        case .settings: return settings(inputs).erased
        case .paywall: return paywall(inputs).erased
        case .entitlementGate: return entitlementGate(inputs).erased
        case .toast: return toast(inputs).erased
        }
    }
}

/// The values every state function reads: the inputs and the resolved product.
struct Ctx {
    let i: KitInputs
    let identity: ResolvedIdentity

    init(_ inputs: KitInputs) {
        i = inputs
        identity = KitIdentity.resolve(inputs)
    }

    var product: CopyArgument { .text(identity.name) }
    var productArg: [String: CopyArgument] { ["product": product] }
    var developerArg: [String: CopyArgument] {
        ["developer": .text(identity.developer ?? identity.name)]
    }
    var formFactor: CopyArgument { .text(i.platform.formFactor.rawValue) }

    func line(_ key: String, _ args: [String: CopyArgument] = [:]) -> CopyLine {
        CopyLine(key, args)
    }

    /// A `core.codes` code's title and message, or the catalog's fallback for a code it does not
    /// know (DL7: an unknown code shows the fallback sentence, never the raw code).
    func codeLines(_ code: String?) -> [CopyLine] {
        let catalog = KitCopy.bundled
        if let code, catalog.has("core.codes.\(code).title") {
            return [
                line("core.codes.\(code).title", productArg),
                line("core.codes.\(code).message", productArg),
            ]
        }
        return [line("core.fallback.title"), line("core.fallback.message")]
    }

    /// The download line's arguments from the update's progress.
    /// The download's counted bytes and time left, each only when known: a line whose arguments
    /// are missing is not drawn (`CopyLine.isComplete`), so the copy never invents a size.
    var progressArgs: [String: CopyArgument] {
        guard let p = i.update?.progress else { return [:] }
        var args: [String: CopyArgument] = [:]
        if let done = p.bytes, let total = p.totalBytes, total > 0 {
            args["size"] = .text(KitFormat.bytes(done))
            args["total"] = .text(KitFormat.bytes(total))
        }
        if let seconds = p.secondsLeft { args["time"] = .text(KitFormat.duration(seconds)) }
        return args
    }
}

/// Formatting the core needs for its arguments (the views reformat with the live locale).
public enum KitFormat {
    /// Bytes as "50 MB" in the file style.
    public static func bytes(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }

    /// A duration as "4:12" (or "1:04:12").
    public static func duration(_ seconds: Double) -> String {
        let total = Int(max(0, seconds).rounded())
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// A fraction as a whole percentage.
    public static func percent(_ fraction: Double) -> String {
        "\(Int((max(0, min(1, fraction)) * 100).rounded()))%"
    }

    /// The date `days` from now, medium style, for "Reconnect by …".
    public static func dayAfter(_ days: Int, from now: Date = Date()) -> String {
        let date = Calendar.current.date(byAdding: .day, value: days, to: now) ?? now
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    /// Epoch seconds as a date, for "Until …".
    public static func date(_ epochSeconds: Int) -> String {
        Date(timeIntervalSince1970: TimeInterval(epochSeconds)).formatted(
            date: .abbreviated, time: .omitted)
    }

    /// A calendar day (`2026-09-30`, as release notes carry it) in the locale's abbreviated style,
    /// never the raw ISO date (DL8); anything else is shown as given.
    public static func day(_ iso: String) -> String {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(identifier: "UTC")
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: String(iso.prefix(10))) else { return iso }
        var style = Date.FormatStyle(date: .abbreviated, time: .omitted)
        style.timeZone = TimeZone(identifier: "UTC")!
        return date.formatted(style)
    }

    /// A platform id as people read it (DL8: never a raw id): `macos` is macOS.
    public static func platformName(_ id: String) -> String {
        switch id.lowercased() {
        case "macos": return "macOS"
        case "ios": return "iOS"
        case "ipados": return "iPadOS"
        case "android": return "Android"
        case "windows": return "Windows"
        case "linux": return "Linux"
        case "web": return "Web"
        case "tvos": return "tvOS"
        case "visionos": return "visionOS"
        case "watchos": return "watchOS"
        default: return id
        }
    }

    /// "today", "3 days ago": the relative time a device was last seen.
    public static func daysAgo(_ days: Int, from now: Date = Date()) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        formatter.dateTimeStyle = .named
        return formatter.localizedString(
            for: Calendar.current.date(byAdding: .day, value: -days, to: now) ?? now,
            relativeTo: now)
    }
}
