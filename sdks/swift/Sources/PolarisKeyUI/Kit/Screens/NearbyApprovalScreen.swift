// @pkey-feature ui.signin
// NearbyApproval (UI-KITS §4.1): the approving device's side of nearby sign-in. The entry is a row
// in the account menu; Ask shows the codes and the person taps the one the other device shows (no
// primary button: choosing the matching code is the action, and Not now the only other); Approved
// and Not nearby are one sentence each. Hidden when Identity is off.

import PolarisKeyUICore
import SwiftUI

public struct NearbyApprovalView: View {
    let model: NearbyApprovalModel

    public init(model: NearbyApprovalModel) { self.model = model }

    public var body: some View {
        let screen = model.screen
        switch screen.state {
        case nil:
            EmptyView()
        case .entry:
            entry(screen)
        default:
            step(screen)
        }
    }

    /// The account menu's row.
    @ViewBuilder private func entry(_ screen: KitScreen<NearbyApprovalState>) -> some View {
        if let line = screen.copy.first {
            KitButton(line: line, kind: .quiet, glyph: "iphone.radiowaves.left.and.right") {
                model.onOpen?()
            }
        }
    }

    @ViewBuilder private func step(_ screen: KitScreen<NearbyApprovalState>) -> some View {
        KitScreenScaffold(header: true) {
            HStack(alignment: .center, spacing: 8) {
                if screen.state == .approved {
                    kitStyle { style in
                        Image(systemName: "checkmark.circle.fill")
                            .font(style.font(.title))
                            .foregroundStyle(style.palette.success)
                            .accessibilityHidden(true)
                    }
                }
                if let title = screen.copy.first {
                    KitText(title, .title, color: .strong)
                }
            }
            .accessibilityAddTraits(.isHeader)
            .frame(maxWidth: .infinity, alignment: .leading)
        } content: {
            VStack(alignment: .leading, spacing: 16) {
                if screen.state == .ask {
                    if let body = screen.line("signin.nearby.askBody") {
                        KitText(body, .body, color: .default)
                    }
                    codeRow
                    if let warning = screen.line("signin.approve.warning") {
                        KitText(warning, .meta, color: .muted)
                    }
                } else {
                    // An outcome: its sentences under the title; the last line is the way on.
                    ForEach(Array(screen.copy.dropFirst().dropLast()), id: \.key) { line in
                        KitText(line, .body, color: .default)
                    }
                }
            }
        } actions: {
            KitActionStack {
                if screen.state == .ask, let deny = screen.line("signin.approve.deny") {
                    KitButton(line: deny, kind: .quiet) { model.onDeny?() }
                        .keyboardShortcut(.cancelAction)
                } else if screen.state != .ask, let way = screen.copy.last {
                    KitButton(line: way, kind: .primary) { model.onPrimary?() }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
    }

    /// The candidate codes, large and tappable; none is preselected.
    @ViewBuilder private var codeRow: some View {
        kitStyle { style in
            HStack(spacing: style.space(.sm)) {
                ForEach(model.codes, id: \.self) { code in
                    Button {
                        model.onChoose?(code)
                    } label: {
                        Text(code)
                            .font(.system(size: 28, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(style.palette.textStrong)
                            .frame(maxWidth: .infinity, minHeight: 64)
                            .background(
                                RoundedRectangle(
                                    cornerRadius: style.groupRadius, style: .continuous
                                )
                                .fill(style.palette.raised))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(code)
                }
            }
        }
    }
}
