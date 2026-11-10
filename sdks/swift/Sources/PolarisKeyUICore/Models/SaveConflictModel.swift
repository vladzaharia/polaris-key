// @pkey-feature ui.settings
// The SaveConflict screen's model (U-22 K.3): the same save changed on two devices, and the person
// picks the copy to keep. It holds the step and answers `KitStates.saveConflict`; the choice goes
// through `SaveConflictHost.keep`. The live form is a `MergeRequest` (U-08.K3): `SaveConflictHost(request:)`
// answers it with `request.keep`, `KitSaveConflict(request:)` reads both copies from it (when, device, whether
// Keep both is free, which is newer), and `SaveConflictModel(request:)` joins the two. The app no longer
// re-supplies the save's bytes: the request holds them. A model built without a host is model-only: a choice
// moves the step and calls the model's closures, and nothing is written.
//
// Must not (ui-matrix `saveConflict`): a save is never discarded without a choice (`choose` takes no
// default, and Retry repeats the choice the person made, never another), and a choice is applied
// once (no control is offered while it runs, and a second call while it runs is ignored).

import Foundation
import Observation
import PolarisKey
import PolarisKeyCore

/// What the screen asks of the saves client: apply one choice. Throws when it could not be applied
/// (both copies are then as they were).
public struct SaveConflictHost: Sendable {
    public var keep: @Sendable (KitSaveConflict.Keep) async throws -> Void

    public init(keep: @escaping @Sendable (KitSaveConflict.Keep) async throws -> Void) {
        self.keep = keep
    }
}

/// A choice a request refused or could not apply: its code (`conflict`, `sync-merge-closed`, a failure code).
/// The screen shows no text from it.
public struct SaveConflictKeepError: Error, Equatable, Sendable {
    public let code: String
    /// The request is open again (`conflict`: the other copy changed while the keep ran; `slots-full`).
    public let reopened: Bool

    public init(code: String, reopened: Bool = false) {
        self.code = code
        self.reopened = reopened
    }
}

extension SaveConflictHost {
    /// Answer a request with `request.keep`. A keep that did not apply throws, so the screen shows `failed`
    /// with both copies as they were (the request is open again, or closed) and Retry repeats the same choice.
    public init(request: MergeRequest) {
        self.init(keep: { choice in
            let keep: MergeKeep
            switch choice {
            case .local: keep = .local
            case .remote: keep = .remote
            case .both: keep = .both
            }
            if case .failed(let code, let reopened) = await request.keep(keep) {
                throw SaveConflictKeepError(code: code, reopened: reopened)
            }
        })
    }
}

extension KitSaveConflict {
    /// How a copy reads by default: `worded(savedAt:)` for the time, and the device the save names. nil
    /// when the copy carries neither.
    public static func copy(of side: MergeSide) -> Copy {
        Copy(when: side.savedAt.flatMap { worded(savedAt: $0) }, device: side.device)
    }

    /// A moment worded for "Saved {when}", by the platform's formatters: a relative day and the short time
    /// ("today, 10:42", "yesterday, 21:40"), else the short date with no year inside the current year
    /// ("Oct 30, 10:12"), and the year only for another year. Lower case inside the sentence.
    /// `savedAt` is epoch milliseconds; `now`, `locale` and `calendar` are for tests.
    public static func worded(
        savedAt: Int, now: Date = Date(), locale: Locale = .current, calendar: Calendar = .current
    ) -> String {
        let date = Date(timeIntervalSince1970: Double(savedAt) / 1000)
        let f = DateFormatter()
        f.locale = locale
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        if calendar.isDate(date, inSameDayAs: now)
            || calendar.isDate(
                date, inSameDayAs: calendar.date(byAdding: .day, value: -1, to: now) ?? now)
        {
            f.dateStyle = .short
            f.timeStyle = .short
            f.doesRelativeDateFormatting = true
            let relative = f.string(from: date)
            // "Today, 10:42" reads mid-sentence in lower case; only the day word changes.
            return relative.prefix(1).lowercased(with: locale) + relative.dropFirst()
        }
        let sameYear = calendar.isDate(date, equalTo: now, toGranularity: .year)
        f.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd jm" : "yMMMd jm")
        return f.string(from: date)
    }

    /// The `choose` step for an open request: both copies, whether the other was deleted, whether Keep both is
    /// free, and which copy is newer. `describe` overrides how a side reads (the app's own words for `when`).
    /// `reopened` adds the line saying the other copy changed again.
    public init(request: MergeRequest, describe: ((MergeSide) -> Copy)? = nil, reopened: Bool = false) {
        let read = describe ?? Self.copy(of:)
        let remote = request.remote
        self.init(
            step: .choose, local: request.local.map(read), remote: remote.map(read), remoteDeleted: remote == nil,
            bothAvailable: request.choices.contains(.both),
            newer: request.newer.map { $0 == .local ? Keep.local : Keep.remote },
            reopened: reopened ? true : nil)
    }
}

