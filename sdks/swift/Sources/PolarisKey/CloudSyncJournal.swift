// The Cloud Sync transfer journal (U-23.S4): what an interrupted file upload needs to carry on after a
// kill. A port of Python `cloud_sync/journal.py`. Host-local state, never a wire shape, so it has no
// corpus family; the unit tests prove it.
//
//   {v: 1, id, kind: "upload", collection, record, uploadId, mode, partBytes, done: [...], sha256, size,
//    expiresAt, state}
//
// `mode` is single, multipart or chunks; `done` is the part numbers the server holds, ascending (always
// empty for chunks, whose record only lets the next run abort the previous upload); `state` is uploading,
// then finalizing; a finished transfer's record is deleted. A reader refuses a `v` it does not know and
// leaves the record alone. A record holds ids, counts, hashes and times: no key, no plaintext, no bearer
// token.
//
// On disk (`FileJournal`) a record is one JSON file in `<state dir>/cloud-sync-transfers/` named by the
// SHA-256 of the transfer id, never by the id (the id is the caller's text, so no id can climb out of the
// directory or collide with another file), mode 0600 in a 0700 directory, written whole to a temporary
// name and renamed into place, kept out of backups (`isExcludedFromBackup`) and, on iOS-family systems,
// readable only after the first unlock. The directory is purged with the person (`clear`).

import Foundation
import PolarisKeyCore

public let transferJournalVersion = 1
public let cloudSyncTransfersDirName = "cloud-sync-transfers"

/// One upload's record. `expiresAt` is epoch milliseconds, as `begin` answers it (V5 §13).
public struct JournalRecord: Sendable, Equatable, Codable {
    public var v: Int
    public var id: String
    public var kind: String
    public var collection: String
    public var record: String
    public var uploadId: String
    public var mode: String
    public var partBytes: Int?
    public var done: [Int]
    public var sha256: String
    public var size: Int
    public var expiresAt: Double
    public var state: String

    /// The record as JSON, the form a store keeps.
    public var json: JSONValue {
        guard let data = try? JSONEncoder().encode(self),
            let v = try? JSONDecoder().decode(JSONValue.self, from: data)
        else { return .null }
        return v
    }
}

/// Why a stored record was refused: `version` for a `v` this build does not know, `shape` otherwise.
public struct TransferJournalError: Error, Sendable, Equatable {
    public enum Reason: String, Sendable { case version, shape }
    public let reason: Reason
}

func isHex64(_ s: String) -> Bool {
    wholeMatches("[0-9a-f]{64}", s) != nil
}

/// The record, or a `TransferJournalError`. The result is a fresh value; the input is not touched.
public func parseJournalRecord(_ raw: JSONValue?) throws -> JournalRecord {
    guard case .object(let o)? = raw else { throw TransferJournalError(reason: .shape) }
    guard case .int(let v)? = o["v"], v == transferJournalVersion else {
        throw TransferJournalError(reason: .version)
    }
    func text(_ k: String) -> String? {
        if case .string(let s)? = o[k], !s.isEmpty { return s }
        return nil
    }
    guard let id = text("id"), o["kind"] == .string("upload"), let collection = text("collection"),
        let record = text("record"), let uploadId = text("uploadId"), let mode = text("mode"),
        ["single", "multipart", "chunks"].contains(mode), let sha = text("sha256"), isHex64(sha),
        case .int(let size)? = o["size"], size >= 0, size <= SYNC_FILE_MAX_BYTES,
        let expiresAt = o["expiresAt"]?.doubleValue, expiresAt.isFinite,
        let state = text("state"), ["uploading", "finalizing"].contains(state),
        case .array(let doneRaw)? = o["done"]
    else { throw TransferJournalError(reason: .shape) }
    var parts = 1
    var partBytes: Int?
    if mode == "multipart" {
        guard case .int(let pb)? = o["partBytes"], pb >= 1 else { throw TransferJournalError(reason: .shape) }
        parts = max(1, (size + pb - 1) / pb)
        if parts > SYNC_MAX_PARTS { throw TransferJournalError(reason: .shape) }
        partBytes = pb
    } else if let pb = o["partBytes"], pb != .null {
        throw TransferJournalError(reason: .shape)
    }
    if mode == "chunks" && !doneRaw.isEmpty { throw TransferJournalError(reason: .shape) }
    var done: [Int] = []
    var last = 0
    for n in doneRaw {
        guard case .int(let k) = n, k > last, k <= parts else { throw TransferJournalError(reason: .shape) }
        done.append(k)
        last = k
    }
    return JournalRecord(
        v: transferJournalVersion, id: id, kind: "upload", collection: collection, record: record,
        uploadId: uploadId, mode: mode, partBytes: partBytes, done: done, sha256: sha, size: size,
        expiresAt: expiresAt, state: state)
}

/// Where records live. The host picks the medium; `get` returns what was stored, unchecked: the engine
/// validates the version.
public protocol JournalStore: Sendable {
    func get(_ id: String) -> JSONValue?
    func put(_ id: String, _ record: JournalRecord)
    func delete(_ id: String)
    func list() -> [String]
    /// Read, change and write back one record as one step: `change` gets what is held (nil when nothing is)
    /// and answers the record to store, or nil to leave it. A delete never lands between the read and the write.
    func update(_ id: String, _ change: (JSONValue?) -> JournalRecord?)
}

