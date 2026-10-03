// @pkey-feature packs.delegation packs.provides
//
// Unit proofs for P4-19's client side in Swift (plans/P4-19.md §2.3–§2.7; P4-25), ported from
// client-core's `test/delegation.test.ts` scenario for scenario: the pack engine's delegated
// surface (a feed target installs through its delegation; a stamp pin, a hold or a replacement
// never does), the data-only rule before any payload byte is fetched and while files are written,
// `PackInstall.delegation` and its reload, delegation revocations (`pack-revoked`, detail
// `delegation`), and `runUpdateCheck`'s step 11 relevance and decision-input expansion. The corpus
// pins every verdict across SDKs (`delegationCases`, `dataOnlyCases`); these pin the I/O around
// them.

import CryptoKit
import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

private let delegationPlans = Locked2(0)

private func engine(
    server: ByteServer, delegations: [String: String], storage: any PackStorage = memoryPackStorage(),
    state: any PackStateStore = memoryPackStateStore(), revocations: (any PackStateStore)? = nil,
    stamp: AppContent = AppContent(contentApi: 1, pins: [], expects: []), holds: [ContentHold] = []
) -> PackEngine {
    let fetch = server.fetchRecord
    return PackEngine(
        PackEngineOptions(
            product: PackFixtures.product, releaseKeys: PackFixtures.releaseKeys,
            productTrust: { PackFixtures.productTrust }, stamp: stamp, zstd: LibZstd(), patchMethods: [],
            memBudget: 1 << 30, storage: storage, state: state, revocations: revocations,
            fetchRecord: { h in
                if let d = delegations[h] { return .ok(d) }
                return await fetch(h)
            },
            fetchObject: server.fetchObject, now: { 1_759_400_000 },
            newPlanId: { "dplan-\(delegationPlans.with { $0 += 1; return $0 })" }, holds: holds))
}

private func target(_ p: TreePack) -> PackTarget {
    PackTarget(pack: p.packId, release: ReleasePin(sha256: p.recordSha256, seq: p.seq, version: p.version))
}

private struct Fixture {
    let d: (jws: String, sha256: String, kid: String)
    let pack: TreePack
    let delegations: [String: String]
    let server: ByteServer
}

private func fixture(_ files: [String: Any] = ["a.json": "{}"]) -> Fixture {
    let ck = contentKeyPair()
    let d = delegationFor(deliverable: "djdl.events", publicKey: ck.pub)
    let pack = treePack(
        packId: "djdl.events.halloween", version: "1.0.0", seq: 1, files: files, signer: (ck.key, d.kid),
        issuedAt: 1_759_250_000)
    return Fixture(d: d, pack: pack, delegations: [d.sha256: d.jws], server: ByteServer(pack))
}

private func verified(_ r: (jws: String, record: String, entry: FeedRevocation)) throws -> LearnedRevocation {
    LearnedRevocation(revocation: try verifiedRevocation(r), jws: r.jws)
}

private func expectPackError(
    _ code: String, detail: String? = nil, path: String? = nil, file: StaticString = #filePath, line: UInt = #line,
    _ body: () async throws -> Void
) async {
    do {
        try await body()
        XCTFail("expected \(code)", file: file, line: line)
    } catch let e as PackError {
        XCTAssertEqual(e.code, code, e.message, file: file, line: line)
        if let detail { XCTAssertEqual(e.detail, detail, file: file, line: line) }
        if let path { XCTAssertEqual(e.path, path, file: file, line: line) }
    } catch {
        XCTFail("expected a PackError, got \(error)", file: file, line: line)
    }
}

final class StrictUTF8Tests: XCTestCase {
    /// The text rule decodes strictly, as client-core's fatal `TextDecoder` (Amendment A1): an
    /// overlong form, a surrogate, a value above U+10FFFF, a byte that never starts a sequence or a
    /// truncated sequence is refused; the largest values just inside each bound pass.
    func testIsStrictUTF8ThroughTheTextRule() {
        let refused: [[UInt8]] = [
            [0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf5], [0xe2, 0x82],
        ]
        for b in refused {
            XCTAssertEqual(dataOnlyRefusal("a.txt", head: b, tail: b, full: b), .content, "\(b)")
        }
        for b: [UInt8] in [[0xed, 0x9f, 0xbf], [0xf4, 0x8f, 0xbf, 0xbf]] {
            XCTAssertNil(dataOnlyRefusal("a.txt", head: b, tail: b, full: b), "\(b)")
        }
    }
}

