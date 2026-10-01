// @pkey-feature core.discover core.sync core.cache license.activate license.enroll
// @pkey-feature license.deactivate devices.register devices.report
// @pkey-feature config.schema release.changelog release.download
//
// The Swift transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/ (read
// from the generator-owned mirror in Resources/transcripts/): drive `PolarisKeyClient` through every
// recorded conversation `sdks/swift/parity.json` makes applicable, against a fake server
// (`ReplayServer` behind a `PolarisTransport`) that serves the Worker's recorded answers and
// asserts every request.
//
// Which transcripts run is DATA: a transcript for a feature this SDK has not implemented is
// skipped — register-reregister-401 until P1b-06 — and starts running the moment the manifest
// claims it. The SDK clock is `CoreOptions.clock`, pinned to each step's `now`:
// the recorded documents were signed at a fixed instant and expire an hour later.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyLicense
import PolarisKeyRelease
import XCTest

/// A settable clock the client reads through `CoreOptions.clock`.
final class ReplayClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int
    init(_ value: Int) { self.value = value }
    var now: Int {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

/// A fixed hashed fingerprint for the keyless registration, so the replay does not depend on
/// what this host can read. (Activation and enrolment collect through the licence client's own
/// path, which is the public surface a host calls.)
private let registerFingerprint = HardwareFingerprint(
    components: ["machineUuid": "REPLAYmachineUuid00000"],
    hwid: "REPLAYhwid0000000000000000000000")

enum SwiftReplay {
    /// THE mapping from transcript verbs and `expect` keys onto the Swift SDK. Kept in one place.
    static func act(
        _ client: PolarisKeyClient, store: InMemoryStore, step: Transcript.Step
    ) async throws -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        switch step.action {
        case "discover":
            switch await client.discover() {
            case .ok: out["result"] = .string("ok")
            case .notFound: out["result"] = .string("not-found")
            case .invalid: out["result"] = .string("invalid")
            case .error: out["result"] = .string("error")
            }
        case "sync":
            let r = await client.sync(force: step.args["force"] == .bool(true))
            out["applied"] = .bool(r.applied)
            out["unauthorized"] = .bool(r.unauthorized)
            out["blocked"] = .bool(r.blocked)
            var docs: [String: JSONValue] = [:]
            for (slice, outcome) in r.documents {
                switch outcome {
                case .applied: docs[slice.rawValue] = .string("applied")
                case .unchanged: docs[slice.rawValue] = .string("unchanged")
                case .unauthorized: docs[slice.rawValue] = .string("unauthorized")
                case .blocked: docs[slice.rawValue] = .string("blocked")
                case .deviceCap: docs[slice.rawValue] = .string("device-cap")
                case .error: docs[slice.rawValue] = .string("error")
                case .skipped: break
                }
            }
            out["documents"] = .object(docs)
        case "activate":
            out["result"] = .string(
                activationKind(await client.activate(key: step.args["key"]?.stringValue ?? "")))
        case "enroll":
            out["result"] = .string(activationKind(await client.enroll()))
        case "register":
            switch await client.core.registerDevice(fingerprint: registerFingerprint) {
            case .ok: out["result"] = .string("ok")
            case .registrationClosed: out["result"] = .string("registration-closed")
            case .rateLimited: out["result"] = .string("rate-limited")
            case .notConfigured: out["result"] = .string("not-configured")
            case .error: out["result"] = .string("error")
            }
        case "deactivate":
            try await client.deactivate()
        case "report":
            out["result"] = .bool(await client.report())
        case "fetchSchema":
            if let data = await client.config.fetchSchema() {
                out["catalog"] = try JSONDecoder().decode(JSONValue.self, from: data)
            } else {
                out["catalog"] = .null
            }
        case "changelog":
            do {
                let entries = try await client.release.changelog()
                out["entries"] = .array(entries.map(entryValue))
                out["result"] = .string("ok")
            } catch let e as PolarisError {
                out["result"] = .string("error")
                out["code"] = .string(e.code)
            }
        case "installUrl":
            out["url"] = .string(try await client.release.installURL().absoluteString)
        case "downloadUrl":
            out["url"] = .string(
                try await client.release.downloadURL(
                    version: step.args["version"]?.stringValue ?? "",
                    binary: step.args["binary"]?.stringValue ?? "",
                    arch: step.args["arch"]?.stringValue ?? "",
                    checksum: step.args["checksum"] == .bool(true),
                    dmg: step.args["dmg"] == .bool(true)
                ).absoluteString)
        default:
            throw ReplayError("the Swift replayer has no mapping for \"\(step.action)\"")
        }
        var services: [String: JSONValue] = [:]
        for (slug, enabled) in await client.capabilities() { services[slug.rawValue] = .bool(enabled) }
        out["services"] = .object(services)
        out["licenseStatus"] = .string(await client.status().status.rawValue)
        out["tokenHeld"] = .bool(await store.getToken() != nil)
        return out
    }

    /// A changelog entry in the transcript's JSON vocabulary (nil ⇒ `null`).
    static func entryValue(_ e: ChangelogEntry) -> JSONValue {
        .object([
            "version": .string(e.version), "tag": .string(e.tag),
            "date": e.date.map(JSONValue.string) ?? .null,
            "summary": e.summary.map(JSONValue.string) ?? .null,
            "url": .string(e.url),
        ])
    }

    static func activationKind(_ r: ActivationResult) -> String {
        switch r {
        case .ok: return "ok"
        case .deviceLimit: return "device-limit"
        case .unauthorized: return "unauthorized"
        case .fingerprintRequired: return "fingerprint-required"
        case .hardwareMismatch: return "hardware-mismatch"
        case .enrollDisabled: return "enroll-disabled"
        case .error: return "error"
        }
    }

    /// Replay `t` step by step; throws on the first step whose traffic or outcome disagrees.
    static func replay(_ t: Transcript) async throws {
        let server = ReplayServer(t)
        let clock = ReplayClock(t.now)
        let store = InMemoryStore(productSlug: t.product, deviceId: t.initial.deviceId)
        if let token = t.initial.token { await store.setToken(token) }
        let core = CoreOptions(
            productSlug: t.product, baseUrl: t.baseUrl, version: t.initial.version,
            pinnedKeys: t.trust, store: store, transport: ReplayTransport(server: server),
            requestTimeoutSeconds: 0,
            expectedServices: t.initial.services?.compactMap(ServiceSlug.init(rawValue:)),
            clock: { clock.now })
        let client = try await PolarisKeyClient.create(options: PolarisKeyClientOptions(core: core))
        for i in t.steps.indices {
            let step = await server.beginStep(i)
            clock.now = step.now ?? t.now
            let observed = try await act(client, store: store, step: step)
            try await server.endStep()
            for (key, want) in step.expect.sorted(by: { $0.key < $1.key }) {
                guard let got = observed[key], got == want else {
                    throw ReplayError(
                        "\(t.id) step \(i) (\(step.action)): \(key): expected \(want), got \(String(describing: observed[key]))"
                    )
                }
            }
        }
        await client.close()
    }
}

