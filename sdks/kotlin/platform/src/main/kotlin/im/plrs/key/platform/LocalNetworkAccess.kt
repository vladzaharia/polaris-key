package im.plrs.key.platform

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/** Whether the app may reach the local network (CC-12b.2). */
public enum class LocalNetworkState {
    /** Allowed, or not enforced on this device or for this target. */
    Ok,

    /** Enforced, and the host app's manifest does not declare the permission. */
    NotDeclared,

    /** Enforced and declared, but the person has not granted it. */
    Denied,
}

/**
 * `ACCESS_LOCAL_NETWORK` is enforced only for an app that targets API 37 or higher and runs on Android 17 or
 * higher. This library declares no permission: the host app does, so an app that never uses LAN does not carry
 * it. This object only reads the state; it never asks. The host or the UI kit asks.
 */
public object LocalNetworkAccess {
    public const val PERMISSION: String = "android.permission.ACCESS_LOCAL_NETWORK"
    public const val ENFORCED_FROM: Int = 37

    public fun check(context: Context): LocalNetworkState {
        val sdk = Build.VERSION.SDK_INT
        val target = context.applicationInfo.targetSdkVersion
        if (!enforced(sdk, target)) return LocalNetworkState.Ok
        val declared = declared(context)
        val granted = context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED
        return decide(sdk, target, declared, granted)
    }

    /** The decision on its inputs; the unit tests drive it at API 37, which the test runtime cannot be. */
    internal fun decide(sdkInt: Int, targetSdk: Int, declared: Boolean, granted: Boolean): LocalNetworkState = when {
        !enforced(sdkInt, targetSdk) -> LocalNetworkState.Ok
        !declared -> LocalNetworkState.NotDeclared
        !granted -> LocalNetworkState.Denied
        else -> LocalNetworkState.Ok
    }

    private fun enforced(sdkInt: Int, targetSdk: Int): Boolean = sdkInt >= ENFORCED_FROM && targetSdk >= ENFORCED_FROM

    @Suppress("DEPRECATION")
    private fun declared(context: Context): Boolean {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()))
        } else {
            pm.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
        }
        return info.requestedPermissions?.contains(PERMISSION) == true
    }
}
