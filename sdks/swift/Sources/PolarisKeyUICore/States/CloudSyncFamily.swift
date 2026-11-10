// @pkey-feature ui.settings
// The cloudSync family of ui-matrix.json: CloudSyncStatus and the three Cloud Sync screens,
// UnlockSync, RecoveryCode and RingChange (U-42; the reference is packages/ui-core/src/models/
// cloudSync.ts). Security points the rows pin (U-sync clients plan §9, S5, S13, T22, T23):
//   - the recovery code is entered only in the app, and both screens say no one will ask for it;
//   - the code is never an input or a copy argument: the kit draws it from the host, once;
//   - Start over warns that synced data will be lost before it runs;
//   - nearby unlock is never offered in v0.10.0 (NearbyApproval does not ship);
//   - a changed ring is confirmed on its own screen: `ring-changed` never offers Unlock, Accept
//     hands the host the ring the person was shown (`ringChange.served`), and without one there
//     is nothing to accept, only the recovery code.

import Foundation

public enum CloudSyncStatusState: String, KitStateID {
    case synced, syncing, offline, conflict, error, locked
    case ringChanged = "ring-changed"
    /// A save transfer is running. Never reads as synced, whatever the last sync time was.
    case transferring, waiting
    case transferFailed = "transfer-failed"
    public static let component = KitComponent.cloudSyncStatus
}

public enum UnlockSyncState: String, KitStateID {
    case code, invalid, working, failed
    case startOverFailed = "start-over-failed"
    case noCode = "no-code"
    case startOver = "start-over"
    public static let component = KitComponent.unlockSync
}

public enum RecoveryCodeState: String, KitStateID {
    case show, saved
    public static let component = KitComponent.recoveryCode
}

public enum RingChangeState: String, KitStateID {
    case confirm, failed
    public static let component = KitComponent.ringChange
}

