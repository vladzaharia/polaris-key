// @pkey-feature ui.kit.manage
// PX-W8: the gate's device-limit surface. SwiftUI rendering can't be snapshotted headlessly
// here, so the pieces the surface draws from are pinned: the copy, the platform's presentation
// (a button on macOS and iOS, a QR code on tvOS) and the link the gate offers (the served link
// with the key fragment on /activate and the app's return).

#if canImport(SwiftUI)
    import PolarisKeyCore
    import PolarisKeyUI
    import XCTest

    final class ManageKitTests: XCTestCase {
        func testCopy() {
            let copy = PolarisCopy()
            XCTAssertEqual(copy.freeDeviceButton, "Replace a device")
            XCTAssertEqual(copy.deviceLimitMessage, "This license has reached its device limit.")
            XCTAssertFalse(copy.freeDeviceScanCaption.isEmpty)
            XCTAssertEqual(PolarisCopy(freeDeviceButton: "Libérer").freeDeviceButton, "Libérer")
        }

        func testPresentation() {
            #if os(tvOS)
                XCTAssertEqual(PolarisManagePresentation.current, .qr)
            #else
                XCTAssertEqual(PolarisManagePresentation.current, .button)
            #endif
        }

        @MainActor
        func testOfferedLink() {
            let activate = "https://key.plrs.im/activate?product=djdl&next=free-device"
            XCTAssertEqual(
                PolarisGateModel.offeredManageURL(
                    activate, key: "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", returnURL: "myapp://done"),
                "https://key.plrs.im/activate?product=djdl&next=free-device&return=myapp%3A%2F%2Fdone#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV"
            )
            // A QR code on a shared screen never carries the key.
            XCTAssertEqual(
                PolarisGateModel.offeredManageURL(
                    activate, key: "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", returnURL: "myapp://done",
                    presentation: .qr),
                "https://key.plrs.im/activate?product=djdl&next=free-device&return=myapp%3A%2F%2Fdone"
            )
            let free = "https://key.plrs.im/#/p/djdl/free-device?license=lic_1"
            XCTAssertEqual(
                PolarisGateModel.offeredManageURL(free, key: "pkey_x", returnURL: nil), free)
            XCTAssertNil(PolarisGateModel.offeredManageURL(nil, key: "k", returnURL: nil))
            XCTAssertNil(
                PolarisGateModel.offeredManageURL("javascript:alert(1)", key: "k", returnURL: nil))
        }
    }
#endif
