// @pkey-feature sync.saves
//
// The machine and host under saves (U-22.5): a record write on an explicit base, awaited; the answer of that
// one mutation (ok, conflict, rejected, dropped by a sign-out); a delete; the file pointer a pulled record
// carries; the blinded id; the cancel that ends the wait and the pause that does not; and a purge that removes
// the person's chunk cache and nothing beside it. Over the scripted Worker of `CloudSyncHostRig`, end-to-end
// mode, a fixture root.

import Foundation
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

private let pointer: JSONValue = .object([
    "version": .int(4), "size": .int(77), "sha256": .string(String(repeating: "cd", count: 32)),
    "format": .string("whole"),
])
private let pointerFile = SyncFilePointer(json: pointer)!

private func sealedValue(_ id: String, _ v: JSONValue) -> JSONValue {
    .string(Base64URL.encode(try! SyncEnvelope.seal(root: hRoot, collection: "saves", name: id, value: v)))
}

private func blindId(_ id: String) -> String { SyncBlind.blind(root: hRoot, kind: .record, ctx: "saves", n: id) }

private func mutations(_ req: SyncRequest) -> [[String: JSONValue]] {
    (req.body?.objectValue?["mutations"]?.arrayValue ?? []).compactMap(\.objectValue)
}

private func lastPush(_ rig: HostRig) -> SyncRequest? { rig.sent.last { $0.method == .post } }

/// Answers every push with `result(mutation)`, and a pull with `changes`.
private func script(
    _ rig: HostRig, changes: [JSONValue] = [], result: @escaping @Sendable ([String: JSONValue]) -> JSONValue
) {
    rig.responder = { req, _ in
        if req.method == .get { return .answer(status: 200, body: hReply(["changes": .array(changes)])) }
        let results = mutations(req).map(result)
        return .answer(status: 200, body: hReply(["results": .array(results)]))
    }
}

private func ok(_ m: [String: JSONValue], _ version: Int) -> JSONValue {
    .object(["mutationId": m["mutationId"]!, "status": .string("ok"), "version": .int(version)])
}

/// There is no implicit collection: the catalog declares `saves`.
private let savesOptions = CloudSyncOptions(
    catalog: .object(
        (hMirror.objectValue ?? [:]).merging([
            "cloudSync": .object(["collections": .array([.object(["name": .string("saves"), "conflict": .string("revision")])])])
        ]) { $1 }))

final class CloudSyncSavesHostTests: XCTestCase {
    private func records(_ rig: HostRig, changes: [JSONValue] = []) async throws -> (MachineRecords, CloudSyncHost) {
        let h = try await hSignedIn(rig, options: savesOptions)
        await h.touch()
        let r = MachineRecords(host: h)
        await r.bind()
        return (r, h)
    }

    func testARecordTombstoneRemovesTheHeldRecordInE2E() async throws {
        let rig = HostRig()
        let change: JSONValue = .object([
            "record": .array([.string("saves"), .string(blindId("slot1"))]), "version": .int(4),
            "ct": sealedValue("slot1", .object(["a": .int(1)])),
        ])
        script(rig, changes: [change]) { ok($0, 5) }
        let (recs, h) = try await records(rig)
        await h.flush()
        let before = try await recs.list()
        XCTAssertEqual(before.map(\.id), ["slot1"])
        // Another device deleted slot1: the Worker serves a tombstone under the blinded id.
        rig.responder = { req, _ in
            if req.method == .get {
                return .answer(
                    status: 200,
                    body: hReply([
                        "cursor": .int(2),
                        "tombstones": .array([
                            .object([
                                "record": .array([.string("saves"), .string(blindId("slot1"))]), "version": .int(5),
                            ])
                        ]),
                    ]))
            }
            return .answer(status: 200, body: hReply())
        }
        _ = await recs.pull()
        await h.flush()
        let after = try await recs.list()
        XCTAssertTrue(after.isEmpty, "the remote delete was not applied: \(after.map(\.id))")
    }

