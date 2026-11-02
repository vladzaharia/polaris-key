// @pkey-feature sync.records
//
// Cloud Sync collections (plans/C-26): the machine's `update`, `delete`, pattern collections, record events
// and outcome taps; the host feeding the catalog's `cloudSync.collections` into the machine; and the
// `client.cloudSync.collection(name)` handle over the scripted Worker of `HostRig`, end-to-end mode, so the
// field and element sealing is on the wire the Worker sees.

import Foundation
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

private func js(_ s: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }

private let collectionsCatalog = js(
    """
    {"schemaVersion":1,"entries":[],
     "cloudSync":{"collections":[
       {"name":"prefs","conflict":"merge"},
       {"name":"tags","conflict":"union"},
       {"name":"best","conflict":"max","conflictField":"score"},
       {"name":"notes.*","conflict":"lastWrite"},
       {"name":"notes.deep.*","conflict":"merge"},
       {"name":"docs","conflict":"revision"},
       {"name":"scratch","template":"session"}]}}
    """)

// MARK: - The machine

final class CloudSyncMachineCollectionTests: XCTestCase {
    private let decls = [
        SyncCollectionDecl(name: "prefs", policy: "merge"),
        SyncCollectionDecl(name: "tags", policy: "union"),
        SyncCollectionDecl(name: "notes.*", policy: "lastWrite"),
        SyncCollectionDecl(name: "notes.deep.*", policy: "merge"),
        SyncCollectionDecl(name: "notes.exact", policy: "union"),
        SyncCollectionDecl(name: "docs", policy: "revision", resolve: "keepServer"),
    ]

    private func machine(contacted: Bool = true) throws -> CloudSyncMachine {
        var o = SyncMachineOptions(
            product: "demo", catalog: SyncMachineCatalog(settings: [], collections: decls),
            document: SyncMachineDocument(), now: 1_760_000_000_000, newClientId: { "c_000000000000000client1" })
        o.subject = "sub_alice"
        o.contacted = contacted
        o.encryption = .server
        o.discovery = .server
        let m = try CloudSyncMachine(o)
        _ = m.takeRequests()
        try m.receive(.answer(status: 200, body: js("{\"encryption\":\"server\",\"cursor\":0}")))
        _ = m.takeRequests()
        _ = m.takeEvents()
        return m
    }

    private func pushed(_ m: CloudSyncMachine) -> [[String: JSONValue]] {
        m.advance(SYNC_DEBOUNCE_MS)
        return m.takeRequests().flatMap {
            ($0.body?.objectValue?["mutations"]?.arrayValue ?? []).compactMap(\.objectValue)
        }
    }

    func testUpdateWritesTheNamedFieldsUnderOneStampAndNothingElse() throws {
        let m = try machine()
        XCTAssertEqual(m.update("prefs", "main", set: ["volume": .int(3), "a": .int(1)], remove: ["old"]), .ok)
        XCTAssertEqual(
            m.record("prefs", "main"), SyncEffectiveValue(value: js("{\"a\":1,\"volume\":3}"), from: .pending))
        let sent = pushed(m)
        XCTAssertEqual(
            sent.map { [$0["op"], $0["field"]] },
            [
                [.string("setField"), .string("a")], [.string("setField"), .string("volume")],
                [.string("removeField"), .string("old")],
            ])
        XCTAssertEqual(Set(sent.compactMap { $0["editedHlc"]?.stringValue }).count, 1, "one stamp")
    }

    func testUpdateRefusesAWrongPolicyAnUnknownNameAndBadNames() throws {
        let m = try machine()
        XCTAssertEqual(m.update("tags", "t", set: ["a": .int(1)]), .failed("collection-unknown"))
        XCTAssertEqual(m.update("nope", "t", set: ["a": .int(1)]), .failed("collection-unknown"))
        XCTAssertEqual(m.update("prefs", "t"), .failed("bad_request"))
        XCTAssertEqual(m.update("prefs", "t", set: ["a": .int(1)], remove: ["a"]), .failed("bad_request"))
        XCTAssertTrue(pushed(m).isEmpty)
    }

