// @pkey-feature connect.links
// CC-19.POLISH: BonjourContactAdverts keeps a registration by name AND port. A listener that restarts on
// another port re-registers the names it kept, and a release behind queued callbacks is safe. The daemon is
// the host's mDNSResponder; the names are registered and withdrawn within the test.

import Foundation
import XCTest

@testable import PolarisKeyPlatform

#if canImport(Network)
    final class BonjourContactAdvertsTests: XCTestCase {
        private func advert(_ name: String) -> BonjourAdvert {
            BonjourAdvert(instance: name, txt: ["v=1", "m=c", "t=0000000000000000"])
        }

        func testAKeptNameIsRegisteredAgainWhenThePortChanges() {
            let a = BonjourContactAdverts()
            defer { a.stop() }
            let names = [
                "pkey-test-c1-\(UInt32.random(in: 0...UInt32.max))",
                "pkey-test-c2-\(UInt32.random(in: 0...UInt32.max))",
            ]
            a.update(names.map(advert), port: 40_001)
            XCTAssertEqual(a.ports, Dictionary(uniqueKeysWithValues: names.map { ($0, UInt16(40_001)) }))
            // Same set, same port: nothing is touched.
            a.update(names.map(advert), port: 40_001)
            XCTAssertEqual(Set(a.ports.values), [40_001])
            // Same names, the listener came back on another port: every name moves with it.
            a.update(names.map(advert), port: 40_002)
            XCTAssertEqual(a.ports, Dictionary(uniqueKeysWithValues: names.map { ($0, UInt16(40_002)) }))
            XCTAssertEqual(a.names, names.sorted())
        }

        func testWithdrawingUnderQueuedCallbacksDoesNotCrash() {
            let a = BonjourContactAdverts()
            for round in 0..<20 {
                let n = "pkey-test-r\(round)-\(UInt32.random(in: 0...UInt32.max))"
                a.update([advert(n)], port: 40_100)
                a.update([], port: 40_100)
            }
            a.stop()
            XCTAssertTrue(a.names.isEmpty)
            // Let the queue drain the deferred releases before the process moves on.
            let done = expectation(description: "drained")
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { done.fulfill() }
            wait(for: [done], timeout: 5)
        }
    }
#endif
