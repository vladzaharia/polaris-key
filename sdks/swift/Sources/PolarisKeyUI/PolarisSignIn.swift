// `PolarisSignIn` — device-code sign-in (RFC 8628) with a QR code (notes/SDK-PARITY-PASS.md §3.12,
// §3.18): the URL, the user code, a QR of the pre-filled URL, a countdown, "Open browser",
// Cancel, and the optional "Is this you?" confirmation with the attach opt-in (P1-07).
//
// States: starting, waiting (pending / slow down), confirm, ready (+identity), expired, failed.

import Foundation
import Observation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
import SwiftUI

/// The device-code flow as observable state.
@MainActor
@Observable
public final class PolarisSignInModel {
    public enum Phase: Equatable {
        case idle
        case starting
        case waiting(SignInPrompt)
        case confirm(SignInPrompt, identity: SignInIdentity, attachable: Bool)
        case ready(SignInReady)
        case expired
        case failed(code: String, message: String)
    }

    public let client: PolarisKeyClient
    /// Hold the flow at the signed-in identity ("Is this you?") before completing.
    public var confirmIdentity: Bool
    public var deviceName: String?
    public private(set) var phase: Phase = .idle
    private var task: Task<Void, Never>?

    public init(client: PolarisKeyClient, confirmIdentity: Bool = false, deviceName: String? = nil) {
        self.client = client
        self.confirmIdentity = confirmIdentity
        self.deviceName = deviceName
    }

    /// Begin (or restart) the flow.
    public func start() {
        task?.cancel()
        phase = .starting
        let client = self.client
        let confirm = confirmIdentity
        let name = deviceName
        task = Task { [weak self] in
            do {
                let prompt = try await client.identity.beginSignIn(deviceName: name)
                self?.phase = .waiting(prompt)
                let result = try await client.identity.waitForSignIn(
                    prompt, confirmIdentity: confirm)
                self?.settle(result, prompt: prompt)
            } catch is CancellationError {
            } catch let e as PolarisError {
                self?.phase = .failed(code: e.code, message: ErrorCopy.message(e.code))
            } catch {
                self?.phase = .failed(code: ErrorCode.signInFailed, message: "\(error)")
            }
        }
    }

    /// The player accepted the identity a confirm showed.
    public func accept(attachLicense: Bool) {
        guard case .confirm(let prompt, _, let attachable) = phase else { return }
        let client = self.client
        task?.cancel()
        task = Task { [weak self] in
            do {
                let result = try await client.identity.acceptSignIn(
                    prompt, attachLicense: attachLicense && attachable)
                self?.settle(result, prompt: prompt)
            } catch is CancellationError {
            } catch let e as PolarisError {
                self?.phase = .failed(code: e.code, message: ErrorCopy.message(e.code))
            } catch {
                self?.phase = .failed(code: ErrorCode.signInFailed, message: "\(error)")
            }
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
        phase = .idle
    }

    private func settle(_ result: SignInResult, prompt: SignInPrompt) {
        switch result {
        case .ready(let ready): phase = .ready(ready)
        case .confirm(let identity, let attachable):
            phase = .confirm(prompt, identity: identity, attachable: attachable)
        case .expired: phase = .expired
        case .error:
            phase = .failed(
                code: ErrorCode.signInDenied, message: ErrorCopy.message(ErrorCode.signInDenied))
        }
    }

    /// The prompt being shown, if any.
    public var prompt: SignInPrompt? {
        switch phase {
        case .waiting(let p), .confirm(let p, _, _): return p
        default: return nil
        }
    }
}

/// The sign-in screen. `onFinish` runs once the flow settles as signed in, or on Cancel.
public struct PolarisSignIn: View {
    @State private var model: PolarisSignInModel
    private let theme: PolarisTheme
    private let onFinish: (Bool) -> Void
    @State private var attach = true
    @Environment(\.openURL) private var openURL

    public init(
        client: PolarisKeyClient, theme: PolarisTheme = PolarisTheme(),
        confirmIdentity: Bool = false, onFinish: @escaping (Bool) -> Void = { _ in }
    ) {
        _model = State(
            initialValue: PolarisSignInModel(client: client, confirmIdentity: confirmIdentity))
        self.theme = theme
        self.onFinish = onFinish
    }

    public init(
        model: PolarisSignInModel, theme: PolarisTheme = PolarisTheme(),
        onFinish: @escaping (Bool) -> Void = { _ in }
    ) {
        _model = State(initialValue: model)
        self.theme = theme
        self.onFinish = onFinish
    }

    private var copy: PolarisKitCopy { theme.copy.kit }

