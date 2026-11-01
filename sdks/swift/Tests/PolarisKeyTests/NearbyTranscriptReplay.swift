// @pkey-feature identity.nearby
//
// The nearby half of the Swift transcript replay (I-44.12; conformance/transcripts/nearby-*.json): the verbs
// `nearbyStart` and `nearbyPoll` run D's routes (`identity.nearbyStart`, `identity.nearbyPoll`) with the fixture
// keys of each step's `keyLabel`. `nearbyApprove` is the signed-in device M's call; the Swift approver's route
// is I-44.13's, so until then its recorded exchanges are served from the recording and its `expect` is taken as
// recorded (the D steps around it are held to the real thing).

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
        if step.action == "nearbyApprove" {
            await server.serveBrowserExchanges()
            for (key, value) in step.expect { out[key] = value }
            return
        }
        if let label = a["keyLabel"]?.stringValue, session.keyLabel != label {
            session.keys.use(label: label)
            session.keyLabel = label
        }
        let transcript = await server.transcript
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

final class NearbyTranscriptTests: XCTestCase {
    /// The recorded nearby conversations, replayed through the Swift SDK. `identity.nearby` is `planned` until
    /// the approver's half (I-44.13) lands, so the manifest-driven replay skips them; this one names them.
    func testReplaysTheNearbyTranscriptsDeviceSteps() async throws {
        let all = try TranscriptFiles.load().filter { $0.features.contains("identity.nearby") }
        XCTAssertEqual(
            Set(all.map(\.id)),
            ["nearby-choose", "nearby-denied", "nearby-disabled", "nearby-errors", "nearby-gate-off", "nearby-happy"])
        var deviceSteps = 0
        for t in all {
            do { try await SwiftReplay.replay(t) } catch { XCTFail("\(error)") }
            deviceSteps += t.steps.filter { ["nearbyStart", "nearbyPoll"].contains($0.action) }.count
        }
        XCTAssertEqual(deviceSteps, 18, "D's start and poll steps were replayed, not skipped")
    }
}
