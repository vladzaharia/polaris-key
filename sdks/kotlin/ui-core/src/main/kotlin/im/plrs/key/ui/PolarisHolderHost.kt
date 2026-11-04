// @pkey-feature ui.kit.holders
// What a gate or the account screen needs to draw the holders' screens for a live client (UK-43.10): the
// views' input (services, the license holder, the Done line), the portal link, and the key held in memory
// between the activation and Start using. Compose-free; the renderers are in the :ui module.
package im.plrs.key.ui

import im.plrs.key.core.PortalLink
import im.plrs.key.license.KeyEntries
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The license key just activated, held in memory until Start using closes the Done step (it is never stored).
 * [toString] redacts the key.
 */
public class PolarisKeyDone(public val key: String, public val entries: KeyEntries? = null) {
    override fun toString(): String = "PolarisKeyDone(key=[redacted])"
}

/**
 * The views' input for a live client: [base] carries `services`, `licenseHolder` and the Done line, ready for
 * [PolarisAddToAccountState] and the activateDone resolver. [portal] is the product's page in the customer
 * portal (never with a key), or null while the portal is off or has no link.
 */
public class HolderFacts(
    public val base: JsonObject,
    public val portal: String?,
    public val account: String?,
    /** Identity is on: the account steps can run in the app. */
    public val identity: Boolean = true,
    public val addIn: String = HOLDER_ADD_IN_APP,
    /** The email the license waits for (unmasked, for a sign-in hint), or null while it floats. */
    public val holderEmail: String? = null,
) {
    /** Add opens the portal: Identity is off, or the kit has no in-app channel. */
    public val portalOnly: Boolean get() = !identity || addIn == HOLDER_ADD_IN_PORTAL
}

/** The `licenseHolder.addIn` of a kit with an in-app channel; Android TV has none and adds in the portal (D5). */
public const val HOLDER_ADD_IN_APP: String = "app"

/** The `licenseHolder.addIn` of a kit with no in-app channel: the manage QR, no `#key=`. */
public const val HOLDER_ADD_IN_PORTAL: String = "portal"

/**
 * The facts for [addIn] ([HOLDER_ADD_IN_APP] on a phone, a tablet and a desktop, [HOLDER_ADD_IN_PORTAL] on Android TV)
 * and [deviceKind] (the "this phone" noun). The license holder is read from the license: an email makes it waiting for
 * that email, none leaves it floating.
 */
public suspend fun PolarisKeyClient.holderFacts(addIn: String, deviceKind: String?, keyDone: PolarisKeyDone? = null): HolderFacts {
    val on = runCatching { capabilities() }.getOrDefault(emptyMap()).filterValues { it }.keys.map { it.slug }
    val services = on.map(::JsonPrimitive)
    val profile = runCatching { license.getProfile() }.getOrNull()
    val info = runCatching { license.licenseInfo() }.getOrNull()
    val doc = runCatching { core.discoveryDocument() }.getOrNull()
    val holder = linkedMapOf<String, kotlinx.serialization.json.JsonElement>("addIn" to JsonPrimitive(addIn))
    profile?.email?.takeIf { it.isNotBlank() }?.let { holder["email"] = JsonPrimitive(it) }
    val members = linkedMapOf<String, kotlinx.serialization.json.JsonElement>(
        "services" to JsonArray(services),
        "licenseHolder" to JsonObject(holder),
    )
    if (keyDone != null) {
        val done = linkedMapOf<String, kotlinx.serialization.json.JsonElement>()
        (info?.tierLabel ?: info?.tier)?.takeIf { it.isNotBlank() }?.let { done["tier"] = JsonPrimitive(it) }
        deviceKind?.let { done["deviceKind"] = JsonPrimitive(it) }
        // The license document carries no device count: the roster's, when it was reached (this device alone offline is not a count).
        rosterPosition()?.let { done["position"] = JsonPrimitive(it) }
        info?.deviceLimit?.let { done["limit"] = JsonPrimitive(it) }
        members["activateDone"] = JsonObject(done)
    }
    val portal = PortalLink.link(null, null, core.endpoints.baseUrl, product)
    return HolderFacts(
        JsonObject(members),
        portal,
        doc?.identity?.accountPortal ?: portal,
        identity = "identity" in on,
        addIn = addIn,
        holderEmail = profile?.email?.takeIf { it.isNotBlank() },
    )
}

/** This device's place among the license's devices (the roster's size), or null when the roster was not reached in time. */
private suspend fun PolarisKeyClient.rosterPosition(): Int? = runCatching {
    kotlinx.coroutines.withTimeoutOrNull(ROSTER_WAIT_MS) { listDevices() }
}.getOrNull()?.takeIf { roster -> roster.isNotEmpty() && roster.none { it.offline } }?.size

private const val ROSTER_WAIT_MS = 3_000L
