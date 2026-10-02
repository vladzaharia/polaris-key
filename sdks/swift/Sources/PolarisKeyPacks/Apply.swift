// The appliers (plans/P4-01.md §2.9; notes/A7 §3.4): `applyFull`, `applyDelta` and `applyFile`,
// over injected ports. `content/cases.json#applyCases` pins every verdict and counter. The first
// failure is the verdict, and nothing throws: a port that throws is the failing step's code.
// client-core `packs/apply.ts` is the reference.
//
// Verify before use: a stored object's length and SHA-256 are checked against its ref before a
// byte is decoded, an installed base's SHA-256 against the delta's `from` before it is used, and
// the output's SHA-256 before it is reported. Every `zstd-patch-from` frame passes §2.7 rule 3's
// window check (`windowAllowed`, with the decoder's own P) before it is decoded, whichever
// decoder the host injected, and a base that starts with the zstd dictionary magic is refused
// (rule 5).

import Foundation
import PolarisKeyCore

/// The counters of the `file` strategy and of a `files` set (§2.9).
public struct ApplyCounters: Sendable, Equatable {
    public var reusedFiles = 0
    public var deltaFiles = 0
    public var blobFiles = 0
    /// The bytes of the objects fetched for the strategy, except the index and gaps.
    public var downloadedBytes = 0
}

/// An applier's verdict.
public enum ApplyVerdict: Sendable, Equatable {
    /// A rebuilt container: its payload hash and size.
    case container(sha256: String, size: Int, counters: ApplyCounters?)
    /// A rebuilt tree: its file count, total size and `treeDigest`.
    case tree(files: Int, bytes: Int, treeDigest: String, counters: ApplyCounters?)
    case failed(error: String, path: String?)

    public var ok: Bool {
        if case .failed = self { return false }
        return true
    }

    /// The verdict as the corpus writes it.
    public var json: JSONValue {
        var o: [String: JSONValue]
        var c: ApplyCounters?
        switch self {
        case .container(let sha, let size, let counters):
            o = ["ok": .bool(true), "sha256": .string(sha), "size": .int(size)]
            c = counters
        case .tree(let files, let bytes, let digest, let counters):
            o = [
                "ok": .bool(true), "files": .int(files), "bytes": .int(bytes),
                "treeDigest": .string(digest),
            ]
            c = counters
        case .failed(let error, let path):
            o = ["ok": .bool(false), "error": .string(error)]
            if let path { o["path"] = .string(path) }
        }
        if let c {
            o["reusedFiles"] = .int(c.reusedFiles)
            o["deltaFiles"] = .int(c.deltaFiles)
            o["blobFiles"] = .int(c.blobFiles)
            o["downloadedBytes"] = .int(c.downloadedBytes)
        }
        return .object(o)
    }
}

/// An applier's answer: the verdict, and the target index when one was read.
public struct ApplyResult: Sendable, Equatable {
    public var verdict: ApplyVerdict
    public var index: FilesIndexDoc?
}

/// What the appliers read from and write to.
public struct ApplyPorts {
    /// The stored objects the strategy fetched, by the SHA-256 of their stored bytes.
    public var objects: ObjectPort
    public var zstd: any ZstdPort
    /// Where a container payload is written (offset 0 onward). Nil: discarded.
    public var sink: (any ByteSink)?
    /// Where a tree's files are written. Nil: discarded.
    public var tree: (any TreeSink)?

    public init(
        objects: @escaping ObjectPort, zstd: any ZstdPort, sink: (any ByteSink)? = nil,
        tree: (any TreeSink)? = nil
    ) {
        self.objects = objects
        self.zstd = zstd
        self.sink = sink
        self.tree = tree
    }
}

private func fail(_ error: String, _ path: String? = nil) -> ApplyResult {
    ApplyResult(verdict: .failed(error: error, path: path), index: nil)
}

