// `update.packs` — the Swift pack facet (plans/P4-01.md §2.6–§2.9, §5; CONTENT §10, §13; P4-07).
// It is `PackEngine` with this SDK's ports:
//
//   transport  the pinned pack record from discovery's `release.endpoints.record` (through Core's
//              transport, the body capped at `MAX_RECORD_JWS_BYTES + 1`), objects from
//              `distribution.endpoints.blobs` (`{sha256}`) with `Range`/`If-Range`, streamed by
//              `URLSession` (or an injected `PackObjectTransport`); the device bearer is sent
//              only to the control plane's own origin. Any answer but 200 or 206 — a 404, or
//              P4-05's 403 `delivery_gate_missing` / `not_entitled` — is a failed fetch;
//   storage    `DirPackStorage` under the platform data directory (P1b-09), excluded from
//              backups: a versioned directory per tree payload and an atomic pointer swap in
//              `state.json`;
//   zstd       libzstd (facebook/zstd 1.5.7), after a start-up probe;
//   SHA-256    CryptoKit, streaming.
//
// The running build's pins come from its content stamp (`PacksOptions.contentStamp`, a file among
// the app's own read-only resources — `Bundle.main` — never a user-writable path): a host without
// a stamp has no packs. Embedded baselines are verified once (marker, bytes, stamp pin) and then
// count as installed. The active set's `packSetId` rides on `devices/report` as `content`.
//
// Names are client-core's (`ensure`, `state`, `registerHandler`, `on`, `packSetId`, `confirm`,
// `recoverState`, `rollback`, `bootOptions`, `bootFetch`, `zstd`, `refusedEmbedded`); the facet
// is `UpdateClient.packs`, so a host writes `update.packs.ensure(["djdl.levels"])`.

import Foundation
import PolarisKeyCore

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Where the content stamp comes from.
public enum PackStampSource: Sendable, Equatable {
    /// A file among the app's own read-only resources.
    case file(URL)
    /// Its bytes.
    case bytes([UInt8])
}

/// One embedded baseline: a single payload file (its marker beside it as `<file>.pkey.json`) or a
/// tree directory (its marker inside as `.pkey/pack.json`).
public struct EmbeddedPack: Sendable, Equatable {
    public var path: URL
    /// The marker file, when it is not at the conventional place.
    public var marker: URL?

    public init(path: URL, marker: URL? = nil) {
        self.path = path
        self.marker = marker
    }
}

/// Fetches one object (the blob route) with the headers the facet computed. The default streams
/// through `URLSession`; tests and hosts with their own HTTP stack inject one.
public protocol PackObjectTransport: Sendable {
    func get(_ url: URL, headers: [String: String], timeoutSeconds: Double) async throws -> ObjectResponse
}

/// `URLSession.bytes(for:)`, chunked. `timeoutSeconds` is URLSession's idle timeout (the time
/// between packets), so a large payload is never cut off for taking longer than one request may.
public struct URLSessionPackObjectTransport: PackObjectTransport {
    public let session: URLSession

    public init(session: URLSession = .shared) { self.session = session }

