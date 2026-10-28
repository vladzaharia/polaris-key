// The styled parts every screen shares (UI-KITS §4.1 "Styled parts"), each public on its own:
// ProductIcon and MonogramIcon, ProductHeader, KeyField, CodeDisplay, CountdownRing, SeatMeter,
// DeviceRow, StatusPill, LoadingIndicator, ProgressBar and PoweredBy. They read the resolved style
// and the copy from the environment, so a host can place one anywhere inside `.polarisKeyTheme`.

import PolarisKeyUICore
import SwiftUI

#if canImport(UIKit)
    import UIKit
#endif
#if os(macOS)
    import AppKit
#endif

// MARK: - Product identity

/// The product's icon at one size: the integrator's, the presentation's or the bundle's bitmap
/// in the app-icon shape, else the monogram (UI-KITS §1.2). Never a Polaris Key mark.
public struct ProductIcon: View {
    let size: CGFloat
    @Environment(\.kitIconImage) private var image

    public init(size: CGFloat) { self.size = size }

    public var body: some View {
        kitStyle { style in
            let shape = RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
            Group {
                if let image {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .interpolation(.high)
                        .scaledToFill()
                        .frame(width: size, height: size)
                        .clipShape(shape)
                        .overlay(
                            shape.strokeBorder(style.palette.border.opacity(0.6), lineWidth: 0.5))
                } else {
                    MonogramIcon(size: size)
                }
            }
            .accessibilityHidden(true)
        }
    }
}

/// The product's initial at weight 600 on the sunken surface, in the icon shape.
public struct MonogramIcon: View {
    let size: CGFloat
    public init(size: CGFloat) { self.size = size }

    public var body: some View {
        kitStyle { style in
            let shape = RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
            shape.fill(style.palette.raised)
                .overlay(shape.strokeBorder(style.palette.border, lineWidth: 1))
                .overlay(
                    Text(style.identity.monogram)
                        .font(.system(size: size * 0.46, weight: .semibold, design: .rounded))
                        .foregroundStyle(style.palette.textStrong)
                )
                .frame(width: size, height: size)
                .compositingGroup()
                .accessibilityHidden(true)
        }
    }
}

/// The product header of a focused step (UI-KITS §1.2): the 28 pt icon beside the name in the
/// strong text colour at weight 600 (LOGO-2: tile-to-cap about 2.3; the tile is no control), the tier after it in muted text as one run.
public struct ProductHeader: View {
    var tier: String?
    var showsIcon = true
    @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 28

    public init(tier: String? = nil, showsIcon: Bool = true) {
        self.tier = tier
        self.showsIcon = showsIcon
    }