    func testDeleteStampsEveryPolicyButUnionAndRefusesRevision() throws {
        let m = try machine()
        XCTAssertEqual(m.delete("docs", "d"), .failed("collection-unknown"))
        XCTAssertEqual(m.delete("nope", "d"), .failed("collection-unknown"))
        XCTAssertTrue(pushed(m).isEmpty)
        XCTAssertEqual(m.delete("notes.work", "n"), .ok)
        let stamped = pushed(m)
        XCTAssertEqual(stamped.map { $0["op"] }, [.string("delete")])
        XCTAssertNotNil(stamped[0]["editedHlc"])
        let u = try machine()
        XCTAssertEqual(u.delete("tags", "t"), .ok)
        let union = pushed(u)
        XCTAssertEqual(union.map { $0["op"] }, [.string("delete")])
        XCTAssertNil(union[0]["editedHlc"], "a union delete carries no stamp")
    }

    func testAPreContactDeleteIsMarkedAndNotSent() throws {
        let m = try machine(contacted: false)
        XCTAssertEqual(m.delete("notes.work", "n"), .ok)
        XCTAssertNil(m.record("notes.work", "n"))
    }

    func testAPatternMatchesTheLongestPrefixWithSomethingAfterIt() throws {
        let m = try machine()
        XCTAssertEqual(m.collectionDecl("notes.work")?.policy, "lastWrite")
        XCTAssertEqual(m.collectionDecl("notes.deep.x")?.policy, "merge")
        XCTAssertEqual(m.collectionDecl("notes.exact")?.policy, "union", "an exact name beats a pattern")
        XCTAssertNil(m.collectionDecl("notes."), "nothing after the prefix")
        XCTAssertNil(m.collectionDecl("notes"))
        XCTAssertNil(m.collectionDecl("other.x"))
        XCTAssertEqual(m.put("notes.a", "id", .int(1)), .ok)
    }

    func testRecordIdsAreInByteOrderWithPendingCreates() throws {
        let m = try machine()
        for id in ["b", "\u{10000}", "a", "\u{FFFF}", "B"] { XCTAssertEqual(m.put("notes.x", id, .int(1)), .ok) }
        XCTAssertEqual(m.recordIds("notes.x"), ["B", "a", "b", "\u{FFFF}", "\u{10000}"])
        XCTAssertEqual(m.recordIds("notes.y"), [])
    }

    func testAWatchedCollectionRaisesRecordsEventsForLocalAndRemoteChanges() throws {
        let m = try machine()
        m.watchRecords("prefs", true)
        XCTAssertEqual(m.update("prefs", "main", set: ["a": .int(1)]), .ok)
        XCTAssertEqual(m.takeEvents(), [.records(collection: "prefs", ids: ["main"], origin: .local)])
        XCTAssertEqual(m.update("prefs", "main", set: ["a": .int(1)]), .ok)
        XCTAssertEqual(m.takeEvents(), [], "no change, no event")
        XCTAssertEqual(m.put("notes.a", "x", .int(1)), .ok)
        XCTAssertEqual(m.takeEvents(), [], "an unwatched collection raises none")
        m.watchRecords("prefs", false)
        XCTAssertEqual(m.update("prefs", "other", set: ["a": .int(1)]), .ok)
        XCTAssertEqual(m.takeEvents(), [])
    }

    func testAPulledRecordIsARemoteChange() throws {
        let m = try machine()
        m.watchRecords("prefs", true)
        m.setNetwork(.offline)
        m.setNetwork(.online)
        let reqs = m.takeRequests()
        XCTAssertFalse(reqs.isEmpty)
        let body = js(
            """
            {"encryption":"server","cursor":5,"changes":[{"record":["prefs","main"],"version":5,"value":{"a":1}}]}
            """)
        try m.receive(.answer(status: 200, body: body))
        XCTAssertTrue(m.takeEvents().contains(.records(collection: "prefs", ids: ["main"], origin: .remote)))
        XCTAssertEqual(m.record("prefs", "main"), SyncEffectiveValue(value: js("{\"a\":1}"), from: .cloud))
    }

