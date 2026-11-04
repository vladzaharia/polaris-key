// @pkey-feature ui.kit.holders
// The holders' steps over a live client (UK-43.6): `HolderFlowView` draws whatever step the flow
// (PolarisKeyUICore/Models/HolderFlowModel.swift) names, for the gate's Done step after a key activates
// and for Add from Settings.
//
//   done  ActivateDone. Add opens the account step in the app (iPhone, iPad, Mac), or the product page
//         where Identity is off: with `#key=` only where it is safe, and a danger line when it does not
//         open. Start using ends the flow and forgets the key.
//   qr    The manage QR a TV shows, with no key in it.
//   add   AddToAccount. Cancel returns to Done with focus on Add; Verify opens the account page and
//         says so when it does not.

import PolarisKeyCore
import PolarisKeyUICore
import SwiftUI

/// An opener for the actions that answer at once (Verify, the Settings row): it hands the link to the one opener
/// the environment gives and, when the system refuses the page, says so through `failed`. False only for a link
/// the kit would not open at all.
@MainActor
func holderOpening(_ opener: OpenURLAction, failed: @escaping @MainActor () -> Void) -> (URL) -> Bool {
    { url in
        guard KitLinks.valid(url.absoluteString) != nil else { return false }
        opener(url) { accepted in if !accepted { Task { @MainActor in failed() } } }
        return true
    }
}

public struct HolderFlowView: View {
    let flow: HolderFlowModel
    @Environment(\.openURL) private var opener

    public init(flow: HolderFlowModel) { self.flow = flow }

    public var body: some View {
        switch flow.stage {
        case .done:
            ActivateDoneView(
                inputs: flow.doneInputs, host: flow.doneHost, portalLink: flow.doneLink,
                onStart: { flow.finish() }, onAdd: { flow.openAdd() }, onSignedIn: { flow.finish() },
                onOtherAccount: { flow.showOtherAccount(expected: $0, signed: $1) })
        case .qr:
            HolderQrView(link: flow.qrLink, onBack: { flow.leave() })
        case .add:
            AddToAccountView(
                model: flow.add, onCancel: { flow.leave() }, onStart: { flow.finish() },
                onDone: { flow.finish() },
                onVerify: verify, onSignedIn: { flow.finish() })
        }
    }

    /// Verify opens the account page; false (the page did not open) says so on the screen. nil leaves it out.
    private var verify: (() -> Bool)? {
        guard flow.verifyLink != nil else { return nil }
        return {
            guard let link = flow.verifyLink, let url = KitLinks.valid(link) else { return false }
            return holderOpening(opener) { flow.add.host.problem = .openFailed }(url)
        }
    }
}

/// The manage QR a TV shows for adding the license in the portal: the key-free link, scanned on a phone. With no link it
/// draws no "Scan" sentence: it says it could not open and gives the portal's address as text.
struct HolderQrView: View {
    let link: String?
    let onBack: () -> Void
    @Environment(\.polarisKeyStrings) private var strings

    /// The address to type: host and path, no query.
    static func address(_ link: String?) -> String {
        guard let url = KitLinks.valid(link), let host = url.host else {
            return KitLinks.display(CUSTOMER_ORIGIN_DEFAULT)
        }
        let path = url.path == "/" ? "" : url.path
        return host + path
    }

    var body: some View {
        kitStyle { style in
            KitScreenScaffold(header: true) {
                KitText("signin.key.addInLocker", [:], .title, color: .strong)
                    .accessibilityAddTraits(.isHeader)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } content: {
                VStack(alignment: .leading, spacing: style.space(.md)) {
                    if let url = KitLinks.valid(link) {
                        // Not "add this key": the QR carries no key, the person types it on the phone.
                        KitText(CopyLine("part.qr.scanInstead"), .body, plain: true)
                        PolarisQRCode(url.absoluteString, accessibilityLabel: strings.string("a11y.qrManage"))
                            .frame(width: 240, height: 240)
                    } else {
                        HolderProblemLine(line: CopyLine(HolderProblem.linkUnavailable.key))
                    }
                    KitText(CopyLine("signin.handoff.url", ["url": .text(Self.address(link))]), .body)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } actions: {
                KitActionStack {
                    KitButton(line: CopyLine("common.done"), kind: .primary) { onBack() }
                }
            }
        }
    }
}
