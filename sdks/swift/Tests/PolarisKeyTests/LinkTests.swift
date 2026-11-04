// @pkey-feature identity.link
//
// I-44.10: the link offer (WIRE-CONTRACT-V5 §12.11.4). The recorded conversations are the
// transcripts' (`link-offer`, `link-errors`, `link-game`, replayed in TranscriptTests); these tests
// hold what a recording cannot: the offer opens only after a sign-in this device started, no request
// goes out before that or after a decline, the decline is a hash kept in the Store, the proof's
// purpose is `link`, the refusals are typed, and nothing secret prints.

import Foundation
import PolarisKey
import XCTest

@testable import PolarisKeyCore
@testable import PolarisKeyIdentity
#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

@MainActor
final class LinkTests: XCTestCase {
    private var server = StubServer()
    private let api = "https://key.example/djdl"
    private let handle = "lh_" + String(repeating: "c", count: 43)
    private let subject = "ps_" + String(repeating: "s", count: 20)
    private let deviceId = "DEVICE00000000000000000000000001"

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func discovery(link: Bool = true) async {
        let linkEntry = link ? #","link":"\#(api)/identity/link""# : ""
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body:
                #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"exchange":{"kinds":["apple"]},"issuer":"\#(api)/identity","endpoints":{"authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token","nonce":"\#(api)/identity/nonce"\#(linkEntry)}}}}"#
        )
        await server.reply(
            "/djdl/identity/link", body: #"{"offer":[{"kind":"google","reach":null},{"kind":"apple","reach":null}]}"#)
    }