private func startsWithDictionaryMagic(_ b: [UInt8]) -> Bool {
    b.count >= 4 && b[0] == 0x37 && b[1] == 0xa4 && b[2] == 0x30 && b[3] == 0xec
}

/// One raw-prefix decode behind the window check (§2.7 rules 3 and 5). Nil on refusal.
func prefixDecode(
    _ zstd: any ZstdPort, _ frame: [UInt8], _ base: [UInt8], _ size: Int, _ memBytes: Int
) -> [UInt8]? {
    if startsWithDictionaryMagic(base) { return nil }
    guard let wlm = windowLogMax(memBytes, zstd.pointerBits),
        windowAllowed(frame, memBytes: memBytes, p: zstd.pointerBits)
    else { return nil }
    return try? zstd.decodeWithPrefix(frame, prefix: base, size: size, windowLogMax: wlm)
}

/// Read and parse the target index (§2.7), refusing an oversized one before reading it.
private func readIndex(_ variant: PackVariant, _ ports: ApplyPorts) -> ParseFilesIndexResult {
    let files = variant.files
    var stored: [UInt8] = []
    if files.size <= MAX_FILES_INDEX_BYTES, files.bytes <= MAX_FILES_INDEX_BYTES {
        if let src = (try? ports.objects(files.sha256)) ?? nil, src.size == files.bytes {
            stored = (try? readAll(src)) ?? []
        }
    }
    let zstd = ports.zstd
    return parseFilesIndex(
        stored, ref: files, payload: variant.payload,
        decode: { try zstd.decode($0, size: $1) })
}

/// Write a source's bytes to a sink at `at`, feeding a hasher; returns the bytes written.
private func copyThrough(
    _ source: any ByteSource, _ sink: (any ByteSink)?, _ at: Int, _ hasher: inout PackHasher
) throws -> Int {
    var n = 0
    while n < source.size {
        let chunk = try source.read(n, Swift.min(READ_CHUNK, source.size - n))
        if chunk.isEmpty { break }
        hasher.update(chunk)
        try sink?.write(at + n, chunk)
        n += chunk.count
    }
    return n
}

/// `applyFull` (§2.9): a tree first validates its index (§2.7's codes). Then, before decoding,
/// the `full` ref must be usable with `full.size == payload.size`, and the stored length and
/// SHA-256 must equal the ref → else `full-corrupt`; the decode must give exactly `full.size`
/// bytes → `full-corrupt`. A container's bytes must hash to `payload.sha256`; a tree's are split
/// by entry sizes in index order and every file's SHA-256 checked → `full-corrupt`.
public func applyFull(_ variant: PackVariant, _ ports: ApplyPorts) -> ApplyResult {
    let payload = variant.payload
    var index: FilesIndexDoc?
    if variant.files.layout == "tree" {
        switch readIndex(variant, ports) {
        case .ok(let i): index = i
        case .refused(let e, let p): return fail(e, p)
        }
    }
    guard let full = variant.full, usableCodec(full.codec), full.size == payload.size else {
        return fail(ErrorCode.fullCorrupt)
    }
    guard let stored = (try? ports.objects(full.sha256)) ?? nil, stored.size == full.bytes else {
        return fail(ErrorCode.fullCorrupt)
    }
    do {
        // Stream the decode when the port can, so a large payload never sits in one buffer.
        if full.codec == "zstd" && ports.zstd.canStream {
            if try hashSource(stored) != full.sha256 { return fail(ErrorCode.fullCorrupt) }
            return streamFull(variant, index, stored, ports)
        }
        guard let out = openObject(stored, full, zstd: ports.zstd) else {
            return fail(ErrorCode.fullCorrupt)
        }
        guard let index else {
            if sha256Of(out) != payload.sha256 { return fail(ErrorCode.fullCorrupt) }
            try ports.sink?.write(0, out)
            return ApplyResult(
                verdict: .container(sha256: payload.sha256, size: out.count, counters: nil),
                index: nil)
        }
        var pos = 0
        for f in index.files {
            guard pos + f.size <= out.count else { return fail(ErrorCode.fullCorrupt) }
            let part = Array(out[pos..<(pos + f.size)])
            pos += f.size
            if sha256Of(part) != f.sha256 { return fail(ErrorCode.fullCorrupt) }
            try ports.tree?.writeFile(f.path, part)
        }
        return ApplyResult(
            verdict: .tree(
                files: index.files.count, bytes: out.count, treeDigest: treeDigest(index.files),
                counters: nil),
            index: index)
    } catch {
        return fail(ErrorCode.fullCorrupt)
    }
}

