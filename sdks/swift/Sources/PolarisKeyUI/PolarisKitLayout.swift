// @pkey-feature ui.kit
// How the kit's full-screen surfaces (the gate, device-code sign-in, offline activation) lay
// themselves out in the space they are given, and the spacing scale they share.
//
// Every surface is three parts: a heading (the product and the title), a detail (what to do) and
// an act (the code, the form and the actions). The page arranges them by the container's SHAPE,
// never by device:
//
//   column       one centred column: phones in portrait, sheets, narrow or portrait windows.
//   sideBySide   heading and detail on the leading side, the act on the trailing side: a landscape
//                phone and short, wide windows, where a column would push the act below the fold.
//   split        the product's icon pane beside the form: landscape-shaped windows at least
//                760 x 520, instead of a small card in empty space.
//
// The arrangement is a pure function of the keyboard-independent container size, so focusing a
// text field never changes it. Within an arrangement, the whole page is ONE always-present
// ScrollView over ONE stack whose order never changes (heading, detail, act); the page measures the
// stack's natural height against the container and switches only parameters — whether the hero and
// optional detail show, whether the type is capped, and the spacers — so a text field keeps its
// identity and its keyboard. A tall container pins the act to the bottom; a short one drops the
// decoration and scrolls.

import SwiftUI

/// The kit's spacing scale: 4-pt steps with one rhythm. 8 inside a group (title and subtitle), 12
/// between controls, 16 between a control and its supporting line, 24 between groups and as the
/// page inset, 32 between columns and around a pane, 48 around a split's form.
enum PolarisSpace {
    static let xxs: CGFloat = 4
    static let xs: CGFloat = 8
    static let s: CGFloat = 12
    static let m: CGFloat = 16
    static let l: CGFloat = 24
    static let xl: CGFloat = 32
    static let xxl: CGFloat = 48
}

/// The arrangement a surface is drawn in (see the file header).
enum PolarisKitLayout: Equatable, Sendable {
    case column
    case sideBySide
    case split

    /// The narrowest container that gets two columns side by side.
    static let twoColumnMinWidth: CGFloat = 560
    /// The smallest container that gets the icon pane beside the form.
    static let splitMinSize = CGSize(width: 760, height: 520)
    /// The split needs a landscape-shaped container: wider than this multiple of its height. iPad
    /// portrait (1024 x 1366) is tall-shaped, so it gets the column, not two three-quarters-empty
    /// strips.
    static let splitAspect: CGFloat = 1.15
    /// The column's and the split form's comfortable maximum width (raised at regular width).
    static let columnMaxWidth: CGFloat = 440
    static let columnMaxWidthRegular: CGFloat = 480
    /// The act's maximum width beside the detail.
    static let actMaxWidth: CGFloat = 380
    /// A container at least this much taller than its content gets the tall form.
    static let tallSlack: CGFloat = 160

    /// Whether the container is wide, tall and landscape-shaped enough for the icon pane.
    static func allowsSplit(_ size: CGSize) -> Bool {
        size.width >= splitMinSize.width && size.height >= splitMinSize.height
            && size.width >= size.height * splitAspect
    }

    /// Whether the container is wide enough for two columns.
    static func allowsTwoColumns(_ size: CGSize) -> Bool {
        size.width >= twoColumnMinWidth
    }

    /// The arrangement for a container of this size (pure, keyboard-independent).
    static func arrangement(for size: CGSize) -> PolarisKitLayout {
        if allowsSplit(size) { return .split }
        if allowsTwoColumns(size) && size.width > size.height { return .sideBySide }
        return .column
    }

    /// The candidates a layout test checks for a size. Kept for the test's shape assertions.
    static func candidates(for size: CGSize) -> [PolarisKitLayout] {
        switch arrangement(for: size) {
        case .split: return [.split]
        case .sideBySide: return [.column, .sideBySide]
        case .column: return [.column]
        }
    }

    /// Text alignment in this arrangement: centred in a column, leading beside something else.
    var textAlignment: TextAlignment { self == .column ? .center : .leading }
    var horizontalAlignment: HorizontalAlignment { self == .column ? .center : .leading }
    var frameAlignment: Alignment { self == .column ? .center : .leading }
}

/// Where a page is in its container: how much room it has, and whether it is compressed (the full
/// content does not fit, so decoration and optional detail give way and the type is capped) or tall
/// (plenty of room, so the heading sits high and the act is pinned to the bottom).
struct PolarisPageFit: Equatable {
    var compressed = false
    var tall = false
    /// The spare height of a tall page, so the heading can sit a third of the way down.
    var slack: CGFloat = 0
}

// ── Environment: the page's fit, read by headings and decoration ───────────────────────────────

private struct PolarisPageFitKey: EnvironmentKey {
    static let defaultValue = PolarisPageFit()
}

extension EnvironmentValues {
    /// The page's fit for this subtree.
    var polarisPageFit: PolarisPageFit {
        get { self[PolarisPageFitKey.self] }
        set { self[PolarisPageFitKey.self] = newValue }
    }
}

