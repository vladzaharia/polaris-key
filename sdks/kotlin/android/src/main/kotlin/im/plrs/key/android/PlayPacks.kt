// packs.transport.play (P6-12): Play Asset Delivery as a pack transport, P5-08's `play-pad` (Godot's
// PKeyPackPlayPadTransport) on the Kotlin pack engine. The flavour-neutral surface lives here so an
// app compiles against both flavours: the play build's transport is PadPackTransport (src/play), the
// direct build's answers the typed `outlet` N/A (it carries no Play Core).
//
// The layering rule (CONTENT §7): the platform moves the bytes, Polaris Key keeps the identity.
// After Play says a pack is COMPLETED, the transport reads the pack's directory FRESH and hands the
// pack facet an embedded baseline (PacksOptions.embedded), the same shape an embedded pack has: a
// single container `<dir>/X` with its marker `<dir>/X.pkey.json`, or a tree `<dir>/` with
// `<dir>/.pkey/pack.json`. :packs then verifies the marker with the release-record verifier and
// matches the bytes against the signed record and the content stamp's pin; Play's own hashes are
// never trusted. The transport never writes into Play's directory.
//
// Play's path holds the versionCode (`files/assetpacks/<pack>/<vc>/<vc>/assets`), so it is re-read on
// every call and NEVER persisted (notes/S-05 §4.2, P5-06). The Play asset-pack name of a pack id
// replaces `.` and `-` with `_` (`diceroll.foes` -> `diceroll_foes`, the mapping of
// `@polaris-key/manifest`'s padPackName and `pkey transport play-pad modules`); the module carries the
// payload under `assets/pkey/`, or under `assets/pkey#tcf_<format>/` per texture format, and Play
// delivers one of them. Play asset packs change only with a new app bundle, so a pack delivered this
// way is the build's pinned release (CONTENT §6.6): the stamp-pin match refuses any other.

package im.plrs.key.android

import im.plrs.key.core.Unsupported
import im.plrs.key.packs.EmbeddedPack
import java.io.File

/** One Play asset pack's state, as Play reported it (`AssetPackState`). */
public data class PlayPackState(
    val name: String,
    /** `AssetPackStatus`: 1 pending, 2 downloading, 3 transferring, 4 completed, 5 failed, 6 canceled, 7 waiting for Wi-Fi, 8 not installed, 9 requires user confirmation. */
    val status: Int,
    val errorCode: Int,
    val bytesDownloaded: Long,
    val totalBytes: Long,
) {
    public companion object {
        public const val PENDING: Int = 1
        public const val DOWNLOADING: Int = 2
        public const val TRANSFERRING: Int = 3
        public const val COMPLETED: Int = 4
        public const val FAILED: Int = 5
        public const val CANCELED: Int = 6
        public const val WAITING_FOR_WIFI: Int = 7
        public const val NOT_INSTALLED: Int = 8
        public const val REQUIRES_USER_CONFIRMATION: Int = 9
    }
}

/** What [PlayPackTransport.ensure] answers. */
public sealed interface PlayPackResult {
    /** Play holds the pack; it mounts from [PlayPackTransport.installed] at the pack facet's next start. */
    public data class Completed(val state: PlayPackState) : PlayPackResult

    /** Play stopped, the player declined, or the wait ran out; [code] is a registry code. */
    public data class Failed(val code: String, val detail: String, val state: PlayPackState? = null) : PlayPackResult

    /** This build cannot deliver packs through Play (the typed N/A: `outlet` on a direct build). */
    public data class NotSupported(val unsupported: Unsupported) : PlayPackResult
}

/** Play Asset Delivery as a pack transport (`play-pad`). [PlayPackTransport.create] picks this build's. */
public interface PlayPackTransport {
    /** The pack ids this transport carries on this install. */
    public val packs: List<String>

    /** Null when Play can deliver packs here, else why not (`outlet` on a direct build). */
    public fun availability(): Unsupported?

    /** Every carried pack Play holds NOW, as embedded baselines for `PacksOptions.embedded`. Never persist the paths. */
    public fun installed(): List<EmbeddedPack>

    /**
     * Ask Play for [packId] and wait until it is COMPLETED. WAITING_FOR_WIFI and
     * REQUIRES_USER_CONFIRMATION ask the confirm hook first (the game's own size disclosure), then
     * show Play's dialog; a declined hook cancels the download (`cancelled`).
     */
    public suspend fun ensure(packId: String): PlayPackResult

    public companion object {
        /** The transport id this implements (`Transport.playPad`). */
        public const val ID: String = im.plrs.key.core.Transport.playPad

        /** The directory below a pack's assets path that holds its payload. */
        public const val PREFIX: String = "pkey"

        /** A single-file payload's marker suffix and a tree's marker path (WIRE-CONTRACT-V4 §3.7). */
        public const val MARKER_SUFFIX: String = ".pkey.json"
        public const val TREE_MARKER: String = ".pkey/pack.json"

        /** The Play asset-pack name of [packId]. */
        public fun padName(packId: String): String = packId.replace('.', '_').replace('-', '_')

        /** The payload directory under a pack's `assetsPath`: `pkey/`, else the first `pkey#tcf_*`; null when neither. */
        public fun payloadDir(assetsPath: String): File? {
            val assets = File(assetsPath)
            val dirs = assets.listFiles { f -> f.isDirectory }?.map { it.name }?.sorted() ?: return null
            if (PREFIX in dirs) return File(assets, PREFIX)
            return dirs.firstOrNull { it.startsWith("$PREFIX#tcf_") }?.let { File(assets, it) }
        }

        /**
         * The baseline one payload directory holds: a single container whose marker sits beside it,
         * else a tree with `.pkey/pack.json`. Null when it holds neither (or two markers: ambiguous).
         */
        public fun probe(dir: File): EmbeddedPack? {
            val files = dir.listFiles { f -> f.isFile }?.map { it.name } ?: return null
            val markers = files.filter { it.endsWith(MARKER_SUFFIX) }
            if (markers.size > 1) return null
            if (markers.size == 1) {
                val payload = File(dir, markers[0].removeSuffix(MARKER_SUFFIX))
                return if (payload.isFile) EmbeddedPack(payload, File(dir, markers[0])) else null
            }
            return if (File(dir, TREE_MARKER).isFile) EmbeddedPack(dir) else null
        }

        /** This build's transport: Play Asset Delivery on a play build, the typed `outlet` N/A on a direct one. */
        public fun create(
            context: android.content.Context,
            packs: List<String>,
            activity: () -> android.app.Activity? = { null },
            confirm: (suspend (packId: String, state: PlayPackState) -> Boolean)? = null,
        ): PlayPackTransport = FlavorAndroid.playPacks(context, packs, activity, confirm)
    }
}
