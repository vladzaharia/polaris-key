// PolarisKeyUpdate — the derivations, the URL/header assembly, and the Sparkle anchor assertion
// (D-24).
//
// No Sparkle is instantiated here, deliberately: driving a real `SPUUpdater` in CI would need a
// signed application bundle, a user driver and a main run loop, and would test Sparkle rather
// than this SDK. What IS tested is everything Polaris Key actually decides — which feed URL, which
// arch, which channels, which headers, and whether the host bundle carries the anchor at all.
// The Sparkle-touching code is compile-tested by virtue of the target building with the
// framework linked.

import Foundation
import PolarisKeyCore
import PolarisKeyUpdate
import XCTest

final class UpdateTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func discovery(
        updateEnabled: Bool = true, channelTemplate: Bool = true
    ) -> ProductDiscoveryDocument {
        var endpoints = [
            "version": "https://key.example/djdl/update/version",
            "appcast": "https://key.example/djdl/update/appcast.xml",
        ]
        if channelTemplate {
            endpoints["channelAppcast"] =
                "https://key.example/djdl/update/{channel}/appcast.xml"
        }
        return ProductDiscoveryDocument(
            product: "djdl",
            services: [
                .license: ServiceFragment(enabled: true),
                .config: ServiceFragment(enabled: true),
                .release: .disabled,
                .update: ServiceFragment(enabled: updateEnabled, endpoints: endpoints),
                .identity: .disabled,
            ])
    }

    // ── Feed URL construction ────────────────────────────────────────────────────────
    // @pkey-feature update.driver
    /// The feed comes from the PUBLISHED fragment, not from string-building: §R1 moved these
    /// paths and left aliases behind, so a host that hard-codes one breaks the next time they
    /// move.
    func testFeedUrlComesFromDiscovery() {
        let feed = UpdateFeedBuilder.feed(from: discovery(), arch: .arm64)
        XCTAssertEqual(
            feed?.url.absoluteString,
            "https://key.example/djdl/update/appcast.xml?arch=arm64")
        XCTAssertEqual(feed?.channel, "stable")
        XCTAssertEqual(feed?.arch, .arm64)
    }

    /// The arch is a QUERY parameter, and this SDK always sends it: the unparameterized feed
    /// serves `arm64` for continuity with shipped `SUFeedURL`s, so an Intel Mac that omitted it
    /// would silently check the wrong feed.
    func testArchIsAlwaysSentAndNeverDuplicated() {
        let x86 = UpdateFeedBuilder.feed(from: discovery(), arch: .x86_64)
        XCTAssertEqual(
            x86?.url.absoluteString,
            "https://key.example/djdl/update/appcast.xml?arch=x86_64")
        // Nil arch omits the parameter entirely rather than emitting `arch=`.
        let none = UpdateFeedBuilder.feed(from: discovery(), arch: nil)
        XCTAssertEqual(
            none?.url.absoluteString, "https://key.example/djdl/update/appcast.xml")
    }

    func testArchNormalization() {
        XCTAssertEqual(UpdateArch.normalize("aarch64"), .arm64)
        XCTAssertEqual(UpdateArch.normalize("ARM64"), .arm64)
        XCTAssertEqual(UpdateArch.normalize("amd64"), .x86_64)
        XCTAssertEqual(UpdateArch.normalize("x86_64"), .x86_64)
        // A typo surfaces as nil rather than as an unnoticed wrong-feed check.
        XCTAssertNil(UpdateArch.normalize("ppc64"))
    }

    // @pkey-feature update.driver
    /// A channel feed is a PATH sibling, not a query parameter. The Worker publishes a
    /// `{channel}` template; preferring it keeps the substitution the product's decision.
    func testChannelFeedUsesThePublishedTemplate() {
        let feed = UpdateFeedBuilder.feed(from: discovery(), channel: "beta", arch: .arm64)
        XCTAssertEqual(
            feed?.url.absoluteString,
            "https://key.example/djdl/update/beta/appcast.xml?arch=arm64")
        XCTAssertEqual(feed?.channel, "beta")
    }

    /// …and without the template, the stable feed's path is rewritten into its sibling.
    func testChannelFeedFallsBackToPathRewriting() {
        let feed = UpdateFeedBuilder.feed(
            from: discovery(channelTemplate: false), channel: "beta", arch: .arm64)
        XCTAssertEqual(
            feed?.url.absoluteString,
            "https://key.example/djdl/update/beta/appcast.xml?arch=arm64")
    }

    /// `stable` is the unnamed default: it names the published feed itself, never a sibling.
    func testStableChannelDoesNotRewriteThePath() {
        let feed = UpdateFeedBuilder.feed(from: discovery(), channel: "stable", arch: nil)
        XCTAssertEqual(
            feed?.url.absoluteString, "https://key.example/djdl/update/appcast.xml")
    }

    /// Fail-closed (D-21), expressed as a value: asking "where is my feed?" for a product that
    /// does not run Update is a sequencing question, not an error.
    func testDisabledUpdateServiceYieldsNoFeed() {
        XCTAssertNil(UpdateFeedBuilder.feed(from: discovery(updateEnabled: false)))
        XCTAssertNil(appcastUrl(from: discovery(updateEnabled: false)))
    }

    // ── allowedChannels (D-13) ───────────────────────────────────────────────────────
    /// The honest answer is whatever the SIGNED licence granted — not whatever the host
    /// hard-coded, which is how a stable-only customer ends up being offered a beta build the
    /// server then refuses to serve.
    func testAllowedChannelsComesFromTheEntitlement() {
        XCTAssertEqual(
            UpdateFeedBuilder.allowedChannels(from: [
                "channels": .array([.string("stable"), .string("beta")])
            ]),
            ["stable", "beta", "staging"])
    }

    /// `stable` is always included: it is the unnamed default channel, and a licence that grants
    /// nothing still gets the release build.
    func testStableIsAlwaysAllowed() {
        XCTAssertEqual(UpdateFeedBuilder.allowedChannels(from: [:]), ["stable"])
        XCTAssertEqual(
            UpdateFeedBuilder.allowedChannels(from: ["channels": .array([])]), ["stable"])
        XCTAssertEqual(
            UpdateFeedBuilder.allowedChannels(from: ["channels": .array([.string("pr")])]),
            ["stable", "pr"])
    }

    /// A malformed entitlement narrows to stable rather than widening to everything — the same
    /// fail-closed posture the capability map takes.
    func testMalformedChannelsEntitlementNarrowsToStable() {
        XCTAssertEqual(
            UpdateFeedBuilder.allowedChannels(from: ["channels": .string("beta")]), ["stable"])
        XCTAssertEqual(
            UpdateFeedBuilder.allowedChannels(from: [
                "channels": .array([.int(1), .string("")])
            ]), ["stable"])
    }

    /// `staging` is the legacy spelling of `beta` (WIRE-CONTRACT-V3 §5.1, P0-04): each grant
    /// also allows the other spelling, as the server's `entitled` feed check treats them.
    func testStagingAndBetaGrantsCoverEachOther() {
        XCTAssertEqual(
            UpdateFeedBuilder.allowedChannels(from: [
                "channels": .array([.string("stable"), .string("staging")])
            ]),
            ["stable", "staging", "beta"])
        XCTAssertEqual(
            UpdateFeedBuilder.allowedChannels(from: ["channels": .array([.string("beta")])]),
            ["stable", "beta", "staging"])
        XCTAssertEqual(
            UpdateFeedBuilder.allowedChannels(from: ["channels": .array([.string("nightly")])]),
            ["stable", "nightly"])
    }

    func testFeedCarriesTheDerivedChannels() {
        let feed = UpdateFeedBuilder.feed(
            from: discovery(), channel: "beta", arch: .arm64,
            entitlements: ["channels": .array([.string("beta")])])
        XCTAssertEqual(feed?.allowedChannels, ["stable", "beta", "staging"])
    }

    // ── entitled-mode headers ────────────────────────────────────────────────────────
    // @pkey-feature update.driver
    /// In `entitled` mode the appcast itself is behind the device credential, so Sparkle's OWN
    /// requests need the bearer token — that is what `SPUUpdater.httpHeaders` is for.
    func testEntitledFeedHeadersCarryTheBearerToken() {
        let headers = UpdateFeedBuilder.feedHeaders(
            token: "pkeyt_abc", version: "1.2.3", channel: "beta", deviceId: "dev_1")
        XCTAssertEqual(headers["Authorization"], "Bearer pkeyt_abc")
        XCTAssertEqual(headers[HEADER_DEVICE], "dev_1")
        XCTAssertEqual(headers[HEADER_VERSION], "1.2.3")
        XCTAssertEqual(headers[HEADER_CHANNEL], "beta")
        XCTAssertEqual(headers[HEADER_SDK_NAME], POLARIS_SDK_NAME)
        // WIRE-CONTRACT-V3 §5.2: the short SDK id and the canonical platform.
        XCTAssertEqual(headers[HEADER_SDK_NAME], "swift")
        XCTAssertEqual(headers[HEADER_PLATFORM], PlatformFamily.headerValue)
        XCTAssertEqual(headers[HEADER_ARCH], ArchFamily.headerValue)
    }

    /// A `public` product sends no credential — but still identifies itself, so the Worker's
    /// device-row bookkeeping sees update traffic too.
    func testPublicFeedHeadersOmitTheAuthorization() {
        let headers = UpdateFeedBuilder.feedHeaders(
            token: nil, version: "1.2.3", channel: "stable", deviceId: "dev_1")
        XCTAssertNil(headers["Authorization"])
        XCTAssertEqual(headers[HEADER_DEVICE], "dev_1")
        let empty = UpdateFeedBuilder.feedHeaders(
            token: "", version: "1.2.3", channel: "stable", deviceId: "dev_1")
        XCTAssertNil(empty["Authorization"], "an empty token is not a credential")
    }

    // ── The SUPublicEDKey anchor (D-24) ──────────────────────────────────────────────
    // @pkey-feature update.driver
    /// The failure this catches is real and SILENT: an app that ships Sparkle without
    /// `SUPublicEDKey` does not fail to build, launch, or check for updates — it simply installs
    /// unsigned payloads.
    func testAnchorAssertionRejectsAMissingOrEmptyKey() {
        XCTAssertThrowsError(
            try SparkleAnchor.assertPresent(infoDictionary: [:], bundleIdentifier: "com.x")
        ) { error in
            XCTAssertEqual(
                error as? SparkleAnchorError, .missingPublicEDKey(bundleIdentifier: "com.x"))
        }
        XCTAssertThrowsError(
            try SparkleAnchor.assertPresent(infoDictionary: nil, bundleIdentifier: nil))
        for bad: Any in ["", "   ", 42, ["a"]] {
            XCTAssertThrowsError(
                try SparkleAnchor.assertPresent(
                    infoDictionary: [SparkleAnchor.publicEDKeyInfoKey: bad],
                    bundleIdentifier: "com.x"),
                "\(bad) is not an EdDSA public key")
        }
    }

    func testAnchorAssertionAcceptsAPresentKey() throws {
        try SparkleAnchor.assertPresent(
            infoDictionary: [
                SparkleAnchor.publicEDKeyInfoKey: "1zXxk3l3ZbEy0AWjqSK2gVqPr0PgQ0Y6vXTs6dYPqPQ="
            ], bundleIdentifier: "com.example.djdl")
    }

    /// The message is the point: an operator reading it must know what to add and where.
    func testAnchorErrorExplainsTheRemedy() {
        let error = SparkleAnchorError.missingPublicEDKey(bundleIdentifier: "com.example.djdl")
        XCTAssertTrue(error.description.contains("SUPublicEDKey"))
        XCTAssertTrue(error.description.contains("com.example.djdl"))
        XCTAssertTrue(error.description.contains("generate_keys"))
    }

    /// The Info.plist key is spelled exactly as Sparkle reads it. It is a literal rather than an
    /// import because `SUConstants.h` is not part of Sparkle's public module — and because the
    /// key belongs to the HOST bundle, not to Sparkle.
    func testAnchorInfoKeySpelling() {
        XCTAssertEqual(SparkleAnchor.publicEDKeyInfoKey, "SUPublicEDKey")
    }

    // ── /update/version ──────────────────────────────────────────────────────────────
    private func core(
        version: String = "1.0.0", services: [ServiceSlug] = [.update]
    ) throws -> CoreContext {
        try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: version,
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"),
                transport: server.transport, expectedServices: services))
    }

    // @pkey-feature update.check
    /// `updateAvailable` is computed from the HOST APPLICATION's version, not the SDK's — the SDK
    /// ships inside the thing being updated — and with the same comparator the server's build
    /// gate uses, so a version check can never recommend a build the gate then blocks.
    func testVersionCheckComparesTheHostVersion() async throws {
        await server.reply(
            "/djdl/update/version",
            body: #"{"version":"2.0.0","tag":"v2.0.0","url":"https://example/v2"}"#)
        let behind = try core(version: "1.0.0")
        try await behind.start()
        let r = try await UpdateClient(core: behind).check()
        XCTAssertEqual(r.version, "2.0.0")
        XCTAssertEqual(r.tag, "v2.0.0")
        XCTAssertTrue(r.updateAvailable)

        let current = try core(version: "2.0.0")
        try await current.start()
        let atLatest = try await UpdateClient(core: current).check()
        XCTAssertFalse(atLatest.updateAvailable)

        let ahead = try core(version: "3.0.0")
        try await ahead.start()
        let beyond = try await UpdateClient(core: ahead).check()
        XCTAssertFalse(beyond.updateAvailable)
    }

    // @pkey-feature update.check
    /// The `entitled` refusal carries the server's machine-readable code, so a host can tell
    /// "not entitled to that channel" from "the feed is down".
    func testEntitledRefusalSurfacesTheWireCode() async throws {
        await server.reply(
            "/djdl/update/version", status: 403,
            body: #"{"error":{"code":"channel_not_allowed"}}"#)
        let c = try core()
        try await c.start()
        do {
            _ = try await UpdateClient(core: c).check(channel: "beta")
            XCTFail("a 403 must surface")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, "channel_not_allowed")
        }
        let request = await server.requests(forPath: "/djdl/update/version").last
        XCTAssertEqual(request?.url.query, "channel=beta")
    }

    // @pkey-feature update.check
    /// D-21 — the sub-client refuses before a socket is opened when the product does not run
    /// Update at all.
    func testUpdateClientRefusesWhenTheServiceIsDisabled() async throws {
        let c = try core(services: [.license])
        try await c.start()
        do {
            _ = try await UpdateClient(core: c).check()
            XCTFail("a disabled service must refuse")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, PolarisError.serviceUnavailable)
        }
        let requests = await server.requests
        XCTAssertTrue(requests.isEmpty, "…and must not have dialled")
    }

    /// The feed is nil until discovery has run — it is the product's own statement of where its
    /// feed lives, and inventing one would be the string-building this target exists to remove.
    func testFeedIsNilBeforeDiscovery() async throws {
        let c = try core()
        try await c.start()
        let feed = await UpdateClient(core: c).feed()
        XCTAssertNil(feed)
    }
}

