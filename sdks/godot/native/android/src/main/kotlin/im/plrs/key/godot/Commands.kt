package im.plrs.key.godot

import android.app.Activity
import android.content.Context
import android.content.Intent
import im.plrs.key.platform.InstallSource
import im.plrs.key.platform.PolarisKeyPlatform
import im.plrs.key.platform.SecureStore
import im.plrs.key.platform.SecureStoreException
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** What the commands act through: the Godot plugin on a device, a Robolectric activity in tests. */
interface Host {
    val appContext: Context
    val foregroundActivity: Activity?

    /** Runs [r] on Android's main (UI) thread. */
    fun onUi(r: Runnable)
}

/**
 * Asynchronous results and unsolicited events, queued from any thread and drained by the GDScript
 * facade (PKeyAndroid) on Godot's main thread through the `poll` command, as the Apple binding does
 * (P5-05). It keeps the newest [capacity] events and counts the ones it dropped.
 */
class EventQueue(private val capacity: Int = 1024) {
    private val events = ArrayDeque<JSONObject>()
    private var dropped = 0

    @Synchronized
    fun push(event: JSONObject) {
        if (events.size >= capacity) {
            events.removeFirst()
            dropped++
        }
        events.addLast(event)
    }

    /** {events: [...], dropped: n} (n since the last drain). */
    @Synchronized
    fun drain(): JSONObject {
        val out = JSONObject().put("events", JSONArray(events.toList())).put("dropped", dropped)
        events.clear()
        dropped = 0
        return out
    }
}

/** The flavour's commands (In-App Updates and PAD in `play`, PackageInstaller in `direct`). */
abstract class FlavorCommands(protected val c: Commands) {
    /** The ops this flavour answers. */
    abstract val ops: Set<String>

    /** Adds this flavour's capability flags to [out]. */
    abstract fun capabilities(out: JSONObject)

    /** Answers [op] (one of [ops]) for request [q]. */
    abstract fun handle(op: String, q: JSONObject): JSONObject

    open fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {}

    open fun close() {}
}

/**
 * The JSON command surface of the Godot plugin: `cmd(json) -> json`, one request in, one reply out.
 * Every reply has `ok`; a failure has `error` (and `unsupported: true, reason` when the op belongs to
 * the other flavour, reason `outlet`). An asynchronous op answers `{ok: true, req}` at once and its
 * result arrives later as a queued event `{ev: "result", req, ok, …}`.
 *
 * Common ops: capabilities, install_source, ks_get / ks_set / ks_delete / ks_info, poll.
 * Unsolicited events: update_state, update_result, pack_state, install_status, resumed.
 *
 * Calls arrive on Godot's render thread (notes/S-10 §5); Play Core and activity work is posted to
 * the UI thread and slow work (hashing an APK) to a worker; none of it blocks the game.
 */
