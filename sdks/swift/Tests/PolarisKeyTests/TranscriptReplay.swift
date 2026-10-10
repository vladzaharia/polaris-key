// The Swift transcript replay engine (P1b-03, PARITY §4.2).
//
// A port of `conformance/runners/node/transcriptReplay.ts` — the same rules, so every SDK is held
// to one recording in one way. The format is documented once, in
// `packages/worker/test/transcripts/format.ts`; the files are read from the checkout's
// `conformance/transcripts/` through `CorpusLocator` (written by `pnpm gen transcripts`, never by
// hand).
//
// The server never throws out of the transport: an SDK is entitled to swallow a transport error
// (a best-effort report does exactly that), so a thrown mismatch could vanish. Every problem is
// RECORDED and answered with a 599, and `endStep()` fails with the full list.

import Foundation
import PolarisKeyCore
@testable import PolarisKeyPacks

// ── The format ─────────────────────────────────────────────────────────────────────────────

struct Transcript: Decodable, Sendable {
    struct Initial: Decodable, Sendable {
        var deviceId: String
        var token: String?
        var version: String
        var services: [String]?
        /// PX-W13: the platform's device name the SDK's default label comes from; absent = none.
        var deviceName: String?
        /// The device's canonical platform (SP-00: `downloadModel`'s `current`, `releaseFetch`).
        var platform: String?
        /// The update journal the client holds before the first step (SP-00, telemetry.updates):
        /// the queued events, oldest first, in the report's `updates` shape.
        var updateJournal: [JSONValue]?
        /// The update client's state before the first `updateDecide` step (P3-03).
        var update: InitialUpdate?
    }
    /// `initial.update` (plans/P3-01.md §6): the host's update configuration and starting cache.
    struct InitialUpdate: Decodable, Sendable {
        struct Installed: Decodable, Sendable {
            var version: String?
            var binaryVersion: String?
            var buildNumber: String?
            var format: String?
            var engine: String?
        }
        struct Cache: Decodable, Sendable {
            var feeds: [String: String]?
            var releaseRecords: [String: String]?
        }
        var pinnedReleaseKeys: [String: String]
        var outlet: JSONValue?
        var platform: String
        var arch: String
        var installed: Installed
        var methods: [String]?
        var cache: Cache?
    }
    struct RequestBody: Decodable, Sendable {
        var json: JSONValue
        var match: String
        var allowedKeys: [String]?
    }
    struct Request: Decodable, Sendable {
        var method: String
        var path: String
        var headers: [String: String]
        var requiredHeaders: [String]
        var body: RequestBody?
    }
    struct Response: Decodable, Sendable {
        var status: Int
        var headers: [String: String]
        var body: JSONValue
    }
    struct Exchange: Decodable, Sendable {
        var request: Request
        var response: Response
        var capture: [String: String]?
    }
    struct Exchanges: Decodable, Sendable {
        var ordered: Bool
        var items: [Exchange]
    }
    struct Step: Decodable, Sendable {
        var action: String
        var note: String?
        var args: [String: JSONValue]
        var now: Int?
        var exchanges: Exchanges
        var expect: [String: JSONValue]
    }

    var transcriptVersion: Int
    var id: String
    var description: String
    var features: [String]
    var requires: [String]
    var product: String
    var baseUrl: String
    var now: Int
    var trust: [String: String]
    var initial: Initial
    var steps: [Step]
}

