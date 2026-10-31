// What the transfer engine needs to know about how a collection stores its files (U-23.K4): the chunk ids, the
// chunk objects and the stored form of a manifest or a whole file. A port of Python
// `cloud_sync/transfer_codec.py`. The engine moves stored bytes and checks hashes; a [FileCodec] is the one place
// that knows whether those bytes are sealed.
//
//   E2eFileCodec     ids are HMAC-SHA256 under K_cid(c); chunks are `pkey-sync-chunk/1` objects (§13.8.3); a
//                    manifest and a whole file are `pkey-sync-file/1` streams
//   ServerFileCodec  ids are the plain SHA-256; a chunk object is `0x00 | codec | body` (D-5); a manifest and a
//                    file are stored as they are
//
// Writers emit codec 0 (raw) chunks only (D-4); readers decode codecs 0 and 1. A zstd body declares its content
// size, which is checked before any decode, and is decoded by libzstd through zstd-jni ([libZstdDecode], the
// `:packs` backend); a runtime without it refuses a codec 1 chunk as `decode`.

package im.plrs.key.sdk

import im.plrs.key.core.SYNC_CDC_MAX_BYTES
import im.plrs.key.core.sync.SyncChunks
import im.plrs.key.core.sync.SyncCrypto
import im.plrs.key.core.sync.SyncFileStream
import im.plrs.key.core.sync.SyncKeys
import im.plrs.key.core.sync.SyncZstdFrame
import im.plrs.key.core.sync.ZstdDecode
import im.plrs.key.packs.selectZstd

/** The version byte of a server-mode chunk object. */
public const val SERVER_CHUNK_OBJECT_VERSION: Int = 0x00

private val libZstd by lazy { selectZstd().first }

/** libzstd for one chunk frame whose content size the caller already bounded; any failure throws. */
public val libZstdDecode: ZstdDecode = { frame, size -> libZstd.decode(frame, size) }

/** The answer of an opener: the plaintext, or the format's reason (the corpus's word). */
public sealed class FileOpened {
    public class Ok(public val plain: ByteArray) : FileOpened()

    public class Invalid(public val reason: String) : FileOpened()
}

/**
 * Opens one stored whole file as its bytes arrive: [push] returns the plaintext of each segment whose tag has
 * verified, [finish] the last. A piece is provisional until [finish] returns. Throws
 * [SyncFileStream.Failure].
 */
public interface FileOpener {
    public fun push(data: ByteArray): List<ByteArray>

    public fun finish(): ByteArray
}

public interface FileCodec {
    /** What `begin` calls it: `e2e` or `none`. */
    public val enc: String

    /** The 32 raw bytes of a plaintext chunk's id. */
    public fun chunkId(plain: ByteArray): ByteArray

    /** The size of the raw (codec 0) object for a chunk of [plainLen] bytes. */
    public fun chunkObjectBytes(plainLen: Int): Int

    public fun sealChunk(id: ByteArray, plain: ByteArray): ByteArray

    /** Opens a stored object for [id]: every check of the format, the id of the plaintext last. */
    public fun openChunk(id: ByteArray, obj: ByteArray): FileOpened

    /** The stored form of a file of [plainSize] bytes, as `begin` declares it. */
    public fun storedSize(plainSize: Long): Long

    /** The plaintext size a stored size implies, or null when none does. */
    public fun plainSize(storedSize: Long): Long?

    public fun sealManifest(plain: ByteArray): ByteArray

    public fun openManifest(stored: ByteArray): FileOpened

    /** The stored form of a whole file (a fresh salt every call). */
    public fun sealWhole(plain: ByteArray): ByteArray

    public fun newOpener(): FileOpener
}

/** The codec of a collection of an end-to-end product. [root] is the ring root; it is held, never printed. */
public class E2eFileCodec(private val root: ByteArray, private val collection: String, private val decode: ZstdDecode? = libZstdDecode) : FileCodec {
    private val collKey = SyncKeys.deriveCollKey(root, collection)
    private val kid = SyncKeys.deriveKid(root)

    override val enc: String get() = "e2e"

    override fun toString(): String = "E2eFileCodec(collection=$collection)"

    override fun chunkId(plain: ByteArray): ByteArray = SyncChunks.chunkId(root, collection, plain)

    override fun chunkObjectBytes(plainLen: Int): Int = plainLen + 30

