// @pkey-feature ui.gate
// The boot screen's wait (UI-KITS DL7, §1.5 rule 4, §4.1 Boot): nothing for the first 250-300 ms,
// then the screen to come as a skeleton under the product's icon, a muted label, and the 2 px
// shimmer along the top edge. The elements kit draws the same shape (`.skeleton` + `.shimmer`).

import PolarisKeyUICore
import SwiftUI

/// What the skeleton draws, apart from the drawing: the bars' relative widths and where the
/// shimmer sits. Reduce Motion pins the shimmer, so the skeleton is static.
struct BootSkeletonModel: Equatable {
    /// The skeleton bars as fractions of the content width: a line and a shorter one (the
    /// elements kit's `span` and `span[data-short]`).
    static let bars: [Double] = [1, 0.7]
    /// The shimmer is 40 % of the edge wide, as in the elements kit.
    static let shimmerWidth = 0.4
    /// Where the shimmer rests when motion is reduced (its start edge, as a fraction of the track).
    static let restingStart = 0.3
    /// The grace before anything shows.
    static let grace: UInt64 = 260_000_000

    var reduceMotion: Bool

    /// The shimmer's start edge as a fraction of the track at `elapsed` seconds. It sweeps from
    /// off the start edge to off the end edge each `PolarisKit.Motion.shimmer`.
    func shimmerStart(elapsed: Double) -> Double {
        if reduceMotion { return Self.restingStart }
        let period = PolarisKit.Motion.shimmer
        let t = elapsed.truncatingRemainder(dividingBy: period) / period
        return -Self.shimmerWidth + t * (1 + Self.shimmerWidth)
    }
}

/// The skeleton of the screen to come. One VoiceOver element: the visible label (the bars are hidden).
struct BootSkeleton: View {
    let line: CopyLine
    let shown: Bool
    var body: some View {
        kitStyle { style in
            VStack(spacing: style.space(.md)) {
                if shown {
                    KitText(line, .meta, color: .muted, alignment: .center)
                        .accessibilityAddTraits(.updatesFrequently)
                    VStack(spacing: style.space(.sm)) {
                        ForEach(Array(BootSkeletonModel.bars.enumerated()), id: \.offset) { _, f in
                            Capsule()
                                .fill(style.palette.textStrong.opacity(0.08))
                                .frame(height: 12)
                                .containerRelativeFrame(.horizontal) { w, _ in w * 0.6 * f }
                        }
                    }
                    .accessibilityHidden(true)
                }
            }
            .frame(minHeight: 60)
            .frame(maxWidth: .infinity)
        }
    }
}

/// The 2 px shimmer along the top edge of the screen.
struct BootShimmer: View {
    let model: BootSkeletonModel
    let color: Color
    @State private var start = Date()

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation(paused: model.reduceMotion)) { ctx in
                let x = model.shimmerStart(elapsed: ctx.date.timeIntervalSince(start))
                LinearGradient(
                    colors: [.clear, color.opacity(0.45), .clear], startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(width: geo.size.width * BootSkeletonModel.shimmerWidth, height: 2)
                .offset(x: geo.size.width * x)
            }
            .frame(width: geo.size.width, height: 2, alignment: .leading)
            .clipped()
        }
        .frame(height: 2)
        .accessibilityHidden(true)
    }
}
