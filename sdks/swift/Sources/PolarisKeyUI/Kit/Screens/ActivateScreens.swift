// @pkey-feature ui.activate ui.devicelimit
// Activate (license key entry with the live verdict) and DeviceLimit (Replace a device on the key
// path), UI-KITS §4.3. A full license is a limit, not an error: the device-limit callout is
// neutral, on the sunken surface, and its fix is the screen's only primary (DL6).

import PolarisKeyUICore
import SwiftUI

/// The two refusals of a well-formed key whose fix is an account (never an error, DL6): the
/// licence has no key entries left, or an account already holds it.
enum ActivateRefusal: Equatable {
    case keyEntryLimit, licenseOwned

    static func of(_ screen: KitScreen<ActivateState>) -> ActivateRefusal? {
        switch screen.state {
        case .keyEntryLimit: return .keyEntryLimit
        case .licenseOwned: return .licenseOwned
        default: return nil
        }
    }

    /// The refusal's link when the server gave a valid one.
    static func link(_ screen: KitScreen<ActivateState>, _ activation: KitActivation?) -> URL? {
        switch of(screen) {
        case .keyEntryLimit: return KitLinks.valid(activation?.manageUrl)
        case .licenseOwned: return KitLinks.valid(activation?.signInUrl)
        case nil: return nil
        }
    }

    /// The primary: add the key to an account, or sign in to the one that has it.
    var actionKey: String {
        switch self {
        case .keyEntryLimit: return "signin.key.addInLocker"
        case .licenseOwned: return "signin.key.ownedSignIn"
        }
    }
}

/// The focused step of the two account refusals (SIGN-IN.md §4.5): the product header, the
/// refusal's title and sentence, a QR on a TV, then Sign in (the primary), the add-it link and
/// Use a different key. No key field: resubmitting the same key cannot succeed.
struct RefusalStep: View {
    let screen: KitScreen<ActivateState>
    let refusal: ActivateRefusal
    var link: URL?
    var onSignIn: (() -> Void)?
    var onOpenLink: (() -> Void)?
    var onDifferentKey: () -> Void
    @Environment(\.polarisKeyStrings) private var strings

    /// A TV cannot open the page: the QR and its caption stand in for the link.
    private static var isTV: Bool {
        #if os(tvOS)
            return true
        #else
            return false
        #endif
    }

    var body: some View {
        kitStyle { style in
            let product: [String: CopyArgument] = ["product": .text(style.identity.name)]
            let title =
                refusal == .keyEntryLimit
                ? CopyLine("core.activation.key-entry-limit.title")
                : CopyLine("core.codes.license_owned.title", product)
            let message =
                refusal == .keyEntryLimit
                ? CopyLine("core.activation.key-entry-limit.message")
                : CopyLine("core.codes.license_owned.message", product)
            KitScreenScaffold(header: true) {
                KitText(title, .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } content: {
                VStack(alignment: .leading, spacing: style.space(.md)) {
                    KitText(message, .body, color: .default)
                    #if os(tvOS)
                        if let link {
                            PolarisQRCode(
                                link.absoluteString,
                                accessibilityLabel: strings.string(
                                    refusal == .keyEntryLimit ? "a11y.qrAddKey" : "a11y.qr")
                            )
                            .frame(width: 200, height: 200)
                            if refusal == .keyEntryLimit {
                                KitText(CopyLine("signin.key.scan"), .meta, color: .muted)
                            }
                        }
                    #endif
                }
            } actions: {
                KitActionStack {
                    // Sign in finishes in the app; the link is the primary only when the kit has
                    // no sign-in to start.
                    if let onSignIn {
                        KitButton(
                            line: CopyLine(
                                refusal == .keyEntryLimit
                                    ? "signin.key.signIn" : "signin.key.ownedSignIn"),
                            kind: .primary, action: onSignIn
                        )
                        .keyboardShortcut(.defaultAction)
                    }
                    if let onOpenLink, !Self.isTV, refusal == .keyEntryLimit || onSignIn == nil {
                        KitButton(
                            line: CopyLine(
                                refusal.actionKey, ["product": .text(style.identity.name)]),
                            kind: onSignIn == nil ? .primary : .secondary,
                            glyph: PolarisKitGlyph.newWindow, action: onOpenLink)
                    }
                    KitButton(
                        line: CopyLine("signin.key.differentKey"), kind: .quiet,
                        action: onDifferentKey)
                }
            }
        }
    }
}

/// The key field step. Return submits; the button keeps its label while busy; a refusal sits under
/// the control that caused it and is announced (DL7).
public struct ActivateView: View {
    let screen: KitScreen<ActivateState>
    @Binding var text: String
    var onSubmit: () -> Void
    var onReplaceDevice: (() -> Void)?
    var onCancel: (() -> Void)?
    var onDone: (() -> Void)?
    /// The refusal's fix, when the server gave a link: the key-entry limit's account page or the
    /// owning account's sign-in. Nil hides it (and, on a TV, the QR).
    var refusalLink: URL?
    var onRefusalLink: (() -> Void)?
    /// The kit's own sign-in (the gate's), offered while Identity is on: the primary of both
    /// account refusals. Nil when the kit cannot sign in.
    var onSignIn: (() -> Void)?