    public var body: some View {
        kitStyle { style in
            HStack(spacing: style.space(.xs)) {
                if showsIcon { ProductIcon(size: min(iconSize, 48)) }
                Group {
                    if let tier {
                        Text(style.identity.name).foregroundStyle(style.palette.textStrong)
                            + Text(" · \(tier)").foregroundStyle(style.palette.textMuted)
                    } else {
                        Text(style.identity.name).foregroundStyle(style.palette.textStrong)
                    }
                }
                .font(style.font(.label))
                .fontWeight(.semibold)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Key field

/// The license key field (UI-KITS §4.3): a visible label, a filled field, visible and private
/// (no autocorrect, no learning, never logged), Paste inside, Return submits, and the live verdict
/// under it. A key never wraps: at rest it gives way in the middle, keeping the prefix and the
/// last six characters.
public struct KeyField: View {
    @Binding var text: String
    let screen: KitScreen<ActivateState>
    var onSubmit: () -> Void
    @FocusState private var focused: Bool
    @AccessibilityFocusState private var errorFocused: Bool

    @Environment(\.polarisKeyStrings) private var strings

    public init(
        text: Binding<String>, screen: KitScreen<ActivateState>, onSubmit: @escaping () -> Void
    ) {
        self._text = text
        self.screen = screen
        self.onSubmit = onSubmit
    }

    /// Not being edited, with a key in it.
    private var atRest: Bool { !focused && !text.isEmpty }

    /// A key that does not fit, at rest: the `pkey_<product>_` prefix and the last six
    /// characters (§4.3), so the person sees which product and which key.
    static func shortened(_ key: String) -> String {
        guard key.count > 12, let cut = key.lastIndex(of: "_") else { return key }
        let prefix = key[...cut]
        let rest = key[key.index(after: cut)...]
        guard rest.count > 6 else { return key }
        return prefix + "…" + rest.suffix(6)
    }

    /// The resting overlay's inset: a native (bordered) field insets its own text by this much.
    static func restingInset(native: Bool) -> CGFloat {
        #if os(macOS)
            return native ? 6 : 0
        #else
            return 0
        #endif
    }

    /// Only an input that is itself wrong takes the stroke (DL7): the key's own shape, or a key
    /// the service does not know. A refusal of a well-formed key is the neutral callout (DL6).
    private var invalid: Bool {
        screen.state == .rejected
            && (screen.shows("part.keyField.malformed")
                || screen.shows("part.keyField.empty")
                || screen.shows("core.activation.unauthorized.message"))
            || screen.state == .cutShort || macRefused
    }

    /// On a Mac a refused key puts the danger stroke on the field and the callout names why.
    private var macRefused: Bool {
        #if os(macOS)
            return screen.state == .rejected
        #else
            return false
        #endif
    }

    public var body: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.xs)) {
                KitText("part.keyField.label", [:], .meta, color: .muted)
                    .accessibilityHidden(true)
                HStack(spacing: style.space(.xs)) {
                    TextField(
                        strings.string("part.keyField.placeholder"), text: $text
                    )
                    .font(style.font(.key))
                    .lineLimit(1)
                    // At rest a long key is drawn by the overlay, which keeps the prefix.
                    .foregroundStyle(atRest ? Color.clear : style.palette.textStrong)
                    .overlay(alignment: .leading) {
                        if atRest {
                            ViewThatFits(in: .horizontal) {
                                Text(verbatim: text).fixedSize()
                                Text(verbatim: KeyField.shortened(text))
                            }
                            .font(style.font(.key))
                            .lineLimit(1)
                            .foregroundStyle(style.palette.textStrong)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                            .padding(.leading, KeyField.restingInset(native: style.isNative))
                        }
                    }
                    .autocorrectionDisabled()
                    #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.asciiCapable)
                    #endif
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit(onSubmit)
                    .accessibilityLabel(strings.string("part.keyField.label"))
                    .privacySensitive()
                    #if os(macOS)
                        .onChange(of: text) { _, new in if new.isEmpty { focused = true } }
                        // The system's rounded-border field wraps the text field itself, so the
                        // text keeps its inset from the border (not the container).
                        .modifier(KeyFieldNativeStyle(isNative: style.isNative))
                        .onAppear { focused = true }
                    #endif
                    #if os(iOS)
                        // Paste is for an empty field (every kit's model drops it once a key is
                        // there); the system dims it when the pasteboard holds no text, which read
                        // as a dead control beside a key that is already entered.
                        if text.isEmpty {
                            PasteButton(payloadType: String.self) { values in
                                if let first = values.first {
                                    Task { @MainActor in
                                        text = first.trimmingCharacters(in: .whitespacesAndNewlines)
                                    }
                                }
                            }
                            .labelStyle(.titleAndIcon)
                            .buttonBorderShape(.capsule)
                            .tint(style.palette.accentFg)
                        }
                    #endif
                    #if os(macOS)
                        // Paste sits inside the field, small (desktop.html); the Tab order
                        // reaches it like any control.
                        if text.isEmpty {
                            Button(strings.string("common.paste")) {
                                if let pasted = NSPasteboard.general.string(forType: .string) {
                                    text = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
                                }
                            }
                            .controlSize(.small)
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.capsule)
                            .tint(style.palette.accentFg)
                        }
                    #endif
                }
                .modifier(KeyFieldSurface(style: style, invalid: invalid, focused: focused))
                verdict(style)
            }
        }
    }

    /// The live verdict under the field: the product from the prefix, the server's answer once
    /// it came, or the error, announced and cleared on edit (DL7).
    @ViewBuilder private func verdict(_ style: KitResolvedStyle) -> some View {
        Group {
            if let line = screen.line("part.keyField.forProduct") {
                #if os(macOS)
                    // The mockup's verdict: the success glyph, then what the key names. The tier
                    // and term are the server's answer and are not known before it.
                    Label {
                        KitText(line, .meta, color: .default)
                    } icon: {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(style.palette.success)
                            .accessibilityHidden(true)
                    }
                #else
                    KitText(line, .meta, color: .muted)
                #endif
            } else if let line = screen.line("part.keyField.cutShort")
                ?? screen.line("part.keyField.malformed") ?? screen.line("part.keyField.empty")
            {
                Label {
                    KitText(line, .meta, color: .danger)
                } icon: {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(style.palette.danger)
                        .accessibilityHidden(true)
                }
                .accessibilityFocused($errorFocused)
            }
        }
        .animation(style.morph, value: screen.stateName)
    }
}

