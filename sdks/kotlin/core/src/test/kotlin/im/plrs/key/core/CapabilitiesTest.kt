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
    fun aPlannedFeatureIsVersion() = assertEquals(UnsupportedReason.version, reason(jvm.supports(Feature.identityOidc, DEFAULT_SERVICES)))

    @Test
    fun aRuntimeNaIsRuntimeOnEveryListedRuntime() {
        for (c in listOf(jvm, android)) assertEquals(UnsupportedReason.runtime, reason(c.supports(Feature.packsTypeGodotZip, DEFAULT_SERVICES)))
        // `except jvm:runtime` on an implemented row (P6-12): runtime on the JVM only; on Android the
        // row asks for its opt-in service like any other.
        val withDistribution = servicesFromList(listOf(ServiceSlug.distribution))
        assertEquals(UnsupportedReason.runtime, reason(jvm.supports(Feature.packsTransportPlay, withDistribution)))
        assertTrue(android.supports(Feature.packsTransportPlay, withDistribution).isSupported)
        // UK-40: the JVM desktop has an install driver now, so update.driver is supported on both.
        val withUpdate = servicesFromList(listOf(ServiceSlug.update))
        assertTrue(jvm.supports(Feature.updateDriver, withUpdate).isSupported)
        assertTrue(android.supports(Feature.updateDriver, withUpdate).isSupported)
    }

    @Test
    fun theStoreIsTheKeystoreOnAndroidAndDependencyOnTheJvm() {
        // core.store is implemented (P6-12's Keystore store); the JVM's 0600 file is `dependency`.
        assertEquals(UnsupportedReason.dependency, reason(jvm.supports(Feature.coreStore, DEFAULT_SERVICES)))
        assertTrue(android.supports(Feature.coreStore, DEFAULT_SERVICES).isSupported)
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
            // Every conditional N/A on the JVM needs its detector: core.store's and (P6-08) packs.apply.delta's.
            assertEquals(2, e.problems.size)
            assertTrue(e.problems.any { it.contains("core.store dependency on jvm") })
            assertTrue(e.problems.any { it.contains("packs.apply.delta dependency on jvm") })
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
        assertTrue(Feature.devicesFingerprint in caps)
        assertFalse(Feature.identityOidc in caps)
        assertFalse("core.store is dependency on the JVM", Feature.coreStore in caps)
    }

    @Test
    fun anUnsupportedCallThrowsTheRegistryCode() {
        val u = (jvm.supports(Feature.identityOidc, DEFAULT_SERVICES) as Support.Unavailable).unsupported
        val e = UnsupportedException(u)
        assertEquals(ErrorCode.unsupported, e.code)
        assertTrue(e.message!!.contains(Feature.identityOidc))
    }
}
