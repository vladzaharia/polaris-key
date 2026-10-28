// @pkey-feature sync.settings
// The Cloud Sync host (U-07.6): H-1 to H-6 and H-10, the person binding (A-1), one pump at a time,
// and `openPull` feeding `CloudSyncMachine.receive`. Everything runs against fakes: a scripted Worker,
// a fixture-root codec, a fake key ring and a temporary state directory. The H rules each name their
// test below. H-7 to H-9 are in CloudSyncHostBoundsTests.

import Foundation
import Testing

@testable import PolarisKey
@testable import PolarisKeyCore

private let VOL = "audio.volume"
private let BIND = "input.bindings"
private let OPEN = "my.private.key"
private let C = HostCodec.settingsCollection
private func j(_ s: String) -> JSONValue { hJ(s) }
private func sealedCt(_ name: String, _ v: JSONValue) -> JSONValue {
    .string(Base64URL.encode(try! SyncEnvelope.seal(root: hRoot, collection: C, name: name, value: v)))
}
private func blinded(_ n: String) -> String { SyncBlind.blind(root: hRoot, kind: .setting, ctx: C, n: n) }
private func signedIn(_ rig: HostRig, options: CloudSyncOptions = CloudSyncOptions(catalog: hMirror)) async throws
    -> CloudSyncHost
{
    try await hSignedIn(rig, options: options)
}

@Suite struct CloudSyncHostTests {
    // MARK: the machine's own receive, fed by openPull

    private func machine() throws -> CloudSyncMachine {
        let routes = syncedSettings(hMirror)
        var o = SyncMachineOptions(
            product: "demo", catalog: SyncMachineCatalog(settings: routes),
            document: SyncMachineDocument(values: [VOL: .double(0.8)]), now: hT0,
            newClientId: { "c_" + String(repeating: "0", count: 15) + "client1" })
        o.subject = hALICE
        o.hasRoot = true
        o.discovery = .e2e
        let m = try CloudSyncMachine(o)
        let req = m.takeRequests()
        #expect(req.count == 1 && req[0].method == .get)
        return m
    }

    private func fed(_ over: [String: JSONValue]) throws -> CloudSyncMachine {
        let m = try machine()
        let r = try HostCodec.openPull(hReply(over), codec: FixtureCodec(hRoot))
        try m.receive(.answer(status: 200, body: r.body), opened: r.opened)
        return m
    }

    private func documentOnly(_ m: CloudSyncMachine) {
        #expect(m.settingState(VOL).invalid)
        #expect(m.get(VOL) == SyncEffectiveValue(value: .double(0.8), from: .document))
    }

    @Test func receiveReadsLegacyPlaintextBelowEncryptionSinceAndASealedRow() throws {
        let m = try fed([
            "encryptionSince": .int(10),
            "changes": .array([
                .object(["setting": .string(VOL), "scope": .string("user"), "value": .double(0.1), "version": .int(3)]),
                .object([
                    "setting": .string(BIND), "scope": .string("user"), "ct": sealedCt(BIND, j("{\"jump\":\"space\"}")),
                    "version": .int(11),
                ]),
            ]),
        ])
        #expect(m.get(VOL) == SyncEffectiveValue(value: .double(0.1), from: .cloud))
        #expect(!m.settingState(VOL).invalid)
        #expect(m.get(BIND) == SyncEffectiveValue(value: j("{\"jump\":\"space\"}"), from: .cloud))
    }

    @Test func receiveRefusesAForgedPlaintextRowEvenMarkedSealed() throws {
        let forged: JSONValue = .object([
            "setting": .string(VOL), "scope": .string("user"), "value": .int(666), "version": .int(50),
            "sealed": .bool(true), "seq": .int(1),
        ])
        documentOnly(try fed(["encryptionSince": .int(10), "changes": .array([forged])]))
    }

    @Test func receiveFallsThroughToTheDocumentOnAnUnopenableCt() throws {
        let other = Data((0..<32).map { UInt8(truncatingIfNeeded: 200 - $0) })
        let ct = Base64URL.encode(try SyncEnvelope.seal(root: other, collection: C, name: VOL, value: .double(0.1)))
        let row: JSONValue = .object([
            "setting": .string(VOL), "scope": .string("user"), "ct": .string(ct), "value": .int(666),
            "version": .int(4),
        ])
        documentOnly(try fed(["encryptionSince": .int(0), "changes": .array([row])]))
    }

