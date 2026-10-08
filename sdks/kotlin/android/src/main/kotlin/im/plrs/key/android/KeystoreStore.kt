// core.store on Android (P6-12): the Store :core defines, over :platform's SecureStore.
//
// The token and the device id are wrapped by one AndroidKeyStore AES-256-GCM key per product (alias
// `pkey:<product>:device`, StrongBox where the device has it, else the TEE; accounts `token` and
// `device`, blobs in `noBackupFilesDir/pkey/<product>/keystore/`, never backed up). The verified
// cache is a plain file under `noBackupFilesDir/pkey/<product>/` (`cache.json`): it holds signed
// artifacts only and is re-verified at every load, so it needs no secrecy. The device id is ALSO
// kept in a plain file (`device-id`, a hashed public value sent on every request), so a Keystore
// fault or a lost key never mints a new device per launch.
//
// The semantics are those of Godot's PKeyKeystoreStore (P5-06) and Swift's KeychainStore:
//
//   migration   a token or device id found only in a legacy store (a FileStore an earlier build
//               used) is moved into the Keystore on first read; the token file is then removed, and
//               a failed removal is retried on every read until no plaintext copy remains
//   failures    never swallowed: a failed Keystore call throws StoreException from the token calls
//               and makes status() report `degraded: keyring-error` until a Keystore call succeeds;
//               the token is never written to a file instead (no silent downgrade)
//   lost key    when the key is gone or permanently invalidated (a lock-screen reset can do it), its
//               values are dropped: the token reads as absent (the device activates again),
//               [lastReset] says why, and the device id comes back from the device file
//
// Plain java.io only (no java.nio.file): this module runs on API 24.

package im.plrs.key.android

