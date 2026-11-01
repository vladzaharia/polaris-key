// Saves on the records store (U-23.S5; WIRE-CONTRACT-V5 §13.7, §13.8; plans D-2, D-3, D-8, D-11).
// A port of client-core's `sync/saves.ts`.
//
// A save is a record of the `saves` collection with one file. The client writes in this order, so no save is
// ever torn:
//
//   1. upload the file (`begin`, bytes, `finalize`), which creates the record or bumps its version and
//      answers its pointer (U-10 A2);
//   2. push the metadata `set` with `baseVersion` = the version `finalize` answered.
//
// In end-to-end mode the sealed metadata carries `"$file": {sha256, size, format}` (D-3). A reader downloads
// the revision whose `sha256` the binding names and fails with `sync-file-invalid` when none matches, so a
// Worker can neither swap the files of two slots nor show a new file under old metadata. A record with no
// binding has no file there, whatever the server attaches to it. In server mode there is no binding (the
// server holds the plaintext) and the metadata is the record's own value.
//
// The record layer is a port, `SaveRecords`: the Cloud Sync host binds it (`MachineRecords`, in
// CloudSyncSavesBinding.swift), sealing and blinding in end-to-end mode. This file owns the order of the steps, the choice of the revision, the format
// check (D-11), the slot cap, conflicts and the `SaveTransfer` handle.
//
// A save is held in memory while it is sealed and sent (the `saves` template's 32 MiB default; an app may
// lower it with `SavesOptions.maxBytes`, and a bigger file is `too-large`). A download streams to a sink.
//
// Nothing here puts a key, a plaintext byte or a bearer token in an error, an event or a log line.

import Foundation
import PolarisKeyCore
#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

public let savesCollection = "saves"
/// The key of the E2E binding inside a save's sealed metadata (D-3).
public let saveFileBindingKey = "$file"
/// SDK-owned metadata keys written with every save (SAVES-META): when it was saved (epoch ms) and the
/// device's display name. A write overwrites an app value under either key. Never a hardware value.
public let saveSavedAtKey = "savedAt"
public let saveDeviceKey = "deviceLabel"
/// The `saves` template's default file bound.
public let savesDefaultMaxBytes = 32 * 1024 * 1024

/// What app code sets for saves (never read from the Worker).
public struct SavesOptions: Sendable, Equatable {
    /// The save format the app reads: a save whose metadata `formatVersion` is above it is `newerFormat` (D-11).
    /// Nil turns the check off.
    public var saveFormatVersion: Int?
    /// The largest save the app writes; default 32 MiB.
    public var maxBytes: Int
    /// The collection's `files.delta` (the `saves` template turns it on).
    public var delta: Bool

    public init(saveFormatVersion: Int? = nil, maxBytes: Int = savesDefaultMaxBytes, delta: Bool = true) {
        self.saveFormatVersion = saveFormatVersion
        self.maxBytes = maxBytes
        self.delta = delta
    }
}

// MARK: Records port

/// The file a save has: the pointer of §13.4. `sha256` and `size` are of the stored bytes (ciphertext in E2E
/// mode).
public typealias SaveFile = SyncFilePointer

/// One save record as the records layer holds it: `value` is the opened metadata.
public struct SaveRecord: Sendable, Equatable {
    public let id: String
    public let version: Int
    public let value: [String: JSONValue]
    /// The pull's `file` member; nil when the record has no file.
    public let file: SaveFile?

    public init(id: String, version: Int, value: [String: JSONValue], file: SaveFile?) {
        self.id = id
        self.version = version
        self.value = value
        self.file = file
    }
}

/// What `set` and `delete` came to.
public enum SaveSetResult: Sendable, Equatable {
    case ok(version: Int)
    case conflict(server: SaveRecord?)
    case rejected(code: String)
}

/// Tells a waiting write that the caller cancelled it (not paused it: a pause never ends the wait).
public final class SaveStop: Sendable {
    private let state = LockedValue<(set: Bool, next: Int, handlers: [Int: @Sendable () -> Void])>((false, 0, [:]))
    public init() {}
    public var isSet: Bool { state.with { $0.set } }

    /// Sets the flag and runs the handlers once. A cancel is not a Task cancellation (a pause cancels the
    /// task too, and a task is cancelled only once), so a waiting write listens here.
    func set() {
        let run = state.with { s -> [@Sendable () -> Void] in
            guard !s.set else { return [] }
            s.set = true
            let all = Array(s.handlers.values)
            s.handlers.removeAll()
            return all
        }
        for h in run { h() }
    }

