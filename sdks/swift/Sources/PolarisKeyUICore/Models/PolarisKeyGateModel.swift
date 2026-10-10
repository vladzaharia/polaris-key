// The live headless model (UI-KITS §1.3 layer c, §4.2): an @Observable view of a PolarisKeyClient
// as `KitInputs`, with the actions every gate screen needs. The drop-in (`.polarisKeyGate`) draws
// it; a host with its own UI binds to the same properties and calls the same actions.
//
// What it fixes from the 0.8 kit (UI-KITS §4.2):
//   * it never shows activation before the first reload: until then the gate is `booting`
//     (the Must not: no flash of the wrong state during a cached-session check);
//   * it re-renders on background changes: it observes `client.events`;
//   * it starts itself (`start()` is idempotent and the drop-in calls it).
//
// Sign-in runs the SDK's device-code primitives in the one form (SIGN-IN.md §3.17): the browser
// hand-off opens the request's page in the system browser sheet, and "Use a code instead" reveals
// the same request's code, so there is never a second request. The in-app license choice (I-04 §G)
// waits for the SDK's grant API (I-10a); until then a sign-in ends on Done or the toast.

import Foundation
import Observation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
import PolarisKeyLicense

/// Which step of the gate the person is on while the license is not yet usable.
public enum KitGateRoute: String, Sendable, Equatable, CaseIterable {
    /// The Welcome screen: Sign in, Use a license key, the extras.
    case welcome
    /// The key field (Activate), reached from "Use a license key".
    case activate
    /// The one sign-in form.
    case signIn
    /// Offline activation.
    case offline
}

/// What the build offers and how the form presents (UI-KITS §3.1, owner decisions).
public struct KitGateOptions: Sendable, Equatable {
    /// Key entry; off where the outlet forbids it (App Store 3.1.1 applies to unlocking content
    /// bought elsewhere only when the product sells in-app, so the integrator decides).
    public var keyEntry: Bool
    /// Offline activation (off on iOS by default; UK-49).
    public var offlineActivation: Bool
    public var trial: Bool
    public var restore: Bool
    public var enroll: Bool
    public var signInPresentation: KitSignInPresentation
    public var replace: KitReplaceMode
    /// The integrator's identity overrides (UI-KITS §3.1 `product`).
    public var integrator: KitIntegrator?

    public init(
        keyEntry: Bool = true, offlineActivation: Bool = false, trial: Bool = false,
        restore: Bool = false, enroll: Bool = false,
        signInPresentation: KitSignInPresentation = .inline, replace: KitReplaceMode = .inline,
        integrator: KitIntegrator? = nil
    ) {
        self.keyEntry = keyEntry
        self.offlineActivation = offlineActivation
        self.trial = trial
        self.restore = restore
        self.enroll = enroll
        self.signInPresentation = signInPresentation
        self.replace = replace
        self.integrator = integrator
    }
}

/// The request a sign-in is waiting on, as the form shows it. The poll credential stays inside
/// the model: only the public user code and the pages are here.
public struct KitSignInRequest: Sendable, Equatable {
    public init(
        userCode: String, verificationUri: String, verificationUriComplete: String, expiresAt: Int
    ) {
        self.userCode = userCode
        self.verificationUri = verificationUri
        self.verificationUriComplete = verificationUriComplete
        self.expiresAt = expiresAt
    }

    /// What the person types on the page, `WDJB-MJHT`.
    public let userCode: String
    /// The page to open and type the code into.
    public let verificationUri: String
    /// The same page with the code filled in.
    public let verificationUriComplete: String
    /// When the code expires (epoch seconds, this client's clock).
    public let expiresAt: Int
}

/// Opens a page in the system browser sheet and closes it; the SDK's
/// `WebAuthenticationSignInBrowser` on iOS and macOS.
public typealias KitSignInBrowser = SignInBrowser

@MainActor
@Observable
public final class PolarisKeyGateModel {
    /// The client, or nil for a preview model.
    public let client: PolarisKeyClient?
    public var options: KitGateOptions {
        didSet { rebuild() }
    }
    /// The catalog the screens read, with the integrator's overrides.
    public var copy: KitCopy

