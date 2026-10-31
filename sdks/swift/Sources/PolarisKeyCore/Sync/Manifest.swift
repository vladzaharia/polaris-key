// `pkey-sync-chunks/1` (WIRE-CONTRACT-V5 §13.8.3): the file of a `chunks` upload, a manifest over
// content-defined chunks. It is stored sealed as a `pkey-sync-file/1` stream; this is the
// plaintext inside.
//
//   header, 64 bytes little-endian: "PKSYNCCH", version u16 (1), recordSize u16 (48),
//     flags u32 (0), chunkCount u32, reserved u32 (0), plainSize u64, plainSha256 (32 bytes)
//   record, 48 bytes: id (32 bytes) | plainLen u32 | flags u32 (0) | reserved u64 (0)
//
// A reader refuses the first violation, in the order of `Invalid`. The plaintext hash binds the
// reassembled file and is checked by whoever reassembles it; a manifest alone cannot.

import Foundation

public enum SyncManifest {
    public static let magic = "PKSYNCCH"
    public static let version = 1
    public static let headerBytes = 64
    public static let recordBytes = 48

    public struct Record: Equatable, Sendable {
        /// 32 raw bytes.
        public let id: Data
        public let plainLen: Int
        public init(id: Data, plainLen: Int) {
            self.id = id
            self.plainLen = plainLen
        }
    }

    public struct Manifest: Equatable, Sendable {
        public let plainSize: Int
        /// 32 bytes.
        public let plainSha256: Data
        public let records: [Record]
        public init(plainSize: Int, plainSha256: Data, records: [Record]) {
            self.plainSize = plainSize
            self.plainSha256 = plainSha256
            self.records = records
        }
    }

    /// In the order a reader checks: the header (`shape`, `magic`, `version`, `recordSize`,
    /// `flags`, `reserved`), the declared `count` (over `SYNC_MAX_CHUNKS_PER_FILE`), the byte
    /// `length`, a `plainSize` over `SYNC_FILE_MAX_BYTES`, each record in file order (`record`:
    /// its flags or reserved are not zero; `chunkLen`: its length is 0 or over
    /// `SYNC_CDC_MAX_BYTES`), and last `size`: the lengths do not add up to `plainSize`.
    public enum Invalid: String, Sendable, Equatable {
        case shape, magic, version, recordSize, flags, reserved, count, length, size, record, chunkLen
    }

    public enum Parsed: Sendable, Equatable {
        case ok(Manifest)
        case invalid(Invalid)

        public var reason: Invalid? { if case .invalid(let r) = self { return r } else { return nil } }
    }

    private static func put(_ b: inout [UInt8], _ at: Int, _ bytes: Int, _ n: Int) {
        var v = UInt64(n)
        for i in 0..<bytes {
            b[at + i] = UInt8(v & 0xFF)
            v >>= 8
        }
    }

    private static func get(_ b: [UInt8], _ at: Int, _ bytes: Int) -> UInt64 {
        var v: UInt64 = 0
        for i in stride(from: bytes - 1, through: 0, by: -1) { v = v << 8 | UInt64(b[at + i]) }
        return v
    }

    public static func encode(_ m: Manifest) throws -> Data {
        guard m.plainSha256.count == 32 else { throw SyncCryptoError.badLength("plainSha256") }
        guard m.plainSize >= 0, m.records.count <= SYNC_MAX_CHUNKS_PER_FILE else {
            throw SyncCryptoError.badLength("manifest")
        }
        var out = [UInt8](repeating: 0, count: headerBytes + recordBytes * m.records.count)
        out.replaceSubrange(0..<8, with: Array(magic.utf8))
        put(&out, 8, 2, version)
        put(&out, 10, 2, recordBytes)
        put(&out, 16, 4, m.records.count)
        put(&out, 24, 8, m.plainSize)
        out.replaceSubrange(32..<64, with: m.plainSha256)
        for (i, r) in m.records.enumerated() {
            guard r.id.count == 32 else { throw SyncCryptoError.badLength("chunk id") }
            guard r.plainLen >= 0, r.plainLen <= Int(UInt32.max) else {
                throw SyncCryptoError.badLength("chunk length")
            }
            let at = headerBytes + recordBytes * i
            out.replaceSubrange(at..<(at + 32), with: r.id)
            put(&out, at + 32, 4, r.plainLen)
        }
        return Data(out)
    }

    public static func parse(_ data: Data) -> Parsed {
        let b = [UInt8](data)
        if b.count < headerBytes { return .invalid(.shape) }
        if Array(b[0..<8]) != Array(magic.utf8) { return .invalid(.magic) }
        if get(b, 8, 2) != UInt64(version) { return .invalid(.version) }
        if get(b, 10, 2) != UInt64(recordBytes) { return .invalid(.recordSize) }
        if get(b, 12, 4) != 0 { return .invalid(.flags) }
        if get(b, 20, 4) != 0 { return .invalid(.reserved) }
        let count = Int(get(b, 16, 4))
        if count > SYNC_MAX_CHUNKS_PER_FILE { return .invalid(.count) }
        if b.count != headerBytes + recordBytes * count { return .invalid(.length) }
        let size = get(b, 24, 8)
        if size > UInt64(SYNC_FILE_MAX_BYTES) { return .invalid(.size) }
        var records: [Record] = []
        records.reserveCapacity(count)
        var sum = 0
        for i in 0..<count {
            let at = headerBytes + recordBytes * i
            if get(b, at + 36, 4) != 0 || get(b, at + 40, 8) != 0 { return .invalid(.record) }
            let len = Int(get(b, at + 32, 4))
            if len == 0 || len > SYNC_CDC_MAX_BYTES { return .invalid(.chunkLen) }
            sum += len
            records.append(Record(id: Data(b[at..<(at + 32)]), plainLen: len))
        }
        if sum != Int(size) { return .invalid(.size) }
        return .ok(
            Manifest(plainSize: Int(size), plainSha256: Data(b[32..<64]), records: records))
    }
}