/// The field's surface. Under `polaris-key` it is filled (sunken) with the accent focus ring; on
/// macOS under `native` it is the system's `.roundedBorder` large field, whose focus ring is the
/// system's. A wrong key takes the danger stroke in both (DL7).
private struct KeyFieldSurface: ViewModifier {
    let style: KitResolvedStyle
    let invalid: Bool
    let focused: Bool

    func body(content: Content) -> some View {
        #if os(macOS)
            if style.isNative {
                content
                    .overlay(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .strokeBorder(invalid ? style.palette.danger : .clear, lineWidth: 1.5)
                    )
            } else {
                filled(content)
            }
        #else
            filled(content)
        #endif
    }

    private func filled(_ content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .padding(.horizontal, style.space(.md))
            .frame(minHeight: style.controlHeight)
            .background(
                RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                    .fill(style.palette.sunken)
            )
            .overlay(
                RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                    .strokeBorder(
                        invalid ? style.palette.danger : (focused ? style.palette.focus : .clear),
                        lineWidth: 2)
            )
    }
}

// MARK: - Sign-in code

/// The device-code display (UI-KITS §4.3): two groups of four in the kit mono, centred on a
/// borderless fill so it reads as output, with Copy at the inline end. VoiceOver reads it
/// character by character.
public struct CodeDisplay: View {
    let code: String
    @State private var copied = false
    @Environment(\.polarisKeyStrings) private var strings

    public init(code: String) { self.code = code }

    /// 40 pt at weight 500 with 0.12 em tracking (§4.3); it shrinks only to fit the line (a code
    /// breaks nowhere), never below the title beside it (DL10).
    static let size: CGFloat = 40
    static let tracking: CGFloat = 0.12

    public var body: some View {
        kitStyle { style in
            HStack(spacing: style.space(.sm)) {
                Text(code)
                    .font(style.codeFont(size: CodeDisplay.size))
                    .tracking(CodeDisplay.size * CodeDisplay.tracking)
                    .foregroundStyle(style.palette.textStrong)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .accessibilityLabel(
                        strings.string(
                            "a11y.code",
                            ["code": .text(code.map(String.init).joined(separator: " "))])
                    )
                    .frame(maxWidth: .infinity)
                Button {
                    KitPasteboard.copy(code)
                    copied = true
                } label: {
                    #if os(macOS)
                        // A labelled button: the code's Copy and the address's Copy link read
                        // apart.
                        Label(
                            strings.string(copied ? "common.copied" : "common.copy"),
                            systemImage: copied ? "checkmark" : "doc.on.doc"
                        )
                        .font(style.font(.label))
                        .frame(minHeight: 28)
                        .contentShape(Rectangle())
                    #else
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(style.font(.label))
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    #endif
                }
                .buttonStyle(.plain)
                .foregroundStyle(style.palette.textMuted)
                .accessibilityLabel(strings.string(copied ? "common.copied" : "a11y.copyCode"))
            }
            .padding(.horizontal, style.space(.md))
            .padding(.vertical, style.space(.sm))
            .background(
                RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                    .fill(style.palette.sunken)
            )
            .overlay {
                // The box keeps its fill on a sheet's panel: a hairline marks its edge there.
                #if os(macOS)
                    RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                        .strokeBorder(style.palette.border, lineWidth: 1)
                #endif
            }
        }
    }
}

/// The determinate countdown ring (UI-KITS §1.5 rule 4): 20 pt, a 2 pt stroke in the accent,
/// draining linearly, beside the time in tabular figures. Under Reduce Motion it steps each second.
public struct CountdownRing: View {
    let expiresAt: Date
    let total: TimeInterval
    @Environment(\.polarisKeyStrings) private var strings

    public init(expiresAt: Date, total: TimeInterval) {
        self.expiresAt = expiresAt
        self.total = total
    }

    @Environment(\.polarisKeyNow) private var frozenNow

