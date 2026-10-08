// The device principal — wire contract v3 §6: keyless registration, the device roster, and the
// fingerprint a mint path sends. The analogue of Swift's `CoreContext` device section.
//
// These live in :core, not in a service module, because that is the point of D-08: a device is
// not a licensing concept. A config-only product's installs need an identity to fetch a document
// AS and a credential to fetch it WITH, and `registerDevice` is where they get one; the roster is a
// property of the product's fleet, available under every registration policy. The registry files
// every `devices.*` row under the `core` service for the same reason.
//
// Every call goes through `CoreContext.request`, so the `X-PKey-*` headers and the deadline arrive
// automatically (R4-08).

package im.plrs.key.core

import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** `POST /<p>/devices/register` (§6). */
public sealed interface RegisterResult {
    public data class Ok(val token: String, val deviceId: String) : RegisterResult

    /**
     * The product's policy is `requires-license` or `requires-identity`: activation (or a sign-in)
     * is the mint path, and the endpoint refuses without telling you which.
     */
    public data object RegistrationClosed : RegisterResult
    public data object RateLimited : RegisterResult
    public data object NotConfigured : RegisterResult
    public data class Error(val message: String) : RegisterResult
}

/**
 * One device as the SERVER reports it (§6). Every field but [id] is optional because the roster
 * shape is the Worker's, and an SDK that predates a column must not fail to read a row.
 */
public data class AccountDevice(
    val id: String,
    val licenseId: String? = null,
    val label: String? = null,
    val status: String? = null,
    val current: Boolean? = null,
    val firstSeen: Long? = null,
    val lastSeen: Long? = null,
    val platform: String? = null,
    val arch: String? = null,
    val appVersion: String? = null,
    val sdkName: String? = null,
    val sdkVersion: String? = null,
) {
    public companion object {
        /** One roster row; null when it has no string `id`. */
        public fun from(element: JsonElement?): AccountDevice? {
            val o = element.objectValue ?: return null
            return AccountDevice(
                id = o["id"].stringValue ?: return null,
                licenseId = o["licenseId"].stringValue,
                label = o["label"].stringValue,
                status = o["status"].stringValue,
                current = o["current"].boolValue,
                firstSeen = o["firstSeen"].longValue,
                lastSeen = o["lastSeen"].longValue,
                platform = o["platform"].stringValue,
                arch = o["arch"].stringValue,
                appVersion = o["appVersion"].stringValue,
                sdkName = o["sdkName"].stringValue,
                sdkVersion = o["sdkVersion"].stringValue,
            )
        }
    }
}

/** `{"fingerprint": {"components": {...}, "hwid": "..."}}`: the body register and activation read. */
public fun HardwareFingerprint.requestBody(): ByteArray = deviceRequestBody(this, null)!!

/**
 * The register and activation body: the fingerprint and the device label (PX-W13 §8 Q2), each
 * member omitted when absent; null when both are, so no body is sent at all.
 */
public fun deviceRequestBody(fingerprint: HardwareFingerprint?, deviceName: String?): ByteArray? {
    val members = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
    if (fingerprint != null) {
        members["fingerprint"] = JsonObject(
            mapOf(
                "components" to JsonObject(fingerprint.components.mapValues { JsonPrimitive(it.value) }),
                "hwid" to JsonPrimitive(fingerprint.hwid),
            ),
        )
    }
    if (deviceName != null) members["deviceName"] = JsonPrimitive(deviceName)
    return if (members.isEmpty()) null else JsonObject(members).toString().toByteArray(Charsets.UTF_8)
}

// ── Registration (§6) ────────────────────────────────────────────────────────────────────────

/**
 * `POST /<p>/devices/register`, then store the token with source `register`. No `Authorization`
 * header is sent even when a stale token is held: a client re-registering asks for a FRESH
 * credential, not to authenticate with the old one.
 */
public suspend fun CoreContext.registerDevice(fingerprint: HardwareFingerprint? = null): RegisterResult {
    val result = requestDeviceRegistration(fingerprint)
    if (result !is RegisterResult.Ok) return result
    return try {
        setToken(result.token, TokenSource.register)
        result
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Exception) {
        RegisterResult.Error("could not persist the device token: ${e.message}")
    }
}

