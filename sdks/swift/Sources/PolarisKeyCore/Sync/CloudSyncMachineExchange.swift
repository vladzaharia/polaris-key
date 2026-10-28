// The Cloud Sync machine, exchange half (U-07.3): `receive` and everything a server answer drives.
// A port of Python `machine.py` (`receive`, `_ok`, `_result`, `_first_contact`, `_client_mismatch`,
// the parked-edit rules and the E2E row guards). A conflict's server copy is judged against the push's own in-flight cursor (X-1).
//
// A served value, key or code is read as data and never logged or put in an error (H-11).

import Foundation

/// The retryable refusals that park a setting edit instead of reverting it (R5).
private let parkingCodes: [String: SyncParkReason] = [
    "quota_exceeded": .quota, "entitlement_required": .entitlement,
]

/// JavaScript's string conversion of a result member (`undefined` when absent).
private func jsString(_ r: [String: JSONValue], _ name: String) -> String {
    guard let v = r[name] else { return "undefined" }
    switch v {
    case .null: return "null"
    case .bool(let b): return b ? "true" : "false"
    case .string(let s): return s
    case .int(let i): return String(i)
    case .double(let d): return d.isFinite && d == d.rounded() && abs(d) < 1e15 ? String(Int(d)) : String(d)
    default: return v.description
    }
}

private func errorCode(_ body: JSONValue?) -> String? {
    body?.objectValue?["error"]?.objectValue?["code"]?.stringValue
}

/// A finite whole number as an `Int` (versions, cursors, sequences).
private func wholeInt(_ v: JSONValue?) -> Int? {
    guard let n = syncNumber(v), let i = Int(exactly: n) else { return nil }
    return i
}

/// Whether two setting operations write the same value: the same key, and the same member unless
/// one of them writes the whole value.
private func sameValue(_ a: SyncOp, _ b: SyncOp) -> Bool {
    guard case .setting(let ka, _) = a.target, case .setting(let kb, _) = b.target, ka == kb else { return false }
    func whole(_ o: SyncOp) -> Bool { o.op == .set || o.op == .clear }
    return whole(a) || whole(b) || a.member == b.member
}

/// A conflict copy the client may compare: opened sealed (not unreadable, not plaintext).
private func decidable(_ r: SyncRow) -> Bool { !r.bad && r.plain == nil }

private func parseHLC(_ h: String) -> (Int, Int)? {
    guard h.range(of: SYNC_HLC_PATTERN, options: .regularExpression) != nil,
        let ms = Int(h.prefix(12), radix: 16), let c = Int(h.suffix(4), radix: 16)
    else { return nil }
    return (ms, c)
}

extension CloudSyncMachine {
    /// The transport's answer to the request in flight.
    public func receive(_ res: SyncResponse, opened: SyncOpenedBody? = nil) throws {
        guard let req = inFlight else { preconditionFailure("respond: no request is in flight") }
        inFlight = nil
        var proceed = false
        if case .answer(let status, let body) = res {
            if status == 503 && req.kind == .push && errorCode(body) == "writes_paused" {
                // R4: the operator paused writes; the journal is unchanged and the next trigger retries.
                paused = true
            } else if status >= 500 || [400, 413, 429].contains(status) {
                // A request-level failure: nothing was processed and the journal is unchanged (rule 1).
            } else if status == 401 {
                s.blocked = .unauthorized
            } else if status == 403 {
                let err = body?.objectValue?["error"]?.objectValue ?? [:]
                if err["code"]?.stringValue == "account_required" {
                    leave(.accountRequired, discard: false)
                    s.blocked = .accountRequired
                    events.append(.signInOffered(signInUrl: err["signInUrl"]?.stringValue))
                    return
                }
                // The journal is kept; a document refresh lifts either block.
                s.blocked = err["code"]?.stringValue == "attestation_required" ? .attestation : .forbidden
            } else if status == 409 {
                try clientMismatch(req)
                proceed = true
            } else if status == 410 {
                if s.partitions[req.partition] != nil { s.partitions[req.partition]!.cursor = 0 }
                needSnapshot = true
                proceed = true
            } else if status == 200, case .object(let b)? = body {
                if acceptMode(b) {
                    if req.kind == .push { paused = false }
                    accept(req, b, opened ?? SyncOpenedBody())
                    proceed = true
                }
                // Otherwise the pin refused it: the body is dropped unread and the journal is unchanged.
            }
        }
        // A transport failure is a request-level failure too: nothing processed.
        if let so = signingOut, s.subject != nil {
            let p = s.partitions[activeName]!
            if !proceed || sendable(p) == 0 {
                leave(.signOut, discard: so.discard)
                return
            }
        }
        if proceed { kick() }
    }

