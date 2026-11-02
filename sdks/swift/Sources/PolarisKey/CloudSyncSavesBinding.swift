// `client.cloudSync.saves` bound to the machine and the file transport (U-22.5): the records port over the
// Cloud Sync host (`MachineRecords`) and the environment `SavesClient` runs in (`LiveSavesEnvironment`).
// A port of Node's `cloudSync/saves.ts` (`MachineRecords`, `SavesApi`).
//
//   records   `MachineRecords`: `SaveRecords` over the machine's `records`, `putAt` and `removeAt`. A write
//             waits for its one outcome (ok, conflict with the server copy, rejected or dropped by a
//             sign-out) and is never coalesced or rebased. There is no timeout on the wait: the caller's
//             cancel, a sign-out and the host's retries end it.
//   files     `CloudSyncFileTransport` + `FileJournal` + `FileChunkCache` under one `FileTransferEngine`
//             (`maxRetryAfterSeconds` 3600).
//   codec     end-to-end: the key ring's `fileCodec("saves")`, which refuses once the ring locks; server
//             mode: `ServerFileCodec`.
//   purge     the journal, the person's chunk cache and any waiting write go with the person.
//
// Nothing here logs a value, a key or a path; events carry ids, counts and codes.

import Foundation
import PolarisKeyCore
import PolarisKeyPlatform

let savesMaxRetryAfterSeconds = 3600.0

/// One write's wait for its outcome: settled by the machine's listener, a cancel, or a drop.
private final class OutcomeSlot: @unchecked Sendable {
    enum End: Sendable {
        case outcome(SyncRecordOutcome)
        case aborted
    }

    private let lock = NSLock()
    private var end: End?
    private var waiter: CheckedContinuation<End, Never>?

    /// The first end wins.
    func settle(_ e: End) {
        let w = lock.withLock { () -> CheckedContinuation<End, Never>? in
            guard end == nil else { return nil }
            end = e
            let w = waiter
            waiter = nil
            return w
        }
        w?.resume(returning: e)
    }

    func wait() async -> End {
        await withCheckedContinuation { (c: CheckedContinuation<End, Never>) in
            let ready = lock.withLock { () -> End? in
                if let end { return end }
                waiter = c
                return nil
            }
            if let ready { c.resume(returning: ready) }
        }
    }
}

/// `SaveRecords` over the Cloud Sync host's machine.
final class MachineRecords: SaveRecords, @unchecked Sendable {
    private let host: CloudSyncHost
    private let slots = LockedValue<[Int: OutcomeSlot]>([:])

    init(host: CloudSyncHost) { self.host = host }

    /// Make this the listener of the host's outcomes (idempotent; the host keeps it across rebuilds).
    func bind() async {
        await host.onOutcome { [weak self] ticket, outcome in self?.deliver(ticket, outcome) }
    }

    private func deliver(_ ticket: Int, _ outcome: SyncRecordOutcome) {
        let slot = slots.with { $0.removeValue(forKey: ticket) }
        slot?.settle(.outcome(outcome))
    }

    /// Settle every write still waiting as dropped (the person and their data are gone).
    func dropAll() {
        let all = slots.with { s -> [OutcomeSlot] in
            let v = Array(s.values)
            s.removeAll()
            return v
        }
        for slot in all { slot.settle(.outcome(.dropped)) }
    }

    func wireId(_ id: String) async throws -> String { try await host.wireId(savesCollection, id) }

    private static func meta(_ v: JSONValue) -> [String: JSONValue] { v.objectValue ?? [:] }

    private static func record(_ row: SyncRecordRow, id: String? = nil) -> SaveRecord {
        SaveRecord(id: id ?? row.id, version: row.version, value: meta(row.value), file: row.file)
    }

    func list() async throws -> [SaveRecord] {
        let e2e = await host.encryptionMode() == .e2e
        return await host.records(savesCollection)
            .filter { !(e2e && SyncBlind.isBlindedName($0.id)) }
            .map { Self.record($0) }
    }

    func get(_ id: String) async throws -> SaveRecord? {
        let rows = await host.records(savesCollection)
        var row = rows.first { $0.id == id }
        // A record that has a file and no value comes back under its wire id (the host cannot place its
        // blinded id without a value).
        if row == nil, await host.encryptionMode() == .e2e {
            let wire = try await host.wireId(savesCollection, id)
            row = rows.first { $0.id == wire }
        }
        return row.map { Self.record($0, id: id) }
    }

    private func wait(
        _ stop: SaveStop?, _ start: @Sendable (@escaping @Sendable (Int) -> Void) async -> SyncTicketResult
    )
        async throws -> SaveSetResult
    {
        await host.catchUp()
        let slot = OutcomeSlot()
        // The slot is registered inside the host's own turn, before anything can settle the ticket.
        let register: @Sendable (Int) -> Void = { [slots] ticket in slots.with { $0[ticket] = slot } }
        let started = await start(register)
        let ticket: Int
        switch started {
        case .failed(let code): return .rejected(code: code)
        case .ticket(let t): ticket = t
        }
        Task { await host.touch() }
        // A cancel ends the wait; a pause never does (the task is cancelled for a pause too).
        let token = stop?.onSet { slot.settle(.aborted) }
        let end = await slot.wait()
        stop?.remove(token)
        guard case .outcome(let outcome) = end else {
            slots.with { _ = $0.removeValue(forKey: ticket) }
            throw TransferError(.aborted)
        }
        switch outcome {
        case .ok(let version): return .ok(version: version)
        case .conflict(let server):
            return .conflict(
                server: server.map {
                    SaveRecord(id: "", version: $0.version, value: Self.meta($0.value), file: $0.file)
                })
        case .rejected(let code): return .rejected(code: code)
        case .dropped: return .rejected(code: "signed-out")
        }
    }