    @Test func receiveDoesNotLetAServedAliasMapMakeOneSettingReadAnother() throws {
        let m = try fed([
            "encryptionSince": .int(0), "aliases": .object(["audio.alt": .string(VOL)]),
            "changes": .array([
                .object([
                    "setting": .string(VOL), "scope": .string("user"), "ct": sealedCt(VOL, .double(0.1)),
                    "version": .int(4),
                ])
            ]),
        ])
        #expect(m.get(VOL) == SyncEffectiveValue(value: .double(0.1), from: .cloud))
        #expect(m.get("audio.alt").value != .double(0.1))
    }

    // MARK: H-3, H-4: the transport

    private final class FakeNet: PolarisTransport, @unchecked Sendable {
        private let lock = NSLock()
        private(set) var requests: [PolarisRequest] = []
        var answer: @Sendable (PolarisRequest) throws -> PolarisResponse = { _ in
            PolarisResponse(status: 200, body: Data("{}".utf8))
        }
        func send(_ r: PolarisRequest) async throws -> PolarisResponse {
            lock.withLock { requests.append(r) }
            return try answer(r)
        }
    }

    private func net(_ n: FakeNet, token: String? = "pkeyt_x") -> CloudSyncTransport {
        CloudSyncTransport(
            product: "demo", baseUrl: "https://key.example", transport: n, headers: { ["X-PKey-Device": "d"] },
            token: { token })
    }

    @Test func h3h4TransportNeverFollowsReadsUnderACapAndHasADeadline() async {
        let n = FakeNet()
        let t = net(n)
        _ = await t.send(SyncRequest(method: .get, path: "/demo/sync?cursor=0&clientId=c_x"))
        _ = await t.send(SyncRequest(method: .post, path: "/demo/sync/ops", body: .object(["a": .int(1)])))
        for r in n.requests {
            #expect(!r.followRedirects)
            #expect(r.timeoutSeconds == 15)
            #expect(r.maxBodyBytes == 8 * 1024 * 1024 + 1)
            #expect(r.headers["authorization"] == "Bearer pkeyt_x")
            #expect(r.headers["X-PKey-Device"] == "d")
            #expect(r.url.absoluteString.hasPrefix("https://key.example/demo/sync"))
        }
        #expect(n.requests[1].headers["content-type"] == "application/json")
    }

    @Test func h3AnOverCapBodyIsNoAnswerAndA3xxIsAnAnswerNotFollowed() async {
        let n = FakeNet()
        let t = net(n)
        let path = "/demo/sync?cursor=0&clientId=c_x"
        n.answer = { _ in PolarisResponse(status: 200, body: Data(count: 8 * 1024 * 1024 + 1)) }
        #expect(await t.send(SyncRequest(method: .get, path: path)) == .transport)
        n.answer = { _ in PolarisResponse(status: 302, body: Data(), headers: ["Location": "https://evil.example/x"]) }
        #expect(await t.send(SyncRequest(method: .get, path: path)) == .answer(status: 302, body: nil))
        n.answer = { _ in PolarisResponse(status: 200, body: Data("<html>".utf8)) }
        #expect(await t.send(SyncRequest(method: .get, path: path)) == .transport)
        n.answer = { _ in PolarisResponse(status: 502, body: Data("<html>".utf8)) }
        #expect(await t.send(SyncRequest(method: .get, path: path)) == .answer(status: 502, body: nil))
        n.answer = { _ in throw PolarisError(code: "transport", message: "x") }
        #expect(await t.send(SyncRequest(method: .get, path: path)) == .transport)
    }

    @Test func h3SendsNothingForAPathOutsideSyncOrWithoutAToken() async {
        let n = FakeNet()
        for path in [
            "/demo/config", "/other/sync/ops", "/demo/sync?cursor=0&x=a b", "/demo/syncx",
            "//evil.example/demo/sync/ops",
        ] {
            #expect(await net(n).send(SyncRequest(method: .get, path: path)) == .transport)
        }
        #expect(await net(n, token: nil).send(SyncRequest(method: .get, path: "/demo/sync?cursor=0")) == .transport)
        #expect(n.requests.isEmpty)
    }

