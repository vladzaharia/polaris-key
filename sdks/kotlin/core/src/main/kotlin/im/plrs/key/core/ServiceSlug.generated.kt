// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen:services` (tools/gen-services.ts) from tools/services.json, the
// one declaration of the opt-in services. `pnpm gen:services -- --check` fails the green
// gate on any difference. To change a service, edit the table and regenerate.

package im.plrs.key.core

/** The opt-in services, in canonical order. Core is not a service — it is always on. */
public enum class ServiceSlug(
    /** The wire and route slug. */
    public val slug: String,
    /** Whether a product runs this service when it has never said otherwise. */
    public val isDefaultEnabled: Boolean,
) {
    license("license", true),
    config("config", true),
    release("release", false),
    distribution("distribution", false),
    update("update", false),
    identity("identity", false),
    sync("sync", false),
    ;

    public companion object {
        /** The service with this slug, or null. */
        public fun of(slug: String?): ServiceSlug? = entries.firstOrNull { it.slug == slug }
    }
}
