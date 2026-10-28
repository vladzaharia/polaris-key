// @pkey-feature identity.devicecode identity.toggle
//
// I-10b.10: `identity.signIn.start()` and the `SignInSession` it returns: the code fields, the
// settled outcomes (`signedIn`, `expired`, `cancelled`), the typed refusal, the `identity` event.
// The poll arithmetic (pacing, slow_down, transient failures) is IdentityMintTests'.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
import XCTest

final class SignInSessionTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func client() async throws -> PolarisKeyClient {
        try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: InMemoryStore(deviceId: "dev"),
                transport: server.transport, expectedServices: [.license, .identity],
                fingerprint: false))
    }

    private func startFlow() async {
        await server.reply(
            "/djdl/identity/auth/device/start",
            body:
                #"{"deviceCode":"dc","userCode":"ABCD-EFGH","verificationUri":"https://key.example/d","verificationUriComplete":"https://key.example/d?user_code=ABCD-EFGH","expiresIn":600,"interval":1,"deviceName":"Deck"}"#
        )
    }

    func testStartExposesTheCodeAndNothingElse() async throws {
        await startFlow()
        let c = try await client()
        let session = try await c.identity.signIn.start(SignInOptions(deviceName: "Deck"))
        XCTAssertEqual(session.userCode, "ABCD-EFGH")
        XCTAssertEqual(session.verificationUri, "https://key.example/d")
        XCTAssertEqual(session.verificationUriComplete, "https://key.example/d?user_code=ABCD-EFGH")
        XCTAssertEqual(session.expiresIn, 600)
        XCTAssertEqual(session.interval, 1)
        XCTAssertEqual(session.deviceName, "Deck")
        XCTAssertEqual(session.outcome, .pending)
        XCTAssertFalse("\(session)".contains("dc\""), "the poll credential is not printed")
    }

    func testADeniedSignInThrowsTheTypedError() async throws {
        await startFlow()
        await server.reply(
            "/djdl/identity/auth/device/poll", body: #"{"status":"error","reason":"access_denied"}"#)
        let c = try await client()
        let session = try await c.identity.signIn.start()
        do {
            _ = try await session.wait()
            XCTFail("expected sign-in-denied")
        } catch let e as SignInError {
            XCTAssertEqual(e.code, ErrorCode.signInDenied)
        }
        let token = await c.core.token
        XCTAssertNil(token)
    }

    func testAnExpiredCodeIsAnOutcome() async throws {
        await startFlow()
        await server.reply("/djdl/identity/auth/device/poll", body: #"{"status":"timeout"}"#)
        let c = try await client()
        let session = try await c.identity.signIn.start()
        let outcome = try await session.wait()
        XCTAssertEqual(outcome, .expired)
        XCTAssertEqual(session.outcome, .expired)
        let again = try await session.wait()
        XCTAssertEqual(again, .expired, "a settled session answers the same outcome")
    }

    func testCancelEndsTheWaitWithoutBinding() async throws {
        await startFlow()
        await server.reply("/djdl/identity/auth/device/poll", body: #"{"status":"pending"}"#)
        let c = try await client()
        let session = try await c.identity.signIn.start()
        let waiting = Task { try await session.wait() }
        try await Task.sleep(nanoseconds: 200_000_000)
        session.cancel()
        let outcome = try await waiting.value
        XCTAssertEqual(outcome, .cancelled)
        let token = await c.core.token
        XCTAssertNil(token)
    }

    func testCancellingTheCallerThrowsAndLeavesTheSessionAlive() async throws {
        await startFlow()
        await server.reply("/djdl/identity/auth/device/poll", body: #"{"status":"pending"}"#)
        let c = try await client()
        let session = try await c.identity.signIn.start()
        let waiting = Task { try await session.wait() }
        try await Task.sleep(nanoseconds: 200_000_000)
        waiting.cancel()
        do {
            _ = try await waiting.value
            XCTFail("expected CancellationError")
        } catch is CancellationError {}
        XCTAssertEqual(session.outcome, .pending)
        session.cancel()
    }

    func testSignedInStoresTheSubjectAndRaisesTheIdentityEvent() async throws {
        await startFlow()
        await server.reply(
            "/djdl/identity/auth/device/poll",
            body:
                #"{"status":"ready","token":"pkeyt_signed","schemaVersion":1,"subject":"acct_1","identity":{"name":"Ada"}}"#
        )
        let c = try await client()
        var events = c.events.makeAsyncIterator()
        let session = try await c.identity.signIn.start()
        let outcome = try await session.wait()
        XCTAssertEqual(
            outcome,
            .signedIn(
                SignInReady(identity: SignInIdentity(name: "Ada"), attached: nil, subject: "acct_1")))
        XCTAssertEqual(c.identity.account, "acct_1")
        var seen: PolarisKeyEvent?
        while let e = await events.next() {
            if e.kind == "identity" {
                seen = e
                break
            }
        }
        XCTAssertEqual(seen, .identity(kind: "signedIn", subject: "acct_1", previous: nil))
    }
}
