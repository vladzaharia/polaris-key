// The Cloud Sync host (U-07.6): the first production host of `CloudSyncMachine`. A port of Python's
// `cloud_sync/host.py` and Node's `cloudSync/host.ts`, with every SEC-SYNC-HOST fix. The machine does no
// I/O; this actor is everything around it:
//
//  - one machine per client, built from app code (`CloudSyncOptions.encryption`, default `.e2e`), the
//    discovery `services.sync` member, the key ring (`attach`) and the product catalog;
//  - H-1: the app's compiled mirror is authoritative. A served catalog is vetted (key pattern, 1024
//    entries, 1 MiB, one entry per key); it only adds routes for keys in neither the mirror nor the
//    person's open settings, and the served `cloudSync.encryption` is dropped (A-7: the app decides);
//  - H-2: the catalog is fetched again when a pull names another `catalogVersion`, at most every five
//    minutes, an equal rebuild is skipped, and the fetch counts against the pump's budget;
//  - H-3, H-4: every request goes through `CloudSyncTransport` (bearer, `X-PKey-*`, no redirect, 8 MiB
//    cap, 15 s); in E2E mode through `HostCodec` on the way out and in;
//  - H-5: open-setting names are noted only from rows this host opened sealed and from its own mutations,
//    at most 4096;
//  - H-6: the journal is written to `<state dir>/cloud-sync.json` (`CloudSyncStateFile`);
//  - H-10: a locked ring sends and reads nothing and the host adds no request of its own; a 200 that is
//    not an object in E2E mode is dropped; an answer the codec cannot open (locked since the request
//    left, or a repeated `mutationId`) is dropped and the cursor stays.
//  - HOST-BIND (A-1): each request is bound to the person the machine held when it was taken. A request
//    whose bound person is known and differs from the session's person, before the send or after the
//    answer, is dropped: nothing is sent, or the answer is not read.
//
// One pump runs at a time: the host is an actor and every `await` re-enters, so the pump checks a
// generation counter after each exchange before `receive` and before saving. A `touch` that arrives
// during a pump sets `again` and returns; the pump runs once more. The machine is not `Sendable` and
// never leaves this actor. No value, root or key material is logged, put in an error or printed.
//
// Bounds (U-07.7): H-7 `purge`, H-8 re-entrancy, H-9 `flush(maxMs)`, `close()` and the lifecycle flush.
// Nothing in the licence path imports this file.

import Foundation
import PolarisKeyCore

#if canImport(UIKit)
    import UIKit
#endif
#if canImport(AppKit)
    import AppKit
#endif

/// What app code sets. Never read from the Worker.
public struct CloudSyncOptions: Sendable {
    /// The product's mode. Default `.e2e`. An app that says `.server` still refuses a Worker it has
    /// seen speak E2E (the machine's pin).
    public var encryption: SyncEncryption
    /// The catalog compiled into the app (`pkey mirror`): used until `/config/schema` has been fetched
    /// once, and authoritative for every key it names.
    public var catalog: JSONValue?
    /// Renames the app declares (old name to current name). Never taken from a served body.
    public var aliases: [String: String]

    public init(encryption: SyncEncryption = .e2e, catalog: JSONValue? = nil, aliases: [String: String] = [:]) {
        self.encryption = encryption
        self.catalog = catalog
        self.aliases = aliases
    }
}

/// What the host needs from the client; each is a function so the host holds no stale copy.
public struct CloudSyncHostDeps: Sendable {
    public var product: String
    public var stateDir: URL
    /// One exchange (`CloudSyncTransport.send`).
    public var send: @Sendable (SyncRequest) async -> SyncResponse
    public var codec: any SyncCodecPort
    public var keyringUnlocked: @Sendable () -> Bool
    public var attachKeyring: @Sendable (any SyncRootListener) -> @Sendable () -> Void
    /// Whether the product runs Cloud Sync (discovery or the build's declaration).
    public var syncEnabled: @Sendable () async -> Bool
    /// `services.sync.encryption` from the loaded discovery document; nil: not loaded or Sync off.
    public var discovery: @Sendable () async -> SyncAdvertised?
    /// `GET /config/schema` (diagnostic and unsigned; nil on any failure).
    public var fetchSchema: @Sendable () async -> JSONValue?
    /// The signed config document's values and the keys it locks.
    public var document: @Sendable () async -> SyncMachineDocument
    /// The person the session's token belongs to; nil when unknown (offline, discovery not loaded).
    public var subject: @Sendable () async -> String?
    /// The clock, in epoch milliseconds.
    public var clock: @Sendable () -> Int

