// Pack fixtures for the Swift pack tests (a port of client-core's `test/packFixtures.ts`):
// `files.tree` pack records signed with the corpus's own release key (`djdl-release-test-2026`,
// never a production key), their objects stored raw (`codec: none`, so no compressor is needed),
// a fake byte server with Range/If-Range, and a `files` delta set whose one `delta` entry is the
// probe vector (a real `zstd --patch-from` frame over a 432-byte base).

import CryptoKit
import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

enum PackFixtures {
    static let product = "djdl"
    static let releaseKid = "djdl-release-test-2026"
    static let productKid = "pkey-test-prod-2026"

    private struct Key: Decodable {
        let kid: String
        let publicKeyRaw: String
        let privateKeyPkcs8Pem: String
    }
    private struct Keys: Decodable { let keys: [Key] }

    private static let keys: [Key] = {
        (try? CorpusBundleLoader.load(Keys.self, "cases").keys) ?? []
    }()

    private static func key(_ kid: String) -> Key { keys.first { $0.kid == kid }! }

    static var releaseKeys: TrustSet { [releaseKid: key(releaseKid).publicKeyRaw] }
    static var productTrust: TrustSet { [productKid: key(productKid).publicKeyRaw] }

    /// The release key's private half: the last 32 bytes of its PKCS#8 DER are the Ed25519 seed.
    static var releaseSigner: Curve25519.Signing.PrivateKey {
        let pem = key(releaseKid).privateKeyPkcs8Pem
        let b64 = pem.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
        let der = Data(base64Encoded: b64)!
        return try! Curve25519.Signing.PrivateKey(rawRepresentation: der.suffix(32))
    }

    static func sha(_ b: [UInt8]) -> String { sha256Of(b) }
    static func sha(_ s: String) -> String { sha256Of(Array(s.utf8)) }

    /// Any corpus key's private half (the last 32 bytes of its PKCS#8 DER are the seed).
    static func signer(_ kid: String) -> Curve25519.Signing.PrivateKey {
        let pem = key(kid).privateKeyPkcs8Pem
        let b64 = pem.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
        return try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(base64Encoded: b64)!.suffix(32))
    }

    /// Sign `payload` with any corpus key and `typ`.
    static func sign(_ payload: JSONValue, kid: String, typ: String) -> String {
        let header = #"{"alg":"EdDSA","typ":"\#(typ)","kid":"\#(kid)"}"#
        let input = Base64URL.encode(string: header) + "." + Base64URL.encode(string: canonicalJSON(payload))
        let sig = try! signer(kid).signature(for: Data(input.utf8))
        return input + "." + Base64URL.encode(sig)
    }

    static func sign(_ payload: JSONValue) -> String {
        let header = #"{"alg":"EdDSA","typ":"pkey-release+jws","kid":"\#(releaseKid)"}"#
        let input = Base64URL.encode(string: header) + "." + Base64URL.encode(string: canonicalJSON(payload))
        let sig = try! releaseSigner.signature(for: Data(input.utf8))
        return input + "." + Base64URL.encode(sig)
    }

    /// The probe vector (zstd 1.5.7 `--patch-from`): base, frame and target.
    static let probeBase = ZstdProbe.base
    static let probeFrame = ZstdProbe.frame
    static let probeTarget: [UInt8] = Array(
        ((0..<6).map {
            "polaris key probe line \($0 == 3 ? "xyz" : String(format: "%03d", $0)): the quick brown fox jumps over the sleepy cat\n"
        }.joined() + "tail added for the probe\n").utf8)
}

struct TreePack: Sendable {
    let packId: String
    let version: String
    let seq: Int
    let jws: String
    let recordSha256: String
    let treeDigest: String
    let size: Int
    /// Every stored object by its SHA-256.
    let objects: [String: [UInt8]]
    let files: [String: [UInt8]]
    let indexSha256: String
    let fullSha256: String
}

