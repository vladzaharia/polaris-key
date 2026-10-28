// @pkey-feature core.discover core.sync sync.settings core.cache license.activate license.enroll
// @pkey-feature core.presentation
// @pkey-feature license.deactivate license.reregister devices.register devices.report
// @pkey-feature config.schema release.changelog release.download
// @pkey-feature identity.devicecode identity.devicelabel config.mint
// @pkey-feature update.feed release.record update.decide
// @pkey-feature packs.apply.chunk commerce.receipt
// @pkey-feature license.refusals ui.boot release.distribution telemetry.updates
// @pkey-feature license.manage
// @pkey-feature release.fetch identity.keyentry identity.account identity.attach identity.toggle
// @pkey-feature identity.redirect.web identity.signin.hints identity.choice connect.identity
// @pkey-feature connect.relay
// @pkey-feature identity.exchange sync.keyring sync.settings
//
// The Swift transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/ (read in
// place through `CorpusLocator`): drive `PolarisKeyClient` through every
// recorded conversation `sdks/swift/parity.json` makes applicable, against a fake server
// (`ReplayServer` behind a `PolarisTransport`) that serves the Worker's recorded answers and
// asserts every request.
//
// Which transcripts run is DATA: a transcript for a feature this SDK has not implemented is
// skipped — and starts running the moment the manifest claims it. The SDK clock is
// `CoreOptions.clock`, pinned to each step's `now`:
// the recorded documents were signed at a fixed instant and expire an hour later.
//
// `updateDecide` (plans/P3-01.md §5, §6) is `UpdateClient.decide(channel:staged:skipVersion:)`,
// and its `expect` keys are the `UpdateCheck`'s own (`channel`, `decision`, `feed`, `record`,
// `errors`). `initial.update` is the host's configuration — `pinnedReleaseKeys`, `outlet`,
// `platform`, `arch`, `installed` and `methods` become `UpdateClientOptions`, with
// `installed.version` as `CoreOptions.version` — and its `cache` seeds the store's record. A
// transcript with `initial.update` and no `initial.services` runs with Release, Distribution and
// Update expected; one that loads no discovery itself is served the Worker's standard document.
//
// `discover` also reports `presentation`: the member `client.presentation` exposes afterwards, or
// null (HA-13, `core.presentation`).
//
// The SP-00 verbs: `activate` / `enroll` also report a refusal's wire `code`
// (`ActivationResult.code`); `boot` is `client.boot()` to its `bootOutcome`; `downloadModel` is
// `client.distribution.downloadModel()` with `current` chosen by `initial.platform`; `report`
// also reports `updatesPending`, the journal's length afterwards, with `initial.updateJournal`
// seeded into the store's `update-events` record before the client starts.
//
// `chunkRange` (P4-32, plans/P4-32.md §5) is `chunkRangeFetch` over `PacksClient.fetchObject`
// (internal, reached through `@testable import PolarisKeyPacks`) with the client's own
// `CoreContext`, against the blobs template the last discover returned, and the replay server
// behind the `PackObjectTransport` seam (`ReplayPackObjectTransport`).

import CryptoKit
import Foundation
import PolarisKey
import PolarisKeyLicense
import PolarisKeyRelease
import PolarisKeyUpdate
import XCTest

@testable import PolarisKeyCore
@testable import PolarisKeyIdentity
@testable import PolarisKeyPacks

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

/// The replay's memory between steps: the session the last `beginSignIn` step started.
final class ReplaySession: @unchecked Sendable {
    var signIn: SignInSession?
    /// What the last `browser` step's authorize request asked for (`license_choice=app`).
    var licenseChoice: LicenseChoiceMode?
    /// `initial.platform`: the device's canonical platform.
    var platform: String?
    /// The transcript's steps (`releaseFetch`'s `partial` seeds from the whole-payload answer).
    var steps: [Transcript.Step] = []
    /// The fixture device keys behind `client.connect` and the label they were last set to.
    let keys = FixtureKeyPort()
    var keyLabel: String?
    /// The ring id of the first ring this conversation created (`keyringAdopt` adopts its root).
    var firstRingId: String?
    /// The key ring's own device keys and root store: memory only, nothing touches the Keychain.
    var ringKeys: DeviceKeyStore?
    /// Cloud Sync's replay memory (U-07.9): the last pull's ETag and the next mutation id.
    var syncEtag = ""
    var syncNextId = 1
    var tap: HeaderTap?
    /// The host codec over a fixture root of its own (`cloudsync-e2e-settings`): not the recorder's.
    var codec: FixtureCodec?
}

/// The fixture device keys of a label (format.ts, `connectIdentity`) as a key port: the Ed25519 seed is
/// SHA-256(label), the agreement key's 32 bytes are SHA-256(label + ":agree") with the top bit of the
/// last byte clear, and it signs deterministically (`DeterministicEd25519`). The agreement key has no private half here (identity needs none), so `dh` answers
/// nil. Test-only; `use(label:)` is a key rotation.
final class FixtureKeyPort: DeviceKeyPort, @unchecked Sendable {
    private let lock = NSLock()
    private var signing = Curve25519.Signing.PrivateKey()
    private var seed = Data()
    private var keys = DevicePublicKeys(signKey: "", agreeKey: "", generation: 1)

    func use(label: String) {
        lock.withLock {
            seed = Data(SHA256.hash(data: Data(label.utf8)))
            // swiftlint:disable:next force_try
            signing = try! Curve25519.Signing.PrivateKey(rawRepresentation: seed)
            var agree = Data(SHA256.hash(data: Data((label + ":agree").utf8)))
            agree[agree.count - 1] &= 0x7f
            keys = DevicePublicKeys(
                signKey: Base64URL.encode(signing.publicKey.rawRepresentation),
                agreeKey: Base64URL.encode(agree), generation: 1)
        }
    }

