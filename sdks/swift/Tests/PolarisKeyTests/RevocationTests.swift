// @pkey-feature packs.revoke update.content
//
// Unit proofs for P4-13's client side in Swift (plans/P4-13.md §2.5; P4-23), ported from
// client-core's `test/content.test.ts` scenario for scenario: the sibling `revocations.json`
// (written only with a first entry, re-verified on load, `relearn`, the 256-target cap, torn and
// unreadable files, two loads), the pack engine's `pack-revoked` refusals, and `runUpdateCheck`'s
// content steps 10–14. The corpus pins every verdict and decision row across SDKs; these pin the
// persistence and the I/O around them, which no corpus row can carry.

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

private let revPlans = Locked2(0)

private func engine(
    server: ByteServer, storage: any PackStorage = memoryPackStorage(),
    state: any PackStateStore = memoryPackStateStore(), revocations: (any PackStateStore)? = nil,
    stamp: AppContent? = nil
) -> PackEngine {
    PackEngine(
        PackEngineOptions(
            product: PackFixtures.product, releaseKeys: PackFixtures.releaseKeys,
            productTrust: { PackFixtures.productTrust }, stamp: stamp, zstd: LibZstd(), patchMethods: [],
            memBudget: 1 << 30, storage: storage, state: state, revocations: revocations,
            fetchRecord: server.fetchRecord, fetchObject: server.fetchObject, now: { 1_759_400_000 },
            newPlanId: { "rplan-\(revPlans.with { $0 += 1; return $0 })" }))
}

