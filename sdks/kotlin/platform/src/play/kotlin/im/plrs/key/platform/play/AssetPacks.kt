package im.plrs.key.platform.play

import android.app.Activity
import android.content.Context
import com.google.android.play.core.assetpacks.AssetPackException
import com.google.android.play.core.assetpacks.AssetPackManager
import com.google.android.play.core.assetpacks.AssetPackManagerFactory
import com.google.android.play.core.assetpacks.AssetPackState
import com.google.android.play.core.assetpacks.AssetPackStateUpdateListener
import com.google.android.play.core.assetpacks.model.AssetPackStatus
import com.google.android.play.core.assetpacks.model.AssetPackStorageMethod
import org.json.JSONObject

/** One asset pack's state (`AssetPackState`). [status] is an `AssetPackStatus`. */
public data class PackState(
    val name: String,
    /** 0 unknown, 1 pending, 2 downloading, 3 transferring, 4 completed, 5 failed, 6 canceled, 7 waiting for Wi-Fi, 8 not installed, 9 requires user confirmation. */
    val status: Int,
    val errorCode: Int,
    val bytesDownloaded: Long,
    val totalBytes: Long,
    val transferPercent: Int,
) {
    /** WAITING_FOR_WIFI or REQUIRES_USER_CONFIRMATION: show [AssetPacks.confirm] to continue. */
    val needsConfirmation: Boolean
        get() = status == AssetPackStatus.WAITING_FOR_WIFI || status == AssetPackStatus.REQUIRES_USER_CONFIRMATION

    public fun toJson(): JSONObject = JSONObject()
        .put("name", name)
        .put("status", status)
        .put("errorCode", errorCode)
        .put("bytesDownloaded", bytesDownloaded)
        .put("totalBytes", totalBytes)
        .put("transferPercent", transferPercent)
        .put("needsConfirmation", needsConfirmation)

    public companion object {
        public fun of(s: AssetPackState): PackState = PackState(
            s.name(), s.status(), s.errorCode(), s.bytesDownloaded(), s.totalBytesToDownload(), s.transferProgressPercentage(),
        )
    }
}

/**
 * Where a pack is (`AssetPackLocation`). A fast-follow or on-demand pack that completed is a plain
 * directory under `files/assetpacks/<pack>/<versionCode>/<versionCode>/assets` (STORAGE_FILES); the
 * path holds the versionCode, so re-read it on every launch and never persist it (notes/S-05
 * §4.2). The install-time pack is APK_ASSETS with no path: Godot reaches it as `res://`.
 */
public data class PackLocation(val name: String, val storageMethod: Int, val assetsPath: String?, val path: String?) {
    /** The install-time pack (inside the APK splits): mount it from `res://`, not a file. */
    val installTime: Boolean get() = storageMethod == AssetPackStorageMethod.APK_ASSETS

    /** The absolute `<assetsPath>/<name>.pck` to mount, or null when the pack is not a file on disk. */
    val pckPath: String?
        get() = if (storageMethod == AssetPackStorageMethod.STORAGE_FILES && !assetsPath.isNullOrEmpty()) "$assetsPath/$name.pck" else null

    public fun toJson(): JSONObject = JSONObject()
        .put("name", name)
        .put("storageMethod", storageMethod)
        .put("assetsPath", assetsPath ?: JSONObject.NULL)
        .put("path", path ?: JSONObject.NULL)
        .put("installTime", installTime)
        .put("pck", pckPath ?: JSONObject.NULL)
}

/** A pack call failed. [errorCode] is the `AssetPackErrorCode` when Play gave one. */
public class PackError(public val exception: String, message: String?, public val errorCode: Int?) : Exception(message) {
    public fun toJson(): JSONObject = JSONObject()
        .put("error", "pack_failed")
        .put("exception", exception)
        .put("message", message ?: JSONObject.NULL)
        .put("errorCode", errorCode ?: JSONObject.NULL)

    public companion object {
        public fun of(e: Exception?): PackError =
            PackError(e?.javaClass?.name ?: "null", e?.message, (e as? AssetPackException)?.errorCode)
    }
}

/**
 * The single-pack surface [AssetPacks] needs, so it can be faked (Play Core 2.3.0 ships no fake
 * asset-pack manager). [PlayPackManager] adapts the real `AssetPackManager`. Callbacks run on
 * Android's main thread.
 */
public interface PackManager {
    public fun state(name: String, callback: (Result<PackState>) -> Unit)
    public fun fetch(name: String, callback: (Result<PackState>) -> Unit)
    public fun location(name: String): PackLocation?
    public fun remove(name: String, callback: (Result<Unit>) -> Unit)
    public fun cancel(name: String): PackState?
    public fun confirm(activity: Activity, callback: (Result<Int>) -> Unit)
    public fun listen(listener: (PackState) -> Unit)
    public fun unlisten(listener: (PackState) -> Unit)
}

/** [PackManager] over Play Core's `AssetPackManager`, one pack per call. */
public class PlayPackManager(private val m: AssetPackManager) : PackManager {
    public constructor(context: Context) : this(AssetPackManagerFactory.getInstance(context))

