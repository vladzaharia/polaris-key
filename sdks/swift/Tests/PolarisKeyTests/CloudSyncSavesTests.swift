// @pkey-feature sync.saves sync.files
//
// Saves (U-23.S5): the file first and the metadata second, the E2E binding, the revision a read chooses,
// newerFormat, the slot cap, conflicts and their three resolutions, pause, resume and cancel, and the
// transfer events. The records layer is an in-memory `SaveRecords`; the file routes are a fake behind the
// engine's `FileTransport`; the real engine, codecs and journal run.

import CryptoKit
import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey

private let root = Data((0..<32).map { UInt8(truncatingIfNeeded: 3 * $0 + 1) })

private func shaHex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

/// A fake of the file routes for single-mode files: one upload at a time per record, versions kept.
private final class FakeFiles: FileTransport, FileRevisions, @unchecked Sendable {
    struct Stored {
        var version: Int
        var bytes: Data
        var format = "whole"
    }
    let lock = NSLock()
    var files: [String: [Stored]] = [:]  // newest last
    var pending: [String: (record: String, size: Int, body: Data?, base: JSONValue?)] = [:]
    var seq = 0
    var versionSeq: [String: Int] = [:]
    var calls: [String] = []
    /// Called at the start of `begin`; may sleep (a transfer to pause) or refuse.
    var onBegin: @Sendable () async throws -> FileRefusal? = { nil }
    /// A server version that makes `begin` a conflict, per record.
    var conflictAt: [String: Int] = [:]

    func begin(_ target: FileTarget, request: JSONValue) async throws -> FileReply<JSONValue> {
        lock.withLock { calls.append("begin") }
        if let r = try await onBegin() { return .refused(r) }
        let (cur, conflict, id): (Int, Int?, String) = lock.withLock {
            seq += 1
            return (versionSeq[target.record] ?? 0, conflictAt[target.record], "up\(seq)")
        }
        if let conflict {
            return .refused(
                FileRefusal(
                    status: 409, code: "revision_conflict",
                    body: .object(["server": .object(["version": .int(conflict)])])))
        }
        let base = request.objectValue?["baseVersion"]
        if case .string("*")? = base, cur > 0 {
            return .refused(
                FileRefusal(
                    status: 409, code: "revision_conflict", body: .object(["server": .object(["version": .int(cur)])])))
        }
        if case .int(let b)? = base, b != cur {
            return .refused(
                FileRefusal(
                    status: 409, code: "revision_conflict", body: .object(["server": .object(["version": .int(cur)])])))
        }
        lock.withLock {
            pending[id] = (target.record, request.objectValue?["size"]?.intValue ?? 0, nil, base)
        }
        return .ok(
            .object(["uploadId": .string(id), "mode": .string("single"), "expiresAt": .int(4_000_000_000_000)]))
    }

    func status(_ target: FileTarget, uploadId: String) async throws -> FileReply<JSONValue> {
        .ok(.object(["mode": .string("single"), "received": .array([])]))
    }

    func putSingle(_ target: FileTarget, uploadId: String, body: Data, sha256: String) async throws -> FileReply<Void> {
        lock.withLock { pending[uploadId]?.body = body }
        return .ok(())
    }

    func putPart(_ target: FileTarget, uploadId: String, n: Int, body: Data, sha256: String) async throws
        -> FileReply<Void>
    { .ok(()) }

    func abort(_ target: FileTarget, uploadId: String) async throws -> FileReply<Void> {
        lock.withLock { _ = pending.removeValue(forKey: uploadId) }
        return .ok(())
    }

    func finalize(_ target: FileTarget, request: JSONValue) async throws -> FileReply<JSONValue> {
        let id = request.objectValue?["uploadId"]?.stringValue ?? ""
        return lock.withLock {
            guard let up = pending.removeValue(forKey: id), let body = up.body else {
                return .refused(FileRefusal(status: 409, code: "upload_incomplete"))
            }
            let v = (versionSeq[up.record] ?? 0) + 1
            versionSeq[up.record] = v
            files[up.record, default: []].append(Stored(version: v, bytes: body))
            return .ok(
                .object([
                    "version": .int(v), "size": .int(body.count), "sha256": .string(shaHex(body)),
                    "format": .string("whole"),
                ]))
        }
    }

