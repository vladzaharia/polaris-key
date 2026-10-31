// `pkey-sync-cdc/1` (WIRE-CONTRACT-V5 §13.8.3): content-defined chunking of a file's plaintext,
// `fastcdc-2016-nc1`, streaming. Every implementation cuts at the same offsets (`cdcCases`).
//
//   gear[i]  xorshift32 from seed 0x9e3779b9: x ^= x << 13; x ^= x >> 17; x ^= x << 5 (32-bit),
//            one step per entry, 256 entries
//   min, max avg / 4 and avg * 4 (64 KiB, 256 KiB and 1 MiB by default)
//   masks    bits = log2(avg); the strict mask has the top bits + 1 bits set, the loose mask the
//            top bits - 1
//   scan     per chunk, h starts at 0 at offset min; h = (h << 1) + gear[byte] (32-bit); up to
//            offset avg a cut where h & strict == 0, after it where h & loose == 0; the cut is
//            after the matching byte, else at max (or at the end of the input)
//   tail     what remains is one chunk when it is at most min bytes
//
// The scan of a chunk never looks past `max` bytes, so a chunk is decided as soon as `max` bytes
// are buffered (or the input ends) and a chunker holds at most `max` bytes at a time.

import Foundation

public enum SyncCdc {
    public struct Params: Equatable, Sendable {
        public let avg: Int
        public let min: Int
        public let max: Int
    }

    /// The parameters of `pkey-sync-cdc/1`: average 256 KiB, minimum 64 KiB, maximum 1 MiB.
    public static let defaultParams = params(avg: SYNC_CDC_AVG_BYTES)!

    /// The parameters for an average chunk size, or nil unless it is a power of two of at least 64.
    public static func params(avg: Int) -> Params? {
        guard avg >= 64, avg & (avg - 1) == 0 else { return nil }
        return Params(avg: avg, min: avg >> 2, max: avg * 4)
    }

    private static let gear: [UInt32] = {
        var g = [UInt32](repeating: 0, count: 256)
        var x = UInt32(truncatingIfNeeded: SYNC_CDC_GEAR_SEED)
        for i in 0..<256 {
            x ^= x << 13
            x ^= x >> 17
            x ^= x << 5
            g[i] = x
        }
        return g
    }()

    private static func topMask(_ n: Int) -> UInt32 {
        n >= 32 ? 0xFFFF_FFFF : ~(UInt32.max >> UInt32(n))
    }

    /// The length of the chunk at the start of `buf[0..<len]`, which is the rest of the input or at
    /// least `max` bytes.
    private static func cutLength(_ buf: [UInt8], _ len: Int, _ p: Params) -> Int {
        if len <= p.min { return len }
        let bits = p.avg.trailingZeroBitCount
        let strict = topMask(bits + 1)
        let loose = topMask(bits - 1)
        let end = Swift.min(len, p.max)
        let normal = Swift.min(end, p.avg)
        var h: UInt32 = 0
        return buf.withUnsafeBufferPointer { b in
            gear.withUnsafeBufferPointer { g in
                var i = p.min
                while i < end {
                    h = (h << 1) &+ g[Int(b[i])]
                    if h & (i < normal ? strict : loose) == 0 { return i + 1 }
                    i += 1
                }
                return end
            }
        }
    }

    /// A push chunker: `push` returns the chunks that are decided, `finish` the rest.
    public struct Chunker {
        public let params: Params
        private var buf: [UInt8] = []

        public init(params: Params = SyncCdc.defaultParams) {
            self.params = params
            buf.reserveCapacity(params.max)
        }

        /// The chunks that `data` completes, in order.
        public mutating func push(_ data: Data) -> [Data] {
            var out: [Data] = []
            var at = data.startIndex
            while at < data.endIndex {
                let take = Swift.min(params.max - buf.count, data.endIndex - at)
                buf.append(contentsOf: data[at..<(at + take)])
                at += take
                if buf.count == params.max { emit(&out, SyncCdc.cutLength(buf, buf.count, params)) }
            }
            return out
        }

        /// The last chunks, once the input has ended. The chunker is empty afterwards.
        public mutating func finish() -> [Data] {
            var out: [Data] = []
            while !buf.isEmpty { emit(&out, SyncCdc.cutLength(buf, buf.count, params)) }
            return out
        }

        private mutating func emit(_ out: inout [Data], _ n: Int) {
            out.append(Data(buf[0..<n]))
            buf.removeSubrange(0..<n)
        }
    }

    /// The chunk lengths of a whole buffer (tests and tools; production code streams).
    public static func lengths(_ data: Data, params: Params = defaultParams) -> [Int] {
        var c = Chunker(params: params)
        return (c.push(data) + c.finish()).map(\.count)
    }
}
