// The Update sub-client — the FEED over Release's truth store (D-05, §R1), and wire v4's signed
// update decision (plans/P3-01.md §2.5–§2.8).
//
//   `check()`        `GET /<p>/update/version` → what the newest build on this channel is, plus
//                    whether the running version is behind it. The comparison uses Core's
//                    `Semver.compare`, the same one the server's build gate and every other SDK
//                    use — a version check that disagreed with the gate would tell a user to
//                    update to a build the gate then blocks.
//   `feed()`         the Sparkle appcast URL + `allowedChannels` + auth headers, taken from
//                    DISCOVERY rather than string-built here.
//   `decide()`       wire v4: the signed channel feed (`pkey-feed+jws`), the release record it
//                    pins (`pkey-release+jws`, fetched by hash), and the decision over both.
//   `channelFeed()`  the verified feed `decide()` would use, without the record. (Named apart
//                    from `feed()`, the Sparkle helper, which is unchanged.)
//   `releaseRecord()` one release record by hash, verified against the PINNED release keys.
//   `buildURL()`     the route an install downloads a build from (`distribution/builds`).
//
// No Sparkle import: this file is the network client, and it works on any platform — an iOS app
// is a "decide only" host (App Store, TestFlight, a marketplace) and calls `decide()` exactly as
// a macOS direct build does. The Sparkle-touching code is in `SparkleUpdater.swift`, behind
// `#if os(macOS)`.
//
// ── WHAT THE v4 CALLS TRUST ─────────────────────────────────────────────────────────────────
//
//   * feeds verify against the EFFECTIVE product trust set (pins ∪ verified manifest keys), as
//     documents do;
//   * records verify against `UpdateClientOptions.pinnedReleaseKeys` only. That map is compiled
//     into the host, never persisted, never merged with the product trust set and never extended
//     from the network; a key that is also a trust pin raises `invalid-options` at construction;
//   * the clock is Core's EFFECTIVE clock, `max(system, highWaterMark)` (V3 §4.2), so winding the
//     system clock back cannot revive an expired feed;
//   * the cache holds signed JWSs only: every entry is re-verified before use, and each channel's
//     floor is derived from the committed feed that survives, never read from a stored number.
//
// The order, the floors, the fallback after a refusal and the error map are `runUpdateCheck` in
// PolarisKeyCore; this file is transport (the discovered templates and two GETs), storage (Core's
// read-modify-write of the `feeds` and `releaseRecords` slices) and the host's options.

import Foundation
import PolarisKeyCore

/// Wire v4 update inputs. The installed VERSION is `CoreOptions.version`; everything else the
/// decision needs about this install is here, and is validated when the client is constructed (a
/// bad value raises `invalid-options`).
public struct UpdateClientOptions: Sendable, Equatable {
    /// `kid` → raw 32-byte Ed25519 release key, base64url (the `TrustSet` encoding): the ONLY keys
    /// a release record verifies against. Two or more are valid at once during a rotation. Empty
    /// ⇒ `decide()` raises `not-configured`; a key that is also a trust pin ⇒ construction raises
    /// `invalid-options` (a release key is never a product key).
    public var pinnedReleaseKeys: TrustSet
    /// Where this install came from: `.kind("app-store")`, read as `{id: kind, kind}`, or the
    /// product's outlet id with its kind. It wins over `stamp` and `detected`. Without it the
    /// client detects the outlet (`detect`) at its first decision; with no stamp and no attested
    /// evidence (an App Store receipt, `AppDistributor`) the outlet is `unknown`, which is never
    /// offered an update.
    public var outlet: HostOutlet?
    /// The build stamp's outlet fields (P1-11), when the host ships one, with the product's
    /// `outletIds` that launcher signals must name.
    public var stamp: OutletStamp?
    /// An outlet detection result the host computed itself. When it is absent and `outlet` is
    /// too, the client detects in-process (`detect`).
    public var detected: DetectedOutlet?
    /// Detect the outlet when neither `outlet` nor `detected` is given: this process's signals
    /// (`readOutletSignals`, with `AppDistributor.current` raced against a 2 s deadline) and the
    /// stamp, through `detectOutlet`, whose result goes to `resolveUpdateOutlet` as `detected`
    /// (plans/P3-01.md §2.9). Default true.
    public var detect: Bool
    /// What the readers look at; this process by default (tests pass a fake install).
    public var outletEnvironment: OutletReaderEnvironment?
    /// The installed build's build number (informational in v4). Default: the main bundle's
    /// `CFBundleVersion`.
    public var buildNumber: String?
    /// The installed build's format (`"dmg"`, `"zip"`, …): a binary build of another format is
    /// never offered. Nil (the default) is any format.
    public var format: String?
    /// What this host can do with a `binary` decision. Default `["native", "download"]` on macOS,
    /// where Sparkle is linked, else `["download"]`.
    public var methods: [String]
    /// The executable's version when it differs from `CoreOptions.version`. Nil means `version`.
    public var binaryVersion: String?
    /// `godot-<major>.<minor>` for a host that runs Godot code packs; nil otherwise.
    public var engine: String?
    /// The install's `Platform` value. Default: this binary's (`macos`, `ios`).
    public var platform: String?
    /// The device's `Arch` value. Default: this binary's (`arm64`, `x86_64`).
    public var arch: String?