    /// Runs `handler` when the flag is set (at once if it already is). Returns the token for `remove`.
    func onSet(_ handler: @escaping @Sendable () -> Void) -> Int? {
        let token = state.with { s -> Int? in
            if s.set { return nil }
            s.next += 1
            s.handlers[s.next] = handler
            return s.next
        }
        if token == nil { handler() }
        return token
    }

    func remove(_ token: Int?) {
        guard let token else { return }
        state.with { _ = $0.handlers.removeValue(forKey: token) }
    }
}

public protocol SaveRecords: Sendable {
    /// The record id as it goes on the wire (blinded in E2E mode).
    func wireId(_ id: String) async throws -> String
    func list() async throws -> [SaveRecord]
    func get(_ id: String) async throws -> SaveRecord?
    /// Push the metadata `set` on `base`, the version `finalize` answered. The wait for the one outcome has
    /// no timeout: the caller's cancel (`stop`), a sign-out (the write is dropped) and the host's retries
    /// are what end it. A cancel throws an `aborted` `TransferError`.
    /// `file` is the pointer `finalize` answered; an acknowledged set adopts it on the row.
    func set(
        _ id: String, value: [String: JSONValue], base: SyncBase, file: SaveFile?, stop: SaveStop?
    ) async throws -> SaveSetResult
    func delete(_ id: String, baseVersion: Int) async throws -> SaveSetResult
    /// Pull the `saves` collection from the server and return when the pull ended. False when this port
    /// cannot pull (the cache is all there is); a pull that failed still returns true with the cache as it was.
    func pull() async -> Bool
}

extension SaveRecords {
    public func pull() async -> Bool { false }
}

// MARK: Errors, summaries, outcomes

public struct SavesError: Error, Sendable, Equatable, CustomStringConvertible {
    public enum Code: String, Sendable {
        /// A downloaded file failed a check the server could have caused (D-8).
        case fileInvalid = "sync-file-invalid"
        case invalidSave = "invalid-save"
        case tooLarge = "too-large"
        case slotsFull = "slots-full"
        case notFound = "not-found"
        case transferFailed = "transfer-failed"
        case rejected
    }

    public let code: Code
    /// A short, fixed word or a wire code; never a value or a key.
    public let detail: String?

    public init(_ code: Code, detail: String? = nil) {
        self.code = code
        self.detail = detail
    }

    public var description: String { "saves: \(code.rawValue)" + (detail.map { " (\($0))" } ?? "") }
}

public struct SaveSummary: Sendable, Equatable {
    public let id: String
    public let version: Int
    /// The metadata object, without the E2E binding.
    public let metadata: JSONValue
    /// Nil when the record has no file (in E2E mode: no binding).
    public let file: SaveFile?
    /// The save's `formatVersion` is above the app's `saveFormatVersion` (D-11).
    public let newerFormat: Bool

    /// The metadata as a `Decodable` of the app's own.
    public func decodeMetadata<M: Decodable>(_ type: M.Type = M.self) throws -> M {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(metadata))
    }
}

public struct SaveContent: Sendable, Equatable {
    public let id: String
    public let version: Int
    public let metadata: JSONValue
    public let file: SaveFile?
    /// The save's bytes; nil when a sink took them or the save has no file.
    public let bytes: Data?

    public func decodeMetadata<M: Decodable>(_ type: M.Type = M.self) throws -> M {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(metadata))
    }
}

public enum SaveRead: Sendable, Equatable {
    case ok(SaveContent)
    case notFound
    case newerFormat(formatVersion: Int, supported: Int)
}

/// One kept revision of a save's file, newest first.
public struct SaveRevision: Sendable, Equatable {
    public let version: Int
    public let size: Int
    public let sha256: String
    public let format: String
    public let createdAt: Int
}

/// What a device tried to write when another write got there first.
public struct SaveConflict: Sendable, Equatable {
    public struct Local: Sendable, Equatable {
        public let metadata: JSONValue
        public let size: Int
    }

    public let id: String
    /// What this device wrote.
    public let local: Local
    /// The server's copy; nil when it was deleted meanwhile.
    public let remote: SaveSummary?
    public let serverVersion: Int?
    /// `keep: .both` needs a free slot of the 16.
    public let bothAvailable: Bool
}

public enum SaveKeep: String, Sendable { case local, remote, both }

public enum SaveTransferState: String, Sendable { case running, paused, done, cancelled, failed, conflict }

public enum SaveOutcome: Sendable, Equatable {
    /// The file is stored and the metadata pushed. `version` is the record's version after the `set`.
    case done(id: String, version: Int, file: SaveFile, copyId: String?)
    case keptRemote(id: String, version: Int?)
    case cancelled
    case failed(SavesError)
    case conflict(SaveConflict)
}

