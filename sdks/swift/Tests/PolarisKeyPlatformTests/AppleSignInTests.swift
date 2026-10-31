import Foundation
import XCTest

@testable import PolarisKeyPlatform

#if canImport(AuthenticationServices)
    import AuthenticationServices
#endif

private final class MemoryUserIDs: AppleUserIDStoring, @unchecked Sendable {
    private let box = PlatformLock<String?>(nil)
    func load() -> String? { box.withLock { $0 } }
    func save(_ userID: String) { box.withLock { $0 = userID } }
    func clear() { box.withLock { $0 = nil } }
}

private final class FakeAuthorizer: AppleIDAuthorizing, @unchecked Sendable {
    struct Call: Equatable {
        var nonce: String
        var immediate: Bool
    }
    private let calls_ = PlatformLock<[Call]>([])
    private let state_ = PlatformLock<AppleCredentialState>(.authorized)
    var result: Result<AppleSignInGrant, AppleSignInFailure>
    init(_ result: Result<AppleSignInGrant, AppleSignInFailure>) { self.result = result }

    var calls: [Call] { calls_.withLock { $0 } }
    func setState(_ s: AppleCredentialState) { state_.withLock { $0 = s } }

    func authorize(nonce: String, immediate: Bool) async throws -> AppleSignInGrant {
        calls_.withLock { $0.append(Call(nonce: nonce, immediate: immediate)) }
        return try result.get()
    }
    func credentialState(forUserID userID: String) async -> AppleCredentialState {
        state_.withLock { $0 }
    }
}

final class AppleSignInTests: XCTestCase {
    private let grant = AppleSignInGrant(
        userID: "001234.abcd", identityToken: "eyJ.SECRET.token", authorizationCode: "c-SECRET", email: "a@b.test")

    func testSilentIsUnavailableAndNeverReachesTheAuthorizer() async {
        let fake = FakeAuthorizer(.success(grant))
        let apple = AppleSignIn(authorizer: fake, userIDs: MemoryUserIDs())
        do {
            _ = try await apple.silent(nonce: "Zm9vLWJhci1ub25jZQ")
            XCTFail("expected a failure")
        } catch {
            guard case .unavailable? = error as? AppleSignInFailure else { return XCTFail("\(error)") }
        }
        XCTAssertTrue(fake.calls.isEmpty)
    }

    func testSheetPassesTheServerNonceAsIsAndPrefersImmediate() async throws {
        let fake = FakeAuthorizer(.success(grant))
        let apple = AppleSignIn(authorizer: fake, userIDs: MemoryUserIDs())
        let nonce = "Zm9vLWJhci1ub25jZQ"
        let got = try await apple.sheet(nonce: nonce)
        XCTAssertEqual(got, grant)
        XCTAssertEqual(fake.calls, [.init(nonce: nonce, immediate: true)])
    }

    func testSheetIsNotImmediate() async throws {
        let fake = FakeAuthorizer(.success(grant))
        let ids = MemoryUserIDs()
        let apple = AppleSignIn(authorizer: fake, userIDs: ids)
        _ = try await apple.sheet(nonce: "n1", preferImmediate: false)
        XCTAssertEqual(fake.calls, [.init(nonce: "n1", immediate: false)])
        XCTAssertNil(ids.load(), "the id is kept only by remember(userID:)")
    }

