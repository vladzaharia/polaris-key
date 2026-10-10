// The SwiftUI side of `PolarisKeyClient` (notes/SDK-PARITY-PASS.md §2.4, SP-S04).
//
//   PolarisKeyModel        an `@Observable` snapshot of the client — gate state, licence info,
//                          the signed profile, whether Identity runs — kept current by
//                          observing `client.events`, plus the actions every screen needs
//                          (refresh, activate, enrol, deactivate). One per client.
//   .polarisKey(client)    puts the model in the environment, syncs when the scene becomes
//                          active (at most once a minute), and wraps the content in the gate
//                          (`PolarisGate`), so one modifier gives a gated, refreshing app.
//
// Every kit component reads the model from the environment (`@Environment(PolarisKeyModel.self)`)
// and also takes one explicitly, so a host can place a component outside the modifier.

import Foundation
import Observation
import PolarisKey
import PolarisKeyCore
import PolarisKeyLicense
import SwiftUI

@MainActor
@Observable
public final class PolarisKeyModel {
    public let client: PolarisKeyClient
    /// The copy every component renders with (§3.2). Override strings here once.
    public var copy: PolarisCopy

    public private(set) var state: LicenseState = LicenseState(status: .needsActivation)
    public private(set) var info: LicenseInfo?
    public private(set) var profile: DocProfile?
    public private(set) var activation: ActivationSource?
    /// Whether the product runs Identity: the kit hides "Sign in" when it does not.
    public private(set) var identityEnabled = false
    /// Whether the product runs License at all (a config-only product shows no gate).
    public private(set) var licenseEnabled = true
    public private(set) var isWorking = false
    /// The last action's person-facing error, or nil.
    public var lastError: String?
    /// The last activation or enrolment, typed, so a view can branch on its kind.
    public private(set) var lastActivation: ActivationResult?
    /// The key of the last activation attempt, kept only while it was refused with `device_limit`
    /// so the gate can retry once after Replace a device; nil after any other result. Internal: it
    /// is a secret and never part of the public surface.
    private(set) var lastKey: String?
    /// Set by `updateAvailable` events.
    public private(set) var availableUpdate: String?
    /// Epoch seconds of the last sync this model ran.
    public private(set) var lastRefresh: Double?
    /// "Continue free" is shown only when the host says the product offers a free tier, and
    /// hidden for good once the server answers `enroll_disabled`.
    public var offersFreeTier: Bool
    /// Where the portal sends the person back after "Replace a device" (`GateOptions.returnURL`).
    public var returnURL: String?
    /// False until the first `reload()` has read the client. The gate draws nothing but its ground
    /// until then, so a licensed cold launch never flashes the activation card.
    public private(set) var hasLoaded = false
    /// Raised once per activation or enrolment result, so a repeated identical refusal is still a
    /// change the gate announces.
    public private(set) var resultSerial = 0

    /// The product's presentation from discovery (`client.presentation`), mapped once for the
    /// SwiftUI kit, with the verified icon's bytes once they arrive; nil when discovery carries
    /// none. The gate puts it in the environment (`polarisKeyPresentation`) unless the host set
    /// one there, and the integrator's theme still wins over it field by field.
    public private(set) var presentation: PolarisProductPresentation?

    private var observation: Task<Void, Never>?
    private var presentationMember: Presentation?
    private var presentationRead = false
    private var presentationGeneration = 0
    private var presentationUnsubscribe: (@Sendable () -> Void)?

    public init(
        client: PolarisKeyClient, copy: PolarisCopy = PolarisCopy(), offersFreeTier: Bool = false,
        returnURL: String? = nil
    ) {
        self.client = client
        self.copy = copy
        self.offersFreeTier = offersFreeTier
        self.returnURL = returnURL
    }

    /// Begin observing `client.events` and take the first snapshot. Idempotent.
    public func start() {
        guard observation == nil else { return }
        let stream = client.events
        presentationUnsubscribe = client.presentationSource.subscribe { [weak self] _ in
            Task { @MainActor in self?.readPresentation() }
        }
        observation = Task { [weak self] in
            await self?.reload()
            for await event in stream {
                guard let self else { return }
                switch event {
                case .updateAvailable(let version, _, _, _): self.availableUpdate = version
                default: await self.reload()
                }
            }
        }
    }