    func testRecordKeysListTheHeldRecordsAndNoneSignedOut() throws {
        let m = try machine()
        XCTAssertTrue(m.recordKeys().isEmpty)
        m.setNetwork(.offline)
        m.setNetwork(.online)
        _ = m.takeRequests()
        let body = js(
            """
            {"encryption":"server","cursor":5,"changes":[{"record":["prefs","b"],"version":5,"value":{"a":1}},
              {"record":["tags","a"],"version":6,"value":["x"]}]}
            """)
        try m.receive(.answer(status: 200, body: body))
        let keys = m.recordKeys().map { "\($0.collection)/\($0.id)" }
        XCTAssertEqual(keys, ["prefs/b", "tags/a"])
        _ = m.signOut()
        XCTAssertTrue(m.recordKeys().isEmpty)
    }

    func testAnOutcomeTapSeesWhatOnOutcomeSees() throws {
        let m = try machine()
        let seen = LockedValue<[Int]>([])
        let direct = LockedValue<[Int]>([])
        m.onOutcome { t, _ in direct.with { $0.append(t) } }
        let remove = m.tapOutcomes { t, _ in seen.with { $0.append(t) } }
        guard case .ticket(let t) = m.putAt("docs", "d", .int(1), baseVersion: .any) else { return XCTFail() }
        let reqs = m.takeRequests()
        let id = reqs.compactMap { $0.body?.objectValue?["mutations"]?.arrayValue?.first?.objectValue?["mutationId"] }
        XCTAssertEqual(id.count, 1)
        try m.receive(
            .answer(
                status: 200,
                body: .object([
                    "encryption": .string("server"), "cursor": .int(1),
                    "results": .array([.object(["mutationId": id[0], "status": .string("ok"), "version": .int(1)])]),
                ])))
        XCTAssertEqual(seen.current, [t])
        XCTAssertEqual(direct.current, [t])
        remove()
        guard case .ticket = m.putAt("docs", "d", .int(2), baseVersion: .version(1)) else { return XCTFail() }
        m.signOut(discardUnsynced: true)
        XCTAssertEqual(seen.current, [t], "a removed tap hears nothing more")
    }
}

// MARK: - The host and the handle

final class CloudSyncCollectionHandleTests: XCTestCase {
    private func options() -> CloudSyncOptions { CloudSyncOptions(catalog: collectionsCatalog) }

    private func pushes(_ rig: HostRig) -> [[String: JSONValue]] {
        rig.sent.filter { $0.method == .post }.flatMap {
            ($0.body?.objectValue?["mutations"]?.arrayValue ?? []).compactMap(\.objectValue)
        }
    }

    private func blind(_ kind: SyncBlind.Kind, _ ctx: String, _ n: String) -> String {
        SyncBlind.blind(root: hRoot, kind: kind, ctx: ctx, n: n)
    }

    private func seal(_ collection: String, _ name: String, _ v: JSONValue) -> JSONValue {
        .string(Base64URL.encode(try! SyncEnvelope.seal(root: hRoot, collection: collection, name: name, value: v)))
    }

    private func handle(_ rig: HostRig, _ name: String, signedIn: Bool = true) async throws
        -> (CloudSyncCollection, CloudSyncHost)
    {
        let h = signedIn ? try await hSignedIn(rig, options: options()) : try await rig.host(options())
        return (CloudSyncCollection(name: name, host: h), h)
    }

    func testTheCatalogsCollectionsReachTheMachine() async throws {
        let rig = HostRig()
        let (prefs, h) = try await handle(rig, "prefs")
        let p1 = await prefs.policy()
        XCTAssertEqual(p1, "merge")
        let best = await h.collectionPolicy("best")
        let scratch = await h.collectionPolicy("scratch")
        let saves = await h.collectionPolicy("saves")
        let none = await h.collectionPolicy("nope")
        XCTAssertEqual(best, "max")
        XCTAssertEqual(scratch, "lastWrite", "a template's conflict")
        XCTAssertNil(saves, "there is no implicit saves collection")
        XCTAssertNil(none)
        XCTAssertEqual(CloudSyncHost.collectionsOf(collectionsCatalog).first { $0.name == "best" }?.field, "score")
    }

