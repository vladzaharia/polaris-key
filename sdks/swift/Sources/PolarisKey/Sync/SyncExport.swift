// The core of `cloudSync.export()` (WIRE-CONTRACT-V5 §13.12, `pkey-sync-export/1`): a readable,
// unencrypted zip of what an app synced, made on the device. A port of client-core's `sync/export.ts` and
// Python's `cloud_sync/export.py`. This file plans the archive, then streams it into an `ExportSink`; it
// speaks to no network and no file. The host (`CloudSyncExport.swift`) gives it
//
//   * the rows as the Worker served them (after a pull with `more` false),
//   * the host codec in end-to-end mode (nil in server mode) and a file-codec factory,
//   * an `ExportFileSource` that fetches stored bytes and chunk objects (`Range` resume, the hourly
//     allowance, retries and their bounded wait are the source's), and
//   * a sink.
//
// Everything the Worker served is untrusted. A row that does not open is dropped and listed; a file that
// does not check is written as far as it checks and flagged `partial`; nothing aborts the export but a
// bound (`sync-export-too-large`, before the first byte), a source that throws, and a cancel.
//
// Order. The central directory lists the entries in the order of §13.12 (README, settings, records, files,
// files.json, index.json, data.json). The bytes are written in the order the data is known: a record line
// cites its file's size and SHA-256, so the files are streamed first. A reader that goes by the central
// directory sees the §13.12 order.
//
// Memory. The plan keeps, per row, the ids and sizes it needs (a row is opened again when its line is
// written), the settings, the manifests of the chunked files and their chunk records. A file is read one
// segment (1 MiB + 16) or one chunk at a time with an incremental SHA-256 and CRC-32; the source's own
// piece (a `Range` of up to 8 MiB) is the other term of the peak.
//
// Nothing here puts a value, an id or a path in an error or a log line.

import Foundation
import PolarisKeyCore

#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

// MARK: input

/// Names one stored file: the record's wire id (blinded in end-to-end mode) and a version. `size` is the
/// pointer's (already checked: a non-negative safe integer) and `format` `whole` or `chunks`; a `chunks`
/// ref names the manifest, which the source reads unranged. `version` is nil for a pointer whose version
/// is not a whole number (the source then asks for the current file, whose bytes the hash check judges).
struct ExportFileRef: Sendable, Equatable {
    let collection: String
    let record: String
    let version: Int?
    let format: String
    let size: Int
}

/// Where a file's stored bytes come from. A source throws what its transport throws (a cancel, a network
/// failure after its bounded retries); the export never swallows that. A missing object is not a throw:
/// `stored` delivers nothing and `chunk` answers nil for what the Worker does not have, and the file is
/// then written short and flagged partial.
protocol ExportFileSource: Sendable {
    /// Every kept version of a record's file, including the current one, in any order: objects with
    /// `version`, `size`, `sha256` and `format`, each as served.
    func pointers(collection: String, record: String) async throws -> [JSONValue]
    /// The stored bytes of a version (a whole file, or the manifest of a chunked one) in pieces, each handed
    /// to `piece`; it answers false to stop reading.
    func stored(_ ref: ExportFileRef, _ piece: (Data) async throws -> Bool) async throws
    /// A chunk object by its id (hex), or nil.
    func chunk(collection: String, id: String) async throws -> Data?
}

struct ExportInput: Sendable {
    var product: String
    /// The device clock, in milliseconds.
    var exportedAt: Int
    /// Edits not yet pushed.
    var unsynced: Int
    var includeRevisions: Bool
    /// The changes of the pull as served (sealed in end-to-end mode): settings and records.
    var changes: [JSONValue]
    var files: any ExportFileSource
    /// The host codec in end-to-end mode; nil is server mode.
    var codec: (any SyncCodecPort)?
    /// A collection's file codec; omitted, `ServerFileCodec` (server mode).
    var fileCodec: (@Sendable (String) throws -> any FileCodec)?
    /// Test and host overrides of the bounds; `maxBytes` is the zip32 total of §13.12.
    var maxEntries: Int?
    var maxBytes: Int?
    /// (plaintext bytes written, planned plaintext bytes) after each piece of a file.
    var onProgress: (@Sendable (Int, Int) -> Void)?

