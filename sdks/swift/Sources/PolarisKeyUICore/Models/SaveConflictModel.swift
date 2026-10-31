// @pkey-feature ui.settings
// The SaveConflict screen's model (U-22 K.3): the same save changed on two devices, and the person
// picks the copy to keep. It holds the step and answers `KitStates.saveConflict`; the choice goes
// through `SaveConflictHost.keep`. The live form is the saves client (K.3T, after the Swift saves
// slice): `SaveConflictHost(keep:)` takes one closure, so the binding is a small tail. A model built
// without a host is model-only: a choice moves the step and calls the model's closures, and
// nothing is written.
//
// Must not (ui-matrix `saveConflict`): a save is never discarded without a choice (`choose` takes no
// default, and Retry repeats the choice the person made, never another), and a choice is applied
// once (no control is offered while it runs, and a second call while it runs is ignored).

import Foundation
import Observation

/// What the screen asks of the saves client: apply one choice. Throws when it could not be applied
/// (both copies are then as they were).
public struct SaveConflictHost: Sendable {
    public var keep: @Sendable (KitSaveConflict.Keep) async throws -> Void

    public init(keep: @escaping @Sendable (KitSaveConflict.Keep) async throws -> Void) {
        self.keep = keep
    }
}

/// A save conflict: choose, being applied, applied, or failed.
@MainActor
@Observable
public final class SaveConflictModel {
    public private(set) var inputs: KitInputs
    private let host: SaveConflictHost?
    /// Told when a choice was applied (before `kept` shows).
    public var onKept: (@MainActor (KitSaveConflict.Keep) -> Void)?
    /// Told on Cancel: the conflict stays as it was.
    public var onCancel: (@MainActor () -> Void)?
    /// Told on Choose again: the screen is back on `choose`, nothing applied.
    public var onChooseAgain: (@MainActor () -> Void)?
    /// Told on Done, after the choice was kept.
    public var onDone: (@MainActor () -> Void)?

    public init(
        conflict: KitSaveConflict, inputs: KitInputs = KitInputs(), host: SaveConflictHost? = nil
    ) {
        var inputs = inputs
        inputs.saveConflict = conflict
        self.inputs = inputs
        self.host = host
    }

    public convenience init(inputs: KitInputs, host: SaveConflictHost? = nil) {
        self.init(
            conflict: inputs.saveConflict ?? KitSaveConflict(step: .choose), inputs: inputs,
            host: host)
    }

    public var conflict: KitSaveConflict { inputs.saveConflict ?? KitSaveConflict(step: .choose) }
    public var screen: KitScreen<SaveConflictState> { KitStates.saveConflict(inputs) }
    public var step: KitSaveConflict.Step { conflict.step }
    /// The other copy was deleted: Keep the other is Delete it here too, and Keep both is gone.
    public var isDeletion: Bool { conflict.remoteDeleted }
    /// Keep both draws disabled, with its reason, when this is false.
    public var canKeepBoth: Bool { !conflict.remoteDeleted && conflict.bothAvailable == true }

    /// Whether `choice` may be made now: only on `choose`, and Keep both only with a free slot.
    public func canKeep(_ choice: KitSaveConflict.Keep) -> Bool {
        guard step == .choose else { return false }
        return choice == .both ? canKeepBoth : true
    }

    /// Make a choice. Applied once: ignored unless the screen is on `choose`.
    public func keep(_ choice: KitSaveConflict.Keep) async {
        guard canKeep(choice) else { return }
        await apply(choice)
    }

    /// Try again, after a choice failed: the same choice, never another.
    public func retry() async {
        guard step == .failed, let choice = conflict.keep else { return }
        await apply(choice)
    }

    /// Choose again, after a choice failed: back to the choices with the same versions. Nothing is
    /// applied; the host is not told.
    public func chooseAgain() {
        guard step == .failed else { return }
        inputs.saveConflict?.step = .choose
        inputs.saveConflict?.keep = nil
        onChooseAgain?()
    }

    private func apply(_ choice: KitSaveConflict.Keep) async {
        set(.keeping, keep: choice)
        do {
            try await host?.keep(choice)
            set(.kept, keep: choice)
            onKept?(choice)
        } catch {
            // Both copies are as they were; nothing about the error reaches the screen.
            set(.failed, keep: choice)
        }
    }

    private func set(_ step: KitSaveConflict.Step, keep: KitSaveConflict.Keep) {
        inputs.saveConflict?.step = step
        inputs.saveConflict?.keep = keep
    }

    public func cancel() { if step == .choose || step == .failed { onCancel?() } }
    public func done() { if step == .kept { onDone?() } }
}