/**
 * The registration request alone, without storing the token. [registerDevice] stores it; the §5
 * re-register on 401 lets the sync pass store it instead, so the one request is identical on both
 * paths: the fingerprint when given, never a bearer.
 */
public suspend fun CoreContext.requestDeviceRegistration(fingerprint: HardwareFingerprint? = null): RegisterResult {
    val headers = LinkedHashMap<String, String>()
    // PX-W13 §8 Q2: the device label rides along, seeding the device's name in the lists.
    val body = deviceRequestBody(fingerprint, deviceLabel())
    if (body != null) headers["content-type"] = "application/json"
    val response = try {
        request(endpoints.devicesRegister, method = "POST", headers = headers, body = body)
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Exception) {
        return RegisterResult.Error(e.message ?: "transport error")
    }
    return when (response.status) {
        200 -> {
            val o = JsonText.parseOrNull(response.text).objectValue
            val token = o?.get("token").stringValue
            val deviceId = o?.get("deviceId").stringValue
            if (token == null || deviceId == null) RegisterResult.Error("malformed register response")
            else RegisterResult.Ok(token, deviceId)
        }
        403 -> RegisterResult.RegistrationClosed
        429 -> RegisterResult.RateLimited
        404 -> RegisterResult.NotConfigured
        else -> RegisterResult.Error(response.text)
    }
}

// ── The roster (§6) ──────────────────────────────────────────────────────────────────────────

private suspend fun CoreContext.requireDeviceToken(): String = token() ?: throw PolarisException(
    ErrorCode.deviceManagementUnsupported, "Activate or register before managing devices.",
)

/**
 * `GET /<p>/devices`: the roster this credential can see. The server decides what "visible"
 * means: a licensed device sees its licence's seat pool, a registered device with no licence sees
 * only itself.
 */
public suspend fun CoreContext.listDevices(): List<AccountDevice> {
    val token = requireDeviceToken()
    val response = request(endpoints.devices, headers = mapOf("authorization" to "Bearer $token"))
    if (!response.isOk) {
        throw PolarisException(ErrorCode.deviceListFailed, "device list failed with status ${response.status}.")
    }
    val rows = JsonText.parseOrNull(response.text).objectValue?.get("devices").arrayValue ?: return emptyList()
    return rows.mapNotNull { AccountDevice.from(it) }
}

/** `PATCH /<p>/devices/:id`: rename (self-only, enforced server-side). A null [label] clears it. */
public suspend fun CoreContext.renameDevice(deviceId: String, label: String?) {
    val token = requireDeviceToken()
    val body = JsonObject(mapOf("label" to (label?.let { JsonPrimitive(it) } ?: JsonNull)))
    val response = request(
        endpoints.device(deviceId), method = "PATCH",
        headers = mapOf("authorization" to "Bearer $token", "content-type" to "application/json"),
        body = body.toString().toByteArray(Charsets.UTF_8),
    )
    if (!response.isOk) {
        throw PolarisException(ErrorCode.deviceRenameFailed, "device rename failed with status ${response.status}.")
    }
}

/**
 * `DELETE /<p>/devices/:id`: release another device's seat. Deauthorizing THIS device is a full
 * local deactivation and belongs to the licence client.
 */
public suspend fun CoreContext.deauthorizeDevice(deviceId: String) {
    val token = requireDeviceToken()
    val response = request(endpoints.device(deviceId), method = "DELETE", headers = mapOf("authorization" to "Bearer $token"))
    if (!response.isOk) {
        throw PolarisException(ErrorCode.deviceDeauthorizeFailed, "device deauthorize failed with status ${response.status}.")
    }
}

// ── The fingerprint a mint path sends ────────────────────────────────────────────────────────

/**
 * Where a mint path (activation, enrolment, registration) gets this host's hashed fingerprint.
 * Null when nothing could be read: the request then carries no body, and the server records the
 * device as `unverified` rather than refusing it. Android's reader (the app-scoped id and the
 * Keystore anchor) is the :android module's (P6-12); [JvmFingerprintSource] reads a JVM desktop.
 */
