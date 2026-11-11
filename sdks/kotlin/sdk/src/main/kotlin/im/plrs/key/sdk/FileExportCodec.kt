// A collection's [FileCodec] as the export core reads it: the root stays inside the codec, which answers only plaintext.

package im.plrs.key.sdk

import im.plrs.key.core.sync.ExportFileCodec
import im.plrs.key.core.sync.ExportFileOpener

/** The export's view of [codec]: what a stored size means, and how a manifest, a chunk and a whole file open. */
public class FileExportCodec(private val codec: FileCodec) : ExportFileCodec {
    override fun storedSize(plainSize: Long): Long = codec.storedSize(plainSize)

    override fun plainSize(storedSize: Long): Long? = codec.plainSize(storedSize)

    override fun openManifest(stored: ByteArray): ByteArray? = (codec.openManifest(stored) as? FileOpened.Ok)?.plain

    override fun openChunk(id: ByteArray, obj: ByteArray): ByteArray? = (codec.openChunk(id, obj) as? FileOpened.Ok)?.plain

    override fun newPlannedOpener(plainSize: Long): ExportFileOpener = codec.newPlannedOpener(plainSize)
}
