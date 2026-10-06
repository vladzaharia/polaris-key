// The pack pipeline (CONTENT §10; plans/P4-01.md §2.6, §2.9): preflight, journal, fetch,
// verify, commit, activate, confirm and resume, over injected ports. client-core
// `packs/engine.ts` (P4-06) is the reference, ported with its four review rounds of state
// safety: a state read is "missing" only on not-found; a torn document is quarantined with GC
// held and the hold's snapshot persisted and reused; an unreadable document blocks every write;
// an install whose payload check throws stays in the document, out of use and out of GC (active
// and previous alike); and a fresh commit carries such an active over to previous, re-verified at
// rollback.
//
// For each pack id `ensure` asks for:
//
//  1. the content stamp's pin (a host without a stamp has no packs, §2.8);
//  2. the pinned pack record, fetched by hash and verified against the pinned release keys with
//     `pin: {kind: "pack", deliverable, version, seq}` (V4 §3.5 steps 12–15);
//  3. its type (a registered handler for `type` and `formatVersion`), its entitlement, and
//     `selectVariant`;
//  4. the target files index when the layout is `tree` or a release of the pack is installed;
//     `planTarget` and `plan`, with the host's free disk and memory budget;
//  5. a journal, then each object fetched with `Range`/`If-Range` into staging, resumed from what
//     is staged (re-hashed, never trusted), checkpointed;
//  6. the applier; on a refusal, the next fallback (`full` always last);
//  7. commit (the payload moves into the store, then the state's pointer swap), activation
//     (`hot` now; `restart` at the next boot), and garbage collection of what no root holds.

import Foundation
import PolarisKeyCore

// ── Ports ────────────────────────────────────────────────────────────────────────────────────

/// A pack type's handler (CONTENT §4.1). `files.tree` is built in; P4-16 and games add more
/// through `registerHandler`.
public protocol PackHandler: Sendable {
    var type: String { get }
    /// The layout of the payloads it installs: `tree` or `container`.
    var layout: String { get }
    /// The activation when the record names none: `hot` or `restart`.
    var activation: String { get }
    /// Whether it can install and activate this `formatVersion`.
    func supports(_ formatVersion: Int) -> Bool
    /// The type's own check of a newly staged payload (CONTENT §4.1 `verify`; P4-16): it runs
    /// after the engine verified the payload (hashes, path rules, the delegated data-only rule) and
    /// moved it into the store, before the state commit and activation. A refusal abandons the
    /// install (`pack-type-check-failed`, its `detail` and `path`); it never runs on the `noop`
    /// reuse path or over an embedded baseline. Parse the bytes; never evaluate them.
    func check(_ staged: StagedPack) async throws -> PackCheckRefusal?
    /// A committed install becomes live: at commit for `hot`, at load for a boot's `restart`.
    func activate(_ install: PackInstall) async throws
    /// `activate` with the installed payload at hand (read lazily). The engine calls this one; its
    /// default forwards to `activate(_:)`.
    func activate(_ install: PackInstall, payload: PackPayloadReader) async throws
    /// A live `hot` install is replaced or rolled back.
    func deactivate(_ install: PackInstall) async throws
}

extension PackHandler {
    public func check(_ staged: StagedPack) async throws -> PackCheckRefusal? { nil }
    public func activate(_ install: PackInstall) async throws {}
    public func activate(_ install: PackInstall, payload: PackPayloadReader) async throws {
        try await activate(install)
    }
    public func deactivate(_ install: PackInstall) async throws {}
}

/// A newly staged payload as a handler's `check` sees it: the verified record and selected
/// variant, its store location and its files in index (path byte) order.
public struct StagedPack: Sendable {
    public let packId: String
    public let record: PackRecordDoc
    public let variant: PackVariant
    public let location: String
    /// A tree's files, or a container's indexed entries, in index (UTF-8 path byte) order.
    public let files: [InstalledFile]
    /// A container's whole payload (nil for a tree).
    public let payload: (any ByteSource)?

    public init(
        packId: String, record: PackRecordDoc, variant: PackVariant, location: String,
        files: [InstalledFile], payload: (any ByteSource)?
    ) {
        self.packId = packId
        self.record = record
        self.variant = variant
        self.location = location
        self.files = files
        self.payload = payload
    }

    /// The file at exactly this index path.
    /// Compared by UTF-8 bytes, never Swift's canonical-equivalence `==`: an index path names one
    /// file exactly, as in every other SDK.
    public func file(_ path: String) -> InstalledFile? { files.first { sameBytes($0.path, path) } }
}

/// A handler's refusal of a staged payload: `pack-type-check-failed` with this `detail` (a
/// `[a-z][a-z0-9-]{0,31}` token; anything else reads as `check`) and `path`.
public struct PackCheckRefusal: Error, Sendable, Equatable {
    public let detail: String
    public let path: String?
    public let message: String?

    public init(_ detail: String, path: String? = nil, message: String? = nil) {
        self.detail = detail
        self.path = path
        self.message = message
    }
}

/// Reads an install's payload on demand (`PackStorage.installed`), files in index order.
public struct PackPayloadReader: Sendable {
    private let reader: @Sendable () throws -> InstalledPayload?

    public init(_ reader: @escaping @Sendable () throws -> InstalledPayload?) { self.reader = reader }

    public func read() throws -> InstalledPayload? { try reader().map(sortedPayload) }
}

/// Whether two strings are the same UTF-8 bytes. Paths, ids and names are matched this way, never
/// with String `==`, which treats canonically equivalent strings (`"\u{E9}"`, `"e\u{301}"`) as
/// equal where no other SDK does.
func sameBytes(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

/// An installed payload with its files in index (path byte) order.
func sortedPayload(_ p: InstalledPayload) -> InstalledPayload {
    InstalledPayload(
        payload: p.payload, files: p.files?.sorted { compareUTF8Bytes($0.path, $1.path) < 0 })
}

/// `files.tree` (CONTENT §4.2): a directory tree, hot (versioned directory plus pointer swap),
/// format version 1.
public struct FilesTreeHandler: PackHandler {
    public init() {}
    public var type: String { "files.tree" }
    public var layout: String { "tree" }
    public var activation: String { "hot" }
    public func supports(_ formatVersion: Int) -> Bool { formatVersion == 1 }
}

public let FILES_TREE_HANDLER: any PackHandler = FilesTreeHandler()

/// An object download as the engine reads it (the host adapts its HTTP client).
public struct ObjectResponse: Sendable {
    public var status: Int
    /// `Content-Range`, or nil.
    public var contentRange: String?
    /// `ETag`, or nil when the host does not report it (P4-11: a chunk run's `206` must carry
    /// exactly `"<bundle sha256>"` when it carries one).
    public var etag: String?
    public var chunks: AsyncThrowingStream<[UInt8], Error>

    public init(
        status: Int, contentRange: String?, etag: String? = nil, chunks: AsyncThrowingStream<[UInt8], Error>
    ) {
        self.status = status
        self.contentRange = contentRange
        self.etag = etag
        self.chunks = chunks
    }
}

/// `GET` of one stored object by its SHA-256, from `offset`; `ifRange` is the strong ETag
/// (`"<sha256>"`) whenever `offset > 0`, so a resume never splices two versions. With `length`
/// (P4-11's chunk runs) the request is the single bounded range
/// `Range: bytes=<offset>-<offset+length-1>`, sent with `Accept-Encoding: identity`, and never a
/// multi-range.
public struct ObjectRequest: Sendable, Equatable {
    public var sha256: String
    public var offset: Int
    public var ifRange: String?
    public var length: Int?

    public init(sha256: String, offset: Int, ifRange: String?, length: Int? = nil) {
        self.sha256 = sha256
        self.offset = offset
        self.ifRange = ifRange
        self.length = length
    }
}

public typealias ObjectFetch = @Sendable (ObjectRequest) async throws -> ObjectResponse

/// `GET` of one release record by hash: the body, or the failure's code.
public enum RecordFetchResult: Sendable, Equatable {
    case ok(String)
    case failed(String)
}

public typealias RecordFetch = @Sendable (String) async -> RecordFetchResult

/// One object being staged for a plan.
public protocol StagedObject: Sendable {
    func size() throws -> Int
    func source() throws -> any ByteSource
    func append(_ bytes: [UInt8]) throws
    func reset() throws
}

/// An install's bytes, for reuse as a delta base or a file seed.
public struct InstalledPayload: Sendable {
    /// A container's whole payload.
    public var payload: (any ByteSource)?
    /// Its files, from the index kept at install (or, for an embedded tree, its listing).
    public var files: [InstalledFile]?

    public init(payload: (any ByteSource)?, files: [InstalledFile]?) {
        self.payload = payload
        self.files = files
    }
}

/// The plan's output area: a byte sink for a container, a tree sink for a tree. A container's
/// output can be read back (`read`, at most `length` bytes, fewer past the end): the chunk
/// strategy needs it (P4-11), and is not run without it.
public struct PackOutput: Sendable {
    public var sink: (any ByteSink)?
    public var tree: (any TreeSink)?
    public var read: (@Sendable (_ offset: Int, _ length: Int) throws -> [UInt8])?

    public init(
        sink: (any ByteSink)? = nil, tree: (any TreeSink)? = nil,
        read: (@Sendable (_ offset: Int, _ length: Int) throws -> [UInt8])? = nil
    ) {
        self.sink = sink
        self.tree = tree
        self.read = read
    }
}

/// The seed-index store (P4-11; `<packs root>/index/<sha256>`): every installed payload's chunk
/// index, kept as fetched (its STORED bytes, possibly zstd) by `chunks.sha256`, and re-verified
/// against its record and installed payload every time it is used.
public protocol ChunkIndexStore: Sendable {
    func get(_ sha256: String) throws -> [UInt8]?
    /// Atomic (temp + rename, or the host's equivalent).
    func put(_ sha256: String, _ bytes: [UInt8]) throws
    func list() throws -> [String]
    func remove(_ sha256: String) throws
}

/// The chunk strategy's run journal (P4-11): `staging/<planId>/journal.json`, removed with the
/// plan's staging.
public protocol RunJournalStore: Sendable {
    func read(_ planId: String) throws -> String?
    /// Atomic (temp + rename).
    func write(_ planId: String, _ text: String) throws
}

/// Where a host keeps staging and the store. Locations and plan ids are opaque to the engine.
public protocol PackStorage: Sendable {
    func stagedObject(_ planId: String, _ sha256: String) throws -> any StagedObject
    func output(_ planId: String, _ layout: String) throws -> PackOutput
    /// `output`, except that with `resume` (P4-11's chunk strategy) a container keeps what an
    /// earlier attempt of the same plan wrote. Default: `output(planId, layout)` (nothing kept,
    /// so a resumed chunk plan refetches every run).
    func output(_ planId: String, _ layout: String, resume: Bool) throws -> PackOutput
    /// P4-11's seed-index store. Nil (the default): no payload is a seed and the chunk strategy is
    /// never planned.
    var chunkIndexes: (any ChunkIndexStore)? { get }
    /// P4-11's run journal. Nil (the default): a resumed chunk plan refetches every run.
    var runJournal: (any RunJournalStore)? { get }
    /// Move the plan's verified output into the store, keeping the decoded files index beside it
    /// (never inside the payload's own paths), and return its location.
    func commit(
        _ planId: String, _ packId: String, _ payloadSha256: String, _ layout: String,
        _ index: FilesIndexDoc?
    ) throws -> String
    /// The install's bytes, or nil when its payload is gone.
    func installed(_ install: PackInstall) throws -> InstalledPayload?
    /// Re-check an install's payload on load: false when it is missing or differs; throws when it
    /// cannot be read.
    func verify(_ install: PackInstall) throws -> Bool
    func remove(_ location: String) throws
    func removeStaging(_ planId: String) throws
    /// Every stored location and staging plan. Never a partial answer: an unreadable directory
    /// throws.
    func list() throws -> (locations: [String], plans: [String])
    func freeDisk() throws -> Int
}

extension PackStorage {
    public func output(_ planId: String, _ layout: String, resume: Bool) throws -> PackOutput {
        try output(planId, layout)
    }
    public var chunkIndexes: (any ChunkIndexStore)? { nil }
    public var runJournal: (any RunJournalStore)? { nil }
}

/// An embedded baseline the host ships: its marker's bytes and its measured payload.
public struct EmbeddedBaseline: Sendable {
    public var marker: [UInt8]
    public var payload: EmbeddedPayload
    /// Where its payload is (the host reads it back through `PackStorage.installed`).
    public var location: String

    public init(marker: [UInt8], payload: EmbeddedPayload, location: String) {
        self.marker = marker
        self.payload = payload
        self.location = location
    }
}

/// One progress event. `state-issue` is emitted once at `load` when the state document cannot be
/// trusted (then `packId` is empty, the counts are 0 and `issue` says why).
public struct PackProgress: Sendable, Equatable {
    public var packId: String
    /// `download`, `apply`, `done` or `state-issue`.
    public var phase: String
    public var done: Int
    public var total: Int
    /// `torn` or `unreadable`, on `state-issue`.
    public var issue: String?

    public init(packId: String, phase: String, done: Int, total: Int, issue: String? = nil) {
        self.packId = packId
        self.phase = phase
        self.done = done
        self.total = total
        self.issue = issue
    }
}

/// The strategies an engine costs unless told otherwise (`chunk` from P4-11).
public let PACK_DEFAULT_STRATEGIES = ["delta", "chunk", "file", "full"]

/// The engine's options.
public struct PackEngineOptions: Sendable {
    /// The product: every record's `aud`.
    public var product: String
    /// The PINNED release keys, the only keys a pack record verifies against.
    public var releaseKeys: TrustSet
    /// The effective product trust set (a release key also in it is refused).
    public var productTrust: @Sendable () async -> TrustSet
    /// The running build's content stamp, or nil: no packs.
    public var stamp: AppContent?
    /// The stamp's holds (`stampHolds`), when the host reads them: a hold for a pack is a
    /// release-key surface, so its release never takes the delegated path (plans/P4-19.md §2.4).
    public var holds: [ContentHold]
    public var prefs: VariantPrefs
    public var zstd: any ZstdPort
    /// `zstd-patch-from` when the decoder passed its start-up probe; empty otherwise.
    public var patchMethods: [String]
    /// The memory budget for one delta frame (`memBytes`).
    public var memBudget: Int
    /// The strategies to cost. Default `["delta", "chunk", "file", "full"]` (`chunk` from P4-11;
    /// it is only planned when the storage keeps seed indexes).
    public var strategies: [String]
    public var transports: [String]
    public var storage: any PackStorage
    public var state: any PackStateStore
    /// The sibling `revocations.json` (plans/P4-13.md §2.5): the same store seam with a second
    /// key, its own atomic replace and quarantine. Nil: revocations live in memory for the life
    /// of the process only. Never created empty: a product with no revocations has no such file.
    public var revocations: (any PackStateStore)?
    public var fetchRecord: RecordFetch
    public var fetchObject: ObjectFetch
    /// Whether `fetchObject` honours a bounded range (`ObjectRequest.length`) with `Content-Range`
    /// and `ETag` (P4-11). False: the chunk strategy is never planned. Default true.
    public var supportsRange: Bool
    /// The licence's granted flags, or nil when the product runs no License service.
    public var entitlements: @Sendable () async -> Set<String>?
    /// Epoch seconds.
    public var now: @Sendable () async -> Int
    /// Fresh plan ids (`[A-Za-z0-9_-]{1,64}`).
    public var newPlanId: @Sendable () -> String
    public var handlers: [any PackHandler]
    /// Write the journal every this many staged bytes (default 8 MiB).
    public var checkpointBytes: Int
    /// The most one buffered decode may hold (the stored `full` frame plus its payload). When set
    /// and the zstd port cannot stream, a larger `full` candidate is dropped before planning.
    public var oneShotBudget: Int?
    /// plans/P4-29.md §2.4: the delta menu of the most recently committed feed of the canonical
    /// channel (`feedContent`'s `deltas`), fresh or stale, or nil. Each entry for the selected
    /// container variant's payload joins the record's deltas as one more candidate; at most one
    /// feed-offered delta is tried per install. Nil (the default): only the record's deltas.
    public var feedDeltas: (@Sendable () -> FeedDeltas?)?
    /// P5-08: the store transport (Apple Background Assets, …) that carries some packs, or nil.
    /// A carried pack is planned only through it (`platform`), never through the CDN.
    public var platform: (any PackPlatformTransport)?

    public init(
        product: String, releaseKeys: TrustSet, productTrust: @escaping @Sendable () async -> TrustSet,
        stamp: AppContent?, prefs: VariantPrefs = VariantPrefs(), zstd: any ZstdPort,
        patchMethods: [String], memBudget: Int, strategies: [String] = PACK_DEFAULT_STRATEGIES,
        transports: [String] = ["pkey-cdn"], storage: any PackStorage, state: any PackStateStore,
        revocations: (any PackStateStore)? = nil, fetchRecord: @escaping RecordFetch, fetchObject: @escaping ObjectFetch,
        supportsRange: Bool = true,
        entitlements: @escaping @Sendable () async -> Set<String>? = { nil },
        now: @escaping @Sendable () async -> Int = { Int(Date().timeIntervalSince1970) },
        newPlanId: @escaping @Sendable () -> String = {
            UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        },
        handlers: [any PackHandler] = [], checkpointBytes: Int = 8 << 20, oneShotBudget: Int? = nil,
        holds: [ContentHold] = [], feedDeltas: (@Sendable () -> FeedDeltas?)? = nil,
        platform: (any PackPlatformTransport)? = nil
    ) {
        self.platform = platform
        self.feedDeltas = feedDeltas
        self.holds = holds
        self.product = product
        self.releaseKeys = releaseKeys
        self.productTrust = productTrust
        self.stamp = stamp
        self.prefs = prefs
        self.zstd = zstd
        self.patchMethods = patchMethods
        self.memBudget = memBudget
        self.strategies = strategies
        self.transports = transports
        self.storage = storage
        self.state = state
        self.revocations = revocations
        self.fetchRecord = fetchRecord
        self.fetchObject = fetchObject
        self.supportsRange = supportsRange
        self.entitlements = entitlements
        self.now = now
        self.newPlanId = newPlanId
        self.handlers = handlers
        self.checkpointBytes = checkpointBytes
        self.oneShotBudget = oneShotBudget
    }
}

/// The error the pipeline raises when it cannot proceed. `code` is a registered client code
/// (`conformance/parity/errors.json`); `detail` names a step, `path` a file.
public struct PackError: Error, Sendable, Equatable, CustomStringConvertible {
    public let code: String
    public let message: String
    public let detail: String?
    public let path: String?
    public let packId: String?

    public init(
        _ code: String, _ message: String, detail: String? = nil, path: String? = nil,
        packId: String? = nil
    ) {
        self.code = code
        self.message = message
        self.detail = detail
        self.path = path
        self.packId = packId
    }

    public var description: String { "PackError(\(code)): \(message)" }
}

/// What `state()` reports.
public struct PacksSnapshot: Sendable, Equatable {
    public struct Inflight: Sendable, Equatable {
        public var planId: String
        public var strategy: String
        public var done: Int
        public var total: Int
    }
    public var active: [String: PackInstall]
    public var previous: [String: PackInstall]
    public var inflight: [String: Inflight]
    /// The pack releases activated in this process: restart packs mounted at this boot, hot packs
    /// active, embedded baselines included. `packSetId` hashes this set.
    public var running: [String: PackInstall]
    public var confirmedBootSeq: Int
    public var bootSeq: Int
    /// Why this load could not trust the state document: `torn` (held aside; garbage collection
    /// waits for `recoverState()`), `unreadable` (nothing is written or installed this process),
    /// or nil.
    public var stateIssue: String?
}

/// What `revocations()` reports (plans/P4-13.md §2.5).
public struct RevocationsSnapshot: Sendable, Equatable {
    /// Revoked target hash → the stored winner (persisted, or this process's only).
    public var revoked: [String: StoredRevocation]
    /// The verified revocation of every revoked target, replacement included.
    public var verified: [String: VerifiedRevocation]
    /// Packs whose embedded baselines are refused until a fresh feed re-teaches them.
    public var relearn: [String]
    /// `torn` (quarantined and replaced), `unreadable` (nothing is written this process), or nil.
    public var issue: String?
}

/// What `estimate` reports for a set of packs (the consent dialog's size disclosure).
public struct PackEstimate: Sendable, Equatable {
    /// The bytes the chosen strategies would download, summed over the packs not yet current.
    public var bytes = 0
    /// The packs that would download.
    public var packs: [String] = []
    /// Packs that cannot be planned, with the code `ensure` would raise.
    public var refused: [(packId: String, code: String)] = []

    public static func == (a: PackEstimate, b: PackEstimate) -> Bool {
        a.bytes == b.bytes && a.packs == b.packs
            && a.refused.map { "\($0.packId) \($0.code)" } == b.refused.map { "\($0.packId) \($0.code)" }
    }
}

/// A value behind a lock, for the engine's synchronous members.
final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func with<R>(_ body: (inout T) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body(&value)
    }
}

