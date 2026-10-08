// @pkey-feature core.verify core.bundle update.feed release.record
// The Swift conformance runner for wire contract v4 (v3's documents, unchanged). It drives EVERY case in
// `conformance/corpus/v2` through the native CryptoKit verifier and asserts the expected
// outcome — the Node runner (`conformance/runners/node/corpusV2.test.ts`) mirrors this file
// against the SAME vectors. That is how the SDKs prove byte-identical verification: one signer,
// several runners.
//
// Six sections, six layers of the contract:
//
//   jwsCases          §1–§2  raw compact-JWS verification      → JWSVerifier.verify
//   licenseDocCases   §3     claim validation, license          → verifyLicenseDoc
//   configDocCases    §3     claim validation, config           → verifyConfigDoc
//   trustCases        §1     trust merge / prune / revocation   → verifyTrustManifest + mergeTrust
//   clockFloorCases   §4.2   the monotonic floor over 3 kinds   → reload path + licenseState
//   bundleCases       §7     all-or-nothing bundle import       → inspectBundle
//
// Wire contract v4 adds two more, at the end of this file:
//
//   feedCases          §2.3, steps 3–8   the channel feed            → feedClaims, verifyFeed
//   releaseRecordCases §2.4, steps 12–15 the release record          → releaseRecordClaims,
//                                                                      verifyReleaseRecord
//
// v4's pointer-set section (§4.1), over the JWS families with `feedCases`,
// `releaseRecordCases`, `packRecordCases` and `markerCases`, is `PointerSetTests.swift`.
//
// Everything reads `conformance/corpus/v2/` from the checkout through `CorpusLocator`.
// The wire-v2 corpus is gone; there is one corpus.

import CryptoKit
import Foundation
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

// ── Corpus shapes ──────────────────────────────────────────────────────────────────

struct Corpus: Decodable {
    let corpusVersion: Int
    let keys: [CorpusKey]
    let jwsCases: [CorpusJwsCase]
    let licenseDocCases: [CorpusDocCase]
    let configDocCases: [CorpusDocCase]
    let trustCases: [CorpusTrustCase]
    let clockFloorCases: [CorpusClockFloorCase]
    let bundleCases: [CorpusBundleCase]
}

struct CorpusKey: Decodable {
    let kid: String
    let publicKeyRaw: String
}

struct CorpusJwsCase: Decodable {
    let id: String
    let description: String
    let jws: String
    let trust: TrustSet
    /// v3 pins a `typ` on EVERY vector — the untyped tolerance window is over (§2).
    let typ: String
    /// Present only on the two `pkey-bundle+jws` vectors, which exercise §1's raised cap.
    let maxPayloadBytes: Int?
    let expect: JwsExpect
}

struct JwsExpect: Decodable {
    let verify: String
    let kid: String?
    /// The expected payload, compared STRUCTURALLY rather than field-by-field: the two bundle
    /// cap vectors carry a quarter-megabyte of padding and omit it entirely.
    let doc: JSONValue?
}

/// §3 — claim validation over an already-signature-valid document.
struct CorpusDocCase: Decodable {
    let id: String
    let description: String
    let jws: String
    let trust: TrustSet
    let typ: String
    let expectedAud: String
    let expectedIss: String
    let deviceId: String
    let now: Int
    let lastAcceptedIssuedAt: Int?
    /// Absent ⇒ the NETWORK path (freshness enforced); `false` ⇒ the cache-reload path.
    let checkFreshness: Bool?
    let expect: DocExpect
}

struct DocExpect: Decodable {
    let accept: Bool
}

/// §1 — what a manifest does to a trust set, given what was already held.
struct CorpusTrustCase: Decodable {
    let id: String
    let description: String
    let pinned: TrustSet
    let before: TrustSet
    let manifestJws: String
    let now: Int
    let checkFreshness: Bool?
    let expect: TrustExpect
}

struct TrustExpect: Decodable {
    let accepted: Bool
    let trust: TrustSet
    /// The accepted manifest's `issuedAt` — the value §4.2 folds into the clock floor.
    let issuedAt: Int?
}