/// A `files.tree` pack release over `files`, every object raw; optionally a `files` delta set
/// from `from`, whose entries are `delta` (the probe frame, when the base file is the probe base)
/// or raw `blob` entries.
func treePack(
    packId: String, version: String, seq: Int, files rawFiles: [String: Any], from: TreePack? = nil,
    activation: String = "hot", entitlement: String? = nil, type: String = "files.tree",
    indexBytes: Int? = nil, recordExtra: [String: JSONValue] = [:]
) -> TreePack {
    var files: [String: [UInt8]] = [:]
    for (p, b) in rawFiles { files[p] = (b as? [UInt8]) ?? Array((b as! String).utf8) }
    let sha = PackFixtures.sha as ([UInt8]) -> String
    let paths = files.keys.sorted { compareUTF8Bytes($0, $1) < 0 }
    let entries: [JSONValue] = paths.map { p in
        let b = files[p]!
        return .object([
            "path": .string(p), "size": .int(b.count), "sha256": .string(sha(b)),
            "blob": .object(["sha256": .string(sha(b)), "bytes": .int(b.count), "codec": .string("none")]),
        ])
    }
    let digest = treeDigest(paths.map { TreeFile(path: $0, size: files[$0]!.count, sha256: sha(files[$0]!)) })
    let size = paths.reduce(0) { $0 + files[$1]!.count }
    let index = Array(
        canonicalJSON(
            .object([
                "format": .string("pkey-files/1"), "layout": .string("tree"),
                "payload": .object(["size": .int(size), "sha256": .string(digest)]), "files": .array(entries),
            ])
        ).utf8)
    let full = paths.flatMap { files[$0]! }
    var objects: [String: [UInt8]] = [sha(index): index, sha(full): full]
    for p in paths { objects[sha(files[p]!)] = files[p]! }

    var deltas: [JSONValue] = []
    if let from {
        let baseHashes = Set(from.files.values.map(sha))
        var data: [UInt8] = []
        var memBytes = 1
        var pe: [JSONValue] = []
        for p in paths {
            let b = files[p]!
            if baseHashes.contains(sha(b)) { continue }
            if let base = from.files[p], sha(base) == sha(PackFixtures.probeBase), sha(b) == sha(PackFixtures.probeTarget) {
                pe.append(
                    .object([
                        "path": .string(p), "op": .string("delta"), "from": .string(sha(base)), "to": .string(sha(b)),
                        "size": .int(b.count), "offset": .int(data.count), "length": .int(PackFixtures.probeFrame.count),
                    ]))
                data += PackFixtures.probeFrame
                memBytes = max(memBytes, base.count + b.count)
            } else {
                pe.append(
                    .object([
                        "path": .string(p), "op": .string("blob"), "to": .string(sha(b)), "size": .int(b.count),
                        "codec": .string("none"), "offset": .int(data.count), "length": .int(b.count),
                    ]))
                data += b
                memBytes = max(memBytes, b.count)
            }
        }
        let patch = Array(
            canonicalJSON(
                .object([
                    "format": .string("pkey-patch/1"), "scope": .string("files"), "method": .string("zstd-patch-from"),
                    "from": .string(from.treeDigest), "to": .string(digest),
                    "data": .object(["sha256": .string(sha(data)), "bytes": .int(data.count)]), "entries": .array(pe),
                ])
            ).utf8)
        if !data.isEmpty {
            objects[sha(patch)] = patch
            objects[sha(data)] = data
            deltas.append(
                .object([
                    "method": .string("zstd-patch-from"), "scope": .string("files"), "from": .string(from.treeDigest),
                    "memBytes": .int(memBytes),
                    "patch": .object([
                        "sha256": .string(sha(patch)), "bytes": .int(patch.count), "size": .int(patch.count),
                        "codec": .string("none"),
                    ]),
                    "data": .object(["sha256": .string(sha(data)), "bytes": .int(data.count)]),
                ]))
        }
    }

    var variant: [String: JSONValue] = [
        "variant": .object([:]), "payload": .object(["size": .int(size), "sha256": .string(digest)]),
        "full": .object([
            "sha256": .string(sha(full)), "bytes": .int(full.count), "size": .int(full.count), "codec": .string("none"),
        ]),
        "files": .object([
            "format": .string("pkey-files/1"), "layout": .string("tree"), "sha256": .string(sha(index)),
            "bytes": .int(indexBytes ?? index.count), "size": .int(indexBytes ?? index.count), "codec": .string("none"),
        ]),
    ]
    if !deltas.isEmpty { variant["deltas"] = .array(deltas) }
    var record: [String: JSONValue] = [
        "schemaVersion": .int(1), "aud": .string(PackFixtures.product), "deliverable": .string(packId),
        "kind": .string("pack"), "version": .string(version), "seq": .int(seq), "issuedAt": .int(1_759_300_000 + seq),
        "type": .string(type), "formatVersion": .int(1), "handler": .object(["activation": .string(activation)]),
        "variants": .array([.object(variant)]),
    ]
    if let entitlement { record["entitlement"] = .string(entitlement) }
    // Record-level members beyond the claims (P4-20's reserved `provides`).
    for (k, v) in recordExtra { record[k] = v }
    let jws = PackFixtures.sign(.object(record))
    return TreePack(
        packId: packId, version: version, seq: seq, jws: jws, recordSha256: recordHash(jws), treeDigest: digest,
        size: size, objects: objects, files: files, indexSha256: sha(index), fullSha256: sha(full))
}

