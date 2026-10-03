package im.plrs.key.platform

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/** Where [SecureStore]'s AES key lives. [AndroidKeyStoreProvider] on a device; a fake in tests. */
public interface KeyProvider {
    /** The key under [alias], or null when there is none. */
    public fun get(alias: String): SecretKey?

    /** Creates (replacing any) AES-256-GCM key under [alias]. */
    public fun create(alias: String): SecretKey

    public fun delete(alias: String)

    /** What protects the key: {backend, securityLevel?, insideSecureHardware?, strongBox, keySize?}. */
    public fun describe(alias: String): JSONObject
}

/**
 * AES-256-GCM keys in AndroidKeyStore, non-exportable and not user-authenticated (the device token
 * must be readable at boot). StrongBox is requested where the device has it and the key falls back
 * to the TEE on [StrongBoxUnavailableException]. On the emulator the key is software-backed
 * (`securityLevel` 0) and StrongBox is unavailable (notes/S-10 §4).
 */
public class AndroidKeyStoreProvider(
    private val context: Context? = null,
    private val preferStrongBox: Boolean = true,
) : KeyProvider {
    private fun store(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    override fun get(alias: String): SecretKey? = store().getKey(alias, null) as SecretKey?

    override fun create(alias: String): SecretKey {
        if (preferStrongBox && Build.VERSION.SDK_INT >= 28 && hasStrongBox()) {
            try {
                return generate(alias, strongBox = true)
            } catch (_: StrongBoxUnavailableException) {
                // Fall through to the TEE.
            }
        }
        return generate(alias, strongBox = false)
    }

    private fun hasStrongBox(): Boolean =
        Build.VERSION.SDK_INT >= 28 && (context?.packageManager?.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE) ?: true)

    private fun generate(alias: String, strongBox: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
        if (strongBox && Build.VERSION.SDK_INT >= 28) spec.setIsStrongBoxBacked(true)
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(spec.build())
        return gen.generateKey()
    }

    override fun delete(alias: String) {
        store().deleteEntry(alias)
    }

    override fun describe(alias: String): JSONObject {
        val out = JSONObject().put("backend", ANDROID_KEYSTORE)
        val key = get(alias) ?: return out.put("exists", false)
        out.put("exists", true)
        val info = SecretKeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE).getKeySpec(key, KeyInfo::class.java) as KeyInfo
        out.put("keySize", info.keySize)
        @Suppress("DEPRECATION")
        out.put("insideSecureHardware", info.isInsideSecureHardware)
        if (Build.VERSION.SDK_INT >= 31) {
            // KeyProperties.SECURITY_LEVEL_*: 0 software, 1 TEE, 2 StrongBox, -2 unknown secure.
            out.put("securityLevel", info.securityLevel)
            out.put("strongBox", info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX)
        }
        return out
    }

    public companion object {
        public const val ANDROID_KEYSTORE: String = "AndroidKeyStore"
    }
}

/**
 * A [SecureStore] operation failed. [reason]: `invalid-name`, `keystore`, `keystore-provider` (the
 * AndroidKeyStore provider itself failed: a `ProviderException`, e.g. a keymaster or StrongBox
 * error), `corrupt` or `io`.
 */
public class SecureStoreException(public val reason: String, message: String, cause: Throwable? = null) :
    Exception(message, cause)

/**
 * Small secrets (the device token, the device id) wrapped by one AndroidKeyStore AES-256-GCM key per
 * product, alias `pkey:<product>:device`. Each value is a file `<account>.kv` under
 * `noBackupFilesDir/pkey/<product>/keystore/` (never backed up; the key could not follow it to
 * another device), written atomically:
 *
 *     0x01 ‖ iv (12 bytes) ‖ ciphertext ‖ tag (16 bytes)      AAD = "pkey/v1/<product>/<account>"
 *
 * The AAD binds a blob to its slot, so a blob copied to another account or product fails its tag.
 * When the key is gone or permanently invalidated, its blobs can never be read again: they are
 * deleted and [get] answers a null value with [Read.reset] set, and the caller re-enrols (a new
 * activation). Every other failure throws [SecureStoreException]; nothing is ever written in the
 * clear.
 */
