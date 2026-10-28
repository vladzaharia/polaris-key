// @pkey-feature ui.settings
// The Cloud Sync screens' models (U-42.3): UnlockSync, RecoveryCode, RingChange and the
// CloudSyncStatus row. Each holds a step and answers the state machines of
// States/CloudSyncFamily.swift; the actions go through `CloudSyncScreenHost`, whose live form is the
// client's `keyring` (`SyncKeyring`). A model built without a host is model-only: its actions
// move the step and call the model's closures, and nothing reaches a keyring.
//
// Security points (U-sync clients plan §9): the recovery code is checked before any request and is
// entered only here (S13, T23); it is shown once and held in memory only until Done, never in the
// inputs, a description, a log or an error (S7); a changed ring is accepted only with the ring the
// person was shown, never a fresh read (S5).

import Foundation
import Observation
import PolarisKey
import PolarisKeyCore

/// What the Cloud Sync screens ask of the keyring. `init(keyring:)` is the live form.
public struct CloudSyncScreenHost: Sendable {
    /// `keyring.recover(code)`: throws `recovery-code-invalid` for a bad code.
    public var recover: @Sendable (String) async throws -> Void
    /// `keyring.reset()`: a new ring and root; returns the new recovery code to show once.
    public var reset: @Sendable () async throws -> String?
    /// `keyring.acceptRingChange(confirmed:)` with the ring the person was shown.
    public var acceptRingChange: @Sendable (SyncRingPin) async throws -> SyncUnlockResult
    /// `keyring.setRecoveryCode()`: a new recovery code to show once.
    public var newRecoveryCode: @Sendable () async throws -> String

    public init(
        recover: @escaping @Sendable (String) async throws -> Void,
        reset: @escaping @Sendable () async throws -> String?,
        acceptRingChange: @escaping @Sendable (SyncRingPin) async throws -> SyncUnlockResult,
        newRecoveryCode: @escaping @Sendable () async throws -> String
    ) {
        self.recover = recover
        self.reset = reset
        self.acceptRingChange = acceptRingChange
        self.newRecoveryCode = newRecoveryCode
    }

    /// The client's keyring: `CloudSyncScreenHost(keyring: client.keyring)`.
    public init(keyring: SyncKeyring) {
        self.init(
            recover: { _ = try await keyring.recover($0) },
            reset: { try await keyring.reset(recovery: true).recoveryCode },
            acceptRingChange: { try await keyring.acceptRingChange(confirmed: $0) },
            newRecoveryCode: { try await keyring.setRecoveryCode() })
    }
}

// MARK: - UnlockSync

/// Unlock the synced data with the recovery code, or start over.
@MainActor
@Observable
public final class UnlockSyncModel: CustomStringConvertible {
    public private(set) var inputs: KitInputs
    /// The recovery code being typed or pasted. Never logged, never in `inputs`.
    public var code = ""
    private let host: CloudSyncScreenHost?
    /// Told when the root is held (the code was right).
    public var onUnlocked: (@MainActor () -> Void)?
    /// Told when Start over made a new ring: the new recovery code, to show once.
    public var onStartedOver: (@MainActor (String?) -> Void)?
    public var onCancel: (@MainActor () -> Void)?
    /// A start-over has run and made a new key: it cannot be cancelled and its screen cannot be
    /// dismissed until it ends, so the new recovery code is never lost.
    public private(set) var minting = false
    /// The red confirm answers only after this long (a double tap on Start over must not reset).
    public private(set) var startOverArmed = false
    private let armDelay: Duration
    private var armTask: Task<Void, Never>?

    public init(
        inputs: KitInputs = KitInputs(), host: CloudSyncScreenHost? = nil,
        armDelay: Duration = .milliseconds(500)
    ) {
        self.inputs = inputs
        self.host = host
        self.armDelay = armDelay
        if inputs.unlockSync == nil { self.inputs.unlockSync = KitUnlockSync(step: .code) }
        // A model that starts on the warning arms its confirm like one that moves there.
        show(self.inputs.unlockSync?.step ?? .code)
    }

    nonisolated public var description: String { "UnlockSyncModel" }

    public var screen: KitScreen<UnlockSyncState> { KitStates.unlockSync(inputs) }
    public var step: KitUnlockSync.Step { inputs.unlockSync?.step ?? .code }

    public func show(_ step: KitUnlockSync.Step) {
        inputs.unlockSync = KitUnlockSync(step: step)
        armTask?.cancel()
        startOverArmed = false
        if step == .startOver {
            armTask = Task { [armDelay] in
                try? await Task.sleep(for: armDelay)
                guard !Task.isCancelled else { return }
                self.startOverArmed = true
            }
        }
    }