    func testAWriteGoesOnTheExplicitBaseSealedWithABlindedIdAndIsAnswered() async throws {
        let rig = HostRig()
        script(rig) { ok($0, 5) }
        let (recs, _) = try await records(rig)
        let value: [String: JSONValue] = ["chapter": .string("2")]
        let result = try await recs.set("slot1", value: value, base: .version(4), file: nil, stop: nil)
        XCTAssertEqual(result, .ok(version: 5))
        let push = try XCTUnwrap(lastPush(rig))
        let m = try XCTUnwrap(mutations(push).first)
        XCTAssertEqual(m["op"], .string("set"))
        XCTAssertEqual(m["baseVersion"], .int(4))
        XCTAssertNil(m["value"], "the value travels sealed")
        XCTAssertNotNil(m["ct"]?.stringValue)
        let wire = try await recs.wireId("slot1")
        XCTAssertEqual(wire, blindId("slot1"))
        XCTAssertEqual(m["target"]?.objectValue?["record"], .array([.string("saves"), .string(wire)]))
        // The row now rests on version 5.
        let got = try await recs.get("slot1")
        let row = try XCTUnwrap(got)
        XCTAssertEqual(row.value, value)
        XCTAssertEqual(row.version, 5)
    }

    func testAWriteThatGivesTheFinalizedPointerListsItsFileAtOnce() async throws {
        let rig = HostRig()
        script(rig) { ok($0, 3) }
        let (recs, _) = try await records(rig)
        let pointer = SaveFile(version: 3, size: 12, sha256: String(repeating: "a", count: 64), format: .whole)
        let result = try await recs.set("slot1", value: ["a": .int(1)], base: .any, file: pointer, stop: nil)
        XCTAssertEqual(result, .ok(version: 3))
        // No pull has run: the row carries the pointer only because the write did.
        let got = try await recs.get("slot1")
        XCTAssertEqual(got?.file, pointer)
        let listed = try await recs.list()
        XCTAssertEqual(listed.first?.file, pointer)
        let body = try XCTUnwrap(mutations(try XCTUnwrap(lastPush(rig))).first)
        XCTAssertNil(body["file"], "the pointer is never sent")
    }

    func testACreateOnlyWriteSendsStarAsItsBase() async throws {
        let rig = HostRig()
        script(rig) { ok($0, 1) }
        let (recs, _) = try await records(rig)
        _ = try await recs.set("slot1", value: [:], base: .any, file: nil, stop: nil)
        let m = try XCTUnwrap(mutations(try XCTUnwrap(lastPush(rig))).first)
        XCTAssertEqual(m["baseVersion"], .string("*"))
    }

    func testAStaleBaseIsAConflictWithTheServersCopyAndIsNeverRebased() async throws {
        let rig = HostRig()
        script(rig) { m in
            .object([
                "mutationId": m["mutationId"]!, "status": .string("conflict"),
                "server": .object(["version": .int(9), "file": pointer]),
            ])
        }
        let (recs, _) = try await records(rig)
        let r = try await recs.set("slot1", value: ["a": .int(1)], base: .version(2), file: nil, stop: nil)
        guard case .conflict(let server?) = r else { return XCTFail("not a conflict: \(r)") }
        XCTAssertEqual(server.id, "slot1")
        XCTAssertEqual(server.version, 9)
        XCTAssertEqual(server.file, pointerFile)
        // No second push: the resolution is the caller's.
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(rig.sent.filter { $0.method == .post }.count, 1)
    }

    func testARefusalCarriesItsCode() async throws {
        let rig = HostRig()
        script(rig) { m in
            .object(["mutationId": m["mutationId"]!, "status": .string("rejected"), "code": .string("value_invalid")])
        }
        let (recs, _) = try await records(rig)
        let r = try await recs.set("slot1", value: [:], base: .any, file: nil, stop: nil)
        XCTAssertEqual(r, .rejected(code: "value_invalid"))
    }

    func testADeleteIsOneMutationWithNoValueAndRemovesTheRow() async throws {
        let rig = HostRig()
        let change: JSONValue = .object([
            "record": .array([.string("saves"), .string(blindId("slot1"))]), "version": .int(4),
            "ct": sealedValue("slot1", .object(["a": .int(1)])), "file": pointer,
        ])
        script(rig, changes: [change]) { ok($0, 5) }
        let (recs, h) = try await records(rig)
        await h.flush()
        let before = try await recs.list()
        XCTAssertEqual(before.map(\.id), ["slot1"])
        XCTAssertEqual(before.first?.file, pointerFile)
        let r = try await recs.delete("slot1", baseVersion: 4)
        XCTAssertEqual(r, .ok(version: 5))
        let m = try XCTUnwrap(mutations(try XCTUnwrap(lastPush(rig))).first)
        XCTAssertEqual(m["op"], .string("delete"))
        XCTAssertNil(m["value"])
        XCTAssertNil(m["ct"])
        let after = try await recs.list()
        XCTAssertTrue(after.isEmpty)
        let gone = try await recs.get("slot1")
        XCTAssertNil(gone)
    }

