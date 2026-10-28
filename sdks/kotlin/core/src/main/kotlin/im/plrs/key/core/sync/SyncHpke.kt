// `pkey-sync-wrap/1` (WIRE-CONTRACT-V5 §13.11.1): RFC 9180 HPKE `mode_base`, single shot, with
// KEM 0x0020 (DHKEM X25519, HKDF-SHA256), KDF 0x0001 (HKDF-SHA256) and AEAD 0x0002 (AES-256-GCM).
// A wrap carries one root `R` to a device's agreement key. Sequence 0 is the only message, so the
// AEAD nonce is the key schedule's `base_nonce`.
//
// The key schedule is written out in `HpkeBaseMode` so that opening runs over `DeviceKeyPort.dh`:
// the private agreement key never leaves its port. Sealing uses an ephemeral X25519 key from
// `DeviceCurves`, which is Tink where the JCA has no X25519 (Android below API 33).

package im.plrs.key.core.sync

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceCurves
import im.plrs.key.core.DeviceCurvesSelection
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.X25519Points

public object SyncHpke {
    /** The `kem` member of a wrap: the HPKE KEM id as a JSON integer. */
    public const val KEM_X25519: Int = HpkeBaseMode.KEM_X25519
    public const val ENC_BYTES: Int = 32

    /** A wrapped root: 32 bytes of `R` and the 16-byte tag. */
    public const val WRAP_CT_BYTES: Int = SyncCrypto.ROOT_BYTES + SyncCrypto.TAG_BYTES

    /** The `info` and `aad` an HPKE message is bound to. */
    public class Binding(public val info: ByteArray, public val aad: ByteArray)

    /**
     * The ephemeral key of a seal: [privateKey] (32 bytes) is for a test vector only, leave it out
     * to draw a fresh one; [curves] does the X25519.
     */
    public class Ephemeral(public val privateKey: ByteArray? = null, public val curves: DeviceCurves = DeviceCurvesSelection.curves)

    private fun fail(why: String): Nothing = throw SyncCryptoException(why)

    private fun isZero(d: ByteArray): Boolean = d.all { it.toInt() == 0 }

    /** The result of a seal: the sender's ephemeral public key and the ciphertext with its tag. */
    public class Sealed(public val enc: ByteArray, public val ct: ByteArray)

    /** `SealBase` for one message. Throws [SyncCryptoException] when the recipient key is not usable. */
    public fun seal(recipientPublicKey: ByteArray, binding: Binding, plaintext: ByteArray, ephemeral: Ephemeral = Ephemeral()): Sealed {
        if (recipientPublicKey.size != ENC_BYTES) fail("bad recipient key length")
        val skE = ephemeral.privateKey ?: SyncCrypto.random(SyncCrypto.KEY_BYTES)
        if (skE.size != SyncCrypto.KEY_BYTES) fail("bad ephemeral key length")
        val enc = ephemeral.curves.x25519(skE, X25519Points.BASE) ?: fail("no X25519 here")
        val dh = ephemeral.curves.x25519(skE, recipientPublicKey)?.takeUnless { isZero(it) } ?: fail("the recipient key is not usable")
        val ss = HpkeBaseMode.sharedSecret(dh, SyncCrypto.cat(enc, recipientPublicKey))
        val ks = HpkeBaseMode.keySchedule(ss, binding.info)
        return Sealed(enc, SyncCrypto.aesGcmSeal(ks.key, binding.aad, plaintext, ks.nonce))
    }

    /**
     * `OpenBase` for a recipient held by a port: [recipientPublicKey] is its raw public key and
     * [dh] is `DeviceKeyPort.dh` (null for a refused peer key). The plaintext, or null for a bad
     * `enc`, a wrong key, info or aad, or tampering.
     */
    public suspend fun open(
        recipientPublicKey: ByteArray,
        dh: suspend (ByteArray) -> ByteArray?,
        enc: ByteArray,
        binding: Binding,
        ciphertext: ByteArray,
    ): ByteArray? {
        val shared = (if (enc.size == ENC_BYTES) dh(enc) else null)?.takeUnless { isZero(it) } ?: return null
        val ss = HpkeBaseMode.sharedSecret(shared, SyncCrypto.cat(enc, recipientPublicKey))
        val ks = HpkeBaseMode.keySchedule(ss, binding.info)
        return SyncCrypto.aesGcmOpen(ks.key, binding.aad, ciphertext, ks.nonce)
    }