// ── Wire v4: UpdateClient.decide(), channelFeed(), releaseRecord() (plans/P3-01.md §2.5–§2.8) ──
//
// @pkey-feature update.feed release.record update.decide
//
// The corpus proves the pure functions (ConformanceTests' feed and record sections,
// UpdateMatrixTests); these prove the wiring around them: the cache slices across a restart, the
// floor derived from a re-verified cached JWS, hash before signature, the effective clock, the
// fallback after a refusal, the options refusals, the bearer's origin and the record-body bound.

final class UpdateDecideTests: XCTestCase {
    private let product = TestSigner(kid: "prod-2026")
    private let releaseKey = TestSigner(kid: "rel-2026")
    private let t0 = 1_700_000_000
    private var server = StubServer()
    private let artifactSha = String(repeating: "c", count: 64)

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    // ── Fixtures ─────────────────────────────────────────────────────────────────────

    private func recordJws(version: String = "1.3.0", seq: Int = 1, signer: TestSigner? = nil) -> String {
        let payload = """
            {"schemaVersion":1,"aud":"djdl","deliverable":"app","kind":"app","version":"\(version)",\
            "seq":\(seq),"issuedAt":\(t0 - 1000),"channel":"stable","builds":[{"id":"macos",\
            "platform":"macos","arch":"universal","format":"dmg","artifacts":[{"name":"x.dmg",\
            "role":"payload","sha256":"\(artifactSha)","size":1000}]}]}
            """
        return (signer ?? releaseKey).sign(payloadJSON: payload, typ: JwsTyp.release.rawValue)
    }

