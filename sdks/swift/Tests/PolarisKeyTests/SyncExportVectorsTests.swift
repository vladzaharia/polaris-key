// @pkey-feature sync.export
// `sync-vectors.json` `exportCases` (WIRE-CONTRACT-V5 §13.12, U-51.6): every row is replayed through
// `exportToSink` with the changes as served, a file source built from the row's recipes and a sink that
// collects the zip. The archive is then read back with an independent central-directory reader (every
// CRC-32 recomputed bit by bit) and its entries compared with the row: names in order, sizes, SHA-256, the
// text of the small ones, or the refusal. `unzip -t` also reads every archive (skipped without `unzip`).

import Foundation
import PolarisKeyCore
import Testing

@testable import PolarisKey

#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

/// One `exportCases` row. The corpus is read with the lenient JSON reader (a Swift string cannot hold a lone
/// surrogate, which some rows carry on purpose), so a row is built from the JSON tree and not decoded.
struct ExportRow {
    struct Stored {
        let label: String
        let length: Int
        let saltHex: String?
        let swapLabel: String?
        let swapSaltHex: String?
        let extra: Int?
        let cut: Int?
        let flipAt: Int?
    }
    struct Chunked {
        let label: String
        let chunkLens: [Int]
        let saltHex: String?
        let manifestPlainSize: Int?
        let plainSha256Flip: Bool?
        let manifestFlipAt: Int?
        let dropChunk: Int?
        let flipChunk: Int?
    }
    struct File {
        let collection: String
        let record: String
        let version: Int
        let size: JSONValue
        let sha256: String
        let format: String
        let stored: Stored?
        let chunked: Chunked?
    }
    struct Entry {
        let name: String
        let size: Int
        let sha256Hex: String
        let utf8: String?
        let hex: String?
    }
    let id: String
    let product: String
    let exportedAt: Int
    let rootHex: String?
    let includeRevisions: Bool
    let unsynced: Int
    let maxEntries: Int?
    let maxBytes: Int?
    let changes: [JSONValue]
    let files: [File]
    let entries: [Entry]?
    let refusal: String?
}

private func field(_ v: JSONValue, _ k: String) -> JSONValue? { v.objectValue?[k] }
private func str(_ v: JSONValue, _ k: String) -> String? { field(v, k)?.stringValue }
private func int(_ v: JSONValue, _ k: String) -> Int? { field(v, k)?.intValue }

private func storedOf(_ v: JSONValue) -> ExportRow.Stored {
    ExportRow.Stored(
        label: str(v, "label")!, length: int(v, "length")!, saltHex: str(v, "saltHex"),
        swapLabel: field(v, "swap").flatMap { str($0, "label") },
        swapSaltHex: field(v, "swap").flatMap { str($0, "saltHex") }, extra: int(v, "extra"), cut: int(v, "cut"),
        flipAt: int(v, "flipAt"))
}

private func chunkedOf(_ v: JSONValue) -> ExportRow.Chunked {
    ExportRow.Chunked(
        label: str(v, "label")!, chunkLens: field(v, "chunkLens")!.arrayValue!.map { $0.intValue! },
        saltHex: str(v, "saltHex"), manifestPlainSize: int(v, "manifestPlainSize"),
        plainSha256Flip: field(v, "plainSha256Flip")?.boolValue, manifestFlipAt: int(v, "manifestFlipAt"),
        dropChunk: int(v, "dropChunk"), flipChunk: int(v, "flipChunk"))
}

