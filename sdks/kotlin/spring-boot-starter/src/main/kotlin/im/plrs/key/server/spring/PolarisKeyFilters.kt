// The servlet filters of the starter. The first reads the request, decides steps 1 to 5 only when the request
// carries a licence header (an open route that gets no header costs nothing), and puts the licence in the
// SecurityContext. It never refuses: the gates do (PolarisKeyAuthorization), and the entry point and
// access-denied handler answer. The second marks a granted gated response `private`.

package im.plrs.key.server.spring

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.core.context.SecurityContextHolderStrategy
import org.springframework.web.filter.OncePerRequestFilter
import im.plrs.key.server.PolarisServer

internal fun HttpServletRequest.isCorsPreflight(): Boolean =
    HttpMethod.OPTIONS.matches(method) && getHeader(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD) != null

public class PolarisKeyAuthenticationFilter(
    private val server: PolarisServer,
    private val provider: PolarisKeyAuthenticationProvider,
    private val preflight: PreflightMode,
) : OncePerRequestFilter() {
    private val strategy: SecurityContextHolderStrategy = SecurityContextHolder.getContextHolderStrategy()

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        // A browser sends no custom header on a preflight; let the CORS filter or the route's own OPTIONS answer.
        val isPreflight = preflight == PreflightMode.Pass && request.isCorsPreflight()
        val state = PolarisKeyRequest(server, provider, request, isPreflight)
        request.setAttribute(PolarisKeyRequest.ATTRIBUTE, state)
        if (!isPreflight && request.getHeader(PolarisKeyRequest.LICENSE_HEADER) != null) {
            val license = state.auth().license
            if (license != null) {
                val context = strategy.createEmptyContext()
                context.authentication = PolarisKeyAuthenticationToken.authenticatedFor(license)
                strategy.context = context
            }
        }
        chain.doFilter(request, response)
    }
}

/** After the authorization filter: a gate that granted marks its response `private` unless the route set a Cache-Control. */
internal class PolarisKeyPrivateFilter : OncePerRequestFilter() {
    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        if (request.getAttribute(PolarisKeyRequest.GATED) == true && response.getHeader(HttpHeaders.CACHE_CONTROL) == null) {
            response.setHeader(HttpHeaders.CACHE_CONTROL, "private")
        }
        chain.doFilter(request, response)
    }
}
