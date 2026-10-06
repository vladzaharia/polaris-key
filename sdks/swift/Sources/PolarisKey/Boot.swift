// `client.boot()` — one call from launch to a ready (or explained) app (notes/SDK-PARITY-PASS.md
// §3.4). It drives the boot stage machine (`bootTransition`, stage-matrix.json) end to end:
//
//   shell   discovery, when the client has no discovery document yet (a failure is tolerated:
//           the services fall back to `expectedServices`)
//   guard   the app boot guard's `markBootAttempt()` (§3.15)
//   sync    one Core pass; no answer at all is `offline`
//   gate    the gate status. With no credential it first REACQUIRES, following discovery's
//           registration policy: `open` registers the device keylessly; anything else leaves the
//           gate at `needs-activation`, an outcome the UI shell renders (an activation prompt is
//           never invented here)
//   decide  the update decision, when `client.update` is configured (PolarisKeyUpdate hooks it)
//   fetch   the required packs, when the content stamp names any (PolarisKeyUpdate hooks it)
//   mount   → ready; `BOOT_OK_SECONDS` later the launch is confirmed (§3.15)
//
// `ensureActivated()` is the sub-call that stops after the gate.

import Foundation
import PolarisKeyCore
import PolarisKeyLicense

/// The boot's `decide` stage.
public typealias BootDecideHook = @Sendable () async -> BootEvent.Decision
/// The boot's `fetch` stage: send consent/progress events through the first argument; answer the
/// result and the installed pack ids.
public typealias BootFetchHook =
    @Sendable (@escaping @Sendable (BootEvent) -> Void) async -> BootFetchAnswer
/// The boot options' pack lists (from the content stamp).
public typealias BootPackOptionsHook = @Sendable () async -> BootPackLists

public struct BootFetchAnswer: Sendable, Equatable {
    public let result: BootEvent.FetchResult
    public let installed: [String]
    public init(result: BootEvent.FetchResult, installed: [String]) {
        self.result = result
        self.installed = installed
    }
}

public struct BootPackLists: Sendable, Equatable {
    public let required: [String]
    public let essential: [String]
    public init(required: [String], essential: [String]) {
        self.required = required
        self.essential = essential
    }
}

/// The decide and fetch stages, supplied by the modules that own them.
public struct BootHooks: Sendable {
    /// nil skips the stage (`none`).
    public var decide: BootDecideHook?
    /// nil skips the stage (`ok`, nothing installed).
    public var fetch: BootFetchHook?
    public var packOptions: BootPackOptionsHook?

    public init(
        decide: BootDecideHook? = nil, fetch: BootFetchHook? = nil,
        packOptions: BootPackOptionsHook? = nil
    ) {
        self.decide = decide
        self.fetch = fetch
        self.packOptions = packOptions
    }
}

/// How a boot ended.
public struct BootRun: Sendable, Equatable {
    /// The machine's final state (`outcome`: ready, waiting, blocked, offline, error).
    public let state: BootState
    /// Every emit, in order (stage changes, `waiting`, `update_available`, …).
    public let emits: [BootEmit]
    /// The gate status the boot saw last.
    public let gate: LicenseStatus?
    /// The boot guard's answer.
    public let guardOutcome: BootGuardOutcome?

    public var outcome: BootOutcome { state.outcome }
}

/// Drives the reducer and records what it emitted.
private final class BootDriver: @unchecked Sendable {
    private let lock = NSLock()
    private var state: BootState
    private var emits: [BootEmit] = []
    private let onEmit: (@Sendable (BootEmit) -> Void)?

    init(_ options: BootOptions, onEmit: (@Sendable (BootEmit) -> Void)?) {
        self.state = initialBootState(options)
        self.onEmit = onEmit
    }

    @discardableResult
    func send(_ event: BootEvent) -> BootState {
        let (next, out): (BootState, [BootEmit]) = lock.withLock {
            let t = bootTransition(state, event)
            state = t.state
            emits.append(contentsOf: t.emits)
            return (t.state, t.emits)
        }
        for e in out { onEmit?(e) }
        return next
    }

    var current: BootState { lock.withLock { state } }
    var all: [BootEmit] { lock.withLock { emits } }
}

extension PolarisKeyClient {
    /// The boot hooks the other modules installed (`client.update` installs decide and fetch).
    public nonisolated var bootHooks: BootHooks {
        get { attachments.current[ObjectIdentifier(BootHooksKey.self)] as? BootHooks ?? BootHooks() }
    }

