// The `entitlements` namespace (SP-35b): a thin view over the licence gate. It holds no state of
// its own; every read goes through the same `LicenseClient` the app already has.

package im.plrs.key.license

import im.plrs.key.core.boolValue
import kotlinx.serialization.json.JsonElement

public class EntitlementsClient(private val license: LicenseClient) {
    /**
     * Whether the licence grants the boolean entitlement [name]. False whenever the gate is not
     * usable (S-19 G11): a revoked, expired or blocked device holds a signed document that still
     * lists its grants, and reading them past the gate would keep paid features on after a revocation.
     */
    public suspend fun has(name: String, now: Long? = null): Boolean {
        if (!license.isLicensed(now)) return false
        return license.documentEntitlements()[name].boolValue == true
    }

    /**
     * The raw value of entitlement [name] (a number, string, list or object), or null when the
     * licence does not carry it or the gate is not usable (G11).
     */
    public suspend fun value(name: String, now: Long? = null): JsonElement? {
        if (!license.isLicensed(now)) return null
        return license.documentEntitlements()[name]
    }

    /** Every entitlement's value off the held document; empty when no licence is held. */
    public suspend fun all(): Map<String, JsonElement> = license.documentEntitlements()
}