    func planChunks(_ target: FileTarget, uploadId: String, request: JSONValue) async throws -> FileReply<JSONValue> {
        .refused(FileRefusal(status: 400, code: "bad_request"))
    }

    func putChunk(_ target: FileTarget, uploadId: String, chunkId: String, body: Data, sha256: String) async throws
        -> FileReply<Void>
    { .refused(FileRefusal(status: 400, code: "bad_request")) }

    func getFile(_ target: FileTarget, query: FileQuery) async throws -> FileReply<FileBody> {
        lock.withLock {
            let all = files[target.record] ?? []
            let hit = query.version.map { v in all.first { $0.version == v } } ?? all.last
            guard let hit else { return .refused(FileRefusal(status: 404, code: "not_found")) }
            var data = hit.bytes
            if let r = query.range { data = Data(hit.bytes[r.lowerBound..<min(r.upperBound, hit.bytes.count)]) }
            return .ok(
                FileBody(
                    status: query.range == nil ? 200 : 206, data: data, etag: "\"\(shaHex(hit.bytes))\"",
                    contentRange: query.range.map { ($0.lowerBound, $0.lowerBound + data.count, hit.bytes.count) }))
        }
    }

    func getChunk(collection: String, chunkId: String) async throws -> FileReply<Data> {
        .refused(FileRefusal(status: 404, code: "not_found"))
    }

    func revisions(_ target: FileTarget) async throws -> FileReply<JSONValue> {
        lock.withLock {
            let all = files[target.record] ?? []
            return .ok(
                .object([
                    "revisions": .array(
                        all.dropLast().reversed().map {
                            .object([
                                "version": .int($0.version), "size": .int($0.bytes.count),
                                "sha256": .string(shaHex($0.bytes)), "format": .string($0.format), "createdAt": .int(0),
                            ])
                        })
                ]))
        }
    }
}

/// An in-memory records layer that follows the Worker's rule: a file route makes (or bumps) the record, and a
/// `set` lands only on the version the file made.
private final class FakeRecords: SaveRecords, @unchecked Sendable {
    let lock = NSLock()
    var rows: [String: SaveRecord] = [:]
    let files: FakeFiles
    let e2e: Bool
    var failSet: SaveSetResult?
    var sets: [(id: String, value: [String: JSONValue], base: SyncBase)] = []
    /// While set, `set` waits (as the machine's outcome wait does) until the caller cancels it.
    var holdSet = false
    var dropped = false

    init(files: FakeFiles, e2e: Bool) {
        self.files = files
        self.e2e = e2e
    }

    func wireId(_ id: String) async throws -> String { e2e ? "B_" + id : id }

    func list() async throws -> [SaveRecord] { lock.withLock { rows.values.sorted { $0.id < $1.id } } }

    func get(_ id: String) async throws -> SaveRecord? { lock.withLock { rows[id] } }

    func set(_ id: String, value: [String: JSONValue], base: SyncBase, stop: SaveStop?) async throws -> SaveSetResult {
        lock.withLock { sets.append((id, value, base)) }
        if lock.withLock({ holdSet }) {
            // A pause never ends the wait; only the caller's cancel does.
            while !(stop?.isSet ?? false) && !lock.withLock({ dropped }) {
                try await Task.sleep(nanoseconds: 2_000_000)
            }
            if stop?.isSet ?? false { throw TransferError(.aborted) }
            return .rejected(code: "signed-out")
        }
        if let failSet { return failSet }
        let wire = try await wireId(id)
        let stored = files.lock.withLock { files.files[wire]?.last }
        let current = stored?.version ?? 0
        guard case .version(let v) = base, v == current, let stored else {
            return .conflict(server: lock.withLock { rows[id] })
        }
        let file = SaveFile(
            version: stored.version, size: stored.bytes.count, sha256: shaHex(stored.bytes), format: .whole)
        lock.withLock { rows[id] = SaveRecord(id: id, version: v, value: value, file: file) }
        return .ok(version: v)
    }

    func delete(_ id: String, baseVersion: Int) async throws -> SaveSetResult {
        lock.withLock { _ = rows.removeValue(forKey: id) }
        return .ok(version: baseVersion + 1)
    }

