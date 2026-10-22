// @pkey-feature ui.activate
// OfflineActivation (UI-KITS §4.3): one form of two numbered steps, in every state but done.
// Step 1 sends the request (the code with Copy, and its QR); step 2 loads the response (a file,
// a drop or pasted text). A rejected signature keeps the form and adds its error under step 2;
// done is a titled confirmation with Done. A loaded file is not an activation until its
// signature verifies, and the product's name appears once, in the header.

import PolarisKeyUICore
import SwiftUI
import UniformTypeIdentifiers

public struct OfflineActivationView: View {
    let screen: KitScreen<OfflineActivationState>
    let requestCode: String
    @Binding var text: String
    var onCopied: () -> Void
    var onSubmit: () -> Void
    var onCancel: (() -> Void)?
    var onDone: (() -> Void)?

    @State private var copied = false
    @State private var picking = false
    @FocusState private var focused: Bool
    @AccessibilityFocusState private var errorFocused: Bool
    @Environment(\.polarisKeyStrings) private var strings
    @Environment(\.horizontalSizeClass) private var sizeClass

    public init(
        screen: KitScreen<OfflineActivationState>, requestCode: String, text: Binding<String>,
        onCopied: @escaping () -> Void = {}, onSubmit: @escaping () -> Void,
        onCancel: (() -> Void)? = nil, onDone: (() -> Void)? = nil
    ) {
        self.screen = screen
        self.requestCode = requestCode
        self._text = text
        self.onCopied = onCopied
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        self.onDone = onDone
    }

    private var done: Bool { screen.state == .done }

    public var body: some View {
        KitScreenScaffold(header: true) {
            KitText(screen.lineOrKey("offlineActivation.title"), .title, color: .strong)
                .accessibilityAddTraits(.isHeader)
                .frame(maxWidth: .infinity, alignment: .leading)
        } content: {
            if done {
                confirmation
            } else {
                form
            }
        } actions: {
            actions
        }
    }

    // MARK: Done

    private var confirmation: some View {
        kitStyle { style in
            HStack(alignment: .top, spacing: style.space(.sm)) {
                Image(systemName: "checkmark.circle.fill")
                    .font(style.font(.title))
                    .foregroundStyle(style.palette.success)
                    .accessibilityHidden(true)
                KitText(screen.lineOrKey("offlineActivation.done"), .body, color: .default)
            }
        }
    }

    // MARK: The two steps