    func testAMergeUpdateSendsSealedFieldOperationsUnderOneStamp() async throws {
        let rig = HostRig()
        let (prefs, h) = try await handle(rig, "prefs")
        let r = await prefs.update("main", set: ["volume": .int(3)], remove: ["old"])
        XCTAssertEqual(r, .ok(mutationId: nil))
        let got = await prefs.get("main")
        XCTAssertEqual(got, SyncEffectiveValue(value: js("{\"volume\":3}"), from: .pending))
        await h.flush()
        let sent = pushes(rig)
        XCTAssertEqual(sent.map { $0["op"] }, [.string("setField"), .string("removeField")])
        XCTAssertEqual(sent[0]["field"], .string(blind(.field, "prefs", "volume")))
        XCTAssertEqual(sent[1]["field"], .string(blind(.field, "prefs", "old")))
        XCTAssertEqual(sent[0]["editedHlc"], sent[1]["editedHlc"])
        XCTAssertNotNil(sent[0]["ct"])
        XCTAssertNil(sent[0]["value"])
        XCTAssertEqual(
            sent[0]["target"]?.objectValue?["record"],
            .array([.string("prefs"), .string(blind(.record, "prefs", "main"))]))
        let wire = String(decoding: try JSONEncoder().encode(JSONValue.array(sent.map { .object($0) })), as: UTF8.self)
        XCTAssertFalse(wire.contains("volume") || wire.contains("\"main\""))
    }

    func testAUnionAddSendsASealedElement() async throws {
        let rig = HostRig()
        let (tags, h) = try await handle(rig, "tags")
        let element = js("{\"b\":1,\"a\":2}")
        let r1 = await tags.add("t", element)
        XCTAssertEqual(r1, .ok(mutationId: nil))
        let again = await tags.add("t", element)
        XCTAssertEqual(again, .ok(mutationId: nil))
        let r2 = await tags.remove("t", element)
        XCTAssertEqual(r2, .ok(mutationId: nil))
        await h.flush()
        let sent = pushes(rig)
        let spelled = "{\"a\":2,\"b\":1}"
        XCTAssertEqual(sent.first?["element"], .string(blind(.element, "tags", spelled)))
        XCTAssertNotNil(sent.first?["ct"])
        XCTAssertEqual(sent.last?["op"], .string("remove"))
        XCTAssertNil(sent.last?["ct"])
    }

    func testRefusalsAreReturnedAndNothingIsSent() async throws {
        let rig = HostRig()
        let (prefs, h) = try await handle(rig, "prefs")
        let (tags, _) = (CloudSyncCollection(name: "tags", host: h), h)
        let nope = CloudSyncCollection(name: "nope", host: h)
        let notes = CloudSyncCollection(name: "notes.work", host: h)
        let docs = CloudSyncCollection(name: "docs", host: h)
        await h.flush()
        let before = pushes(rig).count
        let a = await nope.put("a", .int(1))
        XCTAssertEqual(a, .refused(.collectionUnknown))
        let b = await tags.put("t", .int(1))
        XCTAssertEqual(b, .refused(.opInvalidForPolicy))
        let c = await prefs.add("p", .int(1))
        XCTAssertEqual(c, .refused(.opInvalidForPolicy))
        let d = await notes.put("", .int(1))
        XCTAssertEqual(d, .refused(.valueInvalid))
        let e = await prefs.update("p", set: [:], remove: [])
        XCTAssertEqual(e, .refused(.valueInvalid))
        let f = await prefs.update("p", set: [String(repeating: "x", count: 1025): .int(1)])
        XCTAssertEqual(f, .refused(.valueInvalid))
        let g = await prefs.update("p", set: ["": .int(1)])
        XCTAssertEqual(g, .refused(.valueInvalid))
        let big = await tags.add("t", .string(String(repeating: "x", count: 1100)))
        XCTAssertEqual(big, .refused(.valueInvalid))
        let sameField = await prefs.update("p", set: ["a": .int(1)], remove: ["a"])
        XCTAssertEqual(sameField, .refused(.valueInvalid))
        let versioned = await notes.put("n", .int(1), ifVersion: .any)
        XCTAssertEqual(versioned, .refused(.opInvalidForPolicy))
        let deleteVersion = await notes.delete("n", ifVersion: .version(2))
        XCTAssertEqual(deleteVersion, .refused(.opInvalidForPolicy))
        let ok = await notes.put("n", .int(1))
        XCTAssertEqual(ok, .ok(mutationId: nil))
        _ = docs
        await h.flush()
        XCTAssertEqual(pushes(rig).count - before, 1, "only the accepted put went out")
        let undeclared = await nope.get("a")
        let ids = await nope.ids()
        XCTAssertNil(undeclared)
        XCTAssertEqual(ids, [])
    }