    public init(
        product: String, stateDir: URL, send: @escaping @Sendable (SyncRequest) async -> SyncResponse,
        codec: any SyncCodecPort, keyringUnlocked: @escaping @Sendable () -> Bool,
        attachKeyring: @escaping @Sendable (any SyncRootListener) -> @Sendable () -> Void,
        syncEnabled: @escaping @Sendable () async -> Bool = { true },
        discovery: @escaping @Sendable () async -> SyncAdvertised? = { nil },
        fetchSchema: @escaping @Sendable () async -> JSONValue? = { nil },
        document: @escaping @Sendable () async -> SyncMachineDocument = { SyncMachineDocument() },
        subject: @escaping @Sendable () async -> String? = { nil },
        clock: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.product = product
        self.stateDir = stateDir
        self.send = send
        self.codec = codec
        self.keyringUnlocked = keyringUnlocked
        self.attachKeyring = attachKeyring
        self.syncEnabled = syncEnabled
        self.discovery = discovery
        self.fetchSchema = fetchSchema
        self.document = document
        self.subject = subject
        self.clock = clock
    }

    /// The client's own wiring: its transport, directories, discovery document and key ring. The
    /// schema fetch, the config document and the session's person come from the caller.
    public static func live(
        core: CoreContext, keyring: SyncKeyring,
        fetchSchema: @escaping @Sendable () async -> JSONValue?,
        document: @escaping @Sendable () async -> SyncMachineDocument,
        subject: @escaping @Sendable () async -> String?
    ) -> CloudSyncHostDeps {
        let transport = CloudSyncTransport(core: core)
        return CloudSyncHostDeps(
            product: core.product, stateDir: core.dirs.state, send: { await transport.send($0) },
            codec: keyring.codec, keyringUnlocked: { keyring.unlocked }, attachKeyring: { keyring.attach($0) },
            syncEnabled: {
                #if canImport(FoundationNetworking)
                    // S-4: this build cannot refuse a redirect or stream under the body cap; Cloud Sync is off.
                    return false
                #else
                    return await core.enabled(.sync)
                #endif
            },
            discovery: {
                guard let f = await core.discoveryDocument?.services[.sync], f.enabled else { return nil }
                switch f.extras["encryption"] {
                case .string("e2e")?: return .e2e
                case .string("server")?: return .server
                default: return .omitted
                }
            },
            fetchSchema: fetchSchema, document: document, subject: subject)
    }
}

/// What the key ring is attached with: it records the root, and the host applies it at the next pump
/// (the ring calls this under its own lock, so nothing here may wait on the host).
private final class RootFeed: SyncRootListener, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: Bool?
    private var armed = false
    private let wake: @Sendable () -> Void

    init(wake: @escaping @Sendable () -> Void) { self.wake = wake }

    func setRoot(present: Bool) {
        let go = lock.withLock { () -> Bool in
            pending = present
            return armed
        }
        if go { wake() }
    }

    /// Ends the build: the initial answer the ring gave during `attach` is already in `hasRoot`.
    func arm() {
        lock.withLock {
            pending = nil
            armed = true
        }
    }

    func take() -> Bool? {
        lock.withLock { () -> Bool? in
            defer { pending = nil }
            return pending
        }
    }
}