public fun interface FingerprintSource {
    public fun collect(productSlug: String): HardwareFingerprint?
}

/**
 * A JVM desktop's fingerprint: rule 2's Linux anchor (`/etc/machine-id`), macOS's
 * `IOPlatformUUID`, rule 1's Windows CIM read (board serial and model), and rule 3's RAM bucket.
 * Only components that actually read are included (the omission rule); raw values are hashed by
 * [Fingerprint.hashComponents] and never leave the device.
 */
public object JvmFingerprintSource : FingerprintSource {
    override fun collect(productSlug: String): HardwareFingerprint? {
        if (RuntimeFamily.isAndroid) return null
        val raw = LinkedHashMap<String, String>()
        fun put(component: FingerprintComponent, value: String?) {
            if (!value.isNullOrEmpty()) raw[component.wire] = value
        }
        when (RuntimeFamily.platformToken) {
            "Linux" -> {
                val files = LINUX_ANCHOR_PATHS.associateWith { path ->
                    try {
                        File(path).takeIf { it.canRead() }?.readText()
                    } catch (e: Exception) {
                        null
                    }
                }
                put(FingerprintComponent.machineUuid, Fingerprint.linuxAnchorSource(files)?.value)
            }
            "macOS" -> {
                val out = run(listOf("/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"), null, 5_000)
                val uuid = out?.lineSequence()?.firstOrNull { it.contains("\"IOPlatformUUID\"") }
                    ?.substringAfter('=')?.trim()?.trim('"')
                put(FingerprintComponent.machineUuid, uuid)
            }
            "Windows" -> {
                val cmd = Fingerprint.WINDOWS_CIM_COMMAND
                val parsed = Fingerprint.parseWindowsCim(run(listOf(cmd.program) + cmd.args, cmd.stdin, cmd.timeoutMs))
                put(FingerprintComponent.boardSerial, parsed["boardSerial"])
                put(FingerprintComponent.machineModel, parsed["machineModel"])
            }
        }
        put(FingerprintComponent.ramBucket, physicalMemoryBytes()?.let { Fingerprint.ramBucket(it) })
        if (raw.isEmpty()) return null
        return Fingerprint.hashComponents(productSlug, raw)
    }

    /** Run [command] with [stdin], reading stdout on a helper thread so the deadline holds. */
    private fun run(command: List<String>, stdin: String?, timeoutMs: Long): String? = try {
        val process = ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.DISCARD).start()
        var text: String? = null
        val reader = Thread { text = process.inputStream.bufferedReader(Charsets.UTF_8).readText() }
        reader.isDaemon = true
        reader.start()
        process.outputStream.use { out -> stdin?.let { out.write(it.toByteArray(Charsets.UTF_8)) } }
        if (!process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
            process.destroyForcibly()
            null
        } else {
            reader.join(timeoutMs)
            if (process.exitValue() == 0) text else null
        }
    } catch (e: Exception) {
        null
    }
}

/**
 * Total physical memory through the JDK's management bean, or null where it is not exposed. A JVM-only
 * probe (SP-50): `java.lang.management` does not exist on Android, so it is reached by reflection
 * and never linked (R8 refused a minified app that referenced it), and Android answers null here
 * (its RAM bucket is :android's).
 */
internal fun physicalMemoryBytes(): Long? = if (RuntimeFamily.isAndroid) null else try {
    val bean = Class.forName("java.lang.management.ManagementFactory").getMethod("getOperatingSystemMXBean").invoke(null)
    val api = Class.forName("com.sun.management.OperatingSystemMXBean")
    if (!api.isInstance(bean)) {
        null
    } else {
        val method = api.methods.firstOrNull { it.name == "getTotalMemorySize" && it.parameterCount == 0 }
            ?: api.methods.firstOrNull { it.name == "getTotalPhysicalMemorySize" && it.parameterCount == 0 }
        (method?.invoke(bean) as? Long)?.takeIf { it > 0 }
    }
} catch (e: Throwable) {
    null
}