private func rowOf(_ v: JSONValue) -> ExportRow {
    let expect = field(v, "expect")!
    return ExportRow(
        id: str(v, "id")!, product: str(v, "product")!, exportedAt: int(v, "exportedAt")!, rootHex: str(v, "rootHex"),
        includeRevisions: field(v, "includeRevisions")!.boolValue!, unsynced: int(v, "unsynced")!,
        maxEntries: field(v, "caps").flatMap { int($0, "maxEntries") },
        maxBytes: field(v, "caps").flatMap { int($0, "maxBytes") }, changes: field(v, "changes")!.arrayValue!,
        files: field(v, "files")!.arrayValue!.map { f in
            ExportRow.File(
                collection: str(f, "collection")!, record: str(f, "record")!, version: int(f, "version")!,
                size: field(f, "size")!, sha256: str(f, "sha256")!, format: str(f, "format")!,
                stored: field(f, "stored").map(storedOf), chunked: field(f, "chunked").map(chunkedOf))
        },
        entries: field(expect, "entries")?.arrayValue?.map { e in
            ExportRow.Entry(
                name: str(e, "name")!, size: int(e, "size")!, sha256Hex: str(e, "sha256Hex")!, utf8: str(e, "utf8"),
                hex: str(e, "hex"))
        }, refusal: field(expect, "refusal").flatMap { str($0, "code") })
}

private let exportRows: [ExportRow] = {
    // swiftlint:disable:next force_try
    let raw = try! Data(contentsOf: CorpusLocator.url("sync-vectors"))
    // swiftlint:disable:next force_try
    let tree = try! CanonicalJSON.parseLeniently(utf8: raw)
    return field(tree, "exportCases")!.arrayValue!.map(rowOf)
}()

func xUnhex(_ s: String) -> Data {
    var d = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        d.append(UInt8(s[i..<j], radix: 16)!)
        i = j
    }
    return d
}

func xHex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

/// The deterministic plaintext of the corpus: SHA-256(label ‖ u32be(i)) blocks, cut to `length`.
func xStream(_ label: String, _ length: Int) -> Data {
    var out = Data()
    var i: UInt32 = 0
    while out.count < length {
        var h = SHA256()
        h.update(data: Data(label.utf8))
        h.update(data: withUnsafeBytes(of: i.bigEndian) { Data($0) })
        out.append(Data(h.finalize()).prefix(min(32, length - out.count)))
        i += 1
    }
    return out
}

/// What the transport serves for each file and chunk of a row.
struct ExportTransport {
    var whole: [String: Data] = [:]
    var chunks: [String: Data] = [:]

    static func key(_ collection: String, _ record: String, _ version: Int) -> String {
        "\(collection)\u{0}\(record)\u{0}\(version)"
    }

    init(_ row: ExportRow) throws {
        let root = row.rootHex.map(xUnhex)
        for f in row.files {
            if let r = f.stored {
                let label = r.swapLabel ?? r.label
                let salt = r.swapLabel == nil ? r.saltHex : r.swapSaltHex
                let plain = xStream(label, r.length)
                var served = plain
                if let salt, let root {
                    served = try SyncFileStream.sealFile(
                        collKey: SyncCrypto.deriveCollKey(root: root, collection: f.collection),
                        kid: SyncCrypto.deriveKid(root: root), plain: plain, salt: xUnhex(salt))
                }
                if let extra = r.extra { served += xStream("\(r.label) extra", extra) }
                if let at = r.flipAt { served[at] ^= 1 }
                if let cut = r.cut { served = served.prefix(cut) }
                whole[Self.key(f.collection, f.record, f.version)] = Data(served)
            } else if let r = f.chunked {
                let codec: any FileCodec =
                    root.map { E2eFileCodec(root: $0, collection: f.collection) } ?? ServerFileCodec()
                let total = r.chunkLens.reduce(0, +)
                let plain = xStream(r.label, total)
                var records: [SyncManifest.Record] = []
                var at = 0
                for (i, len) in r.chunkLens.enumerated() {
                    let body = plain.subdata(in: at..<at + len)
                    at += len
                    let id = try codec.chunkId(body)
                    records.append(SyncManifest.Record(id: id, plainLen: len))
                    if r.dropChunk == i { continue }
                    var obj = try codec.sealChunk(id: id, plain: body)
                    if r.flipChunk == i { obj[obj.count - 1] ^= 1 }
                    chunks["\(f.collection)\u{0}\(xHex(id))"] = obj
                }
                var sha = Data(SHA256.hash(data: plain))
                if r.plainSha256Flip == true { sha[0] ^= 1 }
                let manifest = try SyncManifest.encode(
                    SyncManifest.Manifest(plainSize: r.manifestPlainSize ?? total, plainSha256: sha, records: records))
                var stored = manifest
                if let root {
                    stored = try SyncFileStream.sealFile(
                        collKey: SyncCrypto.deriveCollKey(root: root, collection: f.collection),
                        kid: SyncCrypto.deriveKid(root: root), plain: manifest, salt: xUnhex(r.saltHex!))
                }
                if let at = r.manifestFlipAt { stored[at] ^= 1 }
                whole[Self.key(f.collection, f.record, f.version)] = stored
            }
        }
    }
}