    public init(
        pinnedReleaseKeys: TrustSet = [:],
        outlet: HostOutlet? = nil,
        stamp: OutletStamp? = nil,
        detected: DetectedOutlet? = nil,
        detect: Bool = true,
        outletEnvironment: OutletReaderEnvironment? = nil,
        buildNumber: String? = UpdateClientOptions.bundleBuildNumber,
        format: String? = nil,
        methods: [String] = UpdateClientOptions.defaultMethods,
        binaryVersion: String? = nil,
        engine: String? = nil,
        platform: String? = nil,
        arch: String? = nil
    ) {
        self.pinnedReleaseKeys = pinnedReleaseKeys
        self.outlet = outlet
        self.stamp = stamp
        self.detected = detected
        self.detect = detect
        self.outletEnvironment = outletEnvironment
        self.buildNumber = buildNumber
        self.format = format
        self.methods = methods
        self.binaryVersion = binaryVersion
        self.engine = engine
        self.platform = platform
        self.arch = arch
    }

    /// The main bundle's `CFBundleVersion`, when it has one.
    public static var bundleBuildNumber: String? {
        Foundation.Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    }

    /// `["native", "download"]` where Sparkle is linked (macOS), else `["download"]`
    /// (plans/P3-01.md §5, "Host methods").
    public static var defaultMethods: [String] {
        #if os(macOS) && canImport(Sparkle)
        return [BinaryMethod.native, BinaryMethod.download]
        #else
        return [BinaryMethod.download]
        #endif
    }
}

/// `channelFeed()`'s answer: the verified feed `decide()` would decide from.
public struct FeedCheck: Sendable, Equatable {
    /// The canonical channel: the feed's own `channel` claim.
    public let channel: String
    public let feed: ChannelFeedDoc
    public let source: UpdateCheck.FeedSource
    public let errors: [UpdateCheckError]
}

/// `releaseRecord()`'s answer.
public struct ReleaseRecordCheck: Sendable, Equatable {
    public enum Source: String, Sendable, Equatable {
        case network, cache
    }

    public let sha256: String
    public let record: ReleaseRecordDoc
    public let source: Source
    /// True when a committed feed's target for this platform pins the hash: the record was
    /// cross-checked against that pin and committed to the cache.
    public let pinned: Bool
}

/// The validated options.
private struct ConfiguredUpdate: Sendable {
    let releaseKeys: TrustSet
    /// The outlet, when no detection is needed (the host named one or passed `detected`, or
    /// turned detection off); nil until the first decision detects it.
    let outlet: ResolvedOutlet?
    let options: UpdateClientOptions
}

