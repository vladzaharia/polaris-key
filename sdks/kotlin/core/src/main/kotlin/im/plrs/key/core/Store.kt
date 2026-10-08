// The persistence surface Core depends on — wire contract v3 §4.1 and the store contract of
// client-core's CacheRecordV3.
//
// The cache record holds SIGNED ARTIFACTS ONLY (the trust manifest and each document as compact
// JWS, verbatim) plus two unsigned hints that can only tighten the gate. Every counter Core uses
// (anti-replay floors, the clock floor, lastVerifiedAt) is DERIVED by re-verifying the record on
// load, never read from it. A record whose `v` is not CACHE_RECORD_VERSION is discarded.
//
// Two implementations here: `InMemoryStore` (tests, ephemeral hosts) and `FileStore` (the token,
// device id and cache in 0600 files under a 0700 directory). The Android Keystore store is the
// :android module's (P6-12). On a JVM desktop there is no OS keyring without a native library, so
// `FileStore.status()` reports `file` with `keyring-unavailable`, and `supports(core.store)`
// answers `dependency` there (the registry's jvm N/A).

package im.plrs.key.core

import java.io.File
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The wire-v4 update slices Core holds (`CoreContext.updateSlices`). */
public data class UpdateSlices(val feeds: Map<String, String>, val releaseRecords: Map<String, String>)

/** Set by a bundle import (§7). */
public data class ImportedBundle(val bundleId: String, val importedAt: Long)

/** The unsigned 403 hint, as stored. */
public data class BlockInfoRecord(val reason: BlockReason, val allowedRange: AllowedRange? = null)

/** The on-disk cache record (v3). */
public data class CacheRecord(
    val trustJws: String? = null,
    val docs: Map<DocumentSlice, String> = emptyMap(),
    val etags: Map<DocumentSlice, String> = emptyMap(),
    val importedBundle: ImportedBundle? = null,
    val lastSyncUnauthorized: Boolean? = null,
    val blocked: BlockInfoRecord? = null,
    /** Wire v4: the committed channel feeds, keyed by canonical channel. */
    val feeds: Map<String, String> = emptyMap(),
    /** Wire v4: release records by lowercase hex SHA-256, kept while a feed pins one. */
    val releaseRecords: Map<String, String> = emptyMap(),
    val v: Int = CACHE_RECORD_VERSION,
) {
    /** The record as the JSON every SDK writes (`{"docs":{"license":"…"}}`, §4.1). */
    public fun toJson(): JsonObject = buildJsonObject {
        put("v", jsonInt(v.toLong()))
        trustJws?.let { put("trustJws", it) }
        put("docs", JsonObject(docs.entries.associate { it.key.wire to JsonPrimitive(it.value) }))
        put("etags", JsonObject(etags.entries.associate { it.key.wire to JsonPrimitive(it.value) }))
        importedBundle?.let {
            put("importedBundle", buildJsonObject {
                put("bundleId", it.bundleId)
                put("importedAt", jsonInt(it.importedAt))
            })
        }
        lastSyncUnauthorized?.let { put("lastSyncUnauthorized", it) }
        blocked?.let { b ->
            put("blocked", buildJsonObject {
                put("reason", b.reason.wire)
                b.allowedRange?.let { r ->
                    put("allowedRange", buildJsonObject {
                        r.min?.let { put("min", it) }
                        r.max?.let { put("max", it) }
                    })
                }
            })
        }
        put("feeds", JsonObject(feeds.mapValues { JsonPrimitive(it.value) }))
        put("releaseRecords", JsonObject(releaseRecords.mapValues { JsonPrimitive(it.value) }))
    }

    public companion object {
        private fun slices(e: JsonElement?): Map<DocumentSlice, String> =
            e.objectValue?.entries?.mapNotNull { (k, v) ->
                val slice = DocumentSlice.of(k) ?: return@mapNotNull null
                v.stringValue?.let { slice to it }
            }?.toMap() ?: emptyMap()

        private fun strings(e: JsonElement?): Map<String, String> =
            e.objectValue?.entries?.mapNotNull { (k, v) -> v.stringValue?.let { k to it } }?.toMap() ?: emptyMap()

        /** Decode a stored record; null when it is not one (which Core treats as no cache). */
        public fun fromJson(e: JsonElement?): CacheRecord? {
            val o = e.objectValue ?: return null
            val v = o["v"].longValue ?: return null
            val blocked = o["blocked"].objectValue?.let { b ->
                val reason = BlockReason.of(b["reason"].stringValue) ?: return@let null
                val range = b["allowedRange"].objectValue?.let { AllowedRange(it["min"].stringValue, it["max"].stringValue) }
                BlockInfoRecord(reason, range)
            }
            val imported = o["importedBundle"].objectValue?.let { b ->
                val id = b["bundleId"].stringValue ?: return@let null
                ImportedBundle(id, b["importedAt"].longValue ?: return@let null)
            }
            return CacheRecord(
                trustJws = o["trustJws"].stringValue,
                docs = slices(o["docs"]),
                etags = slices(o["etags"]),
                importedBundle = imported,
                lastSyncUnauthorized = o["lastSyncUnauthorized"].boolValue,
                blocked = blocked,
                feeds = strings(o["feeds"]),
                releaseRecords = strings(o["releaseRecords"]),
                v = if (v in Int.MIN_VALUE..Int.MAX_VALUE) v.toInt() else -1,
            )
        }
    }
}