    public var body: some View {
        kitStyle { style in
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let left = max(0, expiresAt.timeIntervalSince(frozenNow ?? context.date))
                HStack(spacing: style.space(.xs)) {
                    ZStack {
                        Circle().stroke(style.palette.border, lineWidth: 2)
                        Circle()
                            .trim(from: 0, to: total > 0 ? left / total : 0)
                            .stroke(
                                style.palette.accentSolid,
                                style: StrokeStyle(lineWidth: 2, lineCap: .round)
                            )
                            .rotationEffect(.degrees(-90))
                    }
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)
                    KitText(
                        "signin.handoff.expires", ["time": .text(Self.clock(left))], .meta,
                        color: .muted
                    )
                    .monospacedDigit()
                }
            }
        }
    }

    static func clock(_ seconds: TimeInterval) -> String {
        let s = Int(seconds.rounded(.up))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

// MARK: - Seats and devices

/// The neutral seat meter (UI-KITS §1.5 rule 9): filled segments in strong text at 80 %, empty at
/// 10 %, with its caption. A full license is a limit, not an error.
public struct SeatMeter: View {
    let used: Int
    let limit: Int
    /// Draw the caption ("3 of 3 in use"). A license row already says "{used} of {limit} devices"
    /// beside its tier, so its meter is the picture alone, hidden from VoiceOver (SIGN-IN.md §3.6).
    var showsCaption = true
    /// A full license's used segments read in `text-muted`, never a warning colour (SIGN-IN.md
    /// §3.6, Full row).
    var muted = false
    @Environment(\.polarisKeyStrings) private var strings

    public init(used: Int, limit: Int, showsCaption: Bool = true, muted: Bool = false) {
        self.used = used
        self.limit = limit
        self.showsCaption = showsCaption
        self.muted = muted
    }

    public var body: some View {
        kitStyle { style in
            HStack(spacing: style.space(.sm)) {
                HStack(spacing: 4) {
                    ForEach(0..<max(1, min(limit, 12)), id: \.self) { index in
                        Capsule()
                            .fill(
                                (muted ? style.palette.textMuted : style.palette.textStrong)
                                    .opacity(index < used ? 0.8 : 0.1)
                            )
                            .frame(width: 24, height: 4)
                    }
                }
                if showsCaption {
                    KitText(
                        "part.seatMeter.caption", ["used": .number(used), "limit": .number(limit)],
                        .meta, color: .muted)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityHidden(!showsCaption)
            .accessibilityAddTraits(.isImage)
            .accessibilityLabel(
                strings.string("a11y.seatMeter", ["used": .number(used), "limit": .number(limit)]))
        }
    }
}

/// One device in a list: the form-factor glyph, the name, "platform · last used when", the
/// Least recent tag and the selection check (one indicator, rule 2).
public struct DeviceRow: View {
    let name: String?
    let formFactor: String
    let meta: String
    var leastRecent = false
    var selected = false
    @Environment(\.polarisKeyStrings) private var strings

    public init(
        name: String?, formFactor: String, meta: String, leastRecent: Bool = false,
        selected: Bool = false
    ) {
        self.name = name
        self.formFactor = formFactor
        self.meta = meta
        self.leastRecent = leastRecent
        self.selected = selected
    }

    public static func glyph(_ formFactor: String) -> String {
        switch formFactor {
        case "iphone", "phone": return "iphone"
        case "ipad", "tablet": return "ipad"
        case "mac": return "laptopcomputer"
        case "computer": return "desktopcomputer"
        case "tv": return "tv"
        default: return "laptopcomputer"
        }
    }

    public var body: some View {
        kitStyle { style in
            HStack(spacing: style.space(.sm)) {
                Image(systemName: Self.glyph(formFactor))
                    .font(.system(size: 20))
                    .foregroundStyle(style.palette.textMuted)
                    .frame(width: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: style.space(.xs)) {
                        Text(name ?? strings.string("devices.unnamed"))
                            .font(style.font(.body))
                            .foregroundStyle(style.palette.textStrong)
                            .fixedSize(horizontal: false, vertical: true)
                            .layoutPriority(1)
                        if leastRecent {
                            KitText("signin.replace.leastRecent", [:], .footnote, color: .strong)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(style.palette.textStrong.opacity(0.09)))
                        }
                    }
                    Text(meta)
                        .font(style.font(.meta))
                        .foregroundStyle(style.palette.textMuted)
                        // The meta wraps between words and never clips (DL11).
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(style.font(.label))
                        .foregroundStyle(style.palette.accentFg)
                        .accessibilityHidden(true)
                }
            }
            .padding(.vertical, style.space(.sm))
            .frame(minHeight: 64)
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(selected ? .isSelected : [])
        }
    }
}

// MARK: - Status, progress, loading

/// Status as an icon and a word, never colour alone (rule 9).
public struct StatusPill: View {
    public enum Tone: Sendable { case neutral, success, warning, danger }
    let line: CopyLine
    let tone: Tone

    public init(_ line: CopyLine, tone: Tone) {
        self.line = line
        self.tone = tone
    }

    public var body: some View {
        kitStyle { style in
            let color: Color = {
                switch tone {
                case .neutral: return style.palette.textMuted
                case .success: return style.palette.success
                case .warning: return style.palette.warning
                case .danger: return style.palette.danger
                }
            }()
            let glyph: String = {
                switch tone {
                case .neutral: return "circle.fill"
                case .success: return "checkmark.circle.fill"
                case .warning: return "exclamationmark.triangle.fill"
                case .danger: return "xmark.octagon.fill"
                }
            }()
            Label {
                KitText(line, .footnote, color: .default)
            } icon: {
                Image(systemName: glyph).foregroundStyle(color).accessibilityHidden(true)
            }
            .labelStyle(.titleAndIcon)
        }
    }
}

/// A determinate bar, only for counted bytes (DL7: never an invented percentage).
public struct ProgressBar: View {
    let fraction: Double
    @Environment(\.polarisKeyStrings) private var strings
    public init(fraction: Double) { self.fraction = fraction }

    public var body: some View {
        kitStyle { style in
            ProgressView(value: max(0, min(1, fraction)))
                .tint(style.palette.accentSolid)
                .accessibilityLabel(Text(strings.string("common.updateProgressLabel")))
                .accessibilityValue(Text(KitFormat.percent(fraction)))
        }
    }
}

/// The wait indicator (DL7, rule 4): nothing for the first 250 ms, then the platform's
/// `ProgressView` with a muted label. It holds still under Reduce Motion.
public struct LoadingIndicator: View {
    let line: CopyLine
    @State private var shown = false

    public init(_ line: CopyLine) { self.line = line }

    public var body: some View {
        kitStyle { style in
            VStack(spacing: style.space(.sm)) {
                if shown {
                    ProgressView()
                        .controlSize(.regular)
                        .tint(style.palette.textMuted)
                        .accessibilityHidden(true)
                    KitText(line, .meta, color: .muted, alignment: .center)
                }
            }
            .frame(minHeight: 60)
            .task {
                try? await Task.sleep(nanoseconds: 260_000_000)
                shown = true
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// "Powered by Polaris Locker" (UI-KITS §1.6, §4.5): off by default, only at the foot of settings
/// and about screens, never on the gate. The line is the Locker micro mark (16 pt) and the phrase in
/// live text. The badge is for about and credits screens (`PolarisPoweredByAttribution(style: .badge)`).
public struct PoweredBy: View {
    public init() {}

    public var body: some View {
        kitStyle { style in
            // The line on the account pane; the badge is for about and credits screens, which the
            // host places (`PolarisPoweredByAttribution(style: .badge)`).
            HStack(spacing: 6) {
                PolarisLockerMicroMark(dark: style.dark)
                KitText("part.poweredBy", [:], .footnote, color: .subtle)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

private struct PolarisKeyNowKey: EnvironmentKey {
    static let defaultValue: Date? = nil
}

extension EnvironmentValues {
    /// A fixed "now" for countdowns: previews and snapshot tests set it so a render is the same
    /// on every run. nil (the default) follows the clock.
    public var polarisKeyNow: Date? {
        get { self[PolarisKeyNowKey.self] }
        set { self[PolarisKeyNowKey.self] = newValue }
    }
}

/// The clipboard.
enum KitPasteboard {
    /// A secret (the recovery code): kept on this device, marked concealed where the system has the
    /// type, and gone after two minutes (iOS). Never a general copy.
    @MainActor static func copySensitive(_ text: String) {
        #if canImport(UIKit) && !os(tvOS) && !os(watchOS)
            UIPasteboard.general.setItems(
                [["public.utf8-plain-text": text]],
                options: [
                    .localOnly: true, .expirationDate: Date().addingTimeInterval(120),
                ])
        #elseif canImport(AppKit)
            let board = NSPasteboard.general
            board.clearContents()
            board.setString(text, forType: .string)
            board.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        #endif
    }

    @MainActor static func copy(_ text: String) {
        #if canImport(UIKit) && !os(tvOS) && !os(watchOS)
            UIPasteboard.general.string = text
        #elseif canImport(AppKit)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

#if os(macOS)
    /// Under `native` the system's large rounded-border style goes on the text field itself.
    private struct KeyFieldNativeStyle: ViewModifier {
        let isNative: Bool

        @ViewBuilder func body(content: Content) -> some View {
            if isNative {
                content.textFieldStyle(.roundedBorder).controlSize(.large)
            } else {
                content.textFieldStyle(.plain)
            }
        }
    }
#endif