private func invalidOptions(_ message: String) -> PolarisError {
    PolarisError(code: ErrorCode.invalidOptions, message: message)
}

/// Validate `UpdateClientOptions` against the trust pins (plans/P3-01.md §2.6, §2.8).
private func configure(_ opts: UpdateClientOptions, pinnedTrust: TrustSet) throws -> ConfiguredUpdate {
    let pins = Set(pinnedTrust.values.compactMap { Base64URL.decode($0) }.filter { $0.count == 32 })
    for key in opts.pinnedReleaseKeys.values {
        if let raw = Base64URL.decode(key), raw.count == 32, pins.contains(raw) {
            throw invalidOptions(
                "A pinned release key is also a trust pin; a release key is never a product key.")
        }
    }
    if let outlet = opts.outlet, !isValidHostOutlet(outlet) {
        throw invalidOptions("update outlet is not an outlet kind or {id, kind, subkind?}.")
    }
    if let d = opts.detected {
        guard OUTLET_KIND_VALUES.contains(d.kind) || d.kind == OUTLET_UNKNOWN,
            d.subkind.map(OUTLET_SUBKIND_VALUES.contains) ?? true
        else { throw invalidOptions("update detected is not an outlet detection result.") }
    }
    guard opts.methods.allSatisfy(BINARY_METHOD_VALUES.contains) else {
        throw invalidOptions(
            "update methods must be a subset of \(BINARY_METHOD_VALUES.joined(separator: ", ")).")
    }
    if let p = opts.platform, !PLATFORM_VALUES.contains(p) {
        throw invalidOptions("update platform must be one of \(PLATFORM_VALUES.joined(separator: ", ")).")
    }
    if let a = opts.arch, !ARCH_VALUES.contains(a) {
        throw invalidOptions("update arch must be one of \(ARCH_VALUES.joined(separator: ", ")).")
    }
    guard let outlet = resolveUpdateOutlet(host: opts.outlet, stamp: opts.stamp, detected: opts.detected)
    else { throw invalidOptions("update outlet is not a valid outlet.") }
    // §2.9: detection runs at every launch, at the first decision (AppDistributor is async).
    let detects = opts.outlet == nil && opts.detected == nil && opts.detect
    return ConfiguredUpdate(releaseKeys: opts.pinnedReleaseKeys, outlet: detects ? nil : outlet, options: opts)
}

/// Substitute `{name}` placeholders, each percent-encoded as `encodeURIComponent` does, and
/// resolve against the control plane (a discovered template is normally absolute already).
func expandTemplate(_ template: String, baseUrl: String, _ values: [String: String]) -> URL? {
    var allowed = CharacterSet.alphanumerics.intersection(CharacterSet(charactersIn: Unicode.Scalar(0)...Unicode.Scalar(0x7F)))
    allowed.insert(charactersIn: "-_.!~*'()")
    var out = template
    for (k, v) in values {
        guard let encoded = v.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        out = out.replacingOccurrences(of: "{\(k)}", with: encoded)
    }
    return URL(string: out, relativeTo: URL(string: baseUrl + "/"))?.absoluteURL
}

/// The wire code a refusal body names (`{error: {code}}` or `{error: "code"}`), or nil.
private func wireCode(_ body: Data) -> String? {
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: body),
        let error = value.objectValue?["error"]
    else { return nil }
    if let code = error.stringValue, !code.isEmpty { return code }
    if let code = error.objectValue?["code"]?.stringValue, !code.isEmpty { return code }
    return nil
}

/// A code `runUpdateCheck` never produces: `channelFeed()` withholds the record fetch with it.
private let RECORD_WITHHELD = "record-withheld"

public struct VersionCheck: Sendable, Equatable {
    /// The newest version on the requested channel.
    public let version: String
    public let tag: String
    public let url: String
    /// Whether the host APPLICATION's own version is older than `version`. Computed from
    /// `CoreOptions.version`, not the SDK's: the SDK ships inside the thing being updated.
    public let updateAvailable: Bool
}

