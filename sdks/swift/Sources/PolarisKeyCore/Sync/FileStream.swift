// `pkey-sync-file/1` (WIRE-CONTRACT-V5 §13.10.4): a file sealed as a stream of segments.
//
//   header, 64 bytes little-endian: "PKSYNCF1", version u16 (1), flags u16 (0),
//     segmentBytes u32 (1 MiB), kid (16 bytes), salt (32 bytes)
//   segment i: AES-256-GCM(K_file, nonce = u8(last) | 0x00 0x00 0x00 | u64be(i), aad = header,
//     the segment's plaintext), so 16 bytes longer than its plaintext
//
// K_file comes from K_coll and the header's salt (`SyncCrypto.deriveFileKey`). Every segment but
// the last holds exactly `segmentBytes` of plaintext; the last holds 1..segmentBytes, except that
// an empty file is one empty last segment. The end of the stream says which segment is last, so a
// truncated stream, a dropped or reordered segment and a missing last flag all fail the tag.
//
// Nothing here holds a whole file unless the caller asks for it (`sealFile` / `openFile`): the
// `Sealer` and the `Opener` keep at most one segment and the bytes in hand, and `openRange` reads
// and decrypts only the segments it needs.

import CryptoKit
import Foundation

public enum SyncFileStream {
    public static let magic = "PKSYNCF1"
    public static let version = 1
    public static let headerBytes = 64
    /// The only segment size `pkey-sync-file/1` defines.
    public static let segmentBytes = SYNC_FILE_SEGMENT_BYTES
    public static let tagBytes = 16

    /// Why a reader refuses a stream, in the order it checks: the header (`shape`: under 64 bytes;
    /// `magic`, `version`, `flags`, `segmentSize`, `kid`), then the body (`shape`: no segment, or a
    /// tail shorter than a tag; `size`: an empty last segment after others, or a short ranged read;
    /// `auth`: a segment fails its tag, which covers truncation, reordering, a missing last flag and
    /// a tampered header). `range` is a ranged open outside the file; `plainSize` and `plainSha256`
    /// are `Reassembly` checks.
    public enum Invalid: String, Sendable, Equatable {
        case shape, magic, version, flags, segmentSize, kid, size, auth, range, plainSize, plainSha256
    }

    public struct Failure: Error, Equatable, Sendable {
        public let reason: Invalid
        public init(_ reason: Invalid) { self.reason = reason }
    }

    public enum Opened: Equatable, Sendable {
        case ok(plain: Data)
        case invalid(Invalid)

        public var reason: Invalid? { if case .invalid(let r) = self { return r } else { return nil } }
    }

    /// The 64-byte header.
    public static func encodeHeader(kid: Data, salt: Data) throws -> Data {
        guard kid.count == SyncCrypto.kidBytes else { throw SyncCryptoError.badLength("kid") }
        guard salt.count == SyncCrypto.fileSaltBytes else { throw SyncCryptoError.badLength("salt") }
        var h = Data(magic.utf8)
        h.append(contentsOf: [UInt8(version & 0xff), UInt8(version >> 8)])
        h.append(contentsOf: [0, 0])
        let seg = UInt32(segmentBytes)
        h.append(contentsOf: [UInt8(seg & 0xff), UInt8(seg >> 8 & 0xff), UInt8(seg >> 16 & 0xff), UInt8(seg >> 24)])
        h.append(kid)
        h.append(salt)
        return h
    }

    /// The sealed size of a plaintext of `plainSize` bytes; nil for a negative size.
    public static func sealedSize(plainSize: Int) -> Int? {
        guard plainSize >= 0 else { return nil }
        let segments = max(1, (plainSize + segmentBytes - 1) / segmentBytes)
        return headerBytes + plainSize + segments * tagBytes
    }

    /// The plaintext size a sealed size implies, or nil when no stream has that size.
    public static func plainSize(sealedSize: Int) -> Int? {
        let body = sealedSize - headerBytes
        let whole = segmentBytes + tagBytes
        guard body >= tagBytes else { return nil }
        let full = body / whole
        let rest = body - full * whole
        if rest == 0 { return full * segmentBytes }
        if rest < tagBytes { return nil }
        // An empty last segment is only the empty file.
        if rest == tagBytes && full > 0 { return nil }
        return full * segmentBytes + (rest - tagBytes)
    }

    private static func nonce(_ index: Int, last: Bool) -> Data {
        var n = Data(count: 12)
        n[0] = last ? 1 : 0
        for i in 0..<8 { n[4 + i] = UInt8(truncatingIfNeeded: UInt64(index) >> UInt64(56 - 8 * i)) }
        return n
    }

    private static func equal(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
    }

    // ── Seal ─────────────────────────────────────────────────────────────────────────────────