extension KitStates {
    /// A small Cloud Sync status. It never implies universal backup.
    public static func cloudSyncStatus(_ i: KitInputs) -> KitScreen<CloudSyncStatusState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.sync), let sync = i.cloudSync else { return .hidden }
        switch sync.state {
        case .locked:
            // A locked device holds no key: it says so and offers Unlock sync, never a sync time.
            return KitScreen(.locked, [c.line("cloudSync.locked"), c.line("cloudSync.unlock")])
        case .ringChanged:
            // A changed ring is confirmed first (S5). The kit owns that screen, so Review shows.
            return KitScreen(
                .ringChanged, [c.line("cloudSync.ringChanged"), c.line("common.review")])
        case .transferring:
            // A pending transfer is never reported as synced, whatever `lastSynced` holds.
            let known = sync.transfer?.size != nil && sync.transfer?.total != nil
            var lines = [c.line("cloudSync.transferring")]
            if known, let t = sync.transfer, let size = t.size, let total = t.total {
                lines.append(
                    c.line("cloudSync.transferProgress", ["size": .text(size), "total": .text(total)]))
            }
            return KitScreen(.transferring, lines)
        case .waiting:
            let key: String
            switch sync.reason ?? .network {
            case .network: key = "cloudSync.waitingNetwork"
            case .battery: key = "cloudSync.waitingBattery"
            case .background: key = "cloudSync.waitingBackground"
            }
            return KitScreen(.waiting, [c.line(key)])
        case .transferFailed:
            // Try again repeats the transfer; the status never reads as an error of the account.
            return KitScreen(
                .transferFailed, [c.line("cloudSync.transferFailed"), c.line("common.tryAgain")])
        default:
            let state = CloudSyncStatusState(rawValue: sync.state.rawValue) ?? .error
            let signedOut = sync.state == .error && sync.signedIn == false
            let review = sync.state == .conflict && sync.canReview == true
            let args: [String: CopyArgument] = sync.lastSynced.map { ["time": .text($0)] } ?? [:]
            if signedOut {
                // Not a fault: it says so and offers Sign in to sync.
                return KitScreen(state, [c.line("cloudSync.syncStopped"), c.line("cloudSync.signIn")])
            }
            var lines = [c.line("cloudSync.\(sync.state.rawValue)", args)]
            if review { lines.append(c.line("common.review")) }
            return KitScreen(state, lines)
        }
    }

    /// Unlock the synced data with the recovery code, or start over.
    public static func unlockSync(_ i: KitInputs) -> KitScreen<UnlockSyncState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.sync), let u = i.unlockSync else { return .hidden }
        // `u.nearby` is read by no branch: v0.10.0 never offers a nearby unlock.
        switch u.step {
        case .working:
            return KitScreen(.working, [c.line("unlockSync.title"), c.line("common.working")])
        case .failed:
            return KitScreen(
                .failed,
                [
                    c.line("unlockSync.title"), c.line("unlockSync.failed"),
                    c.line("common.tryAgain"), c.line("common.cancel"),
                ])
        case .startOverFailed:
            return KitScreen(
                .startOverFailed,
                [
                    c.line("unlockSync.title"), c.line("unlockSync.startOverFailed"),
                    c.line("common.tryAgain"), c.line("common.cancel"),
                ])
        case .noCode:
            // The account holds no recovery code: nothing to enter, so Start over is the way on.
            return KitScreen(
                .noCode,
                [
                    c.line("unlockSync.title"), c.line("unlockSync.noCode"),
                    c.line("unlockSync.startOver"), c.line("common.cancel"),
                ])
        case .startOver:
            // The warning comes first: the sync key is replaced only from this step (T22).
            return KitScreen(
                .startOver,
                [
                    c.line("unlockSync.startOverTitle"), c.line("unlockSync.startOverWarning"),
                    c.line("unlockSync.startOverConfirm"), c.line("common.cancel"),
                ])
        case .code, .invalid:
            var lines = [
                c.line("unlockSync.title"), c.line("unlockSync.lede"), c.line("unlockSync.field"),
            ]
            if u.step == .invalid { lines.append(c.line("unlockSync.invalid")) }
            lines += [
                c.line("recoveryCode.noAsk"), c.line("unlockSync.unlock"),
                c.line("unlockSync.startOver"), c.line("common.cancel"),
            ]
            return KitScreen(u.step == .invalid ? .invalid : .code, lines)
        }
    }

    /// The new recovery code, shown once. Done waits for the person to confirm they saved it.
    public static func recoveryCode(_ i: KitInputs) -> KitScreen<RecoveryCodeState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.sync), let r = i.recoveryCode else { return .hidden }
        let saved = r.saved == true
        var lines = [
            c.line("recoveryCode.title"), c.line("recoveryCode.lede"), c.line("recoveryCode.noAsk"),
            c.line("recoveryCode.copy"), c.line("recoveryCode.saved"),
        ]
        if saved { lines.append(c.line("common.done")) }
        return KitScreen(saved ? .saved : .show, lines)
    }

    /// Confirm a changed ring: it names the device (`by`) and offers to accept the ring that was
    /// shown (`served`). The recovery code is the primary, safer way in.
    public static func ringChange(_ i: KitInputs) -> KitScreen<RingChangeState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.sync), let r = i.ringChange else { return .hidden }
        let by = r.by?.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = by?.isEmpty == false ? by : nil
        let failed = r.failed == true
        var lines = [
            c.line("ringChange.title"),
            named != nil
                ? c.line("ringChange.body", ["device": .text(named!)]) : c.line("ringChange.bodyUnknown"),
            // Nothing served: no Accept, only the recovery code.
            c.line(r.served != nil ? "ringChange.warning" : "ringChange.warningNoServed"),
        ]
        if failed { lines.append(c.line("ringChange.failed")) }
        if r.served != nil { lines.append(c.line("ringChange.accept")) }
        lines += [c.line("ringChange.useCode"), c.line("common.cancel")]
        return KitScreen(failed ? .failed : .confirm, lines)
    }
}

// MARK: - SaveConflict

public enum SaveConflictState: String, KitStateID {
    case choose, keeping, kept, failed
    public static let component = KitComponent.saveConflict
}

