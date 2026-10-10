// @pkey-feature ui.activate ui.devicelimit
// Activate (license key entry with the live verdict) and DeviceLimit (Replace a device on the key
// path), UI-KITS §4.3. A full license is a limit, not an error: the device-limit callout is
// neutral, on the sunken surface, and its fix is the screen's only primary (DL6).

import PolarisKeyUICore
import SwiftUI

/// The key field step. Return submits; the button keeps its label while busy; a refusal sits under
/// the control that caused it and is announced (DL7).
public struct ActivateView: View {
    let screen: KitScreen<ActivateState>
    @Binding var text: String
    var onSubmit: () -> Void
    var onReplaceDevice: (() -> Void)?
    var onCancel: (() -> Void)?

    @AccessibilityFocusState private var calloutFocused: Bool

    public init(
        screen: KitScreen<ActivateState>, text: Binding<String>, onSubmit: @escaping () -> Void,
        onReplaceDevice: (() -> Void)? = nil, onCancel: (() -> Void)? = nil
    ) {
        self.screen = screen
        self._text = text
        self.onSubmit = onSubmit
        self.onReplaceDevice = onReplaceDevice
        self.onCancel = onCancel
    }

    public var body: some View {
        KitScreenScaffold(header: true) {
            VStack(alignment: .leading, spacing: 6) {
                KitText("activate.title", [:], .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                KitText("activate.lede", [:], .body, color: .default)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } content: {
            ActivateBody(
                screen: screen, text: $text, onSubmit: onSubmit, onReplaceDevice: onReplaceDevice)
        } actions: {
            ActivateActions(
                screen: screen, onSubmit: onSubmit, onReplaceDevice: onReplaceDevice,
                onCancel: onCancel)
        }
    }
}

/// The field, the verdict and the outcome callout: the part a form embeds (Welcome's key-only
/// path, the sign-in form's key step).
struct ActivateBody: View {
    let screen: KitScreen<ActivateState>
    @Binding var text: String
    var onSubmit: () -> Void
    var onReplaceDevice: (() -> Void)?

    var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if screen.state != .done {
                    KeyField(text: $text, screen: screen, onSubmit: onSubmit)
                }
                outcome(style)
            }
            .animation(style.morph, value: screen.stateName)
        }
    }

    @ViewBuilder private func outcome(_ style: KitResolvedStyle) -> some View {
        switch screen.state {
        case .done:
            HStack(alignment: .top, spacing: style.space(.sm)) {
                Image(systemName: "checkmark.circle.fill")
                    .font(style.font(.title))
                    .foregroundStyle(style.palette.success)
                    .symbolEffect(.bounce, options: .nonRepeating, isActive: !style.reduceMotion)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    KitText(screen.lineOrKey("core.activation.ok.title"), .headline, color: .strong)
                    KitText(screen.lineOrKey("core.activation.ok.message"), .body, color: .default)
                }
            }
        case .deviceLimit, .rejected:
            if screen.state == .deviceLimit
                || screen.copy.contains(where: { $0.key.hasPrefix("core.") })
            {
                KitCallout(screen: screen)
            }
        default:
            EmptyView()
        }
    }
}

/// The neutral callout under the field (DL6): default text on the sunken surface, no danger
/// colour and no error glyph for a valid key that met a limit.
struct KitCallout: View {
    let screen: KitScreen<ActivateState>

    var body: some View {
        kitStyle { style in
            let title = screen.copy.first {
                $0.key.hasPrefix("core.") && $0.key.hasSuffix(".title")
            }
            let message = screen.copy.first {
                $0.key.hasPrefix("core.") && $0.key.hasSuffix(".message")
            }
            VStack(alignment: .leading, spacing: style.space(.xs)) {
                if let title { KitText(title, .label, color: .strong) }
                if let message { KitText(message, .meta, color: .default) }
                if let caption = screen.line("part.seatMeter.caption"),
                    case .number(let used)? = caption.args["used"],
                    case .number(let limit)? = caption.args["limit"]
                {
                    SeatMeter(used: used, limit: limit).padding(.top, 4)
                }
                if let noManage = screen.line("deviceLimit.noManage") {
                    KitText(noManage, .meta, color: .muted)
                }
            }
            .padding(style.space(.md))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                    .fill(style.palette.sunken)
            )
            .accessibilityElement(children: .combine)
        }
    }
}

/// The step's act: Activate, or the device-limit fix as the only primary.
struct ActivateActions: View {
    let screen: KitScreen<ActivateState>
    var onSubmit: () -> Void
    var onReplaceDevice: (() -> Void)?
    var onCancel: (() -> Void)?