    /// Seals a file as it arrives. `header` goes first; `push` returns the sealed segments that the
    /// bytes complete and `finish` the last one. One byte is held back until more arrives, so the
    /// final segment is known to be the last. Every seal draws a fresh random 32-byte salt
    /// (§13.10.2), never one derived from the content: a salt names one file version, and reusing
    /// it under the same `collKey` repeats K_file and every nonce. `salt` is for known-answer
    /// vectors only.
    public struct Sealer {
        public let header: Data
        private let key: Data
        private var index = 0
        private var buffer = Data()

        public init(collKey: Data, kid: Data, salt: Data? = nil) throws {
            guard collKey.count == 32 else { throw SyncCryptoError.badLength("collection key") }
            let s = salt ?? SyncCrypto.random(SyncCrypto.fileSaltBytes)
            header = try SyncFileStream.encodeHeader(kid: kid, salt: s)
            key = SyncCrypto.deriveFileKey(collKey: collKey, salt: s)
        }

        public mutating func push(_ data: Data) throws -> [Data] {
            buffer.append(data)
            var out: [Data] = []
            while buffer.count > SyncFileStream.segmentBytes {
                let plain = Data(buffer.prefix(SyncFileStream.segmentBytes))
                buffer = Data(buffer.dropFirst(SyncFileStream.segmentBytes))
                out.append(try seal(plain, last: false))
            }
            return out
        }

        /// The last sealed segment (an empty file is one empty last segment). The sealer is empty after.
        public mutating func finish() throws -> Data {
            let plain = buffer
            buffer = Data()
            return try seal(plain, last: true)
        }

        private mutating func seal(_ plain: Data, last: Bool) throws -> Data {
            let sealed = try SyncCrypto.aesGcmSeal(
                key: key, aad: header, plaintext: plain, nonce: SyncFileStream.nonce(index, last: last))
            index += 1
            return sealed
        }
    }

    /// `Sealer` over one buffer: the header and every segment. For files that fit in memory.
    public static func sealFile(collKey: Data, kid: Data, plain: Data, salt: Data? = nil) throws -> Data {
        var s = try Sealer(collKey: collKey, kid: kid, salt: salt)
        var out = s.header
        for seg in try s.push(plain) { out.append(seg) }
        out.append(try s.finish())
        return out
    }

    // ── Open ─────────────────────────────────────────────────────────────────────────────────

    private struct ParsedHeader {
        let header: Data
        let salt: Data
    }

    private static func parseHeader(_ data: Data, kid: Data) throws -> ParsedHeader {
        let b = [UInt8](data)
        guard b.count >= headerBytes else { throw Failure(.shape) }
        guard Array(b[0..<8]) == Array(magic.utf8) else { throw Failure(.magic) }
        guard Int(b[8]) | Int(b[9]) << 8 == version else { throw Failure(.version) }
        guard b[10] == 0 && b[11] == 0 else { throw Failure(.flags) }
        let seg = Int(b[12]) | Int(b[13]) << 8 | Int(b[14]) << 16 | Int(b[15]) << 24
        guard seg == segmentBytes else { throw Failure(.segmentSize) }
        guard equal(Data(b[16..<32]), kid) else { throw Failure(.kid) }
        return ParsedHeader(header: Data(b[0..<headerBytes]), salt: Data(b[32..<headerBytes]))
    }

    /// Opens a sealed stream as it arrives. `push` returns the plaintext of each segment whose tag
    /// has verified and `finish` the last one; both throw `Failure`. Truncation is only known at
    /// `finish`, so a caller that writes the plaintext out treats it as provisional until `finish`
    /// returns. `kid` is `SyncCrypto.deriveKid(root:)`; a stream sealed under another ring is `kid`.
    public struct Opener {
        private let collKey: Data
        private let kid: Data
        private var parsed: ParsedHeader?
        private var key = Data()
        private var index = 0
        private var buffer = Data()

        public init(collKey: Data, kid: Data) {
            self.collKey = collKey
            self.kid = kid
        }

        public mutating func push(_ data: Data) throws -> [Data] {
            buffer.append(data)
            if parsed == nil {
                guard buffer.count >= SyncFileStream.headerBytes else { return [] }
                let p = try SyncFileStream.parseHeader(buffer.prefix(SyncFileStream.headerBytes), kid: kid)
                parsed = p
                key = SyncCrypto.deriveFileKey(collKey: collKey, salt: p.salt)
                buffer = Data(buffer.dropFirst(SyncFileStream.headerBytes))
            }
            let whole = SyncFileStream.segmentBytes + SyncFileStream.tagBytes
            var out: [Data] = []
            // One byte beyond a whole segment proves the segment is not the last.
            while buffer.count > whole {
                out.append(try open(Data(buffer.prefix(whole)), last: false))
                buffer = Data(buffer.dropFirst(whole))
            }
            return out
        }

