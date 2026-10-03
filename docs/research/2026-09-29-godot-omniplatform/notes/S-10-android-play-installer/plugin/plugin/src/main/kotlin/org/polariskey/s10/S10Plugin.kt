package org.polariskey.s10

import android.content.Context
import android.content.Intent
import android.os.Looper
import android.util.Log
import org.godotengine.godot.Godot
import org.godotengine.godot.plugin.GodotPlugin
import org.godotengine.godot.plugin.SignalInfo
import org.godotengine.godot.plugin.UsedByGodot
import org.json.JSONObject

/**
 * S-10 probe plugin (Godot Android plugin v2). One AAR per flavour: `play` adds In-App Updates
 * and Play Asset Delivery, `direct` adds PackageInstaller self-update. Both have install source
 * and Keystore. Every result is a JSON string so GDScript can parse_string it.
 */
class S10Plugin(godot: Godot) : GodotPlugin(godot) {
    override fun getPluginName() = "PKeyS10"

    override fun getPluginSignals(): Set<SignalInfo> = setOf(
        SignalInfo("iau_state", String::class.java),
        SignalInfo("pad_state", String::class.java),
        SignalInfo("pi_status", String::class.java),
        SignalInfo("probe", String::class.java),
    )

    internal val ctx: Context get() = activity!!.applicationContext
    internal val act get() = activity!!
    private val ops: FlavorOps by lazy { FlavorOps(this) }

    init { instance = this }

    /** Emits a signal with the emitting thread recorded, from whatever thread we are on. */
    internal fun emit(signal: String, obj: JSONObject) {
        obj.put("emit_thread", Thread.currentThread().name)
        obj.put("emit_main_looper", Looper.myLooper() == Looper.getMainLooper())
        Log.i(TAG, "$signal $obj")
        emitSignal(signal, obj.toString())
    }

    internal fun onUi(r: Runnable) = runOnUiThread(r)

    @UsedByGodot
    fun flavor(): String = BuildConfig.FLAVOR

    @UsedByGodot
    fun threadInfo(): String = JSONObject()
        .put("thread", Thread.currentThread().name)
        .put("main_looper", Looper.myLooper() == Looper.getMainLooper())
        .toString()

    @UsedByGodot
    fun installSource(): String = timed { InstallSource.read(ctx) }.toString()

    @UsedByGodot
    fun ksWrap(alias: String, plain: String, strongBox: Boolean): String =
        timed { KeyVault.wrap(alias, plain, strongBox) }.toString()

    @UsedByGodot
    fun ksUnwrap(alias: String, blob: String): String = timed { KeyVault.unwrap(alias, blob) }.toString()

    @UsedByGodot
    fun ksInfo(alias: String): String = timed { KeyVault.info(alias) }.toString()

    @UsedByGodot
    fun ksDelete(alias: String): String = timed { KeyVault.delete(alias) }.toString()

    /** Flavour-specific operations ("iau.*", "pad.*", "pi.*"); unknown ops answer unsupported. */
    @UsedByGodot
    fun op(op: String, args: String): String =
        timed { ops.call(op, if (args.isEmpty()) JSONObject() else JSONObject(args)) }.toString()

    /** Threading probe: emit `probe` from a worker thread, the UI thread and the render thread. */
    @UsedByGodot
    fun emitFrom(where: String) {
        val r = Runnable { emit("probe", JSONObject().put("where", where)) }
        when (where) {
            "worker" -> Thread(r, "s10-worker").start()
            "ui" -> runOnUiThread(r)
            "render" -> runOnRenderThread(r)
            else -> r.run()
        }
    }

    override fun onMainActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        emit("probe", JSONObject().put("where", "activity_result").put("request", requestCode).put("result", resultCode))
        ops.onActivityResult(requestCode, resultCode, data)
    }

    override fun onMainResume() {
        ops.onResume()
    }

    companion object {
        const val TAG = "S10"
        @Volatile var instance: S10Plugin? = null

        fun timed(block: () -> JSONObject): JSONObject {
            val t0 = System.nanoTime()
            val out = try {
                block()
            } catch (t: Throwable) {
                Log.w(TAG, "call failed", t)
                JSONObject().put("error", t.javaClass.name).put("message", t.message ?: "")
            }
            return out.put("ms", (System.nanoTime() - t0) / 1e6).put("call_thread", Thread.currentThread().name)
        }
    }
}