    /// Unlock: the code is checked on the device (its checksum) before any request.
    public func unlock() async {
        guard step == .code || step == .invalid else { return }
        let text = code.trimmingCharacters(in: .whitespacesAndNewlines)
        // Nothing typed: nothing was checked, so no error; the view focuses the field.
        guard !text.isEmpty, let host else { return }
        show(.working)
        do {
            try await host.recover(text)
            code = ""
            // Stays on `working` until the host swaps the screen: no empty form flashes.
            onUnlocked?()
        } catch let error as PolarisError where error.code == ErrorCode.recoveryCodeInvalid {
            show(.invalid)
        } catch let error as PolarisError where error.code == ErrorCode.notFound {
            // The account holds no recovery code: trying again cannot work; Start over can.
            show(.noCode)
        } catch {
            show(.failed)
        }
    }

    /// Opens the warning. Nothing is replaced yet.
    private var cameFromNoCode = false

    public func askStartOver() {
        cameFromNoCode = step == .noCode
        if step == .code || step == .invalid || step == .noCode { show(.startOver) }
    }

    /// The field changed: an error clears on edit (DL7).
    public func codeEdited() { if step == .invalid { show(.code) } }

    /// Replaces the sync key, from the warning only (T22).
    public func confirmStartOver() async {
        guard step == .startOver, startOverArmed, !minting, let host else { return }
        show(.working)
        minting = true
        defer { minting = false }
        do {
            // An unstructured task: cancelling the caller (a dismissed view) does not cancel the
            // reset, so a new ring is never made without its code being handed on.
            let fresh = try await Task { try await host.reset() }.value
            code = ""
            onStartedOver?(fresh)
        } catch {
            show(.startOverFailed)
        }
    }

    /// Try again, from a failure: back to the code step.
    /// A failed Start over runs again (the person already confirmed it); an unlock goes back to the
    /// code step.
    public func retry() async {
        if step == .startOverFailed {
            show(.startOver)
            startOverArmed = true
            await confirmStartOver()
        } else if step == .failed {
            show(.code)
        }
    }

    /// Cancel leaves the warning for the code step, and leaves the screen from anywhere else.
    public func cancel() {
        guard !minting else { return }
        if step == .startOver {
            // Back to where the warning was opened from.
            show(cameFromNoCode ? .noCode : .code)
        } else {
            code = ""
            onCancel?()
        }
    }
}

// MARK: - RecoveryCode

/// The new recovery code, shown once. Done waits for the person to confirm they saved it.
@MainActor
@Observable
public final class RecoveryCodeModel: CustomStringConvertible {
    public private(set) var inputs: KitInputs
    /// The code to draw, held in memory until Done or `clear()`. Not part of `inputs`.
    public private(set) var code: String?
    /// A new code is being made: `clear()` is ignored until it is held.
    public private(set) var generating = false
    private let host: CloudSyncScreenHost?
    public var onDone: (@MainActor () -> Void)?

    public init(inputs: KitInputs = KitInputs(), host: CloudSyncScreenHost? = nil) {
        self.inputs = inputs
        self.host = host
        if inputs.recoveryCode == nil { self.inputs.recoveryCode = KitRecoveryCode() }
    }

    nonisolated public var description: String { "RecoveryCodeModel" }

    /// Hidden while there is no code to show: a screen with nothing to save is never drawn.
    public var screen: KitScreen<RecoveryCodeState> {
        code == nil ? .hidden : KitStates.recoveryCode(inputs)
    }
    public var saved: Bool { inputs.recoveryCode?.saved == true }

    /// Shows `code`, from `keyring.create()` or `reset()`; the person has not saved it yet.
    public func show(code: String) {
        self.code = code
        inputs.recoveryCode = KitRecoveryCode(saved: false)
    }

    /// Makes a new code (`keyring.setRecoveryCode()`); the previous one stops working.
    public func generate() async throws {
        guard let host, !generating else { return }
        generating = true
        defer { generating = false }
        // Not cancellable: the previous code stops working once this succeeds, so the new one
        // must reach the screen.
        show(code: try await Task { try await host.newRecoveryCode() }.value)
    }

    /// The person confirms they saved it; only then does Done show.
    public func setSaved(_ saved: Bool) { inputs.recoveryCode = KitRecoveryCode(saved: saved) }

