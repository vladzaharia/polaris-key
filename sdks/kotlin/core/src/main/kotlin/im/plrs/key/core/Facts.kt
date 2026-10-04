// Software facts — the OS / runtime / hardware summary and the product-declared probe results a
// client reports through `POST /<product>/devices/report` (wire contract v3 §6). Mirrors Swift's
// `Facts.swift`, `@polaris-key/node`'s `devices/facts.ts` and the Python SDK's facts module.
//
// Deliberately narrow: there is no installed-application enumeration. A product declares the
// companion apps it cares about and the client answers only those (docs/PRIVACY.md); the Worker's
// report allowlist caps `probes` at 32 entries and truncates every string anyway.
//
// The facts arrive through a PORT, `DeviceFactsSource`, because the inputs are per platform: a JVM
// desktop reads system properties and the file system ([JvmDeviceFactsSource], here), Android reads
// `Build` and answers probes through the package manager (the :android glue, P6-12). This module
// stays free of Android types (checkModuleBoundaries).

package im.plrs.key.core

import java.io.File
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A product-declared companion-application check. Each field names this platform's target. */
public data class ProbeDeclaration(
    val id: String,
    val label: String? = null,
    /** Absolute path or bundle directory to test for. */
    val macos: String? = null,
    /** Executable path to test for. */
    val windows: String? = null,
    /** Executable or package path to test for. */
    val linux: String? = null,
    /** Package name to test for (answered by the Android facts source, P6-12). */
    val android: String? = null,
)

/** One probe's answer. */
public data class ProbeResult(val present: Boolean, val version: String? = null) {
    public fun toJson(): JsonObject = JsonObject(
        buildMap {
            put("present", JsonPrimitive(present))
            version?.let { put("version", JsonPrimitive(it)) }
        },
    )
}

/** The device's current software snapshot. A null member is omitted from the report. */
public data class DeviceFacts(
    val os: Os,
    val hardware: Hardware,
    val runtime: Runtime,
    val locale: String? = null,
    val timezone: String? = null,
    val probes: Map<String, ProbeResult>? = null,
) {
    public data class Os(val name: String, val version: String? = null, val build: String? = null, val kernel: String? = null)

    public data class Hardware(
        val cpuModel: String? = null,
        val cpuCores: Int? = null,
        val ramMb: Long? = null,
        val machineModel: String? = null,
    )

    public data class Runtime(val name: String, val version: String)

    /** The report members this snapshot contributes, in the Worker's allowlist vocabulary. */
    public fun toJson(): Map<String, JsonElement> = buildMap {
        put("os", obj("name" to os.name, "version" to os.version, "build" to os.build, "kernel" to os.kernel))
        put(
            "hardware",
            JsonObject(
                buildMap {
                    hardware.cpuModel?.let { put("cpuModel", JsonPrimitive(it)) }
                    hardware.cpuCores?.let { put("cpuCores", JsonPrimitive(it)) }
                    hardware.ramMb?.let { put("ramMb", JsonPrimitive(it)) }
                    hardware.machineModel?.let { put("machineModel", JsonPrimitive(it)) }
                },
            ),
        )
        put("runtime", obj("name" to runtime.name, "version" to runtime.version))
        locale?.let { put("locale", JsonPrimitive(it)) }
        timezone?.let { put("timezone", JsonPrimitive(it)) }
        probes?.let { p -> put("probes", JsonObject(p.mapValues { it.value.toJson() })) }
    }

    private fun obj(vararg pairs: Pair<String, String?>): JsonObject =
        JsonObject(pairs.mapNotNull { (k, v) -> v?.let { k to JsonPrimitive(it) } }.toMap())
}

/** Where a client's facts come from. Collected on every report; never cached. */
public fun interface DeviceFactsSource {
    public fun collect(probes: List<ProbeDeclaration>): DeviceFacts
}

/** A JVM desktop's facts: system properties, the runtime, and declared probes as file checks. */
public object JvmDeviceFactsSource : DeviceFactsSource {
    /** `process.platform`'s spelling, which every SDK reports: `darwin`, `win32`, `linux`, `android`. */
    public val osName: String
        get() = when (RuntimeFamily.platformToken) {
            "Android" -> "android"
            "macOS" -> "darwin"
            "Windows" -> "win32"
            "Linux" -> "linux"
            else -> System.getProperty("os.name").orEmpty().lowercase().ifEmpty { "unknown" }
        }

    /** Answer the declared probes for this platform; a probe with no target here is omitted. */
    public fun runProbes(declarations: List<ProbeDeclaration>): Map<String, ProbeResult> {
        val out = LinkedHashMap<String, ProbeResult>()
        for (probe in declarations) {
            // Reporting an inapplicable probe as `present: false` would be a lie an admin cannot
            // tell from "not installed", so it is left out.
            val target = when (osName) {
                "darwin" -> probe.macos
                "win32" -> probe.windows
                "android" -> null
                else -> probe.linux
            } ?: continue
            val present = try {
                File(target).exists()
            } catch (e: SecurityException) {
                false
            }
            out[probe.id] = ProbeResult(present, if (present && osName == "darwin") macAppVersion(target) else null)
        }
        return out
    }

    /** A macOS app's `CFBundleShortVersionString`, read best-effort from its Info.plist. */
    private fun macAppVersion(bundle: String): String? = try {
        val plist = File(bundle, "Contents/Info.plist").takeIf { it.isFile }?.readText()
        plist?.let {
            Regex("<key>CFBundleShortVersionString</key>\\s*<string>([^<]+)</string>").find(it)?.groupValues?.get(1)?.trim()
        }
    } catch (e: Exception) {
        null
    }

    override fun collect(probes: List<ProbeDeclaration>): DeviceFacts {
        val ram = physicalMemoryBytes()?.let { it / 1_048_576 }
        return DeviceFacts(
            os = DeviceFacts.Os(
                name = osName,
                version = System.getProperty("os.version")?.ifEmpty { null },
                kernel = System.getProperty("os.name")?.ifEmpty { null },
            ),
            hardware = DeviceFacts.Hardware(
                cpuCores = Runtime.getRuntime().availableProcessors(),
                ramMb = ram,
                machineModel = null,
            ),
            runtime = DeviceFacts.Runtime(name = "kotlin", version = KotlinVersion.CURRENT.toString()),
            locale = Locale.getDefault().toLanguageTag().ifEmpty { null },
            timezone = TimeZone.getDefault().id?.ifEmpty { null },
            probes = if (probes.isEmpty()) null else runProbes(probes),
        )
    }
}
