package org.polariskey.s10

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/** Direct flavour: verified PackageInstaller self-update. No Play Core classes. */
class FlavorOps(private val p: S10Plugin) {
    fun call(op: String, a: JSONObject): JSONObject = when (op) {
        "pi.canRequest" -> JSONObject().put("canRequestPackageInstalls", if (Build.VERSION.SDK_INT >= 26) p.ctx.packageManager.canRequestPackageInstalls() else true)
        "pi.openSettings" -> {
            p.act.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + p.ctx.packageName)))
            JSONObject().put("started", true)
        }
        "pi.verify" -> Installer.verify(p.ctx, File(a.getString("path")), a.optString("sha256"))
        "pi.install" -> Installer.install(p.ctx, File(a.getString("path")), a)
        "pi.constraints" -> Installer.constraints(p.ctx)
        "pi.sessions" -> JSONObject().put("mine", JSONArray(p.ctx.packageManager.packageInstaller.mySessions.map {
            JSONObject().put("id", it.sessionId).put("active", it.isActive).put("progress", it.progress)
        }))
        "pi.log" -> JSONObject().put("log", Installer.readLog(p.ctx))
        else -> JSONObject().put("unsupported", "flavor").put("op", op)
    }

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {}
    fun onResume() {}
}

object Installer {
    const val ACTION = "org.polariskey.s10.INSTALL_STATUS"

    fun sha256File(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(f).use { s ->
            val buf = ByteArray(1 shl 16)
            while (true) { val n = s.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** The refusal checks P5-06 needs: hash, package name, signer equality, higher versionCode. */
    fun verify(ctx: Context, f: File, expectSha: String?): JSONObject {
        val o = JSONObject().put("path", f.path).put("size", f.length())
        val reasons = JSONArray()
        val sha = sha256File(f)
        o.put("sha256", sha)
        if (!expectSha.isNullOrEmpty() && !sha.equals(expectSha, true)) reasons.put("hash_mismatch")
        val pm = ctx.packageManager
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        val arch = pm.getPackageArchiveInfo(f.path, flags)
        if (arch == null) {
            reasons.put("unparseable")
        } else {
            val vc = arch.longVersionCode
            val mine = pm.getPackageInfo(ctx.packageName, 0).longVersionCode
            o.put("archivePackage", arch.packageName).put("archiveVersionCode", vc).put("installedVersionCode", mine)
            if (arch.packageName != ctx.packageName) reasons.put("package_mismatch")
            if (vc <= mine) reasons.put("version_not_higher")
            val si = arch.signingInfo
            val archSigners = si?.apkContentsSigners?.map { InstallSource.sha256(it.toByteArray()) } ?: emptyList()
            val selfSigners = InstallSource.selfSigners(ctx, ctx.packageName)
            o.put("archiveSigners", JSONArray(archSigners)).put("installedSigners", JSONArray(selfSigners))
            if (archSigners.isEmpty() || archSigners.toSet() != selfSigners.toSet()) reasons.put("signer_mismatch")
        }
        return o.put("ok", reasons.length() == 0).put("refused", reasons)
    }

    fun install(ctx: Context, f: File, a: JSONObject): JSONObject {
        val v = if (a.optBoolean("skipVerify")) JSONObject().put("ok", true) else verify(ctx, f, a.optString("sha256"))
        if (!v.getBoolean("ok")) return JSONObject().put("committed", false).put("verify", v)
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        params.setInstallReason(PackageManager.INSTALL_REASON_USER)
        params.setSize(f.length())
        val applied = JSONObject()
        if (Build.VERSION.SDK_INT >= 31 && a.optBoolean("noUserAction", true)) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED); applied.put("noUserAction", true)
        }
        if (Build.VERSION.SDK_INT >= 33 && a.has("packageSource")) {
            params.setPackageSource(a.getInt("packageSource")); applied.put("packageSource", a.getInt("packageSource"))
        }
        if (Build.VERSION.SDK_INT >= 34 && a.optBoolean("requestUpdateOwnership")) {
            params.setRequestUpdateOwnership(true); applied.put("requestUpdateOwnership", true)
        }
        val t0 = System.nanoTime()
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            s.openWrite("base.apk", 0, f.length()).use { out -> FileInputStream(f).use { it.copyTo(out) }; s.fsync(out) }
            val intent = Intent(ctx, InstallStatusReceiver::class.java).setAction(ACTION).putExtra("launchPrompt", a.optBoolean("launchPrompt"))
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pending = PendingIntent.getBroadcast(ctx, id, intent, flags)
            if (Build.VERSION.SDK_INT >= 34 && a.optBoolean("gentle")) {
                pi.commitSessionAfterInstallConstraintsAreMet(id, pending.intentSender, PackageInstaller.InstallConstraints.GENTLE_UPDATE, a.optLong("timeoutMs", 60000))
                applied.put("gentle", true)
            } else {
                s.commit(pending.intentSender)
            }
        }
        val o = JSONObject().put("committed", true).put("session", id).put("applied", applied)
            .put("writeCommitMs", (System.nanoTime() - t0) / 1e6).put("verify", v)
        log(ctx, JSONObject().put("event", "commit").put("detail", o))
        return o
    }

    fun constraints(ctx: Context): JSONObject {
        if (Build.VERSION.SDK_INT < 34) return JSONObject().put("unsupported", "api")
        val o = JSONObject()
        val latch = java.util.concurrent.CountDownLatch(1)
        ctx.packageManager.packageInstaller.checkInstallConstraints(
            listOf(ctx.packageName), PackageInstaller.InstallConstraints.GENTLE_UPDATE, ctx.mainExecutor,
        ) { r -> o.put("allSatisfied", r.areAllConstraintsSatisfied()); latch.countDown() }
        // The callback runs on the main executor; when called from the render thread we can wait.
        o.put("waited", latch.await(3, java.util.concurrent.TimeUnit.SECONDS))
        return o
    }

    fun log(ctx: Context, o: JSONObject) {
        o.put("wall", System.currentTimeMillis())
        Log.i(S10Plugin.TAG, "pi $o")
        File(ctx.filesDir, "pi_log.jsonl").appendText(o.toString() + "\n")
    }

    fun readLog(ctx: Context): JSONArray {
        val f = File(ctx.filesDir, "pi_log.jsonl")
        return JSONArray(if (f.exists()) f.readLines().filter { it.isNotBlank() }.map { JSONObject(it) } else emptyList<JSONObject>())
    }
}

/** Manifest-declared (exported=false) so the status reaches us even if the process restarted. */
class InstallStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)
        val o = JSONObject().put("event", "status").put("status", status)
            .put("message", intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: JSONObject.NULL)
            .put("legacyStatus", intent.getIntExtra("android.content.pm.extra.LEGACY_STATUS", 0))
            .put("session", intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1))
            .put("otherPackage", intent.getStringExtra(PackageInstaller.EXTRA_OTHER_PACKAGE_NAME) ?: JSONObject.NULL)
            .put("pluginAlive", S10Plugin.instance != null)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            o.put("confirmAction", confirm?.action ?: JSONObject.NULL)
            if (intent.getBooleanExtra("launchPrompt", false) && confirm != null) {
                val plugin = S10Plugin.instance
                try {
                    if (plugin != null) plugin.onUi { plugin.act.startActivity(confirm) }
                    else context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    o.put("promptLaunched", true)
                } catch (t: Throwable) {
                    o.put("promptLaunchError", t.javaClass.name + ": " + t.message)
                }
            }
        }
        Installer.log(context, o)
        S10Plugin.instance?.emit("pi_status", o)
    }
}
