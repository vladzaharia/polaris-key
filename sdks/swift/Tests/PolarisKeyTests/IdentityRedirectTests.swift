// @pkey-feature identity.redirect.web identity.signin.hints
//
// I-10b.11: the redirect core's vectors, ported from client-core's `identityRedirect.test.ts`
// (RFC 7636 appendix B, the transcript conversation's authorize URL and form body, the callback
// checks, the token answers). The wire conversation itself is the transcripts' (`redirect-web-*`,
// `locker-redirect-web`, `identity-request-hints`).

import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKeyIdentity

final class IdentityRedirectTests: XCTestCase {
    private let iss = "https://key.plrs.im/djdl/identity"
    private let state = "tidewater-state-0123456789"
    private let verifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
    private let redirect = "https://app.example/auth/callback"
    private let authorizeEndpoint = "https://key.plrs.im/djdl/identity/authorize"
    private let tokenEndpoint = "https://key.plrs.im/djdl/identity/token"

    private var auth: String {
        "\(authorizeEndpoint)?response_type=code&client_id=djdl&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback&state=\(state)&code_challenge=-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10&code_challenge_method=S256&scope=profile+email"
    }

    private func begin(
        redirectUri: String? = nil, scope: [String]? = nil, loginHint: String? = nil,
        nameHint: String? = nil, purpose: String? = nil, licenseChoice: String? = nil,
        choiceAvailable: Bool = false, issuer: String? = nil, tokenEndpoint: String? = nil,
        state: String? = nil, codeVerifier: String? = nil
    ) throws -> RedirectPending {
        try IdentityRedirect.start(
            authorizeEndpoint: authorizeEndpoint, tokenEndpoint: tokenEndpoint ?? self.tokenEndpoint,
            issuer: issuer ?? iss, clientId: "djdl", redirectUri: redirectUri ?? redirect,
            scope: scope, loginHint: loginHint, nameHint: nameHint, purpose: purpose,
            licenseChoice: licenseChoice, choiceAvailable: choiceAvailable,
            state: state ?? self.state, codeVerifier: codeVerifier ?? verifier)
    }

    // ── S256 PKCE ────────────────────────────────────────────────────────────────────────

