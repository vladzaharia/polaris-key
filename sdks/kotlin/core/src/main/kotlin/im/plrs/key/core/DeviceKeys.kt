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
import java.io.FileOutputStream
import java.io.RandomAccessFile
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

/**
 * The stored key record exists but cannot be used (it does not parse, its public halves do not match
 * its private halves, or its wrapping key is gone). It is never replaced automatically: replacing it
 * would silently change the device's identity. The only way out is [DeviceKeyPort.wipe] (or an
 * explicit reset by the host), after which [DeviceKeyPort.ensure] makes a new pair.
 */
public class DeviceKeysUnreadableException(message: String) : Exception(message)

/** Holds the one sealed-or-plain record of a [DeviceKeyStore]. Implementations must make [putIfAbsent] atomic. */
public interface DeviceKeyStorage {
    public val persistence: DeviceKeyPersistence

    /** The record, null when there is none. Throws [DeviceKeysUnreadableException] for one that exists but can never be opened. */
    public suspend fun get(): ByteArray?

    /** Writes [bytes] only when no record exists; false when one does. Safe across processes where the storage is shared. */
    public suspend fun putIfAbsent(bytes: ByteArray): Boolean

    /** Writes [bytes], replacing any record. */
    public suspend fun put(bytes: ByteArray)

    /**
     * A read-modify-write that runs entirely under the storage's lock (the file store's cross-process
     * lock): [transform] gets the current record (null when none; throws [DeviceKeysUnreadableException]
     * for one that cannot be opened) and answers the bytes to write, or null to leave the record as it
     * is. True when it wrote. An exception from [transform] writes nothing.
     */
    public suspend fun update(transform: (current: ByteArray?) -> ByteArray?): Boolean

    /** Deletes the record so it cannot be read back. */
    public suspend fun clear()

    /**
     * Deletes the record but leaves any sealer key alone: for a record that shares its sealer with
     * another (Cloud Connect's state beside the device keys). Defaults to [clear].
     */
    public suspend fun deleteRecord(): Unit = clear()
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

    override suspend fun update(transform: (ByteArray?) -> ByteArray?): Boolean = lock.withLock {
        val next = transform(record?.copyOf()) ?: return@withLock false
        record?.fill(0)
        record = next.copyOf()
        true
    }

    override suspend fun clear(): Unit = lock.withLock { record?.fill(0); record = null }
}

/**
 * Wraps the record before it reaches the disk (the Android Keystore's AES-GCM key). [open] answers
 * null only for a blob that can never be opened (wrong or destroyed key, tampered, wrong [context]):
 * the file store then reports [DeviceKeysUnreadableException] and keeps the file. A failure that may pass (the
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
 * a [sealer]) the wrapping key being lost.
 *
 * The directory is made owner-only (`rwx------`), and a temporary file is made and restricted to
 * the owner (`rw-------`) BEFORE any key byte is written to it, then moved into place atomically
 * (and the directory synced where the platform allows): the keys are never visible with a wider mode
 * or half written. On a JVM with `java.nio.file` (not Android) every operation first REFUSES, with a
 * [StoreException], a directory that is not owned by this user or that others may write, and a file
 * that is not owned by this user or that others may read or write. On Android the app-private
 * `noBackupFilesDir` is the protection and the check is skipped; the class uses plain `java.io`
 * there because API 24 has no `java.nio.file`. On a file system without POSIX modes (Windows) the
 * modes are left alone and the user profile's ACL applies. A cross-process lock file makes
 * [putIfAbsent] and [update] atomic between processes. A symlink in place of the file, or a file that
 * is not a regular file, is refused; an unreadable directory is an error, never "no record".
 *
 * [clear] overwrites the bytes with zeros, deletes the file and, only once it is deleted, tells the
 * [sealer] to destroy its key. Overwriting is best effort (a log-structured disk may keep old
 * blocks); with a sealer the destroyed key is what makes a stale copy unreadable.
 */
