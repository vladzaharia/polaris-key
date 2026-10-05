// Portal links (notes/SDK-PARITY-PASS.md §3.5): the customer portal's URL for a flow, so a kit can put
// a "Manage devices" button on a device-limit refusal, a "Buy" or "Account" button anywhere. Built
// from the control plane's origin (the portal is served at its root) and the portal SPA's SHIPPED
// hash routes (`packages/admin/src/portal/router.ts`):
//
//   account      #/account
//   library      #/
//   activate     #/?activate=<key>
//   devices      #/p/<slug>/devices
//   freeDevice   #/p/<slug>/free-device?for=<deviceId>&return=<returnTo>
//   download     #/p/<slug>/download?platform=<platform>
//
// `returnTo` must be an app deep link or an https URL the portal will send the user back to; the
// portal checks it against the product's allowlist and ignores one it does not allow. The helper
// drops a `returnTo` that is not absolute, or not in [allowedReturn] when the host passes one, and
// never fails. When PX-W8 lands a server-supplied portal URL overrides these (§6, W2).

package im.plrs.key.core

import java.net.URI

/** The portal flows [portalUrl] builds. */
public enum class PortalFlow { account, library, activate, freeDevice, download, devices }

/**
 * The portal URL for [flow]. [deviceId] is the `for` of `freeDevice` (this device when null is passed
 * by the facade); [key] the licence key `activate` pre-fills; [platform] the `download` platform.
 * [allowedReturn] lists the origins (`https://example.com`) and schemes (`myapp:`) a `returnTo` may
 * use; null keeps any absolute https or custom-scheme URL.
 */
public fun portalUrl(
    baseUrl: String,
    product: String,
    flow: PortalFlow,
    deviceId: String? = null,
    returnTo: String? = null,
    key: String? = null,
    platform: String? = null,
    allowedReturn: List<String>? = null,
): String {
    val origin = URI(baseUrl).let { u -> "${u.scheme}://${u.rawAuthority}" }
    val slug = encodeUriComponent(product)
    val ret = returnTo?.takeIf { returnAllowed(it, allowedReturn) }
    fun query(vararg pairs: Pair<String, String?>): String {
        val q = pairs.filter { it.second != null }.joinToString("&") { "${it.first}=${encodeUriComponent(it.second!!)}" }
        return if (q.isEmpty()) "" else "?$q"
    }
    val hash = when (flow) {
        PortalFlow.account -> "#/account"
        PortalFlow.library -> "#/"
        PortalFlow.activate -> "#/" + query("activate" to (key ?: ""))
        PortalFlow.devices -> "#/p/$slug/devices"
        PortalFlow.freeDevice -> "#/p/$slug/free-device" + query("for" to deviceId, "return" to ret)
        PortalFlow.download -> "#/p/$slug/download" + query("platform" to platform)
    }
    return "$origin/$hash"
}

private fun returnAllowed(url: String, allowed: List<String>?): Boolean {
    val u = try {
        URI(url)
    } catch (e: Exception) {
        return false
    }
    val scheme = u.scheme?.lowercase() ?: return false
    if (scheme == "http" || scheme == "javascript" || scheme == "data" || scheme == "file") return false
    if (allowed == null) return scheme == "https" && u.host != null || scheme != "https"
    return allowed.any { a ->
        val al = a.lowercase().trimEnd('/')
        if (al.endsWith(":")) scheme == al.dropLast(1)
        else scheme == "https" && "https://${u.rawAuthority?.lowercase()}" == al
    }
}