    public func stop() {
        observation?.cancel()
        observation = nil
        presentationUnsubscribe?()
        presentationUnsubscribe = nil
    }

    /// Re-read the client's state (no network).
    public func reload() async {
        let client = self.client
        state = await client.status()
        info = await client.licenseInfo()
        profile = await client.license.profile()
        activation = await client.license.activation()
        identityEnabled = await client.core.enabled(.identity)
        licenseEnabled = await client.core.licenseGateEnabled()
        readPresentation()
        hasLoaded = true
    }

    /// The SDK's `Presentation` as the kit's environment value: the one place the two meet.
    public nonisolated static func productPresentation(
        _ member: Presentation?, iconData: Data?
    ) -> PolarisProductPresentation? {
        guard let member else { return nil }
        return PolarisProductPresentation(
            name: member.name, developerName: member.developerName, accent: member.accent,
            accentDark: member.accentDark, iconData: iconData)
    }

    /// The hero's size the kit asks the icon for: the welcome pane's largest draw.
    static let presentationIconPoints: Double = 120
    static let presentationIconScale: Double = 3

    /// Re-read `client.presentation` (no network); when it changed, fetch its verified icon. A
    /// failed icon leaves the monogram or the bundle's icon, never an error.
    func readPresentation() {
        let member = client.presentation
        guard !presentationRead || member != presentationMember else { return }
        presentationRead = true
        presentationMember = member
        presentationGeneration += 1
        let generation = presentationGeneration
        presentation = Self.productPresentation(member, iconData: nil)
        guard member?.icon != nil else { return }
        let client = self.client
        Task { [weak self] in
            let data = await client.presentationIcon(
                points: Self.presentationIconPoints, scale: Self.presentationIconScale)
            guard let self, self.presentationGeneration == generation, let data else { return }
            self.presentation = Self.productPresentation(member, iconData: data)
        }
    }

    /// A sync, then a fresh snapshot.
    public func refresh() async {
        isWorking = true
        defer { isWorking = false }
        _ = await client.sync()
        lastRefresh = Date().timeIntervalSince1970
        await reload()
    }

    /// `refresh()` unless one ran in the last `minimumInterval` seconds.
    public func refreshIfStale(minimumInterval: Double = 60) async {
        if let last = lastRefresh, Date().timeIntervalSince1970 - last < minimumInterval { return }
        await refresh()
    }

    public func activate(key: String) async {
        await activate(key: key, showsWork: true)
    }

    /// `showsWork: false` runs the activation without raising `isWorking` (the gate's one retry
    /// after Replace a device must not disable a field the person is typing in).
    func activate(key: String, showsWork: Bool) async {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if showsWork { isWorking = true }
        defer { if showsWork { isWorking = false } }
        let result = await client.activate(key: trimmed)
        if case .deviceLimit = result { lastKey = trimmed } else { lastKey = nil }
        lastActivation = result
        lastError = copy.activationMessage(result)
        resultSerial += 1
        await reload()
    }

    /// Keyless enrolment ("Continue free").
    public func enroll() async {
        isWorking = true
        defer { isWorking = false }
        let result = await client.enroll()
        lastKey = nil
        lastActivation = result
        if case .enrollDisabled = result { offersFreeTier = false }
        lastError = copy.activationMessage(result)
        resultSerial += 1
        await reload()
    }

    /// Release this device's seat and wipe its credentials.
    public func deactivate() async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await client.deactivate()
            lastError = nil
        } catch {
            lastError = "\(copy.signOutFailedMessage) \(error.localizedDescription)"
        }
        await reload()
    }

    /// Whether `flag` is on (`isEnabled(flag:)`; false whenever the gate is not usable).
    public func isEnabled(flag: String) async -> Bool {
        await client.isEnabled(flag: flag)
    }

    /// The portal link that frees a seat after the last activation was refused with `device_limit`
    /// (with the key as a fragment on an `/activate` link, never on a QR), or nil. The gate offers
    /// it as Replace a device.
    public var offeredManageURL: String? {
        guard case .deviceLimit(_, _, let served)? = lastActivation, let key = lastKey else {
            return nil
        }
        return PolarisGateModel.offeredManageURL(
            served, key: key, returnURL: returnURL, presentation: PolarisManagePresentation.current)
    }

    /// Shown in place of the key field on store outlets that forbid key entry (App Store 3.1.1).
    public var usable: Bool { isUsable(state) }
}

