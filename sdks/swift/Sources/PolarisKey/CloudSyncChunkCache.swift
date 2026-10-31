// The Cloud Sync chunk cache (U-23.S4, plan D-9): a port of Python `cloud_sync/chunk_cache.py`.
//
// It holds chunk objects as stored (ciphertext in E2E mode, never plaintext), keyed by the 64-character
// lowercase hex chunk id, so a download fetches only the chunks the device lacks. Entries are named from
// the id alone, never from server text: `get`, `put` and `delete` refuse anything but such an id with
// `ChunkCacheError.badId`. A cache is best effort: the engine treats a failing `get` as a miss and a
// failing `put` as nothing, and it opens every cached object again before use, so a damaged entry costs a
// fetch. The host bounds it with an LRU of `chunkCacheBudget(largestSave:)` bytes per (product, subject,
// collection), keeps it out of OS backup (`isExcludedFromBackup`) and purges it with the person
// (sign-out, forget): `clear()`.

import Foundation
import PolarisKeyCore

public let cloudSyncChunksDirName = "cloud-sync-chunks"
/// The least a cache is allowed to hold (D-9).
public let chunkCacheMinBytes = 256 * 1024 * 1024

public struct ChunkCacheError: Error, Sendable, Equatable {
    public let what: String
    static let badId = ChunkCacheError(what: "chunk cache id")
}

/// D-9: at most max(256 MiB, twice the largest save).
public func chunkCacheBudget(largestSave: Int) -> Int { max(chunkCacheMinBytes, 2 * max(0, largestSave)) }

/// True for a chunk id that is safe to turn into a file or key name.
public func isChunkCacheId(_ id: String) -> Bool { isHex64(id) }

public protocol ChunkCache: Sendable {
    func get(_ id: String) throws -> Data?
    func put(_ id: String, _ object: Data) throws
    func delete(_ id: String) throws
    /// Drop every entry: the purge that goes with the person.
    func clear()
}

private func check(_ id: String) throws {
    if !isChunkCacheId(id) { throw ChunkCacheError.badId }
}

/// An in-memory LRU: tests, and a host with no durable store (the cache then lasts one session).
public final class MemoryChunkCache: ChunkCache, @unchecked Sendable {
    private let maxBytes: Int
    private var map: [String: Data] = [:]
    private var order: [String] = []  // oldest first
    private var total = 0
    private let lock = NSLock()

    public init(maxBytes: Int = chunkCacheMinBytes) { self.maxBytes = maxBytes }

    public func get(_ id: String) throws -> Data? {
        try check(id)
        return lock.withLock {
            guard let v = map[id] else { return nil }
            order.removeAll { $0 == id }
            order.append(id)
            return v
        }
    }

    public func put(_ id: String, _ object: Data) throws {
        try check(id)
        lock.withLock {
            if let had = map.removeValue(forKey: id) {
                total -= had.count
                order.removeAll { $0 == id }
            }
            if object.count > maxBytes { return }
            map[id] = object
            order.append(id)
            total += object.count
            while total > maxBytes, let oldest = order.first {
                order.removeFirst()
                total -= map.removeValue(forKey: oldest)?.count ?? 0
            }
        }
    }

    public func delete(_ id: String) throws {
        try check(id)
        lock.withLock {
            if let had = map.removeValue(forKey: id) {
                total -= had.count
                order.removeAll { $0 == id }
            }
        }
    }

    public func clear() {
        lock.withLock {
            map = [:]
            order = []
            total = 0
        }
    }
}

/// `<stateDir>/cloud-sync-chunks/<hash(subject)>/<hash(collection)>`: one person's chunks never serve
/// another's and a collection name cannot climb out of the cache root.
public func chunkCacheDirectory(stateDir: URL, subject: String, collection: String) -> URL {
    func h(_ s: String) -> String { SyncCrypto.sha256(Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }
    return stateDir.appendingPathComponent(cloudSyncChunksDirName, isDirectory: true)
        .appendingPathComponent(h(subject), isDirectory: true).appendingPathComponent(h(collection), isDirectory: true)
}

/// The cache on disk: an LRU of at most `maxBytes`, one file per object named by its chunk id (0600, in a
/// 0700 directory kept out of backups).
public final class FileChunkCache: ChunkCache, @unchecked Sendable {
    public let directory: URL
    private let maxBytes: Int
    private var index: [(id: String, size: Int)]?  // oldest first; nil until scanned
    private var total = 0
    private let lock = NSLock()

    public init(directory: URL, maxBytes: Int = chunkCacheMinBytes) {
        self.directory = directory
        self.maxBytes = maxBytes
    }

    private func path(_ id: String) -> URL { directory.appendingPathComponent(id) }

    /// The directory's entries, oldest first (by modification time), scanned once.
    private func load() -> [(id: String, size: Int)] {
        if let index { return index }
        var found: [(Date, String, Int)] = []
        for name in (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [] {
            let p = directory.appendingPathComponent(name)
            if !isChunkCacheId(name) {
                // A temporary file a crash left behind, or anything else we did not write.
                if name.hasSuffix(".tmp") { try? FileManager.default.removeItem(at: p) }
                continue
            }
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: p.path),
                attrs[.type] as? FileAttributeType == .typeRegular, let size = attrs[.size] as? Int,
                size <= SYNC_CHUNK_MAX_STORED_BYTES
            else {
                try? FileManager.default.removeItem(at: p)
                continue
            }
            found.append((attrs[.modificationDate] as? Date ?? .distantPast, name, size))
        }
        found.sort { ($0.0, $0.1) < ($1.0, $1.1) }
        index = found.map { ($0.1, $0.2) }
        total = found.reduce(0) { $0 + $1.2 }
        return index!
    }

    private func drop(_ id: String) {
        var idx = load()
        if let i = idx.firstIndex(where: { $0.id == id }) {
            total -= idx[i].size
            idx.remove(at: i)
            index = idx
        }
        try? FileManager.default.removeItem(at: path(id))
    }

    public func get(_ id: String) throws -> Data? {
        try check(id)
        return lock.withLock {
            var idx = load()
            guard let i = idx.firstIndex(where: { $0.id == id }) else { return nil }
            guard let data = try? Data(contentsOf: path(id)), data.count == idx[i].size else {
                drop(id)
                return nil
            }
            let e = idx.remove(at: i)
            idx.append(e)  // newest goes last, here and on disk
            index = idx
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: path(id).path)
            return data
        }
    }

    public func put(_ id: String, _ object: Data) throws {
        try check(id)
        try lock.withLock {
            _ = load()
            drop(id)
            if object.count > maxBytes || object.count > SYNC_CHUNK_MAX_STORED_BYTES { return }
            try cloudSyncWriteAtomic(object, to: path(id))
            var idx = load()
            idx.append((id, object.count))
            total += object.count
            while total > maxBytes, let first = idx.first, first.id != id {
                idx.removeFirst()
                total -= first.size
                try? FileManager.default.removeItem(at: path(first.id))
            }
            index = idx
        }
    }

    public func delete(_ id: String) throws {
        try check(id)
        lock.withLock {
            _ = load()
            drop(id)
        }
    }

    public func clear() {
        lock.withLock {
            try? FileManager.default.removeItem(at: directory)
            index = []
            total = 0
        }
    }
}
