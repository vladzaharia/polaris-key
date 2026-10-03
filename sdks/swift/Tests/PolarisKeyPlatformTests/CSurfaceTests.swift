import Foundation
import XCTest

@testable import PolarisKeyPlatform
import PolarisKeyPlatformC

/// What the C callback received. A `@convention(c)` function cannot capture, so it writes here.
private let received = PlatformLock<[String]>([])

private let onEvent: PlatformEventCallback = { json in
    let s = String(cString: json)
    received.withLock { $0.append(s) }
}

/// The three C functions, called as a host calls them, against the process's real system
/// services (macOS under `swift test`: no AppDistributor, no configured Background Assets).
final class CSurfaceTests: XCTestCase {
    private func call(_ json: String) -> PlatformObject {
        let p = json.withCString { pkp_call($0) }
        defer { pkp_free(p) }
        guard let p else {
            XCTFail("pkp_call returned NULL")
            return [:]
        }
        return decodePlatformJSON(String(cString: p)) ?? [:]
    }

    override func tearDown() {
        pkp_set_event_callback(nil)
        super.tearDown()
    }

    func testSyncCalls() {
        XCTAssertEqual(call(#"{"op":"ping"}"#)["ok"], true)
        XCTAssertEqual(call("{"), ["ok": false, "error": "bad_json"])
        XCTAssertEqual(call(#"{"op":"what"}"#)["error"], "unknown_op")
        let null = pkp_call(nil)
        XCTAssertEqual(null.map { String(cString: $0) }, #"{"error":"bad_json","ok":false}"#)
        pkp_free(null)
        pkp_free(nil)
    }

    func testCapabilitiesOfThisProcess() {
        let caps = call(#"{"op":"capabilities"}"#)
        XCTAssertEqual(caps["protocol"], 1)
        XCTAssertEqual(caps["backgroundAssetsConfigured"], false)
        #if os(macOS)
        XCTAssertEqual(caps["platform"], "macos")
        XCTAssertEqual(caps["appDistributor"], false)
        #endif
    }

    func testAsyncResultsArriveThroughTheCallback() async throws {
        received.withLock { $0 = [] }
        pkp_set_event_callback(onEvent)
        let ack = call(#"{"op":"distributor","deadline":0.5}"#)
        guard let req = ack["req"] else { return XCTFail("no req: \(ack)") }
        let end = Date().addingTimeInterval(5)
        var event: PlatformObject?
        while Date() < end, event == nil {
            event = received.withLock { $0 }.compactMap(decodePlatformJSON).first { $0["req"] == req }
            if event == nil { try await Task.sleep(nanoseconds: 10_000_000) }
        }
        XCTAssertEqual(event?["ev"], "distributor")
        #if !os(iOS)
        XCTAssertEqual(event?["signal"], "unavailable")
        XCTAssertEqual(event?["reason"], "runtime")
        #endif
    }

    func testBackgroundAssetsNeverTouchedUnconfigured() {
        // `AssetPackManager.shared` traps in an unconfigured process: every packs op must answer
        // without reaching it (this test would crash otherwise).
        let r = call(#"{"op":"packs_check_updates"}"#)
        XCTAssertEqual(r["unsupported"], true)
        XCTAssertTrue(["version", "outlet"].contains(r["reason"]?.stringValue ?? ""))
    }
}