/// SHA-256 of the empty string: an empty object is legitimately zero bytes long.
private let EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

/// `preflight`'s answer.
private enum Preflight {
    case current(PackInstall)
    case plan(Planned)
}

private struct Planned {
    var body: String
    var recordSha256: String
    var record: PackRecordDoc
    var variant: PackVariant
    var installs: [PackInstall]
    var seeds: [String: InstalledPayload]
    var planId: String
    var index: FilesIndexDoc?
    var plan: PlanResult
    /// The delegation's compact JWS when a content key signed the record (plans/P4-19.md §2.3).
    var delegation: String?
    /// P4-11: the parsed target chunk index and the seeds, when the fetch rule ran.
    var chunk: ChunkContext?
    /// plans/P4-29.md §2.4: the delta ids the feed's menu added to `variant` (merged).
    var feedIds: Set<String> = []
}

/// A refused platform copy: the marker step, and the release it holds when the refusal is the pin.
private struct PlatformRefusal: Error {
    var step: String
    var mismatch: (sha256: String, version: String)? = nil
}

/// One chunk seed and where it came from (P4-11).
private struct SeedEntry: Sendable {
    var location: String
    var payloadSha256: String
    var seed: ChunkSeed
}

/// The chunk strategy's preflight context (P4-11).
private struct ChunkContext: Sendable {
    var index: ChunkIndexDoc
    var seeds: [SeedEntry]
}

// ── The engine ───────────────────────────────────────────────────────────────────────────────

