// The Cloud Sync settings API (U-07.8): what app code sees on top of the host (`CloudSyncHost`). A port
// of Python's `cloud_sync/api.py` and Node's `cloudSync/api.ts`.
//
//  - `client.cloudSync.status()` / `flush()` / `newRecoveryCode()`, and `client.events` `.cloudSync`;
//  - `config.set` / `clear` / `setting(k).sync()` routed through the machine while a principal is held
//    (`ConfigSyncPort`).
//
// The identity session drives the machine, in order, on one serial consumer:
//  - A-1  A person change never talks to the server. The old person's unsynced edits are discarded and
//         their synced projection leaves the machine before anything waits (`signOut(discardUnsynced:)`),
//         then the ring is forgotten and the data purged, then the new person signs in. The host drops
//         any request bound to the old person (HOST-BIND).
//  - A-2  An offline boot is not a sign-out. An unknown subject (nothing held, discovery not loaded, a
//         network error) changes nothing; only a readable "no session" leaves.
//  - A-3  Sign-out, the old token still current: Connect leave, then a bounded flush and the machine's
//         sign-out, THEN the ring forgets (the E2E flush needs the root), then purge. Forget and purge are
//         each tried whatever the other did; a forget that throws stops the sign-out (U-39.S) and a purge
//         failure is reported (`purgeFailed`) and never replaces the sign-out's error. Purge also runs when
//         Sync is off.
//  - A-4  A sign-out that happens elsewhere (`account_required`, a released device) reaches the machine as
//         `signedOut` and forgets and purges once. `account_required` keeps the machine as it stands
//         (blocked, partition gone; status stays `blocked` across a relaunch) instead of purging it, and
//         the refused subject is not signed in again until a sign-out or another subject. A key-ring or
//         file route's `account_required` calls `accountRequired(signInUrl:)` here (A-4b).
//  - A-5  `signInUrl` is vetted (`safeSignInUrl`): no control characters or whitespace, resolved against
//         the Worker origin, https on that origin only. The offer follows the forget and comes only for
//         `accountRequired` / `subjectChanged`.
//  - A-6  The legacy local values are offered to the machine once per install (a marker kept apart from
//         the state file, written after sign-in succeeds); the locked list is rebuilt before `set` / `clear`
//         after a document refresh.
//  - A-7  The mode is app code's (`CloudSyncOptions`); licence state is never read or written here.
// No event, log line or error carries a value or the root; events name keys and codes only.

import Foundation
import PolarisKeyConfig
import PolarisKeyCore

/// One Cloud Sync event for app code: the machine's events, and `purgeFailed`.
public enum CloudSyncEvent: Sendable, Equatable {
    case change(keys: [String], origin: SyncChangeOrigin)
    case rejected(mutationId: Int, code: String)
    case signedOut(reason: SyncSignedOutReason, unsynced: Int)
    case unsyncedData(count: Int)
    case signInOffered(signInUrl: String?)
    /// The synced data could not be deleted from disk (no values, no path): the app may warn the person.
    case purgeFailed
    /// A save transfer moved `done` of `total` plaintext bytes (`TransferEvent.transferprogress`).
    case transferProgress(id: String, done: Int, total: Int)
    /// A save transfer ended: `state` is `done`, `cancelled` or `conflict` (`TransferEvent.transferdone`). A
    /// cancelled transfer is a state, not a failure.
    case transferDone(id: String, state: String)
    /// A save transfer failed with a code (`TransferEvent.transferfailed`).
    case transferFailed(id: String, code: String)
    /// A `revision` write met a newer copy (or a keep conflicted again): the request is open and the device
    /// keeps its copy unsent until `keep` (plans/U-08.md section 2.3). `MergeEvent.conflictopened`.
    case conflictOpened(MergeRequest)
    /// A request closed; `how` is `local`, `remote`, `value`, `both` or `superseded`. `MergeEvent.conflictclosed`.
    case conflictClosed(id: String, how: SyncMergeHow)

    /// The transfer event's type word from the generated `TransferEvent` constants; nil for the others.
    public var transferType: String? {
        switch self {
        case .transferProgress: return TransferEvent.transferprogress
        case .transferDone: return TransferEvent.transferdone
        case .transferFailed: return TransferEvent.transferfailed
        default: return nil
        }
    }