public struct SaveReadOptions: Sendable {
    /// Takes the bytes instead of returning them; provisional until `read` returns (discard them on a throw).
    public var sink: (@Sendable (Data) async throws -> Void)?
    public var onProgress: (@Sendable (Int, Int) -> Void)?

    public init(
        sink: (@Sendable (Data) async throws -> Void)? = nil, onProgress: (@Sendable (Int, Int) -> Void)? = nil
    ) {
        self.sink = sink
        self.onProgress = onProgress
    }
}

public struct SaveWriteOptions: Sendable {
    /// The version the caller last saw; nil is the record's current one, or create-only for a new id.
    public var baseVersion: Int?
    public var onProgress: (@Sendable (Int, Int) -> Void)?

    public init(baseVersion: Int? = nil, onProgress: (@Sendable (Int, Int) -> Void)? = nil) {
        self.baseVersion = baseVersion
        self.onProgress = onProgress
    }
}

// MARK: Environment

/// Everything one call needs, resolved when it starts: the signed-in person, the ring's root and the engine.
public struct SavesContext: Sendable {
    public var records: any SaveRecords
    public var engine: FileTransferEngine
    public var revisions: any FileRevisions
    public var codec: any FileCodec
    public var cache: (any ChunkCache)?

    public init(
        records: any SaveRecords, engine: FileTransferEngine, revisions: any FileRevisions, codec: any FileCodec,
        cache: (any ChunkCache)?
    ) {
        self.records = records
        self.engine = engine
        self.revisions = revisions
        self.codec = codec
        self.cache = cache
    }
}

public protocol SavesEnvironment: Sendable {
    /// Throws the typed N/A when the product has no Sync service, and a typed refusal while signed out or locked.
    func savesContext() async throws -> SavesContext
    /// Release the server's upload of a transfer the caller cancelled (best effort; needs no key).
    func release(transferId: String) async
    /// Settle every write waiting on the machine as dropped: the person and their data are gone.
    func dropWaiting()
    /// Delete the person's transfer journal and chunk cache.
    func purgeFiles() async
    /// The device's display name, stored with each save; nil stores none.
    func deviceLabel() async -> String?
}

extension SavesEnvironment {
    public func deviceLabel() async -> String? { nil }
}

private struct Binding: Equatable {
    let sha256: String
    let size: Int
    let format: SyncFilePointer.Format
}

private func splitBinding(_ value: [String: JSONValue]) -> (metadata: [String: JSONValue], binding: Binding?) {
    var metadata = value
    let raw = metadata.removeValue(forKey: saveFileBindingKey)
    guard case .object(let o)? = raw, let sha = o["sha256"]?.stringValue, sha.utf8.count == 64,
        sha.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }),
        case .int(let size)? = o["size"], size > 0, let formatText = o["format"]?.stringValue,
        let format = SyncFilePointer.Format(rawValue: formatText)
    else { return (metadata, nil) }
    return (metadata, Binding(sha256: sha, size: size, format: format))
}

private func formatOf(_ metadata: [String: JSONValue]) -> Int? {
    if case .int(let v)? = metadata["formatVersion"] { return v }
    return nil
}

private func isSaveKey(_ id: String) -> Bool {
    !id.isEmpty && id.utf8.count <= 128
        && id.utf8.allSatisfy {
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x2E
                || $0 == 0x5F || $0 == 0x3A || $0 == 0x2D
        }
}

