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
    @State private var picking = false
    @State private var importing = false

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
            productName: PolarisProductIdentity.resolve(theme: theme, presentation: nil).name,
            deviceId: deviceId, message: message, imported: imported, importing: importing,
            theme: theme,
            onImportFile: { picking = true },
            onPaste: {
                if let text = PolarisPasteboard.string(),
                    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                {
                    importBundle(text)
                } else {
                    message = copy.offlineEmpty
                }
            },
            onDropText: { importBundle($0) },
            onDone: onDone
        )
        .fileImporter(
            isPresented: $picking, allowedContentTypes: [.data, .plainText, .text]
        ) { result in
            guard case .success(let url) = result else { return }
            importing = true
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                importing = false
                message = ErrorCopy.message(ErrorCode.bundle)
                return
            }
            importBundle(String(decoding: data, as: UTF8.self))
        }
        .task { deviceId = await model.client.core.deviceId }
    }

    private func importBundle(_ text: String) {
        importing = true
        // A dropped file arrives as its URL string on some platforms.
        if let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
            url.isFileURL, let data = try? Data(contentsOf: url)
        {
            return importBundle(String(decoding: data, as: UTF8.self))
        }
        let jws = text.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { importing = false }
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

/// The offline page for one state, without a live client (previews and render tests).
///
/// The request code is the device id alone, and Copy and the QR carry exactly what is shown; the
/// product sits on its own meta line above. The code never truncates (it wraps), and while the id
/// loads a redacted placeholder of the same length stands in with no Copy.
struct PolarisOfflineSurface: View {
    let productName: String
    let deviceId: String
    let message: String?
    let imported: Bool
    var importing = false
    let theme: PolarisTheme
    let onImportFile: () -> Void
    let onPaste: () -> Void
    var onDropText: (String) -> Void = { _ in }
    let onDone: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.polarisKeyBranding) private var branding
    @Environment(\.polarisKeyPresentation) private var presentation
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var targeted = false

    private var copy: PolarisKitCopy { theme.copy.kit }

    /// The request code: the device id alone. The card shows it, Copy copies it and the QR encodes
    /// it, all from this one value.
    static func requestCode(deviceId: String) -> String { deviceId }

    /// Drag and drop is offered on macOS and iPad (regular width), not on iPhone.
    private var offersDrop: Bool {
        #if os(macOS)
            return true
        #else
            return sizeClass == .regular
        #endif
    }

    var body: some View {
        let style = PolarisKitStyle(
            theme: theme, scheme: colorScheme, branding: branding, presentation: presentation)
        let identity = PolarisProductIdentity.resolve(theme: theme, presentation: presentation)
        PolarisAdaptivePage(style: style, identity: identity) { layout in
            PolarisPageHeading(
                title: imported ? copy.importedMessage : copy.offlineTitle, identity: identity,
                style: style, layout: layout, symbol: imported ? "checkmark.seal.fill" : nil)
        } detail: { layout in
            if !imported {
                VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.xxs) {
                    PolarisPageText(text: Text(copy.offlineRequest), style: style, layout: layout)
                    PolarisPageText(text: Text(copy.offlineLoadHint), style: style, layout: layout)
                }
            }
        } act: { layout in
            if imported {
                PolarisPageActions(
                    primaryTitle: copy.confirmContinue, primary: onDone, layout: layout,
                    style: style)
            } else {
                request(style: style, layout: layout)
            }
        }
        .modifier(KitTint(color: style.tint))
    }

    /// A placeholder of the id's real length (32 characters), drawn redacted while it loads.
    private var shownCode: String {
        deviceId.isEmpty ? String(repeating: "x", count: 32) : deviceId
    }

    @ViewBuilder private func request(style: PolarisKitStyle, layout: PolarisKitLayout)
        -> some View
    {
        VStack(alignment: layout.horizontalAlignment, spacing: PolarisSpace.l) {
            VStack(alignment: .leading, spacing: PolarisSpace.xs) {
                Text(String(format: copy.offlineProductLabel, productName))
                    .font(style.font(.meta)).foregroundStyle(style.palette.textMuted)
                Text(copy.requestCodeLabel)
                    .font(style.font(.meta)).foregroundStyle(style.palette.textMuted)
                codeCard(style: style, layout: layout)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(OfflineDropTarget(
                enabled: offersDrop, targeted: $targeted, caption: copy.dropHint, style: style,
                onDrop: onDropText))

            if let message {
                PolarisErrorLine(message: message, theme: theme, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            PolarisPageActions(
                primaryTitle: copy.importFileButton, primary: onImportFile,
                secondaryTitle: copy.cancelButton, secondary: onDone,
                leadingTitle: copy.pasteButton, leading: onPaste, layout: layout, style: style,
                primaryDisabled: importing)
            if importing { ProgressView().controlSize(.small) }
        }
    }

    /// The code card, with the QR beside it in the split and under it elsewhere.
    @ViewBuilder private func codeCard(style: PolarisKitStyle, layout: PolarisKitLayout)
        -> some View
    {
        let card = HStack(spacing: PolarisSpace.s) {
            Text(shownCode)
                .font(style.monoBody)
                .foregroundStyle(style.palette.textStrong)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .redacted(reason: deviceId.isEmpty ? .placeholder : [])
                .frame(maxWidth: .infinity, alignment: .leading)
            if !deviceId.isEmpty {
                PolarisCopyButton(
                    value: Self.requestCode(deviceId: deviceId), title: copy.copyCodeLabel, copiedTitle: copy.copiedLabel,
                    style: style)
            }
        }
        .padding(.vertical, PolarisSpace.s)
        .padding(.horizontal, PolarisSpace.m)
        .background(style.tileFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(style.palette.borderSubtle, lineWidth: 1))
        if deviceId.isEmpty {
            card
        } else if layout == .split {
            HStack(alignment: .center, spacing: PolarisSpace.m) {
                card
                PolarisQRCode(Self.requestCode(deviceId: deviceId), accessibilityLabel: copy.requestCodeLabel)
                    .frame(width: 96, height: 96)
            }
        } else if layout == .column {
            VStack(spacing: PolarisSpace.s) {
                card
                // The QR is decoration: it gives way on a compressed page so the actions fit.
                PolarisPageDecoration {
                    PolarisQRCode(
                        Self.requestCode(deviceId: deviceId),
                        accessibilityLabel: copy.requestCodeLabel
                    )
                    .frame(width: 128, height: 128)
                }
            }
        } else {
            card
        }
    }
}

/// The request area as a drop target: a dashed outline that highlights while a file is over it,
/// with the drop hint as its caption. A no-op where drops are not offered (iPhone).
private struct OfflineDropTarget: ViewModifier {
    let enabled: Bool
    @Binding var targeted: Bool
    let caption: String
    let style: PolarisKitStyle
    let onDrop: (String) -> Void

    func body(content: Content) -> some View {
        if enabled {
            VStack(alignment: .leading, spacing: PolarisSpace.xs) {
                content
                Text(caption).font(style.font(.meta)).foregroundStyle(style.palette.textMuted)
            }
            .padding(PolarisSpace.s)
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(
                        targeted ? AnyShapeStyle(style.textTintStyle) : AnyShapeStyle(style.palette.borderSubtle),
                        style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])))
            .dropDestination(for: String.self) { items, _ in
                guard let text = items.first else { return false }
                onDrop(text)
                return true
            } isTargeted: { targeted = $0 }
        } else {
            content
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
