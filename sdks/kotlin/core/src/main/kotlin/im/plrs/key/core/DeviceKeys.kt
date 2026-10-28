// The device key port and its store (CC-26.5; plans/CC-01.md R-5): custody of one device's Ed25519
// signing key and X25519 agreement key. Keys are made on first need and never leave the port:
// callers get public halves, signatures and shared secrets. Mirrors client-core's `DeviceKeyPort`
// (packages/client-core/src/deviceKeys.ts).
//
// Decision Q12: the keys are software 25519 keys held in storage the platform protects. On a JVM
// desktop that is a 0600 file under a 0700 directory (`FileDeviceKeyStorage`); on Android the same
// file holds the record sealed by an Android Keystore AES-GCM key (`:android`).

package im.plrs.key.core

import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A device's two public keys: raw 32 bytes, canonical base64url (43 characters). */
public data class DevicePublicKeys(
    /** The Ed25519 signing key. */
    val signKey: String,
    /** The X25519 agreement key. */
    val agreeKey: String,
    /** The local generation: 1 for the first pair, plus one on every [DeviceKeyPort.rotate]. Not the server's `keySeq`. */
    val generation: Int,
)

/** Where the keys live: [durable] survives a restart, [memory] dies with the process. */
public enum class DeviceKeyPersistence { durable, memory }

/** Custody of one device's signing (Ed25519) and agreement (X25519) keys. */
public interface DeviceKeyPort {
    /** The public keys, making the key pair first if the store holds none. */
    public suspend fun ensure(): DevicePublicKeys

    /** The public keys, or null when the store holds none. Never makes keys. */
    public suspend fun publicKeys(): DevicePublicKeys?

    /** The 64-byte Ed25519 signature by the signing key over [message]. Throws when the store holds no keys. */
    public suspend fun sign(message: ByteArray): ByteArray

    /** X25519 with the agreement key and a peer's raw public key; null when the peer key is refused or there are no keys. */
    public suspend fun dh(peerPublic: ByteArray): ByteArray?

    /** Replaces both keys with a new pair and returns it (`generation` + 1). */
    public suspend fun rotate(): DevicePublicKeys

    /** Where the keys live. A [DeviceKeyPersistence.memory] port must not register keys. */
    public suspend fun persistence(): DeviceKeyPersistence = DeviceKeyPersistence.durable

    /** Deletes both keys. The next [ensure] makes a new pair, with `generation` starting again. */
    public suspend fun wipe()
}

/** Holds the one sealed-or-plain record of a [DeviceKeyStore]. Implementations must make [putIfAbsent] atomic. */
public interface DeviceKeyStorage {
    public val persistence: DeviceKeyPersistence

    public suspend fun get(): ByteArray?

    /** Writes [bytes] only when no record exists; false when one does. Safe across processes where the storage is shared. */
    public suspend fun putIfAbsent(bytes: ByteArray): Boolean

    /** Writes [bytes], replacing any record. */
    public suspend fun put(bytes: ByteArray)

    /** Deletes the record so it cannot be read back. */
    public suspend fun clear()
}

/** Process memory only: the keys die with the process. */
public class InMemoryDeviceKeyStorage : DeviceKeyStorage {
    private val lock = Mutex()
    private var record: ByteArray? = null
    override val persistence: DeviceKeyPersistence = DeviceKeyPersistence.memory

    override suspend fun get(): ByteArray? = lock.withLock { record?.copyOf() }

    override suspend fun putIfAbsent(bytes: ByteArray): Boolean = lock.withLock {
        if (record != null) return@withLock false
        record = bytes.copyOf()
        true
    }

    override suspend fun put(bytes: ByteArray): Unit = lock.withLock { record?.fill(0); record = bytes.copyOf() }

    override suspend fun clear(): Unit = lock.withLock { record?.fill(0); record = null }
}

/**
 * Wraps the record before it reaches the disk (the Android Keystore's AES-GCM key). [open] answers
 * null only for a blob that can never be opened (wrong or destroyed key, tampered, wrong [context]):
 * the store then treats the record as unusable and replaces it. A failure that may pass (the
 * Keystore is busy or unavailable) must throw instead, so a glitch never costs the keys.
 */
