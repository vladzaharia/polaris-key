// The responsive scaffold of every full-screen step (DL1, DL3, DL15, DL17; the UK-07 row of the
// language matrix):
//
//   * one scroll tree whose arrangement comes from the keyboard-independent size, never from the
//     device class: raising the keyboard never changes the arrangement or rebuilds a field;
//   * split (identity pane | title, lede, act) only at width ≥ 1.15 × height and at least
//     760 × 520; the row capped at 1040 with a 48 pt gutter, both panes top-aligned;
//   * otherwise the tall form: a hero screen's block near the upper third (spacers 1:2), the hero
//     icon at 120 pt; a focused step's header pinned at one inset (8 % of the height, 16 to 88 pt)
//     so it never moves between steps; the act docked 24 pt above the bottom safe area and riding
//     above the keyboard;
//   * iPad portrait and other wide tall windows: one column of about 480 pt, never two panes,
//     a focused step centred vertically (a hero screen keeps its block in the upper quarter);
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

    /// A focused step's header inset from the top of the safe area at window `height`.
    public static func topInset(height: CGFloat) -> CGFloat {
        min(max(height * 0.08, 16), 88)
    }

    /// The hero icon's size at `height` (DL3: decoration gives way first).
    public static func heroSize(height: CGFloat) -> CGFloat? {
        if height >= 640 { return 120 }
        if height >= 500 { return 72 }
        return nil
    }
}

/// The arrangement of a Mac window (UK-08.3, `desktop.html`, DL1). One component whose shape is a
/// function of the window's own measured size, so a narrow, a short and a large window are the
/// same screens at other sizes:
///
///   * `strip`  under 640 pt wide: the art pane collapses to a 64 pt header strip holding the icon
///     and the name, and the act docks at the bottom;
///   * `short`  under 480 pt tall (and 640 wide or more): still two columns, no scroll; the lede
///     gives way first and the hero capsules drop to the 28 pt control;
///   * `split`  the art pane (334 pt) beside one top-aligned block of at most 440 pt;
///   * `card`   1200 pt wide and 640 tall or more: the same two panes as a 880 x 600 card on the
///     product ambient.
public enum KitMacArrangement: Sendable, Equatable {
    case strip
    case short
    case split
    case card

    public static let stripBelowWidth: CGFloat = 640
    public static let shortBelowHeight: CGFloat = 480
    public static let cardFromWidth: CGFloat = 1200
    public static let cardFromHeight: CGFloat = 640
    /// The form block's widest extent beside the art pane.
    public static let formMaxWidth: CGFloat = 440
    /// The sheet's width on macOS (the form, fitted).
    public static let sheetWidth: CGFloat = 440
    /// The art pane's margin from the window (and the strip's from the top and sides).
    public static let artMargin: CGFloat = 14
    /// The icon's inset in the header strip.
    public static let stripInset: CGFloat = 16
    /// The gap between the Welcome capsules.
    public static let actsSpacing: CGFloat = 8
    /// The sheet form's padding.
    public static let sheetInsets: (top: CGFloat, side: CGFloat, bottom: CGFloat) = (22, 22, 18)
    /// The hero actions' widest extent.
    public static let actsMaxWidth: CGFloat = 320
    /// The minimum window the kit lays out for.
    public static let minimumWindow = CGSize(width: 480, height: 520)

    public static func of(_ size: CGSize) -> KitMacArrangement {
        if size.width < stripBelowWidth { return .strip }
        if size.height < shortBelowHeight { return .short }
        if size.width >= cardFromWidth, size.height >= cardFromHeight { return .card }
        return .split
    }

    /// The art pane's width; 0 when the pane is a strip.
    public var artWidth: CGFloat {
        switch self {
        case .strip: return 0
        case .short: return 300
        case .split: return 334
        case .card: return 340
        }
    }

    /// The end pane's padding from the window: top, leading, trailing, bottom.
    public var endInsets: (top: CGFloat, leading: CGFloat, trailing: CGFloat, bottom: CGFloat) {
        switch self {
        case .strip: return (28, 32, 32, 32)
        case .short: return (36, 18, 40, 20)
        case .split: return (72, 22, 48, 40)
        case .card: return (80, 22, 48, 40)
        }
    }

    /// The row of the card: 880 x 600; the other arrangements fill the window.
    public static let cardSize = CGSize(width: 880, height: 600)

    /// Whether the lede is drawn (it gives way first at short heights, DL3).
    public var showsLede: Bool { self != .short }

    /// Whether the Welcome capsules are the 36 pt hero (the short window uses the 28 pt control).
    public var heroCapsules: Bool { self != .short }

    /// Whether the art pane is a header strip rather than a column.
    public var isStrip: Bool { self == .strip }
}

private struct KitMacArrangementKey: EnvironmentKey {
    static let defaultValue: KitMacArrangement = .split
}

private struct KitInSheetKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// The Mac arrangement the enclosing scaffold chose, for a screen that adapts inside it.
    var kitMacArrangement: KitMacArrangement {
        get { self[KitMacArrangementKey.self] }
        set { self[KitMacArrangementKey.self] = newValue }
    }

    /// The form is drawn in a sheet (a fitted panel), not the Welcome window.
    var kitInSheet: Bool {
        get { self[KitInSheetKey.self] }
        set { self[KitInSheetKey.self] = newValue }
    }
}

/// Hands a screen the arrangement the enclosing scaffold chose (the scaffold sets it inside its
/// own body, so a screen reads it through a child view).
struct KitArrangementReader<Built: View>: View {
    @Environment(\.kitMacArrangement) private var arrangement
    @ViewBuilder let build: (KitMacArrangement) -> Built