    /// The pin on a 200 body: in E2E mode the body must say `encryption: "e2e"`; an app in server
    /// mode refuses an `e2e` body too, since it cannot open it.
    func acceptMode(_ body: [String: JSONValue]) -> Bool {
        var said = SyncAdvertised.omitted
        if let e = body["encryption"]?.stringValue, e == "e2e" || e == "server" { said = SyncAdvertised(rawValue: e)! }
        if !requiresE2E && said != .e2e { return !pinnedOut }
        advertised = said
        if pinnedOut { return false }
        if said == .e2e { s.e2eSeen = true }
        return true
    }

    func clientMismatch(_ req: InFlight) throws {
        // The server bound this clientId to another device. Regenerate and renumber; none of these
        // mutations was processed under the new id.
        guard s.partitions[req.partition] != nil else { return }
        s.partitions[req.partition]!.clientId = try freshClientId()
        s.partitions[req.partition]!.nextMutationId = 1
        let ops = s.partitions[req.partition]!.pending
        s.partitions[req.partition]!.pending = []
        for o in ops { _ = enqueue(req.partition, o) }
    }

    func firstContact(_ serverNow: Double) {
        guard abs(serverNow) < 1e15 else { return }
        s.offsetMs = Int(serverNow) - now
        if s.contacted { return }
        s.contacted = true
        let offset = s.offsetMs
        let restamp = abs(offset) > SYNC_MAX_CLOCK_SKEW_MS
        func shift(_ h: String) -> String {
            guard let (ms, c) = parseHLC(h) else { return h }
            return syncFormatHLC(physical: ms + offset, counter: c)
        }
        for name in Array(s.partitions.keys) {
            for i in s.partitions[name]!.pending.indices where s.partitions[name]!.pending[i].preContact {
                if restamp, let h = s.partitions[name]!.pending[i].editedHlc, !h.isEmpty {
                    s.partitions[name]!.pending[i].editedHlc = shift(h)
                }
                s.partitions[name]!.pending[i].preContact = false
            }
            for k in Array(s.partitions[name]!.device.keys) where s.partitions[name]!.device[k]!.preContact {
                if restamp { s.partitions[name]!.device[k]!.editedHlc = shift(s.partitions[name]!.device[k]!.editedHlc) }
                s.partitions[name]!.device[k]!.preContact = false
            }
        }
        for k in Array(drafts.keys) where drafts[k]!.preContact {
            if restamp { drafts[k]!.editedHlc = shift(drafts[k]!.editedHlc) }
            drafts[k]!.preContact = false
        }
        if restamp && s.hlc.physical > 0 { s.hlc = (s.hlc.physical + offset, s.hlc.counter) }
    }