public interface DeviceKeySealer {
    public fun seal(plain: ByteArray, context: ByteArray): ByteArray

    public fun open(blob: ByteArray, context: ByteArray): ByteArray?

    /** Destroys the wrapping key, so a copy of the sealed file can never be opened again. */
    public fun destroy()
}

/**
 * The record in one file. Persistence: durable, until [clear], the user deleting the file, or (with
 * a [sealer]) the wrapping key being lost. The file is created `rw-------` in a `rwx------`
 * directory (on a file system without POSIX permissions the owner-only flags are the best the JDK
 * offers and the user profile's ACL applies), written to a temporary file of the same mode and
 * moved into place, so it is never visible with a wider mode or half written. A cross-process lock
 * file makes [putIfAbsent] atomic between processes. A symlink in the way is refused.
 *
 * [clear] overwrites the bytes with zeros, deletes the file and tells the [sealer] to destroy its
 * key. Overwriting is best effort (a log-structured disk may keep old blocks); with a sealer the
 * destroyed key is what makes a stale copy unreadable.
 */
public class FileDeviceKeyStorage(
    private val file: File,
    private val sealer: DeviceKeySealer? = null,
    /** Binds a sealed blob to this use (the AAD): a blob moved to another product or purpose fails to open. */
    private val sealContext: ByteArray = "pkey-device-keys/1".toByteArray(Charsets.UTF_8),
) : DeviceKeyStorage {
    override val persistence: DeviceKeyPersistence = DeviceKeyPersistence.durable

    private val dir: File get() = file.absoluteFile.parentFile ?: File(".")
    private val lockFile: File get() = File(dir, ".${file.name}.lock")
    private val mutex: Mutex = MUTEXES.computeIfAbsent(file.absoluteFile.normalize().path) { Mutex() }

    private suspend inline fun <T> locked(crossinline block: () -> T): T =
        withContext(Dispatchers.IO) { mutex.withLock { withFileLock { block() } } }

    private inline fun <T> withFileLock(block: () -> T): T {
        ensureDirectory()
        refuseSymlink(lockFile)
        val opts = arrayOf(StandardOpenOption.CREATE, StandardOpenOption.WRITE)
        val channel = try {
            if (posix) {
                FileChannel.open(lockFile.toPath(), setOf(*opts), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
            } else {
                FileChannel.open(lockFile.toPath(), *opts)
            }
        } catch (e: IOException) {
            throw StoreException("could not open $lockFile", e)
        }
        return channel.use { ch ->
            ch.lock().use { block() }
        }
    }

    override suspend fun get(): ByteArray? = locked { read() }

    override suspend fun putIfAbsent(bytes: ByteArray): Boolean = locked {
        if (file.exists()) return@locked false
        write(bytes)
        true
    }

    override suspend fun put(bytes: ByteArray): Unit = locked { write(bytes) }

    override suspend fun clear(): Unit = locked {
        refuseSymlink(file)
        try {
            if (file.exists()) {
                val n = file.length()
                if (n in 1..MAX_BYTES) {
                    FileChannel.open(file.toPath(), StandardOpenOption.WRITE).use { ch ->
                        ch.write(java.nio.ByteBuffer.wrap(ByteArray(n.toInt())))
                        ch.force(true)
                    }
                }
            }
            Files.deleteIfExists(file.toPath())
            dir.listFiles { f -> f.name.startsWith(".${file.name}.") && f.name.endsWith(".tmp") }?.forEach { it.delete() }
        } catch (e: IOException) {
            throw StoreException("could not delete $file", e)
        } finally {
            sealer?.destroy()
        }
    }

    private fun read(): ByteArray? {
        refuseSymlink(file)
        if (!file.exists()) return null
        val raw = try {
            if (file.length() > MAX_BYTES) return null
            file.readBytes()
        } catch (e: IOException) {
            throw StoreException("could not read $file", e)
        }
        return if (sealer == null) raw else sealer.open(raw, sealContext)
    }

    private fun write(plain: ByteArray) {
        ensureDirectory()
        refuseSymlink(file)
        val bytes = sealer?.seal(plain, sealContext) ?: plain
        val tmp = File(dir, ".${file.name}.${UUID.randomUUID()}.tmp")
        try {
            if (posix) {
                Files.createFile(tmp.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
            } else {
                Files.createFile(tmp.toPath())
                ownerOnly(tmp)
            }
            FileChannel.open(tmp.toPath(), StandardOpenOption.WRITE).use { ch ->
                ch.write(java.nio.ByteBuffer.wrap(bytes))
                ch.force(true)
            }
            try {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (e: AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (e: IOException) {
            tmp.delete()
            throw StoreException("could not write $file", e)
        } finally {
            if (sealer != null) bytes.fill(0)
        }
    }

    private fun ensureDirectory() {
        refuseSymlink(dir)
        if (dir.isDirectory) return
        if (!dir.mkdirs() && !dir.isDirectory) throw StoreException("could not create $dir")
        try {
            if (posix) Files.setPosixFilePermissions(dir.toPath(), PosixFilePermissions.fromString("rwx------")) else ownerOnly(dir)
        } catch (e: IOException) {
            throw StoreException("could not restrict $dir", e)
        }
    }

    private fun refuseSymlink(f: File) {
        if (Files.isSymbolicLink(f.toPath())) throw StoreException("refusing to use a symlink: $f")
    }

    private val posix: Boolean by lazy {
        try {
            java.nio.file.FileSystems.getDefault().supportedFileAttributeViews().contains("posix")
        } catch (e: Exception) {
            false
        }
    }

    private fun ownerOnly(f: File) {
        f.setReadable(false, false)
        f.setReadable(true, true)
        f.setWritable(false, false)
        f.setWritable(true, true)
        if (f.isDirectory) {
            f.setExecutable(false, false)
            f.setExecutable(true, true)
        }
    }

    private companion object {
        const val MAX_BYTES = 64L * 1024
        val MUTEXES = ConcurrentHashMap<String, Mutex>()
    }
}

/**
 * The key store: generation, rotation and wipe over a [DeviceKeyStorage], with the private halves
 * held only for the length of one operation.
 *
 * The record is JSON `{"v":1,"generation":n,"sign":{"seed","pub"},"agree":{"priv","pub"}}`, every
 * key canonical base64url. A record that does not parse, or whose public halves do not match its
 * private halves, is unusable: [publicKeys] answers null and [ensure] replaces it.
 */
public class DeviceKeyStore(
    private val storage: DeviceKeyStorage,
    private val curves: () -> DeviceCurves = { DeviceCurvesSelection.curves },
) : DeviceKeyPort {
    private val lock = Mutex()

    private class Record(val generation: Int, val seed: ByteArray, val signPub: ByteArray, val agreePriv: ByteArray, val agreePub: ByteArray) {
        fun public(): DevicePublicKeys =
            DevicePublicKeys(Base64Url.encode(signPub), Base64Url.encode(agreePub), generation)

        fun zero() {
            seed.fill(0)
            agreePriv.fill(0)
        }
    }

    override suspend fun persistence(): DeviceKeyPersistence = storage.persistence

    override suspend fun publicKeys(): DevicePublicKeys? = lock.withLock { load()?.let { r -> r.public().also { r.zero() } } }

    override suspend fun ensure(): DevicePublicKeys = lock.withLock {
        load()?.let { r -> return@withLock r.public().also { r.zero() } }
        val fresh = generate(1)
        val bytes = encode(fresh)
        try {
            val raw = storage.get()
            if (raw == null && storage.putIfAbsent(bytes)) return@withLock fresh.public()
            // Another process made a pair first, or the stored one is unusable.
            load()?.let { r -> return@withLock r.public().also { r.zero() } }
            storage.put(bytes)
            fresh.public()
        } finally {
            bytes.fill(0)
            fresh.zero()
        }
    }

    override suspend fun sign(message: ByteArray): ByteArray = lock.withLock {
        val r = load() ?: throw IllegalStateException("device keys: none yet")
        try {
            curves().ed25519Sign(r.seed, message)
        } finally {
            r.zero()
        }
    }

    override suspend fun dh(peerPublic: ByteArray): ByteArray? = lock.withLock {
        if (peerPublic.size != 32 || X25519Points.isLowOrder(peerPublic)) return@withLock null
        val r = load() ?: return@withLock null
        try {
            val secret = curves().x25519(r.agreePriv, peerPublic) ?: return@withLock null
            if (secret.all { it.toInt() == 0 }) null else secret
        } finally {
            r.zero()
        }
    }

    override suspend fun rotate(): DevicePublicKeys = lock.withLock {
        val prev = load()
        val gen = (prev?.generation ?: 0) + 1
        prev?.zero()
        val fresh = generate(gen)
        val bytes = encode(fresh)
        try {
            storage.put(bytes)
            fresh.public()
        } finally {
            bytes.fill(0)
            fresh.zero()
        }
    }

    override suspend fun wipe(): Unit = lock.withLock { storage.clear() }

    private fun generate(generation: Int): Record {
        val c = curves()
        val ed = c.ed25519Generate()
        val priv = DeviceCurvesSelection.randomBytes(32)
        val pub = c.x25519(priv, X25519Points.BASE)
        if (pub == null || X25519Points.isLowOrder(pub)) {
            priv.fill(0)
            ed.seed.fill(0)
            throw DeviceKeyUnsupportedException("no X25519 here")
        }
        return Record(generation, ed.seed, ed.publicKey, priv, pub)
    }

    private fun encode(r: Record): ByteArray {
        val seed = Base64Url.encode(r.seed)
        val priv = Base64Url.encode(r.agreePriv)
        val json = buildJsonObject {
            put("v", 1)
            put("generation", r.generation)
            put("sign", buildJsonObject { put("seed", seed); put("pub", Base64Url.encode(r.signPub)) })
            put("agree", buildJsonObject { put("priv", priv); put("pub", Base64Url.encode(r.agreePub)) })
        }
        return json.toString().toByteArray(Charsets.UTF_8)
    }

    /** The stored record, or null when there is none or it cannot be used. */
    private suspend fun load(): Record? {
        val raw = storage.get() ?: return null
        try {
            val o = JsonText.parseOrNull(String(raw, Charsets.UTF_8)) as? JsonObject ?: return null
            if (o["v"]?.let { (it as? JsonPrimitive)?.content } != "1") return null
            val gen = (o["generation"] as? JsonPrimitive)?.content?.toIntOrNull()?.takeIf { it >= 1 } ?: return null
            val sign = o["sign"] as? JsonObject ?: return null
            val agree = o["agree"] as? JsonObject ?: return null
            fun field(p: JsonObject, k: String): ByteArray? =
                (p[k] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { Base64Url.decodeStrict(it) }?.takeIf { it.size == 32 }
            val seed = field(sign, "seed") ?: return null
            val signPub = field(sign, "pub") ?: return null
            val agreePriv = field(agree, "priv") ?: return null
            val agreePub = field(agree, "pub") ?: return null
            val rec = Record(gen, seed, signPub, agreePriv, agreePub)
            if (!consistent(rec)) {
                rec.zero()
                return null
            }
            return rec
        } finally {
            raw.fill(0)
        }
    }

    /** The public halves belong to the private halves: one agreement and one signature, both checked. */
    private fun consistent(r: Record): Boolean = try {
        val c = curves()
        val derived = c.x25519(r.agreePriv, X25519Points.BASE)
        val probe = byteArrayOf(0x70, 0x6b, 0x65, 0x79)
        derived != null && derived.contentEquals(r.agreePub) &&
            Ed25519.verifier.verify(r.signPub, probe, c.ed25519Sign(r.seed, probe))
    } catch (e: Exception) {
        false
    }
}
