// @pkey-feature identity.nearby
//
// The nearby half of the Swift transcript replay (conformance/transcripts/nearby-*.json): the verbs
// `nearbyStart` and `nearbyPoll` run D's routes (`identity.nearbyStart`, `identity.nearbyPoll`) with the fixture
// keys of each step's `keyLabel`. `nearbyApprove` is the signed-in device M's call: a second client with its own
// device id, token and keys (`approverDeviceId`, `approverToken`, `approverKeyLabel`) runs `identity.nearbyApprove`
// for the vouch the recording names (D's ids and keys, or the step's other agree key), and what it observed is held
// to the step's `expect` like every other step.

import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey
@testable import PolarisKeyIdentity

enum NearbyReplay {
    static func run(
        _ client: PolarisKeyClient, step: Transcript.Step, session: ReplaySession, server: ReplayServer,
        into out: inout [String: JSONValue]
    ) async {
        let a = step.args
        if let label = a["keyLabel"]?.stringValue, session.keyLabel != label {
            session.keys.use(label: label)
            session.keyLabel = label
        }
        let transcript = await server.transcript
        if step.action == "nearbyApprove" {
            await approve(step: step, transcript: transcript, session: session, server: server, into: &out)
            return
        }
        client.identity.nearbyProofSigner.set(doctored(a, product: transcript.product, session: session))
        defer { client.identity.nearbyProofSigner.set(nil) }
        do {
            if step.action == "nearbyStart" {
                let started = try await client.identity.nearbyStart(deviceName: a["deviceName"]?.stringValue)
                out["result"] = .string("ok")
                out["expiresIn"] = .int(started.expiresIn)
                out["interval"] = .int(started.interval)
                return
            }
            let keys = try await session.keys.ensure()
            let started = NearbyStarted(
                request: a["request"]?.stringValue ?? "", expiresIn: 300, interval: 3, signKey: keys.signKey)
            switch try await client.identity.nearbyPoll(started) {
            case .slowDown(let interval):
                out["result"] = .string("slow-down")
                out["interval"] = .int(interval)
            case .denied:
                out["result"] = .string("error")
                out["reason"] = .string("access_denied")
            case .ready(let ready):
                out["result"] = .string("ready")
                out["scope"] = .string(ready.scope)
            case .pending: out["result"] = .string("pending")
            case .timeout: out["result"] = .string("timeout")
            case .unavailable: out["result"] = .string("unavailable")
            }
        } catch let e as PolarisError {
            if e.code == PolarisError.serviceUnavailable {
                out["result"] = .string("unavailable")
            } else if let status = e.status {
                out["result"] = .string("refused")
                out["status"] = .int(status)
                out["code"] = .string(e.code)
            } else {
                out["result"] = .string("error")
                out["code"] = .string(e.code)
            }
        } catch {
            out["result"] = .string("error")
        }
    }


    /// M's `nearby/approve` for one step, from a client of its own.
    private static func approve(
        step: Transcript.Step, transcript t: Transcript, session: ReplaySession, server: ReplayServer,
        into out: inout [String: JSONValue]
    ) async {
        let a = step.args
        do {
            let mKeys = FixtureKeyPort()
            mKeys.use(label: a["approverKeyLabel"]?.stringValue ?? "")
            let store = InMemoryStore(productSlug: t.product, deviceId: a["approverDeviceId"]?.stringValue ?? "")
            await store.setToken(a["approverToken"]?.stringValue ?? "")
            let now = step.now ?? t.now
            let m = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    core: CoreOptions(
                        productSlug: t.product, baseUrl: t.baseUrl, version: t.initial.version, pinnedKeys: t.trust,
                        store: store, transport: ApproverTransport(inner: ReplayTransport(server: server), t: t),
                        requestTimeoutSeconds: 0, expectedServices: [.license, .config, .identity],
                        clock: { now },
                        dataDir: FileManager.default.temporaryDirectory
                            .appendingPathComponent("pkey-replay-\(UUID().uuidString)", isDirectory: true),
                        deviceName: ""),
                    connect: ConnectOptions(keys: mKeys, store: .inMemory())))
            m.identity.redirectAcquisitionSync.set(false)
            m.identity.nearbyProofSigner.set(doctored(a, product: t.product, session: session))
            // The vouch is what the recording sent: D's ids and keys, or the step's other agreement key.
            let d = try await session.keys.ensure()
            var agreeKey = d.agreeKey
            if let other = a["agreeKeyLabel"]?.stringValue {
                let port = FixtureKeyPort()
                port.use(label: other)
                agreeKey = try await port.ensure().agreeKey
            }
            let vouch = VerifiedVouch(
                request: a["request"]?.stringValue ?? "", deviceId: t.initial.deviceId, signKey: d.signKey,
                agreeKey: agreeKey)
            let answer = try await m.identity.nearbyApprove(
                vouch, decision: a["decision"]?.stringValue ?? "", choice: a["choice"])
            switch answer {
            case .approved(let label, _):
                out["result"] = .string("approved")
                out["deviceLabel"] = label.map(JSONValue.string) ?? .null
            case .choose(let choices, _):
                out["result"] = .string("choose")
                out["choices"] = choices
            case .denied: out["result"] = .string("denied")
            case .unavailable: out["result"] = .string("unavailable")
            case .refused(let status, let code, _, _):
                out["result"] = .string("refused")
                out["status"] = .int(status)
                out["code"] = .string(code)
            }
            await m.close()
        } catch let e as PolarisError {
            if e.code == PolarisError.serviceUnavailable {
                out["result"] = .string("unavailable")
            } else if let status = e.status {
                out["result"] = .string("refused")
                out["status"] = .int(status)
                out["code"] = .string(e.code)
            } else {
                out["result"] = .string("error")
                out["code"] = .string(e.code)
            }
        } catch {
            out["result"] = .string("error")
        }
    }

    /// The proof signer of a step that doctors its proof: `proofKeyLabel` signs with another key, `proofValue`
    /// signs over another value. Nil for an ordinary step (the client signs through the key port).
    private static func doctored(
        _ a: [String: JSONValue], product: String, session: ReplaySession
    ) -> (@Sendable (any DeviceKeyPort, DeviceProofFields) async throws -> String)? {
        guard a["proofKeyLabel"] != nil || a["proofValue"] != nil else { return nil }
        let other = a["proofKeyLabel"]?.stringValue.map { label -> FixtureKeyPort in
            let p = FixtureKeyPort()
            p.use(label: label)
            return p
        }
        let value = a["proofValue"]?.stringValue
        return { port, fields in
            var f = fields
            if let value { f.value = value }
            guard let message = DeviceProofs.message(f) else { throw ReplayError("a proof field breaks the format") }
            let signer: any DeviceKeyPort = other ?? port
            return Base64URL.encode(try await signer.sign(message))
        }
    }
}