enum TranscriptFiles {
    /// Every transcript in `conformance/transcripts/`, in file-name order.
    static func load() throws -> [Transcript] {
        let dir = CorpusLocator.transcriptsDir
        guard FileManager.default.fileExists(atPath: dir.path) else {
            throw ReplayError("\(dir.path) is missing: run `swift test` from a monorepo checkout")
        }
        let files = try FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil
        )
        .filter { $0.pathExtension == "json" }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
        return try files.map { try JSONDecoder().decode(Transcript.self, from: Data(contentsOf: $0)) }
    }

    /// This SDK's parity manifest, `sdks/swift/parity.json` — inside the package, so it is read
    /// from the source tree rather than mirrored.
    static func manifestStatuses(filePath: String = #filePath) throws -> [String: String] {
        let url = URL(fileURLWithPath: filePath)
            .deletingLastPathComponent()  // PolarisKeyTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // sdks/swift
            .appendingPathComponent("parity.json")
        struct Entry: Decodable { let status: String }
        struct Manifest: Decodable { let features: [String: Entry] }
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: url))
        return manifest.features.mapValues(\.status)
    }

    /// Every feature the transcript proves is `implemented` here, and nothing it presupposes is
    /// `na`. `pnpm parity:check` applies the same rule.
    static func applies(_ t: Transcript, _ statuses: [String: String]) -> Bool {
        t.features.allSatisfy { statuses[$0] == "implemented" }
            && t.requires.allSatisfy { statuses[$0] != "na" }
    }
}

struct ReplayError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

// ── Body matching ──────────────────────────────────────────────────────────────────────────

private func typeOf(_ v: JSONValue) -> String {
    switch v {
    case .null: return "null"
    case .bool: return "boolean"
    case .int, .double: return "number"
    case .string: return "string"
    case .array: return "array"
    case .object: return "object"
    }
}

private func jsonEqual(_ a: JSONValue, _ b: JSONValue) -> Bool {
    switch (a, b) {
    case (.int, _), (.double, _):
        guard let x = a.doubleValue, let y = b.doubleValue else { return false }
        return x == y
    case (.array(let x), .array(let y)):
        return x.count == y.count && zip(x, y).allSatisfy { jsonEqual($0, $1) }
    case (.object(let x), .object(let y)):
        return Set(x.keys) == Set(y.keys) && x.allSatisfy { k, v in jsonEqual(v, y[k]!) }
    default:
        return a == b
    }
}

private func render(_ v: JSONValue) -> String {
    (try? String(decoding: JSONEncoder().encode(v), as: UTF8.self)) ?? "?"
}

func bodyProblems(_ expected: JSONValue, _ actual: JSONValue, _ mode: String, _ path: String = "$")
    -> [String]
{
    if mode == "exact" {
        return jsonEqual(expected, actual)
            ? [] : ["\(path): expected \(render(expected)), got \(render(actual))"]
    }
    if case .object(let want) = expected {
        guard case .object(let got) = actual else {
            return ["\(path): expected an object, got \(typeOf(actual))"]
        }
        var out: [String] = []
        for (k, v) in want.sorted(by: { $0.key < $1.key }) {
            if let a = got[k] {
                out += bodyProblems(v, a, mode, "\(path).\(k)")
            } else {
                out.append("\(path).\(k): missing")
            }
        }
        return out
    }
    if mode == "shape" {
        return typeOf(expected) == typeOf(actual)
            ? [] : ["\(path): expected a \(typeOf(expected)), got \(typeOf(actual))"]
    }
    return jsonEqual(expected, actual)
        ? [] : ["\(path): expected \(render(expected)), got \(render(actual))"]
}

// ── The server ─────────────────────────────────────────────────────────────────────────────

