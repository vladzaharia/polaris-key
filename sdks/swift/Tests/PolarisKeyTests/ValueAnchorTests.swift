import Foundation

import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

/// Ids and keys taken from a peer, a host or the Worker match whole: a trailing newline, carriage
/// return or other terminator never passes.
final class ValueAnchorTests: XCTestCase {
    private let tails = ["\n", "\r", "\r\n", "\u{85}", "\u{2028}", "\0"]
    private let client = "c_" + String(repeating: "A", count: 22)
    private let ring = "rg_" + String(repeating: "B", count: 22)
    private let sub = "ps_" + String(repeating: "C", count: 22)
    private let device = String(repeating: "D", count: 32)
    private let hex = String(repeating: "a", count: 64)

    private func refuses(_ ok: (String) -> Bool, _ good: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(ok(good), "good value", file: file, line: line)
        for t in tails { XCTAssertFalse(ok(good + t), "tail \(t.unicodeScalars.map(\.value))", file: file, line: line) }
    }

    func testSyncPatterns() {
        refuses({ wholeMatches(SYNC_CLIENT_ID_PATTERN, $0) != nil }, client)
        refuses({ wholeMatches(SYNC_KEY_PATTERN, $0) != nil }, "theme.color")
        refuses({ parseHLC($0) != nil }, "0123456789ab:00ff")
    }

    func testRingIdAndHex() {
        refuses(isRingId, ring)
        refuses(isHex64, hex)
    }

    func testPeerSubjectAndDeviceId() {
        refuses({ PeerDocs.matches(PeerDocs.subPattern, $0) }, sub)
        refuses({ PeerDocs.matches(PeerDocs.devicePattern, $0) }, device)
    }
}