/// §4.2 — the cache-RELOAD path replayed as pure data, ending at a gate decision.
struct CorpusClockFloorCase: Decodable {
    let id: String
    let description: String
    let pinned: TrustSet
    let trustJws: String?
    let licenseJws: String?
    let configJws: String?
    let expectedAud: String
    let deviceId: String
    let systemClock: Int
    let expect: ClockFloorExpect
}

struct ClockFloorExpect: Decodable {
    let highWaterMark: Int
    let effectiveNow: Int
    let status: String
}

/// §7 — the offline bundle import, with the refusing STEP attributed.
struct CorpusBundleCase: Decodable {
    let id: String
    let description: String
    let pinned: TrustSet
    let expectedAud: String
    let deviceId: String
    let now: Int
    let maxPayloadBytes: Int
    let bundleJws: String
    let expect: BundleExpect
}

struct BundleExpect: Decodable {
    let imports: Bool
    /// Which documents landed, in §7 order. A SEQUENCE, not a set.
    let docs: [String]?
    /// The `BundleRefusalReason` raw value, when `imports` is false.
    let reason: String?
}

// ── The runner ─────────────────────────────────────────────────────────────────────

final class ConformanceTests: XCTestCase {
    private func loadCorpus() throws -> Corpus { try CorpusLocator.load(Corpus.self, "cases") }

    /// The corpus this build is held to is v2, and every section carries at least what it
    /// carried when this runner was written.
    ///
    /// A floor rather than an equality, because the corpus is expected to GROW — §10 says a new
    /// divergence gets a case before it gets a fix. What a floor catches is the dangerous
    /// direction: a section that silently shrank, or a `Decodable` mismatch that quietly emptied
    /// one, would otherwise let every loop below pass by iterating nothing.
    func testCorpusIsV3AndFullyPopulated() throws {
        let corpus = try loadCorpus()
        XCTAssertEqual(corpus.corpusVersion, 2)
        XCTAssertGreaterThanOrEqual(corpus.jwsCases.count, 36)
        XCTAssertGreaterThanOrEqual(corpus.licenseDocCases.count, 16)
        XCTAssertGreaterThanOrEqual(corpus.configDocCases.count, 18)
        XCTAssertGreaterThanOrEqual(corpus.trustCases.count, 11)
        XCTAssertGreaterThanOrEqual(corpus.clockFloorCases.count, 7)
        XCTAssertGreaterThanOrEqual(corpus.bundleCases.count, 9)
        // Every refusal step §7 can attribute must have at least one vector behind it, or the
        // attribution assertions below are only testing the steps that happen to be covered.
        let refusals = Set(corpus.bundleCases.compactMap(\.expect.reason))
        XCTAssertEqual(refusals, Set(BundleRefusalReason.allCases.map(\.rawValue)))
    }

    /// §1–§2 — every raw JWS vector: an `ok` case must verify, expose the expected `kid`, and
    /// reproduce the expected payload structurally; a `fail` case (tampered / wrong-kid /
    /// alg=none / oversized / duplicate-key / untyped / mistyped) must return nil.
    func testAllJwsCases() throws {
        for c in try loadCorpus().jwsCases {
            let typ = JwsTyp(rawValue: c.typ)
            XCTAssertNotNil(typ, "\(c.id): corpus names a typ this SDK does not know — \(c.typ)")
            let result = JWSVerifier.verify(
                c.jws, trust: c.trust, typ: typ, requireTyp: true,
                maxPayloadBytes: c.maxPayloadBytes)
            if c.expect.verify == "ok" {
                guard let result else {
                    XCTFail("\(c.id) should verify but returned nil — \(c.description)")
                    continue
                }
                XCTAssertEqual(result.kid, c.expect.kid, "\(c.id): kid mismatch")
                if let expected = c.expect.doc {
                    let actual = try JSONDecoder().decode(
                        JSONValue.self, from: result.payload)
                    XCTAssertEqual(actual, expected, "\(c.id): payload mismatch")
                }
            } else {
                XCTAssertNil(result, "\(c.id) must fail verification — \(c.description)")
            }
        }
    }

