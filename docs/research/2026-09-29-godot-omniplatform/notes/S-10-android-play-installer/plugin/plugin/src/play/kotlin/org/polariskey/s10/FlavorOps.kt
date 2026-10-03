package org.polariskey.s10

import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.google.android.gms.tasks.Task
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.appupdate.testing.FakeAppUpdateManager
import com.google.android.play.core.assetpacks.AssetPackManager
import com.google.android.play.core.assetpacks.AssetPackManagerFactory
import com.google.android.play.core.assetpacks.AssetPackState
import com.google.android.play.core.install.InstallException
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import org.json.JSONArray
import org.json.JSONObject

/** Play flavour: In-App Updates (real and FakeAppUpdateManager) and Play Asset Delivery. */
class FlavorOps(private val p: S10Plugin) {
    private val main = Handler(Looper.getMainLooper())
    private var apm: AssetPackManager? = null

    fun call(op: String, a: JSONObject): JSONObject = when (op) {
        "iau.fake" -> { main.post { IauScript(p, FakeAppUpdateManager(p.ctx).also { setupFake(it, a) }, a, true).run() }; JSONObject().put("started", true) }
        "iau.real" -> { main.post { IauScript(p, AppUpdateManagerFactory.create(p.ctx), a, false).run() }; JSONObject().put("started", true) }
        "pad.fetch" -> { pad().fetch(names(a)).addOnCompleteListener { t -> p.emit("pad_state", taskJson("fetch", t) { statesJson(it.packStates(), it.totalBytes()) }) }; JSONObject().put("started", true) }
        "pad.states" -> { pad().getPackStates(names(a)).addOnCompleteListener { t -> p.emit("pad_state", taskJson("states", t) { statesJson(it.packStates(), it.totalBytes()) }) }; JSONObject().put("started", true) }
        "pad.cancel" -> pad().cancel(names(a)).let { statesJson(it.packStates(), it.totalBytes()) }
        "pad.remove" -> { pad().removePack(a.getString("name")).addOnCompleteListener { t -> p.emit("pad_state", taskJson("remove", t) { JSONObject() }) }; JSONObject().put("started", true) }
        "pad.location" -> pad().getPackLocation(a.getString("name")).let { l ->
            if (l == null) JSONObject().put("location", JSONObject.NULL)
            else JSONObject().put("assetsPath", l.assetsPath() ?: JSONObject.NULL).put("path", l.path() ?: JSONObject.NULL).put("storage", l.packStorageMethod())
        }
        "pad.locations" -> JSONObject().apply { pad().packLocations.forEach { (k, v) -> put(k, v.assetsPath() ?: "") } }
        "pad.confirm" -> { pad().showConfirmationDialog(p.act).addOnCompleteListener { t -> p.emit("pad_state", taskJson("confirm", t) { JSONObject().put("result", it) }) }; JSONObject().put("started", true) }
        else -> JSONObject().put("unsupported", "flavor").put("op", op)
    }

    private fun pad(): AssetPackManager = apm ?: AssetPackManagerFactory.getInstance(p.ctx).also { m ->
        apm = m
        m.registerListener { s -> p.emit("pad_state", JSONObject().put("event", "listener").put("state", stateJson(s))) }
    }

    private fun names(a: JSONObject): List<String> = a.getJSONArray("names").let { arr -> (0 until arr.length()).map { arr.getString(it) } }

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {}
    fun onResume() {}

    companion object {
        fun setupFake(f: FakeAppUpdateManager, a: JSONObject) {
            val s = a.optJSONObject("setup") ?: JSONObject()
            if (s.has("available")) {
                if (s.has("type")) f.setUpdateAvailable(s.getInt("available"), s.getInt("type")) else f.setUpdateAvailable(s.getInt("available"))
            } else f.setUpdateNotAvailable()
            if (s.has("priority")) f.setUpdatePriority(s.getInt("priority"))
            if (s.has("staleness")) f.setClientVersionStalenessDays(s.getInt("staleness"))
            if (s.has("total")) f.setTotalBytesToDownload(s.getLong("total"))
            if (s.has("installError")) f.setInstallErrorCode(s.getInt("installError"))
        }

        fun stateJson(s: AssetPackState): JSONObject = JSONObject().put("name", s.name()).put("status", s.status())
            .put("error", s.errorCode()).put("bytes", s.bytesDownloaded()).put("total", s.totalBytesToDownload())
            .put("pct", s.transferProgressPercentage()).put("updateAvailability", s.updateAvailability())

        fun statesJson(m: Map<String, AssetPackState>, total: Long): JSONObject =
            JSONObject().put("totalBytes", total).put("packs", JSONArray(m.values.map { stateJson(it) }))

        fun <T> taskJson(what: String, t: Task<T>, ok: (T) -> JSONObject): JSONObject {
            val o = JSONObject().put("event", what).put("success", t.isSuccessful)
            if (t.isSuccessful) o.put("result", ok(t.result)) else errJson(t.exception, o)
            return o
        }

        fun errJson(e: Exception?, o: JSONObject = JSONObject()): JSONObject {
            o.put("exception", e?.javaClass?.name ?: JSONObject.NULL).put("message", e?.message ?: JSONObject.NULL)
            if (e is InstallException) o.put("installErrorCode", e.errorCode)
            if (e is com.google.android.play.core.assetpacks.AssetPackException) o.put("padErrorCode", e.errorCode)
            if (e is com.google.android.gms.common.api.ApiException) o.put("statusCode", e.statusCode)
            return o
        }

        fun infoJson(i: AppUpdateInfo): JSONObject = JSONObject()
            .put("availability", i.updateAvailability()).put("availableVersionCode", i.availableVersionCode())
            .put("installStatus", i.installStatus()).put("priority", i.updatePriority())
            .put("staleness", i.clientVersionStalenessDays() ?: JSONObject.NULL)
            .put("bytes", i.bytesDownloaded()).put("total", i.totalBytesToDownload())
            .put("flexibleAllowed", i.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE))
            .put("immediateAllowed", i.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE))
            .put("flexiblePreconditions", JSONArray(i.getFailedUpdatePreconditions(AppUpdateOptions.defaultOptions(AppUpdateType.FLEXIBLE)).toList()))
            .put("immediatePreconditions", JSONArray(i.getFailedUpdatePreconditions(AppUpdateOptions.defaultOptions(AppUpdateType.IMMEDIATE)).toList()))
    }
}