public class SecureStore(
    private val dir: File,
    public val product: String,
    private val keys: KeyProvider,
) {
    public constructor(context: Context, product: String) : this(
        File(context.noBackupFilesDir, "pkey/${checkName(product)}/keystore"),
        product,
        AndroidKeyStoreProvider(context),
    )

    init {
        checkName(product)
    }

    public val alias: String get() = "pkey:$product:device"

    /** Makes the AES/GCM cipher (tests substitute one that raises Keystore-only exceptions). */
    internal var newCipher: () -> Cipher = { Cipher.getInstance(TRANSFORMATION) }

    /** A read: [value] null when absent; [reset] `key-missing` or `key-invalidated` when blobs were dropped. */
    public data class Read(val value: String?, val reset: String? = null)

    public fun get(account: String): Read {
        val file = fileFor(account)
        if (!file.exists()) return Read(null)
        val blob = try {
            file.readBytes()
        } catch (e: IOException) {
            throw SecureStoreException("io", "cannot read ${file.name}: ${e.message}", e)
        }
        if (blob.size < 1 + IV_BYTES + TAG_BYTES || blob[0] != VERSION) {
            throw SecureStoreException("corrupt", "${file.name} is not a version-1 blob")
        }
        val key = try {
            keys.get(alias)
        } catch (e: ProviderException) {
            throw providerFailure("load $alias", e)
        } catch (e: GeneralSecurityException) {
            throw SecureStoreException("keystore", "cannot load $alias: ${e.message}", e)
        } catch (e: IOException) {
            throw SecureStoreException("keystore", "cannot load $alias: ${e.message}", e)
        }
        if (key == null) {
            wipeBlobs()
            return Read(null, RESET_MISSING)
        }
        return try {
            val cipher = newCipher()
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, blob, 1, IV_BYTES))
            cipher.updateAAD(aad(account))
            Read(String(cipher.doFinal(blob, 1 + IV_BYTES, blob.size - 1 - IV_BYTES), Charsets.UTF_8))
        } catch (e: KeyPermanentlyInvalidatedException) {
            resetKey()
            Read(null, RESET_INVALIDATED)
        } catch (e: AEADBadTagException) {
            throw SecureStoreException("corrupt", "${file.name} failed its authentication tag", e)
        } catch (e: ProviderException) {
            throw providerFailure("decrypt ${file.name}", e)
        } catch (e: GeneralSecurityException) {
            throw SecureStoreException("keystore", "cannot decrypt ${file.name}: ${e.message}", e)
        }
    }

    public fun put(account: String, value: String) {
        val file = fileFor(account)
        val blob = try {
            encrypt(account, value.toByteArray(Charsets.UTF_8), retry = true)
        } catch (e: ProviderException) {
            throw providerFailure("encrypt for $account", e)
        } catch (e: GeneralSecurityException) {
            throw SecureStoreException("keystore", "cannot encrypt for $account: ${e.message}", e)
        } catch (e: IOException) {
            throw SecureStoreException("keystore", "cannot load $alias: ${e.message}", e)
        }
        writeAtomically(file, blob)
    }

    /** Removes the value; true when there was one. */
    public fun delete(account: String): Boolean {
        val file = fileFor(account)
        if (!file.exists()) return false
        if (!file.delete()) throw SecureStoreException("io", "cannot delete ${file.name}")
        return true
    }

    /** {alias, backend, exists, securityLevel?, insideSecureHardware?, strongBox?, keySize?}. */
    public fun info(): JSONObject = try {
        keys.describe(alias).put("alias", alias)
    } catch (e: ProviderException) {
        throw providerFailure("describe $alias", e)
    } catch (e: GeneralSecurityException) {
        throw SecureStoreException("keystore", "cannot describe $alias: ${e.message}", e)
    } catch (e: IOException) {
        throw SecureStoreException("keystore", "cannot describe $alias: ${e.message}", e)
    }

    private fun encrypt(account: String, plain: ByteArray, retry: Boolean): ByteArray {
        var key = keys.get(alias)
        if (key == null) {
            // Blobs from a previous key can never be read again.
            wipeBlobs()
            key = keys.create(alias)
        }
        val cipher = newCipher()
        try {
            cipher.init(Cipher.ENCRYPT_MODE, key)
        } catch (e: KeyPermanentlyInvalidatedException) {
            if (!retry) throw e
            resetKey()
            return encrypt(account, plain, retry = false)
        }
        cipher.updateAAD(aad(account))
        val ct = cipher.doFinal(plain)
        val iv = cipher.iv
        if (iv == null || iv.size != IV_BYTES) throw GeneralSecurityException("unexpected IV length ${iv?.size}")
        return byteArrayOf(VERSION) + iv + ct
    }

    private fun resetKey() {
        try {
            keys.delete(alias)
        } catch (_: GeneralSecurityException) {
        } catch (_: IOException) {
        }
        wipeBlobs()
    }

    private fun wipeBlobs() {
        dir.listFiles { f -> f.name.endsWith(SUFFIX) }?.forEach { it.delete() }
    }

    private fun writeAtomically(file: File, bytes: ByteArray) {
        if (!dir.isDirectory && !dir.mkdirs()) throw SecureStoreException("io", "cannot create ${dir.path}")
        val tmp = File(dir, file.name + ".tmp")
        try {
            tmp.outputStream().use { out ->
                out.write(bytes)
                out.fd.sync()
            }
        } catch (e: IOException) {
            tmp.delete()
            throw SecureStoreException("io", "cannot write ${tmp.name}: ${e.message}", e)
        }
        if (!tmp.renameTo(file)) {
            tmp.delete()
            throw SecureStoreException("io", "cannot replace ${file.name}")
        }
    }

    private fun providerFailure(what: String, e: ProviderException) =
        SecureStoreException("keystore-provider", "AndroidKeyStore could not $what: ${e.message}", e)

    private fun fileFor(account: String): File = File(dir, checkName(account) + SUFFIX)

    private fun aad(account: String): ByteArray = "pkey/v1/$product/$account".toByteArray(Charsets.UTF_8)

    public companion object {
        public const val RESET_MISSING: String = "key-missing"
        public const val RESET_INVALIDATED: String = "key-invalidated"
        private const val VERSION: Byte = 1
        private const val IV_BYTES = 12
        private const val TAG_BYTES = 16
        private const val SUFFIX = ".kv"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private val NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

        /** Product and account names become path segments: a slug, never `..` or a separator. */
        public fun checkName(name: String): String {
            if (!NAME.matches(name) || name.contains("..")) {
                throw SecureStoreException("invalid-name", "not a valid store name: \"$name\"")
            }
            return name
        }
    }
}
