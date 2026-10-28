// SP-41, the Swift lane: the quickstart against a LIVE `pkey dev` (the Worker's own router, running
// in a Node process) through the SDK's own `URLSessionTransport`. No replayed transcript, no stub
// transport, no fixture documents: every document the client verifies was signed a moment ago by
// the server on the other end of a loopback socket.
//
// WHAT THE HARNESS PROVIDES (`.github/workflows/ci.yml`, the Swift job; or by hand, see
// packages/docs/src/content/docs/build/local.md). A FRESH server for this lane, nothing else on it:
//
//   pkey dev --builtin --auto-approve --port <p>
//   pkey sdk --lang swift --dev --url http://127.0.0.1:<p> --write --out <dir>/PolarisConfig.swift
//
//   PKEY_DEV_BASE_URL   the server's loopback origin
//   PKEY_DEV_CONFIG     the absolute path of that PolarisConfig.swift
//   PKEY_DEV_APPROVE    the absolute path of packages/cli/scripts/dev-approve.mjs, run as
//                       `node $PKEY_DEV_APPROVE <verification url> <user code>`: the person who
//                       opens the verification page and presses Approve (exit 0 = approved)
//
// SKIPPED only when none of the three variables is set (a plain `swift test`: the jobs that run the
// whole suite without a server). Once any is set the harness is on, and a missing or unusable piece
// (a variable absent or blank, an unreadable config, a server that is not pkey dev, an approver that
// fails) FAILS: a lane that cannot reach its server must not look green.
//
// WHAT IS THE SDK'S AND WHAT IS THE HARNESS'S. Every checkpoint below is reached through the SDK:
// `PolarisKeyClient.activate`, `client.events` and `sync()`, `client.identity.signIn.start` /
// `pollDeviceCode` / `waitDeviceCode`, `client.update.decide`. Only the things a person or an operator
// does are the harness's, over plain HTTP: reading the seeded keys at `/__dev/info`, the control
// commands (`/__dev/config`, `/__dev/release`, the same ones `pkey dev config` and `pkey dev
// release` send), and the approval click.
//
// THE GENERATED CONFIG IS CONSUMED, NOT COPIED. `PolarisConfig.swift` is Swift source the CLI wrote
// for this very server; it cannot be compiled into a package that is already built, so the test
// parses the file (the exact shape of `renderSwift`, packages/cli/src/sdkConfig.ts) and asserts its
// origin, pins, release pins and services equal the server's. Every client is built from the parsed
// `productSlug`, `baseUrl`, `pinnedKeys` and `expectedServices` (what `PolarisConfig.clientOptions`
// passes to `PolarisKeyClientOptions`) over the platform's own transport, and the update client from
// the parsed `pinnedReleaseKeys`, as the file's own comment directs. The credential store and the
// directories are the test's (a Keychain item or a file under the user's Application Support would
// outlive the run). A wrong pin fails every document check.
//
// SEATS. Each licence of the seeded product allows three devices and `fill-seats` is not used, so
// the devices are fixed, one per role, derived with the SDK's own device-id formula. Activating a
// device that already holds a seat costs nothing, and nothing here deactivates: the lane can be
// run again against the same server. The two control commands are written to be repeatable too (the
// config value moves to one the SDK does not hold; the release is the next minor after the newest
// stable one). The tests share that one server and those devices, so they run one after another,
// as `swift test` runs them (not under `--parallel`).
//
// Only the outcomes reachable from the seven seeded keys are exercised: `ok` and `floating` activate;
// `expired`, `disabled` and `revoked` are `unauthorized`; `device-limit-full` is `device_limit`;
// `key-entry-limit` is `key_entry_limit`. Codes and shapes are asserted, never counters that move
// with the server's history, and never the server's own URLs.

import CryptoKit
import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyLicense
import PolarisKeyUpdate
import XCTest

@testable import PolarisKeyIdentity

final class PkeyDevLiveTests: XCTestCase {
    // ── B0: the generated config is the server's ─────────────────────────────────────────

