import Foundation
import XCTest

@testable import PolarisKeyPlatform

/// Names that become keychain items must match whole: a trailing line terminator or control
/// character is refused.
final class NameAnchorTests: XCTestCase {
    private let tails = ["\n", "\r", "\r\n", "\u{85}", "\u{2028}", "\0"]

    func testProductAndAccountNamesRefuseATrailingTerminator() {
        XCTAssertTrue(SecureStore.validProduct("djdl"))
        XCTAssertTrue(SecureStore.validProduct("djdl@com.example"))
        XCTAssertTrue(SecureStore.validAccount("device-token"))
        for t in tails {
            XCTAssertFalse(SecureStore.validProduct("djdl" + t), "product \(t.unicodeScalars.map(\.value))")
            XCTAssertFalse(SecureStore.validProduct("djdl@com.example" + t))
            XCTAssertFalse(SecureStore.validAccount("device-token" + t))
        }
    }

    #if canImport(Security)
        func testBackupComponentsRefuseATrailingTerminator() {
            XCTAssertTrue(PlatformBackupStore.validComponent("ps_abc"))
            for t in tails { XCTAssertFalse(PlatformBackupStore.validComponent("ps_abc" + t)) }
        }
    #endif
}