    init(
        product: String, exportedAt: Int, unsynced: Int, includeRevisions: Bool, changes: [JSONValue],
        files: any ExportFileSource, codec: (any SyncCodecPort)? = nil,
        fileCodec: (@Sendable (String) throws -> any FileCodec)? = nil, maxEntries: Int? = nil,
        maxBytes: Int? = nil, onProgress: (@Sendable (Int, Int) -> Void)? = nil
    ) {
        self.product = product
        self.exportedAt = exportedAt
        self.unsynced = unsynced
        self.includeRevisions = includeRevisions
        self.changes = changes
        self.files = files
        self.codec = codec
        self.fileCodec = fileCodec
        self.maxEntries = maxEntries
        self.maxBytes = maxBytes
        self.onProgress = onProgress
    }
}

/// What the export left out or could not finish: a setting or record that did not open (`invalid`), a file
/// with no entry (`sync-file-invalid`), or a file written short (`sync-file-invalid`, `partial`).
public struct CloudSyncExportSkipped: Sendable, Equatable {
    public let kind: String
    public let collection: String?
    public let entry: String?
    public let code: String
    public let partial: Bool

    init(kind: String, code: String, collection: String? = nil, entry: String? = nil, partial: Bool = false) {
        self.kind = kind
        self.code = code
        self.collection = collection
        self.entry = entry
        self.partial = partial
    }

    var json: JSONValue {
        var o: [String: JSONValue] = ["kind": .string(kind), "code": .string(code)]
        if let collection { o["collection"] = .string(collection) }
        if let entry { o["entry"] = .string(entry) }
        if partial { o["partial"] = .bool(true) }
        return .object(o)
    }
}

struct ExportSummary: Sendable, Equatable {
    /// Bytes sent to the sink.
    var bytes: Int
    /// The zip32 total the plan counted before the first byte.
    var plannedBytes: Int
    var entries: Int
    var settings: Int
    var records: Int
    var files: Int
    var skipped: [CloudSyncExportSkipped]
}

// MARK: fixed text

let syncExportReadme = """
    This is a readable copy of data an app synced with Polaris Locker.

    The app made it on this device. It is NOT encrypted: anyone who can open
    this file can read everything in it. Keep it where you keep your other
    private files, and delete it when you no longer need it. The time it was
    made is "exportedAt" in data.json, in milliseconds since 1970-01-01 UTC.

    Polaris Locker's own export of this data, from its website, uses the same
    layout and holds the data as the app stored it: encrypted when the app
    encrypts it.

    data.json                              what this holds, and what could not be read
    stores/sync.cloudSync/settings.json    the synced settings
    stores/sync.cloudSync/records/         the synced records, one file a collection
    stores/sync.cloudSync/index.json       which file holds which collection
    stores/sync.cloudSync/files/           the synced files
    stores/sync.cloudSync/files.json       which file belongs to which record

    A file marked "partial" in data.json is incomplete or did not match what
    the app stored. Do not rely on it.

    """

// MARK: helpers

private let maxSafe = (1 << 53) - 1

/// A failure of the plan itself (an archive the plan undercounted): never reached by a well-formed export.
struct ExportPlanError: Error {}

func exportCancelled() -> PolarisError {
    PolarisError(code: ErrorCode.cancelled, message: "The export was cancelled")
}

private func checkCancelled() throws {
    if Task.isCancelled { throw exportCancelled() }
}

private func bytesOf(_ s: String) -> Int { s.utf8.count }

/// Names compare as UTF-8 bytes, never by Swift's canonical equivalence.
private func lessBytes(_ a: String, _ b: String) -> Bool { a.utf8.lexicographicallyPrecedes(b.utf8) }

