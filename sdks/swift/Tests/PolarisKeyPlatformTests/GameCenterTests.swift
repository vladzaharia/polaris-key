// @pkey-feature identity.gamecenter
import Foundation
import XCTest

@testable import PolarisKeyGameCenter

private struct FakePlayer: GameCenterPlayerPort {
    var authenticated = true
    var persistent = true
    var team = "T:transcript-team-player-1"
    var signature: Result<GameCenterSignature, Error> = .success(
        GameCenterSignature(
            publicKeyURL: URL(string: "https://static.gc.apple.com/public-key/gc-prod-12.cer")!,
            signature: Data([1, 2, 3]), salt: Data([0x50, 0x4B, 0x65, 0x79, 1, 2, 3, 4]),
            timestamp: 1_699_999_995_000))

    func isAuthenticated() async -> Bool { authenticated }
    func scopedIDsArePersistent() async -> Bool { persistent }
    func teamPlayerID() async -> String { team }
    func identityVerification() async throws -> GameCenterSignature { try signature.get() }
}

final class GameCenterTests: XCTestCase {
    private let bundle: @Sendable () -> String? = { "com.acme.mac" }

    func testTheTokenIsThePrefixAndSixFieldsInV5Order() async throws {
        let token = try await GameCenterIdentity(port: FakePlayer(), bundleID: bundle).token()
        XCTAssertEqual(
            token,
            "gc1.aHR0cHM6Ly9zdGF0aWMuZ2MuYXBwbGUuY29tL3B1YmxpYy1rZXkvZ2MtcHJvZC0xMi5jZXI.AQID"
                + ".UEtleQECAwQ.1699999995000.VDp0cmFuc2NyaXB0LXRlYW0tcGxheWVyLTE.Y29tLmFjbWUubWFj")
        XCTAssertEqual(token.split(separator: ".").count, 7)
    }

    func testTheSubjectTokenType() {
        XCTAssertEqual(gameCenterSubjectTokenType, "urn:polaris-key:token-type:gamecenter-signature")
    }

    func testAPlayerWhoIsNotSignedInFailsTheRung() async {
        await assertFails(FakePlayer(authenticated: false), .notAuthenticated)
    }

    func testIdsThatAreNotPersistentAreNotOffered() async {
        await assertFails(FakePlayer(persistent: false), .idsNotPersistent)
    }

    func testAFailedVerificationIsOneTypedFailure() async {
        struct Boom: Error {}
        await assertFails(FakePlayer(signature: .failure(Boom())), .verificationFailed)
    }

    func testAMissingBundleIdOrAnEmptyFieldIsMalformed() async {
        let none = GameCenterIdentity(port: FakePlayer(), bundleID: { nil })
        do {
            _ = try await none.token()
            XCTFail("expected a failure")
        } catch { XCTAssertEqual(error as? GameCenterFailure, .malformed) }
        await assertFails(FakePlayer(team: ""), .malformed)
    }

    func testATokenOverFourThousandAndNinetySixCharactersIsRefused() async {
        let big = GameCenterSignature(
            publicKeyURL: URL(string: "https://static.gc.apple.com/public-key/a.cer")!,
            signature: Data(repeating: 7, count: 4000), salt: Data([1]), timestamp: 1)
        await assertFails(FakePlayer(signature: .success(big)), .malformed)
    }

    func testNothingSecretIsPrinted() {
        let s = GameCenterSignature(
            publicKeyURL: URL(string: "https://static.gc.apple.com/public-key/a.cer")!,
            signature: Data([9, 9, 9]), salt: Data([8, 8, 8]), timestamp: 5)
        for text in ["\(s)", String(reflecting: s), String(describing: Mirror(reflecting: s).children.map { "\($0.value)" })] {
            XCTAssertFalse(text.contains("CQkJ"))
            XCTAssertFalse(text.contains("09"))
        }
    }

    private func assertFails(
        _ player: FakePlayer, _ expected: GameCenterFailure, line: UInt = #line
    ) async {
        do {
            _ = try await GameCenterIdentity(port: player, bundleID: bundle).token()
            XCTFail("expected \(expected)", line: line)
        } catch {
            XCTAssertEqual(error as? GameCenterFailure, expected, line: line)
        }
    }
}
