// The kit's buttons (UI-KITS §1.4 iOS row, §1.5 rules 7 and 10, DL4): one prominent capsule at a
// time in the product accent, secondaries that recede, quiet links for the extras.
//
//   iOS 26   primary `.glassProminent` tinted with the accent's solid, secondary `.glass`
//   iOS 18   the designed fallback: a solid accent capsule, and for the secondary a
//            `.regularMaterial` capsule in dark, a tonal raised capsule with a hairline in light
//   native   the same system styles with the app's tint
//
// A busy button keeps its label and its focus and adds the indicator (DL4, DL9); it ignores taps
// rather than disabling, so VoiceOver focus stays on it.

import PolarisKeyUICore
import SwiftUI

/// What a button is in its group.
public enum KitButtonKind: Sendable {
    case primary, secondary, quiet, destructive
}

/// A kit button with a catalog label.
struct KitButton: View {
    let line: CopyLine
    var kind: KitButtonKind = .primary
    var busy = false
    /// A trailing SF Symbol: `PolarisKitGlyph.newWindow` (`arrow.up.right.square`) for an action that
    /// leaves the app (rule 11); the button then says "Opens in your browser" as its accessibility hint.
    var glyph: String?
    var fullWidth = true
    /// A banner's or a row's button: about 36 pt, beside text rather than under it.
    var compact = false
    /// The Welcome hero's capsule: `.extraLarge` at 36 pt on macOS; a plain control elsewhere.
    var hero = false
    /// A leading-slot button of a Mac action row (Paste), kept at the row's left edge.
    var leading = false
    /// Whether a quiet Cancel answers Escape; off where another button in the group owns it.
    var escapes = true
    let action: () -> Void

    @Environment(\.polarisKeyStrings) private var strings

    var body: some View {
        kitStyle { style in
            Button {
                if !busy { action() }
            } label: {
                label(style)
            }
            .modifier(KitButtonSkin(kind: kind, style: style, compact: compact, hero: hero))
            .modifier(
                KitMacKeys(
                    defaultAction: kind == .primary && !busy,
                    cancelAction: escapes && kind == .quiet && line.key == "common.cancel")
            )
            .layoutValue(key: KitActionSlotKey.self, value: KitActionSlot(kind: kind, leading: leading))
            .accessibilityAddTraits(busy ? .updatesFrequently : [])
            // The render suite finds the one primary by this (UK-08.7); VoiceOver does not read it.
            .accessibilityIdentifier(kind == .primary ? "pkey.primary" : "")
            .accessibilityValue(busy ? Text(strings.string("a11y.busy")) : Text(""))
            .accessibilityHint(
                glyph == PolarisKitGlyph.newWindow
                    ? Text(strings.string(PolarisKitGlyph.newWindowCopyKey)) : Text(""))
        }
    }

    /// The label's colour, set on the label itself so a glass style's vibrancy never lowers it
    /// below 4.5:1.
    private func labelColor(_ p: KitPalette) -> Color {
        switch kind {
        case .primary: return p.accentOn
        case .destructive: return p.dangerOn
        case .secondary: return p.textStrong
        case .quiet: return p.accentFg
        }
    }

    @ViewBuilder private func label(_ style: KitResolvedStyle) -> some View {
        HStack(spacing: style.space(.xs)) {
            if busy {
                ProgressView()
                    .controlSize(.small)
                    .tint(kind == .primary ? style.palette.accentOn : style.palette.textStrong)
                    .accessibilityHidden(true)
            }
            Text(strings.string(line))
                .font(style.font(.button))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let glyph {
                Image(systemName: glyph)
                    .font(style.font(.meta))
                    .accessibilityHidden(true)
            }
        }
        .modifier(
            KitLabelTint(
                color: labelColor(style.palette),
                // On macOS a filled button's label is not forced: an inactive window drops the
                // tint, and a forced light label is then left on grey (S2).
                inactiveFollowsSystem: kind == .primary || kind == .destructive)
        )
        .frame(maxWidth: fullWidth && kind != .quiet && !compact ? .infinity : nil)
        .frame(minHeight: labelHeight(style))
        .contentShape(Rectangle())
    }