    /// The MergeRequest event's type word from the generated `MergeEvent` constants; nil for the others.
    public var mergeType: String? {
        switch self {
        case .conflictOpened: return MergeEvent.conflictopened
        case .conflictClosed: return MergeEvent.conflictclosed
        default: return nil
        }
    }

    /// nil for a `records` event: a collection's changes go to its handle, not to this stream.
    init?(_ e: SyncEvent) {
        switch e {
        case .change(let k, let o): self = .change(keys: k, origin: o)
        case .rejected(let id, let c): self = .rejected(mutationId: id, code: c)
        case .signedOut(let r, let u): self = .signedOut(reason: r, unsynced: u)
        case .unsyncedData(let c): self = .unsyncedData(count: c)
        case .signInOffered(let u): self = .signInOffered(signInUrl: u)
        // A request's events come from the registry, which holds the request object.
        case .records, .conflict, .conflictClosed: return nil
        }
    }
}

/// The "New recovery code" action's model: `generate()` makes a fresh code through the key ring and returns
/// it once. The code is kept nowhere.
public struct RecoveryCodeModel: Sendable {
    let make: @Sendable () async throws -> String
    public func generate() async throws -> String { try await make() }
}

/// `client.cloudSync`: the verbs. A product without the Sync service gets the typed N/A.
public final class CloudSyncClient: Sendable {
    let api: CloudSyncApi
    /// The saves of the signed-in person (`list`, `read`, `write`, `resolve`, `delete`, `revisions`).
    public let saves: SavesClient

    init(api: CloudSyncApi, saves: SavesClient) {
        self.api = api
        self.saves = saves
    }

    /// Listen for `revision` conflicts: a request opens when a write meets a newer copy, and the device keeps
    /// its copy unsent until `request.keep(...)`. The requests already open are offered at once. The listener
    /// runs on the Cloud Sync host's turn and must not call back into the client synchronously; show the request
    /// and answer later with `keep`. `subscription.cancel()` removes it. See `onConflict(deciding:)` to answer
    /// at once.
    public func onConflict(_ listener: @escaping @Sendable (MergeRequest) -> Void) async -> MergeSubscription {
        await api.onConflict { request in
            listener(request)
            return nil
        }
    }

    /// `onConflict` for a listener that decides: the choice it returns is applied at once (nothing is listed,
    /// no event fires for it), and `nil` leaves the request open for `keep`.
    public func onConflict(deciding listener: @escaping @Sendable (MergeRequest) -> MergeKeep?) async
        -> MergeSubscription
    {
        await api.onConflict(listener)
    }

    /// The open MergeRequests (record collections and saves), in id order. A product without the Sync service
    /// has none.
    public func conflicts() async -> [MergeRequest] { await api.conflicts() }

    /// Whether the cloud held nothing at this person's first sign-in answer: `true` after a first answer that
    /// said empty, `false` after one that did not or after any change, `nil` before an answer or while signed
    /// out. A first sign-in with a local save can offer to upload it.
    public func cloudEmpty() async -> Bool? { await api.cloudEmpty() }

    /// The save writes in flight (each with `pause`, `resume`, `cancel` and `outcome`).
    public func transfers() -> [SaveTransfer] { saves.transfers() }

    /// The machine's status. `local` before Cloud Sync has started. Throws the typed `product` N/A when the
    /// product does not run the Sync service.
    public func status() async throws -> SyncStatus { try await api.status() }

    /// Send what is waiting now (bounded by the sign-out flush window), save the journal and answer the
    /// status.
    @discardableResult
    public func flush() async throws -> SyncStatus { try await api.flush() }

    /// The records handle of a collection the product's catalog declares (plans/C-26). Starts Cloud Sync
    /// first; an undeclared name answers `collection_unknown` from each call, never a throw. Throws the typed
    /// `product` N/A when the product does not run the Sync service.
    public func collection(_ name: String) async throws -> CloudSyncCollection { try await api.collection(name) }

    /// A new recovery code for the key ring (`SyncKeyring.setRecoveryCode`). Shown once, kept nowhere.
    public func newRecoveryCode() async throws -> String { try await api.newRecoveryCode() }