    /// Install boot hooks (PolarisKeyUpdate does this when `client.update` is built).
    public nonisolated func setBootHooks(_ hooks: BootHooks) {
        attachments.with { $0[ObjectIdentifier(BootHooksKey.self)] = hooks }
    }

    /// The app boot guard (§3.15).
    public nonisolated var bootGuard: AppBootGuard { AppBootGuard(core: core) }

    /// Boot the app. See the file header. `onStage` sees every emit as it happens; the returned
    /// run carries them all. `confirmAfterReady` confirms the launch `BOOT_OK_SECONDS` after a
    /// `ready` outcome (pass false to call `bootGuard.confirmBoot()` yourself).
    public func boot(
        options: BootOptions? = nil, register: Bool = true, confirmAfterReady: Bool = true,
        onStage: (@Sendable (BootEmit) -> Void)? = nil
    ) async -> BootRun {
        let hooks = bootHooks
        var opts = options ?? BootOptions()
        if options == nil, let packs = await hooks.packOptions?() {
            opts.requiredPacks = packs.required
            opts.essentialPacks = packs.essential
        }
        let driver = BootDriver(opts, onEmit: onStage)
        driver.send(.start)

        // shell
        if await core.discoveryDocument == nil, !core.localOnly { _ = await discover() }
        driver.send(.shellDone)

        // guard
        let guardOutcome = await bootGuard.markBootAttempt()
        driver.send(.guardDone(guardOutcome.guardResult))

        // sync
        let sync = await self.sync()
        // No answer for any document is `offline`; any answer (applied, unchanged, a refusal the
        // gate will render) is `ok`. A product that fetches no document has nothing to miss.
        let fetched = sync.documents.values.filter { $0 != .skipped }
        let answered = fetched.isEmpty || fetched.contains { $0 != .error }
        let syncResult: BootEvent.SyncResult = core.localOnly || !answered ? .offline : .ok
        var state = driver.send(.syncDone(syncResult))
        guard state.stage == .gate else {
            return BootRun(state: state, emits: driver.all, gate: nil, guardOutcome: guardOutcome)
        }

        // gate (reacquire first when there is no credential)
        let gate = await ensureActivatedStatus(register: register)
        state = driver.send(.gateStatus(gate))
        guard state.stage == .decide else {
            return BootRun(state: state, emits: driver.all, gate: gate, guardOutcome: guardOutcome)
        }

        // decide
        let decision = await hooks.decide?() ?? BootEvent.Decision.none
        state = driver.send(.decideDone(decision))
        guard state.stage == .fetch else {
            return BootRun(state: state, emits: driver.all, gate: gate, guardOutcome: guardOutcome)
        }

        // fetch
        if let fetch = hooks.fetch {
            let answer = await fetch { event in driver.send(event) }
            state = driver.send(.fetchDone(answer.result, installed: answer.installed))
        } else {
            // Nothing can fetch: required packs (if any) stay missing and the machine says so.
            state = driver.send(.fetchDone(.ok, installed: []))
        }
        guard state.stage == .mount else {
            return BootRun(state: state, emits: driver.all, gate: gate, guardOutcome: guardOutcome)
        }
        state = driver.send(.mountDone)

        if state.outcome == .ready, confirmAfterReady {
            let guardian = bootGuard
            Task.detached {
                try? await Task.sleep(nanoseconds: UInt64(BOOT_OK_SECONDS) * 1_000_000_000)
                await guardian.confirmBoot()
            }
        } else if bootConfirmation(state.outcome) == .now {
            await bootGuard.confirmBoot()
        }
        return BootRun(state: state, emits: driver.all, gate: gate, guardOutcome: guardOutcome)
    }

    /// Reacquire a credential the product's registration policy allows without a person (an
    /// `open` product registers the device keylessly), then answer the gate status. It never
    /// prompts: `needsActivation` is an outcome for the UI.
    @discardableResult
    public func ensureActivated(register: Bool = true) async -> LicenseStatus {
        await ensureActivatedStatus(register: register)
    }

    private func ensureActivatedStatus(register: Bool) async -> LicenseStatus {
        var status = await license.status().status
        if status == .needsActivation, await core.discoveryDocument == nil, !core.localOnly {
            _ = await discover()
        }
        let policy = await core.discoveryDocument?.core?.registration
        if status == .needsActivation, await core.token == nil, register,
            policy == .open, !core.localOnly
        {
            if case .ok = await self.register() {
                _ = await sync(force: true)
                status = await license.status().status
            }
        }
        return status
    }
}

private final class BootHooksKey {}
