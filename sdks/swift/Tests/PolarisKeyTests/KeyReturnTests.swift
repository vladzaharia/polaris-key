// @pkey-feature identity.keyreturn
//
// The key return on the redirect sign-in (WIRE-CONTRACT-V5 §12.4, §12.5 rules 3 and 5): the opt-in
// is never sent unless set (web and pushed), the token answer's `via: "key"` is read only with it,
// the outcome is a key activation that clears the held subject, and the flat refusals carry their
// details. The wire conversations are the transcripts' (`redirect-web-key-return*`, replayed in
// `TranscriptTests`).

import Foundation
import PolarisKey
import PolarisKeyCore
import XCTest

@testable import PolarisKeyIdentity

final class KeyReturnTests: XCTestCase {
    private var server = StubServer()
    private let api = "https://key.example/djdl"
    private let redirect = "https://app.example/cb"
    private let tokenPath = "/djdl/identity/token"
    private let subject = "ps_" + String(repeating: "A", count: 22)

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func keyBody(
        scope: String = #""""#, subject: String = "null",
        license: String = #"{"id":"lic_1"}"#, entries: String = #"{"used":1,"limit":10}"#,
        via: String = #""key""#
    ) -> String {
        #"{"access_token":"pkeyt_key","token_type":"Bearer","via":\#(via),"scope":\#(scope),"schemaVersion":1,"device":{"id":"D"},"license":\#(license),"subject":\#(subject),"keyEntries":\#(entries)}"#
    }

