// @pkey-feature sync.saves sync.files
//
// Saves (U-23.S5): the file first and the metadata second, the E2E binding, the revision a read chooses,
// newerFormat, the slot cap, conflicts and their three resolutions, pause, resume and cancel, and the
// transfer events. The records layer is an in-memory `SaveRecords`; the file routes are a fake behind the
// engine's `FileTransport`; the real engine, codecs and journal run.

import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey
#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

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
    /// The `baseVersion` of each `begin`, in order.
    var bases: [JSONValue?] = []
    /// Rewrites the answer to `finalize` (the stored file is untouched).
    var finalizeAnswer: (@Sendable (JSONValue) -> JSONValue)?

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
        lock.withLock { bases.append(base) }
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
            let answer = JSONValue.object([
                "version": .int(v), "size": .int(body.count), "sha256": .string(shaHex(body)),
                "format": .string("whole"),
            ])
            return .ok(finalizeAnswer?(answer) ?? answer)
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
    var sets: [(id: String, value: [String: JSONValue], base: SyncBase, file: SaveFile?)] = []
    /// While set, `set` waits (as the machine's outcome wait does) until the caller cancels it.
    var holdSet = false
    var dropped = false
    /// What a pull does (the test's "another device wrote meanwhile"); nil: the port cannot pull.
    var onPull: (@Sendable () -> Void)?
    var pulls = 0

    func pull() async -> Bool {
        guard let onPull else { return false }
        lock.withLock { pulls += 1 }
        onPull()
        return true
    }

    init(files: FakeFiles, e2e: Bool) {
        self.files = files
        self.e2e = e2e
    }

    func wireId(_ id: String) async throws -> String { e2e ? "B_" + id : id }

    func list() async throws -> [SaveRecord] { lock.withLock { rows.values.sorted { $0.id < $1.id } } }

    func get(_ id: String) async throws -> SaveRecord? { lock.withLock { rows[id] } }

    func set(
        _ id: String, value: [String: JSONValue], base: SyncBase, file: SaveFile?, stop: SaveStop?
    ) async throws -> SaveSetResult {
        lock.withLock { sets.append((id, value, base, file)) }
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
        if let row = lock.withLock({ rows[id] }), row.version != baseVersion { return .conflict(server: row) }
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
    var label: String?
    var interrupted: [String] = []
    /// Runs as the files are purged: what a test looks at before anything is deleted.
    var atPurge: (@Sendable () -> Void)?

    init(context: SavesContext) { self.context = context }

    func interruptedWrites() -> [String] { lock.withLock { interrupted } }

    func deviceLabel() async -> String? { label }

    func savesContext() async throws -> SavesContext {
        if let refusal { throw refusal }
        return context
    }
    func release(transferId: String) async {
        lock.withLock { released.append(transferId) }
        await context.engine.cancel(id: transferId)
    }
    func dropWaiting() { lock.withLock { droppedWaiting += 1 } }
    func purgeFiles() async {
        lock.withLock { purged += 1 }
        atPurge?()
    }
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
        client = SavesClient(env: env, options: options, emit: { ev.add($0) }, now: { savedAtNow })
    }
}

private func obj(_ pairs: [String: JSONValue]) -> JSONValue { .object(pairs) }

/// The clock every rig's saves are stamped with.
private let savedAtNow = 1_000

/// What a write stores for the app's metadata: the app's keys plus the SDK's `savedAt`.
private func stamped(_ pairs: [String: JSONValue]) -> JSONValue {
    var all = pairs
    all[saveSavedAtKey] = .int(savedAtNow)
    return .object(all)
}

