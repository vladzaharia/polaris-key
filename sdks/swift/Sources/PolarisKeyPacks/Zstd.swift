// The Swift zstd backend for packs (plans/P4-01.md §2.7, §5 "zstd per SDK"; PARITY §6.2).
//
// Apple's Compression framework has no zstd, so this links libzstd from the official
// facebook/zstd SwiftPM package, pinned to 1.5.7:
//
//   * plain frames: `ZSTD_decompressDCtx` with `ZSTD_d_windowLogMax` = `windowLogMax(size)`, the
//     output exactly `size` bytes; a whole `full` payload streams through `ZSTD_decompressStream`;
//   * `--patch-from` frames: `ZSTD_DCtx_refPrefix` over the whole base (raw-content prefix mode,
//     never dictionary auto-detection) with the applier's `windowLogMax`.
//
// The window limit is the appliers' header check (`frameWindow` / `windowAllowed`), run before
// every prefix decode whatever the decoder: libzstd's own `windowLogMax` is set too, but one-shot
// decoding into a full-size buffer does not enforce it, so it is never relied on. At start-up the
// backend decodes a tiny built-in prefix vector; `zstd-patch-from` is advertised only when that
// decodes byte for byte.

import Foundation
import PolarisKeyCore
import libzstd

/// libzstd's version string (`ZSTD_versionString()`), for diagnostics and the runners.
public var libzstdVersion: String { String(cString: ZSTD_versionString()) }

/// A libzstd failure, with its error name.
public struct ZstdError: Error, Sendable, CustomStringConvertible {
    public let description: String
}

private func check(_ code: Int) throws -> Int {
    if ZSTD_isError(code) != 0 { throw ZstdError(description: String(cString: ZSTD_getErrorName(code))) }
    return code
}

/// libzstd as a `ZstdPort` (64-bit: P = 31).
public struct LibZstd: ZstdPort {
    public init() {}

    public var pointerBits: Int { MemoryLayout<Int>.size >= 8 ? 31 : 30 }

    public func decode(_ frame: [UInt8], size: Int) throws -> [UInt8] {
        try decodeOneShot(frame, prefix: nil, size: size, windowLogMax: windowLogMax(size, pointerBits) ?? 10)
    }

    public func decodeWithPrefix(_ frame: [UInt8], prefix: [UInt8], size: Int, windowLogMax wlm: Int) throws
        -> [UInt8]
    {
        try decodeOneShot(frame, prefix: prefix, size: size, windowLogMax: wlm)
    }

    private func decodeOneShot(_ frame: [UInt8], prefix: [UInt8]?, size: Int, windowLogMax wlm: Int) throws
        -> [UInt8]
    {
        guard size >= 0 else { throw ZstdError(description: "negative size") }
        guard let dctx = ZSTD_createDCtx() else { throw ZstdError(description: "no context") }
        defer { ZSTD_freeDCtx(dctx) }
        _ = try check(ZSTD_DCtx_setParameter(dctx, ZSTD_d_windowLogMax, Int32(wlm)))
        var out = [UInt8](repeating: 0, count: Swift.max(size, 1))
        let n: Int = try frame.withUnsafeBytes { src in
            try out.withUnsafeMutableBytes { dst in
                func run() throws -> Int {
                    try check(ZSTD_decompressDCtx(dctx, dst.baseAddress, size, src.baseAddress, src.count))
                }
                guard let prefix else { return try run() }
                return try prefix.withUnsafeBytes { p in
                    // The prefix is referenced for the next frame only, and must outlive it.
                    _ = try check(ZSTD_DCtx_refPrefix(dctx, p.baseAddress, p.count))
                    return try run()
                }
            }
        }
        guard n == size else { throw ZstdError(description: "length \(n) is not \(size)") }
        if out.count != size { out.removeLast(out.count - size) }
        return out
    }

    public var canStream: Bool { true }

