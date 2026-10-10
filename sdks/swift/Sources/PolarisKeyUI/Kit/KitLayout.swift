// The responsive scaffold of every full-screen step (DL1, DL3, DL15, DL17; the UK-07 row of the
// language matrix):
//
//   * one scroll tree whose arrangement comes from the keyboard-independent size, never from the
//     device class: raising the keyboard never changes the arrangement or rebuilds a field;
//   * split (identity pane | title, lede, act) only at width ≥ 1.15 × height and at least
//     760 × 520; the row capped at 1040 with a 48 pt gutter, both panes top-aligned;
//   * otherwise the tall form: the heading block near the upper third (spacers 1:2), the hero icon
//     at 120 pt, the act docked 24 pt above the bottom safe area and riding above the keyboard;
//   * iPad portrait and other wide tall windows: one column of about 480 pt, never two panes;
//   * at short heights the hero gives way first (DL3): 120 → 72 → the one-line header strip.

import PolarisKeyUICore
import SwiftUI

/// The arrangement of a full-screen step.
public enum KitArrangement: Sendable, Equatable {
    case tall
    case split

    /// DL1's rule for the SwiftUI kit, on the keyboard-independent size.
    public static func of(_ size: CGSize) -> KitArrangement {
        size.width >= 1.15 * size.height && size.width >= 760 && size.height >= 520
            ? .split : .tall
    }

    /// The hero icon's size at `height` (DL3: decoration gives way first).
    public static func heroSize(height: CGFloat) -> CGFloat? {
        if height >= 640 { return 120 }
        if height >= 500 { return 72 }
        return nil
    }
}

private struct KitWindowSizeKey: PreferenceKey {
    static let defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

/// A full-screen step: identity, heading, body and the act.
struct KitScreenScaffold<Heading: View, Content: View, Actions: View, Footer: View>: View {
    /// Draw the hero icon (Welcome, boot, status) rather than the header strip.
    var hero = false
    /// Show the product header strip above the heading (focused steps).
    var header = true
    var tier: String?
    @ViewBuilder let heading: () -> Heading
    @ViewBuilder let content: () -> Content
    @ViewBuilder let actions: () -> Actions
    @ViewBuilder let footer: () -> Footer

    @State private var window: CGSize = .zero

    var body: some View {
        kitStyle { style in
            ZStack {
                style.palette.page.ignoresSafeArea()
                if style.ambient && !style.isNative {
                    KitAmbient().ignoresSafeArea()
                }
                // The keyboard-independent size the arrangement is chosen from.
                Color.clear
                    .background(
                        GeometryReader { geo in
                            Color.clear.preference(key: KitWindowSizeKey.self, value: geo.size)
                        }
                    )
                    .ignoresSafeArea(.keyboard)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                arranged(style)
            }
            .onPreferenceChange(KitWindowSizeKey.self) { window = $0 }
        }
    }

    @ViewBuilder private func arranged(_ style: KitResolvedStyle) -> some View {
        switch KitArrangement.of(window) {
        case .split: split(style)
        case .tall: tall(style)
        }
    }

    private func heroIcon(_ height: CGFloat) -> CGFloat? {
        hero ? KitArrangement.heroSize(height: height) : nil
    }

    @ViewBuilder private func tall(_ style: KitResolvedStyle) -> some View {
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: style.space(.md))
                    VStack(spacing: style.space(.md)) {
                        if let size = heroIcon(window.height) {
                            ProductIcon(size: size)
                                .padding(.bottom, style.space(.xs))
                        } else if header || hero {
                            ProductHeader(tier: tier)
                                .frame(maxWidth: .infinity, alignment: hero ? .center : .leading)
                        }
                        heading()
                        content()
                    }
                    Spacer(minLength: style.space(.lg))
                    Spacer(minLength: 0)
                    VStack(spacing: style.space(.md)) {
                        actions()
                        footer()
                    }
                    .padding(.bottom, style.space(.lg))
                }
                .padding(.horizontal, style.space(.lg))
                .frame(maxWidth: geo.size.width > 600 ? 480 : .infinity)
                .frame(maxWidth: .infinity)
                .frame(minHeight: geo.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    @ViewBuilder private func split(_ style: KitResolvedStyle) -> some View {
        GeometryReader { geo in
            ScrollView {
                HStack(alignment: .top, spacing: 48) {
                    KitIdentityPane()
                        .frame(maxWidth: .infinity)
                        .frame(height: min(geo.size.height - 96, 560))
                    VStack(alignment: .leading, spacing: style.space(.md)) {
                        if header {
                            ProductHeader(tier: tier, showsIcon: false)
                        }
                        heading()
                        content()
                        VStack(spacing: style.space(.md)) {
                            actions()
                            footer()
                        }
                        .padding(.top, style.space(.sm))
                    }
                    .frame(maxWidth: 480, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: 1040)
                .padding(.horizontal, 48)
                .padding(.vertical, 48)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

extension KitScreenScaffold where Footer == EmptyView {
    init(
        hero: Bool = false, header: Bool = true, tier: String? = nil,
        @ViewBuilder heading: @escaping () -> Heading,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder actions: @escaping () -> Actions
    ) {
        self.init(
            hero: hero, header: header, tier: tier, heading: heading, content: content,
            actions: actions, footer: { EmptyView() })
    }
}

/// The split's start pane (DL1, B10): the product's icon on the accent's subtle ground (light) or
/// over its ambient (dark); under `native` a sunken panel with the icon only. It repeats nothing
/// the end pane says.
struct KitIdentityPane: View {
    var body: some View {
        kitStyle { style in
            ZStack {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .fill(style.isNative ? style.palette.raised : style.palette.accentSubtle)
                ProductIcon(size: 120)
            }
            .accessibilityHidden(true)
        }
    }
}

/// The product ambient (UI-KITS §1.2): in dark, the icon blurred at about 40 % over the top of the
/// screen; in light, washes of the accent's subtle tint. Never under `native` or Reduce
/// Transparency; it is the product's content, so it is not Polaris chrome.
struct KitAmbient: View {
    @Environment(\.kitIconImage) private var icon

    var body: some View {
        kitStyle { style in
            if !style.reduceTransparency {
                GeometryReader { geo in
                    if style.dark, let icon {
                        // Behind the hero only: the glow fades out above the heading, so text
                        // never sits on the product's colours (contrast is measured on the
                        // render, BRAND §9).
                        let height = geo.size.height * 0.36
                        Image(decorative: icon, scale: 1)
                            .resizable()
                            .scaledToFill()
                            .frame(width: geo.size.width * 1.2, height: height)
                            .blur(radius: 90)
                            .opacity(0.42)
                            .frame(width: geo.size.width, height: height)
                            .clipped()
                            .mask(
                                LinearGradient(
                                    stops: [
                                        .init(color: .black, location: 0),
                                        .init(color: .black, location: 0.45),
                                        .init(color: .black.opacity(0), location: 1),
                                    ], startPoint: .top, endPoint: .bottom))
                    } else {
                        RadialGradient(
                            colors: [style.palette.accentSubtle, style.palette.page.opacity(0)],
                            center: UnitPoint(x: 0.3, y: 0.05), startRadius: 0,
                            endRadius: max(geo.size.width, geo.size.height) * 0.6)
                    }
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }
}
