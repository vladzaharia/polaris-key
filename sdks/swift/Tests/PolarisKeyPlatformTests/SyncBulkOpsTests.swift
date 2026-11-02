// @pkey-feature sync.transfer.background
//
// The Cloud Sync bulk-body ops (U-41.5b) over a stubbed session port: each bound and refusal of the request
// checks, the credential kept out of the spool, the tag and the events, a cancel that is final, the order of
// close, reconcile, and the app-delegate hook. The real `URLSession` is not run here.

import Foundation
import XCTest

@testable import PolarisKeyPlatform

// MARK: Stubs

private final class StubTask: BackgroundTaskRef, @unchecked Sendable {
    let taskIdentifier: Int
    let tag: String?
    let url: URL?
    let request: URLRequest
    let file: URL?
    let lock = NSLock()
    var resumed = false
    var cancelled = false
    init(id: Int, request: URLRequest, tag: String, file: URL?) {
        taskIdentifier = id
        self.tag = tag
        self.request = request
        self.file = file
        url = request.url
    }
    func resume() { lock.withLock { resumed = true } }
    func cancel() { lock.withLock { cancelled = true } }
    var isCancelled: Bool { lock.withLock { cancelled } }
}

private final class StubSession: BackgroundSessionPort, @unchecked Sendable {
    let lock = NSLock()
    private(set) var tasks: [StubTask] = []
    private var next = 1
    weak var sink: (any BackgroundSink)?
    func start(sink: any BackgroundSink) { self.sink = sink }
    private func make(_ r: URLRequest, _ tag: String, _ file: URL?) -> StubTask {
        lock.withLock {
            let t = StubTask(id: next, request: r, tag: tag, file: file)
            next += 1
            tasks.append(t)
            return t
        }
    }
    func makeUpload(_ r: URLRequest, from file: URL, tag: String, maxBody: Int) -> any BackgroundTaskRef {
        make(r, tag, file)
    }
    func makeDownload(_ r: URLRequest, tag: String, maxBody: Int) -> any BackgroundTaskRef { make(r, tag, nil) }
    func liveTasks() async -> [any BackgroundTaskRef] { lock.withLock { tasks.filter { !$0.isCancelled } } }
    func adopt(url: String, tag: String) -> StubTask {
        var r = URLRequest(url: URL(string: url)!)
        r.httpMethod = "PUT"
        return make(r, tag, nil)
    }
    func finish(
        _ t: StubTask, status: Int = 200, body: Data = Data(), headers: [String: String] = [:],
        error: (any Error)? = nil
    ) {
        sink?.taskFinished(
            BackgroundResult(
                taskIdentifier: t.taskIdentifier, tag: t.tag, url: t.url, status: status, headers: headers, body: body,
                error: error))
    }
}

// MARK: Harness

private let origin = "https://key.example.test"
private let secret = "tok-secret-0123456789"
private let fileId = String(repeating: "ab", count: 32)

private final class Harness {
    let session = StubSession()
    let sink = PlatformEventSink()
    let registry: SyncBulkRegistry
    var ops: [String: PlatformBinaryOp] = [:]
    let root: URL
    var spoolDir: URL { root.appendingPathComponent("cloud-sync-spool") }

    init(loopbackHttp: Bool = false) {
        let s = session
        registry = SyncBulkRegistry(portFactory: { _, _ in s })
        root = FileManager.default.temporaryDirectory.appendingPathComponent("sbops-\(UUID().uuidString)")
        SyncBulkOps(sink: sink, registry: registry, allowLoopbackHttp: loopbackHttp).register(into: &ops)
    }

    deinit { try? FileManager.default.removeItem(at: root) }

    func call(_ op: String, _ bytes: [UInt8]) -> [UInt8] {
        bytes.withUnsafeBufferPointer { ops[op]!($0) }
    }

    func json(_ op: String, _ o: [String: Any]) -> [UInt8] {
        call(op, [UInt8](try! JSONSerialization.data(withJSONObject: o)))
    }

