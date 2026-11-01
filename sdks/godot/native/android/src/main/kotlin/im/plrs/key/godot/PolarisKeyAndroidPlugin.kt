package im.plrs.key.godot

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import im.plrs.key.platform.transfer.SyncTransfers
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
    private val commandsLazy = lazy { Commands(this) }
    private val commands: Commands by commandsLazy

    init {
        // The background runner (U-41.6a): the platform's scheduler calls it for a queued bulk transfer. A process that
        // started for the work alone never gets here, so it has no runner and the work ends; GDScript resumes at launch.
        SyncTransfers.install(GodotBulkRunner { if (commandsLazy.isInitialized()) commands.bulk else null })
    }

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

    // The binary crypto ops (CC-14b.8): byte[] in and out (PackedByteArray in GDScript). The reply is
    // a status byte then the result; see CryptoCommands. They touch no Activity, so no UI thread.
    @UsedByGodot
    fun cxSeal(key: ByteArray?, nonce: ByteArray?, aad: ByteArray?, plain: ByteArray?): ByteArray = commands.crypto.seal(key, nonce, aad, plain)

    @UsedByGodot
    fun cxOpen(key: ByteArray?, nonce: ByteArray?, aad: ByteArray?, sealed: ByteArray?): ByteArray = commands.crypto.open(key, nonce, aad, sealed)

    @UsedByGodot
    fun cxX25519(privateKey: ByteArray?, peerPublic: ByteArray?): ByteArray = commands.crypto.x25519(privateKey, peerPublic)

    @UsedByGodot
    fun cxX25519Pub(privateKey: ByteArray?): ByteArray = commands.crypto.x25519Public(privateKey)

    // The bulk-body channel (U-41.6a): header and body are byte[]; each reply is a status byte then the result.
    @UsedByGodot
    fun sbOpen(header: ByteArray?): ByteArray = commands.bulk.open(header)

    @UsedByGodot
    fun sbStage(header: ByteArray?, piece: ByteArray?): ByteArray = commands.bulk.stage(header, piece)

    @UsedByGodot
    fun sbPut(header: ByteArray?): ByteArray = commands.bulk.put(header)

    @UsedByGodot
    fun sbGet(header: ByteArray?): ByteArray = commands.bulk.get(header)

    @UsedByGodot
    fun sbTake(header: ByteArray?): ByteArray = commands.bulk.take(header)

    @UsedByGodot
    fun sbCancel(header: ByteArray?): ByteArray = commands.bulk.cancel(header)

    @UsedByGodot
    fun sbEnd(header: ByteArray?): ByteArray = commands.bulk.end(header)

    @UsedByGodot
    fun sbClose(): ByteArray = commands.bulk.close()

    override fun onMainActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        commands.onActivityResult(requestCode, resultCode, data)
    }

    override fun onMainResume() {
        commands.onResume()
    }

    override fun onMainDestroy() {
        if (commandsLazy.isInitialized()) commands.close()
    }
}
