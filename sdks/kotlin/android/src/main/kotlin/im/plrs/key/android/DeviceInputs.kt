// devices.fingerprint and devices.facts on Android (P6-12): what :core's FingerprintSource and
// DeviceFactsSource ports read on a device. PARITY §7: Android gives an app no hardware serial
// (API 29+), so the anchor is an APP-SCOPED id and the Keystore instead:
//
//   machineUuid   Settings.Secure.ANDROID_ID: per app-signing key, user and device on API 26+, reset
//                 by a factory reset. Where it cannot be read, a random anchor generated once and
//                 kept in the Keystore (SecureStore account `anchor`), so the value is still stable
//                 for as long as the key lives
//   machineModel  Build.MODEL
//   ramBucket     rule 3 over ActivityManager.MemoryInfo.totalMem
//
// No other component is read (no CPU model, MAC, board serial or volume id; the omission rule), and
// every value is hashed by :core's Fingerprint.hashComponents, so nothing raw leaves the device. The
// device id's raw value is the same anchor (DeviceId.fromRaw), which is what Godot's PKeyDeviceId
// hashes on Android too (OS.get_unique_id() is ANDROID_ID).
//
// Facts read Build and the runtime, and answer only the product's declared probes, one package name
// each, through PackageManager.getPackageInfo: there is no enumeration of installed applications
// (AGENTS rule 7, no QUERY_ALL_PACKAGES). On API 30+ package visibility hides a package the app does
// not declare: list each probe's package in the app manifest's <queries>, or it reads as absent.

package im.plrs.key.android

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import im.plrs.key.core.DeviceFacts
import im.plrs.key.core.DeviceFactsSource
import im.plrs.key.core.Fingerprint
import im.plrs.key.core.FingerprintComponent
import im.plrs.key.core.FingerprintSource
import im.plrs.key.core.HardwareFingerprint
import im.plrs.key.core.ProbeDeclaration
import im.plrs.key.core.ProbeResult
import im.plrs.key.platform.SecureStore
import im.plrs.key.platform.SecureStoreException
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/** The device inputs the Android readers use. [SystemAndroidDevice] on a device; a fake in tests. */
public interface AndroidDevice {
    /** `Settings.Secure.ANDROID_ID`, or null when it cannot be read. */
    public fun androidId(): String?

    /** `Build.MODEL`. */
    public fun model(): String?

    /** `Build.MANUFACTURER`. */
    public fun manufacturer(): String?

    /** `Build.VERSION.RELEASE`. */
    public fun osVersion(): String?

    /** `Build.DISPLAY` (the build id string the user sees). */
    public fun osBuild(): String?

    /** The kernel release (`os.version`). */
    public fun kernel(): String?

    /** `Build.SOC_MODEL` on API 31+, else null. */
    public fun socModel(): String?

    public fun cpuCores(): Int?

    /** `ActivityManager.MemoryInfo.totalMem`, or null. */
    public fun totalMemoryBytes(): Long?

    /** The installed package's `versionName` (empty when it has none), or null when it is not visible. */
    public fun packageVersion(packageName: String): String?
}

/** [AndroidDevice] over the real platform APIs. Nothing here needs a permission. */
public class SystemAndroidDevice(private val context: Context) : AndroidDevice {
    // ANDROID_ID is the app-scoped id PARITY §7 names; it is hashed before it is used anywhere.
    @SuppressLint("HardwareIds")
    override fun androidId(): String? = try {
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
    } catch (e: Exception) {
        null
    }

    override fun model(): String? = Build.MODEL

    override fun manufacturer(): String? = Build.MANUFACTURER

    override fun osVersion(): String? = Build.VERSION.RELEASE

    override fun osBuild(): String? = Build.DISPLAY

    override fun kernel(): String? = System.getProperty("os.version")

    override fun socModel(): String? = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else null

    override fun cpuCores(): Int = Runtime.getRuntime().availableProcessors()

    override fun totalMemoryBytes(): Long? = try {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager?
        val info = ActivityManager.MemoryInfo()
        am?.getMemoryInfo(info)
        info.totalMem.takeIf { it > 0 }
    } catch (e: Exception) {
        null
    }

    override fun packageVersion(packageName: String): String? = try {
        @Suppress("DEPRECATION")
        val info = context.packageManager.getPackageInfo(packageName, 0)
        info.versionName ?: ""
    } catch (e: PackageManager.NameNotFoundException) {
        null
    }
}