private func l10n() -> (v1: TreePack, v2: TreePack) {
    (
        treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: ["fr.json": #"{"a":"b"}"#]),
        treePack(packId: "djdl.l10n", version: "1.1.0", seq: 2, files: ["fr.json": #"{"a":"c"}"#])
    )
}

/// A store whose every read fails (the device cannot read the file).
private final class UnreadableStore: PackStateStore, @unchecked Sendable {
    struct EIO: Error {}
    func read() throws -> String? { throw EIO() }
    func replace(_ text: String) throws { throw EIO() }
    func quarantine(_ text: String) throws { throw EIO() }
    func quarantined() throws -> Bool { false }
    func clearQuarantine() throws {}
}

/// A store over another that records the order of writes into a shared log.
private final class WatchedStore: PackStateStore, @unchecked Sendable {
    let base: MemoryPackStateStore
    let name: String
    let log: Locked2<[String]>
    init(_ base: MemoryPackStateStore, _ name: String, _ log: Locked2<[String]>) {
        self.base = base
        self.name = name
        self.log = log
    }
    func read() throws -> String? { try base.read() }
    func replace(_ text: String) throws {
        log.with { $0.append(name) }
        try base.replace(text)
    }
    func quarantine(_ text: String) throws { try base.quarantine(text) }
    func quarantined() throws -> Bool { try base.quarantined() }
    func clearQuarantine() throws { try base.clearQuarantine() }
}

private func field(_ text: String?, _ key: String) -> JSONValue? {
    text.flatMap { parseJSON($0)?.objectValue?[key] }
}

private func baseline(_ v: TreePack) -> EmbeddedBaseline {
    EmbeddedBaseline(
        marker: Array(markerFor(v).utf8), payload: .tree(treeDigest: v.treeDigest), location: "embedded/djdl.l10n")
}

private func storageWithBaseline(_ v: TreePack) -> MemoryPackStorage {
    let storage = memoryPackStorage()
    storage.store["embedded/djdl.l10n"] = MemoryPayload(layout: "tree", payload: nil, tree: v.files, index: nil)
    return storage
}

final class RevocationsDocTests: XCTestCase {
    func testParsesNothingTornAndDropsAMalformedEntryIntoRelearn() {
        XCTAssertNil(parseRevocations("not json"))
        XCTAssertNil(parseRevocations(#"{"v":2}"#))
        let doc = parseRevocations(
            canonicalJSON(
                .object([
                    "v": .int(1),
                    "revoked": .object([PackFixtures.sha("t"): .object(["pack": .string("djdl.l10n"), "jws": .int(5)])]),
                    "relearn": .array([.string("djdl.other"), .string("Not A Pack")]),
                ])))
        XCTAssertEqual(doc, RevocationsDoc(revoked: [:], relearn: ["djdl.l10n", "djdl.other"]))
    }

    func testStoresANewTargetSupersedesWithANewerOneIgnoresAnOlderOne() throws {
        let (v1, v2) = l10n()
        let a = revocationFor(v1, issuedAt: 1000)
        let b = revocationFor(v1, replacement: v2, issuedAt: 2000)
        let old = revocationFor(v1, issuedAt: 500, reason: "older")
        let va = try verifiedRevocation(a)
        let vb = try verifiedRevocation(b)
        let vo = try verifiedRevocation(old)
        var s = storeRevocation(emptyRevocations(), va, jws: a.jws)
        XCTAssertTrue(s.changed)
        XCTAssertFalse(storeRevocation(s.doc, va, jws: a.jws).changed)
        s = storeRevocation(s.doc, vb, jws: b.jws)
        XCTAssertEqual(s.doc.revoked[v1.recordSha256]?.record, b.record)
        XCTAssertFalse(storeRevocation(s.doc, vo, jws: old.jws).changed)
        XCTAssertEqual(newerRevocation(va, vb), vb)
    }

    func testKeepsAtMost256TargetsDroppingTheOldestWithoutRelearn() {
        var doc = emptyRevocations()
        for i in 0..<(MAX_STORED_REVOCATIONS + 3) {
            doc.revoked[PackFixtures.sha("t\(i)")] = StoredRevocation(
                jws: "x", pack: "djdl.l10n", version: "1.0.0", seq: 1, record: PackFixtures.sha("r\(i)"),
                issuedAt: 1000 + i)
        }
        let capped = capRevocations(doc)
        XCTAssertEqual(capped.revoked.count, MAX_STORED_REVOCATIONS)
        for i in 0..<3 { XCTAssertNil(capped.revoked[PackFixtures.sha("t\(i)")]) }
        XCTAssertEqual(capped.relearn, [])
    }

    func testReVerifiesOnLoadARotatedKeyForgetsAnyOtherFailureRelearns() throws {
        let (v1, v2) = l10n()
        let good = revocationFor(v1)
        let rotated = revocationFor(v2, kid: "djdl-release-test-2027")
        var doc = emptyRevocations()
        doc.revoked[v1.recordSha256] = StoredRevocation(
            jws: good.jws, pack: "djdl.l10n", version: "1.0.0", seq: 1, record: good.record, issuedAt: 1_759_350_000)
        doc.revoked[v2.recordSha256] = StoredRevocation(
            jws: rotated.jws, pack: "djdl.l10n", version: "1.1.0", seq: 2, record: rotated.record,
            issuedAt: 1_759_350_000)
        let r = reloadRevocations(
            doc, releaseKeys: PackFixtures.releaseKeys, productTrust: PackFixtures.productTrust,
            expectedAud: PackFixtures.product)
        XCTAssertEqual(Array(r.doc.revoked.keys), [v1.recordSha256])
        XCTAssertEqual(r.doc.relearn, [])
        XCTAssertTrue(r.changed)
        // A pin mismatch (the stored seq is wrong) relearns the pack.
        doc.revoked[v1.recordSha256]!.seq = 9
        let r2 = reloadRevocations(
            doc, releaseKeys: PackFixtures.releaseKeys, productTrust: PackFixtures.productTrust,
            expectedAud: PackFixtures.product)
        XCTAssertEqual(r2.doc.revoked, [:])
        XCTAssertEqual(r2.doc.relearn, ["djdl.l10n"])
        XCTAssertEqual(clearRelearn(r2.doc, ["djdl.l10n"]).doc.relearn, [])
    }

    func testReadsAStampsHoldsBesideParseContentStampWithTheTokenRule() {
        let sha = PackFixtures.sha("h")
        let stamp =
            #"{"format":"pkey-content/1","contentApi":1,"pins":[],"expects":[],"holds":[{"pack":"djdl.l10n","release":{"sha256":"\#(sha)","seq":3,"version":"1.0.0"}}]}"#
        XCTAssertEqual(
            stampHolds(stamp),
            [ContentHold(pack: "djdl.l10n", release: ReleasePin(sha256: sha, seq: 3, version: "1.0.0"))])
        XCTAssertNil(stampHolds(stamp.replacingOccurrences(of: #""seq":3"#, with: #""seq":3.0"#)))
        XCTAssertEqual(stampHolds(#"{"format":"pkey-content/1","contentApi":1,"pins":[],"expects":[]}"#), [])
    }
}

final class RevocationEngineTests: XCTestCase {
    func testAProductWithNoRevocationsWritesNoRevocationsJsonAndNoFlag() async throws {
        let (v1, _) = l10n()
        let state = memoryPackStateStore()
        let revs = memoryPackStateStore()
        let storage = memoryPackStorage()
        let e = engine(server: ByteServer(v1), storage: storage, state: state, revocations: revs, stamp: stampFor(v1))
        _ = try await e.load()
        _ = try await e.ensure(["djdl.l10n"])
        try await e.recordRevocations([])
        XCTAssertNil(revs.text)
        XCTAssertNil(field(state.text, "revocationsStored"))
        // A second load of the same product is unchanged too.
        let again = engine(server: ByteServer(v1), storage: storage, state: state, revocations: revs, stamp: stampFor(v1))
        _ = try await again.load()
        do {
            let got = try await again.state().running["djdl.l10n"]
            XCTAssertNotNil(got)
        }
        XCTAssertNil(revs.text)
        XCTAssertNil(field(state.text, "revocationsStored"))
    }

    func testStoresARevocationFlagFirstUnmountsTheReleaseAndRefusesIt() async throws {
        let (v1, _) = l10n()
        let log = Locked2<[String]>([])
        let stateBase = memoryPackStateStore()
        let revsBase = memoryPackStateStore()
        let storage = memoryPackStorage()
        let e = engine(
            server: ByteServer(v1), storage: storage, state: WatchedStore(stateBase, "state", log),
            revocations: WatchedStore(revsBase, "revocations", log), stamp: stampFor(v1))
        _ = try await e.load()
        _ = try await e.ensure(["djdl.l10n"])
        do {
            let got = try await e.state().running["djdl.l10n"]
            XCTAssertNotNil(got)
        }
        let r = revocationFor(v1)
        log.with { $0 = [] }
        try await e.recordRevocations([LearnedRevocation(revocation: try verifiedRevocation(r), jws: r.jws)])
        XCTAssertEqual(log.with { $0 }, ["state", "revocations"])
        XCTAssertEqual(field(stateBase.text, "revocationsStored"), .bool(true))
        XCTAssertEqual(field(revsBase.text, "revoked")?.objectValue.map { Array($0.keys) }, [v1.recordSha256])
        do {
            let got = try await e.state().running["djdl.l10n"]
            XCTAssertNil(got)
        }
        do {
            _ = try await e.ensure(["djdl.l10n"])
            XCTFail("a revoked pin installs")
        } catch let err as PackError {
            XCTAssertEqual(err.code, ErrorCode.packRevoked)
        }
        let rolledBack = try await e.rollback("djdl.l10n")
        XCTAssertFalse(rolledBack)

        // A fresh process re-verifies the file and never mounts the revoked install.
        let again = engine(
            server: ByteServer(v1), storage: storage, state: stateBase, revocations: revsBase, stamp: stampFor(v1))
        // The install is still in the state document; only the revocation keeps it from mounting.
        XCTAssertNotNil(field(stateBase.text, "active")?.objectValue?["djdl.l10n"])
        _ = try await again.load()
        do {
            let got = try await again.state().running["djdl.l10n"]
            XCTAssertNil(got)
        }
        let revoked = await again.isRevoked(v1.recordSha256)
        XCTAssertTrue(revoked)
    }

    func testRefusesARevokedEmbeddedBaselineAndAPackInRelearnAfterATornFile() async throws {
        let (v1, _) = l10n()
        let storage = storageWithBaseline(v1)
        // Torn: quarantined, replaced by a fresh file whose relearn holds the stamp's pins.
        let revs = memoryPackStateStore("{torn")
        let state = memoryPackStateStore()
        let e = engine(server: ByteServer(v1), storage: storage, state: state, revocations: revs, stamp: stampFor(v1))
        _ = try await e.load([baseline(v1)])
        XCTAssertEqual(revs.torn, "{torn")
        XCTAssertEqual(field(revs.text, "relearn"), .array([.string("djdl.l10n")]))
        XCTAssertEqual(field(state.text, "revocationsStored"), .bool(true))
        let issue = await e.revocations().issue
        XCTAssertEqual(issue, "torn")
        do {
            let got = try await e.state().running["djdl.l10n"]
            XCTAssertNil(got)
        }
        // A fresh feed that re-teaches the pack clears relearn; the baseline mounts next boot.
        try await e.recordRevocations([], relearnCleared: ["djdl.l10n"])
        XCTAssertEqual(field(revs.text, "relearn"), .array([]))
        let next = engine(server: ByteServer(v1), storage: storage, state: state, revocations: revs, stamp: stampFor(v1))
        _ = try await next.load([baseline(v1)])
        do {
            let got = try await next.state().running["djdl.l10n"]?.embedded
            XCTAssertEqual(got, true)
        }

        // recoverState() clears relearn wholesale and releases the quarantine.
        let torn2 = memoryPackStateStore("{torn")
        let e2 = engine(server: ByteServer(v1), storage: storage, revocations: torn2, stamp: stampFor(v1))
        _ = try await e2.load([baseline(v1)])
        try await e2.recoverState()
        XCTAssertNil(torn2.torn)
        let relearn = await e2.revocations().relearn
        XCTAssertEqual(relearn, [])
    }

    func testAnUnreadableRevocationsJsonRefusesTheStampsBaselinesOnlyWhenTheFlagIsSet() async throws {
        let (v1, _) = l10n()
        let storage = storageWithBaseline(v1)
        let flagged = memoryPackStateStore(
            #"{"v":1,"active":{},"previous":{},"inflight":{},"observed":{},"confirmedBootSeq":0,"bootSeq":0,"revocationsStored":true}"#)
        let a = engine(
            server: ByteServer(v1), storage: storage, state: flagged, revocations: UnreadableStore(), stamp: stampFor(v1))
        _ = try await a.load([baseline(v1)])
        let issue = await a.revocations().issue
        XCTAssertEqual(issue, "unreadable")
        do {
            let got = try await a.state().running["djdl.l10n"]
            XCTAssertNil(got)
        }
        let b = engine(server: ByteServer(v1), storage: storage, revocations: UnreadableStore(), stamp: stampFor(v1))
        _ = try await b.load([baseline(v1)])
        do {
            let got = try await b.state().running["djdl.l10n"]?.embedded
            XCTAssertEqual(got, true)
        }
    }

    func testOfflineABaselineRefusedForRelearnRaisesPackRevokedWithDetailRelearn() async throws {
        let (v1, _) = l10n()
        let e = engine(
            server: ByteServer(),  // offline: no record can be fetched
            storage: storageWithBaseline(v1), revocations: memoryPackStateStore("{torn"), stamp: stampFor(v1))
        _ = try await e.load([baseline(v1)])
        do {
            _ = try await e.ensure(["djdl.l10n"])
            XCTFail("a baseline in relearn mounts offline")
        } catch let err as PackError {
            XCTAssertEqual(err.code, ErrorCode.packRevoked)
            XCTAssertEqual(err.detail, "relearn")
            XCTAssertEqual(err.packId, "djdl.l10n")
        }
    }

    func testRestoresRevocationsStoredWhenStateJsonLostItButRevocationsJsonHasEntries() async throws {
        let (v1, _) = l10n()
        let r = revocationFor(v1)
        let doc = storeRevocation(emptyRevocations(), try verifiedRevocation(r), jws: r.jws).doc
        let state = memoryPackStateStore("{torn state")
        let e = engine(
            server: ByteServer(v1), state: state, revocations: memoryPackStateStore(serializeRevocations(doc)),
            stamp: stampFor(v1))
        _ = try await e.load()
        do {
            let got = try await e.state().stateIssue
            XCTAssertEqual(got, "torn")
        }
        XCTAssertEqual(field(state.text, "revocationsStored"), .bool(true))
        let revoked = await e.isRevoked(v1.recordSha256)
        XCTAssertTrue(revoked)
    }

    func testRaisesATypedPackErrorForARevokedPinAndForARevokedExactRelease() async throws {
        let (v1, v2) = l10n()
        let e = engine(server: ByteServer(v1, v2), stamp: stampFor(v1))
        _ = try await e.load()
        let r = revocationFor(v1)
        try await e.recordRevocations([LearnedRevocation(revocation: try verifiedRevocation(r), jws: r.jws)])
        do {
            _ = try await e.ensure(["djdl.l10n"])
            XCTFail("a revoked pin installs")
        } catch let err as PackError {
            XCTAssertEqual(err.code, ErrorCode.packRevoked)
        }
        let target = PackTarget(pack: "djdl.l10n", release: ReleasePin(sha256: v1.recordSha256, seq: 1, version: "1.0.0"))
        do {
            _ = try await e.ensureReleases([target])
            XCTFail("a revoked release installs")
        } catch let err as PackError {
            XCTAssertEqual(err.code, ErrorCode.packRevoked)
        }
        // The exact release a `packs` answer names (a replacement) installs.
        let installs = try await e.ensureReleases([
            PackTarget(pack: "djdl.l10n", release: ReleasePin(sha256: v2.recordSha256, seq: 2, version: "1.1.0"))
        ])
        XCTAssertEqual(installs.map(\.recordSha256), [v2.recordSha256])
    }

    /// The directory store keeps `revocations.json` beside `state.json`, with its own quarantine.
    func testTheDirectoryStoreKeepsASiblingRevocationsJson() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pkey-revs-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = DirPackStorage(root: root)
        let revs = storage.revocationStore()
        XCTAssertNil(try revs.read())
        try revs.replace(serializeRevocations(emptyRevocations()))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("revocations.json").path))
        XCTAssertNil(try storage.stateStore().read())
        try revs.quarantine("{torn")
        XCTAssertTrue(try revs.quarantined())
        XCTAssertFalse(try storage.stateStore().quarantined())
    }

    func testTheCapIsAppliedOnStore() async throws {
        let (v1, _) = l10n()
        // 256 stored targets, all newer than the fixture's revocation.
        var doc = emptyRevocations()
        let filler = revocationFor(v1)
        for i in 0..<MAX_STORED_REVOCATIONS {
            doc.revoked[PackFixtures.sha("t\(i)")] = StoredRevocation(
                jws: filler.jws, pack: "djdl.l10n", version: "1.0.0", seq: 1, record: PackFixtures.sha("r\(i)"),
                issuedAt: 1_800_000_000 + i)
        }
        let capped = storeRevocation(doc, try verifiedRevocation(filler), jws: filler.jws)
        XCTAssertTrue(capped.changed)
        XCTAssertEqual(capped.doc.revoked.count, MAX_STORED_REVOCATIONS)
        XCTAssertNil(capped.doc.revoked[v1.recordSha256], "the oldest is dropped first")
        XCTAssertEqual(capped.doc.relearn, [])
    }
}

// ── runUpdateCheck's content steps 10–14 ─────────────────────────────────────────────────────

private let NOW = 1_759_400_100

private struct CheckSetup {
    let v1: TreePack
    let v2: TreePack
    let rev: (jws: String, record: String, entry: FeedRevocation)
    let input: UpdateCheckInput
    let records: [String: String]
    let feedJws: String
    let fetched: Locked2<[String]>

    func fetchRecord(failing: String? = nil) -> @Sendable (String) async -> FetchOutcome {
        let records = self.records
        let fetched = self.fetched
        return { h in
            fetched.with { $0.append(h) }
            if h == failing { return .failed(code: ErrorCode.networkError) }
            return records[h].map { .ok($0) } ?? .failed(code: ErrorCode.networkError)
        }
    }

    func run(
        _ input: UpdateCheckInput? = nil, feedFails: Bool = false, failing: String? = nil
    ) async -> UpdateCheckRun? {
        let body = feedJws
        let r = await runUpdateCheck(
            input ?? self.input,
            fetchFeed: { _ in feedFails ? .failed(code: ErrorCode.networkError) : .ok(body) },
            fetchRecord: fetchRecord(failing: failing))
        if case .ok(let run) = r { return run }
        return nil
    }
}

private func selectsAny(_ variants: [JSONValue]) -> Bool {
    if case .index = selectVariant(variants, VariantPrefs()) { return true }
    return false
}

private func checkSetup(replacement: Bool = false, noPackSets: Bool = false) -> CheckSetup {
    let (v1, v2) = l10n()
    let appRecord: JSONValue = .object([
        "schemaVersion": .int(1), "aud": .string(PackFixtures.product), "deliverable": .string("app"),
        "kind": .string("app"), "version": .string("1.5.0"), "seq": .int(15), "issuedAt": .int(1_759_000_000),
        "builds": .array([
            .object([
                "id": .string("macos-dmg"), "platform": .string("macos"), "arch": .string("universal"),
                "format": .string("dmg"),
                "artifacts": .array([
                    .object([
                        "name": .string("a.dmg"), "role": .string("payload"), "sha256": .string(PackFixtures.sha("a")),
                        "size": .int(1),
                    ])
                ]),
            ])
        ]),
    ])
    let appJws = PackFixtures.sign(appRecord)
    let rev = replacement ? revocationFor(v1, replacement: v2) : revocationFor(v1)
    let setId = PackFixtures.sha("djdl.l10n \(v1.recordSha256)\n")
    var feed: [String: JSONValue] = [
        "schemaVersion": .int(1), "iss": .string(POLARIS_ISSUER), "aud": .string(PackFixtures.product),
        "channel": .string("stable"), "selector": .object([:]), "seq": .int(7), "issuedAt": .int(NOW - 100),
        "expiresAt": .int(NOW + 800),
        "app": .object([
            "deliverable": .string("app"), "versionScheme": .string("semver"),
            "targets": .array([
                .object([
                    "platform": .string("macos"),
                    "release": .object([
                        "sha256": .string(PackFixtures.sha(appJws)), "seq": .int(15), "version": .string("1.5.0"),
                    ]),
                    "floor": .null, "critical": .bool(false),
                    "outlets": .object([
                        "direct": .object([
                            "kind": .string("direct"), "live": .object(["version": .string("1.5.0"), "seq": .int(15)]),
                            "halted": .bool(false),
                        ])
                    ]),
                ])
            ]),
        ]),
        "revocations": .array([rev.entry.json]),
    ]
    if !noPackSets {
        feed["packSets"] = FeedPackSets(
            releases: [v1.recordSha256: FeedPackRelease(pack: "djdl.l10n", version: "1.0.0", seq: 1)],
            sets: [setId: [v1.recordSha256]],
            rows: [FeedPackRow(contentApi: 1, platform: "macos", engine: "", variant: [:], set: setId)]
        ).json
    }
    let feedJws = PackFixtures.sign(.object(feed), kid: PackFixtures.productKid, typ: "pkey-feed+jws")
    let records = [PackFixtures.sha(appJws): appJws, rev.record: rev.jws, v1.recordSha256: v1.jws, v2.recordSha256: v2.jws]
    let input = UpdateCheckInput(
        channel: "stable", expectedAud: PackFixtures.product, trust: PackFixtures.productTrust,
        releaseKeys: PackFixtures.releaseKeys, now: NOW, installId: "dev_1",
        installed: InstalledBuild(version: "1.5.0", platform: "macos", arch: "arm64"),
        outlet: UpdateOutlet(id: "direct", kind: "direct"), subkind: nil, methods: [BinaryMethod.download],
        feeds: [:], releaseRecords: [:],
        content: UpdateCheckContent(
            stamp: UpdateContentStamp(
                contentApi: 1, pins: [],
                expects: [ContentExpectation(pack: "djdl.l10n", required: true, delivery: "essential")], holds: []),
            active: ["djdl.l10n": ReleasePin(sha256: v1.recordSha256, seq: 1, version: "1.0.0")], engine: nil,
            axes: [:], revoked: [:], relearn: ["djdl.l10n"], selectsVariant: selectsAny))
    return CheckSetup(
        v1: v1, v2: v2, rev: rev, input: input, records: records, feedJws: feedJws, fetched: Locked2([]))
}

final class UpdateCheckContentTests: XCTestCase {
    func testLearnsARelevantRevocationAndBlocksRevokedRequiredContent() async throws {
        let s = checkSetup()
        let rRun = await s.run()
        let r = try XCTUnwrap(rRun)
        XCTAssertEqual(r.revocations?.learned.map(\.revocation.record), [s.rev.record])
        XCTAssertEqual(r.revocations?.relearnCleared, ["djdl.l10n"])
        XCTAssertEqual(r.check.decision.action, UpdateAction.blocked)
        guard case .blocked(let reason, _, _) = r.check.decision else { return XCTFail() }
        XCTAssertEqual(reason, UpdateBlockedReason.revokedContent)
        XCTAssertEqual(r.check.boot, .required)
    }

    func testClearsRelearnWhenTheFeedListsOnlyTheRevocationOfAnOlderReleaseTheDeviceDoesNotHold() async throws {
        let s = checkSetup(noPackSets: true)
        let pin2 = ReleasePin(sha256: s.v2.recordSha256, seq: 2, version: "1.1.0")
        var input = s.input
        let c = input.content!
        input.content = UpdateCheckContent(
            stamp: UpdateContentStamp(
                contentApi: 1, pins: [PackTarget(pack: "djdl.l10n", release: pin2)], expects: c.stamp.expects,
                holds: []),
            active: ["djdl.l10n": pin2], engine: nil, axes: [:], revoked: [:], relearn: c.relearn,
            selectsVariant: selectsAny)
        let rRun = await s.run(input)
        let r = try XCTUnwrap(rRun)
        // v1 is outside H: its revocation is not fetched, and it keeps nothing in relearn.
        XCTAssertFalse(s.fetched.with { $0 }.contains(s.rev.record))
        XCTAssertEqual(r.revocations?.learned, [])
        XCTAssertEqual(r.revocations?.relearnCleared, ["djdl.l10n"])
    }

    func testKeepsRelearnWhileAConsideredRevocationCannotBeFetched() async throws {
        let s = checkSetup()
        let rRun = await s.run(failing: s.rev.record)
        let r = try XCTUnwrap(rRun)
        XCTAssertEqual(r.revocations?.relearnCleared, [])
    }

    func testInstallsAFetchedVerifiedUsableReplacementInstead() async throws {
        let s = checkSetup(replacement: true)
        let rRun = await s.run()
        let r = try XCTUnwrap(rRun)
        XCTAssertTrue(s.fetched.with { $0 }.contains(s.v2.recordSha256))
        guard case .packs(let install, _, _, _) = r.check.decision else {
            return XCTFail("expected packs, got \(r.check.decision.json)")
        }
        XCTAssertEqual(
            install,
            [PackTarget(pack: "djdl.l10n", release: ReleasePin(sha256: s.v2.recordSha256, seq: 2, version: "1.1.0"))])
        XCTAssertEqual(r.check.boot, BootEvent.Decision.none)
    }

    func testAReplacementThatCannotBeFetchedIsNotYetUsableTheRequiredPackStaysBlocked() async throws {
        let s = checkSetup(replacement: true)
        let rRun = await s.run(failing: s.v2.recordSha256)
        let r = try XCTUnwrap(rRun)
        XCTAssertEqual(r.check.decision.action, UpdateAction.blocked)
    }

    func testSkipsAStoredRevocationItAlreadyHoldsAndClearsNothingFromACommittedFeed() async throws {
        let s = checkSetup()
        let v = try verifiedRevocation(s.rev)
        let firstRun = await s.run()
        let first = try XCTUnwrap(firstRun)
        s.fetched.with { $0 = [] }
        var input = s.input
        input.feeds = first.feeds
        input.releaseRecords = first.releaseRecords
        let c = input.content!
        input.content = UpdateCheckContent(
            stamp: c.stamp, active: c.active, engine: nil, axes: [:], revoked: [s.rev.entry.target: v],
            relearn: c.relearn, selectsVariant: selectsAny)
        let rRun = await s.run(input, feedFails: true)
        let r = try XCTUnwrap(rRun)
        XCTAssertFalse(s.fetched.with { $0 }.contains(s.rev.record))
        XCTAssertEqual(r.check.feed, .committed)
        XCTAssertEqual(r.revocations?.relearnCleared, [])
    }

    func testWithoutContentNoContentStepRunsAndNothingIsReported() async throws {
        let s = checkSetup()
        var input = s.input
        input.content = nil
        let rRun = await s.run(input)
        let r = try XCTUnwrap(rRun)
        XCTAssertNil(r.revocations)
        XCTAssertFalse(s.fetched.with { $0 }.contains(s.rev.record))
        XCTAssertNotEqual(r.check.boot, .required)
    }
}
