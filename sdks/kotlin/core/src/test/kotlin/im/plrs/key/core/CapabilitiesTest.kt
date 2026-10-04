// @pkey-feature core.caps
//
// supports(feature) and caps() over the generated capability table (P1b-10, PARITY §2.2): the
// order of the rules, the typed reasons, the detector/table consistency check, and that the table
// is sdks/kotlin/parity.json's (the digest pnpm parity:check recomputes).

package im.plrs.key.core

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CapabilitiesTest {
    private val jvm = Capabilities(Capabilities.sdkDetectors, runtime = "jvm")
    private val android = Capabilities(Capabilities.sdkDetectors, runtime = "android")

    private fun reason(s: Support): String? = (s as? Support.Unavailable)?.unsupported?.reason

    @Test
    fun theTableIsThisSdksManifest() {
        assertEquals("kotlin", CAPABILITY_SDK)
        assertEquals(listOf("android", "jvm"), CAPABILITY_RUNTIMES)
        assertEquals(FEATURE_VALUES.toSet(), CAPABILITIES.keys)
        val manifest = JsonText.parse(File(System.getProperty("pkey.repoRoot"), "sdks/kotlin/parity.json").readText()) as kotlinx.serialization.json.JsonObject
        val features = manifest["features"]!!.objectValue!!
        for ((id, row) in CAPABILITIES) assertEquals(id, features[id].objectValue!!["status"].stringValue, row.status)
        assertEquals(64, CAPABILITY_DIGEST.length)
    }

    @Test
    fun anImplementedCoreFeatureIsSupported() {
        assertTrue(jvm.supports(Feature.coreVerify, DEFAULT_SERVICES).isSupported)
        assertTrue(jvm.supports(Feature.uiStages, NO_SERVICES).isSupported)
    }

    @Test
    fun anUnknownFeatureIsVersion() = assertEquals(UnsupportedReason.version, reason(jvm.supports("core.teleport", DEFAULT_SERVICES)))

    @Test
    fun aPlannedFeatureIsVersion() = assertEquals(UnsupportedReason.version, reason(jvm.supports(Feature.devicesFingerprint, DEFAULT_SERVICES)))

    @Test
    fun aRuntimeNaIsRuntimeOnEveryListedRuntime() {
        for (c in listOf(jvm, android)) assertEquals(UnsupportedReason.runtime, reason(c.supports(Feature.packsTypeGodotZip, DEFAULT_SERVICES)))
        // `except jvm:runtime` on a planned row: runtime wins over planned on the JVM only.
        assertEquals(UnsupportedReason.runtime, reason(jvm.supports(Feature.updateDriver, DEFAULT_SERVICES)))
        assertEquals(UnsupportedReason.version, reason(android.supports(Feature.updateDriver, DEFAULT_SERVICES)))
    }

    @Test
    fun theStoreIsPlannedOnAndroidAndVersionedOnTheJvm() {
        // core.store is planned (P6-12): `version` precedes the jvm dependency detector.
        assertEquals(UnsupportedReason.version, reason(jvm.supports(Feature.coreStore, DEFAULT_SERVICES)))
        assertEquals(UnsupportedReason.version, reason(android.supports(Feature.coreStore, DEFAULT_SERVICES)))
    }

    @Test
    fun aDisabledOptInServiceIsProduct() {
        val table = mapOf("x.y" to CapabilityRow("implemented", "release", emptyList()))
        val c = Capabilities(emptyMap(), table = table, runtime = "jvm")
        assertEquals(UnsupportedReason.product, reason(c.supports("x.y", DEFAULT_SERVICES)))
        assertTrue(c.supports("x.y", servicesFromList(listOf(ServiceSlug.release))).isSupported)
    }

    @Test
    fun aConditionalNaAsksItsDetector() {
        val table = mapOf("x.y" to CapabilityRow("implemented", "core", listOf(CapabilityNa("jvm", UnsupportedReason.dependency))))
        var missing: String? = "no keyring"
        val c = Capabilities(mapOf(capabilityDetectorKey("x.y", UnsupportedReason.dependency) to { missing }), table = table, runtime = "jvm")
        val s = c.supports("x.y", DEFAULT_SERVICES) as Support.Unavailable
        assertEquals(UnsupportedReason.dependency, s.unsupported.reason)
        assertEquals("no keyring", s.unsupported.detail)
        missing = null
        assertTrue(c.supports("x.y", DEFAULT_SERVICES).isSupported)
    }

    @Test
    fun detectorsAndTableMustAgree() {
        try {
            Capabilities(emptyMap(), runtime = "jvm")
            fail("a missing detector must be refused")
        } catch (e: CapabilityTableException) {
            assertTrue(e.problems.single().contains("core.store dependency on jvm"))
        }
        try {
            Capabilities(Capabilities.sdkDetectors + ("nope#outlet" to { null }), runtime = "jvm")
            fail("a stray detector must be refused")
        } catch (e: CapabilityTableException) {
            assertTrue(e.problems.single().contains("nope#outlet"))
        }
        Capabilities.sdk()
    }

    @Test
    fun capsListsTheSupportedFeaturesInRegistryOrder() {
        val caps = jvm.caps(DEFAULT_SERVICES)
        assertEquals(caps, FEATURE_VALUES.filter { it in caps })
        assertTrue(Feature.coreSync in caps)
        assertFalse(Feature.devicesFingerprint in caps)
    }

    @Test
    fun anUnsupportedCallThrowsTheRegistryCode() {
        val u = (jvm.supports(Feature.devicesFingerprint, DEFAULT_SERVICES) as Support.Unavailable).unsupported
        val e = UnsupportedException(u)
        assertEquals(ErrorCode.unsupported, e.code)
        assertTrue(e.message!!.contains(Feature.devicesFingerprint))
    }
}