    private func client(store: InMemoryStore? = nil) async throws -> (PolarisKeyClient, InMemoryStore) {
        let held = store ?? InMemoryStore(deviceId: deviceId)
        if await held.getToken() == nil { await held.setToken("pkeyt_signedin") }
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: held, transport: server.transport,
                expectedServices: [.identity], fingerprint: false,
                connect: ConnectOptions(keys: try LabelKeyPort(label: "transcript-device-key-1"))))
        c.identity.redirectAcquisitionSync.set(false)
        return (c, held)
    }

    private func linkRequests() async -> [PolarisRequest] {
        await server.requests(forPath: "/djdl/identity/link")
    }

    func testNoOfferBeforeASignInThisDeviceStarted() async throws {
        await discovery()
        let (c, _) = try await client()
        XCTAssertFalse(c.identity.link.pending)
        let offered = try await c.identity.link.offer()
        XCTAssertEqual(offered, .unavailable)
        let accepted = try await c.identity.link.accept(linkHandle: handle)
        XCTAssertEqual(accepted, .unavailable)
        let sent = await linkRequests()
        XCTAssertTrue(sent.isEmpty)
    }

    func testAnExchangeSignInDoesNotOpenTheOffer() async throws {
        await discovery()
        await server.reply(
            "/djdl/identity/token",
            body:
                #"{"access_token":"pkeyt_x","token_type":"Bearer","scope":"profile","schemaVersion":1,"device":{"id":"D"},"license":null,"subject":"\#(subject)","issued_token_type":"urn:polaris-key:token-type:device"}"#
        )
        await server.reply(
            "/djdl/identity/nonce",
            body: #"{"nonce":"\#(String(repeating: "N", count: 43))","expiresIn":300}"#)
        let (c, _) = try await client()
        let outcome = try await c.identity.exchange(
            kind: .apple, subjectToken: "a.b.c", optionalNonce: String(repeating: "N", count: 43))
        guard case .signedIn(let ready) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertFalse(ready.sameDevice)
        XCTAssertFalse(c.identity.link.pending)
    }

    func testAnOpenOfferReadsTheKindsWithTheDeviceToken() async throws {
        await discovery()
        let (c, _) = try await client()
        c.identity.linkOpen(subject: subject)
        XCTAssertTrue(c.identity.link.pending)
        let offered = try await c.identity.link.offer()
        XCTAssertEqual(
            offered, .ok([LinkOfferEntry(kind: "google", reach: nil), LinkOfferEntry(kind: "apple", reach: nil)]))
        let all = await linkRequests()
        let sent = try XCTUnwrap(all.first)
        XCTAssertEqual(sent.method, "GET")
        XCTAssertEqual(sent.headers["authorization"], "Bearer pkeyt_signedin")
    }

    func testAProductWithoutTheRouteHasNoOffer() async throws {
        await discovery(link: false)
        let (c, _) = try await client()
        c.identity.linkOpen(subject: subject)
        let offered = try await c.identity.link.offer()
        XCTAssertEqual(offered, .unavailable)
        let sent = await linkRequests()
        XCTAssertTrue(sent.isEmpty)
    }

    func testTheProofIsALinkProofOverTheHandleByTheDeviceKey() async throws {
        await discovery()
        await server.reply("/djdl/identity/link", body: #"{"linked":{"kind":"apple","reach":"developer"}}"#)
        let keys = try LabelKeyPort(label: "transcript-device-key-1")
        let (c, _) = try await client()
        c.identity.linkOpen(subject: subject)
        let result = try await c.identity.link.accept(linkHandle: handle)
        XCTAssertEqual(result, .linked(kind: "apple", reach: "developer"))
        let all = await linkRequests()
        let sent = try XCTUnwrap(all.first)
        XCTAssertEqual(sent.method, "POST")
        let body = try XCTUnwrap(
            try JSONDecoder().decode(JSONValue.self, from: try XCTUnwrap(sent.body)).objectValue)
        XCTAssertEqual(Set(body.keys), ["linkHandle", "proof"])
        XCTAssertEqual(body["linkHandle"]?.stringValue, handle)
        let proof = DeviceProof(
            fields: DeviceProofFields(
                purpose: "link", product: "djdl", deviceId: deviceId, value: handle, tokenHash: "-"),
            signKey: keys.keys.signKey, sig: try XCTUnwrap(body["proof"]?.stringValue))
        XCTAssertTrue(DeviceProofs.verify(proof))
        var other = proof
        other.fields.purpose = "exchange"
        XCTAssertFalse(DeviceProofs.verify(other))
    }

    func testTheHandleAnExchangeLeftIsUsedAndSpent() async throws {
        await discovery()
        await server.reply("/djdl/identity/link", body: #"{"linked":{"kind":"apple","reach":"developer"}}"#)
        let (c, _) = try await client()
        c.identity.linkHold(handle: handle, expiresAt: Int.max)
        c.identity.linkOpen(subject: subject)
        _ = try await c.identity.link.accept()
        let all = await linkRequests()
        let sent = try XCTUnwrap(all.first)
        let body = try JSONDecoder().decode(JSONValue.self, from: try XCTUnwrap(sent.body)).objectValue
        XCTAssertEqual(body?["linkHandle"]?.stringValue, handle)
        let left = await c.identity.linkHeldHandle()
        XCTAssertNil(left)
        c.identity.link.dismiss()
        XCTAssertFalse(c.identity.link.pending)
    }

    func testRefusalsAreTypedAndAStaleStepUpKeepsTheOffer() async throws {
        await discovery()
        let (c, _) = try await client()
        c.identity.linkOpen(subject: subject)
        for (status, code) in [(401, "step_up_required"), (404, "not_found"), (400, "invalid_grant")] {
            await server.reply("/djdl/identity/link", status: status, body: #"{"error":{"code":"\#(code)"}}"#)
            let result = try await c.identity.link.accept(linkHandle: handle)
            XCTAssertEqual(result, .refused(status: status, code: code))
            XCTAssertTrue(c.identity.link.pending, code)
        }
    }

    func testAConflictIsRememberedAsADeclineAndNoOfferFollows() async throws {
        await discovery()
        await server.reply("/djdl/identity/link", status: 409, body: #"{"error":{"code":"link_conflict"}}"#)
        let (c, _) = try await client()
        c.identity.updateSubject(subject)
        c.identity.linkOpen(subject: subject)
        let result = try await c.identity.link.accept(linkHandle: handle)
        XCTAssertEqual(result, .refused(status: 409, code: "link_conflict"))
        let offered = try await c.identity.link.offer()
        XCTAssertEqual(offered, .unavailable)
    }

    func testADeclineKeepsOnlyAHashAndSurvivesARestart() async throws {
        await discovery()
        let (c, store) = try await client()
        c.identity.updateSubject(subject)
        c.identity.linkOpen(subject: subject)
        await c.identity.link.decline()
        XCTAssertFalse(c.identity.link.pending)

        let record = await store.readRecord(IdentityClient.linkDeclinedRecord)
        let kept = try XCTUnwrap(record)
        let text = String(decoding: kept, as: UTF8.self)
        let expected = Base64URL.encode(Data(SHA256.hash(data: Data(("\(api)/identity" + subject).utf8))))
        XCTAssertEqual(text, expected)
        XCTAssertFalse(text.contains(subject))

        // A new client over the same Store: the same account's next sign-in gets no offer, and no request.
        let (again, _) = try await client(store: store)
        again.identity.updateSubject(subject)
        again.identity.linkOpen(subject: subject)
        let offered = try await again.identity.link.offer()
        XCTAssertEqual(offered, .unavailable)
        let sent = await linkRequests()
        XCTAssertTrue(sent.isEmpty)

        // Another account on this device is still offered.
        again.identity.updateSubject("ps_" + String(repeating: "t", count: 20))
        again.identity.linkOpen(subject: "ps_" + String(repeating: "t", count: 20))
        let other = try await again.identity.link.offer()
        guard case .ok = other else { return XCTFail("\(other)") }
    }

    func testAnotherAccountsSignInDropsTheOffer() async throws {
        await discovery()
        let (c, _) = try await client()
        c.identity.updateSubject(subject)
        c.identity.linkOpen(subject: subject)
        c.identity.updateSubject("ps_" + String(repeating: "t", count: 20))
        let offered = try await c.identity.link.offer()
        XCTAssertEqual(offered, .unavailable)
        XCTAssertFalse(c.identity.link.pending)
    }

    func testNothingSecretPrints() async throws {
        await discovery()
        await server.reply("/djdl/identity/link", status: 500, body: #"{"error":"\#(handle)"}"#)
        let (c, _) = try await client()
        c.identity.linkOpen(subject: subject)
        do {
            _ = try await c.identity.link.accept(linkHandle: handle)
            XCTFail("a server error was accepted")
        } catch let error as PolarisError {
            XCTAssertFalse("\(error)".contains(handle))
            XCTAssertFalse(error.message.contains(handle))
        }
    }

    // Lead additions from the I-44.10 review.

    private func redeem(_ c: PolarisKeyClient, tokenEndpoint: String) async throws {
        let pending = RedirectPending(
            authorizeUrl: "", state: String(repeating: "s", count: 24),
            codeVerifier: String(repeating: "v", count: 43), redirectUri: "https://app.example/cb",
            clientId: "djdl", issuer: "\(api)/identity", tokenEndpoint: tokenEndpoint, choiceApp: false,
            keyReturn: false)
        _ = try await c.identity.redeemRedirect(pending, code: "C0DE", deviceName: nil)
    }

    func testTheTokenRequestCarriesTheDeviceTokenOnlyToThisProduct() async throws {
        await discovery()
        let token =
            #"{"access_token":"pkeyt_new","token_type":"Bearer","scope":"profile","schemaVersion":1,"device":{"id":"D"},"license":null,"subject":"\#(subject)"}"#
        await server.reply("/djdl/identity/token", body: token)
        await server.reply("/elsewhere/token", body: token)
        let (c, _) = try await client()
        try await redeem(c, tokenEndpoint: "https://other.example/elsewhere/token")
        let off = await server.requests(forPath: "/elsewhere/token")
        XCTAssertEqual(off.count, 1)
        XCTAssertNil(off.first?.headers["authorization"])
        let (d, _) = try await client()
        try await redeem(d, tokenEndpoint: "\(api)/identity/token")
        let on = await server.requests(forPath: "/djdl/identity/token")
        XCTAssertEqual(on.first?.headers["authorization"], "Bearer pkeyt_signedin")
    }

    func testASignInThatNamedNoSubjectOpensNoOffer() async throws {
        await discovery()
        let (c, _) = try await client()
        c.identity.linkOpen(subject: nil)
        XCTAssertFalse(c.identity.link.pending)
        c.identity.linkOpen(subject: "")
        XCTAssertFalse(c.identity.link.pending)
        let offered = try await c.identity.link.offer()
        XCTAssertEqual(offered, .unavailable)
        let sent = await linkRequests()
        XCTAssertTrue(sent.isEmpty)
    }

    func testAcceptIsUnavailableWhenTheDeviceKeysDieWithTheProcess() async throws {
        await discovery()
        let held = InMemoryStore(deviceId: deviceId)
        await held.setToken("pkeyt_signedin")
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: held, transport: server.transport,
                expectedServices: [.identity], fingerprint: false,
                connect: ConnectOptions(keys: try LabelKeyPort(label: "k", kind: .memory))))
        c.identity.linkOpen(subject: subject)
        let port = try await c.identity.exchangePort()
        XCTAssertNil(port)
        let accepted = try await c.identity.link.accept(linkHandle: handle)
        XCTAssertEqual(accepted, .unavailable)
        let sent = await linkRequests()
        XCTAssertTrue(sent.isEmpty)
        // The offer itself needs no keys.
        let offered = try await c.identity.link.offer()
        guard case .ok = offered else { return XCTFail("\(offered)") }
    }
}
