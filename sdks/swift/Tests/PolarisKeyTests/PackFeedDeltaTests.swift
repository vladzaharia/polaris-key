// @pkey-feature packs.delta.feed
//
// The feed's delta menu in the pack engine (plans/P4-29.md §2.4), a port of client-core's
// `test/packsFeedDelta.test.ts` (and the Python SDK's `tests/test_packs_feed_delta.py`): a lazy
// delta the committed feed offers joins the record's deltas as one more candidate, is checked
// like any delta (artifact, base, output against the CI-signed record), falls back on any
// failure, and at most one feed-offered delta is tried per install. A journal keeps the entry, so
// a resume plans it again.
//
// The Swift engine emits no `fallback` progress event (P4-18 is Node and React only), so a
// fallback is read from the objects the server was asked for.

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

let feedPack = "djdl.levels"

struct FeedBlobHandler: PackHandler {
    let type = "custom.blob"
    let layout = "container"
    let activation = "hot"
    func supports(_ formatVersion: Int) -> Bool { formatVersion == 1 }
}

struct FeedRelease {
    let version: String
    let seq: Int
    let jws: String
    let recordSha256: String
    let payload: [UInt8]
    var objects: [String: [UInt8]]

    var target: PackTarget {
        PackTarget(pack: feedPack, release: ReleasePin(sha256: recordSha256, seq: seq, version: version))
    }
}

private func sha(_ b: [UInt8]) -> String { sha256Of(b) }

/// A container release over `payload` (one file), `full` stored raw; `delta` adds a record payload
/// delta from `delta.from` whose artifact is `delta.frame`.
func feedRelease(
    _ version: String, _ seq: Int, _ payload: [UInt8], delta: (from: [UInt8], frame: [UInt8])? = nil
) -> FeedRelease {
    let index = Array(
        canonicalJSON(
            .object([
                "format": .string("pkey-files/1"), "layout": .string("container"),
                "payload": .object(["size": .int(payload.count), "sha256": .string(sha(payload))]),
                "files": .array([
                    .object([
                        "path": .string("data.bin"), "offset": .int(0), "size": .int(payload.count),
                        "sha256": .string(sha(payload)),
                        "blob": .object([
                            "sha256": .string(sha(payload)), "bytes": .int(payload.count), "codec": .string("none"),
                        ]),
                    ])
                ]),
            ])
        ).utf8)
    let gaps: [UInt8] = []
    var objects: [String: [UInt8]] = [sha(payload): payload, sha(index): index, sha(gaps): gaps]
    var variant: [String: JSONValue] = [
        "variant": .object([:]),
        "payload": .object(["size": .int(payload.count), "sha256": .string(sha(payload))]),
        "full": .object([
            "sha256": .string(sha(payload)), "bytes": .int(payload.count), "size": .int(payload.count),
            "codec": .string("none"),
        ]),
        "files": .object([
            "format": .string("pkey-files/1"), "layout": .string("container"), "sha256": .string(sha(index)),
            "bytes": .int(index.count), "size": .int(index.count), "codec": .string("none"),
            "gaps": .object([
                "sha256": .string(sha(gaps)), "bytes": .int(0), "size": .int(0), "codec": .string("none"),
            ]),
        ]),
    ]
    if let delta {
        objects[sha(delta.frame)] = delta.frame
        variant["deltas"] = .array([
            .object([
                "method": .string("zstd-patch-from"), "scope": .string("payload"), "from": .string(sha(delta.from)),
                "memBytes": .int(delta.from.count + payload.count),
                "artifact": .object(["sha256": .string(sha(delta.frame)), "bytes": .int(delta.frame.count)]),
            ])
        ])
    }
    let jws = PackFixtures.sign(
        .object([
            "schemaVersion": .int(1), "aud": .string(PackFixtures.product), "deliverable": .string(feedPack),
            "kind": .string("pack"), "version": .string(version), "seq": .int(seq),
            "issuedAt": .int(1_759_300_000 + seq), "type": .string("custom.blob"), "formatVersion": .int(1),
            "handler": .object(["activation": .string("hot")]), "variants": .array([.object(variant)]),
        ]))
    return FeedRelease(
        version: version, seq: seq, jws: jws, recordSha256: recordHash(jws), payload: payload, objects: objects)
}