/// Decoration that a compressed page drops (the Welcome's hero icon, the gate's optional subtitle),
/// so the essential act fits.
struct PolarisPageDecoration<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(\.polarisPageFit) private var fit

    var body: some View {
        if !fit.compressed { content() }
    }
}

// ── Measurement ────────────────────────────────────────────────────────────────────────────────

private struct PolarisHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct PolarisStableSizeKey: PreferenceKey {
    static let defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

/// An id for the page's act, so the ScrollView can bring it into view when the keyboard covers it.
private enum PolarisPageAnchor: Hashable { case act }

/// A monotonic token a focused field raises to ask the page to scroll its act into view.
struct PolarisScrollRequestKey: PreferenceKey {
    static let defaultValue = 0
    static func reduce(value: inout Int, nextValue: () -> Int) {
        value = max(value, nextValue())
    }
}

extension View {
    /// Ask the enclosing page to scroll its act into view (raise a new token on each focus gain).
    func polarisScrollRequest(_ token: Int) -> some View {
        preference(key: PolarisScrollRequestKey.self, value: token)
    }
}

/// A full-screen kit page: heading, detail and act, arranged for the container (see the file
/// header). The page paints the ground and owns all scrolling.
struct PolarisAdaptivePage<Heading: View, Detail: View, Act: View>: View {
    let style: PolarisKitStyle
    let identity: PolarisProductIdentity
    @ViewBuilder let heading: (PolarisKitLayout) -> Heading
    @ViewBuilder let detail: (PolarisKitLayout) -> Detail
    @ViewBuilder let act: (PolarisKitLayout) -> Act

    /// The container size, measured ignoring the keyboard, so the arrangement never changes when a
    /// field is focused.
    @State private var size: CGSize = .zero
    /// The natural height of the full (uncompressed) column, from a hidden measurer.
    @State private var naturalColumnHeight: CGFloat = 0
    @State private var scrollToken = 0

    var body: some View {
        let arrangement = PolarisKitLayout.arrangement(for: size)
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                arranged(arrangement)
                    .frame(minHeight: size.height > 0 ? size.height : nil, alignment: .top)
                    .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            #if os(iOS)
                .scrollDismissesKeyboard(.interactively)
            #endif
            .onPreferenceChange(PolarisScrollRequestKey.self) { token in
                guard token != scrollToken else { return }
                scrollToken = token
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(PolarisPageAnchor.act, anchor: .bottom)
                }
            }
        }
        .background(style.palette.page.ignoresSafeArea())
        .background(sizeProbe)
        .background(columnMeasurer)
    }

    // ── the three arrangements, from one set of closures ──

    @ViewBuilder private func arranged(_ arrangement: PolarisKitLayout) -> some View {
        switch arrangement {
        case .split: split(size)
        case .sideBySide: sideBySide()
        case .column: column()
        }
    }

    private var columnWidth: CGFloat {
        let regular = size.width >= PolarisKitLayout.twoColumnMinWidth
        return regular ? PolarisKitLayout.columnMaxWidthRegular : PolarisKitLayout.columnMaxWidth
    }

    private func fit(_ available: CGFloat) -> PolarisPageFit {
        guard naturalColumnHeight > 0, available > 0 else { return PolarisPageFit() }
        if naturalColumnHeight > available { return PolarisPageFit(compressed: true, tall: false) }
        let slack = available - naturalColumnHeight
        return PolarisPageFit(compressed: false, tall: slack >= PolarisKitLayout.tallSlack, slack: slack)
    }

    private func column() -> some View {
        let available = size.height - PolarisSpace.l * 2
        let f = fit(available)
        return stack(.column, fit: f)
            .frame(maxWidth: columnWidth)
            .padding(f.compressed ? PolarisSpace.s : PolarisSpace.l)
            .frame(maxWidth: .infinity)
            .environment(\.polarisPageFit, f)
            .modifier(PolarisCompressedType(compressed: f.compressed))
    }

    private func sideBySide() -> some View {
        // Beside each other the content is shorter, so it is compressed only when it still overruns.
        let f = PolarisPageFit(compressed: naturalColumnHeight > size.height, tall: false)
        return HStack(alignment: .center, spacing: PolarisSpace.xl) {
            VStack(alignment: .leading, spacing: PolarisSpace.s) {
                heading(.sideBySide)
                detail(.sideBySide)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(spacing: PolarisSpace.m) { actWithAnchor(.sideBySide) }
                .frame(minWidth: 0, maxWidth: PolarisKitLayout.actMaxWidth)
                .layoutPriority(1)
        }
        .padding(.horizontal, PolarisSpace.xl)
        .padding(.vertical, PolarisSpace.l)
        .frame(maxWidth: 880)
        .frame(maxWidth: .infinity)
        .environment(\.polarisPageFit, f)
        .modifier(PolarisCompressedType(compressed: f.compressed))
    }

    private func split(_ size: CGSize) -> some View {
        let paneWidth = min(max(size.width * 0.42, 300), 600)
        return HStack(spacing: 0) {
            PolarisIdentityPane(identity: identity, style: style, paneWidth: paneWidth)
                .frame(width: paneWidth)
            let f = fit(size.height - PolarisSpace.xxl * 2)
            stack(.split, fit: f)
                .frame(maxWidth: PolarisKitLayout.columnMaxWidthRegular, alignment: .leading)
                .padding(f.compressed ? PolarisSpace.l : PolarisSpace.xxl)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .modifier(PolarisCompressedType(compressed: f.compressed))
        }
    }

    /// Heading, detail and act in one stack whose order never changes. The tall form lifts the
    /// heading to a third of the height and pins the act to the bottom; otherwise it is centred.
    @ViewBuilder private func stack(_ layout: PolarisKitLayout, fit f: PolarisPageFit) -> some View {
        VStack(alignment: layout.horizontalAlignment, spacing: 0) {
            if f.tall { Color.clear.frame(height: f.slack / 3) }
            heading(layout)
            detail(layout).padding(.top, f.compressed ? PolarisSpace.xxs : PolarisSpace.s)
            if f.tall {
                Spacer(minLength: PolarisSpace.l)
                actWithAnchor(layout).padding(.bottom, PolarisSpace.l)
            } else {
                actWithAnchor(layout).padding(.top, f.compressed ? PolarisSpace.s : PolarisSpace.l)
            }
        }
        .environment(\.polarisPageFit, f)
    }

    private func actWithAnchor(_ layout: PolarisKitLayout) -> some View {
        act(layout).id(PolarisPageAnchor.act)
    }

    // ── keyboard-independent size, and the hidden natural-height measurer ──

    private var sizeProbe: some View {
        GeometryReader { g in
            Color.clear.preference(key: PolarisStableSizeKey.self, value: g.size)
        }
        .ignoresSafeArea(.keyboard)
        .onPreferenceChange(PolarisStableSizeKey.self) { s in
            if s != .zero { size = s }
        }
    }

    /// Measure the full, uncompressed column once, hidden, so compression and the tall form never
    /// feed back into the height they are decided from.
    private var columnMeasurer: some View {
        VStack(alignment: .center, spacing: 0) {
            heading(.column)
            detail(.column).padding(.top, PolarisSpace.s)
            act(.column).padding(.top, PolarisSpace.l)
        }
        .environment(\.polarisPageFit, PolarisPageFit())
        .frame(width: columnWidth)
        .fixedSize(horizontal: false, vertical: true)
        .background(
            GeometryReader { g in
                Color.clear.preference(key: PolarisHeightKey.self, value: g.size.height)
            }
        )
        .onPreferenceChange(PolarisHeightKey.self) { h in
            if h > 0 { naturalColumnHeight = h }
        }
        .hidden()
        .accessibilityHidden(true)
        .allowsHitTesting(false)
        .disabled(true)
    }
}

