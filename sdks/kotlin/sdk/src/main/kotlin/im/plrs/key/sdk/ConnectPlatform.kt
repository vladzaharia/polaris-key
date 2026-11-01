// What the platform glue gives Cloud Connect (CC-12b.5): the LAN discovery adapter and the local-network
// permission state. The `:android` glue installs one process-wide (the `AttestationProviders.installed`
// pattern); `CloudConnect` and `CloudNearby` use it only on Android and only when the host's own options
// carry no `mdns` adapter. Nothing here asks the person for anything: the host or the UI kit asks.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.peer.lan.MdnsAdapter

/** Whether this app may reach the local network (Android 17 and a target of 37 enforce it). */
public enum class LocalNetworkVerdict {
    /** Allowed, or not enforced here. */
    Ok,

    /** Enforced, and the host app does not declare the permission: a build mistake (`not-configured`). */
    NotDeclared,

    /** Declared but not granted (`nearby-permission-denied`). */
    Denied,
}

/** The platform's LAN edge. */
public interface ConnectPlatform {
    /** The discovery adapter, or null when this device cannot discover (Android below 14). */
    public val mdns: MdnsAdapter?

    /** Read when LAN or nearby starts; never prompts. */
    public suspend fun localNetwork(): LocalNetworkVerdict
}

/** The platform glue in this process. */
public object ConnectPlatforms {
    @Volatile public var installed: ConnectPlatform? = null

    /** Test seam: the JVM tests stand in for Android. */
    @Volatile internal var android: Boolean = RuntimeFamily.isAndroid
}

/**
 * The LAN options to start with: [o] itself off Android or when the host chose an adapter; on Android the
 * installed platform's adapter, with its permission read in front of the host's own `lanPermission`. Null when
 * Android has no adapter (the typed `unsupported`; the relay still works).
 */
internal fun androidLanOptions(o: LanOptions, android: Boolean, platform: ConnectPlatform?): LanOptions? {
    val adapter = platform?.mdns
    return when {
        !android || o.mdns != null -> o
        platform == null || adapter == null -> null
        else -> o.with(mdns = adapter, lanPermission = guarded(platform, o.lanPermission))
    }
}

private fun guarded(p: ConnectPlatform, host: suspend () -> Boolean): suspend () -> Boolean = {
    when (p.localNetwork()) {
        LocalNetworkVerdict.Ok -> host()

        LocalNetworkVerdict.Denied -> false

        LocalNetworkVerdict.NotDeclared ->
            throw PolarisException(ErrorCode.notConfigured, "The app does not declare ACCESS_LOCAL_NETWORK.")
    }
}