/// A blob server over the releases; `corrupt` answers that object with its first byte flipped.
private final class FeedServer: @unchecked Sendable {
    private let lock = NSLock()
    private var records: [String: String] = [:]
    private var objects: [String: [UInt8]] = [:]
    private var _fetched: [String] = []
    private var _corrupt = Set<String>()

    init(_ releases: FeedRelease...) {
        for r in releases {
            records[r.recordSha256] = r.jws
            for (h, b) in r.objects { objects[h] = b }
        }
    }

    private func locked<R>(_ f: () -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return f()
    }

    var fetched: [String] {
        get { locked { _fetched } }
        set { locked { _fetched = newValue } }
    }
    func corrupt(_ h: String) { locked { _ = _corrupt.insert(h) } }

    var fetchRecord: RecordFetch {
        { [self] h in locked { records[h] }.map { .ok($0) } ?? .failed("not_found") }
    }

    var fetchObject: ObjectFetch {
        { [self] req in
            let b: [UInt8]? = locked {
                _fetched.append(req.sha256)
                guard var b = objects[req.sha256] else { return nil }
                if _corrupt.contains(req.sha256), !b.isEmpty { b[0] ^= 0xFF }
                return b
            }
            guard let b else {
                return ObjectResponse(status: 404, contentRange: nil, chunks: AsyncThrowingStream { $0.finish() })
            }
            return ObjectResponse(
                status: 200, contentRange: nil,
                chunks: AsyncThrowingStream { c in
                    c.yield(b)
                    c.finish()
                })
        }
    }
}

private let feedPlans = Locked2(0)

private func stampOf(_ r: FeedRelease) -> AppContent {
    AppContent(
        contentApi: 1, pins: [ContentPin(pack: feedPack, sha256: r.recordSha256, seq: r.seq, version: r.version)],
        expects: [ContentExpect(pack: feedPack, required: true, delivery: "essential")])
}

private func feedEngine(
    _ srv: FeedServer, _ first: FeedRelease, storage: any PackStorage = memoryPackStorage(),
    state: any PackStateStore = memoryPackStateStore(),
    newPlanId: (@Sendable () -> String)? = nil,
    feedDeltas: (@Sendable () -> FeedDeltas?)? = nil
) -> PackEngine {
    PackEngine(
        PackEngineOptions(
            product: PackFixtures.product, releaseKeys: PackFixtures.releaseKeys,
            productTrust: { PackFixtures.productTrust }, stamp: stampOf(first), zstd: LibZstd(),
            patchMethods: ["zstd-patch-from"], memBudget: 1 << 30, storage: storage, state: state,
            fetchRecord: srv.fetchRecord, fetchObject: srv.fetchObject, now: { 1_759_400_000 },
            newPlanId: newPlanId ?? { "feed-plan-\(feedPlans.with { $0 += 1; return $0 })" },
            handlers: [FeedBlobHandler()], feedDeltas: feedDeltas))
}

/// One zstd frame of raw blocks (RFC 8878 §3.1.1.2), with its content size.
private func rawFrame(_ content: [UInt8]) -> [UInt8] {
    let n = content.count
    let h = (n << 3) | 1
    return [
        0x28, 0xB5, 0x2F, 0xFD, 0xA0, UInt8(n & 0xFF), UInt8((n >> 8) & 0xFF), UInt8((n >> 16) & 0xFF),
        UInt8((n >> 24) & 0xFF), UInt8(h & 0xFF), UInt8((h >> 8) & 0xFF), UInt8((h >> 16) & 0xFF),
    ] + content
}

private let probeBase = PackFixtures.probeBase
private let probeFrame = PackFixtures.probeFrame
private let probeTarget = PackFixtures.probeTarget

/// A feed menu entry to the probe target from `base`, whose artifact is `frame`.
private func entry(_ base: [UInt8], _ frame: [UInt8], memBytes: Int? = nil) -> FeedDelta {
    FeedDelta(
        from: sha(base), method: "zstd-patch-from", memBytes: memBytes ?? base.count + probeTarget.count,
        artifactSha256: sha(frame), artifactBytes: frame.count)
}