/// The split's icon pane: the product's icon at hero size over a quiet ground, no text (the form
/// names the product), hidden from VoiceOver as decoration. Under `.polarisKey` the ground takes a
/// wash of the product's accent; natively it is a ground one step quieter than the form.
struct PolarisIdentityPane: View {
    let identity: PolarisProductIdentity
    let style: PolarisKitStyle
    let paneWidth: CGFloat

    var body: some View {
        let hero = min(max(paneWidth * 0.32, 128), 192)
        return PolarisProductIcon(identity: identity, size: hero, style: style)
            .modifier(PolarisHeroShadow())
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ground.ignoresSafeArea())
            .overlay(alignment: .trailing) {
                Rectangle().fill(style.palette.borderSubtle).frame(width: 1).ignoresSafeArea()
            }
            .accessibilityHidden(true)
    }

    @ViewBuilder private var ground: some View {
        if style.branding == .polarisKey {
            ZStack {
                style.palette.raised
                RadialGradient(
                    colors: [style.palette.accent.opacity(0.22), .clear], center: .center,
                    startRadius: 0, endRadius: 420)
            }
        } else {
            style.paneGround
        }
    }
}

/// A soft drop shadow, grouped so it never shows through a translucent icon.
struct PolarisHeroShadow: ViewModifier {
    func body(content: Content) -> some View {
        content.compositingGroup().shadow(color: .black.opacity(0.18), radius: 16, y: 6)
    }
}

// ── The layout probe ─────────────────────────────────────────────────────────────────────

/// The elements a layout test needs to find on screen: the user code, the screen's primary action,
/// and the gate's Activate when Sign in is the primary. Each publishes its bounds as an anchor;
/// nothing reads them outside tests.
enum PolarisLayoutRole: Hashable, Sendable {
    case code
    case primaryAction
    case activate
}

struct PolarisLayoutProbeKey: PreferenceKey {
    static let defaultValue: [PolarisLayoutRole: Anchor<CGRect>] = [:]
    static func reduce(
        value: inout [PolarisLayoutRole: Anchor<CGRect>],
        nextValue: () -> [PolarisLayoutRole: Anchor<CGRect>]
    ) {
        value.merge(nextValue()) { _, new in new }
    }
}

extension View {
    /// Publish this view's bounds as `role` for the layout tests.
    func polarisLayoutProbe(_ role: PolarisLayoutRole) -> some View {
        anchorPreference(key: PolarisLayoutProbeKey.self, value: .bounds) { [role: $0] }
    }
}
