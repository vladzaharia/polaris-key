// @pkey-feature identity.gamecenter
import Foundation
import XCTest

@testable import PolarisKeyGameCenter
@testable import PolarisKeyGameCenterC
@testable import PolarisKeyPlatform

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

// ── The Godot extension's op (I-48.6a) ───────────────────────────────────────────────────────

final class GameCenterOpsTests: XCTestCase {
    private func host(_ player: any GameCenterPlayerPort) -> (GameCenterHost, EventLog) {
        let h = GameCenterHost(identity: GameCenterIdentity(port: player, bundleID: { "com.acme.mac" }))
        return (h, EventLog(h.sink))
    }

    private func call(_ h: GameCenterHost, _ q: PlatformObject) -> PlatformObject {
        decodePlatformJSON(h.call(encodePlatformJSON(q))) ?? [:]
    }

    func testTheOpAnswersTheRawFieldsInOneEvent() async {
        let (h, log) = host(FakeGCPlayer())
        let ack = call(h, ["op": "gc_identity"])
        XCTAssertEqual(ack["ok"], true)
        XCTAssertNil(ack["signature"], "the ack carries no secret")
        let ev = await log.result(ack["req"])
        XCTAssertEqual(ev["ev"], "gc_identity")
        XCTAssertEqual(ev["ok"], true)
        XCTAssertEqual(ev["publicKeyUrl"], "https://static.gc.apple.com/public-key/gc-prod-12.cer")
        XCTAssertEqual(ev["signature"], "AQID")
        XCTAssertEqual(ev["salt"], "UEtleQECAwQ")
        XCTAssertEqual(ev["timestamp"], "1699999995000")
        XCTAssertEqual(ev["teamPlayerId"], "T:transcript-team-player-1")
        XCTAssertEqual(ev["bundleId"], "com.acme.mac")
    }

    func testFailuresAreTypedAndCarryNoField() async {
        let cases: [(FakeGCPlayer, String)] = [
            (FakeGCPlayer(authenticated: false), "not_authenticated"),
            (FakeGCPlayer(persistent: false), "ids_not_persistent"),
            (FakeGCPlayer(fail: true), "verification_failed"),
            (FakeGCPlayer(team: ""), "malformed"),
        ]
        for (player, code) in cases {
            let (h, log) = host(player)
            let ev = await log.result(call(h, ["op": "gc_identity"])["req"])
            XCTAssertEqual(ev["ok"], false)
            XCTAssertEqual(ev["error"], .string(code))
            XCTAssertNil(ev["signature"])
        }
    }

    func testSyncOpsAndErrors() {
        let (h, _) = host(FakeGCPlayer())
        XCTAssertEqual(call(h, ["op": "ping"])["ok"], true)
        XCTAssertEqual(call(h, ["op": "capabilities"])["protocol"], 1)
        XCTAssertEqual(call(h, ["op": "nope"])["error"], "unknown_op")
        XCTAssertEqual(call(h, [:])["error"], "missing_op")
        XCTAssertEqual(decodePlatformJSON(h.call("{"))?["error"], "bad_json")
    }

    func testTheCSurfaceAnswersLikeTheHost() {
        let p = "{\"op\":\"ping\"}".withCString { pkgcCall($0) }
        defer { pkgcFree(p) }
        XCTAssertEqual(p.flatMap { decodePlatformJSON(String(cString: $0)) }?["ok"], true)
        let none = pkgcCall(nil)
        XCTAssertEqual(none.flatMap { decodePlatformJSON(String(cString: $0)) }?["error"], "bad_json")
        pkgcFree(none)
        pkgcFree(nil)
    }

    func testTheFieldsNeverReachADescription() async throws {
        let f = try await GameCenterIdentity(port: FakeGCPlayer(), bundleID: { "com.acme.mac" }).fields()
        let mirrored = Mirror(reflecting: f).children.map { "\($0.value)" }
        for text in ["\(f)", String(reflecting: f), String(describing: mirrored)] {
            XCTAssertFalse(text.contains("AQID"))
            XCTAssertFalse(text.contains("1699999995000"))
        }
    }

    func testTheForeignRawTokenAgreesWithTheEncoder() async throws {
        let id = GameCenterIdentity(port: FakeGCPlayer(), bundleID: { "com.acme.mac" })
        let f = try await id.fields()
        let sig = GameCenterSignature(
            publicKeyURL: URL(string: f.publicKeyURL)!, signature: f.signature, salt: f.salt, timestamp: f.timestamp)
        let rebuilt = try GameCenterToken.encode(sig, teamPlayerID: f.teamPlayerID, bundleID: f.bundleID)
        let direct = try await id.token()
        XCTAssertEqual(rebuilt, direct)
    }
}

private struct FakeGCPlayer: GameCenterPlayerPort {
    var authenticated = true
    var persistent = true
    var team = "T:transcript-team-player-1"
    var fail = false

    func isAuthenticated() async -> Bool { authenticated }
    func scopedIDsArePersistent() async -> Bool { persistent }
    func teamPlayerID() async -> String { team }
    func identityVerification() async throws -> GameCenterSignature {
        struct Boom: Error {}
        if fail { throw Boom() }
        return GameCenterSignature(
            publicKeyURL: URL(string: "https://static.gc.apple.com/public-key/gc-prod-12.cer")!,
            signature: Data([1, 2, 3]), salt: Data([0x50, 0x4B, 0x65, 0x79, 1, 2, 3, 4]), timestamp: 1_699_999_995_000)
    }
}
