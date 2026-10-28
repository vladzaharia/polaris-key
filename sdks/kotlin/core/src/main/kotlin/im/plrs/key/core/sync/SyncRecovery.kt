// The recovery code and the adopt blob (WIRE-CONTRACT-V5 §13.11.4).
//
//   code    = 16 random bytes ‖ the first 4 bytes of SHA-256(those 16): 160 bits, 32 Crockford
//             base32 characters, shown as 8 groups of 4 joined by hyphens.
//   blob    = 0x01 ‖ n12 ‖ AES-256-GCM(K, n, aad, R)       (recovery and adopt share the layout)
//   recovery: K = K_rec, aad = "pkey-sync/1 recovery" ‖ ringId ‖ u32be(epoch) ‖ kid
//   adopt:    K = K_adopt (of the new root), aad = "pkey-sync/1 adopt" ‖ fromRingId ‖ u32be(epoch)
//             ‖ kid, sealing the foreign or previous root; `epoch` and `kid` are that root's.

package im.plrs.key.core.sync

public object SyncRecovery {
    public const val CODE_BYTES: Int = 16
    public const val CHECKSUM_BYTES: Int = 4
    public const val CODE_CHARS: Int = 32

    /** The client error code for a bad checksum or a failed unwrap. */
    public const val CODE_INVALID: String = "recovery-code-invalid"

    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private const val GROUP = 4
    private const val CHAR_BITS = 5
    private const val BYTE_BITS = 8
    private const val BYTE_MASK = 0xff
    private const val CHAR_MASK = 31

    /** A fresh 16-byte code. */
    public fun newCode(): ByteArray = SyncCrypto.random(CODE_BYTES)

    private fun withChecksum(code: ByteArray): ByteArray = code + SyncCrypto.sha256(code).copyOf(CHECKSUM_BYTES)

    /** The text shown to the person: 8 groups of 4, upper case, joined by hyphens. */
    public fun encode(code: ByteArray): String {
        if (code.size != CODE_BYTES) throw SyncCryptoException("bad recovery code length")
        val chars = StringBuilder()
        var acc = 0
        var bits = 0
        for (b in withChecksum(code)) {
            acc = (acc shl BYTE_BITS) or (b.toInt() and BYTE_MASK)
            bits += BYTE_BITS
            while (bits >= CHAR_BITS) {
                chars.append(ALPHABET[(acc shr (bits - CHAR_BITS)) and CHAR_MASK])
                bits -= CHAR_BITS
            }
            acc = acc and ((1 shl bits) - 1)
        }
        return chars.chunked(GROUP).joinToString("-")
    }

    /**
     * The 16-byte code in a typed or pasted string, or null. It ignores case, spaces and hyphens,
     * maps `I` and `L` to `1` and `O` to `0`, and checks the length and the checksum.
     */
    public fun parse(text: String): ByteArray? {
        val clean = text.uppercase().filter { it != '-' && !it.isWhitespace() }
            .map {
                if (it == 'I' || it == 'L') {
                    '1'
                } else if (it == 'O') {
                    '0'
                } else {
                    it
                }
            }
        val bytes = if (clean.size == CODE_CHARS) decodeChars(clean) else null
        val code = bytes?.copyOf(CODE_BYTES)
        val ok = code != null && SyncCrypto.equalBytes(withChecksum(code), bytes)
        return if (ok) code else null
    }

    private fun decodeChars(clean: List<Char>): ByteArray? {
        val bytes = ArrayList<Byte>()
        var acc = 0
        var bits = 0
        for (ch in clean) {
            val v = ALPHABET.indexOf(ch)
            if (v < 0) return null
            acc = (acc shl CHAR_BITS) or v
            bits += CHAR_BITS
            if (bits >= BYTE_BITS) {
                bytes.add(((acc shr (bits - BYTE_BITS)) and BYTE_MASK).toByte())
                bits -= BYTE_BITS
                acc = acc and ((1 shl bits) - 1)
            }
        }
        return bytes.toByteArray()
    }

    // -- The blobs -------------------------------------------------------------------------------

    /** The ring ([ringId], [epoch]) and root [kid] a blob names: the recovery ring, or the foreign one an adopt blob came from. */
    public class RingRef(public val ringId: String, public val epoch: Int, public val kid: ByteArray)

    /** `recovery.ct`: the root sealed under the code. [nonce] is for a test vector only. */
    public fun wrap(code: ByteArray, ref: RingRef, root: ByteArray, nonce: ByteArray? = null): ByteArray =
        SyncBlobs.seal(SyncKeys.deriveRecoveryKey(code, ref.ringId), SyncBlobs.aad(SyncKeys.Label.RECOVERY, ref), root, nonce)

    /** The root, or null (a wrong code, ring, epoch or `kid`, or tampering). */
    public fun unwrap(code: ByteArray, ref: RingRef, blob: ByteArray): ByteArray? =
        SyncBlobs.open(SyncKeys.deriveRecoveryKey(code, ref.ringId), SyncBlobs.aad(SyncKeys.Label.RECOVERY, ref), blob)

    /** Seals a foreign or previous root under `K_adopt` of the current root; [from] names the root being sealed. */
    public fun sealAdopt(currentRoot: ByteArray, from: RingRef, oldRoot: ByteArray, nonce: ByteArray? = null): ByteArray =
        SyncBlobs.seal(SyncKeys.deriveAdoptKey(currentRoot), SyncBlobs.aad(SyncKeys.Label.ADOPT, from), oldRoot, nonce)

    /** The adopted root, or null. */
    public fun openAdopt(currentRoot: ByteArray, from: RingRef, blob: ByteArray): ByteArray? =
        SyncBlobs.open(SyncKeys.deriveAdoptKey(currentRoot), SyncBlobs.aad(SyncKeys.Label.ADOPT, from), blob)
}

/** The one layout recovery and adopt share: `0x01 ‖ n12 ‖ AES-256-GCM(K, n, aad, R)`. */
internal object SyncBlobs {
    private const val VERSION = 0x01

    fun aad(label: String, ref: SyncRecovery.RingRef): ByteArray =
        SyncCrypto.cat(SyncCrypto.utf8(label), SyncCrypto.utf8(ref.ringId), HpkeBaseMode.u32be(ref.epoch), ref.kid)

    fun seal(key: ByteArray, aad: ByteArray, root: ByteArray, nonce: ByteArray?): ByteArray {
        val n = nonce ?: SyncCrypto.random(SyncCrypto.NONCE_BYTES)
        if (n.size != SyncCrypto.NONCE_BYTES) throw SyncCryptoException("bad nonce length")
        return SyncCrypto.cat(byteArrayOf(VERSION.toByte()), n, SyncCrypto.aesGcmSeal(key, aad, root, n))
    }

    fun open(key: ByteArray, aad: ByteArray, blob: ByteArray): ByteArray? {
        val head = 1 + SyncCrypto.NONCE_BYTES
        if (blob.size != head + SyncCrypto.ROOT_BYTES + SyncCrypto.TAG_BYTES || blob[0].toInt() != VERSION) return null
        val root = SyncCrypto.aesGcmOpen(key, aad, blob.copyOfRange(head, blob.size), blob.copyOfRange(1, head))
        return root?.takeIf { it.size == SyncCrypto.ROOT_BYTES }
    }
}
