package im.plrs.key.godot

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import org.godotengine.godot.Godot
import org.godotengine.godot.plugin.GodotPlugin
import org.godotengine.godot.plugin.UsedByGodot

/**
 * The Godot Android plugin (v2), Engine singleton `PolarisKeyAndroid`. ONE method, [cmd], takes and
 * returns a JSON string ([Commands] documents the ops); asynchronous results and events are queued
 * and drained by the GDScript facade (addons/polaris_key/native/pkey_android.gd) with the `poll`
 * command on Godot's main thread, so no signal crosses JNI and the facade has one code path.
 *
 * No method may share a name with an `Object` method: `call`, `get`, `set`, `connect`, … are
 * shadowed in GDScript and silently return null (notes/S-10 §5).
 */
class PolarisKeyAndroidPlugin(godot: Godot) : GodotPlugin(godot), Host {
    private val commands: Commands by lazy { Commands(this) }

    override fun getPluginName(): String = "PolarisKeyAndroid"

    private val main = Handler(Looper.getMainLooper())

    // Only GodotPlugin members that exist since Godot 4.2 are used (getActivity, the onMain*
    // callbacks): the AAR is compiled against 4.7.2 but must link on older engines. That is why
    // the UI thread is reached through a main-looper Handler, not runOnUiThread (deprecated in 4.7)
    // or runOnHostThread (only in newer engines).
    override val appContext: Context
        get() = getActivity()?.applicationContext ?: throw IllegalStateException("Godot has no activity yet")

    override val foregroundActivity: Activity?
        get() = getActivity()

    override fun onUi(r: Runnable) {
        if (Looper.myLooper() == Looper.getMainLooper()) r.run() else main.post(r)
    }

    @UsedByGodot
    fun cmd(json: String): String = commands.cmd(json)

    override fun onMainActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        commands.onActivityResult(requestCode, resultCode, data)
    }

    override fun onMainResume() {
        commands.onResume()
    }

    override fun onMainDestroy() {
        commands.close()
    }
}
