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

// MARK: The URLSession adapter's delegate (host, no session is run)

#if canImport(Darwin)
    final class BackgroundPortDelegateTests: XCTestCase {
        private final class Sink: BackgroundSink, @unchecked Sendable {
            let lock = NSLock()
            var results: [BackgroundResult] = []
            func taskFinished(_ result: BackgroundResult) { lock.withLock { results.append(result) } }
            func sessionFinishedEvents() {}
        }

        private func quietSession() -> URLSession { URLSession(configuration: .ephemeral) }

        func testADownloadIsCancelledPastItsLimit() {
            let session = quietSession()
            defer { session.invalidateAndCancel() }
            let port = URLSessionBackgroundPort(identifier: "pkey.sync.delegatetest", defaultLimit: 100)
            let url = URL(string: "https://127.0.0.1:9/never")!
            // Within the limit, written or announced: the task goes on.
            let ok = session.downloadTask(with: url)
            port.urlSession(
                session, downloadTask: ok, didWriteData: 100, totalBytesWritten: 100, totalBytesExpectedToWrite: 100)
            port.urlSession(
                session, downloadTask: ok, didWriteData: 1, totalBytesWritten: 1, totalBytesExpectedToWrite: -1)
            XCTAssertEqual(ok.state, .suspended)
            // More written than the limit.
            let written = session.downloadTask(with: url)
            port.urlSession(
                session, downloadTask: written, didWriteData: 1, totalBytesWritten: 101, totalBytesExpectedToWrite: -1)
            XCTAssertNotEqual(written.state, .suspended, "cancelled once it wrote past its limit")
            // More announced than the limit.
            let announced = session.downloadTask(with: url)
            port.urlSession(
                session, downloadTask: announced, didWriteData: 0, totalBytesWritten: 0,
                totalBytesExpectedToWrite: 101)
            XCTAssertNotEqual(announced.state, .suspended, "cancelled once the server announced too much")
        }

        func testThePortReceivesUploadAnswerBodies() {
            let port = URLSessionBackgroundPort(identifier: "pkey.sync.delegatetest2", defaultLimit: 100)
            XCTAssertTrue(
                port.responds(to: #selector(URLSessionDataDelegate.urlSession(_:dataTask:didReceive:))),
                "the session sends the answer body of an upload to the port")
            XCTAssertTrue((port as AnyObject) is URLSessionDataDelegate)
            let sink = Sink()
            port.start(sink: sink)
            let session = quietSession()
            defer { session.invalidateAndCancel() }
            let task = session.dataTask(with: URL(string: "https://127.0.0.1:9/never")!)
            port.urlSession(session, dataTask: task, didReceive: Data("quota_exceeded".utf8))
            port.urlSession(session, task: task, didCompleteWithError: nil)
            let got = sink.lock.withLock { sink.results.first }
            XCTAssertEqual(got.map { String(decoding: $0.body, as: UTF8.self) }, "quota_exceeded")
        }

        func testTheBackgroundSessionRefusesEveryRedirect() {
            let port = URLSessionBackgroundPort(identifier: "pkey.sync.delegatetest3", defaultLimit: 100)
            let session = quietSession()
            defer { session.invalidateAndCancel() }
            let task = session.dataTask(with: URL(string: "https://127.0.0.1:9/never")!)
            for code in [301, 302, 307, 308] {
                let response = HTTPURLResponse(
                    url: task.originalRequest!.url!, statusCode: code, httpVersion: nil,
                    headerFields: ["Location": "https://other.example/next"])!
                var followed: URLRequest?? = .none
                port.urlSession(
                    session, task: task, willPerformHTTPRedirection: response,
                    newRequest: URLRequest(url: URL(string: "https://other.example/next")!)
                ) { followed = .some($0) }
                XCTAssertNil(followed ?? nil, "the \(code) was followed")
                XCTAssertTrue(followed != nil, "the completion handler was never called for \(code)")
            }
        }
    }
#endif

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
