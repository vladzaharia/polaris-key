// The authentication half of the Spring Security adapter: a token that carries the request's header
// fields, a provider that decides WIRE-CONTRACT-V4 §14.2 steps 1 to 5 through the PolarisServer, and
// the per-request state the filter, the AuthorizationManagers and the refusal handlers share.
//
// Nothing here logs a header, a JWS or a holder.

package im.plrs.key.server.spring

import im.plrs.key.server.BackendProblem
import im.plrs.key.server.BackendWire
import im.plrs.key.server.PolarisAuth
import im.plrs.key.server.PolarisLicense
import im.plrs.key.server.PolarisServer
import jakarta.servlet.http.HttpServletRequest
import kotlinx.coroutines.runBlocking
import org.springframework.security.authentication.AbstractAuthenticationToken
import org.springframework.security.authentication.AuthenticationProvider
import org.springframework.security.core.Authentication
import org.springframework.security.core.AuthenticationException
import org.springframework.security.core.GrantedAuthority
import org.springframework.security.core.authority.SimpleGrantedAuthority

/** A request's licence document, as a Spring `Authentication`. Its principal is the [PolarisLicense]. */
public class PolarisKeyAuthenticationToken private constructor(
    private val fields: List<Pair<String, String>>,
    private val acceptLanguage: String?,
    private val license: PolarisLicense?,
    authorities: Collection<GrantedAuthority>,
) : AbstractAuthenticationToken(authorities) {
    init {
        super.setAuthenticated(license != null)
    }

    internal fun fields(): List<Pair<String, String>> = fields
    internal fun acceptLanguage(): String? = acceptLanguage

    override fun getCredentials(): Any? = null

    /** The [PolarisLicense] once authenticated, else null. Its `toString` never carries the holder. */
    override fun getPrincipal(): Any? = license

    override fun setAuthenticated(authenticated: Boolean) {
        require(!authenticated) { "PolarisKeyAuthenticationToken: authenticate it through PolarisKeyAuthenticationProvider" }
        super.setAuthenticated(false)
    }

    override fun getName(): String = license?.let { "${it.product}:${it.id}" } ?: ""

    public companion object {
        /** The authorities an authenticated licence grants: `polaris:license`, `polaris:tier:<tier>`, `polaris:signed-in`. */
        public const val AUTHORITY_LICENSE: String = "polaris:license"
        public const val AUTHORITY_SIGNED_IN: String = "polaris:signed-in"
        public const val AUTHORITY_TIER_PREFIX: String = "polaris:tier:"

        /** The token the filter hands the provider: the request's header fields, not yet decided. */
        public fun unauthenticated(fields: List<Pair<String, String>>, acceptLanguage: String?): PolarisKeyAuthenticationToken =
            PolarisKeyAuthenticationToken(fields, acceptLanguage, null, emptyList())

        internal fun authenticatedFor(license: PolarisLicense): PolarisKeyAuthenticationToken = authenticated(license)

        internal fun authenticated(license: PolarisLicense): PolarisKeyAuthenticationToken {
            val authorities = buildList {
                add(SimpleGrantedAuthority(AUTHORITY_LICENSE))
                license.tier?.let { add(SimpleGrantedAuthority(AUTHORITY_TIER_PREFIX + it)) }
                if (license.user != null) add(SimpleGrantedAuthority(AUTHORITY_SIGNED_IN))
            }
            return PolarisKeyAuthenticationToken(emptyList(), null, license, authorities)
        }
    }
}

/** Steps 1 to 5 refused: carries the localized [problem] the entry point answers. */
public class PolarisKeyAuthenticationException(public val problem: BackendProblem) : AuthenticationException(problem.code)

/** Decides a [PolarisKeyAuthenticationToken] with the [PolarisServer]: the licence document in `X-PKey-License`, verified offline. */
public class PolarisKeyAuthenticationProvider(private val server: PolarisServer) : AuthenticationProvider {
    override fun authenticate(authentication: Authentication): Authentication {
        val token = authentication as PolarisKeyAuthenticationToken
        server.start()
        val result = runBlocking { server.authenticate(token.fields(), emptyList(), token.acceptLanguage()) }
        val license = result.license ?: throw PolarisKeyAuthenticationException(result.problem!!)
        return PolarisKeyAuthenticationToken.authenticated(license)
    }

    override fun supports(authentication: Class<*>): Boolean = PolarisKeyAuthenticationToken::class.java.isAssignableFrom(authentication)
}

/** The request's header fields, in the shape the server decides from. */
internal fun HttpServletRequest.headerFields(): List<Pair<String, String>> = buildList {
    for (name in headerNames) for (value in getHeaders(name)) add(name to value)
}

/**
 * What the filter, the gates and the refusal handlers share for one request: the decision of steps 1 to
 * 5 (made on first use, once) and the problem that was refused.
 */
public class PolarisKeyRequest internal constructor(
    internal val server: PolarisServer,
    private val provider: PolarisKeyAuthenticationProvider,
    private val request: HttpServletRequest,
    /** True for a CORS preflight that passes every gate. */
    public val preflight: Boolean,
) {
    private var decided: PolarisAuth? = null

    /** The licence the request carries, once decided and valid. */
    public val license: PolarisLicense? get() = decided?.license

    /** The problem that refused this request (steps 1 to 6), or null. Read by the entry point and the denied handler. */
    @Volatile
    public var refusal: BackendProblem? = decided?.problem
        internal set

    internal val acceptLanguage: String? get() = request.getHeader("Accept-Language")

    /** Steps 1 to 5, decided once through the provider. */
    internal fun auth(): PolarisAuth {
        decided?.let { return it }
        val result = try {
            PolarisAuth(provider.authenticate(PolarisKeyAuthenticationToken.unauthenticated(request.headerFields(), acceptLanguage)).principal as PolarisLicense, null)
        } catch (e: PolarisKeyAuthenticationException) {
            PolarisAuth(null, e.problem)
        }
        decided = result
        if (result.problem != null) refusal = result.problem
        return result
    }

    internal companion object {
        const val ATTRIBUTE = "im.plrs.key.server.spring.request"
        const val GATED = "im.plrs.key.server.spring.gated"
        const val LICENSE_HEADER = BackendWire.HEADER_LICENSE

        fun of(request: HttpServletRequest): PolarisKeyRequest? = request.getAttribute(ATTRIBUTE) as? PolarisKeyRequest
    }
}

/** The licence a gated request carries, or null when it carries none. Same as `@AuthenticationPrincipal PolarisLicense`. */
public val HttpServletRequest.polarisLicense: PolarisLicense? get() = PolarisKeyRequest.of(this)?.license

/**
 * The licence of a request behind a Polaris Key gate, non-null. Throws `IllegalStateException` on a
 * route with no gate, where [polarisLicense] is null.
 */
public fun HttpServletRequest.requirePolarisLicense(): PolarisLicense = polarisLicense ?: error(
    "this request has no verified license: gate the route with .access(PolarisKey.license()) (or entitlement, tier, signIn, all) in authorizeHttpRequests, and apply polarisKey() to the HttpSecurity, before calling requirePolarisLicense()",
)
