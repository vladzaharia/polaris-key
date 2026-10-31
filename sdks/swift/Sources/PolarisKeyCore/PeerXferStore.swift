// WIRE-CONTRACT-V5 §15.11 "Resume" and "The name is display data": the receiver's partial files.
//
// A directory the SDK owns, owner-only. A partial is a file named by `xferPartialPath` (64 hex characters,
// derived from the peer key, the transfer id and the hash) and a sidecar `<path>.json` that holds what the
// path cannot: the peer, the id, the hash, the size and the chunk. The offer's `name` never reaches a path.
// The last write time is the file's own modification time.
//
// Delivery is the host's: a partial that verified is linked (or copied through a temporary file in the
// destination's directory) to a path the host chose, and never over an existing file.

import CryptoKit
import Foundation

public struct XferStoreError: Error, Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case io, exists, badPath, quota, purged }
    public let kind: Kind
    public init(_ kind: Kind) { self.kind = kind }
}

public final class XferStore: @unchecked Sendable {
    /// The most bytes of a kept partial that a resume re-reads and hashes before it answers `ACCEPT`; the
    /// sender re-sends the rest (§15.11 allows a lower offset).
    public static let rehashCapBytes = 256 * 1024 * 1024

    private struct Meta: Codable {
        var peer: String
        var id: String
        var sha256: String
        var size: Int
        var chunk: Int
    }

    /// What the store may hold in all (kept and live partial files together), by default.
    public static let defaultQuotaBytes = 16 * 1024 * 1024 * 1024
    /// What the volume keeps free beyond the store, by default.
    public static let defaultDiskReserveBytes = 256 * 1024 * 1024

    private let dir: URL
    private let lock = NSLock()
    private var handles: [String: FileHandle] = [:]
    /// Refs a live transfer holds, in any session of this process, with the size it declared and the bytes it has
    /// written. The bytes still to come are reserved: they are taken off what a new offer may ask for.
    private var live: [String: (declared: Int, written: Int)] = [:]
    private var generation = 0
    private let freeBytes: @Sendable () -> Int?
    private let quota: Int?
    private let diskReserve: Int
    private let fm = FileManager.default

    /// `directory` is created owner-only on first use. `free` answers the bytes the volume can still take (nil for
    /// unknown); `quota` caps the bytes the store holds and `diskReserve` is kept free on the volume.
    public init(
        directory: URL, free: (@Sendable () -> Int?)? = nil, quota: Int? = XferStore.defaultQuotaBytes,
        diskReserve: Int = XferStore.defaultDiskReserveBytes
    ) {
        dir = directory
        freeBytes = free ?? { XferStore.volumeFree(directory) }
        self.quota = quota
        self.diskReserve = diskReserve
    }

    /// Changes whenever the store is purged. An effect that was queued before the purge carries the old value and
    /// is refused, so a late write never recreates what was deleted.
    public var epoch: Int { lock.withLock { generation } }

    private func check(_ epoch: Int?) throws {
        if let epoch, epoch != generation { throw XferStoreError(.purged) }
    }

    private static func volumeFree(_ dir: URL) -> Int? {
        var probe = dir
        while !FileManager.default.fileExists(atPath: probe.path), probe.pathComponents.count > 1 {
            probe.deleteLastPathComponent()
        }
        let v = try? probe.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return v?.volumeAvailableCapacityForImportantUsage.map { Int($0) }
    }

    /// The bytes a new offer may ask for now: the volume's free space less the disk reserve, and the quota less what
    /// the store holds, each less the bytes live transfers have reserved and not yet written. nil when neither is
    /// known.
    public var free: Int? {
        lock.lock()
        defer { lock.unlock() }
        let reserved = live.values.reduce(0) { $0 + max(0, $1.declared - $1.written) }
        var best: Int?
        if let v = freeBytes() { best = max(0, v - diskReserve - reserved) }
        if let q = quota {
            let room = max(0, q - onDiskLocked() - reserved)
            best = min(best ?? room, room)
        }
        return best
    }