    @Test func h3TheRedirectDelegateAnswersTheThreeXxWhenNotFollowing() {
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: URL(string: "https://key.example/demo/sync?cursor=0")!)
        let resp = HTTPURLResponse(
            url: task.originalRequest!.url!, statusCode: 302, httpVersion: nil,
            headerFields: ["Location": "https://evil.example/x"])!
        var next = URLRequest(url: URL(string: "https://evil.example/x")!)
        next.setValue("Bearer t", forHTTPHeaderField: "authorization")
        func run(follow: Bool) -> (URLRequest?, PolarisError?) {
            let d = RedirectPolicy.Delegate(follow: follow)
            var got: URLRequest? = URLRequest(url: URL(string: "https://unset.example")!)
            d.urlSession(session, task: task, willPerformHTTPRedirection: resp, newRequest: next) { got = $0 }
            return (got, d.refusal)
        }
        let (stopped, refusal) = run(follow: false)
        #expect(stopped == nil && refusal == nil)  // the 3xx is the answer, nothing goes to the new URL
        let (followed, _) = run(follow: true)
        #expect(followed != nil)  // the default is unchanged
        session.invalidateAndCancel()
    }

    // MARK: H-6: the state file

    @Test func h6StateFileIsOwnerOnlyExcludedFromBackupAndRoundTripsTheJournal() async throws {
        let rig = HostRig()
        let h = try await signedIn(rig)
        #expect(await h.set(VOL, .double(0.4)) == .ok)
        rig.now += 5_000
        await h.touch()
        let url = rig.dir.appendingPathComponent(cloudSyncFileName)
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect((attrs[.posixPermissions] as? Int) == 0o600)
        #expect(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: rig.dir.path).filter {
            $0.hasSuffix(".tmp")
        }
        #expect(leftovers.isEmpty)
        // The root never reaches the file.
        let text = try Data(contentsOf: url)
        #expect(text.range(of: hRoot) == nil)
        #expect(
            String(decoding: text, as: UTF8.self).range(of: hRoot.map { String(format: "%02x", $0) }.joined()) == nil)
        // A relaunch gets the journal back.
        let loaded = CloudSyncStateFile(stateDir: rig.dir, product: "demo").load()
        #expect(loaded.persisted?.subject == hALICE)
        #expect(loaded.persisted?.partitions[hALICE]?.settings[VOL]?.value == .double(0.4))
        let h2 = try await rig.host()
        #expect(await h2.get(VOL)?.value == .double(0.4))
    }

    @Test func h6AnotherProductsOrACorruptFileIsEmptyAndRemoveSweeps() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pk-state-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let f = CloudSyncStateFile(stateDir: dir, product: "demo")
        var st = SyncMachineState(
            subject: nil, partitions: [syncLocalPartition: SyncPartition(clientId: nil)], hlc: (1, 2), offsetMs: 3,
            contacted: true)
        st.aliases = ["a": "b"]
        try f.save(CloudSyncFile(persisted: st, catalog: hMirror, openKeys: ["k"]))
        #expect(f.load().persisted == st)
        #expect(f.load().openKeys == ["k"])
        #expect(CloudSyncStateFile(stateDir: dir, product: "other").load() == CloudSyncFile())
        try Data("{not json".utf8).write(to: f.url)
        #expect(f.load() == CloudSyncFile())
        try Data().write(to: dir.appendingPathComponent("\(cloudSyncFileName).abc.tmp"))
        try f.remove()
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty)
        try f.remove()  // already gone: fine
    }

    @Test func h6APlantedSymlinkIsNeverWrittenThrough() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pk-state-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent("victim.txt")
        try Data("keep".utf8).write(to: target)
        // The state file itself is a symlink: the rename replaces the link, the victim is untouched.
        try FileManager.default.createSymbolicLink(
            at: dir.appendingPathComponent(cloudSyncFileName), withDestinationURL: target)
        try CloudSyncStateFile(stateDir: dir, product: "demo").save(CloudSyncFile())
        #expect(try Data(contentsOf: target) == Data("keep".utf8))
        #expect(
            (try? FileManager.default.destinationOfSymbolicLink(
                atPath: dir.appendingPathComponent(cloudSyncFileName).path)) == nil)
    }

    // MARK: H-1, H-2: the catalog

    private func served(_ entries: String, version: Int = 2, extra: String = "") -> JSONValue {
        j("{\"schemaVersion\":\(version),\(extra)\"entries\":[\(entries)]}")
    }

    @Test func h1TheMirrorIsAuthoritativeAndAServedCatalogOnlyAddsKeys() async throws {
        let rig = HostRig()
        rig.setSchema(
            served(
                """
                {"key":"audio.volume","kind":"config","user":{"sync":"user","conflict":"merge"}},
                {"key":"new.key","kind":"config","user":{"sync":"user","conflict":"max"}}
                """, extra: "\"cloudSync\":{\"encryption\":\"server\"},"))
        rig.responder = { _, _ in .answer(status: 200, body: hReply(["catalogVersion": .int(2)])) }
        let h = try await signedIn(rig)
        let table = await h.routeTable()
        #expect(table.map(\.key) == [VOL, BIND, "new.key"])
        #expect(table[0].policy == .lastWrite)  // the app's compiled route wins
        #expect(table.allSatisfy { $0.encryption == nil })  // the served mode is dropped
        let machineMode = await h.encryptionMode()
        #expect(machineMode == .e2e)
    }

    @Test func h1ANonDeclaredKeyTheMachineHoldsOpenIsNotTurnedDeclaredByTheServer() async throws {
        let rig = HostRig()
        rig.responder = { req, _ in
            if req.method == .get { return .answer(status: 200, body: hReply()) }
            let ids = (req.body?.objectValue?["mutations"]?.arrayValue ?? []).compactMap {
                $0.objectValue?["mutationId"]
            }
            return .answer(
                status: 200,
                body: hReply([
                    "catalogVersion": .int(2),
                    "results": .array(
                        ids.map { .object(["mutationId": $0, "status": .string("ok"), "version": .int(2)]) }),
                ]))
        }
        rig.setSchema(served("{\"key\":\"\(OPEN)\",\"kind\":\"config\",\"user\":{\"sync\":\"user\"}}"))
        let h = try await signedIn(rig)
        // An open key is an own mutation the catalog does not declare.
        #expect(await h.set(OPEN, .string("v")) == .ok)
        rig.now += 5_000
        await h.touch()
        #expect(await h.openKeyNames().contains(OPEN))
        #expect(rig.fetchCount == 1)  // the push answer named catalogVersion 2: the schema was fetched
        #expect(!(await h.routeKeys().contains(OPEN)))  // and it did not turn the open key into a declared one
    }

    @Test func h1VettingDropsBadKeysDuplicatesAndOversizedCatalogs() {
        let bad = CloudSyncHost.vetted(
            served(
                """
                {"key":"ok.key"},{"key":"ok.key"},{"key":"has space"},{"key":""},{"x":1},{"key":"a/b"}
                """))
        #expect(bad?.objectValue?["entries"]?.arrayValue?.count == 1)
        let many = (0..<1025).map { "{\"key\":\"k\($0)\"}" }.joined(separator: ",")
        #expect(CloudSyncHost.vetted(served(many)) == nil)
        let big = "{\"key\":\"big\",\"pad\":\"\(String(repeating: "x", count: 1024 * 1024))\"}"
        #expect(CloudSyncHost.vetted(served(big)) == nil)
        #expect(CloudSyncHost.vetted(.object(["entries": .array([])])) == nil)
        #expect(CloudSyncHost.vetted(.string("x")) == nil)
    }

    @Test func h2RefetchesOnAChangedVersionAtMostEveryFiveMinutesAndSkipsAnEqualRebuild() async throws {
        let rig = HostRig()
        rig.setSchema(served("{\"key\":\"new.key\",\"kind\":\"config\",\"user\":{\"sync\":\"user\"}}", version: 2))
        let v = LockedValue<Int>(2)
        rig.responder = { req, _ in
            req.method == .get
                ? .answer(status: 200, body: hReply(["catalogVersion": .int(v.current)]))
                : .answer(status: 200, body: hReply(["catalogVersion": .int(v.current)]))
        }
        let h = try await signedIn(rig)
        #expect(rig.fetchCount == 1)
        #expect(await h.routeKeys().contains("new.key"))
        let gen = await h.generationCount()
        // Another version, inside the window: no fetch.
        v.set(3)
        rig.now += 1_000
        _ = await h.set(VOL, .double(0.2))
        rig.now += 5_000
        await h.touch()
        #expect(rig.fetchCount == 1)
        // After the window: fetched once, the same catalog again does not rebuild the machine.
        rig.now += CloudSyncHost.catalogRefetchMs
        _ = await h.set(VOL, .double(0.3))
        rig.now += 5_000
        await h.touch()
        #expect(rig.fetchCount == 2)
        #expect(await h.generationCount() == gen)
        // A tried version is not asked again.
        rig.now += CloudSyncHost.catalogRefetchMs
        _ = await h.set(VOL, .double(0.35))
        rig.now += 5_000
        await h.touch()
        #expect(rig.fetchCount == 2)
    }

    @Test func h2AChangedRouteSetRebuildsTheMachineFromItsOwnJournal() async throws {
        let rig = HostRig()
        rig.responder = { _, _ in .answer(status: 200, body: hReply(["catalogVersion": .int(2)])) }
        let h = try await signedIn(rig)
        #expect(rig.fetchCount == 1)  // the first pull named version 2, the hMirror holds 1
        let gen = await h.generationCount()
        rig.setSchema(served("{\"key\":\"added.later\",\"kind\":\"config\",\"user\":{\"sync\":\"user\"}}", version: 3))
        rig.now += CloudSyncHost.catalogRefetchMs
        rig.responder = { _, _ in .answer(status: 200, body: hReply(["catalogVersion": .int(3)])) }
        _ = await h.set(VOL, .double(0.2))
        rig.now += 5_000
        await h.touch()
        #expect(await h.routeKeys().contains("added.later"))
        #expect(await h.generationCount() > gen)
        #expect(await h.get(VOL)?.value == .double(0.2))  // the journal survived the rebuild
    }

    // MARK: H-5: open-key names

    @Test func h5OpenKeysComeOnlyFromSealedRowsAndOwnMutationsAndAreCapped() async throws {
        let rig = HostRig()
        let honest = blinded("sealed.open.key")
        rig.responder = { _, _ in
            .answer(
                status: 200,
                body: hReply([
                    "encryptionSince": .int(0),
                    "changes": .array([
                        .object([
                            "setting": .string(honest), "scope": .string("user"),
                            "ct": sealedCt("sealed.open.key", .int(1)), "version": .int(5),
                        ]),
                        // A plaintext row and an unopenable one name keys too: neither enters the set.
                        .object([
                            "setting": .string("plain.liar"), "scope": .string("user"), "value": .int(1),
                            "version": .int(6),
                        ]),
                        .object([
                            "setting": .string(blinded("x")), "scope": .string("user"), "ct": .string("AAAA"),
                            "version": .int(7),
                        ]),
                    ]),
                ]))
        }
        let h = try await signedIn(rig)
        #expect(await h.openKeyNames() == ["sealed.open.key"])
        // The cap: the oldest names go first.
        for i in 0..<(cloudSyncOpenKeysMax + 10) { await h.noteOpenKeyForTest("k\(i)") }
        let names = await h.openKeyNames()
        #expect(names.count == cloudSyncOpenKeysMax)
        #expect(names.last == "k\(cloudSyncOpenKeysMax + 9)" && !names.contains("sealed.open.key"))
    }

    // MARK: H-10, the codec drops

    @Test func h10ALockedRingSendsAndPullsNothingAndTheHostAddsNoRequest() async throws {
        let rig = HostRig()
        rig.codec.lock(true)
        let h = try await signedIn(rig)
        await h.touch()
        #expect(rig.sent.isEmpty)
        #expect(rig.fetchCount == 0)
        // The root arrives: the pump sends.
        rig.setRoot(true)
        await h.touch()
        #expect(!rig.sent.isEmpty)
    }

    @Test func h10ARootLostMidFlightDropsTheAnswerAndTheCursorStays() async throws {
        let rig = HostRig()
        rig.onSend = { $0.codec.lock(true) }  // the ring locks while the request is out
        rig.responder = { _, _ in .answer(status: 200, body: hReply(["cursor": .int(9)])) }
        let h = try await signedIn(rig)
        #expect(rig.sent.count >= 1)
        #expect(await h.cursor() == 0)
    }

    @Test func h10AnE2e200ThatIsNotAnObjectIsDropped() async throws {
        let rig = HostRig()
        rig.responder = { _, _ in .answer(status: 200, body: .array([])) }
        let h = try await signedIn(rig)
        #expect(await h.cursor() == 0)
    }

    @Test func h10ARepeatedMutationIdAnswerIsDroppedAndTheEditStaysPending() async throws {
        let rig = HostRig()
        let h = try await signedIn(rig)
        rig.responder = { req, _ in
            if req.method == .get { return .answer(status: 200, body: hReply()) }
            let r: JSONValue = .object(["mutationId": .int(1), "status": .string("ok"), "version": .int(3)])
            return .answer(status: 200, body: hReply(["results": .array([r, r])]))
        }
        _ = await h.set(VOL, .double(0.6))
        rig.now += 5_000
        await h.touch()
        #expect(await h.status()?.pending == 1)
    }

    @Test func h10ASealedPushLeavesNoPlaintextOnTheWire() async throws {
        let rig = HostRig()
        let h = try await signedIn(rig)
        _ = await h.set(VOL, .string("secret-volume"))
        _ = await h.set(OPEN, .string("secret-open"))
        rig.now += 5_000
        await h.touch()
        let post = try #require(rig.sent.last { $0.method == .post })
        let wire = String(decoding: try JSONEncoder().encode(post.body), as: UTF8.self)
        #expect(!wire.contains("secret") && !wire.contains(OPEN) && wire.contains("\"ct\""))
        #expect(wire.contains(blinded(OPEN)))
    }

    // MARK: HOST-BIND (A-1)

    @Test func hostBindDropsARequestBoundToAnotherPersonBeforeItIsSent() async throws {
        let rig = HostRig()
        let h = try await signedIn(rig)
        let before = rig.sent.count
        _ = await h.set(VOL, .double(0.7))
        rig.now += 5_000
        rig.subject = hBOB  // the session is another person's now
        await h.touch()
        #expect(rig.sent.count == before)
        #expect(await h.status()?.pending == 1)  // the edit waits; nothing was sent to the server
    }

    @Test func hostBindDoesNotReadAnAnswerWhenThePersonChangedDuringTheRequest() async throws {
        let rig = HostRig()
        let h = try await signedIn(rig)
        _ = await h.set(VOL, .double(0.7))
        rig.now += 5_000
        rig.onSend = { $0.subject = hBOB }
        await h.touch()
        #expect(await h.status()?.pending == 1)  // the ok result was not applied
    }

    @Test func hostBindAnUnknownSessionPersonDoesNotBlock() async throws {
        let rig = HostRig()
        rig.subject = nil  // offline or discovery not loaded: unknown, not a different person
        let h = try await signedIn(rig)
        _ = await h.set(VOL, .double(0.7))
        rig.now += 5_000
        await h.touch()
        #expect(rig.sent.contains { $0.method == .post })
        #expect(await h.status()?.pending == 0)
    }

    // MARK: one pump at a time, the budget, the timer

    @Test func onePumpRunsAtATimeEvenWhenTouchedConcurrently() async throws {
        let rig = HostRig()
        rig.sendDelayMs = 20
        let h = try await rig.host()
        _ = try await h.signIn(hALICE)
        await withTaskGroup(of: Void.self) { g in
            for _ in 0..<8 { g.addTask { await h.touch() } }
        }
        #expect(rig.maxInFlight == 1)
    }

    @Test func aPumpMakesAtMostSixtyFourExchanges() async throws {
        let rig = HostRig()
        let cursor = LockedValue<Int>(0)
        rig.responder = { _, _ in
            cursor.set(cursor.current + 1)
            return .answer(status: 200, body: hReply(["cursor": .int(cursor.current), "more": .bool(true)]))
        }
        let h = try await signedIn(rig)
        #expect(rig.sent.count <= CloudSyncHost.maxExchanges)
        #expect(rig.sent.count == CloudSyncHost.maxExchanges)
        _ = h
    }

    @Test func theTimerPushesADebouncedEditWithoutAnotherCall() async throws {
        let rig = HostRig()
        rig.now = Int(Date().timeIntervalSince1970 * 1000)
        let clock = rig.deps().clock
        _ = clock
        var deps = rig.deps()
        deps.clock = { Int(Date().timeIntervalSince1970 * 1000) }
        let h = CloudSyncHost(deps: deps, options: CloudSyncOptions(catalog: hMirror))
        try await h.start()
        _ = try await h.signIn(hALICE)
        await h.touch()
        _ = await h.set(VOL, .double(0.9))
        var seen = false
        for _ in 0..<40 where !seen {
            try await Task.sleep(nanoseconds: 100_000_000)
            seen = rig.sent.contains { $0.method == .post }
        }
        #expect(seen)
    }
}