/** Where the token lives, and why if that is weaker than this platform's best option (P1b-09). */
public data class StoreStatus(
    /** One of `STORE_BACKEND_VALUES`. */
    val backend: String,
    val degraded: Degraded? = null,
) {
    public data class Degraded(
        /** One of `STORE_DEGRADED_REASON_VALUES`. */
        val reason: String,
        val detail: String? = null,
    )
}

/** A persistence failure the host can act on; never swallowed (R4-12). */
public class StoreException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** The persistence surface Core depends on. */
public interface Store {
    public suspend fun getToken(): String?

    public suspend fun setToken(token: String)

    public suspend fun clearToken()

    public suspend fun getDeviceId(): String

    /** A missing, unreadable or unparseable cache is "no cache", never an error (fail closed). */
    public suspend fun readCache(): CacheRecord?

    public suspend fun writeCache(record: CacheRecord)

    public suspend fun clearCache()

    /** Where the token lives now; null when the store does not report. Never throws. */
    public suspend fun status(): StoreStatus? = null

    /**
     * A private directory for the SDK's own UNSIGNED state beside the token (the update-event
     * journal, local config overrides, boot-guard slots); null keeps that state in memory.
     */
    public val stateDirectory: File? get() = null

    /**
     * Whether these calls block on I/O (SP-50). Core calls a blocking store on `Dispatchers.IO`, so
     * a host's own store needs no dispatcher of its own; a memory-only store answers false and is
     * called in place.
     */
    public val blocking: Boolean get() = true
}

/** In-memory store: nothing survives the process. */
public class InMemoryStore(productSlug: String = "test", deviceId: String? = null) : Store {
    private val lock = Mutex()
    private var token: String? = null
    private var cache: CacheRecord? = null
    private val deviceIdValue: String = deviceId ?: DeviceId.derive(productSlug)

    override suspend fun getToken(): String? = lock.withLock { token }

    override suspend fun setToken(token: String): Unit = lock.withLock { this.token = token }

    override suspend fun clearToken(): Unit = lock.withLock { token = null }

    override suspend fun getDeviceId(): String = deviceIdValue

    override suspend fun readCache(): CacheRecord? = lock.withLock { cache }

    override suspend fun writeCache(record: CacheRecord): Unit = lock.withLock { cache = record }

    override suspend fun clearCache(): Unit = lock.withLock { cache = null }

    override suspend fun status(): StoreStatus = StoreStatus(StoreBackend.memory, StoreStatus.Degraded(StoreDegradedReason.notPersistent))

    /** Memory only: Core calls it in place. */
    override val blocking: Boolean get() = false
}

/**
 * The token, device id and cache as 0600 files in `<directory>` (created 0700). Writes are atomic
 * (a temporary file renamed over the target) and never follow a symlink at the target.
 */
public class FileStore(public val productSlug: String, public val directory: File) : Store {
    override val stateDirectory: File get() = directory
    private val lock = Mutex()

    /** The store's lock, on `Dispatchers.IO`: every file (and keyring) access is main-safe (SP-50). */
    private suspend inline fun <T> locked(crossinline block: suspend () -> T): T =
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { lock.withLock { block() } }
    private val tokenFile = File(directory, "token")
    private val deviceFile = File(directory, "device-id")
    private val cacheFile = File(directory, "cache.json")

    override suspend fun getToken(): String? = locked { read(tokenFile)?.trim()?.ifEmpty { null } }

    override suspend fun setToken(token: String): Unit = locked { write(tokenFile, token) }

    override suspend fun clearToken(): Unit = locked { delete(tokenFile) }

    override suspend fun getDeviceId(): String = locked {
        read(deviceFile)?.trim()?.takeIf { it.isNotEmpty() }?.let { return@locked it }
        val id = DeviceId.derive(productSlug)
        write(deviceFile, id)
        id
    }

    override suspend fun readCache(): CacheRecord? = locked {
        val text = try {
            read(cacheFile)
        } catch (e: StoreException) {
            null
        } ?: return@locked null
        CacheRecord.fromJson(JsonText.parseOrNull(text))
    }

    override suspend fun writeCache(record: CacheRecord): Unit = locked { write(cacheFile, record.toJson().toString()) }

    override suspend fun clearCache(): Unit = locked { delete(cacheFile) }

