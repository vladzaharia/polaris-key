// The ports every pack function takes (plans/P4-01.md §2.13; client-core `packs/ports.ts`).
// Nothing in the pure half of this target does I/O: byte storage, zstd and the network are
// injected through these protocols, so the same appliers, planner and pipeline run over the
// directory store, over memory and under the corpus runner. Byte sources and sinks are
// positional, so a payload is streamed through them rather than held whole where the applier
// allows it.
//
// Swift's ports are synchronous: file reads and libzstd calls block, and only the network is
// `async`. SHA-256 is always CryptoKit's streaming `SHA256`, so there is no hasher port.

import CryptoKit
import Foundation

/// A readable run of bytes of a known length: a staged object, an installed file, a range of an
/// installed payload. `read` returns exactly `length` bytes, or fewer only at the end.
public protocol ByteSource: Sendable {
    var size: Int { get }
    func read(_ offset: Int, _ length: Int) throws -> [UInt8]
}

/// A positional writer: a container payload being rebuilt.
public protocol ByteSink: Sendable {
    func write(_ offset: Int, _ bytes: [UInt8]) throws
}

/// Where a tree payload's files go while it is staged. Paths have passed `checkPaths`.
public protocol TreeSink: Sendable {
    func writeFile(_ path: String, _ bytes: [UInt8]) throws
}

/// The zstd decoder (plans/P4-01.md §2.7 rules 1–3). `decode` takes one frame with its content
/// size; `decodeWithPrefix` one `zstd --patch-from` frame over the whole base as a raw-content
/// prefix. Either may throw: every failure is the applier's verdict, never an exception. The
/// appliers run the window check themselves before `decodeWithPrefix` (§2.7 rule 3), with
/// `pointerBits` as P: 31 for a 64-bit decoder, 30 for a 32-bit one.
public protocol ZstdPort: Sendable {
    var pointerBits: Int { get }
    func decode(_ frame: [UInt8], size: Int) throws -> [UInt8]
    func decodeWithPrefix(_ frame: [UInt8], prefix: [UInt8], size: Int, windowLogMax: Int) throws
        -> [UInt8]
    /// Whether `decodeStream` is available. When it is, `applyFull` streams the whole payload
    /// through it instead of decoding it in one buffer.
    var canStream: Bool { get }
    /// A streaming decode of one plain frame, whose output arrives in order through `onChunk`
    /// and must total `size` bytes.
    func decodeStream(_ frame: any ByteSource, size: Int, onChunk: ([UInt8]) throws -> Void) throws
}

extension ZstdPort {
    public var canStream: Bool { false }
    public func decodeStream(
        _ frame: any ByteSource, size: Int, onChunk: ([UInt8]) throws -> Void
    ) throws {
        throw PackPortError.unsupported
    }
}

/// A port that cannot do what was asked.
public enum PackPortError: Error, Sendable {
    case unsupported
    case short
}

/// A stored object by the SHA-256 of its stored bytes, or nil when the host has none. The
/// applier checks the length and the hash against the ref before it decodes a byte.
public typealias ObjectPort = (String) throws -> (any ByteSource)?

/// One installed file, reachable by its SHA-256 (a file of an installed tree, or a range of an
/// installed container payload).
public struct InstalledFile: Sendable {
    public let path: String
    public let sha256: String
    public let size: Int
    public let source: any ByteSource

    public init(path: String, sha256: String, size: Int, source: any ByteSource) {
        self.path = path
        self.sha256 = sha256
        self.size = size
        self.source = source
    }
}

// ── Helpers over the ports ─────────────────────────────────────────────────────────────────

/// The chunk size every helper reads in: 1 MiB.
public let READ_CHUNK = 1 << 20

/// A source over bytes already in memory.
public struct MemorySource: ByteSource {
    public let bytes: [UInt8]
    public init(_ bytes: [UInt8]) { self.bytes = bytes }
    public var size: Int { bytes.count }
    public func read(_ offset: Int, _ length: Int) throws -> [UInt8] {
        let lo = Swift.min(Swift.max(offset, 0), bytes.count)
        let hi = Swift.min(Swift.max(offset + Swift.max(length, 0), lo), bytes.count)
        return Array(bytes[lo..<hi])
    }
}

public func memorySource(_ bytes: [UInt8]) -> any ByteSource { MemorySource(bytes) }

/// A source over a range of another source.
public struct SliceSource: ByteSource {
    public let base: any ByteSource
    public let offset: Int
    public let size: Int
    public func read(_ at: Int, _ length: Int) throws -> [UInt8] {
        try base.read(offset + at, Swift.max(0, Swift.min(length, size - at)))
    }
}

public func sliceSource(_ source: any ByteSource, _ offset: Int, _ size: Int) -> any ByteSource {
    SliceSource(base: source, offset: offset, size: size)
}

/// Every byte of a source, in one buffer. Only for objects the caller has bounded.
public func readAll(_ source: any ByteSource) throws -> [UInt8] {
    var out: [UInt8] = []
    out.reserveCapacity(source.size)
    var at = 0
    while at < source.size {
        let chunk = try source.read(at, Swift.min(READ_CHUNK, source.size - at))
        if chunk.isEmpty { break }
        out += chunk
        at += chunk.count
    }
    return out
}

/// Lowercase hex.
public func hexString<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
    let digits: [Character] = Array("0123456789abcdef")
    var out = ""
    for b in bytes {
        out.append(digits[Int(b >> 4)])
        out.append(digits[Int(b & 15)])
    }
    return out
}

/// An incremental SHA-256 (CryptoKit).
public struct PackHasher {
    private var h = SHA256()
    public init() {}
    public mutating func update(_ bytes: [UInt8]) { h.update(data: bytes) }
    public mutating func update(_ bytes: ArraySlice<UInt8>) {
        bytes.withUnsafeBytes { h.update(bufferPointer: $0) }
    }
    public func digest() -> String { hexString(h.finalize()) }
}

/// The SHA-256 of bytes in memory.
public func sha256Of(_ bytes: [UInt8]) -> String { hexString(SHA256.hash(data: bytes)) }
public func sha256Of(_ bytes: ArraySlice<UInt8>) -> String {
    bytes.withUnsafeBytes { hexString(SHA256.hash(data: $0)) }
}

/// The SHA-256 of a whole source, read in chunks.
public func hashSource(_ source: any ByteSource) throws -> String {
    var h = PackHasher()
    var at = 0
    while at < source.size {
        let chunk = try source.read(at, Swift.min(READ_CHUNK, source.size - at))
        if chunk.isEmpty { break }
        h.update(chunk)
        at += chunk.count
    }
    return h.digest()
}