/// A content stamp pinning these releases (all required, essential).
func stampFor(_ packs: TreePack...) -> AppContent {
    AppContent(
        contentApi: 1,
        pins: packs.map { ContentPin(pack: $0.packId, sha256: $0.recordSha256, seq: $0.seq, version: $0.version) },
        expects: packs.map { ContentExpect(pack: $0.packId, required: true, delivery: "essential") })
}

/// The stamp file's text for `stampFor`.
func stampText(_ content: AppContent) -> String {
    guard case .object(var o) = content.json else { return "" }
    o["format"] = .string("pkey-content/1")
    return canonicalJSON(.object(o))
}

/// A marker (`pkey-marker/1`) for an embedded copy of `pack`.
func markerFor(_ pack: TreePack) -> String {
    canonicalJSON(
        .object([
            "format": .string("pkey-marker/1"), "packId": .string(pack.packId), "version": .string(pack.version),
            "release": .string(pack.jws),
        ]))
}

/// A fake byte server over every pack's records and objects. `cut` makes the next GET of an
/// object stop after that many bytes (an interrupted download); `override` replaces the object
/// GET wholesale.
final class ByteServer: @unchecked Sendable {
    private let lock = NSLock()
    var records: [String: String] = [:]
    var objects: [String: [UInt8]] = [:]
    private var _calls: [ObjectRequest] = []
    private var _cut: Int?
    private var _override: (@Sendable (ObjectRequest) async throws -> ObjectResponse)?
    private var _recordOverride: (@Sendable (String) async -> RecordFetchResult)?

    init(_ packs: TreePack...) {
        for p in packs {
            records[p.recordSha256] = p.jws
            for (h, b) in p.objects { objects[h] = b }
        }
    }

    private func locked<R>(_ f: () -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return f()
    }

    var calls: [ObjectRequest] {
        get { locked { _calls } }
        set { locked { _calls = newValue } }
    }
    var cut: Int? {
        get { locked { _cut } }
        set { locked { _cut = newValue } }
    }
    var override: (@Sendable (ObjectRequest) async throws -> ObjectResponse)? {
        get { locked { _override } }
        set { locked { _override = newValue } }
    }
    var recordOverride: (@Sendable (String) async -> RecordFetchResult)? {
        get { locked { _recordOverride } }
        set { locked { _recordOverride = newValue } }
    }

    var fetchRecord: RecordFetch {
        { [self] h in
            if let o = recordOverride { return await o(h) }
            return locked { records[h] }.map { .ok($0) } ?? .failed("not_found")
        }
    }

    var fetchObject: ObjectFetch {
        { [self] req in
            if let o = override { return try await o(req) }
            return serve(req)
        }
    }

