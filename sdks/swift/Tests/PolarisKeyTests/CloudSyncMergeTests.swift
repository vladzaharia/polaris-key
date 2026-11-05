// @pkey-feature sync.conflict
//
// MergeRequest (U-08; plans/U-08.md section 2): the registry over a real machine. A `revision` record's plain
// put that meets a conflict opens one request, the device keeps its copy unsent, and `keep` settles it. The
// harness is the host's job in miniature: after every machine turn it hands the registry the events just
// taken, the machine's open requests and the versions of the requests that closed. The scenario corpus
// (`SyncScenariosTests`) pins the machine; these tests pin what the client builds on it.

import Foundation
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

private func js(_ s: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }

private func body(
    cursor: Int, changes: String = "[]", results: String = "[]", extra: String = ""
) -> JSONValue {
    js(
        """
        {"encryption":"server","subject":"sub_alice","serverNow":1760000000000,"cursor":\(cursor),"more":false,
         "lastMutationId":0,"catalogVersion":1,"aliases":{},"quota":{"bytes":268435456,"files":true},
         "usage":{"bytes":0,"settings":0,"records":0,"files":0},"changes":\(changes),"tombstones":[],
         "results":\(results)\(extra)}
        """)
}

/// The host's turn, in miniature: a machine and the registry that hears it.
private final class Harness: MergeMachinePort, @unchecked Sendable {
    let machine: CloudSyncMachine
    let registry: MergeRegistry
    let noticed = LockedValue<Int>(0)

    init() throws {
        var o = SyncMachineOptions(
            product: "demo",
            catalog: SyncMachineCatalog(
                settings: [], collections: [SyncCollectionDecl(name: "progress", policy: "revision")]),
            document: SyncMachineDocument(), now: 1_760_000_000_000, newClientId: { "c_000000000000000client1" })
        o.subject = "sub_alice"
        o.contacted = true
        o.encryption = .server
        o.discovery = .server
        machine = try CloudSyncMachine(o)
        let counter = noticed
        registry = MergeRegistry(notice: { _ in counter.with { $0 += 1 } })
        registry.attach(self)
        _ = machine.takeRequests()
        try machine.receive(.answer(status: 200, body: body(cursor: 9, changes: Harness.row(3, version: 7))))
        pump()
    }

    static func row(_ level: Int, version: Int) -> String {
        "[{\"record\":[\"progress\",\"main\"],\"value\":{\"level\":\(level)},\"version\":\(version)}]"
    }

    /// What the host does after a turn.
    func pump() {
        let events = machine.takeEvents()
        var versions: [String: Int] = [:]
        for case .conflictClosed(let id, _) in events {
            if let row = machine.records("progress").first { versions[id] = row.version }
        }
        registry.ingest(events, machine.conflicts(), versions: versions)
    }

    func answer(_ b: JSONValue) throws {
        try machine.receive(.answer(status: 200, body: b))
        pump()
    }

    func keep(_ id: String, _ choice: MergeKeep) async -> CallResult {
        let r = machine.keep(id, choice)
        pump()
        return r
    }

    func snapshot() async -> [SyncMachineConflict]? { machine.conflicts() }

    /// Write level 4 over version 7 while the cloud holds level 5 at version 8: the conflict.
    func conflict() throws {
        XCTAssertEqual(machine.put("progress", "main", js("{\"level\":4}")), .ok)
        _ = machine.takeRequests()
        try answer(
            body(
                cursor: 10, changes: Harness.row(5, version: 8),
                results:
                    "[{\"mutationId\":1,\"status\":\"conflict\",\"server\":{\"value\":{\"level\":5},\"version\":8}}]"
            ))
    }

    /// The machine's answer to the keep's set (mutation `id`).
    func okSet(mutation id: Int, version: Int, level: Int) throws {
        _ = machine.takeRequests()
        try answer(
            body(
                cursor: 11, changes: Harness.row(level, version: version),
                results: "[{\"mutationId\":\(id),\"status\":\"ok\",\"version\":\(version)}]"))
    }
}

final class CloudSyncMergeTests: XCTestCase {
    private let id = "w:progress/main"

