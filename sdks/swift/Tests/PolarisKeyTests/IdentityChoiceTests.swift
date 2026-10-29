// @pkey-feature identity.choice
//
// I-10b.12: `identity.choice` and `LicenseChoiceModel` beyond what the recordings show (the wire
// conversation is the transcripts': `choice-*`, `redirect-web-choose*`): the routes come from
// discovery or not at all (unpublished: the typed unsupported result, and a sign-in that asked for
// `app` runs in card mode), the grant never prints, refusals are typed and change nothing local,
// and the model turns the SDK's views into the kit's inputs and survives a raced view.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyUICore
import XCTest

@testable import PolarisKeyIdentity

@MainActor
final class IdentityChoiceTests: XCTestCase {
    private var server = StubServer()
    private let api = "https://key.example/djdl"
    private let grant = "sg_" + String(repeating: "a", count: 43)

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func discovery(choice: Bool) async {
        let routes =
            choice
            ? #","choiceLicenses":"\#(api)/identity/choice/licenses","choiceDevices":"\#(api)/identity/choice/devices","choiceComplete":"\#(api)/identity/choice/complete","choiceCancel":"\#(api)/identity/choice/cancel""#
            : ""
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body:
                #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"\#(api)/identity","endpoints":{"authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token"\#(routes)}}}}"#
        )
    }

    private func client(token: String? = nil) async throws -> PolarisKeyClient {
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

    private func row(_ id: String, state: String = "free", used: Int = 0, replace: String = "null")
        -> String
    {
        #"{"id":"\#(id)","tierName":"djdl","name":null,"origin":"key","access":"seats","seats":{"used":\#(used),"limit":3},"current":false,"expiresAt":null,"state":"\#(state)","replace":\#(replace),"freeDeviceUrl":null}"#
    }

    private func view(_ rows: [String], preselected: String = "null") -> String {
        #"{"state":"choose","choices":[\#(rows.joined(separator: ","))],"keep":false,"preselected":\#(preselected),"create":null,"getLicense":null}"#
    }

    private let tokenOk =
        #"{"access_token":"pkeyt_new","token_type":"Bearer","scope":"profile email","schemaVersion":1,"device":{"id":"D"},"license":{"id":"lic_pro"},"subject":"ps_abc","keyEntries":{"used":1,"limit":10},"attachable":true}"#

    func testAnUnpublishedRouteIsTheTypedUnsupportedResult() async throws {
        await discovery(choice: false)
        let c = try await client()
        do {
            _ = try await c.identity.choice.licenses(grant: grant)
            XCTFail("an unpublished route was called")
        } catch let e as UnsupportedError {
            XCTAssertEqual(e.feature, Feature.identityChoice)
            XCTAssertEqual(e.reason, UnsupportedReason.product)
        }
        let calls = await server.requests(forPath: "/djdl/identity/choice/licenses")
        XCTAssertTrue(calls.isEmpty)
    }

    func testAskingForAppWithoutRoutesRunsCardMode() async throws {
        await discovery(choice: false)
        let c = try await client()
        let s = try await c.identity.signIn.start(
            SignInOptions(
                channel: .redirect, redirectUri: "https://app.example/cb", licenseChoice: .app))
        XCTAssertFalse(try XCTUnwrap(s.authorizeUrl).contains("license_choice"))
        await discovery(choice: true)
        let c2 = try await client()
        let s2 = try await c2.identity.signIn.start(
            SignInOptions(
                channel: .redirect, redirectUri: "https://app.example/cb", licenseChoice: .app))
        XCTAssertTrue(try XCTUnwrap(s2.authorizeUrl).hasSuffix("&license_choice=app"))
    }

    func testTheGrantTravelsInTheBodyAndNeverPrints() async throws {
        await discovery(choice: true)
        await server.reply("/djdl/identity/choice/licenses", body: view([row("lic_pro")]))
        let c = try await client(token: "pkeyt_old")
        let v = try await c.identity.choice.licenses(grant: grant)
        XCTAssertEqual(v.choices.map(\.id), ["lic_pro"])
        let calls = await server.requests(forPath: "/djdl/identity/choice/licenses")
        let call = try XCTUnwrap(calls.first)
        XCTAssertEqual(call.url.query, nil)
        XCTAssertNil(call.headers["authorization"], "the grant is the credential, not the token")
        XCTAssertTrue(String(decoding: try XCTUnwrap(call.body), as: UTF8.self).contains(grant))
        let pending = PendingSignIn(grant: grant, expiresIn: 300, expiresAt: 1, view: v)
        XCTAssertFalse("\(pending)".contains(grant))
        XCTAssertFalse("\(String(reflecting: pending))".contains(grant))
    }

    func testCompleteStoresTheTokenAndReadsKeyEntriesAndAttachable() async throws {
        await discovery(choice: true)
        await server.reply("/djdl/identity/choice/complete", body: tokenOk)
        let c = try await client()
        let done = try await c.identity.choice.complete(grant: grant, choice: .keep)
        XCTAssertEqual(done.ready.licenseId, "lic_pro")
        XCTAssertEqual(done.ready.subject, "ps_abc")
        XCTAssertEqual(done.keyEntries, KeyEntries(used: 1, limit: 10))
        XCTAssertEqual(done.attachable, true)
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_new")
        XCTAssertEqual(c.identity.account, "ps_abc")
    }

    func testKeepSendsTheDevicesBearerAndNoOtherChoiceDoes() async throws {
        await discovery(choice: true)
        await server.reply("/djdl/identity/choice/complete", body: tokenOk)
        let c = try await client(token: "pkeyt_old")
        _ = try await c.identity.choice.complete(grant: grant, choice: .keep)
        let c2 = try await client(token: "pkeyt_old")
        _ = try await c2.identity.choice.complete(grant: grant, choice: .license(id: "lic_pro"))
        let calls = await server.requests(forPath: "/djdl/identity/choice/complete")
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].headers["authorization"], "Bearer pkeyt_old")
        XCTAssertNil(calls[1].headers["authorization"])
    }

    func testARefusalIsTypedAndKeepsTheTokenAndTheGrant() async throws {
        await discovery(choice: true)
        await server.route("/djdl/identity/choice/complete") { _ in
            StubServer.Reply(
                status: 429, body: #"{"error":{"code":"rate_limited"},"retryAfter":12.2}"#)
        }
        let c = try await client(token: "pkeyt_old")
        do {
            _ = try await c.identity.choice.complete(grant: grant, choice: .license(id: "lic_pro"))
            XCTFail("a refusal was accepted")
        } catch let e as ChoiceError {
            XCTAssertEqual(e.code, ErrorCode.rateLimited)
            XCTAssertEqual(e.retryAfterSeconds, 13)
            XCTAssertEqual(e.status, 429)
        }
        let held = await c.core.token
        XCTAssertEqual(held, "pkeyt_old")
    }

    func testDeviceLimitCarriesTheFreshView() async throws {
        await discovery(choice: true)
        let fresh = view([row("lic_pro", state: "full", used: 3)])
        await server.route("/djdl/identity/choice/complete") { _ in
            StubServer.Reply(
                status: 403, body: #"{"error":{"code":"device_limit"},"limit":3,"view":\#(fresh)}"#)
        }
        let c = try await client()
        do {
            _ = try await c.identity.choice.complete(grant: grant, choice: .license(id: "lic_pro"))
            XCTFail()
        } catch let e as ChoiceError {
            XCTAssertEqual(e.code, ErrorCode.deviceLimit)
            XCTAssertEqual(e.view?.choices.first?.state, "full")
        }
    }

    // ── The model ────────────────────────────────────────────────────────────────────────

    func testTheModelDrawsTheViewPicksAndSignsIn() async throws {
        await discovery(choice: true)
        await server.reply(
            "/djdl/identity/choice/licenses",
            body: view([row("lic_lite"), row("lic_pro")], preselected: #""lic_pro""#))
        await server.reply("/djdl/identity/choice/complete", body: tokenOk)
        let c = try await client()
        let model = LicenseChoiceModel(identity: c.identity, grant: grant)
        XCTAssertEqual(model.phase, .loading)
        XCTAssertEqual(model.inputs().loading, true)
        await model.start()
        XCTAssertEqual(model.phase, .choosing)
        XCTAssertEqual(model.choices?.choices.map(\.id), ["lic_lite", "lic_pro"])
        XCTAssertEqual(model.selected, "lic_pro", "the preselection stands")
        model.select("lic_lite")
        await model.confirm()
        XCTAssertEqual(model.phase, .done)
        XCTAssertEqual(model.completion?.ready.licenseId, "lic_pro")
        let sent = await server.requests(forPath: "/djdl/identity/choice/complete")
        let body = try XCTUnwrap(sent.first?.body)
        XCTAssertTrue(
            String(decoding: body, as: UTF8.self).contains(#""licenseId":"lic_lite""#))
        let inputs = model.inputs()
        XCTAssertEqual(inputs.signIn?.outcome, .choose)
        XCTAssertEqual(inputs.choices?.choices.count, 2)
    }

    func testTheModelReplacesADeviceAndSurvivesARacedView() async throws {
        await discovery(choice: true)
        let full = view(
            [row("lic_team", state: "full", used: 1, replace: #"{"allowed":true,"retryAfter":null}"#)])
        await server.reply("/djdl/identity/choice/licenses", body: full)
        await server.reply(
            "/djdl/identity/choice/devices",
            body:
                #"{"licenseId":"lic_team","seats":{"used":1,"limit":1},"devices":[{"id":"OLD","label":null,"platform":null,"deviceType":null,"lastSeen":1,"leastRecent":true,"activeNow":true,"thisBrowser":false}],"replace":{"allowed":true,"retryAfter":null}}"#
        )
        let racedView = view([row("lic_team", state: "full", used: 1)])
        await server.route("/djdl/identity/choice/complete") { _ in
            StubServer.Reply(
                status: 403, body: #"{"error":{"code":"device_limit"},"view":\#(racedView)}"#)
        }
        let c = try await client()
        let model = LicenseChoiceModel(identity: c.identity, grant: grant)
        await model.start()
        await model.openReplace(licenseId: "lic_team")
        XCTAssertEqual(model.replaceView?.devices.map(\.id), ["OLD"])
        XCTAssertEqual(model.inputs().signIn?.event, .openReplace)
        await model.replace(deviceId: "OLD")
        XCTAssertEqual(model.phase, .choosing, "a raced view is a retry, not an end")
        XCTAssertTrue(model.raced)
        XCTAssertNil(model.replaceView)
        XCTAssertEqual(model.error?.code, ErrorCode.deviceLimit)
        XCTAssertNil(model.choices?.choices.first?.replace, "the fresh view replaced the list")
    }

    func testAnInvalidGrantEndsTheModel() async throws {
        await discovery(choice: true)
        await server.route("/djdl/identity/choice/licenses") { _ in
            StubServer.Reply(status: 400, body: #"{"error":{"code":"invalid_grant"}}"#)
        }
        let c = try await client()
        let model = LicenseChoiceModel(identity: c.identity, grant: grant)
        await model.start()
        XCTAssertEqual(model.phase, .grantExpired)
        XCTAssertEqual(model.inputs().signIn?.grantExpired, true)
    }
}