    /// The file `pkey sdk --lang swift --dev --write` produced names this server: its origin, its
    /// product, its signing pins, its release pins and its services, as the server reports them at
    /// `/__dev/info` and as the SDK itself reads them through discovery over its own transport.
    func testB0TheGeneratedConfigNamesTheRunningServer() async throws {
        let env = try await DevLiveEnvironment.load()
        let config = env.config

        XCTAssertEqual(config.baseUrl, env.baseUrl, "PolarisConfig.baseUrl is the origin under test")
        XCTAssertEqual(config.productSlug, env.info.product)
        XCTAssertEqual(config.pinnedKeys, env.info.trust.pinnedKeys, "the signing pins")
        XCTAssertFalse(config.pinnedKeys.isEmpty)
        XCTAssertEqual(config.pinnedReleaseKeys, env.info.releaseKeys, "the release pins")
        XCTAssertFalse(config.pinnedReleaseKeys.isEmpty)
        XCTAssertEqual(config.expectedServices.map(\.rawValue), env.info.services)
        XCTAssertEqual(
            Set(env.info.keys.keys), Set(DevLiveEnvironment.seededKeys),
            "the seven seeded test keys, and no others")
        // Pins are raw Ed25519 keys, base64url: the only form the SDK takes.
        for key in Array(config.pinnedKeys.values) + Array(config.pinnedReleaseKeys.values) {
            XCTAssertEqual(Base64URL.decode(key)?.count, 32, "a raw 32-byte Ed25519 key")
        }

        // The quickstart's first lines, on the parsed values: a client over the real transport is
        // built (a non-https origin must be loopback or the SDK refuses it) and asks the origin who
        // it is. Discovery is the first request any client makes to this server.
        let client = try await makeClient(env, device: "app")
        XCTAssertEqual(client.core.endpoints.baseUrl, env.baseUrl)
        XCTAssertEqual(client.product, env.info.product)
        let needsActivation = await client.status()
        XCTAssertEqual(needsActivation.status, .needsActivation, "a fresh install holds no licence")

        let found = await client.discover()
        guard case .ok(let document) = found else {
            return XCTFail("discovery over the SDK's own transport: \(found)")
        }
        XCTAssertEqual(document.product, config.productSlug)
        XCTAssertEqual(document.trust?.pinnedKeys, config.pinnedKeys, "discovery publishes the pins the config carries")
        XCTAssertEqual(
            Set(document.servicesMap.filter(\.value).keys.map(\.rawValue)),
            Set(config.expectedServices.map(\.rawValue)),
            "the services the config expects are the ones the server runs")
        // The generated file's own claim: its release keys match `release.releaseKeyFingerprints`
        // (the SHA-256 of each raw key, in hex).
        let published = Set(
            document.services[.release]?.extras["releaseKeyFingerprints"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        let pinned = Set(
            config.pinnedReleaseKeys.values.compactMap { Base64URL.decode($0) }
                .map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() })
        XCTAssertFalse(pinned.isEmpty)
        XCTAssertEqual(pinned, published, "the release pins are the server's release key fingerprints")
    }

    // ── B1: first activation ─────────────────────────────────────────────────────────────

    /// `ok` and `floating` are the two keys that activate. Each is a first activation on a fresh
    /// install: the gate moves from `needs-activation` to `ok`, the `license` event says so, and the
    /// signed licence the client now holds is the key's own.
    func testB1FirstActivationWithTheOkAndFloatingKeysOpensTheGate() async throws {
        let env = try await DevLiveEnvironment.load()
        var licenseIds: [String] = []

        for name in ["ok", "floating"] {
            let client = try await makeClient(env, device: name == "ok" ? "app" : "floating")
            let before = await client.status()
            XCTAssertEqual(before.status, .needsActivation, "\(name): a fresh install is not activated")
            let licensedBefore = await client.isLicensed()
            XCTAssertFalse(licensedBefore, "\(name)")
            let recorder = DevLiveEvents(client.events)
            defer { recorder.stop() }

            let result = await client.license.activateWithKey(try env.key(name))
            guard case .ok(let token, let schemaVersion, _) = result else {
                return XCTFail("\(name): expected an activation, got \(result)")
            }
            XCTAssertTrue(token.hasPrefix("pkeyt_"), "\(name): a device token")
            XCTAssertGreaterThanOrEqual(schemaVersion, 1, name)
            XCTAssertTrue(result.isOK)
            XCTAssertEqual(result.kind, "ok")

            let after = await client.status()
            XCTAssertEqual(after.status, .ok, "\(name): the verified licence opens the gate")
            let licensed = await client.isLicensed()
            XCTAssertTrue(licensed, name)
            let activation = await client.license.activation()
            XCTAssertEqual(activation, .token, "\(name): activated by a device token")
            let held = await client.core.token
            // A boolean, so a failure never prints the bearer credential.
            XCTAssertTrue(held == token, "\(name): the token the result carries is the one the client holds")
            let info = await client.licenseInfo()
            let licence = try XCTUnwrap(info, "\(name): a verified licence document is cached")
            XCTAssertFalse(licence.licenseId.isEmpty, name)
            licenseIds.append(licence.licenseId)
            XCTAssertNotNil(licence.profile, "\(name): the signed greeting block")
            XCTAssertNotNil(licence.tier, "\(name): the licence's tier")
            XCTAssertGreaterThan(licence.deviceLimit ?? 0, 0, "\(name): the licence's seat limit")

            // `ok` is the key with `exportPro` entitled (docs: Run Polaris Key locally, Test keys).
            if name == "ok" {
                let pro = await client.entitlements.has("exportPro")
                XCTAssertTrue(pro, "ok: exportPro is entitled")
            }

            let opened = await recorder.first(within: 5) {
                $0 == .license(status: .ok, previous: .needsActivation)
            }
            XCTAssertNotNil(opened, "\(name): activation raises the `license` event; saw \(recorder.all)")
        }
        XCTAssertEqual(Set(licenseIds).count, 2, "two keys, two licences")
    }

    // ── B2: every refusal the seeded keys reach ──────────────────────────────────────────

    /// The five keys that refuse, each from a fresh install: the kind and code the Worker answers
    /// with, no token held afterwards, and the gate still asking for activation.
    func testB2EverySeededRefusalIsAnsweredWithItsOwnCode() async throws {
        let env = try await DevLiveEnvironment.load()

        for name in ["expired", "disabled", "revoked", "device-limit-full", "key-entry-limit"] {
            let client = try await makeClient(env, device: "refusals")
            let recorder = DevLiveEvents(client.events)
            defer { recorder.stop() }
            let result = await client.license.activateWithKey(try env.key(name))

            switch name {
            case "expired", "disabled", "revoked":
                // The Worker does not say which: a key it will not honour is one `unauthorized`.
                guard case .unauthorized = result else {
                    XCTFail("\(name): expected unauthorized, got \(result)")
                    continue
                }
                XCTAssertEqual(result.code, ErrorCode.unauthorized, name)
                XCTAssertEqual(result.kind, "unauthorized", name)
            case "device-limit-full":
                guard case .deviceLimit(let limit, let deviceCount, let manageURL) = result else {
                    XCTFail("\(name): expected device_limit, got \(result)")
                    continue
                }
                XCTAssertEqual(result.code, ErrorCode.deviceLimit, name)
                XCTAssertEqual(result.kind, "device-limit", name)
                // The shape: a limit and a count the count has reached, and a link a person may be
                // sent to. Not the numbers' history, not the link's host.
                let reached = try XCTUnwrap(limit, "\(name): the limit")
                let held = try XCTUnwrap(deviceCount, "\(name): the device count")
                XCTAssertGreaterThan(reached, 0, name)
                XCTAssertGreaterThanOrEqual(held, reached, name)
                XCTAssertTrue(ManageLink.isValid(manageURL), "\(name): a manage link the client may show")
            default:
                guard case .keyEntryLimit = result else {
                    XCTFail("\(name): expected key_entry_limit, got \(result)")
                    continue
                }
                XCTAssertEqual(result.code, ErrorCode.keyEntryLimit, name)
                XCTAssertEqual(result.kind, "key-entry-limit", name)
            }
            XCTAssertFalse(result.isOK, name)
            XCTAssertFalse(result.message?.isEmpty ?? true, "\(name): a sentence to show the person")

            let held = await client.core.token
            XCTAssertNil(held, "\(name): a refusal leaves no credential behind")
            let state = await client.status()
            XCTAssertEqual(state.status, .needsActivation, "\(name): the gate is still closed")
            let licensed = await client.isLicensed()
            XCTAssertFalse(licensed, name)
            // Nothing moved, so nothing was announced.
            try await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(recorder.all, [], "\(name): a refusal raises no change event")
        }
    }

    // ── B3: a config change event after a control command ────────────────────────────────

    /// The operator sets `render.quality` over `/__dev/config`; the app's next `sync()` brings the
    /// new signed document and the one change is announced to `client.events` and to the key's
    /// `onConfigChange` listener, with the value, the previous value and where it comes from.
    func testB3AConfigChangeReachesTheEventStreamOnTheNextSync() async throws {
        let env = try await DevLiveEnvironment.load()
        let client = try await makeClient(env, device: "app")
        let activated = await client.license.activateWithKey(try env.key("ok"))
        guard case .ok = activated else { return XCTFail("ok did not activate: \(activated)") }

        // The baseline: what this run's client holds before the operator acts. (A server that
        // already saw this lane run holds the last run's value.)
        let setting = "render.quality"
        await client.sync(force: true)
        let beforeState = await client.config.settingState(setting)
        let value = try XCTUnwrap(
            ["draft", "standard", "high"].first { JSONValue.string($0) != beforeState.value },
            "a value to change to")

        let recorder = DevLiveEvents(client.events)
        let heard = LockedValue<[ConfigChange]>([])
        let subscription = client.config.onConfigChange(setting) { change in
            heard.with { $0.append(change) }
        }
        defer {
            subscription.cancel()
            recorder.stop()
        }

        // Signed documents carry whole-second times: a change made in the second of the last sync
        // shows on the sync after it (docs: Run Polaris Key locally, "Change things while it runs").
        try await Task.sleep(nanoseconds: 1_100_000_000)
        let said = try await DevLiveControl(baseUrl: env.baseUrl).post(
            "config", ["name": setting, "value": value])
        XCTAssertTrue(said.contains(setting), "the control command names what it changed: \(said)")

        let result = await client.sync()
        XCTAssertTrue(result.applied, "the sync brought a new signed document: \(result)")
        XCTAssertEqual(result.documents[.config], .applied)

        let expected = PolarisKeyEvent.config(
            key: setting, value: .string(value), previous: beforeState.value, source: .enforced)
        let event = await recorder.first(within: 5) { $0 == expected }
        XCTAssertNotNil(event, "the config event; saw \(recorder.all)")
        XCTAssertEqual(
            recorder.all.filter { $0.kind == "config" }, [expected], "announced once, and only this setting")
        XCTAssertEqual(
            heard.current,
            [ConfigChange(key: setting, value: .string(value), previous: beforeState.value, source: .enforced)],
            "the listener hears the same change once")

        let afterState = await client.config.settingState(setting)
        XCTAssertEqual(afterState.value, .string(value))
        XCTAssertEqual(afterState.source, .enforced)
        XCTAssertTrue(afterState.locked, "the operator's value cannot be overridden locally")
        let read = await client.config.get(setting, default: .string("unset"))
        XCTAssertEqual(read, .string(value))

        // The same document again: nothing changed, nothing is announced.
        await client.sync(force: true)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(recorder.all.filter { $0.kind == "config" }.count, 1)
    }

    // ── B4: device-code sign-in ──────────────────────────────────────────────────────────

    /// `startDeviceCode` asks the Worker for a code; a person (the harness, `PKEY_DEV_APPROVE`) opens
    /// the verification page and approves; `pollDeviceCode` sees the flow still pending until then and
    /// `waitDeviceCode` settles it `ready`, with the fake IdP's person, a stored credential and an
    /// open gate.
    func testB4DeviceCodeSignInIsApprovedAndSettlesThroughTheSdk() async throws {
        let env = try await DevLiveEnvironment.load()
        let client = try await makeClient(env, device: "signin")
        let before = await client.status()
        XCTAssertEqual(before.status, .needsActivation)
        let recorder = DevLiveEvents(client.events)
        defer { recorder.stop() }

        let prompt = try await client.identity.startDeviceCode(deviceName: "SP-41 Swift live test")
        XCTAssertFalse(prompt.userCode.isEmpty)
        XCTAssertFalse(prompt.deviceCode.isEmpty)
        XCTAssertGreaterThan(prompt.interval, 0)
        XCTAssertGreaterThan(prompt.expiresIn, prompt.interval)
        XCTAssertEqual(prompt.deviceName, "SP-41 Swift live test", "the label the sign-in page shows")
        XCTAssertTrue(
            prompt.verificationUri.hasPrefix("\(env.baseUrl)/"),
            "the page is on the server under test: \(prompt.verificationUri)")
        XCTAssertTrue(prompt.verificationUriComplete.hasPrefix(prompt.verificationUri))
        XCTAssertEqual(
            DevLiveApprover.normalize(
                URLComponents(string: prompt.verificationUriComplete)?.queryItems?
                    .first { $0.name == "user_code" }?.value ?? ""),
            DevLiveApprover.normalize(prompt.userCode), "the complete URI carries the code")

        // One poll before the person has done anything: still pending, and the SDK's own pacing is
        // what the Worker enforces, so `wait` below is never told to slow down by this one.
        let early = try await client.identity.pollDeviceCode(prompt)
        XCTAssertEqual(early, .pending)
        let tokenBefore = await client.core.token
        XCTAssertNil(tokenBefore, "no credential until the person approves")

        // The person's side: open the verification URL, press Approve.
        try await DevLiveApprover.approve(
            script: env.approveScript, verificationUrl: prompt.verificationUriComplete,
            userCode: prompt.userCode)

        // The device's side: the paced wait. A hung flow would otherwise outlast the code (ten
        // minutes), so it is bounded and cancelled.
        let result = try await devLiveDeadline(90, "waitDeviceCode") {
            try await client.identity.waitDeviceCode(prompt)
        }
        guard case .ready(let ready) = result else {
            return XCTFail("expected a completed sign-in, got \(result)")
        }
        // The fake IdP vouches for its one person's e-mail (`email_verified`), so the Worker's poll
        // names both what the SDK hands back and what the signed profile holds.
        let person = env.info.idp.person
        XCTAssertEqual(ready.identity?.name, person.name)
        XCTAssertEqual(ready.identity?.email, person.email)
        XCTAssertNil(ready.attached, "nothing was attached: this device held no anonymous licence")

        let held = await client.core.token
        XCTAssertNotNil(held, "the poll stored the device token")
        let after = await client.status()
        XCTAssertEqual(after.status, .ok, "a signed-in device holds a licensed token")
        let current = await client.identity.current()
        XCTAssertEqual(current?.name, person.name, "the signed profile names the person")
        XCTAssertEqual(current?.email, person.email, "and holds the person's e-mail")
        let opened = await recorder.first(within: 5) {
            $0 == .license(status: .ok, previous: .needsActivation)
        }
        XCTAssertNotNil(opened, "sign-in raises the `license` event; saw \(recorder.all)")
    }

    // ── B5: an update decision before and after a release ────────────────────────────────

    /// The install is on the newest stable release, so the signed decision is `none`; the operator
    /// publishes the next release over `/__dev/release`; the next `decide()` is a `binary` offer
    /// for exactly that release, and `updateAvailable` is announced once. Feed and record verify
    /// against the pinned release key from the generated config.
    func testB5TheUpdateDecisionChangesWhenTheOperatorPublishesARelease() async throws {
        let env = try await DevLiveEnvironment.load()
        let installed = try env.newestStableRelease()
        let next = try DevLiveVersion.nextMinor(after: installed)

        let client = try await makeClient(env, device: "app", version: installed)
        let activated = await client.license.activateWithKey(try env.key("ok"))
        guard case .ok = activated else { return XCTFail("ok did not activate: \(activated)") }
        // The quickstart's note: `PolarisConfig.pinnedReleaseKeys` feeds `UpdateClientOptions`.
        let update = try client.configureUpdate(
            UpdateClientOptions(
                pinnedReleaseKeys: env.config.pinnedReleaseKeys, outlet: .kind("direct"), format: "zip",
                methods: [BinaryMethod.download], platform: Platform.macos))
        let recorder = DevLiveEvents(client.events)
        defer { recorder.stop() }

        let before = try await update.decide()
        XCTAssertEqual(before.channel, "stable")
        XCTAssertEqual(before.decision.action, UpdateAction.none, "installed \(installed) is the newest: \(before)")
        XCTAssertEqual(before.errors, [], "the feed and its record verified")
        XCTAssertEqual(before.feed, .network)

        let said = try await DevLiveControl(baseUrl: env.baseUrl).post("release", ["version": next])
        XCTAssertTrue(said.contains(next), "the control command names the release: \(said)")

        let after = try await update.decide()
        XCTAssertEqual(after.channel, "stable")
        XCTAssertEqual(after.errors, [], "the new feed and its record verified against the pinned key")
        guard case .binary(let method, let release, let build, let mandatory, let critical, _, _, _) = after.decision
        else { return XCTFail("expected a binary offer for \(next), got \(after.decision)") }
        XCTAssertEqual(release.version, next)
        XCTAssertEqual(method, BinaryMethod.download)
        XCTAssertFalse(build.isEmpty)
        XCTAssertFalse(mandatory)
        XCTAssertFalse(critical)
        XCTAssertEqual(after.record, .network, "the record the feed pins was fetched and verified")
        XCTAssertEqual(after.boot, .optional)

        let offered = PolarisKeyEvent.updateAvailable(
            version: next, action: UpdateAction.binary, mandatory: false, channel: "stable")
        let event = await recorder.first(within: 5) { $0 == offered }
        XCTAssertNotNil(event, "the offer is announced; saw \(recorder.all)")
        XCTAssertEqual(recorder.all.filter { $0.kind == "updateAvailable" }, [offered], "once")
    }

    // ── The client ───────────────────────────────────────────────────────────────────────

    /// `PolarisKeyClient.create` over the platform's `URLSessionTransport` (the default: no transport
    /// is passed), with what `PolarisConfig.clientOptions(version:)` passes, from the parsed file. The
    /// credential store and the directories are this test's own, and the device is the role's fixed one.
    private func makeClient(
        _ env: DevLiveEnvironment, device role: String, version: String = "1.0.0"
    ) async throws -> PolarisKeyClient {
        let config = env.config
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("pkey-dev-live-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let deviceId = DeviceID.fromRaw(productSlug: config.productSlug, raw: "sp41-swift-live:\(role)")

        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                core: CoreOptions(
                    productSlug: config.productSlug, baseUrl: config.baseUrl, version: version,
                    pinnedKeys: config.pinnedKeys,
                    store: InMemoryStore(productSlug: config.productSlug, deviceId: deviceId),
                    configDir: root.appendingPathComponent("config", isDirectory: true),
                    expectedServices: config.expectedServices,
                    dataDir: root.appendingPathComponent("data", isDirectory: true),
                    cacheDir: root.appendingPathComponent("cache", isDirectory: true),
                    stateDir: root.appendingPathComponent("state", isDirectory: true),
                    deviceName: "SP-41 Swift live test"),
                config: ConfigClientOptions(local: LocalConfigOptions(store: MemoryLocalConfigStore()))))
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// The harness
// ═════════════════════════════════════════════════════════════════════════════════════════

/// A fault in the harness (a variable, a file, the server, the approver), not an SDK assertion.
private struct DevLiveError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// `GET /__dev/info`: what a running pkey dev says about itself (`pkey dev keys --json`).
private struct DevLiveInfo: Decodable, Sendable {
    struct Trust: Decodable, Sendable { let pinnedKeys: [String: String] }
    struct Person: Decodable, Sendable {
        let name: String
        let email: String
    }
    struct Idp: Decodable, Sendable { let person: Person }
    struct Release: Decodable, Sendable {
        let version: String
        let channel: String
    }

    let baseUrl: String
    let product: String
    let services: [String]
    let trust: Trust
    let releaseKeys: [String: String]
    let keys: [String: String]
    let idp: Idp
    let releases: [Release]
}

/// What the harness handed over, read and checked once per test.
private struct DevLiveEnvironment: Sendable {
    static let seededKeys = [
        "ok", "expired", "disabled", "revoked", "device-limit-full", "key-entry-limit", "floating",
    ]
    private static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "::1"]

    /// `PKEY_DEV_BASE_URL`, without trailing slashes.
    let baseUrl: String
    let approveScript: String
    let info: DevLiveInfo
    let config: DevLiveGeneratedConfig

    func key(_ name: String) throws -> String {
        guard let key = info.keys[name], !key.isEmpty else {
            throw DevLiveError("pkey dev has no test key `\(name)` (it lists \(info.keys.keys.sorted()))")
        }
        return key
    }

    /// The newest stable release the server holds: the version an install is on when it is up to
    /// date.
    func newestStableRelease() throws -> String {
        let stable = info.releases.filter { $0.channel == "stable" }.map(\.version)
        guard let newest = try stable.max(by: { try DevLiveVersion.parse($0) < DevLiveVersion.parse($1) })
        else { throw DevLiveError("the server holds no stable release (it lists \(info.releases))") }
        return newest
    }

    static let variables = ["PKEY_DEV_BASE_URL", "PKEY_DEV_CONFIG", "PKEY_DEV_APPROVE"]

    static func load() async throws -> DevLiveEnvironment {
        let environment = ProcessInfo.processInfo.environment
        guard variables.contains(where: { environment[$0] != nil }) else {
            throw XCTSkip(
                "PKEY_DEV_BASE_URL, PKEY_DEV_CONFIG and PKEY_DEV_APPROVE are all unset: no pkey dev to test against. "
                    + "Start a fresh `pkey dev --builtin --auto-approve`, write its Swift config "
                    + "(`pkey sdk --lang swift --dev --url <origin> --write --out <file>`) and set the three "
                    + "(PKEY_DEV_APPROVE is packages/cli/scripts/dev-approve.mjs).")
        }
        func required(_ name: String) throws -> String {
            guard let value = environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty
            else {
                throw DevLiveError(
                    "\(name) is unset or blank while another of PKEY_DEV_BASE_URL, PKEY_DEV_CONFIG and "
                        + "PKEY_DEV_APPROVE is set: the harness must provide all three")
            }
            return value
        }
        let rawBase = try required("PKEY_DEV_BASE_URL")

        // The origin: loopback http with a port, and nothing else. The test must never reach a
        // production host, and the SDK itself refuses plain http anywhere but loopback.
        let trimmed = rawBase.trimmingCharacters(in: .whitespacesAndNewlines)
        let baseUrl = trimmed.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard let parts = URLComponents(string: baseUrl), parts.scheme == "http",
            let host = parts.host?.lowercased(), loopbackHosts.contains(host), parts.port != nil,
            parts.path.isEmpty, parts.query == nil, parts.fragment == nil, parts.user == nil
        else {
            throw DevLiveError(
                "PKEY_DEV_BASE_URL must be a loopback origin like http://127.0.0.1:8787 (pkey dev answers on loopback "
                    + "only, and the SDK sends no credential over plain http elsewhere); got `\(rawBase)`")
        }

        let approveScript = try required("PKEY_DEV_APPROVE")
        guard approveScript.hasPrefix("/"), FileManager.default.isReadableFile(atPath: approveScript) else {
            throw DevLiveError(
                "PKEY_DEV_APPROVE must be the absolute path of a readable script; got `\(approveScript)`")
        }
        let configPath = try required("PKEY_DEV_CONFIG")
        guard let text = try? String(contentsOfFile: configPath, encoding: .utf8) else {
            throw DevLiveError("PKEY_DEV_CONFIG is not a readable UTF-8 file: `\(configPath)`")
        }
        let config = try DevLiveGeneratedConfig.parse(text)

        let info = try await DevLiveHTTP.info(baseUrl: baseUrl)
        guard info.baseUrl.replacingOccurrences(of: "/+$", with: "", options: .regularExpression) == baseUrl else {
            throw DevLiveError(
                "the server at \(baseUrl) reports its origin as \(info.baseUrl): PKEY_DEV_BASE_URL must be the origin "
                    + "pkey dev prints (http://127.0.0.1:<port>, no trailing slash), and that server's")
        }
        return DevLiveEnvironment(baseUrl: baseUrl, approveScript: approveScript, info: info, config: config)
    }
}

/// The values of `PolarisConfig.swift` as `pkey sdk --lang swift --write` generates it
/// (`renderSwift` in packages/cli/src/sdkConfig.ts):
///
///     public enum PolarisConfig {
///         public static let productSlug = "tidewater"
///         public static let baseUrl = "http://127.0.0.1:8787"
///         public static let pinnedKeys: TrustSet = [
///             "tidewater-2026": "…",
///         ]
///         public static let pinnedReleaseKeys: TrustSet = [ … ]
///         public static let expectedServices: [ServiceSlug] = [.license, .config, …]
///         …
///
/// The renderer quotes with `JSON.stringify` and writes one map row per line, so each literal and
/// each row is decoded as JSON. A shape this does not know is an error that names the line, which
/// is how a change to the generator reaches this test.
private struct DevLiveGeneratedConfig: Equatable, Sendable {
    let productSlug: String
    let baseUrl: String
    let pinnedKeys: TrustSet
    let pinnedReleaseKeys: TrustSet
    let expectedServices: [ServiceSlug]

