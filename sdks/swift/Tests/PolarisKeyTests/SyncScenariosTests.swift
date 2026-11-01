// @pkey-feature sync.saves
// @pkey-feature sync.scenarios
// @pkey-feature sync.e2e
// @pkey-feature sync.settings
// @pkey-feature config.sync
//
// The Swift runner for `conformance/corpus/v2/sync-scenarios.json` (U-07.1), read in place through
// `CorpusLocator`. Mirrors Python's `test_sync_scenarios.py`.
//
// `settingCases` runs in full, and so does every scenario: the runner carries no skip list, so a row
// X-1.1 adds (`e2e-conflict-plaintext-copy-refused`) replays at once. The corpus version is compared
// with the generated constant, never a literal.

import Foundation
import PolarisKeyCore
import XCTest

/// What the scenario driver needs of a machine. The machine (U-07.2) conforms in the test target
/// until the host owns it; every answer is the plain JSON the corpus compares.
protocol SyncScenarioMachine: AnyObject {
    func call(_ name: String, _ args: [JSONValue]) -> JSONValue
    func advance(ms: Int)
    func setNetwork(_ state: String)
    func receive(status: Int, body: JSONValue?, opened: SyncOpenedBody?) throws
    func receiveTransportError() throws
    func setRoot(has: Bool)
    func signIn(subject: String) throws
    func signOut(discardUnsynced: Bool)
    func relaunch(journalLost: Bool) throws -> SyncScenarioMachine
    func takeRequests() -> [JSONValue]
    func takeEvents() -> [JSONValue]
    func get(_ key: String) -> JSONValue?
    func settingState(_ key: String) -> JSONValue?
    func record(_ collection: String, _ id: String) -> JSONValue?
    func journal() -> JSONValue
    func records(_ collection: String) -> JSONValue
    func takeOutcomes() -> [JSONValue]
    func status() -> JSONValue
    func encryptionSince() -> JSONValue
}

/// The scenario's `init` block, as the machine's constructor takes it.
struct SyncScenarioInit {
    let json: [String: JSONValue]
    var clientIds: [String]
    init(_ v: JSONValue) {
        json = v.objectValue ?? [:]
        clientIds = (json["clientIds"]?.arrayValue ?? []).compactMap(\.stringValue)
    }
    subscript(key: String) -> JSONValue? { json[key] }
}

private struct SyncScenarioFile {
    let root: [String: JSONValue]
    var scenarios: [[String: JSONValue]] { (root["scenarios"]?.arrayValue ?? []).compactMap(\.objectValue) }
    var settingCases: [[String: JSONValue]] { (root["settingCases"]?.arrayValue ?? []).compactMap(\.objectValue) }
    /// The records binding of cloudSync.saves (plans/U-22.5.md): a second family, replayed in full.
    var fileRecordScenarios: [[String: JSONValue]] {
        let family = root["fileRecordCases"]?.objectValue
        return (family?["scenarios"]?.arrayValue ?? []).compactMap(\.objectValue)
    }

    static func load() throws -> SyncScenarioFile {
        let v = try CorpusLocator.load(JSONValue.self, "sync-scenarios")
        return SyncScenarioFile(root: v.objectValue ?? [:])
    }
}

final class SyncScenariosTests: XCTestCase {
    /// Builds the machine for a scenario.
    static func makeMachine(_ i: SyncScenarioInit, _ product: JSONValue, _ newId: @escaping () -> String) throws
        -> SyncScenarioMachine
    {
        let a = try CloudSyncScenarioAdapter(product: product, initBlock: i, newClientId: newId)
        if let legacy = i["legacyLocal"], legacy != .null {
            XCTAssertEqual(a.machine.importLocal(legacy.objectValue ?? [:]), .ok, "import")
        }
        return a
    }

    private func file() throws -> SyncScenarioFile { try SyncScenarioFile.load() }