public class FileDeviceKeyStorage private constructor(
    private val fileSource: Lazy<File>,
    private val sealer: DeviceKeySealer?,
    private val sealContext: ByteArray,
) : DeviceKeyStorage {
    public constructor(
        file: File,
        sealer: DeviceKeySealer? = null,
        /** Binds a sealed blob to this use (the AAD): a blob moved to another product or purpose fails to open. */
        sealContext: ByteArray = "pkey-device-keys/1".toByteArray(Charsets.UTF_8),
    ) : this(lazyOf(file), sealer, sealContext)

    /**
     * A file resolved on first use, which is always on [Dispatchers.IO]: a platform directory lookup
     * (Android's `noBackupFilesDir` touches the disk) never runs on the thread that builds the storage.
     */
    public constructor(
        file: () -> File,
        sealer: DeviceKeySealer? = null,
        sealContext: ByteArray = "pkey-device-keys/1".toByteArray(Charsets.UTF_8),
    ) : this(lazy(LazyThreadSafetyMode.SYNCHRONIZED, file), sealer, sealContext)

    override val persistence: DeviceKeyPersistence = DeviceKeyPersistence.durable

    private val file: File get() = fileSource.value
    private val dir: File get() = file.absoluteFile.parentFile ?: File(".")
    private val lockFile: File get() = File(dir, ".${file.name}.lock")
    private val mutex: Mutex by lazy { MUTEXES.computeIfAbsent(File(dir.canonicalFile, file.name).path) { Mutex() } }
    private val nio: Boolean = !RuntimeFamily.isAndroid && NioFiles.available

    private suspend inline fun <T> locked(crossinline block: () -> T): T =
        withContext(Dispatchers.IO) { mutex.withLock { withFileLock { block() } } }

    private inline fun <T> withFileLock(block: () -> T): T {
        ensureDirectory()
        refuseSymlink(lockFile)
        val existed = exists(lockFile)
        val raf = try {
            RandomAccessFile(lockFile, "rw")
        } catch (e: IOException) {
            throw StoreException("could not open $lockFile", e)
        }
        return raf.use { r ->
            if (!existed) ownerOnly(lockFile)
            r.channel.lock().use {
                if (nio) NioFiles.checkTrusted(dir, file, lockFile)
                block()
            }
        }
    }

    override suspend fun get(): ByteArray? = locked { read() }

    override suspend fun putIfAbsent(bytes: ByteArray): Boolean = locked {
        if (exists(file)) return@locked false
        write(bytes)
        true
    }

    override suspend fun put(bytes: ByteArray): Unit = locked { write(bytes) }

    override suspend fun update(transform: (ByteArray?) -> ByteArray?): Boolean = locked {
        val next = transform(read()) ?: return@locked false
        try {
            write(next)
        } finally {
            next.fill(0)
        }
        true
    }

    override suspend fun clear(): Unit = removeRecord(destroySealer = true)

    override suspend fun deleteRecord(): Unit = removeRecord(destroySealer = false)

    private suspend fun removeRecord(destroySealer: Boolean) {
        locked {
            refuseSymlink(file)
            try {
                if (exists(file)) {
                    val n = file.length()
                    if (n in 1..MAX_BYTES) {
                        RandomAccessFile(file, "rw").use { r ->
                            r.write(ByteArray(n.toInt()))
                            r.fd.sync()
                        }
                    }
                    if (!file.delete() && exists(file)) throw IOException("delete failed")
                }
                sweepTemporaries()
            } catch (e: IOException) {
                throw StoreException("could not delete $file", e)
            }
            // Only a deleted file lets the key go; a failure above leaves the key, so nothing is lost.
            if (destroySealer) sealer?.destroy()
        }
    }

    private fun read(): ByteArray? {
        refuseSymlink(file)
        if (!exists(file)) return null
        val raw = try {
            if (file.length() > MAX_BYTES) throw DeviceKeysUnreadableException("device keys: the record is not one of ours")
            file.readBytes()
        } catch (e: IOException) {
            throw StoreException("could not read $file", e)
        }
        return if (sealer == null) raw else sealer.open(raw, sealContext)
            ?: throw DeviceKeysUnreadableException("device keys: the record cannot be opened")
    }

    private fun write(plain: ByteArray) {
        ensureDirectory()
        refuseSymlink(file)
        sweepTemporaries()
        val bytes = sealer?.seal(plain, sealContext) ?: plain
        val tmp = File(dir, ".${file.name}.${UUID.randomUUID()}.tmp")
        try {
            if (!tmp.createNewFile()) throw IOException("temporary file exists")
            ownerOnly(tmp) // before the first key byte
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            if (nio) {
                NioFiles.replace(tmp, file)
                NioFiles.syncDirectory(dir)
            } else if (!tmp.renameTo(file)) {
                // java.io renameTo replaces atomically on POSIX; a failure is an error, never delete-then-rename.
                throw IOException("rename failed")
            }
        } catch (e: IOException) {
            zeroAndDelete(tmp)
            throw StoreException("could not write $file", e)
        } finally {
            if (sealer != null) bytes.fill(0)
        }
    }

    /** Removes stale temporary files (a crashed write); the lock is held, so none is in use. */
    private fun sweepTemporaries() {
        dir.listFiles { f -> f.name.startsWith(".${file.name}.") && f.name.endsWith(".tmp") }?.forEach { zeroAndDelete(it) }
    }

    private fun zeroAndDelete(f: File) {
        try {
            val n = f.length()
            if (f.isFile && n in 1..MAX_BYTES) RandomAccessFile(f, "rw").use { it.write(ByteArray(n.toInt())) }
        } catch (_: IOException) {
        }
        f.delete()
    }

    private fun ensureDirectory() {
        if (dir.isDirectory) return
        if (!dir.mkdirs() && !dir.isDirectory) throw StoreException("could not create $dir")
        ownerOnly(dir)
    }

    /**
     * Whether [f] exists, never trusting `File.exists()` alone (which answers false when the directory
     * cannot be listed). With nio: attributes without following links, a non-regular file refused.
     * Without: the directory must be readable and listable before "absent" is believed.
     */
    private fun exists(f: File): Boolean {
        if (nio) return NioFiles.exists(f)
        if (f.exists()) return true
        val parent = f.absoluteFile.parentFile
        if (parent != null && (!parent.isDirectory || !parent.canRead() || parent.list() == null)) {
            throw StoreException("cannot list ${parent.path}")
        }
        return false
    }

    /** True when [f] is a symlink: its canonical path (parent resolved) is not where it says it is. */
    private fun refuseSymlink(f: File) {
        val parent = f.absoluteFile.parentFile?.canonicalFile ?: return
        val leaf = File(parent, f.name)
        if (leaf.canonicalPath != leaf.absolutePath) throw StoreException("refusing to use a symlink: $f")
    }

    /** `rw-------` for a file, `rwx------` for a directory; left alone where the file system has no POSIX modes. */
    private fun ownerOnly(f: File) {
        if (nio && !NioFiles.posix(f)) return
        val ok = f.setReadable(false, false) && f.setReadable(true, true) &&
            f.setWritable(false, false) && f.setWritable(true, true) &&
            (!f.isDirectory || (f.setExecutable(false, false) && f.setExecutable(true, true)))
        if (!ok) throw StoreException("could not restrict $f")
    }

    private companion object {
        const val MAX_BYTES = 64L * 1024
        val MUTEXES = ConcurrentHashMap<String, Mutex>()
    }
}