    private func withId(_ id: String, _ r: SaveSetResult) -> SaveSetResult {
        if case .conflict(let s?) = r {
            return .conflict(server: SaveRecord(id: id, version: s.version, value: s.value, file: s.file))
        }
        return r
    }

    func set(
        _ id: String, value: [String: JSONValue], base: SyncBase, file: SaveFile?, stop: SaveStop?
    ) async throws -> SaveSetResult {
        let host = self.host
        let r = try await wait(stop) { register in
            await host.putAt(savesCollection, id, .object(value), base: base, file: file, onTicket: register)
        }
        return withId(id, r)
    }

    func pull() async -> Bool {
        guard await host.requestPull() else { return false }
        await host.touch()
        return true
    }

    func delete(_ id: String, baseVersion: Int) async throws -> SaveSetResult {
        let host = self.host
        let r = try await wait(nil) { register in
            await host.removeAt(savesCollection, id, base: .version(baseVersion), onTicket: register)
        }
        return withId(id, r)
    }
}

/// What `SavesClient` runs in, built once per client.
final class LiveSavesEnvironment: SavesEnvironment, @unchecked Sendable {
    private let core: CoreContext
    private let api: CloudSyncApi
    private let keyring: @Sendable () -> SyncKeyring
    private let options: SavesOptions
    let journal: FileJournal
    private let engine: FileTransferEngine
    let background: CloudSyncBackground?
    private let resumed = LockedValue<Set<String>>([])
    private let state = LockedValue<(records: MachineRecords?, host: CloudSyncHost?, subject: String?)>(
        (nil, nil, nil))

    init(
        core: CoreContext, api: CloudSyncApi, keyring: @escaping @Sendable () -> SyncKeyring, options: SavesOptions,
        backgroundTokens: BackgroundTokens? = nil, backgroundPort: (any BackgroundSessionPort)? = nil
    ) {
        self.core = core
        self.api = api
        self.keyring = keyring
        self.options = options
        let journal = FileJournal(stateDir: core.dirs.state)
        self.journal = journal
        var bulk: CloudSyncBackground?
        let resumed = self.resumed
        #if canImport(Darwin)
            if let backgroundTokens {
                // Reconcile's ids (transfers to send again) join the journaled ones in `interruptedWrites`.
                let onResume: @Sendable ([String]) -> Void = { ids in resumed.with { $0.formUnion(ids) } }
                if let backgroundPort {
                    bulk = CloudSyncBackground(
                        product: core.product, stateDir: core.dirs.state, journal: journal, port: backgroundPort,
                        tokens: backgroundTokens, onResume: onResume)
                } else {
                    bulk = CloudSyncBackground(
                        product: core.product, stateDir: core.dirs.state, journal: journal,
                        tokens: backgroundTokens, onResume: onResume)
                }
            }
        #endif
        background = bulk
        engine = FileTransferEngine(
            transport: CloudSyncFileTransport(core: core, bulk: bulk), journal: journal,
            maxRetryAfterSeconds: savesMaxRetryAfterSeconds)
    }

    /// The records port for the host the API holds; one per host.
    private func records(_ host: CloudSyncHost) -> MachineRecords {
        state.with { s in
            if let r = s.records, s.host === host { return r }
            let r = MachineRecords(host: host)
            s.records = r
            s.host = host
            return r
        }
    }

    func savesContext() async throws -> SavesContext {
        try await core.requireService(.sync, feature: Feature.syncSaves)
        if let background {
            // Reconcile once per context. It does nothing while the channel is closed: only a person's
            // sign-in opens it again (`personSignedIn`).
            Task { await background.reconcile() }
        }
        guard let host = await api.startedHost() else { throw SavesError(.rejected, detail: "sync-not-started") }
        let recs = records(host)
        await recs.bind()
        let e2e = await host.encryptionMode() == .e2e
        let codec: any FileCodec = e2e ? try keyring().fileCodec(collection: savesCollection) : ServerFileCodec()
        var cache: (any ChunkCache)?
        if options.delta, let subject = await host.machineSubject() {
            state.with { $0.subject = subject }
            cache = FileChunkCache(
                directory: chunkCacheDirectory(
                    stateDir: core.dirs.state, subject: subject, collection: savesCollection),
                maxBytes: chunkCacheBudget(largestSave: options.maxBytes))
        }
        return SavesContext(
            records: recs, engine: engine, revisions: CloudSyncFileTransport(core: core), codec: codec,
            cache: cache)
    }

    func release(transferId: String) async { await engine.cancel(id: transferId) }

    func deviceLabel() async -> String? { await core.deviceLabel() }

    func dropWaiting() { state.current.records?.dropAll() }

    func interruptedWrites() -> [String] {
        Array(Set(journal.list()).union(resumed.current)).filter { $0.hasPrefix("saves:") }
    }

    /// A person signed in: the channel a sign-out closed may enqueue again.
    func personSignedIn() { background?.open() }

    /// Lock, sign-out and forget: cancel every background task and delete the spool before anything else.
    func closeBackground() async { await background?.close() }

    func purgeFiles() async {
        await background?.close()
        journal.clear()
        resumed.with { $0.removeAll() }
        // Only the signed-in person's cache (the last one a context used), never another's.
        let subject = state.with { s -> String? in
            let v = s.subject
            s.subject = nil
            return v
        }
        if let subject {
            try? FileManager.default.removeItem(
                at: chunkCachePersonDirectory(stateDir: core.dirs.state, subject: subject))
        }
    }
}