/// A source over a row's transport: the bytes arrive in awkward pieces, and the reads are counted.
final class ExportRowSource: ExportFileSource, @unchecked Sendable {
    private let row: ExportRow
    private let transport: ExportTransport
    private let pieceSize: Int
    private let lock = NSLock()
    private var readBytes = 0
    var stored: Int { lock.withLock { readBytes } }

    init(_ row: ExportRow, _ transport: ExportTransport, piece: Int = 300_007) {
        self.row = row
        self.transport = transport
        pieceSize = piece
    }

    func pointers(collection: String, record: String) async throws -> [JSONValue] {
        row.files.filter { $0.collection == collection && $0.record == record }
            .map {
                .object([
                    "version": .int($0.version), "size": $0.size, "sha256": .string($0.sha256),
                    "format": .string($0.format),
                ])
            }
    }

    func stored(_ ref: ExportFileRef, _ piece: (Data) async throws -> Bool) async throws {
        guard let v = ref.version, let bytes = transport.whole[ExportTransport.key(ref.collection, ref.record, v)]
        else { return }
        var at = 0
        while at < bytes.count {
            let part = bytes.subdata(in: at..<min(bytes.count, at + pieceSize))
            lock.withLock { readBytes += part.count }
            at += part.count
            guard try await piece(part) else { return }
        }
    }

    func chunk(collection: String, id: String) async throws -> Data? { transport.chunks["\(collection)\u{0}\(id)"] }
}

/// Collects what a writer sends.
final class CollectingSink: ExportSink, @unchecked Sendable {
    private let lock = NSLock()
    private var parts: [Data] = []
    private var largest = 0
    var writes: Int { lock.withLock { parts.count } }
    var maxPiece: Int { lock.withLock { largest } }
    var zip: Data { lock.withLock { parts.reduce(into: Data()) { $0.append($1) } } }
    func write(_ data: Data) async throws {
        lock.withLock {
            parts.append(data)
            largest = max(largest, data.count)
        }
    }
}

struct ZipEntry {
    let name: String
    let data: Data
}

struct ZipReadError: Error { let why: String }

