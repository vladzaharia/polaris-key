// The boot stage machine — client boot behaviour, outside the wire contract.
//
// Mirrors `@polaris-key/client-core`'s `stages.ts`. One pure reducer every renderer drives (a
// SwiftUI boot view, Godot's PKeyBoot, a terminal): the host does the work of each stage and
// reports its result as an event; the machine decides the next stage and what to emit. It does
// no I/O, reads no clock and uses no randomness, so the same inputs reach the same stages,
// emits and outcome in every language. `conformance/corpus/v2/stage-matrix.json` pins it, and
// `StageMatrixTests` replays every row and every probe of its `accepts` table over the mirror in
// `Tests/PolarisKeyTests/Resources/v2/`.
//
// The normal path is idle → shell → guard → sync → gate → decide → fetch → mount → ready, and
// every stage is entered even when it has nothing to do. An event the current stage does not
// accept is IGNORED: the input state comes back unchanged with no emits. Every accepted event
// emits something, so an empty `emits` always means the event was ignored. Malformed events
// cannot be expressed: `BootEvent` and `BootEmit` are closed enums.
//
// The corpus strings (dotted events, snake_case emits, kebab-case payload values) are each
// case's `type` or raw value; no port renames a string.

/// Every stage, in boot order, then the three stops.
public let BOOT_STAGES: [String] = BootStage.allCases.map(\.rawValue)
/// The outcome a renderer reports: `running` until the boot stops or the gate waits.
public let BOOT_OUTCOMES: [String] = BootOutcome.allCases.map(\.rawValue)
/// The events a host sends, dotted.
public let BOOT_EVENT_TYPES: [String] = [
    "start", "shell.done", "guard.done", "sync.done", "sync.timeout", "gate.status", "decide.done",
    "fetch.done", "mount.done", "background.start", "background.done", "retry", "play-offline",
    "fail",
]
/// The emits the machine produces, snake_case: the signal names renderers expose.
public let BOOT_EMIT_TYPES: [String] = [
    "stage_changed", "waiting", "update_available", "blocked", "offline", "error",
    "boot_rolled_back", "boot_ready",
]
/// What `bootGuardAction` decides at launch.
public let BOOT_GUARD_ACTIONS: [String] = BootGuardAction.allCases.map(\.rawValue)
/// Unconfirmed launches of the active slot that trigger a rollback on the next launch.
public let MAX_FAILED_BOOTS = 2

public enum BootStage: String, Sendable, Equatable, CaseIterable {
    case idle, shell, `guard`, sync, gate, decide, fetch, mount, ready, background
    case offline, blocked, error
}

public enum BootOutcome: String, Sendable, Equatable, CaseIterable {
    case running, waiting, ready, blocked, offline, error
}

public enum BootGuardAction: String, Sendable, Equatable, CaseIterable {
    case none
    case applyStaged = "apply-staged"
    case rollBack = "roll-back"
}

/// An event the host sends: the result of its work for the current stage.
public enum BootEvent: Sendable, Equatable {
    case start
    case shellDone
    case guardDone(GuardResult)
    case syncDone(SyncResult)
    /// Sent by the host's own timer while the sync runs.
    case syncTimeout
    /// A status from `licenseState`; sent again while the gate waits.
    case gateStatus(LicenseStatus)
    case decideDone(Decision)
    /// `installed` lists the pack ids present after the fetch, compared by exact string.
    case fetchDone(FetchResult, installed: [String])
    case mountDone
    case backgroundStart
    case backgroundDone
    case retry
    case playOffline
    /// The host's own work for the current stage failed in a way its event cannot express.
    case fail(code: String)

    public enum GuardResult: String, Sendable, Equatable, CaseIterable {
        case ok, applied
        case rolledBack = "rolled-back"
    }
    public enum SyncResult: String, Sendable, Equatable, CaseIterable {
        case ok, offline, error
    }
    public enum Decision: String, Sendable, Equatable, CaseIterable {
        case none, optional, required
    }
    public enum FetchResult: String, Sendable, Equatable, CaseIterable {
        case ok, offline, failed
    }