private func hexSha256(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

private func savesError(_ e: Error) -> SavesError {
    if let s = e as? SavesError { return s }
    if let t = e as? TransferError {
        return t.reason == .fileInvalid
            ? SavesError(.fileInvalid, detail: t.detail)
            : SavesError(.transferFailed, detail: t.code ?? t.reason.rawValue)
    }
    if let p = e as? PolarisError { return SavesError(.transferFailed, detail: p.code) }
    return SavesError(.transferFailed)
}

// MARK: The client

/// `client.cloudSync.saves`: the verbs.
public final class SavesClient: Sendable {
    private let env: any SavesEnvironment
    private let options: SavesOptions
    private let emit: @Sendable (CloudSyncEvent) -> Void
    private let live = LockedValue<[String: SaveTransfer]>([:])
    private let now: @Sendable () -> Int

    init(
        env: any SavesEnvironment, options: SavesOptions, emit: @escaping @Sendable (CloudSyncEvent) -> Void,
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.env = env
        self.options = options
        self.emit = emit
        self.now = now
    }

    /// The SDK's own keys: when and where this save was written (SAVES-META).
    private func stamped(_ metadata: JSONValue) async -> JSONValue {
        guard case .object(var o) = metadata else { return metadata }
        o.removeValue(forKey: saveSavedAtKey)
        o.removeValue(forKey: saveDeviceKey)
        o[saveSavedAtKey] = .int(now())
        if let label = await env.deviceLabel(), !label.isEmpty { o[saveDeviceKey] = .string(label) }
        return .object(o)
    }

    private func summary(_ rec: SaveRecord, e2e: Bool) -> SaveSummary {
        let (metadata, binding) = splitBinding(rec.value)
        let fv = formatOf(metadata)
        let newer = options.saveFormatVersion.map { s in fv.map { $0 > s } ?? false } ?? false
        var file = rec.file
        if e2e { file = (binding != nil && rec.file?.sha256 == binding?.sha256) ? rec.file : nil }
        return SaveSummary(
            id: rec.id, version: rec.version, metadata: .object(metadata), file: file, newerFormat: newer)
    }

    /// The saves of this person, by id.
    public func list() async throws -> [SaveSummary] {
        let ctx = try await env.savesContext()
        let e2e = ctx.codec.enc == "e2e"
        return try await ctx.records.list().map { summary($0, e2e: e2e) }.sorted { $0.id < $1.id }
    }

    /// The kept revisions of a save's file, newest first.
    public func revisions(_ id: String) async throws -> [SaveRevision] {
        guard isSaveKey(id) else { throw SavesError(.invalidSave, detail: "id") }
        let ctx = try await env.savesContext()
        return try await revisionList(ctx, id)
    }

    private func revisionList(_ ctx: SavesContext, _ id: String) async throws -> [SaveRevision] {
        let target = FileTarget(collection: savesCollection, record: try await ctx.records.wireId(id))
        switch try await ctx.revisions.revisions(target) {
        case .refused(let r):
            throw SavesError(r.status == 404 ? .notFound : .rejected, detail: r.code)
        case .ok(let v):
            return (v.objectValue?["revisions"]?.arrayValue ?? []).compactMap { e in
                guard case .object(let o) = e, let version = o["version"]?.intValue, let size = o["size"]?.intValue,
                    let sha = o["sha256"]?.stringValue, let format = o["format"]?.stringValue
                else { return nil }
                return SaveRevision(
                    version: version, size: size, sha256: sha, format: format, createdAt: o["createdAt"]?.intValue ?? 0)
            }
        }
    }

    /// Read a save: its metadata and bytes (the revision its binding names, in E2E mode). Emits
    /// `transferProgress`, then `transferDone` or `transferFailed`, under the id `saves:read:<id>`.
    public func read(_ id: String, options readOptions: SaveReadOptions = SaveReadOptions()) async throws -> SaveRead {
        let tid = "saves:read:\(id)"
        let emit = self.emit
        var opts = readOptions
        let caller = readOptions.onProgress
        opts.onProgress = { done, total in
            caller?(done, total)
            emit(.transferProgress(id: tid, done: done, total: total))
        }
        do {
            let r = try await readNow(id, options: opts)
            emit(.transferDone(id: tid, state: "done"))
            return r
        } catch {
            emit(
                .transferFailed(
                    id: tid, code: (error as? SavesError)?.code.rawValue ?? SavesError.Code.transferFailed.rawValue))
            throw error
        }
    }

    private func readNow(_ id: String, options readOptions: SaveReadOptions) async throws -> SaveRead {
        guard isSaveKey(id) else { throw SavesError(.invalidSave, detail: "id") }
        let ctx = try await env.savesContext()
        guard let rec = try await ctx.records.get(id) else { return .notFound }
        let (metadata, binding) = splitBinding(rec.value)
        if let supported = options.saveFormatVersion, let fv = formatOf(metadata), fv > supported {
            return .newerFormat(formatVersion: fv, supported: supported)
        }
        let ref: SaveFile?
        if ctx.codec.enc == "e2e" {
            if let binding {
                ref = try await revisionFor(ctx, id, rec, binding)
            } else if rec.value[saveFileBindingKey] != nil {
                // A malformed binding is not an absent one: the writer meant a file.
                throw SavesError(.fileInvalid, detail: "binding")
            } else {
                ref = nil
            }
        } else {
            ref = rec.file
        }
        guard let ref else {
            return .ok(
                SaveContent(id: id, version: rec.version, metadata: .object(metadata), file: nil, bytes: nil))
        }
        let collected = LockedValue<Data>(Data())
        let sink: @Sendable (Data) async throws -> Void =
            readOptions.sink ?? { piece in collected.with { $0.append(piece) } }
        do {
            try await ctx.engine.download(
                DownloadRequest(
                    collection: savesCollection, record: try await ctx.records.wireId(id), format: ref.format.rawValue,
                    size: ref.size, sha256: ref.sha256, codec: ctx.codec, version: ref.version, cache: ctx.cache,
                    onProgress: readOptions.onProgress, sink: sink))
        } catch {
            throw savesError(error)
        }
        return .ok(
            SaveContent(
                id: id, version: rec.version, metadata: .object(metadata), file: ref,
                bytes: readOptions.sink == nil ? collected.current : nil))
    }

    /// D-3: the revision the binding names, else a failure.
    private func revisionFor(_ ctx: SavesContext, _ id: String, _ rec: SaveRecord, _ b: Binding) async throws
        -> SaveFile
    {
        func fits(_ sha: String, _ size: Int, _ format: String) -> Bool {
            sha == b.sha256 && size == b.size && format == b.format.rawValue
        }
        if let f = rec.file, fits(f.sha256, f.size, f.format.rawValue) { return f }
        guard let found = try await revisionList(ctx, id).first(where: { fits($0.sha256, $0.size, $0.format) }) else {
            throw SavesError(.fileInvalid, detail: "binding")
        }
        guard let format = SaveFile.Format(rawValue: found.format) else {
            throw SavesError(.fileInvalid, detail: "binding")
        }
        return SaveFile(version: found.version, size: found.size, sha256: found.sha256, format: format)
    }

    /// Write a save. Returns at once with a handle; `outcome()` settles when the file is stored and the
    /// metadata is pushed, or on a conflict, a failure or a cancel.
    public func write(
        _ id: String, bytes: Data, metadata: JSONValue, options writeOptions: SaveWriteOptions = SaveWriteOptions()
    ) async throws -> SaveTransfer {
        try await write(id, source: DataSource(bytes), metadata: metadata, options: writeOptions)
    }

    public func write(
        _ id: String, source: any RangedSource, metadata: JSONValue,
        options writeOptions: SaveWriteOptions = SaveWriteOptions()
    ) async throws -> SaveTransfer {
        _ = try await env.savesContext()  // the typed refusal (no Sync service, locked, not started) is thrown here
        return run(id, source, await stamped(metadata), writeOptions, mode: nil)
    }

    /// `write` with the app's own `Encodable` metadata.
    public func write<M: Encodable>(
        _ id: String, bytes: Data, encoding metadata: M, options writeOptions: SaveWriteOptions = SaveWriteOptions()
    ) async throws -> SaveTransfer {
        let value = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(metadata))
        return try await write(id, bytes: bytes, metadata: value, options: writeOptions)
    }

    /// Settle a conflict. `remote` keeps the server's copy and writes nothing; `local` writes this device's
    /// save on top of the server's version; `both` writes it as a new save in a free slot.
    public func resolve(
        _ conflict: SaveConflict, keep: SaveKeep, bytes: Data,
        options writeOptions: SaveWriteOptions = SaveWriteOptions()
    ) async throws -> SaveTransfer {
        let ctx = try await env.savesContext()
        switch keep {
        case .remote:
            // Pull first, so the cache holds the copy the person chose (not this device's old one).
            _ = await ctx.records.pull()
            let rec = try? await ctx.records.get(conflict.id)
            return SaveTransfer.settled(
                id: conflict.id, .keptRemote(id: conflict.id, version: rec?.version), state: .done)
        case .both where !conflict.bothAvailable:
            return SaveTransfer.settled(id: conflict.id, .failed(SavesError(.slotsFull)), state: .failed)
        case .both:
            return run(conflict.id, DataSource(bytes), conflict.local.metadata, writeOptions, mode: .copy)
        case .local:
            return run(
                conflict.id, DataSource(bytes), conflict.local.metadata, writeOptions,
                // A copy the server no longer holds is replaced on "record must not exist".
                mode: .base(
                    conflict.remote == nil || (conflict.serverVersion ?? 0) == 0
                        ? .any : .version(conflict.serverVersion ?? 0)))
        }
    }

    /// Delete a save; its file is collected with the record.
    @discardableResult
    public func delete(_ id: String, baseVersion: Int? = nil) async throws -> SaveSetResult {
        guard isSaveKey(id) else { throw SavesError(.invalidSave, detail: "id") }
        let ctx = try await env.savesContext()
        var base = baseVersion
        if base == nil {
            guard let rec = try await ctx.records.get(id) else { return .rejected(code: "not_found") }
            base = rec.version
        }
        return try await ctx.records.delete(id, baseVersion: base!)
    }

    /// The person's data is gone: cancel what runs, settle waiting writes, delete the journal and the chunk
    /// cache. Each step is tried whatever the other did.
    func purge() async {
        let running = live.with { l -> [SaveTransfer] in
            let v = Array(l.values)
            l.removeAll()
            return v
        }
        env.dropWaiting()
        // The server's upload is released best effort in the background: a sign-out never waits on the network.
        for t in running { Task { await t.cancel() } }
        await env.purgeFiles()
    }

    /// The transfers in flight: running, paused or waiting on a conflict.
    public func transfers() -> [SaveTransfer] {
        live.current.values.sorted { $0.id < $1.id }
    }

    // MARK: internals

    fileprivate enum Mode {
        case base(SyncBase)
        case copy
    }

    /// The journal key of a save's write: stable across launches, so an interrupted upload resumes.
    private func transferId(_ id: String) -> String { "saves:\(id)" }

    private func run(
        _ id: String, _ source: any RangedSource, _ metadata: JSONValue, _ opts: SaveWriteOptions, mode: Mode?
    )
        -> SaveTransfer
    {
        let transferId = self.transferId(id)
        let emit = self.emit
        let stop = SaveStop()
        let progress = LockedValue<(done: Int, total: Int)>((0, source.size))
        let attempt: @Sendable () async throws -> SaveOutcome = { [self] in
            try await self.attempt(
                id, source, metadata, opts, mode, transferId: transferId, stop: stop,
                onProgress: { done, total in
                    progress.set((done, total))
                    opts.onProgress?(done, total)
                    emit(.transferProgress(id: transferId, done: done, total: total))
                })
        }
        let release: @Sendable () async -> Void = { [env] in await env.release(transferId: transferId) }
        let t = SaveTransfer(
            id: transferId, progress: progress, stop: stop, attempt: attempt, release: release,
            onSettle: { [live] outcome in
                live.with { _ = $0.removeValue(forKey: transferId) }
                switch outcome {
                case .failed(let e): emit(.transferFailed(id: transferId, code: e.code.rawValue))
                case .cancelled: emit(.transferDone(id: transferId, state: "cancelled"))
                case .conflict: emit(.transferDone(id: transferId, state: "conflict"))
                case .done, .keptRemote: emit(.transferDone(id: transferId, state: "done"))
                }
            })
        live.with { $0[transferId] = t }
        t.start()
        return t
    }

    private func attempt(
        _ id: String, _ source: any RangedSource, _ metadataValue: JSONValue, _ opts: SaveWriteOptions, _ mode: Mode?,
        transferId: String, stop: SaveStop, onProgress: @escaping @Sendable (Int, Int) -> Void
    ) async throws -> SaveOutcome {
        guard isSaveKey(id) else { return .failed(SavesError(.invalidSave, detail: "id")) }
        guard case .object(let metadata) = metadataValue else {
            return .failed(SavesError(.invalidSave, detail: "metadata"))
        }
        guard metadata[saveFileBindingKey] == nil else {
            return .failed(SavesError(.invalidSave, detail: "reserved-key"))
        }
        guard source.size <= options.maxBytes, source.size <= SYNC_FILE_MAX_BYTES else {
            return .failed(SavesError(.tooLarge))
        }
        let ctx = try await env.savesContext()
        let records = ctx.records
        var targetId = id
        var base: SyncBase
        switch mode {
        case .copy:
            guard let free = try await freeId(records, id) else { return .failed(SavesError(.slotsFull)) }
            targetId = free
            base = .any
        case .base(let b)?:
            base = b
        case nil:
            if let v = opts.baseVersion {
                base = .version(v)
            } else if let existing = try await records.get(id) {
                base = .version(existing.version)
            } else {
                if try await records.list().count >= SYNC_SAVE_SLOTS { return .failed(SavesError(.slotsFull)) }
                base = .any
            }
        }
        let wire = try await records.wireId(targetId)
        let baseJSON: JSONValue
        switch base {
        case .any: baseJSON = .string("*")
        case .version(let v): baseJSON = .int(v)
        }
        let finalized: JSONValue
        do {
            let stored = ctx.codec.storedSize(source.size)
            guard let plan = SyncTransferPlan.plan(size: stored, delta: options.delta), plan.mode != .tooLarge else {
                return .failed(SavesError(.tooLarge))
            }
            if plan.mode == .chunks {
                finalized = try await ctx.engine.uploadChunked(
                    ChunkedUploadRequest(
                        id: transferId, collection: savesCollection, record: wire, source: source, codec: ctx.codec,
                        baseVersion: baseJSON, onProgress: onProgress))
            } else {
                let plain = try source.read(0, source.size)
                let sealed = try ctx.codec.sealWhole(plain)
                finalized = try await ctx.engine.upload(
                    UploadRequest(
                        id: transferId, collection: savesCollection, record: wire, source: DataSource(sealed),
                        size: sealed.count, sha256: hexSha256(sealed), enc: ctx.codec.enc, baseVersion: baseJSON,
                        onProgress: onProgress))
            }
        } catch let e as TransferError where e.reason == .conflict {
            return try await conflictOutcome(
                records, ctx.codec.enc == "e2e", id, metadata, source.size, e.serverVersion)
        } catch let e as TransferError where e.reason == .aborted {
            throw e
        } catch is CancellationError {
            throw TransferError(.aborted)
        } catch {
            return .failed(savesError(error))
        }
        guard let file = SaveFile(json: finalized) else {
            return .failed(SavesError(.transferFailed, detail: "bad-reply"))
        }
        var value = metadata
        if ctx.codec.enc == "e2e" {
            value[saveFileBindingKey] = .object([
                "sha256": .string(file.sha256), "size": .int(file.size), "format": .string(file.format.rawValue),
            ])
        }
        switch try await records.set(targetId, value: value, base: .version(file.version), file: file, stop: stop) {
        case .ok(let version):
            return .done(id: id, version: version, file: file, copyId: targetId != id ? targetId : nil)
        case .conflict(let server):
            return try await conflictOutcome(
                records, ctx.codec.enc == "e2e", id, metadata, source.size, server?.version, known: server,
                hasKnown: true
            )
        case .rejected(let code):
            return .failed(SavesError(.rejected, detail: code))
        }
    }

    /// The first `<id>.copy`, `<id>.copy2`, ... that is not a save; nil when all 16 slots are in use.
    private func freeId(_ records: any SaveRecords, _ id: String) async throws -> String? {
        let all = try await records.list()
        if all.count >= SYNC_SAVE_SLOTS { return nil }
        let taken = Set(all.map(\.id))
        for n in 1..<1000 {
            let candidate = "\(id.prefix(120)).copy\(n == 1 ? "" : String(n))"
            if !taken.contains(candidate) { return candidate }
        }
        return nil
    }

    private func conflictOutcome(
        _ records: any SaveRecords, _ e2e: Bool, _ id: String, _ metadata: [String: JSONValue], _ size: Int,
        _ serverVersion: Int?, known: SaveRecord? = nil, hasKnown: Bool = false
    ) async throws -> SaveOutcome {
        // The cache may be behind the conflict: pull before reading it, so the screen shows what the server
        // holds (and a save deleted elsewhere reads as deleted).
        let pulled = await records.pull()
        let slots = try await records.list().count
        // The server's answer wins. `known` is the copy a rejected `set` carried (nil: deleted). A file `begin`
        // answers only a version, and the cached row stands in for it only while it is that very version; a
        // stale row is never presented as the server's copy.
        let remote: SaveSummary?
        let version: Int?
        if hasKnown {
            remote = known.map { summary($0, e2e: e2e) }
            version = known?.version ?? serverVersion
        } else if let serverVersion {
            if serverVersion == 0 {
                remote = nil
                version = 0
            } else {
                let rec = try await records.get(id)
                if let rec, rec.version >= serverVersion {
                    remote = summary(rec, e2e: e2e)
                    version = rec.version
                } else if pulled, rec == nil {
                    // Pulled and gone: a tombstone's version, not a copy.
                    remote = nil
                    version = nil
                } else {
                    remote = SaveSummary(
                        id: id, version: serverVersion, metadata: .object([:]), file: nil, newerFormat: false)
                    version = serverVersion
                }
            }
        } else {
            let rec = try await records.get(id)
            remote = rec.map { summary($0, e2e: e2e) }
            version = rec?.version
        }
        return .conflict(
            SaveConflict(
                id: id, local: SaveConflict.Local(metadata: .object(metadata), size: size),
                remote: remote, serverVersion: version, bothAvailable: slots < SYNC_SAVE_SLOTS))
    }
}

