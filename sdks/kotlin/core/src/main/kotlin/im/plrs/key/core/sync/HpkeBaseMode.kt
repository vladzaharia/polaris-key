// RFC 9180 `mode_base` for DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM: the KEM's
// ExtractAndExpand and the key schedule, with the labeled HKDF they use. Nothing here holds a key.

package im.plrs.key.core.sync

import java.nio.ByteBuffer

public object HpkeBaseMode {
    /** The HPKE KEM id of DHKEM(X25519, HKDF-SHA256). */
    public const val KEM_X25519: Int = 0x0020
    private const val KDF_HKDF_SHA256 = 0x0001
    private const val AEAD_AES_256_GCM = 0x0002
    private const val BYTE_MASK = 0xff
    private const val BYTE_BITS = 8
    private val kemSuite = SyncCrypto.utf8("KEM") + i2osp2(KEM_X25519)
    private val hpkeSuite = SyncCrypto.utf8("HPKE") + i2osp2(KEM_X25519) + i2osp2(KDF_HKDF_SHA256) + i2osp2(AEAD_AES_256_GCM)
    private val v1 = SyncCrypto.utf8("HPKE-v1")

    private fun i2osp2(n: Int): ByteArray = byteArrayOf((n shr BYTE_BITS and BYTE_MASK).toByte(), (n and BYTE_MASK).toByte())

    /** A 32-bit big-endian integer. */
    public fun u32be(n: Int): ByteArray = ByteBuffer.allocate(Int.SIZE_BYTES).putInt(n).array()

    // HKDF-Extract and -Expand (RFC 5869), which RFC 9180 labels.
    private fun labeledExtract(suite: ByteArray, salt: ByteArray, label: String, ikm: ByteArray): ByteArray =
        SyncCrypto.hmac(if (salt.isEmpty()) ByteArray(SyncCrypto.ROOT_BYTES) else salt, SyncCrypto.cat(v1, suite, SyncCrypto.utf8(label), ikm))

    private fun labeledExpand(suite: ByteArray, prk: ByteArray, label: String, info: ByteArray, length: Int): ByteArray {
        val labeled = SyncCrypto.cat(i2osp2(length), v1, suite, SyncCrypto.utf8(label), info)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var off = 0
        var i = 1
        while (off < length) {
            t = SyncCrypto.hmac(prk, SyncCrypto.cat(t, labeled, byteArrayOf(i.toByte())))
            val n = minOf(t.size, length - off)
            t.copyInto(out, off, 0, n)
            off += n
            i++
        }
        return out
    }

    /** `ExtractAndExpand` of the KEM (RFC 9180 §4.1). */
    public fun sharedSecret(dh: ByteArray, kemContext: ByteArray): ByteArray {
        val prk = labeledExtract(kemSuite, ByteArray(0), "eae_prk", dh)
        return labeledExpand(kemSuite, prk, "shared_secret", kemContext, SyncCrypto.KEY_BYTES)
    }

    /** The AEAD key and nonce of a `mode_base` context (RFC 9180 §5.1). */
    public class KeySchedule(public val key: ByteArray, public val nonce: ByteArray)

    public fun keySchedule(secret: ByteArray, info: ByteArray): KeySchedule {
        val none = ByteArray(0)
        val pskIdHash = labeledExtract(hpkeSuite, none, "psk_id_hash", none)
        val infoHash = labeledExtract(hpkeSuite, none, "info_hash", info)
        val context = SyncCrypto.cat(byteArrayOf(0x00), pskIdHash, infoHash)
        val s = labeledExtract(hpkeSuite, secret, "secret", none)
        return KeySchedule(
            labeledExpand(hpkeSuite, s, "key", context, SyncCrypto.KEY_BYTES),
            labeledExpand(hpkeSuite, s, "base_nonce", context, SyncCrypto.NONCE_BYTES),
        )
    }
}