    /// Writes a readable (decrypted) zip of the app's synced data to `destination`, a file URL: settings,
    /// records and files, in the layout of Polaris Locker's own export (WIRE-CONTRACT-V5 §13.12). The file is
    /// **not encrypted**: tell the person before you call this, and delete it when it has been shared. The SDK
    /// picks no location and has no consent prompt; on iOS pass a URL in the app's own container and offer it
    /// through `ShareLink` or the document picker, then delete it.
    ///
    /// `<destination>.partial` is created exclusively with owner-only access (and iOS data protection
    /// `completeUnlessOpen`), flushed to disk and renamed over `destination`; an error or a cancel (cancel the
    /// task) removes it and leaves any earlier file as it was. Throws the typed `product` N/A when the product
    /// does not run the Sync service; `account_required`, `sync-locked`, `sync-encryption-pinned`, `cancelled`,
    /// `sync-export-too-large` (nothing is written) and `sync-export-failed` (`exportFailureReason`:
    /// `destination`, `network` or `busy`). Data that does not check is left out or written short and listed in
    /// `skipped`; it never stops the export.
    public func export(to destination: URL, options: CloudSyncExportOptions = CloudSyncExportOptions()) async throws
        -> CloudSyncExport
    {
        try await api.export(to: destination, options: options)
    }

    /// The recovery-code screen's model.
    public var recoveryCode: RecoveryCodeModel { RecoveryCodeModel { try await self.api.newRecoveryCode() } }
}

/// A sign-in URL fit to hand to the app: https on the Worker's origin (`https://host[:port]`), normalised,
/// else nil. `https://` or `//` start an authority that must be exactly the Worker's host (and port; 443 is
/// the default); any other `scheme:`, userinfo, a trailing dot, a lookalike host, a backslash, whitespace or a
/// control or non-ASCII character answers nil. Anything else is a path on the origin; there is no path
/// restriction. The rule is the same in every SDK and pinned by the corpus's `signInUrlCases`; it uses no URL
/// library, so no parser's quirks can differ between languages.
func safeSignInUrl(_ url: String?, origin: String) -> String? {
    guard let url, !url.isEmpty, let base = parseSignInOrigin(origin) else { return nil }
    for u in url.unicodeScalars where u.value < 0x21 || u.value > 0x7E || u.value == 0x5C { return nil }
    let rest: Substring?
    if url.lowercased().hasPrefix("https://") {
        rest = url.dropFirst(8)
    } else if url.hasPrefix("//") {
        rest = url.dropFirst(2)
    } else {
        rest = nil
    }
    var tail: String
    if let rest {
        let end = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" })
        let authority = String(end.map { rest[..<$0] } ?? rest).lowercased()
        let allowed = base.port == "443" ? [base.host, "\(base.host):443"] : ["\(base.host):\(base.port)"]
        guard allowed.contains(authority) else { return nil }
        tail = end.map { String(rest[$0...]) } ?? ""
    } else if startsWithScheme(url) {
        return nil
    } else {
        tail = url
    }
    if !tail.hasPrefix("/") { tail = "/" + tail }
    return "https://\(base.host)\(base.port == "443" ? "" : ":" + base.port)\(tail)"
}

/// `https://host[:port]` as the lower-case host and the port ("443" when none).
private func parseSignInOrigin(_ origin: String) -> (host: String, port: String)? {
    let o = origin.lowercased()
    guard o.hasPrefix("https://") else { return nil }
    let rest = o.dropFirst(8)
    let parts = rest.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    guard let hostPart = parts.first, !hostPart.isEmpty,
        hostPart.unicodeScalars.allSatisfy({
            ($0.value >= 0x61 && $0.value <= 0x7A) || ($0.value >= 0x30 && $0.value <= 0x39) || $0 == "." || $0 == "-"
        })
    else { return nil }
    var port = "443"
    if parts.count == 2 {
        let p = parts[1]
        guard !p.isEmpty, p.count <= 5, p.allSatisfy(\.isASCII), p.allSatisfy(\.isNumber), let n = Int(p) else {
            return nil
        }
        port = String(n)
    }
    return (String(hostPart), port)
}

