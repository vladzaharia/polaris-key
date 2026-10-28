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
//         `signedOut` and forgets and purges once.
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

    init(_ e: SyncEvent) {
        switch e {
        case .change(let k, let o): self = .change(keys: k, origin: o)
        case .rejected(let id, let c): self = .rejected(mutationId: id, code: c)
        case .signedOut(let r, let u): self = .signedOut(reason: r, unsynced: u)
        case .unsyncedData(let c): self = .unsyncedData(count: c)
        case .signInOffered(let u): self = .signInOffered(signInUrl: u)
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
    init(api: CloudSyncApi) { self.api = api }

    /// The machine's status. `local` before Cloud Sync has started. Throws the typed `product` N/A when the
    /// product does not run the Sync service.
    public func status() async throws -> SyncStatus { try await api.status() }

    /// Send what is waiting now (bounded by the sign-out flush window), save the journal and answer the
    /// status.
    @discardableResult
    public func flush() async throws -> SyncStatus { try await api.flush() }

    /// A new recovery code for the key ring (`SyncKeyring.setRecoveryCode`). Shown once, kept nowhere.
    public func newRecoveryCode() async throws -> String { try await api.newRecoveryCode() }

    /// The recovery-code screen's model.
    public var recoveryCode: RecoveryCodeModel { RecoveryCodeModel { try await self.api.newRecoveryCode() } }
}

/// A sign-in URL fit to hand to the app: https on the Worker's origin, else nil. A path is resolved against
/// the origin; control characters and whitespace are refused before parsing.
func safeSignInUrl(_ url: String?, origin: String) -> String? {
    guard let url, let base = URL(string: origin),
        !url.unicodeScalars.contains(where: { $0.value <= 0x20 || (0x7F...0x9F).contains($0.value) }),
        let resolved = URL(string: url, relativeTo: base)?.absoluteURL,
        resolved.scheme?.lowercased() == "https", base.scheme?.lowercased() == "https",
        resolved.host?.lowercased() == base.host?.lowercased(),
        (resolved.port ?? 443) == (base.port ?? 443)
    else { return nil }
    return resolved.absoluteString
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
    private let recovery: @Sendable () async throws -> String
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
        recovery: @escaping @Sendable () async throws -> String
    ) {
        self.core = core
        self.config = config
        self.makeHost = host
        self.account = account
        self.emit = emit
        self.forgetRing = forgetRing
        self.recovery = recovery
        self.importMarker = core.dirs.state.appendingPathComponent("cloud-sync-imported.json")
        (queue, enqueue) = AsyncStream<Work>.makeStream()
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

    func newRecoveryCode() async throws -> String { try await recovery() }

    /// The person Cloud Sync is signed in as (for tests and diagnostics).
    func currentSubject() -> String? { subject }

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
        await config.useSync(SyncPort(api: self))
        await h.installLifecycleHooks()
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
                if target != subject { await signIn(target) }
            } else if subject != nil {
                // A readable "no session": the principal is gone with the account.
                await leave()
            }
        case IdentityChange.signedOut:
            // A sign-out that happened elsewhere (the hook already left when it was ours).
            if subject != nil { await leave() }
        default: break
        }
    }

    private func signIn(_ target: String) async {
        let h = host()
        guard await h.isStarted else { return }
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
        let who = subject
        if let h = hostValue, await h.isStarted, who != nil {
            await h.signOut()
            await h.flush(maxMs: max(left, 500))
            await drainEvents()
        }
        subject = nil
        do { try await forgetRing() } catch {
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
        do { try await forgetRing() } catch { failure = error }
        await purge()
        return failure
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
        if left && !explicitForget { forgotten = startForget() }
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
            emit(CloudSyncEvent(e))
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
    private func startForget() -> Task<Void, Never> {
        if let t = forgetTask { return t }
        let t = Task {
            try? await self.forgetRing()
            await self.purge()
            self.forgetDone()
        }
        forgetTask = t
        return t
    }

    private func forgetDone() { forgetTask = nil }

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
