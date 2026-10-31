// What the transfer engine needs to know about how a collection stores its files (U-23.S4): the chunk
// ids, the chunk objects and the stored form of a manifest or a whole file. A port of Python
// `cloud_sync/transfer_codec.py`. The engine moves stored bytes and checks hashes; a `FileCodec` is the one
// place that knows whether those bytes are sealed.
//
//   E2eFileCodec     ids are HMAC-SHA256 under K_cid(c); chunks are `pkey-sync-chunk/1` objects (§13.8.3);
//                    a manifest and a whole file are `pkey-sync-file/1` streams
//   ServerFileCodec  ids are the plain SHA-256; a chunk object is `0x00 | codec | body` (D-5); a manifest
//                    and a file are stored as they are
//
// Writers emit codec 0 (raw) chunks only (D-4); readers decode codecs 0 and 1. A zstd body declares its
// content size, which is checked before any decode, and is decoded by libzstd (`zstdDecodeChunk`).

import Foundation
import PolarisKeyCore
import libzstd

/// The version byte of a server-mode chunk object.
public let serverChunkObjectVersion: UInt8 = 0x00

/// libzstd for one chunk frame whose content size the caller already bounded (at most 1 MiB): the
/// output is exactly `size` bytes or it throws. The window is capped at 2 MiB.
public func zstdDecodeChunk(_ frame: Data, _ size: Int) throws -> Data {
    struct Failed: Error {}
    guard size >= 0, size <= SYNC_CDC_MAX_BYTES, let dctx = ZSTD_createDCtx() else { throw Failed() }
    defer { ZSTD_freeDCtx(dctx) }
    if ZSTD_isError(ZSTD_DCtx_setParameter(dctx, ZSTD_d_windowLogMax, 21)) != 0 { throw Failed() }
    var out = [UInt8](repeating: 0, count: max(size, 1))
    let n: Int = frame.withUnsafeBytes { src in
        out.withUnsafeMutableBytes { dst in
            ZSTD_decompressDCtx(dctx, dst.baseAddress, size, src.baseAddress, src.count)
        }
    }
    guard ZSTD_isError(n) == 0, n == size else { throw Failed() }
    return Data(out.prefix(size))
}

/// The answer of an opener: the plaintext, or the format's reason.
public enum FileOpened: Sendable, Equatable {
    case ok(Data)
    case invalid(String)
}

/// Opens one stored whole file as its bytes arrive: `push` returns the plaintext of each segment whose tag
/// has verified, `finish` the last. A piece is provisional until `finish` returns. Throws
/// `SyncFileStream.Failure`.
public protocol FileOpener: AnyObject, Sendable {
    func push(_ data: Data) throws -> [Data]
    func finish() throws -> Data
}

public protocol FileCodec: Sendable {
    /// What `begin` calls it: "e2e" or "none".
    var enc: String { get }
    /// The 32 raw bytes of a plaintext chunk's id.
    func chunkId(_ plain: Data) throws -> Data
    /// The size of the raw (codec 0) object for a chunk of `plainLen` bytes.
    func chunkObjectBytes(_ plainLen: Int) -> Int
    func sealChunk(id: Data, plain: Data) throws -> Data
    /// Opens a stored object for `id`: every check of the format, the id of the plaintext last.
    func openChunk(id: Data, object: Data) throws -> FileOpened
    /// The stored form of a file of `plainSize` bytes, as `begin` declares it.
    func storedSize(_ plainSize: Int) -> Int
    /// The plaintext size a stored size implies, or nil when none does.
    func plainSize(_ storedSize: Int) -> Int?
    func sealManifest(_ plain: Data) throws -> Data
    func openManifest(_ stored: Data) throws -> FileOpened
    /// The stored form of a whole file (a fresh salt every call).
    func sealWhole(_ plain: Data) throws -> Data
    func makeOpener() throws -> any FileOpener
}

private final class SyncOpener: FileOpener, @unchecked Sendable {
    private var inner: SyncFileStream.Opener
    private let lock = NSLock()
    init(collKey: Data, kid: Data) { inner = SyncFileStream.Opener(collKey: collKey, kid: kid) }
    func push(_ data: Data) throws -> [Data] { try lock.withLock { try inner.push(data) } }
    func finish() throws -> Data { try lock.withLock { try inner.finish() } }
}

private final class PassThrough: FileOpener, @unchecked Sendable {
    func push(_ data: Data) throws -> [Data] { [data] }
    func finish() throws -> Data { Data() }
}