    func open(origin o: String = origin, keep: [String] = [], dir: String? = nil, product: String = "djdl") -> [UInt8] {
        json("sb_open", ["product": product, "origin": o, "state_dir": dir ?? root.path, "keep": keep])
    }

    func stage(_ piece: [UInt8], name: String? = nil) -> [UInt8] {
        let n = Array((name ?? "").utf8)
        return call("sb_stage", [UInt8(n.count)] + n + piece)
    }

    func stagedName(_ piece: [UInt8] = [1, 2, 3]) -> String {
        let r = stage(piece)
        XCTAssertEqual(r.first, 1)
        return String(decoding: r.dropFirst(), as: UTF8.self)
    }

    func head(_ op: String, _ h: [String: Any]) -> [UInt8] {
        let d = [UInt8](try! JSONSerialization.data(withJSONObject: h))
        let n = d.count
        return call(op, [UInt8(n >> 24 & 255), UInt8(n >> 16 & 255), UInt8(n >> 8 & 255), UInt8(n & 255)] + d)
    }

    func putHeader(
        req: Int = 1, spool: String, url: String? = nil, extra: [String: Any] = [:], transfer: String = "saves:one"
    ) -> [String: Any] {
        var h: [String: Any] = [
            "req": req, "transfer": transfer, "bearer": secret, "spool": spool, "max_body": 65_537,
            "url": url ?? "\(origin)/djdl/sync/files/saves/one/upload/up1/parts/2", "part": 2,
            "headers": ["content-type": "application/octet-stream", "content-digest": "sha-256=:AAAA:"],
        ]
        for (k, v) in extra { h[k] = v }
        return h
    }

    func getHeader(req: Int = 2, url: String? = nil, extra: [String: Any] = [:]) -> [String: Any] {
        var h: [String: Any] = [
            "req": req, "transfer": "saves:one", "bearer": secret, "max_body": 1024,
            "url": url ?? "\(origin)/djdl/sync/files/saves/one?version=3",
            "headers": ["accept": "application/octet-stream", "range": "bytes=0-9"],
        ]
        for (k, v) in extra { h[k] = v }
        return h
    }

    func events() -> [(String, [UInt8])] { sink.drainBinary() }

