// @pkey-feature devices.facts
package im.plrs.key.android

import im.plrs.key.core.ProbeDeclaration
import im.plrs.key.core.ProbeResult
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** devices.facts on Android: Build facts and the product's declared package probes, nothing else. */
class AndroidFactsTest {
    @Test
    fun factsComeFromBuildAndTheRuntime() {
        val f = AndroidDeviceFactsSource(FakeDevice()).collect(emptyList())
        assertEquals("android", f.os.name)
        assertEquals("16", f.os.version)
        assertEquals("BP2A.250605.031", f.os.build)
        assertEquals("6.1.99-android14", f.os.kernel)
        assertEquals("Google Pixel 9", f.hardware.machineModel)
        assertEquals("Tensor G4", f.hardware.cpuModel)
        assertEquals(8, f.hardware.cpuCores)
        assertEquals(12L * 1024, f.hardware.ramMb)
        assertEquals("kotlin", f.runtime.name)
        assertNull("no probes declared, no probes member", f.probes)
        val json = f.toJson()
        assertEquals(JsonPrimitive("android"), (json["os"] as JsonObject)["name"])
    }

    @Test
    fun onlyDeclaredAndroidPackagesAreProbed() {
        val device = FakeDevice(packages = mutableMapOf("com.discord" to "250.12", "org.example.noversion" to ""))
        val probes = listOf(
            ProbeDeclaration(id = "discord", android = "com.discord"),
            ProbeDeclaration(id = "noversion", android = "org.example.noversion"),
            ProbeDeclaration(id = "absent", android = "org.example.absent"),
            ProbeDeclaration(id = "desktop-only", macos = "/Applications/Discord.app"),
        )
        val out = AndroidDeviceFactsSource(device).collect(probes).probes!!
        assertEquals(ProbeResult(true, "250.12"), out["discord"])
        assertEquals(ProbeResult(true, null), out["noversion"])
        assertEquals(ProbeResult(false, null), out["absent"])
        assertEquals("a probe with no android target is omitted, never `present: false`", setOf("discord", "noversion", "absent"), out.keys)
    }

    @Test
    fun machineModelDoesNotRepeatTheManufacturer() {
        assertEquals("samsung SM-S928B", AndroidDeviceFactsSource.machineModel("samsung", "SM-S928B"))
        assertEquals("Pixel 9", AndroidDeviceFactsSource.machineModel(null, "Pixel 9"))
        assertEquals("OnePlus CPH2581", AndroidDeviceFactsSource.machineModel("OnePlus", "OnePlus CPH2581"))
        assertNull(AndroidDeviceFactsSource.machineModel(null, null))
    }
}
