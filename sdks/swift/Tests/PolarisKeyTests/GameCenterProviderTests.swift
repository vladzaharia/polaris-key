// @pkey-feature identity.gamecenter
import Foundation
import PolarisKey
import PolarisKeyGameCenter
import PolarisKeyIdentity
import XCTest

@testable import PolarisKeyIdentity

final class GameCenterProviderTests: XCTestCase {
    private func provider(authenticated: Bool = true, persistent: Bool = true) -> GameCenterSignInProvider {
        GameCenterSignInProvider(
            identity: GameCenterIdentity(
                port: ReplayGameCenterPlayer(
                    signature: GameCenterSignature(
                        publicKeyURL: URL(string: "https://static.gc.apple.com/public-key/a.cer")!,
                        signature: Data([1]), salt: Data([2]), timestamp: 3),
                    team: "T:x", authenticated: authenticated, persistent: persistent),
                bundleID: { "com.acme.mac" }))
    }

    func testTheProviderIsTheGameCenterKindWithASilentRungAndNoSheet() async throws {
        let p = provider()
        XCTAssertEqual(p.kind, .gamecenter)
        XCTAssertTrue(p.hasSilentRung)
        let silent = try await p.silent(nonce: "n")
        XCTAssertTrue(silent.token.hasPrefix("gc1."))
        XCTAssertEqual(silent.nonce, "n")
        XCTAssertNil(silent.userID)
        let revoked = await p.credentialRevoked()
        XCTAssertFalse(revoked)
        do {
            _ = try await p.sheet(nonce: "n")
            XCTFail("Game Center has no sheet")
        } catch {}
    }

    func testAPlayerWhoIsOutOrWhoseIdsMayChangeGetsNoToken() async {
        for p in [provider(authenticated: false), provider(persistent: false)] {
            do {
                _ = try await p.silent(nonce: "n")
                XCTFail("expected a failure")
            } catch { XCTAssertTrue(error is GameCenterFailure) }
        }
    }

    func testTheGrantTypeIsGameCentersAndTheIdTokenTypeIsUnchanged() {
        XCTAssertEqual(ExchangeKind.gamecenter.subjectTokenType, gameCenterSubjectTokenType)
        XCTAssertEqual(ExchangeKind.apple.subjectTokenType, "urn:ietf:params:oauth:token-type:id_token")
        XCTAssertEqual(ExchangeKind.google.subjectTokenType, "urn:ietf:params:oauth:token-type:id_token")
    }
}