private func sameBytes(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

private func isNumber(_ v: JSONValue?) -> Bool {
    switch v {
    case .int?, .double?: return true
    default: return false
    }
}

private func numbersEqual(_ a: JSONValue?, _ b: JSONValue?) -> Bool {
    guard isNumber(a), isNumber(b), let x = a?.doubleValue, let y = b?.doubleValue else { return false }
    return x == y
}

/// A pointer's size when it is a non-negative safe integer (a JSON number), else nil.
private func sizeOf(_ v: JSONValue?) -> Int? {
    switch v {
    case .int(let i)?: return i >= 0 && i <= maxSafe ? i : nil
    case .double(let d)?:
        guard d.isFinite, d == d.rounded(.towardZero), d >= 0, d <= Double(maxSafe) else { return nil }
        return Int(d)
    default: return nil
    }
}

private func isHex64(_ v: JSONValue?) -> Bool {
    guard case .string(let s)? = v else { return false }
    return s.utf8.count == 64 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
}

private func hex(_ d: some Sequence<UInt8>) -> String { d.map { String(format: "%02x", $0) }.joined() }

/// A served version is a count a reader of any language holds exactly: an integer past 2^53 - 1 is not.
private func safeVersion(_ v: JSONValue?) -> Bool {
    switch v {
    case .int(let i)?: return i.magnitude <= UInt(maxSafe)
    case .double(let d)?: return !(d.isFinite && d == d.rounded(.towardZero) && abs(d) > Double(maxSafe))
    default: return true
    }
}

/// Whether a container nests no deeper than `MAX_JSON_DEPTH`, counted from the value's own outermost array
/// or object as level 1.
private func withinDepth(_ v: JSONValue, _ level: Int = 0) -> Bool {
    switch v {
    case .array(let a): return level < MAX_JSON_DEPTH && a.allSatisfy { withinDepth($0, level + 1) }
    case .object(let o): return level < MAX_JSON_DEPTH && o.values.allSatisfy { withinDepth($0, level + 1) }
    default: return true
    }
}

/// Canonical JSON (§13.10.3) has a spelling for the value: a finite number, an integer within 2^53, and
/// nesting within the bound. (A Swift string never holds a lone surrogate.)
private func serialisable(_ v: JSONValue) -> Bool {
    withinDepth(v) && (try? CanonicalJSON.encode(v)) != nil
}

/// A name the lenient parse turned into NaN: its string held a lone surrogate.
func isUnspellable(_ v: JSONValue) -> Bool {
    if case .double(let d) = v { return d.isNaN }
    return false
}

private func isNameOrUnspellable(_ v: JSONValue) -> Bool {
    if case .string = v { return true }
    return isUnspellable(v)
}

private func canon(_ v: JSONValue) throws -> String { try CanonicalJSON.encode(v) + "\n" }

private func entryNames(records: Int, files: Int) -> [String] {
    let d = SYNC_EXPORT_STORE_DIR
    return ["README.txt", d + "settings.json"]
        + (0..<records).map { "\(d)records/\($0).ndjson" } + (0..<files).map { "\(d)files/\($0).bin" }
        + [d + "files.json", d + "index.json", "data.json"]
}

private func recordRef(_ c: [String: JSONValue]) -> (collection: String, id: String)? {
    guard case .array(let r)? = c["record"], r.count >= 2, case .string(let a) = r[0], case .string(let b) = r[1]
    else { return nil }
    return (a, b)
}

private func pointerOf(_ c: [String: JSONValue]) -> [String: JSONValue]? {
    if case .object(let f)? = c["file"], isNumber(f["version"]) { return f }
    return nil
}

// MARK: opening rows

private struct Binding {
    let sha256: String
    let size: Int
    let format: String
}

/// Whether the sealed `$file` binding names this pointer's file.
private func named(_ b: Binding, by f: [String: JSONValue]) -> Bool {
    guard case .string(let sha)? = f["sha256"], sha == b.sha256, isNumber(f["size"]),
        f["size"]?.doubleValue == Double(b.size), case .string(let fmt)? = f["format"], fmt == b.format
    else { return false }
    return true
}

/// The `$file` binding of a sealed value, or nil when it names no file a reader can use.
private func bindingOf(_ raw: JSONValue) -> Binding? {
    guard case .object(let o) = raw, case .string(let sha)? = o["sha256"], isHex64(o["sha256"]),
        let size = sizeOf(o["size"]), size != 0, case .string(let fmt)? = o["format"],
        fmt == "whole" || fmt == "chunks"
    else { return nil }
    return Binding(sha256: sha, size: size, format: fmt)
}

private struct OpenedRow {
    let id: String
    let version: JSONValue
    let hasValue: Bool
    let value: JSONValue
    let binding: Binding?
}

private enum OpenedRecord {
    case row(OpenedRow)
    /// An end-to-end record with no cells reveals no id: omitted, unlisted.
    case omit
    /// A file and no value: nothing names the id, nothing binds the file.
    case fileOnly
    case invalid
}

private struct Opener {
    let codec: (any SyncCodecPort)?

    /// An opened change as the host codec opens a pull, or nil when it does not open.
    private func viaPull(_ c: [String: JSONValue]) throws -> [String: JSONValue]? {
        let pulled = try HostCodec.openPull(.object(["changes": .array([.object(c)])]), codec: codec!)
        guard case .object(let b) = pulled.body, case .array(let list)? = b["changes"],
            case .object(let e)? = list.first,
            let row = pulled.opened.changes.first ?? nil, row.sealed
        else { return nil }
        return e
    }

    func setting(_ c: [String: JSONValue], wire: String) throws -> (name: String, value: JSONValue)? {
        guard codec != nil else {
            if case .object? = c["members"] { return (wire, c["members"]!) }
            return c["value"].map { (wire, $0) }
        }
        var hasMembers = false
        if case .array? = c["members"] { hasMembers = true }
        if c["ct"] == nil && !hasMembers { return nil }
        guard let e = try viaPull(c), case .string(let name)? = e["setting"], let value = e["value"] else { return nil }
        return (name, value)
    }

    func record(_ collection: String, _ wire: String, _ c: [String: JSONValue]) throws -> OpenedRecord {
        let pointer = pointerOf(c)
        let version = c["version"] ?? .null
        guard codec != nil else {
            return .row(
                OpenedRow(
                    id: wire, version: version, hasValue: c["value"] != nil, value: c["value"] ?? .null,
                    binding: nil))
        }
        for shape in ["fields", "elements"] {
            if case .array(let cells)? = c[shape], cells.isEmpty { return .omit }
        }
        var sealedShape = false
        if case .array? = c["fields"] { sealedShape = true }
        if case .array? = c["elements"] { sealedShape = true }
        if case .string? = c["ct"] { sealedShape = true }
        if !sealedShape { return c["ct"] == nil && pointer != nil ? .fileOnly : .invalid }
        guard let e = try viaPull(c), case .array(let rec)? = e["record"], rec.count >= 2,
            case .string(let col) = rec[0], sameBytes(col, collection), case .string(let id) = rec[1],
            var value = e["value"]
        else { return .invalid }
        var binding: Binding?
        if case .string? = c["ct"], case .object(var o) = value, let raw = o["$file"] {
            o["$file"] = nil
            value = .object(o)
            binding = bindingOf(raw)
        }
        return .row(OpenedRow(id: id, version: version, hasValue: true, value: value, binding: binding))
    }
}

// MARK: the plan

private final class Row {
    let collection: String
    /// The wire id, which keys the row's files.
    let wire: String
    let id: String
    /// The change as served: the row is opened again when its line is written.
    let change: [String: JSONValue]
    var pointer: [String: JSONValue]?
    let binding: Binding?
    /// Bytes of the line without its `file` member.
    let lineBytes: Int

    init(
        collection: String, wire: String, id: String, change: [String: JSONValue], pointer: [String: JSONValue]?,
        binding: Binding?, lineBytes: Int
    ) {
        self.collection = collection
        self.wire = wire
        self.id = id
        self.change = change
        self.pointer = pointer
        self.binding = binding
        self.lineBytes = lineBytes
    }
}

private struct Manifest {
    let records: [SyncManifest.Record]
    let plainSha256: Data
}

private struct Planned {
    let row: Row
    let ref: ExportFileRef
    let file: [String: JSONValue]
    let live: Bool
    let planned: Int
    let manifest: Manifest?
}

private func lineText(_ r: OpenedRow, file: JSONValue?, id: String? = nil) throws -> String {
    var o: [String: JSONValue] = ["id": .string(id ?? r.id), "version": r.version]
    if r.hasValue { o["value"] = r.value }
    if let file { o["file"] = file }
    return try canon(.object(o))
}

private func writable(_ r: OpenedRow) -> Bool {
    serialisable(.string(r.id)) && safeVersion(r.version) && serialisable(r.version)
        && serialisable(r.hasValue ? r.value : .null)
}

/// The settings' canonical object, built from pairs so two names that Swift would call equal stay two.
private func settingsLine(_ pairs: [(name: String, value: JSONValue)]) throws -> String {
    let sorted = pairs.sorted { Array($0.name.utf16).lexicographicallyPrecedes(Array($1.name.utf16)) }
    let parts = try sorted.map { try CanonicalJSON.encode(.string($0.name)) + ":" + CanonicalJSON.encode($0.value) }
    return "{" + parts.joined(separator: ",") + "}\n"
}

/// A file may take ceil(planned / this) + 8 requests of its source.
let exportPieceFloorBytes = 64 * 1024

private func readBounded(_ files: any ExportFileSource, _ ref: ExportFileRef, limit: Int) async throws -> (
    data: Data, over: Bool
) {
    var parts = Data()
    var over = false
    try await files.stored(ref) { piece in
        try checkCancelled()
        if parts.count + piece.count > limit {
            over = true
            return false
        }
        parts.append(piece)
        return true
    }
    return (parts, over)
}

/// Plans the archive, refusing with `sync-export-too-large` before the first byte, then writes it to `sink`.
/// The caller commits (or discards) the sink's destination once this returns or throws.
func exportToSink(_ inp: ExportInput, _ sink: any ExportSink) async throws -> ExportSummary {
    let e2e = inp.codec != nil
    let opener = Opener(codec: inp.codec)
    let encryption = e2e ? "e2e" : "server"
    let d = SYNC_EXPORT_STORE_DIR
    let maxEntries = inp.maxEntries ?? SYNC_EXPORT_MAX_ENTRIES
    let maxBytes = inp.maxBytes ?? SYNC_EXPORT_MAX_BYTES
    let reserve = SYNC_EXPORT_ITEM_RESERVE_BYTES
    var settingSkips: [CloudSyncExportSkipped] = []
    var recordSkips: [CloudSyncExportSkipped] = []
    var fileSkips: [CloudSyncExportSkipped] = []
    var partialSkips: [CloudSyncExportSkipped] = []
    var codecs: [[UInt8]: any FileCodec] = [:]

    func codecFor(_ collection: String) throws -> any FileCodec {
        let key = Array(collection.utf8)
        if let c = codecs[key] { return c }
        let c: any FileCodec = try inp.fileCodec?(collection) ?? ServerFileCodec()
        codecs[key] = c
        return c
    }

    let changes = inp.changes.compactMap { $0.objectValue }

    // Settings, in the byte order of the name the Worker served.
    var settingChanges: [(wire: String, change: [String: JSONValue])] = []
    for c in changes {
        if case .string(let wire)? = c["setting"] { settingChanges.append((wire, c)) }
    }
    settingChanges.sort { lessBytes($0.wire, $1.wire) }
    // A name no Swift string can hold (a lone surrogate, read leniently as NaN) is a row no runtime
    // can write: it is listed, never dropped quietly. The same for a record whose collection or id is one.
    for c in changes {
        if let name = c["setting"], isUnspellable(name) {
            settingSkips.append(CloudSyncExportSkipped(kind: "setting", code: "invalid"))
        } else if case .array(let r)? = c["record"], r.count >= 2, isUnspellable(r[0]) || isUnspellable(r[1]),
            isNameOrUnspellable(r[0]), isNameOrUnspellable(r[1])
        {
            let collection = r[0].stringValue
            recordSkips.append(CloudSyncExportSkipped(kind: "record", code: "invalid", collection: collection))
        }
    }
    var settings: [(name: String, value: JSONValue)] = []
    var settingIndex: [[UInt8]: Int] = [:]
    var settingCount = 0
    for (wire, c) in settingChanges {
        try checkCancelled()
        if let got = try opener.setting(c, wire: wire), serialisable(.string(got.name)), serialisable(got.value) {
            let key = Array(got.name.utf8)
            if let at = settingIndex[key] {
                settings[at] = got
            } else {
                settingIndex[key] = settings.count
                settings.append(got)
            }
            settingCount += 1
        } else {
            settingSkips.append(CloudSyncExportSkipped(kind: "setting", code: "invalid"))
        }
    }
    let settingsLineBytes = Data(try settingsLine(settings).utf8)

    // Records, a collection at a time, rows in the byte order of the wire id.
    let recordChanges = changes.filter { recordRef($0) != nil }
    var collections: [String] = []
    var seenCollections = Set<[UInt8]>()
    for c in recordChanges where seenCollections.insert(Array(recordRef(c)!.collection.utf8)).inserted {
        collections.append(recordRef(c)!.collection)
    }
    collections.sort(by: lessBytes)
    /// The written collections, with the index into `collections` of each.
    var written: [(collection: String, rows: [Row])] = []
    var writtenAt: [Int: Int] = [:]
    var fileOnly: [Int: Int] = [:]
    for (ci, collection) in collections.enumerated() {
        var rows: [Row] = []
        let mine = recordChanges.filter { sameBytes(recordRef($0)!.collection, collection) }
            .sorted { lessBytes(recordRef($0)!.id, recordRef($1)!.id) }
        for c in mine {
            try checkCancelled()
            let wire = recordRef(c)!.id
            switch try opener.record(collection, wire, c) {
            case .omit: continue
            case .fileOnly:
                fileOnly[ci, default: 0] += 1
            case .invalid:
                recordSkips.append(CloudSyncExportSkipped(kind: "record", code: "invalid", collection: collection))
            case .row(let r):
                guard writable(r) else {
                    recordSkips.append(
                        CloudSyncExportSkipped(kind: "record", code: "invalid", collection: collection))
                    continue
                }
                rows.append(
                    Row(
                        collection: collection, wire: wire, id: r.id, change: c, pointer: pointerOf(c),
                        binding: r.binding, lineBytes: bytesOf(try lineText(r, file: nil))))
            }
        }
        rows.sort { lessBytes($0.id, $1.id) }
        if !rows.isEmpty {
            writtenAt[ci] = written.count
            written.append((collection, rows))
        }
    }

    // The manifests of every chunked file are fetched and checked before anything else is read.
    var chunkTotal = 0
    /// The collection of every file pointer the machine holds that the plan met.
    var pointerCollections: [String] = []

    func validate(_ collection: String, _ ref: ExportFileRef, _ f: [String: JSONValue]) async throws -> (
        plain: Int, manifest: Manifest?
    )? {
        guard let size = sizeOf(f["size"]), isHex64(f["sha256"]), case .string(let sha)? = f["sha256"] else {
            return nil
        }
        let codec = try codecFor(collection)
        guard case .string(let fmt)? = f["format"] else { return nil }
        if fmt == "whole" {
            if !e2e { return (size, nil) }
            guard let plain = codec.plainSize(size) else { return nil }
            return (plain, nil)
        }
        guard fmt == "chunks" else { return nil }
        let manifestMax = codec.storedSize(
            SyncManifest.headerBytes + SyncManifest.recordBytes * SYNC_MAX_CHUNKS_PER_FILE)
        let (got, over) = try await readBounded(inp.files, ref, limit: manifestMax)
        guard !over, hex(SHA256.hash(data: got)) == sha else { return nil }
        guard case .ok(let plain) = try codec.openManifest(got), case .ok(let m) = SyncManifest.parse(plain) else {
            return nil
        }
        guard codec.storedSize(m.plainSize) == size else { return nil }
        chunkTotal += m.records.count
        return (m.plainSize, Manifest(records: m.records, plainSha256: m.plainSha256))
    }

    // The plan: every file entry, live first and then the revisions, newest first.
    var planned: [Planned] = []
    for (ci, collection) in collections.enumerated() {
        func noEntry() {
            pointerCollections.append(collection)
            fileSkips.append(CloudSyncExportSkipped(kind: "file", code: "sync-file-invalid", collection: collection))
        }
        for _ in 0..<(fileOnly[ci] ?? 0) { noEntry() }
        let rows = writtenAt[ci].map { written[$0].rows } ?? []
        for row in rows {
            guard let current = row.pointer else { continue }
            try checkCancelled()
            if e2e && row.binding == nil {
                // A file the sealed value does not name is no readable file there (§13.10.4).
                noEntry()
                row.pointer = nil
                continue
            }
            var others: [[String: JSONValue]] = []
            for f in try await inp.files.pointers(collection: collection, record: row.wire) {
                if case .object(let o) = f, isNumber(o["version"]), !numbersEqual(o["version"], current["version"]) {
                    others.append(o)
                }
            }
            let older = others.sorted { ($0["version"]?.doubleValue ?? 0) > ($1["version"]?.doubleValue ?? 0) }
            let candidates = [current] + older
            pointerCollections.append(contentsOf: candidates.map { _ in collection })
            var live: Int?
            for (i, f) in candidates.enumerated() {
                if row.binding.map({ named($0, by: f) }) ?? (i == 0) {
                    live = i
                    break
                }
            }

            func mark(_ f: [String: JSONValue], live isLive: Bool) async throws {
                let size = sizeOf(f["size"])
                let fmt = f["format"]?.stringValue == "chunks" ? "chunks" : "whole"
                let version = f["version"]?.intValue
                let ref = ExportFileRef(
                    collection: collection, record: row.wire, version: version, format: fmt, size: size ?? 0)
                var v: (plain: Int, manifest: Manifest?)?
                if chunkTotal <= SYNC_EXPORT_MAX_CHUNKS { v = try await validate(collection, ref, f) }
                guard let v else {
                    fileSkips.append(
                        CloudSyncExportSkipped(kind: "file", code: "sync-file-invalid", collection: collection))
                    if isLive { row.pointer = nil }
                    return
                }
                planned.append(
                    Planned(row: row, ref: ref, file: f, live: isLive, planned: v.plain, manifest: v.manifest))
            }

            // No candidate is the live file: the row has no readable file.
            guard let live else {
                row.pointer = nil
                fileSkips.append(
                    CloudSyncExportSkipped(kind: "file", code: "sync-file-invalid", collection: collection))
                continue
            }
            try await mark(candidates[live], live: true)
            if inp.includeRevisions {
                for (i, f) in candidates.enumerated() where i != live { try await mark(f, live: false) }
            }
        }
    }

    // The bounds, all before the first byte.
    let entryCount = 5 + written.count + planned.count
    if entryCount > maxEntries { throw exportTooLarge("too many entries") }
    if chunkTotal > SYNC_EXPORT_MAX_CHUNKS { throw exportTooLarge("too many chunks") }
    var fileBytes = 0
    for p in planned {
        fileBytes += p.planned  // each term and the sum stay safe integers: stop at the cap
        if fileBytes > maxBytes { throw exportTooLarge("files over the limit") }
    }

    let liveRows = Set(planned.filter(\.live).map { ObjectIdentifier($0.row) })

    func indexText(_ listing: [(collection: String, rows: [Row])]) throws -> String {
        try canon(
            .object([
                "records": .array(
                    listing.enumerated().map { i, e in
                        .object([
                            "entry": .string("\(d)records/\(i).ndjson"), "collection": .string(e.collection),
                            "count": .int(e.rows.count),
                        ])
                    })
            ]))
    }

    var known = bytesOf(syncExportReadme) + settingsLineBytes.count
    known += bytesOf(try indexText(written))
    for (_, rows) in written {
        for r in rows { known += r.lineBytes + (liveRows.contains(ObjectIdentifier(r)) ? reserve : 0) }
    }
    // files.json and data.json depend on what the reads find: they count at their bound.
    known += 2 + planned.count
    for p in planned { known += reserve + 6 * (bytesOf(p.row.collection) + bytesOf(p.row.id)) }
    known += reserve
    known += reserve * settingChanges.count
    for c in recordChanges { known += reserve + 6 * bytesOf(recordRef(c)!.collection) }
    for pc in pointerCollections { known += reserve + 6 * bytesOf(pc) }

    let names = entryNames(records: written.count, files: planned.count)
    let overhead =
        names.reduce(0) { $0 + SYNC_EXPORT_ZIP_ENTRY_BYTES + 2 * bytesOf($1) } + SYNC_EXPORT_ZIP_END_BYTES
    let plannedBytes = fileBytes + known + overhead
    if plannedBytes > maxBytes { throw exportTooLarge("over the size limit") }

    // ── write ────────────────────────────────────────────────────────────────────────────────

    let zip = ZipStoreWriter(sink: sink)
    try await zip.addBytes("README.txt", Data(syncExportReadme.utf8))
    try await zip.addBytes(d + "settings.json", settingsLineBytes)

    // The files, read one at a time, in plan order, at most the planned size each.
    var fileIndex: [JSONValue] = []
    var lineFile: [ObjectIdentifier: JSONValue] = [:]
    var writtenPlain = 0
    let onProgress = inp.onProgress
    let progress: (Int) -> Void = { n in
        writtenPlain += n
        onProgress?(writtenPlain, fileBytes)
    }

    for (n, p) in planned.enumerated() {
        try checkCancelled()
        let entry = "\(d)files/\(n).bin"
        try await zip.begin(entry)
        let read = try await readFile(p, zip, inp.files, try codecFor(p.row.collection), e2e, progress)
        try await zip.end()
        if read.partial {
            partialSkips.append(
                CloudSyncExportSkipped(
                    kind: "file", code: "sync-file-invalid", collection: p.row.collection, entry: entry, partial: true))
        }
        // What the archive holds of this file, as the record's `file` member and as a files.json item.
        var facts: [String: JSONValue] = [
            "entry": .string(entry), "version": p.file["version"] ?? .null, "size": .int(read.size),
            "sha256": .string(read.sha),
        ]
        if read.partial {
            facts["partial"] = .bool(true)
            facts["expectedSize"] = .int(p.planned)
        }
        var item = facts
        item["collection"] = .string(p.row.collection)
        item["id"] = .string(p.row.id)
        item["live"] = .bool(p.live)
        if e2e && !p.live { item["bound"] = .bool(false) }
        fileIndex.append(.object(item))
        if p.live { lineFile[ObjectIdentifier(p.row)] = .object(facts) }
    }

    // The record files, a line at a time: each row is opened again for its line.
    var indexRecords: [JSONValue] = []
    var recordCount = 0
    for (i, entry) in written.enumerated() {
        let name = "\(d)records/\(i).ndjson"
        try await zip.begin(name)
        for r in entry.rows {
            try checkCancelled()
            guard case .row(let again) = try opener.record(entry.collection, r.wire, r.change) else {
                throw PolarisError(code: ErrorCode.syncExportFailed, message: "A record changed while it was exported")
            }
            try await zip.write(Data(try lineText(again, file: lineFile[ObjectIdentifier(r)], id: r.id).utf8))
            recordCount += 1
        }
        try await zip.end()
        indexRecords.append(
            .object(["entry": .string(name), "collection": .string(entry.collection), "count": .int(entry.rows.count)]))
    }

    try await zip.addBytes(d + "files.json", Data(try canon(.array(fileIndex)).utf8))
    try await zip.addBytes(d + "index.json", Data(try canon(.object(["records": .array(indexRecords)])).utf8))
    let skipped = settingSkips + recordSkips + fileSkips + partialSkips
    let data: JSONValue = .object([
        "schema": .string(SYNC_EXPORT_FORMAT), "source": .string("device"), "product": .string(inp.product),
        "exportedAt": .int(inp.exportedAt), "encryption": .string(encryption),
        "counts": .object([
            "settings": .int(settingCount), "records": .int(recordCount), "files": .int(planned.count),
        ]),
        "unsynced": .int(inp.unsynced), "skipped": .array(skipped.map(\.json)),
    ])
    try await zip.addBytes("data.json", Data(try canon(data).utf8))
    let total = try await zip.finish(order: names)
    if total > plannedBytes { throw ExportPlanError() }
    return ExportSummary(
        bytes: total, plannedBytes: plannedBytes, entries: names.count, settings: settingCount,
        records: recordCount, files: planned.count, skipped: skipped)
}

// MARK: reading one file

/// A sink write is at most one segment: 1 MiB of plaintext.
private let piece = 1_048_576

/// Streams one planned file into the open entry; the bytes written, their SHA-256 and whether it is partial.
private func readFile(
    _ p: Planned, _ zip: ZipStoreWriter, _ files: any ExportFileSource, _ codec: any FileCodec, _ e2e: Bool,
    _ progress: (Int) -> Void
) async throws -> (size: Int, sha: String, partial: Bool) {
    var written = SHA256()
    var size = 0
    var partial = false

    func put(_ b: Data) async throws {
        if size + b.count > p.planned { throw ExportPlanError() }
        written.update(data: b)
        size += b.count
        try await zip.write(b)
        progress(b.count)
    }

    if let m = p.manifest {
        var total = SHA256()
        for rec in m.records {
            try checkCancelled()
            let id = hex(rec.id)
            guard let obj = try await files.chunk(collection: p.row.collection, id: id),
                obj.count <= SYNC_CHUNK_MAX_STORED_BYTES,
                case .ok(let plain) = try codec.openChunk(id: rec.id, object: obj), plain.count == rec.plainLen
            else {
                partial = true
                break
            }
            total.update(data: plain)
            try await put(plain)
        }
        if !partial && Data(total.finalize()) != m.plainSha256 { partial = true }
        return (size, hex(written.finalize()), partial)
    }

    let stored = sizeOf(p.file["size"]) ?? 0
    let wanted = p.file["sha256"]?.stringValue
    var read = 0
    var hash = SHA256()
    // The opener (end-to-end) sees at most `stored` bytes; the rest of what a source serves is not read.
    let opener: (any FileOpener)? = e2e ? try codec.makePlannedOpener(plainSize: p.planned) : nil
    if stored > 0 {
        // A source is asked for at most `ceil(stored / 64 KiB) + 8` pieces: a Worker serving one-byte
        // ranges ends the file short (partial) and the export goes on.
        var pieces = 0
        let pieceCap = (stored + exportPieceFloorBytes - 1) / exportPieceFloorBytes + 8
        try await files.stored(p.ref) { got in
            try checkCancelled()
            pieces += 1
            let room = stored - read
            let part = got.count > room ? got.prefix(room) : got
            if part.isEmpty { return read < stored && pieces < pieceCap }
            read += part.count
            hash.update(data: part)
            if let opener {
                do {
                    for plain in try opener.push(Data(part)) { try await put(plain) }
                } catch is SyncFileStream.Failure {
                    partial = true
                    return false
                }
            } else {
                var at = part.startIndex
                while at < part.endIndex {
                    let end = min(part.endIndex, at + piece)
                    try await put(Data(part[at..<end]))
                    at = end
                }
            }
            return read < stored && pieces < pieceCap
        }
    }
    if let opener, !partial {
        do { _ = try opener.finish() } catch is SyncFileStream.Failure { partial = true }
    }
    if !partial { partial = read != stored || hex(hash.finalize()) != wanted }
    return (size, hex(written.finalize()), partial)
}