    /// A 200 answer, accepted.
    func accept(_ req: InFlight, _ body: [String: JSONValue], _ opened: SyncOpenedBody) {
        if let n = syncNumber(body["serverNow"]) { firstContact(n) }
        guard req.partition == s.subject else { return }
        if let subj = body["subject"]?.stringValue, subj != req.partition {
            leave(.subjectChanged, discard: false)
            return
        }
        let name = req.partition
        let before = valueMap()
        var overrides: [String: SyncChangeOrigin] = [:]
        let batch = s.partitions[name]!.pending.filter { req.mutationIds.contains($0.mutationId) }
        var parkedNow: [SyncOp] = []
        for case .object(let r) in body["results"]?.arrayValue ?? [] {
            guard let mid = wholeInt(r["mutationId"]),
                let at = s.partitions[name]!.pending.firstIndex(where: {
                    $0.mutationId == mid && req.mutationIds.contains($0.mutationId)
                })
            else { continue }
            var op = s.partitions[name]!.pending[at]
            var park: SyncParkReason?
            if r["status"]?.stringValue == "rejected", case .setting = op.target {
                park = parkingCodes[jsString(r, "code")]
            }
            if let park {
                // R5: a retryable refusal keeps the edit on the device, still read, until it can land.
                op.parked = park
                s.partitions[name]!.pending[at] = op
                parkedNow.append(op)
                continue
            }
            s.partitions[name]!.pending.remove(at: at)
            result(name, op, r, &overrides, opened, cursor: req.cursor)
        }
        // A parked edit that a later edit of the same value already replaces is dropped.
        for op in parkedNow {
            let later = batch + s.partitions[name]!.pending
            if later.contains(where: { $0.mutationId != op.mutationId && $0.mutationId > op.mutationId && sameValue(op, $0) }) {
                s.partitions[name]!.pending.removeAll { $0.mutationId == op.mutationId }
            }
        }
        // The pull members: a cursor-0 request answers with a snapshot, which replaces ours.
        if req.cursor == 0 && syncIsNumber(body["cursor"]) {
            s.partitions[name]!.settings = [:]
            s.partitions[name]!.records = [:]
        }
        if requiresE2E, let since = syncNumber(body["encryptionSince"]) { lowerSince(name, since) }
        let openedChanges = opened.changes
        for (i, cv) in (body["changes"]?.arrayValue ?? []).enumerated() {
            guard case .object(let c) = cv, let version = wholeInt(c["version"]) else { continue }
            // E2E guard (a): inside one partition a served change is newer than the cursor the request
            // carried, so an older one is a replay or a forgery. Only a snapshot (cursor 0) has no floor.
            if requiresE2E && req.cursor > 0 && version <= req.cursor { continue }
            let openRow = i < openedChanges.count ? openedChanges[i] : nil
            var latchKey = ""
            var settingKey: String?
            var recordKey: String?
            if let k = c["setting"]?.stringValue {
                settingKey = k
                latchKey = "s:\(k)"
            } else if let rec = c["record"]?.arrayValue, rec.count == 2 {
                recordKey = syncRecordKey(rec[0].stringValue ?? rec[0].description, rec[1].stringValue ?? rec[1].description)
                latchKey = "r:" + recordKey!
            }
            let bad = rowBad(name, latchKey, version, openRow, cursor: req.cursor)
            let row = SyncRow(value: c["value"] ?? .null, version: version, bad: bad.bad, plain: bad.plain)
            if let k = settingKey {
                s.partitions[name]!.settings[k] = row
                dropParkedByRemote(name, k, c["editedHlc"]?.stringValue)
            } else if let rk = recordKey {
                s.partitions[name]!.records[rk] = row
            }
        }
        for case .object(let t) in body["tombstones"]?.arrayValue ?? [] {
            if let k = t["setting"]?.stringValue {
                s.partitions[name]!.settings.removeValue(forKey: k)
                dropParkedByRemote(name, k, t["editedHlc"]?.stringValue)
            } else if let rec = t["record"]?.arrayValue, rec.count == 2 {
                s.partitions[name]!.records.removeValue(forKey: syncRecordKey(rec[0].stringValue ?? rec[0].description, rec[1].stringValue ?? rec[1].description))
            }
        }
        if let cur = wholeInt(body["cursor"]) { s.partitions[name]!.cursor = cur }
        if case .object(let al)? = body["aliases"] {
            s.aliases = al.compactMapValues(\.stringValue)
        }
        // R5: more room than the last response showed re-sends the quota-parked edits.
        if let quota = syncNumber(body["quota"]?.objectValue?["bytes"]),
            let usage = syncNumber(body["usage"]?.objectValue?["bytes"])
        {
            let headroom = quota - usage
            if let h = s.partitions[name]!.headroom, headroom > h { unpark(name) { $0 == .quota } }
            s.partitions[name]!.headroom = headroom
        }
        needSnapshot = false
        pullWanted = body["more"] == .bool(true)
        emitChanges(before, overrides, .remote)
    }