    /// §3 — every claim the contract makes about a LICENSE document, at a pinned `now`.
    func testAllLicenseDocCases() throws {
        for c in try loadCorpus().licenseDocCases {
            XCTAssertEqual(c.typ, JwsTyp.license.rawValue, "\(c.id) typ")
            let doc = verifyLicenseDoc(c.jws, options: options(c))
            assertAccept(doc != nil, c)
        }
    }

    /// §3 — the same envelope rules over a CONFIG document, plus the two config-only vectors:
    /// a document with no licence fields at all is ACCEPTED (D-08's wire-level guarantee), and a
    /// string `schemaVersion` is refused on shape.
    func testAllConfigDocCases() throws {
        for c in try loadCorpus().configDocCases {
            XCTAssertEqual(c.typ, JwsTyp.config.rawValue, "\(c.id) typ")
            let doc = verifyConfigDoc(c.jws, options: options(c))
            assertAccept(doc != nil, c)
        }
    }

    private func options(_ c: CorpusDocCase) -> VerifyOptions {
        VerifyOptions(
            trust: c.trust, expectedAud: c.expectedAud, deviceId: c.deviceId,
            lastAcceptedIssuedAt: c.lastAcceptedIssuedAt, expectedIss: c.expectedIss,
            now: c.now, checkFreshness: c.checkFreshness ?? true)
    }

    private func assertAccept(_ accepted: Bool, _ c: CorpusDocCase) {
        if c.expect.accept {
            XCTAssertTrue(accepted, "\(c.id) should be accepted — \(c.description)")
        } else {
            XCTAssertFalse(accepted, "\(c.id) must be rejected — \(c.description)")
        }
    }

    /// §1 — a manifest is verified against the PINNED keys only, and what it publishes REPLACES
    /// the discovered set. A refused manifest leaves the previous set untouched.
    func testAllTrustCases() throws {
        for c in try loadCorpus().trustCases {
            let result = verifyTrustManifest(
                c.manifestJws,
                options: VerifyTrustManifestOptions(
                    pinned: c.pinned, expectedAud: "djdl", now: c.now,
                    checkFreshness: c.checkFreshness ?? true))
            XCTAssertEqual(
                result.doc != nil, c.expect.accepted, "\(c.id) acceptance — \(c.description)")
            let discovered = result.doc != nil ? result.discovered : c.before
            XCTAssertEqual(
                mergeTrust(c.pinned, discovered), c.expect.trust, "\(c.id) resulting trust set")
            if let issuedAt = c.expect.issuedAt {
                XCTAssertEqual(result.doc?.issuedAt, issuedAt, "\(c.id) issuedAt")
            }
        }
    }

    /// §4.2 — the monotonic clock floor. Each case replays the cache-RELOAD path as pure data:
    /// re-verify the cached manifest (freshness OFF), re-verify each cached document against the
    /// resulting trust set (freshness OFF), take the floor as the max over the `issuedAt` of
    /// whatever actually verified, then gate at `max(systemClock, floor)`.
    ///
    /// Order is load-bearing: trust first, because the documents may be signed by a key only the
    /// manifest publishes. Deriving the floor from the DOCUMENTS alone is inert (R4-04) — that is
    /// what `floor-config-doc-alone-does-not-stop-rollback` pins, and v3 giving the client a
    /// second document changes nothing, because both are stamped by the same fetch.
    func testAllClockFloorCases() throws {
        for c in try loadCorpus().clockFloorCases {
            var trust = c.pinned
            var verified: [any DatedArtifact] = []

            if let trustJws = c.trustJws {
                let manifest = verifyTrustManifest(
                    trustJws,
                    options: VerifyTrustManifestOptions(
                        pinned: c.pinned, expectedAud: c.expectedAud, now: c.systemClock,
                        checkFreshness: false))
                if let doc = manifest.doc {
                    trust = mergeTrust(c.pinned, manifest.discovered)
                    verified.append(doc)
                }
            }

            let reload = { (t: TrustSet) in
                VerifyOptions(
                    trust: t, expectedAud: c.expectedAud, deviceId: c.deviceId,
                    now: c.systemClock, checkFreshness: false)
            }
            var license: LicenseDoc?
            if let jws = c.licenseJws, let doc = verifyLicenseDoc(jws, options: reload(trust)) {
                license = doc
                verified.append(doc)
            }
            if let jws = c.configJws, let doc = verifyConfigDoc(jws, options: reload(trust)) {
                verified.append(doc)
            }

            let floor = highWaterMark(verified)
            XCTAssertEqual(floor, c.expect.highWaterMark, "\(c.id) highWaterMark")
            XCTAssertEqual(
                effectiveNow(c.systemClock, floor), c.expect.effectiveNow, "\(c.id) effectiveNow")
            let state = licenseState(
                GateInput(
                    licenseServiceEnabled: true, activation: .token, doc: license,
                    now: c.systemClock, highWaterMark: floor))
            XCTAssertEqual(
                state.status.rawValue, c.expect.status, "\(c.id) — \(c.description)")
        }
    }