    func testCorpusConstants() throws {
        let f = try file()
        XCTAssertEqual(f.root["syncScenariosVersion"], .int(SYNC_SCENARIOS_VERSION))
        let want: [String: JSONValue] = [
            "debounceMs": .int(SYNC_DEBOUNCE_MS),
            "signOutFlushMs": .int(SYNC_SIGNOUT_FLUSH_MS),
            "pendingDays": .int(SYNC_PENDING_DAYS),
            "maxMutationsPerPush": .int(SYNC_MAX_MUTATIONS),
            "maxClockSkewMs": .int(SYNC_MAX_CLOCK_SKEW_MS),
            "maxValueBytes": .int(SYNC_MAX_VALUE_BYTES),
        ]
        XCTAssertEqual(f.root["constants"]?.objectValue, want)
    }

    func testScenarios() throws {
        let f = try file()
        var ran = 0
        for sc in f.scenarios {
            let name = sc["name"]?.stringValue ?? "?"
            try runScenario(sc, name: name, make: Self.makeMachine, product: f.root["product"] ?? .null)
            ran += 1
        }
        XCTAssertEqual(ran, f.scenarios.count)
        XCTAssertFalse(f.scenarios.isEmpty)
    }

    // MARK: - The driver (Python `test_scenario`)

    private func runScenario(
        _ sc: [String: JSONValue], name: String,
        make: (SyncScenarioInit, JSONValue, @escaping () -> String) throws -> SyncScenarioMachine, product: JSONValue
    ) throws {
        let initBlock = SyncScenarioInit(sc["init"] ?? .null)
        var ids = initBlock.clientIds
        let newClientId: () -> String = {
            XCTAssertFalse(ids.isEmpty, "init.clientIds exhausted")
            return ids.isEmpty ? "" : ids.removeFirst()
        }
        var m = try make(initBlock, product, newClientId)
        let licence = initBlock["licence"]
        for (i, step) in (sc["steps"]?.arrayValue ?? []).enumerated() {
            guard let (kind, raw) = step.objectValue?.first else { continue }
            let at = "\(name), step \(i + 1) (\(kind))"
            let o = raw.objectValue ?? [:]
            switch kind {
            case "local":
                let result = m.call(o["call"]?.stringValue ?? "", o["args"]?.arrayValue ?? [])
                if let want = o["expect"] { XCTAssertEqual(result, want, at) }
            case "advance": m.advance(ms: o["ms"]?.intValue ?? 0)
            case "network": m.setNetwork(o["state"]?.stringValue ?? "")
            case "respond":
                if o["error"] != nil {
                    try m.receiveTransportError()
                } else {
                    try m.receive(
                        status: o["status"]?.intValue ?? 0, body: o["body"],
                        opened: o["opened"].map(SyncOpenedBody.init(json:)))
                }
            case "root": m.setRoot(has: o["has"] == .bool(true))
            case "signIn": try m.signIn(subject: o["subject"]?.stringValue ?? "")
            case "signOut": m.signOut(discardUnsynced: o["discardUnsynced"] == .bool(true))
            case "relaunch": m = try m.relaunch(journalLost: o["journal"] == .string("lost"))
            case "assert": try assertStep(m, o, at: at, licence: licence)
            default: XCTFail("\(at): unknown step")
            }
        }
    }

    private func assertStep(_ m: SyncScenarioMachine, _ o: [String: JSONValue], at: String, licence: JSONValue?) throws
    {
        let requests = m.takeRequests()
        let events = m.takeEvents()
        if let want = o["requests"] { XCTAssertEqual(.array(requests), want, "\(at): requests") }
        if let want = o["events"] { XCTAssertEqual(.array(events), want, "\(at): events") }
        for (key, want) in o["values"]?.objectValue ?? [:] {
            XCTAssertTrue(jsonEqual(m.get(key), want), "\(at): values.\(key)")
        }
        for (key, want) in o["states"]?.objectValue ?? [:] {
            XCTAssertTrue(jsonEqual(m.settingState(key), want), "\(at): states.\(key)")
        }
        let outcomes = m.takeOutcomes()
        if let want = o["outcomes"] { XCTAssertTrue(jsonEqual(.array(outcomes), want), "\(at): outcomes") }
        for (c, want) in o["rows"]?.objectValue ?? [:] {
            XCTAssertTrue(jsonEqual(m.records(c), want), "\(at): rows.\(c)")
        }
        for (key, want) in o["records"]?.objectValue ?? [:] {
            let parts = key.split(separator: "/", maxSplits: 1).map(String.init)
            XCTAssertTrue(jsonEqual(m.record(parts[0], parts.count > 1 ? parts[1] : ""), want), "\(at): records.\(key)")
        }
        if let want = o["journal"] { XCTAssertTrue(jsonEqual(m.journal(), want), "\(at): journal") }
        if let want = o["status"] { XCTAssertTrue(jsonEqual(m.status(), want), "\(at): status") }
        if let want = o["encryptionSince"] {
            XCTAssertTrue(jsonEqual(m.encryptionSince(), want), "\(at): encryptionSince")
        }
        if let want = o["licence"] { XCTAssertTrue(jsonEqual(licence, want), "\(at): licence") }
    }