/** The `java.nio.file` half of [FileDeviceKeyStorage]; never loaded on Android (API 24 has no such classes). */
internal object NioFiles {
    val available: Boolean by lazy {
        try {
            Class.forName("java.nio.file.Files")
            true
        } catch (e: Throwable) {
            false
        }
    }

    fun posix(f: File): Boolean = try {
        java.nio.file.Files.getFileStore(f.toPath()).supportsFileAttributeView("posix")
    } catch (e: Exception) {
        false
    }

    /** Attributes without following links: absent is false; a symlink or non-regular file, or any other failure, throws. */
    fun exists(f: File): Boolean {
        val p = f.toPath()
        return try {
            val a = java.nio.file.Files.readAttributes(p, java.nio.file.attribute.BasicFileAttributes::class.java, java.nio.file.LinkOption.NOFOLLOW_LINKS)
            if (a.isSymbolicLink || !a.isRegularFile) throw StoreException("not a regular file: $f")
            true
        } catch (e: java.nio.file.NoSuchFileException) {
            // Absent only if the directory itself is readable and listable.
            val parent = p.parent
            if (parent != null && !java.nio.file.Files.isDirectory(parent)) throw StoreException("cannot list $parent")
            false
        } catch (e: IOException) {
            throw StoreException("cannot examine $f", e)
        }
    }

