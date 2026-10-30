// Chunk ids and chunk objects (WIRE-CONTRACT-V5 §13.8.3, §13.10.2).
//
//   id      E2E: HMAC-SHA256(K_cid(c), plainChunk); server mode: SHA-256(plainChunk). Hex on the
//           wire (`SYNC_CHUNK_ID_PATTERN`), 32 raw bytes as a key salt and in the aad.
//   object  `pkey-sync-chunk/1`: 0x01 | codec | nonce(12) | AES-256-GCM(K_chunk(id), nonce,
//           aad = 0x01 | codec | id, body). codec 0 is the chunk as is, codec 1 is one zstd frame
//           that declares its content size. A writer may compress (D-4: writers here emit codec
//           0); a reader decodes both. K_chunk is per chunk id, but one id can be sealed with
//           different bodies, so the nonce is synthetic: HMAC-SHA256(K_chunk, 0x01 | codec |
//           body)[0:12]. The reader takes the nonce from the object and recomputes it after the
//           tag opens.
//
// :core links no zstd: a codec 1 object needs the caller's [ZstdDecode] (`LibZstd.decode` from
// :packs, or the :zstd module's). Without one a codec 1 object is [SyncChunks.Invalid.DECODE].

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_CDC_MAX_BYTES

/** A zstd decoder for one frame with its content size. It may throw; any failure is [SyncChunks.Invalid.DECODE]. */
public typealias ZstdDecode = (frame: ByteArray, size: Int) -> ByteArray

/** A refusal on its way out of [SyncChunks.open]; it never leaves this file. */
private class Refusal(val reason: SyncChunks.Invalid) : Exception(reason.wire)

private fun need(ok: Boolean, reason: SyncChunks.Invalid) {
    if (!ok) throw Refusal(reason)
}

private fun <T : Any> required(value: T?, reason: SyncChunks.Invalid): T = value ?: throw Refusal(reason)

public object SyncChunks {
    public const val OBJECT_VERSION: Int = 0x01
    public const val CODEC_RAW: Int = 0
    public const val CODEC_ZSTD: Int = 1

    /** Version, codec, nonce and the tag: the smallest object (an empty body). */
    public const val OBJECT_MIN_BYTES: Int = 2 + SyncCrypto.NONCE_BYTES + SyncCrypto.TAG_BYTES
    private const val HEADER_BYTES = 2
    private const val ID_BYTES = 32
    private const val ID_HEX_LENGTH = 64
    private const val BYTE_MASK = 0xff
    private const val NIBBLE_BITS = 4
    private const val HEX_ALPHA = 10

    /** Why a reader refuses a chunk object, in the order it checks; [wire] is the corpus's word. */
    public enum class Invalid(public val wire: String) {
        SHAPE("shape"),
        VERSION("version"),
        CODEC("codec"),
        AUTH("auth"),
        NONCE("nonce"),
        DECODE("decode"),
        SIZE("size"),
        ID("id"),
    }

    public sealed class Opened {
        public class Ok(public val plain: ByteArray, public val codec: Int) : Opened()

        public class Refused(public val reason: Invalid) : Opened()
    }

    /** 32 raw bytes of a chunk id, or null when the text is not 64 lowercase hex characters. */
    public fun idBytes(hex: String): ByteArray? {
        fun nibble(c: Char): Int? = when (c) {
            in '0'..'9' -> c - '0'
            in 'a'..'f' -> c - 'a' + HEX_ALPHA
            else -> null
        }
        val nibbles = hex.map { nibble(it) }
        return if (hex.length != ID_HEX_LENGTH || nibbles.any { it == null }) {
            null
        } else {
            ByteArray(ID_BYTES) { ((nibbles[it * 2]!! shl NIBBLE_BITS) or nibbles[it * 2 + 1]!!).toByte() }
        }
    }

    /** [bytes] as lowercase hex, 64 characters for an id. */
    public fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /**
     * The id of a plaintext chunk. [root] is the ring root in E2E mode; null is server mode, where
     * the id is the plain SHA-256.
     */
    public fun chunkId(root: ByteArray?, collection: String, plain: ByteArray): ByteArray =
        if (root == null) SyncCrypto.sha256(plain) else SyncCrypto.hmac(SyncKeys.deriveChunkIdKey(root, collection), plain)