    private func onDiskLocked() -> Int {
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return 0 }
        var n = 0
        for name in names where !name.hasSuffix(".json") {
            if let a = try? fm.attributesOfItem(atPath: dir.appendingPathComponent(name).path),
                let sz = (a[.size] as? NSNumber)?.intValue
            {
                n += sz
            }
        }
        return n
    }

    private func ensureDir() throws {
        if fm.fileExists(atPath: dir.path) { return }
        try fm.createDirectory(
            at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    // Only a derived name reaches a path: 64 lowercase hex characters.
    private func file(_ ref: String) throws -> URL {
        let u = Array(ref.utf8)
        guard u.count == 64 || ref.hasPrefix("n"), !ref.isEmpty,
            u.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x7a) })
        else { throw XferStoreError(.badPath) }
        return dir.appendingPathComponent(ref, isDirectory: false)
    }

    private func sidecar(_ ref: String) throws -> URL {
        try file(ref).appendingPathExtension("json")
    }

    private func peerHex(_ key: Data) -> String { key.map { String(format: "%02x", $0) }.joined() }

    // MARK: Reads

    /// The kept partials of `key`, as the machine wants them: ages become offsets from `mono`. Expired ones are
    /// removed. `reread` is what a resume may re-read.
    public func partials(key: Data, mono: Double, wall: Date = Date()) -> [XferPartial] {
        lock.lock()
        defer { lock.unlock() }
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
        var out: [XferPartial] = []
        for n in names where n.hasSuffix(".json") {
            let ref = String(n.dropLast(5))
            guard let meta = readMeta(ref), meta.peer == peerHex(key), let f = try? file(ref) else { continue }
            guard let attrs = try? fm.attributesOfItem(atPath: f.path),
                let mtime = attrs[.modificationDate] as? Date, let size = (attrs[.size] as? NSNumber)?.intValue
            else {
                removeLocked(ref)
                continue
            }
            let age = max(0, wall.timeIntervalSince(mtime))
            if age > xferPartialSeconds {
                removeLocked(ref)
                continue
            }
            let bytes = min(size, meta.size)
            out.append(
                XferPartial(
                    ref: ref, id: meta.id, sha256: meta.sha256, size: meta.size, chunk: meta.chunk, bytes: bytes,
                    writtenAt: mono - age, held: live[ref] != nil,
                    reread: min(bytes, XferStore.rehashCapBytes)))
        }
        return out
    }

    private func readMeta(_ ref: String) -> Meta? {
        guard let u = try? sidecar(ref), let d = try? Data(contentsOf: u) else { return nil }
        return try? JSONDecoder().decode(Meta.self, from: d)
    }

    /// A hasher fed with the first `offset` bytes of a partial. The bytes are read from the file.
    /// nil when the file is gone or holds fewer bytes than it was said to: the resume then starts at 0.
    public func rehash(ref: String, offset: Int) -> SHA256? {
        var h = SHA256()
        guard offset > 0 else { return h }
        guard let u = try? file(ref), let fh = try? FileHandle(forReadingFrom: u) else { return nil }
        defer { try? fh.close() }
        var left = offset
        while left > 0 {
            guard let d = try? fh.read(upToCount: min(left, 1 << 20)), !d.isEmpty else { return nil }
            h.update(data: d)
            left -= d.count
        }
        return h
    }

    // MARK: Effects

    /// A live transfer takes `ref`: `declared` bytes are reserved, `written` of them are on disk. Called as soon as
    /// the machine accepts, before the file work is done, so an offer that arrives next sees the reservation.
    public func reserve(_ ref: String, declared: Int, written: Int) {
        lock.lock()
        defer { lock.unlock() }
        live[ref] = (declared, written)
    }

    /// The transfer ended (delivered, cancelled, closed): the reservation and the hold are released.
    public func release(_ ref: String) {
        lock.lock()
        defer { lock.unlock() }
        live[ref] = nil
    }

    /// True while a live transfer holds `ref`.
    public func isHeld(_ ref: String) -> Bool { lock.withLock { live[ref] != nil } }

    public func create(_ meta: XferPartial, peer key: Data, epoch: Int? = nil) throws {
        lock.lock()
        defer { lock.unlock() }
        try check(epoch)
        try ensureDir()
        try createLocked(meta, key)
    }

    private func createLocked(_ meta: XferPartial, _ key: Data) throws {
        let f = try file(meta.ref)
        let held = live[meta.ref]
        removeLocked(meta.ref)
        live[meta.ref] = held
        let fd = open(f.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw XferStoreError(.io) }
        handles[meta.ref] = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        let m = Meta(peer: peerHex(key), id: meta.id, sha256: meta.sha256, size: meta.size, chunk: meta.chunk)
        let side = try sidecar(meta.ref)
        let sfd = open(side.path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600)
        guard sfd >= 0 else { throw XferStoreError(.io) }
        let h = FileHandle(fileDescriptor: sfd, closeOnDealloc: true)
        try h.write(contentsOf: JSONEncoder().encode(m))
        try h.close()
    }

    private func handle(_ ref: String) throws -> FileHandle {
        if let h = handles[ref] { return h }
        let f = try file(ref)
        let fd = open(f.path, O_RDWR | O_NOFOLLOW)
        guard fd >= 0 else { throw XferStoreError(.io) }
        let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        handles[ref] = h
        return h
    }

    /// Cut a partial to `offset`. A partial that is gone (another session finished or removed it) is made again,
    /// empty, from `meta`: the resume starts over.
    public func truncate(
        _ ref: String, to offset: Int, meta: XferPartial? = nil, peer key: Data? = nil, epoch: Int? = nil
    )
        throws
    {
        lock.lock()
        defer { lock.unlock() }
        try check(epoch)
        if let h = try? handle(ref) {
            try h.truncate(atOffset: UInt64(offset))
            return
        }
        guard let meta, let key else { throw XferStoreError(.io) }
        try ensureDir()
        try createLocked(meta, key)
    }

    public func write(_ ref: String, offset: Int, data: Data, epoch: Int? = nil) throws {
        lock.lock()
        defer { lock.unlock() }
        try check(epoch)
        if let l = live[ref] {
            // Never past the size the transfer declared: that is the space reserved for it.
            guard offset + data.count <= l.declared else { throw XferStoreError(.quota) }
        } else if let q = quota, onDiskLocked() + data.count > q {
            throw XferStoreError(.quota)
        }
        let h = try handle(ref)
        try h.seek(toOffset: UInt64(offset))
        try h.write(contentsOf: data)
        if let l = live[ref] { live[ref] = (l.declared, max(l.written, offset + data.count)) }
    }

    /// Release the open handle of a kept partial.
    public func keep(_ ref: String) {
        lock.lock()
        defer { lock.unlock() }
        try? handles.removeValue(forKey: ref)?.close()
    }

    public func remove(_ ref: String) {
        lock.lock()
        defer { lock.unlock() }
        removeLocked(ref)
    }

    private func removeLocked(_ ref: String) {
        try? handles.removeValue(forKey: ref)?.close()
        live[ref] = nil
        if let f = try? file(ref) { try? fm.removeItem(at: f) }
        if let s = try? sidecar(ref) { try? fm.removeItem(at: s) }
    }

    /// Deliver a verified partial to `destination`, which must not exist. A hard link when the destination is on
    /// the same volume, else a copy through a temporary file beside it, then a link: never an overwrite, and the
    /// destination never holds a part of the content.
    public func deliver(_ ref: String, to destination: URL, epoch: Int? = nil) throws {
        lock.lock()
        defer { lock.unlock() }
        try check(epoch)
        try? handles.removeValue(forKey: ref)?.close()
        let src = try file(ref)
        if link(src.path, destination.path) == 0 {
            removeLocked(ref)
            return
        }
        if errno == EEXIST { throw XferStoreError(.exists) }
        guard errno == EXDEV || errno == EPERM || errno == ENOTSUP else { throw XferStoreError(.io) }
        let tmp = destination.deletingLastPathComponent().appendingPathComponent(
            ".pkey-" + UUID().uuidString.lowercased())
        do {
            try fm.copyItem(at: src, to: tmp)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
            guard link(tmp.path, destination.path) == 0 else {
                let e = errno
                try? fm.removeItem(at: tmp)
                throw XferStoreError(e == EEXIST ? .exists : .io)
            }
            try? fm.removeItem(at: tmp)
        } catch let e as XferStoreError {
            throw e
        } catch {
            try? fm.removeItem(at: tmp)
            throw XferStoreError(.io)
        }
        removeLocked(ref)
    }

    /// Create an empty file at `destination` (a transfer of size 0), never over an existing one.
    public func deliverEmpty(to destination: URL) throws {
        let fd = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw XferStoreError(errno == EEXIST ? .exists : .io) }
        close(fd)
    }

    /// A new owner-only file in the store's directory for a stream that is spooled before it is offered.
    public func newSpool() throws -> URL {
        lock.lock()
        defer { lock.unlock() }
        try ensureDir()
        let u = dir.appendingPathComponent("spool-" + UUID().uuidString.lowercased(), isDirectory: false)
        let fd = open(u.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw XferStoreError(.io) }
        close(fd)
        return u
    }

    // MARK: Purge

    /// Delete every partial of `key` (a contact removed).
    public func purge(key: Data) {
        lock.lock()
        defer { lock.unlock() }
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
        for n in names where n.hasSuffix(".json") {
            let ref = String(n.dropLast(5))
            if readMeta(ref)?.peer == peerHex(key) { removeLocked(ref) }
        }
    }

    /// Delete everything the store holds (sign-out or forget).
    public func purgeAll() {
        lock.lock()
        defer { lock.unlock() }
        for (_, h) in handles { try? h.close() }
        handles = [:]
        live = [:]
        generation += 1
        try? fm.removeItem(at: dir)
    }
}