    static func parse(_ text: String) throws -> DevLiveGeneratedConfig {
        guard text.contains("GENERATED by `pkey sdk --lang swift") else {
            throw DevLiveError(
                "PKEY_DEV_CONFIG is not a file `pkey sdk --lang swift --write` generated (no GENERATED marker)")
        }
        let lines = text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        var productSlug: String?
        var baseUrl: String?
        var pinnedKeys: TrustSet?
        var pinnedReleaseKeys: TrustSet?
        var expectedServices: [ServiceSlug]?

        var index = 0
        while index < lines.count {
            let line = lines[index]
            index += 1
            if let literal = line.after("public static let productSlug = ") {
                productSlug = try string(literal, in: line)
            } else if let literal = line.after("public static let baseUrl = ") {
                baseUrl = try string(literal, in: line)
            } else if let opener = line.after("public static let pinnedKeys: TrustSet = ") {
                pinnedKeys = try map(opener, lines: lines, index: &index, in: line)
            } else if let opener = line.after("public static let pinnedReleaseKeys: TrustSet = ") {
                pinnedReleaseKeys = try map(opener, lines: lines, index: &index, in: line)
            } else if let list = line.after("public static let expectedServices: [ServiceSlug] = ") {
                guard list.hasPrefix("["), list.hasSuffix("]") else {
                    throw DevLiveError("PolarisConfig.expectedServices is not a one-line array: `\(line)`")
                }
                expectedServices = try list.dropFirst().dropLast()
                    .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                    .map { member in
                        guard member.hasPrefix("."), let slug = ServiceSlug(rawValue: String(member.dropFirst())) else {
                            throw DevLiveError("PolarisConfig.expectedServices names an unknown service `\(member)`")
                        }
                        return slug
                    }
            }
        }
        guard let productSlug, let baseUrl, let pinnedKeys, let pinnedReleaseKeys, let expectedServices else {
            throw DevLiveError(
                "PolarisConfig.swift is missing productSlug, baseUrl, pinnedKeys, pinnedReleaseKeys or expectedServices: "
                    + "the generator's output changed shape")
        }
        return DevLiveGeneratedConfig(
            productSlug: productSlug,
            baseUrl: baseUrl.replacingOccurrences(of: "/+$", with: "", options: .regularExpression),
            pinnedKeys: pinnedKeys, pinnedReleaseKeys: pinnedReleaseKeys, expectedServices: expectedServices)
    }