    func ensure() async throws -> DevicePublicKeys { lock.withLock { keys } }
    func publicKeys() async throws -> DevicePublicKeys? { lock.withLock { keys } }
    func sign(_ message: Data) async throws -> Data {
        // Deterministic, so the signature is the recorded one (CryptoKit's signing is randomised).
        lock.withLock {
            DeterministicEd25519.sign(message, seed: seed, publicKey: signing.publicKey.rawRepresentation)
        }
    }
    func dh(_ peerPublic: Data) async throws -> Data? { nil }
    func rotate() async throws -> DevicePublicKeys { lock.withLock { keys } }
    func persistence() async throws -> DeviceKeyPersistence { .durable }
    func wipe() async throws {}
}

/// The fake platform provider: it returns the ID token the recording was made with.
struct RecordedProvider: Sendable { let token: String }

enum SwiftReplay {
    /// THE mapping from transcript verbs and `expect` keys onto the Swift SDK. Kept in one place.
    static func act(
        _ client: PolarisKeyClient, store: InMemoryStore, step: Transcript.Step,
        session: ReplaySession, update: UpdateClient? = nil,
        objects: (any PackObjectTransport)? = nil, server: ReplayServer? = nil
    ) async throws -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        switch step.action {
        case "cloudSyncPull", "cloudSyncPush":
            guard let server else { throw ReplayError("cloudSync without a replay server") }
            try await CloudSyncReplay.run(client, step: step, session: session, server: server, into: &out)
        case "browser" where await server?.transcript.id == "cloudsync-cors":
            guard let server else { throw ReplayError("browser without a replay server") }
            await CloudSyncReplay.cors(client, step: step, server: server)
        case "browser":
            // The browser's half is the recording's; the SDK's half is the authorize URL it
            // builds for the request the Worker answered with a 303 to the card.
            guard let server else { throw ReplayError("browser without a replay server") }
            let transcript = await server.transcript
            if let authorize = step.exchanges.items.first(where: {
                $0.request.method == "GET" && $0.response.status == 303
                    && $0.request.path.contains("/identity/authorize?")
            }) {
                session.licenseChoice =
                    authorize.request.path.contains("license_choice=app") ? .app : nil
                let started = try await redirectSession(
                    client, step: step, licenseChoice: session.licenseChoice)
                let want = transcript.baseUrl + authorize.request.path
                if started.authorizeUrl != want {
                    await server.recordFailure(
                        "authorize URL differs from the recording:\n    want \(want)\n    got  \(started.authorizeUrl ?? "nil")"
                    )
                }
            }
            await server.serveBrowserExchanges()
            // Facts the recorder read off the browser's pages; nothing of the SDK's.
            for (key, value) in step.expect { out[key] = value }
        case "choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel":
            await choice(client, step: step, into: &out)
        case "redirectComplete":
            // What the recorded browser asked for decides whether the session may settle
            // `.chooseLicense`.
            let s = try await redirectSession(
                client, step: step, licenseChoice: session.licenseChoice)
            do {
                switch try await s.complete(callbackUrl: step.args["callbackUrl"]?.stringValue ?? "") {
                case .signedIn(let ready):
                    out["result"] = .string("ok")
                    out["scope"] = ready.scope.map(JSONValue.string) ?? .null
                    out["subject"] = ready.subject.map(JSONValue.string) ?? .null
                    out["licenseId"] = ready.licenseId.map(JSONValue.string) ?? .null
                case .chooseLicense: out["result"] = .string("choose")
                case .cancelled: out["result"] = .string("cancelled")
                default: out["result"] = .string("error")
                }
            } catch let e as SignInError {
                out["result"] = .string(redirectResult(e.code))
                out["code"] = .string(e.code)
            } catch let e as PolarisError {
                out["result"] = .string("error")
                out["code"] = .string(e.code)
            }
        case "chunkRange":
            guard let objects else { throw ReplayError("chunkRange without a pack object transport") }
            let core = client.core
            let fetchRange = chunkRangeFetch { req in
                try await PacksClient.fetchObject(core, objects, req)
            }
            let r = try await fetchRange(
                ChunkRangeRequest(
                    bundle: step.args["bundle"]?.stringValue ?? "",
                    offset: step.args["offset"]?.intValue ?? 0,
                    length: step.args["length"]?.intValue ?? 0))
            switch r {
            case .refused:
                out["range"] = .string("refused")
            case .ok(let chunks):
                var bytes: [UInt8] = []
                for try await c in chunks { bytes.append(contentsOf: c) }
                out["range"] = .string("ok")
                out["bytes"] = .string(String(decoding: bytes, as: UTF8.self))
            }
        case "updateDecide":
            guard let update else { throw ReplayError("updateDecide without initial.update") }
            var staged: StagedUpdate?
            if let s = step.args["staged"]?.objectValue, let v = s["version"]?.stringValue,
                let c = s["channel"]?.stringValue
            {
                staged = StagedUpdate(version: v, channel: c)
            }
            do {
                let check = try await update.decide(
                    channel: step.args["channel"]?.stringValue, staged: staged,
                    skipVersion: step.args["skipVersion"]?.stringValue)
                if case .object(let fields) = check.json {
                    for (k, v) in fields { out[k] = v }
                }
                out["result"] = .string("ok")
            } catch let e as PolarisError {
                out["result"] = .string("error")
                out["code"] = .string(e.code)
            }
        // The recorded action names stay (plans/I-10-slices.md D-6); they drive the session.
        case "beginSignIn":
            let p: SignInSession
            do {
                p = try await client.identity.signIn.start(
                    SignInOptions(deviceName: step.args["deviceName"]?.stringValue))
            } catch let e as PolarisError {
                out["result"] = .string(e.code)
                break
            }
            session.signIn = p
            out["prompt"] = .object([
                "userCode": .string(p.userCode),
                "verificationUri": .string(p.verificationUri),
                "verificationUriComplete": .string(p.verificationUriComplete),
                "expiresIn": .int(p.expiresIn),
                "interval": .int(p.interval),
                "deviceName": p.deviceName.map { .string($0) } ?? .null,
            ])
        case "pollSignIn":
            guard let sign = session.signIn else { throw ReplayError("pollSignIn before beginSignIn") }
            do {
                switch try await sign.pollOnce() {
                case .pending: out["result"] = .string("pending")
                case .slowDown(let interval):
                    out["result"] = .string("slow-down")
                    out["interval"] = .int(interval)
                case .ready: out["result"] = .string("ready")
                case .confirm: out["result"] = .string("confirm")
                case .expired: out["result"] = .string("expired")
                case .error(_, let code):
                    out["result"] = .string("error")
                    if let code { out["code"] = .string(code) }
                }
            } catch let e as PolarisError where e.code == "server-error" || e.code == "network-error" {
                // I-37d: no answer or a 5xx on the poll is transient; a wait loop keeps polling.
                out["result"] = .string("transient")
                out["code"] = .string(e.code)
            }
        case "waitForSignIn":
            guard let sign = session.signIn else { throw ReplayError("waitForSignIn before beginSignIn") }
            do {
                switch try await sign.wait() {
                case .signedIn: out["result"] = .string("ready")
                case .choose: out["result"] = .string("confirm")
                case .chooseLicense: out["result"] = .string("choose")
                case .expired: out["result"] = .string("expired")
                case .cancelled: out["result"] = .string("cancelled")
                case .pending: out["result"] = .string("pending")
                }
            } catch let e as SignInError {
                out["result"] = .string("error")
                out["code"] = .string(e.code)
            }
        case "mintToken":
            do {
                let minted = try await client.config.mintToken(
                    step.args["recipeId"]?.stringValue ?? "")
                out["result"] = .string("ok")
                out["token"] = .string(minted.token)
                out["expiresAt"] = .int(minted.expiresAt)
            } catch let error as PolarisError {
                out["result"] = .string(error.code)
            }
        case "commerceBinding":
            do {
                let b = try await client.commerce.binding()
                out["result"] = .string("ok")
                out["bindingId"] = .string(b.bindingId)
                out["products"] = .array(
                    b.products.map { p in
                        var o: [String: JSONValue] = [
                            "store": .string(p.store), "productId": .string(p.productId),
                            "flag": .string(p.flag),
                        ]
                        if let d = p.deliverable { o["deliverable"] = .string(d) }
                        return .object(o)
                    })
            } catch let e as PolarisError {
                out["result"] = .string(e.code)
                if let reason = e.detail { out["reason"] = .string(reason) }
            }
        case "commerceClaim":
            let r = await client.commerce.claim(
                store: step.args["store"]?.stringValue ?? "",
                payload: step.args["payload"]?.objectValue ?? [:])
            switch r {
            case .ok(let claim):
                out["result"] = .string("ok")
                out["flag"] = .string(claim.flag)
                out["state"] = .string(claim.state)
                out["granted"] = .bool(claim.granted)
            default:
                out["result"] = .string(r.code)
                if let reason = r.reason { out["reason"] = .string(reason) }
            }
        case "discover":
            switch await client.discover() {
            case .ok: out["result"] = .string("ok")
            case .notFound: out["result"] = .string("not-found")
            case .invalid: out["result"] = .string("invalid")
            case .error: out["result"] = .string("error")
            }
            // `core.presentation` (HA-13): the member the client now exposes, or null.
            out["presentation"] = client.presentation?.jsonValue ?? .null
            // `identity.exchange` (§12.11.6): the exchange member and whether the nonce route is named.
            let identity = await client.core.discoveryDocument?.identity
            out["exchange"] =
                identity?.exchange.map {
                    var o: [String: JSONValue] = ["kinds": .array($0.kinds.map(JSONValue.string))]
                    if let id = $0.googleServerClientId {
                        o["google"] = .object(["serverClientId": .string(id)])
                    }
                    return .object(o)
                } ?? .null
            out["nonceEndpoint"] = .bool(!(identity?.nonce ?? "").isEmpty)
        case "exchange":
            try await exchange(client, step: step, session: session, into: &out)
        case "connectIdentity", "connectDevices":
            // `client.connect` (CC-06.4, `connect.identity`).
            let label = step.args["keyLabel"]?.stringValue ?? ""
            if session.keyLabel != label {
                // A different label is a different key pair: the next call registers it.
                session.keys.use(label: label)
                session.keyLabel = label
            }
            if step.action == "connectIdentity" {
                switch await client.connect.identity(refresh: step.args["refresh"]?.boolValue ?? false) {
                case .ready(let id):
                    out["result"] = .string("ok")
                    out["epoch"] = .int(id.ring.epoch)
                    out["devices"] = .array(id.ring.devices.map { .string($0.deviceId) })
                    out["deviceId"] = .string(id.deviceId)
                    out["discKeys"] = .int(id.discKeys.count)
                case .unsupported: out["result"] = .string("unavailable")
                case .refused(let r):
                    out["result"] = .string("refused")
                    out["code"] = .string(r.code)
                case .error(let code, _):
                    out["result"] = .string("error")
                    out["code"] = .string(code)
                }
            } else {
                switch await client.connect.listDevices() {
                case .devices(let list):
                    out["result"] = .string("ok")
                    out["devices"] = .array(
                        list.map {
                            .object([
                                "deviceId": .string($0.deviceId),
                                "label": $0.label.map(JSONValue.string) ?? .null,
                                "platform": $0.platform.map(JSONValue.string) ?? .null,
                                "lastSeen": .int($0.lastSeen), "self": .bool($0.isSelf),
                            ])
                        })
                case .unsupported: out["result"] = .string("unavailable")
                case .refused(let r):
                    out["result"] = .string("refused")
                    out["code"] = .string(r.code)
                case .error(let code, _):
                    out["result"] = .string("error")
                    out["code"] = .string(code)
                }
            }
        case "relayTicket":
            // `client.connect.relayTicket()` (CC-11.4, `connect.relay`): a refusal reads as `refused`
            // with the status, the Worker's code and, where it answers them, `retryAfter` and `scope`.
            switch await client.connect.relayTicket() {
            case .granted(let g):
                out["result"] = .string("ok")
                out["protocol"] = .string(g.protocolName)
                out["url"] = .string(g.url.absoluteString)
                out["expiresIn"] = .int(g.expiresAt - (await client.core.now()))
            case .relay(let e):
                out["result"] = .string("refused")
                out["status"] = e.status.map(JSONValue.int) ?? .null
                out["code"] = .string(e.code)
                if let r = e.retryAfterSeconds { out["retryAfter"] = .int(r) }
                if let sc = e.scope { out["scope"] = .string(sc) }
            case .refused(let r):
                out["result"] = .string("refused")
                out["status"] = .int(r.status)
                out["code"] = .string(r.code)
            case .unsupported: out["result"] = .string("unavailable")
            case .error(let code, _):
                out["result"] = .string("error")
                out["code"] = .string(code)
            }
        case "keyringGet", "keyringCreate", "keyringReset", "keyringWrap", "keyringUnwrap", "keyringAdopt",
            "keyringRecoverySet", "keyringRecoveryGet":
            try await keyring(client, step: step, session: session, into: &out)
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
            activation(await client.license.activateWithKey(step.args["key"]?.stringValue ?? ""), into: &out)
        case "enroll":
            activation(await client.enroll(), into: &out)
        case "boot":
            let run = await client.boot(confirmAfterReady: false)
            out["bootOutcome"] = .string(run.outcome.rawValue)
        case "downloadModel":
            let model = try await client.distribution.downloadModel()
            out["result"] = .string("ok")
            out["platforms"] = .array(model.platforms.map { .string($0.platform) })
            out["current"] = session.platform.flatMap(model.group(for:)).map(groupValue) ?? .null
        case "releaseFetch":
            try await releaseFetch(client, step: step, session: session, into: &out)
        case "register":
            switch await client.core.registerDevice(fingerprint: registerFingerprint) {
            case .ok: out["result"] = .string("ok")
            case .registrationClosed: out["result"] = .string("registration-closed")
            case .rateLimited: out["result"] = .string("rate-limited")
            case .notConfigured: out["result"] = .string("not-configured")
            case .error: out["result"] = .string("error")
            }
        case "subject":
            out["subject"] = try await client.identity.subject().map(JSONValue.string) ?? .null
        case "signOut":
            out["released"] = .bool(try await client.identity.signOut().released)
        case "attach":
            switch try await client.identity.attach(confirm: step.args["confirm"] == .bool(true)) {
            case .confirm(let l):
                out["result"] = .string("confirm")
                out["license"] = .object([
                    "id": .string(l.id), "tierId": l.tierId.map(JSONValue.string) ?? .null,
                    "name": l.name.map(JSONValue.string) ?? .null,
                ])
            case .ok(let subject, let attached):
                out["result"] = .string("ok")
                out["attached"] = attached.map(JSONValue.string) ?? .null
                out["subject"] = subject.map(JSONValue.string) ?? .null
            case .refused(let code, _):
                out["result"] = .string("refused")
                out["code"] = .string(code)
            }
        case "deactivate":
            try await client.deactivate()
        case "report":
            out["result"] = .bool(await client.report())
            out["updatesPending"] = .int(await client.core.journal.all().count)
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
            out["url"] = .string(try await client.release.installUrl().absoluteString)
        case "downloadUrl":
            out["url"] = .string(
                try await client.release.downloadUrl(
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
        // The `exchange` verb reports its own, per step (the token it stored, not the store's).
        if step.action != "exchange" { out["tokenHeld"] = .bool(await store.getToken() != nil) }
        return out
    }

    /// The key ring verbs (U-39.4, `sync.keyring`) over `client.keyring`. The transcripts hold no key
    /// material the client could use, so the client makes its own: create and reset draw a root, wrap
    /// seals it to a fresh agreement key for the named device (`deviceId` is the TARGET), and adopt takes
    /// the root of the first ring this conversation created. A refusal reads as `refused` with the status
    /// and the code.
    private static func keyring(
        _ client: PolarisKeyClient, step: Transcript.Step, session: ReplaySession,
        into out: inout [String: JSONValue]
    ) async throws {
        if session.ringKeys == nil {
            let keys = try DeviceKeyStore.inMemory(productSlug: client.product)
            session.ringKeys = keys
            try client.configureKeyring(SyncKeyringOptions(keys: keys, rootStore: .inMemory()))
        }
        let k = client.keyring
        do {
            switch step.action {
            case "keyringGet":
                let r = try await k.read()
                if let g = r.ring {
                    out["ring"] = .object([
                        "ringId": .string(g.ringId), "epoch": .int(g.epoch), "rootKid": .string(g.rootKid),
                        "state": .string(g.state), "recoverySet": .bool(g.recoverySet),
                        "previous": g.previous.map { .string($0.ringId) } ?? .null,
                        "adopted": .array(g.adopted.map { .string($0.ringId) }),
                    ])
                } else {
                    out["ring"] = .null
                }
                if let w = r.wrap {
                    out["wrap"] = .object([
                        "epoch": .int(w.epoch), "kid": .string(w.kid), "by": w.by.map { .string($0) } ?? .null,
                    ])
                } else {
                    out["wrap"] = .null
                }
            case "keyringCreate", "keyringReset":
                let made = step.action == "keyringCreate" ? try await k.create() : try await k.reset()
                if step.action == "keyringCreate", session.firstRingId == nil { session.firstRingId = made.ringId }
                // The ring id is the client's own draw and the recording's is a fixture: both must be a
                // well formed id, and the replay reports the recorded one when ours is.
                let ok = made.ringId.range(of: "^rg_[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil
                out["ringId"] = ok ? (step.expect["ringId"] ?? .string(made.ringId)) : .string(made.ringId)
                out["epoch"] = .int(made.epoch)
            case "keyringWrap":
                let pub = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
                try await k.wrapTo(deviceId: step.args["deviceId"]?.stringValue ?? "", agreeKey: pub)
            case "keyringUnwrap":
                try await k.removeWrap(deviceId: step.args["deviceId"]?.stringValue ?? "")
            case "keyringAdopt":
                try await k.adopt(ringId: session.firstRingId ?? "")
            case "keyringRecoverySet":
                _ = try await k.setRecoveryCode()
            default:
                out["ct"] = .string(try await k.recoveryBlob().ct)
            }
            out["result"] = .string("ok")
        } catch let e as PolarisError {
            out["result"] = .string("refused")
            if let s = e.status { out["status"] = .int(s) }
            out["code"] = .string(e.code)
        }
    }

    /// The recorder's constants for a redirect conversation (`packages/worker/test/transcripts`).
    private static let recordedState = "tidewater-state-0123456789"
    private static let recordedVerifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
    private static let recordedRedirect = "https://app.example/auth/callback"

    /// A redirect session the way the step's `args` ask for one: the recorded `state` and verifier
    /// (a step may name its own), the hints it carries, the recorded redirect URI.
    private static func redirectSession(
        _ client: PolarisKeyClient, step: Transcript.Step, licenseChoice: LicenseChoiceMode? = nil
    ) async throws -> SignInSession {
        client.identity.redirectEntropy.set(
            (
                state: step.args["state"]?.stringValue ?? recordedState,
                codeVerifier: step.args["codeVerifier"]?.stringValue ?? recordedVerifier
            ))
        return try await client.identity.signIn.start(
            SignInOptions(
                channel: .redirect, redirectUri: step.args["redirectUri"]?.stringValue ?? recordedRedirect,
                loginHint: step.args["loginHint"]?.stringValue,
                nameHint: step.args["nameHint"]?.stringValue,
                purpose: step.args["purpose"]?.stringValue.flatMap(SignInPurpose.init(rawValue:)),
                licenseChoice: licenseChoice))
    }

    /// `exchange` (`identity.exchange`, I-44.3): the platform's ID token is the recording's
    /// (`subjectToken`, a fake provider that returns it). A recorded `nonce` is the one the
    /// provider was asked with (`exchange(kind:subjectToken:nonce:)`); without one the SDK's
    /// internal `optionalNonce: nil` path fetches it from the nonce route. The fixture device keys
    /// are the connect port's (`keyLabel`): durable, with deterministic signatures.
    private static func exchange(
        _ client: PolarisKeyClient, step: Transcript.Step, session: ReplaySession,
        into out: inout [String: JSONValue]
    ) async throws {
        let label = step.args["keyLabel"]?.stringValue ?? ""
        if session.keyLabel != label {
            session.keys.use(label: label)
            session.keyLabel = label
        }
        guard let kind = ExchangeKind(rawValue: step.args["kind"]?.stringValue ?? "") else {
            throw ReplayError("exchange: unknown kind")
        }
        // A step that never reaches the token route records no token; the SDK needs a non-empty one.
        let provider = RecordedProvider(token: step.args["subjectToken"]?.stringValue ?? "unused.subject.token")
        let heldBefore = await client.core.token
        var signedIn = false
        do {
            let outcome = try await client.identity.exchange(
                kind: kind, subjectToken: provider.token,
                optionalNonce: step.args["nonce"]?.stringValue)
            switch outcome {
            case .signedIn(let ready):
                signedIn = true
                out["result"] = .string("ok")
                out["scope"] = ready.scope.map(JSONValue.string) ?? .null
                out["subject"] = ready.subject.map(JSONValue.string) ?? .null
                out["licenseId"] = ready.licenseId.map(JSONValue.string) ?? .null
                out["issuedTokenType"] = .string("urn:polaris-key:token-type:device")
            case .confirm(let pending):
                out["result"] = .string("confirm")
                out["firstTime"] = .bool(pending.consent.firstTime)
                out["changed"] = .bool(pending.consent.changed)
                out["as"] = .object([
                    "provider": .string(pending.consent.as.provider),
                    "email": pending.consent.as.email.map(JSONValue.string) ?? .null,
                ])
            case .choose: out["result"] = .string("choose")
            case .needsSignIn(let n):
                out["result"] = .string("interstitial-required")
                out["reason"] = .string(n.reason.rawValue)
                out["url"] = .string(n.url)
                out["linkHandle"] = n.linkHandle.map(JSONValue.string) ?? .null
                out["expiresIn"] = n.expiresIn.map { .int($0) } ?? .null
            case .unavailable: out["result"] = .string("unavailable")
            }
        } catch let e as ExchangeError {
            out["result"] = .string("refused")
            out["code"] = .string(e.code)
        } catch let e as PolarisError {
            out["result"] = .string("error")
            out["code"] = .string(e.code)
        }
        // Per step, as the other runners report it: this exchange stored a token. Any other
        // outcome leaves the token that was already held exactly as it was.
        let heldAfter = await client.core.token
        if !signedIn, heldAfter != heldBefore {
            throw ReplayError("exchange: a step that signed nobody in changed the held token")
        }
        out["tokenHeld"] = .bool(signedIn && heldAfter != nil)
    }

    /// `choiceLicenses` / `choiceDevices` / `choiceComplete` / `choiceCancel`: `identity.choice`.
    /// The recorded `complete` has no `choice` argument; the choice is in the request the
    /// recording asserts, so the replayer reads it from there.
    private static func choice(
        _ client: PolarisKeyClient, step: Transcript.Step, into out: inout [String: JSONValue]
    ) async {
        let grant = step.args["grant"]?.stringValue ?? ""
        do {
            switch step.action {
            case "choiceLicenses":
                let view = try await client.identity.choice.licenses(grant: grant)
                out["result"] = .string("ok")
                out["state"] = .string(view.state)
                out["licenses"] = .array(view.choices.map { .string($0.id) })
            case "choiceDevices":
                let view = try await client.identity.choice.devices(
                    grant: grant, licenseId: step.args["licenseId"]?.stringValue ?? "")
                out["result"] = .string("ok")
                out["devices"] = .array(view.devices.map { .string($0.id) })
            case "choiceComplete":
                let done = try await client.identity.choice.complete(
                    grant: grant, choice: recordedChoice(step), consent: recordedConsent(step))
                out["result"] = .string("ok")
                out["tokenHeld"] = .bool(await client.core.token != nil)
                out["scope"] = done.ready.scope.map(JSONValue.string) ?? .null
                out["licenseId"] = done.ready.licenseId.map(JSONValue.string) ?? .null
                out["subject"] = done.ready.subject.map(JSONValue.string) ?? .null
                if let k = done.keyEntries {
                    out["keyEntries"] = .object(["used": .int(k.used), "limit": .int(k.limit)])
                }
            default:
                try await client.identity.choice.cancel(grant: grant)
                out["result"] = .string("ok")
            }
        } catch let e as ChoiceError {
            out["result"] = .string("refused")
            out["code"] = .string(e.code)
        } catch let e as PolarisError {
            out["result"] = .string("error")
            out["code"] = .string(e.code)
        } catch {
            out["result"] = .string("error")
        }
    }

    /// The `consent` the recording's `choice/complete` request carries (an exchange `confirm`).
    private static func recordedConsent(_ step: Transcript.Step) -> ChoiceConsent? {
        guard
            let claims = step.exchanges.items.first?.request.body?.json.objectValue?["consent"]?
                .objectValue?["claims"]
        else { return nil }
        if case .array(let list) = claims { return ChoiceConsent(claims: list.compactMap(\.stringValue)) }
        return nil
    }

    /// The `LicenseChoiceInput` the recording's `choice/complete` request carries (absent: none,
    /// which the Worker refuses with `license_choice_required`).
    private static func recordedChoice(_ step: Transcript.Step) -> LicenseChoiceInput? {
        guard
            let wire = step.exchanges.items.first?.request.body?.json.objectValue?["choice"]?
                .objectValue
        else { return nil }
        switch wire["kind"]?.stringValue {
        case "license":
            return .license(
                id: wire["licenseId"]?.stringValue ?? "",
                replaceDeviceId: wire["replaceDeviceId"]?.stringValue)
        case "keep": return .keep
        case "create": return .create
        case "key": return .key(wire["key"]?.stringValue ?? "")
        default: return nil
        }
    }

    /// `redirectComplete`'s `result` for a refusal's code (`format.ts`).
    private static func redirectResult(_ code: String) -> String {
        switch code {
        case "invalid_grant", "invalid_request", "invalid_client", "license_choice_required",
            "rate_limited":
            return code.replacingOccurrences(of: "_", with: "-")
        default: return "error"
        }
    }

    /// `releaseFetch` (SP-19) is `client.update.fetch(version:buildId:size:sha256:to:)` into a
    /// fresh directory; `partial` seeds `<to>.part` with the first that many bytes of the
    /// transcript's whole-payload answer. A refusal is `refused` with the server's code (the
    /// client's own failures are `error`), and must leave no file at `to`.
    static func releaseFetch(
        _ client: PolarisKeyClient, step: Transcript.Step, session: ReplaySession,
        into out: inout [String: JSONValue]
    ) async throws {
        let a = step.args
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pkey-replay-fetch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let to = dir.appendingPathComponent("payload.bin")
        if let n = a["partial"]?.intValue {
            guard let path = step.exchanges.items.first?.request.path,
                let whole = payload(of: session.steps, path: path)
            else { throw ReplayError("releaseFetch: no whole-payload answer to seed from") }
            try whole.prefix(n).write(to: dir.appendingPathComponent("payload.bin.part"))
        }
        do {
            let r = try await client.update.fetch(
                version: a["version"]?.stringValue ?? "", buildId: a["build"]?.stringValue ?? "",
                size: a["size"]?.intValue, sha256: a["sha256"]?.stringValue ?? "", to: to)
            out["result"] = .string("ok")
            out["size"] = .int(r.size)
            out["sha256"] = .string(r.sha256)
            let written = try Data(contentsOf: to)
            guard written.count == r.size else {
                throw ReplayError("releaseFetch: the verified file holds \(written.count) bytes, not \(r.size)")
            }
        } catch let e as PolarisError {
            let local: Set<String> = [
                ErrorCode.network, ErrorCode.networkError, ErrorCode.payloadMismatch,
                ErrorCode.invalidOptions, ErrorCode.serviceUnavailable, ErrorCode.notConfigured,
            ]
            out["result"] = .string(local.contains(e.code) ? "error" : "refused")
            out["code"] = .string(e.code)
            guard !FileManager.default.fileExists(atPath: to.path) else {
                throw ReplayError("releaseFetch: a refusal left a file at the destination")
            }
        }
    }

    /// The body of the first 200 GET of `path` in `steps`.
    static func payload(of steps: [Transcript.Step], path: String) -> Data? {
        for s in steps {
            for x in s.exchanges.items
            where x.request.method == "GET" && x.request.path == path && x.response.status == 200 {
                if case .string(let text) = x.response.body { return Data(text.utf8) }
            }
        }
        return nil
    }

    /// `initial.update.outlet`: a kind, or `{id, kind, subkind?}`.
    static func hostOutlet(_ v: JSONValue?) throws -> HostOutlet? {
        switch v {
        case nil, .null?: return nil
        case .string(let kind)?: return .kind(kind)
        case .object(let o)?:
            guard let id = o["id"]?.stringValue, let kind = o["kind"]?.stringValue else {
                throw ReplayError("initial.update.outlet needs a string id and kind")
            }
            return .outlet(id: id, kind: kind, subkind: o["subkind"]?.stringValue)
        default: throw ReplayError("initial.update.outlet is not an outlet")
        }
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

    /// An activation or enrolment result: its `activationResult` kind and, on a refusal, the
    /// wire code the body carried.
    static func activation(_ r: ActivationResult, into out: inout [String: JSONValue]) {
        out["result"] = .string(r.kind)
        func entries(_ e: KeyEntries?) -> JSONValue {
            e.map { .object(["used": .int($0.used), "limit": .int($0.limit)]) } ?? .null
        }
        if case .ok(_, _, let keyEntries) = r {
            // `null` with Identity off: the response has no member and the client reports none.
            out["keyEntries"] = entries(keyEntries)
            return
        }
        out["code"] = .string(r.code)
        // PX-W8: the refusal link, exactly as served; null when the result carries none.
        if case .deviceLimit(_, _, let manageURL) = r {
            out["manageUrl"] = manageURL.map(JSONValue.string) ?? .null
        }
        if case .keyEntryLimit(let manageUrl, let keyEntries) = r {
            out["manageUrl"] = manageUrl.map(JSONValue.string) ?? .null
            out["keyEntries"] = entries(keyEntries)
        }
        if case .licenseOwned(let signInUrl) = r {
            // keyentry-owned (recorded before the kind) names this refusal `refused`.
            out["result"] = .string("refused")
            out["signInUrl"] = signInUrl.map(JSONValue.string) ?? .null
        }
    }

    /// A download model's platform group in the transcript's JSON vocabulary (nil ⇒ `null`).
    static func groupValue(_ g: DistributionPlatform) -> JSONValue {
        func opt(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }
        return .object([
            "platform": .string(g.platform), "label": .string(g.label), "primary": opt(g.primary),
            "actions": .array(g.actions.map(JSONValue.string)),
            "builds": .array(
                g.builds.map { b in
                    .object([
                        "releaseId": .string(b.releaseId), "version": .string(b.version),
                        "buildId": .string(b.buildId), "platform": .string(b.platform),
                        "arch": .string(b.arch), "format": opt(b.format), "name": .string(b.name),
                        "size": b.size.map(JSONValue.int) ?? .null, "sha256": opt(b.sha256),
                        "minOs": opt(b.minOs), "url": .string(b.url), "outletId": .string(b.outletId),
                    ])
                }),
        ])
    }

    /// Replay `t` step by step; throws on the first step whose traffic or outcome disagrees.
    static func replay(_ t: Transcript) async throws {
        let server = ReplayServer(t)
        let clock = ReplayClock(t.now)
        let store = InMemoryStore(productSlug: t.product, deviceId: t.initial.deviceId)
        if let token = t.initial.token { await store.setToken(token) }
        if let journal = t.initial.updateJournal {
            await store.writeRecord(UpdateJournal.recordName, try JSONEncoder().encode(journal))
        }
        let u = t.initial.update
        if let cache = u?.cache {
            await store.writeCache(
                CacheRecord(feeds: cache.feeds ?? [:], releaseRecords: cache.releaseRecords ?? [:]))
        }
        // The redirect conversations ride a product that runs Identity (their discovery names it).
        // (`cloudsync-cors`' `browser` steps are plain requests, not a redirect sign-in.)
        let redirects =
            t.id != "cloudsync-cors"
            && t.steps.contains { ["browser", "redirectComplete"].contains($0.action) }
        let services =
            t.initial.services
            ?? (u != nil
                ? ["release", "distribution", "update"] : (redirects ? ["license", "config", "identity"] : nil))
        let tap = HeaderTap(ReplayTransport(server: server))
        let core = CoreOptions(
            productSlug: t.product, baseUrl: t.baseUrl,
            version: u?.installed.version ?? t.initial.version,
            pinnedKeys: t.trust, store: store, transport: tap,
            requestTimeoutSeconds: 0,
            expectedServices: services?.compactMap(ServiceSlug.init(rawValue:)),
            clock: { clock.now },
            // Persisted state (presentation.json, the icon cache) in a throwaway directory, so a
            // replay never reads what an earlier one wrote.
            dataDir: FileManager.default.temporaryDirectory
                .appendingPathComponent("pkey-replay-\(UUID().uuidString)", isDirectory: true),
            // PX-W13: `initial.deviceName` stands in for the platform's device name; absent = none.
            deviceName: t.initial.deviceName ?? "")
        let session = ReplaySession()
        let client = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                core: core, connect: ConnectOptions(keys: session.keys, store: .inMemory())))
        var update: UpdateClient?
        if let u {
            update = try UpdateClient(
                core: client.core,
                options: UpdateClientOptions(
                    pinnedReleaseKeys: u.pinnedReleaseKeys, outlet: try hostOutlet(u.outlet),
                    buildNumber: u.installed.buildNumber, format: u.installed.format,
                    methods: u.methods ?? [BinaryMethod.download],
                    binaryVersion: u.installed.binaryVersion, engine: u.installed.engine,
                    platform: u.platform, arch: u.arch))
        }
        // The redirect recordings hold the token exchange, not the sync a sign-in triggers after it.
        if redirects || t.steps.contains(where: { ["exchange", "choiceComplete"].contains($0.action) }) {
            client.identity.redirectAcquisitionSync.set(false)
        }
        session.platform = t.initial.platform
        session.steps = t.steps
        session.tap = tap
        if t.id == "cloudsync-e2e-settings" { session.codec = FixtureCodec(CloudSyncReplay.root) }
        for i in t.steps.indices {
            let step = await server.beginStep(i)
            clock.now = step.now ?? t.now
            let observed = try await act(
                client, store: store, step: step, session: session, update: update,
                objects: ReplayPackObjectTransport(server: server), server: server)
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
        // The Cloud Sync conversations are required, not optional: a regression in the manifest or the
        // replayer must not quietly drop them.
        let cloud = try transcripts().filter { $0.id.hasPrefix("cloudsync-") }.map(\.id)
        XCTAssertFalse(cloud.isEmpty)
        for id in cloud { XCTAssertTrue(replayed.contains(id), "\(id) was not replayed") }
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

    /// The presentation is held as tightly: a member that stays after it went away fails.
    func testAStalePresentationFails() async throws {
        var t = try XCTUnwrap(try transcripts().first { $0.id == "discovery-presentation" })
        t.steps[1].expect["presentation"] = t.steps[0].expect["presentation"]
        await assertReplayFails(t, matching: "step 1 (discover): presentation")
    }

    /// The update transcripts are held as tightly: an `UpdateCheck` member that disagrees fails.
    func testADoctoredUpdateDecisionFails() async throws {
        var t = try XCTUnwrap(try transcripts().first { $0.id == "update-feed-rollback" })
        t.steps[0].expect["channel"] = .string("latest")
        await assertReplayFails(t, matching: "step 0 (updateDecide): channel")
        var u = try XCTUnwrap(try transcripts().first { $0.id == "update-record-by-hash" })
        u.steps[1].exchanges.items.append(u.steps[0].exchanges.items[1])
        await assertReplayFails(
            u, matching: "expected request not sent: GET /djdl/release/records/")
    }

    /// `packs-chunk-range` passes only when the SDK reads the exact run: a recorded
    /// `Content-Range` altered to another range must be refused, so the step fails. (Keys are
    /// compared in sorted order, so the first to fail is `bytes`: a refused fetch returns none.)
    func testAChunkRangeWithAnotherContentRangeFails() async throws {
        var t = try XCTUnwrap(try transcripts().first { $0.id == "packs-chunk-range" })
        for i in t.steps[1].exchanges.items.indices {
            t.steps[1].exchanges.items[i].response.headers["content-range"] = "bytes 17-40/64"
        }
        await assertReplayFails(
            t, matching: "step 1 (chunkRange): bytes: expected \"ghijklmnopqrstuvwxyzABCD\", got nil")
    }

    // ── release.fetch (SP-19): the cases the recording does not hold ──────────────────

    private func fetchGated() throws -> Transcript {
        try XCTUnwrap(try transcripts().first { $0.id == "release-fetch-gated" })
    }

    /// A 200 to the ranged request means the representation changed: the part is discarded
    /// and the whole payload is taken, still verified.
    func testA200ToARangedRequestRestarts() async throws {
        var t = try fetchGated()
        let whole = t.steps[1].exchanges.items[0].response
        t.steps[2].exchanges.items[0].response = whole
        try await SwiftReplay.replay(t)
    }

    /// The refused code is the body's registered wire code; an unregistered one falls back to
    /// the status's (`unauthorized` for a 401).
    func testAnUnregisteredRefusalCodeFallsBackToTheStatus() async throws {
        var t = try fetchGated()
        t.steps[3].exchanges.items[0].response.body = .object([
            "error": .string("not_a_registered_code"), "message": .string("doctored"),
        ])
        t.steps[3].expect["code"] = .string(ErrorCode.unauthorized)
        try await SwiftReplay.replay(t)
        t.steps[3].exchanges.items[0].response.body = .object([
            "error": .object(["code": .string(ErrorCode.downloadAuthRequired)])
        ])
        t.steps[3].expect["code"] = .string(ErrorCode.downloadAuthRequired)
        try await SwiftReplay.replay(t)
    }

    /// Bytes that disagree with the record never reach the destination.
    func testAPayloadThatDisagreesWithTheRecordIsRefused() async throws {
        var t = try fetchGated()
        t.steps[1].args["sha256"] = .string(String(repeating: "0", count: 64))
        t.steps[1].expect = ["result": .string("error"), "code": .string(ErrorCode.payloadMismatch)]
        try await SwiftReplay.replay(t)
    }
}