    /// The default answer: Range honoured only with a matching `If-Range`, bodies in 7-byte chunks.
    func serve(_ req: ObjectRequest) -> ObjectResponse {
        let (b, cut): ([UInt8]?, Int?) = locked {
            _calls.append(req)
            let c = _cut
            _cut = nil
            return (objects[req.sha256], c)
        }
        guard let b else {
            return ObjectResponse(status: 404, contentRange: nil, chunks: AsyncThrowingStream { $0.finish() })
        }
        let ranged = req.offset > 0 && req.ifRange == "\"\(req.sha256)\""
        let body = ranged ? Array(b[req.offset...]) : b
        let stream = AsyncThrowingStream<[UInt8], Error> { c in
            if let cut {
                c.yield(Array(body.prefix(cut)))
                c.finish(throwing: URLError(.networkConnectionLost))
                return
            }
            var at = 0
            while at < body.count {
                c.yield(Array(body[at..<min(at + 7, body.count)]))
                at += 7
            }
            c.finish()
        }
        return ObjectResponse(
            status: ranged ? 206 : 200,
            contentRange: ranged ? "bytes \(req.offset)-\(b.count - 1)/\(b.count)" : nil, chunks: stream)
    }
}

/// A `PackStorage` over another, with `verify` and `list` replaceable (the flaky-disk cases).
final class WrappedStorage: PackStorage, @unchecked Sendable {
    let base: any PackStorage
    var verifyOverride: (@Sendable (PackInstall) throws -> Bool)?
    var listOverride: (@Sendable () throws -> (locations: [String], plans: [String]))?

    init(_ base: any PackStorage) { self.base = base }

    func stagedObject(_ planId: String, _ sha256: String) throws -> any StagedObject {
        try base.stagedObject(planId, sha256)
    }
    func output(_ planId: String, _ layout: String) throws -> PackOutput { try base.output(planId, layout) }
    func commit(_ planId: String, _ packId: String, _ payloadSha256: String, _ layout: String, _ index: FilesIndexDoc?)
        throws -> String
    { try base.commit(planId, packId, payloadSha256, layout, index) }
    func installed(_ install: PackInstall) throws -> InstalledPayload? { try base.installed(install) }
    func verify(_ install: PackInstall) throws -> Bool { try verifyOverride?(install) ?? base.verify(install) }
    func remove(_ location: String) throws { try base.remove(location) }
    func removeStaging(_ planId: String) throws { try base.removeStaging(planId) }
    func list() throws -> (locations: [String], plans: [String]) { try listOverride?() ?? base.list() }
    func freeDisk() throws -> Int { try base.freeDisk() }
}

/// A test I/O failure.
struct TestIOError: Error {}

/// A `kind: revocation` record (plans/P4-13.md §2.3) revoking `target`, signed with the release
/// key (or `kid`'s key), and its feed entry.
func revocationFor(
    _ target: TreePack, replacement: TreePack? = nil, issuedAt: Int = 1_759_350_000,
    reason: String = "Withdrawn in a test.", kid: String = PackFixtures.releaseKid
) -> (jws: String, record: String, entry: FeedRevocation) {
    var o: [String: JSONValue] = [
        "schemaVersion": .int(1), "aud": .string(PackFixtures.product), "deliverable": .string(target.packId),
        "kind": .string("revocation"), "version": .string(target.version), "seq": .int(target.seq),
        "issuedAt": .int(issuedAt), "revokes": .string(target.recordSha256), "reason": .string(reason),
    ]
    if let r = replacement {
        o["replacement"] = .object([
            "sha256": .string(r.recordSha256), "seq": .int(r.seq), "version": .string(r.version),
        ])
    }
    let jws = PackFixtures.sign(.object(o), kid: kid, typ: "pkey-release+jws")
    let record = PackFixtures.sha(jws)
    return (
        jws, record,
        FeedRevocation(
            record: record, pack: target.packId, target: target.recordSha256, version: target.version,
            seq: target.seq)
    )
}

/// The verified form of a fixture revocation.
func verifiedRevocation(_ r: (jws: String, record: String, entry: FeedRevocation)) throws -> VerifiedRevocation {
    try XCTUnwrap(
        verifyRevocation(
            r.jws,
            options: VerifyRevocationOptions(
                releaseKeys: PackFixtures.releaseKeys, productTrust: PackFixtures.productTrust,
                expectedAud: PackFixtures.product, entry: r.entry)
        ).revocation, "the fixture revocation verifies")
}
