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
            case .revoked, .expired, .versionTooOld, .versionTooNew, .channelNotEntitled:
                // One shared mapping for every terminal "message" surface — see
                // `PolarisKeyCopy.message(for:allowedRange:)`.
                if let copy = theme.copy.message(
                    for: model.state.status, allowedRange: model.state.allowedRange)
                {
                    messageScreen(
                        title: copy.title, subtitle: copy.subtitle, symbol: copy.symbol)
                }
            }
        }
        .task { await model.reload() }
    }

    // ── needs-enroll: OIDC button + license-key card ──
    private var enrollScreen: some View {
        cardShell {
            theme.logo()
                .accessibilityHidden(true)
            Text(theme.copy.welcomeTitle)
                .font(.title2).bold()
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(theme.copy.welcomeSubtitle)
                .font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Button(action: onSignIn) {
                Text(theme.copy.signInButton)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.accent)
            .disabled(model.isWorking)
            .accessibilityLabel(theme.copy.signInButton)
            .accessibilityHint("Opens single sign-on to license \(theme.copy.productName).")

            HStack {
                divider
                Text(theme.copy.orDividerLabel).font(.caption).foregroundStyle(.secondary)
                divider
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(theme.copy.orDividerLabel)

            VStack(spacing: 8) {
                #if os(iOS)
                TextField(theme.copy.licenseKeyPlaceholder, text: $licenseKey)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel(theme.copy.licenseKeyPlaceholder)
                    .accessibilityHint("Enter a license key to activate without signing in.")
                #else
                TextField(theme.copy.licenseKeyPlaceholder, text: $licenseKey)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .accessibilityLabel(theme.copy.licenseKeyPlaceholder)
                    .accessibilityHint("Enter a license key to activate without signing in.")
                #endif
                Button(theme.copy.activateButton) {
                    let key = licenseKey
                    Task { await model.activate(key: key) }
                }
                .frame(maxWidth: .infinity)
                .buttonStyle(.bordered)
                .disabled(model.isWorking || licenseKey.isEmpty)
                .accessibilityLabel(theme.copy.activateButton)
                .accessibilityHint("Activates the license key you entered above.")
            }

            if let err = model.lastError {
                Text(err)
                    .font(.caption).foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isStaticText)
            }
            if model.isWorking {
                ProgressView()
                    .accessibilityLabel("Working")
            }
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

    // ── shared building blocks ──
    private func messageScreen(title: String, subtitle: String, symbol: String) -> some View {
        cardShell {
            // Group the glyph + title + body so VoiceOver reads them as one status card
            // ("<title>. <subtitle>.") instead of three disjoint swipes; the glyph carries
            // no independent meaning, so it folds into the combined label.
            VStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.system(size: 40)).foregroundStyle(theme.accent)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.title2).bold()
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(subtitle)
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)

            Button(theme.copy.retryButton) { Task { await model.refresh() } }
                .buttonStyle(.bordered)
                .disabled(model.isWorking)
                .accessibilityLabel(theme.copy.retryButton)
                .accessibilityHint("Re-checks your license with the server.")
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
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline).bold()
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // Combine the title + body into a single announced label; flag it as an alert so
            // VoiceOver proactively reads the grace state when the banner appears.
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isStaticText)
            Spacer()
            Button(theme.copy.reconnectButton) { Task { await model.refresh() } }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model.isWorking)
                .accessibilityLabel(theme.copy.reconnectButton)
                .accessibilityHint("Re-checks your license to leave the offline grace period.")
        }
        .padding(10)
        .background(tint.opacity(0.12))
        .accessibilityElement(children: .contain)
    }

    private var divider: some View { Rectangle().fill(.quaternary).frame(height: 1) }
}