final class DelegatedEngineTests: XCTestCase {
    func testKidHelpers() {
        let f = fixture()
        XCTAssertEqual(delegationHashOf(f.pack.jws), f.d.sha256)
        XCTAssertEqual(delegatedKid(f.d.sha256), f.d.kid)
        XCTAssertNil(delegationHashOf(f.d.jws))
    }

    func testInstallsADelegatedFeedTargetStoresItsDelegationAndReloadsIt() async throws {
        let f = fixture(["lore/a.json": #"{"spooky": true}"#, "img/banner.png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a] as [UInt8]])
        let state = memoryPackStateStore()
        let storage = memoryPackStorage()
        let e = engine(server: f.server, delegations: f.delegations, storage: storage, state: state)
        _ = try await e.load()
        let installs = try await e.ensureReleases([target(f.pack)])
        XCTAssertEqual(installs.first?.delegation, f.d.jws)
        let known = await e.delegatedReleases()
        XCTAssertEqual(known, [f.pack.recordSha256: DelegatedRelease(pack: f.pack.packId, delegation: f.d.sha256)])
        // A fresh engine over the same state re-verifies the install through its delegation, with
        // no network (an installed release stays valid after its window).
        let again = engine(server: ByteServer(), delegations: [:], storage: storage, state: state)
        _ = try await again.load()
        let st = try await again.state()
        XCTAssertEqual(st.active[f.pack.packId]?.recordSha256, f.pack.recordSha256)
        XCTAssertNotNil(st.running[f.pack.packId])
    }

    /// P4-20 x P4-19: `packFor` verifies a delegated feed target through its delegation, as
    /// `ensure` does (one `fetchVerified`), instead of refusing it at `jws`.
    func testPackForResolvesADelegatedFeedTargetsProvides() async throws {
        let ck = contentKeyPair()
        let d = delegationFor(deliverable: "djdl.events", publicKey: ck.pub)
        let pack = treePack(
            packId: "djdl.events.halloween", version: "1.0.0", seq: 1, files: ["a.json": "{}"],
            signer: (ck.key, d.kid), issuedAt: 1_759_250_000,
            recordExtra: ["provides": .array([.string("event.halloween")])])
        let server = ByteServer(pack)
        let e = engine(server: server, delegations: [d.sha256: d.jws])
        _ = try await e.load()
        let got = try await e.packFor("event.halloween", targets: [target(pack)])
        XCTAssertEqual(got, PackProvider(packId: pack.packId, release: target(pack).release))
        let known = await e.delegatedReleases()
        XCTAssertEqual(known, [pack.recordSha256: DelegatedRelease(pack: pack.packId, delegation: d.sha256)])
        // Without the delegation the target cannot verify, so it never answers.
        let bare = engine(server: server, delegations: [:])
        _ = try await bare.load()
        let none = try await bare.packFor("event.halloween", targets: [target(pack)])
        XCTAssertNil(none)
    }

    func testNeverTakesTheDelegatedPathForTheStampsPin() async throws {
        let f = fixture()
        let e = engine(server: f.server, delegations: f.delegations, stamp: stampFor(f.pack))
        _ = try await e.load()
        await expectPackError(ErrorCode.recordRejected, detail: "jws") { _ = try await e.ensure([f.pack.packId]) }
    }

    func testRefusesAFileOffTheExtensionAllowListBeforeAnyPayloadObjectIsFetched() async throws {
        let f = fixture(["a.json": "{}", "scene.tres": "[gd_resource]"])
        let e = engine(server: f.server, delegations: f.delegations)
        _ = try await e.load()
        await expectPackError(ErrorCode.packNotDataOnly, detail: "extension", path: "scene.tres") {
            _ = try await e.ensureReleases([target(f.pack)])
        }
        // Only the files index was fetched.
        XCTAssertEqual(f.server.calls.map(\.sha256), [f.pack.indexSha256])
        let est = try await e.estimateReleases([target(f.pack)])
        XCTAssertEqual(est.refused.map(\.code), [ErrorCode.packNotDataOnly])
    }

    func testRefusesAnAllowedExtensionCarryingAGodotHeadWhileWritingAndDiscardsThePlan() async throws {
        let f = fixture(["a.json": "{}", "b.json": [0x52, 0x53, 0x52, 0x43, 0, 0, 0, 0] as [UInt8]])
        let e = engine(server: f.server, delegations: f.delegations)
        _ = try await e.load()
        await expectPackError(ErrorCode.packNotDataOnly, detail: "content", path: "b.json") {
            _ = try await e.ensureReleases([target(f.pack)])
        }
        let st = try await e.state()
        XCTAssertNil(st.active[f.pack.packId])
        XCTAssertNil(st.inflight[f.pack.packId])
        XCTAssertEqual(dataOnlyFileRefusal("b.json", f.pack.files["b.json"]!), .content)
    }

    func testRefusesAReleaseUnderARevokedDelegationAndUnmountsIt() async throws {
        let f = fixture()
        let e = engine(server: f.server, delegations: f.delegations)
        _ = try await e.load()
        _ = try await e.ensureReleases([target(f.pack)])
        var st = try await e.state()
        XCTAssertNotNil(st.running[f.pack.packId])
        let rev = delegationRevocationFor(f.d, deliverable: "djdl.events")
        try await e.recordRevocations([try verified(rev)])
        st = try await e.state()
        XCTAssertNil(st.running[f.pack.packId])
        let by = await e.revokedBy(f.pack.recordSha256, f.d.sha256)
        XCTAssertEqual(by, .delegation)
        await expectPackError(ErrorCode.packRevoked, detail: "delegation") {
            _ = try await e.ensureReleases([target(f.pack)])
        }
    }

    func testPackForStopsNamingAMemoisedDelegatedTargetOnceItsDelegationIsRevoked() async throws {
        let ck = contentKeyPair()
        let d = delegationFor(deliverable: "djdl.events", publicKey: ck.pub)
        let pack = treePack(
            packId: "djdl.events.halloween", version: "1.0.0", seq: 1, files: ["a.json": "{}"],
            signer: (ck.key, d.kid), issuedAt: 1_759_250_000,
            recordExtra: ["provides": .array([.string("event.halloween")])])
        let e = engine(server: ByteServer(pack), delegations: [d.sha256: d.jws])
        _ = try await e.load()
        let first = try await e.packFor("event.halloween", targets: [target(pack)])
        XCTAssertNotNil(first)
        let rev = delegationRevocationFor((jws: d.jws, sha256: d.sha256, kid: d.kid), deliverable: "djdl.events")
        try await e.recordRevocations([try verified(rev)])
        let after = try await e.packFor("event.halloween", targets: [target(pack)])
        XCTAssertNil(after)
    }

    func testReSniffsAReusedInstallOnANoopPlan() async throws {
        let files: [String: Any] = ["cfg.txt": #"x = Object(GDScript,"script/source":"extends Node")"# + "\n"]
        let released = treePack(packId: "djdl.events.halloween", version: "0.9.0", seq: 1, files: files)
        let ck = contentKeyPair()
        let d = delegationFor(deliverable: "djdl.events", publicKey: ck.pub)
        let delegated = treePack(
            packId: "djdl.events.halloween", version: "1.0.0", seq: 2, files: files, signer: (ck.key, d.kid),
            issuedAt: 1_759_250_000)
        XCTAssertEqual(delegated.treeDigest, released.treeDigest)
        let server = ByteServer(released, delegated)
        let e = engine(server: server, delegations: [d.sha256: d.jws])
        _ = try await e.load()
        _ = try await e.ensureReleases([target(released)])
        let before = server.calls.count
        await expectPackError(ErrorCode.packNotDataOnly, detail: "content", path: "cfg.txt") {
            _ = try await e.ensureReleases([target(delegated)])
        }
        let st = try await e.state()
        XCTAssertEqual(st.active[released.packId]?.recordSha256, released.recordSha256)
        // A noop plan: no payload object was fetched for the delegated release.
        XCTAssertFalse(server.calls.dropFirst(before).contains { $0.sha256 == delegated.fullSha256 })
    }

    func testNeverTakesTheDelegatedPathForTheStampsHold() async throws {
        let f = fixture()
        let hold = ContentHold(pack: f.pack.packId, release: target(f.pack).release, reason: "held")
        let e = engine(server: f.server, delegations: f.delegations, holds: [hold])
        _ = try await e.load()
        await expectPackError(ErrorCode.recordRejected, detail: "jws") {
            _ = try await e.ensureReleases([target(f.pack)])
        }
    }

    func testNeverTakesTheDelegatedPathForAStoredRevocationsReplacement() async throws {
        let f = fixture()
        let old = treePack(packId: f.pack.packId, version: "0.9.0", seq: 1, files: ["a.json": "[]"])
        let rev = revocationFor(old, replacement: f.pack)
        let e = engine(server: ByteServer(old, f.pack), delegations: f.delegations)
        _ = try await e.load()
        try await e.recordRevocations([try verified(rev)])
        await expectPackError(ErrorCode.recordRejected, detail: "jws") {
            _ = try await e.ensureReleases([target(f.pack)])
        }
    }

    func testFetchesAtMostMaxDelegationsPerCheckDistinctDelegationsPerCall() async throws {
        let ck = contentKeyPair()
        var delegations: [String: String] = [:]
        var packs: [TreePack] = []
        for k in 0...MAX_DELEGATIONS_PER_CHECK {
            let d = delegationFor(deliverable: "djdl.events", publicKey: ck.pub, seq: k + 1)
            delegations[d.sha256] = d.jws
            packs.append(
                treePack(
                    packId: "djdl.events.p\(k)", version: "1.0.0", seq: 1, files: ["a.json": "[\(k)]"],
                    signer: (ck.key, d.kid), issuedAt: 1_759_250_000))
        }
        let server = ByteServer()
        for p in packs {
            server.records[p.recordSha256] = p.jws
            for (h, b) in p.objects { server.objects[h] = b }
        }
        let e = engine(server: server, delegations: delegations)
        _ = try await e.load()
        let est = try await e.estimateReleases(packs.map(target))
        XCTAssertEqual(est.packs.count, MAX_DELEGATIONS_PER_CHECK)
        XCTAssertEqual(est.refused.map(\.packId), ["djdl.events.p\(MAX_DELEGATIONS_PER_CHECK)"])
        XCTAssertEqual(est.refused.map(\.code), [ErrorCode.networkError])
        // The next call has a fresh bound, and the fetched delegations are kept in the process.
        let again = try await e.estimateReleases([target(packs.last!)])
        XCTAssertTrue(again.refused.isEmpty)
    }

    func testAtBootAStoredDelegationRevocationKeepsTheDelegatedInstallFromRunning() async throws {
        let f = fixture()
        let state = memoryPackStateStore()
        let storage = memoryPackStorage()
        let revocations = memoryPackStateStore()
        let e = engine(
            server: f.server, delegations: f.delegations, storage: storage, state: state, revocations: revocations)
        _ = try await e.load()
        _ = try await e.ensureReleases([target(f.pack)])
        try await e.recordRevocations([try verified(delegationRevocationFor(f.d, deliverable: "djdl.events"))])
        let boot = engine(
            server: ByteServer(), delegations: [:], storage: storage, state: state, revocations: revocations)
        _ = try await boot.load()
        let st = try await boot.state()
        XCTAssertEqual(st.active[f.pack.packId]?.recordSha256, f.pack.recordSha256)
        XCTAssertNil(st.running[f.pack.packId])
        await expectPackError(ErrorCode.packRevoked, detail: "delegation") {
            _ = try await boot.ensureReleases([target(f.pack)])
        }
    }

    func testADelegatedVariantCarryingAChunkIndexStillPassesTheDataOnlySink() async throws {
        let ck = contentKeyPair()
        let d = delegationFor(deliverable: "djdl.events", publicKey: ck.pub)
        let pack = treePack(
            packId: "djdl.events.halloween", version: "1.0.0", seq: 1,
            files: ["a.json": "{}", "b.json": "[gd_resource]"], signer: (ck.key, d.kid), issuedAt: 1_759_250_000,
            variantExtra: [
                "chunks": .object([
                    "format": .string("pkey-chunks/1"), "sha256": .string(PackFixtures.sha("chunk index")),
                    "bytes": .int(64), "size": .int(64), "codec": .string("none"),
                ])
            ])
        let e = engine(server: ByteServer(pack), delegations: [d.sha256: d.jws])
        _ = try await e.load()
        await expectPackError(ErrorCode.packNotDataOnly, detail: "content", path: "b.json") {
            _ = try await e.ensureReleases([target(pack)])
        }
    }

    func testRefusesADelegatedRecordWhoseDelegationCannotBeFetched() async throws {
        let f = fixture()
        let e = engine(server: f.server, delegations: [:])
        _ = try await e.load()
        await expectPackError("not_found", detail: "delegation") { _ = try await e.ensureReleases([target(f.pack)]) }
    }

    func testDropsAStoredDelegatedInstallWhoseDelegationWasTamperedWith() async throws {
        let f = fixture()
        let state = memoryPackStateStore()
        let storage = memoryPackStorage()
        let e = engine(server: f.server, delegations: f.delegations, storage: storage, state: state)
        _ = try await e.load()
        _ = try await e.ensureReleases([target(f.pack)])
        guard case .object(var doc) = parseJSON(try XCTUnwrap(state.read())),
            case .object(var active) = doc["active"], case .object(var install) = active[f.pack.packId]
        else { return XCTFail("state shape") }
        let other = delegationFor(deliverable: "djdl.events", publicKey: contentKeyPair().pub)
        install["delegation"] = .string(other.jws)
        active[f.pack.packId] = .object(install)
        doc["active"] = .object(active)
        let tampered = memoryPackStateStore(canonicalJSON(.object(doc)))
        let again = engine(server: ByteServer(), delegations: [:], storage: storage, state: tampered)
        _ = try await again.load()
        let st = try await again.state()
        XCTAssertNil(st.active[f.pack.packId])
    }
}

// ── runUpdateCheck and delegation revocations (plans/P4-19.md §2.7) ───────────────────────────

private let CHECK_NOW = 1_759_400_100

private func selectsAnyVariant(_ variants: [JSONValue]) -> Bool {
    if case .index = selectVariant(variants, VariantPrefs()) { return true }
    return false
}

private struct DelegationCheck {
    let f: Fixture
    let rev: (jws: String, record: String, entry: FeedRevocation)
    let feedJws: String
    let records: [String: String]
    let fetched = Locked2<[String]>([])

    func input(delegated: [String: DelegatedRelease]) -> UpdateCheckInput {
        UpdateCheckInput(
            channel: "stable", expectedAud: PackFixtures.product, trust: PackFixtures.productTrust,
            releaseKeys: PackFixtures.releaseKeys, now: CHECK_NOW, installId: "dev_1",
            installed: InstalledBuild(version: "1.5.0", platform: "macos", arch: "arm64"),
            outlet: UpdateOutlet(id: "direct", kind: "direct"), subkind: nil, methods: [BinaryMethod.download],
            feeds: [:], releaseRecords: [:],
            content: UpdateCheckContent(
                stamp: UpdateContentStamp(
                    contentApi: 1, pins: [],
                    expects: [ContentExpectation(pack: f.pack.packId, required: true, delivery: "essential")],
                    holds: []),
                active: [f.pack.packId: target(f.pack).release], engine: nil, axes: [:], revoked: [:], relearn: [],
                selectsVariant: selectsAnyVariant, delegated: delegated))
    }

    var known: [String: DelegatedRelease] {
        [f.pack.recordSha256: DelegatedRelease(pack: f.pack.packId, delegation: f.d.sha256)]
    }

    func run(_ input: UpdateCheckInput) async -> UpdateCheckRun? {
        let body = feedJws
        let records = self.records
        let fetched = self.fetched
        let r = await runUpdateCheck(
            input, fetchFeed: { _ in .ok(body) },
            fetchRecord: { h in
                fetched.with { $0.append(h) }
                return records[h].map { .ok($0) } ?? .failed(code: ErrorCode.networkError)
            })
        if case .ok(let run) = r { return run }
        return nil
    }
}

private func delegationCheck(kind: Bool = true) -> DelegationCheck {
    let f = fixture()
    let appJws = PackFixtures.sign(
        .object([
            "schemaVersion": .int(1), "aud": .string(PackFixtures.product), "deliverable": .string("app"),
            "kind": .string("app"), "version": .string("1.5.0"), "seq": .int(15), "issuedAt": .int(1_759_000_000),
            "builds": .array([
                .object([
                    "id": .string("macos-dmg"), "platform": .string("macos"), "arch": .string("universal"),
                    "format": .string("dmg"),
                    "artifacts": .array([
                        .object([
                            "name": .string("a.dmg"), "role": .string("payload"),
                            "sha256": .string(PackFixtures.sha("a")), "size": .int(1),
                        ])
                    ]),
                ])
            ]),
        ]))
    let rev = delegationRevocationFor(f.d, deliverable: "djdl.events")
    let e = rev.entry
    let plain = FeedRevocation(record: e.record, pack: e.pack, target: e.target, version: e.version, seq: e.seq)
    let feed: JSONValue = .object([
        "schemaVersion": .int(1), "iss": .string(POLARIS_ISSUER), "aud": .string(PackFixtures.product),
        "channel": .string("stable"), "selector": .object([:]), "seq": .int(7), "issuedAt": .int(CHECK_NOW - 100),
        "expiresAt": .int(CHECK_NOW + 800),
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
        "revocations": .array([(kind ? e : plain).json]),
    ])
    let feedJws = PackFixtures.sign(feed, kid: PackFixtures.productKid, typ: "pkey-feed+jws")
    return DelegationCheck(
        f: f, rev: rev, feedJws: feedJws, records: [PackFixtures.sha(appJws): appJws, rev.record: rev.jws])
}

final class DelegatedUpdateCheckTests: XCTestCase {
    func testLearnsADelegationRevocationForAnActiveDelegatedInstallAndRevokesItForTheDecision() async throws {
        let s = delegationCheck()
        let run = await s.run(s.input(delegated: s.known))
        let r = try XCTUnwrap(run)
        XCTAssertEqual(r.revocations?.learned.map(\.revocation.record), [s.rev.record])
        guard case .blocked(let reason, _, _) = r.check.decision else {
            return XCTFail("expected blocked, got \(r.check.decision.json)")
        }
        XCTAssertEqual(reason, UpdateBlockedReason.revokedContent)
    }

    func testTreatsADelegationEntryAsRelevantByScopeWithNoKnownDelegatedRelease() async throws {
        let s = delegationCheck()
        let run = await s.run(s.input(delegated: [:]))
        let r = try XCTUnwrap(run)
        // djdl.events covers djdl.events.halloween (an expected, active pack): fetched and stored,
        // but with no known delegated release nothing is revoked for the decision.
        XCTAssertEqual(r.revocations?.learned.map(\.revocation.record), [s.rev.record])
        if case .blocked(let reason, _, _) = r.check.decision {
            XCTAssertNotEqual(reason, UpdateBlockedReason.revokedContent)
        }
    }

    func testDoesNotConsiderAnEntryWithoutKindWhoseTargetIsADelegation() async throws {
        let s = delegationCheck(kind: false)
        let run = await s.run(s.input(delegated: s.known))
        XCTAssertNotNil(run)
        XCTAssertFalse(s.fetched.with { $0 }.contains(s.rev.record))
    }
}