    public var body: some View {
        PolarisSignInSurface(
            phase: model.phase, theme: theme, attach: $attach,
            onOpen: { url in openURL(url) },
            onAccept: { model.accept(attachLicense: attach) },
            onRetry: { model.start() },
            onCancel: {
                model.cancel()
                onFinish(false)
            }
        )
        .task { if case .idle = model.phase { model.start() } }
        .onChange(of: model.phase) { _, phase in
            if case .ready = phase { onFinish(true) }
        }
        .onDisappear { model.cancel() }
    }
}

/// The sign-in screen for one phase, without a live client (previews and render tests).
struct PolarisSignInSurface: View {
    let phase: PolarisSignInModel.Phase
    let theme: PolarisTheme
    @Binding var attach: Bool
    let onOpen: (URL) -> Void
    let onAccept: () -> Void
    let onRetry: () -> Void
    let onCancel: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.polarisKeyBranding) private var branding

    private var copy: PolarisKitCopy { theme.copy.kit }

    var body: some View {
        let style = PolarisKitStyle(theme: theme, scheme: colorScheme, branding: branding)
        PolarisCard(theme: theme) {
            switch phase {
            case .idle, .starting:
                PolarisHeading(title: copy.signInTitle, subtitle: copy.startingSignIn, theme: theme)
                ProgressView().accessibilityLabel(copy.startingSignIn)
            case .waiting(let prompt):
                waiting(prompt, style: style)
            case .confirm(_, let identity, let attachable):
                PolarisHeading(
                    title: copy.confirmTitle,
                    subtitle: [identity.name, identity.email].compactMap { $0 }
                        .joined(separator: "\n"),
                    symbol: "person.crop.circle.badge.checkmark", theme: theme)
                if attachable {
                    Toggle(copy.attachFreeLicense, isOn: $attach)
                        .font(style.font(.caption))
                }
                Button(action: onAccept) {
                    Text(copy.confirmContinue).frame(maxWidth: .infinity)
                }
                .polarisPrimaryButton()
                cancelButton
            case .ready(let ready):
                PolarisHeading(
                    title: copy.signedInAs,
                    subtitle: [ready.identity?.name, ready.identity?.email].compactMap { $0 }
                        .joined(separator: "\n"),
                    symbol: "checkmark.circle.fill", theme: theme)
            case .expired:
                PolarisHeading(
                    title: ErrorCopy.title(ErrorCode.signInExpired),
                    subtitle: ErrorCopy.message(ErrorCode.signInExpired),
                    symbol: "clock.badge.exclamationmark", theme: theme)
                retryButtons
            case .failed(_, let message):
                PolarisHeading(
                    title: copy.signInTitle, subtitle: nil,
                    symbol: "exclamationmark.triangle.fill", theme: theme)
                PolarisErrorLine(message: message, theme: theme)
                retryButtons
            }
        }
    }

    @ViewBuilder private func waiting(_ prompt: SignInPrompt, style: PolarisKitStyle) -> some View {
        PolarisHeading(title: copy.signInTitle, subtitle: copy.signInSubtitle, theme: theme)
        PolarisQRCode(prompt.verificationUriComplete, accessibilityLabel: copy.signInQRLabel)
            .frame(maxWidth: 200, maxHeight: 200)
        Text(prompt.userCode)
            .font(.system(.title, design: .monospaced).weight(.semibold))
            .foregroundStyle(style.palette.textStrong)
            .textSelection(.enabled)
            .accessibilityLabel(prompt.userCode.map(String.init).joined(separator: " "))
        Text(prompt.verificationUri)
            .font(style.font(.caption)).foregroundStyle(style.palette.textMuted)
            .textSelection(.enabled)
        countdown(prompt, style: style)
        if let url = URL(string: prompt.verificationUriComplete) {
            Button {
                onOpen(url)
            } label: {
                Text(copy.openBrowserButton).frame(maxWidth: .infinity)
            }
            .polarisPrimaryButton()
        }
        cancelButton
    }

    private func countdown(_ prompt: SignInPrompt, style: PolarisKitStyle) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = max(0, prompt.expiresAt - Int(context.date.timeIntervalSince1970))
            Text("\(copy.codeExpiresIn) \(left / 60):\(String(format: "%02d", left % 60))")
                .font(style.font(.caption).monospacedDigit())
                .foregroundStyle(style.palette.textMuted)
        }
    }

    private var cancelButton: some View {
        Button(action: onCancel) { Text(copy.cancelButton).frame(maxWidth: .infinity) }
            .polarisSecondaryButton()
    }

    @ViewBuilder private var retryButtons: some View {
        Button(action: onRetry) { Text(copy.tryAgainButton).frame(maxWidth: .infinity) }
            .polarisPrimaryButton()
        cancelButton
    }
}