actor ReplayServer {
    let transcript: Transcript
    private(set) var bindings: [String: String] = [:]
    private var failures: [String] = []
    private var step: Transcript.Step?
    private var stepIndex = -1
    private var served: [Bool] = []

    init(_ transcript: Transcript) {
        self.transcript = transcript
        bindings["deviceId"] = transcript.initial.deviceId
        bindings["version"] = transcript.initial.version
        if let token = transcript.initial.token { bindings["token"] = token }
    }

    func beginStep(_ index: Int) -> Transcript.Step {
        let step = transcript.steps[index]
        self.step = step
        stepIndex = index
        served = Array(repeating: false, count: step.exchanges.items.count)
        for (k, v) in step.args { if case .string(let s) = v { bindings[k] = s } }
        return step
    }

    /// Throw with every problem the step produced, including requests it never sent.
    func endStep() throws {
        if let step {
            for (i, item) in step.exchanges.items.enumerated() where !served[i] {
                failures.append(
                    "expected request not sent: \(item.request.method) \(item.request.path)")
            }
        }
        let action = step?.action ?? "?"
        step = nil
        guard failures.isEmpty else {
            let all = failures.joined(separator: "\n  ")
            failures = []
            throw ReplayError("\(transcript.id) step \(stepIndex) (\(action)):\n  \(all)")
        }
    }

    private func substitute(_ template: String) -> (value: String?, unbound: String?) {
        var out = ""
        var rest = Substring(template)
        while let open = rest.firstIndex(of: "{"),
            let close = rest[open...].firstIndex(of: "}")
        {
            out += rest[..<open]
            let name = String(rest[rest.index(after: open)..<close])
            guard let bound = bindings[name] else { return (nil, name) }
            out += bound
            rest = rest[rest.index(after: close)...]
        }
        out += rest
        return (out, nil)
    }

    func problems(_ item: Transcript.Exchange, headers: [String: String], body: Data?) -> [String] {
        var out: [String] = []
        let expected = item.request
        for (name, template) in expected.headers.sorted(by: { $0.key < $1.key }) {
            let (value, unbound) = substitute(template)
            let actual = headers[name.lowercased()]
            if let unbound {
                out.append(
                    "header \(name): sent before {\(unbound)} was bound (an earlier response it depends on)"
                )
            } else if actual == nil {
                out.append("header \(name): missing")
            } else if actual != value {
                out.append("header \(name): expected \"\(value ?? "")\", got \"\(actual ?? "")\"")
            }
        }
        for name in expected.requiredHeaders where headers[name.lowercased()] == nil {
            out.append("required header \(name): missing")
        }
        let hasBody = (body?.count ?? 0) > 0
        if let want = expected.body {
            guard hasBody, let body else {
                out.append("body: expected a JSON body, got none")
                return out
            }
            guard let parsed = try? JSONDecoder().decode(JSONValue.self, from: body) else {
                out.append("body: not JSON")
                return out
            }
            out += bodyProblems(want.json, parsed, want.match).map { "body \($0)" }
            if let allowed = want.allowedKeys, case .object(let members) = parsed {
                for key in members.keys.sorted() where !allowed.contains(key) {
                    out.append("body: key \"\(key)\" is not allowed")
                }
            }
        } else if hasBody {
            out.append("body: expected none, got \(String(decoding: body!.prefix(120), as: UTF8.self))")
        }
        return out
    }

    /// Match an arrived request; returns the exchange to serve, or nil (recorded as a failure).
    func handle(method: String, path: String, headers: [String: String], body: Data?)
        -> Transcript.Exchange?
    {
        let label = "\(method) \(path)"
        guard let step else {
            failures.append("unexpected request outside a step: \(label)")
            return nil
        }
        let items = step.exchanges.items
        var candidates = items.indices.filter {
            !served[$0] && items[$0].request.method == method && items[$0].request.path == path
        }
        if step.exchanges.ordered, let next = served.firstIndex(of: false) {
            candidates = candidates.filter { $0 == next }
        }
        guard let first = candidates.first else {
            failures.append("unexpected request: \(label)")
            return nil
        }
        for i in candidates where problems(items[i], headers: headers, body: body).isEmpty {
            served[i] = true
            capture(items[i])
            return items[i]
        }
        let why = problems(items[first], headers: headers, body: body).joined(separator: "\n    ")
        failures.append("request \(label) does not match the recording:\n    \(why)")
        return nil
    }

    private func capture(_ item: Transcript.Exchange) {
        for (name, path) in item.capture ?? [:] {
            var cur: JSONValue? = item.response.body
            for part in path.dropFirst(2).split(separator: ".") {
                cur = cur?.objectValue?[String(part)]
            }
            if let value = cur?.stringValue {
                bindings[name] = value
            } else {
                failures.append("capture \(name) (\(path)) found no string")
            }
        }
    }

    func recordFailure(_ message: String) { failures.append(message) }

    private var discoveryLoaded = false

    /// The Worker's standard discovery document, for a transcript that loads discovery nowhere
    /// itself (P3-03's update transcripts): served once, to a request for the discovery path
    /// that the current step does not record. Nil for every other request.
    func standardDiscovery(path: String) -> Data? {
        let discoveryPath = "/\(transcript.product)/.well-known/polaris.json"
        guard path == discoveryPath, !discoveryLoaded,
            !transcript.steps.contains(where: { $0.action == "discover" }),
            let step, !step.exchanges.items.contains(where: { $0.request.path == discoveryPath })
        else { return nil }
        discoveryLoaded = true
        let base = "\(transcript.baseUrl)/\(transcript.product)"
        let doc: JSONValue = .object([
            "product": .string(transcript.product),
            "services": .object([
                "release": .object([
                    "enabled": .bool(true),
                    "endpoints": .object(["record": .string("\(base)/release/records/{sha256}")]),
                ]),
                "distribution": .object([
                    "enabled": .bool(true),
                    "endpoints": .object([
                        "builds": .string("\(base)/distribution/builds/{selector}/{buildId}")
                    ]),
                ]),
                "update": .object([
                    "enabled": .bool(true),
                    "endpoints": .object(["feed": .string("\(base)/update/{channel}/feed.jws")]),
                ]),
            ]),
        ])
        return try? JSONEncoder().encode(doc)
    }
}

