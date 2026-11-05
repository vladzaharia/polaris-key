// The Cloud Sync machine, MergeRequest half (U-08.6; plans/U-08.md section 2.3). A port of client-core's
// `conflicts`, `keep` and `cloudEmpty` and of the open and close of a request: `revision` is the only policy
// that asks, and a request holds the device's copy unsent until `keep`. Requests are journalled in the
// subject's partition (`SyncPartition.conflicts`); the saves layer's requests are not (S5) and live in the
// host's registry, not here.
//
// A value held in a request is read as data and never logged or put in an error (H-11).

import Foundation

extension CloudSyncMachine {
    /// `w:<collection>/<record>` (plans/U-08.md section 2.2).
    func conflictId(_ collection: String, _ record: String) -> String { "w:\(collection)/\(record)" }

    func splitRecordKey(_ rk: String) -> (collection: String, record: String) {
        guard let i = rk.firstIndex(of: "/") else { return (rk, "") }
        return (String(rk[..<i]), String(rk[rk.index(after: i)...]))
    }

    /// The open requests' record keys of the signed-in subject, in id order.
    func subjectConflicts() -> [String] {
        guard s.subject != nil else { return [] }
        return syncSortedKeys(s.partitions[activeName]!.conflicts.keys)
    }

    /// Open (or, when a keep's own set conflicted, reopen) the request of a `revision` record: the held edit,
    /// else the mutation's, is the device's copy; nothing is enqueued (rule 1).
    func openConflict(_ name: String, _ rk: String, _ collection: String, _ record: String, _ op: SyncOp) {
        let held = s.partitions[name]!.held[rk]
        s.partitions[name]!.held.removeValue(forKey: rk)
        if var existing = s.partitions[name]!.conflicts[rk] {
            existing.keep = nil
            existing.error = nil
            if let held { existing.local = held }
            s.partitions[name]!.conflicts[rk] = existing
        } else {
            s.partitions[name]!.conflicts[rk] = SyncConflictRec(
                local: held ?? op.value ?? .null, localVersion: op.baseVersion)
        }
        events.append(.conflict(id: conflictId(collection, record), collection: collection, record: record))
    }

    func closeConflict(_ name: String, _ rk: String, _ how: SyncMergeHow) {
        guard s.partitions[name]?.conflicts[rk] != nil else { return }
        s.partitions[name]!.conflicts.removeValue(forKey: rk)
        let (collection, record) = splitRecordKey(rk)
        events.append(.conflictClosed(id: conflictId(collection, record), how: how))
    }

    /// The open MergeRequests of the signed-in subject (record collections), in id order.
    public func conflicts() -> [SyncMachineConflict] {
        guard s.subject != nil else { return [] }
        let p = s.partitions[activeName]!
        return subjectConflicts().map { rk in
            let c = p.conflicts[rk]!
            let (collection, record) = splitRecordKey(rk)
            var remote: SyncMergeSide?
            if let row = p.records[rk], !rowUnreadable(row) {
                remote = SyncMergeSide(value: row.value, version: row.version)
            }
            return SyncMachineConflict(
                id: conflictId(collection, record), collection: collection, record: record,
                local: SyncMergeSide(value: c.local, version: c.localVersion), remote: remote,
                choices: [.local, .remote, .value], state: c.keep != nil ? .applying : .open, error: c.error)
        }
    }

    /// Answer an open request (rule 6). `local` and `value` send one `set` on the remote version (`"*"` when
    /// it is gone); `remote` sends nothing and reads the server copy. The request is `applying` until the set
    /// is answered. A refusal journals nothing: `sync-merge-closed` for a request that is not open,
    /// `bad_request` for a choice it does not offer or one that is already applying.
    public func keep(_ id: String, _ choice: SyncMergeKeep) -> CallResult {
        guard s.subject != nil else { return .failed(ErrorCode.syncMergeClosed) }
        let name = activeName
        guard
            let rk = subjectConflicts().first(where: { k in
                let (c, r) = splitRecordKey(k)
                return conflictId(c, r) == id
            })
        else { return .failed(ErrorCode.syncMergeClosed) }
        let c = s.partitions[name]!.conflicts[rk]!
        if c.keep != nil { return .failed("bad_request") }
        let how: SyncMergeHow
        switch choice {
        case .local: how = .local
        case .remote: how = .remote
        case .value(let v):
            if jsonBytes(v) > SYNC_MAX_VALUE_BYTES { return .failed("bad_request") }
            how = .value
        case .both: return .failed("bad_request")
        }
        let (collection, record) = splitRecordKey(rk)
        if how == .remote {
            closeConflict(name, rk, .remote)
            noteRecordChanges(.merge)
            kick()
            return .ok
        }
        let row = s.partitions[name]!.records[rk]
        let base: Int? = row.flatMap { rowUnreadable($0) ? nil : $0.version }
        var value = c.local
        if case .value(let v) = choice { value = v }
        var op = SyncOp(mutationId: 0, target: .record(collection, record), op: .set, value: value)
        if let base { op.baseVersion = base } else { op.baseAny = true }
        let queued = enqueue(name, op)
        s.partitions[name]!.conflicts[rk]!.error = nil
        s.partitions[name]!.conflicts[rk]!.keep = SyncConflictRec.Keep(choice: how, mutationId: queued.mutationId)
        noteRecordChanges(.merge)
        kick()
        return .ok
    }

    /// Whether the cloud was empty at the subject's first cursor-0 answer: `true` after one that said so,
    /// `false` after one that did not or after any change, `nil` before any (rule 8).
    public func cloudEmpty() -> Bool? {
        guard s.subject != nil else { return nil }
        return s.partitions[activeName]!.empty
    }
}