    /// The label's own height, so every button of a group is the same height (DL4): the skins add
    /// 7 pt a side, the large glass control its own 14.5 pt a side (measured on the simulator).
    private func labelHeight(_ style: KitResolvedStyle) -> CGFloat {
        if kind == .quiet { return 44 }
        let height =
            compact ? KitButtonSkin.compactHeight : (hero ? style.heroControlHeight : style.controlHeight)
        #if os(macOS)
            return max(0, height - 14)
        #else
            if style.usesGlass, kind == .primary || kind == .destructive, !compact {
                return max(0, height - 29)
            }
            return max(0, height - 14)
        #endif
    }
}

/// The button's look for its kind, platform and preset.
struct KitButtonSkin: ViewModifier {
    let kind: KitButtonKind
    let style: KitResolvedStyle
    var compact = false
    var hero = false

    /// A banner button's height.
    static let compactHeight: CGFloat = 36

    func body(content: Content) -> some View {
        let p = style.palette
        let height =
            compact ? Self.compactHeight : (hero ? style.heroControlHeight : style.controlHeight)
        #if os(macOS)
            let largeSize: ControlSize = hero ? .extraLarge : .large
        #else
            let largeSize: ControlSize = .large
        #endif
        switch kind {
        case .quiet:
            content
                .buttonStyle(KitQuietStyle(color: p.accentFg, reduceMotion: style.reduceMotion))
        case .primary, .destructive:
            let fill = kind == .destructive ? p.danger : p.accentSolid
            let label = kind == .destructive ? p.dangerOn : p.accentOn
            if style.usesGlass, #available(iOS 26.0, macOS 26.0, *) {
                #if compiler(>=6.2)
                content
                    .modifier(
                        KitGlassPrimary(
                            tint: kind == .destructive ? fill : p.primaryGlassFill, label: label,
                            size: compact ? .regular : largeSize,
                            inactive: KitInactiveLook.neutral(p),
                            reduceMotion: style.reduceMotion, height: height))
                #endif
            } else {
                content
                    .buttonStyle(
                        KitCapsuleStyle(
                            fill: AnyShapeStyle(fill), label: label,
                            reduceMotion: style.reduceMotion, height: height,
                            inactive: KitInactiveLook.neutral(p)))
            }
        case .secondary:
            if style.usesGlass, #available(iOS 26.0, macOS 26.0, *) {
                // Liquid Glass behind an opaque label: the system `.glass` style draws its label
                // with vibrancy, which measured under 4.5:1 in the accessibility audit.
                #if compiler(>=6.2)
                content
                    .buttonStyle(
                        KitGlassStyle(
                            label: p.textStrong, ground: p.raised, dark: style.dark,
                            reduceMotion: style.reduceMotion, height: height))
                #endif
            } else if style.reduceTransparency || style.increaseContrast || !style.dark {
                // A tonal raised fill with a hairline: the regular material over a light page
                // measured about 1.02:1, so the button read as bare text (DL4).
                content
                    .buttonStyle(
                        KitCapsuleStyle(
                            fill: AnyShapeStyle(p.raised), label: p.textStrong,
                            reduceMotion: style.reduceMotion, height: height,
                            hairline: p.border))
            } else {
                content
                    .buttonStyle(
                        KitCapsuleStyle(
                            fill: AnyShapeStyle(.regularMaterial), label: p.textStrong,
                            reduceMotion: style.reduceMotion, height: height))
            }
        }
    }
}

/// Return goes to the one prominent button and Escape to Cancel (macOS; iOS has neither key).
struct KitMacKeys: ViewModifier {
    let defaultAction: Bool
    let cancelAction: Bool

    @ViewBuilder func body(content: Content) -> some View {
        #if os(macOS)
            if defaultAction {
                content.keyboardShortcut(.defaultAction)
            } else if cancelAction {
                content.keyboardShortcut(.cancelAction)
            } else {
                content
            }
        #else
            content
        #endif
    }
}

/// The neutral look of a filled capsule in an inactive Mac window.
struct KitInactiveLook {
    let fill: Color
    let label: Color
    let hairline: Color


