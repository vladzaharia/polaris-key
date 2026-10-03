import Foundation
import XCTest

@testable import PolarisKeyPlatform

/// The router: request shapes, sync vs async ops, and every module reached through JSON.
final class HostTests: XCTestCase {
    private func host(_ services: PlatformServices) -> (PlatformHost, EventLog) {
        let h = PlatformHost(services: services)
        return (h, EventLog(h.sink))
    }

    private func call(_ h: PlatformHost, _ json: String) -> PlatformObject {
        decodePlatformJSON(h.call(json)) ?? [:]
    }

    func testMalformedRequests() {
        let (h, _) = host(fakeServices(store: FakeStoreClient(catalog: [])))
        XCTAssertEqual(call(h, "not json"), ["ok": false, "error": "bad_json"])
        XCTAssertEqual(call(h, "[1]"), ["ok": false, "error": "bad_json"])
        XCTAssertEqual(call(h, #"{"x":1}"#), ["ok": false, "error": "missing_op"])
        XCTAssertEqual(call(h, #"{"op":"nope"}"#), ["ok": false, "error": "unknown_op", "op": "nope"])
        XCTAssertEqual(call(h, #"{"op":"products"}"#)["error"], "missing_ids")
        XCTAssertEqual(call(h, #"{"op":"purchase"}"#)["error"], "missing_product")
        XCTAssertEqual(call(h, #"{"op":"finish","id":"x"}"#)["error"], "missing_id")
        XCTAssertEqual(call(h, #"{"op":"packs_ensure"}"#)["error"], "missing_packs")
    }

    func testPingAndCapabilities() {
        let (h, _) = host(fakeServices(availability: .iOS17_4, store: FakeStoreClient(catalog: []), keychain: FakeKeychain()))
        let ping = call(h, #"{"op":"ping"}"#)
        XCTAssertEqual(ping["ok"], true)
        XCTAssertEqual(ping["protocol"], 1)
        let caps = call(h, #"{"op":"capabilities"}"#)
        XCTAssertEqual(caps["appDistributor"], true)
        XCTAssertEqual(caps["appDistributorWeb"], false)
        XCTAssertEqual(caps["managedAssetPacks"], false)
        XCTAssertEqual(caps["storeKit"], true)
        XCTAssertEqual(caps["keychain"], true)
    }

    func testAsyncOpsAnswerAReqThenAnEvent() async {
        let (h, log) = host(fakeServices(distributor: FakeDistributor(.answer(.testFlight))))
        let ack = call(h, #"{"op":"distributor"}"#)
        XCTAssertEqual(ack["ok"], true)
        guard let req = ack["req"] else { return XCTFail("no req") }
        let ev = await log.result(req)
        XCTAssertEqual(ev["ev"], "distributor")
        XCTAssertEqual(ev["signal"], "testFlight")
        XCTAssertEqual(ev["bundleIdentifier"], "gg.vlad.diceroll")
        let second = call(h, #"{"op":"distributor"}"#)
        XCTAssertNotEqual(second["req"], req, "request ids are unique")
    }

    func testDistributorDeadlineFromTheRequest() async {
        let (h, log) = host(fakeServices(distributor: FakeDistributor(.hang)))
        let ack = call(h, #"{"op":"distributor","deadline":0.1}"#)
        let ev = await log.result(ack["req"], timeout: 3)
        XCTAssertEqual(ev["signal"], "unavailable")
        XCTAssertEqual(ev["reason"], "timeout")
    }

    func testStoreThroughJSON() async {
        let store = FakeStoreClient(catalog: [
            ProductInfo(id: "pack.foes", type: "Non-Consumable", displayName: "Foes", displayPrice: "$4.99", price: "4.99")
        ])
        let (h, log) = host(fakeServices(store: store))
        XCTAssertEqual(call(h, #"{"op":"listen"}"#), ["ok": true])
        let products = await log.result(call(h, #"{"op":"products","ids":["pack.foes","x"]}"#)["req"])
        guard case .array(let ps)? = products["products"] else { return XCTFail() }
        XCTAssertEqual(ps.count, 1)

        XCTAssertEqual(call(h, #"{"op":"purchase","product":"pack.foes","appAccountToken":"nope"}"#)["error"], "bad_app_account_token")
        store.willPurchase(.success(transaction(42), confirmIn: "scene"))
        let bought = await log.result(
            call(h, #"{"op":"purchase","product":"pack.foes","appAccountToken":"6F2C3B1A-0000-4000-8000-00000000C0DE"}"#)["req"])
        XCTAssertEqual(bought["result"], "success")
        guard case .object(let t)? = bought["transaction"] else { return XCTFail() }
        XCTAssertEqual(t["id"], "42")

        store.deliver(transaction(42))  // re-delivery: suppressed
        store.deliver(transaction(42, revoked: true))
        _ = await log.wait { $0.contains { $0["ev"] == "transaction_updated" } }
        XCTAssertEqual(log.named("transaction_updated").map { $0["revoked"] }, [true])

        let finished = await log.result(call(h, #"{"op":"finish","id":"42"}"#)["req"])
        XCTAssertEqual(finished["finished"], true)
        let ents = await log.result(call(h, #"{"op":"entitlements","product":"pack.foes"}"#)["req"])
        XCTAssertEqual(ents["entitlements"], .array([]))
    }

    func testStoreAbsentIsUnsupported() {
        let (h, _) = host(fakeServices(store: nil))
        for op in ["products", "purchase", "entitlements", "listen", "finish", "app_transaction"] {
            let r = call(h, #"{"op":"\#(op)"}"#)
            XCTAssertEqual(r["unsupported"], true, op)
            XCTAssertEqual(r["reason"], "runtime", op)
        }
    }

    func testAppTransactionThroughJSON() async {
        let info = AppTransactionInfo(
            jws: "x.y.z", verified: true, environment: "Sandbox", originalAppVersion: "1.0", appVersion: "1.4",
            bundleID: "gg.vlad.diceroll", appTransactionID: "705", originalPurchaseDate: 1)
        let (h, log) = host(fakeServices(appTransaction: FakeAppTransaction(info: info)))
        let ev = await log.result(call(h, #"{"op":"app_transaction"}"#)["req"])
        XCTAssertEqual(ev["environment"], "Sandbox")
        XCTAssertEqual(ev["jws"], "x.y.z")
    }

    #if canImport(Security)
    func testKeychainThroughJSON() {
        let (h, _) = host(fakeServices(keychain: FakeKeychain()))
        XCTAssertEqual(call(h, #"{"op":"kc_set","product":"diceroll","account":"device","value":"abc"}"#)["ok"], true)
        XCTAssertEqual(call(h, #"{"op":"kc_get","product":"diceroll","account":"device"}"#), ["ok": true, "value": "abc"])
        XCTAssertEqual(call(h, #"{"op":"kc_delete","product":"diceroll","account":"device"}"#), ["ok": true])
        XCTAssertEqual(call(h, #"{"op":"kc_get","product":"diceroll"}"#)["error"], "missing_product_or_account")
        XCTAssertEqual(call(h, #"{"op":"kc_set","product":"diceroll","account":"device"}"#)["error"], "missing_value")
        let (none, _) = host(fakeServices(keychain: nil))
        XCTAssertEqual(call(none, #"{"op":"kc_get","product":"diceroll","account":"device"}"#)["reason"], "runtime")
    }
    #endif

    func testPacksThroughJSON() async {
        let packs = FakeAssetPackClient()
        packs.afterEnsure["foes-c3"] = AssetPackStatus(["upToDate", "downloaded"])
        packs.files = ["/staging/foes/content.pck"]
        let (h, log) = host(fakeServices(packs: packs))
        let ev = await log.result(
            call(h, #"{"op":"packs_ensure","packs":[{"id":"foes-c3","path":"foes/content.pck"}],"latest":true}"#)["req"])
        XCTAssertEqual(ev["ev"], "packs_ensure")
        XCTAssertEqual(log.named("pack_ready").first?["path"], "/staging/foes/content.pck")
        XCTAssertEqual(call(h, #"{"op":"packs_watch","id":"foes-c3"}"#)["ok"], true)
        XCTAssertEqual(call(h, #"{"op":"packs_unwatch","id":"foes-c3"}"#)["ok"], true)
        let url = await log.result(call(h, #"{"op":"packs_url","path":"foes/content.pck"}"#)["req"])
        XCTAssertEqual(url["exists"], true)

        // Below 26.4 every packs op answers unsupported synchronously, with no req.
        let (old, _) = host(fakeServices(availability: .iOS26_3, packs: packs))
        for q in [
            #"{"op":"packs_status","id":"a"}"#, #"{"op":"packs_ensure","id":"a","path":"p"}"#,
            #"{"op":"packs_check_updates"}"#, #"{"op":"packs_remove","id":"a"}"#, #"{"op":"packs_url","path":"p"}"#,
            #"{"op":"packs_watch","id":"a"}"#,
        ] {
            let r = call(old, q)
            XCTAssertEqual(r["reason"], "version", q)
            XCTAssertNil(r["req"], q)
        }
        let (sideload, _) = host(fakeServices(packs: FakeAssetPackClient(configured: false)))
        XCTAssertEqual(call(sideload, #"{"op":"packs_check_updates"}"#)["reason"], "outlet")
    }

    func testJSONRoundTrip() {
        let o: PlatformObject = [
            "s": "a/b", "i": 3, "d": .double(1.5), "b": true, "n": .null, "a": .array([1, "x"]), "o": .object(["k": false]),
        ]
        let text = encodePlatformJSON(o)
        XCTAssertTrue(text.contains(#""s":"a/b""#), "slashes are not escaped: \(text)")
        XCTAssertEqual(decodePlatformJSON(text), o)
        XCTAssertEqual(encodePlatformJSON(["d": .double(.infinity)]), #"{"error":"encode","ok":false}"#)
    }

    func testTheBufferIsBounded() {
        let sink = PlatformEventSink()
        for i in 0..<(PlatformEventSink.bufferLimit + 10) { sink.emit(["i": .int(i)]) }
        let drained = sink.drain()
        XCTAssertEqual(drained.count, PlatformEventSink.bufferLimit)
        XCTAssertEqual(drained.first?["i"], 10)
        XCTAssertTrue(sink.drain().isEmpty)
    }
}