    var body: some View {
        KitActionStack {
            switch screen.state {
            case .deviceLimit:
                if screen.line("deviceLimit.noManage") == nil, let onReplaceDevice {
                    KitButton(
                        line: screen.lineOrKey("deviceLimit.title"), kind: .primary,
                        glyph: "arrow.up.right", action: onReplaceDevice
                    )
                    .keyboardShortcut(.defaultAction)
                } else {
                    KitButton(line: CopyLine("common.tryAgain"), kind: .primary, action: onSubmit)
                        .keyboardShortcut(.defaultAction)
                }
            case .done:
                EmptyView()
            default:
                KitButton(
                    line: CopyLine("activate.submit"), kind: .primary, busy: screen.state == .busy,
                    action: onSubmit
                )
                .keyboardShortcut(.defaultAction)
            }
            if let onCancel, screen.state != .done {
                KitButton(line: CopyLine("common.cancel"), kind: .quiet, action: onCancel)
                    .keyboardShortcut(.cancelAction)
            }
        }
    }
}

// MARK: - Device limit

/// Replace a device on the key path (UI-KITS §4.3 DeviceLimit). In layer 1 there is no device-wire
/// list for a refused key, so the browser mode opens `manageUrl` (PX-W8) and the kit retries once
/// on return; the in-app list arrives with I-13 and renders when the inputs carry it.
public struct DeviceLimitView: View {
    let screen: KitScreen<DeviceLimitState>
    let devices: [KitDevice]
    @Binding var selection: String?
    var onOpenBrowser: () -> Void
    var onReplace: () -> Void
    var onBack: () -> Void
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        screen: KitScreen<DeviceLimitState>, devices: [KitDevice] = [],
        selection: Binding<String?> = .constant(nil), onOpenBrowser: @escaping () -> Void,
        onReplace: @escaping () -> Void = {}, onBack: @escaping () -> Void
    ) {
        self.screen = screen
        self.devices = devices
        self._selection = selection
        self.onOpenBrowser = onOpenBrowser
        self.onReplace = onReplace
        self.onBack = onBack
    }

    public var body: some View {
        KitScreenScaffold(header: true) {
            VStack(alignment: .leading, spacing: 6) {
                KitText(
                    screen.line("deviceLimit.heading") ?? screen.lineOrKey("deviceLimit.title"),
                    .title, color: .strong
                )
                .accessibilityAddTraits(.isHeader)
                if let lede = screen.line("deviceLimit.lede") ?? screen.line("deviceLimit.browser")
                {
                    KitText(lede, .body, color: .default)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } content: {
            content
        } actions: {
            KitActionStack {
                switch screen.state {
                case .browserMode:
                    if screen.shows("deviceLimit.openBrowser") {
                        KitButton(
                            line: CopyLine("deviceLimit.openBrowser"), kind: .primary,
                            glyph: "arrow.up.right", action: onOpenBrowser
                        )
                        .keyboardShortcut(.defaultAction)
                    }
                case .default, .busy:
                    KitButton(
                        line: CopyLine("deviceLimit.primary"), kind: .primary,
                        busy: screen.state == .busy, action: onReplace
                    )
                    .keyboardShortcut(.defaultAction)
                case .failed:
                    KitButton(line: CopyLine("common.tryAgain"), kind: .primary, action: onReplace)
                case .removed, .none:
                    EmptyView()
                }
                KitButton(line: CopyLine("common.back"), kind: .quiet, action: onBack)
                    .keyboardShortcut(.cancelAction)
            }
        }
    }

    @ViewBuilder private var content: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if let caption = screen.line("part.seatMeter.caption"),
                    case .number(let used)? = caption.args["used"],
                    case .number(let limit)? = caption.args["limit"]
                {
                    SeatMeter(used: used, limit: limit)
                }
                if screen.state == .default || screen.state == .busy {
                    VStack(spacing: 0) {
                        ForEach(Array(devices.enumerated()), id: \.offset) { index, device in
                            Button {
                                selection = device.name
                            } label: {
                                DeviceRow(
                                    name: device.name, formFactor: device.formFactor.rawValue,
                                    meta: strings.string(
                                        "signin.replace.meta",
                                        [
                                            "platform": .text(
                                                KitFormat.platformName(device.platform)),
                                            "when": .text(KitFormat.daysAgo(device.lastSeenDays)),
                                        ]),
                                    leastRecent: device.name == leastRecent,
                                    selected: device.name == (selection ?? leastRecent))
                            }
                            .buttonStyle(.plain)
                            .padding(.horizontal, style.space(.md))
                            if index < devices.count - 1 {
                                Divider().padding(.leading, 56)
                            }
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                            .fill(style.palette.raised))
                    if let confirm = screen.line("deviceLimit.confirmTitle") {
                        VStack(alignment: .leading, spacing: 4) {
                            KitText(confirm, .label, color: .strong)
                            if let consequence = screen.line("deviceLimit.consequence") {
                                KitText(consequence, .meta, color: .muted)
                            }
                        }
                    }
                }
                if let line = screen.line("deviceLimit.removed")
                    ?? screen.line("deviceLimit.failed")
                {
                    KitText(line, .body, color: .default)
                }
            }
        }
    }

    private var leastRecent: String? {
        devices.filter { !$0.current }.max { $0.lastSeenDays < $1.lastSeenDays }?.name
    }
}