    /// `sb_reconciled` arrives from a task; wait for it.
    func awaitReconciled() async -> [String: Any] {
        for _ in 0..<200 {
            for (k, d) in sink.drainBinary() where k == "sb_reconciled" {
                return (try? JSONSerialization.jsonObject(with: Data(d))) as? [String: Any] ?? [:]
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("no reconcile event")
        return [:]
    }
}

private func doneFrame(_ d: [UInt8]) -> (head: [String: Any], body: [UInt8]) {
    let n = Int(d[0]) << 24 | Int(d[1]) << 16 | Int(d[2]) << 8 | Int(d[3])
    let h = (try? JSONSerialization.jsonObject(with: Data(d[4..<(4 + n)]))) as? [String: Any] ?? [:]
    return (h, Array(d[(4 + n)...]))
}

private func tagOf(_ t: StubTask, _ at: Int = 0) -> BackgroundTag? { BackgroundTag.parse(t.tag) }

// MARK: Tests

final class SyncBulkOpsTests: XCTestCase {
    func testOpenCreatesTheSpoolPrivateAndOutOfBackup() async throws {
        let h = Harness()
        XCTAssertEqual(h.open(), [1])
        _ = await h.awaitReconciled()
        let attrs = try FileManager.default.attributesOfItem(atPath: h.spoolDir.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        let values = try h.spoolDir.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }

    func testOpenRefusesWhatIsNotAPinnableOrigin() {
        let h = Harness()
        for bad in [
            "http://key.example.test", "https://key.example.test/path", "https://u:p@key.example.test",
            "https://key.example.test?q=1", "ftp://key.example.test", "", "key.example.test",
        ] { XCTAssertEqual(h.open(origin: bad), [3], bad) }
        XCTAssertEqual(h.open(origin: "http://127.0.0.1:8787"), [3])
        XCTAssertEqual(h.open(dir: "relative/dir"), [3])
        XCTAssertEqual(h.open(dir: "/tmp/../etc"), [3])
        XCTAssertEqual(h.call("sb_open", [1, 2, 3]), [3])
    }

    func testLoopbackHttpOnlyUnderTheSelfTestSwitch() async {
        let h = Harness(loopbackHttp: true)
        XCTAssertEqual(h.open(origin: "http://127.0.0.1:8787"), [1])
        _ = await h.awaitReconciled()
        XCTAssertEqual(h.open(origin: "http://key.example.test"), [3])
    }

    func testNothingWorksBeforeOpen() {
        let h = Harness()
        XCTAssertEqual(h.stage([1]), [0])
        let name = String(repeating: "0a", count: 16) + ".bin"
        XCTAssertEqual(h.head("sb_put", h.putHeader(spool: name)), [0])
        XCTAssertEqual(h.head("sb_get", h.getHeader()), [0])
        XCTAssertTrue(h.session.tasks.isEmpty)
    }

    func testStagingBoundsAndNames() async throws {
        let h = Harness()
        _ = h.open()
        _ = await h.awaitReconciled()
        let first = h.stage([9, 9])
        XCTAssertEqual(first.first, 1)
        let name = String(decoding: first.dropFirst(), as: UTF8.self)
        XCTAssertTrue(BackgroundTag.isSpoolName(name))
        XCTAssertEqual(h.stage([7], name: name).first, 1)
        XCTAssertEqual(try Data(contentsOf: h.spoolDir.appendingPathComponent(name)), Data([9, 9, 7]))
        let attrs = try FileManager.default.attributesOfItem(atPath: h.spoolDir.appendingPathComponent(name).path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        // a piece over 8 MiB, a name we did not make, a bad name length
        XCTAssertEqual(h.stage([UInt8](repeating: 0, count: 8 * 1024 * 1024 + 1)), [3])
        XCTAssertEqual(h.stage([1], name: String(repeating: "0b", count: 16) + ".bin"), [0])
        XCTAssertEqual(h.call("sb_stage", [5, 1, 2, 3, 4, 5, 9]), [3])
        XCTAssertEqual(h.call("sb_stage", []), [3])
        // a file holds at most 16 MiB
        let big = h.stagedName([UInt8](repeating: 0, count: 8 * 1024 * 1024))
        XCTAssertEqual(h.stage([UInt8](repeating: 0, count: 8 * 1024 * 1024), name: big).first, 1)
        XCTAssertEqual(h.stage([1], name: big), [0])
    }

    func testAPutIsOneTaskWithTheCredentialOnlyInItsHeaders() async throws {
        let h = Harness()
        _ = h.open()
        _ = await h.awaitReconciled()
        let name = h.stagedName()
        XCTAssertEqual(h.head("sb_put", h.putHeader(spool: name)), [1])
        let t = try XCTUnwrap(h.session.tasks.first)
        XCTAssertTrue(t.resumed)
        XCTAssertEqual(t.request.httpMethod, "PUT")
        XCTAssertEqual(t.request.value(forHTTPHeaderField: "Authorization"), "Bearer \(secret)")
        XCTAssertEqual(t.request.value(forHTTPHeaderField: "Content-Type"), "application/octet-stream")
        XCTAssertEqual(t.file?.lastPathComponent, name)
        let tag = try XCTUnwrap(BackgroundTag.parse(t.tag))
        XCTAssertEqual(tag.kind, .up)
        XCTAssertEqual(tag.part, 2)
        XCTAssertEqual(tag.spool, name)
        XCTAssertEqual(tag.idHash, backgroundIdHash("saves:one"))
        XCTAssertFalse((t.tag ?? "").contains(secret))
        // the spool holds the body and nothing else
        for f in try FileManager.default.contentsOfDirectory(atPath: h.spoolDir.path) {
            let d = try Data(contentsOf: h.spoolDir.appendingPathComponent(f))
            XCTAssertNil(d.range(of: Data(secret.utf8)))
        }
        // an answer reaches GDScript with the allow-listed headers only, and never the credential
        h.session.finish(
            t, status: 204, body: Data([5]),
            headers: ["ETag": "\"x\"", "Set-Cookie": "a=b", "Retry-After": "3", "Authorization": secret])
        let ev = h.events()
        XCTAssertEqual(ev.map(\.0), ["sb_done"])
        let f = doneFrame(ev[0].1)
        XCTAssertEqual(f.head["req"] as? Int, 1)
        XCTAssertEqual(f.head["status"] as? Int, 204)
        XCTAssertEqual(f.head["headers"] as? [String: String], ["etag": "\"x\"", "retry-after": "3"])
        XCTAssertEqual(f.body, [5])
        XCTAssertNil(Data(ev[0].1).range(of: Data(secret.utf8)))
        // the spool file is released with the answer
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.spoolDir.appendingPathComponent(name).path))
    }

    func testEveryPutRefusalLeavesNoTask() async {
        let h = Harness()
        _ = h.open()
        _ = await h.awaitReconciled()
        let name = h.stagedName()
        let base = "\(origin)/djdl/sync/files/saves/one"
        let cases: [(String, [String: Any], UInt8)] = [
            ("other host", ["url": "https://evil.example.test/djdl/sync/files/saves/one/upload/u/parts/1"], 0),
            ("http", ["url": "http://key.example.test/djdl/sync/files/saves/one/upload/u/parts/1"], 0),
            ("other port", ["url": "https://key.example.test:8443/djdl/sync/files/saves/one/upload/u/parts/1"], 0),
            ("userinfo", ["url": "https://a:b@key.example.test/djdl/sync/files/saves/one/upload/u/parts/1"], 0),
            ("other product", ["url": "\(origin)/other/sync/files/saves/one/upload/u/parts/1"], 0),
            ("not files", ["url": "\(origin)/djdl/sync/saves/one/upload/u/parts/1"], 0),
            ("begin", ["url": "\(base)/begin"], 0),
            ("finalize", ["url": "\(base)/finalize"], 0),
            ("a file read as put", ["url": base], 0),
            ("query on put", ["url": "\(base)/upload/u?version=1"], 0),
            ("traversal", ["url": "\(origin)/djdl/sync/files/saves/../upload/u/parts/1"], 0),
            ("bad part", ["url": "\(base)/upload/u/parts/12345"], 0),
            ("chunk not hex", ["url": "\(base)/upload/u/chunks/zz"], 0),
            ("authorization header", ["headers": ["authorization": "Bearer x"]], 3),
            ("cookie header", ["headers": ["cookie": "a=b"]], 3),
            ("host header", ["headers": ["host": "evil.example.test"]], 3),
            ("content-length header", ["headers": ["content-length": "3"]], 3),
            ("line break in a value", ["headers": ["accept": "a\r\nx: y"]], 3),
            ("line break in the bearer", ["bearer": "a\r\nx: y"], 3),
            ("space in the bearer", ["bearer": "a b"], 3),
            ("empty bearer", ["bearer": ""], 3),
            ("max_body over 16 MiB", ["max_body": 16 * 1024 * 1024 + 1], 3),
            ("max_body zero", ["max_body": 0], 3),
            ("req zero", ["req": 0], 3),
            ("no transfer", ["transfer": ""], 3),
            ("spool not native-named", ["spool": "../../etc/passwd"], 3),
            ("spool never staged", ["spool": String(repeating: "0c", count: 16) + ".bin"], 0),
        ]
        for (label, extra, want) in cases {
            XCTAssertEqual(h.head("sb_put", h.putHeader(spool: name, extra: extra)), [want], label)
        }
        XCTAssertEqual(h.head("sb_put", h.putHeader(spool: name, extra: ["spool": NSNull()])), [3])
        XCTAssertTrue(h.session.tasks.isEmpty)
        // sixteen headers is the most
        var many: [String: String] = [:]
        for i in 0..<17 { many["x-pkey-n\(i)"] = "1" }
        XCTAssertEqual(h.head("sb_put", h.putHeader(spool: name, extra: ["headers": many])), [3])
        // a header over 16 KiB, and a length that does not match
        let long = [UInt8](repeating: 0x20, count: 17 * 1024)
        XCTAssertEqual(h.call("sb_put", [0, 0, 0x44, 0] + long.prefix(0x4400)), [3])
        XCTAssertEqual(h.call("sb_put", [0, 0, 0, 5, 1, 2]), [3])
        XCTAssertEqual(h.call("sb_put", [0, 0]), [3])
        // and the good one still goes
        XCTAssertEqual(h.head("sb_put", h.putHeader(spool: name)), [1])
        // the same request id twice is refused
        let second = h.stagedName()
        XCTAssertEqual(h.head("sb_put", h.putHeader(spool: second)), [0])
    }

    func testTheRouteTableIsTheSharedOne() async throws {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { dir.deleteLastPathComponent() }  // .../sdks
        let file = dir.appendingPathComponent("godot/tests/fixtures/bulk_routes.json")
        let fx = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        let product = fx["product"] as! String
        let allow = fx["allow"] as! [[String]]
        let refuse = fx["refuse"] as! [[String]]
        XCTAssertFalse(allow.isEmpty)
        XCTAssertFalse(refuse.isEmpty)
        let h = Harness()
        _ = h.open(product: product)
        _ = await h.awaitReconciled()
        var req = 1
        for row in allow + refuse {
            let isAllow = allow.contains(row)
            let (method, path) = (row[0], row[1])
            guard method == "PUT" || method == "GET" else { continue }  // no op carries another method
            req += 1
            let url = origin + path
            let got: [UInt8]
            if method == "PUT" {
                got = h.head("sb_put", h.putHeader(req: req, spool: h.stagedName(), url: url))
            } else {
                got = h.head("sb_get", h.getHeader(req: req, url: url))
            }
            if isAllow {
                XCTAssertEqual(got, [1], "allow \(method) \(path)")
            } else {
                XCTAssertNotEqual(got, [1], "refuse \(method) \(path)")
            }
        }
        XCTAssertEqual(h.session.tasks.count, allow.count)
    }

    func testTheRequestPastTheTaskBoundIsRefusedAndLeavesNoTask() async throws {
        let h = Harness()
        _ = h.open()
        _ = await h.awaitReconciled()
        for i in 1...300 {
            XCTAssertEqual(h.head("sb_get", h.getHeader(req: i)), [1], "task \(i)")
        }
        XCTAssertEqual(h.head("sb_get", h.getHeader(req: 301)), [0])
        XCTAssertEqual(h.session.tasks.count, 301)
        XCTAssertTrue(h.session.tasks.last!.isCancelled)
        let live = await h.session.liveTasks()
        XCTAssertEqual(live.count, 300)
    }

    func testAGetIsBoundedAndTakesOnlyAVersionQuery() async throws {
        let h = Harness()
        _ = h.open()
        _ = await h.awaitReconciled()
        XCTAssertEqual(h.head("sb_get", h.getHeader()), [1])
        let t = try XCTUnwrap(h.session.tasks.first)
        XCTAssertEqual(t.request.httpMethod, "GET")
        XCTAssertEqual(t.request.value(forHTTPHeaderField: "Range"), "bytes=0-9")
        XCTAssertEqual(BackgroundTag.parse(t.tag)?.kind, .dn)
        XCTAssertNil(BackgroundTag.parse(t.tag)?.spool)
        let chunk = "\(origin)/djdl/sync/files/saves/chunks/\(fileId)"
        XCTAssertEqual(h.head("sb_get", h.getHeader(req: 3, url: chunk)), [1])
        for (label, url) in [
            ("other query", "\(origin)/djdl/sync/files/saves/one?foo=1"),
            ("long version", "\(origin)/djdl/sync/files/saves/one?version=1234567890"),
            ("two queries", "\(origin)/djdl/sync/files/saves/one?version=1&x=2"),
            ("upload as get", "\(origin)/djdl/sync/files/saves/one/upload/u"),
            ("revisions", "\(origin)/djdl/sync/files/saves/one/revisions"),
            ("other host", "https://evil.example.test/djdl/sync/files/saves/one"),
            ("fragment", "\(origin)/djdl/sync/files/saves/one#x"),
        ] { XCTAssertEqual(h.head("sb_get", h.getHeader(req: 9, url: url)), [0], label) }
        XCTAssertEqual(h.head("sb_get", h.getHeader(req: 9, extra: ["spool": "x"])), [3])
        XCTAssertEqual(h.head("sb_get", h.getHeader(req: 9, extra: ["max_body": 16 * 1024 * 1024 + 1])), [3])
        XCTAssertEqual(h.session.tasks.count, 2)
        // an answer longer than max_body is a failure, not a truncated success
        h.session.finish(t, body: Data(repeating: 1, count: 1025))
        let ev = h.events()
        XCTAssertEqual(ev.map(\.0), ["sb_fail"])
        let o = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(ev[0].1)) as? [String: Any])
        XCTAssertEqual(o["code"] as? String, "oversize")
        XCTAssertEqual(o["req"] as? Int, 2)
    }