    /// Done: the code leaves memory, the host moves on.
    public func done() {
        guard saved else { return }
        clear()
        onDone?()
    }

    public func clear() {
        guard !generating else { return }
        code = nil
        inputs.recoveryCode = KitRecoveryCode(saved: false)
    }
}

// MARK: - RingChange

/// Confirm a changed ring. Accept hands the host the ring the person was shown (`served`).
@MainActor
@Observable
public final class RingChangeModel: CustomStringConvertible {
    public private(set) var inputs: KitInputs
    public private(set) var busy = false
    private let host: CloudSyncScreenHost?
    /// Told when the ring was accepted and the root is held.
    public var onAccepted: (@MainActor () -> Void)?
    /// Told when accepting did not open a root (no wrap, or the request failed).
    public var onFailed: (@MainActor () -> Void)?
    /// Told when the recovery code is chosen: the host shows UnlockSync.
    public var onUseRecoveryCode: (@MainActor () -> Void)?
    public var onCancel: (@MainActor () -> Void)?

    public init(by: String? = nil, served: SyncRingPin? = nil, host: CloudSyncScreenHost? = nil) {
        var inputs = KitInputs()
        inputs.ringChange = KitRingChange(by: by, served: served.map(Self.ring))
        self.inputs = inputs
        self.host = host
    }

    public init(inputs: KitInputs, host: CloudSyncScreenHost? = nil) {
        self.inputs = inputs
        self.host = host
    }

    nonisolated public var description: String { "RingChangeModel" }

    public var screen: KitScreen<RingChangeState> { KitStates.ringChange(inputs) }

    private static func ring(_ pin: SyncRingPin) -> KitRingChange.Ring {
        KitRingChange.Ring(ringId: pin.ringId, epoch: pin.epoch, rootKid: pin.rootKid)
    }

    /// Accepts the ring that was shown, never a fresh read (S5). If the Worker now serves another
    /// ring the answer is `ringChanged` again: the screen shows that one and asks again.
    public func accept() async {
        guard !busy, let served = inputs.ringChange?.served, let host else { return }
        busy = true
        defer { busy = false }
        inputs.ringChange?.failed = nil
        let pin = SyncRingPin(ringId: served.ringId, epoch: served.epoch, rootKid: served.rootKid)
        do {
            switch try await host.acceptRingChange(pin) {
            case .unlocked: onAccepted?()
            case .ringChanged(_, let now, _, let by):
                inputs.ringChange = KitRingChange(by: by, served: Self.ring(now))
            case .locked:
                inputs.ringChange?.failed = true
                onFailed?()
            }
        } catch {
            inputs.ringChange?.failed = true
            onFailed?()
        }
    }

    public func useRecoveryCode() { onUseRecoveryCode?() }
    public func cancel() { onCancel?() }
}

// MARK: - CloudSyncStatus

/// The status row. Its Unlock and Review open UnlockSync and RingChange; the settings host (U-07)
/// supplies them. The kit draws only `locked` and `ring-changed` here; the other states are the
/// settings host's.
@MainActor
@Observable
public final class CloudSyncStatusModel {
    public private(set) var inputs: KitInputs
    /// Opens UnlockSync. Required: a locked row always has a way forward.
    public let onUnlock: @MainActor () -> Void
    /// Opens RingChange. Required for the same reason.
    public let onReview: @MainActor () -> Void
    /// Sign in to sync, for the signed-out error row. nil draws no button.
    public let onSignIn: (@MainActor () -> Void)?

    public init(
        _ state: KitCloudSync.State = .locked, onUnlock: @escaping @MainActor () -> Void,
        onReview: @escaping @MainActor () -> Void, onSignIn: (@MainActor () -> Void)? = nil
    ) {
        var inputs = KitInputs()
        inputs.cloudSync = KitCloudSync(state: state)
        self.inputs = inputs
        self.onUnlock = onUnlock
        self.onReview = onReview
        self.onSignIn = onSignIn
    }

    public init(
        inputs: KitInputs, onUnlock: @escaping @MainActor () -> Void,
        onReview: @escaping @MainActor () -> Void, onSignIn: (@MainActor () -> Void)? = nil
    ) {
        self.inputs = inputs
        self.onUnlock = onUnlock
        self.onReview = onReview
        self.onSignIn = onSignIn
    }

    public var screen: KitScreen<CloudSyncStatusState> { KitStates.cloudSyncStatus(inputs) }

    public func show(_ state: KitCloudSync.State) {
        inputs.cloudSync = KitCloudSync(state: state)
    }
}
