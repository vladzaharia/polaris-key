// The host app for the gate's UI tests (GateUITests) and for rendering the kit in the simulator.
// It hosts the real drop-in gate (`.polarisKey(client, theme:, options:)`) over a real client whose
// "server" is a scripted stub, so a launch argument picks the state the gate starts in:
//
//   -pkScenario licensed        a valid licence: the gate shows the app, never the activation card
//   -pkScenario needsActivation no licence
//   -pkScenario expired         a licence past its grace
//   -pkScenario revoked         the server refuses the device's token
//   -pkScenario deviceLimit     like needsActivation; the key `pkey_full` is refused with a manage link
//   -pkScenario signedIn        needsActivation; the sign-in poll answers ready with an identity
//
//   -pkPreset native|polaris    the branding (default polaris)
//   -pkAccent ff6a3d            an integrator accent (through the contrast resolver)
//   -pkRenewURL 1               give the gate a renewal page
//   -pkOffline 1                offer offline activation (off on iOS by default)
//
// The scripted keys: `pkey_good` activates; `pkey_full` is refused with `device_limit` and a
// manage link; any other key is refused as unknown. The stub, signer and fixtures are the test
// target's own (Tests/PolarisKeyTests/TestSupport.swift), compiled into this app, not copied.
import CryptoKit
import Foundation
import PolarisKey
import PolarisKeyUI
import SwiftUI

@main
struct GateHostApp: App {
    var body: some Scene {
        WindowGroup { ScenarioRoot() }
    }
}

enum Scenario: String {
    case licensed, needsActivation, expired, revoked, deviceLimit, signedIn

    static var current: Scenario {
        Scenario(rawValue: UserDefaults.standard.string(forKey: "pkScenario") ?? "") ?? .needsActivation
    }
}

/// Whether the scripted server has issued a credential yet.
final class ActivationFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

/// The scripted server and the client over it.
struct ScriptedWorld {
    let scenario: Scenario
    let signer = TestSigner(kid: "gate-host-key")
    let server = StubServer()
    let activated = ActivationFlag()

    init(scenario: Scenario) { self.scenario = scenario }

    private func now() -> Int { Int(Date().timeIntervalSince1970) }

    func makeClient() async throws -> PolarisKeyClient {
        let t = now()
        let day = 86_400
        let store = InMemoryStore(deviceId: "dev")
        switch scenario {
        case .licensed:
            await store.setToken("pkeyt_host")
            await store.writeCache(
                CacheRecord(docs: [.license: signer.sign(Fixtures.license(issuedAt: t))]))
        case .expired:
            await store.setToken("pkeyt_host")
            await store.writeCache(
                CacheRecord(docs: [
                    .license: signer.sign(
                        Fixtures.license(
                            issuedAt: t - 100 * day, expiresAt: t - 90 * day,
                            graceUntil: t - 60 * day))
                ]))
        case .revoked:
            await store.setToken("pkeyt_host")
            await store.writeCache(
                CacheRecord(docs: [.license: signer.sign(Fixtures.license(issuedAt: t))]))
        case .needsActivation, .deviceLimit, .signedIn:
            break
        }
        await script()
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store,
                transport: server.transport, expectedServices: [.license, .identity],
                fingerprint: false))
    }

    private func script() async {
        let signer = self.signer
        let scenario = self.scenario
        let activated = self.activated
        await server.route("/djdl/license/activate") { request in
            let body = (try? JSONDecoder().decode(JSONValue.self, from: request.body ?? Data()))?
                .objectValue
            let key = request.headers["authorization"] ?? body?["key"]?.stringValue ?? ""
            if key.contains("pkey_good") {
                activated.set()
                return StubServer.Reply(body: #"{"token":"pkeyt_new","schemaVersion":1}"#)
            }
            if key.contains("pkey_full") {
                return StubServer.Reply(
                    status: 403,
                    body: #"{"error":"device_limit","limit":1,"deviceCount":1,"manageUrl":"https://key.plrs.im/activate?product=djdl&next=free-device"}"#)
            }
            return StubServer.Reply(status: 401, body: #"{"error":"unauthorized"}"#)
        }
        await server.route("/djdl/license/document") { _ in
            if activated.isSet {
                let fresh = signer.sign(
                    Fixtures.license(issuedAt: Int(Date().timeIntervalSince1970)))
                return StubServer.Reply(status: 200, body: fresh, headers: ["ETag": "fresh"])
            }
            switch scenario {
            case .revoked: return StubServer.Reply(status: 401, body: #"{"error":"unauthorized"}"#)
            case .expired: return StubServer.Reply(status: 503, body: "{}")
            default: return StubServer.Reply(status: 404, body: "{}")
            }
        }
        await server.reply(
            "/djdl/identity/auth/device/start",
            body: #"{"deviceCode":"dc","userCode":"ABCD-EFGH","verificationUri":"https://key.example/d","verificationUriComplete":"https://key.example/d?user_code=ABCD-EFGH","expiresIn":600,"interval":1}"#)
        if scenario == .signedIn {
            await server.reply(
                "/djdl/identity/auth/device/poll",
                body: #"{"status":"ready","token":"pkeyt_signed","schemaVersion":1,"identity":{"name":"Ada Lovelace","email":"ada@example.com"}}"#)
            // The sign-in mints a credential; the next sync finds a fresh licence.
            await server.route("/djdl/license/document") { _ in
                activated.set()
                let fresh = signer.sign(
                    Fixtures.license(issuedAt: Int(Date().timeIntervalSince1970)))
                return StubServer.Reply(status: 200, body: fresh, headers: ["ETag": "fresh"])
            }
        } else {
            await server.reply(
                "/djdl/identity/auth/device/poll", body: #"{"status":"pending"}"#)
        }
    }
}

struct ScenarioRoot: View {
    @State private var client: PolarisKeyClient?
    @State private var failure: String?

    private var defaults: UserDefaults { .standard }

    private var theme: PolarisTheme {
        var accent: Color?
        if let hex = defaults.string(forKey: "pkAccent"), let value = UInt32(hex, radix: 16) {
            accent = Color(
                red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
                blue: Double(value & 0xFF) / 255)
        }
        let branding: PolarisBranding = defaults.string(forKey: "pkPreset") == "native" ? .native : .polarisKey
        return PolarisTheme(
            branding: branding, accent: accent, copy: PolarisCopy(productName: "Tidewater Studio"))
    }

    private var options: GateOptions {
        GateOptions(
            offersOfflineActivation: defaults.bool(forKey: "pkOffline")
                || GateOptions.defaultOffersOfflineActivation,
            returnURL: "tidewater://activated",
            renewURL: defaults.bool(forKey: "pkRenewURL") ? URL(string: "https://example.com/renew") : nil,
            blockedAction: { _ in AnyView(Link("Contact support", destination: URL(string: "https://example.com/help")!)) })
    }

    var body: some View {
        Group {
            if let client {
                Text("Licensed content")
                    .accessibilityIdentifier("licensed-content")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .polarisKey(client, theme: theme, options: options)
            } else if let failure {
                Text(failure)
            } else {
                Color.clear
            }
        }
        .task {
            do { client = try await ScriptedWorld(scenario: .current).makeClient() } catch {
                failure = "\(error)"
            }
        }
    }
}