    func seed(_ id: String, _ value: [String: JSONValue], bytes: Data? = nil, sealed: Data? = nil) {
        let stored = sealed ?? bytes
        var file: SaveFile?
        if let stored {
            let wire = e2e ? "B_" + id : id
            files.lock.withLock {
                let v = (files.versionSeq[wire] ?? 0) + 1
                files.versionSeq[wire] = v
                files.files[wire, default: []].append(FakeFiles.Stored(version: v, bytes: stored))
            }
            let v = files.lock.withLock { files.versionSeq[wire]! }
            file = SaveFile(version: v, size: stored.count, sha256: shaHex(stored), format: .whole)
        }
        lock.withLock { rows[id] = SaveRecord(id: id, version: file?.version ?? 1, value: value, file: file) }
    }
}

private final class Env: SavesEnvironment, @unchecked Sendable {
    let context: SavesContext
    let lock = NSLock()
    var released: [String] = []
    var droppedWaiting = 0
    var purged = 0
    var refusal: (any Error)?

    init(context: SavesContext) { self.context = context }

    func savesContext() async throws -> SavesContext {
        if let refusal { throw refusal }
        return context
    }
    func release(transferId: String) async {
        lock.withLock { released.append(transferId) }
        await context.engine.cancel(id: transferId)
    }
    func dropWaiting() { lock.withLock { droppedWaiting += 1 } }
    func purgeFiles() async { lock.withLock { purged += 1 } }
}

private final class Events: @unchecked Sendable {
    let lock = NSLock()
    var list: [CloudSyncEvent] = []
    func add(_ e: CloudSyncEvent) { lock.withLock { list.append(e) } }
    var all: [CloudSyncEvent] { lock.withLock { list } }
}

private struct Rig {
    let files = FakeFiles()
    let records: FakeRecords
    let client: SavesClient
    let env: Env
    let events = Events()
    let journal = MemoryJournal()

    init(e2e: Bool, options: SavesOptions = SavesOptions(delta: false)) {
        records = FakeRecords(files: files, e2e: e2e)
        let codec: any FileCodec = e2e ? E2eFileCodec(root: root, collection: savesCollection) : ServerFileCodec()
        let engine = FileTransferEngine(
            transport: files, journal: journal, sleep: { _ in }, random: { 0.5 })
        let ctx = SavesContext(records: records, engine: engine, revisions: files, codec: codec, cache: nil)
        let ev = events
        env = Env(context: ctx)
        client = SavesClient(env: env, options: options, emit: { ev.add($0) })
    }
}

private func obj(_ pairs: [String: JSONValue]) -> JSONValue { .object(pairs) }

final class CloudSyncSavesTests: XCTestCase {
    func testAnEndToEndWritePushesTheFileThenTheBoundMetadata() async throws {
        let rig = Rig(e2e: true)
        let payload = Data("a save".utf8)
        let t = try await rig.client.write("slot1", bytes: payload, metadata: obj(["chapter": .string("3")]))
        guard case .done(_, let version, let file, nil) = await t.outcome() else { return XCTFail("not done") }
        XCTAssertEqual(version, 1)
        XCTAssertEqual(file.version, 1)
        XCTAssertEqual(t.state, .done)
        let set = try XCTUnwrap(rig.records.sets.first)
        // The metadata set rests on the version finalize answered, and is bound to the stored bytes.
        XCTAssertEqual(set.base, .version(1))
        let binding = try XCTUnwrap(set.value[saveFileBindingKey]?.objectValue)
        XCTAssertEqual(binding["sha256"]?.stringValue, file.sha256)
        XCTAssertEqual(binding["size"], .int(file.size))
        XCTAssertEqual(binding["format"]?.stringValue, "whole")
        // The stored file is ciphertext.
        let stored = rig.files.files["B_slot1"]!.last!.bytes
        XCTAssertNotEqual(stored, payload)
        XCTAssertEqual(shaHex(stored), file.sha256)
        // And it reads back.
        guard case .ok(let content) = try await rig.client.read("slot1") else { return XCTFail("not found") }
        XCTAssertEqual(content.bytes, payload)
        XCTAssertEqual(content.metadata, obj(["chapter": .string("3")]))
        XCTAssertEqual(content.file, file)
    }