    /// Everything the screens are drawn from.
    public private(set) var inputs: KitInputs
    /// The step shown while the license is not usable.
    public var route: KitGateRoute = .welcome {
        didSet { if route != oldValue { routeChanged() } }
    }
    /// The key field's text. Editing clears a submitted verdict and the last refusal (DL7).
    public var keyText: String = "" {
        didSet {
            guard keyText != oldValue else { return }
            keySubmitted = false
            activation = nil
            rebuild()
        }
    }
    /// The sign-in request in flight, or nil.
    public private(set) var request: KitSignInRequest?
    /// Whether the first reload has finished: before it the gate is `booting`, never Welcome.
    public private(set) var hasLoaded = false
    /// The name a finished sign-in names in its toast.
    public private(set) var signedInName: String?
    /// The latest one-shot message for assistive tech (DL7, DL9): set on each refusal, step and
    /// result; a view announces it once.
    public private(set) var announcement: CopyLine?

    // Live state the inputs are built from.
    private var license: LicenseState?
    private var servicesOn: Set<KitService>?
    private var registration: KitRegistration = .requiresLicense
    private var accountSignedIn = false
    private var presentation: KitPresentation?
    private var bundle: KitBundle
    private var platform: KitPlatform
    private var keySubmitted = false
    private var activation: KitActivation?
    private var pending: KitPending?
    private var signIn: KitSignIn?
    private var deviceCode: KitDeviceCode?
    private var signInError: KitError?
    private var update: KitUpdate?
    private var bootError: String?

    private var prompt: SignInPrompt?
    private var observation: Task<Void, Never>?
    private var signInTask: Task<Void, Never>?
    private var unsubscribe: (@Sendable () -> Void)?
    private let browser: (any KitSignInBrowser)?
    /// The browser the current request opened in (the injected one, else the system sheet).
    private var activeBrowser: (any KitSignInBrowser)?
    private let presentationSource: (any KitPresentationSource)?

    /// A live model over `client`.
    public init(
        client: PolarisKeyClient, options: KitGateOptions = KitGateOptions(),
        presentationSource: (any KitPresentationSource)? = nil,
        browser: (any KitSignInBrowser)? = nil, copy: KitCopy = .bundled,
        bundle: KitBundle? = nil, platform: KitPlatform = .current
    ) {
        self.client = client
        self.options = options
        self.copy = copy
        self.presentationSource = presentationSource
        self.browser = browser
        self.bundle = bundle ?? KitBundle(slug: client.product, name: Self.bundleName())
        self.platform = platform
        self.inputs = KitInputs(platform: platform)
        rebuild()
    }

    /// A still model for previews, galleries and snapshot tests: it shows `inputs` and its
    /// actions do nothing that reaches a network.
    public init(
        preview inputs: KitInputs, route: KitGateRoute = .welcome, copy: KitCopy = .bundled,
        request: KitSignInRequest? = nil, presentationIcon: Data? = nil
    ) {
        self.client = nil
        self.options = KitGateOptions()
        self.copy = copy
        self.presentationSource = nil
        self.browser = nil
        self.bundle = inputs.bundle
        self.platform = inputs.platform
        self.inputs = inputs
        self.route = route
        self.hasLoaded = true
        self.keyText = inputs.keyField?.text ?? ""
        self.keySubmitted = inputs.keyField?.submitted ?? false
        self.activation = inputs.activation
        self.inputs = inputs
        self.request = request
        self.presentationIcon = presentationIcon
    }

    // MARK: Screens

    public var gate: KitScreen<GateState> { KitStates.gate(inputs) }
    public var boot: KitScreen<BootScreenState> { KitStates.boot(inputs) }
    public var welcome: KitScreen<WelcomeState> { KitStates.welcome(inputs) }
    public var activate: KitScreen<ActivateState> { KitStates.activate(inputs) }
    public var signInScreen: KitScreen<SignInState> { KitStates.signIn(inputs) }
    public var handoff: KitScreen<SignInHandoffState> { KitStates.signInHandoff(inputs) }
    public var licenseChoice: KitScreen<LicenseChoiceState> { KitStates.licenseChoice(inputs) }
    public var deviceLimit: KitScreen<DeviceLimitState> { KitStates.deviceLimit(inputs) }
    public var statusScreen: KitScreen<StatusScreenState> { KitStates.statusScreen(inputs) }
    public var graceBanner: KitScreen<GraceBannerState> { KitStates.graceBanner(inputs) }
    public var offlineActivation: KitScreen<OfflineActivationState> {
        KitStates.offlineActivation(inputs)
    }
    public var updatePrompt: KitScreen<UpdatePromptState> { KitStates.updatePrompt(inputs) }
    public var identity: ResolvedIdentity { KitIdentity.resolve(inputs) }