    override suspend fun status(): StoreStatus =
        StoreStatus(
            StoreBackend.file,
            StoreStatus.Degraded(StoreDegradedReason.keyringUnavailable, "no OS keyring is reachable from this process"),
        )

    private fun read(file: File): String? {
        if (!file.exists()) return null
        if (Files.isSymbolicLink(file.toPath())) throw StoreException("refusing to read through a symlink: $file")
        return try {
            file.readText(Charsets.UTF_8)
        } catch (e: IOException) {
            throw StoreException("could not read $file", e)
        }
    }

    private fun ensureDirectory() {
        if (directory.isDirectory) return
        if (!directory.mkdirs() && !directory.isDirectory) throw StoreException("could not create $directory")
        restrict(directory, "rwx------")
    }

    private fun restrict(file: File, mode: String) {
        try {
            Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString(mode))
        } catch (e: UnsupportedOperationException) {
            // Not a POSIX file system (Windows): the user profile's ACL applies.
            file.setReadable(false, false)
            file.setReadable(true, true)
            file.setWritable(false, false)
            file.setWritable(true, true)
        } catch (e: IOException) {
            throw StoreException("could not restrict $file", e)
        }
    }

    private fun write(file: File, text: String) {
        ensureDirectory()
        if (Files.isSymbolicLink(file.toPath())) throw StoreException("refusing to write through a symlink: $file")
        val tmp = File(directory, ".${file.name}.${UUID.randomUUID()}.tmp")
        try {
            Files.newOutputStream(tmp.toPath()).use { it.write(text.toByteArray(Charsets.UTF_8)) }
            restrict(tmp, "rw-------")
            try {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (e: AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (e: IOException) {
            tmp.delete()
            throw StoreException("could not write $file", e)
        }
    }

    private fun delete(file: File) {
        try {
            Files.deleteIfExists(file.toPath())
        } catch (e: IOException) {
            throw StoreException("could not delete $file", e)
        }
    }

    public companion object {
        /**
         * `<base>/polaris-key/<product>`: base is `$XDG_STATE_HOME`, `%LOCALAPPDATA%` or `~`-relative.
         * Throws `invalid-options` when the base would be `~`-relative and there is no home directory
         * (`user.home` empty, as on Android): never a directory under `/` (SP-50).
         */
        public fun defaultDirectory(
            productSlug: String,
            home: String = System.getProperty("user.home").orEmpty(),
            os: String = System.getProperty("os.name").orEmpty(),
            env: (String) -> String? = System::getenv,
        ): File {
            fun fromHome(path: String): File {
                if (home.isBlank() || home == "?") {
                    throw PolarisException(
                        ErrorCode.invalidOptions,
                        "There is no home directory to keep the device token in (user.home is empty): pass CoreOptions.store, " +
                            "or a data directory (PolarisKeyDesktop's DesktopOptions.dataDirectory).",
                    )
                }
                return File(home, path)
            }
            val base = when {
                os.startsWith("Windows", true) -> env("LOCALAPPDATA")?.takeIf { it.isNotEmpty() }?.let(::File) ?: fromHome("AppData/Local")
                os.startsWith("Mac", true) -> fromHome("Library/Application Support")
                else -> env("XDG_STATE_HOME")?.takeIf { it.isNotEmpty() }?.let(::File) ?: fromHome(".local/state")
            }
            return File(File(base, "polaris-key"), productSlug)
        }
    }
}

/**
 * The stable, hashed device id: SHA-256 of `pkey-device:<product>:<raw>`, base64url, first 32
 * characters (`fingerprint.json#/deviceIds`). The raw OS identifier never leaves the device.
 */
public object DeviceId {
    /** The formula itself, pinned by the corpus. */
    public fun fromRaw(productSlug: String, raw: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("pkey-device:$productSlug:$raw".toByteArray(Charsets.UTF_8))
        return Base64Url.encode(digest).take(32)
    }

    /**
     * Derive a device id. The raw source is [raw] when given, else the Linux anchor
     * (`/etc/machine-id`, then `/var/lib/dbus/machine-id`, WIRE-CONTRACT-V3 §6.1 rule 2), else a
     * random UUID that the store persists. Android's app-scoped id is the :android module's (P6-12).
     */
    public fun derive(productSlug: String, raw: String? = null): String {
        val source = raw ?: linuxAnchor() ?: UUID.randomUUID().toString()
        return fromRaw(productSlug, source)
    }

    private fun linuxAnchor(): String? {
        if (RuntimeFamily.isAndroid || !System.getProperty("os.name").orEmpty().startsWith("Linux", true)) return null
        val files = LINUX_ANCHOR_PATHS.associateWith { path ->
            try {
                val f = File(path)
                if (f.isFile && f.canRead()) f.readText() else null
            } catch (e: Exception) {
                null
            }
        }
        return Fingerprint.linuxAnchorSource(files)?.value
    }
}