    func testASignedOutHandleRefusesWithSignedOut() async throws {
        let rig = HostRig()
        let h = try await rig.host(options())
        let notes = CloudSyncCollection(name: "notes.a", host: h)
        let r = await notes.put("n", .int(1))
        XCTAssertEqual(r, .refused(.signedOut))
    }

    func testAPulledRecordRaisesAChangeAndOpensTheSealedFields() async throws {
        let rig = HostRig()
        let (prefs, h) = try await handle(rig, "prefs", signedIn: false)
        let seen = LockedValue<[CollectionEvent]>([])
        let sub = await prefs.on { e in seen.with { $0.append(e) } }
        let row: JSONValue = .object([
            "record": .array([.string("prefs"), .string(blind(.record, "prefs", "main"))]),
            "fields": .array([
                .object([
                    "field": .string(blind(.field, "prefs", "a")), "ct": seal("prefs", "main\u{0}a", .int(1)),
                ])
            ]), "version": .int(5),
        ])
        rig.responder = { req, _ in
            if req.method == .get {
                return .answer(status: 200, body: hReply(["cursor": .int(5), "changes": .array([row])]))
            }
            return .answer(status: 200, body: hReply())
        }
        _ = try await h.signIn(hALICE)
        await h.touch()
        let got = await prefs.get("main")
        XCTAssertEqual(got, SyncEffectiveValue(value: js("{\"a\":1}"), from: .cloud))
        XCTAssertTrue(seen.current.contains(.change(ids: ["main"], origin: .remote)))
        let ids = await prefs.ids()
        XCTAssertEqual(ids, ["main"])
        await sub.cancel()
        let count = seen.current.count
        _ = await prefs.update("main", set: ["b": .int(2)])
        XCTAssertEqual(seen.current.count, count, "a cancelled listener hears nothing more")
    }

    func testALocalWriteRaisesAChangeAtOnce() async throws {
        let rig = HostRig()
        let (notes, _) = try await handle(rig, "notes.w")
        let seen = LockedValue<[CollectionEvent]>([])
        _ = await notes.on { e in seen.with { $0.append(e) } }
        _ = await notes.put("b", .int(1))
        _ = await notes.put("a", .int(1))
        XCTAssertEqual(
            seen.current, [.change(ids: ["b"], origin: .local), .change(ids: ["a"], origin: .local)])
        let ids = await notes.ids()
        XCTAssertEqual(ids, ["a", "b"])
    }

    func testACompareAndSetPutReportsItsOutcomeToTheListener() async throws {
        let rig = HostRig()
        let (docs, h) = try await handle(rig, "docs")
        rig.responder = { req, _ in
            if req.method == .get { return .answer(status: 200, body: hReply()) }
            let ids = (req.body?.objectValue?["mutations"]?.arrayValue ?? []).compactMap {
                $0.objectValue?["mutationId"]
            }
            return .answer(
                status: 200,
                body: hReply([
                    "results": .array(
                        ids.map { .object(["mutationId": $0, "status": .string("ok"), "version": .int(4)]) })
                ]))
        }
        let seen = LockedValue<[CollectionEvent]>([])
        _ = await docs.on { e in seen.with { $0.append(e) } }
        let r = await docs.put("d", .int(1), ifVersion: .version(3))
        guard case .ok(let ticket?) = r else { return XCTFail("no ticket: \(r)") }
        await h.flush()
        XCTAssertTrue(seen.current.contains(.outcome(mutationId: ticket, .ok(version: 4))))
        let sent = pushes(rig).last
        XCTAssertEqual(sent?["baseVersion"], .int(3))
        // Not this handle's ticket: another handle's write is not reported here.
        let other = CloudSyncCollection(name: "docs", host: h)
        _ = await other.put("e", .int(1), ifVersion: .any)
        await h.flush()
        XCTAssertEqual(seen.current.filter { if case .outcome = $0 { return true } else { return false } }.count, 1)
    }