/// M's transport: the replay server's, but discovery is M's own. It first reads the document the transcript
/// recorded while the gate was on, and a fresh read (N11) the last one, so a gate that went off shows only to a
/// device that asks again. A transcript with no `discover` step rides the standard document that names nearby.
struct ApproverTransport: PolarisTransport {
    let inner: ReplayTransport
    let t: Transcript
    private let reads = LockedValue(0)

    init(inner: ReplayTransport, t: Transcript) {
        self.inner = inner
        self.t = t
    }

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        let path = "/\(t.product)/.well-known/polaris.json"
        guard request.url.path == path else { return try await inner.send(request) }
        let docs = t.steps.filter { $0.action == "discover" }.compactMap {
            $0.exchanges.items.first { $0.request.path == path }?.response.body
        }
        let n = reads.with { r -> Int in
            r += 1
            return r
        }
        let doc: JSONValue
        if docs.isEmpty {
            let identityBase = "\(t.baseUrl)/\(t.product)/identity"
            doc = .object([
                "product": .string(t.product),
                "services": .object([
                    "license": .object(["enabled": .bool(true)]),
                    "config": .object(["enabled": .bool(true)]),
                    "identity": .object([
                        "enabled": .bool(true), "configured": .bool(true), "nearby": .bool(true),
                        "endpoints": .object([
                            "nearbyStart": .string("\(identityBase)/nearby/start"),
                            "nearbyApprove": .string("\(identityBase)/nearby/approve"),
                            "nearbyPoll": .string("\(identityBase)/nearby/poll"),
                        ]),
                    ]),
                ]),
            ])
        } else {
            doc = n == 1 ? docs[0] : docs[docs.count - 1]
        }
        return PolarisResponse(
            status: 200, body: try JSONEncoder().encode(doc), headers: ["content-type": "application/json"])
    }
}

final class NearbyTranscriptTests: XCTestCase {
    /// The recorded nearby conversations, replayed through the Swift SDK: D's start and poll steps and M's approve
    /// steps are all held to the real routes.
    func testReplaysTheNearbyTranscriptsDeviceSteps() async throws {
        let all = try TranscriptFiles.load().filter { $0.features.contains("identity.nearby") }
        XCTAssertEqual(
            Set(all.map(\.id)),
            ["nearby-choose", "nearby-denied", "nearby-disabled", "nearby-errors", "nearby-gate-off", "nearby-happy"])
        var deviceSteps = 0
        var approveSteps = 0
        for t in all {
            do { try await SwiftReplay.replay(t) } catch { XCTFail("\(error)") }
            deviceSteps += t.steps.filter { ["nearbyStart", "nearbyPoll"].contains($0.action) }.count
            approveSteps += t.steps.filter { $0.action == "nearbyApprove" }.count
        }
        XCTAssertEqual(deviceSteps, 18, "D's start and poll steps were replayed, not skipped")
        XCTAssertEqual(approveSteps, 12, "M's approve steps were replayed against the real route")
    }
}
