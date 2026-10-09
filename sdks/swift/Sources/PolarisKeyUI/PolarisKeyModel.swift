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

    private var observation: Task<Void, Never>?

    public init(client: PolarisKeyClient, copy: PolarisCopy = PolarisCopy(), offersFreeTier: Bool = false) {
        self.client = client
        self.copy = copy
        self.offersFreeTier = offersFreeTier
    }

    /// Begin observing `client.events` and take the first snapshot. Idempotent.
    public func start() {
        guard observation == nil else { return }
        let stream = client.events
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
            served, key: key, returnURL: nil, presentation: PolarisManagePresentation.current)
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
    public func polarisKey(
        _ client: PolarisKeyClient, theme: PolarisTheme = PolarisTheme(), gate: Bool = true,
        offersFreeTier: Bool = false
    ) -> some View {
        modifier(
            PolarisKeyModifier(
                client: client, theme: theme, gate: gate, offersFreeTier: offersFreeTier))
    }

    /// The same, with a model the host already holds.
    public func polarisKey(
        model: PolarisKeyModel, theme: PolarisTheme = PolarisTheme(), gate: Bool = true
    ) -> some View {
        modifier(PolarisKeyModelModifier(model: model, theme: theme, gate: gate))
    }
}

struct PolarisKeyModifier: ViewModifier {
    let theme: PolarisTheme
    let gate: Bool
    @State private var model: PolarisKeyModel

    init(client: PolarisKeyClient, theme: PolarisTheme, gate: Bool, offersFreeTier: Bool) {
        self.theme = theme
        self.gate = gate
        _model = State(
            initialValue: PolarisKeyModel(
                client: client, copy: theme.copy, offersFreeTier: offersFreeTier))
    }

    func body(content: Content) -> some View {
        content.modifier(PolarisKeyModelModifier(model: model, theme: theme, gate: gate))
    }
}

struct PolarisKeyModelModifier: ViewModifier {
    let model: PolarisKeyModel
    let theme: PolarisTheme
    let gate: Bool
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        Group {
            if gate {
                PolarisGate(model: model, theme: theme) { content }
            } else {
                content
            }
        }
        .environment(model)
        .environment(\.polarisTheme, theme)
        .task {
            model.start()
            await model.refreshIfStale(minimumInterval: 0)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refreshIfStale() } }
        }
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