public actor PackEngine {
    private let opts: PackEngineOptions
    private nonisolated let handlerTable: Locked<[String: any PackHandler]>
    private nonisolated let listeners: Locked<[UUID: @Sendable (PackProgress) -> Void]>
    private var embedded: [String: PackInstall] = [:]
    /// P5-08: the packs whose `embedded` entry is the platform transport's copy (never committed
    /// to the state: its path is the platform's and is re-read at every boot).
    private var platformCopies = Set<String>()
    private var running: [String: PackInstall] = [:]
    /// Locations whose payload could not be read at load: kept out of use and out of GC.
    private var unverifiable = Set<String>()
    /// Stored installs whose payload check threw: kept in the written document, out of use.
    private var deferredActive: [String: PackInstall] = [:]
    private var deferredPrevious: [String: PackInstall] = [:]
    private var stateIssue: String?
    /// No garbage collection while a torn document is held or the state is unreadable.
    private var gcHold = false
    /// While a torn document is held: what existed when the hold started, never collected.
    private var holdSnapshot: (locations: Set<String>, plans: Set<String>)?
    /// Packs whose `previous` was carried over from an entry whose check could not run:
    /// re-verified before a rollback uses it.
    private var unverifiedPrevious = Set<String>()
    private var doc: PackStateDoc?
    /// The revocations (plans/P4-13.md §2.5): the sibling document as loaded and updated.
    private var revDoc = emptyRevocations()
    /// Every revocation verified in this process (loaded or learned), by target.
    private var revVerified: [String: VerifiedRevocation] = [:]
    /// The JWS of each revocation learned in this process, by target.
    private var revJws: [String: String] = [:]
    private var revIssue: String?
    /// Whether `revocations.json` exists (it is never created empty).
    private var revFile = false
    /// Plan ids `estimate` staged an index under, reused by the next `ensure`.
    private var preflightPlans: [String: (planId: String, recordSha256: String)] = [:]
    /// Delegation records fetched in this process, by hash (plans/P4-19.md §2.3). Each is bound to
    /// its hash and re-verified at every use against the current trust inputs.
    private var delegationBodies: [String: String] = [:]
    /// Distinct delegations this call may still fetch (`MAX_DELEGATIONS_PER_CHECK`).
    private var delegationBudget = MAX_DELEGATIONS_PER_CHECK
    /// Delegated releases verified in this process: record hash → pack and delegation hash.
    private var delegatedKnown: [String: DelegatedRelease] = [:]
    private var tail: Task<Void, Never>?
    /// Seed indexes `storeSeedIndexes` already tried to fetch in this process (P4-11).
    private var seedIndexTried = Set<String>()
    /// Save compatibility's record facts, by record hash (`Provides.swift`).
    private var providesMemo = ProvidesMemo()

    public init(_ opts: PackEngineOptions) {
        self.opts = opts
        // Built in (P4-16): `data.json` and `l10n.table` with their default options; a host
        // registers a configured instance to read what they parse.
        var table: [String: any PackHandler] = [
            FILES_TREE_HANDLER.type: FILES_TREE_HANDLER, "data.json": DataJsonHandler(),
            "l10n.table": L10nTableHandler(),
        ]
        for h in opts.handlers { table[h.type] = h }
        self.handlerTable = Locked(table)
        self.listeners = Locked([:])
    }

    /// Add or replace a handler for a pack type (CONTENT §4.1 custom types). Throws
    /// `invalid-options` for a handler whose layout or activation is outside the vocabulary.
    public nonisolated func registerHandler(_ handler: any PackHandler) throws {
        guard !handler.type.isEmpty, handler.layout == "tree" || handler.layout == "container",
            handler.activation == "hot" || handler.activation == "restart"
        else {
            throw PackError(
                ErrorCode.invalidOptions,
                "registerHandler needs {type, layout tree|container, activation hot|restart, supports}.")
        }
        handlerTable.with { $0[handler.type] = handler }
    }

    /// Progress events; returns the unsubscribe function.
    @discardableResult
    public nonisolated func on(_ listener: @escaping @Sendable (PackProgress) -> Void) -> @Sendable () -> Void {
        let id = UUID()
        listeners.with { $0[id] = listener }
        return { [listeners] in listeners.with { $0[id] = nil } }
    }

    private func handler(_ type: String) -> (any PackHandler)? { handlerTable.with { $0[type] } }

    /// Load the state (re-verifying every entry), register the host's embedded baselines (each
    /// marker verified once, its bytes matched, its pin checked against the stamp), activate what
    /// this boot runs, persist the document and collect garbage. Run once, before `ensure`.
    /// Returns the embedded baselines that were refused, by marker step.
    public func load(_ embedded: [EmbeddedBaseline] = []) async throws -> [(location: String, step: String)] {
        try await serialised { try await self.loadNow(embedded) }
    }

    private func loadNow(_ embeddedList: [EmbeddedBaseline]) async throws -> [(location: String, step: String)] {
        var refused: [(location: String, step: String)] = []
        for e in embeddedList {
            switch await verifyEmbedded(e) {
            case .success(let install): embedded[install.packId] = install
            case .failure(let r): refused.append((e.location, r.step))
            }
        }
        // P5-08: every carried pack the platform holds now, read fresh, under the platform pin
        // rule. Its copy stands in for a bundled baseline of the same pack.
        if let p = opts.platform, p.unavailable() == nil {
            for packId in Set((opts.stamp?.pins.map(\.pack) ?? []) + (opts.stamp?.expects.map(\.pack) ?? []))
                .sorted() where p.carries(packId)
            {
                guard let dir = (try? await p.locate(packId, contentApi: opts.stamp?.contentApi ?? -1)) ?? nil else { continue }
                switch readPlatformBaseline(dir) {
                case .refused(let location, let step): refused.append((location, step))
                case .baseline(let b):
                    switch await verifyPlatform(b, packId: packId, exact: nil) {
                    case .success(let install):
                        embedded[packId] = install
                        platformCopies.insert(packId)
                    case .failure(let r): refused.append((b.location, r.step))
                    }
                }
            }
        }
        // The state. `read` is nil only for "no document"; anything else it throws means the
        // document is unknown, so nothing may be written over it or collected this process.
        let st = opts.state
        var text: String?
        var unreadable = false
        do {
            text = try st.read()
        } catch {
            unreadable = true
        }
        // A document that exists but does not parse (a torn write) is not the empty state: it is
        // held aside before anything replaces it, and nothing is collected while it is held.
        let torn: Bool = {
            guard !unreadable, let text else { return false }
            return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !looksLikeState(text)
        }()
        if torn {
            // A store that cannot keep the torn text aside is treated as unreadable: nothing is
            // written over the text.
            do { try st.quarantine(text!) } catch { unreadable = true }
        }
        let held = !unreadable && (torn || ((try? st.quarantined()) ?? true))
        stateIssue = unreadable ? "unreadable" : held ? "torn" : nil
        gcHold = unreadable
        if held {
            // Bound the hold: what exists now may belong to the lost document and is kept; what
            // this process creates and drops later is collected as usual. The first hold's
            // snapshot is kept beside the quarantine and reused by later loads; one that cannot
            // be read holds GC entirely.
            if let listed = holdList(st) {
                holdSnapshot = (Set(listed.locations), Set(listed.plans))
            } else {
                gcHold = true
            }
        }
        if let issue = stateIssue {
            emit(PackProgress(packId: "", phase: "state-issue", done: 0, total: 0, issue: issue))
        }
        let parsed = parsePackState(torn ? nil : text)
        let deferred = Locked(Set<PackInstall>())
        let unverifiableNow = Locked(Set<String>())
        let storage = opts.storage
        let reloaded = await reloadPackState(
            parsed,
            PackStateVerifier(
                install: { i in
                    guard await self.verifyStoredRecord(i.record, i.recordSha256, i.packId, i, i.delegation)
                    else {
                        return false
                    }
                    do {
                        return try storage.verify(i)
                    } catch {
                        // The payload could not be read (an I/O error, not a mismatch): kept in
                        // the document and out of GC, but out of the running set and the planner.
                        unverifiableNow.with { _ = $0.insert(i.location) }
                        deferred.with { _ = $0.insert(i) }
                        return false
                    }
                },
                journal: { j in
                    await self.verifyStoredRecord(j.record, j.recordSha256, j.packId, nil, j.delegation)
                }))
        unverifiable.formUnion(unverifiableNow.with { $0 })
        let deferredSet = deferred.with { $0 }
        for (id, i) in parsed.active where deferredSet.contains(i) { deferredActive[id] = i }
        for (id, i) in parsed.previous where deferredSet.contains(i) { deferredPrevious[id] = i }
        doc = reloaded
        // plans/P4-13.md §2.5: the sibling revocations, before anything mounts.
        try await loadRevocations(stateUnreadable: unreadable)
        // This boot's set: every active install (restart packs mount now), else the embedded
        // baseline. A revoked release never activates or mounts (`pack-revoked`).
        for id in reloaded.active.keys.sorted() where !installRevoked(reloaded.active[id]!) {
            try await activate(reloaded.active[id]!)
        }
        for (id, e) in embedded where running[id] == nil && !embeddedRefused(e) { running[id] = e }
        if !unreadable { try persist() }
        collect()
        return refused
    }

    /// The install state and this process's running set.
    public func state() throws -> PacksSnapshot {
        let doc = try requireLoaded()
        var inflight: [String: PacksSnapshot.Inflight] = [:]
        for (id, j) in doc.inflight {
            inflight[id] = .init(
                planId: j.planId, strategy: j.strategy, done: j.objects.reduce(0) { $0 + $1.done },
                total: j.objects.reduce(0) { $0 + $1.bytes })
        }
        return PacksSnapshot(
            active: doc.active, previous: doc.previous, inflight: inflight, running: running,
            confirmedBootSeq: doc.confirmedBootSeq, bootSeq: doc.bootSeq, stateIssue: stateIssue)
    }

    /// The bytes of a pack's running install (its files, its payload), or nil.
    public func open(_ packId: String) throws -> InstalledPayload? {
        guard let i = running[packId] else { return nil }
        return try opts.storage.installed(i)
    }

    /// `packSetId` of the running set (plans/P4-01.md §2.9), for `devices/report`'s `content`.
    public func packSetId() -> String? {
        PolarisKeyPacks.packSetId(
            running.values.map { PackSetEntry(packId: $0.packId, releaseSha256: $0.recordSha256) })
    }

    /// Save compatibility (P4-20, CONTENT §6.7 item 8): whether a pack release in the ACTIVE set
    /// provides `contentId` (its record's `provides`, `Provides.swift`). The active set is the
    /// running set: restart packs mounted at this boot, hot packs active, embedded baselines
    /// included; a revoked release is never in it. A pack whose `entitlement` the licence lacks
    /// never answers.
    public func isAvailable(_ contentId: String) async throws -> Bool {
        _ = try requireLoaded()
        let granted = await opts.entitlements()
        for i in running.values where providesMemo.facts(ProvidesMemo.key(i.packId, i.recordSha256), i.record).answers(contentId, granted) {
            return true
        }
        return false
    }

    /// The pack whose TARGET release provides `contentId`, so a game can `estimate` and `ensure`
    /// it. The target set is `targets` (a `packs` decision's install list) or, by default, the
    /// content stamp's pins; each target's record is the verified record of an install or embedded
    /// baseline with its hash, else fetched by hash and verified as `ensure` verifies it. The first
    /// target, in list order, that provides the id answers. A target that cannot be fetched or
    /// verified, a revoked one and an unentitled one (CONTENT §6.7 item 9) never answer. Nil when
    /// no target provides it.
    public func packFor(_ contentId: String, targets: [PackTarget]? = nil) async throws -> PackProvider? {
        try await serialised { try await self.packForNow(contentId, targets) }
    }

    private func packForNow(_ contentId: String, _ targets: [PackTarget]?) async throws -> PackProvider? {
        _ = try requireLoaded()
        resetDelegationBudget()
        let list = targets ?? (opts.stamp?.pins ?? []).map {
            PackTarget(pack: $0.pack, release: ReleasePin(sha256: $0.sha256, seq: $0.seq, version: $0.version))
        }
        let granted = await opts.entitlements()
        // A revoked record, or one signed under a revoked delegation (checked here too, because a
        // memo hit skips `fetchVerified`'s own check).
        let delegated = delegatedReleases()
        for t in list where revokedBy(t.release.sha256, delegated[t.release.sha256]?.delegation) == nil {
            if let f = await targetFacts(t), f.answers(contentId, granted) {
                return PackProvider(packId: t.pack, release: t.release)
            }
        }
        return nil
    }

    /// A target's facts: from an install or embedded baseline of that release, else its record
    /// fetched and verified (`fetchVerified`); nil when that fails.
    private func targetFacts(_ t: PackTarget) async -> ProvidesFacts? {
        let sha = t.release.sha256
        let key = ProvidesMemo.key(t.pack, sha)
        if let hit = providesMemo.get(key) { return hit }
        guard let doc else { return nil }
        for case let i? in [doc.active[t.pack], doc.previous[t.pack], running[t.pack], embedded[t.pack]]
        where i.recordSha256 == sha && i.packId == t.pack {
            return providesMemo.facts(key, i.record)
        }
        guard let (body, _, _) = try? await fetchVerified(t.pack, t.release) else { return nil }
        return providesMemo.facts(key, body)
    }

    /// Mark this boot healthy (CONTENT §10 step 7).
    public func confirm() async throws {
        try await serialised {
            try await self.refuseUnreadable()
            try await self.confirmNow()
        }
    }

    private func confirmNow() throws {
        doc = confirmBoot(try requireLoaded())
        try persist()
    }

    /// Re-point a pack at `previous`. A hot pack switches now; a restart pack at the next boot.
    public func rollback(_ packId: String) async throws -> Bool {
        try await serialised { try await self.rollbackNow(packId) }
    }

    private func rollbackNow(_ packId: String) async throws -> Bool {
        try refuseUnreadable()
        let doc = try requireLoaded()
        let before = doc.active[packId]
        // plans/P4-13.md §2.5: never back to a revoked release.
        if let prev = doc.previous[packId], installRevoked(prev) { return false }
        if let prev = doc.previous[packId], unverifiedPrevious.contains(packId) {
            // Carried over from an entry whose check could not run: verify it now.
            var ok = await verifyStoredRecord(prev.record, prev.recordSha256, packId, prev, prev.delegation)
            if ok { ok = (try? opts.storage.verify(prev)) ?? false }
            if !ok { return false }
            unverifiedPrevious.remove(packId)
        }
        let r = rollbackInstall(doc, packId: packId)
        if !r.rolledBack { return false }
        self.doc = r.state
        try persist()
        let now = r.state.active[packId]!
        if now.activation == "hot" {
            if let before, let h = handler(now.type) { try await h.deactivate(before) }
            try await activate(now)
        }
        return true
    }

    /// Install the pinned release of each pack, in order. Returns the installs (already-current
    /// packs included); throws a `PackError` for the first pack that cannot be installed.
    public func ensure(_ packIds: [String]) async throws -> [PackInstall] {
        try await serialised {
            try await self.refuseUnreadable()
            await self.resetDelegationBudget()
            var out: [PackInstall] = []
            for id in packIds { out.append(try await self.ensureOne(id)) }
            return out
        }
    }

    /// Install exact releases (a `packs` decision's `install`, plans/P4-13.md §2.6): each pack's
    /// named release, verified against the pinned release keys with that pin, instead of the
    /// stamp's pin. Throws `pack-revoked` for a release a verified revocation names.
    public func ensureReleases(_ targets: [PackTarget]) async throws -> [PackInstall] {
        try await serialised {
            try await self.refuseUnreadable()
            await self.resetDelegationBudget()
            var out: [PackInstall] = []
            for t in targets { out.append(try await self.ensureOne(t.pack, target: t.release)) }
            return out
        }
    }

    /// Preflight each pack (CONTENT §10 step 1) without downloading the payload, and sum the
    /// chosen strategies' bytes: the size a consent dialog discloses. The index each tree stages
    /// is reused by `ensure`.
    public func estimate(_ packIds: [String]) async throws -> PackEstimate {
        try await estimateAll(packIds.map { ($0, nil) })
    }

    /// `estimate` for exact releases (a `packs` decision's `install`, plans/P4-13.md §2.6).
    public func estimateReleases(_ targets: [PackTarget]) async throws -> PackEstimate {
        try await estimateAll(targets.map { ($0.pack, $0.release) })
    }

    private func estimateAll(_ items: [(String, ReleasePin?)]) async throws -> PackEstimate {
        try await serialised {
            try await self.refuseUnreadable()
            await self.resetDelegationBudget()
            var out = PackEstimate()
            for (id, release) in items {
                do {
                    switch try await self.preflight(id, want: release) {
                    case .current: continue
                    case .plan(let p):
                        if case .chosen(let c, _, _) = p.plan {
                            if c.strategy == "noop" { continue }
                            out.packs.append(id)
                            out.bytes += c.bytes
                        } else {
                            out.packs.append(id)
                        }
                    }
                } catch let e as PackError {
                    out.refused.append((id, e.code))
                } catch let e as PolarisError {
                    out.refused.append((id, e.code))
                } catch {
                    out.refused.append((id, ErrorCode.networkError))
                }
            }
            return out
        }
    }

    /// Operator recovery after a torn state document: drop the copy held aside and resume garbage
    /// collection, which then removes the payloads no install names. The installs the torn
    /// document held are not recovered; `ensure` reinstalls them.
    public func recoverState() async throws {
        try await serialised { try await self.recoverNow() }
    }

    private func recoverNow() throws {
        _ = try requireLoaded()
        if stateIssue == "unreadable" {
            throw PackError(
                ErrorCode.packStateUnreadable,
                "The pack state could not be read; restart once the store is readable.")
        }
        try opts.state.clearQuarantine()
        stateIssue = nil
        gcHold = false
        holdSnapshot = nil
        // plans/P4-13.md §2.5: `relearn` is cleared wholesale and a quarantined `revocations.json`
        // released; revocations are re-learned from the next feed.
        if let rs = opts.revocations, revIssue != "unreadable" {
            try rs.clearQuarantine()
            if !revDoc.relearn.isEmpty {
                revDoc.relearn = []
                if revFile { try rs.replace(serializeRevocations(revDoc)) }
            }
            if revIssue == "torn" { revIssue = nil }
        }
        collect()
    }

    // ── Revocations (plans/P4-13.md §2.5) ───────────────────────────────────────────────────

    /// The stored and this process's verified revocations.
    public func revocations() -> RevocationsSnapshot {
        var revoked = revDoc.revoked
        for (t, r) in revVerified where revoked[t] == nil {
            revoked[t] = StoredRevocation(
                jws: revJws[t] ?? "", pack: r.pack, version: r.version, seq: r.seq, record: r.record,
                issuedAt: r.issuedAt)
        }
        return RevocationsSnapshot(revoked: revoked, verified: revVerified, relearn: revDoc.relearn, issue: revIssue)
    }

    /// Keep revocations a fresh check verified (plans/P4-13.md §2.5 step 11): each is stored when
    /// its target is new, or when `newerRevocation` ranks it above the stored one.
    /// `relearnCleared` names the packs a fresh, network-verified feed with a usable `revocations`
    /// member re-taught. A revoked install stops running at once (a `hot` handler is deactivated;
    /// a `restart` pack is not mounted at the next boot). Writes `state.json`'s
    /// `revocationsStored` before the sibling file the first time; writes nothing while either
    /// document is unreadable (the revocations still apply for the life of the process).
    public func recordRevocations(_ learned: [LearnedRevocation], relearnCleared: [String] = []) async throws {
        try await serialised { try await self.recordNow(learned, relearnCleared) }
    }

    private func recordNow(_ learned: [LearnedRevocation], _ relearnCleared: [String]) async throws {
        _ = try requireLoaded()
        var next = revDoc
        var changed = false
        for l in learned {
            let t = l.revocation.target
            if let prev = revVerified[t] {
                if newerRevocation(l.revocation, prev) == l.revocation {
                    revVerified[t] = l.revocation
                    revJws[t] = l.jws
                }
            } else {
                revVerified[t] = l.revocation
                revJws[t] = l.jws
            }
            let r = storeRevocation(next, l.revocation, jws: l.jws)
            next = r.doc
            changed = changed || r.changed
        }
        let c = clearRelearn(next, relearnCleared)
        next = c.doc
        changed = changed || c.changed
        // The cap may have dropped a target: it is forgotten here too.
        for t in Array(revVerified.keys) where next.revoked[t] == nil && revDoc.revoked[t] != nil {
            revVerified[t] = nil
        }
        revDoc = next
        do {
            if changed { try persistRevocations() }
        } catch {
            // A failed write never keeps a revoked release running.
            await unmountRevoked()
            throw error
        }
        await unmountRevoked()
    }

    /// Whether a release is revoked (stored, or verified in this process).
    public func isRevoked(_ recordSha256: String) -> Bool {
        revDoc.revoked[recordSha256] != nil || revVerified[recordSha256] != nil
    }

    /// Why a release is revoked (plans/P4-19.md §2.3 `recordRevoked`): `record` when its own hash
    /// is a target, `delegation` when the delegation it was signed under is, else nil.
    public func revokedBy(_ recordSha256: String, _ delegationSha256: String?) -> RecordRevokedBy? {
        let targets = Set(revDoc.revoked.keys).union(revVerified.keys)
        return recordRevoked(recordSha256, delegationSha256, targets)
    }

    /// Whether an install is revoked: its record, or the delegation it was signed under.
    private func installRevoked(_ i: PackInstall) -> Bool {
        revokedBy(i.recordSha256, installDelegation(i)) != nil
    }

    /// The delegated releases this engine knows (plans/P4-19.md §2.7): every stored or running
    /// install signed by a content key, and every delegated feed target verified in this process,
    /// as record hash → its pack and delegation hash. The update check adds a decision revocation
    /// for each one whose delegation is revoked, and treats a delegation entry naming one of these
    /// delegations as relevant (step 11).
    public func delegatedReleases() -> [String: DelegatedRelease] {
        var out = delegatedKnown
        let stored = doc.map { Array($0.active.values) + Array($0.previous.values) } ?? []
        let installs = stored + Array(running.values)
        for i in installs {
            if let h = installDelegation(i) { out[i.recordSha256] = DelegatedRelease(pack: i.packId, delegation: h) }
        }
        return out
    }

    private func resetDelegationBudget() { delegationBudget = MAX_DELEGATIONS_PER_CHECK }

    /// The embedded-baseline refusals (plans/P4-13.md §2.5): a revoked release; a pack in
    /// `relearn`; with an unreadable `revocations.json` and `revocationsStored` set, every pack the
    /// stamp pins or the host embeds. These apply at every boot and every mount, online or
    /// offline, until a fresh feed clears `relearn` (or `recoverState()`); online, the pack is
    /// fetched instead. A product with no revocations refuses nothing.
    private func embeddedRefused(_ e: PackInstall) -> Bool {
        if isRevoked(e.recordSha256) { return true }
        if revDoc.relearn.contains(e.packId) { return true }
        if revIssue == "unreadable", doc?.revocationsStored == true,
            stampPacks().contains(e.packId) || embedded[e.packId] != nil
        {
            return true
        }
        return false
    }

    private func stampPacks() -> Set<String> { Set((opts.stamp?.pins ?? []).map(\.pack)) }

    /// Load `revocations.json` (§2.5): absent is empty; unreadable writes nothing this process;
    /// torn is quarantined and replaced by a fresh document whose `relearn` holds the stamp's
    /// pinned and embedded packs; each entry is re-verified against the pinned release keys.
    private func loadRevocations(stateUnreadable: Bool) async throws {
        guard let rs = opts.revocations else { return }
        let text: String?
        do {
            text = try rs.read()
        } catch {
            revIssue = "unreadable"
            return
        }
        guard let text else { return }
        revFile = true
        let parsed =
            text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : parseRevocations(text)
        guard let parsed else {
            // Torn: held aside, then a fresh document that re-learns the stamp's packs.
            do { try rs.quarantine(text) } catch {
                revIssue = "unreadable"
                return
            }
            revIssue = "torn"
            var relearn = stampPacks()
            relearn.formUnion(embedded.keys)
            revDoc = RevocationsDoc(revoked: [:], relearn: relearn.sorted { compareUTF8Bytes($0, $1) < 0 })
            if !stateUnreadable { try writeRevocations() }
            return
        }
        let r = reloadRevocations(
            parsed, releaseKeys: opts.releaseKeys, productTrust: await opts.productTrust(),
            expectedAud: opts.product)
        revDoc = r.doc
        for (t, v) in r.verified { revVerified[t] = v }
        if r.changed && !stateUnreadable {
            try writeRevocations()
        } else if !stateUnreadable, !isEmptyRevocations(revDoc), doc?.revocationsStored != true {
            // A torn (or replaced) `state.json` lost the flag while the sibling file kept its
            // entries: set it again, so an unreadable `revocations.json` later still refuses. A
            // failed write leaves the flag unset in memory; the next sibling write retries it. The
            // load goes on: the sibling file is unchanged and still read.
            try? persistFlag()
        }
    }

    /// Persist the revocations: `revocationsStored` in `state.json` first, then the sibling file.
    /// Never creates an empty file; never writes while a document is unreadable.
    private func persistRevocations() throws {
        guard opts.revocations != nil else { return }
        if revIssue == "unreadable" || stateIssue == "unreadable" { return }
        if !revFile && isEmptyRevocations(revDoc) { return }
        try writeRevocations()
    }

    private func writeRevocations() throws {
        guard let rs = opts.revocations else { return }
        // Without the flag on disk the sibling file is not written: an unreadable file later must
        // never be read as "no revocations" while it holds some.
        if try !requireLoaded().revocationsStored { try persistFlag() }
        try rs.replace(serializeRevocations(revDoc))
        revFile = true
    }

    /// Write `revocationsStored: true` to `state.json`. The in-memory document takes the flag only
    /// once the write succeeded, so a failed write (which throws) is retried before the next
    /// sibling write instead of being believed.
    private func persistFlag() throws {
        let before = try requireLoaded()
        var flagged = before
        flagged.revocationsStored = true
        doc = flagged
        do {
            try persist()
        } catch {
            doc = before
            throw error
        }
    }

    /// Stop running every revoked release (a hot handler is deactivated).
    private func unmountRevoked() async {
        for (id, i) in running where installRevoked(i) {
            if i.activation == "hot", let h = handler(i.type) {
                // A handler failure never keeps a revoked release running.
                try? await h.deactivate(i)
            }
            running[id] = nil
        }
    }

    // ── Internals ──────────────────────────────────────────────────────────────────────────

    private func serialised<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = tail
        let task = Task { () async throws -> T in
            await previous?.value
            return try await work()
        }
        tail = Task { _ = try? await task.value }
        return try await task.value
    }

    private func requireLoaded() throws -> PackStateDoc {
        guard let doc else {
            throw PackError(ErrorCode.notConfigured, "Call load() before using packs.")
        }
        return doc
    }

    private nonisolated func emit(_ e: PackProgress) {
        // A listener never fails an install.
        for l in listeners.with({ Array($0.values) }) { l(e) }
    }

    /// The torn hold's snapshot: the saved one, else `storage.list()` now (saved when the store
    /// keeps it). Nil when it cannot be known (an unreadable snapshot or listing).
    private func holdList(_ st: any PackStateStore) -> (locations: [String], plans: [String])? {
        if st.keepsHoldList {
            let saved: String?
            do { saved = try st.readHoldList() } catch { return nil }
            if let saved {
                guard let d = parseJSON(saved)?.objectValue,
                    let locs = d["locations"]?.arrayValue, let plans = d["plans"]?.arrayValue
                else { return nil }
                let ls = locs.compactMap(\.stringValue)
                let ps = plans.compactMap(\.stringValue)
                // Torn too (a non-string member): fall through to the full hold.
                guard ls.count == locs.count, ps.count == plans.count else { return nil }
                return (ls, ps)
            }
        }
        let listed: (locations: [String], plans: [String])
        do { listed = try opts.storage.list() } catch { return nil }
        if st.keepsHoldList {
            let text = canonicalJSON(
                .object([
                    "locations": .array(listed.locations.map { .string($0) }),
                    "plans": .array(listed.plans.map { .string($0) }),
                ]))
            do { try st.writeHoldList(text) } catch { return nil }
        }
        return listed
    }

    private func refuseUnreadable() throws {
        _ = try requireLoaded()
        if stateIssue == "unreadable" {
            throw PackError(
                ErrorCode.packStateUnreadable,
                "The pack state could not be read, so nothing is fetched, written or installed this process.")
        }
    }

    private func persist() throws {
        if stateIssue == "unreadable" {
            throw PackError(
                ErrorCode.packStateUnreadable,
                "The pack state could not be read, so nothing is written or installed this process.")
        }
        var out = try requireLoaded()
        // Entries whose payload check threw stay in the document for the next load.
        out.active = deferredActive.merging(out.active) { _, b in b }
        out.previous = deferredPrevious.merging(out.previous) { _, b in b }
        for id in out.active.keys where out.previous[id]?.recordSha256 == out.active[id]?.recordSha256 {
            out.previous[id] = nil
        }
        try opts.state.replace(serializePackState(out))
    }

    private func activate(_ i: PackInstall) async throws {
        if let h = handler(i.type) {
            let storage = opts.storage
            try await h.activate(i, payload: PackPayloadReader { try storage.installed(i) })
        }
        running[i.packId] = i
    }

    /// Steps 12–16 again over a stored record, with its own pack id as the pin; a delegated record
    /// through its stored delegation (plans/P4-19.md §2.4: an installed release stays valid after
    /// its window).
    private func verifyStoredRecord(
        _ jws: String, _ sha256: String, _ packId: String, _ install: PackInstall?,
        _ delegation: String? = nil
    ) async -> Bool {
        let r = verifyReleaseRecord(
            jws,
            options: VerifyReleaseRecordOptions(
                releaseKeys: opts.releaseKeys, productTrust: await opts.productTrust(),
                expectedAud: opts.product, expectedHash: sha256, delegation: delegation))
        guard let rec = r.record, rec.kind == "pack", rec.deliverable == packId,
            let pack = PackRecordDoc(json: rec.json)
        else { return false }
        if let install {
            guard pack.version == install.version, pack.seq == install.seq,
                let v = pack.variants.first(where: { variantKey($0.variant) == install.variant }),
                v.payload.sha256 == install.payloadSha256, v.payload.size == install.payloadSize,
                pack.type == install.type
            else { return false }
        }
        return true
    }

    private func verifyEmbedded(_ e: EmbeddedBaseline) async -> Result<PackInstall, MarkerRefusal> {
        let m = verifyMarker(
            e.marker, releaseKeys: opts.releaseKeys, productTrust: await opts.productTrust(),
            expectedAud: opts.product)
        guard case .ok(let packId, let version, let release, let record, let recordSha256) = m else {
            if case .rejected(let step) = m { return .failure(MarkerRefusal(step: step)) }
            return .failure(MarkerRefusal(step: "format"))
        }
        let match = matchEmbedded(
            packId: packId, record: record, recordSha256: recordSha256, payload: e.payload,
            stamp: opts.stamp)
        switch match {
        case .failure(let r): return .failure(r)
        case .success(let k):
            let v = record.variants[k]
            return .success(
                PackInstall(
                    packId: packId, record: release, recordSha256: recordSha256, version: version,
                    seq: record.seq, type: record.type, variant: variantKey(v.variant),
                    layout: v.files.layout, payloadSha256: v.payload.sha256,
                    payloadSize: v.payload.size,
                    activation: activationOf(record, handler(record.type)), location: e.location,
                    embedded: true, installedAt: record.issuedAt))
        }
    }

    /// P5-08: a platform copy of `packId`, verified like an embedded baseline, then held to the
    /// platform pin rule: `exact` (a decision's target) takes only that release; otherwise the
    /// stamp's pin, or, where the transport floats, a later unrevoked `seq` of the same pack.
    private func verifyPlatform(
        _ e: EmbeddedBaseline, packId: String, exact: String?
    ) async -> Result<PackInstall, PlatformRefusal> {
        let m = verifyMarker(
            e.marker, releaseKeys: opts.releaseKeys, productTrust: await opts.productTrust(),
            expectedAud: opts.product)
        guard case .ok(let markedId, let version, let release, let record, let recordSha256) = m else {
            if case .rejected(let step) = m { return .failure(PlatformRefusal(step: step)) }
            return .failure(PlatformRefusal(step: "format"))
        }
        if !sameBytes(markedId, packId) { return .failure(PlatformRefusal(step: "cross-check")) }
        let k: Int
        switch matchEmbedded(packId: markedId, record: record, recordSha256: recordSha256, payload: e.payload, stamp: nil) {
        case .failure(let r): return .failure(PlatformRefusal(step: r.step))
        case .success(let i): k = i
        }
        let mismatch = PlatformRefusal(step: "pin", mismatch: (recordSha256, version))
        if let exact {
            if recordSha256 != exact { return .failure(mismatch) }
        } else if let pin = opts.stamp?.pins.first(where: { $0.pack == packId }), pin.sha256 != recordSha256 {
            let floats = opts.platform?.floats ?? false
            if !floats || record.seq <= pin.seq || isRevoked(recordSha256) { return .failure(mismatch) }
        }
        let v = record.variants[k]
        return .success(
            PackInstall(
                packId: markedId, record: release, recordSha256: recordSha256, version: version,
                seq: record.seq, type: record.type, variant: variantKey(v.variant),
                layout: v.files.layout, payloadSha256: v.payload.sha256, payloadSize: v.payload.size,
                activation: activationOf(record, handler(record.type)), location: e.location,
                embedded: true, installedAt: record.issuedAt))
    }

    /// P5-08 step 4 for a pack the platform transport carries: the target is bound to the
    /// platform's transport, which the planner may use only while the platform is available here.
    /// No index, seed or object is fetched through the CDN transport.
    private func platformPreflight(
        _ p: any PackPlatformTransport, _ packId: String, _ pinSha: String, _ body: String,
        _ record: PackRecordDoc, _ variant: PackVariant, _ delegated: String?
    ) throws -> Preflight {
        var installs: [PackInstall] = []
        for i in try installsOf(packId) where ((try? opts.storage.installed(i)) ?? nil) != nil {
            installs.append(i)
        }
        var target = planTarget(variant, recordSha256: pinSha, filesIndex: nil)
        target.platform = p.id
        var listed = opts.transports
        if p.unavailable() == nil, !listed.contains(p.id) { listed.append(p.id) }
        let caps = PlanCaps(
            strategies: opts.strategies, patchMethods: [], transports: listed, memBudget: opts.memBudget,
            freeDisk: (try? opts.storage.freeDisk()) ?? 0)
        let planned = plan(
            target: target,
            installed: installs.map {
                PlanInstalled(release: $0.recordSha256, payloadSha256: $0.payloadSha256, chunks: nil, files: nil)
            }, caps: caps)
        if case .error(let e) = planned {
            let why = p.unavailable().map { " (\($0.reason): \($0.detail))" } ?? ""
            throw PackError(
                e, "No way to install \(packId): it is bound to \(p.id), which is not available here\(why).",
                packId: packId)
        }
        return .plan(
            Planned(
                body: body, recordSha256: pinSha, record: record, variant: variant, installs: installs,
                seeds: [:], planId: "", index: nil, plan: planned, delegation: delegated, chunk: nil))
    }

    /// P5-08: the `platform` strategy. The transport delivers the pack, its copy is read again and
    /// accepted under the platform pin rule, registered as this pack's baseline and activated (hot
    /// now; a restart pack mounts at the next boot). Nothing is committed to the state document.
    private func ensurePlatform(_ packId: String, _ recordSha256: String, isPin: Bool) async throws -> PackInstall {
        guard let p = opts.platform else {
            throw PackError(ErrorCode.planTransportUnsupported, "\(packId) is platform-bound.", packId: packId)
        }
        if let u = p.unavailable() {
            throw PackError(ErrorCode.unsupported, u.description, detail: u.reason, packId: packId)
        }
        emit(PackProgress(packId: packId, phase: "download", done: 0, total: 0))
        do {
            try await p.ensure(packId, contentApi: opts.stamp?.contentApi ?? -1) { [weak self] done, total in
                self?.emit(PackProgress(packId: packId, phase: "download", done: done, total: total))
            }
        } catch let e as PackError {
            throw e
        } catch {
            throw PackError(
                ErrorCode.platformError, "\(p.id) could not make \(packId) available: \(error).", packId: packId)
        }
        guard let dir = try await p.locate(packId, contentApi: opts.stamp?.contentApi ?? -1) else {
            throw PackError(
                ErrorCode.platformError, "\(p.id) reports \(packId) ready but holds no copy of it.", packId: packId)
        }
        let b: EmbeddedBaseline
        switch readPlatformBaseline(dir) {
        case .refused(_, let step):
            throw PackError(
                ErrorCode.markerRejected, "\(packId)'s copy from \(p.id) cannot be read as a pack.",
                detail: step, packId: packId)
        case .baseline(let x): b = x
        }
        let install: PackInstall
        switch await verifyPlatform(b, packId: packId, exact: isPin ? nil : recordSha256) {
        case .failure(let r):
            if let (sha, version) = r.mismatch {
                throw PackError(
                    ErrorCode.recordMismatch, "\(p.id) holds \(packId)@\(version) (\(sha)), not the target release.",
                    packId: packId)
            }
            throw PackError(
                ErrorCode.markerRejected, "\(packId)'s copy from \(p.id) was refused at \(r.step).",
                detail: r.step, packId: packId)
        case .success(let i): install = i
        }
        embedded[packId] = install
        platformCopies.insert(packId)
        if install.activation == "hot" {
            if let before = running[packId], before.location != install.location, let h = handler(before.type) {
                try await h.deactivate(before)
            }
            try await activate(install)
        }
        emit(PackProgress(packId: packId, phase: "done", done: 0, total: 0))
        return install
    }

    /// The installs of a pack the planner can reuse: active, previous and the embedded copy.
    private func installsOf(_ packId: String) throws -> [PackInstall] {
        let doc = try requireLoaded()
        var out: [PackInstall] = []
        var seen = Set<String>()
        for i in [doc.active[packId], embedded[packId], doc.previous[packId]] {
            if let i, seen.insert(i.location).inserted { out.append(i) }
        }
        return out
    }

    /// Step 2 for one pin: the record fetched by hash and verified against the pinned release
    /// keys, a delegated one through its delegation (plans/P4-19.md §2.3). Returns the body, the
    /// record and the delegation's compact JWS (or nil). `preflight` and `packFor` (P4-20) share
    /// it, as client-core's `fetchVerified`.
    private func fetchVerified(
        _ packId: String, _ release: ReleasePin
    ) async throws -> (String, PackRecordDoc, String?) {
        let body: String
        switch await opts.fetchRecord(release.sha256) {
        case .ok(let b): body = b
        case .failed(let code):
            throw PackError(code, "Fetching \(packId)'s record failed (\(code)).", packId: packId)
        }
        // plans/P4-19.md §2.3, §2.4: a `pkd1-` kid names its delegation, fetched by hash, only on
        // the delegated surface (a feed target that is neither the stamp's pin or hold for this pack
        // nor a stored revocation's replacement). Elsewhere step 13 refuses it at `jws`.
        var delegation: String?
        if let h = delegationHashOf(body), delegatedAllowed(packId, release.sha256) {
            delegation = try await fetchDelegation(packId, h)
        }
        let v = verifyReleaseRecord(
            body,
            options: VerifyReleaseRecordOptions(
                releaseKeys: opts.releaseKeys, productTrust: await opts.productTrust(),
                expectedAud: opts.product, expectedHash: release.sha256,
                pin: ReleaseRecordPin(kind: "pack", deliverable: packId, version: release.version, seq: release.seq),
                delegation: delegation))
        if let d = v.delegation {
            delegatedKnown[release.sha256] = DelegatedRelease(pack: packId, delegation: d.sha256)
            if revokedBy(release.sha256, d.sha256) != nil {
                throw PackError(
                    ErrorCode.packRevoked,
                    "\(packId)@\(release.version) was signed under a delegation its developer revoked.",
                    detail: "delegation", packId: packId)
            }
        }
        let delegated = v.delegation != nil ? delegation : nil
        let record: PackRecordDoc
        switch v {
        case .refused(.crossCheck):
            throw PackError(
                ErrorCode.recordMismatch, "\(packId)'s record is not the pinned release.", packId: packId)
        case .refused(let step):
            throw PackError(
                ErrorCode.recordRejected, "\(packId)'s record was refused at \(step.rawValue).",
                detail: step.rawValue, packId: packId)
        case .ok(let rec), .delegated(let rec, _):
            guard let p = PackRecordDoc(json: rec.json) else {
                throw PackError(
                    ErrorCode.recordRejected, "\(packId)'s record was refused at claims.",
                    detail: "claims", packId: packId)
            }
            record = p
        }
        return (body, record, delegated)
    }

    /// Steps 1–4 for one pack: what is already current, or the verified record, the variant, the
    /// seeds, the index and the plan.
    private func preflight(_ packId: String, want: ReleasePin? = nil) async throws -> Preflight {
        let doc = try requireLoaded()
        guard let stamp = opts.stamp else {
            throw PackError(
                ErrorCode.notConfigured, "This build ships no content stamp, so it has no packs.",
                packId: packId)
        }
        let stampPin = stamp.pins.first(where: { $0.pack == packId })
        let pin: ContentPin? =
            want.map { ContentPin(pack: packId, sha256: $0.sha256, seq: $0.seq, version: $0.version) } ?? stampPin
        guard let pin else {
            throw PackError(
                ErrorCode.packNotPinned, "The content stamp pins no release of \(packId).",
                packId: packId)
        }
        // plans/P4-13.md §2.5: a revoked release is never installed, activated or mounted.
        if isRevoked(pin.sha256) {
            throw PackError(
                ErrorCode.packRevoked, "\(packId)@\(pin.version) was revoked by its developer.",
                packId: packId)
        }

        // Already current: the active install, or the embedded copy, is the pinned release.
        let current = doc.active[packId]
        if let current, current.recordSha256 == pin.sha256 {
            // plans/P4-19.md §2.6: a release under a revoked delegation is refused like a revoked one.
            if installRevoked(current) {
                throw PackError(
                    ErrorCode.packRevoked,
                    "\(packId)@\(pin.version) was signed under a delegation its developer revoked.",
                    detail: "delegation", packId: packId)
            }
            return .current(current)
        }
        if let emb = embedded[packId], emb.recordSha256 == pin.sha256, current == nil, !embeddedRefused(emb) {
            return .current(emb)
        }
        // P5-08: the stamp's pin, with the platform holding a later release it may float to.
        if want == nil, current == nil, platformCopies.contains(packId), let emb = embedded[packId],
            opts.platform?.floats == true, emb.seq > pin.seq, !embeddedRefused(emb)
        {
            return .current(emb)
        }

        // 2. The pinned record, by hash, against the pinned release keys.
        let (body, record, delegated) = try await fetchVerified(
            packId, ReleasePin(sha256: pin.sha256, seq: pin.seq, version: pin.version))

        // 3. Type, entitlement, variant.
        guard let h = handler(record.type), h.supports(record.formatVersion),
            record.activation == nil || record.activation == "hot" || record.activation == "restart"
        else {
            throw PackError(
                ErrorCode.packTypeUnsupported,
                "\(packId) is a \(record.type) v\(record.formatVersion) pack, which this SDK cannot hold.",
                packId: packId)
        }
        if let ent = record.entitlement, let granted = await opts.entitlements(), !granted.contains(ent) {
            throw PackError(
                ErrorCode.packNotEntitled, "\(packId) needs the \(ent) entitlement.", packId: packId)
        }
        let rawVariants = record.json.objectValue?["variants"]?.arrayValue ?? []
        guard case .index(let k) = selectVariant(rawVariants, opts.prefs) else {
            throw PackError(ErrorCode.packNoVariant, "No variant of \(packId) is eligible here.", packId: packId)
        }
        let variant = record.variants[k]
        if variant.files.layout != h.layout {
            throw PackError(
                ErrorCode.packTypeUnsupported,
                "\(packId)'s variant is a \(variant.files.layout), not a \(h.layout).", packId: packId)
        }

        if let p = opts.platform, p.carries(packId) {
            return try platformPreflight(p, packId, pin.sha256, body, record, variant, delegated)
        }

        // 4. The index (a tree, or any installed release), the target, the plan. Only installs
        // whose bytes can be opened count as installed: the planner must not choose a delta from
        // a base the appliers cannot read.
        var seeds: [String: InstalledPayload] = [:]
        var installs: [PackInstall] = []
        for i in try installsOf(packId) {
            if let p = (try? opts.storage.installed(i)) ?? nil {
                seeds[i.location] = p
                installs.append(i)
            }
        }
        // plans/P4-29.md §2.4 step 6: a journal whose delta neither the record nor its own
        // `feedDelta` names is abandoned and re-planned.
        let prior = doc.inflight[packId]
        let early = preflightPlans[packId]
        let planId: String
        let priorUsable =
            prior.map {
                $0.recordSha256 == pin.sha256 && $0.variant == variantKey(variant.variant)
                    && journalDeltaKnown($0, variant)
            } ?? false
        if let prior, priorUsable {
            planId = prior.planId
        } else if let early, early.recordSha256 == pin.sha256 {
            planId = early.planId
        } else {
            planId = opts.newPlanId()
        }
        preflightPlans[packId] = (planId, pin.sha256)
        var index: FilesIndexDoc?
        let needIndex = variant.files.layout == "tree" || seeds.values.contains { $0.files != nil }
        // Bound the index before a byte of it is staged (plans/P4-01.md §2.7 step 1).
        let indexOk = indexReadable(variant.files) && variant.files.bytes <= MAX_FILES_INDEX_BYTES
        if needIndex && !indexOk && variant.files.layout == "tree" {
            throw PackError(
                ErrorCode.filesIndexInvalid,
                "\(packId)'s files index is unreadable here or over the size limit.", packId: packId)
        }
        if needIndex && indexOk {
            var noProgress: (done: Int, total: Int)? = nil
            let ok = await downloadInto(
                planId, packId, (variant.files.sha256, variant.files.bytes), &noProgress)
            if ok {
                let staged = try opts.storage.stagedObject(planId, variant.files.sha256)
                let zstd = opts.zstd
                let r = parseFilesIndex(
                    try readAll(try staged.source()), ref: variant.files, payload: variant.payload,
                    decode: { try zstd.decode($0, size: $1) })
                switch r {
                case .ok(let i): index = i
                case .refused(let error, let path):
                    if variant.files.layout == "tree" {
                        throw PackError(error, "\(packId)'s files index was refused.", path: path, packId: packId)
                    }
                }
            } else if variant.files.layout == "tree" {
                throw PackError(
                    ErrorCode.networkError, "Fetching \(packId)'s files index failed.", packId: packId)
            }
        }
        // plans/P4-19.md §2.5: a delegated release's extension rule over the files index, before
        // any payload object is fetched.
        if delegated != nil {
            guard let index else {
                throw PackError(
                    ErrorCode.filesIndexInvalid,
                    "\(packId)'s files index is required for a delegated release.", packId: packId)
            }
            for f in index.files where dataOnlyPathRefusal(f.path) != nil {
                throw PackError(
                    ErrorCode.packNotDataOnly,
                    "\(packId) holds \(f.path), which a delegated content key may not ship.",
                    detail: DataOnlyRule.extension.rawValue, path: f.path, packId: packId)
            }
        }
        // P4-11's fetch rule (plans/P4-10.md §2.5): the target chunk index is staged and parsed
        // before planning when the strategy is allowed, the record is not delegated (a delegated
        // release is a tree, and chunks are container-only), the variant's `chunks` is usable and
        // at least one seed index is stored. Anything that fails leaves it nil, never an error.
        var chunk: ChunkContext?
        if opts.strategies.contains("chunk"), opts.supportsRange, delegated == nil, variant.files.layout == "container",
            let chunksRef = usableChunksRef(variant), opts.storage.chunkIndexes != nil
        {
            let list = chunkSeeds(packId, installs, seeds)
            if !list.isEmpty {
                var noProgress: (done: Int, total: Int)? = nil
                let ok = await downloadInto(planId, packId, (chunksRef.sha256, chunksRef.bytes), &noProgress)
                if ok, let staged = try? opts.storage.stagedObject(planId, chunksRef.sha256),
                    let bytes = try? readAll(try staged.source())
                {
                    let zstd = opts.zstd
                    if case .ok(let parsed) = parseChunkIndex(
                        bytes, ref: chunksRef, payload: variant.payload, decode: { try zstd.decode($0, size: $1) })
                    {
                        chunk = ChunkContext(index: parsed, seeds: list)
                    }
                }
            }
        }
        // plans/P4-29.md §2.4 steps 1–2 and 6: the committed feed's menu, plus a resumed journal's
        // own feed delta, join the record's deltas (a record delta wins a shared id).
        var merged = withFeedDeltas(variant, feedMenu())
        var feedIds = Set(merged.feedIds)
        if let prior, priorUsable, prior.strategy == "delta", let fd = prior.feedDelta {
            let again = withFeedDeltas(merged.variant, [variant.payload.sha256: [fd]])
            feedIds.formUnion(again.feedIds)
            merged = (again.variant, Array(feedIds))
        }
        var target = planTarget(
            merged.variant, recordSha256: pin.sha256, filesIndex: index, chunkIndex: chunk?.index.planIndex)
        if let budget = opts.oneShotBudget, target.full != nil, let full = variant.full,
            !(full.codec == "zstd" && opts.zstd.canStream), full.bytes + full.size > budget
        {
            target.full = nil
        }
        // Seeds count only when the target index parsed. This pack's installs carry their chunk
        // ids; every other seed (another pack's payload, an embedded baseline) rides along as a
        // synthetic entry whose payload is never a hash, so `noop` and `delta` never match it.
        var plannerInstalled = installs.map { i in
            PlanInstalled(
                release: i.recordSha256, payloadSha256: i.payloadSha256,
                chunks: chunk?.seeds.first { $0.location == i.location }?.seed.index.records.map(\.id),
                files: seeds[i.location]?.files?.map(\.sha256))
        }
        for e in chunk?.seeds ?? [] where !installs.contains(where: { $0.location == e.location }) {
            plannerInstalled.append(
                PlanInstalled(
                    release: "", payloadSha256: "seed:" + e.payloadSha256,
                    chunks: e.seed.index.records.map(\.id), files: nil))
        }
        let caps = PlanCaps(
            strategies: opts.supportsRange ? opts.strategies : opts.strategies.filter { $0 != "chunk" },
            patchMethods: opts.patchMethods, transports: opts.transports,
            memBudget: opts.memBudget, freeDisk: (try? opts.storage.freeDisk()) ?? 0)
        let p = plan(target: target, installed: plannerInstalled, caps: caps)
        if case .error(let e) = p {
            throw PackError(e, "No way to install \(packId): \(e).", packId: packId)
        }
        return .plan(
            Planned(
                body: body, recordSha256: pin.sha256, record: record, variant: merged.variant,
                installs: installs, seeds: seeds, planId: planId, index: index, plan: p,
                delegation: delegated, chunk: chunk, feedIds: feedIds))
    }

    /// The committed feed's delta menu, or nil.
    private func feedMenu() -> FeedDeltas? { opts.feedDeltas?() }

    /// The chunk seeds for a pack (P4-11), deduplicated by payload, in this order: the pack's own
    /// readable installs, every other pack's active then previous install (by pack id), then the
    /// embedded baselines (by pack id). A seed is a container whose own record's variant carries a
    /// usable `chunks` ref, whose stored index parses bound to the installed payload, and whose
    /// payload opens. Stored indexes are never trusted: each is parsed again here.
    private func chunkSeeds(
        _ packId: String, _ own: [PackInstall], _ opened: [String: InstalledPayload]
    ) -> [SeedEntry] {
        guard let store = opts.storage.chunkIndexes, let doc else { return [] }
        let others = Set(doc.active.keys).union(doc.previous.keys).filter { !sameBytes($0, packId) }
            .sorted { compareUTF8Bytes($0, $1) < 0 }
        var candidates = own
        for id in others {
            for case let i? in [doc.active[id], doc.previous[id]] { candidates.append(i) }
        }
        for id in embedded.keys.sorted(by: { compareUTF8Bytes($0, $1) < 0 }) where !sameBytes(id, packId) {
            candidates.append(embedded[id]!)
        }
        var out: [SeedEntry] = []
        var payloads = Set<String>()
        var locations = Set<String>()
        let zstd = opts.zstd
        for i in candidates {
            if i.layout != "container" || payloads.contains(i.payloadSha256) { continue }
            if locations.contains(i.location) || unverifiable.contains(i.location) { continue }
            if isRevoked(i.recordSha256) { continue }
            guard let ref = installChunksRef(i), let stored = (try? store.get(ref.sha256)) ?? nil else { continue }
            guard case .ok(let index) = parseChunkIndex(
                stored, ref: ref, payload: PackPayload(size: i.payloadSize, sha256: i.payloadSha256),
                decode: { try zstd.decode($0, size: $1) })
            else { continue }
            let p = opened[i.location] ?? ((try? opts.storage.installed(i)) ?? nil)
            guard let source = p?.payload, source.size == i.payloadSize else { continue }
            payloads.insert(i.payloadSha256)
            locations.insert(i.location)
            out.append(
                SeedEntry(
                    location: i.location, payloadSha256: i.payloadSha256,
                    seed: ChunkSeed(index: index, payload: source)))
        }
        return out
    }

    /// After a pack is ensured (P4-11): keep the chunk index of every root install and embedded
    /// baseline that has one and lacks it, fetched by hash, verified against its record and its
    /// installed payload, and stored by `chunks.sha256`. Best effort: a failure only means no seed.
    private func storeSeedIndexes() async {
        guard let store = opts.storage.chunkIndexes, opts.strategies.contains("chunk"), opts.supportsRange, let doc
        else { return }
        var have = Set((try? store.list()) ?? [])
        let zstd = opts.zstd
        for i in Array(doc.active.values) + Array(doc.previous.values) + Array(embedded.values) {
            guard i.layout == "container", let ref = installChunksRef(i), !have.contains(ref.sha256),
                !seedIndexTried.contains(ref.sha256)
            else { continue }
            // Once per index per engine (process): a missing or unusable one is not refetched at
            // every ensure.
            seedIndexTried.insert(ref.sha256)
            guard let res = try? await opts.fetchObject(ObjectRequest(sha256: ref.sha256, offset: 0, ifRange: nil)),
                res.status == 200
            else { continue }
            var stored: [UInt8] = []
            var over = false
            do {
                for try await c in res.chunks {
                    if stored.count + c.count > ref.bytes {
                        over = true
                        break
                    }
                    stored += c
                }
            } catch {
                continue
            }
            if over || stored.count != ref.bytes { continue }
            guard case .ok = parseChunkIndex(
                stored, ref: ref, payload: PackPayload(size: i.payloadSize, sha256: i.payloadSha256),
                decode: { try zstd.decode($0, size: $1) })
            else { continue }
            if (try? store.put(ref.sha256, stored)) != nil { have.insert(ref.sha256) }
        }
    }

    /// The chunk strategy (P4-11; plans/P4-10.md §2.5): `applyChunk` over the staged target index,
    /// the seeds the preflight found, single-range requests through `chunkRangeFetch` (exact
    /// `Content-Range`, `If-Range` on the bundle hash) and the plan's container output, resumed from
    /// the run journal (`staging/<planId>/journal.json`), with the repair pass. A delegated release
    /// never gets here: it is a tree (plans/P4-19.md §2.3), `planTarget` maps a tree's `chunks` to
    /// nil, and the fetch rule requires a record that is not delegated.
    private func applyChunkPlan(
        _ planId: String, _ packId: String, _ variant: PackVariant, _ chunk: ChunkContext, total: Int
    ) async throws -> ChunkVerdict {
        guard let ref = usableChunksRef(variant), variant.files.layout == "container" else {
            return .failed(error: ErrorCode.chunksRefMismatch, chunk: nil, bundle: nil, detail: nil)
        }
        let storage = opts.storage
        let out = try storage.output(planId, "container", resume: true)
        guard let sink = out.sink, let read = out.read else {
            return .failed(error: ErrorCode.chunksRefMismatch, chunk: nil, bundle: nil, detail: nil)
        }
        let seeds = chunk.seeds.map(\.seed)
        var seeded = Set<String>()
        for s in seeds { for r in s.index.records { seeded.insert(r.id) } }
        let runs = chunkRuns(chunk.index.records) { seeded.contains($0) }.count
        let journal = storage.runJournal
        let done = Locked(readRunJournal((try? journal?.read(planId)) ?? nil, index: ref.sha256, runs: runs))
        let base = ref.bytes
        emit(PackProgress(packId: packId, phase: "download", done: Swift.min(base, total), total: total))
        let r = await applyChunk(
            variant, seeds: seeds,
            ApplyChunkPorts(
                objects: { sha256 in
                    let o = try storage.stagedObject(planId, sha256)
                    return try o.size() > 0 ? try o.source() : nil
                },
                zstd: opts.zstd, fetchRange: chunkRangeFetch(opts.fetchObject),
                output: PackChunkOutput(sink: sink, reader: read)),
            repair: true, completedRuns: done.with { $0 },
            onRunDone: { k in
                let text = done.with { d -> String in
                    d.insert(k)
                    return writeRunJournal(index: ref.sha256, runs: runs, done: d)
                }
                // Best effort: a journal that cannot be written only costs refetching.
                try? journal?.write(planId, text)
            },
            onProgress: { [weak self] fetched in
                self?.emit(
                    PackProgress(packId: packId, phase: "download", done: Swift.min(total, base + fetched), total: total))
            })
        return r.verdict
    }

    /// Keep a chunk plan's staged target index in the seed store (best effort).
    private func keepStagedIndex(_ planId: String, _ variant: PackVariant) {
        guard let store = opts.storage.chunkIndexes, let ref = usableChunksRef(variant),
            let o = try? opts.storage.stagedObject(planId, ref.sha256), (try? o.size()) == ref.bytes,
            let bytes = try? readAll(try o.source())
        else { return }
        try? store.put(ref.sha256, bytes)
    }

    /// §2.4's delegated surface: never the stamp's pin or hold for the pack, never a stored
    /// revocation's replacement (release-key surfaces vouch for exact bytes).
    private func delegatedAllowed(_ packId: String, _ sha256: String) -> Bool {
        if opts.stamp?.pins.contains(where: { $0.pack == packId && $0.sha256 == sha256 }) == true {
            return false
        }
        if opts.holds.contains(where: { $0.pack == packId && $0.release.sha256 == sha256 }) { return false }
        for r in revVerified.values where r.replacement?.sha256 == sha256 { return false }
        return true
    }

    /// A delegation record by hash: this process's copy, else fetched (at most
    /// `MAX_DELEGATIONS_PER_CHECK` distinct ones per call; a target beyond that waits).
    private func fetchDelegation(_ packId: String, _ hash: String) async throws -> String {
        if let have = delegationBodies[hash] { return have }
        if delegationBudget <= 0 {
            throw PackError(
                ErrorCode.networkError,
                "\(packId)'s delegation was not fetched: this call reached its delegation bound; the next one retries.",
                detail: "delegation", packId: packId)
        }
        delegationBudget -= 1
        switch await opts.fetchRecord(hash) {
        case .failed(let code):
            throw PackError(
                code, "Fetching \(packId)'s delegation failed (\(code)).", detail: "delegation",
                packId: packId)
        case .ok(let body):
            // Kept only when it is the record the hash names; `verifyReleaseRecord` checks it again.
            if recordHash(body) == hash { delegationBodies[hash] = body }
            return body
        }
    }

    private func ensureOne(_ packId: String, target: ReleasePin? = nil) async throws -> PackInstall {
        do {
            let install = try await ensureOneInner(packId, target: target)
            await storeSeedIndexes()
            return install
        } catch let e as PackError {
            // plans/P4-13.md §2.5: when the only copy is an embedded baseline refused for `relearn`
            // (or for `revocationsStored` with an unreadable `revocations.json`) and the fetch
            // cannot proceed, the typed refusal is `pack-revoked` with detail `relearn`.
            let want = target?.sha256 ?? opts.stamp?.pins.first(where: { $0.pack == packId })?.sha256
            if e.code != ErrorCode.packRevoked, let emb = embedded[packId], emb.recordSha256 == want,
                !isRevoked(emb.recordSha256), embeddedRefused(emb)
            {
                throw PackError(
                    ErrorCode.packRevoked,
                    "\(packId)'s embedded copy is refused until a fresh feed re-teaches its revocations, and it cannot be fetched (\(e.code)).",
                    detail: "relearn", packId: packId)
            }
            throw e
        }
    }

    private func ensureOneInner(_ packId: String, target: ReleasePin?) async throws -> PackInstall {
        let pre: Planned
        switch try await preflight(packId, want: target) {
        case .current(let current):
            if current.embedded != true, running[packId] == nil, current.activation == "hot" {
                try await activate(current)
            }
            return current
        case .plan(let p): pre = p
        }
        let variant = pre.variant
        preflightPlans[packId] = nil
        var candidates: [PlanCandidate] = []
        switch pre.plan {
        case .chosen(let c, _, let fallbacks):
            if c.strategy == "noop" {
                let same = pre.installs.first { $0.payloadSha256 == variant.payload.sha256 }!
                // P5-08: a platform copy is never committed to the state; it stands as the install.
                if platformCopies.contains(packId), let emb = embedded[packId], emb.location == same.location {
                    if running[packId] == nil, emb.activation == "hot" { try await activate(emb) }
                    return emb
                }
                // plans/P4-19.md Amendment A1: a delegated release that reuses an install holding
                // the same payload re-sniffs that install's files, so the data-only rule holds
                // whatever admitted the bytes first.
                if pre.delegation != nil {
                    guard let files = pre.seeds[same.location]?.files else {
                        throw PackError(
                            ErrorCode.packNotDataOnly,
                            "\(packId)'s reused install cannot be re-checked by the data-only rule.",
                            detail: DataOnlyRule.content.rawValue, packId: packId)
                    }
                    for f in files {
                        if let rule = dataOnlyFileRefusal(f.path, try readAll(f.source)) {
                            throw PackError(
                                ErrorCode.packNotDataOnly,
                                "\(packId) holds \(f.path), which a delegated content key may not ship (\(rule.rawValue)).",
                                detail: rule.rawValue, path: f.path, packId: packId)
                        }
                    }
                }
                return try await commit(
                    packId, pre.body, pre.recordSha256, pre.record, variant, same.location,
                    stagingPlan: pre.planId, reused: true, delegation: pre.delegation)
            }
            candidates = [c] + fallbacks
        case .platform:
            return try await ensurePlatform(packId, pre.recordSha256, isPin: target == nil)
        case .error(let e):
            throw PackError(e, "No way to install \(packId): \(e).", packId: packId)
        }

        // 5–6. Each candidate in turn: journal, fetch, apply. plans/P4-29.md §2.4 step 5: at most
        // one feed-offered delta per install; once it fails the rest of the menu is skipped.
        var firstFailure: PackError?
        var feedTried = false
        for cand in candidates {
            let fromFeed = cand.strategy == "delta" && cand.delta.map { pre.feedIds.contains($0) } == true
            if fromFeed && feedTried { continue }
            let feedDelta = fromFeed ? feedEntryOf(variant, cand.delta!) : nil
            if fromFeed && feedDelta == nil { continue }
            if fromFeed { feedTried = true }
            let listed: [(sha256: String, bytes: Int)]?
            if cand.strategy == "chunk" {
                // The index only (staged by the fetch rule); the runs are fetched by the applier.
                // Never for a delegated record (its writes must all pass the data-only sink).
                listed =
                    pre.chunk != nil && pre.delegation == nil
                    ? usableChunksRef(variant).map { [($0.sha256, $0.bytes)] } : nil
            } else {
                listed = objectsFor(cand.strategy, cand.delta, variant, pre.index, pre.seeds)
            }
            guard let objects = listed else { continue }
            let journal = PackJournal(
                planId: pre.planId, packId: packId, record: pre.body, recordSha256: pre.recordSha256,
                variant: variantKey(variant.variant), strategy: cand.strategy, delta: cand.delta,
                objects: objects.map { JournalObject(sha256: $0.sha256, bytes: $0.bytes, done: 0) },
                startedAt: await opts.now(), delegation: pre.delegation, feedDelta: feedDelta)
            doc = beginInstall(try requireLoaded(), journal)
            try persist()
            // A chunk plan's total is the planner's (the index and every fetched run).
            let total =
                cand.strategy == "chunk"
                ? Swift.max(cand.bytes, objects.first?.bytes ?? 0) : objects.reduce(0) { $0 + $1.bytes }
            var progress = (done: 0, total: total)
            emit(PackProgress(packId: packId, phase: "download", done: 0, total: total))
            var fetched = true
            for o in objects {
                let ok = await download(pre.planId, packId, o, progress: &progress)
                if !ok {
                    // plans/P4-29.md §2.4 step 5: a feed delta that cannot be fetched (a cold
                    // delta's 404, say) falls back like any other failure of that candidate.
                    if fromFeed {
                        fetched = false
                        break
                    }
                    // The journal and what is staged stay for the next `ensure`, which resumes.
                    throw PackError(
                        ErrorCode.networkError,
                        "Fetching \(packId)'s objects failed; the next ensure resumes.", packId: packId)
                }
            }
            let result: ApplyResult
            let refusal: DataOnlyRefusalSeen?
            if !fetched {
                result = ApplyResult(verdict: .failed(error: ErrorCode.networkError, path: nil), index: nil)
                refusal = nil
            } else if cand.strategy == "chunk", let chunk = pre.chunk {
                let v = try await applyChunkPlan(pre.planId, packId, variant, chunk, total: total)
                emit(PackProgress(packId: packId, phase: "apply", done: total, total: total))
                refusal = nil
                switch v {
                case .ok(let c):
                    result = ApplyResult(verdict: .container(sha256: c.sha256, size: c.size, counters: nil), index: nil)
                    // The target index becomes a seed for the next release (best effort).
                    keepStagedIndex(pre.planId, variant)
                case .failed(let error, _, _, let detail):
                    if error == ErrorCode.networkError && detail == "interrupted" {
                        // The state journal, the staged index, the output and the run journal stay
                        // for the next `ensure`, which resumes the completed runs (re-hashed).
                        throw PackError(
                            ErrorCode.networkError, "Fetching \(packId)'s chunks failed; the next ensure resumes.",
                            detail: "chunk", packId: packId)
                    }
                    result = ApplyResult(verdict: .failed(error: error, path: nil), index: nil)
                }
            } else {
                emit(PackProgress(packId: packId, phase: "apply", done: total, total: total))
                // plans/P4-19.md §2.5: every file a delegated install writes passes the data-only rule.
                (result, refusal) = try apply(
                    pre.planId, packId, cand.strategy, cand.delta, variant, pre.seeds,
                    dataOnly: pre.delegation != nil)
            }
            if let r = refusal {
                // A refusal aborts the plan: no fallback, staging discarded.
                doc = abandonInstall(try requireLoaded(), packId: packId)
                try persist()
                try? opts.storage.removeStaging(pre.planId)
                throw PackError(
                    ErrorCode.packNotDataOnly,
                    "\(packId) holds \(r.path), which a delegated content key may not ship (\(r.rule.rawValue)).",
                    detail: r.rule.rawValue, path: r.path, packId: packId)
            }
            if result.verdict.ok {
                let location = try opts.storage.commit(
                    pre.planId, packId, variant.payload.sha256, variant.files.layout,
                    result.index ?? pre.index)
                try await typeCheck(
                    packId, pre.record, variant, location, planId: pre.planId, delegation: pre.delegation)
                let install = try await commit(
                    packId, pre.body, pre.recordSha256, pre.record, variant, location,
                    stagingPlan: pre.planId, reused: false, delegation: pre.delegation)
                emit(PackProgress(packId: packId, phase: "done", done: total, total: total))
                return install
            }
            if case .failed(let error, let path) = result.verdict, firstFailure == nil {
                firstFailure = PackError(
                    error, "Installing \(packId) by \(cand.strategy) failed: \(error).",
                    detail: cand.strategy, path: path, packId: packId)
            }
            try? opts.storage.removeStaging(pre.planId)
        }
        doc = abandonInstall(try requireLoaded(), packId: packId)
        try persist()
        try? opts.storage.removeStaging(pre.planId)
        throw firstFailure
            ?? PackError(ErrorCode.planNoStrategy, "No way to install \(packId).", packId: packId)
    }

    /// The objects a strategy fetches, in order; nil when the strategy cannot run here.
    private func objectsFor(
        _ strategy: String, _ delta: String?, _ variant: PackVariant, _ index: FilesIndexDoc?,
        _ seeds: [String: InstalledPayload]
    ) -> [(sha256: String, bytes: Int)]? {
        let files = variant.files
        let idx = (sha256: files.sha256, bytes: files.bytes)
        var gaps: [(sha256: String, bytes: Int)] = []
        if files.layout == "container", let g = files.gaps { gaps = [(g.sha256, g.bytes)] }
        switch strategy {
        case "full":
            guard let full = variant.full else { return nil }
            return files.layout == "tree" ? [idx, (full.sha256, full.bytes)] : [(full.sha256, full.bytes)]
        case "delta":
            guard let d = variant.deltas.first(where: { $0.id == delta && $0.id != nil }) else {
                return nil
            }
            switch d {
            case .payload(_, _, _, let a): return [(a.sha256, a.bytes)]
            case .files(_, _, _, let patch, let data):
                return [idx] + gaps + [(patch.sha256, patch.bytes), (data.sha256, data.bytes)]
            case .other: return nil
            }
        case "file":
            guard let index else { return nil }
            var held = Set<String>()
            for s in seeds.values { for f in s.files ?? [] { held.insert(f.sha256) } }
            var blobs: [(sha256: String, bytes: Int)] = []
            var seen = Set<String>()
            for f in index.files where !held.contains(f.sha256) && !seen.contains(f.blob.sha256) {
                seen.insert(f.blob.sha256)
                blobs.append((f.blob.sha256, f.blob.bytes))
            }
            return [idx] + gaps + blobs
        default:
            return nil
        }
    }

    private func apply(
        _ planId: String, _ packId: String, _ strategy: String, _ delta: String?,
        _ variant: PackVariant, _ seeds: [String: InstalledPayload], dataOnly: Bool
    ) throws -> (ApplyResult, DataOnlyRefusalSeen?) {
        let out = try storage(planId, variant.files.layout)
        var tree = out.tree
        var guarded: DataOnlyTreeSink?
        if dataOnly, let inner = tree {
            guarded = DataOnlyTreeSink(inner)
            tree = guarded
        }
        let result = try applyWith(
            planId, packId, strategy, delta, variant, seeds, PackOutput(sink: out.sink, tree: tree))
        return (result, guarded?.seen.with { $0 })
    }

    private func storage(_ planId: String, _ layout: String) throws -> PackOutput {
        try opts.storage.output(planId, layout)
    }

    private func applyWith(
        _ planId: String, _ packId: String, _ strategy: String, _ delta: String?,
        _ variant: PackVariant, _ seeds: [String: InstalledPayload], _ out: PackOutput
    ) throws -> ApplyResult {
        let storage = opts.storage
        let objects: ObjectPort = { sha256 in
            let o = try storage.stagedObject(planId, sha256)
            return try o.size() > 0 || sha256 == EMPTY_SHA256 ? try o.source() : nil
        }
        let ports = ApplyPorts(objects: objects, zstd: opts.zstd, sink: out.sink, tree: out.tree)
        if strategy == "full" { return applyFull(variant, ports) }
        var installed: [InstalledFile] = []
        for s in seeds.values { installed += s.files ?? [] }
        if strategy == "file" { return applyFile(variant, nil, installed: installed, ports) }
        guard let k = variant.deltas.firstIndex(where: { $0.id == delta && $0.id != nil }) else {
            return ApplyResult(verdict: .failed(error: ErrorCode.deltaArtifactMismatch, path: nil), index: nil)
        }
        if case .files = variant.deltas[k] { return applyFile(variant, k, installed: installed, ports) }
        // A payload delta's base: the installed payload whose hash is `from`.
        var base: (any ByteSource)?
        for i in try installsOf(packId) {
            if base == nil, i.payloadSha256 == variant.deltas[k].from, let p = seeds[i.location]?.payload {
                base = p
            }
        }
        guard let base else {
            return ApplyResult(verdict: .failed(error: ErrorCode.deltaBaseMismatch, path: nil), index: nil)
        }
        return applyDelta(variant, k, base: base, ports)
    }

    /// The handler's type check over a newly staged payload now in the store (CONTENT §4.1
    /// `verify`; P4-16). A refusal (a throwing check is one, `check`; a payload the storage cannot
    /// read back is one, `unreadable`) abandons the install, discards staging, collects the stored
    /// payload (no root holds it) and raises `pack-type-check-failed`.
    private func typeCheck(
        _ packId: String, _ record: PackRecordDoc, _ variant: PackVariant, _ location: String,
        planId: String, delegation: String?
    ) async throws {
        guard let h = handler(record.type) else { return }
        let provisional = PackInstall(
            packId: packId, record: "", recordSha256: "", version: record.version, seq: record.seq,
            type: record.type, variant: variantKey(variant.variant), layout: variant.files.layout,
            payloadSha256: variant.payload.sha256, payloadSize: variant.payload.size,
            activation: activationOf(record, h), location: location, embedded: nil,
            installedAt: await opts.now(), delegation: delegation)
        var refusal: PackCheckRefusal?
        do {
            if let got = try opts.storage.installed(provisional) {
                // Index (path byte) order, whatever order the storage lists them in, so every SDK
                // names the same first refused file.
                let p = sortedPayload(got)
                refusal = try await h.check(
                    StagedPack(
                        packId: packId, record: record, variant: variant, location: location,
                        files: p.files ?? [], payload: p.payload))
            } else {
                refusal = PackCheckRefusal("unreadable", message: "the stored payload cannot be read back")
            }
        } catch {
            refusal = PackCheckRefusal("check", message: "\(error)")
        }
        guard let r = refusal else { return }
        let detail = isPackToken(r.detail) ? r.detail : "check"
        doc = abandonInstall(try requireLoaded(), packId: packId)
        try persist()
        try? opts.storage.removeStaging(planId)
        collect()
        let at = r.path.map { ", \($0)" } ?? ""
        let tail = r.message.map { ": \($0)" } ?? "."
        throw PackError(
            ErrorCode.packTypeCheckFailed, "\(packId) failed its \(record.type) check (\(detail)\(at))\(tail)",
            detail: detail, path: r.path, packId: packId)
    }

    /// Commit: the pointer swap, activation, garbage collection.
    private func commit(
        _ packId: String, _ recordJws: String, _ recordSha256: String, _ record: PackRecordDoc,
        _ variant: PackVariant, _ location: String, stagingPlan: String, reused: Bool,
        delegation: String? = nil
    ) async throws -> PackInstall {
        let install = PackInstall(
            packId: packId, record: recordJws, recordSha256: recordSha256, version: record.version,
            seq: record.seq, type: record.type, variant: variantKey(variant.variant),
            layout: variant.files.layout, payloadSha256: variant.payload.sha256,
            payloadSize: variant.payload.size, activation: activationOf(record, handler(record.type)),
            location: location, embedded: embedded[packId]?.location == location ? true : nil,
            installedAt: await opts.now(), delegation: delegation)
        // A fresh commit supersedes this pack's entries whose check could not run; an active one
        // becomes `previous`, re-verified before a rollback uses it.
        let carried = deferredActive[packId]
        deferredActive[packId] = nil
        deferredPrevious[packId] = nil
        let before = running[packId]
        var next = commitInstall(try requireLoaded(), install)
        if let carried, carried.recordSha256 != install.recordSha256 {
            next.previous[packId] = carried
            unverifiedPrevious.insert(packId)
        } else {
            unverifiedPrevious.remove(packId)
        }
        doc = next
        try persist()
        if !reused { try? opts.storage.removeStaging(stagingPlan) }
        if install.activation == "hot" {
            if let before, before.location != location, let h = handler(record.type) {
                try await h.deactivate(before)
            }
            try await activate(install)
        }
        collect()
        return install
    }

    /// Remove every stored location and staging area no root holds.
    private func collect() {
        if gcHold { return }
        guard let doc else { return }
        var roots = gcRoots(doc, embedded: Array(embedded.values) + Array(running.values))
        roots.locations.formUnion(unverifiable)
        // A listing that fails collects nothing (never a partial answer).
        guard let listed = try? opts.storage.list() else { return }
        let held = holdSnapshot
        for loc in listed.locations
        where !roots.locations.contains(loc) && !(held?.locations.contains(loc) ?? false) {
            try? opts.storage.remove(loc)
        }
        for plan in listed.plans where !roots.plans.contains(plan) && !(held?.plans.contains(plan) ?? false) {
            try? opts.storage.removeStaging(plan)
        }
        // P4-11: a stored seed index no root install's record names goes too.
        if let store = opts.storage.chunkIndexes, let stored = try? store.list() {
            var keep = Set<String>()
            let installs =
                Array(doc.active.values) + Array(doc.previous.values) + Array(deferredActive.values)
                + Array(deferredPrevious.values) + Array(embedded.values) + Array(running.values)
            for i in installs { if let ref = installChunksRef(i) { keep.insert(ref.sha256) } }
            for sha in stored where !keep.contains(sha) { try? store.remove(sha) }
        }
    }

    /// Stage one object: resume from what is staged (its bytes re-hashed, never trusted), fetch
    /// the rest with `Range` and `If-Range`, checkpoint the journal. True when the staged object
    /// then has the ref's length and SHA-256; a mismatch resets it and refetches once.
    private func download(
        _ planId: String, _ packId: String, _ ref: (sha256: String, bytes: Int),
        progress: inout (done: Int, total: Int)
    ) async -> Bool {
        var local: (done: Int, total: Int)? = progress
        let ok = await downloadInto(planId, packId, ref, &local)
        progress = local!
        return ok
    }

    private func downloadInto(
        _ planId: String, _ packId: String, _ ref: (sha256: String, bytes: Int),
        _ progress: inout (done: Int, total: Int)?
    ) async -> Bool {
        guard let staged = try? opts.storage.stagedObject(planId, ref.sha256) else { return false }
        for _ in 0..<2 {
            do {
                var have = try staged.size()
                if have > ref.bytes {
                    try staged.reset()
                    have = 0
                }
                // Resume: what is staged is hashed again, never taken on trust.
                var hasher = PackHasher()
                if have > 0 {
                    let src = try staged.source()
                    var at = 0
                    while at < have {
                        let chunk = try src.read(at, Swift.min(READ_CHUNK, have - at))
                        if chunk.isEmpty { break }
                        hasher.update(chunk)
                        at += chunk.count
                    }
                }
                let counted = progress != nil ? have : 0
                if progress != nil {
                    progress!.done += counted
                    emit(PackProgress(packId: packId, phase: "download", done: progress!.done, total: progress!.total))
                }
                var outcome: FetchOutcome
                if have < ref.bytes {
                    let res: ObjectResponse
                    do {
                        res = try await opts.fetchObject(
                            ObjectRequest(
                                sha256: ref.sha256, offset: have,
                                ifRange: have > 0 ? "\"\(ref.sha256)\"" : nil))
                    } catch {
                        return false
                    }
                    if res.status == 200 && have > 0 {
                        // The validator moved, so the server sent the whole object: start over.
                        if progress != nil { progress!.done -= counted }
                        try staged.reset()
                        outcome = await fetchInto(staged, res, ref, PackHasher(), 0, planId, packId, &progress)
                    } else if res.status == 206 && have > 0 && rangeStartsAt(res.contentRange, have) {
                        outcome = await fetchInto(staged, res, ref, hasher, have, planId, packId, &progress)
                    } else if res.status == 200 {
                        outcome = await fetchInto(staged, res, ref, hasher, 0, planId, packId, &progress)
                    } else {
                        return false
                    }
                } else {
                    outcome = hasher.digest() == ref.sha256 ? .ok : .mismatch
                }
                switch outcome {
                case .ok: return true
                // An interrupted transfer keeps what is staged for the next resume.
                case .interrupted: return false
                case .mismatch:
                    if progress != nil { progress!.done -= Swift.min((try? staged.size()) ?? 0, ref.bytes) }
                    try staged.reset()
                }
            } catch {
                return false
            }
        }
        return false
    }

    private enum FetchOutcome { case ok, interrupted, mismatch }

    private func fetchInto(
        _ staged: any StagedObject, _ res: ObjectResponse, _ ref: (sha256: String, bytes: Int),
        _ hasherIn: PackHasher, _ from: Int, _ planId: String, _ packId: String,
        _ progress: inout (done: Int, total: Int)?
    ) async -> FetchOutcome {
        var hasher = hasherIn
        var have = from
        var sinceCheckpoint = 0
        let every = opts.checkpointBytes
        func save() throws {
            guard let doc, doc.inflight[packId]?.planId == planId else { return }
            self.doc = checkpoint(doc, packId: packId, sha256: ref.sha256, done: have)
            try persist()
        }
        do {
            for try await chunk in res.chunks {
                if have + chunk.count > ref.bytes { return .mismatch }
                hasher.update(chunk)
                try staged.append(chunk)
                have += chunk.count
                sinceCheckpoint += chunk.count
                if progress != nil {
                    progress!.done += chunk.count
                    emit(PackProgress(packId: packId, phase: "download", done: progress!.done, total: progress!.total))
                }
                if sinceCheckpoint >= every {
                    sinceCheckpoint = 0
                    try save()
                }
            }
        } catch {
            try? save()
            return .interrupted
        }
        do { try save() } catch { return .interrupted }
        return have == ref.bytes && hasher.digest() == ref.sha256 ? .ok : .mismatch
    }
}

