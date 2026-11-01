// @pkey-feature sync.transfer.background
//
// The background-session adapter's task tag (moved from PolarisKeyTests with the code, U-41.5a), and the
// real `URLSession` adapter in an iOS simulator (CI macOS only).

import Foundation
import XCTest

@testable import PolarisKeyPlatform

private let hex64 = String(repeating: "ab", count: 32)

final class BackgroundTagTests: XCTestCase {
    func testTheTagRoundTripsAndRefusesWhatIsNotOurs() {
        let t = BackgroundTag(
            idHash: hex64, kind: .up, part: 3, enqueuedAt: 99, spool: String(repeating: "0a", count: 16) + ".bin")
        XCTAssertEqual(BackgroundTag.parse(t.text), t)
        XCTAssertEqual(
            BackgroundTag.parse(BackgroundTag(idHash: hex64, kind: .dn, part: 0, enqueuedAt: 1, spool: nil).text)?
                .spool, nil)
        for bad in [
            nil, "", "pkbg2|\(hex64)|up|1|1|-", "pkbg1|xyz|up|1|1|-", "pkbg1|\(hex64)|sideways|1|1|-",
            "pkbg1|\(hex64)|up|-1|1|-", "pkbg1|\(hex64)|up|1|1|../../etc/passwd", "pkbg1|\(hex64)|up|1|1",
        ] { XCTAssertNil(BackgroundTag.parse(bad), bad ?? "nil") }
    }
}

// MARK: Simulator (CI macOS only)

#if os(iOS)
    /// NEEDS A SIMULATOR. Runs the real `URLSession` adapter in an iOS simulator: a background session with
    /// the product's identifier starts, a task made through the port is listed by `liveTasks`, and cancelling
    /// it delivers a result to the sink. CI's macOS job runs it with `xcodebuild test -destination
    /// 'platform=iOS Simulator,…'`; it is not run on a development machine whose simulators hang.
    final class BackgroundSessionSimulatorTests: XCTestCase {
        private final class Sink: BackgroundSink, @unchecked Sendable {
            let finished = XCTestExpectation(description: "task finished")
            func taskFinished(_ result: BackgroundResult) { finished.fulfill() }
            func sessionFinishedEvents() {}
        }

        func testTheRealBackgroundSessionListsAndCancelsATask() async throws {
            let port = URLSessionBackgroundPort(identifier: "pkey.sync.simtest", defaultLimit: 65_537)
            let sink = Sink()
            port.start(sink: sink)
            var request = URLRequest(url: URL(string: "https://127.0.0.1:9/never")!)
            request.httpMethod = "GET"
            let task = port.makeDownload(request, tag: "pkbg1|\(hex64)|dn|0|1|-", maxBody: 1024)
            task.resume()
            let live = await port.liveTasks()
            XCTAssertTrue(live.contains { $0.taskIdentifier == task.taskIdentifier })
            task.cancel()
            await fulfillment(of: [sink.finished], timeout: 30)
        }
    }
#endif