public actor UpdateClient {
    private let core: CoreContext
    private let configured: ConfiguredUpdate?
    /// The in-process detection, once started: never cached past this client (§2.9). The task,
    /// not its result, so concurrent `decide()` / `outlet()` calls share one detection.
    private var detection: Task<(outlet: ResolvedOutlet, detected: DetectedOutlet?), Never>?
    /// The v4 calls run one at a time: each is a read-modify-write of the cache slices, and the
    /// actor alone would let two interleave at their network awaits.
    private var tail: Task<Void, Never>?

    /// A client for `check()` and the Sparkle helpers. `decide()` and `releaseRecord()` raise
    /// `not-configured` on it: they need `UpdateClientOptions.pinnedReleaseKeys`.
    public init(core: CoreContext) {
        self.core = core
        self.configured = nil
    }

    /// A client for wire v4's signed decision too. Throws `invalid-options` (`PolarisError`) for
    /// an outlet outside the vocabularies, a method outside `BINARY_METHOD_VALUES`, a platform or
    /// arch outside the enums, or a pinned release key whose raw bytes are also a trust pin.
    public init(core: CoreContext, options: UpdateClientOptions) throws {
        self.core = core
        self.configured = try configure(options, pinnedTrust: core.pinnedTrust)
    }

    /// The outlet `decide()` uses (`resolveUpdateOutlet`'s answer), detecting it first when the
    /// host named none; nil without update options. For support diagnostics and UI.
    public func outlet() async -> ResolvedOutlet? {
        guard let configured else { return nil }
        return await resolvedOutlet(configured).outlet
    }

    /// The detection result: the in-process one, or the host's `detected` as given (even when the
    /// host's `outlet` wins); nil when the host passed no `detected` and named the outlet or
    /// turned detection off, or configured no updates.
    public func detected() async -> DetectedOutlet? {
        guard let configured else { return nil }
        return await resolvedOutlet(configured).detected
    }

    private func resolvedOutlet(_ c: ConfiguredUpdate) async -> (outlet: ResolvedOutlet, detected: DetectedOutlet?) {
        // The host's `detected` is reported as given, even when its `outlet` wins (as in Node and
        // Python); nil when it passed none.
        if let outlet = c.outlet { return (outlet, c.options.detected) }
        if let detection { return await detection.value }
        let options = c.options
        let task = Task { () -> (outlet: ResolvedOutlet, detected: DetectedOutlet?) in
            let stamp = detectionStamp(options.stamp)
            let signals = await readOutletSignals(
                options.outletEnvironment ?? .process(), outletIds: stamp?.outletIds ?? [:])
            let detected = detectOutlet(stamp: stamp, signals: signals)
            let outlet =
                resolveUpdateOutlet(host: nil, stamp: options.stamp, detected: detected)
                ?? ResolvedOutlet(id: nil, kind: OUTLET_UNKNOWN, subkind: nil)
            return (outlet: outlet, detected: Optional(detected))
        }
        detection = task
        return await task.value
    }

    /// `GET /<p>/update/version` — the newest build, and whether we are behind it.
    ///
    /// Refuses when the product does not run Update (D-21), before a socket is opened: a
    /// disabled service and a missing route answer with the same 404 server-side, so probing
    /// would tell the caller nothing the capability map does not already say.
    public func check(channel: String? = nil) async throws -> VersionCheck {
        try await core.requireService(.update, feature: Feature.updateCheck)
        var components = URLComponents(
            url: core.endpoints.updateVersion, resolvingAgainstBaseURL: false)
        if let channel {
            components?.queryItems = [URLQueryItem(name: "channel", value: channel)]
        }
        guard let url = components?.url else {
            throw PolarisError(code: "bad_request", message: "could not build update/version URL")
        }

        var headers: [String: String] = [:]
        // The token is sent when we hold one: `entitled` products need it, and `public` ones
        // ignore it. Sending it unconditionally is what keeps the caller from having to know
        // which access mode the product is on.
        if let token = await core.token { headers["authorization"] = "Bearer \(token)" }

        let response = try await core.request(url, headers: headers)
        if response.status == 403 {
            let body = try? JSONDecoder().decode(WireErrorBody.self, from: response.body)
            throw PolarisError(
                code: body?.error?.code ?? "forbidden",
                message: "This build is not entitled to that update channel.")
        }
        guard response.isOK else {
            throw PolarisError(
                code: "not_found",
                message: "update/version failed with status \(response.status).")
        }
        guard let body = try? JSONDecoder().decode(VersionBody.self, from: response.body) else {
            throw PolarisError(
                code: "bad_request", message: "malformed update/version response")
        }
        return VersionCheck(
            version: body.version, tag: body.tag, url: body.url,
            updateAvailable: Semver.compare(core.version, body.version) < 0)
    }

    /// The Sparkle feed for a channel, derived from the discovery document Core loaded.
    ///
    /// Returns nil when discovery has not run or Update is not enabled — see
    /// `UpdateFeedBuilder.feed` for why that is a value rather than an error.
    public func feed(
        channel: String = "stable",
        arch: UpdateArch? = UpdateArch.current,
        entitlements: [String: JSONValue] = [:]
    ) async -> UpdateFeed? {
        guard let document = await core.discoveryDocument else { return nil }
        return UpdateFeedBuilder.feed(
            from: document, channel: channel, arch: arch, entitlements: entitlements)
    }

    /// The headers Sparkle must send with its own feed requests in `entitled` mode.
    public func feedHeaders(channel: String = "stable") async -> [String: String] {
        UpdateFeedBuilder.feedHeaders(
            token: await core.token, version: core.version, channel: channel,
            deviceId: await core.deviceId)
    }
}