// MARK: The transfer handle

/// A write in flight. A cancelled transfer is a state, not an error (D-8).
public final class SaveTransfer: @unchecked Sendable {
    private enum Wanted { case run, pause, cancel }

    public let id: String
    private let lock = NSLock()
    private var stateValue: SaveTransferState = .running
    private var wanted: Wanted = .run
    private var current: Task<SaveOutcome, Error>?
    private var gate: CheckedContinuation<Void, Never>?
    private var finished: Task<SaveOutcome, Never>?
    private let progressBox: LockedValue<(done: Int, total: Int)>
    private let stop: SaveStop
    private let attempt: @Sendable () async throws -> SaveOutcome
    private let release: @Sendable () async -> Void
    private let onSettle: @Sendable (SaveOutcome) -> Void

    init(
        id: String, progress: LockedValue<(done: Int, total: Int)>, stop: SaveStop = SaveStop(),
        attempt: @escaping @Sendable () async throws -> SaveOutcome,
        release: @escaping @Sendable () async -> Void, onSettle: @escaping @Sendable (SaveOutcome) -> Void
    ) {
        self.id = id
        self.stop = stop
        self.progressBox = progress
        self.attempt = attempt
        self.release = release
        self.onSettle = onSettle
    }

    /// A transfer that was decided without any network.
    static func settled(id: String, _ outcome: SaveOutcome, state: SaveTransferState) -> SaveTransfer {
        let t = SaveTransfer(
            id: id, progress: LockedValue((0, 0)), attempt: { outcome }, release: {}, onSettle: { _ in })
        t.lock.withLock { t.stateValue = state }
        t.finished = Task { outcome }
        return t
    }

