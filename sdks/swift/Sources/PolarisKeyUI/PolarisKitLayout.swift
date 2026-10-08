// @pkey-feature ui.kit
// How the kit's full-screen surfaces (the gate, device-code sign-in, offline activation) lay
// themselves out in the space they are given, and the spacing scale they share.
//
// Every surface is three parts: a heading (the product and the title), a detail (what to do) and
// an act (the code, the form and the actions). The page arranges them by size, never by device:
//
//   column       one centred column: phones in portrait, sheets and narrow windows. When the
//                column is taller than the screen (large Dynamic Type on a small phone) the act
//                moves up under the heading and the detail follows, so the code and the primary
//                action are on screen without scrolling, and the rest scrolls.
//   sideBySide   heading and detail on the leading side, the act on the trailing side: a phone in
//                landscape and short windows, where a column would push the act below the fold.
//   split        the product's identity pane beside the form (the split Welcome): iPad and roomy
//                Mac windows, instead of a small card in empty space.
//
// `ViewThatFits` picks between column and sideBySide by whether the column fits, so Dynamic Type,
// long product names and localised copy choose the layout, not a hard-coded device list.

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

    /// The narrowest container that can hold two columns side by side.
    static let twoColumnMinWidth: CGFloat = 560
    /// The smallest container that gets the identity pane beside the form.
    static let splitMinSize = CGSize(width: 760, height: 520)
    /// The column's and the split form's comfortable maximum width.
    static let columnMaxWidth: CGFloat = 440
    /// The act's maximum width beside the detail.
    static let actMaxWidth: CGFloat = 380

    /// Whether the container is wide and tall enough for the identity pane.
    static func allowsSplit(_ size: CGSize) -> Bool {
        size.width >= splitMinSize.width && size.height >= splitMinSize.height
    }

    /// Whether the container is wide enough for two columns.
    static func allowsTwoColumns(_ size: CGSize) -> Bool {
        size.width >= twoColumnMinWidth
    }

    /// The candidates for a container, in the order `ViewThatFits` tries them; the last one also
    /// takes over, scrolling, when nothing fits.
    static func candidates(for size: CGSize) -> [PolarisKitLayout] {
        if allowsSplit(size) { return [.split] }
        return allowsTwoColumns(size) ? [.column, .sideBySide] : [.column]
    }

    /// Text alignment in this arrangement: centred in a column, leading beside something else.
    var textAlignment: TextAlignment { self == .column ? .center : .leading }
    var horizontalAlignment: HorizontalAlignment { self == .column ? .center : .leading }
    var frameAlignment: Alignment { self == .column ? .center : .leading }
}