// ── Wire v4 ─────────────────────────────────────────────────────────────────────────────────

extension UpdateClient {
    /// The signed update decision (plans/P3-01.md §2.5 steps 1–18): fetch the channel feed,
    /// verify it against the effective product trust set and the channel's `seq` floor, commit
    /// it, fetch the release record it pins for this platform (hash before signature, pinned
    /// release keys only), and decide. Returns the `UpdateCheck`; its `channel` is the canonical
    /// channel a host records as `StagedUpdate.channel`.
    ///
    /// After a refusal it decides from the committed feed, reporting the refusal in `errors`; a
    /// record that cannot be fetched or is refused is nil for the call. It throws `PolarisError`
    /// only when it has nothing to decide from (`feed-rejected` with the step as `detail`,
    /// `feed-rollback`, `network-error` or the Worker's wire code), and for `not-configured` (no
    /// `pinnedReleaseKeys`), `service-unavailable` (no Update service, or a discovery document
    /// without the v4 endpoints — fall back to `check()`) and `local-only`.
    ///
    /// Discovery is fetched first when this session has not loaded it. When the network is down
    /// the decision still comes from the committed feed (a stale one answers `none {stale}`).
    /// A `mandatory` or `blocked` answer is a prompt the player cannot dismiss over an app that
    /// keeps running (`isUndismissable`); no v4 answer stops the app (`bootDecision`).
    public func decide(
        channel: String? = nil, staged: StagedUpdate? = nil, skipVersion: String? = nil
    ) async throws -> UpdateCheck {
        try await serialized { try await self.decideNow(channel: channel, staged: staged, skipVersion: skipVersion) }
    }

    /// The verified feed `decide()` would decide from (§2.5 steps 1–10), without the record. It
    /// runs the same steps, commits an accepted feed the same way and falls back to the committed
    /// feed the same way; it needs no release keys.
    public func channelFeed(channel: String? = nil) async throws -> FeedCheck {
        try await serialized { try await self.channelFeedNow(channel: channel) }
    }