    func start() {
        let task = Task { await self.drive() }
        lock.withLock { finished = task }
    }

    public var state: SaveTransferState { lock.withLock { stateValue } }
    /// Plaintext bytes accounted for and the file's size.
    public var progress: (done: Int, total: Int) { progressBox.current }

    /// Settles on done, cancelled, failed or conflict; never throws.
    public func outcome() async -> SaveOutcome {
        let task = lock.withLock { finished }
        return await task?.value ?? .cancelled
    }

    public func pause() {
        let task = lock.withLock { () -> Task<SaveOutcome, Error>? in
            guard stateValue == .running, wanted != .cancel else { return nil }
            wanted = .pause
            return current
        }
        task?.cancel()
    }

    public func resume() {
        let g = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            guard wanted != .cancel, stateValue == .paused || wanted == .pause else { return nil }
            wanted = .run
            let g = gate
            gate = nil
            return g
        }
        g?.resume()
    }

    public func cancel() async {
        let (task, g, skip) = lock.withLock {
            () -> (Task<SaveOutcome, Error>?, CheckedContinuation<Void, Never>?, Bool) in
            if stateValue == .done || stateValue == .failed || stateValue == .conflict || stateValue == .cancelled {
                return (nil, nil, true)
            }
            wanted = .cancel
            let g = gate
            gate = nil
            return (current, g, false)
        }
        if skip { return }
        // The wait for the metadata write ends only on this (a pause leaves it running).
        stop.set()
        task?.cancel()
        g?.resume()
        _ = await outcome()
    }

    private func want() -> Wanted { lock.withLock { wanted } }

    private func set(_ s: SaveTransferState) { lock.withLock { stateValue = s } }

    private func drive() async -> SaveOutcome {
        while true {
            if want() == .cancel { return await cancelled() }
            // A pause asked before the attempt began waits first.
            if want() == .pause {
                let outcome = await waitWhilePaused()
                if let outcome { return outcome }
            }
            set(.running)
            let task = Task { try await attempt() }
            lock.withLock { current = task }
            do {
                let outcome = try await task.value
                if want() == .cancel { return await cancelled() }
                return settle(outcome)
            } catch {
                if want() == .cancel { return await cancelled() }
                let aborted = (error as? TransferError)?.reason == .aborted || error is CancellationError
                if !aborted { return settle(.failed(savesError(error))) }
                if want() == .run { continue }
                if let outcome = await waitWhilePaused() { return outcome }
            }
        }
    }

    /// Paused: wait for resume or cancel. Returns the outcome when it was a cancel.
    private func waitWhilePaused() async -> SaveOutcome? {
        set(.paused)
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let resumeNow = lock.withLock { () -> Bool in
                if wanted != .pause { return true }
                gate = c
                return false
            }
            if resumeNow { c.resume() }
        }
        if want() == .cancel { return await cancelled() }
        lock.withLock { wanted = .run }
        return nil
    }

    private func settle(_ outcome: SaveOutcome) -> SaveOutcome {
        switch outcome {
        case .done, .keptRemote: set(.done)
        case .failed: set(.failed)
        case .conflict: set(.conflict)
        case .cancelled: set(.cancelled)
        }
        onSettle(outcome)
        return outcome
    }

    private func cancelled() async -> SaveOutcome {
        // The server expires the upload within the day if this cannot reach it.
        await release()
        set(.cancelled)
        onSettle(.cancelled)
        return .cancelled
    }
}