    private static func string(_ literal: String, in line: String) throws -> String {
        guard let value = try? JSONDecoder().decode(String.self, from: Data(literal.utf8)) else {
            throw DevLiveError("not a string literal in `\(line)`")
        }
        return value
    }

    /// `[:]`, or `[` followed by `"kid": "key",` rows up to a `]` line.
    private static func map(_ opener: String, lines: [String], index: inout Int, in line: String) throws -> TrustSet {
        if opener == "[:]" { return [:] }
        guard opener == "[" else { throw DevLiveError("a trust map in an unknown shape: `\(line)`") }
        var out: TrustSet = [:]
        while index < lines.count {
            let row = lines[index]
            index += 1
            if row == "]" { return out }
            let json = "{" + (row.hasSuffix(",") ? String(row.dropLast()) : row) + "}"
            guard let pair = try? JSONDecoder().decode([String: String].self, from: Data(json.utf8)), pair.count == 1
            else { throw DevLiveError("a trust map row in an unknown shape: `\(row)` under `\(line)`") }
            out.merge(pair) { _, new in new }
        }
        throw DevLiveError("the trust map opened by `\(line)` is never closed")
    }
}

extension String {
    fileprivate func after(_ prefix: String) -> String? {
        hasPrefix(prefix) ? String(dropFirst(prefix.count)) : nil
    }
}

/// `x.y.z` release versions, as the dev server's `release` command takes them.
private struct DevLiveVersion: Comparable {
    let major: Int
    let minor: Int
    let patch: Int