/// A save conflict: choose, being applied, applied, or failed. The form built from inputs and a host (no
/// request) is for previews and tests: a keep that meets a newer copy ends it, as a closed request does.
@MainActor
@Observable
public final class SaveConflictModel {
    public private(set) var inputs: KitInputs
    private let host: SaveConflictHost?
    /// The live request, when the model was built from one: its sides are read again whenever the screen
    /// goes back to the choices, so the cards never show what the request has moved past.
    private let request: MergeRequest?
    private let describe: ((MergeSide) -> KitSaveConflict.Copy)?
    /// A model with no request met a reopened conflict: the copies it was built with are stale and it has no
    /// request to read again, so it answers nothing more (no choice, no Try again). `onClosed` was told.
    private var closed = false
    /// Told when the request ended meanwhile (an exact write superseded it): there is nothing left to choose.
    public var onClosed: (@MainActor () -> Void)?
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
        self.request = nil
        self.describe = nil
    }

    private init(
        bound request: MergeRequest, inputs: KitInputs, describe: ((MergeSide) -> KitSaveConflict.Copy)?
    ) {
        var inputs = inputs
        inputs.saveConflict = KitSaveConflict(request: request, describe: describe)
        self.inputs = inputs
        self.host = SaveConflictHost(request: request)
        self.request = request
        self.describe = describe
    }

    /// The live form: the screen for an open request, answered with `request.keep`.
    public convenience init(
        request: MergeRequest, inputs: KitInputs = KitInputs(), describe: ((MergeSide) -> KitSaveConflict.Copy)? = nil
    ) {
        self.init(bound: request, inputs: inputs, describe: describe)
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
        guard step == .choose, !closed else { return false }
        return choice == .both ? canKeepBoth : true
    }

    /// Make a choice. Applied once: ignored unless the screen is on `choose`.
    public func keep(_ choice: KitSaveConflict.Keep) async {
        guard canKeep(choice) else { return }
        await apply(choice)
    }

    /// Try again, after a choice failed: the same choice, never another.
    public func retry() async {
        guard step == .failed, !closed, let choice = conflict.keep else { return }
        await apply(choice)
    }

    /// Choose again, after a choice failed: back to the choices with the same versions. Nothing is
    /// applied; the host is not told.
    public func chooseAgain() {
        guard step == .failed, !closed else { return }
        if !reread(reopened: false) {
            inputs.saveConflict?.step = .choose
            inputs.saveConflict?.keep = nil
        }
        onChooseAgain?()
    }

    private func apply(_ choice: KitSaveConflict.Keep) async {
        set(.keeping, keep: choice)
        do {
            try await host?.keep(choice)
            set(.kept, keep: choice)
            onKept?(choice)
        } catch let e as SaveConflictKeepError {
            if e.code == "sync-merge-closed" {
                // The request ended meanwhile: nothing is left to choose, and Try again could never succeed.
                (onClosed ?? onCancel)?()
            } else if e.reopened && (e.code == "conflict" || e.code == "slots-full")
                && reread(reopened: e.code == "conflict")
            {
                // The other copy moved (or Keep both lost its slot) while the keep ran: nothing was applied.
                // Back to the choices on the request's current sides, which say so.
            } else if e.reopened && e.code == "conflict" && request == nil {
                // No request to read again: the cards are stale, and a keep would run on the new copy unseen.
                // Treated as closed for this form; nothing more is sent.
                closed = true
                set(.failed, keep: choice)
                (onClosed ?? onCancel)?()
            } else {
                set(.failed, keep: choice)
            }
        } catch {
            // Both copies are as they were; nothing about the error reaches the screen.
            set(.failed, keep: choice)
        }
    }

    /// Back to the choices, read again from the live request. False when the model has no request.
    private func reread(reopened: Bool) -> Bool {
        guard let request else { return false }
        inputs.saveConflict = KitSaveConflict(request: request, describe: describe, reopened: reopened)
        return true
    }

    private func set(_ step: KitSaveConflict.Step, keep: KitSaveConflict.Keep) {
        inputs.saveConflict?.step = step
        inputs.saveConflict?.keep = keep
    }

    public func cancel() { if step == .choose || step == .failed { onCancel?() } }
    public func done() { if step == .kept { onDone?() } }
}