import android.content.Context
import im.plrs.key.core.CacheRecord
import im.plrs.key.core.JsonText
import im.plrs.key.core.Store
import im.plrs.key.core.StoreBackend
import im.plrs.key.core.StoreDegradedReason
import im.plrs.key.core.StoreException
import im.plrs.key.core.StoreStatus
import im.plrs.key.platform.SecureStore
import im.plrs.key.platform.SecureStoreException
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** The Android store: the Keystore for the token and device id, files for the cache. */
public class AndroidKeystoreStore(
    public val productSlug: String,
    private val keystore: SecureStore,
    /**
     * `noBackupFilesDir/pkey/<product>`: the cache and the device-id file. Resolved on first use, so
     * building the store (and the client) on the main thread touches no file (SP-50).
     */
    directory: () -> File,
    /** Where the raw device identifier comes from when no id is stored yet. */
    private val deviceIdSource: () -> String,
    /** A store an earlier build used; its token and device id move into the Keystore. */
    private val legacy: Store? = null,
) : Store {
    public constructor(
        productSlug: String,
        keystore: SecureStore,
        directory: File,
        deviceIdSource: () -> String,
        legacy: Store? = null,
    ) : this(productSlug, keystore, { directory }, deviceIdSource, legacy)

    /** The store for [productSlug] in [context]: AndroidKeyStore, `noBackupFilesDir`, [AndroidDevice.deviceIdRaw]. */
    public constructor(context: Context, productSlug: String, legacy: Store? = null) : this(
        productSlug,
        SecureStore(context, productSlug),
        { File(context.noBackupFilesDir, "pkey/${SecureStore.checkName(productSlug)}") },
        { deviceIdRaw(SystemAndroidDevice(context), SecureStore(context, productSlug)) },
        legacy,
    )

    /** `noBackupFilesDir/pkey/<product>` (see the constructor). */
    public val directory: File by lazy(directory)

    /** The SDK's unsigned state (the update-event journal, local config) lives beside the cache. */
    override val stateDirectory: File get() = directory

    private val lock = Mutex()
    private val cacheFile by lazy { File(this.directory, "cache.json") }
    private val deviceFile by lazy { File(this.directory, "device-id") }

    @Volatile private var keystoreError: String? = null

    @Volatile private var deviceId: String? = null

    /** The last time a read found the key lost (`key-missing`, `key-invalidated`); null when never. */
    @Volatile public var lastReset: String? = null
        private set

    override suspend fun getToken(): String? = io {
        val r = keystoreGet(TOKEN, "read")
        if (r != null) {
            // A migration whose file delete failed: retried on every read until it succeeds.
            removeLegacyToken()
            return@io r
        }
        val old = legacy?.getToken()?.takeIf { it.isNotEmpty() } ?: return@io null
        keystorePut(TOKEN, old, "write")
        removeLegacyToken()
        old
    }

    override suspend fun setToken(token: String): Unit = io { keystorePut(TOKEN, token, "write") }

    override suspend fun clearToken(): Unit = io {
        try {
            keystore.delete(TOKEN)
            keystoreError = null
        } catch (e: SecureStoreException) {
            throw fail("remove", TOKEN, e)
        }
        legacy?.clearToken()
    }

    /**
     * The Keystore's id; else the device file's or the legacy store's (moved into the Keystore); else
     * one derived from [deviceIdSource] and stored. Write-once.
     */
    override suspend fun getDeviceId(): String = io {
        deviceId?.let { return@io it }
        var keystoreUsable = true
        val stored = try {
            val r = keystore.get(DEVICE)
            r.reset?.let { lastReset = it }
            keystoreError = null
            r.value
        } catch (e: SecureStoreException) {
            keystoreUsable = false
            keystoreError = describe("read", DEVICE, e)
            null
        }
        if (stored != null && DEVICE_ID.matches(stored)) {
            writeIfAbsent(deviceFile, stored)
            return@io stored.also { deviceId = it }
        }
        val id = readText(deviceFile)?.trim()?.takeIf { DEVICE_ID.matches(it) }
            ?: legacy?.getDeviceId()?.trim()?.takeIf { DEVICE_ID.matches(it) }
            ?: im.plrs.key.core.DeviceId.fromRaw(productSlug, deviceIdSource())
        writeIfAbsent(deviceFile, id)
        if (keystoreUsable && stored != id) {
            try {
                keystore.put(DEVICE, id)
            } catch (e: SecureStoreException) {
                keystoreError = describe("write", DEVICE, e)
            }
        }
        id.also { deviceId = it }
    }

    override suspend fun readCache(): CacheRecord? = io {
        val text = try {
            readText(cacheFile)
        } catch (e: StoreException) {
            null
        } ?: return@io null
        CacheRecord.fromJson(JsonText.parseOrNull(text))
    }

    override suspend fun writeCache(record: CacheRecord): Unit = io { writeAtomically(cacheFile, record.toJson().toString()) }

    override suspend fun clearCache(): Unit = io {
        if (cacheFile.exists() && !cacheFile.delete()) throw StoreException("could not delete $cacheFile")
    }

    override suspend fun status(): StoreStatus =
        StoreStatus(StoreBackend.keystore, keystoreError?.let { StoreStatus.Degraded(StoreDegradedReason.keyringError, it) })

    // ── Internals ───────────────────────────────────────────────────────────────────────────

    private suspend fun <T> io(block: suspend () -> T): T = withContext(Dispatchers.IO) { lock.withLock { block() } }

    private fun keystoreGet(account: String, op: String): String? {
        val r = try {
            keystore.get(account)
        } catch (e: SecureStoreException) {
            throw fail(op, account, e)
        }
        keystoreError = null
        r.reset?.let { lastReset = it }
        return r.value?.takeIf { it.isNotEmpty() }
    }

    private fun keystorePut(account: String, value: String, op: String) {
        try {
            keystore.put(account, value)
        } catch (e: SecureStoreException) {
            throw fail(op, account, e)
        }
        keystoreError = null
    }

    private suspend fun removeLegacyToken() {
        val old = legacy ?: return
        try {
            if (old.getToken() != null) old.clearToken()
        } catch (e: StoreException) {
            keystoreError = "the token was moved into the Keystore but its legacy copy could not be removed (${e.message}); retried on the next read"
        }
    }

    private fun describe(op: String, account: String, e: SecureStoreException): String =
        "Keystore $op of $account failed (${e.reason}): ${e.message}"

    private fun fail(op: String, account: String, e: SecureStoreException): StoreException {
        val detail = describe(op, account, e)
        keystoreError = detail
        return StoreException(detail, e)
    }

    private fun readText(file: File): String? {
        if (!file.exists()) return null
        return try {
            file.readText(Charsets.UTF_8)
        } catch (e: IOException) {
            throw StoreException("could not read $file", e)
        }
    }

    private fun writeIfAbsent(file: File, text: String) {
        if (readText(file)?.trim() == text) return
        writeAtomically(file, text)
    }

    private fun writeAtomically(file: File, text: String) {
        if (!directory.isDirectory && !directory.mkdirs() && !directory.isDirectory) throw StoreException("could not create $directory")
        val tmp = File(directory, ".${file.name}.${UUID.randomUUID()}.tmp")
        try {
            tmp.outputStream().use { out ->
                out.write(text.toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
        } catch (e: IOException) {
            tmp.delete()
            throw StoreException("could not write $file", e)
        }
        if (!tmp.renameTo(file)) {
            tmp.delete()
            throw StoreException("could not replace $file")
        }
    }

    public companion object {
        public const val TOKEN: String = "token"
        public const val DEVICE: String = "device"

        /** A stored device id: 32 base64url characters (`fingerprint.json#/deviceIds`). */
        internal val DEVICE_ID = Regex("^[A-Za-z0-9_-]{32}$")
    }
}
