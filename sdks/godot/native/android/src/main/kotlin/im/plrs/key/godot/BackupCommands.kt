package im.plrs.key.godot

import android.util.Base64
import im.plrs.key.platform.PlatformBackup
import im.plrs.key.platform.PlatformBackupRead
import im.plrs.key.platform.PlatformBackupWrite
import org.json.JSONObject

/**
 * The backup ops of the Godot plugin (I-49.14), over `:platform`'s [PlatformBackup] (Block Store in `play`,
 * Unavailable in `direct`). They hold the silent-restore item and the Cloud Sync root (I-49):
 *
 * - `bk_info`: `{supported}` now; the event adds `cloud` (whether an item written now reaches the cloud, which
 *   is only when end-to-end encryption is available).
 * - `bk_get {kind, product}`: the event is `{ok: true, found: false}` or `{ok: true, found: true, value}` (base64).
 * - `bk_set {kind, product, value}`: `value` is base64 and at most 4096 bytes. The event is `{ok: true, cloud}`.
 * - `bk_delete {kind, product}`: the event is `{ok: true}`; a missing item is not an error.
 *
 * `kind` is `restore` or `sync` and `product` a product slug; the plugin builds the one key per product
 * (`pkey-restore-<product>`, `pkey-sync-<product>`), because an app may hold 16 entries in all. A sync item's
 * subject and ring id travel inside its value.
 *
 * Each op answers `{ok: true, req}` at once and its result arrives as a queued event. A failure is
 * `{ok: false, error: "unavailable" | "refused", reason}` where `reason` is one of [PlatformBackup]'s fixed words
 * (`outlet`, `no-play-services`, `unsupported`, `full`, `failed`, `bad-key`, `too-large`), never provider text.
 * A malformed request is refused at once with `bad_input`. The value is a secret: no event, error or log
 * names it except a `bk_get` result's `value`.
 */
class BackupCommands(private val c: Commands, private val backup: () -> PlatformBackup) {
    private val resolved: PlatformBackup? by lazy {
        try {
            backup()
        } catch (e: LinkageError) {
            null
        }
    }

    /** Whether the ops can store anything in this build (the `platformBackup` capability). */
    fun available(): Boolean = resolved?.isSupported == true

    fun handle(op: String, q: JSONObject): JSONObject {
        if (op == "bk_info") return info()
        val key = key(q) ?: return Commands.fail("bad_input", null)
        return when (op) {
            "bk_get" -> get(key)
            "bk_set" -> {
                val bytes = value(q) ?: return Commands.fail("bad_input", null)
                set(key, bytes)
            }
            else -> delete(key)
        }
    }

    private fun info(): JSONObject = c.async { done ->
        val b = resolved
        if (b == null || !b.isSupported) {
            done(JSONObject().put("ok", true).put("supported", false).put("cloud", false))
        } else {
            b.cloudBackup { cloud -> done(JSONObject().put("ok", true).put("supported", true).put("cloud", cloud)) }
        }
    }

    private fun get(key: String): JSONObject = c.async { done ->
        val b = resolved ?: return@async done(unavailable(NO_CLASS))
        b.get(key) { r ->
            done(
                when (r) {
                    is PlatformBackupRead.Found -> JSONObject().put("ok", true).put("found", true).put("value", Base64.encodeToString(r.bytes, Base64.NO_WRAP))
                    PlatformBackupRead.Missing -> JSONObject().put("ok", true).put("found", false)
                    is PlatformBackupRead.Unavailable -> unavailable(r.reason)
                    is PlatformBackupRead.Refused -> refused(r.reason)
                },
            )
        }
    }

    private fun set(key: String, bytes: ByteArray): JSONObject = c.async { done ->
        val b = resolved ?: return@async done(unavailable(NO_CLASS))
        b.set(key, bytes) { r -> done(written(r)) }
    }

    private fun delete(key: String): JSONObject = c.async { done ->
        val b = resolved ?: return@async done(unavailable(NO_CLASS))
        b.delete(key) { r -> done(written(r)) }
    }

    private fun written(r: PlatformBackupWrite): JSONObject = when (r) {
        is PlatformBackupWrite.Done -> JSONObject().put("ok", true).put("cloud", r.cloud)
        is PlatformBackupWrite.Unavailable -> unavailable(r.reason)
        is PlatformBackupWrite.Refused -> refused(r.reason)
    }

    private fun unavailable(reason: String): JSONObject = Commands.fail("unavailable", null).put("reason", reason)

    private fun refused(reason: String): JSONObject = Commands.fail("refused", null).put("reason", reason)

    /** The Block Store key of `q.kind` and `q.product`, or null when either is not what the ops take. */
    private fun key(q: JSONObject): String? {
        val product = q.optString("product")
        if (!PRODUCT.matches(product)) return null
        return when (q.optString("kind")) {
            "restore" -> PlatformBackup.RESTORE_PREFIX + product
            "sync" -> PlatformBackup.SYNC_PREFIX + product
            else -> null
        }
    }

    private fun value(q: JSONObject): ByteArray? {
        val raw = q.optString("value")
        if (raw.isEmpty()) return null
        return try {
            Base64.decode(raw, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    companion object {
        val OPS = setOf("bk_info", "bk_get", "bk_set", "bk_delete")

        /** A product slug: lower-case letters, digits and hyphens, at most 64. */
        private val PRODUCT = Regex("[a-z0-9][a-z0-9-]{0,63}")
        private const val NO_CLASS = "no-play-services"
    }
}