    public func get(_ url: URL, headers: [String: String], timeoutSeconds: Double) async throws -> ObjectResponse {
        var req = URLRequest(url: url)
        if timeoutSeconds > 0 { req.timeoutInterval = timeoutSeconds }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        let (bytes, response) = try await session.bytes(for: req)
        let http = response as? HTTPURLResponse
        let stream = AsyncThrowingStream<[UInt8], Error> { continuation in
            let task = Task {
                do {
                    var buf: [UInt8] = []
                    buf.reserveCapacity(1 << 16)
                    for try await b in bytes {
                        buf.append(b)
                        if buf.count >= 1 << 16 {
                            continuation.yield(buf)
                            buf.removeAll(keepingCapacity: true)
                        }
                    }
                    if !buf.isEmpty { continuation.yield(buf) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return ObjectResponse(
            status: http?.statusCode ?? 0, contentRange: http?.value(forHTTPHeaderField: "Content-Range"),
            chunks: stream)
    }
}

/// `update.packs` options. Equality compares the handlers by type and the transport by presence.
public struct PacksOptions: Sendable, Equatable {
    public static func == (a: PacksOptions, b: PacksOptions) -> Bool {
        a.contentStamp == b.contentStamp && a.embedded == b.embedded && a.axes == b.axes
            && a.engine == b.engine && a.memBudget == b.memBudget && a.dir == b.dir
            && a.handlers.map(\.type) == b.handlers.map(\.type)
            && a.excludeFromBackup == b.excludeFromBackup
            && (a.objectTransport == nil) == (b.objectTransport == nil)
    }

    /// The content stamp (`pkey-content.json`). Without one the facet has no packs (`ensure`
    /// throws `not-configured`).
    public var contentStamp: PackStampSource?
    /// Embedded baselines, verified once at load and then used as installed state.
    public var embedded: [EmbeddedPack]
    /// Variant preferences, per axis, in preference order (`["locale": ["fr", "en"]]`).
    public var axes: [String: [String]]
    /// `godot-<major>.<minor>` for a host that runs Godot packs; nil otherwise.
    public var engine: String?
    /// The most memory one delta frame may take (`memBytes`). Default 256 MiB.
    public var memBudget: Int
    /// Where staging, the store and `state.json` live. Default `<data dir>/packs`.
    public var dir: URL?
    /// Extra handlers (P4-16 types, game-registered `custom.*`). `files.tree` is built in.
    public var handlers: [any PackHandler]
    /// Exclude the store from backups when it starts (P1b-09). Default true.
    public var excludeFromBackup: Bool
    /// The blob transport. Default `URLSessionPackObjectTransport()`.
    public var objectTransport: (any PackObjectTransport)?

    public init(
        contentStamp: PackStampSource? = nil, embedded: [EmbeddedPack] = [], axes: [String: [String]] = [:],
        engine: String? = nil, memBudget: Int = 256 * 1024 * 1024, dir: URL? = nil,
        handlers: [any PackHandler] = [], excludeFromBackup: Bool = true,
        objectTransport: (any PackObjectTransport)? = nil
    ) {
        self.contentStamp = contentStamp
        self.embedded = embedded
        self.axes = axes
        self.engine = engine
        self.memBudget = memBudget
        self.dir = dir
        self.handlers = handlers
        self.excludeFromBackup = excludeFromBackup
        self.objectTransport = objectTransport
    }
}

/// The pack facet.
public actor PacksClient {
    private let core: CoreContext
    private let releaseKeys: TrustSet
    private let opts: PacksOptions
    private var engine: PackEngine?
    private var starting: Task<PackEngine, Error>?
    private nonisolated let building = Locked<PackEngine?>(nil)
    private nonisolated let pendingHandlers = Locked<[any PackHandler]>([])
    private nonisolated let listeners = Locked<[UUID: @Sendable (PackProgress) -> Void]>([:])
    private var zstdInfo: PackZstdInfo?
    private var refused: [(location: String, step: String)] = []

    /// The facet over `core`, verifying pack records against `releaseKeys` (the update client's
    /// `pinnedReleaseKeys`, never the product trust set). Registers itself as the source of the
    /// device report's `content.packSetId`.
    public init(core: CoreContext, releaseKeys: TrustSet, options: PacksOptions = PacksOptions()) {
        self.core = core
        self.releaseKeys = releaseKeys
        self.opts = options
        // Only a facet with a stamp has packs to report.
        if options.contentStamp != nil {
            core.setPackSetIdSource { [weak self] in await self?.packSetId() }
        }
    }

    /// Whether the host configured a content stamp (and so may have packs).
    public nonisolated var configured: Bool { opts.contentStamp != nil }

    /// Install the pinned release of each pack (CONTENT §10): already-current packs return at
    /// once; others are fetched, verified, committed and (for `hot` types) activated. Throws a
    /// `PackError` (`not-configured`, `pack-not-pinned`, `record-rejected`, `record-mismatch`,
    /// `pack-type-unsupported`, `pack-not-entitled`, `pack-no-variant`, a `plan-*` or applier
    /// code, `pack-state-unreadable`, or `network-error`, after which the next `ensure` resumes the
    /// download), or `PolarisError` `service-unavailable` when the product runs no Release service.
    public func ensure(_ packIds: [String]) async throws -> [PackInstall] {
        try await core.requireService(.release, feature: Feature.packsState)
        return try await start().ensure(packIds)
    }

    /// The install state and this process's running set.
    public func state() async throws -> PacksSnapshot { try await start().state() }

    /// The directory of a pack's running tree payload, or nil when it is not running.
    public func path(_ packId: String) async throws -> URL? {
        guard let i = try await state().running[packId], i.layout == "tree" else { return nil }
        return URL(fileURLWithPath: i.location, isDirectory: true)
    }

    /// Add a handler for a pack type (CONTENT §4.1).
    public nonisolated func registerHandler(_ handler: any PackHandler) throws {
        if let engine = building.with({ $0 }) {
            try engine.registerHandler(handler)
        } else {
            guard handler.layout == "tree" || handler.layout == "container",
                handler.activation == "hot" || handler.activation == "restart", !handler.type.isEmpty
            else {
                throw PackError(
                    ErrorCode.invalidOptions,
                    "registerHandler needs {type, layout tree|container, activation hot|restart, supports}.")
            }
            pendingHandlers.with { $0.append(handler) }
            // An engine built meanwhile gets it too.
            if let engine = building.with({ $0 }) { try engine.registerHandler(handler) }
        }
    }

    /// Progress events (`download`, `apply`, `done`, `state-issue`); returns the unsubscribe.
    @discardableResult
    public nonisolated func on(_ listener: @escaping @Sendable (PackProgress) -> Void) -> @Sendable () -> Void {
        let id = UUID()
        listeners.with { $0[id] = listener }
        return { [listeners] in listeners.with { $0[id] = nil } }
    }

    /// Progress events as an `AsyncStream`.
    public nonisolated func progress() -> AsyncStream<PackProgress> {
        AsyncStream { continuation in
            let off = on { continuation.yield($0) }
            continuation.onTermination = { _ in off() }
        }
    }

    /// The running set's `packSetId` (plans/P4-01.md §2.9); nil without a stamp or before packs
    /// can start.
    public func packSetId() async -> String? {
        guard configured, let engine = try? await start() else { return nil }
        return await engine.packSetId()
    }

    /// Mark this boot healthy (CONTENT §10 step 7).
    public func confirm() async throws { try await start().confirm() }

    /// Operator recovery after a torn `state.json` (held aside as `state.json.torn`; garbage
    /// collection waits until this is called). See `state().stateIssue`.
    public func recoverState() async throws { try await start().recoverState() }

    /// Re-point a pack at the install it replaced.
    public func rollback(_ packId: String) async throws -> Bool { try await start().rollback(packId) }

    /// The boot stage machine's pack options from the content stamp (plans/P4-01.md §2.10), for
    /// `BootOptions(requiredPacks:essentialPacks:)`.
    public func bootOptions() throws -> (requiredPacks: [String], essentialPacks: [String]) {
        bootPackOptions(try readStamp())
    }

    /// The boot's FETCH stage (the stage machine's host side): estimate the required and
    /// essential packs, send `fetch.consent` when the policy asks, download with
    /// `fetch.progress`, and send `fetch.done {result, installed}` through `send`.
    public func bootFetch(
        send: @escaping @Sendable (BootEvent) -> Void, consent: BootConsentPolicy = .metered,
        metered: Bool = false, answer: (@Sendable (Int, Bool) async -> Bool)? = nil,
        install: [PackTarget]? = nil
    ) async throws -> (result: BootEvent.FetchResult, installed: [String], background: [PackTarget]) {
        let engine = try await start()
        return try await runBootFetch(
            engine,
            RunBootFetchOptions(
                stamp: try readStamp(), send: send, consent: consent, metered: metered, answer: answer,
                install: install))
    }

    /// Install exact releases: a `packs` decision's `install` list (plans/P4-13.md §2.6). Throws
    /// `pack-revoked` for a release a verified revocation names.
    public func ensureReleases(_ targets: [PackTarget]) async throws -> [PackInstall] {
        try await core.requireService(.release, feature: Feature.packsState)
        return try await start().ensureReleases(targets)
    }

    /// Save compatibility (CONTENT §6.7 item 8): whether a pack release in the active set (mounted
    /// or active in this process, embedded baselines included) provides `contentId` in its
    /// record's `provides`. False without a content stamp.
    public func isAvailable(_ contentId: String) async throws -> Bool {
        guard configured else { return false }
        return try await start().isAvailable(contentId)
    }

    /// The pack whose target release provides `contentId` (the stamp's pins, or `targets`: a
    /// `packs` decision's install list), to `estimate` and `ensure` before a save that needs it.
    /// Reads only records (fetched by hash and verified); nil when no target provides it or
    /// without a content stamp.
    public func packFor(_ contentId: String, targets: [PackTarget]? = nil) async throws -> PackProvider? {
        guard configured else { return nil }
        return try await start().packFor(contentId, targets: targets)
    }

    /// The stored and this process's verified revocations, and `relearn` (plans/P4-13.md §2.5).
    public func revocations() async throws -> RevocationsSnapshot { try await start().revocations() }

    /// The update check's content input (plans/P4-13.md §2.5, §2.6): the stamp and its holds, the
    /// running releases (embedded baselines included), the variant preferences and the stored
    /// revocations. Nil when the host configured no content stamp.
    public func contentInput() async throws -> UpdateCheckContent? {
        guard configured, let bytes = try readStampBytes(), let stamp = try readStamp() else { return nil }
        let engine = try await start()
        var active: [String: ReleasePin] = [:]
        for (id, i) in try await engine.state().running {
            active[id] = ReleasePin(sha256: i.recordSha256, seq: i.seq, version: i.version)
        }
        let revs = await engine.revocations()
        let prefs = VariantPrefs(engine: opts.engine, axes: opts.axes)
        return UpdateCheckContent(
            stamp: UpdateContentStamp(stamp, holds: stampHolds(bytes)), active: active, engine: opts.engine,
            axes: opts.axes, revoked: revs.verified, relearn: revs.relearn,
            selectsVariant: { variants in
                if case .index = selectVariant(variants, prefs) { return true }
                return false
            },
            // plans/P4-19.md §2.7: the delegated releases the engine knows.
            delegated: await engine.delegatedReleases())
    }

    /// Keep the revocations an update check verified (the engine's `recordRevocations`).
    public func recordRevocations(_ r: UpdateCheckRevocations) async throws {
        try await start().recordRevocations(r.learned, relearnCleared: r.relearnCleared)
    }

    /// Which decoder serves frames (after the start-up probe).
    public func zstd() async throws -> PackZstdInfo {
        _ = try await start()
        return zstdInfo!
    }

    /// The embedded baselines `start` refused, by marker step.
    public func refusedEmbedded() async throws -> [(location: String, step: String)] {
        _ = try await start()
        return refused
    }

    // ── Internals ──────────────────────────────────────────────────────────────────────────

    private func start() async throws -> PackEngine {
        if let engine { return engine }
        if let starting { return try await starting.value }
        let task = Task { try await self.boot() }
        starting = task
        do {
            let e = try await task.value
            engine = e
            return e
        } catch {
            starting = nil
            building.with { $0 = nil }
            throw error
        }
    }

    private func boot() async throws -> PackEngine {
        let stamp = try readStamp()
        let z = selectZstd()
        zstdInfo = z.info
        let root = opts.dir ?? core.dirs.data.appendingPathComponent("packs", isDirectory: true)
        let storage = DirPackStorage(root: root)
        _ = try storage.freeDisk()  // creates the root
        if opts.excludeFromBackup { _ = ProductDirs.excludeFromBackup(root) }
        let core = self.core
        let objectTransport = opts.objectTransport ?? URLSessionPackObjectTransport()
        let engine = PackEngine(
            PackEngineOptions(
                product: core.product, releaseKeys: releaseKeys, productTrust: { await core.trust }, stamp: stamp,
                prefs: VariantPrefs(engine: opts.engine, axes: opts.axes), zstd: z.zstd,
                patchMethods: z.info.patchMethods, memBudget: opts.memBudget, storage: storage,
                state: storage.stateStore(), revocations: storage.revocationStore(),
                fetchRecord: { await PacksClient.fetchRecord(core, $0) },
                fetchObject: { try await PacksClient.fetchObject(core, objectTransport, $0) },
                entitlements: { await PacksClient.entitlements(core) },
                now: { await core.now() },
                handlers: opts.handlers + pendingHandlers.with { $0 },
                // plans/P4-19.md §2.4: a hold's release never takes the delegated path. Unusable
                // stamp holds (`stampHolds` gives nil) are treated as no holds: the record hash a
                // decision names still binds the bytes.
                holds: ((try? readStampBytes()) ?? nil).flatMap { stampHolds($0) } ?? []))
        let listeners = self.listeners
        engine.on { e in for l in listeners.with({ Array($0.values) }) { l(e) } }
        // A handler registered while the engine loads goes straight to it.
        building.with { $0 = engine }
        for h in pendingHandlers.with({ $0 }) { try? engine.registerHandler(h) }
        let embedded = embeddedBaselines()
        refused += try await engine.load(embedded)
        return engine
    }

    private func readStampBytes() throws -> [UInt8]? {
        guard let src = opts.contentStamp else { return nil }
        switch src {
        case .bytes(let b): return b
        case .file(let url):
            guard let data = try? Data(contentsOf: url) else {
                throw PackError(ErrorCode.contentStampInvalid, "The content stamp cannot be read.")
            }
            return [UInt8](data)
        }
    }

    private func readStamp() throws -> AppContent? {
        guard let bytes = try readStampBytes() else { return nil }
        guard let content = parseContentStamp(bytes).content else {
            throw PackError(ErrorCode.contentStampInvalid, "The content stamp is not a valid pkey-content/1 document.")
        }
        return content
    }

    private func embeddedBaselines() -> [EmbeddedBaseline] {
        var out: [EmbeddedBaseline] = []
        for e in opts.embedded {
            let path = e.path.standardizedFileURL.path
            do {
                guard let st = try statOrNil(path) else { throw PackFileError(errno: ENOENT, path: path) }
                let dir = (st.st_mode & S_IFMT) == S_IFDIR
                let markerPath = e.marker?.path ?? (dir ? path + "/.pkey/pack.json" : path + ".pkey.json")
                guard let marker = try readFileOrNil(markerPath) else {
                    throw PackFileError(errno: ENOENT, path: markerPath)
                }
                let payload: EmbeddedPayload
                if dir {
                    payload = .tree(treeDigest: try directoryTreeDigest(path))
                } else {
                    let m = try measureFile(path)
                    payload = .file(sha256: m.sha256, size: m.size)
                }
                out.append(EmbeddedBaseline(marker: marker, payload: payload, location: path))
            } catch {
                refused.append((path, "format"))
            }
        }
        return out
    }

    /// The licence's granted boolean flags, or nil when the product runs no License service.
    private static func entitlements(_ core: CoreContext) async -> Set<String>? {
        guard await core.enabled(.license) else { return nil }
        var granted = Set<String>()
        for (k, v) in await core.cache().license?.doc.entitlements ?? [:] where v.value == .bool(true) {
            granted.insert(k)
        }
        return granted
    }

    /// A discovered template, loading discovery first when this session has not.
    private static func template(_ core: CoreContext, _ service: ServiceSlug, _ name: String) async -> String? {
        var doc = await core.discoveryDocument
        if doc == nil, !core.localOnly {
            await core.discover()
            doc = await core.discoveryDocument
        }
        return doc?.services[service]?.endpoints[name]
    }

    /// `{sha256}` substituted (percent-encoded as `encodeURIComponent`), resolved against the
    /// control plane.
    private static func expand(_ template: String, _ core: CoreContext, _ sha256: String) -> URL? {
        var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        allowed.insert(charactersIn: "-_.!~*'()")
        guard let enc = sha256.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(
            string: template.replacingOccurrences(of: "{sha256}", with: enc),
            relativeTo: URL(string: core.endpoints.baseUrl + "/"))?.absoluteURL
    }

    private static func sameOrigin(_ url: URL, _ core: CoreContext) -> Bool {
        guard let base = URL(string: core.endpoints.baseUrl) else { return false }
        return url.scheme?.lowercased() == base.scheme?.lowercased()
            && url.host?.lowercased() == base.host?.lowercased() && url.port == base.port
    }

    private static func fetchRecord(_ core: CoreContext, _ sha256: String) async -> RecordFetchResult {
        if core.localOnly { return .failed(PolarisError.localOnly) }
        guard let t = await template(core, .release, "record") else {
            return .failed(ErrorCode.serviceUnavailable)
        }
        guard let url = expand(t, core, sha256) else { return .failed(ErrorCode.networkError) }
        var headers = ["accept": "application/jose"]
        if let token = await core.token, sameOrigin(url, core) { headers["authorization"] = "Bearer \(token)" }
        do {
            let res = try await core.request(url, headers: headers, maxBodyBytes: MAX_RECORD_JWS_BYTES + 1)
            guard res.isOK else { return .failed(ErrorCode.networkError) }
            // A record over the bound is refused at step `hash` from this prefix, never hashed.
            return .ok(String(decoding: res.body.prefix(MAX_RECORD_JWS_BYTES + 1), as: UTF8.self))
        } catch {
            return .failed(ErrorCode.networkError)
        }
    }

    private static func fetchObject(
        _ core: CoreContext, _ transport: any PackObjectTransport, _ req: ObjectRequest
    ) async throws -> ObjectResponse {
        if core.localOnly {
            throw PolarisError(code: PolarisError.localOnly, message: "This client is in local-only mode.")
        }
        guard let t = await template(core, .distribution, "blobs"), let url = expand(t, core, req.sha256) else {
            throw PackError(ErrorCode.serviceUnavailable, "Discovery names no blob endpoint.")
        }
        var extra: [String: String] = [:]
        if let token = await core.token, sameOrigin(url, core) { extra["authorization"] = "Bearer \(token)" }
        if req.offset > 0 { extra["range"] = "bytes=\(req.offset)-" }
        if let ifRange = req.ifRange { extra["if-range"] = ifRange }
        let headers = await core.headers(extra)
        return try await transport.get(url, headers: headers, timeoutSeconds: core.requestTimeoutSeconds)
    }
}