/// A full-screen kit page: heading, detail and act, arranged for the container (see the file
/// header). The page paints the ground and owns all scrolling.
struct PolarisAdaptivePage<Heading: View, Detail: View, Act: View>: View {
    let style: PolarisKitStyle
    let identity: PolarisProductIdentity
    @ViewBuilder let heading: (PolarisKitLayout) -> Heading
    @ViewBuilder let detail: (PolarisKitLayout) -> Detail
    @ViewBuilder let act: (PolarisKitLayout) -> Act

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            Group {
                if PolarisKitLayout.allowsSplit(size) {
                    split(size)
                } else if PolarisKitLayout.allowsTwoColumns(size) {
                    ViewThatFits(in: .vertical) {
                        column(prioritised: false)
                        sideBySide(alignment: .center)
                        ScrollView(.vertical) { sideBySide(alignment: .top) }
                            .scrollBounceBehavior(.basedOnSize)
                    }
                } else {
                    ViewThatFits(in: .vertical) {
                        column(prioritised: false)
                        ScrollView(.vertical) { column(prioritised: true) }
                            .scrollBounceBehavior(.basedOnSize)
                    }
                }
            }
            .frame(width: size.width, height: size.height)
        }
        .background(style.palette.page.ignoresSafeArea())
    }

    /// One column. Prioritised, the act comes straight after the heading.
    private func column(prioritised: Bool) -> some View {
        stack(.column, prioritised: prioritised)
            .frame(maxWidth: PolarisKitLayout.columnMaxWidth)
        .padding(PolarisSpace.l)
        .frame(maxWidth: .infinity)
    }

    private func sideBySide(alignment: VerticalAlignment) -> some View {
        HStack(alignment: alignment, spacing: PolarisSpace.xl) {
            VStack(alignment: .leading, spacing: PolarisSpace.s) {
                heading(.sideBySide)
                detail(.sideBySide)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(spacing: PolarisSpace.m) { act(.sideBySide) }
                .frame(maxWidth: PolarisKitLayout.actMaxWidth)
        }
        .padding(.horizontal, PolarisSpace.xl)
        .padding(.vertical, PolarisSpace.l)
        .frame(maxWidth: 880)
        .frame(maxWidth: .infinity)
    }

    private func split(_ size: CGSize) -> some View {
        let paneWidth = min(max(size.width * 0.42, 300), 600)
        return HStack(spacing: 0) {
            PolarisIdentityPane(identity: identity, style: style)
                .frame(width: paneWidth)
            ViewThatFits(in: .vertical) {
                splitForm(prioritised: false)
                ScrollView(.vertical) { splitForm(prioritised: true) }
                    .scrollBounceBehavior(.basedOnSize)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func splitForm(prioritised: Bool) -> some View {
        stack(.split, prioritised: prioritised)
            .frame(maxWidth: PolarisKitLayout.columnMaxWidth, alignment: .leading)
        .padding(PolarisSpace.xxl)
        .frame(maxWidth: .infinity)
    }
}

extension PolarisAdaptivePage {
    /// Heading, detail and act in one stack with the kit's rhythm: the detail 12 under the
    /// heading (one group), the act 24 under it. Prioritised, the act follows the heading and the
    /// detail comes last.
    fileprivate func stack(_ layout: PolarisKitLayout, prioritised: Bool) -> some View {
        VStack(alignment: layout.horizontalAlignment, spacing: 0) {
            heading(layout)
            if prioritised {
                act(layout).padding(.top, PolarisSpace.l)
                detail(layout).padding(.top, PolarisSpace.l)
            } else {
                detail(layout).padding(.top, PolarisSpace.s)
                act(layout).padding(.top, PolarisSpace.l)
            }
        }
        .environment(\.polarisPageIsCompressed, prioritised)
    }
}

private struct PolarisPageCompressedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True inside a page that did not fit and put its act first: decoration gives way there.
    var polarisPageIsCompressed: Bool {
        get { self[PolarisPageCompressedKey.self] }
        set { self[PolarisPageCompressedKey.self] = newValue }
    }
}

/// Decoration that a compressed page drops (the Welcome's hero icon), so the act fits.
struct PolarisPageDecoration<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(\.polarisPageIsCompressed) private var compressed

    var body: some View {
        if !compressed { content() }
    }
}

/// The split Welcome's identity pane: the product's icon at hero size over a quiet ground, its name
/// and developer under it. Under `.polarisKey` branding the ground takes a wash of the product's
/// accent; natively it is the system's raised ground, so the host's look leads.
struct PolarisIdentityPane: View {
    let identity: PolarisProductIdentity
    let style: PolarisKitStyle

    #if os(macOS)
        @ScaledMetric(relativeTo: .largeTitle) private var heroSize: CGFloat = 128
    #else
        @ScaledMetric(relativeTo: .largeTitle) private var heroSize: CGFloat = 120
    #endif

    var body: some View {
        VStack(spacing: PolarisSpace.m) {
            PolarisProductIcon(identity: identity, size: min(heroSize, 160), style: style)
                .shadow(color: .black.opacity(0.18), radius: 16, y: 6)
            VStack(spacing: PolarisSpace.xxs) {
                Text(identity.name)
                    .font(style.font(.paneTitle))
                    .foregroundStyle(style.palette.textStrong)
                if let developer = identity.developer {
                    Text(developer)
                        .font(style.font(.caption))
                        .foregroundStyle(style.palette.textMuted)
                }
            }
            .multilineTextAlignment(.center)
            .accessibilityElement(children: .combine)
        }
        .padding(PolarisSpace.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ground.ignoresSafeArea())
        .overlay(alignment: .trailing) {
            Rectangle().fill(style.palette.borderSubtle).frame(width: 1).ignoresSafeArea()
        }
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
            style.palette.raised
        }
    }
}

// ── The layout probe ─────────────────────────────────────────────────────────────────────

/// The elements a layout test needs to find on screen: the user code, the screen's primary
/// action, and the gate's Activate when Sign in is the primary. Each publishes its bounds as an
/// anchor; nothing reads them outside tests.
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