    func testARevisionConflictOpensARequestAndTheDeviceKeepsItsCopyUnsent() async throws {
        let h = try Harness()
        let heard = LockedValue<[String]>([])
        _ = await h.registry.addListener { r in
            heard.with { $0.append(r.id) }
            return nil
        }
        try h.conflict()
        XCTAssertEqual(heard.current, [id])
        let open = await h.registry.conflicts()
        XCTAssertEqual(open.map(\.id), [id])
        let r = open[0]
        XCTAssertEqual(r.cause, .write)
        XCTAssertEqual(r.collection, "progress")
        XCTAssertEqual(r.record, "main")
        XCTAssertEqual(r.local?.value, js("{\"level\":4}"))
        XCTAssertEqual(r.local?.version, 7)
        XCTAssertEqual(r.remote?.value, js("{\"level\":5}"))
        XCTAssertEqual(r.remote?.version, 8)
        XCTAssertEqual(r.choices, [.local, .remote, .value])
        XCTAssertEqual(r.state, .open)
        XCTAssertNil(r.newer)
        XCTAssertEqual(h.machine.status().conflicts, 1)
        XCTAssertTrue(h.machine.takeRequests().isEmpty, "nothing is enqueued until keep")
        XCTAssertEqual(h.machine.record("progress", "main")?.value, js("{\"level\":4}"))
        XCTAssertEqual(h.machine.record("progress", "main")?.from, .pending)
    }