    /// §7 — offline bundle import, all-or-nothing, with the refusing STEP attributed.
    ///
    /// The corpus pins WHICH step refused, not merely that something did: "the bundle was
    /// addressed to another device" (step 2) and "the license document inside it was addressed to
    /// another device" (step 4) are different failures with different operator remedies.
    func testAllBundleCases() throws {
        for c in try loadCorpus().bundleCases {
            // The raised cap is the implementation's constant, never the caller's — the corpus
            // asserts the two agree rather than passing the value in.
            XCTAssertEqual(
                c.maxPayloadBytes, MAX_BUNDLE_BYTES, "\(c.id): bundle cap must be the constant")
            let options = BundleOptions(
                pinned: c.pinned, product: c.expectedAud, deviceId: c.deviceId, now: c.now)
            let inspection = inspectBundle(c.bundleJws, options: options)

            if c.expect.imports {
                guard case .ok(let bundle) = inspection else {
                    XCTFail("\(c.id) should import — \(c.description)")
                    continue
                }
                XCTAssertEqual(
                    bundle.importedSlices.map(\.rawValue), c.expect.docs ?? [],
                    "\(c.id) imported documents, in §7 order")
                // The ergonomic entry point must never disagree with the attributed one.
                XCTAssertEqual(
                    verifyBundle(c.bundleJws, options: options), bundle,
                    "\(c.id): verifyBundle and inspectBundle must agree")
            } else {
                guard case .refused(let reason) = inspection else {
                    XCTFail("\(c.id) must be refused — \(c.description)")
                    continue
                }
                XCTAssertEqual(
                    reason.rawValue, c.expect.reason, "\(c.id) refusal step — \(c.description)")
                XCTAssertNil(
                    verifyBundle(c.bundleJws, options: options),
                    "\(c.id): a refused bundle must yield nothing at all")
            }
        }
    }

    /// The control bundle in detail: step 4 runs against the set step 3 BUILT, not against the
    /// pins alone — the config document inside it is signed by a rotated key that only the inner
    /// manifest publishes.
    func testValidBundleCarriesVerifiedContents() throws {
        let corpus = try loadCorpus()
        guard let c = corpus.bundleCases.first(where: { $0.id == "bundle-valid-full" }) else {
            return XCTFail("missing bundle-valid-full")
        }
        guard
            let bundle = verifyBundle(
                c.bundleJws,
                options: BundleOptions(
                    pinned: c.pinned, product: c.expectedAud, deviceId: c.deviceId, now: c.now))
        else { return XCTFail("bundle-valid-full should verify") }

        XCTAssertFalse(bundle.bundleId.isEmpty)
        XCTAssertEqual(bundle.trustJws.split(separator: ".").count, 3)
        XCTAssertGreaterThan(
            bundle.effectiveTrust.count, c.pinned.count,
            "the inner manifest must have published at least one further key")
        XCTAssertEqual(bundle.license?.doc.deviceId, c.deviceId)
        XCTAssertEqual(bundle.license?.doc.aud, c.expectedAud)
        XCTAssertEqual(bundle.config?.doc.deviceId, c.deviceId)
        XCTAssertEqual(bundle.license?.jws.split(separator: ".").count, 3)
        XCTAssertEqual(bundle.config?.jws.split(separator: ".").count, 3)
    }

    // ── Targeted checks the corpus cannot express as data ────────────────────────────

