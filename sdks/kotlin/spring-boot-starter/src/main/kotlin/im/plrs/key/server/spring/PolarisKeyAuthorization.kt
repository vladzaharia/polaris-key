// Step 6: the per-route requirements, as Spring Security AuthorizationManagers for `access(...)`.
//
//     http.authorizeHttpRequests {
//         it.requestMatchers("/health").permitAll()
//         it.requestMatchers("/api/me").access(PolarisKey.license())
//         it.requestMatchers("/api/export").access(PolarisKey.entitlement("export.pdf"))
//         it.requestMatchers("/api/team").access(PolarisKey.tier("pro", "team"))
//         it.requestMatchers("/api/me/pro").access(PolarisKey.all(Require.signIn(), Require.tier("pro")))
//         it.anyRequest().denyAll()
//     }
//
// A route no matcher names is the app's own rule. A denial is never a bare 401/403: the entry point
// or access-denied handler answers the localized problem the request was refused with.

package im.plrs.key.server.spring

import im.plrs.key.server.BackendRequirement
import im.plrs.key.server.Require
import java.util.function.Supplier
import kotlinx.serialization.json.JsonElement
import org.springframework.security.authorization.AuthorizationDecision
import org.springframework.security.authorization.AuthorizationManager
import org.springframework.security.core.Authentication
import org.springframework.security.web.access.intercept.RequestAuthorizationContext

/** The gates. Each decides steps 1 to 5 once per request, then its requirements in order; the first that fails refuses. */
public object PolarisKey {
    /** A route that needs a usable licence document (steps 1 to 5). */
    @JvmStatic
    public fun license(): AuthorizationManager<RequestAuthorizationContext> = PolarisKeyAuthorizationManager(emptyList())

    /** A route that also needs boolean entitlement [name]; with [test], the valued entitlement (a seat count, a list) must satisfy it. */
    @JvmStatic
    @JvmOverloads
    public fun entitlement(name: String, test: ((JsonElement) -> Boolean)? = null): AuthorizationManager<RequestAuthorizationContext> =
        PolarisKeyAuthorizationManager(listOf(Require.entitlement(name, test)))

    /** A route that also needs the licence's tier to be one of [tiers]. */
    @JvmStatic
    public fun tier(vararg tiers: String): AuthorizationManager<RequestAuthorizationContext> =
        PolarisKeyAuthorizationManager(listOf(Require.tier(*tiers)))

    /** A route that also needs a signed-in account. */
    @JvmStatic
    public fun signIn(): AuthorizationManager<RequestAuthorizationContext> = PolarisKeyAuthorizationManager(listOf(Require.signIn()))

    /** A route that needs every one of [requirements], checked in order. Build them with [Require]. */
    @JvmStatic
    public fun all(vararg requirements: BackendRequirement): AuthorizationManager<RequestAuthorizationContext> =
        PolarisKeyAuthorizationManager(requirements.toList())
}

internal class PolarisKeyAuthorizationManager(private val requirements: List<BackendRequirement>) : AuthorizationManager<RequestAuthorizationContext> {
    @Deprecated("Spring Security 6.4 renamed this authorize", ReplaceWith("authorize(authentication, context)"))
    override fun check(authentication: Supplier<Authentication>, context: RequestAuthorizationContext): AuthorizationDecision {
        val request = context.request
        val state = PolarisKeyRequest.of(request) ?: error(
            "PolarisKey gate without the filter: apply the starter to the HttpSecurity first, for example http.with(PolarisKeyConfigurer.polarisKey(), Customizer.withDefaults())",
        )
        // A passing preflight carries no licence and nothing to check.
        if (state.preflight) return AuthorizationDecision(true)
        val auth = state.auth()
        val license = auth.license ?: return AuthorizationDecision(false)
        val problem = state.server.refusalFor(license, requirements, state.acceptLanguage)
        if (problem != null) {
            state.refusal = problem
            return AuthorizationDecision(false)
        }
        request.setAttribute(PolarisKeyRequest.GATED, true)
        return AuthorizationDecision(true)
    }
}