    static func parse(_ text: String) throws -> DevLiveVersion {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard parts.count == 3, let major = parts[0], let minor = parts[1], let patch = parts[2] else {
            throw DevLiveError("`\(text)` is not an x.y.z release version")
        }
        return DevLiveVersion(major: major, minor: minor, patch: patch)
    }

    /// The release after `version`: the next minor, so it is newer than every release published by
    /// an earlier run of this lane against the same server.
    static func nextMinor(after version: String) throws -> String {
        let v = try parse(version)
        return "\(v.major).\(v.minor + 1).0"
    }

    static func < (a: DevLiveVersion, b: DevLiveVersion) -> Bool {
        (a.major, a.minor, a.patch) < (b.major, b.minor, b.patch)
    }
}

/// The harness's plain HTTP: the reads and commands a person or an operator makes, never an SDK
/// call. The session is the platform's own and speaks the same `http://127.0.0.1` the SDK's does
/// (App Transport Security does not apply to IP-address and loopback hosts).
private enum DevLiveHTTP {
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    static func info(baseUrl: String) async throws -> DevLiveInfo {
        guard let url = URL(string: "\(baseUrl)/__dev/info") else { throw DevLiveError("bad origin `\(baseUrl)`") }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(from: url)
        } catch {
            throw DevLiveError("no pkey dev answered at \(baseUrl) (\(error.localizedDescription))")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let info = try? JSONDecoder().decode(DevLiveInfo.self, from: data) else {
            throw DevLiveError("\(baseUrl)/__dev/info answered \(status) and is not pkey dev's info document")
        }
        return info
    }
}

/// `POST /__dev/<command>`: what `pkey dev config|release …` sends (`X-PKey-Dev` is the header a web
/// page cannot add cross-origin).
private struct DevLiveControl: Sendable {
    let baseUrl: String