final class CloudSyncSavesTests: XCTestCase {
    // sync.transfer.background: an upload an earlier run left unfinished is reported once, with no new verb.
    func testAnInterruptedWriteIsReportedOnceAtStartAndWritingItAgainClearsIt() async throws {
        let rig = Rig(e2e: false)
        rig.env.lock.withLock { rig.env.interrupted = ["saves:slot1", "saves:read:x", "files:other", "saves:"] }
        _ = try await rig.client.list()
        _ = try await rig.client.list()
        func failures() -> [String] {
            rig.events.all.compactMap {
                if case .transferFailed(let id, let code) = $0 {
                    XCTAssertEqual(code, "transfer-failed")
                    return id
                }
                return nil
            }
        }
        XCTAssertEqual(failures(), ["saves:slot1"])
        // Writing that save again is the retry: no second failure is reported for it by the write itself.
        let t = try await rig.client.write("slot1", bytes: Data("again".utf8), metadata: obj([:]))
        guard case .done = await t.outcome() else { return XCTFail("not done") }
        XCTAssertEqual(failures(), ["saves:slot1"])
    }

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
        XCTAssertEqual(content.metadata, stamped(["chapter": .string("3")]))
        XCTAssertEqual(content.file, file)
    }

    func testTheMetadataWriteCarriesTheFinalizedPointerSoTheNewFileListsAtOnce() async throws {
        let rig = Rig(e2e: false)
        let t = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj(["a": .int(1)]))
        guard case .done(_, _, let file, nil) = await t.outcome() else { return XCTFail("not done") }
        // The machine adopts this pointer on ok; without it the new row would list no file until a pull.
        XCTAssertEqual(rig.records.sets.first?.file, file)
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

    func testAFinalizeAnswerNamingAnotherFileFailsTheWriteAndAdoptsNothing() async throws {
        for e2e in [false, true] {
            let rig = Rig(e2e: e2e)
            guard case .done = try await rig.client.write("a", bytes: Data("one".utf8), metadata: obj([:])).outcome()
            else { return XCTFail("first write") }
            let second = try await rig.client.write("b", bytes: Data("another".utf8), metadata: obj([:])).outcome()
            guard case .done(_, _, let other, nil) = second else { return XCTFail("second write") }
            let before = rig.records.sets.count
            rig.files.finalizeAnswer = { a in
                var o = a.objectValue!
                o["size"] = .int(other.size)
                o["sha256"] = .string(other.sha256)
                return .object(o)
            }
            let opts = try await rig.records.get("a").map { SaveWriteOptions(baseVersion: $0.version) }
            let out = try await rig.client.write(
                "a", bytes: Data("three!".utf8), metadata: obj([:]), options: opts ?? SaveWriteOptions()
            ).outcome()
            guard case .failed = out else { return XCTFail("expected failed, got \(out)") }
            XCTAssertEqual(rig.records.sets.count, before, "no metadata set for a refused file")
        }
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
        // An existing slot is still writable once this device has seen it (S2).
        _ = try await rig.client.list()
        guard case .done = try await rig.client.write("s3", bytes: Data("z".utf8), metadata: obj([:])).outcome()
        else { return XCTFail("overwrite") }
    }

    /// A seeded save at version 1 and a write on a stale base: the conflict, as an open request.
    private func conflictRig() async throws -> (rig: Rig, request: MergeRequest) {
        let rig = Rig(e2e: false)
        rig.records.seed("slot1", ["who": .string("remote")], bytes: Data("remote".utf8))
        // The caller last saw version 0 of a record that is now at 1.
        let t = try await rig.client.write(
            "slot1", bytes: Data("local".utf8), metadata: obj(["who": .string("local")]),
            options: SaveWriteOptions(baseVersion: 0))
        guard case .conflict(let request) = await t.outcome() else {
            XCTFail("not a conflict")
            throw CancellationError()
        }
        XCTAssertEqual(t.state, .conflict)
        return (rig, request)
    }

    // @pkey-feature sync.conflict (saveConflictOpensRequest)
    func testSaveConflictOpensRequest() async throws {
        let (rig, request) = try await conflictRig()
        XCTAssertEqual(request.id, "w:saves/slot1")
        XCTAssertEqual(request.cause, .write)
        XCTAssertEqual(request.collection, "saves")
        XCTAssertEqual(request.record, "slot1")
        XCTAssertEqual(request.state, .open)
        XCTAssertNil(request.error)
        XCTAssertEqual(request.choices, [.local, .remote, .both])
        XCTAssertEqual(request.remote?.value, obj(["who": .string("remote")]))
        XCTAssertEqual(request.remote?.version, 1)
        XCTAssertEqual(request.local?.value, stamped(["who": .string("local")]))
        XCTAssertEqual(request.local?.version, 0)
        XCTAssertEqual(request.local?.file?.size, 5)
        XCTAssertEqual(request.local?.savedAt, savedAtNow)
        let open = await rig.client.merge.conflicts()
        XCTAssertEqual(open.map(\.id), ["w:saves/slot1"])
    }

    // @pkey-feature sync.conflict (saveKeepRemote)
    func testSaveKeepRemote() async throws {
        let (rig, request) = try await conflictRig()
        let callsBefore = rig.files.calls.count
        // remote: nothing is written, and the pull is the one the conflict made plus the keep's.
        let outcome = await request.keep(.remote)
        XCTAssertEqual(outcome, .kept(.remote, version: 1, copyId: nil))
        XCTAssertEqual(rig.files.calls.count, callsBefore)
        let open = await rig.client.merge.conflicts()
        XCTAssertTrue(open.isEmpty)
    }

    // @pkey-feature sync.conflict (saveKeepLocal)
    func testSaveKeepLocal() async throws {
        let (rig, request) = try await conflictRig()
        // local: written on top of the server's version.
        let outcome = await request.keep(.local)
        guard case .kept(.local, let version?, nil) = outcome else { return XCTFail("keep local: \(outcome)") }
        XCTAssertGreaterThan(version, 1)
        let r = try await rig.records.get("slot1")
        XCTAssertEqual(r?.value, ["who": .string("local"), saveSavedAtKey: .int(savedAtNow)])
        XCTAssertEqual(r?.version, version)
        let open = await rig.client.merge.conflicts()
        XCTAssertTrue(open.isEmpty)
    }

    func testKeepBothWritesTheCopyInAFreeSlot() async throws {
        let (rig, request) = try await conflictRig()
        guard case .kept(.both, _, let copy?) = await request.keep(.both) else { return XCTFail("keep both") }
        XCTAssertEqual(copy, "slot1.copy")
        let r1 = try await rig.records.get("slot1")
        XCTAssertEqual(r1?.value, ["who": .string("remote")])
        let r2 = try await rig.records.get("slot1.copy")
        XCTAssertEqual(r2?.value, ["who": .string("local"), saveSavedAtKey: .int(savedAtNow)])
    }

    func testAConflictDescribesTheServersVersionNotTheCachedCopy() async throws {
        let rig = Rig(e2e: false)
        rig.records.seed("slot1", ["who": .string("old")], bytes: Data("old".utf8))
        // Another device wrote version 40; this device's cache still holds version 1.
        rig.files.conflictAt["slot1"] = 40
        let t = try await rig.client.write(
            "slot1", bytes: Data("mine".utf8), metadata: obj(["who": .string("mine")]))
        guard case .conflict(let c) = await t.outcome() else { return XCTFail("not a conflict") }
        XCTAssertEqual(c.remote?.version, 40)
        XCTAssertNotEqual(c.remote?.value, obj(["who": .string("old")]))
        // Keeping this device's version succeeds, and the next write does not repeat the conflict.
        rig.files.conflictAt = [:]
        rig.files.lock.withLock { rig.files.versionSeq["slot1"] = 40 }
        let outcome0 = await c.keep(.local)
        XCTAssertTrue(outcome0.isOK)
        guard case .done = try await rig.client.write("slot1", bytes: Data("again".utf8), metadata: obj([:])).outcome()
        else { return XCTFail("a repeated conflict") }
    }

    func testAConflictAndKeepingTheOtherVersionPullFirstAndSavesRecordWhenAndWhere() async throws {
        let rig = Rig(e2e: false)
        rig.env.label = "Steam Deck"
        rig.records.seed("slot1", ["who": .string("old")], bytes: Data("old".utf8))
        rig.files.conflictAt["slot1"] = 40
        // The pull brings in the server's version-40 row (this device's cache held version 1).
        let records = rig.records
        rig.records.onPull = {
            records.lock.withLock {
                records.rows["slot1"] = SaveRecord(
                    id: "slot1", version: 40, value: ["who": .string("theirs"), saveSavedAtKey: .int(500)], file: nil)
            }
        }
        let t = try await rig.client.write(
            "slot1", bytes: Data("mine".utf8), metadata: obj(["who": .string("mine")]))
        guard case .conflict(let c) = await t.outcome() else { return XCTFail("not a conflict") }
        XCTAssertEqual(rig.records.pulls, 1)
        XCTAssertEqual(c.remote?.version, 40)
        XCTAssertEqual(c.remote?.value, obj(["who": .string("theirs"), saveSavedAtKey: .int(500)]))
        XCTAssertEqual(c.remote?.savedAt, 500)
        // This device's card carries when and where it was saved.
        XCTAssertEqual(c.local?.value, stamped(["who": .string("mine"), saveDeviceKey: .string("Steam Deck")]))
        XCTAssertEqual(c.local?.device, "Steam Deck")
        XCTAssertEqual(c.local?.savedAt, savedAtNow)
        XCTAssertEqual(c.newer, .local)
        // Keeping the other version pulls again, and the chosen copy is what is held.
        let outcome1 = await c.keep(.remote)
        XCTAssertEqual(outcome1, .kept(.remote, version: 40, copyId: nil))
        XCTAssertEqual(rig.records.pulls, 2)
    }

    func testASaveDeletedElsewhereReadsAsDeletedAfterThePull() async throws {
        let rig = Rig(e2e: false)
        rig.records.seed("slot1", ["who": .string("old")], bytes: Data("old".utf8))
        // A tombstone answers its version, not 0; the pull removes the row.
        rig.files.conflictAt["slot1"] = 99
        let records = rig.records
        rig.records.onPull = { records.lock.withLock { _ = records.rows.removeValue(forKey: "slot1") } }
        let t = try await rig.client.write(
            "slot1", bytes: Data("mine".utf8), metadata: obj(["who": .string("mine")]))
        guard case .conflict(let c) = await t.outcome() else { return XCTFail("not a conflict") }
        XCTAssertNil(c.remote)
    }

    // @pkey-feature sync.conflict (saveKeepAfterDeleteCreates)
    func testSaveKeepAfterDeleteCreates() async throws {
        let rig = Rig(e2e: false)
        rig.records.seed("slot1", ["who": .string("old")], bytes: Data("old".utf8))
        rig.files.conflictAt["slot1"] = 0
        let t = try await rig.client.write(
            "slot1", bytes: Data("mine".utf8), metadata: obj(["who": .string("mine")]))
        guard case .conflict(let c) = await t.outcome() else { return XCTFail("not a conflict") }
        XCTAssertNil(c.remote)
        XCTAssertEqual(c.choices, [.local, .remote])
        rig.files.conflictAt = [:]
        rig.files.lock.withLock { rig.files.versionSeq["slot1"] = 0 }
        let outcome2 = await c.keep(.local)
        XCTAssertTrue(outcome2.isOK)
        XCTAssertEqual(rig.files.bases.last, .some(.string("*")))
    }

    // @pkey-feature sync.conflict (saveKeepBothNeedsFreeSlot)
    func testSaveKeepBothNeedsFreeSlot() async throws {
        let rig = Rig(e2e: false)
        for n in 0..<SYNC_SAVE_SLOTS { rig.records.seed(n == 0 ? "slot1" : "s\(n)", [:], bytes: Data("x".utf8)) }
        let t = try await rig.client.write(
            "slot1", bytes: Data("l".utf8), metadata: obj([:]), options: SaveWriteOptions(baseVersion: 0))
        guard case .conflict(let c) = await t.outcome() else { return XCTFail("not a conflict") }
        XCTAssertEqual(c.choices, [.local, .remote], "both is not offered while the 16 slots are full")
        let calls = rig.files.calls.count
        let outcome3 = await c.keep(.both)
        XCTAssertEqual(outcome3, .failed(code: "bad_request", reopened: false))
        XCTAssertEqual(rig.files.calls.count, calls)
        XCTAssertEqual(c.state, .open)
    }

    func testAMetadataConflictAfterTheFileIsAConflictToo() async throws {
        let rig = Rig(e2e: false)
        rig.records.failSet = .conflict(server: SaveRecord(id: "slot1", version: 9, value: ["a": .int(1)], file: nil))
        guard
            case .conflict(let c) = try await rig.client.write("slot1", bytes: Data("l".utf8), metadata: obj([:]))
                .outcome()
        else { return XCTFail("not a conflict") }
        XCTAssertEqual(c.remote?.version, 9)
    }

    // @pkey-feature sync.conflict (saveRequestFreezesSlot)
    func testSaveRequestFreezesSlot() async throws {
        let (rig, request) = try await conflictRig()
        let seen = LockedValue<[String]>([])
        rig.client.merge.watch { signal in
            switch signal {
            case .opened: seen.with { $0.append("opened") }
            case .closed: seen.with { $0.append("closed") }
            }
        }
        let calls = rig.files.calls.count
        let later = Data("later copy!".utf8)
        let t = try await rig.client.write(
            "slot1", bytes: later, metadata: obj(["who": .string("later")]))
        guard case .conflict(let again) = await t.outcome() else { return XCTFail("not a conflict") }
        XCTAssertTrue(again === request)
        XCTAssertEqual(request.local?.value, stamped(["who": .string("later")]))
        XCTAssertEqual(request.local?.file?.size, later.count)
        XCTAssertEqual(rig.files.calls.count, calls, "nothing is sent while a request is open")
        let open = await rig.client.merge.conflicts()
        XCTAssertEqual(open.count, 1)
        XCTAssertEqual(seen.current, [])
        // The later copy is the one that is kept.
        let outcome4 = await request.keep(.local)
        XCTAssertTrue(outcome4.isOK)
        guard case .ok(let read) = try await rig.client.read("slot1") else { return XCTFail("read") }
        XCTAssertEqual(read.metadata.objectValue?["who"], .string("later"))
        XCTAssertEqual(read.bytes, later)
    }

    // @pkey-feature sync.conflict (saveRequestFreezesSlot)
    func testSaveRequestFreezesSlotDeleteKeepsTheOtherCopy() async throws {
        let (rig, request) = try await conflictRig()
        // The delete's default base is the request's (0): it conflicts and the other copy survives.
        guard case .conflict = try await rig.client.delete("slot1") else { return XCTFail("a delete that conflicts") }
        let kept = try await rig.records.get("slot1")
        XCTAssertEqual(kept?.value, ["who": .string("remote")])
        let open = await rig.client.merge.conflicts()
        XCTAssertTrue(open.isEmpty)
        let outcome5 = await request.keep(.local)
        XCTAssertEqual(outcome5, .failed(code: ErrorCode.syncMergeClosed, reopened: false))
    }

    // @pkey-feature sync.conflict (saveBaseIsSeenVersion)
    func testSaveBaseIsSeenVersion() async throws {
        let rig = Rig(e2e: false)
        guard case .done = try await rig.client.write("slot1", bytes: Data("one".utf8), metadata: obj([:])).outcome()
        else { return XCTFail("create") }
        // Another device writes; this device's cache is refreshed by a pull. A pulled version is never a base.
        rig.records.seed("slot1", ["who": .string("other")], bytes: Data("other copy".utf8))
        guard
            case .conflict(let mine) = try await rig.client.write(
                "slot1", bytes: Data("mine".utf8), metadata: obj([:])
            ).outcome()
        else { return XCTFail("silently overwritten") }
        XCTAssertEqual(mine.local?.version, 1, "the version this device wrote")
        XCTAssertNotEqual(mine.local?.version, mine.remote?.version)
        // A fresh client has not seen the slot: its write is create-only.
        let fresh = SavesClient(env: rig.env, options: SavesOptions(delta: false), emit: { _ in }, now: { savedAtNow })
        guard
            case .conflict(let created) = try await fresh.write("slot1", bytes: Data("c".utf8), metadata: obj([:]))
                .outcome()
        else { return XCTFail("create-only") }
        XCTAssertNil(created.local?.version)
        // Reading the slot is seeing it.
        let reader = SavesClient(env: rig.env, options: SavesOptions(delta: false), emit: { _ in }, now: { savedAtNow })
        _ = try await reader.read("slot1")
        guard case .done = try await reader.write("slot1", bytes: Data("r".utf8), metadata: obj([:])).outcome()
        else { return XCTFail("a slot that was read") }
    }

    // @pkey-feature sync.conflict (saveExactWriteSupersedes)
    func testSaveExactWriteSupersedes() async throws {
        let (rig, request) = try await conflictRig()
        let closed = LockedValue<[String]>([])
        rig.client.merge.watch { signal in
            if case .closed(let id, let how) = signal { closed.with { $0.append("\(id):\(how.rawValue)") } }
        }
        let server = request.remote!.version!
        guard
            case .done = try await rig.client.write(
                "slot1", bytes: Data("exact".utf8), metadata: obj([:]), options: SaveWriteOptions(baseVersion: server)
            ).outcome()
        else { return XCTFail("exact write") }
        XCTAssertEqual(closed.current, ["w:saves/slot1:superseded"])
        let open = await rig.client.merge.conflicts()
        XCTAssertTrue(open.isEmpty)
        let outcome6 = await request.keep(.local)
        XCTAssertEqual(outcome6, .failed(code: ErrorCode.syncMergeClosed, reopened: false))
    }

    // @pkey-feature sync.conflict (saveKeepOnClosedRequest)
    func testSaveKeepOnClosedRequest() async throws {
        let (rig, request) = try await conflictRig()
        let outcome7 = await request.keep(.remote)
        XCTAssertTrue(outcome7.isOK)
        let calls = rig.files.calls.count
        let outcome8 = await request.keep(.local)
        XCTAssertEqual(outcome8, .failed(code: ErrorCode.syncMergeClosed, reopened: false))
        XCTAssertEqual(rig.files.calls.count, calls)
    }

    func testSaveKeepThatMeetsANewerSaveReopensTheRequest() async throws {
        let (rig, request) = try await conflictRig()
        let opened = LockedValue<Int>(0)
        rig.client.merge.watch { signal in
            if case .opened = signal { opened.with { $0 += 1 } }
        }
        let before = request.remote!.version!
        // Another device writes again before the keep lands.
        rig.records.seed("slot1", ["who": .string("three")], bytes: Data("three".utf8))
        let outcome9 = await request.keep(.local)
        XCTAssertEqual(outcome9, .failed(code: "conflict", reopened: true))
        XCTAssertEqual(request.state, .open)
        XCTAssertGreaterThan(request.remote!.version!, before)
        XCTAssertEqual(request.remote?.value, obj(["who": .string("three")]))
        XCTAssertEqual(opened.current, 1)
        // The person decides again.
        let outcome10 = await request.keep(.local)
        XCTAssertTrue(outcome10.isOK)
    }

    // @pkey-feature sync.conflict (saveRequestNotJournaled)
    func testSaveRequestNotJournaled() async throws {
        let (rig, _) = try await conflictRig()
        XCTAssertTrue(rig.journal.list().isEmpty)
        let next = SavesClient(env: rig.env, options: SavesOptions(delta: false), emit: { _ in }, now: { savedAtNow })
        let open = await next.merge.conflicts()
        XCTAssertTrue(open.isEmpty)
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

    func testAClosedChannelEndsTheTransferInsteadOfRetryingIt() async throws {
        let attempts = LockedValue(0)
        let t = SaveTransfer(
            id: "saves:slot1", progress: LockedValue((0, 0)),
            attempt: {
                // A channel that stays closed answers `closed` every time; a retry would be a loop.
                let n = attempts.with { count -> Int in
                    count += 1
                    return count
                }
                if n > 3 { throw TransferError(.rejected) }
                throw TransferError(.closed)
            },
            release: {}, onSettle: { _ in })
        t.start()
        guard case .cancelled = await t.outcome() else { return XCTFail("a closed channel is a cancel") }
        XCTAssertEqual(attempts.current, 1)
        XCTAssertEqual(t.state, .cancelled)
    }

    func testPurgeStopsRunningSavesBeforeTheJournalIsCleared() async throws {
        let rig = Rig(e2e: false)
        rig.records.lock.withLock { rig.records.holdSet = true }
        let t = try await rig.client.write("slot1", bytes: Data("x".utf8), metadata: obj([:]))
        for _ in 0..<200 where rig.records.lock.withLock({ rig.records.sets.isEmpty }) {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        let seen = LockedValue<Bool?>(nil)
        rig.env.atPurge = { seen.set(t.cancelRequested) }
        await rig.client.purge()
        XCTAssertEqual(seen.current, true, "the cancel is set before the files are purged")
        guard case .cancelled = await t.outcome() else { return XCTFail("not cancelled") }
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