    func testTransportErrorsAreFailuresAndACancelledTaskIsSilent() async throws {
        let h = Harness()
        _ = h.open()
        _ = await h.awaitReconciled()
        XCTAssertEqual(h.head("sb_get", h.getHeader(req: 1)), [1])
        XCTAssertEqual(h.head("sb_get", h.getHeader(req: 2)), [1])
        h.session.finish(h.session.tasks[0], error: URLError(.notConnectedToInternet))
        h.session.finish(h.session.tasks[1], error: URLError(.cancelled))
        let ev = h.events()
        XCTAssertEqual(ev.map(\.0), ["sb_fail"])
        let text = String(decoding: ev[0].1, as: UTF8.self)
        XCTAssertTrue(text.contains("network"))
        XCTAssertFalse(text.contains("Internet"))
    }

    func testCancelIsFinal() async throws {
        let h = Harness()
        _ = h.open()
        _ = await h.awaitReconciled()
        let name = h.stagedName()
        XCTAssertEqual(h.head("sb_put", h.putHeader(spool: name)), [1])
        XCTAssertEqual(h.head("sb_get", h.getHeader(req: 2)), [1])
        XCTAssertEqual(h.json("sb_cancel", ["req": 2]), [1])
        XCTAssertTrue(h.session.tasks[1].isCancelled)
        h.session.finish(h.session.tasks[1], status: 200)
        XCTAssertTrue(h.events().isEmpty)
        // a cancel by transfer takes the put and its spool file with it
        XCTAssertEqual(h.json("sb_cancel", ["transfer": "saves:one"]), [1])
        XCTAssertTrue(h.session.tasks[0].isCancelled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.spoolDir.appendingPathComponent(name).path))
        h.session.finish(h.session.tasks[0], status: 200)
        XCTAssertTrue(h.events().isEmpty)
        // an unused staged file is dropped by name
        let spare = h.stagedName()
        XCTAssertEqual(h.json("sb_cancel", ["spool": spare]), [1])
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.spoolDir.appendingPathComponent(spare).path))
        XCTAssertEqual(h.json("sb_cancel", [:]), [3])
        XCTAssertEqual(h.call("sb_cancel", [0xFF]), [3])
    }

    func testCloseCancelsEverythingDeletesTheSpoolAndRefusesUntilOpen() async throws {
        let h = Harness()
        _ = h.open()
        _ = await h.awaitReconciled()
        let name = h.stagedName()
        XCTAssertEqual(h.head("sb_put", h.putHeader(spool: name)), [1])
        let unused = h.stagedName()
        XCTAssertEqual(h.call("sb_close", []), [1])
        XCTAssertTrue(h.session.tasks[0].isCancelled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.spoolDir.path))
        h.session.finish(h.session.tasks[0], status: 200)
        XCTAssertTrue(h.events().isEmpty, "a closed channel tells no one")
        XCTAssertEqual(h.stage([1], name: unused), [0])
        XCTAssertEqual(h.head("sb_get", h.getHeader(req: 7)), [0])
        // open again: new work is accepted
        _ = h.open()
        _ = await h.awaitReconciled()
        XCTAssertEqual(h.head("sb_get", h.getHeader(req: 8)), [1])
    }

    func testReconcileCancelsForeignStaleAndUnknownTasksAndSweepsOrphans() async throws {
        let h = Harness()
        let now = Int(Date().timeIntervalSince1970)
        let mine = backgroundIdHash("saves:mine")
        let kept = String(repeating: "0d", count: 16) + ".bin"
        let orphan = String(repeating: "0e", count: 16) + ".bin"
        try FileManager.default.createDirectory(at: h.spoolDir, withIntermediateDirectories: true)
        for n in [kept, orphan] { try Data([1]).write(to: h.spoolDir.appendingPathComponent(n)) }
        let u = "\(origin)/djdl/sync/files/saves/mine/upload/u/parts/1"
        let live = h.session.adopt(
            url: u, tag: BackgroundTag(idHash: mine, kind: .up, part: 1, enqueuedAt: now, spool: kept).text)
        let stale = h.session.adopt(
            url: u, tag: BackgroundTag(idHash: mine, kind: .up, part: 2, enqueuedAt: now - 1801, spool: nil).text)
        let foreign = h.session.adopt(
            url: u,
            tag: BackgroundTag(idHash: backgroundIdHash("saves:other"), kind: .up, part: 1, enqueuedAt: now, spool: nil)
                .text)
        let unknown = h.session.adopt(url: u, tag: "not-ours")
        XCTAssertEqual(h.open(keep: ["saves:mine"]), [1])
        let report = await h.awaitReconciled()
        XCTAssertFalse(live.isCancelled)
        XCTAssertTrue(stale.isCancelled)
        XCTAssertTrue(foreign.isCancelled)
        XCTAssertTrue(unknown.isCancelled)
        XCTAssertEqual(report["resume"] as? [String], ["saves:mine"])
        XCTAssertEqual(report["cancelled"] as? Int, 3)
        XCTAssertEqual(report["swept"] as? Int, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: h.spoolDir.appendingPathComponent(kept).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.spoolDir.appendingPathComponent(orphan).path))
        // a late answer to a task nobody holds only releases its spool file (no ledger, no event)
        h.session.finish(live, status: 200)
        XCTAssertTrue(h.events().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.spoolDir.appendingPathComponent(kept).path))
    }

    func testAKeepListOverTheBoundIsRefused() {
        let h = Harness()
        XCTAssertEqual(h.open(keep: (0...1024).map { "id\($0)" }), [3])
    }

    func testTheHookTakesOnlyOurSessionsAndHoldsTheCompletion() async throws {
        let h = Harness()
        XCTAssertFalse(h.registry.handleBackgroundEvents(identifier: "com.example.other", completion: {}))
        XCTAssertFalse(h.registry.handleBackgroundEvents(identifier: "pkey.sync.", completion: {}))
        XCTAssertFalse(h.registry.handleBackgroundEvents(identifier: "pkey.sync.bad/product", completion: {}))
        // the session is made natively; the completion waits for its events
        let first = PlatformLock<Bool>(false)
        XCTAssertTrue(
            h.registry.handleBackgroundEvents(
                identifier: "pkey.sync.djdl", completion: { first.withLock { $0 = true } }))
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(first.withLock { $0 }, "held until the session has delivered its events")
        h.session.sink?.sessionFinishedEvents()
        for _ in 0..<100 where !first.withLock({ $0 }) { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(first.withLock { $0 })
        // events that arrived first are not lost
        let ran2 = XCTestExpectation(description: "second")
        h.session.sink?.sessionFinishedEvents()
        XCTAssertTrue(h.registry.handleBackgroundEvents(identifier: "pkey.sync.djdl", completion: { ran2.fulfill() }))
        await fulfillment(of: [ran2], timeout: 5)
        // a later open uses the session the hook made
        XCTAssertEqual(h.open(), [1])
        _ = await h.awaitReconciled()
        XCTAssertEqual(h.head("sb_get", h.getHeader()), [1])
    }
}