class Commands(val host: Host, flavorFactory: ((Commands) -> FlavorCommands)? = null) {
    val queue = EventQueue()
    private val nextReq = AtomicInteger(1)
    val worker: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "pkey-android-worker") }
    private val flavor: FlavorCommands = (flavorFactory ?: ::createFlavorCommands)(this)

    fun cmd(json: String): String = try {
        val q = JSONObject(json)
        handle(q.optString("op"), q).toString()
    } catch (e: JSONException) {
        fail("bad_request", e.message).toString()
    } catch (e: Exception) {
        fail("exception", "${e.javaClass.name}: ${e.message}").toString()
    }

    private fun handle(op: String, q: JSONObject): JSONObject = when (op) {
        "poll" -> queue.drain().put("ok", true)
        "capabilities" -> capabilities()
        "install_source" -> InstallSource.read(host.appContext).toJson().put("ok", true)
        "ks_get" -> store(q) { s ->
            val r = s.get(q.getString("account"))
            JSONObject().put("ok", true).put("value", r.value ?: JSONObject.NULL).put("reset", r.reset ?: JSONObject.NULL)
        }
        "ks_set" -> store(q) { s ->
            s.put(q.getString("account"), q.getString("value"))
            JSONObject().put("ok", true)
        }
        "ks_delete" -> store(q) { s -> JSONObject().put("ok", true).put("existed", s.delete(q.getString("account"))) }
        "ks_info" -> store(q) { s -> s.info().put("ok", true) }
        else -> when {
            op in flavor.ops -> flavor.handle(op, q)
            op in PLAY_OPS || op in DIRECT_OPS -> JSONObject()
                .put("ok", false)
                .put("unsupported", true)
                .put("reason", "outlet")
                .put("detail", "$op needs the ${if (op in PLAY_OPS) "play" else "direct"} build of polaris-key-platform; this is the ${PolarisKeyPlatform.flavor} build.")
            else -> fail("unknown_op", op)
        }
    }

    private fun capabilities(): JSONObject {
        val ctx = host.appContext
        val out = JSONObject()
            .put("ok", true)
            .put("protocol", PolarisKeyPlatform.PROTOCOL)
            .put("flavor", PolarisKeyPlatform.flavor)
            .put("sdk", android.os.Build.VERSION.SDK_INT)
            .put("package", ctx.packageName)
            .put("keystore", true)
            .put("inAppUpdates", false)
            .put("assetPacks", false)
            .put("packageInstaller", false)
            .put("playIntegrity", false)
        flavor.capabilities(out)
        return out
    }

    private fun store(q: JSONObject, block: (SecureStore) -> JSONObject): JSONObject = try {
        block(SecureStore(host.appContext, q.getString("product")))
    } catch (e: SecureStoreException) {
        fail("keystore", e.message).put("reason", e.reason)
    }

    /**
     * Starts an asynchronous op: answers `{ok: true, req}` now; [block] calls its argument once with
     * the result, from any thread, and that becomes the `{ev: "result", req, …}` event.
     */
    fun async(block: (done: (JSONObject) -> Unit) -> Unit): JSONObject {
        val req = nextReq.getAndIncrement()
        val once = java.util.concurrent.atomic.AtomicBoolean(false)
        val done: (JSONObject) -> Unit = { r ->
            if (once.compareAndSet(false, true)) queue.push(r.put("ev", "result").put("req", req))
        }
        try {
            block(done)
        } catch (e: Exception) {
            done(fail("exception", "${e.javaClass.name}: ${e.message}"))
        }
        return JSONObject().put("ok", true).put("req", req)
    }

    /** [async] with [block] run on the UI thread. */
    fun onUiAsync(block: (done: (JSONObject) -> Unit) -> Unit): JSONObject = async { done ->
        host.onUi {
            try {
                block(done)
            } catch (e: Exception) {
                done(fail("exception", "${e.javaClass.name}: ${e.message}"))
            }
        }
    }

    /** [async] with [block] run on the worker thread. */
    fun onWorkerAsync(block: () -> JSONObject): JSONObject = async { done ->
        worker.execute {
            done(
                try {
                    block()
                } catch (e: Exception) {
                    fail("exception", "${e.javaClass.name}: ${e.message}")
                },
            )
        }
    }

    fun event(name: String, body: JSONObject) {
        queue.push(body.put("ev", name))
    }

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) = flavor.onActivityResult(requestCode, resultCode, data)

    fun onResume() = event("resumed", JSONObject())

    fun close() {
        flavor.close()
        worker.shutdown()
    }

    companion object {
        val PLAY_OPS = setOf(
            "iau_check", "iau_start", "iau_complete", "pad_state", "pad_fetch", "pad_location", "pad_remove", "pad_cancel", "pad_confirm",
            "integrity_prepare", "integrity_token",
        )
        val DIRECT_OPS = setOf("pi_can_install", "pi_open_settings", "pi_verify", "pi_install", "pi_last", "pi_abandon_stale", "pi_constraints")

        fun fail(error: String, message: String?): JSONObject =
            JSONObject().put("ok", false).put("error", error).put("message", message ?: JSONObject.NULL)
    }
}
