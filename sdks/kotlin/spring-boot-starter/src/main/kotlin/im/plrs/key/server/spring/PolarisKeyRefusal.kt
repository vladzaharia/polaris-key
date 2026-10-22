// The refusal half: an AuthenticationEntryPoint (steps 1 to 5, 401) and an AccessDeniedHandler (step 6, 403)
// that send the localized problem body, `application/problem+json` with `Cache-Control: no-store` and, on a
// 401, the `PKey-License` challenge. `errors = throw` raises `PolarisKeyError` into the MVC exception
// resolvers instead (`@ExceptionHandler`, `@ControllerAdvice`).

package im.plrs.key.server.spring

import im.plrs.key.server.BackendProblem
import im.plrs.key.server.PolarisKeyError
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpHeaders
import org.springframework.security.access.AccessDeniedException
import org.springframework.security.core.AuthenticationException
import org.springframework.security.web.AuthenticationEntryPoint
import org.springframework.security.web.access.AccessDeniedHandler
import org.springframework.web.servlet.HandlerExceptionResolver

/** Your own response to a refusal. The problem's headers are NOT yet set; [respondProblem] sets them. */
public fun interface PolarisKeyRefusalHandler {
    public fun handle(request: HttpServletRequest, response: HttpServletResponse, problem: BackendProblem)
}

/**
 * Answer [problem] as `application/problem+json`, with its headers and, unless [status] says
 * otherwise, its status. For a [PolarisKeyRefusalHandler] that changes the status and keeps the body.
 */
@JvmOverloads
public fun HttpServletResponse.respondProblem(problem: BackendProblem, status: Int? = null) {
    this.status = status ?: problem.status
    for ((name, value) in problem.headers) {
        if (name.equals(HttpHeaders.CONTENT_TYPE, ignoreCase = true)) contentType = value else setHeader(name, value)
    }
    characterEncoding = "UTF-8"
    writer.write(problem.body)
    writer.flush()
}

internal class PolarisKeyRefusals(
    private val errors: ErrorMode,
    private val resolver: HandlerExceptionResolver?,
    private val handler: PolarisKeyRefusalHandler?,
) {
    fun refuse(request: HttpServletRequest, response: HttpServletResponse, problem: BackendProblem) {
        if (errors == ErrorMode.Throw) {
            val error = PolarisKeyError(problem)
            if (resolver?.resolveException(request, response, null, error) != null) return
            throw error
        }
        (handler ?: PolarisKeyRefusalHandler { _, res, p -> res.respondProblem(p) }).handle(request, response, problem)
    }
}

/** Steps 1 to 5 refused, or no licence on a gated route: 401 with the challenge. */
public class PolarisKeyAuthenticationEntryPoint internal constructor(private val refusals: PolarisKeyRefusals) : AuthenticationEntryPoint {
    override fun commence(request: HttpServletRequest, response: HttpServletResponse, authException: AuthenticationException) {
        val problem = (authException as? PolarisKeyAuthenticationException)?.problem ?: PolarisKeyRequest.of(request)?.refusal
            ?: throw authException
        refusals.refuse(request, response, problem)
    }
}

/** Step 6 refused (`not_entitled`, `sign_in_required`): 403. */
public class PolarisKeyAccessDeniedHandler internal constructor(private val refusals: PolarisKeyRefusals) : AccessDeniedHandler {
    override fun handle(request: HttpServletRequest, response: HttpServletResponse, accessDeniedException: AccessDeniedException) {
        val problem = PolarisKeyRequest.of(request)?.refusal ?: throw accessDeniedException
        refusals.refuse(request, response, problem)
    }
}
