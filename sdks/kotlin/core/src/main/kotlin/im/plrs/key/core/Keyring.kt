// The OS keyring token store for a JVM desktop (UK-40, SP-K12): Keychain on macOS, Credential
// Manager on Windows, Secret Service on Linux. A port of Python's `KeyringStore`
// (`polaris_key/devices/store.py`, P1b-09, security finding R4-11), the reference for the
// fallback rules:
//
//   - the token lives in the keyring under service `pkey:<product>`, account `device-token` (§8);
//   - a token write is VERIFIED (set, then read back). A write that cannot be verified falls back to
//     the 0600 token file and deletes the keyring entry (best effort), and `status()` says so;
//   - THE INVARIANT: the token file exists only when the last token write fell back (or an earlier
//     FileStore build left it), so reads are file-first and a stale keyring entry never shadows a
//     newer file token;
//   - a FileStore token from an earlier build moves into the keyring on the first read that can
//     verify the move;
//   - the device id and the verified cache stay in the 0600 FileStore files (neither is a secret:
//     the cache holds signed artifacts only, §4.1).
//
// The OS binding is the [KeyringBackend] port. [JavaKeyringBackend] binds java-keyring
// (`com.github.javakeyring:java-keyring`, JNA), which :core declares compileOnly: a desktop app adds
// it at runtime (PolarisKeyDesktop's README line), and where it is absent, or no backend is
// reachable (a headless Linux session with no Secret Service), the store keeps the token in the
// 0600 file, `status()` reports `file` with `keyring-unavailable`, and `supports(core.store)`
// answers the registry's jvm `dependency` N/A. Nothing here is ever a silent downgrade: SP-50 adds a
// warning, once per run, the first time the token is kept in (or read from) the file because the
// keyring could not take it (`DegradedStoreWarning`; java.util.logging `im.plrs.key` by default).

package im.plrs.key.core

import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The once-per-run warning a [KeyringStore] gives when it keeps the device token in its 0600 file
 * instead of the OS keyring (SP-50): java-keyring missing (add `im.plrs.key:polaris-key-desktop`), no
 * reachable keyring, or a write the keyring would not verify.
 */
public object DegradedStoreWarning {
    private val warned = AtomicBoolean(false)

    /** Where the warning goes: java.util.logging's `im.plrs.key` logger at WARNING unless replaced. */
    @Volatile
    public var sink: (String) -> Unit = { java.util.logging.Logger.getLogger("im.plrs.key").warning(it) }

    /** Whether this run has warned. */
    public val hasWarned: Boolean get() = warned.get()

    internal fun once(message: String) {
        if (warned.compareAndSet(false, true)) sink(message)
    }

    /** Forget that this run warned (tests). */
    internal fun reset() {
        warned.set(false)
    }
}

/** A keyring operation failed for a reason other than a missing entry. */
public class KeyringException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** One OS credential store. */
public interface KeyringBackend {
    /**
     * Why this keyring cannot be used here, or null when it can. Selects the OS backend and reads
     * nothing from it, so `supports()` can ask; never throws.
     */
    public fun unavailable(): String?

    /** The secret, or null when there is no entry. Throws [KeyringException] on any other failure. */
    public fun get(service: String, account: String): String?

    /** Store [secret], replacing any entry. Throws [KeyringException]. */
    public fun set(service: String, account: String, secret: String)

    /** Remove the entry; a missing entry is not an error. Throws [KeyringException]. */
    public fun delete(service: String, account: String)
}

/** A backend that is never usable, with [reason] as its `unavailable()` answer. */
public class NoKeyring(private val reason: String) : KeyringBackend {
    override fun unavailable(): String = reason

    override fun get(service: String, account: String): String? = throw KeyringException(reason)

    override fun set(service: String, account: String, secret: String): Unit = throw KeyringException(reason)

    override fun delete(service: String, account: String): Unit = throw KeyringException(reason)
}

/**
 * The OS keyring through java-keyring (macOS Keychain, Windows Credential Manager, Secret Service
 * or KWallet on Linux). java-keyring is compileOnly in :core: when the application does not ship it,
 * [unavailable] says so and nothing else is called. The backend is selected once per instance and
 * kept; a failed selection is retried at the next call (a keyring daemon can start later).
 */
public class JavaKeyringBackend : KeyringBackend {
    @Volatile private var access: JavaKeyringAccess? = null