    /// One release record by its lowercase hex SHA-256 (§2.5 steps 11–16): from the cache, else
    /// `GET …/release/records/{sha256}`; the body's hash must equal `hash` before any signature
    /// work, and the signature must come from a PINNED release key. When a committed feed's
    /// target for this platform pins the hash, the record is cross-checked against that pin and
    /// committed; otherwise it is verified only. Throws `record-rejected` (`detail`: `hash`, `jws`
    /// or `claims`), `record-mismatch`, a transport code, `not-configured` or
    /// `service-unavailable`.
    public func releaseRecord(hash: String) async throws -> ReleaseRecordCheck {
        try await serialized { try await self.releaseRecordNow(hash) }
    }

    /// A build's download URL (plans/P3-01.md §2.4 "Bytes", decision 5): discovery's
    /// `distribution.endpoints.builds`, else Release's `release.endpoints.builds`, with
    /// `{selector}` = the record's `version` and `{buildId}` = the build's `id`, each
    /// percent-encoded. That route serves the build's payload from every location it has; the
    /// R2-only blob route is never used. Verify the bytes against the record's `size` and
    /// `sha256` before staging. Nil when discovery has not been loaded or names neither template.
    public func buildURL(version: String, buildId: String) async -> URL? {
        guard let doc = await core.discoveryDocument,
            let template = doc.services[.distribution]?.endpoints["builds"]
                ?? doc.services[.release]?.endpoints["builds"]
        else { return nil }
        return expandTemplate(
            template, baseUrl: core.endpoints.baseUrl, ["selector": version, "buildId": buildId])
    }

    // ── Internals ───────────────────────────────────────────────────────────────────────────

    private func serialized<T: Sendable>(
        _ work: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let previous = tail
        let task = Task { () async throws -> T in
            await previous?.value
            return try await work()
        }
        tail = Task { _ = try? await task.value }
        return try await task.value
    }

    private func requireKeys() throws -> ConfiguredUpdate {
        guard let configured, !configured.releaseKeys.isEmpty else {
            throw PolarisError(
                code: ErrorCode.notConfigured,
                message: "Update decisions need UpdateClientOptions.pinnedReleaseKeys.")
        }
        return configured
    }

    private var platformValue: String? { configured?.options.platform ?? PlatformFamily.headerValue }

    private func installed() throws -> InstalledBuild {
        let opts = configured?.options
        guard let platform = platformValue, let arch = opts?.arch ?? ArchFamily.headerValue else {
            throw PolarisError(
                code: ErrorCode.notConfigured,
                message: "This host's platform or arch has no canonical value; set UpdateClientOptions.platform and arch.")
        }
        return InstalledBuild(
            version: core.version, binaryVersion: opts?.binaryVersion,
            buildNumber: opts?.buildNumber, platform: platform, arch: arch, format: opts?.format,
            engine: opts?.engine)
    }

    /// §2.5 step 1: the feed and record templates from discovery, loading discovery first when
    /// this session has not. A loaded document that lacks a needed one is refused as
    /// `service-unavailable` before dialling. When discovery itself cannot be reached, nil: the
    /// fetches then fail as a transport failure and the decision comes from the committed feed.
    private func endpoints(feed: Bool, record: Bool) async throws -> (feed: String, record: String)? {
        var doc = await core.discoveryDocument
        if doc == nil {
            if core.localOnly {
                throw PolarisError(
                    code: PolarisError.localOnly,
                    message: "This client is in local-only mode; network calls are refused.")
            }
            await core.discover()
            doc = await core.discoveryDocument
        }
        guard let doc else { return nil }
        let feedTemplate = doc.services[.update]?.endpoints["feed"]
        let recordTemplate = doc.services[.release]?.endpoints["record"]
        if (feed && feedTemplate == nil) || (record && recordTemplate == nil) {
            throw PolarisError(
                code: ErrorCode.serviceUnavailable,
                message: "This Worker serves no signed update feed (wire v4); use check().")
        }
        return (feedTemplate ?? "", recordTemplate ?? "")
    }

