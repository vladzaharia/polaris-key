package org.polariskey.s10

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/** AES-256-GCM key in AndroidKeyStore wrapping small secrets. Blob = 0x01 || iv(12) || ct+tag. */
object KeyVault {
    private const val KS = "AndroidKeyStore"
    private fun store() = KeyStore.getInstance(KS).apply { load(null) }

    fun key(alias: String, strongBox: Boolean, out: JSONObject? = null): SecretKey {
        (store().getKey(alias, null) as SecretKey?)?.let {
            out?.put("created", false)
            return it
        }
        val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
        if (strongBox && Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true)
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KS)
        g.init(b.build())
        out?.put("created", true)
        return g.generateKey()
    }

    fun wrap(alias: String, plain: String, strongBox: Boolean): JSONObject {
        val o = JSONObject()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key(alias, strongBox, o))
        val ct = c.doFinal(plain.toByteArray())
        val blob = byteArrayOf(1) + c.iv + ct
        return o.put("blob", Base64.encodeToString(blob, Base64.NO_WRAP)).put("ivLen", c.iv.size)
    }

    fun unwrap(alias: String, blob: String): JSONObject {
        val b = Base64.decode(blob, Base64.NO_WRAP)
        require(b[0].toInt() == 1) { "unknown blob version" }
        val k = store().getKey(alias, null) as SecretKey? ?: return JSONObject().put("error", "no_key")
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, b, 1, 12))
        return JSONObject().put("plain", String(c.doFinal(b, 13, b.size - 13)))
    }

    fun info(alias: String): JSONObject {
        val k = store().getKey(alias, null) as SecretKey? ?: return JSONObject().put("error", "no_key")
        val ki = SecretKeyFactory.getInstance(k.algorithm, KS).getKeySpec(k, KeyInfo::class.java) as KeyInfo
        val o = JSONObject()
        @Suppress("DEPRECATION")
        o.put("insideSecureHardware", ki.isInsideSecureHardware)
        if (Build.VERSION.SDK_INT >= 31) o.put("securityLevel", ki.securityLevel)
        o.put("keySize", ki.keySize).put("userAuth", ki.isUserAuthenticationRequired)
        return o
    }

    fun delete(alias: String): JSONObject {
        store().deleteEntry(alias)
        return JSONObject().put("deleted", true)
    }
}