extension KitStates {
    /// The same save changed on two devices: the person picks one, the kit never settles it for
    /// them (reference: packages/ui-core/src/models/saveConflict.ts).
    ///   - `choose` takes no default: no filled control, and nothing focused but the heading;
    ///   - Keep both needs a free slot and a copy to keep: without either it is drawn disabled,
    ///     with its reason (`KitSaveConflictScreen.disabledActions`), and not offered as an action;
    ///   - a deleted other copy has its own title and lede, `Delete it here too` replaces Keep the
    ///     other, and Keep both goes;
    ///   - Newer tags the version the app names and chooses nothing; never with one version;
    ///   - while a choice runs no control is offered (busy), `kept` titles the choice made, and
    ///     `failed` offers Try again, Choose again and Cancel with none filled.
    public static func saveConflict(_ i: KitInputs) -> KitScreen<SaveConflictState> {
        let c = Ctx(i)
        guard i.closedServices.contains(.sync), let s = i.saveConflict else { return .hidden }
        let gone = s.remoteDeleted
        // Only one save exists after a deletion elsewhere, so the title stays the deleted one.
        let situation = c.line(gone ? "saveConflict.deletedTitle" : "saveConflict.title")
        switch s.step {
        case .keeping:
            return KitScreen(
                .keeping, [situation, c.line("saveConflict.keeping"), c.line("a11y.busy")])
        case .kept:
            // The title is the result. Deleted with `both` reads as local.
            let title: String
            switch gone && s.keep == .remote ? "deleted" : (gone ? "local" : (s.keep?.rawValue ?? "local")) {
            case "remote": title = "saveConflict.keptRemoteTitle"
            case "both": title = "saveConflict.keptBothTitle"
            case "deleted": title = "saveConflict.keptDeletedTitle"
            default: title = "saveConflict.keptLocalTitle"
            }
            var lines = [c.line(title)]
            if !gone && s.keep == .both { lines.append(c.line("saveConflict.keptCopy")) }
            lines.append(c.line("common.done"))
            return KitScreen(.kept, lines)
        case .failed:
            // Nothing is filled: Try again repeats the choice, Choose again returns to the
            // versions, Cancel leaves. The heading takes focus.
            return KitScreen(
                .failed,
                [
                    situation, c.line(gone ? "saveConflict.failedDeleted" : "saveConflict.failed"),
                    c.line("common.tryAgain"), c.line("saveConflict.chooseAgain"),
                    c.line("common.cancel"),
                ])
        case .choose:
            let both = !gone && s.bothAvailable == true
            var lines = [
                c.line(gone ? "saveConflict.deletedTitle" : "saveConflict.title"),
                c.line(gone ? "saveConflict.deletedLede" : "saveConflict.lede"),
            ]
            // A choice met a newer copy: nothing was applied, and these are the new versions.
            if s.reopened == true { lines.append(c.line("saveConflict.reopened")) }
            lines.append(c.line("saveConflict.thisDevice"))
            if let when = s.local?.when {
                lines.append(c.line("saveConflict.savedThis", ["when": .text(when)]))
            }
            if !gone && s.newer == .local { lines.append(c.line("saveConflict.newerThis")) }
            if gone {
                lines.append(c.line("saveConflict.deletedElsewhere"))
            } else if let device = s.remote?.device {
                lines.append(c.line("saveConflict.otherDevice", ["device": .text(device)]))
            } else {
                lines.append(c.line("saveConflict.otherUnknown"))
            }
            if !gone, let when = s.remote?.when {
                lines.append(c.line("saveConflict.savedOther", ["when": .text(when)]))
            }
            if !gone && s.newer == .remote { lines.append(c.line("saveConflict.newerOther")) }
            lines.append(c.line("saveConflict.keepThis"))
            lines.append(c.line(gone ? "saveConflict.acceptDelete" : "saveConflict.keepOther"))
            if !gone { lines.append(c.line("saveConflict.keepBoth")) }
            if !gone && !both { lines.append(c.line("saveConflict.bothFull")) }
            lines.append(c.line("common.cancel"))
            // The disabled Keep both is on screen but takes no action.
            return KitScreen(.choose, lines, withheld: both ? [] : [.keepBoth])
        }
    }
}