    func testAServerModeWriteHasNoBinding() async throws {
        let rig = Rig(e2e: false)
        let t = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj(["a": .int(1)]))
        guard case .done = await t.outcome() else { return XCTFail("not done") }
        XCTAssertNil(rig.records.sets.first?.value[saveFileBindingKey])
        guard case .ok(let c) = try await rig.client.read("slot1") else { return XCTFail("not found") }
        XCTAssertEqual(c.bytes, Data("x".utf8))
    }

    func testAMetadataRejectionLeavesNoReadableSave() async throws {
        let rig = Rig(e2e: true)
        rig.records.failSet = .rejected(code: "value_invalid")
        let t = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj([:]))
        guard case .failed(let e) = await t.outcome() else { return XCTFail("not failed") }
        XCTAssertEqual(e.code, .rejected)
        XCTAssertEqual(e.detail, "value_invalid")
        XCTAssertEqual(t.state, .failed)
        // The file is stored but no metadata names it: the save does not exist.
        guard case .notFound = try await rig.client.read("slot1") else { return XCTFail("a torn save read") }
        let listed = try await rig.client.list()
        XCTAssertEqual(listed.count, 0)
    }

    func testAnEndToEndReadFollowsTheBindingToAKeptRevision() async throws {
        let rig = Rig(e2e: true)
        for text in ["one", "two"] {
            let base = try await rig.records.get("slot1").map { SaveWriteOptions(baseVersion: $0.version) }
            guard
                case .done = try await rig.client.write(
                    "slot1", bytes: Data(text.utf8), metadata: obj([:]), options: base ?? SaveWriteOptions()
                ).outcome()
            else { return XCTFail("write \(text)") }
        }
        // The server's current file is "two". Re-point the record's binding at the first revision.
        let first = rig.files.files["B_slot1"]![0]
        let got = try await rig.records.get("slot1")
        let row = try XCTUnwrap(got)
        var value = row.value
        value[saveFileBindingKey] = .object([
            "sha256": .string(shaHex(first.bytes)), "size": .int(first.bytes.count), "format": .string("whole"),
        ])
        rig.records.lock.withLock {
            rig.records.rows["slot1"] = SaveRecord(id: "slot1", version: row.version, value: value, file: row.file)
        }
        guard case .ok(let c) = try await rig.client.read("slot1") else { return XCTFail("not found") }
        XCTAssertEqual(c.bytes, Data("one".utf8))
        XCTAssertEqual(c.file?.version, first.version)
    }

    func testAnEndToEndReadWhoseBindingNamesNoFileIsInvalid() async throws {
        let rig = Rig(e2e: true)
        guard case .done = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj([:])).outcome()
        else { return XCTFail("write") }
        let got = try await rig.records.get("slot1")
        let row = try XCTUnwrap(got)
        var value = row.value
        value[saveFileBindingKey] = .object([
            "sha256": .string(String(repeating: "0", count: 64)), "size": .int(1), "format": .string("whole"),
        ])
        rig.records.lock.withLock {
            rig.records.rows["slot1"] = SaveRecord(id: "slot1", version: row.version, value: value, file: row.file)
        }
        do {
            _ = try await rig.client.read("slot1")
            XCTFail("a swapped file was returned")
        } catch let e as SavesError {
            XCTAssertEqual(e.code, .fileInvalid)
            XCTAssertEqual(e.code.rawValue, ErrorCode.syncFileInvalid)
        }
        // A malformed binding is not an absent one.
        value[saveFileBindingKey] = .string("nonsense")
        rig.records.lock.withLock {
            rig.records.rows["slot1"] = SaveRecord(id: "slot1", version: row.version, value: value, file: row.file)
        }
        do {
            _ = try await rig.client.read("slot1")
            XCTFail("a malformed binding read")
        } catch let e as SavesError { XCTAssertEqual(e.code, .fileInvalid) }
    }

    func testATamperedStoredFileIsInvalid() async throws {
        let rig = Rig(e2e: true)
        guard case .done = try await rig.client.write("slot1", bytes: Data("hello".utf8), metadata: obj([:])).outcome()
        else { return XCTFail("write") }
        rig.files.lock.withLock {
            var b = rig.files.files["B_slot1"]![0].bytes
            b[b.count - 1] ^= 1
            rig.files.files["B_slot1"]![0].bytes = b
        }
        do {
            _ = try await rig.client.read("slot1")
            XCTFail("a tampered file read")
        } catch let e as SavesError { XCTAssertEqual(e.code, .fileInvalid) }
    }

    func testANewerFormatIsReportedAndNotRead() async throws {
        let rig = Rig(e2e: false, options: SavesOptions(saveFormatVersion: 2, delta: false))
        rig.records.seed("old", ["formatVersion": .int(2)], bytes: Data("o".utf8))
        rig.records.seed("new", ["formatVersion": .int(3)], bytes: Data("n".utf8))
        let list = try await rig.client.list()
        XCTAssertEqual(list.map(\.newerFormat), [true, false])
        XCTAssertEqual(list.map(\.id), ["new", "old"])
        guard case .newerFormat(let fv, let supported) = try await rig.client.read("new") else {
            return XCTFail("a newer format was read")
        }
        XCTAssertEqual(fv, 3)
        XCTAssertEqual(supported, 2)
        guard case .ok = try await rig.client.read("old") else { return XCTFail("an old format was not read") }
        // Without the option the check is off.
        let open = Rig(e2e: false)
        open.records.seed("new", ["formatVersion": .int(99)], bytes: Data("n".utf8))
        guard case .ok = try await open.client.read("new") else { return XCTFail("the check was on") }
    }

    func testAnUnknownIdAndABadIdAreNotRead() async throws {
        let rig = Rig(e2e: false)
        guard case .notFound = try await rig.client.read("nope") else { return XCTFail("found") }
        do {
            _ = try await rig.client.read("../x")
            XCTFail("a bad id was read")
        } catch let e as SavesError { XCTAssertEqual(e.code, .invalidSave) }
    }

    func testTheWriteGuards() async throws {
        let rig = Rig(e2e: false, options: SavesOptions(maxBytes: 4, delta: false))
        guard
            case .failed(let big) = try await rig.client.write("a", bytes: Data(count: 5), metadata: obj([:])).outcome()
        else { return XCTFail("too large") }
        XCTAssertEqual(big.code, .tooLarge)
        guard
            case .failed(let reserved) = try await rig.client.write(
                "a", bytes: Data(count: 1), metadata: obj([saveFileBindingKey: .int(1)])
            ).outcome()
        else { return XCTFail("reserved") }
        XCTAssertEqual(reserved.detail, "reserved-key")
        guard
            case .failed(let notObject) = try await rig.client.write("a", bytes: Data(count: 1), metadata: .string("x"))
                .outcome()
        else { return XCTFail("metadata") }
        XCTAssertEqual(notObject.detail, "metadata")
        guard
            case .failed(let id) = try await rig.client.write("a b", bytes: Data(count: 1), metadata: obj([:]))
                .outcome()
        else { return XCTFail("id") }
        XCTAssertEqual(id.code, .invalidSave)
        XCTAssertTrue(rig.files.calls.isEmpty, "nothing was sent for a refused write")
    }

    func testTheSixteenSlotsAreTheCap() async throws {
        let rig = Rig(e2e: false)
        for n in 0..<SYNC_SAVE_SLOTS { rig.records.seed("s\(n)", [:], bytes: Data("x".utf8)) }
        guard
            case .failed(let e) = try await rig.client.write("fresh", bytes: Data("y".utf8), metadata: obj([:]))
                .outcome()
        else { return XCTFail("a seventeenth save") }
        XCTAssertEqual(e.code, .slotsFull)
        // An existing slot is still writable.
        guard case .done = try await rig.client.write("s3", bytes: Data("z".utf8), metadata: obj([:])).outcome()
        else { return XCTFail("overwrite") }
    }

    func testAStaleBaseIsAConflictAndEachKeepResolvesIt() async throws {
        let rig = Rig(e2e: false)
        rig.records.seed("slot1", ["who": .string("remote")], bytes: Data("remote".utf8))
        // The caller last saw version 0 of a record that is now at 1.
        let t = try await rig.client.write(
            "slot1", bytes: Data("local".utf8), metadata: obj(["who": .string("local")]),
            options: SaveWriteOptions(baseVersion: 0))
        guard case .conflict(let conflict) = await t.outcome() else { return XCTFail("not a conflict") }
        XCTAssertEqual(t.state, .conflict)
        XCTAssertEqual(conflict.serverVersion, 1)
        XCTAssertEqual(conflict.remote?.metadata, obj(["who": .string("remote")]))
        XCTAssertEqual(conflict.local.metadata, obj(["who": .string("local")]))
        XCTAssertEqual(conflict.local.size, 5)
        XCTAssertTrue(conflict.bothAvailable)

        // remote: nothing is written.
        let callsBefore = rig.files.calls.count
        guard
            case .keptRemote(_, let v) = try await rig.client.resolve(conflict, keep: .remote, bytes: Data()).outcome()
        else { return XCTFail("keep remote") }
        XCTAssertEqual(v, 1)
        XCTAssertEqual(rig.files.calls.count, callsBefore)

        // both: a copy in a free slot, the original untouched.
        guard
            case .done(let id, _, _, let copy) = try await rig.client.resolve(
                conflict, keep: .both, bytes: Data("local".utf8)
            ).outcome()
        else { return XCTFail("keep both") }
        XCTAssertEqual(id, "slot1")
        XCTAssertEqual(copy, "slot1.copy")
        let r1 = try await rig.records.get("slot1")
        XCTAssertEqual(r1?.value, ["who": .string("remote")])
        let r2 = try await rig.records.get("slot1.copy")
        XCTAssertEqual(r2?.value, ["who": .string("local")])

        // local: written on top of the server's version.
        guard case .done = try await rig.client.resolve(conflict, keep: .local, bytes: Data("local".utf8)).outcome()
        else { return XCTFail("keep local") }
        let r3 = try await rig.records.get("slot1")
        XCTAssertEqual(r3?.value, ["who": .string("local")])
    }

    func testKeepBothNeedsAFreeSlot() async throws {
        let rig = Rig(e2e: false)
        for n in 0..<SYNC_SAVE_SLOTS { rig.records.seed(n == 0 ? "slot1" : "s\(n)", [:], bytes: Data("x".utf8)) }
        let t = try await rig.client.write(
            "slot1", bytes: Data("l".utf8), metadata: obj([:]), options: SaveWriteOptions(baseVersion: 0))
        guard case .conflict(let c) = await t.outcome() else { return XCTFail("not a conflict") }
        XCTAssertFalse(c.bothAvailable)
        guard case .failed(let e) = try await rig.client.resolve(c, keep: .both, bytes: Data("l".utf8)).outcome()
        else { return XCTFail("keep both") }
        XCTAssertEqual(e.code, .slotsFull)
    }

    func testAMetadataConflictAfterTheFileIsAConflictToo() async throws {
        let rig = Rig(e2e: false)
        rig.records.failSet = .conflict(server: SaveRecord(id: "slot1", version: 9, value: ["a": .int(1)], file: nil))
        guard
            case .conflict(let c) = try await rig.client.write("slot1", bytes: Data("l".utf8), metadata: obj([:]))
                .outcome()
        else { return XCTFail("not a conflict") }
        XCTAssertEqual(c.serverVersion, 9)
    }

    func testRevisionsAreListedNewestFirst() async throws {
        let rig = Rig(e2e: false)
        for text in ["one", "two", "three"] {
            let base = try await rig.records.get("slot1").map { SaveWriteOptions(baseVersion: $0.version) }
            guard
                case .done = try await rig.client.write(
                    "slot1", bytes: Data(text.utf8), metadata: obj([:]), options: base ?? SaveWriteOptions()
                ).outcome()
            else { return XCTFail("write") }
        }
        let revs = try await rig.client.revisions("slot1")
        XCTAssertEqual(revs.map(\.version), [2, 1])
    }

    func testDeleteUsesTheCurrentVersionUnlessGiven() async throws {
        let rig = Rig(e2e: false)
        rig.records.seed("slot1", [:], bytes: Data("x".utf8))
        guard case .ok = try await rig.client.delete("slot1") else { return XCTFail("delete") }
        let missing = try await rig.records.get("slot1")
        XCTAssertNil(missing)
        guard case .rejected(let code) = try await rig.client.delete("slot1") else { return XCTFail("delete twice") }
        XCTAssertEqual(code, "not_found")
    }

    func testTheCodableMetadataRoundTrips() async throws {
        struct Meta: Codable, Equatable {
            var chapter: String
            var formatVersion: Int
        }
        let rig = Rig(e2e: false)
        let t = try await rig.client.write(
            "slot1", bytes: Data("x".utf8), encoding: Meta(chapter: "2", formatVersion: 1))
        guard case .done = await t.outcome() else { return XCTFail("write") }
        let list = try await rig.client.list()
        XCTAssertEqual(try list[0].decodeMetadata(Meta.self), Meta(chapter: "2", formatVersion: 1))
        guard case .ok(let c) = try await rig.client.read("slot1") else { return XCTFail("read") }
        XCTAssertEqual(try c.decodeMetadata(Meta.self), Meta(chapter: "2", formatVersion: 1))
    }

    func testTransferEventsAreEmittedAndACancelIsNotAFailure() async throws {
        let rig = Rig(e2e: false)
        let t = try await rig.client.write("slot1", bytes: Data(count: 100), metadata: obj([:]))
        let id = t.id
        guard case .done = await t.outcome() else { return XCTFail("write") }
        let events = rig.events.all
        XCTAssertTrue(events.contains(.transferDone(id: id, state: "done")))
        XCTAssertEqual(id, "saves:slot1", "the journal key is stable across launches")
        XCTAssertEqual(events.compactMap(\.transferType).first, TransferEvent.transferprogress)
        XCTAssertTrue(
            events.contains { if case .transferProgress(id, _, _) = $0 { return true } else { return false } })
        XCTAssertTrue(rig.client.transfers().isEmpty, "a settled transfer is not in flight")

        // A server that fails the write emits transferFailed with a code.
        let bad = Rig(e2e: false)
        bad.files.lock.withLock { bad.files.conflictAt = [:] }
        bad.records.failSet = .rejected(code: "value_invalid")
        let f = try await bad.client.write("s", bytes: Data(count: 1), metadata: obj([:]))
        _ = await f.outcome()
        XCTAssertTrue(bad.events.all.contains(.transferFailed(id: f.id, code: "rejected")))
    }

    func testPauseResumeAndCancelAreStatesNotErrors() async throws {
        let rig = Rig(e2e: false)
        let gate = LockedValue<Bool>(true)
        rig.files.onBegin = {
            while gate.current { try await Task.sleep(nanoseconds: 5_000_000) }
            return nil
        }
        // Paused while the first begin is waiting: the attempt is cancelled and the transfer holds.
        let t = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj([:]))
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(t.state, .running)
        XCTAssertEqual(rig.client.transfers().map(\.id), [t.id])
        t.pause()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(t.state, .paused)
        gate.set(false)
        t.resume()
        guard case .done = await t.outcome() else { return XCTFail("a resumed transfer did not finish") }
        XCTAssertEqual(t.state, .done)

        // Cancel while waiting: a state, no failure event.
        gate.set(true)
        let c = try await rig.client.write("slot2", bytes: Data("y".utf8), metadata: obj([:]))
        try await Task.sleep(nanoseconds: 50_000_000)
        await c.cancel()
        guard case .cancelled = await c.outcome() else { return XCTFail("not cancelled") }
        XCTAssertEqual(c.state, .cancelled)
        XCTAssertFalse(
            rig.events.all.contains { if case .transferFailed(c.id, _) = $0 { return true } else { return false } })
        let missing = try await rig.records.get("slot2")
        XCTAssertNil(missing)
        // Cancelling a finished transfer does nothing.
        await t.cancel()
        XCTAssertEqual(t.state, .done)
    }

    func testAPauseBeforeTheFirstStepHoldsTheWrite() async throws {
        let rig = Rig(e2e: false)
        let t = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj([:]))
        t.pause()
        // Whether the pause came first or the write already finished, resume lets it settle.
        t.resume()
        guard case .done = await t.outcome() else { return XCTFail("did not finish") }
    }

    func testACancelEndsTheWaitForTheMetadataWriteAndAPauseDoesNot() async throws {
        let rig = Rig(e2e: false)
        rig.records.lock.withLock { rig.records.holdSet = true }
        let t = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj([:]))
        // The file is stored and the metadata write is waiting for its outcome.
        for _ in 0..<200 where rig.records.lock.withLock({ rig.records.sets.isEmpty }) {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(rig.records.sets.count, 1)
        // A pause leaves the wait running: the one write is not made again.
        t.pause()
        try await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(rig.records.sets.count, 1, "a pause must not restart the metadata write")
        t.resume()
        // A cancel ends it, and the transfer is a cancelled state, not a failure.
        await t.cancel()
        guard case .cancelled = await t.outcome() else { return XCTFail("not cancelled") }
        XCTAssertEqual(t.state, .cancelled)
        XCTAssertEqual(rig.env.released, ["saves:slot1"])
        XCTAssertFalse(rig.events.all.contains { if case .transferFailed = $0 { return true } else { return false } })
        XCTAssertTrue(rig.events.all.contains(.transferDone(id: "saves:slot1", state: "cancelled")))
    }

    func testPurgeCancelsRunningWritesAndDeletesTheFilesAndWaitingWrites() async throws {
        let rig = Rig(e2e: false)
        rig.records.lock.withLock { rig.records.holdSet = true }
        let t = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj([:]))
        for _ in 0..<200 where rig.records.lock.withLock({ rig.records.sets.isEmpty }) {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        await rig.client.purge()
        guard case .cancelled = await t.outcome() else { return XCTFail("not cancelled") }
        XCTAssertEqual(rig.env.droppedWaiting, 1)
        XCTAssertEqual(rig.env.purged, 1)
        XCTAssertTrue(rig.client.transfers().isEmpty)
    }

    func testARefusedEnvironmentThrowsFromEveryVerb() async throws {
        let rig = Rig(e2e: true)
        rig.env.refusal = PolarisError(code: ErrorCode.syncLocked, message: "locked")
        func code(_ body: () async throws -> Void) async -> String? {
            do { try await body() } catch { return (error as? PolarisError)?.code }
            return nil
        }
        let list = await code { _ = try await rig.client.list() }
        let read = await code { _ = try await rig.client.read("a") }
        let write = await code { _ = try await rig.client.write("a", bytes: Data(), metadata: obj([:])) }
        let revisions = await code { _ = try await rig.client.revisions("a") }
        let delete = await code { _ = try await rig.client.delete("a") }
        XCTAssertEqual([list, read, write, revisions, delete], Array(repeating: ErrorCode.syncLocked, count: 5))
    }

    func testAReadEmitsTransferEventsUnderItsOwnId() async throws {
        let rig = Rig(e2e: false)
        rig.records.seed("slot1", [:], bytes: Data("hello".utf8))
        guard case .ok = try await rig.client.read("slot1") else { return XCTFail("read") }
        XCTAssertTrue(rig.events.all.contains(.transferDone(id: "saves:read:slot1", state: "done")))
        do {
            _ = try await rig.client.read("../x")
            XCTFail("bad id")
        } catch {}
        XCTAssertTrue(rig.events.all.contains(.transferFailed(id: "saves:read:../x", code: "invalid-save")))
    }

    func testCancelThenPauseSettlesCancelled() async throws {
        let rig = Rig(e2e: false)
        rig.records.lock.withLock { rig.records.holdSet = true }
        let t = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj([:]))
        for _ in 0..<200 where rig.records.lock.withLock({ rig.records.sets.isEmpty }) {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        let cancelling = Task { await t.cancel() }
        t.pause()
        await cancelling.value
        guard case .cancelled = await t.outcome() else { return XCTFail("not cancelled") }
        XCTAssertEqual(t.state, .cancelled)
    }

    func testCancelThenResumeOnAPausedTransferSettlesCancelled() async throws {
        let rig = Rig(e2e: false)
        let gate = LockedValue<Bool>(true)
        rig.files.onBegin = {
            while gate.current { try await Task.sleep(nanoseconds: 5_000_000) }
            return nil
        }
        let t = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj([:]))
        try await Task.sleep(nanoseconds: 50_000_000)
        t.pause()
        for _ in 0..<200 where t.state != .paused { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertEqual(t.state, .paused)
        let cancelling = Task { await t.cancel() }
        t.resume()
        await cancelling.value
        guard case .cancelled = await t.outcome() else { return XCTFail("not cancelled") }
        XCTAssertEqual(t.state, .cancelled)
    }
}