    /// Key selection is driven by the trust set's VALUE, not merely by the presence of the kid.
    func testWrongKeyForKnownKidFails() throws {
        let corpus = try loadCorpus()
        guard let valid = corpus.jwsCases.first(where: { $0.id == "valid-stable" }) else {
            return XCTFail("missing valid-stable case")
        }
        // Same kid, the OTHER corpus key's bytes.
        let other = corpus.keys.first { $0.kid != "pkey-test-prod-2026" }
        XCTAssertNotNil(other)
        XCTAssertNil(
            JWSVerifier.verify(
                valid.jws, trust: ["pkey-test-prod-2026": other!.publicKeyRaw], typ: .license))
    }

    /// A 31-byte (non-32) key is rejected before any signature math.
    func testNon32ByteKeyRejected() throws {
        let corpus = try loadCorpus()
        guard let valid = corpus.jwsCases.first(where: { $0.id == "valid-stable" }) else {
            return XCTFail("missing valid-stable case")
        }
        let short = Base64URL.encode(Data(repeating: 0, count: 31))
        XCTAssertNil(
            JWSVerifier.verify(
                valid.jws, trust: ["pkey-test-prod-2026": short], typ: .license))
    }

    /// The product-scoped wrapper: right aud/device passes, wrong fails, and a replayed
    /// `issuedAt` is rejected. `now` is anchored to the vector's own `issuedAt` because §3 checks
    /// the whole signed validity window and these are fixed-timestamp fixtures.
    func testVerifyDocAntiReplay() throws {
        let corpus = try loadCorpus()
        guard let valid = corpus.jwsCases.first(where: { $0.id == "valid-stable" }),
            let doc = valid.expect.doc?.objectValue,
            let deviceId = doc["deviceId"]?.stringValue,
            let issuedAt = doc["issuedAt"]?.intValue
        else { return XCTFail("missing valid-stable case") }

        func verify(aud: String, device: String, floor: Int? = nil) -> LicenseDoc? {
            verifyLicenseDoc(
                valid.jws,
                options: VerifyOptions(
                    trust: valid.trust, expectedAud: aud, deviceId: device,
                    lastAcceptedIssuedAt: floor, now: issuedAt))
        }
        XCTAssertNotNil(verify(aud: "djdl", device: deviceId))
        XCTAssertNil(verify(aud: "other", device: deviceId), "wrong audience")
        XCTAssertNil(verify(aud: "djdl", device: "someone-else"), "wrong device")
        XCTAssertNil(
            verify(aud: "djdl", device: deviceId, floor: issuedAt),
            "replay: issuedAt not strictly greater than the last accepted")
        XCTAssertNotNil(verify(aud: "djdl", device: deviceId, floor: issuedAt - 1))
    }

    /// The payload cap, not the signature, is what rejects an over-cap document: an
    /// exactly-at-cap blob still verifies and a one-byte-over blob does not. The corpus pins the
    /// same boundary for both the ordinary 64 KiB cap and the bundle's 256 KiB one; this proves
    /// the Swift arithmetic independently, with a locally-minted key.
    func testPayloadSizeCapRejectsOversizedButAcceptsAtCap() {
        let signer = TestSigner(kid: "test-cap-key")

        func payload(padLen: Int) -> String {
            let pad = String(repeating: "x", count: padLen)
            return """
                {"iss":"key.plrs.im","aud":"djdl","deviceId":"d","issuedAt":1,"expiresAt":2,\
                "graceUntil":3,"licenseId":"\(pad)","entitlements":{}}
                """
        }
        let base = payload(padLen: 0).utf8.count
        let atCapPad = JWSVerifier.maxPayloadBytes - base
        XCTAssertEqual(payload(padLen: atCapPad).utf8.count, JWSVerifier.maxPayloadBytes)

        XCTAssertNotNil(
            JWSVerifier.verify(
                signer.sign(payloadJSON: payload(padLen: atCapPad), typ: JwsTyp.license.rawValue),
                trust: signer.trust, typ: .license),
            "payload at the cap must verify")
        XCTAssertNil(
            JWSVerifier.verify(
                signer.sign(
                    payloadJSON: payload(padLen: atCapPad + 1), typ: JwsTyp.license.rawValue),
                trust: signer.trust, typ: .license),
            "payload over the cap must be rejected before decode")
    }
}