    func testARecordWithAFileAndNoValueIsFoundByItsWireIdAndNotListed() async throws {
        let rig = HostRig()
        let torn: JSONValue = .object([
            "record": .array([.string("saves"), .string(blindId("torn"))]), "version": .int(2), "file": pointer,
        ])
        script(rig, changes: [torn]) { ok($0, 3) }
        let (recs, h) = try await records(rig)
        await h.flush()
        // The blinded id of a record the host cannot place without a value is not a save name to list.
        let listed = try await recs.list()
        XCTAssertTrue(listed.isEmpty)
        let found = try await recs.get("torn")
        let row = try XCTUnwrap(found)
        XCTAssertEqual(row.id, "torn")
        XCTAssertEqual(row.version, 2)
        XCTAssertEqual(row.file, pointerFile)
        XCTAssertTrue(row.value.isEmpty)
    }

    func testAFileOnlyRowUnderAPlainIdIsNotASave() async throws {
        let rig = HostRig()
        let plain: JSONValue = .object([
            "record": .array([.string("saves"), .string("slot1")]), "version": .int(2), "file": pointer,
        ])
        script(rig, changes: [plain]) { ok($0, 3) }
        let (recs, h) = try await records(rig)
        await h.flush()
        let got = try await recs.get("slot1")
        XCTAssertNil(got, "end-to-end mode takes a file-only row only under a blinded id")
    }

    func testASignOutDropsAWaitingWrite() async throws {
        let rig = HostRig()
        rig.responder = { req, _ in req.method == .get ? .answer(status: 200, body: hReply()) : .transport }
        let (recs, h) = try await records(rig)
        let task = Task { try await recs.set("slot1", value: [:], base: .any, file: nil, stop: nil) }
        for _ in 0..<200 where lastPush(rig) == nil { try await Task.sleep(nanoseconds: 5_000_000) }
        _ = await h.signOut(discardUnsynced: true)
        await h.touch()
        let r = try await task.value
        XCTAssertEqual(r, .rejected(code: "signed-out"))
    }

    func testACancelEndsTheWaitAndAPauseDoesNot() async throws {
        let rig = HostRig()
        rig.responder = { req, _ in req.method == .get ? .answer(status: 200, body: hReply()) : .transport }
        let (recs, _) = try await records(rig)
        let stop = SaveStop()
        let finished = LockedValue<String?>(nil)
        let task = Task {
            do {
                _ = try await recs.set("slot1", value: [:], base: .any, file: nil, stop: stop)
                finished.set("returned")
            } catch let e as TransferError where e.reason == .aborted {
                finished.set("aborted")
            } catch { finished.set("other") }
        }
        for _ in 0..<200 where lastPush(rig) == nil { try await Task.sleep(nanoseconds: 5_000_000) }
        // A pause cancels the task and leaves the stop flag alone: the wait goes on.
        task.cancel()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNil(finished.current)
        // A cancel after the pause sets the flag; the task was cancelled once already.
        stop.set()
        await task.value
        XCTAssertEqual(finished.current, "aborted")
    }

    func testAPurgeRemovesThePersonsChunkCacheAndTheJournalAndNothingBeside() async throws {
        let rig = HostRig()
        let h = try await hSignedIn(rig, options: savesOptions)
        let mine = chunkCacheDirectory(stateDir: rig.dir, subject: hALICE, collection: "saves")
        let theirs = chunkCacheDirectory(stateDir: rig.dir, subject: hBOB, collection: "saves")
        let journal = rig.dir.appendingPathComponent(cloudSyncTransfersDirName, isDirectory: true)
        for d in [mine, theirs, journal] {
            try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
            try Data("x".utf8).write(to: d.appendingPathComponent("f"))
        }
        try await h.purge()
        XCTAssertFalse(FileManager.default.fileExists(atPath: mine.path))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: chunkCachePersonDirectory(stateDir: rig.dir, subject: hALICE).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: theirs.path), "another person's cache is not ours to delete")
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: rig.dir.appendingPathComponent(cloudSyncChunksDirName).path), "the cache root stays")
    }
}