    /// The server's one-line answer.
    @discardableResult
    func post(_ command: String, _ body: [String: String]) async throws -> String {
        guard let url = URL(string: "\(baseUrl)/__dev/\(command)") else {
            throw DevLiveError("bad origin `\(baseUrl)`")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("1", forHTTPHeaderField: "x-pkey-dev")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await DevLiveHTTP.session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        struct Answer: Decodable {
            let ok: Bool?
            let message: String?
        }
        let answer = try? JSONDecoder().decode(Answer.self, from: data)
        guard status == 200, answer?.ok == true else {
            throw DevLiveError(
                "POST /__dev/\(command) answered \(status): \(answer?.message ?? String(decoding: data, as: UTF8.self))"
            )
        }
        return answer?.message ?? ""
    }
}

/// The person who opens the verification page and presses Approve: `node $PKEY_DEV_APPROVE <url> <code>`
/// (exit 0 = approved; a failure says why on stderr).
private enum DevLiveApprover {
    /// A user code as the Worker compares it: no dashes, upper case.
    static func normalize(_ code: String) -> String {
        code.uppercased().replacingOccurrences(of: "-", with: "")
    }

    static func approve(script: String, verificationUrl: String, userCode: String) async throws {
        #if os(macOS)
            let node = try DevLiveNodeRun(arguments: [script, verificationUrl, userCode])
            let status = try await devLiveDeadline(60, "dev-approve") { try await node.finish() }
            guard status == 0 else {
                throw DevLiveError("`node \(script)` exited \(status): \(node.output())")
            }
        #else
            throw DevLiveError(
                "the device-code approver runs `node` through Foundation.Process, which is macOS-only here")
        #endif
    }
}

#if os(macOS)
    /// One `node` child (found on PATH, as a shell would), its output kept in a scratch file so no pipe
    /// can fill and stall it. `Process` is not `Sendable` on every SDK this package builds with, so it
    /// lives behind this class, which is.
    private final class DevLiveNodeRun: @unchecked Sendable {
        private let process = Process()
        private let log: URL
        private let sink: FileHandle