/// Whether `s` starts with `scheme:` (a letter, then letters, digits, `+`, `.` or `-`, then a colon).
private func startsWithScheme(_ s: String) -> Bool {
    var seenFirst = false
    for c in s.unicodeScalars {
        if !seenFirst {
            guard (c.value >= 0x41 && c.value <= 0x5A) || (c.value >= 0x61 && c.value <= 0x7A) else { return false }
            seenFirst = true
            continue
        }
        if c == ":" { return true }
        let ok =
            (c.value >= 0x41 && c.value <= 0x5A) || (c.value >= 0x61 && c.value <= 0x7A)
            || (c.value >= 0x30 && c.value <= 0x39) || c == "+" || c == "." || c == "-"
        if !ok { return false }
    }
    return false
}

actor CloudSyncApi {
    private enum Work {
        case identity(IdentityChange)
        case marker(@Sendable () -> Void)
    }

    private let core: CoreContext
    private let makeHost: @Sendable () -> CloudSyncHost
    private let config: ConfigClient
    private let account: @Sendable () -> String?
    private let emit: @Sendable (CloudSyncEvent) -> Void
    private let forgetRing: @Sendable () async throws -> Void
    private let lockRing: @Sendable () async -> Void
    private let purgeSaves: @Sendable () async -> Void
    private let personSignedIn: @Sendable () -> Void
    private let recovery: @Sendable () async throws -> String
    /// Diagnostics; never given a value or a secret.
    private let log: @Sendable (String) -> Void
    let merge: MergeRegistry
    private var hostValue: CloudSyncHost?
    private var attached = false
    private var attaching: Task<Void, Never>?
    private var subject: String?
    /// While a hook forgets explicitly, the machine's own `signedOut` does not start a second forget.
    private var explicitForget = false
    private var forgetTask: Task<Void, Never>?
    private let queue: AsyncStream<Work>
    private let enqueue: AsyncStream<Work>.Continuation
    private var consumer: Task<Void, Never>?
    private nonisolated let eventTail = LockedValue<Task<Void, Never>?>(nil)
    private let importMarker: URL

    init(
        core: CoreContext, config: ConfigClient, host: @escaping @Sendable () -> CloudSyncHost,
        account: @escaping @Sendable () -> String?, emit: @escaping @Sendable (CloudSyncEvent) -> Void,
        forgetRing: @escaping @Sendable () async throws -> Void,
        lockRing: @escaping @Sendable () async -> Void = {},
        purgeSaves: @escaping @Sendable () async -> Void = {},
        personSignedIn: @escaping @Sendable () -> Void = {},
        recovery: @escaping @Sendable () async throws -> String,
        merge: MergeRegistry = MergeRegistry(),
        log: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.log = log
        self.core = core
        self.config = config
        self.makeHost = host
        self.account = account
        self.emit = emit
        self.forgetRing = forgetRing
        self.lockRing = lockRing
        self.purgeSaves = purgeSaves
        self.personSignedIn = personSignedIn
        self.recovery = recovery
        self.merge = merge
        self.importMarker = core.dirs.state.appendingPathComponent("cloud-sync-imported.json")
        (queue, enqueue) = AsyncStream<Work>.makeStream()
        merge.attach(ApiMergePort(api: self))
    }

    private func host() -> CloudSyncHost {
        if let h = hostValue { return h }
        let h = makeHost()
        hostValue = h
        return h
    }

    // MARK: what app code calls

    func status() async throws -> SyncStatus {
        try await core.requireService(.sync, feature: Feature.syncSettings)
        guard let h = hostValue, await h.isStarted else { return SyncStatus(state: .local, pending: 0) }
        return await h.status() ?? SyncStatus(state: .local, pending: 0)
    }

    func flush() async throws -> SyncStatus {
        try await core.requireService(.sync, feature: Feature.syncSettings)
        await attach()
        await drain()
        await host().flush()
        await drain()
        return try await status()
    }

    func collection(_ name: String) async throws -> CloudSyncCollection {
        try await core.requireService(.sync, feature: Feature.syncRecords)
        await attach()
        return CloudSyncCollection(name: name, host: host())
    }

    func newRecoveryCode() async throws -> String { try await recovery() }

    nonisolated let exporterBox = LockedValue<CloudSyncExporter?>(nil)

    func export(to destination: URL, options: CloudSyncExportOptions) async throws -> CloudSyncExport {
        try await core.requireService(.sync, feature: Feature.syncExport)
        guard let exporter = exporterBox.current else { throw syncExportFailed("network") }
        return try await exporter.run(to: destination, options: options)
    }

    // MARK: MergeRequests (plans/U-08.md section 2.5)

    /// The host once it has started; never starts one.
    func hostIfStarted() async -> CloudSyncHost? {
        guard let h = hostValue, await h.isStarted else { return nil }
        return h
    }

    /// Listen for requests as they open; the ones already open are offered at once. A returned choice decides.
    /// Starts Cloud Sync first, so a request the journal held across a relaunch is offered too. A product
    /// without the Sync service has no requests.
    func onConflict(_ fn: @escaping MergeRegistry.Decider) async -> MergeSubscription {
        await attach()
        return await merge.addListener(fn)
    }

    func conflicts() async -> [MergeRequest] {
        await attach()
        return await merge.conflicts()
    }

    /// Whether the cloud was empty at this person's first answer (`nil` before one, or while signed out).
    func cloudEmpty() async -> Bool? {
        await attach()
        guard let h = await hostIfStarted() else { return nil }
        return await h.cloudEmpty()
    }

    /// The person Cloud Sync is signed in as (for tests and diagnostics).
    func currentSubject() -> String? { subject }

    /// The host, started and signed in as the held subject; nil when the product has no Sync service or the
    /// host did not start.
    func startedHost() async -> CloudSyncHost? {
        await attach()
        guard let h = hostValue, await h.isStarted else { return nil }
        return h
    }

    // MARK: what the client calls

    /// An identity change, queued and handled in order.
    nonisolated func onIdentity(_ change: IdentityChange) { enqueue.yield(.identity(change)) }

    /// Start the host and sign the machine in as the held subject. Idempotent; a no-op while the product
    /// does not run the Sync service.
    func attach() async {
        guard await core.enabled(.sync) else { return }
        if attached { return }
        if let t = attaching { return await t.value }
        let t = Task { await self.start() }
        attaching = t
        await t.value
        attaching = nil
    }

    /// The signed config document refreshed: lift a block, and rebuild if the document changed.
    func noteDocumentRefreshed() async {
        guard let h = hostValue, await h.isStarted else { return }
        await h.noteDocumentRefreshed()
    }

    nonisolated func attachSoon() { Task { await self.attach() } }

    private func start() async {
        let h = host()
        do { try await h.start() } catch { return }
        attached = true
        startConsumer()
        await h.onEvents { [weak self] events in self?.queueEvents(events) }
        await h.setMergeSink { [merge] events, snapshot, versions in
            merge.ingest(events, snapshot, versions: versions)
        }
        await config.useSync(SyncPort(api: self))
        await h.installLifecycleHooks()
        // A pin left behind by an earlier run goes now, before anything signs in.
        _ = await retryForget()
        // A journal saved while signed in still names its subject.
        subject = await h.machineSubject()
        // A-2: an unknown subject changes nothing; a known one signs in.
        if let who = account() { await signIn(who) }
    }

    private func startConsumer() {
        guard consumer == nil else { return }
        let q = queue
        consumer = Task { [weak self] in
            for await work in q {
                guard let self else { return }
                await self.handle(work)
            }
        }
    }

    private func handle(_ work: Work) async {
        switch work {
        case .marker(let done): done()
        case .identity(let change): await onIdentityNow(change)
        }
    }

    /// Wait for every identity change queued so far. Never from inside a handler.
    /// With `maxMs`, the wait ends at the bound whatever the consumer is doing (S-3).
    private func drain(maxMs: Int? = nil) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            if consumer == nil {
                c.resume()
                return
            }
            let once = Once(c)
            if let maxMs {
                once.sleeper = Task.detached {
                    try? await Task.sleep(nanoseconds: UInt64(max(maxMs, 0)) * 1_000_000)
                    once.fire()
                }
            }
            enqueue.yield(.marker { once.fire() })
        }
    }

    /// The machine's events, handled one batch at a time and in order, off whatever thread ran the pump.
    private nonisolated func queueEvents(_ events: [SyncEvent]) {
        eventTail.with { tail in
            let prev = tail
            tail = Task {
                await prev?.value
                await self.onEvents(events)
            }
        }
    }

    /// Wait for the batches the machine has raised so far (safe inside a handler).
    private func drainEvents() async { await eventTail.current?.value }

    // MARK: identity (A-1, A-2, A-4)

    private func onIdentityNow(_ change: IdentityChange) async {
        await attach()
        guard let h = hostValue, await h.isStarted else { return }
        switch change.kind {
        case IdentityChange.signedIn, IdentityChange.subjectChanged:
            if let target = change.subject {
                // A sign-in the person completes in this run lifts a refusal; a changed subject does not.
                if target != subject { await signIn(target, fresh: change.kind == IdentityChange.signedIn) }
            } else {
                // A readable "no session": the principal is gone with the account.
                await h.clearRefused()
                if subject != nil { await leave() }
            }
        case IdentityChange.signedOut:
            // A sign-out that happened elsewhere (the hook already left when it was ours).
            await h.clearRefused()
            if subject != nil { await leave() }
        default: break
        }
    }

    /// `fresh`: the person completed this sign-in during this run (an identity change), not the account read
    /// at launch.
    private func signIn(_ target: String, fresh: Bool = false) async {
        let h = host()
        guard await h.isStarted else { return }
        // The Worker took this subject's account away: a sign-out, another subject or a sign-in the person
        // completes now lifts it; the account replayed at launch does not.
        if await h.refused == target {
            if !fresh { return }
            await h.clearRefused()
        }
        // The earlier key ring is not gone yet: nothing signs in until it is.
        if !(await retryForget()) { return }
        // Another person: the first leaves (unsynced edits dropped, then forgotten) before this one
        // starts. The device credential is already the new person's, so nothing is sent for the old one.
        if let old = subject, old != target { await signOutNow() }
        // Once per install, before the first principal arrives so the values enter at the floor and a
        // newer cloud value wins. The marker is written after the sign-in succeeded (A-6).
        let importing = !FileManager.default.fileExists(atPath: importMarker.path)
        if importing { _ = await h.importLocal(await config.importable()) }
        subject = target
        do { _ = try await h.signIn(target) } catch {
            subject = nil
            return
        }
        personSignedIn()
        if importing {
            try? FileManager.default.createDirectory(
                at: importMarker.deletingLastPathComponent(), withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            try? Data("{\"v\":1}".utf8).write(to: importMarker, options: .atomic)
        }
        // Not the whole pump: sign-out and the release hook never wait behind a slow Worker (S-3).
        Task { await h.touch() }
        await settle()
    }

    /// The person changed: never talks to the server. Unsynced edits are discarded and the old synced
    /// values leave memory before anything waits.
    private func signOutNow() async {
        let h = host()
        subject = nil
        await h.signOut(discardUnsynced: true)
        await h.touch()
        await drainEvents()
        await settle()
    }

    /// The device was released or the identity is gone: leave the principal without a flush.
    private func leave() async {
        let h = host()
        subject = nil
        await h.signOut(discardUnsynced: true)
        await h.touch()
        await drainEvents()
        await settle()
    }

    /// The release hook: the principal is gone with the device. Leaves, forgets the ring (a failure
    /// stops the release), purges.
    func beforeRelease() async throws {
        await drain()
        await drainEvents()
        if let h = hostValue, await h.isStarted, subject != nil { await leave() }
        if let failure = await forgetAndPurge() { throw failure }
    }

    /// The identity client's pre-sign-out hook (the old token is still current): bounded flush, the
    /// machine's sign-out, then the ring forgets and the data is purged (A-3).
    func beforeSignOut() async throws {
        // Bounded like the flush: a consumer stuck behind a slow Worker never holds the sign-out (S-3).
        let began = Date()
        await drain(maxMs: SYNC_SIGNOUT_FLUSH_MS)
        let left = max(0, SYNC_SIGNOUT_FLUSH_MS - Int(Date().timeIntervalSince(began) * 1000))
        explicitForget = true
        defer { explicitForget = false }
        if let h = hostValue, await h.isStarted { await h.clearRefused() }
        let who = subject
        if let h = hostValue, await h.isStarted, who != nil {
            await h.signOut()
            await h.flush(maxMs: max(left, 500))
            await drainEvents()
        }
        subject = nil
        do { try await forgetPerson() } catch {
            // D-13: a ring that cannot forget stops the sign-out and the person stays signed in: nothing
            // is purged, and Cloud Sync is signed in again for them.
            if let who { await signIn(who) }
            throw error
        }
        await purge()  // a purge failure is reported (`purgeFailed`) and never replaces anything
    }

    /// The release hook's chain: forget the ring, then purge. Each is tried whatever the other did; a
    /// forget failure is returned (it stops the release), a purge failure is reported and never replaces it.
    private func forgetAndPurge() async -> (any Error)? {
        var failure: (any Error)?
        do { try await forgetPerson() } catch { failure = error }
        await purge()
        return failure
    }

    /// The person's keys and saves leave in this order: the ring locks (the root leaves memory, and a save
    /// codec stops with it), the save transfers are purged (journal, chunk cache, waiting writes), then the
    /// root and the pin are removed. A removal that fails throws; the earlier steps are not undone.
    private func forgetPerson() async throws {
        try await Self.forgetInOrder(lock: lockRing, purgeSaves: purgeSaves, forget: forgetRing)
    }

    /// The lock step of a forget: the background channel is closed first, so nothing sealed under the root
    /// goes out once the ring is locked.
    static func lockClosingBackground(
        closeBackground: @Sendable () async -> Void, lockRing: @Sendable () async -> Void
    ) async {
        await closeBackground()
        await lockRing()
    }

    static func forgetInOrder(
        lock: @Sendable () async -> Void, purgeSaves: @Sendable () async -> Void,
        forget: @Sendable () async throws -> Void
    ) async throws {
        await lock()
        await purgeSaves()
        try await forget()
    }

    private func saveBlocked(_ refused: String?, pending: Bool) async {
        guard let h = hostValue else { return }
        do { try await h.saveBlocked(subject: refused, forgetPending: pending) } catch { emit(.purgeFailed) }
    }

    /// Try again to remove a pin an earlier blocked state left; true when none is left.
    private func retryForget() async -> Bool {
        guard let h = hostValue, await h.forgetPending else { return true }
        await lockRing()
        do { try await forgetRing() } catch {
            log("cloud sync: the key ring pin could not be removed")
            return false
        }
        await h.settleForget()
        return true
    }

    /// A key-ring or file route answered `account_required` (WIRE-CONTRACT-V5 section 11.5): the machine takes
    /// the same transition as for a `/sync` 403. `signInUrl` is the answer's, unvetted; it is vetted on the way
    /// out like every offer. `forSubject` is who was signed in when the call started: the answer is ignored if
    /// the machine's person is another by now. Never throws into the route that saw it.
    func accountRequired(signInUrl: String?, forSubject: String?) async {
        await attach()
        guard let h = hostValue, await h.isStarted else { return }
        // A late answer for a person who has gone says nothing about the one signed in now.
        guard forSubject == subject else { return }
        await h.accountRequired(signInUrl: signInUrl)
        await drainEvents()
        await settle()
    }

    private func purge() async {
        do { try await host().purge() } catch { emit(.purgeFailed) }
    }

    // MARK: the machine's events (A-4, A-5)

    private func onEvents(_ events: [SyncEvent]) async {
        let leftReasons = events.compactMap { e -> SyncSignedOutReason? in
            if case .signedOut(let r, _) = e { return r }
            return nil
        }
        let left = !leftReasons.isEmpty
        // The root leaves memory before anything else runs.
        var forgotten: Task<Void, Never>?
        // `account_required` keeps the machine as it stands (blocked, partition gone) instead of purging it.
        let blocked = leftReasons.contains(.accountRequired)
        let was = subject
        if left && !explicitForget { forgotten = startForget(keeping: blocked ? .some(was) : nil) }
        let origin = config
        for e in events {
            switch e {
            case .signedOut: subject = nil
            case .change(let keys, let o): await origin.noteSyncChange(keys: keys, origin: o)
            default: break
            }
            if case .signInOffered = e, left { continue }  // offered below, after the forget
            if case .signInOffered(let url) = e {
                emit(.signInOffered(signInUrl: safeSignInUrl(url, origin: originString)))
                continue
            }
            if let event = CloudSyncEvent(e) { emit(event) }
        }
        if let forgotten {
            await forgotten.value
            let offers = events.compactMap { e -> String?? in
                if case .signInOffered(let u) = e { return .some(u) }
                return nil
            }
            let wants = leftReasons.contains { $0 == .accountRequired || $0 == .subjectChanged }
            if wants || !offers.isEmpty {
                for u in offers.isEmpty ? [nil] : offers {
                    emit(.signInOffered(signInUrl: safeSignInUrl(u ?? nil, origin: originString)))
                }
            }
        }
    }

    private nonisolated var originString: String {
        let b = core.endpoints.baseUrl
        guard let u = URL(string: b), let scheme = u.scheme, let host = u.host else { return b }
        return "\(scheme)://\(host)" + (u.port.map { ":\($0)" } ?? "")
    }

    /// Ring first, then the purge; single-flight so two events never forget twice at once.
    /// With `keeping` (after `account_required`; the subject the Worker refused) the machine is saved as it
    /// stands, so its status is still `blocked` after a relaunch; every other leave purges it.
    private func startForget(keeping refused: String??) -> Task<Void, Never> {
        if let t = forgetTask { return t }
        let t = Task {
            if let refused {
                // The ring locks and the saves go first; then the state says the pin is pending before the
                // pin is tried, so a crash cannot lose that.
                await self.lockRing()
                await self.purgeSaves()
                await self.saveBlocked(refused, pending: true)
                do {
                    try await self.forgetRing()
                    await self.settleForget()
                } catch {
                    self.log("cloud sync: the key ring pin could not be removed")
                }
            } else {
                do { try await self.forgetPerson() } catch {
                    self.log("cloud sync: the key ring pin could not be removed")
                }
                await self.purge()
            }
            self.forgetDone()
        }
        forgetTask = t
        return t
    }

    private func forgetDone() { forgetTask = nil }

    private func settleForget() async { await hostValue?.settleForget() }

    /// Wait for a forget the machine's events started.
    private func settle() async {
        if let t = forgetTask { await t.value }
    }

    // MARK: the config port

    fileprivate func activeHost() async -> CloudSyncHost? {
        guard let h = hostValue, await h.isStarted, subject != nil else { return nil }
        return h
    }
}

