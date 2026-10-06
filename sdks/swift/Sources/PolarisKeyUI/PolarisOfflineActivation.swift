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

    private var copy: PolarisKitCopy { theme.copy.kit }

    var body: some View {
        let style = PolarisKitStyle(theme: theme, scheme: colorScheme, branding: branding)
        PolarisCard(theme: theme) {
            if imported {
                PolarisHeading(
                    title: copy.offlineTitle, subtitle: copy.importedMessage,
                    symbol: "checkmark.seal.fill", theme: theme)
                Button(action: onDone) { Text(copy.confirmContinue).frame(maxWidth: .infinity) }
                    .polarisPrimaryButton()
            } else {
                PolarisHeading(
                    title: copy.offlineTitle, subtitle: copy.offlineSubtitle,
                    symbol: "doc.badge.arrow.up", theme: theme)
                VStack(spacing: 6) {
                    Text(copy.requestCodeLabel)
                        .font(style.font(.caption)).foregroundStyle(style.palette.textMuted)
                    Text("\(product) · \(deviceId)")
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(style.palette.textStrong)
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                    if !deviceId.isEmpty {
                        PolarisQRCode(deviceId, accessibilityLabel: copy.requestCodeLabel)
                            .frame(maxWidth: 140, maxHeight: 140)
                    }
                    Button(copied ? copy.copiedLabel : copy.copyButton, action: onCopy)
                        .buttonStyle(.borderless)
                        .disabled(deviceId.isEmpty)
                }
                Button(action: onImportFile) {
                    Text(copy.importFileButton).frame(maxWidth: .infinity)
                }
                .polarisPrimaryButton()
                Button(action: onPaste) { Text(copy.pasteButton).frame(maxWidth: .infinity) }
                    .polarisSecondaryButton()
                Text(copy.dropHint)
                    .font(style.font(.caption)).foregroundStyle(style.palette.textMuted)
                if let message { PolarisErrorLine(message: message, theme: theme) }
                Button(copy.cancelButton, action: onDone).buttonStyle(.borderless)
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