    func testPkceChallenges() {
        // RFC 7636 appendix B
        XCTAssertEqual(
            IdentityRedirect.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        // the conformance/transcripts conversation
        XCTAssertEqual(
            IdentityRedirect.pkceChallenge(verifier), "-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10")
    }

    func testGeneratedVerifiersAndStates() {
        let a = IdentityRedirect.generateCodeVerifier()
        XCTAssertEqual(a.count, 43)
        XCTAssertTrue(a.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
        XCTAssertNotEqual(IdentityRedirect.generateCodeVerifier(), a)
        XCTAssertEqual(IdentityRedirect.generateState().count, 43)
        XCTAssertEqual(
            IdentityRedirect.generateState(random: { [UInt8](repeating: 0, count: $0) }),
            String(repeating: "A", count: 43))
    }

    // ── The authorize URL ────────────────────────────────────────────────────────────────

    func testAuthorizeUrlVectors() throws {
        struct Vector {
            let name: String
            let build: () throws -> RedirectPending
            let url: String
        }
        let vectors: [Vector] = [
            Vector(name: "the plain request", build: { try self.begin() }, url: auth),
            Vector(
                name: "hints, verbatim and form-encoded",
                build: { try self.begin(loginHint: "Ada@Example.com", nameHint: "Ada", purpose: "attach") },
                url: "\(auth)&login_hint=Ada%40Example.com&name_hint=Ada&purpose=attach"),
            Vector(
                name: "a hint that is not an email is still sent as given",
                build: { try self.begin(loginHint: "not an email") },
                url: "\(auth)&login_hint=not+an+email"),
            Vector(
                name: "license_choice=app when asked and the choice endpoints exist",
                build: { try self.begin(licenseChoice: "app", choiceAvailable: true) },
                url: "\(auth)&license_choice=app"),
            Vector(
                name: "license_choice withheld when discovery has no choice endpoints",
                build: { try self.begin(licenseChoice: "app", choiceAvailable: false) }, url: auth),
            Vector(
                name: "license_choice=card is never sent",
                build: { try self.begin(licenseChoice: "card", choiceAvailable: true) }, url: auth),
            Vector(
                name: "a scope list", build: { try self.begin(scope: ["profile", "cloudSync"]) },
                url: auth.replacingOccurrences(of: "scope=profile+email", with: "scope=profile+cloudSync")),
            Vector(
                name: "empty hints are dropped", build: { try self.begin(loginHint: "", nameHint: "") },
                url: auth),
            Vector(
                name: "UTF-8, * and ~ in a hint (WHATWG form encoding)",
                build: { try self.begin(nameHint: "Zoë * ~") },
                url: "\(auth)&name_hint=Zo%C3%AB+*+%7E"),
        ]
        for v in vectors {
            let pending = try v.build()
            XCTAssertEqual(pending.authorizeUrl, v.url, v.name)
            XCTAssertEqual(pending.state, state, v.name)
            XCTAssertFalse(pending.authorizeUrl.contains(verifier), v.name)
        }
    }

    func testRandomEntropyYieldsARequestThatSatisfiesItsOwnRules() throws {
        let p = try IdentityRedirect.start(
            authorizeEndpoint: authorizeEndpoint, tokenEndpoint: tokenEndpoint, issuer: iss,
            clientId: "djdl", redirectUri: redirect)
        XCTAssertEqual(p.state.count, 43)
        XCTAssertTrue(
            p.authorizeUrl.contains(
                "code_challenge=\(IdentityRedirect.pkceChallenge(p.codeVerifierForTests))"))
    }

    func testRefusesBeforeAnythingIsBuilt() {
        let cases: [(String, () throws -> RedirectPending)] = [
            ("http redirect", { try self.begin(redirectUri: "http://app.example/cb") }),
            ("loopback http (I-15's)", { try self.begin(redirectUri: "http://127.0.0.1:8080/cb") }),
            ("a fragment", { try self.begin(redirectUri: "\(self.redirect)#x") }),
            ("userinfo", { try self.begin(redirectUri: "https://u:p@app.example/cb") }),
            ("a relative URI", { try self.begin(redirectUri: "/cb") }),
            ("a short state", { try self.begin(state: "short") }),
            ("a short verifier", { try self.begin(codeVerifier: "too-short") }),
            (
                "a verifier outside the unreserved set",
                { try self.begin(codeVerifier: String(repeating: "a", count: 42) + "+") }
            ),
            ("no issuer", { try self.begin(issuer: "") }),
            (
                "a relative token endpoint",
                { try self.begin(tokenEndpoint: "/djdl/identity/token") }
            ),
            ("an empty scope", { try self.begin(scope: ["  "]) }),
        ]
        for (name, build) in cases {
            XCTAssertThrowsError(try build(), name) { error in
                XCTAssertEqual((error as? PolarisError)?.code, ErrorCode.invalidArgument, name)
            }
        }
    }

    func testIsRedirectUri() {
        XCTAssertTrue(IdentityRedirect.isRedirectUri(redirect))
        XCTAssertTrue(IdentityRedirect.isRedirectUri("https://app.example"))
        XCTAssertFalse(IdentityRedirect.isRedirectUri("https://app.example/a b"))
        XCTAssertFalse(IdentityRedirect.isRedirectUri("https://app.example\\@evil.example/"))
        XCTAssertFalse(IdentityRedirect.isRedirectUri(nil))
    }

    func testThePendingRequestNeverPrintsItsVerifier() throws {
        let p = try begin()
        XCTAssertFalse("\(p)".contains(verifier))
        XCTAssertFalse(String(reflecting: p).contains(verifier))
    }

    // ── checkCallback ────────────────────────────────────────────────────────────────────

    private func check(_ url: String) -> CallbackResult {
        IdentityRedirect.checkCallback(
            state: state, redirectUri: redirect, issuer: iss, callbackUrl: url)
    }

    private func failed(_ reason: CallbackFailure, _ error: String? = nil) -> CallbackResult {
        .failed(reason: reason, error: error)
    }

    func testCallbackVectors() {
        let issEnc = "https%3A%2F%2Fkey.plrs.im%2Fdjdl%2Fidentity"
        let ok = "\(redirect)?code=abc_DEF-123&state=\(state)&iss=\(issEnc)"
        let vectors: [(String, String, CallbackResult)] = [
            ("a valid callback", ok, .code("abc_DEF-123")),
            (
                "parameters in another order, with an extra one",
                "\(redirect)?iss=\(issEnc)&x=1&state=\(state)&code=c", .code("c")
            ),
            (
                "access_denied is cancelled",
                "\(redirect)?error=access_denied&state=\(state)&iss=\(issEnc)", .cancelled
            ),
            (
                "another error is a failure, naming it",
                "\(redirect)?error=server_error&state=\(state)&iss=\(issEnc)",
                failed(.authorizationError, "server_error")
            ),
            (
                "a wrong state", ok.replacingOccurrences(of: state, with: "another-state-0123456789"),
                failed(.stateMismatch)
            ),
            ("no state", "\(redirect)?code=c&iss=\(issEnc)", failed(.stateMismatch)),
            (
                "a wrong issuer (mix-up, RFC 9207)",
                "\(redirect)?code=c&state=\(state)&iss=https%3A%2F%2Fevil.example%2Fdjdl%2Fidentity",
                failed(.issuerMismatch)
            ),
            ("no issuer", "\(redirect)?code=c&state=\(state)", failed(.issuerMismatch)),
            (
                "state is checked before iss, and iss before error",
                "\(redirect)?error=access_denied&state=bad-state-0123456789&iss=x", failed(.stateMismatch)
            ),
            (
                "an access_denied from the wrong issuer is not a cancel",
                "\(redirect)?error=access_denied&state=\(state)&iss=x", failed(.issuerMismatch)
            ),
            ("no code", "\(redirect)?state=\(state)&iss=\(issEnc)", failed(.missingCode)),
            ("an empty code", "\(redirect)?code=&state=\(state)&iss=\(issEnc)", failed(.missingCode)),
            ("a repeated code", "\(ok)&code=other", failed(.malformed)),
            (
                "another redirect URI path", ok.replacingOccurrences(of: "/auth/callback", with: "/other"),
                failed(.redirectMismatch)
            ),
            (
                "another origin", ok.replacingOccurrences(of: "app.example", with: "evil.example"),
                failed(.redirectMismatch)
            ),
            (
                "a fragment carrying the code is not read",
                "\(redirect)#code=c&state=\(state)&iss=\(issEnc)", failed(.stateMismatch)
            ),
            ("not a URL", "code=c&state=x", failed(.malformed)),
        ]
        for (name, url, expected) in vectors {
            XCTAssertEqual(check(url), expected, name)
        }
    }

    func testAMalformedPercentEscapeIsMalformedNotACrash() {
        guard case .failed(let reason, _) = check("\(redirect)?code=%E0%A4%A&state=\(state)") else {
            return XCTFail("expected a failure")
        }
        XCTAssertEqual(reason, .malformed)
    }

    // ── tokenForm ────────────────────────────────────────────────────────────────────────

    func testTokenFormHasAFixedMemberOrder() {
        let code = "pql7NwTrZq8ADBYf14sz1sjf4BSnZl-AaWyCGWs9TX0"
        XCTAssertEqual(
            IdentityRedirect.tokenForm(
                clientId: "djdl", codeVerifier: verifier, redirectUri: redirect, code: code),
            "grant_type=authorization_code&client_id=djdl&code=\(code)&code_verifier=\(verifier)&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback"
        )
    }

    func testTokenFormAddsDeviceNameLast() {
        let form = IdentityRedirect.tokenForm(
            clientId: "djdl", codeVerifier: verifier, redirectUri: redirect, code: "c",
            deviceName: "Ada's PC")
        XCTAssertTrue(
            form.hasSuffix("&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback&device_name=Ada%27s+PC"), form)
    }

    // ── parseTokenAnswer ─────────────────────────────────────────────────────────────────

    private let grant = "sg_" + String(repeating: "A", count: 43)

    private func json(_ text: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    func testATokenResponse() {
        let answer = IdentityRedirect.parseTokenAnswer(
            status: 200,
            body: json(
                #"{"access_token":"pkeyt_x","token_type":"Bearer","scope":"profile email","schemaVersion":1,"device":{"id":"D","status":"authorized"},"license":null,"subject":"ps_abc"}"#
            ))
        XCTAssertEqual(
            answer,
            .token(
                accessToken: "pkeyt_x", scope: "profile email", subject: "ps_abc", schemaVersion: 1,
                device: ["id": .string("D"), "status": .string("authorized")], license: nil))
    }

    func testChooseIsDecidedByStatusAloneEvenBesideOtherMembers() {
        let answer = IdentityRedirect.parseTokenAnswer(
            status: 200,
            body: json(
                #"{"status":"choose","grant":"\#(grant)","expiresIn":300,"choices":{"state":"choose"},"access_token":"pkeyt_ignored"}"#
            ))
        XCTAssertEqual(
            answer, .choose(grant: grant, expiresIn: 300, choices: ["state": .string("choose")]))
    }

    func testA200ThatLacksWhatTheCallNeedsIsMalformed() {
        let bodies: [(String, String)] = [
            ("a bad grant", #"{"status":"choose","grant":"sg_short","expiresIn":1,"choices":{}}"#),
            ("no access_token", #"{"scope":"x","subject":"s","device":{"id":"D"},"license":null}"#),
            ("no subject", #"{"access_token":"t","scope":"x","device":{"id":"D"},"license":null}"#),
            ("no license member", #"{"access_token":"t","scope":"x","subject":"s","device":{"id":"D"}}"#),
            ("not an object", #""x""#),
        ]
        for (name, body) in bodies {
            XCTAssertEqual(
                IdentityRedirect.parseTokenAnswer(status: 200, body: json(body)), .malformed, name)
        }
    }

    func testRefusals() {
        let vectors: [(Int, String, TokenAnswer)] = [
            (400, #"{"error":"invalid_grant"}"#, .refused(error: "invalid_grant", status: 400, retryAfterSeconds: nil)),
            (
                401, #"{"error":"invalid_client"}"#,
                .refused(error: "invalid_client", status: 401, retryAfterSeconds: nil)
            ),
            (
                429, #"{"error":"rate_limited","retryAfter":2.2}"#,
                .refused(error: "rate_limited", status: 429, retryAfterSeconds: 3)
            ),
            (500, #""oops""#, .refused(error: "server_error", status: 500, retryAfterSeconds: nil)),
            (502, #"{"error":""}"#, .refused(error: "server_error", status: 502, retryAfterSeconds: nil)),
        ]
        for (status, body, expected) in vectors {
            XCTAssertEqual(
                IdentityRedirect.parseTokenAnswer(status: status, body: json(body)), expected,
                "\(status) \(body)")
        }
    }
}