public actor CloudSyncHost {
    /// How often the real-clock timer wakes the machine while it holds work (ms).
    public static let tickMs = 250
    /// The most exchanges one pump makes, whatever the machine keeps asking for.
    public static let maxExchanges = 64
    /// The most entries and bytes of a catalog the host will route by (H-1).
    public static let maxCatalogEntries = 1024
    public static let maxCatalogBytes = 1024 * 1024
    /// A served catalog is fetched again at most this often (H-2; the first fetch is free).
    public static let catalogRefetchMs = 5 * 60_000

    private let deps: CloudSyncHostDeps
    private let options: CloudSyncOptions
    private let file: CloudSyncStateFile
    private var machine: CloudSyncMachine?
    private var detach: (@Sendable () -> Void)?
    private var feed: RootFeed?
    /// Bumped whenever the machine is replaced: an exchange in flight checks it after every `await`.
    private var generation = 0
    private var mirror: JSONValue?
    private var served: JSONValue?
    private var catalog: JSONValue = emptyCatalog
    private var routes: [SettingRoute] = []
    private var lastFetchAt: Int?
    private var used = 0
    private var openKeys: [String] = []
    private var documentJSON = ""
    private var triedCatalogVersion: Int?
    private var rebuildWanted = false
    private var again = false
    /// The pump in progress, if any: one at a time; `flush`, `purge` and `close` wait on it, bounded.
    private var pumpTask: Task<Void, Never>?
    /// How long `purge` and `close` wait for a pump in progress (ms).
    var pumpWaitMs = 2000
    private var observers: [(center: NotificationCenter, token: any NSObjectProtocol)] = []
    private var timer: Task<Void, Never>?
    private var started = false
    private var closed = false
    /// After a purge the journal stays unsaved until a principal signs in again.
    private var purged = false
    /// Purges in progress: the machine is gone and touch, rebuild and sign-in wait for the end (S-2).
    private var purging = 0
    private var purgeWaiters: [CheckedContinuation<Void, Never>] = []
    private var listeners: [(id: Int, fn: @Sendable ([SyncEvent]) -> Void)] = []
    private var nextListener = 0

    private static let emptyCatalog: JSONValue = .object(["schemaVersion": .int(0), "entries": .array([])])

    public init(deps: CloudSyncHostDeps, options: CloudSyncOptions = CloudSyncOptions()) {
        self.deps = deps
        self.options = options
        self.file = CloudSyncStateFile(stateDir: deps.stateDir, product: deps.product)
    }

    // MARK: basics

    public var isStarted: Bool { started && !closed }

    /// Subscribe to the machine's events (batches, in order). Returns the id for `removeListener`.
    @discardableResult
    public func onEvents(_ fn: @escaping @Sendable ([SyncEvent]) -> Void) -> Int {
        nextListener += 1
        listeners.append((nextListener, fn))
        return nextListener
    }

    public func removeListener(_ id: Int) { listeners.removeAll { $0.id == id } }

    // MARK: start

    /// Load the saved journal and catalog, build the machine, attach it to the key ring and run a
    /// first pump. Idempotent. Makes no request unless a catalog has to be fetched (none cached and
    /// none compiled in).
    public func start() async throws {
        if started || closed { return }
        started = true
        let saved = file.load()
        openKeys = saved.openKeys
        mirror = Self.vetted(options.catalog)
        // N-1: a served catalog is never persisted; the mirror is authoritative and a fresh start asks
        // the Worker again when there is no mirror.
        served = nil
        try await build(saved.persisted)
        if options.catalog == nil {
            used = 0
            await refetchCatalog(nil)
        }
        await touch()
    }

    /// The routes' catalog: the mirror as it is, plus served entries only for keys the mirror does not
    /// name and the person's own open settings do not use. The Worker's catalog never changes a route
    /// the app compiled in, and never turns an open setting into a declared one (H-1).
    private func effective() -> JSONValue {
        let mirrorEntries = mirror?.objectValue?["entries"]?.arrayValue ?? []
        var taken = Set(mirrorEntries.compactMap { $0.objectValue?["key"]?.stringValue })
        taken.formUnion(openKeys)
        let extra = (served?.objectValue?["entries"]?.arrayValue ?? []).filter {
            $0.objectValue?["key"]?.stringValue.map { !taken.contains($0) } ?? false
        }
        var base = (mirror ?? served ?? Self.emptyCatalog).objectValue ?? [:]
        base["schemaVersion"] = (served ?? mirror)?.objectValue?["schemaVersion"] ?? .int(0)
        base["entries"] = .array(mirrorEntries + extra)
        return .object(base)
    }

    /// The routes of a catalog, without any mode the catalog states (the app decides the mode).
    private static func routesOf(_ catalog: JSONValue) -> [SettingRoute] {
        syncedSettings(catalog).map {
            var r = $0
            r.encryption = nil
            return r
        }
    }

    /// A catalog fit to route by: the right shape and size, every entry key a valid sync key, and one
    /// entry per key. nil when it is not.
    static func vetted(_ c: JSONValue?) -> JSONValue? {
        guard isCatalogShape(c), case .object(var o)? = c, case .array(let list)? = o["entries"],
            list.count <= maxCatalogEntries, let data = try? JSONEncoder().encode(c), data.count <= maxCatalogBytes
        else { return nil }
        var seen = Set<String>()
        var entries: [JSONValue] = []
        for e in list {
            guard let k = e.objectValue?["key"]?.stringValue,
                k.range(of: SYNC_KEY_PATTERN, options: .regularExpression) != nil, seen.insert(k).inserted
            else { continue }
            entries.append(e)
        }
        o["entries"] = .array(entries)
        return .object(o)
    }

    /// (Re)build the machine from the journal, the catalog and the document. Both awaits come FIRST;
    /// the snapshot (`fromCurrent`: the machine now held) and the new machine are made with no
    /// suspension between them, so an edit accepted while the awaits ran is in the snapshot (S-1). A
    /// build that finds the generation moved (a purge, another build) installs nothing and answers
    /// false.
    @discardableResult
    private func build(_ persisted: SyncMachineState?, fromCurrent: Bool = false) async throws -> Bool {
        let gen = generation
        let document = await deps.document()
        let advertised = await deps.discovery()
        guard generation == gen, !closed else { return false }
        var snapshot = persisted
        if fromCurrent, let old = machine {
            snapshot = old.persist()
            emit(old)
        }
        detach?()
        detach = nil
        catalog = effective()
        routes = Self.routesOf(catalog)
        documentJSON = Self.dump(document)
        var o = SyncMachineOptions(
            product: deps.product, catalog: SyncMachineCatalog(settings: routes), document: document,
            now: deps.clock(), newClientId: { "c_" + Base64URL.encode(SyncCrypto.random(16)) })
        o.encryption = options.encryption
        o.hasRoot = deps.keyringUnlocked()
        o.discovery = advertised
        let m = try CloudSyncMachine(o, persisted: snapshot)
        machine = m
        generation += 1
        let f = RootFeed(wake: { [weak self] in Task { await self?.touch() } })
        feed = f
        detach = deps.attachKeyring(f)
        f.arm()
        return true
    }

    private static func dump(_ document: SyncMachineDocument) -> String {
        (jsonCanonical(.object(document.values)) ?? "") + "|" + document.locked.sorted().joined(separator: ",")
    }

    // MARK: the client's calls

    /// Discovery just loaded: tell the machine what `services.sync` says.
    public func noteDiscovery() async {
        guard let m = machine else { return }
        let advertised = await deps.discovery()
        if let advertised, machine === m { m.setDiscovery(advertised) }
        await touch()
    }

    /// The signed config document refreshed: lift a block, and rebuild if the document changed.
    public func noteDocumentRefreshed() async {
        guard let m = machine else { return }
        _ = m.refresh()
        if Self.dump(await deps.document()) != documentJSON { rebuildWanted = true }
        await touch()
    }

    /// Bring the machine's clock to the real one, so an edit made now is stamped and debounced from now.
    public func catchUp() {
        guard let m = machine else { return }
        let dt = deps.clock() - m.clockNow
        if dt > 0 { m.advance(dt) }
    }

    public func signIn(_ subject: String) async throws -> CallResult {
        // A purge that is still running ends first, so the new person's machine is not replaced under it.
        if purging > 0 { await withCheckedContinuation { purgeWaiters.append($0) } }
        guard let m = machine else { return .failed("not-started") }
        purged = false
        return try m.signIn(subject)
    }

    @discardableResult
    public func signOut(discardUnsynced: Bool = false) -> CallResult {
        machine?.signOut(discardUnsynced: discardUnsynced) ?? .failed("not-started")
    }

    public func set(_ key: String, _ value: JSONValue) -> CallResult {
        guard let m = machine else { return .failed("not-started") }
        catchUp()
        let r = m.set(key, value)
        armTimer()
        return r
    }

    public func clear(_ key: String) -> CallResult {
        guard let m = machine else { return .failed("not-started") }
        catchUp()
        let r = m.clear(key)
        armTimer()
        return r
    }

    /// The person the machine is signed in as; nil while signed out or not started.
    public func machineSubject() -> String? { machine?.subject }

    /// Offer the legacy local values to the machine (once per install; the caller keeps the marker).
    public func importLocal(_ values: [String: JSONValue]) -> CallResult {
        machine?.importLocal(values) ?? .failed("not-started")
    }

    /// A document that changed since the machine was built is routed through a rebuild first, so the
    /// locked list the machine checks is the current one (A-6). A no-op when nothing changed.
    public func refreshDocumentIfChanged() async {
        guard let m = machine else { return }
        _ = m.refresh()
        if Self.dump(await deps.document()) != documentJSON {
            rebuildWanted = true
            await touch()
        }
    }

    public func get(_ key: String) -> SyncEffectiveValue? { machine?.get(key) }
    public func settingState(_ key: String) -> SyncSettingState? { machine?.settingState(key) }
    public func status() -> SyncStatus? { machine?.status() }

    /// The routes the machine uses now (for tests and diagnostics: keys and routes only).
    public func routeKeys() -> [String] { routes.map(\.key) }
    func routeTable() -> [SettingRoute] { routes }
    func generationCount() -> Int { generation }
    func encryptionMode() -> SyncEncryption? { machine?.encryptionMode }
    func cursor() -> Int? { machine?.persist().partitions[machine?.subject ?? syncLocalPartition]?.cursor }
    func setPumpWait(_ ms: Int) { pumpWaitMs = ms }
    func noteOpenKeyForTest(_ name: String) { addOpenKey(name) }
    /// The open-setting names held for tombstone mapping.
    public func openKeyNames() -> [String] { openKeys }

    // MARK: the pump

    /// Run the machine now: advance its clock, exchange every queued request, save. Never throws.
    /// A touch that arrives while a pump runs sets `again` and returns at once (H-8): the running pump
    /// goes round once more, so no wake-up is lost and no second pump starts.
    public func touch() async {
        guard started, !closed, purging == 0, await deps.syncEnabled() else { return }
        if pumpTask != nil {
            again = true
            return
        }
        await startPump().value
    }

    /// Start the one pump task. Called only while none runs.
    private func startPump() -> Task<Void, Never> {
        let t = Task { await self.runPumps() }
        pumpTask = t
        return t
    }

    private func runPumps() async {
        while true {
            await pump()
            // No suspension between this check and clearing the task: a touch that lands as the pump
            // ends either set `again` before the check or starts a pump of its own after (H-9).
            if !again || closed { break }
        }
        pumpTask = nil
        armTimer()
    }

    private func pump() async {
        used = 0
        repeat {
            again = false
            if rebuildWanted { await rebuild() }
            guard let m = machine else { return }
            let gen = generation
            if let present = feed?.take() { m.setRoot(present) }
            let dt = deps.clock() - m.clockNow
            if dt > 0 { m.advance(dt) }
            while used < Self.maxExchanges {
                let reqs = m.takeRequests()
                // Bound at take time, in the same step that queued them.
                let bound = m.subject
                if reqs.isEmpty { break }
                for req in reqs {
                    used += 1
                    await exchange(m, req, bound: bound, gen: gen)
                    if generation != gen { return }
                }
            }
            emit(m)
        } while again && used < Self.maxExchanges && !closed
        // Saving commits the debounced edits (`persist()`), so a pump that exchanged nothing leaves the
        // file alone and an edit keeps its debounce window.
        if used > 0 { save() }
    }

    /// Hand the machine its answer, unless the machine it was for is gone or no longer waits.
    private func receive(_ m: CloudSyncMachine, _ gen: Int, _ res: SyncResponse, _ opened: SyncOpenedBody? = nil) {
        guard generation == gen, machine === m, m.awaitingAnswer else { return }
        do { try m.receive(res, opened: opened) } catch { /* a host-made id is always valid */  }
    }

    /// One request: seal it (E2E), send it, open the answer, hand both to the machine.
    private func exchange(_ m: CloudSyncMachine, _ req: SyncRequest, bound: String?, gen: Int) async {
        let codec = deps.codec
        let e2e = m.encryptionMode == .e2e
        // H-10: a locked ring sends nothing, a pull included.
        if e2e && codec.locked { return receive(m, gen, .transport) }
        // HOST-BIND: this request belongs to `bound`; the session now belongs to someone else.
        if await otherPerson(bound) { return receive(m, gen, .transport) }
        guard generation == gen, machine === m else { return }

        var wire = req
        var mutations: [JSONValue] = []
        if req.method == .post {
            if case .object(let b)? = req.body, case .array(let list)? = b["mutations"] { mutations = list }
            noteOpenKeys(mutations)
            if e2e, let body = req.body {
                do {
                    wire = SyncRequest(
                        method: .post, path: req.path,
                        body: try HostCodec.sealPush(body, codec: codec, routes: routes))
                } catch {
                    // Locked, or a mutation that cannot be sealed: nothing is sent.
                    return receive(m, gen, .transport)
                }
            }
        }

        let res = await deps.send(wire)
        guard generation == gen, machine === m else { return }
        // The answer to a request made for another person is not read.
        if await otherPerson(bound) { return receive(m, gen, .transport) }
        guard generation == gen, machine === m else { return }

        guard case .answer(let status, let body) = res, status == 200, case .object? = body else {
            // E2E and a 200 that is not an object: dropped. Otherwise server mode, an error answer or
            // no answer: the machine reads it as it is.
            if e2e, case .answer(200, _) = res { return receive(m, gen, .transport) }
            return receive(m, gen, res)
        }
        if !e2e { return receive(m, gen, res) }
        let pulled: SyncOpenedPull
        do {
            pulled = try HostCodec.openPull(
                body!, codec: codec, mutations: mutations, aliases: options.aliases, openKeys: openKeys)
        } catch {
            // Locked since the request left, or a repeated mutationId: the answer is dropped and the
            // cursor stays.
            return receive(m, gen, .transport)
        }
        // A purge or rebuild since the request left: the old person's names go nowhere.
        guard generation == gen, machine === m else { return }
        noteOpenedKeys(pulled)
        receive(m, gen, .answer(status: 200, body: pulled.body), pulled.opened)
        await maybeRefetch(pulled.body)
    }

    /// The bound person is known, the session's person is known, and they differ.
    private func otherPerson(_ bound: String?) async -> Bool {
        guard let bound, let current = await deps.subject() else { return false }
        return bound != current
    }

    // MARK: the catalog

    /// A pull that names another `catalogVersion` than the catalog held: fetch it again, once (H-2).
    private func maybeRefetch(_ body: JSONValue) async {
        guard let v = syncNumber(body.objectValue?["catalogVersion"]) else { return }
        let held = syncNumber(catalog.objectValue?["schemaVersion"])
        if v == held || Int(exactly: v) == triedCatalogVersion { return }
        await refetchCatalog(Int(exactly: v))
    }

    private func refetchCatalog(_ version: Int?) async {
        let now = deps.clock()
        // Rate-limited, and counted in the pump's budget like any other request.
        if used >= Self.maxExchanges || (lastFetchAt.map { now - $0 < Self.catalogRefetchMs } ?? false) { return }
        lastFetchAt = now
        triedCatalogVersion = version
        used += 1
        let gen = generation
        guard let fetched = Self.vetted(await deps.fetchSchema()), generation == gen else { return }
        if jsonCanonical(fetched) == served.flatMap(jsonCanonical) { return }
        let before = Self.routesOf(catalog)
        served = fetched
        // Rebuild only when the routes the machine uses would change.
        let effective = effective()
        if Self.routesOf(effective) == before {
            catalog = effective
            return
        }
        rebuildWanted = true
        again = true
    }

    /// New catalog or document: the machine is rebuilt from its own journal (never mid-request).
    private func rebuild() async {
        rebuildWanted = false
        guard machine != nil, purging == 0 else { return }
        guard (try? await build(nil, fromCurrent: true)) == true else { return }
        save()
    }

    // MARK: open keys (H-5)

    private func isDeclared(_ name: String) -> Bool { routes.contains { $0.key == name } }

    /// Own mutations: a setting that is not declared is an open key.
    private func noteOpenKeys(_ mutations: [JSONValue]) {
        for mu in mutations {
            if case .string(let s)? = mu.objectValue?["target"]?.objectValue?["setting"], !isDeclared(s) {
                addOpenKey(s)
            }
        }
    }

    /// Names from rows this host opened (`sealed`): a served name, an unopened row or a plaintext row
    /// never enters the set, so a Worker cannot fill it to push real names out.
    private func noteOpenedKeys(_ pulled: SyncOpenedPull) {
        guard case .array(let list)? = pulled.body.objectValue?["changes"] else { return }
        for (i, c) in list.enumerated() {
            guard i < pulled.opened.changes.count, pulled.opened.changes[i]?.sealed == true,
                case .string(let s)? = c.objectValue?["setting"], !isDeclared(s)
            else { continue }
            addOpenKey(s)
        }
    }

    private func addOpenKey(_ name: String) {
        openKeys.removeAll { $0 == name }
        openKeys.append(name)
        if openKeys.count > cloudSyncOpenKeysMax { openKeys.removeFirst(openKeys.count - cloudSyncOpenKeysMax) }
    }

    // MARK: events and state

    private func emit(_ m: CloudSyncMachine) {
        let events = m.takeEvents()
        if events.isEmpty { return }
        for l in listeners { l.fn(events) }
    }

    /// Persist the journal. Committing the debounced edits is what `persist()` does by contract. The
    /// file never holds the root.
    private func save(_ persisted: SyncMachineState? = nil) {
        guard !purged, let m = machine else { return }
        let snapshot = persisted ?? m.persist()
        // A failure to persist never fails the call that produced it.
        try? file.save(CloudSyncFile(persisted: snapshot, catalog: nil, openKeys: openKeys))
    }

    // MARK: bounds: flush, purge, close (H-7, H-9)

    /// Wait for `t`, but for at most `ms`. The wait is not cancellable by the pump, so it is a race
    /// between two tasks and whichever finishes first resumes the caller.
    private func waitBounded(_ t: Task<Void, Never>, ms: Int) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let once = Once(c)
            let sleeper = Task.detached {
                try? await Task.sleep(nanoseconds: UInt64(max(ms, 0)) * 1_000_000)
                once.fire()
            }
            once.sleeper = sleeper
            Task.detached {
                await t.value
                once.fire()
            }
        }
    }

    /// Send what is waiting and save, giving up (the journal is kept) after `maxMs`. The bound holds
    /// for the pump in progress and the trailing touch together (H-9): a pump already running is asked
    /// to go round once more, and the wait ends at the deadline whatever the network does.
    public func flush(maxMs: Int = SYNC_SIGNOUT_FLUSH_MS) async {
        guard isStarted, !purged, purging == 0, let m = machine else { return }
        catchUp()
        _ = m.flush()
        if await deps.syncEnabled() {
            if let cur = pumpTask {
                again = true
                await waitBounded(cur, ms: maxMs)
            } else if isStarted {
                await waitBounded(startPump(), ms: maxMs)
            }
        }
        save()
    }

    /// Forget the person's synced data: the machine is rebuilt empty and `cloud-sync.json`, which holds
    /// the opened snapshot in the clear, is deleted. The file goes FIRST, before anything is awaited,
    /// and the generation moves on, so a pump in flight never receives into the new machine and never
    /// saves the old snapshot again. Nothing is saved until `signIn`. Works before `start()` too (the
    /// file may predate this process). Throws only if the file could not be removed; the in-memory data
    /// is gone either way.
    public func purge() async throws {
        purged = true
        // The old machine is gone before anything is awaited (S-2): a touch, a timer or a key-ring wake
        // finds none, and a rebuild already under way finds the generation moved.
        purging += 1
        defer {
            purging -= 1
            if purging == 0 {
                let waiting = purgeWaiters
                purgeWaiters = []
                for w in waiting { w.resume() }
            }
        }
        machine = nil
        detach?()
        detach = nil
        feed = nil
        generation += 1
        var failure: (any Error)?
        do { try file.remove() } catch { failure = error }
        openKeys = []
        timer?.cancel()
        timer = nil
        if started && !closed {
            if let t = pumpTask { await waitBounded(t, ms: pumpWaitMs) }
            // Rebuilt whatever the wait found; a purge never leaves the old machine in place.
            if (try? await build(nil)) == true, let m = machine {
                _ = m.importLocal([:])
                emit(m)
            }
        }
        openKeys = []
        do { try file.remove() } catch { failure = failure ?? error }
        if let failure { throw failure }
    }

    /// Stop the timer and the lifecycle hooks, detach from the ring and save the journal. Safe to call
    /// more than once.
    public func close() async {
        if closed { return }
        let was = isStarted
        closed = true
        timer?.cancel()
        timer = nil
        for o in observers { o.center.removeObserver(o.token) }
        observers = []
        detach?()
        detach = nil
        if was, let t = pumpTask { await waitBounded(t, ms: pumpWaitMs) }
        if was { save() }
    }

    // MARK: lifecycle (Q-5: a bounded flush, no background tasks)

    /// The notifications that flush: the app entering the background, and (macOS) terminating.
    static var lifecycleNames: [(name: Notification.Name, blocking: Bool)] {
        var out: [(Notification.Name, Bool)] = []
        #if canImport(UIKit)
            out.append((UIApplication.didEnterBackgroundNotification, false))
        #endif
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
            out.append((NSApplication.willTerminateNotification, true))
        #endif
        return out
    }

    /// Flush, bounded by `SYNC_SIGNOUT_FLUSH_MS`, when the app goes to the background or terminates. The
    /// journal is on disk either way and resumes at the next launch. A terminating process would not
    /// outlive an unawaited task, so a `blocking` notification holds its poster for the bound.
    public func installLifecycleHooks(
        center: NotificationCenter = .default,
        names: [(name: Notification.Name, blocking: Bool)]? = nil
    ) {
        guard !closed else { return }
        for (name, blocking) in names ?? Self.lifecycleNames {
            let token = center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                let sem = DispatchSemaphore(value: 0)
                Task {
                    await self?.flush(maxMs: SYNC_SIGNOUT_FLUSH_MS)
                    sem.signal()
                }
                if blocking { _ = sem.wait(timeout: .now() + .milliseconds(SYNC_SIGNOUT_FLUSH_MS + 500)) }
            }
            observers.append((center, token))
        }
    }

    // MARK: the timer

    /// The real-clock timer: wake while the machine holds work (an edit waiting out its debounce, a
    /// request to retry, a sign-out flush).
    private func armTimer() {
        guard timer == nil, !closed, let m = machine else { return }
        let s = m.status()
        guard s.pending > 0, [.pending, .syncing, .paused].contains(s.state) else { return }
        timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(CloudSyncHost.tickMs) * 1_000_000)
            await self?.timerFired()
        }
    }

    private func timerFired() async {
        timer = nil
        await touch()
    }
}

/// Resumes a continuation once, from whichever of two tasks gets there first.
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<Void, Never>?
    var sleeper: Task<Void, Never>?
    init(_ c: CheckedContinuation<Void, Never>) { cont = c }
    func fire() {
        let c = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            defer { cont = nil }
            return cont
        }
        sleeper?.cancel()
        c?.resume()
    }
}