    // MARK: - fileRecordCases (replayed in full)

    func testFileRecordCases() throws {
        let f = try file()
        let family = f.root["fileRecordCases"]?.objectValue
        XCTAssertEqual(family?["calls"], .array([.string("putAt"), .string("removeAt")]))
        XCTAssertEqual(family?["asserts"], .array([.string("rows"), .string("outcomes")]))
        let scenarios = f.fileRecordScenarios
        XCTAssertEqual(scenarios.count, 19)
        // ported in SAVES-FILEPTR.2
        let pending: Set<String> = [
            "put-at-file-pointer-create", "put-at-file-pointer-update", "put-at-without-pointer-keeps-file",
        ]
        for sc in scenarios where !pending.contains(sc["name"]?.stringValue ?? "") {
            try runScenario(
                sc, name: sc["name"]?.stringValue ?? "?", make: Self.makeMachine, product: f.root["product"] ?? .null)
        }
    }

    // MARK: - settingCases (in full)

    func testSettingCases() throws {
        let cases = try file().settingCases
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = c["name"]?.stringValue ?? "?"
            let entries = c["entries"]?.arrayValue ?? []
            var issues: [JSONValue] = []
            var hasError = false
            for e in entries {
                for i in userSettingIssues(e) {
                    hasError = hasError || i.severity == .error
                    issues.append(
                        .object([
                            "key": e.objectValue?["key"] ?? .null, "code": .string(i.code),
                            "severity": .string(i.severity.rawValue),
                        ]))
                }
            }
            XCTAssertTrue(jsonEqual(.array(issues), c["issues"]), "\(name): issues")
            if c["routes"] == .null {
                XCTAssertTrue(hasError, "\(name): a null routes case holds an error")
                continue
            }
            let routes = syncedSettings(.object(["entries": .array(entries)]))
            XCTAssertTrue(jsonEqual(.array(routes.map(\.json)), c["routes"]), "\(name): routes")
            for key in (c["open"]?.arrayValue ?? []).compactMap(\.stringValue) {
                XCTAssertFalse(routes.contains { $0.key == key }, "\(name): \(key) is open")
            }
        }
    }

    func testBadHostClientIdThrows() throws {
        var o = SyncMachineOptions(
            product: "demo", catalog: SyncMachineCatalog(settings: []), document: SyncMachineDocument(), now: 0,
            newClientId: { "not-a-client-id" })
        o.subject = "sub_a"
        XCTAssertThrowsError(try CloudSyncMachine(o)) { XCTAssertEqual($0 as? SyncMachineError, .badClientId) }
        o.subject = nil
        let m = try CloudSyncMachine(o)
        XCTAssertThrowsError(try m.signIn("sub_a"))
        XCTAssertNil(m.persist().subject, "a refused sign-in moves nothing")
    }

    // MARK: - M-4 helpers

    func testJSONEqualIsNumericAndKeepsNullApartFromAbsent() {
        XCTAssertTrue(jsonEqual(.int(1), .double(1.0)))
        XCTAssertFalse(jsonEqual(.bool(true), .int(1)))
        XCTAssertFalse(jsonEqual(.null, nil))
        XCTAssertTrue(jsonEqual(nil, nil))
        XCTAssertFalse(jsonEqual(.double(.nan), .double(.nan)))
        XCTAssertTrue(jsonEqual(.object(["a": .int(1), "b": .null]), .object(["b": .null, "a": .double(1)])))
        XCTAssertFalse(jsonEqual(.object(["a": .null]), .object([:])))
        XCTAssertFalse(syncIsNumber(.bool(false)))
        XCTAssertFalse(syncIsInteger(.double(1.5)))
        XCTAssertTrue(syncIsInteger(.double(2.0)))
    }

    func testUTF16OrderAndByteBound() {
        // U+FF5E sorts above U+1F600 by scalar but below it by UTF-16 code unit (a surrogate pair).
        XCTAssertTrue(syncUTF16Less("\u{1F600}", "\u{FF5E}"))
        XCTAssertEqual(syncSortedKeys(["b", "\u{1F600}", "\u{FF5E}", "a"]), ["a", "b", "\u{1F600}", "\u{FF5E}"])
        XCTAssertEqual(jsonBytes(.object(["b": .double(1.0), "a": .string("é")])), #"{"a":"é","b":1}"#.utf8.count)
        XCTAssertEqual(jsonBytes(.double(.infinity)), Int.max)
    }
}