    override fun unavailable(): String? = try {
        open()
        null
    } catch (e: KeyringException) {
        e.message ?: "no OS keyring is reachable"
    }

    override fun get(service: String, account: String): String? = open().get(service, account)

    override fun set(service: String, account: String, secret: String): Unit = open().set(service, account, secret)

    override fun delete(service: String, account: String): Unit = open().delete(service, account)

    private fun open(): JavaKeyringAccess {
        access?.let { return it }
        synchronized(this) {
            access?.let { return it }
            if (!onClasspath) throw KeyringException("java-keyring (com.github.javakeyring:java-keyring) is not on the classpath")
            val opened = try {
                JavaKeyringAccess.create()
            } catch (e: KeyringException) {
                throw e
            } catch (e: LinkageError) {
                throw KeyringException("the OS keyring binding does not load here: ${e.message ?: e.javaClass.simpleName}", e)
            } catch (e: Exception) {
                throw KeyringException("no OS keyring is reachable: ${e.message ?: e.javaClass.simpleName}", e)
            }
            access = opened
            return opened
        }
    }

    public companion object {
        /** Whether java-keyring itself is on this process's classpath (probed once). */
        public val onClasspath: Boolean by lazy {
            try {
                Class.forName("com.github.javakeyring.Keyring", false, JavaKeyringBackend::class.java.classLoader)
                true
            } catch (e: Throwable) {
                false
            }
        }

        /**
         * Whether a java-keyring failure message means "no such entry". java-keyring reports a
         * missing entry as an exception on every backend; these are its own messages (1.0.4), and
         * Windows' ERROR_NOT_FOUND (1168).
         */
        public fun isNotFound(message: String?): Boolean {
            val m = message ?: return false
            return NOT_FOUND.any { m.contains(it, ignoreCase = true) }
        }

        private val NOT_FOUND = listOf(
            "No stored credentials match",
            "No password to delete",
            "could not be found",
            "is not in wallet",
            "Password not Found",
            "Error code 1168",
        )
    }
}

/**
 * The only code that names java-keyring's types; loaded only after [JavaKeyringBackend.onClasspath]
 * holds, so :core runs without the library.
 */
internal class JavaKeyringAccess private constructor(private val keyring: com.github.javakeyring.Keyring) {
    fun get(service: String, account: String): String? = try {
        keyring.getPassword(service, account)
    } catch (e: com.github.javakeyring.PasswordAccessException) {
        if (JavaKeyringBackend.isNotFound(e.message)) null else throw KeyringException("keyring read failed: ${e.message}", e)
    } catch (e: RuntimeException) {
        throw KeyringException("keyring read failed: ${e.message ?: e.javaClass.simpleName}", e)
    }

    fun set(service: String, account: String, secret: String) {
        try {
            keyring.setPassword(service, account, secret)
        } catch (e: com.github.javakeyring.PasswordAccessException) {
            throw KeyringException("keyring write failed: ${e.message}", e)
        } catch (e: RuntimeException) {
            throw KeyringException("keyring write failed: ${e.message ?: e.javaClass.simpleName}", e)
        }
    }

    fun delete(service: String, account: String) {
        try {
            keyring.deletePassword(service, account)
        } catch (e: com.github.javakeyring.PasswordAccessException) {
            if (!JavaKeyringBackend.isNotFound(e.message)) throw KeyringException("keyring delete failed: ${e.message}", e)
        } catch (e: RuntimeException) {
            throw KeyringException("keyring delete failed: ${e.message ?: e.javaClass.simpleName}", e)
        }
    }

    companion object {
        fun create(): JavaKeyringAccess = try {
            JavaKeyringAccess(com.github.javakeyring.Keyring.create())
        } catch (e: com.github.javakeyring.BackendNotSupportedException) {
            throw KeyringException("no OS keyring backend is reachable from this process (${e.message})", e)
        }
    }
}

/**
 * The token in the OS keyring, with an explicit 0600 file fallback and a `status()` that says which
 * one holds it; the device id and cache in [directory]'s 0600 files. See the file comment.
 */
