package im.plrs.key.ui

import im.plrs.key.core.LicenseStatus
import im.plrs.key.sdk.DeviceInfo
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The roster model stays usable from a non-Compose host. */
@OptIn(ExperimentalCoroutinesApi::class)
class PolarisDevicesStateTest {
    @Test
    fun loadsSortsRenamesAndDeauthorizes() = runTest {
        val devices = mutableListOf(
            DeviceInfo("b", current = false, status = LicenseStatus.ok, label = "Zed"),
            DeviceInfo("a", current = true, status = LicenseStatus.ok, label = "Pixel"),
            DeviceInfo("c", current = false, status = LicenseStatus.ok, label = "alpha"),
        )
        val renamed = mutableListOf<Pair<String, String?>>()
        val state = PolarisDevicesState(
            object : PolarisDevicesActions {
                override suspend fun list(): List<DeviceInfo> = devices.toList()
                override suspend fun rename(deviceId: String, label: String?) {
                    renamed += deviceId to label
                }

                override suspend fun deauthorize(deviceId: String) {
                    devices.removeAll { it.id == deviceId }
                }
            },
            backgroundScope,
            clockMillis = { 5 },
        )

        state.load()
        runCurrent()
        assertEquals(listOf("a", "c", "b"), state.ui.value.devices.map { it.id })

        state.rename("c", "   ")
        runCurrent()
        assertEquals(listOf("c" to null), renamed)

        state.deauthorize("b")
        runCurrent()
        assertEquals(listOf("a", "c"), state.ui.value.devices.map { it.id })
        assertNull(state.ui.value.busyId)
    }

    @Test
    fun surfacesAListFailure() = runTest {
        val state = PolarisDevicesState(
            object : PolarisDevicesActions {
                override suspend fun list(): List<DeviceInfo> = throw IllegalStateException("401")
                override suspend fun rename(deviceId: String, label: String?) = Unit
                override suspend fun deauthorize(deviceId: String) = Unit
            },
            backgroundScope,
        )

        state.load()
        runCurrent()

        assertTrue(state.ui.value.error)
        assertFalse(state.ui.value.loading)
    }
}