    func testAListenerThatReturnsAChoiceDecidesInline() async throws {
        let h = try Harness()
        let closed = LockedValue<[String]>([])
        h.registry.watch { signal in
            if case .closed(let id, let how) = signal { closed.with { $0.append("\(id):\(how.rawValue)") } }
        }
        _ = await h.registry.addListener { _ in .remote }
        try h.conflict()
        // The decision runs on a task of its own: wait for it to land.
        for _ in 0..<200 where !h.machine.conflicts().isEmpty { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(h.machine.conflicts().isEmpty)
        XCTAssertEqual(closed.current, ["\(id):remote"])
        XCTAssertNil(h.machine.status().conflicts)
        XCTAssertEqual(h.machine.record("progress", "main")?.value, js("{\"level\":5}"))
    }

    func testKeepLocalIsApplyingUntilTheSetIsAnsweredThenClosesAsLocal() async throws {
        let h = try Harness()
        try h.conflict()
        let r = await h.registry.conflicts()[0]
        let result = Task { await r.keep(.local) }
        for _ in 0..<200 where r.state != .applying { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertEqual(r.state, .applying)
        // One set of the device's copy on the remote version.
        let sent = h.machine.takeRequests().first?.body?.objectValue?["mutations"]?.arrayValue ?? []
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.objectValue?["baseVersion"], .int(8))
        XCTAssertEqual(sent.first?.objectValue?["value"], js("{\"level\":4}"))
        // A second keep while it applies is refused.
        let again = await r.keep(.remote)
        XCTAssertEqual(again, .failed(code: "bad_request", reopened: false))
        try h.okSet(mutation: 2, version: 9, level: 4)
        let outcome = await result.value
        XCTAssertEqual(outcome, .kept(.local, version: 9, copyId: nil))
        let open = await h.registry.conflicts()
        XCTAssertTrue(open.isEmpty)
        // Closed: a keep on it is the typed client code.
        let late = await r.keep(.local)
        XCTAssertEqual(late, .failed(code: ErrorCode.syncMergeClosed, reopened: false))
    }

    func testKeepValueSendsTheNewValueOnTheRemoteVersion() async throws {
        let h = try Harness()
        try h.conflict()
        let r = await h.registry.conflicts()[0]
        let result = Task { await r.keep(.value(js("{\"level\":9}"))) }
        for _ in 0..<200 where r.state != .applying { try await Task.sleep(nanoseconds: 5_000_000) }
        let sent = h.machine.takeRequests().first?.body?.objectValue?["mutations"]?.arrayValue ?? []
        XCTAssertEqual(sent.first?.objectValue?["value"], js("{\"level\":9}"))
        XCTAssertEqual(sent.first?.objectValue?["baseVersion"], .int(8))
        try h.okSet(mutation: 2, version: 9, level: 9)
        let outcome = await result.value
        XCTAssertEqual(outcome, .kept(.value, version: 9, copyId: nil))
    }

    func testKeepRemoteSendsNothingAndReadsTheServerCopy() async throws {
        let h = try Harness()
        try h.conflict()
        let r = await h.registry.conflicts()[0]
        let outcome = await r.keep(.remote)
        XCTAssertEqual(outcome, .kept(.remote, version: 8, copyId: nil))
        XCTAssertTrue(h.machine.takeRequests().isEmpty)
        XCTAssertEqual(h.machine.record("progress", "main")?.value, js("{\"level\":5}"))
        XCTAssertEqual(h.machine.record("progress", "main")?.from, .cloud)
    }

    func testAKeepThatConflictsAgainReopensTheRequestWithTheNewRemote() async throws {
        let h = try Harness()
        try h.conflict()
        let opened = LockedValue<Int>(0)
        h.registry.watch { signal in
            if case .opened = signal { opened.with { $0 += 1 } }
        }
        let r = await h.registry.conflicts()[0]
        let result = Task { await r.keep(.local) }
        for _ in 0..<200 where r.state != .applying { try await Task.sleep(nanoseconds: 5_000_000) }
        _ = h.machine.takeRequests()
        try h.answer(
            body(
                cursor: 11, changes: Harness.row(6, version: 10),
                results:
                    "[{\"mutationId\":2,\"status\":\"conflict\",\"server\":{\"value\":{\"level\":6},\"version\":10}}]"))
        let outcome = await result.value
        XCTAssertEqual(outcome, .failed(code: "conflict", reopened: true))
        XCTAssertEqual(r.state, .open)
        XCTAssertEqual(r.remote?.version, 10)
        XCTAssertEqual(r.local?.value, js("{\"level\":4}"))
        XCTAssertEqual(opened.current, 1)
    }

    func testAKeepThatIsRefusedForGoodReopensTheRequestWithTheFailure() async throws {
        let h = try Harness()
        try h.conflict()
        let r = await h.registry.conflicts()[0]
        let result = Task { await r.keep(.local) }
        for _ in 0..<200 where r.state != .applying { try await Task.sleep(nanoseconds: 5_000_000) }
        _ = h.machine.takeRequests()
        try h.answer(
            body(
                cursor: 11,
                results: "[{\"mutationId\":2,\"status\":\"rejected\",\"code\":\"value_invalid\"}]"))
        let outcome = await result.value
        XCTAssertEqual(outcome, .failed(code: "value_invalid", reopened: true))
        XCTAssertEqual(r.state, .open)
        XCTAssertEqual(r.error, "value_invalid")
    }

    func testAChoiceTheRequestDoesNotOfferIsBadRequestAndLeavesItOpen() async throws {
        let h = try Harness()
        try h.conflict()
        let r = await h.registry.conflicts()[0]
        let outcome = await r.keep(.both)
        XCTAssertEqual(outcome, .failed(code: "bad_request", reopened: false))
        XCTAssertEqual(r.state, .open)
        XCTAssertTrue(h.machine.takeRequests().isEmpty)
    }

    func testAListenerRegisteredLaterIsOfferedTheRequestsAlreadyOpen() async throws {
        let h = try Harness()
        try h.conflict()
        let heard = LockedValue<[String]>([])
        let sub = await h.registry.addListener { r in
            heard.with { $0.append(r.id) }
            return nil
        }
        XCTAssertEqual(heard.current, [id])
        sub.cancel()
        // It opened while nothing listened, so the dev notice fired for it, once.
        XCTAssertEqual(h.noticed.current, 1)
    }

    func testTheDevNoticeFiresOnceWhenNothingListens() async throws {
        let h = try Harness()
        try h.conflict()
        XCTAssertEqual(h.noticed.current, 1)
        // A second request in the same registry does not repeat it.
        let other = MergeView(
            id: "w:saves/x", cause: .write, collection: "saves", record: "x", local: nil, remote: nil,
            choices: [.local, .remote], state: .open, error: nil)
        h.registry.open(other) { _ in MergeRegistry.closedOutcome }
        XCTAssertEqual(h.noticed.current, 1)
    }

    func testSigningOutClosesTheMachinesRequestsAndCountsThemAsUnsynced() async throws {
        let h = try Harness()
        try h.conflict()
        _ = h.machine.signOut()
        let events = h.machine.takeEvents()
        XCTAssertTrue(events.contains(.signedOut(reason: .signOut, unsynced: 1)))
        XCTAssertTrue(events.contains(.unsyncedData(count: 1)))
        h.registry.ingest(events, h.machine.conflicts(), versions: [:])
        let open = await h.registry.conflicts()
        XCTAssertTrue(open.isEmpty)
    }

    func testAnOpenRequestSurvivesTheJournalAndCloudEmptyIsKept() throws {
        let h = try Harness()
        try h.conflict()
        let saved = h.machine.persist()
        let back = SyncMachineState(fileJSON: saved.fileJSON)
        XCTAssertNotNil(back)
        let part = back?.partitions["sub_alice"]
        XCTAssertEqual(part?.conflicts["progress/main"]?.localVersion, 7)
        XCTAssertEqual(part?.conflicts["progress/main"]?.local, js("{\"level\":4}"))
        XCTAssertEqual(part?.empty, saved.partitions["sub_alice"]?.empty)
    }
}