private func menuOf(_ entries: FeedDelta...) -> FeedDeltas { [sha(probeTarget): entries] }

/// v1 (the probe base) and v2 (the probe target) with NO record delta; `extra` objects are on the
/// server beside them (feed-offered frames).
private func pair(_ extra: [UInt8]...) -> (v1: FeedRelease, v2: FeedRelease) {
    let v1 = feedRelease("1.0.0", 1, probeBase)
    var v2 = feedRelease("1.1.0", 2, probeTarget)
    for b in extra { v2.objects[sha(b)] = b }
    return (v1, v2)
}

private func payloadOf(_ e: PackEngine) async throws -> String? {
    try await e.state().active[feedPack]?.payloadSha256
}

final class PackFeedDeltaTests: XCTestCase {
    func testPlansTheFeedsDeltaForARecordThatCarriesNoneAndInstallsIt() async throws {
        let p = pair(probeFrame)
        let srv = FeedServer(p.v1, p.v2)
        let e = feedEngine(srv, p.v1, feedDeltas: { menuOf(entry(probeBase, probeFrame)) })
        _ = try await e.load()
        _ = try await e.ensureReleases([p.v1.target])
        srv.fetched = []
        _ = try await e.ensureReleases([p.v2.target])
        let got = try await payloadOf(e)
        XCTAssertEqual(got, sha(probeTarget))
        XCTAssertEqual(srv.fetched, [sha(probeFrame)])
    }

    func testFallsBackWhenTheFeedsDelta404sAndInstallsByTheNextCandidate() async throws {
        let p = pair()
        let srv = FeedServer(p.v1, p.v2)
        let e = feedEngine(srv, p.v1, feedDeltas: { menuOf(entry(probeBase, probeFrame)) })
        _ = try await e.load()
        _ = try await e.ensureReleases([p.v1.target])
        srv.fetched = []
        _ = try await e.ensureReleases([p.v2.target])
        let got = try await payloadOf(e)
        XCTAssertEqual(got, sha(probeTarget))
        XCTAssertEqual(srv.fetched.first, sha(probeFrame))
        XCTAssertTrue(srv.fetched.dropFirst().contains(sha(probeTarget)))
        let inflight = try await e.state().inflight
        XCTAssertNil(inflight[feedPack])
    }

    func testFallsBackWhenTheStoredArtifactDoesNotMatchTheMenuEntry() async throws {
        let p = pair(probeFrame)
        let srv = FeedServer(p.v1, p.v2)
        srv.corrupt(sha(probeFrame))
        let e = feedEngine(srv, p.v1, feedDeltas: { menuOf(entry(probeBase, probeFrame)) })
        _ = try await e.load()
        _ = try await e.ensureReleases([p.v1.target])
        srv.fetched = []
        _ = try await e.ensureReleases([p.v2.target])
        let got = try await payloadOf(e)
        XCTAssertEqual(got, sha(probeTarget))
        XCTAssertEqual(srv.fetched.first, sha(probeFrame))
        XCTAssertTrue(srv.fetched.dropFirst().contains(sha(probeTarget)))
    }

    func testChecksTheOutputAgainstTheRecordAndFallsBack() async throws {
        // A frame that decodes to other bytes is refused (delta-apply-failed).
        let frame = rawFrame(Array("not the payload the record pins, but a valid frame all the same\n".utf8))
        let p = pair(frame)
        let srv = FeedServer(p.v1, p.v2)
        let e = feedEngine(
            srv, p.v1, feedDeltas: { menuOf(entry(probeBase, frame, memBytes: probeBase.count + 4096)) })
        _ = try await e.load()
        _ = try await e.ensureReleases([p.v1.target])
        srv.fetched = []
        _ = try await e.ensureReleases([p.v2.target])
        let got = try await payloadOf(e)
        XCTAssertEqual(got, sha(probeTarget))
        XCTAssertEqual(srv.fetched.first, sha(frame))
        XCTAssertTrue(srv.fetched.dropFirst().contains(sha(probeTarget)))
    }