    /// The corpus's dotted event type.
    public var type: String {
        switch self {
        case .start: "start"
        case .shellDone: "shell.done"
        case .guardDone: "guard.done"
        case .syncDone: "sync.done"
        case .syncTimeout: "sync.timeout"
        case .gateStatus: "gate.status"
        case .decideDone: "decide.done"
        case .fetchDone: "fetch.done"
        case .mountDone: "mount.done"
        case .backgroundStart: "background.start"
        case .backgroundDone: "background.done"
        case .retry: "retry"
        case .playOffline: "play-offline"
        case .fail: "fail"
        }
    }
}

/// What the machine emits; a renderer exposes each as a signal or callback.
public enum BootEmit: Sendable, Equatable {
    /// Always first, on every stage change.
    case stageChanged(stage: BootStage, previous: BootStage)
    case waiting(status: LicenseStatus)
    case updateAvailable
    case blocked(reason: BlockedReason)
    /// `canPlayOffline` is `false` on every v1 path.
    case offline(canPlayOffline: Bool)
    /// `sync-failed`, `fetch-failed`, or the code of the host's `fail`.
    case error(code: String)
    case bootRolledBack
    case bootReady

    public enum BlockedReason: String, Sendable, Equatable, CaseIterable {
        case updateRequired = "update-required"
        case notAvailable = "not-available"
    }

    /// The corpus's snake_case emit type.
    public var type: String {
        switch self {
        case .stageChanged: "stage_changed"
        case .waiting: "waiting"
        case .updateAvailable: "update_available"
        case .blocked: "blocked"
        case .offline: "offline"
        case .error: "error"
        case .bootRolledBack: "boot_rolled_back"
        case .bootReady: "boot_ready"
        }
    }
}

public struct BootOptions: Sendable, Equatable {
    /// Continue on local state when the sync gets no answer or an unusable one.
    public var allowOffline: Bool
    /// Let `grace` pass the gate.
    public var allowGrace: Bool
    /// Pack ids that must be installed before `mount`.
    public var requiredPacks: [String]

    public init(allowOffline: Bool = true, allowGrace: Bool = true, requiredPacks: [String] = []) {
        self.allowOffline = allowOffline
        self.allowGrace = allowGrace
        self.requiredPacks = requiredPacks
    }
}

public struct BootState: Sendable, Equatable {
    public let stage: BootStage
    public let outcome: BootOutcome
    public let options: BootOptions
    /// The latest sync result; a timeout is `offline`.
    public let sync: Sync
    /// Where `retry` goes: `shell` before `shell.done`, `guard` before `guard.done`, then `sync`.
    public let resume: Resume

    public enum Sync: String, Sendable, Equatable, CaseIterable {
        case pending, ok, offline, error
    }
    public enum Resume: String, Sendable, Equatable, CaseIterable {
        case shell, `guard`, sync
    }

    public init(
        stage: BootStage, outcome: BootOutcome, options: BootOptions, sync: Sync, resume: Resume
    ) {
        self.stage = stage
        self.outcome = outcome
        self.options = options
        self.sync = sync
        self.resume = resume
    }
}

public struct BootTransition: Sendable, Equatable {
    public let state: BootState
    public let emits: [BootEmit]

    public init(state: BootState, emits: [BootEmit]) {
        self.state = state
        self.emits = emits
    }
}

/// Stage `idle`, outcome `running`, sync `pending`, resume `shell`.
public func initialBootState(_ options: BootOptions = BootOptions()) -> BootState {
    BootState(stage: .idle, outcome: .running, options: options, sync: .pending, resume: .shell)
}

/// The launch decision of the boot guard: roll back, apply a staged update, or neither.
public func bootGuardAction(staged: Bool, failedBoots: Int) -> BootGuardAction {
    if failedBoots >= MAX_FAILED_BOOTS { return .rollBack }
    if staged { return .applyStaged }
    return BootGuardAction.none
}