        init(arguments: [String]) throws {
            log = FileManager.default.temporaryDirectory
                .appendingPathComponent("pkey-dev-approve-\(UUID().uuidString).log")
            FileManager.default.createFile(atPath: log.path, contents: nil)
            sink = try FileHandle(forWritingTo: log)
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node"] + arguments
            process.standardOutput = sink
            process.standardError = sink
        }

        deinit {
            try? sink.close()
            try? FileManager.default.removeItem(at: log)
        }

        /// Runs the child to its end and answers its exit status; cancelling the task kills it.
        func finish() async throws -> Int32 {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int32, Error>) in
                    if Task.isCancelled {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    process.terminationHandler = { finished in
                        continuation.resume(returning: finished.terminationStatus)
                    }
                    do {
                        try process.run()
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            } onCancel: {
                if process.isRunning { process.terminate() }
            }
        }

        /// Everything the child printed.
        func output() -> String {
            (try? String(contentsOf: log, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
    }
#endif

/// Every `client.events` event, recorded as it arrives, so a test can ask for one by predicate
/// with a deadline instead of blocking on a stream that may never produce it.
private final class DevLiveEvents: Sendable {
    private let seen: LockedValue<[PolarisKeyEvent]>
    private let task: Task<Void, Never>

    /// Subscribes at once: an event raised after this returns is recorded.
    init(_ stream: AsyncStream<PolarisKeyEvent>) {
        let seen = LockedValue<[PolarisKeyEvent]>([])
        self.seen = seen
        self.task = Task {
            for await event in stream { seen.with { $0.append(event) } }
        }
    }

    deinit { task.cancel() }

    var all: [PolarisKeyEvent] { seen.current }

    func stop() { task.cancel() }

    /// The first recorded event `matches`, waiting up to `seconds` for one.
    func first(within seconds: Double, _ matches: @Sendable (PolarisKeyEvent) -> Bool) async -> PolarisKeyEvent? {
        let deadline = Date().addingTimeInterval(seconds)
        while true {
            if let found = all.first(where: matches) { return found }
            if Date() >= deadline { return nil }
            try? await Task.sleep(nanoseconds: 25_000_000)
        }
    }
}

/// `body`, or a `DevLiveError` once `seconds` pass (the body is cancelled).
private func devLiveDeadline<T: Sendable>(
    _ seconds: Double, _ what: String, _ body: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await body() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw DevLiveError("\(what) did not finish within \(Int(seconds)) s")
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else { throw DevLiveError("\(what) produced nothing") }
        return first
    }
}