/// The codec of a collection of an end-to-end product. `root` is the ring root; it is held, never printed.
public struct E2eFileCodec: FileCodec, CustomStringConvertible, CustomReflectable {
    private let root: Data
    private let collection: String
    private let collKey: Data
    private let kid: Data

    public init(root: Data, collection: String) {
        self.root = root
        self.collection = collection
        collKey = SyncCrypto.deriveCollKey(root: root, collection: collection)
        kid = SyncCrypto.deriveKid(root: root)
    }

    public var description: String { "E2eFileCodec(collection: \(collection))" }
    public var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
    public var enc: String { "e2e" }

    public func chunkId(_ plain: Data) throws -> Data {
        SyncChunks.chunkId(root: root, collection: collection, plain: plain)
    }
    public func chunkObjectBytes(_ plainLen: Int) -> Int { plainLen + 30 }

    public func sealChunk(id: Data, plain: Data) throws -> Data {
        try SyncChunks.seal(root: root, collection: collection, id: id, codec: SyncChunks.codecRaw, body: plain)
    }

    public func openChunk(id: Data, object: Data) throws -> FileOpened {
        switch SyncChunks.open(root: root, collection: collection, id: id, object: object, decode: zstdDecodeChunk) {
        case .ok(let plain, _): return .ok(plain)
        case .invalid(let r): return .invalid(r.rawValue)
        }
    }

    public func storedSize(_ plainSize: Int) -> Int { SyncFileStream.sealedSize(plainSize: plainSize) ?? -1 }
    public func plainSize(_ storedSize: Int) -> Int? { SyncFileStream.plainSize(sealedSize: storedSize) }
    public func sealManifest(_ plain: Data) throws -> Data { try sealWhole(plain) }
    public func sealWhole(_ plain: Data) throws -> Data {
        try SyncFileStream.sealFile(collKey: collKey, kid: kid, plain: plain)
    }

    public func openManifest(_ stored: Data) throws -> FileOpened {
        switch SyncFileStream.openFile(collKey: collKey, kid: kid, sealed: stored) {
        case .ok(let plain): return .ok(plain)
        case .invalid(let r): return .invalid(r.rawValue)
        }
    }

    public func makeOpener() throws -> any FileOpener { SyncOpener(collKey: collKey, kid: kid) }
}

/// The codec of a collection of a server-mode product.
public struct ServerFileCodec: FileCodec {
    public init() {}
    public var enc: String { "none" }
    public func chunkId(_ plain: Data) throws -> Data { SyncCrypto.sha256(plain) }
    public func chunkObjectBytes(_ plainLen: Int) -> Int { plainLen + 2 }

    public func sealChunk(id: Data, plain: Data) throws -> Data {
        guard id.count == 32 else { throw SyncCryptoError.badLength("chunk id") }
        return Data([serverChunkObjectVersion, SyncChunks.codecRaw]) + plain
    }

    public func openChunk(id: Data, object: Data) throws -> FileOpened {
        let o = [UInt8](object)
        if o.count < 2 { return .invalid("shape") }
        if o.count > SYNC_CHUNK_MAX_STORED_BYTES { return .invalid("size") }
        if o[0] != serverChunkObjectVersion { return .invalid("version") }
        let codec = o[1]
        guard codec == SyncChunks.codecRaw || codec == SyncChunks.codecZstd else { return .invalid("codec") }
        let body = Data(o[2...])
        let plain: Data
        if codec == SyncChunks.codecRaw {
            plain = body
        } else {
            guard let size = SyncChunks.zstdContentSize(body) else { return .invalid("decode") }
            if size > SYNC_CDC_MAX_BYTES { return .invalid("size") }
            guard let out = try? zstdDecodeChunk(body, size), out.count == size else { return .invalid("decode") }
            plain = out
        }
        if plain.count > SYNC_CDC_MAX_BYTES { return .invalid("size") }
        if SyncCrypto.sha256(plain) != id { return .invalid("id") }
        return .ok(plain)
    }

    public func storedSize(_ plainSize: Int) -> Int { plainSize }
    public func plainSize(_ storedSize: Int) -> Int? { storedSize }
    public func sealManifest(_ plain: Data) throws -> Data { plain }
    public func sealWhole(_ plain: Data) throws -> Data { plain }
    public func openManifest(_ stored: Data) throws -> FileOpened { .ok(stored) }
    public func makeOpener() throws -> any FileOpener { PassThrough() }
}