    /// One `application/jose` GET. Never throws: a transport failure or a non-2xx answer is the
    /// Worker's wire code when its body names one, else `network-error`. The device bearer goes
    /// only to the control plane's own origin, never to a host a discovery document named.
    private func getJose(_ url: URL?, maxBytes: Int? = nil) async -> FetchOutcome {
        guard let url else { return .failed(code: ErrorCode.networkError) }
        var headers = ["accept": "application/jose"]
        if let token = await core.token, sameOrigin(url) {
            headers["authorization"] = "Bearer \(token)"
        }
        do {
            let response = try await core.request(
                url, headers: headers, maxBodyBytes: maxBytes.map { $0 + 1 })
            guard response.isOK else {
                return .failed(code: wireCode(response.body) ?? ErrorCode.networkError)
            }
            // Bounded again here whatever the transport did: a record body longer than
            // `MAX_RECORD_JWS_BYTES` is refused at step 12 from this prefix, without hashing.
            let body = maxBytes.map { response.body.prefix($0 + 1) } ?? response.body
            return .ok(String(decoding: body, as: UTF8.self))
        } catch {
            return .failed(code: ErrorCode.networkError)
        }
    }

    private func sameOrigin(_ url: URL) -> Bool {
        guard let base = URL(string: core.endpoints.baseUrl) else { return false }
        return url.scheme?.lowercased() == base.scheme?.lowercased()
            && url.host?.lowercased() == base.host?.lowercased() && url.port == base.port
    }