private struct Overrun: Error {}

/// `applyFull`'s streaming path: the frame's output arrives in order and is hashed (a
/// container) or split into files (a tree) as it comes.
private func streamFull(
    _ variant: PackVariant, _ index: FilesIndexDoc?, _ stored: any ByteSource, _ ports: ApplyPorts
) -> ApplyResult {
    let payload = variant.payload
    let size = variant.full!.size
    var total = 0
    guard let index else {
        var hasher = PackHasher()
        do {
            try ports.zstd.decodeStream(stored, size: size) { chunk in
                if total + chunk.count > size { throw Overrun() }
                hasher.update(chunk)
                try ports.sink?.write(total, chunk)
                total += chunk.count
            }
        } catch {
            return fail(ErrorCode.fullCorrupt)
        }
        if total != size || hasher.digest() != payload.sha256 { return fail(ErrorCode.fullCorrupt) }
        return ApplyResult(
            verdict: .container(sha256: payload.sha256, size: size, counters: nil), index: nil)
    }
    // A tree: walk the entries as the bytes arrive; each file is buffered alone.
    let files = index.files
    var i = 0
    var buffer: [UInt8] = []
    func flush() throws {
        while i < files.count && buffer.count >= files[i].size {
            let f = files[i]
            let part = Array(buffer[0..<f.size])
            buffer.removeFirst(f.size)
            if sha256Of(part) != f.sha256 { throw Overrun() }
            try ports.tree?.writeFile(f.path, part)
            i += 1
        }
    }
    do {
        try flush()  // zero-size files at the start
        try ports.zstd.decodeStream(stored, size: size) { chunk in
            if total + chunk.count > size { throw Overrun() }
            total += chunk.count
            buffer += chunk
            try flush()
        }
    } catch {
        return fail(ErrorCode.fullCorrupt)
    }
    if total != size || i != files.count { return fail(ErrorCode.fullCorrupt) }
    return ApplyResult(
        verdict: .tree(files: files.count, bytes: total, treeDigest: treeDigest(files), counters: nil),
        index: index)
}

/// `applyDelta` (`payload` scope, §2.9): the artifact against its ref →
/// `delta-artifact-mismatch`; the base's SHA-256 equals `from` → `delta-base-mismatch`; §2.7
/// rule 3's window check, then the raw-prefix decode, its length and its SHA-256 against
/// `payload` → `delta-apply-failed`. `skipBaseCheck` is the corpus's test-only switch.
public func applyDelta(
    _ variant: PackVariant, _ deltaIndex: Int, base: any ByteSource, _ ports: ApplyPorts,
    skipBaseCheck: Bool = false
) -> ApplyResult {
    let payload = variant.payload
    guard deltaIndex >= 0, deltaIndex < variant.deltas.count,
        case .payload(_, let from, let memBytes, let a) = variant.deltas[deltaIndex]
    else { return fail(ErrorCode.deltaArtifactMismatch) }
    do {
        guard let src = (try? ports.objects(a.sha256)) ?? nil, src.size == a.bytes else {
            return fail(ErrorCode.deltaArtifactMismatch)
        }
        let frame = try readAll(src)
        if frame.count != a.bytes || sha256Of(frame) != a.sha256 {
            return fail(ErrorCode.deltaArtifactMismatch)
        }
        let baseBytes = try readAll(base)
        if !skipBaseCheck && sha256Of(baseBytes) != from {
            return fail(ErrorCode.deltaBaseMismatch)
        }
        guard let out = prefixDecode(ports.zstd, frame, baseBytes, payload.size, memBytes),
            out.count == payload.size, sha256Of(out) == payload.sha256
        else { return fail(ErrorCode.deltaApplyFailed) }
        try ports.sink?.write(0, out)
        return ApplyResult(
            verdict: .container(sha256: payload.sha256, size: out.count, counters: nil), index: nil)
    } catch {
        return fail(ErrorCode.deltaApplyFailed)
    }
}

