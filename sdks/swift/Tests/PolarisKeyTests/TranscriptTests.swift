// @pkey-feature core.discover core.sync core.cache license.activate license.enroll
// @pkey-feature core.presentation
// @pkey-feature license.deactivate license.reregister devices.register devices.report
// @pkey-feature config.schema release.changelog release.download
// @pkey-feature identity.devicecode identity.devicelabel config.mint
// @pkey-feature update.feed release.record update.decide
// @pkey-feature packs.apply.chunk commerce.receipt
// @pkey-feature license.refusals ui.boot release.distribution telemetry.updates
// @pkey-feature license.manage
// @pkey-feature release.fetch identity.keyentry identity.account identity.attach identity.toggle
// @pkey-feature identity.redirect.web identity.signin.hints
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

import Foundation
import PolarisKey
import PolarisKeyCore
@testable import PolarisKeyIdentity
import PolarisKeyLicense
@testable import PolarisKeyPacks
import PolarisKeyRelease
import PolarisKeyUpdate
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

/// The replay's memory between steps: the session the last `beginSignIn` step started.
final class ReplaySession: @unchecked Sendable {
    var signIn: SignInSession?
    /// `initial.platform`: the device's canonical platform.
    var platform: String?
    /// The transcript's steps (`releaseFetch`'s `partial` seeds from the whole-payload answer).
    var steps: [Transcript.Step] = []
}

enum SwiftReplay {
    /// THE mapping from transcript verbs and `expect` keys onto the Swift SDK. Kept in one place.
    static func act(
        _ client: PolarisKeyClient, store: InMemoryStore, step: Transcript.Step,
        session: ReplaySession, update: UpdateClient? = nil,
        objects: (any PackObjectTransport)? = nil, server: ReplayServer? = nil
    ) async throws -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        switch step.action {
        case "browser":
            // The browser's half is the recording's; the SDK's half is the authorize URL it
            // builds for the request the Worker answered with a 303 to the card.
            guard let server else { throw ReplayError("browser without a replay server") }
            let transcript = await server.transcript
            if let authorize = step.exchanges.items.first(where: {
                $0.request.method == "GET" && $0.response.status == 303
                    && $0.request.path.contains("/identity/authorize?")
            }) {
                let started = try await redirectSession(client, step: step)
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
        case "redirectComplete":
            let s = try await redirectSession(client, step: step)
            do {
                switch try await s.complete(callbackUrl: step.args["callbackUrl"]?.stringValue ?? "") {
                case .signedIn(let ready):
                    out["result"] = .string("ok")
                    out["scope"] = ready.scope.map(JSONValue.string) ?? .null
                    out["subject"] = ready.subject.map(JSONValue.string) ?? .null
                    out["licenseId"] = ready.licenseId.map(JSONValue.string) ?? .null
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
        out["tokenHeld"] = .bool(await store.getToken() != nil)
        return out
    }

    /// The recorder's constants for a redirect conversation (`packages/worker/test/transcripts`).
    private static let recordedState = "tidewater-state-0123456789"
    private static let recordedVerifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
    private static let recordedRedirect = "https://app.example/auth/callback"

    /// A redirect session the way the step's `args` ask for one: the recorded `state` and verifier
    /// (a step may name its own), the hints it carries, the recorded redirect URI.
    private static func redirectSession(_ client: PolarisKeyClient, step: Transcript.Step)
        async throws -> SignInSession
    {
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
                purpose: step.args["purpose"]?.stringValue.flatMap(SignInPurpose.init(rawValue:))))
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
        let redirects = t.steps.contains { ["browser", "redirectComplete"].contains($0.action) }
        let services =
            t.initial.services
            ?? (u != nil
                ? ["release", "distribution", "update"] : (redirects ? ["license", "config", "identity"] : nil))
        let core = CoreOptions(
            productSlug: t.product, baseUrl: t.baseUrl,
            version: u?.installed.version ?? t.initial.version,
            pinnedKeys: t.trust, store: store, transport: ReplayTransport(server: server),
            requestTimeoutSeconds: 0,
            expectedServices: services?.compactMap(ServiceSlug.init(rawValue:)),
            clock: { clock.now },
            // Persisted state (presentation.json, the icon cache) in a throwaway directory, so a
            // replay never reads what an earlier one wrote.
            dataDir: FileManager.default.temporaryDirectory
                .appendingPathComponent("pkey-replay-\(UUID().uuidString)", isDirectory: true),
            // PX-W13: `initial.deviceName` stands in for the platform's device name; absent = none.
            deviceName: t.initial.deviceName ?? "")
        let client = try await PolarisKeyClient.create(options: PolarisKeyClientOptions(core: core))
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
        if redirects { client.identity.redirectAcquisitionSync.set(false) }
        let session = ReplaySession()
        session.platform = t.initial.platform
        session.steps = t.steps
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