    func testChecksTheBaseAgainstFromAndFallsBack() async throws {
        // An entry naming an installed payload whose bytes differ is refused (delta-base-mismatch).
        let p = pair(probeFrame)
        let srv = FeedServer(p.v1, p.v2)
        let storage = WrappedStorage(memoryPackStorage())
        let e = feedEngine(srv, p.v1, storage: storage, feedDeltas: { menuOf(entry(probeBase, probeFrame)) })
        _ = try await e.load()
        _ = try await e.ensureReleases([p.v1.target])
        // The installed base's bytes change under the engine (a disk fault): its hash no longer
        // equals the entry's `from`.
        storage.installedOverride = { got in
            guard var got, got.payload != nil else { return got }
            var flipped = probeBase
            flipped[0] ^= 1
            got.payload = MemorySource(flipped)
            return got
        }
        srv.fetched = []
        _ = try await e.ensureReleases([p.v2.target])
        let got = try await payloadOf(e)
        XCTAssertEqual(got, sha(probeTarget))
        XCTAssertEqual(srv.fetched.first, sha(probeFrame))
        XCTAssertTrue(srv.fetched.dropFirst().contains(sha(probeTarget)))
    }

    func testTriesAtMostOneFeedOfferedDeltaPerInstall() async throws {
        // Two installed bases (A previous, the probe base active) and two feed entries: the cheap
        // one from the probe base 404s; the other, from A, is on the server but is never fetched.
        let a = Array("an older payload of the same pack\n".utf8)
        let second = rawFrame(probeTarget)
        let v0 = feedRelease("0.9.0", 1, a)
        let v1 = feedRelease("1.0.0", 2, probeBase)
        var v2 = feedRelease("1.1.0", 3, probeTarget)
        v2.objects[sha(second)] = second
        let srv = FeedServer(v0, v1, v2)
        let e = feedEngine(srv, v0, feedDeltas: { menuOf(entry(probeBase, probeFrame), entry(a, second)) })
        _ = try await e.load()
        _ = try await e.ensureReleases([v0.target])
        _ = try await e.ensureReleases([v1.target])
        srv.fetched = []
        _ = try await e.ensureReleases([v2.target])
        let got = try await payloadOf(e)
        XCTAssertEqual(got, sha(probeTarget))
        XCTAssertTrue(srv.fetched.contains(sha(probeFrame)))
        XCTAssertFalse(srv.fetched.contains(sha(second)))
    }

    func testARecordDeltaWinsAndAMenuEntryNamingItsIdIsNotAddedTwice() async throws {
        let v1 = feedRelease("1.0.0", 1, probeBase)
        let v2 = feedRelease("1.1.0", 2, probeTarget, delta: (probeBase, probeFrame))
        let srv = FeedServer(v1, v2)
        let e = feedEngine(srv, v1, feedDeltas: { menuOf(entry(probeBase, probeFrame)) })
        _ = try await e.load()
        _ = try await e.ensureReleases([v1.target])
        srv.fetched = []
        _ = try await e.ensureReleases([v2.target])
        let got = try await payloadOf(e)
        XCTAssertEqual(got, sha(probeTarget))
        XCTAssertEqual(srv.fetched, [sha(probeFrame)])
    }

    func testReadsTheMenuAtEachPlanAndNoMenuPlansOnlyTheRecord() async throws {
        let p = pair(probeFrame)
        let srv = FeedServer(p.v1, p.v2)
        let calls = Locked2(0)
        let e = feedEngine(
            srv, p.v1,
            feedDeltas: {
                calls.with { $0 += 1 }
                return nil
            })
        _ = try await e.load()
        _ = try await e.ensureReleases([p.v1.target])
        srv.fetched = []
        _ = try await e.ensureReleases([p.v2.target])
        XCTAssertGreaterThan(calls.with { $0 }, 0)
        let got = try await payloadOf(e)
        XCTAssertEqual(got, sha(probeTarget))
        XCTAssertFalse(srv.fetched.contains(sha(probeFrame)))
    }