    private func feedJws(
        seq: Int, issuedAt: Int, channel: String = "stable", pin: String, version: String = "1.3.0",
        pinSeq: Int = 1, floor: String? = nil
    ) -> String {
        let floorJSON = floor.map { #"{"minVersion":"\#($0)"}"# } ?? "null"
        let payload = """
            {"schemaVersion":1,"iss":"key.plrs.im","aud":"djdl","channel":"\(channel)",\
            "selector":{},"seq":\(seq),"issuedAt":\(issuedAt),"expiresAt":\(issuedAt + 900),\
            "app":{"deliverable":"app","versionScheme":"semver","targets":[{"platform":"macos",\
            "release":{"sha256":"\(pin)","seq":\(pinSeq),"version":"\(version)"},\
            "floor":\(floorJSON),"critical":false,"outlets":{"direct":{"kind":"direct",\
            "live":{"version":"\(version)","seq":\(pinSeq)},"halted":false}}}]}}
            """
        return product.sign(payloadJSON: payload, typ: JwsTyp.feed.rawValue)
    }

    private func discoveryBody(feedBase: String = "https://key.example", v4: Bool = true) -> String {
        let feed = v4 ? #","endpoints":{"feed":"\#(feedBase)/djdl/update/{channel}/feed.jws"}"# : ""
        let record = v4 ? #","endpoints":{"record":"https://key.example/djdl/release/records/{sha256}"}"# : ""
        return """
            {"product":"djdl","services":{"release":{"enabled":true\(record)},\
            "distribution":{"enabled":true,"endpoints":{"builds":"https://key.example/djdl/distribution/builds/{selector}/{buildId}"}},\
            "update":{"enabled":true\(feed)}}}
            """
    }

    private func makeCore(
        store: InMemoryStore, clock: ReplayClock, feedBase: String = "https://key.example",
        v4: Bool = true
    ) async throws -> CoreContext {
        let body = discoveryBody(feedBase: feedBase, v4: v4)
        await server.reply("/djdl/.well-known/polaris.json", body: body)
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.2.0",
                pinnedKeys: product.trust, store: store, transport: server.transport,
                expectedServices: [.release, .distribution, .update], clock: { clock.now }))
        try await core.start()
        return core
    }

    private func options(keys: TrustSet? = nil) -> UpdateClientOptions {
        UpdateClientOptions(
            pinnedReleaseKeys: keys ?? releaseKey.trust, outlet: .kind("direct"),
            buildNumber: "120", format: "dmg", methods: [BinaryMethod.download],
            platform: Platform.macos, arch: Arch.arm64)
    }

    private func serve(feed: String? = nil, record: String? = nil, channel: String = "stable") async {
        if let feed { await server.reply("/djdl/update/\(channel)/feed.jws", body: feed) }
        if let record {
            await server.reply("/djdl/release/records/\(recordHash(record))", body: record)
        }
    }

    // ── The happy path, and the cache ───────────────────────────────────────────────

    func testDecideCommitsTheFeedAndRecordThenDecidesFromTheCache() async throws {
        let record = recordJws()
        let feed = feedJws(seq: 1, issuedAt: t0, pin: recordHash(record))
        await serve(feed: feed, record: record)
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        let client = try UpdateClient(core: core, options: options())

        let first = try await client.decide()
        XCTAssertEqual(first.channel, "stable")
        XCTAssertEqual(first.feed, .network)
        XCTAssertEqual(first.record, .network)
        XCTAssertEqual(first.errors, [])
        guard case .binary(let method, let release, let build, false, false, [], false) = first.decision
        else { return XCTFail("\(first.decision)") }
        XCTAssertEqual(method, BinaryMethod.download)
        XCTAssertEqual(release, DecisionRelease(version: "1.3.0", seq: 1, sha256: recordHash(record)))
        XCTAssertEqual(build, "macos")
        XCTAssertEqual(first.boot, .optional)
        // The feed is requested by the requested name, with the platform always sent.
        let v1 = await server.requests(forPath: "/djdl/update/stable/feed.jws").first
        let feedRequest = try XCTUnwrap(v1)
        XCTAssertEqual(feedRequest.url.query, "platform=macos")
        XCTAssertEqual(feedRequest.headers["accept"], "application/jose")

        // Persisted: signed artifacts only, keyed by canonical channel and by hash.
        let v2 = await store.readCache()
        let cached = try XCTUnwrap(v2)
        XCTAssertEqual(cached.feeds, ["stable": feed])
        XCTAssertEqual(cached.releaseRecords, [recordHash(record): record])
        let v3 = await core.feedFloors
        XCTAssertEqual(v3, ["stable": FeedFloor(seq: 1, issuedAt: t0)])

        // The same bytes again: nothing changed, and the record comes from the verified cache.
        let second = try await client.decide()
        XCTAssertEqual(second.feed, .network)
        XCTAssertEqual(second.record, .cache)
        let v4 = await server.requests(forPath: "/djdl/release/records/\(recordHash(record))").count
        XCTAssertEqual(v4, 1)
        XCTAssertEqual(second.decision, first.decision)
    }

    /// Acceptance: a reload refuses a feed with a lower seq, using a floor DERIVED from a
    /// re-verified cached JWS — across a restart, with nothing but the signed feed persisted.
    func testAReloadRefusesALowerSeqWithAFloorDerivedFromTheCachedJws() async throws {
        let record = recordJws()
        let pin = recordHash(record)
        let committed = feedJws(seq: 8, issuedAt: t0 - 60, pin: pin)
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        await store.writeCache(CacheRecord(feeds: ["stable": committed]))
        // A restart: a fresh Core over the same store.
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        let v5 = await core.feedFloors
        XCTAssertEqual(v5, ["stable": FeedFloor(seq: 8, issuedAt: t0 - 60)])

        await serve(feed: feedJws(seq: 7, issuedAt: t0, pin: pin), record: record, channel: "latest")
        let client = try UpdateClient(core: core, options: options())
        // `latest` is an alias: the floor is looked up by the feed's own claim, `stable`.
        let check = try await client.decide(channel: "latest")
        XCTAssertEqual(check.channel, "stable")
        XCTAssertEqual(check.feed, .committed)
        XCTAssertEqual(check.errors, [UpdateCheckError(code: ErrorCode.feedRollback)])
        XCTAssertEqual(check.record, .network)
        XCTAssertEqual(check.decision.action, UpdateAction.binary)
        // The committed seq-8 feed is still the committed one.
        let v6 = await store.readCache()?.feeds
        XCTAssertEqual(v6, ["stable": committed])
    }

    /// A cached feed that no longer verifies (its signature, or its key left the trust set) is
    /// dropped on load together with its floor; it is never a floor read from a stored number.
    func testATamperedCachedFeedIsDroppedWithItsFloor() async throws {
        let record = recordJws()
        let pin = recordHash(record)
        // Flip one signature character to a different one. (Replacing the tail with a fixed "AA" was
        // a no-op whenever a fresh random key's signature already ended in "AA", about 1 run in 256.)
        var chars = Array(feedJws(seq: 8, issuedAt: t0 - 60, pin: pin))
        let at = chars.count - 20
        chars[at] = chars[at] == "A" ? "B" : "A"
        let tampered = String(chars)
        let foreign = TestSigner(kid: "prod-2026")  // the pinned kid, another key
        let forged = foreign.sign(
            payloadJSON: String(decoding: Base64URL.decode(String(feedJws(seq: 9, issuedAt: t0, pin: pin).split(separator: ".")[1]))!, as: UTF8.self),
            typ: JwsTyp.feed.rawValue)
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        await store.writeCache(
            CacheRecord(feeds: ["stable": tampered, "beta": forged], releaseRecords: [pin: record]))
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        let v7 = await core.feedFloors
        XCTAssertEqual(v7, [:])
        // A record no surviving feed pins is not kept either.
        let v8 = await core.updateSlices().releaseRecords
        XCTAssertEqual(v8, [:])

        await serve(feed: feedJws(seq: 7, issuedAt: t0, pin: pin), record: record)
        let check = try await UpdateClient(core: core, options: options()).decide()
        XCTAssertEqual(check.feed, .network)
        XCTAssertEqual(check.errors, [])
    }

    /// A deactivation removes every credential and grant, not the feeds' `seq` floors.
    func testADeactivationKeepsTheFloors() async throws {
        let record = recordJws()
        let feed = feedJws(seq: 3, issuedAt: t0, pin: recordHash(record))
        await serve(feed: feed, record: record)
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        await store.setToken("pkeyt_secret")
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        _ = try await UpdateClient(core: core, options: options()).decide()
        try await core.clearAll()
        let token = await store.getToken()
        XCTAssertNil(token)
        let cached = await store.readCache()
        XCTAssertEqual(cached?.feeds, ["stable": feed])
        XCTAssertEqual(cached?.releaseRecords, [recordHash(record): record])
        let floors = await core.feedFloors
        XCTAssertEqual(floors, ["stable": FeedFloor(seq: 3, issuedAt: t0)])
    }

    /// The cached slices survive a write by another path (a document sync) untouched.
    func testCacheRecordCodableRoundTrip() throws {
        let record = CacheRecord(
            trustJws: "t", feeds: ["stable": "a.b.c"], releaseRecords: [String(repeating: "a", count: 64): "d.e.f"])
        let data = try JSONEncoder().encode(record)
        XCTAssertEqual(try JSONDecoder().decode(CacheRecord.self, from: data), record)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNotNil(json["feeds"])
        // No empty slices are written, and a v3 record without them decodes as "no floor yet".
        let bare = try JSONEncoder().encode(CacheRecord())
        let bareJson = try XCTUnwrap(JSONSerialization.jsonObject(with: bare) as? [String: Any])
        XCTAssertNil(bareJson["feeds"])
        XCTAssertNil(bareJson["releaseRecords"])
        let old = try JSONDecoder().decode(CacheRecord.self, from: Data(#"{"v":3,"trustJws":"t"}"#.utf8))
        XCTAssertEqual(old.feeds, [:])
        XCTAssertEqual(old.releaseRecords, [:])
    }

    // ── Hash before signature; release keys are never product keys ──────────────────

    /// Acceptance: a record with a mismatched hash is refused BEFORE signature verification —
    /// even a record whose signature is also broken reports `hash`.
    func testAMismatchedHashIsRefusedBeforeTheSignature() async throws {
        let good = recordJws()
        let pin = recordHash(good)
        var forged = recordJws(version: "1.3.0")
        forged.removeLast(4)
        forged += "AAAA"  // a broken signature too
        XCTAssertNotEqual(recordHash(forged), pin)
        await server.reply("/djdl/release/records/\(pin)", body: forged)
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        let client = try UpdateClient(core: core, options: options())
        do {
            _ = try await client.releaseRecord(hash: pin)
            XCTFail("a record with another hash was accepted")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.recordRejected)
            XCTAssertEqual(e.detail, "hash")
        }
        // The same record through decide(): null for the call, the refusal in `errors`.
        await serve(feed: feedJws(seq: 1, issuedAt: t0, pin: pin))
        let check = try await client.decide()
        XCTAssertEqual(check.errors, [UpdateCheckError(code: ErrorCode.recordRejected, detail: "hash")])
        XCTAssertEqual(check.record, .none)
        XCTAssertEqual(check.decision, .none(reason: UpdateNoneReason.notAvailable, behind: false, discardStaged: false))
    }

    /// Acceptance: a record signed by the PRODUCT key is refused (at `jws`), even with its hash
    /// pinned by a genuine feed: records verify against the pinned release keys only.
    func testARecordSignedByTheProductKeyIsRefused() async throws {
        let byProduct = recordJws(signer: TestSigner(kid: releaseKey.kid, key: product.key))
        let pin = recordHash(byProduct)
        await serve(feed: feedJws(seq: 1, issuedAt: t0, pin: pin), record: byProduct)
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        let check = try await UpdateClient(core: core, options: options()).decide()
        XCTAssertEqual(check.errors, [UpdateCheckError(code: ErrorCode.recordRejected, detail: "jws")])
        XCTAssertEqual(check.decision.action, UpdateAction.none)
        let v9 = await store.readCache()?.releaseRecords ?? [:]
        XCTAssertEqual(v9, [:])
        // The same key pinned as a release key is refused at construction.
        XCTAssertThrowsError(
            try UpdateClient(core: core, options: options(keys: ["rel": product.publicKeyB64]))
        ) { XCTAssertEqual(($0 as? PolarisError)?.code, ErrorCode.invalidOptions) }
    }

    // ── Freshness and the effective clock ───────────────────────────────────────────

    /// A committed feed past `expiresAt + 300` freezes: `none {stale}`, staged update kept.
    func testAStaleCommittedFeedFreezesWhenOffline() async throws {
        let record = recordJws()
        let feed = feedJws(seq: 1, issuedAt: t0, pin: recordHash(record))
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        await store.writeCache(CacheRecord(feeds: ["stable": feed], releaseRecords: [recordHash(record): record]))
        let clock = ReplayClock(t0 + 900 + 300)
        let core = try await makeCore(store: store, clock: clock)
        await server.reply("/djdl/update/stable/feed.jws", status: 503, body: "{}")
        let check = try await UpdateClient(core: core, options: options()).decide(
            staged: StagedUpdate(version: "1.3.0", channel: "stable"))
        XCTAssertEqual(check.feed, .committed)
        XCTAssertEqual(check.errors, [UpdateCheckError(code: ErrorCode.networkError)])
        XCTAssertEqual(check.decision, .none(reason: UpdateNoneReason.stale, behind: false, discardStaged: false))
        XCTAssertEqual(check.boot, .none)
        // One second earlier the same committed feed still decides.
        clock.now = t0 + 900 + 299
        let fresh = try await UpdateClient(core: core, options: options()).decide()
        XCTAssertEqual(fresh.decision.action, UpdateAction.binary)
    }

    /// The decision runs at the EFFECTIVE clock, `max(system, highWaterMark)`: winding the system
    /// clock back cannot revive an expired feed, cached or served.
    func testAWoundBackClockCannotReviveAnExpiredFeed() async throws {
        let record = recordJws()
        let feed = feedJws(seq: 1, issuedAt: t0, pin: recordHash(record))
        // A signed trust manifest issued well after the feed expired raises the floor.
        let manifest = product.sign(
            Fixtures.manifest(
                issuedAt: t0 + 5000,
                keys: [Fixtures.manifestKey(kid: product.kid, publicKey: product.publicKeyB64)]))
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        await store.writeCache(
            CacheRecord(trustJws: manifest, feeds: ["stable": feed], releaseRecords: [recordHash(record): record]))
        // The system clock says the feed is fresh.
        let core = try await makeCore(store: store, clock: ReplayClock(t0 + 100))
        let v10 = await core.now()
        XCTAssertEqual(v10, t0 + 5000)
        await serve(feed: feed)
        let client = try UpdateClient(core: core, options: options())
        let check = try await client.decide()
        XCTAssertEqual(check.decision, .none(reason: UpdateNoneReason.stale, behind: false, discardStaged: false))
        // A different, equally old signing served now is refused on freshness at the effective
        // clock, and the committed feed (stale) decides.
        await serve(feed: feedJws(seq: 2, issuedAt: t0, pin: recordHash(record)))
        let refused = try await client.decide()
        XCTAssertEqual(refused.errors, [UpdateCheckError(code: ErrorCode.feedRejected, detail: "freshness")])
        XCTAssertEqual(refused.feed, .committed)
        XCTAssertEqual(refused.decision.action, UpdateAction.none)
    }

    // ── The canonical channel ────────────────────────────────────────────────────────

    /// An alias answer commits under the feed's own claim and removes the requested name's entry;
    /// every other entry stays.
    func testAnAliasAnswerCommitsUnderTheCanonicalChannel() async throws {
        let record = recordJws()
        let pin = recordHash(record)
        let manualStaging = feedJws(seq: 3, issuedAt: t0 - 100, channel: "staging", pin: pin)
        let stable = feedJws(seq: 5, issuedAt: t0 - 100, pin: pin)
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        await store.writeCache(CacheRecord(feeds: ["staging": manualStaging, "stable": stable]))
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        let beta = feedJws(seq: 1, issuedAt: t0, channel: "beta", pin: pin)
        await serve(feed: beta, record: record, channel: "staging")
        let check = try await UpdateClient(core: core, options: options()).decide(channel: "staging")
        XCTAssertEqual(check.channel, "beta")
        XCTAssertEqual(check.feed, .network)
        let v11 = await store.readCache()?.feeds
        XCTAssertEqual(v11, ["beta": beta, "stable": stable])
    }

    /// `channelFeed()` runs the same steps without the record and needs no release keys.
    func testChannelFeedVerifiesAndCommitsWithoutTheRecord() async throws {
        let record = recordJws()
        let feed = feedJws(seq: 4, issuedAt: t0, pin: recordHash(record))
        await serve(feed: feed, channel: "latest")
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        let client = try UpdateClient(core: core, options: options(keys: [:]))
        let check = try await client.channelFeed(channel: "latest")
        XCTAssertEqual(check.channel, "stable")
        XCTAssertEqual(check.feed.seq, 4)
        XCTAssertEqual(check.source, .network)
        XCTAssertEqual(check.errors, [])
        let v12 = await store.readCache()?.feeds
        XCTAssertEqual(v12, ["stable": feed])
        let v13 = await server.requests(forPath: "/djdl/release/records/\(recordHash(record))").count
        XCTAssertEqual(v13, 0)
        // decide() still needs the keys.
        do {
            _ = try await client.decide()
            XCTFail("decide() without release keys")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.notConfigured)
        }
    }

    // ── Options, discovery and transport ─────────────────────────────────────────────

    func testOptionsAreValidatedAtConstruction() async throws {
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        var bad: [UpdateClientOptions] = []
        var o = options()
        o.outlet = .kind("epic")
        bad.append(o)
        o = options()
        o.outlet = .outlet(id: "Direct Build", kind: "direct")
        bad.append(o)
        o = options()
        o.methods = ["teleport"]
        bad.append(o)
        o = options()
        o.platform = "plan9"
        bad.append(o)
        o = options()
        o.arch = "ppc"
        bad.append(o)
        o = options()
        o.detected = DetectedOutlet(kind: "epic")
        bad.append(o)
        for opts in bad {
            XCTAssertThrowsError(try UpdateClient(core: core, options: opts), "\(opts)") {
                XCTAssertEqual(($0 as? PolarisError)?.code, ErrorCode.invalidOptions)
            }
        }
        // No options at all: check() works, decide() and releaseRecord() are not configured.
        let plain = UpdateClient(core: core)
        for call in [{ _ = try await plain.decide() }, { _ = try await plain.releaseRecord(hash: self.artifactSha) }] as [() async throws -> Void] {
            do {
                try await call()
                XCTFail("not-configured expected")
            } catch let e as PolarisError {
                XCTAssertEqual(e.code, ErrorCode.notConfigured)
            }
        }
        // Without an outlet the install is `unknown`, which is never offered an update.
        let record = recordJws()
        await serve(feed: feedJws(seq: 1, issuedAt: t0, pin: recordHash(record)), record: record)
        var unknown = options()
        unknown.outlet = nil
        let check = try await UpdateClient(core: core, options: unknown).decide()
        XCTAssertEqual(check.decision, .none(reason: UpdateNoneReason.notAvailable, behind: false, discardStaged: false))
    }

    /// A discovery document without the v4 endpoints is an older Worker: `service-unavailable`
    /// before dialling, and the host falls back to `check()`.
    func testDiscoveryWithoutTheV4EndpointsIsServiceUnavailable() async throws {
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        let core = try await makeCore(store: store, clock: ReplayClock(t0), v4: false)
        do {
            _ = try await UpdateClient(core: core, options: options()).decide()
            XCTFail("decide() without v4 endpoints")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.serviceUnavailable)
        }
        let v14 = await server.requests(forPath: "/djdl/update/stable/feed.jws").count
        XCTAssertEqual(v14, 0)
    }

    /// The device bearer goes only to the control plane's own origin, never to a host a
    /// discovery document names.
    func testTheBearerGoesOnlyToTheControlPlane() async throws {
        let record = recordJws()
        await serve(feed: feedJws(seq: 1, issuedAt: t0, pin: recordHash(record)), record: record)
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        await store.setToken("pkeyt_secret")
        let core = try await makeCore(store: store, clock: ReplayClock(t0), feedBase: "https://cdn.example")
        _ = try await UpdateClient(core: core, options: options()).decide()
        let v15 = await server.requests(forPath: "/djdl/update/stable/feed.jws").first
        let feedRequest = try XCTUnwrap(v15)
        XCTAssertEqual(feedRequest.url.host, "cdn.example")
        XCTAssertNil(feedRequest.headers["authorization"])
        let v16 = await server.requests(forPath: "/djdl/release/records/\(recordHash(record))").first
        let recordRequest = try XCTUnwrap(
            v16)
        XCTAssertEqual(recordRequest.headers["authorization"], "Bearer pkeyt_secret")
    }

    /// §2.5 step 11: the record fetch asks the transport to stop at 88 845 bytes, and a longer
    /// body is refused at `hash` from that prefix, without hashing.
    func testTheRecordBodyIsBounded() async throws {
        let pin = String(repeating: "d", count: 64)
        await server.reply("/djdl/release/records/\(pin)", body: String(repeating: "a", count: 200_000))
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        do {
            _ = try await UpdateClient(core: core, options: options()).releaseRecord(hash: pin)
            XCTFail("an oversized record was accepted")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.recordRejected)
            XCTAssertEqual(e.detail, "hash")
        }
        let v17 = await server.requests(forPath: "/djdl/release/records/\(pin)").first
        let request = try XCTUnwrap(v17)
        XCTAssertEqual(request.maxBodyBytes, MAX_RECORD_JWS_BYTES + 1)
    }

    /// The download URL comes from discovery's `builds` template, percent-encoded.
    func testBuildUrlUsesTheBuildsRoute() async throws {
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        let client = try UpdateClient(core: core, options: options())
        let v18 = await client.buildURL(version: "1.3.0", buildId: "macos")
        XCTAssertNil(v18)  // no discovery yet
        await core.discover()
        let v19 = await client.buildURL(version: "1.3.0+46", buildId: "macos")?.absoluteString
        XCTAssertEqual(
            v19,
            "https://key.example/djdl/distribution/builds/1.3.0%2B46/macos")
    }

    /// `check()` and the Sparkle helpers are unchanged by v4.
    func testCheckIsUnchanged() async throws {
        await server.reply(
            "/djdl/update/version", body: #"{"version":"1.3.0","tag":"v1.3.0","url":"https://x"}"#)
        let store = InMemoryStore(productSlug: "djdl", deviceId: "dev-1")
        let core = try await makeCore(store: store, clock: ReplayClock(t0))
        let check = try await UpdateClient(core: core, options: options()).check(channel: "beta")
        XCTAssertEqual(check.version, "1.3.0")
        XCTAssertTrue(check.updateAvailable)
        let v20 = await server.requests(forPath: "/djdl/update/version").first?.url.query
        XCTAssertEqual(
            v20, "channel=beta")
    }
}