/// The machine behind the driver's protocol: it turns the corpus's `init` block into options and the
/// typed answers into the JSON the corpus compares.
final class CloudSyncScenarioAdapter: SyncScenarioMachine {
    let machine: CloudSyncMachine
    private let opts: SyncMachineOptions
    /// The outcomes since the last assert; shared with the machine a relaunch builds.
    private var sink = OutcomeSink()

    final class OutcomeSink { var items: [JSONValue] = [] }

    private func listen() {
        let sink = self.sink
        machine.onOutcome { ticket, outcome in sink.items.append(Self.outcomeJSON(ticket, outcome)) }
    }

    static func outcomeJSON(_ ticket: Int, _ o: SyncRecordOutcome) -> JSONValue {
        var out: [String: JSONValue] = ["mutationId": .int(ticket)]
        switch o {
        case .ok(let v):
            out["status"] = .string("ok")
            out["version"] = .int(v)
        case .conflict(let server):
            out["status"] = .string("conflict")
            if let server {
                out["server"] = .object([
                    "value": server.value, "version": .int(server.version), "file": server.file?.json ?? .null,
                ])
            } else {
                out["server"] = .null
            }
        case .rejected(let code):
            out["status"] = .string("rejected")
            out["code"] = .string(code)
        case .dropped: out["status"] = .string("dropped")
        }
        return .object(out)
    }

    init(product: JSONValue, initBlock i: SyncScenarioInit, newClientId: @escaping () -> String) throws {
        let cat = i["catalog"]?.objectValue ?? [:]
        let doc = i["document"]?.objectValue ?? [:]
        let clock = i["clock"]?.objectValue ?? [:]
        var o = SyncMachineOptions(
            product: product.stringValue ?? "",
            catalog: SyncMachineCatalog(
                settings: (cat["settings"]?.arrayValue ?? []).compactMap(SettingRoute.init(json:)),
                collections: (cat["collections"]?.arrayValue ?? []).compactMap {
                    guard let c = $0.objectValue, let n = c["name"]?.stringValue, let p = c["policy"]?.stringValue
                    else { return nil }
                    return SyncCollectionDecl(
                        name: n, policy: p, field: c["field"]?.stringValue, resolve: c["resolve"]?.stringValue)
                }),
            document: SyncMachineDocument(
                values: doc["values"]?.objectValue ?? [:],
                locked: (doc["locked"]?.arrayValue ?? []).compactMap(\.stringValue)),
            now: clock["now"]?.intValue ?? 0, newClientId: newClientId)
        o.offsetMs = clock["offsetMs"]?.intValue ?? 0
        o.contacted = clock["contacted"]?.boolValue ?? false
        o.subject = i["subject"]?.stringValue
        o.network = i["network"]?.stringValue.flatMap(SyncNetwork.init(rawValue:)) ?? .online
        o.onSignOut =
            i["options"]?.objectValue?["onSignOut"]?.stringValue.flatMap(SyncOnSignOut.init(rawValue:)) ?? .clear
        o.encryption = i["encryption"]?.stringValue.flatMap(SyncEncryption.init(rawValue:)) ?? .e2e
        o.hasRoot = i["hasRoot"]?.boolValue ?? false
        opts = o
        machine = try CloudSyncMachine(o)
        listen()
    }

