// The default UpdateSlots and BootGuardStore for a JVM host (UK-40, SP-K12; PARITY §5.5 note 9): the
// boot guard's slots as directories, Godot's `user://updates/` layout (P3-10) on java.io.
//
//   <root>/staged/   payload + meta.json   what the host staged (stage())
//   <root>/current/  payload + meta.json   the applied update the host loads (payload("current"))
//   <root>/previous/ payload + meta.json   what a rollback restores
//
// meta.json is `{"v":1,"version","sha256","size","engine","scheme"}`. Every swap is a directory
// rename, ordered so an interrupted swap needs no journal: applyStaged drops `previous`, renames
// `current` → `previous` (only when `current` exists), then `staged` → `current`; a crash between
// the last two leaves no `current` and the verified `staged`, which the next launch applies again
// without touching `previous`. rollBack drops `current` and renames `previous` → `current`.
//
// A desktop app that updates through installers (DesktopInstallDriver) stages nothing, so the guard
// counts nothing and every launch is `ok`; a host that swaps its own payloads (a launcher's app JAR,
// a content archive) stages them here and the guard applies, counts and rolls back.

package im.plrs.key.update

import im.plrs.key.core.JsonText
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import java.io.File
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** [UpdateSlots] over directories under [root] (see the file comment). */
public class DirUpdateSlots(public val root: File) : UpdateSlots {
    private fun slotDir(slot: String): File {
        require(slot in SLOTS) { "slot must be one of ${SLOTS.joinToString(", ")}" }
        return File(root, slot)
    }

    /** The payload file of [slot], or null when the slot is empty. */
    public fun payload(slot: String): File? = File(slotDir(slot), PAYLOAD).takeIf { it.isFile && meta(slot) != null }

    override fun current(): SlotMeta? = meta("current")

    override fun staged(): SlotMeta? = meta("staged")

    override fun previous(): SlotMeta? = meta("previous")

    override fun drop(slot: String) {
        slotDir(slot).deleteRecursively()
    }

    override suspend fun verifyStaged(): Boolean = withContext(Dispatchers.IO) {
        val meta = staged() ?: return@withContext false
        val file = File(slotDir("staged"), PAYLOAD)
        file.isFile && file.length() == meta.size && DesktopInstallDriver.sha256(file).equals(meta.sha256, ignoreCase = true)
    }

    override suspend fun applyStaged(): Boolean = withContext(Dispatchers.IO) {
        val staged = slotDir("staged")
        if (meta("staged") == null) return@withContext false
        val current = slotDir("current")
        val previous = slotDir("previous")
        if (current.isDirectory) {
            previous.deleteRecursively()
            if (!rename(current, previous)) return@withContext false
        }
        rename(staged, current)
    }

    override suspend fun rollBack(): Boolean = withContext(Dispatchers.IO) {
        val previous = slotDir("previous")
        if (meta("previous") == null) return@withContext false
        val current = slotDir("current")
        current.deleteRecursively()
        rename(previous, current)
    }

    /**
     * Stage [payload] as [meta] (copied, then renamed into `staged` whole), replacing anything
     * staged. Verify it against the signed record first; the guard verifies it again at launch.
     */
    public suspend fun stage(payload: File, meta: SlotMeta): Unit = withContext(Dispatchers.IO) {
        root.mkdirs()
        val tmp = File(root, ".staging-${UUID.randomUUID()}")
        try {
            tmp.mkdirs()
            Files.copy(payload.toPath(), File(tmp, PAYLOAD).toPath(), StandardCopyOption.REPLACE_EXISTING)
            File(tmp, META).writeText(metaJson(meta))
            val staged = slotDir("staged")
            staged.deleteRecursively()
            if (!rename(tmp, staged)) throw IOException("could not stage into $staged")
        } finally {
            tmp.deleteRecursively()
        }
    }

    private fun meta(slot: String): SlotMeta? {
        val f = File(slotDir(slot), META)
        if (!f.isFile) return null
        val o = try {
            JsonText.parseOrNull(f.readText()).objectValue
        } catch (e: IOException) {
            null
        } ?: return null
        if (o["v"].longValue != 1L) return null
        return SlotMeta(
            version = o["version"].stringValue ?: return null,
            sha256 = o["sha256"].stringValue ?: return null,
            size = o["size"].longValue ?: return null,
            engine = o["engine"].stringValue,
            scheme = o["scheme"].stringValue ?: "semver",
        )
    }

    private fun rename(from: File, to: File): Boolean = try {
        try {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE)
        } catch (e: AtomicMoveNotSupportedException) {
            Files.move(from.toPath(), to.toPath())
        }
        true
    } catch (e: IOException) {
        false
    }

    public companion object {
        public val SLOTS: List<String> = listOf("staged", "current", "previous")
        public const val PAYLOAD: String = "payload"
        public const val META: String = "meta.json"

        internal fun metaJson(meta: SlotMeta): String = buildJsonObject {
            put("v", jsonInt(1))
            put("version", JsonPrimitive(meta.version))
            put("sha256", JsonPrimitive(meta.sha256.lowercase()))
            put("size", jsonInt(meta.size))
            put("engine", meta.engine?.let { JsonPrimitive(it) } ?: JsonNull)
            put("scheme", JsonPrimitive(meta.scheme))
        }.toString()
    }
}

/** [BootGuardStore] as one file (`<data dir>/updates/state.json`), replaced atomically. */
public class FileBootGuardStore(public val file: File) : BootGuardStore {
    override fun read(): String? = try {
        if (file.isFile) file.readText() else null
    } catch (e: IOException) {
        null
    }

    override fun write(text: String) {
        val dir = file.absoluteFile.parentFile
        dir.mkdirs()
        val tmp = File(dir, ".${file.name}.${UUID.randomUUID()}.tmp")
        try {
            tmp.writeText(text)
            try {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (e: AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            tmp.delete()
        }
    }
}