    /// The verdict on the key field as typed.
    public var keyVerdict: KeyVerdict { KeyVerdict(keyText, submitted: keySubmitted) }

    // MARK: Lifecycle

    /// Observe `client.events` and take the first snapshot. Idempotent.
    public func start() {
        guard let client, observation == nil else { return }
        let stream = client.events
        if let source = presentationSource {
            unsubscribe = source.subscribe { [weak self] in
                Task { @MainActor in self?.readPresentation() }
            }
        }
        readPresentation()
        observation = Task { [weak self] in
            await self?.reload()
            await self?.refresh()
            for await event in stream {
                guard let self else { return }
                if case .updateAvailable(let version, let action, let mandatory, _) = event {
                    self.update = KitUpdate(action: action, version: version, mandatory: mandatory)
                    self.rebuild()
                } else {
                    await self.reload()
                }
            }
        }
    }

    public func stop() {
        observation?.cancel()
        observation = nil
        signInTask?.cancel()
        signInTask = nil
        unsubscribe?()
        unsubscribe = nil
    }

    /// Re-read the client's state (no network).
    public func reload() async {
        guard let client else { return }
        let state = await client.status()
        let core = client.core
        var on: Set<KitService> = []
        for service in KitService.allCases {
            if let slug = ServiceSlug(rawValue: service.rawValue), await core.enabled(slug) {
                on.insert(service)
            }
        }
        if await core.licenseGateEnabled() { on.insert(.license) } else { on.remove(.license) }
        let policy = await core.discoveryDocument?.core?.registration
        let current = await client.identity.current()
        license = state
        servicesOn = on
        registration = policy.flatMap { KitRegistration(rawValue: $0.rawValue) } ?? .requiresLicense
        accountSignedIn = current != nil
        if let name = current?.name ?? current?.email { signedInName = name }
        hasLoaded = true
        if state.status == .ok || state.status == .grace || state.status == .notApplicable {
            route = .welcome
        }
        rebuild()
    }

    /// A sync, then a fresh snapshot ("Try again", "Reconnect").
    public func refresh() async {
        guard let client else { return }
        let result = await client.sync()
        _ = result
        await reload()
    }

    // MARK: Activation

    /// Show the key field.
    public func useLicenseKey() { route = .activate }

    /// Back to Welcome (Cancel on a step, Escape, the sheet's dismissal).
    public func backToWelcome() {
        cancelSignIn()
        route = .welcome
    }

    /// Submit the key field (Return or Activate). A short or malformed key is caught here and
    /// never sent.
    public func submitKey() async {
        keySubmitted = true
        activation = nil
        rebuild()
        guard keyVerdict.kind == .parsed, let client else {
            announce(activate.copy.first)
            return
        }
        pending = .activate
        rebuild()
        let key = keyText.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = await client.activate(key: key)
        pending = nil
        activation = Self.kitActivation(result)
        rebuild()
        announce(activate.copy.first)
        if result.isOK { await reload() }
    }

