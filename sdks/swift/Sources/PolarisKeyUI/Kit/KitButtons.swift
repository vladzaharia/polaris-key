// The kit's buttons (UI-KITS §1.4 iOS row, §1.5 rules 7 and 10, DL4): one prominent capsule at a
// time in the product accent, secondaries that recede, quiet links for the extras.
//
//   iOS 26   primary `.glassProminent` tinted with the accent's solid, secondary `.glass`
//   iOS 18   the designed fallback: a solid accent capsule, and a `.regularMaterial` capsule for
//            the secondary (never a filled capsule with a border)
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
    /// A trailing SF Symbol: `arrow.up.right` for an action that leaves the app (rule 11).
    var glyph: String?
    var fullWidth = true
    let action: () -> Void

    @Environment(\.polarisKeyStrings) private var strings

    var body: some View {
        kitStyle { style in
            Button {
                if !busy { action() }
            } label: {
                label(style)
            }
            .modifier(KitButtonSkin(kind: kind, style: style))
            .accessibilityAddTraits(busy ? .updatesFrequently : [])
            .accessibilityValue(busy ? Text(strings.string("a11y.busy")) : Text(""))
        }
    }

    /// The label's colour, set on the label itself so a glass style's vibrancy never lowers it
    /// below 4.5:1.
    private func labelColor(_ p: KitPalette) -> Color {
        switch kind {
        case .primary: return p.accentOn
        case .destructive: return .white
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
        .foregroundStyle(labelColor(style.palette))
        .frame(maxWidth: fullWidth && kind != .quiet ? .infinity : nil)
        .frame(minHeight: kind == .quiet ? 44 : style.controlHeight - 14)
        .contentShape(Rectangle())
    }
}

/// The button's look for its kind, platform and preset.
struct KitButtonSkin: ViewModifier {
    let kind: KitButtonKind
    let style: KitResolvedStyle

    func body(content: Content) -> some View {
        let p = style.palette
        switch kind {
        case .quiet:
            content
                .buttonStyle(KitQuietStyle(color: p.accentFg, reduceMotion: style.reduceMotion))
        case .primary, .destructive:
            let fill = kind == .destructive ? p.danger : p.accentSolid
            let label = kind == .destructive ? Color.white : p.accentOn
            if style.usesGlass, #available(iOS 26.0, macOS 26.0, *) {
                content
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                    .tint(fill)
                    .foregroundStyle(label)
            } else {
                content
                    .buttonStyle(
                        KitCapsuleStyle(
                            fill: AnyShapeStyle(fill), label: label,
                            reduceMotion: style.reduceMotion, height: style.controlHeight))
            }
        case .secondary:
            if style.usesGlass, #available(iOS 26.0, macOS 26.0, *) {
                // Liquid Glass behind an opaque label: the system `.glass` style draws its label
                // with vibrancy, which measured under 4.5:1 in the accessibility audit.
                content
                    .buttonStyle(
                        KitGlassStyle(
                            label: p.textStrong, reduceMotion: style.reduceMotion,
                            height: style.controlHeight))
            } else if style.reduceTransparency || style.increaseContrast {
                content
                    .buttonStyle(
                        KitCapsuleStyle(
                            fill: AnyShapeStyle(p.raised), label: p.textStrong,
                            reduceMotion: style.reduceMotion, height: style.controlHeight,
                            hairline: p.border))
            } else {
                content
                    .buttonStyle(
                        KitCapsuleStyle(
                            fill: AnyShapeStyle(.regularMaterial), label: p.textStrong,
                            reduceMotion: style.reduceMotion, height: style.controlHeight))
            }
        }
    }
}

/// The iOS 18 capsule: solid or material, pressed at 0.98, dimmed to 42 % when disabled.
struct KitCapsuleStyle: ButtonStyle {
    let fill: AnyShapeStyle
    let label: Color
    let reduceMotion: Bool
    let height: CGFloat
    var hairline: Color?

    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(label)
            .padding(.horizontal, 20)
            .padding(.vertical, 7)
            .frame(minHeight: height)
            .background(Capsule().fill(fill))
            .overlay {
                if let hairline { Capsule().strokeBorder(hairline, lineWidth: 1) }
            }
            .contentShape(Capsule())
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.42)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// The iOS 26 secondary: a Liquid Glass capsule, interactive, with an opaque label.
@available(iOS 26.0, macOS 26.0, *)
struct KitGlassStyle: ButtonStyle {
    let label: Color
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
            .glassEffect(.regular.interactive(), in: Capsule())
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .opacity(isEnabled ? 1 : 0.42)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

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

/// A group of buttons per §1.5 rule 10: on phones and in cards up to 440 pt, full width and
/// stacked, primary first; a group that does not fit stacks whole, never 2 + 1.
struct KitActionStack<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        kitStyle { style in
            VStack(spacing: style.space(.sm)) {
                content()
            }
            .frame(maxWidth: .infinity)
        }
    }
}