    /// The one inactive look, for the solid and the glass primary alike: the raised fill, the
    /// strong text colour (4.5:1 or more in both schemes) and a hairline.
    static func neutral(_ p: KitPalette) -> KitInactiveLook {
        KitInactiveLook(fill: p.raised, label: p.textStrong, hairline: p.border)
    }
}

/// Sets a button label's colour. On macOS, a filled button's label follows the system while the
/// window is inactive (the system drops the tint then); everywhere else it is always set.
struct KitLabelTint: ViewModifier {
    let color: Color
    var inactiveFollowsSystem = false
    #if os(macOS)
        @Environment(\.appearsActive) private var appearsActive
    #endif

    func body(content: Content) -> some View {
        #if os(macOS)
            if inactiveFollowsSystem && !appearsActive {
                content
            } else {
                content.foregroundStyle(color)
            }
        #else
            content.foregroundStyle(color)
        #endif
    }
}

/// The iOS 18 capsule: solid or material, pressed at 0.98, dimmed to 42 % when disabled.
struct KitCapsuleStyle: ButtonStyle {
    let fill: AnyShapeStyle
    let label: Color
    let reduceMotion: Bool
    let height: CGFloat
    var hairline: Color?
    /// A filled button's look in an inactive window (macOS): the neutral fill with the strong
    /// text colour, so the label never sits white on grey (S2).
    var inactive: KitInactiveLook?

    @Environment(\.isEnabled) private var isEnabled
    #if os(macOS)
        @Environment(\.appearsActive) private var appearsActive
    #endif

    private var showsInactive: Bool {
        #if os(macOS)
            return inactive != nil && !appearsActive
        #else
            return false
        #endif
    }

    func makeBody(configuration: Configuration) -> some View {
        let look = showsInactive ? inactive : nil
        configuration.label
            .foregroundStyle(look?.label ?? label)
            .padding(.horizontal, 20)
            .padding(.vertical, 7)
            .frame(minHeight: height)
            .background(Capsule().fill(look.map { AnyShapeStyle($0.fill) } ?? fill))
            .overlay {
                if let line = look?.hairline ?? hairline {
                    Capsule().strokeBorder(line, lineWidth: 1)
                }
            }
            .contentShape(Capsule())
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.42)
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

#if compiler(>=6.2)
/// The iOS 26 / macOS 26 primary: `.glassProminent` in the accent. In an inactive Mac window the
/// system drops the tint and leaves a white label on grey (S2), so the glass gives way to the
/// neutral capsule with `textStrong`, as `KitCapsuleStyle`'s inactive look does.
@available(iOS 26.0, macOS 26.0, *)
struct KitGlassPrimary: ViewModifier {
    let tint: Color
    let label: Color
    let size: ControlSize
    let inactive: KitInactiveLook
    let reduceMotion: Bool
    let height: CGFloat
    #if os(macOS)
        @Environment(\.appearsActive) private var appearsActive
    #endif

    private var showsInactive: Bool {
        #if os(macOS)
            return !appearsActive
        #else
            return false
        #endif
    }

    @ViewBuilder func body(content: Content) -> some View {
        if showsInactive {
            content.buttonStyle(
                KitCapsuleStyle(
                    fill: AnyShapeStyle(inactive.fill), label: inactive.label,
                    reduceMotion: reduceMotion, height: height, hairline: inactive.hairline,
                    inactive: inactive))
        } else {
            content
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .controlSize(size)
                .tint(tint)
                .foregroundStyle(label)
        }
    }
}

/// The iOS 26 secondary: a Liquid Glass capsule, interactive, with an opaque label.
@available(iOS 26.0, macOS 26.0, *)
struct KitGlassStyle: ButtonStyle {
    let label: Color
    /// The raised surface the glass is tinted toward, so the label's contrast never depends on
    /// what is behind the button (DL2: opaque enough on any ground).
    let ground: Color
    let dark: Bool
    let reduceMotion: Bool
    let height: CGFloat

    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(label)
            .padding(.horizontal, 20)
            .padding(.vertical, 7)
            .frame(minHeight: height)
            .contentShape(Capsule())
            .glassEffect(
                .regular.tint(ground.opacity(dark ? 0.55 : 0.85)).interactive(), in: Capsule()
            )
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .opacity(isEnabled ? 1 : 0.42)
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
#endif

/// A quiet text link in the accent's text colour (the extras row; no default blue, rule 6).
struct KitQuietStyle: ButtonStyle {
    let color: Color
    let reduceMotion: Bool

    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(color)
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
            .opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.42)
    }
}