    /// E2E `encryptionSince`: only the host's open result counts. A row it opened from a `ct` is good
    /// (and lowers the clamp); one it could not open is bad; a plaintext row is legacy data only while
    /// its host-mapped `seq` stays below the partition's `encryptionSince`, judged on every read. A
    /// plaintext row with no `seq` is bad at once. Server mode reads every row as it always did.
    func rowBad(_ name: String, _ latchKey: String, _ version: Int, _ open: SyncOpenedRow?, cursor: Int? = nil)
        -> (bad: Bool, plain: Int?)
    {
        if !requiresE2E { return (false, nil) }
        if open?.invalid == true { return (true, nil) }
        if open?.sealed == true {
            noteSealed(name, version, latchKey)
            return (false, nil)
        }
        guard let seq = open?.seq else { return (true, nil) }
        // Guard (c): a key this machine has seen sealed never reads as legacy plaintext.
        if latchKey != "" && s.partitions[name]!.sealedKeys.contains(latchKey) { return (true, nil) }
        // Guard (b): legacy only if the request's cursor was still below the boundary.
        let since = s.partitions[name]!.encryptionSince
        if let cursor, since == nil || cursor >= since! { return (true, nil) }
        return (false, seq)
    }

    /// A conflict's `server` copy as a row. `cursor` is the push's own in-flight cursor (the partition
    /// cursor captured when it was sent), never the cursor after the answer: guard (b) then holds for
    /// a conflict copy as for a pulled change (X-1).
    func copyRow(
        _ name: String, _ latchKey: String, _ server: [String: JSONValue], _ version: Int, _ open: SyncOpenedRow?,
        cursor: Int
    ) -> SyncRow {
        let bad = rowBad(name, latchKey, version, open, cursor: cursor)
        return SyncRow(value: server["value"] ?? .null, version: version, bad: bad.bad, plain: bad.plain)
    }

    /// Take a served boundary: the least ever served, held at or below the sealed floor.
    func lowerSince(_ name: String, _ served: Double) {
        guard served.isFinite, served >= 0, let sv = Int(exactly: served.rounded(.down)) else { return }
        var since = min(s.partitions[name]!.encryptionSince ?? sv, sv)
        if let f = s.partitions[name]!.sealedFloor { since = min(since, f) }
        s.partitions[name]!.encryptionSince = since
    }

    /// This machine pushed, or opened, a sealed row at `version`: no plaintext at or above it is
    /// legacy, whatever a Worker serves.
    func noteSealed(_ name: String, _ version: Int, _ latchKey: String = "") {
        guard requiresE2E else { return }
        if latchKey != "" && !s.partitions[name]!.sealedKeys.contains(latchKey) {
            s.partitions[name]!.sealedKeys.append(latchKey)
            let extra = s.partitions[name]!.sealedKeys.count - syncSealedLatchMax
            if extra > 0 { s.partitions[name]!.sealedKeys.removeFirst(extra) }
        }
        let floor = min(s.partitions[name]!.sealedFloor ?? version, version)
        s.partitions[name]!.sealedFloor = floor
        if let since = s.partitions[name]!.encryptionSince { s.partitions[name]!.encryptionSince = min(since, floor) }
    }

    /// A newer remote value of a `lastWrite` key replaces its parked `set` or `clear` (R5).
    func dropParkedByRemote(_ name: String, _ serverKey: String, _ editedHlc: String?) {
        guard let editedHlc else { return }
        s.partitions[name]!.pending.removeAll { o in
            guard o.parked != nil, case .setting(let k, _) = o.target, o.op == .set || o.op == .clear,
                alias(k) == serverKey, policyOf(k) == "lastWrite", let h = o.editedHlc
            else { return false }
            return syncUTF16Less(h, editedHlc)
        }
    }

    /// The number a `max`/`min` record compares: the value, or its `field` member.
    private func compared(_ v: JSONValue?, _ field: String?) -> JSONValue? {
        if let field, case .object(let o)? = v { return o[field] }
        return v
    }

    /// Whether `local` beats `server` under a `max` or `min` policy (numbers only).
    private func better(_ policy: String, _ local: JSONValue?, _ server: JSONValue?) -> Bool {
        guard let l = syncNumber(local), let s = syncNumber(server) else { return false }
        return policy == "max" ? l > s : l < s
    }

    /// `max` and `min` are decided by the client in E2E mode.
    func clientDecides(_ policy: String) -> Bool { requiresE2E && (policy == "max" || policy == "min") }

