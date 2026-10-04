// @pkey-feature devices.fingerprint
package im.plrs.key.android

import androidx.test.core.app.ApplicationProvider
import im.plrs.key.core.DeviceId
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.platform.SecureStore
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** A device whose every input is given. */
class FakeDevice(
    var androidId: String? = "9f3c2a7b11d04e55",
    var model: String? = "Pixel 9",
    var manufacturer: String? = "Google",
    var totalMem: Long? = 12L shl 30,
    val packages: MutableMap<String, String> = mutableMapOf(),
) : AndroidDevice {
    override fun androidId(): String? = androidId
    override fun model(): String? = model
    override fun manufacturer(): String? = manufacturer
    override fun osVersion(): String = "16"
    override fun osBuild(): String = "BP2A.250605.031"
    override fun kernel(): String = "6.1.99-android14"
    override fun socModel(): String = "Tensor G4"
    override fun cpuCores(): Int = 8
    override fun totalMemoryBytes(): Long? = totalMem
    override fun packageVersion(packageName: String): String? = packages[packageName]
}

/**
 * devices.fingerprint on Android, against conformance/corpus/v2/fingerprint.json: the Android reader
 * (ANDROID_ID as machineUuid, Build.MODEL, the RAM bucket) fed each corpus input yields the corpus
 * digests, the ramBuckets family's buckets and the deviceIds family's ids.
 */
@RunWith(RobolectricTestRunner::class)
class AndroidFingerprintTest {
    @get:Rule val tmp = TemporaryFolder()

    private val corpus = Corpus.load("fingerprint.json").objectValue!!

    @Test
    fun androidShapedVectorMatchesTheCorpus() {
        // `unicode-model` is exactly what an Android device reads: machineUuid and machineModel, and a
        // RAM total below 1 GiB (no bucket).
        val vector = corpus["vectors"].arrayValue!!.map { it.objectValue!! }.first { it["id"].stringValue == "unicode-model" }
        val raw = vector["raw"].objectValue!!
        assertEquals(setOf("machineUuid", "machineModel"), raw.keys)
        val device = FakeDevice(androidId = raw["machineUuid"].stringValue, model = raw["machineModel"].stringValue, totalMem = 512L shl 20)
        val fp = AndroidFingerprintSource(device).collect(vector["product"].stringValue!!)!!
        val expected = vector["components"].objectValue!!.mapValues { it.value.stringValue }
        assertEquals(expected, fp.components)
        assertEquals(vector["hwid"].stringValue, fp.hwid)
    }

    @Test
    fun ramBucketsFollowTheCorpus() {
        for (case in corpus["ramBuckets"].arrayValue!!.map { it.objectValue!! }) {
            val bytes = case["bytes"].longValue ?: continue // a case beyond Long is the BigInteger path's (:conformance)
            val raw = AndroidFingerprintSource(FakeDevice(totalMem = bytes)).rawComponents()
            assertEquals("ramBuckets ${case["id"].stringValue}", case["bucket"].stringValue, raw["ramBucket"])
        }
    }

    @Test
    fun deviceIdsHashTheAnchorAsTheCorpusSays() {
        for (case in corpus["deviceIds"].arrayValue!!.map { it.objectValue!! }) {
            val raw = case["raw"].stringValue!!
            val anchor = deviceIdRaw(FakeDevice(androidId = raw), null)
            assertEquals(raw.trim(), anchor)
            assertEquals(case["id"].stringValue, case["expected"].stringValue, DeviceId.fromRaw(case["product"].stringValue!!, anchor))
        }
    }

    @Test
    fun withoutAndroidIdTheKeystoreAnchorIsStable() {
        val keys = SoftKeyProvider()
        val secure = SecureStore(File(tmp.root, "ks"), "diceroll", keys)
        val device = FakeDevice(androidId = null)
        val first = AndroidAnchor.read(device, secure)
        assertEquals(AndroidAnchor.KEYSTORE, first.source)
        assertEquals(first, AndroidAnchor.read(device, secure))
        val fp1 = AndroidFingerprintSource(device, secure).collect("diceroll")
        val fp2 = AndroidFingerprintSource(device, secure).collect("diceroll")
        assertEquals(fp1, fp2)
        // The broken Android 2.2 id and an all-zero id are no evidence.
        assertEquals(AndroidAnchor.KEYSTORE, AndroidAnchor.read(FakeDevice(androidId = "9774d56d682e549c"), secure).source)
        assertEquals(AndroidAnchor.KEYSTORE, AndroidAnchor.read(FakeDevice(androidId = "0000000000000000"), secure).source)
        // A broken Keystore leaves an ephemeral anchor, never a crash.
        keys.broken = true
        val eph = AndroidAnchor.read(device, secure)
        assertEquals(AndroidAnchor.EPHEMERAL, eph.source)
        assertNotEquals(first.value, eph.value)
    }

    @Test
    fun readsOnlyTheThreeAndroidComponents() {
        val raw = AndroidFingerprintSource(FakeDevice()).rawComponents()
        assertEquals(listOf("machineUuid", "machineModel", "ramBucket"), raw.keys.toList())
        assertEquals("8", raw["ramBucket"])
        val none = AndroidFingerprintSource(FakeDevice(androidId = null, model = null, totalMem = null)).rawComponents()
        assertEquals("an unstored anchor is still read", setOf("machineUuid"), none.keys)
    }

    @Test
    fun systemDeviceReadsOnRobolectric() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val device = SystemAndroidDevice(ctx)
        assertNotNull(device.model())
        assertTrue(device.cpuCores() > 0)
        assertNull("an undeclared package is not visible", device.packageVersion("org.example.absent"))
        assertNotNull("the app sees itself", device.packageVersion(ctx.packageName))
        assertFalse(AndroidFingerprintSource(device).rawComponents().isEmpty())
    }
}
