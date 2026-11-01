// @pkey-feature ui.signin
// NearbyApproval (UI-KITS §4.1): the approving device's side of nearby sign-in. The entry is a row
// in the account menu; Ask shows the codes and the person taps the one the other device shows (no
// primary button: choosing the matching code is the action, and Deny the only other); the licence
// choice, when the Worker asks for one, is one tap per licence with Deny beside it; Approved and Not
// nearby are one sentence each. While a call is pending the screen shows progress and takes no second
// answer. Hidden when Identity is off.

import PolarisKeyCore
import PolarisKeyUICore
import SwiftUI

public struct NearbyApprovalView: View {
    let model: NearbyApprovalModel
    @Environment(\.polarisKeyStrings) private var strings

    public init(model: NearbyApprovalModel) { self.model = model }

    public var body: some View {
        let screen = model.screen
        switch screen.state {
        case nil:
            EmptyView()
        case .entry where model.presented:
            waiting(screen)
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

    /// The screen is open and no session has reached the code yet.
    @ViewBuilder private func waiting(_ screen: KitScreen<NearbyApprovalState>) -> some View {
        KitScreenScaffold(header: true) {
            if let title = screen.copy.first {
                KitText(title, .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } content: {
            if model.pending { LoadingIndicator(CopyLine("common.loading")) }
        } actions: {
            KitActionStack {
                KitButton(line: CopyLine("common.cancel"), kind: .quiet) { model.onPrimary?() }
                    .keyboardShortcut(.cancelAction)
            }
        }
    }

    @ViewBuilder private func step(_ screen: KitScreen<NearbyApprovalState>) -> some View {
        KitScreenScaffold(header: true) {
            kitStyle { style in
                HStack(alignment: .center, spacing: style.space(.xs)) {
                    if screen.state == .approved {
                        kitStyle { inner in
                            Image(systemName: "checkmark.circle.fill")
                                .font(inner.font(.title))
                                .foregroundStyle(inner.palette.success)
                                .accessibilityHidden(true)
                        }
                    }
                    if let title = screen.copy.first {
                        KitText(title, .title, color: .strong)
                    }
                }
                .accessibilityAddTraits(.isHeader)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } content: {
            kitStyle { style in
                VStack(alignment: .leading, spacing: style.space(.md)) {
                    if screen.state == .ask {
                        if let body = screen.line("signin.nearby.askBody") {
                            KitText(body, .body, color: .default)
                        }
                        codeRow
                        if let warning = screen.line("signin.approve.warning") {
                            KitText(warning, .meta, color: .muted)
                        }
                        if model.pending { LoadingIndicator(CopyLine("common.loading")) }
                    } else if screen.state == .choose {
                        if let lede = screen.line("signin.nearby.chooseLede") {
                            KitText(lede, .body, color: .default)
                        }
                        licenseRows
                        if model.pending { LoadingIndicator(CopyLine("common.loading")) }
                    } else {
                        // An outcome: its sentences under the title; the last line is the way on.
                        ForEach(Array(screen.copy.dropFirst().dropLast()), id: \.key) { line in
                            KitText(line, .body, color: .default)
                        }
                    }
                }
            }
        } actions: {
            KitActionStack {
                if screen.state == .ask || screen.state == .choose,
                    let deny = screen.line("signin.approve.deny")
                {
                    // Leaving the ask or the choice answers Deny, so Deny is the one way out.
                    KitButton(line: deny, kind: .quiet) { model.onDeny?() }
                        .keyboardShortcut(.cancelAction)
                        .disabled(model.pending && screen.state == .choose)
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
                            .font(style.font(.title))
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
                    .disabled(model.pending)
                    .accessibilityLabel(code)
                }
            }
        }
    }

    /// The licences the Worker offered: one tap gives the new device that licence. A full one is a row
    /// without an action.
    @ViewBuilder private var licenseRows: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.sm)) {
                ForEach(model.choices?.choices ?? []) { choice in
                    Button {
                        model.onChooseLicense?(choice.id)
                    } label: {
                        HStack(alignment: .center, spacing: style.space(.sm)) {
                            VStack(alignment: .leading, spacing: style.space(.xxs)) {
                                Text(choice.name ?? style.identity.name)
                                    .font(style.font(.body))
                                    .foregroundStyle(style.palette.textStrong)
                                    .fixedSize(horizontal: false, vertical: true)
                                HStack(spacing: style.space(.xs)) {
                                    Text(choice.tierName)
                                        .font(style.font(.footnote))
                                        .fixedSize()
                                        .padding(.horizontal, style.space(.xs))
                                        .padding(.vertical, style.space(.xxs) / 2)
                                        .background(Capsule().fill(style.palette.textStrong.opacity(0.09)))
                                    if let seats = choice.seats {
                                        Text(
                                            strings.string(
                                                "signin.choice.devices",
                                                ["used": .number(seats.used), "limit": .number(seats.limit)])
                                        )
                                        .font(style.font(.footnote))
                                        .foregroundStyle(style.palette.textMuted)
                                    }
                                    if choice.isFull {
                                        KitText("signin.choice.tag.full", [:], .footnote, color: .muted)
                                    }
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(style.space(.md))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                                .fill(style.palette.raised))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.pending || choice.isFull)
                }
                if model.choices?.create != nil {
                    KitButton(line: CopyLine("signin.choice.create"), kind: .quiet) {
                        model.onCreateLicense?()
                    }
                    .disabled(model.pending)
                }
            }
        }
    }
}