    private init(machine: CloudSyncMachine, opts: SyncMachineOptions, sink: OutcomeSink) {
        self.machine = machine
        self.opts = opts
        self.sink = sink
        listen()
    }

    func records(_ collection: String) -> JSONValue {
        .array(
            machine.records(collection).map {
                .object([
                    "id": .string($0.id), "value": $0.value, "version": .int($0.version),
                    "file": $0.file?.json ?? .null,
                ])
            })
    }

    func takeOutcomes() -> [JSONValue] {
        defer { sink.items = [] }
        return sink.items
    }

    func call(_ name: String, _ a: [JSONValue]) -> JSONValue {
        func str(_ i: Int) -> String { a.count > i ? (a[i].stringValue ?? "") : "" }
        func base(_ i: Int) -> SyncBase {
            if a.count > i, let v = a[i].intValue { return .version(v) }
            return .any
        }
        func ticket(_ r: SyncTicketResult) -> JSONValue {
            switch r {
            case .ticket(let t): return .object(["ok": .bool(true), "mutationId": .int(t)])
            case .failed(let e): return .object(["ok": .bool(false), "error": .string(e)])
            }
        }
        switch name {
        case "putAt": return ticket(machine.putAt(str(0), str(1), a[2], baseVersion: base(3)))
        case "removeAt": return ticket(machine.removeAt(str(0), str(1), baseVersion: base(2)))
        default: return plain(name, a)
        }
    }

    private func plain(_ name: String, _ a: [JSONValue]) -> JSONValue {
        func str(_ i: Int) -> String { a.count > i ? (a[i].stringValue ?? "") : "" }
        let r: CallResult
        switch name {
        case "set": r = machine.set(str(0), a[1])
        case "clear": r = machine.clear(str(0))
        case "put": r = machine.put(str(0), str(1), a[2])
        case "add": r = machine.add(str(0), str(1), a[2])
        case "remove": r = machine.remove(str(0), str(1), a[2])
        case "flush": r = machine.flush()
        case "refresh": r = machine.refresh()
        default:
            XCTFail("unknown call \(name)")
            r = .failed("unknown")
        }
        return r.json
    }

    func advance(ms: Int) { machine.advance(ms) }
    func setNetwork(_ state: String) { machine.setNetwork(SyncNetwork(rawValue: state) ?? .online) }
    func receive(status: Int, body: JSONValue?, opened: SyncOpenedBody?) throws {
        try machine.receive(.answer(status: status, body: body), opened: opened)
    }
    func receiveTransportError() throws { try machine.receive(.transport) }
    func setRoot(has: Bool) { machine.setRoot(has) }
    func signIn(subject: String) throws { try machine.signIn(subject) }
    func signOut(discardUnsynced: Bool) { machine.signOut(discardUnsynced: discardUnsynced) }
    func relaunch(journalLost: Bool) throws -> SyncScenarioMachine {
        CloudSyncScenarioAdapter(
            machine: try CloudSyncMachine.relaunch(machine, opts, journalLost: journalLost), opts: opts, sink: sink)
    }
    func takeRequests() -> [JSONValue] { machine.takeRequests().map(\.json) }
    func takeEvents() -> [JSONValue] { machine.takeEvents().map(\.json) }
    func get(_ key: String) -> JSONValue? { machine.get(key).json }
    func settingState(_ key: String) -> JSONValue? { machine.settingState(key).json }
    func record(_ collection: String, _ id: String) -> JSONValue? { machine.record(collection, id)?.json ?? .null }
    func journal() -> JSONValue { machine.journal() }
    func status() -> JSONValue { machine.status().json }
    func encryptionSince() -> JSONValue { machine.encryptionSince.map { .int($0) } ?? .null }
}
