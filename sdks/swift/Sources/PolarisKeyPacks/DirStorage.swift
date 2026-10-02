// The directory pack store (CONTENT §9–§10; the Swift port of `@polaris-key/node`'s
// `DirPackStorage`): staging, the content-addressed store and the install-state file under one
// directory, by default `<data dir>/packs` (P1b-09's platform data directory, excluded from
// backups).
//
//   <root>/state.json                         the install state, written by temp + rename
//   <root>/state.json.torn                    a torn document held aside (never overwritten)
//   <root>/state.json.torn.list               the torn hold's snapshot of the store
//   <root>/staging/<planId>/objects/<sha256>  objects being fetched (appended, resumable)
//   <root>/staging/<planId>/out/              the payload being built (a tree's files, or
//                                             `payload.bin` for a container)
//   <root>/store/<packId>/<payloadSha256>/    a committed payload, never overwritten: a tree's
//                                             files, or `payload.bin`; `.pkey/files.json` beside
//                                             them holds the files index kept at install
//
// Every read distinguishes "missing" from "cannot read": only ENOENT and ENOTDIR are missing,
// anything else throws (`verify`, `installed`, `quarantined`, `commit` and the state read rely on
// it). A directory listing either answers whole or throws. Files and directories are synced with
// `F_FULLFSYNC` where the file system supports it (falling back to `fsync(2)`), so a rename that
// names a payload or a state document survives a power loss on Apple hardware.

import Foundation
import PolarisKeyCore

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// A POSIX failure on a pack path.
public struct PackFileError: Error, Sendable, CustomStringConvertible, Equatable {
    public let errno: Int32
    public let path: String
    public var description: String { "\(String(cString: strerror(errno))) (\(errno)): \(path)" }

    public var isMissing: Bool { errno == ENOENT || errno == ENOTDIR }
}

private func fail(_ path: String) -> PackFileError { PackFileError(errno: errno, path: path) }

/// `stat` of `path`, or nil ONLY when it does not exist (ENOENT, ENOTDIR). Anything else throws.
func statOrNil(_ path: String) throws -> stat? {
    var st = stat()
    if stat(path, &st) == 0 { return st }
    let e = fail(path)
    if e.isMissing { return nil }
    throw e
}

func pathExists(_ path: String) throws -> Bool { try statOrNil(path) != nil }

private func isDir(_ st: stat) -> Bool { (st.st_mode & S_IFMT) == S_IFDIR }
private func isReg(_ st: stat) -> Bool { (st.st_mode & S_IFMT) == S_IFREG }

/// One directory entry, typed without following symlinks.
struct DirEntry {
    let name: String
    let isDirectory: Bool
    let isFile: Bool
}

/// A directory's entries, or nil ONLY when it does not exist. An unreadable directory, or a
/// read that fails part-way, throws: never a partial listing.
func listDirectory(_ path: String) throws -> [DirEntry]? {
    guard let dir = opendir(path) else {
        let e = fail(path)
        if e.isMissing { return nil }
        throw e
    }
    defer { closedir(dir) }
    var out: [DirEntry] = []
    while true {
        errno = 0
        guard let ent = readdir(dir) else {
            if errno != 0 { throw fail(path) }
            break
        }
        let name = withUnsafePointer(to: ent.pointee.d_name) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(NAME_MAX) + 1) { String(cString: $0) }
        }
        if name == "." || name == ".." { continue }
        var st = stat()
        let full = path + "/" + name
        guard lstat(full, &st) == 0 else { throw fail(full) }
        out.append(DirEntry(name: name, isDirectory: isDir(st), isFile: isReg(st)))
    }
    return out
}

/// fsync one descriptor: `F_FULLFSYNC` (through the drive's write cache) where supported, else
/// `fsync(2)`.
private func syncFD(_ fd: Int32, _ path: String) throws {
    #if canImport(Darwin)
    if fcntl(fd, F_FULLFSYNC) == 0 { return }
    #endif
    if fsync(fd) != 0 {
        let e = fail(path)
        // A file system that cannot sync a directory at all says so with one of these.
        if e.errno == EINVAL || e.errno == ENOTSUP || e.errno == EBADF { return }
        throw e
    }
}

/// fsync a file or directory by path.
func syncPath(_ path: String) throws {
    let fd = open(path, O_RDONLY)
    guard fd >= 0 else { throw fail(path) }
    defer { close(fd) }
    try syncFD(fd, path)
}

/// fsync every file under `dir`, then each directory, depth first.
private func syncTree(_ dir: String) throws {
    for e in try listDirectory(dir) ?? [] {
        let p = dir + "/" + e.name
        if e.isDirectory { try syncTree(p) } else if e.isFile { try syncPath(p) }
    }
    try syncPath(dir)
}

