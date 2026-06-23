// A drop-in SwiftUI gate that renders by license status. It observes a `PolarisKeyClient`
// (the headless API stays there) and shows the right surface for each state: an OIDC sign-in
// button + license-key entry card when enrollment is needed, an offline-grace banner, a
// version-block screen, or — when usable — the product's own UI via a slot closure.
//
// Brandable through `PolarisKeyTheme`; extensible through the `content` slot, so a product
// drops this in at its root and supplies (a) what to render once licensed and (b) how to
// start its OIDC flow.

import PolarisKey
import SwiftUI

/// An observable wrapper that bridges the `PolarisKeyClient` actor into SwiftUI. It snapshots
/// the gate state on the main actor so views update; call `refresh()`/`activate(key:)` to
/// drive the client and re-snapshot.
@MainActor
public final class PolarisKeyGateModel: ObservableObject {
    @Published public private(set) var state: LicenseState
    @Published public private(set) var profile: DocProfile?
    @Published public private(set) var isWorking = false
    @Published public var lastError: String?

    private let client: PolarisKeyClient

    public init(client: PolarisKeyClient, initialState: LicenseState = LicenseState(status: .needsEnroll)) {
        self.client = client
        self.state = initialState
    }

    /// Pull the latest gate state from the client (no network).
    public func reload() async {
        state = await client.status()
        profile = await client.profile()
    }

    /// Re-fetch managed config online, then re-snapshot the gate.
    public func refresh() async {
        isWorking = true
        defer { isWorking = false }
        _ = await client.refresh()
        await reload()
    }

    /// Activate with a license key, surfacing a human error on failure, then re-snapshot.
    public func activate(key: String) async {
        isWorking = true
        defer { isWorking = false }
        let result = await client.activate(key: key)
        switch result {
        case .ok:
            lastError = nil
        case .machineLimit:
            lastError = "This license has reached its device limit."
        case .unauthorized:
            lastError = "That license key wasn't accepted."
        case .error(let message):
            lastError = message.isEmpty ? "Activation failed." : message
        }
        await reload()
    }

    public func deactivate() async {
        isWorking = true
        defer { isWorking = false }
        await client.deactivate()
        await reload()
    }
}

/// The drop-in gate. `content` is rendered when the gate is usable (ok/grace); `onSignIn`
/// starts the product's OIDC flow (the SDK is transport-agnostic about the browser dance).
public struct PolarisKeyLoginView<Content: View>: View {
    @ObservedObject private var model: PolarisKeyGateModel
    private let theme: PolarisKeyTheme
    private let onSignIn: () -> Void
    private let content: () -> Content

    @State private var licenseKey: String = ""

    public init(
        model: PolarisKeyGateModel,
        theme: PolarisKeyTheme = PolarisKeyTheme(),
        onSignIn: @escaping () -> Void = {},
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.model = model
        self.theme = theme
        self.onSignIn = onSignIn
        self.content = content
    }

    public var body: some View {
        Group {
            switch model.state.status {
            case .ok:
                content()
            case .grace:
                graceScreen
            case .needsEnroll:
                enrollScreen
            case .revoked:
                messageScreen(
                    title: theme.copy.revokedTitle, subtitle: theme.copy.revokedSubtitle,
                    symbol: "xmark.seal.fill")
            case .expired:
                messageScreen(
                    title: theme.copy.expiredTitle, subtitle: theme.copy.expiredSubtitle,
                    symbol: "clock.badge.exclamationmark")
            case .versionTooOld, .versionTooNew, .channelNotEntitled:
                versionBlockScreen
            }
        }
        .task { await model.reload() }
    }

    // ── needs-enroll: OIDC button + license-key card ──
    private var enrollScreen: some View {
        cardShell {
            theme.logo()
            Text(theme.copy.welcomeTitle).font(.title2).bold()
            Text(theme.copy.welcomeSubtitle)
                .font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button(action: onSignIn) {
                Text(theme.copy.signInButton)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.accent)
            .disabled(model.isWorking)

            HStack { divider; Text("or").font(.caption).foregroundStyle(.secondary); divider }

            VStack(spacing: 8) {
                #if os(iOS)
                TextField(theme.copy.licenseKeyPlaceholder, text: $licenseKey)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                #else
                TextField(theme.copy.licenseKeyPlaceholder, text: $licenseKey)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                #endif
                Button(theme.copy.activateButton) {
                    let key = licenseKey
                    Task { await model.activate(key: key) }
                }
                .frame(maxWidth: .infinity)
                .buttonStyle(.bordered)
                .disabled(model.isWorking || licenseKey.isEmpty)
            }

            if let err = model.lastError {
                Text(err).font(.caption).foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            if model.isWorking { ProgressView() }
        }
    }

    // ── grace: keep working, with a reconnect affordance ──
    private var graceScreen: some View {
        VStack(spacing: 0) {
            banner(
                title: theme.copy.graceTitle, subtitle: theme.copy.graceSubtitle,
                symbol: "wifi.exclamationmark", tint: .orange)
            content()
        }
    }

    private var versionBlockScreen: some View {
        let title: String
        switch model.state.status {
        case .versionTooNew: title = theme.copy.versionTooNewTitle
        case .channelNotEntitled: title = theme.copy.channelNotEntitledTitle
        default: title = theme.copy.versionTooOldTitle
        }
        var subtitle = theme.copy.versionBlockSubtitle
        if let range = model.state.allowedRange {
            let parts = [range.min.map { "min \($0)" }, range.max.map { "max \($0)" }]
                .compactMap { $0 }
            if !parts.isEmpty { subtitle += " (allowed: \(parts.joined(separator: ", ")))" }
        }
        return messageScreen(title: title, subtitle: subtitle, symbol: "exclamationmark.triangle.fill")
    }

    // ── shared building blocks ──
    private func messageScreen(title: String, subtitle: String, symbol: String) -> some View {
        cardShell {
            Image(systemName: symbol).font(.system(size: 40)).foregroundStyle(theme.accent)
            Text(title).font(.title2).bold()
            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") { Task { await model.refresh() } }
                .buttonStyle(.bordered)
                .disabled(model.isWorking)
        }
    }

    private func cardShell<C: View>(@ViewBuilder _ inner: () -> C) -> some View {
        VStack(spacing: 16) { inner() }
            .padding(28)
            .frame(maxWidth: 360)
            .background(.background)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(.quaternary, lineWidth: 1)
            )
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func banner(title: String, subtitle: String, symbol: String, tint: Color) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline).bold()
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Reconnect") { Task { await model.refresh() } }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model.isWorking)
        }
        .padding(10)
        .background(tint.opacity(0.12))
    }

    private var divider: some View { Rectangle().fill(.quaternary).frame(height: 1) }
}