    fun replace(tmp: File, dest: File) {
        try {
            java.nio.file.Files.move(
                tmp.toPath(),
                dest.toPath(),
                java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                java.nio.file.StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (e: java.nio.file.AtomicMoveNotSupportedException) {
            // No atomic rename here: the lock is held, and REPLACE_EXISTING never deletes first.
            java.nio.file.Files.move(tmp.toPath(), dest.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        }
    }

    /** Syncs the directory entry where the platform allows it (not on Windows). */
    fun syncDirectory(dir: File) {
        try {
            java.nio.channels.FileChannel.open(dir.toPath(), java.nio.file.StandardOpenOption.READ).use { it.force(true) }
        } catch (_: Exception) {
        }
    }

    /** Refuses a directory or file that this user does not own, or that others may write (directory) or touch (file). */
    fun checkTrusted(dir: File, file: File, lock: File) {
        if (!posix(dir)) return
        val me = currentOwner(dir)
        checkOwner(dir, me)
        val perms = java.nio.file.Files.getPosixFilePermissions(dir.toPath())
        if (java.nio.file.attribute.PosixFilePermission.GROUP_WRITE in perms || java.nio.file.attribute.PosixFilePermission.OTHERS_WRITE in perms) {
            throw StoreException("refusing a directory others may write: $dir")
        }
        for (f in listOf(file, lock)) {
            if (!java.nio.file.Files.exists(f.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) continue
            checkOwner(f, me)
            val fp = java.nio.file.Files.getPosixFilePermissions(f.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)
            val loose = fp.any {
                it.name.startsWith("GROUP_") || it.name.startsWith("OTHERS_")
            }
            if (loose) throw StoreException("refusing a file others may access: $f")
        }
    }

    /** This user, as the owner of a file we make now (no name lookup that can fail). */
    private fun currentOwner(dir: File): java.nio.file.attribute.UserPrincipal {
        val probe = File(dir, ".owner-probe.${UUID.randomUUID()}.tmp")
        try {
            probe.createNewFile()
            return java.nio.file.Files.getOwner(probe.toPath())
        } catch (e: IOException) {
            throw StoreException("cannot determine the current user", e)
        } finally {
            probe.delete()
        }
    }

    private fun checkOwner(f: File, me: java.nio.file.attribute.UserPrincipal) {
        val owner = try {
            java.nio.file.Files.getOwner(f.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)
        } catch (e: IOException) {
            throw StoreException("cannot examine $f", e)
        }
        if (owner != me) throw StoreException("refusing a path owned by another user: $f")
    }
}

/**
 * The key store: generation, rotation and wipe over a [DeviceKeyStorage], with the private halves
 * held only for the length of one operation.
 *
 * The record is JSON `{"v":1,"generation":n,"sign":{"seed","pub"},"agree":{"priv","pub"}}`, every
 * key canonical base64url. A record that does not parse, or whose public halves do not match its
 * private halves, is unreadable: every member except [wipe] throws [DeviceKeysUnreadableException]
 * and the record is kept (never replaced, so the identity never changes silently). [wipe] clears it.
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
        var result: DevicePublicKeys? = null
        // Under the storage lock: an existing record is returned (or throws if unreadable); only an
        // absent one is created, so two processes can never each create a pair.
        storage.update { current ->
            if (current != null) {
                val r = parse(current) ?: throw DeviceKeysUnreadableException("device keys: the record is unreadable")
                result = r.public()
                r.zero()
                return@update null
            }
            val fresh = generate(1)
            result = fresh.public()
            encode(fresh).also { fresh.zero() }
        }
        result!!
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
        var result: DevicePublicKeys? = null
        // The generation is read and the successor written under the storage lock, so a concurrent
        // rotate (another process) can neither be lost nor repeat a generation; an unreadable record throws.
        storage.update { current ->
            val prev = current?.let { parse(it) ?: throw DeviceKeysUnreadableException("device keys: the record is unreadable") }
            val gen = (prev?.generation ?: 0) + 1
            prev?.zero()
            val fresh = generate(gen)
            result = fresh.public()
            encode(fresh).also { fresh.zero() }
        }
        result!!
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
        val rec = Record(generation, ed.seed, ed.publicKey, priv, pub)
        // A fresh pair must pass the same check a stored one does, before anything is written.
        if (!consistent(rec)) {
            rec.zero()
            throw DeviceKeyUnsupportedException("the curve backend is inconsistent")
        }
        return rec
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

    /** The stored record, null when there is none; throws [DeviceKeysUnreadableException] when it cannot be used. */
    private suspend fun load(): Record? {
        val raw = storage.get() ?: return null
        try {
            return parse(raw) ?: throw DeviceKeysUnreadableException("device keys: the record is unreadable")
        } finally {
            raw.fill(0)
        }
    }

    private fun parse(raw: ByteArray): Record? {
        val o = JsonText.parseOrNull(String(raw, Charsets.UTF_8)) as? JsonObject ?: return null
        if ((o["v"] as? JsonPrimitive)?.content != "1") return null
        val gen = (o["generation"] as? JsonPrimitive)?.content?.toIntOrNull()?.takeIf { it >= 1 } ?: return null
        val sign = o["sign"] as? JsonObject ?: return null
        val agree = o["agree"] as? JsonObject ?: return null
        fun field(p: JsonObject, k: String): ByteArray? =
            (p[k] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { Base64Url.decodeStrict(it) }?.takeIf { it.size == 32 }
        val seed = field(sign, "seed") ?: return null
        val signPub = field(sign, "pub")
        val agreePriv = field(agree, "priv")
        val agreePub = field(agree, "pub")
        if (signPub == null || agreePriv == null || agreePub == null) {
            seed.fill(0)
            agreePriv?.fill(0)
            return null
        }
        val rec = Record(gen, seed, signPub, agreePriv, agreePub)
        if (!consistent(rec)) {
            rec.zero()
            return null
        }
        return rec
    }

    /** The public halves belong to the private halves: one agreement and one signature, both checked. */
    private fun consistent(r: Record): Boolean {
        val c = curves()
        // An unavailable backend is "unsupported here", never "this record is bad".
        val derived = c.x25519(r.agreePriv, X25519Points.BASE) ?: throw DeviceKeyUnsupportedException("no X25519 here")
        val verifier = Ed25519.verifier
        if (verifier === UnavailableEd25519Verifier) throw DeviceKeyUnsupportedException("no Ed25519 verification here")
        val probe = byteArrayOf(0x70, 0x6b, 0x65, 0x79)
        val sig = c.ed25519Sign(r.seed, probe) // throws DeviceKeyUnsupportedException when the backend cannot
        return derived.contentEquals(r.agreePub) && verifier.verify(r.signPub, probe, sig)
    }
}

/** The file the default device key store uses in a client's state directory. */
public const val DEVICE_KEYS_FILE: String = "device-keys.json"

/**
 * The store a client uses when the host gave none: the 0600 file in [stateDirectory], or, with no
 * state directory, a memory-only store (which refuses to register keys). Android has no default:
 * its store is sealed by the Keystore (`androidDeviceKeyStore`).
 */
public fun defaultDeviceKeyStore(stateDirectory: File?): DeviceKeyStore =
    DeviceKeyStore(if (stateDirectory == null) InMemoryDeviceKeyStorage() else FileDeviceKeyStorage(File(stateDirectory, DEVICE_KEYS_FILE)))