// ── Environment ─────────────────────────────────────────────────────────────────────────────

extension View {
    /// The one-line integration: the model in the environment, a sync whenever the scene becomes
    /// active (at most once a minute), and the gate around the content.
    ///
    /// ```swift
    /// let client = try await PolarisKeyClient.fromBundle()
    /// WindowGroup { ContentView().polarisKey(client) }
    /// ```
    ///
    /// `options` carries what the host decides about the gate (`GateOptions`): key entry, offline
    /// activation (off on iOS), the free tier, the return URL for "Replace a device", a renewal
    /// page and a slot for the host's own action on a blocking state. `offersFreeTier` is kept
    /// for source compatibility and is the same switch as `options.offersFreeTier`.
    public func polarisKey(
        _ client: PolarisKeyClient, theme: PolarisTheme = PolarisTheme(), gate: Bool = true,
        offersFreeTier: Bool = false, options: GateOptions = GateOptions()
    ) -> some View {
        var options = options
        if offersFreeTier { options.offersFreeTier = true }
        return modifier(
            PolarisKeyModifier(client: client, theme: theme, gate: gate, options: options))
    }

    /// The same, with a model the host already holds.
    public func polarisKey(
        model: PolarisKeyModel, theme: PolarisTheme = PolarisTheme(), gate: Bool = true,
        options: GateOptions = GateOptions()
    ) -> some View {
        modifier(PolarisKeyModelModifier(model: model, theme: theme, gate: gate, options: options))
    }
}

struct PolarisKeyModifier: ViewModifier {
    let theme: PolarisTheme
    let gate: Bool
    let options: GateOptions
    @State private var model: PolarisKeyModel

    init(client: PolarisKeyClient, theme: PolarisTheme, gate: Bool, options: GateOptions) {
        self.theme = theme
        self.gate = gate
        self.options = options
        _model = State(
            initialValue: PolarisKeyModel(
                client: client, copy: theme.copy, offersFreeTier: options.offersFreeTier,
                returnURL: options.returnURL))
    }

    func body(content: Content) -> some View {
        content.modifier(
            PolarisKeyModelModifier(model: model, theme: theme, gate: gate, options: options))
    }
}

struct PolarisKeyModelModifier: ViewModifier {
    let model: PolarisKeyModel
    let theme: PolarisTheme
    let gate: Bool
    var options = GateOptions()
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        Group {
            if gate {
                PolarisGate(model: model, theme: theme, options: options) { content }
            } else {
                content
            }
        }
        .modifier(PolarisPresentationDefault(model: model))
        .environment(model)
        .environment(\.polarisTheme, theme)
        .task {
            // A model the host holds takes the options that belong to it.
            if let returnURL = options.returnURL { model.returnURL = returnURL }
            if options.offersFreeTier { model.offersFreeTier = true }
            model.start()
            await model.refreshIfStale(minimumInterval: 0)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refreshIfStale() } }
        }
    }
}

/// The model's presentation in the environment, unless the host already put one there: the
/// kit's default when the integrator passes nothing (plans/HA-13.md).
struct PolarisPresentationDefault: ViewModifier {
    let model: PolarisKeyModel
    @Environment(\.polarisKeyPresentation) private var host

    func body(content: Content) -> some View {
        content.environment(\.polarisKeyPresentation, host ?? model.presentation)
    }
}

private struct PolarisThemeKey: EnvironmentKey {
    static let defaultValue = PolarisTheme()
}

extension EnvironmentValues {
    /// The theme `.polarisKey(client, theme:)` set, read by every kit component.
    public var polarisTheme: PolarisTheme {
        get { self[PolarisThemeKey.self] }
        set { self[PolarisThemeKey.self] = newValue }
    }
}