    /** [chunkId] as the 64-character hex of the wire. */
    public fun chunkIdHex(root: ByteArray?, collection: String, plain: ByteArray): String = hex(chunkId(root, collection, plain))

    private fun syntheticNonce(key: ByteArray, codec: Int, body: ByteArray): ByteArray =
        SyncCrypto.hmac(key, SyncCrypto.cat(byteArrayOf(OBJECT_VERSION.toByte(), codec.toByte()), body)).copyOf(SyncCrypto.NONCE_BYTES)

    private fun chunkKey(root: ByteArray, collection: String, id: ByteArray): ByteArray =
        SyncKeys.deriveChunkKey(SyncKeys.deriveCollKey(root, collection), id)

    /**
     * Seals [body] (the chunk for codec 0, one zstd frame for codec 1) as the object for [id]. The
     * caller computed [id] from the plaintext; [open] checks it again.
     */
    public fun seal(root: ByteArray, collection: String, id: ByteArray, codec: Int, body: ByteArray): ByteArray {
        val rootOk = root.size == SyncCrypto.ROOT_BYTES
        val idOk = id.size == ID_BYTES
        val codecOk = codec == CODEC_RAW || codec == CODEC_ZSTD
        if (!(rootOk && idOk && codecOk)) throw SyncCryptoException("bad root, chunk id or chunk codec")
        val head = byteArrayOf(OBJECT_VERSION.toByte(), codec.toByte())
        val key = chunkKey(root, collection, id)
        val nonce = syntheticNonce(key, codec, body)
        return SyncCrypto.cat(head, nonce, SyncCrypto.aesGcmSeal(key, SyncCrypto.cat(head, id), body, nonce))
    }

    private fun decodeBody(body: ByteArray, decode: ZstdDecode?): ByteArray {
        val size = required(SyncZstdFrame.contentSize(body), Invalid.DECODE)
        val decoder = required(decode, Invalid.DECODE)
        need(size <= SYNC_CDC_MAX_BYTES, Invalid.SIZE)
        val plain = required(runCatching { decoder(body, size) }.getOrNull(), Invalid.DECODE)
        need(plain.size == size, Invalid.DECODE)
        return plain
    }

    /**
     * Opens the object for [id] in [collection]. The checks run in the order of [Invalid]: shape,
     * version, codec, the tag (which covers the codec and the id), the nonce, the zstd frame (it
     * must declare a content size of at most `SYNC_CDC_MAX_BYTES`, checked before any decode), and
     * last that the keyed hash of the plaintext is [id].
     */
    public fun open(root: ByteArray, collection: String, id: ByteArray, obj: ByteArray, decode: ZstdDecode? = null): Opened = try {
        need(obj.size >= OBJECT_MIN_BYTES, Invalid.SHAPE)
        need((obj[0].toInt() and BYTE_MASK) == OBJECT_VERSION, Invalid.VERSION)
        val codec = obj[1].toInt() and BYTE_MASK
        need(codec == CODEC_RAW || codec == CODEC_ZSTD, Invalid.CODEC)
        need(id.size == ID_BYTES && root.size == SyncCrypto.ROOT_BYTES, Invalid.AUTH)
        val key = chunkKey(root, collection, id)
        val nonce = obj.copyOfRange(HEADER_BYTES, HEADER_BYTES + SyncCrypto.NONCE_BYTES)
        val sealed = obj.copyOfRange(HEADER_BYTES + SyncCrypto.NONCE_BYTES, obj.size)
        val body = required(SyncCrypto.aesGcmOpen(key, SyncCrypto.cat(obj.copyOfRange(0, HEADER_BYTES), id), sealed, nonce), Invalid.AUTH)
        need(SyncCrypto.equalBytes(syntheticNonce(key, codec, body), nonce), Invalid.NONCE)
        val plain = if (codec == CODEC_RAW) body else decodeBody(body, decode)
        need(plain.size <= SYNC_CDC_MAX_BYTES, Invalid.SIZE)
        need(SyncCrypto.equalBytes(chunkId(root, collection, plain), id), Invalid.ID)
        Opened.Ok(plain, codec)
    } catch (r: Refusal) {
        Opened.Refused(r.reason)
    }
}