final class TranscriptTests: XCTestCase {
    private func transcripts() throws -> [Transcript] { try TranscriptFiles.load() }

    func testTheTranscriptSetIsPresent() throws {
        XCTAssertFalse(try transcripts().isEmpty)
    }

    func testReplaysEveryApplicableTranscript() async throws {
        let statuses = try TranscriptFiles.manifestStatuses()
        var replayed: [String] = []
        for t in try transcripts() where TranscriptFiles.applies(t, statuses) {
            do {
                try await SwiftReplay.replay(t)
            } catch {
                XCTFail("\(error)")
            }
            replayed.append(t.id)
        }
        // Printed so a run shows which conversations Swift is held to today.
        print("transcripts replayed by Swift: \(replayed.joined(separator: ", "))")
        XCTAssertFalse(replayed.isEmpty)
    }

    // ── The replayer fails on a doctored transcript ────────────────────────────────────

    private func base() throws -> Transcript {
        try XCTUnwrap(try transcripts().first { $0.id == "sync-etag-304" })
    }

    private func assertReplayFails(_ t: Transcript, matching needle: String) async {
        do {
            try await SwiftReplay.replay(t)
            XCTFail("the doctored transcript replayed cleanly")
        } catch {
            XCTAssertTrue(
                "\(error)".contains(needle), "expected \"\(needle)\" in: \(error)")
        }
    }

    func testAnExtraRequestFails() async throws {
        var t = try base()
        t.steps[0].exchanges.items.removeAll { $0.request.path.hasSuffix("/devices/report") }
        await assertReplayFails(t, matching: "unexpected request: POST /djdl/devices/report")
    }

    func testAnOmittedRequestFails() async throws {
        var t = try base()
        t.steps[0].exchanges.items.append(t.steps[0].exchanges.items[0])
        await assertReplayFails(
            t, matching: "expected request not sent: GET /djdl/.well-known/polaris-trust.jws")
    }

    func testADroppedRequiredHeaderFails() async throws {
        var t = try base()
        for i in t.steps[0].exchanges.items.indices
        where t.steps[0].exchanges.items[i].request.path.hasSuffix("/license/document") {
            t.steps[0].exchanges.items[i].request.requiredHeaders.append("x-pkey-doctored")
        }
        await assertReplayFails(t, matching: "required header x-pkey-doctored: missing")
    }

    func testADifferentOutcomeFails() async throws {
        var t = try base()
        t.steps[1].expect["documents"] = .object([
            "license": .string("applied"), "config": .string("applied"),
        ])
        await assertReplayFails(t, matching: "step 1 (sync): documents")
    }
}