    /// `onDone` carries the Done step's one action (Start using <Product>, DL4): a lone action is
    /// always the primary. The drop-in gate leaves it nil because the app opens on success.
    public init(
        screen: KitScreen<ActivateState>, text: Binding<String>, onSubmit: @escaping () -> Void,
        onReplaceDevice: (() -> Void)? = nil, onCancel: (() -> Void)? = nil,
        onDone: (() -> Void)? = nil, refusalLink: URL? = nil, onRefusalLink: (() -> Void)? = nil,
        onSignIn: (() -> Void)? = nil
    ) {
        self.onSignIn = onSignIn
        self.screen = screen
        self._text = text
        self.refusalLink = refusalLink
        self.onRefusalLink = onRefusalLink
        self.onSubmit = onSubmit
        self.onReplaceDevice = onReplaceDevice
        self.onCancel = onCancel
        self.onDone = onDone
    }

    public var body: some View {
        if let refusal = ActivateRefusal.of(screen), onSignIn != nil || refusalLink != nil {
            RefusalStep(
                screen: screen, refusal: refusal, link: refusalLink, onSignIn: onSignIn,
                onOpenLink: onRefusalLink, onDifferentKey: { text = "" })
        } else {
            form
        }
    }

    private var form: some View {
        KitScreenScaffold(header: true) {
            // Done names its state: the outcome is the heading, not a row under the old one.
            VStack(alignment: .leading, spacing: 6) {
                KitText(
                    screen.state == .done
                        ? screen.lineOrKey("core.activation.ok.title") : CopyLine("activate.title"),
                    .title, color: .strong
                )
                .accessibilityAddTraits(.isHeader)
                KitText(
                    screen.state == .done
                        ? screen.lineOrKey("core.activation.ok.message")
                        : CopyLine("activate.lede"),
                    .body, color: .default)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } content: {
            ActivateBody(
                screen: screen, text: $text, onSubmit: onSubmit, onReplaceDevice: onReplaceDevice,
                outcomeIsHeading: true, refusalLink: refusalLink)
        } actions: {
            ActivateActions(
                screen: screen, onSubmit: onSubmit, onReplaceDevice: onReplaceDevice,
                onCancel: onCancel, onDone: onDone, onDifferentKey: { text = "" },
                onRefusalLink: onRefusalLink)
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
    /// Activate's own screen titles the outcome; an embedding form shows it here.
    var outcomeIsHeading = false
    /// The refusal's link, drawn as a QR on a TV (which cannot open it).
    var refusalLink: URL?
    @Environment(\.polarisKeyStrings) private var strings

    var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.md)) {
                if screen.state != .done {
                    KeyField(text: $text, screen: screen, onSubmit: onSubmit)
                }
                outcome(style)
                #if os(tvOS)
                    if let link = refusalLink, ActivateRefusal.of(screen) != nil {
                        PolarisQRCode(
                            link.absoluteString,
                            accessibilityLabel: strings.string(
                                ActivateRefusal.of(screen) == .keyEntryLimit
                                    ? "a11y.qrManage" : "a11y.qr")
                        )
                        .frame(width: 200, height: 200)
                    }
                #endif
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
                // On Activate's own screen the outcome is already the heading.
                if !outcomeIsHeading {
                    VStack(alignment: .leading, spacing: 4) {
                        KitText(
                            screen.lineOrKey("core.activation.ok.title"), .headline, color: .strong)
                        KitText(
                            screen.lineOrKey("core.activation.ok.message"), .body, color: .default)
                    }
                }
            }
        case .deviceLimit, .rejected, .keyEntryLimit, .licenseOwned:
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
    /// VoiceOver lands on the refusal when it appears (DL7), so the person hears it and its fix.
    @AccessibilityFocusState private var focused: Bool

    var body: some View {
        kitStyle { style in
            let title = screen.copy.first {
                $0.key.hasPrefix("core.") && $0.key.hasSuffix(".title")
            }
            let message = screen.copy.first {
                $0.key.hasPrefix("core.") && $0.key.hasSuffix(".message")
            }
            VStack(alignment: .leading, spacing: style.space(.xs)) {
                if let title {
                    #if os(macOS)
                        if screen.state == .rejected {
                            Label {
                                KitText(title, .label, color: .strong)
                            } icon: {
                                Image(systemName: "exclamationmark.circle.fill")
                                    .foregroundStyle(style.palette.danger)
                                    .accessibilityHidden(true)
                            }
                        } else {
                            KitText(title, .label, color: .strong)
                        }
                    #else
                        KitText(title, .label, color: .strong)
                    #endif
                }
                if let message {
                    #if os(macOS)
                        // A refusal with no title of its own carries the glyph on its message.
                        if screen.state == .rejected, title == nil {
                            Label {
                                KitText(message, .meta, color: .default)
                            } icon: {
                                Image(systemName: "exclamationmark.circle.fill")
                                    .foregroundStyle(style.palette.danger)
                                    .accessibilityHidden(true)
                            }
                        } else {
                            KitText(message, .meta, color: .default)
                        }
                    #else
                        KitText(message, .meta, color: .default)
                    #endif
                }
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
            .accessibilityFocused($focused)
            .onAppear { focused = true }
        }
    }
}

/// The step's act: Activate, or the device-limit fix as the only primary.
struct ActivateActions: View {
    let screen: KitScreen<ActivateState>
    var onSubmit: () -> Void
    var onReplaceDevice: (() -> Void)?
    var onCancel: (() -> Void)?
    var onDone: (() -> Void)?
    /// A refused key's way on (macOS): clear the field and focus it.
    var onDifferentKey: (() -> Void)?
    /// A refusal's fix when the server gave a link (nil on a TV, which shows a QR instead).
    var onRefusalLink: (() -> Void)?

    /// Whether a refusal is the service's answer to a well-formed key (a callout, not the field's
    /// own message): the fix is a different key.
    static func refusesTheKey(_ screen: KitScreen<ActivateState>) -> Bool {
        (screen.state == .rejected || ActivateRefusal.of(screen) != nil)
            && screen.copy.contains { $0.key.hasPrefix("core.") }
    }

    /// The device-limit fix's label: "Replace a Device" on a Mac (the button's `macos` variant, title
    /// case), the screen's title elsewhere.
    static var replaceKey: String {
        #if os(macOS)
            return "signin.replace.open"
        #else
            return "deviceLimit.title"
        #endif
    }

    /// The secondary verb: on a Mac "Back" inline and "Cancel" in a sheet, drawn as a bordered
    /// secondary directly left of the default; a quiet "Cancel" elsewhere.
    @Environment(\.kitInSheet) private var inSheet
    var cancelKey: String {
        #if os(macOS)
            return inSheet ? "common.cancel" : "common.back"
        #else
            return "common.cancel"
        #endif
    }
    static var cancelKind: KitButtonKind {
        #if os(macOS)
            return .secondary
        #else
            return .quiet
        #endif
    }

    /// The Done step's lone action, when the host gave one (DL4: a lone action is the primary).
    static func doneActionKey(onDone: Bool) -> String? { onDone ? "signin.done.start" : nil }

    var body: some View {
        KitActionStack {
            switch screen.state {
            case .deviceLimit:
                if screen.line("deviceLimit.noManage") == nil, let onReplaceDevice {
                    KitButton(
                        line: screen.lineOrKey(Self.replaceKey), kind: .primary,
                        glyph: PolarisKitGlyph.newWindow, action: onReplaceDevice
                    )
                    .keyboardShortcut(.defaultAction)
                } else {
                    KitButton(line: CopyLine("common.tryAgain"), kind: .primary, action: onSubmit)
                        .keyboardShortcut(.defaultAction)
                }
            case .done:
                if Self.doneActionKey(onDone: onDone != nil) != nil, let onDone {
                    kitStyle { style in
                        KitButton(
                            line: CopyLine(
                                "signin.done.start", ["product": .text(style.identity.name)]),
                            kind: .primary, action: onDone
                        )
                        .keyboardShortcut(.defaultAction)
                    }
                }
            default:
                if let refusal = ActivateRefusal.of(screen), let onRefusalLink {
                    kitStyle { style in
                        KitButton(
                            line: CopyLine(
                                refusal.actionKey, ["product": .text(style.identity.name)]),
                            kind: .primary, glyph: PolarisKitGlyph.newWindow, action: onRefusalLink
                        )
                        .keyboardShortcut(.defaultAction)
                    }
                    if let onDifferentKey {
                        KitButton(
                            line: CopyLine("signin.key.differentKey"), kind: .quiet,
                            action: onDifferentKey)
                    }
                } else if Self.refusesTheKey(screen), let onDifferentKey {
                    KitButton(
                        line: CopyLine("signin.key.differentKey"), kind: .primary,
                        action: onDifferentKey
                    )
                    .keyboardShortcut(.defaultAction)
                } else {
                    KitButton(
                        line: CopyLine("activate.submit"), kind: .primary,
                        busy: screen.state == .busy, action: onSubmit
                    )
                    .keyboardShortcut(.defaultAction)
                }
            }
            if let onCancel, screen.state != .done {
                KitButton(line: CopyLine(cancelKey), kind: Self.cancelKind, action: onCancel)
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
                // The component is titled Replace a device in every kit (UI-KITS DeviceLimit,
                // owner 2026-10-05); the seat count is the line under it.
                KitText(screen.lineOrKey(ActivateActions.replaceKey), .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                if let count = screen.line("deviceLimit.heading") {
                    KitText(count, .headline, color: .strong)
                }
                if let lede = screen.line("deviceLimit.lede") ?? screen.line("deviceLimit.browser") {
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
                            glyph: PolarisKitGlyph.newWindow, action: onOpenBrowser
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
                KitButton(line: CopyLine("common.back"), kind: ActivateActions.cancelKind, action: onBack)
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
                    SeatMeter(used: used, limit: limit, showsCaption: showsSeatCaption)
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

    /// The count is stated once: the heading says "3 of 3" on a Mac, so the meter is the picture.
    private var showsSeatCaption: Bool {
        #if os(macOS)
            return screen.line("deviceLimit.heading") == nil
        #else
            return true
        #endif
    }

    private var leastRecent: String? {
        devices.filter { !$0.current }.max { $0.lastSeenDays < $1.lastSeenDays }?.name
    }
}