/// plans/P4-29.md §2.4 step 6: whether a journal's `delta` is one the record or the journal's own
/// `feedDelta` names (always true for a journal of another strategy).
private func journalDeltaKnown(_ j: PackJournal, _ variant: PackVariant) -> Bool {
    guard j.strategy == "delta", let delta = j.delta else { return true }
    if variant.deltas.contains(where: { $0.id == delta }) { return true }
    return j.feedDelta?.artifactSha256 == delta
}

/// The merged feed entry of a planned feed delta, as the journal keeps it.
private func feedEntryOf(_ variant: PackVariant, _ id: String) -> FeedDelta? {
    for d in variant.deltas {
        if case .payload(let method, let from, let mem, let a) = d, a.sha256 == id {
            return FeedDelta(
                from: from, method: method, memBytes: mem, artifactSha256: a.sha256, artifactBytes: a.bytes)
        }
    }
    return nil
}

private func rangeStartsAt(_ contentRange: String?, _ offset: Int) -> Bool {
    guard let cr = contentRange?.trimmingCharacters(in: .whitespaces),
        let m = wholeMatches(#"bytes ([0-9]+)-[0-9]+/[0-9]+"#, cr), let start = m[1]
    else { return false }
    return Int(start) == offset
}

/// A record's activation, else its handler's default.
private func activationOf(_ record: PackRecordDoc, _ handler: (any PackHandler)?) -> String {
    if let a = record.activation, a == "hot" || a == "restart" { return a }
    return handler?.activation ?? "restart"
}

/// The delegation hash of a delegated install (its stored delegation and the record's kid), or nil
/// for a release-signed one.
private func installDelegation(_ i: PackInstall) -> String? {
    i.delegation != nil ? delegationHashOf(i.record) : nil
}

// ── P4-11 chunk helpers ─────────────────────────────────────────────────────────────────────

/// A variant's `chunks` ref when the chunk strategy could read it (plans/P4-10.md §2.5: the
/// format, a usable codec, both sizes within `MAX_CHUNK_INDEX_BYTES`), else nil.
func usableChunksRef(_ variant: PackVariant) -> PackObjectRef? {
    guard let c = variant.chunks, c.format == CHUNKS_FORMAT, usableCodec(c.ref.codec),
        c.ref.bytes >= 0, c.ref.size >= 0, c.ref.bytes <= MAX_CHUNK_INDEX_BYTES,
        c.ref.size <= MAX_CHUNK_INDEX_BYTES
    else { return nil }
    return c.ref
}

/// The usable `chunks` ref of an install's own variant, read from its (verified) record.
func installChunksRef(_ i: PackInstall) -> PackObjectRef? {
    guard let json = verifiedPayloadOf(i.record), let rec = PackRecordDoc(json: json) else { return nil }
    guard let v = rec.variants.first(where: { variantKey($0.variant) == i.variant }),
        v.payload.sha256 == i.payloadSha256
    else { return nil }
    return usableChunksRef(v)
}

/// The run journal (P4-11): which runs of a chunk plan are complete. Ignored (empty) unless
/// `v == 1`, `index` is this plan's chunk index, `runs` is this plan's run count and the bitmap
/// is `ceil(runs / 8)` bytes of lowercase hex (bit k is byte[k >> 3] & (1 << (k & 7))).
public func readRunJournal(_ text: String?, index: String, runs: Int) -> Set<Int> {
    var done = Set<Int>()
    guard let text, let o = parseJSON(text)?.objectValue else { return done }
    let bytes = (runs + 7) / 8
    guard o["v"]?.intValue == 1, o["index"]?.stringValue == index, o["runs"]?.intValue == runs,
        let bitmap = o["bitmap"]?.stringValue, bitmap.utf8.count == bytes * 2,
        bitmap.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) })
    else { return done }
    let bits = hexBytes(bitmap)
    guard bits.count == bytes else { return done }
    for k in 0..<runs where bits[k >> 3] & (1 << UInt8(k & 7)) != 0 { done.insert(k) }
    return done
}

/// The run journal's text for `done` (see `readRunJournal`).
public func writeRunJournal(index: String, runs: Int, done: Set<Int>) -> String {
    var bits = [UInt8](repeating: 0, count: (runs + 7) / 8)
    for k in done where k >= 0 && k < runs { bits[k >> 3] |= 1 << UInt8(k & 7) }
    return canonicalJSON(
        .object([
            "v": .int(1), "index": .string(index), "runs": .int(runs), "bitmap": .string(hexString(bits)),
        ]))
}

/// A container output as the chunk applier reads it.
private struct PackChunkOutput: ChunkOutput {
    let sink: any ByteSink
    let reader: @Sendable (Int, Int) throws -> [UInt8]
    func write(_ offset: Int, _ bytes: [UInt8]) throws { try sink.write(offset, bytes) }
    func read(_ offset: Int, _ length: Int) throws -> [UInt8] { try reader(offset, length) }
}