    func testAWatchAndAnOutcomeTapSurviveAMachineRebuild() async throws {
        let rig = HostRig()
        let (prefs, h) = try await handle(rig, "prefs")
        let seen = LockedValue<[CollectionEvent]>([])
        _ = await prefs.on { e in seen.with { $0.append(e) } }
        try await h.purge()
        _ = try await h.signIn(hALICE)
        _ = await prefs.update("main", set: ["a": .int(1)])
        XCTAssertTrue(seen.current.contains(.change(ids: ["main"], origin: .local)))
    }

    func testWhatCannotBeSealedIsRefusedWithoutJournallingOrSending() async throws {
        let rig = HostRig()
        let (prefs, h) = try await handle(rig, "prefs")
        let notes = CloudSyncCollection(name: "notes.work", host: h)
        let tags = CloudSyncCollection(name: "tags", host: h)
        await h.flush()
        let before = pushes(rig).count
        let bad = CollectionResult.refused(.valueInvalid)
        let r1 = await notes.put("a\u{0}b", .int(1))
        let r2 = await notes.put("n", .double(.nan))
        let r3 = await notes.put("n", .int(1 << 60))
        let r4 = await notes.put(String(repeating: "x", count: 129), .int(1))
        let r5 = await notes.put("a b", .int(1))
        let r6 = await notes.put("x:" + String(repeating: "A", count: 43), .int(1))
        let r7 = await prefs.update("p", set: ["f\u{0}": .int(1)])
        let r8 = await prefs.update("p", set: ["f": .double(.infinity)])
        let r9 = await tags.add("t", .double(.nan))
        let r10 = await notes.delete("a\u{0}b")
        for r in [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10] { XCTAssertEqual(r, bad) }
        await h.flush()
        XCTAssertEqual(pushes(rig).count, before, "nothing was sent")
        let ids = await notes.ids()
        XCTAssertEqual(ids, [])
    }

    func testRefusalsComeInOneOrder() async throws {
        let rig = HostRig()
        let h = try await rig.host(options())
        let nope = CloudSyncCollection(name: "nope", host: h)
        let tags = CloudSyncCollection(name: "tags", host: h)
        let unknown = await nope.put("a\u{0}", .int(1))
        XCTAssertEqual(unknown, .refused(.collectionUnknown))
        let out = await tags.put("a\u{0}", .int(1))
        XCTAssertEqual(out, .refused(.signedOut), "signed out before the policy and the value")
        let (tags2, _) = (try await handle(HostRig(), "tags"))
        let policy = await tags2.put("a\u{0}", .int(1))
        XCTAssertEqual(policy, .refused(.opInvalidForPolicy))
    }

    func testTwoHandlesOnOneCollectionDoNotSilenceEachOther() async throws {
        let rig = HostRig()
        let (a, h) = try await handle(rig, "prefs")
        let b = CloudSyncCollection(name: "prefs", host: h)
        let seen = LockedValue<[CollectionEvent]>([])
        _ = await a.on { e in seen.with { $0.append(e) } }
        let sub = await b.on { _ in }
        await sub.cancel()
        _ = await a.update("main", set: ["v": .int(1)])
        XCTAssertTrue(seen.current.contains(.change(ids: ["main"], origin: .local)))
    }

    func testAnUnsealableJournaledMutationIsDroppedAndTheNextOneIsPushed() async throws {
        let rig = HostRig()
        let h = try await hSignedIn(rig, options: options())
        await h.flush()
        let before = pushes(rig).count
        // Journaled around the collection handle: a setting name no codec spells.
        _ = await h.set("x\u{0}y", .string("v"))
        await h.flush()
        XCTAssertEqual(pushes(rig).count, before, "nothing unsealable was sent")
        let good = CloudSyncCollection(name: "notes.work", host: h)
        let r = await good.put("n1", .int(2))
        XCTAssertEqual(r, .ok(mutationId: nil))
        await h.flush()
        XCTAssertEqual(pushes(rig).count - before, 1, "the next mutation went out")
        let st = await h.status()
        XCTAssertEqual(st?.pending, 0)
    }
}
