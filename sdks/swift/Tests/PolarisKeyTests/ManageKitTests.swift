// @pkey-feature ui.kit.manage
// PX-W8: the legacy copy the device-limit surface drew from (the kit's Replace flow is covered by
// KitGateModelTests).

#if canImport(SwiftUI)
    import PolarisKeyCore
    import PolarisKeyUI
    import XCTest

    final class ManageKitTests: XCTestCase {
        func testCopy() {
            let copy = PolarisCopy()
            XCTAssertEqual(copy.freeDeviceButton, KitButtonCase.button("Replace a device"))
            XCTAssertFalse(copy.freeDeviceScanCaption.isEmpty)
            XCTAssertEqual(PolarisCopy(freeDeviceButton: "Libérer").freeDeviceButton, "Libérer")
        }
    }
#endif