/// The reducer: the next state and the emits the event produced, `stageChanged` first. An event
/// the current stage does not accept returns the input state and no emits.
public func bootTransition(_ state: BootState, _ event: BootEvent) -> BootTransition {
    let waiting = state.stage == .gate && state.outcome == .waiting

    func go(
        _ stage: BootStage, _ outcome: BootOutcome, _ extra: BootEmit? = nil,
        sync: BootState.Sync? = nil, resume: BootState.Resume? = nil
    ) -> BootTransition {
        var emits: [BootEmit] = []
        if stage != state.stage { emits.append(.stageChanged(stage: stage, previous: state.stage)) }
        if let extra { emits.append(extra) }
        let next = BootState(
            stage: stage, outcome: outcome, options: state.options, sync: sync ?? state.sync,
            resume: resume ?? state.resume)
        return BootTransition(state: next, emits: emits)
    }
    let ignore = BootTransition(state: state, emits: [])

    /// The stop a failed sync leads to: offline after no answer, error after an unusable one.
    func syncStop(_ result: BootState.Sync, recording: Bool) -> BootTransition {
        let sync: BootState.Sync? = recording ? result : nil
        return result == .offline
            ? go(.offline, .offline, .offline(canPlayOffline: false), sync: sync)
            : go(.error, .error, .error(code: "sync-failed"), sync: sync)
    }
    func onSync(_ result: BootState.Sync) -> BootTransition {
        if result == .ok || state.options.allowOffline { return go(.gate, .running, sync: result) }
        return syncStop(result, recording: true)
    }
    /// `expired`, or `grace` the options refuse: the player can renew after an answered sync,
    /// otherwise the boot stops for the reason the sync failed.
    func gateHolds(_ status: LicenseStatus) -> BootTransition {
        if state.sync == .offline || state.sync == .error {
            return syncStop(state.sync, recording: false)
        }
        return go(.gate, .waiting, .waiting(status: status))
    }

    switch event {
    case .start:
        return state.stage == .idle ? go(.shell, .running) : ignore

    case .shellDone:
        return state.stage == .shell ? go(.guard, .running, resume: .guard) : ignore

    case .guardDone(let result):
        guard state.stage == .guard else { return ignore }
        return go(.sync, .running, result == .rolledBack ? .bootRolledBack : nil, resume: .sync)

    case .syncDone(let result):
        guard state.stage == .sync else { return ignore }
        switch result {
        case .ok: return onSync(.ok)
        case .offline: return onSync(.offline)
        case .error: return onSync(.error)
        }

    case .syncTimeout:
        return state.stage == .sync ? onSync(.offline) : ignore

    case .gateStatus(let status):
        guard state.stage == .gate else { return ignore }
        switch status {
        case .ok, .notApplicable:
            return go(.decide, .running)
        case .grace:
            return state.options.allowGrace ? go(.decide, .running) : gateHolds(status)
        case .expired:
            return gateHolds(status)
        case .needsActivation, .revoked:
            return go(.gate, .waiting, .waiting(status: status))
        case .versionTooOld:
            return go(.blocked, .blocked, .blocked(reason: .updateRequired))
        case .versionTooNew, .channelNotEntitled:
            return go(.blocked, .blocked, .blocked(reason: .notAvailable))
        }

    case .decideDone(let decision):
        guard state.stage == .decide else { return ignore }
        switch decision {
        case .none: return go(.fetch, .running)
        case .optional: return go(.fetch, .running, .updateAvailable)
        case .required: return go(.blocked, .blocked, .blocked(reason: .updateRequired))
        }

    case .fetchDone(let result, let installed):
        guard state.stage == .fetch else { return ignore }
        if state.options.requiredPacks.allSatisfy(installed.contains) {
            return go(.mount, .running)
        }
        if result == .offline { return go(.offline, .offline, .offline(canPlayOffline: false)) }
        return go(.error, .error, .error(code: "fetch-failed"))

    case .mountDone:
        return state.stage == .mount ? go(.ready, .ready, .bootReady) : ignore

    case .backgroundStart:
        return state.stage == .ready ? go(.background, .ready) : ignore

    case .backgroundDone:
        return state.stage == .background ? go(.ready, .ready) : ignore

    case .retry:
        guard waiting || [.offline, .blocked, .error].contains(state.stage) else { return ignore }
        let target: BootStage
        switch state.resume {
        case .shell: target = .shell
        case .guard: target = .guard
        case .sync: target = .sync
        }
        return go(target, .running, sync: .pending)

    case .playOffline:
        // Accepted nowhere in v1: `canPlayOffline` is never true.
        return ignore

    case .fail(let code):
        let failing: Set<BootStage> = [.shell, .guard, .sync, .gate, .decide, .fetch, .mount]
        guard failing.contains(state.stage), !waiting else { return ignore }
        return go(.error, .error, .error(code: code))
    }
}