/** The value Android's anchor is read from, and where it came from. */
public data class AndroidAnchor(val value: String, val source: String) {
    public companion object {
        public const val ANDROID_ID: String = "android-id"
        public const val KEYSTORE: String = "keystore"
        public const val EPHEMERAL: String = "ephemeral"

        /** The SecureStore account holding the random anchor. */
        public const val ACCOUNT: String = "anchor"

        /** The ANDROID_ID every device of one Android 2.2 batch reported: no evidence. */
        private const val BROKEN_ANDROID_ID = "9774d56d682e549c"

        /**
         * ANDROID_ID when it reads, else the Keystore's random anchor (created on first use), else a
         * random value for this call only (the store keeps the id it derived from it in its file).
         */
        public fun read(device: AndroidDevice, keystore: SecureStore?): AndroidAnchor {
            val id = device.androidId()?.trim()
            if (!id.isNullOrEmpty() && id != BROKEN_ANDROID_ID && id.any { it != '0' }) return AndroidAnchor(id, ANDROID_ID)
            if (keystore != null) {
                try {
                    keystore.get(ACCOUNT).value?.takeIf { it.isNotEmpty() }?.let { return AndroidAnchor(it, KEYSTORE) }
                    val fresh = UUID.randomUUID().toString()
                    keystore.put(ACCOUNT, fresh)
                    return AndroidAnchor(fresh, KEYSTORE)
                } catch (e: SecureStoreException) {
                    // Fall through: an unstored anchor.
                }
            }
            return AndroidAnchor(UUID.randomUUID().toString(), EPHEMERAL)
        }
    }
}

/** The raw value the device id hashes (`DeviceId.fromRaw`): the anchor. */
public fun deviceIdRaw(device: AndroidDevice, keystore: SecureStore?): String = AndroidAnchor.read(device, keystore).value

/** Android's fingerprint: the anchor, the model and the RAM bucket, hashed per `fingerprint.json`. */
public class AndroidFingerprintSource(
    private val device: AndroidDevice,
    /** Holds the random anchor where ANDROID_ID cannot be read; null never stores one. */
    private val keystore: SecureStore? = null,
) : FingerprintSource {
    public constructor(context: Context, productSlug: String) : this(SystemAndroidDevice(context), SecureStore(context, productSlug))

    /** The raw components (component wire name to value); unreadable ones are omitted. Never sent. */
    public fun rawComponents(): Map<String, String> {
        val raw = LinkedHashMap<String, String>()
        fun put(c: FingerprintComponent, v: String?) {
            val t = v?.let { Fingerprint.trimAsciiWhitespace(it) }
            if (!t.isNullOrEmpty()) raw[c.wire] = t
        }
        put(FingerprintComponent.machineUuid, AndroidAnchor.read(device, keystore).value)
        put(FingerprintComponent.machineModel, device.model())
        put(FingerprintComponent.ramBucket, device.totalMemoryBytes()?.let { Fingerprint.ramBucket(it) })
        return raw
    }

    override fun collect(productSlug: String): HardwareFingerprint? {
        val raw = rawComponents()
        if (raw.isEmpty()) return null
        return Fingerprint.hashComponents(productSlug, raw)
    }
}

/** Android's facts: Build, the runtime, and the declared probes' packages. */
public class AndroidDeviceFactsSource(private val device: AndroidDevice) : DeviceFactsSource {
    public constructor(context: Context) : this(SystemAndroidDevice(context))

    /** The declared probes with an `android` package name; a probe without one is omitted. */
    public fun runProbes(declarations: List<ProbeDeclaration>): Map<String, ProbeResult> {
        val out = LinkedHashMap<String, ProbeResult>()
        for (probe in declarations) {
            // An inapplicable probe is left out, never reported as `present: false`.
            val pkg = probe.android?.takeIf { it.isNotEmpty() } ?: continue
            val version = device.packageVersion(pkg)
            out[probe.id] = ProbeResult(version != null, version?.takeIf { it.isNotEmpty() })
        }
        return out
    }

    override fun collect(probes: List<ProbeDeclaration>): DeviceFacts {
        val mem = device.totalMemoryBytes()
        return DeviceFacts(
            os = DeviceFacts.Os(name = "android", version = device.osVersion().nonEmpty(), build = device.osBuild().nonEmpty(), kernel = device.kernel().nonEmpty()),
            hardware = DeviceFacts.Hardware(
                cpuModel = device.socModel().nonEmpty()?.takeIf { !it.equals(Build.UNKNOWN, ignoreCase = true) },
                cpuCores = device.cpuCores(),
                ramMb = mem?.let { it / 1_048_576 },
                machineModel = machineModel(device.manufacturer(), device.model()),
            ),
            runtime = DeviceFacts.Runtime(name = "kotlin", version = KotlinVersion.CURRENT.toString()),
            locale = Locale.getDefault().toLanguageTag().ifEmpty { null },
            timezone = TimeZone.getDefault().id?.ifEmpty { null },
            probes = if (probes.isEmpty()) null else runProbes(probes),
        )
    }

    public companion object {
        /** `<manufacturer> <model>`, without repeating a manufacturer the model already starts with. */
        public fun machineModel(manufacturer: String?, model: String?): String? {
            val m = model.nonEmpty() ?: return manufacturer.nonEmpty()
            val maker = manufacturer.nonEmpty() ?: return m
            return if (m.startsWith(maker, ignoreCase = true)) m else "$maker $m"
        }
    }
}

private fun String?.nonEmpty(): String? = this?.trim()?.ifEmpty { null }