    /// Paste replaces the field's text (the field is never appended to).
    public func paste(_ text: String) {
        keyText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func kitActivation(_ result: ActivationResult) -> KitActivation {
        switch result {
        case .deviceLimit(let limit, let count, let manageURL):
            return KitActivation(
                result: result.kind, limit: limit, deviceCount: count, manageUrl: manageURL)
        case .refused(let code, _, _):
            return KitActivation(result: "refused", code: code)
        case .error(let code, _, _):
            return KitActivation(result: "error", code: code)
        default:
            return KitActivation(result: result.kind)
        }
    }

    // MARK: Sign-in

    /// Start the sign-in: one request, opened in the system browser sheet (the hand-off step), or,
    /// with `code`, shown as the code view without a browser ("Sign in with a code"). `method`
    /// names what the person picked, for a failure's sentence.
    public func beginSignIn(method: String? = nil, code: Bool = false) {
        guard let client else { return }
        route = .signIn
        signInError = nil
        signIn = KitSignIn(
            presentation: options.signInPresentation, replace: options.replace,
            channel: .browser, method: method)
        pending = .signIn
        rebuild()
        signInTask?.cancel()
        signInTask = Task { [weak self] in
            guard let self else { return }
            do {
                let prompt = try await client.identity.beginSignIn(deviceName: nil)
                try Task.checkCancellation()
                self.prompt = prompt
                self.request = KitSignInRequest(
                    userCode: prompt.userCode, verificationUri: prompt.verificationUri,
                    verificationUriComplete: prompt.verificationUriComplete,
                    expiresAt: prompt.expiresAt)
                self.pending = nil
                self.signIn?.outcome = .pending
                if code {
                    self.signIn?.channel = .deviceCode
                    self.deviceCode = KitDeviceCode(phase: .waiting, secondsLeft: self.secondsLeft)
                } else {
                    let opened = await self.openBrowser(prompt.verificationUriComplete)
                    self.signIn?.browserOpened = opened
                }
                self.rebuild()
                self.announce(self.signInScreen.copy.first)
                await self.waitForSignIn(prompt)
            } catch is CancellationError {
                return
            } catch {
                self.pending = nil
                self.signInError = KitError(
                    code: (error as? PolarisError)?.code ?? "sign-in-failed")
                self.rebuild()
                self.announce(self.signInScreen.copy.first)
            }
        }
    }

    /// "Open browser again": the same request's page, never a second request.
    public func reopenBrowser() {
        guard let prompt else { return }
        signIn?.event = .reopen
        Task { [weak self] in
            let opened = await self?.openBrowser(prompt.verificationUriComplete) ?? false
            self?.signIn?.browserOpened = opened
            self?.rebuild()
        }
    }

    /// "Use a code instead": the same request's code, in place.
    public func useCode() {
        guard prompt != nil else { return }
        signIn?.channel = .deviceCode
        signIn?.event = .useCode
        deviceCode = KitDeviceCode(phase: .waiting, secondsLeft: secondsLeft)
        activeBrowser?.close()
        rebuild()
        announce(handoff.copy.first)
    }

    /// The link was copied (no browser could open).
    public func linkCopied() {
        signIn?.event = .copyLink
        rebuild()
        announce(handoff.copy.first)
    }

    /// Cancel the sign-in: the form returns to its first step; nothing binds.
    public func cancelSignIn() {
        signInTask?.cancel()
        signInTask = nil
        activeBrowser?.close()
        prompt = nil
        request = nil
        deviceCode = nil
        signInError = nil
        pending = nil
        if signIn != nil { signIn?.outcome = .cancelled }
        signIn?.channel = .browser
        signIn?.event = nil
        rebuild()
    }

    /// Seconds until the request's code expires, or nil.
    public var secondsLeft: Int? {
        guard let request else { return nil }
        return max(0, request.expiresAt - Int(Date().timeIntervalSince1970))
    }

    private func openBrowser(_ url: String) async -> Bool {
        guard KitLinks.valid(url) != nil,
            let browser = browser ?? activeBrowser ?? defaultBrowser()
        else {
            return false
        }
        activeBrowser = browser
        do {
            try await browser.open(URL(string: url)!)
            return true
        } catch {
            return false
        }
    }

    private func defaultBrowser() -> (any KitSignInBrowser)? {
        #if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(visionOS))
            return WebAuthenticationSignInBrowser()
        #else
            return nil
        #endif
    }

    private func waitForSignIn(_ prompt: SignInPrompt) async {
        guard let client else { return }
        do {
            let result = try await client.identity.waitForSignIn(prompt)
            try Task.checkCancellation()
            activeBrowser?.close()
            switch result {
            case .ready(let ready):
                if signIn?.channel == .deviceCode { deviceCode = KitDeviceCode(phase: .ok) }
                signIn?.redeeming = true
                rebuild()
                if let name = ready.identity?.name ?? ready.identity?.email { signedInName = name }
                await reload()
                signIn?.redeeming = nil
                signIn?.outcome = .signedIn
                signIn?.issuedNow = false
                rebuild()
                announce(signInScreen.copy.first)
            case .confirm:
                // waitForSignIn without confirmIdentity never stops here; treat it as unfinished.
                signInError = KitError(code: "sign-in-failed")
                rebuild()
            case .expired:
                if signIn?.channel == .deviceCode {
                    deviceCode = KitDeviceCode(phase: .expired)
                } else {
                    signIn?.outcome = .expired
                }
                rebuild()
                announce(signInScreen.copy.first)
            case .error:
                signInError = KitError(code: "sign-in-failed")
                rebuild()
                announce(signInScreen.copy.first)
            }
        } catch {
            return
        }
    }

    // MARK: Blocking states

    /// "Use a different key" and "Use another license": the key field, the refused license kept
    /// until a new one activates.
    public func useDifferentKey() {
        keyText = ""
        route = .activate
        rebuild()
    }

    /// Sign out: release this device's seat and wipe its credential.
    public func signOut() async {
        guard let client else { return }
        try? await client.deactivate()
        route = .welcome
        await reload()
    }

    // MARK: Inputs

    private func readPresentation() {
        guard let p = presentationSource?.current() else {
            presentation = nil
            rebuild()
            return
        }
        presentation = KitPresentation(
            name: p.name, developerName: p.developerName, accent: p.accent,
            accentDark: p.accentDark, icon: false)
        rebuild()
        Task { [weak self] in
            guard let source = self?.presentationSource else { return }
            let data = await source.icon(px: 120, scale: 3)
            self?.presentationIcon = data
            self?.presentation?.icon = data != nil
            self?.rebuild()
        }
    }

    /// The verified presentation icon's bytes, when the source supplied them.
    public private(set) var presentationIcon: Data?

    private func rebuild() {
        guard client != nil else {
            // A preview keeps its inputs; only the key field follows what is typed.
            if inputs.keyField?.text != keyText || inputs.keyField?.submitted != keySubmitted {
                inputs.keyField = KitKeyField(text: keyText, submitted: keySubmitted)
                inputs.activation = activation
            }
            return
        }
        var i = KitInputs(
            integrator: options.integrator, presentation: presentation, bundle: bundle,
            platform: platform, services: servicesOn, registration: registration,
            capabilities: KitCapabilities(
                signIn: true, keyEntry: options.keyEntry, deviceCode: true,
                offlineActivation: options.offlineActivation, trial: options.trial,
                restore: options.restore, purchase: false, enroll: options.enroll))
        if !hasLoaded {
            i.gate = KitGate(checking: true)
        } else if let license {
            let status = KitLicenseStatus(rawValue: license.status.rawValue) ?? .needsActivation
            var days: Int?
            if status == .grace, let until = license.graceUntil {
                let left = Double(until) - Date().timeIntervalSince1970
                days = max(0, Int((left / 86_400).rounded(.up)))
            }
            i.gate = KitGate(
                status: status, graceDaysLeft: days,
                allowed: license.allowedRange.map {
                    KitAllowedVersions(min: $0.min, max: $0.max)
                })
        }
        i.pending = pending
        i.keyField = KitKeyField(text: keyText, submitted: keySubmitted)
        i.activation = activation
        i.signIn = signIn
        i.deviceCode = signIn?.channel == .deviceCode ? deviceCode : nil
        if route == .signIn { i.error = signInError }
        i.update = update
        i.account = KitAccount(signedIn: accountSignedIn, holder: accountSignedIn ? "account" : nil)
        inputs = i
    }

    private func routeChanged() {
        if route != .signIn, signIn != nil, signIn?.outcome != .signedIn { cancelSignIn() }
        if route == .signIn, signIn == nil {
            signIn = KitSignIn(
                presentation: options.signInPresentation, replace: options.replace,
                channel: .browser)
        }
        rebuild()
    }

    private func announce(_ line: CopyLine?) { announcement = line }

    private static func bundleName() -> String? {
        let info = Bundle.main.infoDictionary ?? [:]
        return (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String)
    }
}