/**
 * Runs a list of In-App Update steps on the main thread, one per main-loop turn so listener
 * callbacks land between steps, and emits one `iau_state` with the whole trace at the end.
 */
class IauScript(private val p: S10Plugin?, private val m: AppUpdateManager, a: JSONObject, private val fake: Boolean) {
    private val steps = a.optJSONArray("steps") ?: JSONArray(listOf("info"))
    private val trace = JSONArray()
    private val main = Handler(Looper.getMainLooper())
    private var info: AppUpdateInfo? = null
    private var i = 0
    private val t0 = System.nanoTime()
    var onDone: ((JSONObject) -> Unit)? = null
    private val listener = InstallStateUpdatedListener { s ->
        rec(JSONObject().put("listener", true).put("installStatus", s.installStatus()).put("error", s.installErrorCode())
            .put("bytes", s.bytesDownloaded()).put("total", s.totalBytesToDownload()))
    }

    private fun rec(o: JSONObject) {
        o.put("t_ms", (System.nanoTime() - t0) / 1e6).put("thread", Thread.currentThread().name)
        if (fake && m is FakeAppUpdateManager) {
            o.put("dialog", m.isConfirmationDialogVisible).put("immediateUi", m.isImmediateFlowVisible)
                .put("splash", m.isInstallSplashScreenVisible).put("inProgressType", m.typeForUpdateInProgress ?: JSONObject.NULL)
        }
        trace.put(o)
    }

    fun run() {
        m.registerListener(listener)
        next()
    }

    private fun next() {
        if (i >= steps.length()) return finish()
        val step = steps.getString(i++)
        val f = m as? FakeAppUpdateManager
        try {
            when {
                step == "info" -> {
                    m.appUpdateInfo.addOnCompleteListener { t ->
                        if (t.isSuccessful) { info = t.result; rec(JSONObject().put("step", step).put("info", FlavorOps.infoJson(t.result))) }
                        else rec(FlavorOps.errJson(t.exception, JSONObject().put("step", step)))
                        main.post { next() }
                    }
                    return
                }
                step.startsWith("start:") -> {
                    val type = if (step.endsWith("immediate")) AppUpdateType.IMMEDIATE else AppUpdateType.FLEXIBLE
                    val ok = m.startUpdateFlowForResult(info!!, p!!.act, AppUpdateOptions.defaultOptions(type), 4242)
                    rec(JSONObject().put("step", step).put("returned", ok))
                }
                step.startsWith("startTask:") -> {
                    val type = if (step.endsWith("immediate")) AppUpdateType.IMMEDIATE else AppUpdateType.FLEXIBLE
                    m.startUpdateFlow(info!!, p!!.act, AppUpdateOptions.defaultOptions(type)).addOnCompleteListener { t ->
                        if (t.isSuccessful) rec(JSONObject().put("step", "$step:result").put("activityResult", t.result))
                        else rec(FlavorOps.errJson(t.exception, JSONObject().put("step", "$step:result")))
                    }
                    rec(JSONObject().put("step", step).put("returned", "task"))
                }
                step == "complete" -> {
                    m.completeUpdate().addOnCompleteListener { t ->
                        rec(if (t.isSuccessful) JSONObject().put("step", "complete:result").put("success", true) else FlavorOps.errJson(t.exception, JSONObject().put("step", "complete:result")))
                    }
                    rec(JSONObject().put("step", step))
                }
                step == "accept" -> { f!!.userAcceptsUpdate(); rec(JSONObject().put("step", step)) }
                step == "reject" -> { f!!.userRejectsUpdate(); rec(JSONObject().put("step", step)) }
                step == "downloadStarts" -> { f!!.downloadStarts(); rec(JSONObject().put("step", step)) }
                step.startsWith("bytes:") -> { f!!.setBytesDownloaded(step.substring(6).toLong()); rec(JSONObject().put("step", step)) }
                step == "downloadCompletes" -> { f!!.downloadCompletes(); rec(JSONObject().put("step", step)) }
                step == "downloadFails" -> { f!!.downloadFails(); rec(JSONObject().put("step", step)) }
                step == "cancelDownload" -> { f!!.userCancelsDownload(); rec(JSONObject().put("step", step)) }
                step == "installCompletes" -> { f!!.installCompletes(); rec(JSONObject().put("step", step)) }
                step == "installFails" -> { f!!.installFails(); rec(JSONObject().put("step", step)) }
                else -> rec(JSONObject().put("step", step).put("error", "unknown step"))
            }
        } catch (t: Throwable) {
            rec(JSONObject().put("step", step).put("exception", t.javaClass.name).put("message", t.message ?: ""))
        }
        main.post { next() }
    }

    private fun finish() {
        main.postDelayed({
            m.unregisterListener(listener)
            val out = JSONObject().put("event", if (fake) "iau.fake" else "iau.real").put("trace", trace)
            p?.emit("iau_state", out)
            onDone?.invoke(out)
        }, 50)
    }
}