/// Write `bytes` to a new file at `path` (mode 0600), synced. `exclusive` refuses an existing one.
private func writeFileSynced(_ path: String, _ bytes: [UInt8], exclusive: Bool = false) throws {
    let flags = O_WRONLY | O_CREAT | (exclusive ? O_EXCL : O_TRUNC)
    let fd = open(path, flags, 0o600)
    guard fd >= 0 else { throw fail(path) }
    defer { close(fd) }
    try writeAll(fd, bytes, path)
    try syncFD(fd, path)
}

private func writeAll(_ fd: Int32, _ bytes: [UInt8], _ path: String) throws {
    var off = 0
    while off < bytes.count {
        let n = bytes[off...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        if n < 0 {
            if errno == EINTR { continue }
            throw fail(path)
        }
        off += n
    }
}

/// The whole of a file, or nil ONLY when it does not exist.
func readFileOrNil(_ path: String) throws -> [UInt8]? {
    let fd = open(path, O_RDONLY)
    if fd < 0 {
        let e = fail(path)
        if e.isMissing { return nil }
        throw e
    }
    defer { close(fd) }
    var out: [UInt8] = []
    var buf = [UInt8](repeating: 0, count: 1 << 16)
    while true {
        let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        if n < 0 {
            if errno == EINTR { continue }
            throw fail(path)
        }
        if n == 0 { break }
        out += buf[0..<n]
    }
    return out
}

private func mkdirs(_ path: String) throws {
    try FileManager.default.createDirectory(
        atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
}

/// `rm -rf`: a missing path is fine; anything else that fails throws.
private func removeTree(_ path: String) throws {
    var st = stat()
    if lstat(path, &st) != 0 {
        let e = fail(path)
        if e.isMissing { return }
        throw e
    }
    do {
        try FileManager.default.removeItem(atPath: path)
    } catch let e as NSError where e.domain == NSCocoaErrorDomain && e.code == NSFileNoSuchFileError {
        return
    }
}

private func renamePath(_ from: String, _ to: String) throws {
    if rename(from, to) != 0 { throw fail(from) }
}

/// A file on disk as a `ByteSource` (opened per read, so nothing stays open between reads).
public struct FileSource: ByteSource {
    public let path: String
    public let size: Int

    public init(path: String, size: Int) {
        self.path = path
        self.size = size
    }

    public func read(_ offset: Int, _ length: Int) throws -> [UInt8] {
        let n = Swift.max(0, Swift.min(length, size - offset))
        if n == 0 { return [] }
        let fd = open(path, O_RDONLY)
        guard fd >= 0 else { throw fail(path) }
        defer { close(fd) }
        var buf = [UInt8](repeating: 0, count: n)
        var got = 0
        while got < n {
            let r = buf.withUnsafeMutableBytes { pread(fd, $0.baseAddress! + got, n - got, off_t(offset + got)) }
            if r < 0 {
                if errno == EINTR { continue }
                throw fail(path)
            }
            if r == 0 { break }
            got += r
        }
        return got == n ? buf : Array(buf[0..<got])
    }
}

/// A file's SHA-256 and size, read in chunks.
public func measureFile(_ path: String) throws -> (sha256: String, size: Int) {
    guard let st = try statOrNil(path) else { throw PackFileError(errno: ENOENT, path: path) }
    let src = FileSource(path: path, size: Int(st.st_size))
    return (try hashSource(src), src.size)
}

/// Every regular file under `dir`, as `/`-separated paths relative to it, skipping `.pkey/`.
/// Symlinks and other entries are never part of a tree payload.
public func walkTree(_ dir: String) throws -> [String] {
    var out: [String] = []
    func walk(_ at: String, _ rel: String) throws {
        guard let entries = try listDirectory(at) else { throw PackFileError(errno: ENOENT, path: at) }
        for e in entries {
            let r = rel.isEmpty ? e.name : rel + "/" + e.name
            if r == ".pkey" { continue }
            if e.isDirectory { try walk(at + "/" + e.name, r) } else if e.isFile { out.append(r) }
        }
    }
    try walk(dir, "")
    return out
}

/// A directory's files with their sizes and SHA-256 (the embedded and reload checks).
public func measureTree(_ dir: String) throws -> [TreeFile] {
    try walkTree(dir).map { p in
        let m = try measureFile(dir + "/" + p)
        return TreeFile(path: p, size: m.size, sha256: m.sha256)
    }
}

/// `treeDigest` of a directory, minus `.pkey/` (plans/P4-01.md §2.6).
public func directoryTreeDigest(_ dir: String) throws -> String { treeDigest(try measureTree(dir)) }

private let CONTAINER_FILE = "payload.bin"
private let INDEX_FILE = ".pkey/files.json"

private struct DirStaged: StagedObject {
    let path: String
    func size() throws -> Int { Int(try statOrNil(path)?.st_size ?? 0) }
    func source() throws -> any ByteSource { FileSource(path: path, size: try size()) }
    func append(_ bytes: [UInt8]) throws {
        try mkdirs((path as NSString).deletingLastPathComponent)
        let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        guard fd >= 0 else { throw fail(path) }
        defer { close(fd) }
        try writeAll(fd, bytes, path)
    }
    func reset() throws { try removeTree(path) }
}

private struct DirSink: ByteSink {
    let path: String
    func write(_ offset: Int, _ bytes: [UInt8]) throws {
        let fd = open(path, O_WRONLY)
        guard fd >= 0 else { throw fail(path) }
        defer { close(fd) }
        var off = 0
        while off < bytes.count {
            let n = bytes[off...].withUnsafeBytes { pwrite(fd, $0.baseAddress, $0.count, off_t(offset + off)) }
            if n < 0 {
                if errno == EINTR { continue }
                throw fail(path)
            }
            off += n
        }
    }
}

private struct DirTree: TreeSink {
    let root: String
    func writeFile(_ path: String, _ bytes: [UInt8]) throws {
        let abs = try DirPackStorage.inside(root, path)
        try mkdirs((abs as NSString).deletingLastPathComponent)
        let fd = open(abs, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        guard fd >= 0 else { throw fail(abs) }
        defer { close(fd) }
        try writeAll(fd, bytes, abs)
    }
}

/// The atomic-replace state file, with a torn document's quarantine at `state.json.torn` and the
/// hold's snapshot at `state.json.torn.list`.
public struct DirPackStateStore: PackStateStore {
    public let root: String
    var path: String { root + "/state.json" }
    var torn: String { path + ".torn" }
    var holdList: String { path + ".torn.list" }

    public init(root: String) { self.root = root }

    public func read() throws -> String? {
        // Only a missing file is "no state"; anything else is unknown, never empty.
        guard let bytes = try readFileOrNil(path) else { return nil }
        return String(decoding: bytes, as: UTF8.self)
    }

    public func replace(_ text: String) throws {
        try mkdirs(root)
        let tmp = "\(path).\(getpid()).tmp"
        // Durable before the rename, so a power loss never leaves a torn state file.
        try writeFileSynced(tmp, Array(text.utf8))
        try renamePath(tmp, path)
        try syncPath(root)
    }

    public func quarantine(_ text: String) throws {
        if try pathExists(torn) { return }
        try writeFileSynced(torn, Array(text.utf8), exclusive: true)
        try syncPath(root)
    }

    public func quarantined() throws -> Bool { try pathExists(torn) }

    public func clearQuarantine() throws {
        try removeTree(holdList)
        try removeTree(torn)
    }

    public var keepsHoldList: Bool { true }

    public func readHoldList() throws -> String? {
        guard let bytes = try readFileOrNil(holdList) else { return nil }
        return String(decoding: bytes, as: UTF8.self)
    }

    public func writeHoldList(_ text: String) throws {
        if try pathExists(holdList) { return }
        let tmp = "\(holdList).\(getpid()).tmp"
        try writeFileSynced(tmp, Array(text.utf8))
        try renamePath(tmp, holdList)
        try syncPath(root)
    }
}

/// The `PackStorage` over a directory.
public final class DirPackStorage: PackStorage, @unchecked Sendable {
    public let root: String
    public let stagingDir: String
    public let storeDir: String
    /// Measured trees of embedded locations (measured once per process).
    private let embeddedFiles = Locked([String: [InstalledFile]]())

    public init(root: URL) {
        let r = root.standardizedFileURL.path
        self.root = r
        self.stagingDir = r + "/staging"
        self.storeDir = r + "/store"
    }

    /// The state store beside the payloads.
    public func stateStore() -> DirPackStateStore { DirPackStateStore(root: root) }

    /// `parts` joined under `base`, refusing anything that would land outside it.
    static func inside(_ base: String, _ parts: String...) throws -> String {
        var p = base
        for part in parts {
            for seg in part.split(separator: "/", omittingEmptySubsequences: true) {
                if seg == "." || seg == ".." { throw PackFileError(errno: EINVAL, path: part) }
                p += "/" + seg
            }
        }
        return p
    }

    public func stagedObject(_ planId: String, _ sha256: String) throws -> any StagedObject {
        DirStaged(path: try Self.inside(stagingDir, planId, "objects", sha256))
    }

    public func output(_ planId: String, _ layout: String) throws -> PackOutput {
        let out = try Self.inside(stagingDir, planId, "out")
        try removeTree(out)
        try mkdirs(out)
        if layout == "tree" { return PackOutput(tree: DirTree(root: out)) }
        let file = out + "/" + CONTAINER_FILE
        try writeFileSynced(file, [])
        return PackOutput(sink: DirSink(path: file))
    }

    public func commit(
        _ planId: String, _ packId: String, _ payloadSha256: String, _ layout: String,
        _ index: FilesIndexDoc?
    ) throws -> String {
        let out = try Self.inside(stagingDir, planId, "out")
        let location = try Self.inside(storeDir, packId, payloadSha256)
        if let index {
            try mkdirs(out + "/.pkey")
            try writeFileSynced(out + "/" + INDEX_FILE, Array(canonicalJSON(index.json).utf8))
        }
        if try pathExists(location) {
            // The same payload is already stored (a rollback target, say): keep the stored copy.
            try removeTree(out)
            return location
        }
        // The payload is durable before the pointer can name it.
        try syncTree(out)
        let parent = (location as NSString).deletingLastPathComponent
        try mkdirs(parent)
        try renamePath(out, location)
        try syncPath(parent)
        return location
    }

    /// A container install's payload file: `payload.bin` in the store, or the embedded file itself.
    private func payloadFile(_ install: PackInstall) -> String {
        install.embedded == true ? install.location : install.location + "/" + CONTAINER_FILE
    }

    public func installed(_ install: PackInstall) throws -> InstalledPayload? {
        let loc = install.location
        guard try pathExists(loc) else { return nil }
        if install.layout == "tree" {
            guard let files = try treeFiles(loc, embedded: install.embedded == true) else { return nil }
            return InstalledPayload(payload: nil, files: files)
        }
        let file = payloadFile(install)
        guard let st = try statOrNil(file) else { return nil }
        let whole = FileSource(path: file, size: Int(st.st_size))
        let index = install.embedded == true ? nil : try readIndex(loc)
        return InstalledPayload(
            payload: whole,
            files: index?.files.map {
                InstalledFile(path: $0.path, sha256: $0.sha256, size: $0.size, source: sliceSource(whole, $0.offset ?? 0, $0.size))
            })
    }

    /// The index kept at install: nil when missing or not an index; unreadable throws.
    private func readIndex(_ location: String) throws -> FilesIndexDoc? {
        guard let bytes = try readFileOrNil(location + "/" + INDEX_FILE),
            let v = try? JSONDecoder().decode(JSONValue.self, from: Data(bytes))
        else { return nil }
        return FilesIndexDoc(json: v)
    }

    /// A tree's files: from the index kept at install, else (an embedded tree) measured once.
    private func treeFiles(_ location: String, embedded: Bool) throws -> [InstalledFile]? {
        let index = embedded ? nil : try readIndex(location)
        let entries: [TreeFile]
        if let index {
            entries = index.files.map { TreeFile(path: $0.path, size: $0.size, sha256: $0.sha256) }
        } else {
            if let cached = embeddedFiles.with({ $0[location] }) { return cached }
            entries = try measureTree(location)
        }
        let files = entries.map {
            InstalledFile(path: $0.path, sha256: $0.sha256, size: $0.size, source: FileSource(path: location + "/" + $0.path, size: $0.size))
        }
        if index == nil { embeddedFiles.with { $0[location] = files } }
        return files
    }

    /// False when the payload is missing or its digest differs; throws when it cannot be read
    /// (the engine then neither uses nor collects it this load).
    public func verify(_ install: PackInstall) throws -> Bool {
        if install.layout == "tree" {
            guard try pathExists(install.location) else { return false }
            return try directoryTreeDigest(install.location) == install.payloadSha256
        }
        let file = payloadFile(install)
        guard try pathExists(file) else { return false }
        let m = try measureFile(file)
        return m.sha256 == install.payloadSha256 && m.size == install.payloadSize
    }

    public func remove(_ location: String) throws {
        // Only ever inside the store: an embedded payload lives in the app's resources.
        let abs = URL(fileURLWithPath: location).standardizedFileURL.path
        guard abs.hasPrefix(storeDir + "/") else { return }
        try removeTree(abs)
    }

    public func removeStaging(_ planId: String) throws {
        try removeTree(try Self.inside(stagingDir, planId))
    }

    public func list() throws -> (locations: [String], plans: [String]) {
        var locations: [String] = []
        var plans: [String] = []
        // Only a missing directory is "nothing there"; an unreadable one throws, so the engine
        // never plans garbage collection from a partial listing.
        for pack in try listDirectory(storeDir) ?? [] where pack.isDirectory {
            for v in try listDirectory(storeDir + "/" + pack.name) ?? [] where v.isDirectory {
                locations.append(storeDir + "/" + pack.name + "/" + v.name)
            }
        }
        for p in try listDirectory(stagingDir) ?? [] where p.isDirectory { plans.append(p.name) }
        return (locations, plans)
    }

    public func freeDisk() throws -> Int {
        try mkdirs(root)
        var s = statfs()
        guard statfs(root, &s) == 0 else { throw fail(root) }
        return Int(s.f_bavail) * Int(s.f_bsize)
    }
}