    /// A crash after the journal of a delta install of `v2` was written.
    private func crashJournal(
        _ state: MemoryPackStateStore, _ v2: FeedRelease, _ planId: String, _ feedDelta: JSONValue?
    ) throws {
        let text = try XCTUnwrap(state.text)
        guard case .object(var doc) = try XCTUnwrap(parseJSON(text)),
            case .object(var inflight) = try XCTUnwrap(doc["inflight"])
        else { return XCTFail("no state document") }
        var j: [String: JSONValue] = [
            "planId": .string(planId), "packId": .string(feedPack), "record": .string(v2.jws),
            "recordSha256": .string(v2.recordSha256), "variant": .string(""), "strategy": .string("delta"),
            "delta": .string(sha(probeFrame)),
            "objects": .array([
                .object(["sha256": .string(sha(probeFrame)), "bytes": .int(probeFrame.count), "done": .int(0)])
            ]),
            "startedAt": .int(1_759_400_000),
        ]
        if let feedDelta { j["feedDelta"] = feedDelta }
        inflight[feedPack] = .object(j)
        doc["inflight"] = .object(inflight)
        try state.replace(canonicalJSON(.object(doc)))
    }

    func testAResumedJournalPlansItsOwnFeedDeltaAgain() async throws {
        // Even when the feed no longer lists it.
        let p = pair(probeFrame)
        let srv = FeedServer(p.v1, p.v2)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let first = feedEngine(srv, p.v1, storage: storage, state: state)
        _ = try await first.load()
        _ = try await first.ensureReleases([p.v1.target])
        try crashJournal(state, p.v2, "resumed-plan", entry(probeBase, probeFrame).json)
        let fresh = Locked2(0)
        let second = feedEngine(
            srv, p.v1, storage: storage, state: state,
            newPlanId: {
                fresh.with { $0 += 1 }
                return "fresh-plan"
            }, feedDeltas: { nil })
        _ = try await second.load()
        let planId = try await second.state().inflight[feedPack]?.planId
        XCTAssertEqual(planId, "resumed-plan")
        XCTAssertEqual(parsePackState(try XCTUnwrap(state.text)).inflight[feedPack]?.feedDelta, entry(probeBase, probeFrame))
        srv.fetched = []
        _ = try await second.ensureReleases([p.v2.target])
        let got = try await payloadOf(second)
        XCTAssertEqual(got, sha(probeTarget))
        XCTAssertEqual(srv.fetched, [sha(probeFrame)])
        XCTAssertEqual(fresh.with { $0 }, 0)
    }

    func testAbandonsAJournalWhoseDeltaNeitherTheRecordNorItsFeedDeltaNames() async throws {
        let p = pair(probeFrame)
        let srv = FeedServer(p.v1, p.v2)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let first = feedEngine(srv, p.v1, storage: storage, state: state)
        _ = try await first.load()
        _ = try await first.ensureReleases([p.v1.target])
        try crashJournal(state, p.v2, "stale-plan", nil)
        let fresh = Locked2(0)
        let second = feedEngine(
            srv, p.v1, storage: storage, state: state,
            newPlanId: {
                fresh.with { $0 += 1 }
                return "fresh-plan"
            })
        _ = try await second.load()
        srv.fetched = []
        _ = try await second.ensureReleases([p.v2.target])
        let got = try await payloadOf(second)
        XCTAssertEqual(got, sha(probeTarget))
        XCTAssertGreaterThan(fresh.with { $0 }, 0)
        // No menu and no journalled entry: the frame is never planned.
        XCTAssertFalse(srv.fetched.contains(sha(probeFrame)))
    }

    func testAJournalWithAMalformedFeedDeltaIsNotReadBack() async throws {
        let p = pair(probeFrame)
        let srv = FeedServer(p.v1, p.v2)
        let state = memoryPackStateStore()
        let first = feedEngine(srv, p.v1, state: state)
        _ = try await first.load()
        _ = try await first.ensureReleases([p.v1.target])
        guard case .object(var bad) = entry(probeBase, probeFrame).json else { return XCTFail() }
        bad["scope"] = .string("files")
        try crashJournal(state, p.v2, "bad-plan", .object(bad))
        XCTAssertNil(parsePackState(try XCTUnwrap(state.text)).inflight[feedPack])
    }
}