    /** The raw agreement public key the port holds, or null. */
    private suspend fun portPublicKey(port: DeviceKeyPort): ByteArray? =
        port.publicKeys()?.let { Base64Url.decode(it.agreeKey) }?.takeIf { it.size == ENC_BYTES }

    /** `OpenBase` over a device key port. */
    public suspend fun open(port: DeviceKeyPort, enc: ByteArray, binding: Binding, ciphertext: ByteArray): ByteArray? {
        val pub = portPublicKey(port) ?: return null
        return open(pub, { port.dh(it) }, enc, binding, ciphertext)
    }

    // -- The wrap --------------------------------------------------------------------------------

    /** What a wrap is bound to: [epoch] is at least 1. */
    public class WrapContext(public val product: String, public val deviceId: String, public val ringId: String, public val epoch: Int)

    /** `"pkey-sync/1 wrap\0" ‖ product ‖ 0x00 ‖ deviceId ‖ 0x00 ‖ ringId ‖ 0x00 ‖ u32be(epoch)`. */
    public fun wrapInfo(c: WrapContext): ByteArray {
        val nul = byteArrayOf(0)
        return SyncCrypto.cat(
            SyncCrypto.utf8("pkey-sync/1 wrap\u0000"),
            SyncCrypto.utf8(c.product),
            nul,
            SyncCrypto.utf8(c.deviceId),
            nul,
            SyncCrypto.utf8(c.ringId),
            nul,
            HpkeBaseMode.u32be(c.epoch),
        )
    }

    /** A `pkey-sync-wrap/1` as the routes carry it, in bytes. */
    public class Wrap(public val kem: Int, public val enc: ByteArray, public val ct: ByteArray) {
        override fun equals(other: Any?): Boolean = other is Wrap && kem == other.kem && enc.contentEquals(other.enc) && ct.contentEquals(other.ct)

        override fun hashCode(): Int = (kem * 31 + enc.contentHashCode()) * 31 + ct.contentHashCode()
    }

    /** Wraps [root] to a device's agreement key. [kid] (16 bytes, of [root]) is the associated data. */
    public fun wrapRoot(
        recipientPublicKey: ByteArray,
        context: WrapContext,
        kid: ByteArray,
        root: ByteArray,
        ephemeral: Ephemeral = Ephemeral(),
    ): Wrap {
        val s = seal(recipientPublicKey, Binding(wrapInfo(context), kid), root, ephemeral)
        return Wrap(KEM_X25519, s.enc, s.ct)
    }

    /**
     * The root in a wrap, or null: an unknown `kem`, a wrong key, context or `kid`, tampering, or a
     * plaintext that is not 32 bytes. The caller still checks that `kid(R)` is the ring's `rootKid`.
     */
    public suspend fun unwrapRoot(
        recipientPublicKey: ByteArray,
        dh: suspend (ByteArray) -> ByteArray?,
        context: WrapContext,
        kid: ByteArray,
        wrap: Wrap,
    ): ByteArray? {
        if (wrap.kem != KEM_X25519) return null
        val root = open(recipientPublicKey, dh, wrap.enc, Binding(wrapInfo(context), kid), wrap.ct)
        return root?.takeIf { it.size == SyncCrypto.ROOT_BYTES }
    }

    /** [unwrapRoot] for a device whose agreement key lives in a [DeviceKeyPort]. */
    public suspend fun unwrapRoot(port: DeviceKeyPort, context: WrapContext, kid: ByteArray, wrap: Wrap): ByteArray? {
        val pub = portPublicKey(port) ?: return null
        return unwrapRoot(pub, { port.dh(it) }, context, kid, wrap)
    }
}
