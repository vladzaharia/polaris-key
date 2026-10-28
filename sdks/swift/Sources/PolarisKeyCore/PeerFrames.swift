// WIRE-CONTRACT-V5 §15.6: TCP framing, `u16be len || Noise message`, len 1 to 65,535 (CC-11.3).
// Swift mirror of client-core's `peer/frame.ts`. Pure bytes: no I/O, no clock.

import Foundation

public enum PeerFrame {
    public static let maxFrame = 65535

    /// A frame's bytes were not a frame: a zero length, wherever it occurs.
    public struct BadFrame: Error, Sendable, Equatable, CustomStringConvertible {
        public var code: String { "peer_bad_frame" }
        public var description: String { "peer: peer_bad_frame" }
    }

    /// A length the framing cannot hold (empty, or over 65,535).
    public struct BadLength: Error, Sendable, Equatable {}

    public static func encode(_ noise: Data) throws -> Data {
        guard noise.count >= 1, noise.count <= maxFrame else { throw BadLength() }
        var out = Data(capacity: 2 + noise.count)
        out.append(UInt8(noise.count >> 8))
        out.append(UInt8(noise.count & 0xff))
        out.append(noise)
        return out
    }

    /// Cut a byte stream into frames; a trailing partial frame is `rest`. A zero length throws.
    public static func decode(_ stream: Data) throws -> (frames: [Data], rest: Data) {
        let s = [UInt8](stream)
        var frames: [Data] = []
        var i = 0
        while s.count - i >= 2 {
            let len = Int(s[i]) << 8 | Int(s[i + 1])
            if len == 0 { throw BadFrame() }
            if s.count - i - 2 < len { break }
            frames.append(Data(s[(i + 2)..<(i + 2 + len)]))
            i += 2 + len
        }
        return (frames, Data(s[i...]))
    }
}

/// A stateful reader over a socket's chunks. One growing buffer and an offset: every byte is
/// copied in once and out once, so a peer that trickles a frame one byte at a time costs linear
/// work (`copied` counts the bytes moved, for the test).
public struct PeerFrameReader: Sendable {
    private var buf = [UInt8](repeating: 0, count: 1024)
    private var start = 0
    private var end = 0
    public private(set) var copied = 0

    public init() {}

    /// The frames the chunk completes. Throws `PeerFrame.BadFrame` after a zero length; the reader
    /// is then empty and the caller closes the session.
    public mutating func push(_ chunk: Data) throws -> [Data] {
        if end + chunk.count > buf.count {
            let live = end - start
            let need = live + chunk.count
            var cap = buf.count
            while cap < need { cap *= 2 }
            var next = cap == buf.count ? buf : [UInt8](repeating: 0, count: cap)
            for k in 0..<live { next[k] = buf[start + k] }
            copied += live
            buf = next
            start = 0
            end = live
        }
        for (k, b) in chunk.enumerated() { buf[end + k] = b }
        end += chunk.count
        copied += chunk.count
        var frames: [Data] = []
        while end - start >= 2 {
            let len = Int(buf[start]) << 8 | Int(buf[start + 1])
            if len == 0 {
                start = 0
                end = 0
                throw PeerFrame.BadFrame()
            }
            if end - start - 2 < len { break }
            frames.append(Data(buf[(start + 2)..<(start + 2 + len)]))
            copied += len
            start += 2 + len
        }
        if start == end {
            start = 0
            end = 0
        }
        return frames
    }
}