extension JournalStore {
    public func update(_ id: String, _ change: (JSONValue?) -> JournalRecord?) {
        if let next = change(get(id)) { put(id, next) }
    }
}

/// An in-memory journal: tests, and a host with nothing durable (a transfer then does not survive a kill).
public final class MemoryJournal: JournalStore, @unchecked Sendable {
    private var map: [String: JSONValue] = [:]
    private let lock = NSLock()

    public init() {}

    public func get(_ id: String) -> JSONValue? { lock.withLock { map[id] } }

    public func put(_ id: String, _ record: JournalRecord) { lock.withLock { map[id] = record.json } }

    /// A raw value, as a foreign build would have left it (tests).
    public func putRaw(_ id: String, _ value: JSONValue) { lock.withLock { map[id] = value } }

    public func delete(_ id: String) { lock.withLock { _ = map.removeValue(forKey: id) } }

    public func list() -> [String] { lock.withLock { Array(map.keys) } }

    public func update(_ id: String, _ change: (JSONValue?) -> JournalRecord?) {
        lock.withLock { if let next = change(map[id]) { map[id] = next.json } }
    }
}

/// The file a transfer id lives in: the lowercase hex SHA-256 of the id, `.json`.
public func journalFileName(_ id: String) -> String {
    SyncCrypto.sha256(Data(id.utf8)).map { String(format: "%02x", $0) }.joined() + ".json"
}

/// Write `data` to `url` the way the state file is written: a random temporary name beside it, created
/// exclusively (O_EXCL), without following a link (O_NOFOLLOW), 0600, fsynced, kept out of backups and
/// (iOS family) protected until first unlock, then renamed over the target. The directory is created
/// 0700 and kept out of backups. Throws on any failure; a failed write leaves no temporary file.
func cloudSyncWriteAtomic(_ data: Data, to url: URL) throws {
    let dir = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(
        at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    // A directory that already exists keeps its mode through the call above: set it on every write.
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
    var dirURL = dir
    var dirValues = URLResourceValues()
    dirValues.isExcludedFromBackup = true
    try? dirURL.setResourceValues(dirValues)
    let tmp = dir.appendingPathComponent(
        "\(url.lastPathComponent).\(SyncCrypto.random(8).map { String(format: "%02x", $0) }.joined()).tmp")
    let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
    var done = false
    defer { if !done { unlink(tmp.path) } }
    do {
        var offset = 0
        try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            while offset < buf.count {
                let n = write(fd, buf.baseAddress! + offset, buf.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw CocoaError(.fileWriteUnknown)
                }
                offset += n
            }
        }
        guard fsync(fd) == 0 else { throw CocoaError(.fileWriteUnknown) }
    } catch {
        close(fd)
        throw error
    }
    close(fd)
    var kept = tmp
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? kept.setResourceValues(values)
    #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: tmp.path)
    #endif
    guard rename(tmp.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
    done = true
}

/// The journal on disk. `stateDir` is the host's state directory; the journal sits in a folder of its own.
public final class FileJournal: JournalStore, @unchecked Sendable {
    public let directory: URL
    /// Writes and deletes run one at a time, so a late write never lands after a delete.
    private let lock = NSLock()

    public init(stateDir: URL) {
        directory = stateDir.appendingPathComponent(cloudSyncTransfersDirName, isDirectory: true)
    }

    private func url(_ id: String) -> URL { directory.appendingPathComponent(journalFileName(id)) }

    private static func read(_ url: URL) -> JSONValue? {
        guard let data = try? Data(contentsOf: url), data.count <= 1024 * 1024 else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// A missing file or one that is not JSON is `nil`; a record of another version or shape is returned
    /// as found, and the engine refuses it and leaves it alone.
    public func get(_ id: String) -> JSONValue? { Self.read(url(id)) }

    public func put(_ id: String, _ record: JournalRecord) {
        guard let data = try? JSONEncoder().encode(record) else { return }
        lock.withLock { try? cloudSyncWriteAtomic(data, to: url(id)) }
    }

    public func update(_ id: String, _ change: (JSONValue?) -> JournalRecord?) {
        lock.withLock {
            guard let next = change(Self.read(url(id))), let data = try? JSONEncoder().encode(next) else { return }
            try? cloudSyncWriteAtomic(data, to: url(id))
        }
    }

    public func delete(_ id: String) {
        lock.withLock { _ = try? FileManager.default.removeItem(at: url(id)) }
    }

    /// The ids of the records held, keeping only a record whose file name is the hash of its own id.
    public func list() -> [String] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return [] }
        var ids: [String] = []
        for name in names where name.count == 69 && name.hasSuffix(".json") && isHex64(String(name.dropLast(5))) {
            if case .object(let o)? = Self.read(directory.appendingPathComponent(name)),
                case .string(let rid)? = o["id"], journalFileName(rid) == name
            {
                ids.append(rid)
            }
        }
        return ids
    }

    /// The purge that goes with the person (sign-out, forget).
    public func clear() {
        lock.withLock { _ = try? FileManager.default.removeItem(at: directory) }
    }
}