    private val listeners = mutableMapOf<(PackState) -> Unit, AssetPackStateUpdateListener>()

    override fun state(name: String, callback: (Result<PackState>) -> Unit) {
        guard(callback) {
            m.getPackStates(listOf(name)).addOnCompleteListener { t ->
                callback(if (t.isSuccessful) pick(name, t.result?.packStates()) else Result.failure(PackError.of(t.exception)))
            }
        }
    }

    override fun fetch(name: String, callback: (Result<PackState>) -> Unit) {
        guard(callback) {
            m.fetch(listOf(name)).addOnCompleteListener { t ->
                callback(if (t.isSuccessful) pick(name, t.result?.packStates()) else Result.failure(PackError.of(t.exception)))
            }
        }
    }

    override fun location(name: String): PackLocation? =
        m.getPackLocation(name)?.let { PackLocation(name, it.packStorageMethod(), it.assetsPath(), it.path()) }

    override fun remove(name: String, callback: (Result<Unit>) -> Unit) {
        guard(callback) {
            m.removePack(name).addOnCompleteListener { t ->
                callback(if (t.isSuccessful) Result.success(Unit) else Result.failure(PackError.of(t.exception)))
            }
        }
    }

    override fun cancel(name: String): PackState? = m.cancel(listOf(name)).packStates()[name]?.let { PackState.of(it) }

    override fun confirm(activity: Activity, callback: (Result<Int>) -> Unit) {
        guard(callback) {
            m.showConfirmationDialog(activity).addOnCompleteListener { t ->
                callback(if (t.isSuccessful) Result.success(t.result ?: 0) else Result.failure(PackError.of(t.exception)))
            }
        }
    }

    override fun listen(listener: (PackState) -> Unit) {
        if (listeners.containsKey(listener)) return
        val l = AssetPackStateUpdateListener { s -> listener(PackState.of(s)) }
        listeners[listener] = l
        m.registerListener(l)
    }

    override fun unlisten(listener: (PackState) -> Unit) {
        listeners.remove(listener)?.let { m.unregisterListener(it) }
    }

    private fun pick(name: String, states: Map<String, AssetPackState>?): Result<PackState> {
        val s = states?.get(name) ?: return Result.failure(PackError("missing", "no state for $name", null))
        return Result.success(PackState.of(s))
    }

    private fun <T> guard(callback: (Result<T>) -> Unit, block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            callback(Result.failure(PackError.of(e)))
        }
    }
}

/**
 * Play Asset Delivery for fast-follow and on-demand packs (Godot itself only handles the single
 * install-time pack). The rules from notes/S-10 §2:
 *
 *  - ONE pack per call: one unknown name fails a whole `fetch`/`getPackStates` batch. Names are
 *    checked here first (a Play pack name: a letter, then letters, digits and underscores), and
 *    against [known] when the build lists its packs.
 *  - State comes from the listener ([listen]); the `fetch` result only says the request was
 *    accepted (it answers PENDING).
 *  - After COMPLETED, mount [PackLocation.pckPath]. APK_ASSETS or an empty path means "not a file":
 *    the install-time pack (Godot's `res://`), or not available.
 *  - WAITING_FOR_WIFI and REQUIRES_USER_CONFIRMATION continue only after [confirm].
 */
public class AssetPacks(private val manager: PackManager, private val known: Set<String>? = null) {
    public constructor(context: Context, known: Set<String>? = null) : this(PlayPackManager(context), known)

    public fun state(name: String, callback: (Result<PackState>) -> Unit) {
        refusal(name)?.let { return callback(Result.failure(it)) }
        manager.state(name, callback)
    }

    public fun fetch(name: String, callback: (Result<PackState>) -> Unit) {
        refusal(name)?.let { return callback(Result.failure(it)) }
        manager.fetch(name, callback)
    }

    /** The pack's location now (null when it is not on the device). Never persist it. */
    public fun location(name: String): PackLocation? {
        refusal(name)?.let { throw it }
        return manager.location(name)
    }

    public fun remove(name: String, callback: (Result<Unit>) -> Unit) {
        refusal(name)?.let { return callback(Result.failure(it)) }
        manager.remove(name, callback)
    }

    public fun cancel(name: String): PackState? {
        refusal(name)?.let { throw it }
        return manager.cancel(name)
    }

    public fun confirm(activity: Activity, callback: (Result<Int>) -> Unit): Unit = manager.confirm(activity, callback)

    public fun listen(listener: (PackState) -> Unit): Unit = manager.listen(listener)

    public fun unlisten(listener: (PackState) -> Unit): Unit = manager.unlisten(listener)

    private fun refusal(name: String): PackError? = when {
        !isPackName(name) -> PackError("invalid-name", "not a Play asset pack name: \"$name\"", null)
        known != null && name !in known -> PackError("unknown-pack", "\"$name\" is not one of this build's packs", null)
        else -> null
    }

    public companion object {
        private val NAME = Regex("^[A-Za-z][A-Za-z0-9_]{0,127}$")

        public fun isPackName(name: String): Boolean = NAME.matches(name)
    }
}
