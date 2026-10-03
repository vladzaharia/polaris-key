package im.plrs.key.platform

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * Who installed this app, as Android records it. RAW values only: mapping them to an outlet is the
 * SDK's job (P3-11's outlet-matrix.json), and the installing package alone is forgeable
 * (`adb install -i com.android.vending` records Play with the shell as initiator, notes/S-06 §7).
 * A `com.android.vending` claim is attested only when [initiatorCertSha256] equals the Play Store's
 * certificate digest.
 *
 * After a self-update (notes/S-10 §4) the installer and the initiator are the app itself, the
 * initiator's signer is the app's own certificate and [packageSource] is 0.
 */
public data class InstallSourceInfo(
    val packageName: String,
    val sdkInt: Int,
    val versionCode: Long,
    val targetSdk: Int,
    /** `installSourceInfo` (API 30+) or `installerPackageName` (the deprecated fallback). */
    val api: String,
    /** The installing package (`getInstallingPackageName`), null when none was recorded. */
    val installer: String?,
    /** The initiating package (API 30+). */
    val initiator: String?,
    /** The originating package (API 30+; null unless the caller holds INSTALL_PACKAGES). */
    val originator: String?,
    /** SHA-256 of each of the initiator's signing certificates (API 30+), null when unknown. */
    val initiatorSigners: List<String>?,
    /** `PackageInstaller.PACKAGE_SOURCE_*` (API 33+), null below. */
    val packageSource: Int?,
    /** `getUpdateOwnerPackageName` (API 34+), null below or when no installer owns updates. */
    val updateOwner: String?,
    /** SHA-256 of this app's own signing certificates. */
    val selfSigners: List<String>,
) {
    /** The first initiator certificate digest (the shape the GDScript reader reports). */
    val initiatorCertSha256: String? get() = initiatorSigners?.firstOrNull()

    /** True when the app installed its own update (installer == initiator == own package). */
    val selfUpdated: Boolean get() = installer == packageName && initiator == packageName

    public fun toJson(): JSONObject = JSONObject()
        .put("package", packageName)
        .put("sdk", sdkInt)
        .put("versionCode", versionCode)
        .put("targetSdk", targetSdk)
        .put("api", api)
        .put("installer", installer ?: JSONObject.NULL)
        .put("initiator", initiator ?: JSONObject.NULL)
        .put("originator", originator ?: JSONObject.NULL)
        .put("initiatorCertSha256", initiatorCertSha256 ?: JSONObject.NULL)
        .put("initiatorSigners", initiatorSigners?.let { JSONArray(it) } ?: JSONObject.NULL)
        .put("packageSource", packageSource ?: JSONObject.NULL)
        .put("updateOwner", updateOwner ?: JSONObject.NULL)
        .put("selfSigners", JSONArray(selfSigners))
        .put("selfUpdated", selfUpdated)
}

/** Reads [InstallSourceInfo]. Every API-level call is guarded; nothing here needs a permission. */
public object InstallSource {
    public const val PLAY_STORE: String = "com.android.vending"

    public fun read(context: Context): InstallSourceInfo {
        val pm = context.packageManager
        val pkg = context.packageName
        val sdk = Build.VERSION.SDK_INT
        val info = pm.getPackageInfo(pkg, 0)
        var api = "installerPackageName"
        var installer: String? = null
        var initiator: String? = null
        var originator: String? = null
        var initiatorSigners: List<String>? = null
        var packageSource: Int? = null
        var updateOwner: String? = null
        if (Build.VERSION.SDK_INT >= 30) {
            api = "installSourceInfo"
            val s = pm.getInstallSourceInfo(pkg)
            installer = s.installingPackageName.nonEmpty()
            initiator = s.initiatingPackageName.nonEmpty()
            originator = s.originatingPackageName.nonEmpty()
            initiatorSigners = s.initiatingPackageSigningInfo?.apkContentsSigners?.let(::digests)
            if (Build.VERSION.SDK_INT >= 33) packageSource = s.packageSource
            if (Build.VERSION.SDK_INT >= 34) updateOwner = s.updateOwnerPackageName.nonEmpty()
        } else {
            @Suppress("DEPRECATION")
            installer = pm.getInstallerPackageName(pkg).nonEmpty()
        }
        return InstallSourceInfo(
            packageName = pkg,
            sdkInt = sdk,
            versionCode = versionCode(info),
            targetSdk = context.applicationInfo.targetSdkVersion,
            api = api,
            installer = installer,
            initiator = initiator,
            originator = originator,
            initiatorSigners = initiatorSigners,
            packageSource = packageSource,
            updateOwner = updateOwner,
            selfSigners = selfSigners(context),
        )
    }

    /** SHA-256 of this app's current signing certificates (`apkContentsSigners`). */
    public fun selfSigners(context: Context): List<String> {
        val pm = context.packageManager
        val pkg = context.packageName
        return if (Build.VERSION.SDK_INT >= 28) {
            val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
            info.signingInfo?.apkContentsSigners?.let(::digests) ?: emptyList()
        } else {
            @Suppress("DEPRECATION")
            val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES)
            @Suppress("DEPRECATION")
            info.signatures?.let { digests(it) } ?: emptyList()
        }
    }

    /** `longVersionCode` on API 28+, else the int `versionCode`. */
    public fun versionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()

    internal fun digests(signers: Array<out Signature>): List<String> = signers.map { Digests.sha256(it.toByteArray()) }

    private fun String?.nonEmpty(): String? = if (this.isNullOrEmpty()) null else this
}