/// What a button is in an action row, for the Mac order.
struct KitActionSlot: Equatable {
    var kind: KitButtonKind = .quiet
    var leading = false
}

struct KitActionSlotKey: LayoutValueKey {
    static let defaultValue = KitActionSlot()
}

/// The Mac button order (HIG): the leading slot (Paste) at the left edge, then the quiet extras,
/// Cancel and secondaries, and the one default last, so Cancel sits directly left of it.
enum KitActionOrder {
    /// Display positions, left to right, as indices into `slots` (source order within a rank).
    static func order(_ slots: [KitActionSlot]) -> [Int] {
        func rank(_ s: KitActionSlot) -> Int {
            if s.leading { return 0 }
            switch s.kind {
            case .quiet: return 1
            case .secondary: return 2
            case .primary, .destructive: return 3
            }
        }
        return slots.indices.sorted {
            let (a, b) = (rank(slots[$0]), rank(slots[$1]))
            return a == b ? $0 < $1 : a < b
        }
    }
}

#if os(macOS)
    /// A trailing-aligned horizontal row in `KitActionOrder`; the leading slot hugs the left edge.
    struct KitMacActionRow: Layout {
        var spacing: CGFloat

        private func sizes(_ subviews: Subviews) -> [CGSize] {
            subviews.map { $0.sizeThatFits(.unspecified) }
        }

        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
            let s = sizes(subviews)
            let w = s.reduce(0) { $0 + $1.width } + spacing * CGFloat(max(0, s.count - 1))
            // Never wider than offered: an ideal-size query (no width, or an unbounded one) gets
            // the row's own width, so `ViewThatFits` can see that it does not fit and stack.
            let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? w
            return CGSize(width: width, height: s.map(\.height).max() ?? 0)
        }

        func placeSubviews(
            in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
        ) {
            let s = sizes(subviews)
            let slots = subviews.map { $0[KitActionSlotKey.self] }
            let order = KitActionOrder.order(slots)
            let lead = order.filter { slots[$0].leading }
            let rest = order.filter { !slots[$0].leading }
            var x = bounds.minX
            for i in lead {
                subviews[i].place(
                    at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: .unspecified)
                x += s[i].width + spacing
            }
            var right = bounds.maxX
            for i in rest.reversed() {
                right -= s[i].width
                subviews[i].place(
                    at: CGPoint(x: right, y: bounds.midY), anchor: .leading, proposal: .unspecified)
                right -= spacing
            }
        }
    }
#endif

/// A group of buttons per §1.5 rule 10: on phones and in cards up to 440 pt, full width and
/// stacked, primary first; a group that does not fit stacks whole, never 2 + 1. On macOS it is
/// one row, Cancel directly left of the default (`KitActionOrder`).
struct KitActionStack<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        kitStyle { style in
            #if os(macOS)
                // One row while it fits; a group that does not fit stacks whole, primary first.
                ViewThatFits(in: .horizontal) {
                    KitMacActionRow(spacing: style.space(.sm)) { content() }
                    VStack(spacing: style.space(.sm)) { content() }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity)
            #else
                VStack(spacing: style.space(.sm)) {
                    content()
                }
                // A wrapped label grows its capsule; a pinned page never squeezes the stack.
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity)
            #endif
        }
    }
}

/// The sign-in methods: a vertical stack of full-width buttons (320 pt inline, the form's width in
/// the sheet) on macOS, where `KitActionStack` would be one row; the standard stack elsewhere.
struct KitMethodsStack<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(\.kitInSheet) private var inSheet

    var body: some View {
        kitStyle { style in
            #if os(macOS)
                VStack(alignment: .leading, spacing: style.space(.sm)) { content() }
                    .frame(
                        maxWidth: inSheet ? .infinity : KitMacArrangement.actsMaxWidth,
                        alignment: .leading)
            #else
                KitActionStack { content() }
            #endif
        }
    }
}