    func testEmptyNonceIsRefusedBeforeAnyRequest() async {
        let fake = FakeAuthorizer(.success(grant))
        let apple = AppleSignIn(authorizer: fake, userIDs: MemoryUserIDs())
        do {
            _ = try await apple.sheet(nonce: "")
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? AppleSignInFailure, .unavailable("empty nonce"))
        }
        XCTAssertTrue(fake.calls.isEmpty)
    }

    func testFailuresPassThroughAndKeepNoUserID() async {
        for failure in [AppleSignInFailure.cancelled, .unavailable("x")] {
            let ids = MemoryUserIDs()
            let apple = AppleSignIn(authorizer: FakeAuthorizer(.failure(failure)), userIDs: ids)
            do {
                _ = try await apple.sheet(nonce: "n")
                XCTFail("expected a failure")
            } catch {
                XCTAssertEqual(error as? AppleSignInFailure, failure)
            }
            XCTAssertNil(ids.load())
        }
    }

    func testUserIDIsKeptAndDrivesTheLaunchCheck() async throws {
        let fake = FakeAuthorizer(.success(grant))
        let ids = MemoryUserIDs()
        let apple = AppleSignIn(authorizer: fake, userIDs: ids)
        let before = await apple.credentialState()
        XCTAssertNil(before)
        let beforeRevoked = await apple.credentialRevoked()
        XCTAssertFalse(beforeRevoked)

        _ = try await apple.sheet(nonce: "n")
        XCTAssertNil(ids.load())
        apple.remember(userID: "001234.abcd")
        XCTAssertEqual(ids.load(), "001234.abcd")
        let authorized = await apple.credentialRevoked()
        XCTAssertFalse(authorized)

        fake.setState(.revoked)
        let revoked = await apple.credentialRevoked()
        XCTAssertTrue(revoked)
        fake.setState(.notFound)
        let gone = await apple.credentialRevoked()
        XCTAssertFalse(gone, "not found is not revocation")
        fake.setState(.transferred)
        let moved = await apple.credentialRevoked()
        XCTAssertFalse(moved)

        apple.signOutCleanup()
        XCTAssertNil(ids.load())
    }

    // ── The router ops (I-48.4a) ─────────────────────────────────────────────────────────────

    private func routed(_ fake: FakeAuthorizer, ids: MemoryUserIDs = MemoryUserIDs()) -> (PlatformHost, EventLog) {
        let h = PlatformHost(
            services: fakeServices(appleSignIn: AppleSignIn(authorizer: fake, userIDs: ids)))
        return (h, EventLog(h.sink))
    }

    private func call(_ h: PlatformHost, _ q: PlatformObject) -> PlatformObject {
        decodePlatformJSON(h.call(encodePlatformJSON(q))) ?? [:]
    }

    func testCapabilityFollowsTheService() {
        let (h, _) = routed(FakeAuthorizer(.success(grant)))
        XCTAssertEqual(call(h, ["op": "capabilities"])["appleSignIn"], true)
        let none = PlatformHost(services: fakeServices())
        XCTAssertEqual(call(none, ["op": "capabilities"])["appleSignIn"], false)
        XCTAssertEqual(call(none, ["op": "apple_sign_in", "nonce": "n"])["reason"], "runtime")
        XCTAssertEqual(call(none, ["op": "apple_forget"])["unsupported"], true)
    }

    func testSignInEventCarriesTheTokenAndTheUserID() async {
        let fake = FakeAuthorizer(.success(grant))
        let (h, log) = routed(fake)
        let ack = call(h, ["op": "apple_sign_in", "nonce": "bm9uY2U"])
        let ev = await log.result(ack["req"])
        XCTAssertEqual(ev["ev"], "apple_sign_in")
        XCTAssertEqual(ev["ok"], true)
        XCTAssertEqual(ev["token"], "eyJ.SECRET.token")
        XCTAssertEqual(ev["userID"], "001234.abcd")
        // `immediate` defaults to true; the ack itself carries no secret.
        XCTAssertEqual(fake.calls, [.init(nonce: "bm9uY2U", immediate: true)])
        XCTAssertNil(ack["token"])
    }

    func testSignInPassesImmediateFalseForThePlainSheet() async {
        let fake = FakeAuthorizer(.success(grant))
        let (h, log) = routed(fake)
        _ = await log.result(call(h, ["op": "apple_sign_in", "nonce": "n", "immediate": false])["req"])
        XCTAssertEqual(fake.calls.first?.immediate, false)
    }

    func testSignInFailuresAreTyped() async {
        for (failure, code) in [
            (AppleSignInFailure.cancelled, "cancelled"), (.unavailable("x"), "unavailable"),
        ] {
            let (h, log) = routed(FakeAuthorizer(.failure(failure)))
            let ev = await log.result(call(h, ["op": "apple_sign_in", "nonce": "n"])["req"])
            XCTAssertEqual(ev["ok"], false)
            XCTAssertEqual(ev["error"], .string(code))
            XCTAssertNil(ev["token"])
        }
        let (h, _) = routed(FakeAuthorizer(.success(grant)))
        XCTAssertEqual(call(h, ["op": "apple_sign_in"])["error"], "missing_nonce")
        XCTAssertEqual(call(h, ["op": "apple_sign_in", "nonce": ""])["error"], "missing_nonce")
    }

    func testRememberStateAndForget() async {
        let fake = FakeAuthorizer(.success(grant))
        let ids = MemoryUserIDs()
        let (h, log) = routed(fake, ids: ids)
        var ev = await log.result(call(h, ["op": "apple_credential_state"])["req"])
        XCTAssertEqual(ev["state"], "none")
        XCTAssertEqual(call(h, ["op": "apple_remember"])["error"], "missing_user_id")
        XCTAssertEqual(call(h, ["op": "apple_remember", "userID": "001234.abcd"])["ok"], true)
        XCTAssertEqual(ids.load(), "001234.abcd")
        fake.setState(.revoked)
        ev = await log.result(call(h, ["op": "apple_credential_state"])["req"])
        XCTAssertEqual(ev["state"], "revoked")
        XCTAssertEqual(call(h, ["op": "apple_forget"])["ok"], true)
        XCTAssertNil(ids.load())
    }

    func testTheTokenNeverReachesADescription() {
        for text in [
            grant.description, grant.debugDescription, "\(grant)", String(reflecting: grant),
        ] where text.contains("SECRET") {
            XCTFail("secret in \(text)")
        }
    }

    #if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(tvOS) || os(visionOS))
        func testSystemErrorsMapToCancelledOrUnavailable() {
            func err(_ code: ASAuthorizationError.Code) -> Error {
                NSError(domain: ASAuthorizationError.errorDomain, code: code.rawValue)
            }
            XCTAssertEqual(SystemAppleIDAuthorizer.typed(err(.canceled)), .cancelled)
            XCTAssertEqual(SystemAppleIDAuthorizer.typed(err(.notInteractive)), .cancelled)
            for c: ASAuthorizationError.Code in [.unknown, .failed, .invalidResponse, .notHandled] {
                guard case .unavailable = SystemAppleIDAuthorizer.typed(err(c)) else {
                    return XCTFail("\(c) should be unavailable")
                }
            }
            guard case .unavailable = SystemAppleIDAuthorizer.typed(NSError(domain: "other", code: 1)) else {
                return XCTFail("a foreign error should be unavailable")
            }
        }
    #endif
}