    /// One processed result.
    func result(
        _ name: String, _ op: SyncOp, _ r: [String: JSONValue], _ overrides: inout [String: SyncChangeOrigin],
        _ opened: SyncOpenedBody, cursor: Int
    ) {
        let status = r["status"]?.stringValue
        let openedConflict = opened.conflicts[op.mutationId]
        if case .setting(let key, _) = op.target {
            let serverKey = r["renamedTo"]?.stringValue ?? alias(key)
            if op.moved { overrides[key] = .merge }
            let version = wholeInt(r["version"])
            if status == "ok", let version { noteSealed(name, version, "s:\(serverKey)") }
            if status == "ok" {
                if r["dropped"] == .bool(true) {
                    overrides[key] = .migration
                    for d in catalog.settings where alias(d.key) == alias(key) { overrides[d.key] = .migration }
                } else if let version {
                    let prior = s.partitions[name]!.settings[serverKey]
                    if let value = syncApplySettingOp(policyOf(key), prior?.value, op) {
                        s.partitions[name]!.settings[serverKey] = SyncRow(value: value, version: version)
                    } else {
                        s.partitions[name]!.settings.removeValue(forKey: serverKey)
                    }
                }
            } else if status == "conflict", case .object(let server)? = r["server"] {
                // A stale write loses to the server copy, and nothing is enqueued.
                if let sv = wholeInt(server["version"]) {
                    let sbad = copyRow(name, "s:\(serverKey)", server, sv, openedConflict, cursor: cursor)
                    s.partitions[name]!.settings[serverKey] = sbad
                    // E2E max/min: keep the better value and re-push it on the server's version.
                    if op.op == .set, decidable(sbad), clientDecides(policyOf(key)),
                        better(policyOf(key), op.value, server["value"])
                    {
                        var again = SyncOp(mutationId: 0, target: op.target, op: .set, value: op.value, baseVersion: sv)
                        if let h = op.editedHlc, !h.isEmpty { again.editedHlc = h }
                        _ = enqueue(name, again)
                        overrides[key] = .merge
                    }
                }
            } else if status == "rejected" {
                // A terminal refusal: the value reverts to the snapshot and the app is told.
                events.append(.rejected(mutationId: op.mutationId, code: jsString(r, "code")))
            }
            return
        }
        // A record.
        guard case .record(let c, let rid) = op.target else { return }
        let rk = syncRecordKey(c, rid)
        let decl = collectionDecl(c)
        var rebaseOn: Int?
        var rebaseAny = false
        var hasRebase = false
        var rebaseValue: JSONValue?
        if status == "ok", let version = wholeInt(r["version"]) {
            noteSealed(name, version, "r:\(rk)")
            let prior = s.partitions[name]!.records[rk]
            if let value = syncApplyRecordOp(prior?.value, op) {
                s.partitions[name]!.records[rk] = SyncRow(value: value, version: version)
            }
            if s.partitions[name]!.held[rk] != nil { (rebaseOn, hasRebase) = (version, true) }
        } else if status == "conflict", case .object(let server)? = r["server"] {
            if let sv = wholeInt(server["version"]) {
                let sbad = copyRow(name, "r:\(rk)", server, sv, openedConflict, cursor: cursor)
                s.partitions[name]!.records[rk] = sbad
                // The resolution is a NEW mutation on the server's version; N is never resent. Only
                // `revision` resolves on the device; every other policy took the server's copy.
                if s.partitions[name]!.held[rk] != nil {
                    (rebaseOn, hasRebase) = (sv, true)
                } else if let decl, op.op == .set, decidable(sbad), clientDecides(decl.policy),
                    better(decl.policy, compared(op.value, decl.field), compared(server["value"], decl.field))
                {
                    // E2E max/min record: the better value is re-pushed on the server's version.
                    (rebaseOn, hasRebase, rebaseValue) = (sv, true, op.value)
                } else if let decl, decl.policy == "revision", decl.resolve == "keepLocal", op.op == .set {
                    (rebaseOn, hasRebase, rebaseValue) = (sv, true, op.value)
                }
            }
        } else {
            if status == "rejected" { events.append(.rejected(mutationId: op.mutationId, code: jsString(r, "code"))) }
            if s.partitions[name]!.held[rk] != nil {
                hasRebase = true
                if let row = s.partitions[name]!.records[rk] { rebaseOn = row.version } else { rebaseAny = true }
            }
        }
        if hasRebase {
            let value = s.partitions[name]!.held[rk] ?? rebaseValue
            s.partitions[name]!.held.removeValue(forKey: rk)
            _ = enqueue(
                name,
                SyncOp(
                    mutationId: 0, target: .record(c, rid), op: .set, value: value ?? .null, baseVersion: rebaseOn,
                    baseAny: rebaseAny))
        }
    }
}
