// @pkey-feature packs.apply.delta packs.apply.full
//
// The libzstd backend's traps (plans/P4-01.md §2.7 rules 3 and 5; PARITY §6.3; notes/A7 §7):
//
//   * a `--patch-from` frame over a base that starts with the dictionary magic `37 A4 30 EC`
//     decodes through the raw-content prefix (`ZSTD_DCtx_refPrefix` never auto-detects a
//     dictionary), while the appliers still refuse such a base (CI never publishes one);
//   * a frame whose header declares a window over 128 MiB decodes once `windowLogMax` allows it,
//     and the appliers' header check — not the decoder — refuses it when `memBytes` does not;
//   * the start-up probe, and the streaming decode `applyFull` uses.

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest
import libzstd

final class PackZstdTests: XCTestCase {
    /// `ZSTD_compress2` over `src` with `prefix` referenced as raw content.
    private func compress(_ src: [UInt8], prefix: [UInt8]) throws -> [UInt8] {
        let cctx = try XCTUnwrap(ZSTD_createCCtx())
        defer { ZSTD_freeCCtx(cctx) }
        var out = [UInt8](repeating: 0, count: ZSTD_compressBound(src.count))
        let n = src.withUnsafeBytes { s in
            prefix.withUnsafeBytes { p in
                out.withUnsafeMutableBytes { d -> Int in
                    _ = ZSTD_CCtx_refPrefix(cctx, p.baseAddress, p.count)
                    return ZSTD_compress2(cctx, d.baseAddress, d.count, s.baseAddress, s.count)
                }
            }
        }
        XCTAssertEqual(ZSTD_isError(n), 0)
        return Array(out[0..<n])
    }

    private func payloadDeltaVariant(target: [UInt8], base: [UInt8], frame: [UInt8], memBytes: Int) throws -> PackVariant {
        try XCTUnwrap(
            PackVariant(
                json: .object([
                    "variant": .object([:]),
                    "payload": .object(["size": .int(target.count), "sha256": .string(sha256Of(target))]),
                    "full": .object([
                        "sha256": .string(sha256Of(frame)), "bytes": .int(1), "size": .int(target.count),
                        "codec": .string("zstd"),
                    ]),
                    "files": .object([
                        "format": .string("pkey-files/1"), "layout": .string("container"),
                        "sha256": .string(sha256Of([1])), "bytes": .int(1), "size": .int(1), "codec": .string("zstd"),
                    ]),
                    "deltas": .array([
                        .object([
                            "method": .string("zstd-patch-from"), "scope": .string("payload"),
                            "from": .string(sha256Of(base)), "memBytes": .int(memBytes),
                            "artifact": .object(["sha256": .string(sha256Of(frame)), "bytes": .int(frame.count)]),
                        ])
                    ]),
                ])))
    }

    func testABaseStartingWithTheDictionaryMagicDecodesAsARawPrefixButTheApplierRefusesIt() throws {
        var base: [UInt8] = [0x37, 0xa4, 0x30, 0xec]
        base += Array(String(repeating: "a base that happens to start with the zstd dictionary magic\n", count: 40).utf8)
        var target = base
        target.replaceSubrange(100..<110, with: Array("CHANGED!!!".utf8))
        target += Array("and a tail\n".utf8)
        let frame = try compress(target, prefix: base)
        let wlm = try XCTUnwrap(windowLogMax(base.count + target.count))
        XCTAssertTrue(windowAllowed(frame, memBytes: base.count + target.count))

        // The raw-content prefix decoder handles it.
        let out = try LibZstd().decodeWithPrefix(frame, prefix: base, size: target.count, windowLogMax: wlm)
        XCTAssertEqual(out, target)

        // The applier refuses it before any decoder sees it (rule 5).
        let variant = try payloadDeltaVariant(target: target, base: base, frame: frame, memBytes: base.count + target.count)
        let r = applyDelta(variant, 0, base: MemorySource(base), ApplyPorts(objects: { _ in MemorySource(frame) }, zstd: LibZstd()))
        XCTAssertEqual(r.verdict, .failed(error: ErrorCode.deltaApplyFailed, path: nil))

        // The same delta over a base without the magic applies.
        let plainBase = Array(base.dropFirst(4))
        var plainTarget = plainBase
        plainTarget += Array("tail\n".utf8)
        let plainFrame = try compress(plainTarget, prefix: plainBase)
        let ok = applyDelta(
            try payloadDeltaVariant(
                target: plainTarget, base: plainBase, frame: plainFrame, memBytes: plainBase.count + plainTarget.count),
            0, base: MemorySource(plainBase), ApplyPorts(objects: { _ in MemorySource(plainFrame) }, zstd: LibZstd()))
        XCTAssertEqual(ok.verdict, .container(sha256: sha256Of(plainTarget), size: plainTarget.count, counters: nil))
    }

