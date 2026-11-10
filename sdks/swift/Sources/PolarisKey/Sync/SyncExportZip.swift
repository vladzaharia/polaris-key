// The zip container of `cloudSync.export()` (WIRE-CONTRACT-V5 §13.12): a streaming STORED zip32 writer. A
// port of client-core's `sync/zipStore.ts` and Python's `ZipStoreWriter`.
//
// Every entry is written as it arrives, with a data descriptor after its data (bit 3), so memory is one
// piece of the caller's data and the central directory's records. Names are UTF-8 (bit 11), the DOS date
// is fixed (an archive never says when it was made), and there is no extra field, no comment and no zip64.
// The layout is the one §13.12's overhead formula counts: a 30-byte local header, the data, a 16-byte
// descriptor and a 46-byte central record per entry, plus the 22-byte end record. The central directory
// lists the entries in the order the caller names, which need not be the order they were written in.
//
// A write that would take the archive past zip32 (the 4 GiB - 1 limit for data, descriptors, central
// directory and end record together, or 65,535 entries) throws `sync-export-too-large` before it reaches
// the sink. Nothing here puts a name, a value or a path in an error.

import Foundation
import PolarisKeyCore

/// Where the archive goes. `write` is called in order. Committing (a rename) and discarding on a failure
/// belong to the host, after the export returns or throws.
protocol ExportSink: Sendable {
    func write(_ data: Data) async throws
}

/// CRC-32 (IEEE 802.3, the zip checksum), incremental.
struct Crc32 {
    private static let table: [UInt32] = (0..<256).map { n in
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 == 1 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }
    private var state: UInt32 = 0xFFFF_FFFF

    mutating func update(_ data: Data) {
        let table = Self.table
        var c = state
        data.withUnsafeBytes { raw in
            for b in raw { c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        }
        state = c
    }

    var value: UInt32 { state ^ 0xFFFF_FFFF }
}

func exportTooLarge(_ what: String) -> PolarisError {
    PolarisError(code: ErrorCode.syncExportTooLarge, message: "The export is too large: \(what)")
}

final class ZipStoreWriter {
    private struct Done {
        let name: String
        let raw: [UInt8]
        let offset: Int
        let crc: UInt32
        let size: Int
    }
    private struct Open {
        let name: String
        let raw: [UInt8]
        let offset: Int
        var crc = Crc32()
        var size = 0
    }

    static let maxU32 = 0xFFFF_FFFF
    private static let maxEntries = 0xFFFF
    /// 1980-01-01 00:00:00.
    private static let dosTime: UInt16 = 0
    private static let dosDate: UInt16 = 0x0021
    /// Bit 3: sizes and CRC follow the data. Bit 11: names are UTF-8.
    private static let flags: UInt16 = 0x0808
    private static let version: UInt16 = 20

    private let sink: any ExportSink
    private let limit: Int
    private var offset = 0
    private var done: [Done] = []
    private var names = Set<[UInt8]>()
    private var current: Open?
    private var finished = false
    /// What the archive still needs after the data written so far: the central records of the entries done,
    /// the open entry's descriptor and central record, and the end record.
    private var reserve = SYNC_EXPORT_ZIP_END_BYTES

    init(sink: any ExportSink, limit: Int = ZipStoreWriter.maxU32) {
        self.sink = sink
        self.limit = limit
    }

    var bytesWritten: Int { offset }

    private func emit(_ b: Data) async throws {
        offset += b.count
        try await sink.write(b)
    }

    private static func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xFF), UInt8(v >> 8)] }
    private static func le32(_ v: UInt32) -> [UInt8] {
        [UInt8(v & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 24)]
    }

    func begin(_ name: String) async throws {
        precondition(!finished && current == nil, "zip: an entry is open or the archive is finished")
        let raw = Array(name.utf8)
        precondition(!raw.isEmpty && raw.count <= 0xFFFF, "zip: entry name length")
        precondition(!names.contains(raw), "zip: entry name repeats")
        if done.count + 1 > Self.maxEntries { throw exportTooLarge("too many entries") }
        let need = SYNC_EXPORT_ZIP_ENTRY_BYTES + 2 * raw.count
        if offset + need + reserve > limit { throw exportTooLarge("over the size limit") }
        var header: [UInt8] = []
        header += Self.le32(0x0403_4B50)
        header += Self.le16(Self.version) + Self.le16(Self.flags) + Self.le16(0)
        header += Self.le16(Self.dosTime) + Self.le16(Self.dosDate)
        header += Self.le32(0) + Self.le32(0) + Self.le32(0)
        header += Self.le16(UInt16(raw.count)) + Self.le16(0)
        reserve += 16 + 46 + raw.count
        names.insert(raw)
        current = Open(name: name, raw: raw, offset: offset)
        try await emit(Data(header + raw))
    }

    func write(_ data: Data) async throws {
        precondition(current != nil, "zip: no entry is open")
        if data.isEmpty { return }
        if offset + data.count + reserve > limit { throw exportTooLarge("over the size limit") }
        current!.crc.update(data)
        current!.size += data.count
        try await emit(data)
    }

    func end() async throws {
        guard let c = current else { preconditionFailure("zip: no entry is open") }
        // The descriptor's 16 bytes were reserved at `begin`.
        reserve -= 16
        current = nil
        done.append(Done(name: c.name, raw: c.raw, offset: c.offset, crc: c.crc.value, size: c.size))
        let size = UInt32(c.size)
        try await emit(
            Data(Self.le32(0x0807_4B50) + Self.le32(c.crc.value) + Self.le32(size) + Self.le32(size)))
    }

    func addBytes(_ name: String, _ data: Data) async throws {
        try await begin(name)
        try await write(data)
        try await end()
    }

    /// Writes the central directory (`order` names every entry once; omitted, as written) and the end
    /// record. Returns the archive's size.
    func finish(order: [String]? = nil) async throws -> Int {
        precondition(!finished && current == nil, "zip: an entry is open or the archive is finished")
        let byName = Dictionary(uniqueKeysWithValues: done.map { (Array($0.name.utf8), $0) })
        let listed = order ?? done.map(\.name)
        let keys = listed.map { Array($0.utf8) }
        precondition(
            keys.count == done.count && Set(keys).count == keys.count && keys.allSatisfy { byName[$0] != nil },
            "zip: the order does not name every entry once")
        finished = true
        let cdOffset = offset
        var cdSize = 0
        for k in keys {
            let d = byName[k]!
            var rec: [UInt8] = []
            rec += Self.le32(0x0201_4B50)
            rec += Self.le16(Self.version) + Self.le16(Self.version) + Self.le16(Self.flags) + Self.le16(0)
            rec += Self.le16(Self.dosTime) + Self.le16(Self.dosDate)
            rec += Self.le32(d.crc) + Self.le32(UInt32(d.size)) + Self.le32(UInt32(d.size))
            rec += Self.le16(UInt16(d.raw.count)) + Self.le16(0) + Self.le16(0) + Self.le16(0) + Self.le16(0)
            rec += Self.le32(0) + Self.le32(UInt32(d.offset))
            cdSize += rec.count + d.raw.count
            try await emit(Data(rec + d.raw))
        }
        var tail: [UInt8] = []
        tail += Self.le32(0x0605_4B50) + Self.le16(0) + Self.le16(0)
        tail += Self.le16(UInt16(keys.count)) + Self.le16(UInt16(keys.count))
        tail += Self.le32(UInt32(cdSize)) + Self.le32(UInt32(cdOffset)) + Self.le16(0)
        try await emit(Data(tail))
        return offset
    }
}
