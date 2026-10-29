// @pkey-feature ui.gate ui.activate ui.signin
// The Mac window and sheet scaffolds (UK-08.3, `desktop.html`, DL1). macOS only: the iOS
// arrangement is `KitScreenScaffold`'s own and does not change.
//
//   * The Welcome window is one component: the art pane beside one top-aligned block of at most
//     440 pt, a 64 pt header strip under 640 pt wide, a short landscape under 480 pt tall, and a
//     880 x 600 card on the product ambient from 1200 pt wide (`KitMacArrangement`).
//   * Every step (Activate, Sign in, Device limit) is inline in that window: only the end pane
//     changes, the art pane stays.
//   * A sheet is the form alone, fitted to 440 pt, on the system's panel (macOS 26 draws the
//     inset rounded sheet itself; on 15 the system sheet is the designed fallback).

#if os(macOS)
    import SwiftUI

    private struct KitLeadingTextKey: EnvironmentKey {
        static let defaultValue = false
    }

    extension EnvironmentValues {
        /// Text starts at the leading edge (a Mac window and sheet are left-aligned, not centred).
        var kitLeadingText: Bool {
            get { self[KitLeadingTextKey.self] }
            set { self[KitLeadingTextKey.self] = newValue }
        }
    }

    /// The art pane's ground: the accent's subtle tint with a soft wash, or under `native` one step
    /// quieter, a sunken panel.
    struct KitMacArtFill: View {
        var body: some View {
            kitStyle { style in
                let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
                shape
                    .fill(style.isNative ? Color.primary.opacity(0.06) : style.palette.accentSubtle)
                    .overlay {
                        if style.isNative {
                            shape.strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
                        }
                    }
                    .overlay {
                        if !style.isNative {
                            RadialGradient(
                                colors: [style.palette.accentSolid.opacity(0.22), .clear],
                                center: .topLeading, startRadius: 0, endRadius: 460
                            )
                            .clipShape(shape)
                        }
                    }
            }
        }
    }

    /// The start pane: the product's icon on the art ground. Decorative.
    struct KitMacArtPane: View {
        var body: some View {
            ZStack {
                KitMacArtFill()
                ProductIcon(size: 112)
            }
            .accessibilityHidden(true)
        }
    }

    /// The narrow window's one-line header strip: the icon and the product's name.
    struct KitMacStrip: View {
        /// The icon's inset in the strip.
        var leading: CGFloat
        /// The window's width, when known: at the minimum (480) the name is dropped.
        var iconOnly = false

        var body: some View {
            kitStyle { style in
                ZStack(alignment: .leading) {
                    KitMacArtFill()
                    HStack(spacing: style.space(.sm)) {
                        ProductIcon(size: 40)
                        // At the minimum width the strip is the icon alone.
                        if !iconOnly {
                            Text(style.identity.name)
                                .font(style.font(.label))
                                .foregroundStyle(style.palette.textStrong)
                                .lineLimit(1)
                        }
                    }
                    .padding(.leading, leading)
                    .accessibilityElement(children: .combine)
                }
                .frame(height: 64)
            }
        }
    }

    struct KitMacScaffold<Heading: View, Content: View, Actions: View, Footer: View>: View {
        let arrangement: KitMacArrangement
        let hero: Bool
        let header: Bool
        let tier: String?
        @ViewBuilder let heading: () -> Heading
        @ViewBuilder let content: () -> Content
        @ViewBuilder let actions: () -> Actions
        @ViewBuilder let footer: () -> Footer
        @Environment(\.dynamicTypeSize) private var typeSize

        var body: some View {
            kitStyle { style in
                GeometryReader { geo in
                    layout(style, geo)
                }
            }
            .environment(\.kitMacArrangement, arrangement)
            .environment(\.kitLeadingText, true)
        }

        @ViewBuilder private func layout(_ style: KitResolvedStyle, _ geo: GeometryProxy)
            -> some View
        {
            let safeTop = geo.safeAreaInsets.top
            switch arrangement {
            case .strip:
                VStack(spacing: 0) {
                    KitMacStrip(
                        leading: KitMacArrangement.stripInset,
                        iconOnly: geo.size.width <= KitMacArrangement.minimumWindow.width)
                        .padding(.horizontal, KitMacArrangement.artMargin)
                        .padding(.top, KitMacArrangement.artMargin)
                    endPane(style, height: geo.size.height - 78, safeTop: 0)
                }
            case .card:
                let size = KitMacArrangement.cardSize
                row(style, height: min(size.height, geo.size.height - 48), safeTop: 0)
                    .frame(
                        width: min(size.width, geo.size.width - 48),
                        height: min(size.height, geo.size.height - 48)
                    )
                    .background(
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .fill(style.dark ? style.palette.page.mix(with: .white, by: 0.06) : style.palette.page)
                            .shadow(color: .black.opacity(0.28), radius: 20, y: 12)
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .split, .short:
                row(style, height: geo.size.height, safeTop: safeTop)
            }
        }

        private func row(_ style: KitResolvedStyle, height: CGFloat, safeTop: CGFloat)
            -> some View
        {
            HStack(spacing: 0) {
                KitMacArtPane()
                    .frame(width: arrangement.artWidth)
                    .padding(KitMacArrangement.artMargin)
                endPane(style, height: height, safeTop: safeTop)
            }
        }

        private func endPane(_ style: KitResolvedStyle, height: CGFloat, safeTop: CGFloat)
            -> some View
        {
            let ins = arrangement.endInsets
            // The measures are the mockup's, drawn with the title bar; a titled window's content
            // starts under it, so the system's 28 pt comes off the top.
            let top = arrangement.isStrip ? ins.top : max(ins.top - 28, 20) + safeTop
            let pinned = arrangement.isStrip
            // At an accessibility text size the content outgrows the window: the actions stay
            // pinned under it, so the primary is always in the first viewport and the content (the
            // device list) is what scrolls. The text never shrinks.
            let pinsActions = pinned || typeSize.isAccessibilitySize
            return ScrollView {
                VStack(alignment: .leading, spacing: style.space(.lg)) {
                    if header && !hero && !pinned {
                        ProductHeader(tier: tier)
                    }
                    VStack(alignment: .leading, spacing: hero ? 8 : style.space(.md)) {
                        heading()
                        content()
                    }
                    if !pinsActions {
                        VStack(alignment: .leading, spacing: style.space(.md)) {
                            actions()
                            footer()
                        }
                    }
                }
                .frame(
                    maxWidth: pinned ? .infinity : KitMacArrangement.formMaxWidth,
                    alignment: .leading
                )
                .padding(.top, top)
                .padding(.leading, ins.leading)
                .padding(.trailing, ins.trailing)
                .padding(.bottom, pinsActions ? style.space(.md) : ins.bottom)
                .frame(
                    maxWidth: .infinity,
                    minHeight: max(0, height - (pinsActions ? 0 : 28)),
                    alignment: .topLeading)
            }
            .scrollBounceBehavior(.basedOnSize)
            // In the strip the actions are outside the scroll view, so they never fall below the
            // fold of a 480 x 520 window.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if pinsActions {
                    VStack(alignment: .leading, spacing: style.space(.md)) {
                        actions()
                        footer()
                    }
                    .padding(.leading, ins.leading)
                    .padding(.trailing, ins.trailing)
                    .padding(.top, style.space(.sm))
                    .padding(.bottom, ins.bottom)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(style.palette.page)
                }
            }
        }
    }

    /// The sheet's form: the header, the step and the act at 440 pt, fitted to its content.
    struct KitMacSheetForm<Heading: View, Content: View, Actions: View, Footer: View>: View {
        let header: Bool
        let tier: String?
        @ViewBuilder let heading: () -> Heading
        @ViewBuilder let content: () -> Content
        @ViewBuilder let actions: () -> Actions
        @ViewBuilder let footer: () -> Footer

        var body: some View {
            kitStyle { style in
                VStack(alignment: .leading, spacing: style.space(.md)) {
                    if header { ProductHeader(tier: tier) }
                    heading()
                    content()
                    actions()
                    footer()
                }
                // Children never lay out wider than the form (the sheet is 440 pt).
                .frame(
                    maxWidth: KitMacArrangement.sheetWidth - 2 * KitMacArrangement.sheetInsets.side,
                    alignment: .leading
                )
                .padding(.top, KitMacArrangement.sheetInsets.top)
                .padding(.horizontal, KitMacArrangement.sheetInsets.side)
                .padding(.bottom, KitMacArrangement.sheetInsets.bottom)
                .frame(width: KitMacArrangement.sheetWidth)
                .fixedSize(horizontal: false, vertical: true)
            }
            .environment(\.kitMacArrangement, .split)
            .environment(\.kitLeadingText, true)
        }
    }

    extension View {
        /// The Mac sheet: fitted to the 440 pt form. macOS 26 draws the inset rounded panel; the
        /// kit only sizes it (S3).
        func kitMacSheet() -> some View {
            presentationSizing(.fitted)
                .environment(\.kitInSheet, true)
        }
    }
#endif
