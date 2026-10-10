// A floating banner (UI-KITS §4.1 UpdatePrompt and GraceBanner on iOS): a glyph or the product's
// icon, one or two lines of text, and compact buttons. The text keeps its width: when the buttons
// do not fit beside it at the current Dynamic Type size, they move under it, whole, so a word is
// never broken or clipped (DL11).

import SwiftUI

struct KitBanner<Leading: View, Lines: View, Actions: View>: View {
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let text: () -> Lines
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        kitStyle { style in
            ViewThatFits(in: .horizontal) {
                HStack(spacing: style.space(.sm)) {
                    leading()
                    textBlock(style)
                        .layoutPriority(1)
                    HStack(spacing: style.space(.xs)) { actions() }
                        .fixedSize()
                }
                VStack(alignment: .leading, spacing: style.space(.sm)) {
                    HStack(alignment: .top, spacing: style.space(.sm)) {
                        leading()
                        textBlock(style)
                    }
                    HStack(spacing: style.space(.xs)) { actions() }
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .padding(.leading, style.space(.md))
            .padding(.trailing, style.space(.sm))
            .padding(.vertical, style.space(.sm))
            .modifier(KitFloatingSurface(style: style))
            .padding(.horizontal, style.space(.md))
            .padding(.bottom, style.space(.xs))
            .accessibilityElement(children: .contain)
        }
    }

    private func textBlock(_ style: KitResolvedStyle) -> some View {
        VStack(alignment: .leading, spacing: 2) { text() }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Words wrap only between words; a column too narrow for its longest word makes
            // ViewThatFits take the stacked layout instead.
            .fixedSize(horizontal: false, vertical: true)
    }
}