    private var form: some View {
        kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.lg)) {
                step(1, "offlineActivation.request") { requestBlock(style) }
                step(2, "offlineActivation.loadHint") { loadBlock(style) }
            }
        }
    }

    /// One numbered step: the kit draws the number (a formatted integer, not copy) beside the
    /// sentence, which is the step.
    private func step<Body: View>(
        _ number: Int, _ key: String, @ViewBuilder _ body: () -> Body
    ) -> some View {
        let inner = body()
        return kitStyle { style in
            VStack(alignment: .leading, spacing: style.space(.sm)) {
                HStack(alignment: .firstTextBaseline, spacing: style.space(.sm)) {
                    Text(verbatim: "\(number)")
                        .font(style.font(.meta).weight(.semibold))
                        .foregroundStyle(style.palette.textStrong)
                        .frame(width: 24, height: 24)
                        .background(style.palette.raised, in: Circle())
                        .overlay(Circle().strokeBorder(style.palette.border, lineWidth: 1))
                        .accessibilityHidden(true)
                    KitText(screen.lineOrKey(key), .body, color: .default)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Text(verbatim: "\(number). \(strings.string(screen.lineOrKey(key)))"))
                inner
            }
        }
    }

    // MARK: Step 1

    @ViewBuilder private func requestBlock(_ style: KitResolvedStyle) -> some View {
        let wasCopied = copied || screen.shows("offlineActivation.codeCopied")
        let card = VStack(alignment: .leading, spacing: style.space(.sm)) {
            Text(verbatim: PolarisOfflineSurface.displayCode(requestCode))
                .font(style.font(.key))
                .foregroundStyle(style.palette.textStrong)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            KitButton(
                line: CopyLine(wasCopied ? "offlineActivation.codeCopied" : "offlineActivation.copyCode"),
                kind: .secondary, fullWidth: false, compact: true
            ) {
                KitPasteboard.copy(requestCode)
                copied = true
                onCopied()
            }
        }
        .padding(style.space(.md))
        .background(
            RoundedRectangle(cornerRadius: style.groupRadius, style: .continuous)
                .fill(style.palette.sunken))
        let qr = PolarisQRCode(
            requestCode, accessibilityLabel: strings.string("a11y.qrRequest")
        )
        .frame(width: 112, height: 112)
        // The QR gives way before the actions do (DL3): beside the card where it fits, under it
        // where the card needs the width.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: style.space(.md)) {
                card
                qr
            }
            VStack(alignment: .leading, spacing: style.space(.sm)) {
                card
                qr
            }
        }
    }

    // MARK: Step 2

    private var offersDrop: Bool {
        #if os(macOS)
            return true
        #else
            return sizeClass == .regular
        #endif
    }

    private var error: CopyLine? {
        screen.line("core.codes.bundle-jws-rejected.message")
            ?? screen.line("offlineActivation.empty")
    }

    @ViewBuilder private func loadBlock(_ style: KitResolvedStyle) -> some View {
        VStack(alignment: .leading, spacing: style.space(.sm)) {
            KitButton(
                line: screen.lineOrKey("offlineActivation.loadFile"), kind: .secondary,
                fullWidth: false
            ) { picking = true }
            TextField(
                strings.string("offlineActivation.paste"), text: $text, axis: .vertical
            )
            .font(style.font(.key))
            .lineLimit(2...4)
            .autocorrectionDisabled()
            #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.asciiCapable)
            #endif
            .focused($focused)
            .padding(style.space(.md))
            .background(
                RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                    .fill(style.palette.sunken)
            )
            .overlay(
                RoundedRectangle(cornerRadius: style.fieldRadius, style: .continuous)
                    .strokeBorder(
                        error != nil
                            ? style.palette.danger : (focused ? style.palette.focus : .clear),
                        lineWidth: 2)
            )
            .privacySensitive()
            if let error {
                Label {
                    KitText(error, .meta, color: .danger)
                } icon: {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(style.palette.danger)
                        .accessibilityHidden(true)
                }
                .accessibilityFocused($errorFocused)
                .onAppear { errorFocused = true }
            }
            if offersDrop {
                KitText(screen.lineOrKey("offlineActivation.dropHint"), .meta, color: .muted)
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.data, .plainText, .text]) {
            result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let data = try? Data(contentsOf: url) {
                text = String(decoding: data, as: UTF8.self)
            }
        }
        .modifier(OfflineDrop(enabled: offersDrop) { text = $0 })
    }

    // MARK: Actions

    @ViewBuilder private var actions: some View {
        KitActionStack {
            if done {
                KitButton(line: screen.lineOrKey("common.done"), kind: .primary) { onDone?() }
                    .keyboardShortcut(.defaultAction)
            } else {
                KitButton(line: screen.lineOrKey("offlineActivation.submit"), kind: .primary) {
                    onSubmit()
                }
                .keyboardShortcut(.defaultAction)
                if let onCancel {
                    KitButton(line: CopyLine("common.cancel"), kind: .quiet, action: onCancel)
                        .keyboardShortcut(.cancelAction)
                }
            }
        }
    }
}

/// A file's text or text dropped on the form, where drops are offered (a Mac, an iPad).
private struct OfflineDrop: ViewModifier {
    let enabled: Bool
    let onDrop: (String) -> Void

    func body(content: Content) -> some View {
        if enabled {
            content.dropDestination(for: String.self) { items, _ in
                guard let text = items.first else { return false }
                onDrop(text.trimmingCharacters(in: .whitespacesAndNewlines))
                return true
            }
        } else {
            content
        }
    }
}