    /// A hand-assembled frame: no content size, a Window_Descriptor of 2^28 (256 MiB), one raw
    /// last block.
    private func bigWindowFrame(_ content: [UInt8]) -> [UInt8] {
        let n = content.count
        let blockHeader = (n << 3) | 1  // Last_Block, Raw_Block, Block_Size
        return [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x90]
            + [UInt8(blockHeader & 0xff), UInt8((blockHeader >> 8) & 0xff), UInt8((blockHeader >> 16) & 0xff)]
            + content
    }

    func testAFrameWithAWindowOver128MiBDecodesWhenWindowLogMaxAllowsIt() throws {
        let content = Array("a small payload inside a frame that declares a 256 MiB window\n".utf8)
        let frame = bigWindowFrame(content)
        XCTAssertEqual(frameWindow(frame), 1 << 28)
        XCTAssertGreaterThan(frameWindow(frame)!, 128 << 20)
        // libzstd decodes it once windowLogMax admits the window.
        XCTAssertEqual(try LibZstd().decodeWithPrefix(frame, prefix: [1, 2, 3], size: content.count, windowLogMax: 28), content)

        // Through the applier: memBytes 2^28 passes the header check and decodes.
        let base = Array("an unrelated base\n".utf8)
        let ok = applyDelta(
            try payloadDeltaVariant(target: content, base: base, frame: frame, memBytes: 1 << 28), 0,
            base: MemorySource(base), ApplyPorts(objects: { _ in MemorySource(frame) }, zstd: LibZstd()))
        XCTAssertEqual(ok.verdict, .container(sha256: sha256Of(content), size: content.count, counters: nil))

        // A smaller memBytes is refused by the header check itself, whatever the decoder would do.
        let refused = applyDelta(
            try payloadDeltaVariant(target: content, base: base, frame: frame, memBytes: 1 << 27), 0,
            base: MemorySource(base), ApplyPorts(objects: { _ in MemorySource(frame) }, zstd: LibZstd()))
        XCTAssertEqual(refused.verdict, .failed(error: ErrorCode.deltaApplyFailed, path: nil))
    }

    func testTheProbeAndTheBackendInfo() {
        XCTAssertTrue(ZstdProbe.passes(LibZstd()))
        let (z, info) = selectZstd()
        XCTAssertEqual(z.pointerBits, 31)
        XCTAssertEqual(info.patchMethods, ["zstd-patch-from"])
        XCTAssertEqual(libzstdVersion, "1.5.7")
        XCTAssertEqual(info.library, "libzstd 1.5.7")
    }

    func testStreamingDecodeMatchesOneShotAndRefusesAWrongSize() throws {
        let content = (0..<300_000).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ ($0 >> 9)) }
        let frame = try compress(content, prefix: [])
        var got: [UInt8] = []
        try LibZstd().decodeStream(MemorySource(frame), size: content.count) { got += $0 }
        XCTAssertEqual(got, content)
        XCTAssertThrowsError(try LibZstd().decodeStream(MemorySource(frame), size: content.count - 1) { _ in })
        XCTAssertThrowsError(try LibZstd().decodeStream(MemorySource(frame), size: content.count + 1) { _ in })
        XCTAssertThrowsError(try LibZstd().decode(frame, size: content.count + 1))
    }
}
