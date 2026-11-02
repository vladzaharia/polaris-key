// @pkey-feature identity.redirect.native
// I-48.17: the system browser sheet ops of the binary entry, against a stub presenter (no window).

import Foundation
import XCTest

@testable import PolarisKeyPlatform

private final class StubPresenter: WebAuthPresenting, @unchecked Sendable {
    private let lock = NSLock()
    private var completion: (@Sendable (WebAuthEnd) -> Void)?
    private(set) var presented: [(url: URL, scheme: String, ephemeral: Bool)] = []
    private(set) var cancels = 0
    var starts = true

    func present(
        url: URL, callbackScheme: String, ephemeral: Bool, completion: @escaping @Sendable (WebAuthEnd) -> Void
    ) -> Bool {
        lock.withLock {
            presented.append((url, callbackScheme, ephemeral))
            if starts { self.completion = completion }
        }
        return starts
    }

    func cancel() { lock.withLock { cancels += 1 } }

    func end(_ e: WebAuthEnd) { lock.withLock { completion }?(e) }
}

final class WebAuthHostTests: XCTestCase {
    private let authorize = "https://key.plrs.im/authorize?client_id=app&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Aabc"

    private func make(_ presenter: StubPresenter = StubPresenter()) -> (ops: [String: PlatformBinaryOp], sink: PlatformEventSink, presenter: StubPresenter) {
        let sink = PlatformEventSink()
        var ops: [String: PlatformBinaryOp] = [:]
        WebAuthHost(sink: sink, presenter: presenter).register(into: &ops)
        return (ops, sink, presenter)
    }

    private func run(_ ops: [String: PlatformBinaryOp], _ op: String, _ bytes: [UInt8]) -> [UInt8] {
        bytes.withUnsafeBufferPointer { ops[op]!($0) }
    }

    private func open(_ ops: [String: PlatformBinaryOp], url: String? = nil, scheme: String = "demoapp", host: String = "key.plrs.im", ephemeral: Bool = false) -> [UInt8] {
        let o: [String: Any] = ["url": url ?? authorize, "callback_scheme": scheme, "issuer_host": host, "prefers_ephemeral": ephemeral]
        return run(ops, "auth_open", [UInt8](try! JSONSerialization.data(withJSONObject: o)))
    }

    private func events(_ sink: PlatformEventSink) -> [(String, [String: Any])] {
        sink.drainBinary().map { k, d in
            (k, (try? JSONSerialization.jsonObject(with: Data(d)) as? [String: Any]) ?? [:])
        }
    }

    func testOpensTheIssuerHostAndDeliversTheRegisteredScheme() {
        let m = make()
        XCTAssertEqual(open(m.ops, ephemeral: true), [1])
        XCTAssertEqual(m.presenter.presented.count, 1)
        XCTAssertEqual(m.presenter.presented[0].scheme, "demoapp")
        XCTAssertTrue(m.presenter.presented[0].ephemeral)
        m.presenter.end(.callback("demoapp:/pkey/callback?code=x&state=y"))
        let ev = events(m.sink)
        XCTAssertEqual(ev.count, 1)
        XCTAssertEqual(ev[0].0, "auth_done")
        XCTAssertEqual(ev[0].1["url"] as? String, "demoapp:/pkey/callback?code=x&state=y")
    }

    func testRefusesAnythingButAnHttpsIssuerHostUrl() {
        let m = make()
        for bad in [
            "http://key.plrs.im/authorize", "https://evil.example/authorize", "https://key.plrs.im.evil.example/a",
            "https://user@key.plrs.im/authorize", "https://key.plrs.im:8443/authorize", "https://key.plrs.im/a#frag",
            "javascript:alert(1)", "demoapp:/pkey/callback", "https://key.plrs.im/a b", "",
        ] {
            XCTAssertEqual(open(m.ops, url: bad), [3], bad)
        }
        XCTAssertTrue(m.presenter.presented.isEmpty, "nothing was shown")
    }

    func testRefusesBadSchemesAndHosts() {
        let m = make()
        for scheme in ["", "https", "http", "file", "data", "javascript", "1abc", "Demo", "a b", String(repeating: "a", count: 65)] {
            XCTAssertEqual(open(m.ops, scheme: scheme), [3], scheme)
        }
        XCTAssertEqual(open(m.ops, host: ""), [3])
        XCTAssertEqual(open(m.ops, host: "key.plrs.im/x"), [3])
        XCTAssertEqual(run(m.ops, "auth_open", Array("nope".utf8)), [3])
        XCTAssertEqual(run(m.ops, "auth_open", [UInt8](repeating: 0x20, count: 5000)), [3])
        XCTAssertTrue(m.presenter.presented.isEmpty)
    }

    func testOneSessionAtATime() {
        let m = make()
        XCTAssertEqual(open(m.ops), [1])
        XCTAssertEqual(open(m.ops), [7])
        XCTAssertEqual(m.presenter.presented.count, 1)
        m.presenter.end(.cancelled)
        XCTAssertEqual(open(m.ops), [1], "free again once it ended")
    }

    func testCancelClosesWithoutAnEventAndDropsALateCallback() {
        let m = make()
        XCTAssertEqual(run(m.ops, "auth_cancel", []), [0], "nothing to cancel")
        XCTAssertEqual(open(m.ops), [1])
        XCTAssertEqual(run(m.ops, "auth_cancel", []), [1])
        XCTAssertEqual(m.presenter.cancels, 1)
        m.presenter.end(.callback("demoapp:/pkey/callback?code=x&state=y"))
        XCTAssertTrue(events(m.sink).isEmpty, "a callback after a cancel is dropped")
        XCTAssertEqual(open(m.ops), [1])
    }

    func testAForeignSchemeCallbackIsAFailure() {
        let m = make()
        XCTAssertEqual(open(m.ops), [1])
        m.presenter.end(.callback("https://evil.example/pkey/callback?code=x"))
        let ev = events(m.sink)
        XCTAssertEqual(ev.map(\.0), ["auth_fail"])
        XCTAssertEqual(ev[0].1["reason"] as? String, "failed")
        XCTAssertFalse(String(describing: ev).contains("code=x"))
    }

    func testDismissedAndFailedEnds() {
        let m = make()
        XCTAssertEqual(open(m.ops), [1])
        m.presenter.end(.cancelled)
        XCTAssertEqual(events(m.sink).first?.1["reason"] as? String, "cancelled")
        XCTAssertEqual(open(m.ops), [1])
        m.presenter.end(.failed)
        XCTAssertEqual(events(m.sink).first?.1["reason"] as? String, "failed")
    }

    func testASheetThatCannotBeShownFreesTheSlot() {
        let p = StubPresenter()
        p.starts = false
        let m = make(p)
        XCTAssertEqual(open(m.ops), [6])
        p.starts = true
        XCTAssertEqual(open(m.ops), [1])
    }

    func testTheOpsAreInTheSystemTable() {
        let ops = PlatformBinaryOps.system(sink: PlatformEventSink(), environment: [:])
        XCTAssertNotNil(ops["auth_open"])
        XCTAssertNotNil(ops["auth_cancel"])
    }
}
