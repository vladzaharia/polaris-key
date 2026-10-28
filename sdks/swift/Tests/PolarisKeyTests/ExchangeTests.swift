// @pkey-feature identity.exchange
//
// I-44.1: the platform ID-token exchange primitive (WIRE-CONTRACT-V5 §12.11.2-.3). The recorded
// conversations are the transcripts' (`exchange-*`, replayed by I-44.3); these tests hold what a
// recording cannot: the proof the client signs, the form it sends, a fresh single-use nonce per
// attempt, every outcome, `unavailable` without a request, and that no token, grant, handle or
// nonce prints.

import CryptoKit
import Foundation
import PolarisKey
import XCTest

@testable import PolarisKeyCore
@testable import PolarisKeyIdentity

/// The fixture device keys of `label` (format.ts "exchange"): the signing seed is SHA-256(label),
/// the agreement key SHA-256(label + ":agree") with bit 255 clear. Durable or memory by choice.
final class LabelKeyPort: DeviceKeyPort, @unchecked Sendable {
    private let priv: Curve25519.Signing.PrivateKey
    private let agree: Data
    private let kind: DeviceKeyPersistence

    init(label: String, kind: DeviceKeyPersistence = .durable) throws {
        priv = try Curve25519.Signing.PrivateKey(
            rawRepresentation: Data(SHA256.hash(data: Data(label.utf8))))
        var a = Data(SHA256.hash(data: Data((label + ":agree").utf8)))
        a[31] &= 0x7f
        agree = a
        self.kind = kind
    }

    var keys: DevicePublicKeys {
        DevicePublicKeys(
            signKey: Base64URL.encode(priv.publicKey.rawRepresentation),
            agreeKey: Base64URL.encode(agree), generation: 1)
    }
    func ensure() async throws -> DevicePublicKeys { keys }
    func publicKeys() async throws -> DevicePublicKeys? { keys }
    func sign(_ message: Data) async throws -> Data { try priv.signature(for: message) }
    func dh(_ peerPublic: Data) async throws -> Data? { nil }
    func rotate() async throws -> DevicePublicKeys { keys }
    func persistence() async throws -> DeviceKeyPersistence { kind }
    func wipe() async throws {}
}

@MainActor
final class ExchangeTests: XCTestCase {
    private var server = StubServer()
    private let api = "https://key.example/djdl"
    private let nonce = "sQXGUn9Dig9pVY62opwL2ZY-2R6qs3Rmyj7WRgxJxG4"
    private let providerToken = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJnLXN1Yi0xIn0.SECRETSIGNATURE"
    private let grant = "sg_" + String(repeating: "b", count: 43)
    private let handle = "lh_" + String(repeating: "c", count: 43)

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func discovery(
        exchange: String? = #""exchange":{"kinds":["google","apple"],"google":{"serverClientId":"1234-web"}},"#,
        nonceRoute: Bool = true
    ) async {
        let nonceEntry = nonceRoute ? #","nonce":"\#(api)/identity/nonce""# : ""
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body:
                #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,\#(exchange ?? "")"issuer":"\#(api)/identity","endpoints":{"authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token","choiceLicenses":"\#(api)/identity/choice/licenses","choiceDevices":"\#(api)/identity/choice/devices","choiceComplete":"\#(api)/identity/choice/complete","choiceCancel":"\#(api)/identity/choice/cancel"\#(nonceEntry)}}}}"#
        )
        await server.reply("/djdl/identity/nonce", body: #"{"nonce":"\#(nonce)","expiresIn":300}"#)
    }