/// `applyFile` (§2.9), for the `file` strategy (`deltaIndex` nil) and for a `files`-scope set:
/// the target index (§2.7's codes), the gaps ref of a container (a failure is
/// `files-layout-mismatch`), the descriptor and data of a set (`delta-artifact-mismatch`). Then
/// for each target file in index order: reuse an installed file with the same SHA-256; else the
/// set's `delta` entry (no installed file with its `from` → `delta-base-mismatch {path}`; the
/// window check against the set's `memBytes`, then the decode → `delta-apply-failed {path}`);
/// else its `blob` entry, or for the `file` strategy the file's own blob by its ref (ref, decode
/// or hash → `file-corrupt {path}`); else `file-source-missing {path}`. A container's payload
/// SHA-256 → `payload-hash-mismatch`; a tree checks every file, reused ones included
/// (`file-corrupt {path}`), and reports its `treeDigest`.
public func applyFile(
    _ variant: PackVariant, _ deltaIndex: Int?, installed: [InstalledFile], _ ports: ApplyPorts
) -> ApplyResult {
    var current: (error: String, path: String?) = (ErrorCode.fileCorrupt, nil)
    do {
        let payload = variant.payload
        let index: FilesIndexDoc
        switch readIndex(variant, ports) {
        case .ok(let i): index = i
        case .refused(let e, let p): return fail(e, p)
        }
        let container = index.layout == "container"

        var gaps: [UInt8] = []
        if container {
            guard let g = variant.files.gaps,
                let opened = openObject((try? ports.objects(g.sha256)) ?? nil, g, zstd: ports.zstd)
            else { return fail(ErrorCode.filesLayoutMismatch) }
            gaps = opened
        }

        var entries: [String: PatchEntry] = [:]
        var data: (any ByteSource)?
        var memBytes = 0
        var downloaded = 0
        var usingSet = false
        if let deltaIndex {
            guard deltaIndex >= 0, deltaIndex < variant.deltas.count,
                case .files(let method, let from, let mem, let patchRef, let dataRef) =
                    variant.deltas[deltaIndex]
            else { return fail(ErrorCode.deltaArtifactMismatch) }
            usingSet = true
            memBytes = mem
            let patchSrc = (try? ports.objects(patchRef.sha256)) ?? nil
            guard
                let patch = parsePatch(
                    patchSrc, method: method, from: from, patch: patchRef, data: dataRef,
                    targetPayloadSha256: payload.sha256, target: index, zstd: ports.zstd)
            else { return fail(ErrorCode.deltaArtifactMismatch) }
            guard let d = (try? ports.objects(dataRef.sha256)) ?? nil, d.size == dataRef.bytes,
                (try? hashSource(d)) == dataRef.sha256
            else { return fail(ErrorCode.deltaArtifactMismatch) }
            data = d
            downloaded = patchRef.bytes + dataRef.bytes
            for e in patch.entries { entries[e.path] = e }
        }

        var have: [String: InstalledFile] = [:]
        for f in installed where have[f.sha256] == nil { have[f.sha256] = f }
        var counters = ApplyCounters()

        // A container is written as it is rebuilt (gap, file, gap, …) and hashed whole; a tree's
        // produced files are written at once, its reused ones after the second pass verifies them.
        var hasher = PackHasher()
        var pos = 0
        var gp = 0
        var written = 0
        var reused: [InstalledFile?] = []

        for f in index.files {
            current = (ErrorCode.fileCorrupt, f.path)
            let reuse = have[f.sha256]
            var bytes: [UInt8]?
            if reuse != nil {
                counters.reusedFiles += 1
            } else if usingSet {
                guard let e = entries[f.path] else { return fail(ErrorCode.fileSourceMissing, f.path) }
                let slice = try data!.read(e.offset, e.length)
                if e.op == "delta" {
                    current = (ErrorCode.deltaApplyFailed, f.path)
                    guard let b = have[e.from!] else { return fail(ErrorCode.deltaBaseMismatch, f.path) }
                    let baseBytes = try readAll(b.source)
                    if sha256Of(baseBytes) != e.from { return fail(ErrorCode.deltaBaseMismatch, f.path) }
                    guard let out = prefixDecode(ports.zstd, slice, baseBytes, f.size, memBytes),
                        out.count == f.size, sha256Of(out) == f.sha256
                    else { return fail(ErrorCode.deltaApplyFailed, f.path) }
                    bytes = out
                    counters.deltaFiles += 1
                } else {
                    var out: [UInt8]? = slice
                    if e.codec == "zstd" { out = try? ports.zstd.decode(slice, size: f.size) }
                    guard let o = out, o.count == f.size, sha256Of(o) == f.sha256 else {
                        return fail(ErrorCode.fileCorrupt, f.path)
                    }
                    bytes = o
                    counters.blobFiles += 1
                }
            } else {
                guard let stored = (try? ports.objects(f.blob.sha256)) ?? nil else {
                    return fail(ErrorCode.fileSourceMissing, f.path)
                }
                let ref = PackObjectRef(
                    sha256: f.blob.sha256, bytes: f.blob.bytes, size: f.size, codec: f.blob.codec)
                guard let out = openObject(stored, ref, zstd: ports.zstd), sha256Of(out) == f.sha256
                else { return fail(ErrorCode.fileCorrupt, f.path) }
                bytes = out
                counters.blobFiles += 1
                downloaded += stored.size
            }

            if container {
                let offset = f.offset ?? 0
                let g = offset - pos
                // A gaps object shorter than the layout needs yields fewer bytes here, and the
                // payload hash then refuses the result (as client-core's `subarray` does).
                let lo = Swift.min(Swift.max(gp, 0), gaps.count)
                let hi = Swift.min(Swift.max(gp + g, lo), gaps.count)
                let gap = Array(gaps[lo..<hi])
                hasher.update(gap)
                try ports.sink?.write(written, gap)
                written += gap.count
                gp += g
                let src: any ByteSource = bytes.map { memorySource($0) } ?? reuse!.source
                written += try copyThrough(sliceSource(src, 0, f.size), ports.sink, written, &hasher)
                pos = offset + f.size
            } else {
                if let bytes { try ports.tree?.writeFile(f.path, bytes) }
                reused.append(bytes == nil ? reuse : nil)
            }
        }

        counters.downloadedBytes = downloaded
        if !container {
            for (i, f) in index.files.enumerated() {
                guard let r = reused[i] else { continue }
                let b = try readAll(sliceSource(r.source, 0, f.size))
                if b.count != f.size || sha256Of(b) != f.sha256 { return fail(ErrorCode.fileCorrupt, f.path) }
                try ports.tree?.writeFile(f.path, b)
            }
            return ApplyResult(
                verdict: .tree(
                    files: index.files.count, bytes: index.files.reduce(0) { $0 + $1.size },
                    treeDigest: treeDigest(index.files), counters: counters),
                index: index)
        }
        let trailing = gp < gaps.count ? Array(gaps[gp...]) : []
        hasher.update(trailing)
        try ports.sink?.write(written, trailing)
        written += trailing.count
        if hasher.digest() != payload.sha256 { return fail(ErrorCode.payloadHashMismatch) }
        return ApplyResult(
            verdict: .container(sha256: payload.sha256, size: written, counters: counters),
            index: index)
    } catch {
        return fail(current.error, current.path)
    }
}