/// The `PolarisTransport` a replaying client is built with.
struct ReplayTransport: PolarisTransport {
    let server: ReplayServer

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        let origin = URL(string: server.transcript.baseUrl)!
        guard request.url.scheme == origin.scheme, request.url.host == origin.host,
            request.url.port == origin.port
        else {
            await server.recordFailure("request to a foreign origin: \(request.url)")
            return PolarisResponse(status: 599, body: Data("replay: foreign origin".utf8))
        }
        let components = URLComponents(url: request.url, resolvingAgainstBaseURL: false)
        var path = components?.percentEncodedPath ?? request.url.path
        if let query = components?.percentEncodedQuery { path += "?\(query)" }
        var headers: [String: String] = [:]
        for (k, v) in request.headers { headers[k.lowercased()] = v }
        if let discovery = await server.standardDiscovery(path: path) {
            return PolarisResponse(
                status: 200, body: discovery, headers: ["content-type": "application/json"])
        }
        guard
            let item = await server.handle(
                method: request.method.uppercased(), path: path, headers: headers,
                body: request.body)
        else {
            return PolarisResponse(status: 599, body: Data("replay: no matching exchange".utf8))
        }
        let body: Data
        if case .string(let text) = item.response.body {
            body = Data(text.utf8)
        } else {
            body = (try? JSONEncoder().encode(item.response.body)) ?? Data()
        }
        return PolarisResponse(
            status: item.response.status, body: body, headers: item.response.headers)
    }
}

/// The pack object transport a `chunkRange` step hands `PacksClient.fetchObject` (P4-32): the
/// same replay server behind the `PackObjectTransport` seam, as `ReplayTransport` is behind
/// `PolarisTransport`. It reports bounded ranges (as `URLSessionPackObjectTransport` does), and
/// the recorded `Content-Range` and `ETag`.
struct ReplayPackObjectTransport: PackObjectTransport {
    let server: ReplayServer

    var supportsRange: Bool { true }

    func get(_ url: URL, headers: [String: String], timeoutSeconds: Double) async throws -> ObjectResponse {
        let r = try await ReplayTransport(server: server).send(
            PolarisRequest(url: url, method: "GET", headers: headers, timeoutSeconds: timeoutSeconds))
        var lower: [String: String] = [:]
        for (k, v) in r.headers { lower[k.lowercased()] = v }
        let bytes = [UInt8](r.body)
        return ObjectResponse(
            status: r.status, contentRange: lower["content-range"], etag: lower["etag"],
            chunks: AsyncThrowingStream { c in
                if !bytes.isEmpty { c.yield(bytes) }
                c.finish()
            })
    }
}
