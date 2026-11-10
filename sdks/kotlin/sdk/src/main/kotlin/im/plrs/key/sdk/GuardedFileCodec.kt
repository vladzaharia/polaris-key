// The key ring's file codec for one collection (U-22.5): the E2E codec over the root held now, behind a guard that
// re-checks, on every call and every stream piece, that this root is still the ring's. Once the ring locks, nothing
// is sealed or opened under it: the transfer stops with `sync-locked` rather than carry on under a root the ring has let go.

package im.plrs.key.sdk

import im.plrs.key.core.sync.ExportFileOpener

@Suppress("TooManyFunctions")
internal class GuardedFileCodec(private val inner: FileCodec, private val live: () -> Boolean) : FileCodec {
    private fun check() {
        if (!live()) throw lockedError()
    }

    override val enc: String get() = inner.enc

    override fun chunkId(plain: ByteArray): ByteArray = inner.also { check() }.chunkId(plain)

    override fun chunkObjectBytes(plainLen: Int): Int = inner.also { check() }.chunkObjectBytes(plainLen)

    override fun sealChunk(id: ByteArray, plain: ByteArray): ByteArray = inner.also { check() }.sealChunk(id, plain)

    override fun openChunk(id: ByteArray, obj: ByteArray): FileOpened = inner.also { check() }.openChunk(id, obj)

    override fun storedSize(plainSize: Long): Long = inner.also { check() }.storedSize(plainSize)

    override fun plainSize(storedSize: Long): Long? = inner.also { check() }.plainSize(storedSize)

    override fun sealManifest(plain: ByteArray): ByteArray = inner.also { check() }.sealManifest(plain)

    override fun openManifest(stored: ByteArray): FileOpened = inner.also { check() }.openManifest(stored)

    override fun sealWhole(plain: ByteArray): ByteArray = inner.also { check() }.sealWhole(plain)

    override fun newPlannedOpener(plainSize: Long): ExportFileOpener {
        check()
        val opener = inner.newPlannedOpener(plainSize)
        return object : ExportFileOpener {
            override fun push(data: ByteArray): List<ByteArray> = opener.also { check() }.push(data)

            override fun finish() = opener.also { check() }.finish()
        }
    }

    override fun newOpener(): FileOpener {
        check()
        val opener = inner.newOpener()
        return object : FileOpener {
            override fun push(data: ByteArray): List<ByteArray> = opener.also { check() }.push(data)

            override fun finish(): ByteArray = opener.also { check() }.finish()
        }
    }
}