// ── Wire contract v4: feeds and release records (plans/P3-01.md §4.4, §4.5) ──────────────────

struct V4Corpus: Decodable {
    let feedCases: [CorpusFeedCase]
    let releaseRecordCases: [CorpusRecordCase]
}

/// WIRE-CONTRACT-V4 §2.3: one `feedCases` vector.
struct CorpusFeedCase: Decodable {
    struct Floor: Decodable {
        let seq: Int
        let issuedAt: Int
    }
    struct Expect: Decodable {
        let verify: String
        let reason: String?
        let seq: Int?
        let issuedAt: Int?
        let doc: JSONValue?
    }
    let id: String
    let description: String
    let jws: String
    let trust: TrustSet
    let expectedAud: String
    let channel: String
    let platform: String
    let now: Int
    let checkFreshness: Bool
    /// Keyed by CANONICAL channel.
    let floors: [String: Floor]?
    let expect: Expect
}

/// WIRE-CONTRACT-V4 §2.4: one `releaseRecordCases` vector.
struct CorpusRecordCase: Decodable {
    struct Pin: Decodable {
        let deliverable: String
        let version: String
        let seq: Int
    }
    struct Expect: Decodable {
        let verify: String
        let step: String?
        let kind: String?
        let doc: JSONValue?
    }
    let id: String
    let description: String
    let jws: String
    let releaseKeys: TrustSet
    let productTrust: TrustSet
    let expectedAud: String
    let expectedHash: String
    let pin: Pin?
    let expect: Expect
}

extension ConformanceTests {
    private func v4Corpus() throws -> V4Corpus { try CorpusLocator.load(V4Corpus.self, "cases") }

    /// Steps 4–6 alone, over every feed case that reaches them: the case's reason where it fails
    /// at the claims, the channel binding or the selector, no refusal otherwise.
    func testFeedClaimsOverEveryCaseThatReachesThem() throws {
        let corpus = try v4Corpus()
        let claimReasons: Set<String> = ["claims", "channel", "selector"]
        let reachable = claimReasons.union(["freshness", "not-newer", "rollback"])
        var checked = 0
        for c in corpus.feedCases {
            let reason = c.expect.verify == "ok" ? nil : c.expect.reason
            if let reason, !reachable.contains(reason) { continue }
            let v = try XCTUnwrap(
                JWSVerifier.verify(c.jws, trust: c.trust, typ: .feed), "\(c.id) reaches the claims step")
            let payload = try JSONDecoder().decode(JSONValue.self, from: v.payload)
            let got = feedClaims(
                payload, expectedAud: c.expectedAud, channel: c.channel, platform: c.platform,
                nonWire: v.nonWireIntegers)
            let want = reason.flatMap { claimReasons.contains($0) ? $0 : nil }
            XCTAssertEqual(got?.rawValue, want, "\(c.id): \(c.description)")
            checked += 1
        }
        XCTAssertGreaterThan(checked, 50)
    }

    /// Steps 3–8 through `verifyFeed`, every case, with the same ids as the other runners.
    func testAllFeedCases() throws {
        let corpus = try v4Corpus()
        XCTAssertEqual(corpus.feedCases.count, 80)
        for c in corpus.feedCases {
            let r = verifyFeed(
                c.jws,
                options: VerifyFeedOptions(
                    trust: c.trust, expectedAud: c.expectedAud, channel: c.channel,
                    platform: c.platform, now: c.now, checkFreshness: c.checkFreshness,
                    floors: (c.floors ?? [:]).mapValues { FeedFloor(seq: $0.seq, issuedAt: $0.issuedAt) }))
            if c.expect.verify == "ok" {
                guard let feed = r.feed else {
                    XCTFail("\(c.id) → ok, got \(String(describing: r.refusal)): \(c.description)")
                    continue
                }
                XCTAssertEqual(feed.seq, c.expect.seq, c.id)
                XCTAssertEqual(feed.issuedAt, c.expect.issuedAt, c.id)
                if let doc = c.expect.doc {
                    XCTAssertEqual(feed.json, doc, c.id)
                    // The typed view carries the same values as the payload.
                    XCTAssertEqual(ChannelFeedDoc(json: doc), feed, c.id)
                }
            } else {
                XCTAssertEqual(r.refusal?.rawValue, c.expect.reason, "\(c.id): \(c.description)")
            }
        }
    }

