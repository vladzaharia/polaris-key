package org.polariskey.s10

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** getInstallSourceInfo (API 30+) with the getInstallerPackageName fallback; raw values only. */
object InstallSource {
    fun sha256(b: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    fun read(ctx: Context): JSONObject {
        val pm = ctx.packageManager
        val pkg = ctx.packageName
        val o = JSONObject().put("package", pkg).put("sdk", Build.VERSION.SDK_INT)
        val pi = pm.getPackageInfo(pkg, 0)
        o.put("versionCode", if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else pi.versionCode.toLong())
        o.put("targetSdk", ctx.applicationInfo.targetSdkVersion)
        if (Build.VERSION.SDK_INT >= 30) {
            val s = pm.getInstallSourceInfo(pkg)
            o.put("installing", s.installingPackageName ?: JSONObject.NULL)
            o.put("initiating", s.initiatingPackageName ?: JSONObject.NULL)
            o.put("originating", s.originatingPackageName ?: JSONObject.NULL)
            val si = s.initiatingPackageSigningInfo
            o.put(
                "initiatorSigners",
                if (si == null) JSONObject.NULL else JSONArray(si.apkContentsSigners.map { sha256(it.toByteArray()) }),
            )
            if (Build.VERSION.SDK_INT >= 33) o.put("packageSource", s.packageSource)
            if (Build.VERSION.SDK_INT >= 34) o.put("updateOwner", s.updateOwnerPackageName ?: JSONObject.NULL)
        } else {
            @Suppress("DEPRECATION")
            o.put("installing", pm.getInstallerPackageName(pkg) ?: JSONObject.NULL)
        }
        o.put("selfSigners", JSONArray(selfSigners(ctx, pkg)))
        return o
    }

    fun selfSigners(ctx: Context, pkg: String): List<String> {
        val pm = ctx.packageManager
        return if (Build.VERSION.SDK_INT >= 28) {
            val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
            info.signingInfo!!.apkContentsSigners.map { sha256(it.toByteArray()) }
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures!!.map { sha256(it.toByteArray()) }
        }
    }
}