        /// The plaintext of the last segment, once the input has ended.
        public mutating func finish() throws -> Data {
            guard parsed != nil, buffer.count >= SyncFileStream.tagBytes else { throw Failure(.shape) }
            if buffer.count == SyncFileStream.tagBytes && index > 0 { throw Failure(.size) }
            let tail = buffer
            buffer = Data()
            return try open(tail, last: true)
        }

        private mutating func open(_ sealed: Data, last: Bool) throws -> Data {
            guard
                let plain = SyncCrypto.aesGcmOpen(
                    key: key, aad: parsed!.header, ciphertext: sealed,
                    nonce: SyncFileStream.nonce(index, last: last))
            else { throw Failure(.auth) }
            index += 1
            return plain
        }
    }

    /// `Opener` over one buffer; a refusal comes back with its reason.
    public static func openFile(collKey: Data, kid: Data, sealed: Data) -> Opened {
        var o = Opener(collKey: collKey, kid: kid)
        var out = Data()
        do {
            for seg in try o.push(sealed) { out.append(seg) }
            out.append(try o.finish())
        } catch let f as Failure {
            return .invalid(f.reason)
        } catch {
            return .invalid(.auth)
        }
        return .ok(plain: out)
    }

    /// Reads `length` bytes of the stored file at `offset`; a short answer is a `size` refusal.
    public typealias RangeReader = (_ offset: Int, _ length: Int) throws -> Data

    /// Opens bytes `[start, end)` of the plaintext of a stored stream of `sealedSize` bytes. It reads
    /// the header and then only the segments that overlap the range, each verified as a whole; the
    /// last-segment flag comes from `sealedSize`, so a server that lies about the size or drops a
    /// tail fails the tag. An `end` past the plaintext is `range`. Throws `Failure`.
    public static func openRange(
        collKey: Data, kid: Data, read: RangeReader, sealedSize: Int, start: Int, end: Int
    ) throws -> Data {
        guard let plainLen = plainSize(sealedSize: sealedSize) else { throw Failure(.shape) }
        guard start >= 0, start <= end, end <= plainLen else { throw Failure(.range) }
        func fetch(_ offset: Int, _ length: Int) throws -> Data {
            let b = try read(offset, length)
            guard b.count == length else { throw Failure(.size) }
            return b
        }
        let p = try parseHeader(try fetch(0, headerBytes), kid: kid)
        if start == end { return Data() }
        let key = SyncCrypto.deriveFileKey(collKey: collKey, salt: p.salt)
        let whole = segmentBytes + tagBytes
        let segments = max(1, (plainLen + segmentBytes - 1) / segmentBytes)
        var out = Data()
        for i in (start / segmentBytes)...((end - 1) / segmentBytes) {
            let isLast = i == segments - 1
            let segLen = isLast ? plainLen - i * segmentBytes : segmentBytes
            let sealed = try fetch(headerBytes + i * whole, segLen + tagBytes)
            guard
                let plain = SyncCrypto.aesGcmOpen(
                    key: key, aad: p.header, ciphertext: sealed, nonce: nonce(i, last: isLast))
            else { throw Failure(.auth) }
            let from = max(start, i * segmentBytes) - i * segmentBytes
            let to = min(end, i * segmentBytes + segLen) - i * segmentBytes
            out.append(plain.subdata(in: from..<to))
        }
        return out
    }

    // ── Reassembly ───────────────────────────────────────────────────────────────────────────

    /// Passes the plaintext of a reassembled file through while hashing it, and at the end checks the
    /// length and SHA-256 the chunk manifest declared (`SyncManifest.Manifest.plainSize` /
    /// `plainSha256`). `push` throws `plainSize` for a source that overruns (before it can write the
    /// rest of a runaway file); `finish` throws `plainSize` or `plainSha256`. The caller discards what
    /// it wrote: a file is not usable until `finish` returns. Never holds the file.
    public struct Reassembly {
        private let expectedSize: Int
        private let expectedSha256: Data
        private var hash = SHA256()
        private var count = 0

        public init(plainSize: Int, plainSha256: Data) throws {
            guard plainSize >= 0, plainSize <= SYNC_FILE_MAX_BYTES else { throw Failure(.plainSize) }
            expectedSize = plainSize
            expectedSha256 = plainSha256
        }

        public mutating func push(_ part: Data) throws {
            count += part.count
            if count > expectedSize { throw Failure(.plainSize) }
            hash.update(data: part)
        }

        public mutating func finish() throws {
            if count != expectedSize { throw Failure(.plainSize) }
            if !SyncFileStream.equal(Data(hash.finalize()), expectedSha256) { throw Failure(.plainSha256) }
        }
    }
}