    public func decodeStream(_ frame: any ByteSource, size: Int, onChunk: ([UInt8]) throws -> Void) throws {
        guard let ds = ZSTD_createDStream() else { throw ZstdError(description: "no stream") }
        defer { ZSTD_freeDStream(ds) }
        _ = try check(ZSTD_DCtx_setParameter(ds, ZSTD_d_windowLogMax, Int32(windowLogMax(size, pointerBits) ?? 10)))
        let outCap = ZSTD_DStreamOutSize()
        var outBuf = [UInt8](repeating: 0, count: outCap)
        var total = 0
        var at = 0
        var last = 1
        while at < frame.size {
            let chunk = try frame.read(at, Swift.min(READ_CHUNK, frame.size - at))
            if chunk.isEmpty { break }
            at += chunk.count
            try chunk.withUnsafeBytes { src in
                var input = ZSTD_inBuffer(src: src.baseAddress, size: src.count, pos: 0)
                while input.pos < input.size {
                    var produced = 0
                    try outBuf.withUnsafeMutableBytes { dst in
                        var output = ZSTD_outBuffer(dst: dst.baseAddress, size: dst.count, pos: 0)
                        last = try check(ZSTD_decompressStream(ds, &output, &input))
                        produced = output.pos
                    }
                    if produced > 0 {
                        total += produced
                        if total > size { throw ZstdError(description: "overrun") }
                        try onChunk(Array(outBuf[0..<produced]))
                    }
                }
            }
        }
        // Flush whatever the decoder still holds.
        while last != 0 {
            var produced = 0
            try outBuf.withUnsafeMutableBytes { dst in
                var output = ZSTD_outBuffer(dst: dst.baseAddress, size: dst.count, pos: 0)
                var input = ZSTD_inBuffer(src: nil, size: 0, pos: 0)
                last = try check(ZSTD_decompressStream(ds, &output, &input))
                produced = output.pos
            }
            if produced == 0 { break }
            total += produced
            if total > size { throw ZstdError(description: "overrun") }
            try onChunk(Array(outBuf[0..<produced]))
        }
        guard last == 0 else { throw ZstdError(description: "truncated frame") }
        guard total == size else { throw ZstdError(description: "length \(total) is not \(size)") }
    }
}

// ── The probe vector ───────────────────────────────────────────────────────────────────────
// A 432-byte base and a `zstd --patch-from` frame (zstd 1.5.7) that decodes over it to a 469-byte
// target: the same vector as the Node backend's.

public enum ZstdProbe {
    public static let base: [UInt8] = Array(
        (0..<6).map { "polaris key probe line \(String(format: "%03d", $0)): the quick brown fox jumps over the lazy dog\n" }
            .joined().utf8)
    public static let frame: [UInt8] = hexBytes(
        "28b52ffd64d500150200540230736c65657079206361740a313278797a357461696c20616464656420666f70726f62650a0a00db6bf840c481b4bbab0c04d021809e01ca9ab04cf0c8b204205fff9e32"
    )
    public static let size = 469
    public static let sha256 = "cb0e436ee45ab5d453e18dd20612ce36c56e371dbf940bc5cabd20fd0ef27c27"
    /// base + target, so `windowLogMax` is 10.
    public static let memBytes = 901

    /// Whether a prefix decoder turns the probe vector into its target, byte for byte.
    public static func passes(_ zstd: any ZstdPort) -> Bool {
        guard let wlm = windowLogMax(memBytes),
            let out = try? zstd.decodeWithPrefix(frame, prefix: base, size: size, windowLogMax: wlm)
        else { return false }
        return out.count == size && sha256Of(out) == sha256
    }
}

/// Bytes from lowercase hex (no validation beyond pairs).
public func hexBytes(_ hex: String) -> [UInt8] {
    var out: [UInt8] = []
    var it = hex.utf8.makeIterator()
    func nibble(_ c: UInt8) -> UInt8 { c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x57 }
    while let a = it.next(), let b = it.next() { out.append(nibble(a) << 4 | nibble(b)) }
    return out
}

/// Which decoder serves each kind of frame, for diagnostics and `caps`.
public struct PackZstdInfo: Sendable, Equatable {
    /// `libzstd <version>`.
    public var library: String
    /// `["zstd-patch-from"]` when the prefix decoder decodes the probe, else empty.
    public var patchMethods: [String]
}

/// This process's zstd backend (probed once per call).
public func selectZstd() -> (zstd: any ZstdPort, info: PackZstdInfo) {
    let z = LibZstd()
    return (z, PackZstdInfo(library: "libzstd \(libzstdVersion)", patchMethods: ZstdProbe.passes(z) ? ["zstd-patch-from"] : []))
}