/// A STORED zip32 read through its central directory, every CRC-32 recomputed bit by bit.
func readStoredZip(_ zip: Data) throws -> [ZipEntry] {
    let b = [UInt8](zip)
    func u16(_ at: Int) -> Int { Int(b[at]) | Int(b[at + 1]) << 8 }
    func u32(_ at: Int) -> Int { u16(at) | u16(at + 2) << 16 }
    let end = b.count - 22
    guard end >= 0, u32(end) == 0x0605_4B50 else { throw ZipReadError(why: "no end record") }
    let n = u16(end + 10)
    var at = u32(end + 16)
    func crc(_ s: ArraySlice<UInt8>) -> Int {
        var c: UInt32 = 0xFFFF_FFFF
        for x in s {
            c ^= UInt32(x)
            for _ in 0..<8 { c = c & 1 == 1 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        }
        return Int(c ^ 0xFFFF_FFFF)
    }
    var out: [ZipEntry] = []
    for _ in 0..<n {
        guard u32(at) == 0x0201_4B50 else { throw ZipReadError(why: "bad central") }
        let method = u16(at + 10)
        let sum = u32(at + 16)
        let size = u32(at + 24)
        let nameLen = u16(at + 28)
        let skip = u16(at + 30) + u16(at + 32)
        let local = u32(at + 42)
        let name = String(decoding: b[(at + 46)..<(at + 46 + nameLen)], as: UTF8.self)
        guard method == 0 else { throw ZipReadError(why: "not stored") }
        guard u32(local) == 0x0403_4B50 else { throw ZipReadError(why: "bad local") }
        let start = local + 30 + u16(local + 26) + u16(local + 28)
        let data = b[start..<(start + size)]
        guard crc(data) == sum else { throw ZipReadError(why: "crc mismatch") }
        let d = start + size
        guard u32(d) == 0x0807_4B50, u32(d + 4) == sum, u32(d + 8) == size, u32(d + 12) == size else {
            throw ZipReadError(why: "bad descriptor")
        }
        out.append(ZipEntry(name: name, data: Data(data)))
        at += 46 + nameLen + skip
    }
    return out
}

/// `unzip -t` on an archive, or nil when there is no `unzip`.
func unzipTest(_ zip: Data) throws -> (ok: Bool, output: String)? {
    let tool = ["/usr/bin/unzip", "/opt/homebrew/bin/unzip", "/usr/local/bin/unzip"].first {
        FileManager.default.isExecutableFile(atPath: $0)
    }
    guard let tool else { return nil }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pk-unzip-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appendingPathComponent("a.zip")
    try zip.write(to: file)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tool)
    p.arguments = ["-t", file.path]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    try p.run()
    let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    p.waitUntilExit()
    return (p.terminationStatus == 0, text)
}

/// Runs one row to a collecting sink. A throw is returned, not rethrown.
func runExportRow(_ row: ExportRow) async throws -> (sink: CollectingSink, source: ExportRowSource, error: Error?) {
    let root = row.rootHex.map(xUnhex)
    let source = ExportRowSource(row, try ExportTransport(row))
    let sink = CollectingSink()
    var input = ExportInput(
        product: row.product, exportedAt: row.exportedAt, unsynced: row.unsynced,
        includeRevisions: row.includeRevisions, changes: row.changes, files: source,
        codec: root.map { FixtureCodec($0) },
        fileCodec: root.map { r in { @Sendable collection in E2eFileCodec(root: r, collection: collection) } },
        maxEntries: row.maxEntries, maxBytes: row.maxBytes)
    input.onProgress = nil
    do {
        _ = try await exportToSink(input, sink)
    } catch {
        return (sink, source, error)
    }
    return (sink, source, nil)
}

@Suite("Cloud Sync export (sync-vectors.json exportCases)")
struct SyncExportVectorsTests {
    @Test func hasRows() { #expect(!exportRows.isEmpty) }

    @Test(arguments: exportRows.map(\.id))
    func row(id: String) async throws {
        let row = exportRows.first { $0.id == id }!
        let (sink, source, error) = try await runExportRow(row)
        if let refusal = row.refusal {
            let e = try #require(error as? PolarisError)
            #expect(e.code == refusal)
            // Refused before the first byte; only manifests may have been fetched to plan.
            #expect(sink.writes == 0)
            #expect(source.stored < 4096)
            return
        }
        if let error { throw error }
        let got = try readStoredZip(sink.zip)
        let want = try #require(row.entries)
        #expect(got.map(\.name) == want.map(\.name))
        for (g, w) in zip(got, want) {
            #expect(g.data.count == w.size, "\(w.name) size")
            #expect(xHex(Data(SHA256.hash(data: g.data))) == w.sha256Hex, "\(w.name) sha256")
            if let text = w.utf8 { #expect(String(decoding: g.data, as: UTF8.self) == text, "\(w.name)") }
            if let h = w.hex { #expect(xHex(g.data) == h, "\(w.name)") }
        }
        // A sink is handed pieces no larger than a segment plus its tag.
        #expect(sink.maxPiece <= 1_048_576 + 16)
        if let t = try unzipTest(sink.zip) { #expect(t.ok, "unzip -t: \(t.output)") }
    }
}