    var body: some View { build(arrangement) }
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
    /// Name the product once under the hero icon, for a screen whose title does not (DL5: a
    /// status screen's "License expired"). The one-line header already carries it.
    var heroName = false
    var tier: String?
    @ViewBuilder let heading: () -> Heading
    @ViewBuilder let content: () -> Content
    @ViewBuilder let actions: () -> Actions
    @ViewBuilder let footer: () -> Footer

    @State private var window: CGSize = .zero

    @Environment(\.kitInSheet) private var inSheet
    @Environment(\.dynamicTypeSize) private var dynamicType

    var body: some View {
        #if os(macOS)
            if inSheet {
                // A sheet is the form alone, fitted to 440 pt, on the system's panel.
                KitMacSheetForm(
                    header: header, tier: tier, heading: heading, content: content,
                    actions: actions, footer: footer)
            } else {
                scaffold
            }
        #else
            scaffold
        #endif
    }

    private var scaffold: some View {
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
        #if os(macOS)
            KitMacScaffold(
                arrangement: KitMacArrangement.of(window), hero: hero, header: header, tier: tier,
                heading: heading, content: content, actions: actions, footer: footer)
        #else
            switch KitArrangement.of(window) {
            case .split: split(style)
            case .tall: tall(style)
            }
        #endif
    }

    private func heroIcon(_ height: CGFloat) -> CGFloat? {
        hero ? KitArrangement.heroSize(height: height) : nil
    }

    @ViewBuilder private func tall(_ style: KitResolvedStyle) -> some View {
        GeometryReader { geo in
            // A wide window (an iPad in portrait) keeps the act with the content: the main action
            // stays in the first view instead of 600 pt below it (UI-KITS: main action first).
            let regular = geo.size.width > 600
            // At accessibility sizes the lines scroll and the act docks to the bottom edge, so the
            // main action stays in the first viewport (SIGN-IN §3.19). A hero keeps its flow.
            let docked = dynamicType.isAccessibilitySize && !hero
            ScrollView {
                VStack(spacing: 0) {
                    // A hero screen centres its block near the upper third (spacers 1:2); a
                    // focused step pins its header at one inset from the window, so the header
                    // stays put while the steps of one form morph under it (SIGN-IN §3.17).
                    if hero {
                        Spacer(minLength: style.space(.md))
                            .frame(maxHeight: regular ? geo.size.height * 0.25 : .infinity)
                    } else if regular {
                        // A focused step in a tall wide window (an iPad in portrait) settles in
                        // the middle of it: the header pinned at the top would leave most of the
                        // screen empty under the act. The top spacer shares the free height with
                        // the bottom one, so the block is centred and a taller body just grows.
                        Spacer(minLength: KitArrangement.topInset(height: window.height))
                    } else {
                        Color.clear.frame(height: KitArrangement.topInset(height: window.height))
                    }
                    VStack(alignment: hero ? .center : .leading, spacing: style.space(.md)) {
                        if let size = heroIcon(window.height) {
                            ProductIcon(size: size)
                                .padding(.bottom, heroName ? 0 : style.space(.xs))
                            if heroName {
                                ProductHeader(tier: tier, showsIcon: false)
                                    .frame(maxWidth: .infinity, alignment: .center)
                                    .padding(.bottom, style.space(.xs))
                            }
                        } else if header || hero {
                            ProductHeader(tier: tier)
                                .frame(maxWidth: .infinity, alignment: hero ? .center : .leading)
                        }
                        Group {
                            heading()
                            content()
                        }
                        // A body narrower than the column starts at the title's edge.
                        .frame(maxWidth: .infinity, alignment: hero ? .center : .leading)
                    }
                    if docked {
                        Spacer(minLength: style.space(.lg))
                    } else {
                        Spacer(minLength: style.space(.lg))
                            .frame(maxHeight: regular ? style.space(.xl) * 1.5 : .infinity)
                        if hero && !regular { Spacer(minLength: 0) }
                        VStack(spacing: style.space(.md)) {
                            actions()
                            footer()
                        }
                        .padding(.bottom, style.space(.lg))
                        if regular { Spacer(minLength: 0) }
                    }
                }
                .padding(.horizontal, style.space(.lg))
                .frame(maxWidth: geo.size.width > 600 ? 480 : .infinity)
                .frame(maxWidth: .infinity)
                .frame(minHeight: geo.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if docked {
                    VStack(spacing: style.space(.md)) {
                        actions()
                        footer()
                    }
                    .padding(.horizontal, style.space(.lg))
                    .padding(.top, style.space(.sm))
                    .padding(.bottom, style.space(.lg))
                    .frame(maxWidth: geo.size.width > 600 ? 480 : .infinity)
                    .frame(maxWidth: .infinity)
                    .background(style.palette.page)
                }
            }
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
                        if header || heroName {
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
        hero: Bool = false, header: Bool = true, heroName: Bool = false, tier: String? = nil,
        @ViewBuilder heading: @escaping () -> Heading,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder actions: @escaping () -> Actions
    ) {
        self.init(
            hero: hero, header: header, heroName: heroName, tier: tier, heading: heading,
            content: content,
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
                        // A flat wash, not a gradient: the audit measures contrast against the
                        // pixels behind a line, and behind a muted line a gradient read below
                        // 4.5:1 on every run. One colour is the same everywhere (BRAND §9).
                        Rectangle().fill(style.palette.accentSubtle.opacity(0.35))
                    }
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }
}