/// The config client's port onto the machine.
struct SyncPort: ConfigSyncPort {
    let api: CloudSyncApi

    func active() async -> Bool { await api.activeHost() != nil }

    func set(_ key: String, _ value: JSONValue) async -> CallResult {
        guard let h = await api.activeHost() else { return .failed("signed-out") }
        // A document that changed since the machine was built is routed first (A-6).
        await h.refreshDocumentIfChanged()
        let r = await h.set(key, value)
        // One pump reports the edit's events (nothing is due before the debounce); the call does not
        // wait for it (S-3).
        Task { await h.touch() }
        return r
    }

    func clear(_ key: String) async -> CallResult {
        guard let h = await api.activeHost() else { return .failed("signed-out") }
        await h.refreshDocumentIfChanged()
        let r = await h.clear(key)
        Task { await h.touch() }
        return r
    }

    func get(_ key: String) async -> SyncEffectiveValue? { await api.activeHost()?.get(key) }

    func state(_ key: String) async -> SettingSyncState {
        await api.activeHost()?.settingState(key)?.sync ?? .local
    }
}

/// The registry's way to the machine: the started host, if any.
struct ApiMergePort: MergeMachinePort {
    let api: CloudSyncApi

    func keep(_ id: String, _ choice: MergeKeep) async -> CallResult {
        guard let h = await api.hostIfStarted() else { return .failed(ErrorCode.syncMergeClosed) }
        return await h.mergeKeep(id, choice)
    }

    func snapshot() async -> [SyncMachineConflict]? {
        guard let h = await api.hostIfStarted() else { return nil }
        return await h.mergeSnapshot()
    }
}
