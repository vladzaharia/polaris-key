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
            ["stable", "beta"])
    }

    /// `stable` is always included: it is the unnamed default channel, and a licence that grants
    /// nothing still gets the release build.
    func testStableIsAlwaysAllowed() {
        XCTAssertEqual(UpdateFeedBuilder.allowedChannels(from: [:]), ["stable"])
        XCTAssertEqual(
            UpdateFeedBuilder.allowedChannels(from: ["channels": .array([])]), ["stable"])
        XCTAssertEqual(
            UpdateFeedBuilder.allowedChannels(from: ["channels": .array([.string("beta")])]),
            ["stable", "beta"])
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

    func testFeedCarriesTheDerivedChannels() {
        let feed = UpdateFeedBuilder.feed(
            from: discovery(), channel: "beta", arch: .arm64,
            entitlements: ["channels": .array([.string("beta")])])
        XCTAssertEqual(feed?.allowedChannels, ["stable", "beta"])
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