    private func client(token: String? = nil) async throws -> PolarisKeyClient {
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body:
                #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"\#(api)/identity","endpoints":{"authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token"}}}}"#
        )
        let store = InMemoryStore(deviceId: "dev")
        if let token { await store.setToken(token) }
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.identity], fingerprint: false))
        c.identity.redirectAcquisitionSync.set(false)
        return c
    }

    private func begin(_ c: PolarisKeyClient, keyReturn: Bool) async throws -> (SignInSession, String) {
        let s = try await c.identity.signIn.start(
            SignInOptions(channel: .redirect, redirectUri: redirect, keyReturn: keyReturn))
        let url = try XCTUnwrap(s.authorizeUrl)
        let state = try XCTUnwrap(
            URLComponents(string: url)?.queryItems?.first(where: { $0.name == "state" })?.value)
        return (s, state)
    }

    private func callback(_ state: String) -> String {
        "\(redirect)?code=C0DE&state=\(state)&iss=https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity"
    }

    // ── Rule 1: the opt-in is never sent unless set ──────────────────────────────────────

    func testTheOptInIsSentLastOnTheWebRequestAndOnlyWhenSet() async throws {
        let c = try await client()
        let (on, _) = try await begin(c, keyReturn: true)
        XCTAssertTrue(try XCTUnwrap(on.authorizeUrl).hasSuffix("&key_return=allow"))
        let (off, _) = try await begin(c, keyReturn: false)
        XCTAssertFalse(try XCTUnwrap(off.authorizeUrl).contains("key_return"))
        XCTAssertFalse(SignInOptions().keyReturn)
    }

    func testTheOptInRidesThePushedRequestBeforeTheDeviceNameAndOnlyWhenSet() throws {
        func push(_ keyReturn: Bool) throws -> PushedRequest {
            try NativeRedirect.pushRequest(
                requestEndpoint: "\(api)/identity/request", authorizeEndpoint: "\(api)/identity/authorize",
                tokenEndpoint: "\(api)/identity/token", issuer: "\(api)/identity", clientId: "djdl",
                redirectUri: "http://127.0.0.1:49152/pkey/callback", deviceName: "Ada's Mac",
                keyReturn: keyReturn, state: "tidewater-state-0123456789",
                codeVerifier: "transcript-verifier-0123456789-abcdefghijklmnopqrst")
        }
        let on = try push(true)
        XCTAssertTrue(on.body.contains("&key_return=allow&device_name="), on.body)
        XCTAssertTrue(on.pending.keyReturn)
        let off = try push(false)
        XCTAssertFalse(off.body.contains("key_return"))
        XCTAssertFalse(off.pending.keyReturn)
    }

    // ── Rule 2: the activated outcome ────────────────────────────────────────────────────

    func testAKeyAnswerWithTheOptInIsAnActivationThatClearsTheSubject() async throws {
        await server.reply(tokenPath, body: keyBody())
        let c = try await client(token: "pkeyt_old")
        c.identity.subjectValue.set(subject)
        let events = LockedValue<[IdentityChange]>([])
        c.identity.identityEvents.set { change in events.with { $0.append(change) } }
        let (s, state) = try await begin(c, keyReturn: true)
        let outcome = try await s.complete(callbackUrl: callback(state))
        guard case .activated(let activated) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(outcome.kind, "activated")
        XCTAssertEqual(activated.licenseId, "lic_1")
        XCTAssertEqual(activated.keyEntries, KeyEntries(used: 1, limit: 10))
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_key")
        // A key activation: rung 1 of automatic sign-in reads only a sign-in provenance.
        let provenance = await c.core.tokenProvenance()
        XCTAssertEqual(provenance, .key)
        XCTAssertNil(c.identity.account)
        let kinds = events.current.map(\.kind)
        XCTAssertEqual(kinds, [IdentityChange.subjectChanged])
        XCTAssertNil(events.current[0].subject)
        XCTAssertEqual(events.current[0].previous, subject)
    }

    func testAnActivationWithNoHeldAccountEmitsNoEvent() async throws {
        await server.reply(tokenPath, body: keyBody())
        let c = try await client()
        let events = LockedValue<[IdentityChange]>([])
        c.identity.identityEvents.set { change in events.with { $0.append(change) } }
        let (s, state) = try await begin(c, keyReturn: true)
        _ = try await s.complete(callbackUrl: callback(state))
        XCTAssertTrue(events.current.isEmpty)
    }

    func testAKeyAnswerWithoutTheOptInIsMalformedAndStoresNothing() async throws {
        await server.reply(tokenPath, body: keyBody())
        let c = try await client()
        let (s, state) = try await begin(c, keyReturn: false)
        do {
            _ = try await s.complete(callbackUrl: callback(state))
            XCTFail("expected bad-response")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.badResponse)
        }
        let held = await c.core.token
        XCTAssertNil(held)
    }

    func testTheStrictParse() throws {
        func parse(_ text: String, keyReturn: Bool = true) throws -> TokenAnswer {
            IdentityRedirect.parseTokenAnswer(
                status: 200, body: try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
                keyReturn: keyReturn)
        }
        guard case .activated(_, let none, _, _, _, let entries) = try parse(keyBody()) else {
            return XCTFail("the valid body is an activation")
        }
        XCTAssertNil(none)
        XCTAssertEqual(entries, KeyEntries(used: 1, limit: 10))
        guard case .activated(_, let named, _, _, _, _) = try parse(keyBody(subject: #""\#(self.subject)""#))
        else { return XCTFail("a pairwise subject is allowed") }
        XCTAssertEqual(named, subject)
        let bad: [(String, String)] = [
            ("a scope", keyBody(scope: #""profile""#)),
            ("no licence", keyBody(license: "null")),
            ("a non-pairwise subject", keyBody(subject: #""someone""#)),
            ("a negative count", keyBody(entries: #"{"used":-1,"limit":10}"#)),
            ("a fractional count", keyBody(entries: #"{"used":1.5,"limit":10}"#)),
            ("no count", keyBody(entries: "null")),
            ("another via", keyBody(via: #""account""#)),
        ]
        for (name, body) in bad { XCTAssertEqual(try parse(body), .malformed, name) }
        XCTAssertEqual(try parse(keyBody(), keyReturn: false), .malformed)
    }

    // ── Rule 2: the flat refusals ────────────────────────────────────────────────────────

    private func refusal(_ body: String, status: Int = 403) async throws -> SignInError {
        await server.reply(tokenPath, status: status, body: body)
        let c = try await client(token: "pkeyt_old")
        let (s, state) = try await begin(c, keyReturn: true)
        do {
            _ = try await s.complete(callbackUrl: callback(state))
            throw XCTSkip("expected a refusal")
        } catch let e as SignInError {
            let held = await c.core.token
            XCTAssertEqual(held, "pkeyt_old")
            return e
        }
    }

    func testLicenseOwnedCarriesTheSignInLink() async throws {
        let e = try await refusal(
            #"{"error":"license_owned","message":"x","signInUrl":"https://key.example/signin?product=djdl"}"#)
        XCTAssertEqual(e.code, "license_owned")
        XCTAssertEqual(e.details?.signInUrl, "https://key.example/signin?product=djdl")
    }

    func testKeyEntryLimitCarriesTheCountAndTheManageLink() async throws {
        let e = try await refusal(
            #"{"error":"key_entry_limit","keyEntries":{"used":1,"limit":1},"manageUrl":"https://key.example/activate"}"#
        )
        XCTAssertEqual(e.code, "key_entry_limit")
        XCTAssertEqual(e.details?.keyEntries, KeyEntries(used: 1, limit: 1))
        XCTAssertEqual(e.details?.manageUrl, "https://key.example/activate")
    }

    func testDeviceLimitCarriesTheLimitTheCountAndTheManageLink() async throws {
        let e = try await refusal(
            #"{"error":"device_limit","limit":1,"deviceCount":1,"manageUrl":"https://key.example/activate"}"#)
        XCTAssertEqual(e.code, "device_limit")
        XCTAssertEqual(e.details?.limit, 1)
        XCTAssertEqual(e.details?.deviceCount, 1)
    }

    func testARefusalWithNoDetailsHasNone() async throws {
        let e = try await refusal(#"{"error":"invalid_grant"}"#, status: 400)
        XCTAssertNil(e.details)
    }
}