    override fun sealChunk(id: ByteArray, plain: ByteArray): ByteArray = SyncChunks.seal(root, collection, id, SyncChunks.CODEC_RAW, plain)

    override fun openChunk(id: ByteArray, obj: ByteArray): FileOpened = when (val o = SyncChunks.open(root, collection, id, obj, decode)) {
        is SyncChunks.Opened.Ok -> FileOpened.Ok(o.plain)
        is SyncChunks.Opened.Refused -> FileOpened.Invalid(o.reason.wire)
    }

    override fun storedSize(plainSize: Long): Long = SyncFileStream.sealedSize(plainSize)

    override fun plainSize(storedSize: Long): Long? = SyncFileStream.plainSize(storedSize)

    override fun sealManifest(plain: ByteArray): ByteArray = sealWhole(plain)

    override fun sealWhole(plain: ByteArray): ByteArray = SyncFileStream.sealFile(collKey, kid, plain)

    override fun openManifest(stored: ByteArray): FileOpened = when (val o = SyncFileStream.openFile(collKey, kid, stored)) {
        is SyncFileStream.Opened.Ok -> FileOpened.Ok(o.plain)
        is SyncFileStream.Opened.Refused -> FileOpened.Invalid(o.reason.wire)
    }

    override fun newOpener(): FileOpener {
        val inner = SyncFileStream.Opener(collKey, kid)
        return object : FileOpener {
            override fun push(data: ByteArray): List<ByteArray> = inner.push(data)

            override fun finish(): ByteArray = inner.finish()
        }
    }
}

/** The codec of a collection of a server-mode product. */
public class ServerFileCodec(private val decode: ZstdDecode? = libZstdDecode) : FileCodec {
    override val enc: String get() = "none"

    override fun chunkId(plain: ByteArray): ByteArray = SyncCrypto.sha256(plain)

    override fun chunkObjectBytes(plainLen: Int): Int = plainLen + 2

    override fun sealChunk(id: ByteArray, plain: ByteArray): ByteArray {
        require(id.size == 32) { "chunk id length" }
        return byteArrayOf(SERVER_CHUNK_OBJECT_VERSION.toByte(), SyncChunks.CODEC_RAW.toByte()) + plain
    }

    override fun openChunk(id: ByteArray, obj: ByteArray): FileOpened {
        val reason: String? = when {
            obj.size < 2 -> "shape"
            obj.size > SERVER_CHUNK_MAX_STORED_BYTES -> "size"
            (obj[0].toInt() and 0xff) != SERVER_CHUNK_OBJECT_VERSION -> "version"
            (obj[1].toInt() and 0xff) != SyncChunks.CODEC_RAW && (obj[1].toInt() and 0xff) != SyncChunks.CODEC_ZSTD -> "codec"
            else -> null
        }
        if (reason != null) return FileOpened.Invalid(reason)
        val body = obj.copyOfRange(2, obj.size)
        val plain: ByteArray
        if ((obj[1].toInt() and 0xff) == SyncChunks.CODEC_RAW) {
            plain = body
        } else {
            val size = SyncZstdFrame.contentSize(body)
            val decoder = decode
            if (size == null || decoder == null) return FileOpened.Invalid("decode")
            if (size > SYNC_CDC_MAX_BYTES) return FileOpened.Invalid("size")
            val out = runCatching { decoder(body, size) }.getOrNull()
            if (out == null || out.size != size) return FileOpened.Invalid("decode")
            plain = out
        }
        return when {
            plain.size > SYNC_CDC_MAX_BYTES -> FileOpened.Invalid("size")
            !SyncCrypto.equalBytes(SyncCrypto.sha256(plain), id) -> FileOpened.Invalid("id")
            else -> FileOpened.Ok(plain)
        }
    }

    override fun storedSize(plainSize: Long): Long = plainSize

    override fun plainSize(storedSize: Long): Long? = storedSize

    override fun sealManifest(plain: ByteArray): ByteArray = plain.copyOf()

    override fun sealWhole(plain: ByteArray): ByteArray = plain.copyOf()

    override fun openManifest(stored: ByteArray): FileOpened = FileOpened.Ok(stored)

    override fun newOpener(): FileOpener = object : FileOpener {
        override fun push(data: ByteArray): List<ByteArray> = listOf(data)

        override fun finish(): ByteArray = ByteArray(0)
    }
}