    private func feedURL(_ template: String?, channel: String, platform: String) -> URL? {
        guard let template,
            let url = expandTemplate(template, baseUrl: core.endpoints.baseUrl, ["channel": channel]),
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "platform", value: platform)]
        return components.url
    }

    private func recordURL(_ template: String?, sha256: String) -> URL? {
        guard let template else { return nil }
        return expandTemplate(template, baseUrl: core.endpoints.baseUrl, ["sha256": sha256])
    }

    private func raise(_ error: UpdateCheckError) -> PolarisError {
        PolarisError(
            code: error.code,
            message: error.detail.map { "update: \(error.code) (\($0))" } ?? "update: \(error.code)",
            detail: error.detail)
    }

    private func decideNow(
        channel: String?, staged: StagedUpdate?, skipVersion: String?
    ) async throws -> UpdateCheck {
        let c = try requireKeys()
        try await core.requireService(.update, feature: Feature.updateDecide)
        let installed = try installed()
        let outlet = await resolvedOutlet(c).outlet
        let ep = try await endpoints(feed: true, record: true)
        let slices = await core.updateSlices()
        let deviceId = await core.deviceId
        let input = UpdateCheckInput(
            channel: channel ?? core.channel, expectedAud: core.product, trust: await core.trust,
            releaseKeys: c.releaseKeys,
            // §2.5: the effective clock, max(system, highWaterMark) (V3 §4.2).
            now: await core.now(),
            installId: deviceId.isEmpty ? nil : deviceId, installed: installed,
            outlet: outlet.outlet, subkind: outlet.subkind, staged: staged,
            skipVersion: skipVersion, methods: c.options.methods, feeds: slices.feeds,
            releaseRecords: slices.releaseRecords)
        let feedTemplate = ep?.feed
        let recordTemplate = ep?.record
        let platform = installed.platform
        let outcome = await runUpdateCheck(
            input,
            fetchFeed: { requested in
                await self.getJose(self.feedURL(feedTemplate, channel: requested, platform: platform))
            },
            fetchRecord: { sha256 in
                await self.getJose(
                    self.recordURL(recordTemplate, sha256: sha256), maxBytes: MAX_RECORD_JWS_BYTES)
            })
        switch outcome {
        case .failed(let error):
            throw raise(error)
        case .ok(let run):
            await core.commitUpdateSlices(feeds: run.feeds, releaseRecords: run.releaseRecords)
            return run.check
        }
    }

    private func channelFeedNow(channel: String?) async throws -> FeedCheck {
        try await core.requireService(.update, feature: Feature.updateFeed)
        let installed = try installed()
        let ep = try await endpoints(feed: true, record: false)
        let slices = await core.updateSlices()
        // The same steps as `decide()`, by the same function, with the record fetch withheld: the
        // order, the floors and the fallback cannot differ between the two. The decision it makes
        // over no record is discarded, and only the `feeds` slice is written.
        let input = UpdateCheckInput(
            channel: channel ?? core.channel, expectedAud: core.product, trust: await core.trust,
            releaseKeys: configured?.releaseKeys ?? [:], now: await core.now(), installId: nil,
            installed: installed, outlet: UpdateOutlet(id: nil, kind: OUTLET_UNKNOWN),
            subkind: nil, methods: [], feeds: slices.feeds, releaseRecords: [:])
        let feedTemplate = ep?.feed
        let platform = installed.platform
        let outcome = await runUpdateCheck(
            input,
            fetchFeed: { requested in
                await self.getJose(self.feedURL(feedTemplate, channel: requested, platform: platform))
            },
            fetchRecord: { _ in .failed(code: RECORD_WITHHELD) })
        switch outcome {
        case .failed(let error):
            throw raise(error)
        case .ok(let run):
            await core.commitUpdateSlices(feeds: run.feeds)
            return FeedCheck(
                channel: run.check.channel, feed: run.feed, source: run.check.feed,
                errors: run.check.errors.filter { $0.code != RECORD_WITHHELD })
        }
    }

    private func releaseRecordNow(_ sha256: String) async throws -> ReleaseRecordCheck {
        let c = try requireKeys()
        try await core.requireService(.release, feature: Feature.releaseRecord)
        let installed = try installed()
        let ep = try await endpoints(feed: false, record: true)
        let slices = await core.updateSlices()
        let trust = await core.trust

        // The pin, from a committed feed that still verifies (the reload path).
        let committed = reloadFeeds(
            slices.feeds, trust: trust, expectedAud: core.product, platform: installed.platform)
        var pin: ReleaseRecordPin?
        for cf in committed.feeds.values {
            if let t = feedTarget(cf.feed.app.targets, platform: installed.platform),
                t.release.sha256 == sha256
            {
                pin = ReleaseRecordPin(deliverable: "app", version: t.release.version, seq: t.release.seq)
                break
            }
        }
        let opts = VerifyReleaseRecordOptions(
            releaseKeys: c.releaseKeys, productTrust: trust, expectedAud: core.product,
            expectedHash: sha256, pin: pin)

        if let cached = slices.releaseRecords[sha256],
            let record = verifyReleaseRecord(cached, options: opts).record
        {
            return ReleaseRecordCheck(sha256: sha256, record: record, source: .cache, pinned: pin != nil)
        }

        switch await getJose(recordURL(ep?.record, sha256: sha256), maxBytes: MAX_RECORD_JWS_BYTES) {
        case .failed(let code):
            throw raise(UpdateCheckError(code: code))
        case .ok(let body):
            switch verifyReleaseRecord(body, options: opts) {
            case .refused(.crossCheck):
                throw raise(UpdateCheckError(code: ErrorCode.recordMismatch))
            case .refused(let step):
                throw raise(UpdateCheckError(code: ErrorCode.recordRejected, detail: step.rawValue))
            case .ok(let record):
                if pin != nil {
                    var records = slices.releaseRecords
                    records[sha256] = body
                    await core.commitUpdateSlices(releaseRecords: records)
                }
                return ReleaseRecordCheck(
                    sha256: sha256, record: record, source: .network, pinned: pin != nil)
            }
        }
    }
}

private struct VersionBody: Decodable {
    let version: String
    let tag: String
    let url: String
}

private struct WireErrorBody: Decodable {
    struct Nested: Decodable {
        let code: String?
    }
    let error: Nested?
}
