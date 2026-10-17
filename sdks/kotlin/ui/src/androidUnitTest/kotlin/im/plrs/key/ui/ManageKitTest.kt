// @pkey-feature ui.kit.manage
// PX-W8: the gate's device-limit surface. The snapshots (gate-device-limit-manage and its TV
// variant, in KitSnapshotTest) pin the drawing; this pins the link the gate offers (the served
// link with the key fragment on /activate only, plus the app's return) and the state holder
// clearing it when the person edits the key.

package im.plrs.key.ui

import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.license.ActivationResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ManageKitTest {
    private val activate = "https://key.plrs.im/activate?product=djdl&next=free-device"

    @Test
    fun theOfferedLink() {
        assertEquals(
            "$activate&return=myapp%3A%2F%2Fdone#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV",
            offeredManageUrl(ActivationResult.DeviceLimit(1, 1, activate), "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", "myapp://done"),
        )
        // A QR code on a shared screen never carries the key: the phone's /activate page asks.
        assertEquals(
            "$activate&return=myapp%3A%2F%2Fdone",
            offeredManageUrl(ActivationResult.DeviceLimit(1, 1, activate), "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", "myapp://done", forQr = true),
        )
        val free = "https://key.plrs.im/#/p/djdl/free-device?license=lic_1"
        assertEquals(free, offeredManageUrl(ActivationResult.DeviceLimit(1, 1, free), "pkey_x"))
        assertNull(offeredManageUrl(ActivationResult.DeviceLimit(1, 1), "k"))
        assertNull(offeredManageUrl(ActivationResult.DeviceLimit(1, 1, "javascript:alert(1)"), "k"))
        assertNull(offeredManageUrl(ActivationResult.Unauthorized, "k"))
    }

    @Test
    fun theCopy() {
        val copy = PolarisCopy()
        assertEquals("Replace a device", copy.freeDevice)
        assertEquals("Scan the code to replace a device on your phone.", copy.freeDeviceScan)
    }

    @Test
    fun theStateHolderOffersAndClearsTheLink() = runBlocking {
        val actions = object : PolarisGateActions {
            override suspend fun status(): LicenseState = LicenseState(status = LicenseStatus.needsActivation)
            override suspend fun activate(key: String): ActivationResult = ActivationResult.DeviceLimit(1, 1, activate)
        }
        val state = PolarisGateState(actions, CoroutineScope(Dispatchers.Unconfined), returnUrl = "myapp://done")
        state.onKeyChange("pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV")
        state.activate()
        repeat(3) { yield() }
        assertEquals(
            "$activate&return=myapp%3A%2F%2Fdone#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV",
            state.activation.value.manageUrl,
        )
        assertEquals("$activate&return=myapp%3A%2F%2Fdone", state.activation.value.manageQrUrl)
        state.onKeyChange("pkey_other")
        assertNull(state.activation.value.manageUrl)
        assertNull(state.activation.value.manageQrUrl)
    }
}