    private func client(keys: (any DeviceKeyPort)? = nil, token: String? = nil) async throws
        -> PolarisKeyClient
    {
        let store = InMemoryStore(deviceId: "DEVICE00000000000000000000000001")
        if let token { await store.setToken(token) }
        let port = try keys ?? LabelKeyPort(label: "transcript-device-key-1")
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.identity], fingerprint: false,
                connect: ConnectOptions(keys: port)))
        c.identity.redirectAcquisitionSync.set(false)
        return c
    }

    private let tokenOk =
        #"{"access_token":"pkeyt_exchanged","token_type":"Bearer","scope":"profile email","schemaVersion":1,"device":{"id":"D"},"license":null,"subject":"ps_abc","issued_token_type":"urn:polaris-key:token-type:device"}"#

    private func form(_ request: PolarisRequest) -> [String: String] {
        var out: [String: String] = [:]
        for pair in String(decoding: request.body ?? Data(), as: UTF8.self).split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            out[parts[0]] = (parts.count > 1 ? parts[1] : "").removingPercentEncoding
        }
        return out
    }

    // ── The request ────────────────────────────────────────────────────────────────────

    func testDiscoveryCarriesTheExchangeMember() async throws {
        await discovery()
        let c = try await client()
        await c.core.discover()
        let document = await c.core.discoveryDocument
        let fragment = try XCTUnwrap(document?.identity)
        XCTAssertEqual(fragment.exchange?.kinds, ["google", "apple"])
        XCTAssertEqual(fragment.exchange?.googleServerClientId, "1234-web")
        XCTAssertEqual(fragment.nonce, "\(api)/identity/nonce")
    }

    func testTheProofBindsTheNonceTheKeyAndTheTokenAndTheTokenIsStored() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", body: tokenOk)
        let keys = try LabelKeyPort(label: "transcript-device-key-1")
        let c = try await client(keys: keys)
        let outcome = try await c.identity.exchange(
            kind: .google, subjectToken: providerToken, nonce: nonce)
        guard case .signedIn(let ready) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(ready.subject, "ps_abc")
        XCTAssertEqual(ready.scope, "profile email")
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_exchanged")
        XCTAssertEqual(c.identity.account, "ps_abc")

        let tokenCalls = await server.requests(forPath: "/djdl/identity/token")
        let call = try XCTUnwrap(tokenCalls.first)
        XCTAssertEqual(call.headers["content-type"], "application/x-www-form-urlencoded")
        XCTAssertNil(call.headers["authorization"])
        XCTAssertNil(call.url.query)
        let f = form(call)
        XCTAssertEqual(f["grant_type"], "urn:ietf:params:oauth:grant-type:token-exchange")
        XCTAssertEqual(f["client_id"], "djdl")
        XCTAssertEqual(f["subject_token"], providerToken)
        XCTAssertEqual(f["subject_token_type"], "urn:ietf:params:oauth:token-type:id_token")
        XCTAssertEqual(f["nonce"], nonce)
        XCTAssertEqual(f["device_key"], keys.keys.signKey)
        let proof = DeviceProof(
            fields: DeviceProofFields(
                purpose: "exchange", product: "djdl", deviceId: "DEVICE00000000000000000000000001",
                value: "\(nonce).\(keys.keys.signKey)",
                tokenHash: Base64URL.encode(Data(SHA256.hash(data: Data(providerToken.utf8))))),
            signKey: keys.keys.signKey, sig: try XCTUnwrap(f["proof"]))
        XCTAssertTrue(DeviceProofs.verify(proof))
        // A proof for another token, nonce or device does not verify.
        var other = proof
        other.fields.tokenHash = "-"
        XCTAssertFalse(DeviceProofs.verify(other))
    }

    func testTheNonceRouteRegistersTheKeysAndEveryAttemptAsksForAFreshNonce() async throws {
        await discovery()
        let counter = LockedValue(0)
        await server.route("/djdl/identity/nonce") { _ in
            let n = counter.with {
                $0 += 1
                return $0
            }
            let value = String(repeating: n == 1 ? "A" : "B", count: 43)
            return StubServer.Reply(body: #"{"nonce":"\#(value)","expiresIn":300}"#)
        }
        await server.reply("/djdl/identity/token", status: 400, body: #"{"error":"invalid_grant"}"#)
        let keys = try LabelKeyPort(label: "transcript-device-key-1")
        let c = try await client(keys: keys)
        for _ in 0..<2 {
            do {
                _ = try await c.identity.exchange(kind: .google, subjectToken: providerToken, optionalNonce: nil)
                XCTFail("a refusal was accepted")
            } catch is ExchangeError {}
        }
        let nonces = await server.requests(forPath: "/djdl/identity/nonce")
        XCTAssertEqual(nonces.count, 2)
        let body = try JSONDecoder().decode(
            JSONValue.self, from: try XCTUnwrap(nonces.first?.body)
        ).objectValue
        XCTAssertEqual(body?["signKey"]?.stringValue, keys.keys.signKey)
        XCTAssertEqual(body?["agreeKey"]?.stringValue, keys.keys.agreeKey)
        let sent = await server.requests(forPath: "/djdl/identity/token").map { form($0)["nonce"] }
        XCTAssertEqual(sent, [String(repeating: "A", count: 43), String(repeating: "B", count: 43)])
    }

    // ── The outcomes ───────────────────────────────────────────────────────────────────

    func testConfirmIsPendingConsentAndCompleteSendsTheConsent() async throws {
        await discovery()
        await server.reply(
            "/djdl/identity/token",
            body:
                #"{"status":"confirm","grant":"\#(grant)","expiresIn":300,"consent":{"client":{"appName":"djdl","developerName":null,"iconUrl":null,"nameVerified":true},"as":{"provider":"google","email":"ada@example.com"},"items":[{"kind":"profile","claims":["name","picture","email"]}],"scopeHash":"327f","firstTime":true,"changed":false}}"#
        )
        await server.reply("/djdl/identity/choice/complete", body: tokenOk)
        let c = try await client()
        let outcome = try await c.identity.exchange(
            kind: .google, subjectToken: providerToken, nonce: nonce)
        guard case .confirm(let pending) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(pending.grant, grant)
        XCTAssertEqual(pending.consent.as.email, "ada@example.com")
        XCTAssertTrue(pending.consent.firstTime)
        XCTAssertFalse(pending.consent.changed)
        let heldBefore = await c.core.token
        XCTAssertNil(heldBefore, "no token before the person consents")
        for text in [
            "\(pending)", String(reflecting: pending),
            String(describing: Mirror(reflecting: pending).children.map { "\($0.value)" }),
        ] {
            XCTAssertFalse(text.contains(grant), text)
        }

        let done = try await c.identity.choice.complete(
            grant: pending.grant, choice: nil, consent: ChoiceConsent(claims: ["profile", "email"]))
        XCTAssertEqual(done.ready.subject, "ps_abc")
        let completeCalls = await server.requests(forPath: "/djdl/identity/choice/complete")
        let call = try XCTUnwrap(completeCalls.first)
        let body = try JSONDecoder().decode(JSONValue.self, from: try XCTUnwrap(call.body))
        XCTAssertEqual(
            body.objectValue?["consent"],
            .object(["claims": .array([.string("profile"), .string("email")])]))
        XCTAssertNil(body.objectValue?["choice"])
        XCTAssertEqual(body.objectValue?["grant"]?.stringValue, grant)
    }

    func testChooseIsAPendingSignInWithTheView() async throws {
        await discovery()
        await server.reply(
            "/djdl/identity/token",
            body:
                #"{"status":"choose","grant":"\#(grant)","expiresIn":300,"choices":{"state":"choose","choices":[{"id":"lic_a","tierName":"djdl","name":null,"origin":"key","access":"seats","seats":{"used":0,"limit":3},"current":false,"expiresAt":null,"state":"free","replace":null,"freeDeviceUrl":null}],"keep":false,"preselected":null,"create":null,"getLicense":null}}"#
        )
        let c = try await client()
        let outcome = try await c.identity.exchange(
            kind: .apple, subjectToken: providerToken, nonce: nonce)
        guard case .choose(let pending) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(pending.grant, grant)
        XCTAssertEqual(pending.view.choices.map(\.id), ["lic_a"])
        XCTAssertFalse("\(pending)".contains(grant))
        let held = await c.core.token
        XCTAssertNil(held)
    }

    func testNoLinkIsNeedsSignInWithTheHandleAndItNeverPrints() async throws {
        await discovery()
        await server.reply(
            "/djdl/identity/token", status: 403,
            body:
                #"{"error":"interstitial_required","reason":"no_link","url":"\#(api)/identity/authorize","linkHandle":"\#(handle)","expiresIn":600}"#
        )
        let c = try await client()
        let outcome = try await c.identity.exchange(
            kind: .apple, subjectToken: providerToken, nonce: nonce)
        guard case .needsSignIn(let n) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(n.reason, .noLink)
        XCTAssertEqual(n.linkHandle, handle)
        XCTAssertEqual(n.expiresIn, 600)
        XCTAssertEqual(n.url, "\(api)/identity/authorize")
        for text in ["\(n)", String(reflecting: n), "\(Mirror(reflecting: n).children.map { "\($0.value)" })"] {
            XCTAssertFalse(text.contains(handle), text)
        }
        let held = await c.core.token
        XCTAssertNil(held)
    }

    func testTermsHasNoHandleAndAnUnknownReasonReadsAsNoLink() async throws {
        await discovery()
        await server.reply(
            "/djdl/identity/token", status: 403,
            body: #"{"error":"interstitial_required","reason":"terms","url":"\#(api)/identity/authorize"}"#)
        let c = try await client()
        let outcome = try await c.identity.exchange(
            kind: .google, subjectToken: providerToken, nonce: nonce)
        guard case .needsSignIn(let n) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(n.reason, .terms)
        XCTAssertNil(n.linkHandle)

        await server.reply(
            "/djdl/identity/token", status: 403,
            body:
                #"{"error":"interstitial_required","reason":"newer","url":"\#(api)/x","linkHandle":"\#(handle)","expiresIn":600}"#
        )
        guard
            case .needsSignIn(let m) = try await c.identity.exchange(
                kind: .google, subjectToken: providerToken, nonce: nonce)
        else { return XCTFail("not needsSignIn") }
        XCTAssertEqual(m.reason, .noLink)
        XCTAssertNil(m.linkHandle, "only a literal no_link carries a handle")

        // no_link without a handle is still needsSignIn(noLink).
        await server.reply(
            "/djdl/identity/token", status: 403,
            body: #"{"error":"interstitial_required","reason":"no_link","url":"\#(api)/identity/authorize"}"#)
        guard
            case .needsSignIn(let k) = try await c.identity.exchange(
                kind: .google, subjectToken: providerToken, nonce: nonce)
        else { return XCTFail("not needsSignIn") }
        XCTAssertEqual(k.reason, .noLink)
        XCTAssertNil(k.linkHandle)
    }

    func testTheCardUrlMustBeHttpsOrLoopback() async throws {
        await discovery()
        let c = try await client()
        for (url, ok) in [
            ("http://evil.example/card", false), ("javascript:alert(1)", false), ("/relative", false),
            ("http://127.0.0.1:8787/card", true), ("https://key.example/card", true),
        ] {
            await server.reply(
                "/djdl/identity/token", status: 403,
                body: #"{"error":"interstitial_required","reason":"terms","url":"\#(url)"}"#)
            do {
                let outcome = try await c.identity.exchange(
                    kind: .google, subjectToken: providerToken, nonce: nonce)
                XCTAssertTrue(ok, "\(url) was accepted: \(outcome)")
            } catch let e as PolarisError {
                XCTAssertFalse(ok, "\(url) was refused")
                XCTAssertEqual(e.code, ErrorCode.badResponse)
            }
        }
    }

    func testATokenRoute404IsUnavailable() async throws {
        await discovery()
        await server.reply("/djdl/identity/token", status: 404, body: "{}")
        let c = try await client()
        let outcome = try await c.identity.exchange(
            kind: .google, subjectToken: providerToken, nonce: nonce)
        XCTAssertEqual(outcome, .unavailable(code: ErrorCode.notFound))
    }

    func testRefusalsAreTypedAndChangeNothingLocal() async throws {
        await discovery()
        let c = try await client(token: "pkeyt_old")
        for (status, body, code) in [
            (400, #"{"error":"invalid_grant"}"#, "invalid_grant"),
            (400, #"{"error":"unsupported_grant_type"}"#, "unsupported_grant_type"),
            (403, #"{"error":"not_entitled"}"#, "not_entitled"),
            (500, #"{"error":"boom"}"#, IdentityClient.serverError),
        ] {
            await server.reply("/djdl/identity/token", status: status, body: body)
            do {
                _ = try await c.identity.exchange(
                    kind: .google, subjectToken: providerToken, nonce: nonce)
                XCTFail("a refusal was accepted")
            } catch let e as ExchangeError {
                XCTAssertEqual(e.code, code)
                XCTAssertEqual(e.status, status)
                XCTAssertFalse(e.description.contains(providerToken))
            }
        }
        await server.reply(
            "/djdl/identity/token", status: 429, body: #"{"error":"rate_limited","retryAfter":12.2}"#)
        do {
            _ = try await c.identity.exchange(
                kind: .google, subjectToken: providerToken, nonce: nonce)
            XCTFail("a refusal was accepted")
        } catch let e as ExchangeError {
            XCTAssertEqual(e.code, ErrorCode.rateLimited)
            XCTAssertEqual(e.retryAfterSeconds, 13)
        }
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_old")
    }

    func testANonceRoute404IsUnavailableAndNoTokenRequestFollows() async throws {
        await discovery()
        await server.reply("/djdl/identity/nonce", status: 404, body: #"{"error":{"code":"not_found"}}"#)
        let c = try await client()
        let outcome = try await c.identity.exchange(kind: .google, subjectToken: providerToken, optionalNonce: nil)
        XCTAssertEqual(outcome, .unavailable(code: ErrorCode.notFound))
        let tokenCalls = await server.requests(forPath: "/djdl/identity/token")
        XCTAssertTrue(tokenCalls.isEmpty)
        let answer = try await c.identity.exchangeNonce(kind: .google)
        XCTAssertEqual(answer, .unavailable(code: ErrorCode.notFound))
    }

    func testNoExchangeMemberOrKindOrNonceRouteIsUnavailableWithoutARequest() async throws {
        for (exchange, nonceRoute, kind) in [
            (nil as String?, true, ExchangeKind.google),
            (#""exchange":{"kinds":["google"]},"#, true, .apple),
            (#""exchange":{"kinds":["google"]},"#, false, .google),
        ] {
            server = StubServer()
            await discovery(exchange: exchange, nonceRoute: nonceRoute)
            let c = try await client()
            let outcome = try await c.identity.exchange(
                kind: kind, subjectToken: providerToken, nonce: nonce)
            XCTAssertEqual(outcome, .unavailable(code: ErrorCode.platformIdentityUnavailable))
            let sent = await server.requests.filter { $0.url.path.hasPrefix("/djdl/identity/") }
            XCTAssertTrue(sent.isEmpty, "\(sent.map(\.url))")
        }
    }

    func testMemoryOnlyKeysAreUnavailableAndRegisterNothing() async throws {
        await discovery()
        let c = try await client(keys: LabelKeyPort(label: "k", kind: .memory))
        let outcome = try await c.identity.exchange(
            kind: .google, subjectToken: providerToken, nonce: nonce)
        XCTAssertEqual(outcome, .unavailable(code: ErrorCode.platformIdentityUnavailable))
        let sent = await server.requests.filter { $0.url.path.hasPrefix("/djdl/identity/") }
        XCTAssertTrue(sent.isEmpty)
    }

    func testNonceAndTokenArgumentsAreChecked() async throws {
        await discovery()
        let c = try await client()
        for (token, n) in [("", nonce as String?), (providerToken, "short")] {
            do {
                _ = try await c.identity.exchange(kind: .google, subjectToken: token, optionalNonce: n)
                XCTFail("a bad argument was sent")
            } catch let e as PolarisError {
                XCTAssertEqual(e.code, ErrorCode.invalidArgument)
                XCTAssertFalse(e.message.contains(providerToken))
            }
        }
        let sent = await server.requests.filter { $0.url.path.hasPrefix("/djdl/identity/") }
        XCTAssertTrue(sent.isEmpty)
    }

    func testTheNonceNeverPrints() async throws {
        await discovery()
        let c = try await client()
        guard case .nonce(let n) = try await c.identity.exchangeNonce(kind: .google) else {
            return XCTFail("no nonce")
        }
        XCTAssertEqual(n.value, nonce)
        XCTAssertEqual(n.expiresIn, 300)
        for text in ["\(n)", String(reflecting: n), "\(Mirror(reflecting: n).children.map { "\($0.value)" })"] {
            XCTAssertFalse(text.contains(nonce), text)
        }
    }
}
