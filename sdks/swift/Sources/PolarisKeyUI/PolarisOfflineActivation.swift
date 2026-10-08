// `PolarisOfflineActivation` — offline activation (WIRE-CONTRACT-V3 §7, notes/SDK-PARITY-PASS.md
// §3.18): the request code an operator mints a bundle against (the product and this device's id,
// with Copy and a QR code), then the `pkey-bundle+jws` that comes back, imported from a file
// (`fileImporter`), pasted text, or a file or text dropped on the card.
//
// An import is all-or-nothing; a refusal names the §7 step in plain words (`ErrorCopy` by code).
// States: idle, imported, invalid bundle.

import PolarisKey
import PolarisKeyCore
import SwiftUI
import UniformTypeIdentifiers

#if os(macOS)
    import AppKit
#elseif canImport(UIKit)
    import UIKit
#endif

public struct PolarisOfflineActivation: View {
    private let model: PolarisKeyModel
    private let theme: PolarisTheme
    private let onDone: () -> Void

    @State private var deviceId = ""
    @State private var message: String?
    @State private var imported = false
    @State private var importing = false
    @State private var copied = false

    public init(
        model: PolarisKeyModel, theme: PolarisTheme = PolarisTheme(),
        onDone: @escaping () -> Void = {}
    ) {
        self.model = model
        self.theme = theme
        self.onDone = onDone
    }

    private var copy: PolarisKitCopy { theme.copy.kit }

    public var body: some View {
        PolarisOfflineSurface(
            product: model.client.product, deviceId: deviceId, message: message,
            imported: imported, copied: copied, theme: theme,
            onCopy: {
                PolarisPasteboard.copy(deviceId)
                copied = true
            },
            onImportFile: { importing = true },
            onPaste: { if let text = PolarisPasteboard.string() { importBundle(text) } },
            onDone: onDone
        )
        .dropDestination(for: String.self) { items, _ in
            guard let text = items.first else { return false }
            importBundle(text)
            return true
        }
        .fileImporter(
            isPresented: $importing, allowedContentTypes: [.data, .plainText, .text]
        ) { result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                message = ErrorCopy.message(ErrorCode.bundle)
                return
            }
            importBundle(String(decoding: data, as: UTF8.self))
        }
        .task { deviceId = await model.client.core.deviceId }
    }

    private func importBundle(_ text: String) {
        // A dropped file arrives as its URL string on some platforms.
        if let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
            url.isFileURL, let data = try? Data(contentsOf: url)
        {
            return importBundle(String(decoding: data, as: UTF8.self))
        }
        let jws = text.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                _ = try await model.client.importBundle(jws)
                imported = true
                message = nil
                await model.reload()
            } catch let e as PolarisError {
                imported = false
                message = ErrorCopy.message(e.code)
            } catch {
                imported = false
                message = ErrorCopy.message(ErrorCode.bundle)
            }
        }
    }
}

/// The offline card for one state, without a live client (previews and render tests).
struct PolarisOfflineSurface: View {
    let product: String
    let deviceId: String
    let message: String?
    let imported: Bool
    let copied: Bool
    let theme: PolarisTheme
    let onCopy: () -> Void
    let onImportFile: () -> Void
    let onPaste: () -> Void
    let onDone: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.polarisKeyBranding) private var branding
    @Environment(\.polarisKeyPresentation) private var presentation

    private var copy: PolarisKitCopy { theme.copy.kit }

    var body: some View {
        let style = PolarisKitStyle(
            theme: theme, scheme: colorScheme, branding: branding, presentation: presentation)
        let identity = PolarisProductIdentity.resolve(theme: theme, presentation: presentation)
        PolarisAdaptivePage(style: style, identity: identity) { layout in
            PolarisPageHeading(
                title: copy.offlineTitle, identity: identity, style: style, layout: layout,
                symbol: imported ? "checkmark.seal.fill" : nil)
        } detail: { layout in
            PolarisPageText(
                text: Text(imported ? copy.importedMessage : copy.offlineSubtitle), style: style,
                layout: layout)
        } act: { layout in
            if imported {
                PolarisPageActions(
                    primaryTitle: copy.confirmContinue, primary: onDone, layout: layout)
            } else {
                request(style: style, layout: layout)
            }
        }
        .modifier(KitTint(color: style.tint))
    }

    /// The request code (with Copy, and a QR another phone can scan when this device is offline),
    /// then the ways to bring the activation file back.
    @ViewBuilder private func request(style: PolarisKitStyle, layout: PolarisKitLayout)
        -> some View
    {
        VStack(spacing: PolarisSpace.l) {
            VStack(spacing: PolarisSpace.xs) {
                Text(copy.requestCodeLabel)
                    .font(style.font(.meta)).foregroundStyle(style.palette.textMuted)
                    .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
                HStack(spacing: PolarisSpace.s) {
                    Text("\(product) · \(deviceId)")
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(style.palette.textStrong)
                        // Never truncated: every character is needed to mint the bundle.
                        .lineLimit(2)
                        .minimumScaleFactor(0.6)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !deviceId.isEmpty {
                        Button(action: onCopy) {
                            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                .imageScale(.large)
                                .frame(minWidth: 28, minHeight: 28)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(copied ? copy.copiedLabel : copy.copyButton)
                    }
                }
                .padding(.vertical, PolarisSpace.s)
                .padding(.horizontal, PolarisSpace.m)
                .background(
                    style.sunken, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                if !deviceId.isEmpty, layout != .sideBySide {
                    PolarisQRCode(deviceId, accessibilityLabel: copy.requestCodeLabel)
                        .frame(maxWidth: 128, maxHeight: 128)
                        .padding(.top, PolarisSpace.xs)
                        .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
                }
            }
            VStack(spacing: PolarisSpace.s) {
                PolarisPageActions(
                    primaryTitle: copy.importFileButton, primary: onImportFile,
                    secondaryTitle: copy.pasteButton, secondary: onPaste, layout: layout,
                    secondaryCancels: false)
                Text(copy.dropHint)
                    .font(style.font(.meta)).foregroundStyle(style.palette.textMuted)
                    .multilineTextAlignment(layout.textAlignment)
                    .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
                if let message {
                    PolarisErrorLine(
                        message: message, theme: theme, alignment: layout.textAlignment
                    )
                    .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
                }
                Button(copy.cancelButton, action: onDone)
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
                    .frame(maxWidth: .infinity, alignment: layout.frameAlignment)
            }
        }
    }
}

/// The system pasteboard, both platforms.
enum PolarisPasteboard {
    @MainActor static func copy(_ text: String) {
        #if os(macOS)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        #elseif canImport(UIKit) && !os(tvOS) && !os(watchOS)
            UIPasteboard.general.string = text
        #endif
    }

    @MainActor static func string() -> String? {
        #if os(macOS)
            return NSPasteboard.general.string(forType: .string)
        #elseif canImport(UIKit) && !os(tvOS) && !os(watchOS)
            return UIPasteboard.general.string
        #else
            return nil
        #endif
    }
}
