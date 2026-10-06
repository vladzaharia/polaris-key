// The app build's boot guard (notes/SDK-PARITY-PASS.md §3.15, `update.bootguard`).
//
//   markBootAttempt()  at startup: a launch of the same build that never confirmed counts as a
//                      failed boot; `bootGuardAction` (stage-matrix.json) decides from the count.
//   confirmBoot()      once the app is healthy (the boot shell does it `BOOT_OK_SECONDS` after
//                      `ready`): resets the count, and the first confirmed launch of a new build
//                      journals P6-03's `update_confirmed`.
//
// An Apple app has no previous build on disk to roll back to (Sparkle and the App Store replace
// the bundle), so after `MAX_FAILED_BOOTS` unconfirmed launches the guard cannot roll back: it
// journals `boot_rolled_back` with code `no-previous` once, so auto-halt sees the failing build,
// and answers the typed outcome `rollBackUnavailable`. (Packs roll back through the pack facet.)
//
// The record lives beside the credential (`Store.readRecord("boot-guard")`).

import Foundation

/// What `markBootAttempt()` decided.
public struct BootGuardOutcome: Sendable, Equatable {
    /// `bootGuardAction(staged: false, failedBoots:)`.
    public let action: BootGuardAction
    /// Unconfirmed launches of this build before this one.
    public let failedBoots: Int
    /// True when the action was `roll-back` and there is nothing to roll back to.
    public let rollBackUnavailable: Bool

    /// The event the boot stage machine's `guard` stage reports.
    public var guardResult: BootEvent.GuardResult { .ok }
}

struct BootGuardRecord: Codable, Equatable {
    var version: String
    var failedBoots: Int
    var pending: Bool
    var lastConfirmedVersion: String?
    var reportedRollback: Bool
}

public final class AppBootGuard: Sendable {
    public static let recordName = "boot-guard"
    private let core: CoreContext

    public init(core: CoreContext) { self.core = core }

    private func load() async -> BootGuardRecord? {
        guard let data = await core.store.readRecord(Self.recordName) else { return nil }
        return try? JSONDecoder().decode(BootGuardRecord.self, from: data)
    }

    private func save(_ r: BootGuardRecord) async {
        await core.store.writeRecord(Self.recordName, try? JSONEncoder().encode(r))
    }

    /// Count this launch. Call once, as early as possible.
    @discardableResult
    public func markBootAttempt() async -> BootGuardOutcome {
        var r =
            await load()
            ?? BootGuardRecord(
                version: core.version, failedBoots: 0, pending: false, lastConfirmedVersion: nil,
                reportedRollback: false)
        if r.version != core.version {
            r = BootGuardRecord(
                version: core.version, failedBoots: 0, pending: false,
                lastConfirmedVersion: r.lastConfirmedVersion ?? r.version, reportedRollback: false)
        } else if r.pending {
            r.failedBoots += 1
        }
        r.pending = true
        let action = bootGuardAction(staged: false, failedBoots: r.failedBoots)
        let unavailable = action == .rollBack
        if unavailable && !r.reportedRollback {
            await core.journal.record(
                UpdateEvent.bootRolledBack, release: core.version,
                fromRelease: r.lastConfirmedVersion, channel: core.channel, code: "no-previous")
            r.reportedRollback = true
        }
        await save(r)
        return BootGuardOutcome(
            action: action, failedBoots: r.failedBoots, rollBackUnavailable: unavailable)
    }

    /// This launch is healthy.
    public func confirmBoot() async {
        var r =
            await load()
            ?? BootGuardRecord(
                version: core.version, failedBoots: 0, pending: true, lastConfirmedVersion: nil,
                reportedRollback: false)
        let previous = r.lastConfirmedVersion
        if r.version == core.version, previous != nil, previous != core.version {
            await core.journal.record(
                UpdateEvent.updateConfirmed, release: core.version, fromRelease: previous,
                channel: core.channel)
        }
        r.version = core.version
        r.failedBoots = 0
        r.pending = false
        r.reportedRollback = false
        r.lastConfirmedVersion = core.version
        await save(r)
    }

    /// Unconfirmed launches of this build so far.
    public func failedBoots() async -> Int { await load()?.failedBoots ?? 0 }
}