    /// Step 14 alone, over every record case that reaches it (key selection from the pinned
    /// release keys only, as step 13 does).
    func testRecordClaimsOverEveryCaseThatReachesThem() throws {
        let corpus = try v4Corpus()
        var checked = 0
        for c in corpus.releaseRecordCases {
            let step = c.expect.verify == "ok" ? nil : c.expect.step
            if let step, step != "claims", step != "cross-check" { continue }
            let header = try JSONDecoder().decode(
                JSONValue.self,
                from: try XCTUnwrap(Base64URL.decode(String(c.jws.split(separator: ".")[0]))))
            let kid = try XCTUnwrap(header.objectValue?["kid"]?.stringValue)
            let v = try XCTUnwrap(
                JWSVerifier.verify(c.jws, trust: [kid: c.releaseKeys[kid]!], typ: .release),
                "\(c.id) reaches the claims step")
            let payload = try JSONDecoder().decode(JSONValue.self, from: v.payload)
            XCTAssertEqual(
                releaseRecordClaims(payload, expectedAud: c.expectedAud, nonWire: v.nonWireIntegers),
                step != "claims", "\(c.id): \(c.description)")
            checked += 1
        }
        XCTAssertGreaterThan(checked, 30)
    }

    /// Steps 12–15 through `verifyReleaseRecord`, every case.
    func testAllReleaseRecordCases() throws {
        let corpus = try v4Corpus()
        XCTAssertEqual(corpus.releaseRecordCases.count, 49)
        for c in corpus.releaseRecordCases {
            let r = verifyReleaseRecord(
                c.jws,
                options: VerifyReleaseRecordOptions(
                    releaseKeys: c.releaseKeys, productTrust: c.productTrust,
                    expectedAud: c.expectedAud, expectedHash: c.expectedHash,
                    pin: c.pin.map {
                        ReleaseRecordPin(deliverable: $0.deliverable, version: $0.version, seq: $0.seq)
                    }))
            if c.expect.verify == "ok" {
                guard let record = r.record else {
                    XCTFail("\(c.id) → ok, got \(String(describing: r.step)): \(c.description)")
                    continue
                }
                XCTAssertEqual(record.kind, c.expect.kind, c.id)
                if let doc = c.expect.doc {
                    XCTAssertEqual(record.json, doc, c.id)
                    XCTAssertEqual(ReleaseRecordDoc(json: doc), record, c.id)
                }
            } else {
                XCTAssertEqual(r.step?.rawValue, c.expect.step, "\(c.id): \(c.description)")
            }
        }
    }

    /// §2.5 step 12: a body of 88 845 bytes is refused at `hash` WITHOUT hashing, even when its
    /// hash is the pin (the corpus does not carry one; P3-02's size budget).
    func testRecordBodyBoundIsRefusedBeforeHashing() {
        let body = String(repeating: "a", count: MAX_RECORD_JWS_BYTES + 1)
        let r = verifyReleaseRecord(
            body,
            options: VerifyReleaseRecordOptions(
                releaseKeys: ["k": String(repeating: "A", count: 43)], productTrust: [:],
                expectedAud: "djdl", expectedHash: recordHash(body)))
        XCTAssertEqual(r, .refused(.hash))
        // A non-ASCII body is refused at the same step.
        let wide = "é" + String(repeating: "a", count: 10)
        XCTAssertEqual(
            verifyReleaseRecord(
                wide,
                options: VerifyReleaseRecordOptions(
                    releaseKeys: [:], productTrust: [:], expectedAud: "djdl",
                    expectedHash: recordHash(wide))),
            .refused(.hash))
        XCTAssertEqual(MAX_RECORD_JWS_BYTES, 1_370 + 1 + 87_386 + 1 + 86)
    }
}