public class KeyringStore(
    public val productSlug: String,
    public val directory: File,
    private val backend: KeyringBackend = JavaKeyringBackend(),
) : Store {
    private val lock = Mutex()

    /** The store's lock, on `Dispatchers.IO`: every file (and keyring) access is main-safe (SP-50). */
    private suspend inline fun <T> locked(crossinline block: suspend () -> T): T =
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { lock.withLock { block() } }
    private val files = FileStore(productSlug, directory)

    /** The keyring service tag, `pkey:<product>` (§8). */
    public val service: String = "$KEYRING_SERVICE_PREFIX$productSlug"

    /** Why the OS keyring cannot be used, or null when it can. Reads nothing; never throws. */
    public fun keyringUnavailable(): String? = try {
        backend.unavailable()
    } catch (e: Exception) {
        e.message ?: e.javaClass.simpleName
    }

    override suspend fun getToken(): String? = locked {
        val fromFile = files.getToken()
        if (fromFile != null) {
            // An earlier FileStore build, or a write that fell back: move it when the move verifies.
            val why = keyringUnavailable()
            if (why == null && writeVerified(fromFile)) {
                try {
                    files.clearToken()
                } catch (e: StoreException) {
                    // The file still holds the same token; reads stay file-first.
                }
            } else {
                warnDegraded(why ?: "the OS keyring did not verify the move")
            }
            return@locked fromFile
        }
        if (keyringUnavailable() != null) return@locked null
        try {
            backend.get(service, ACCOUNT)?.ifEmpty { null }
        } catch (e: Exception) {
            null
        }
    }

    override suspend fun setToken(token: String): Unit = locked {
        val usable = keyringUnavailable() == null
        if (usable && writeVerified(token)) {
            try {
                files.clearToken()
            } catch (e: StoreException) {
                // A surviving file must never hold an OLDER token than the keyring.
                files.setToken(token)
            }
            return@locked
        }
        // Throws on failure: losing the token silently is worse than an error.
        files.setToken(token)
        warnDegraded(if (usable) "the OS keyring did not verify the write" else keyringUnavailable() ?: "no OS keyring")
        if (usable) {
            try {
                backend.delete(service, ACCOUNT)
            } catch (e: Exception) {
                // Best effort: the file is the newer copy, and reads are file-first.
            }
        }
    }

    override suspend fun clearToken(): Unit = locked {
        if (keyringUnavailable() == null) {
            try {
                backend.delete(service, ACCOUNT)
            } catch (e: Exception) {
                // The file below is removed either way; status() reports a keyring that fails.
            }
        }
        files.clearToken()
    }

    override suspend fun getDeviceId(): String = files.getDeviceId()

    override suspend fun readCache(): CacheRecord? = files.readCache()

    override suspend fun writeCache(record: CacheRecord): Unit = files.writeCache(record)

    override suspend fun clearCache(): Unit = files.clearCache()

    override suspend fun status(): StoreStatus = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { statusOnIo() }

    private suspend fun statusOnIo(): StoreStatus = try {
        val why = keyringUnavailable()
        if (why != null) {
            StoreStatus(StoreBackend.file, StoreStatus.Degraded(StoreDegradedReason.keyringUnavailable, why))
        } else {
            val readError = try {
                backend.get(service, ACCOUNT)
                null
            } catch (e: Exception) {
                e.message ?: e.javaClass.simpleName
            }
            when {
                readError != null -> StoreStatus(StoreBackend.file, StoreStatus.Degraded(StoreDegradedReason.keyringError, readError))
                files.getToken() != null -> StoreStatus(
                    StoreBackend.file,
                    StoreStatus.Degraded(
                        StoreDegradedReason.keyringError,
                        "an earlier write fell back to this file; the next token write moves it to the keyring",
                    ),
                )
                else -> StoreStatus(StoreBackend.keyring)
            }
        }
    } catch (e: Exception) {
        StoreStatus(StoreBackend.file, StoreStatus.Degraded(StoreDegradedReason.keyringError, e.message ?: e.javaClass.simpleName))
    }

    private fun warnDegraded(why: String) = DegradedStoreWarning.once(
        "Polaris Key ($productSlug): the device token is in a 0600 file in $directory, not the OS keyring ($why). " +
            "On a desktop, add im.plrs.key:polaris-key-desktop and check that a keyring is reachable.",
    )

    /** Set, then read back: true only when the keyring now holds exactly [token]. */
    private fun writeVerified(token: String): Boolean = try {
        backend.set(service, ACCOUNT, token)
        backend.get(service, ACCOUNT) == token
    } catch (e: Exception) {
        false
    }

    public companion object {
        /** §8: the OS keyring service tag is `pkey:<product>`. */
        public const val KEYRING_SERVICE_PREFIX: String = "pkey:"

        /** The keyring account the device token lives under. */
        public const val ACCOUNT: String = "device-token"
    }
}
