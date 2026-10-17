// The Ktor plugin of the server drop-ins (SP-57): an `Authentication` provider that decides steps 1
// to 5 of WIRE-CONTRACT-V4 §14.2, and route plugins for step 6.
//
//     install(Authentication) { polarisKey { products = listOf(PolarisProduct("acme", pinnedKeys)) } }
//     routing {
//         requireEntitlement("export.pdf") {
//             get("/api/export") { call.respond(mapOf("tier" to call.principal<PolarisLicense>()!!.tier)) }
//         }
//     }
//
// A refusal is `application/problem+json` with `Cache-Control: no-store` and, on a 401, the
// `PKey-License` challenge. `onRefusal` replaces the response; `errors = ErrorMode.Throw` raises a
// `PolarisKeyError` into StatusPages instead. A passing request has the `PolarisLicense` as its
// principal, and a gated route that sets no `Cache-Control` gets `private`.
//
// The header, the JWS and the holder never reach a log from here: nothing in this module logs.

package im.plrs.key.server.ktor

import im.plrs.key.core.PolarisTransport
import im.plrs.key.server.BackendProblem
import im.plrs.key.server.BackendRefusal
import im.plrs.key.server.BackendRequirement
import im.plrs.key.server.PolarisAuth
import im.plrs.key.server.PolarisKeyError
import im.plrs.key.server.PolarisLicense
import im.plrs.key.server.PolarisProduct
import im.plrs.key.server.PolarisServer
import im.plrs.key.server.PolarisServerOptions
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.ApplicationStopped
import io.ktor.server.application.createRouteScopedPlugin
import io.ktor.server.application.install
import io.ktor.server.application.RouteScopedPlugin
import io.ktor.server.auth.AuthenticationChecked
import io.ktor.server.auth.AuthenticationConfig
import io.ktor.server.auth.AuthenticationContext
import io.ktor.server.auth.AuthenticationFailedCause
import io.ktor.server.auth.AuthenticationProvider
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.principal
import io.ktor.server.response.ApplicationSendPipeline
import io.ktor.server.response.PipelineResponse
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import io.ktor.util.AttributeKey
import java.util.concurrent.atomic.AtomicBoolean

/** The provider's name for `authenticate(PolarisKey.AUTH)`. */
public object PolarisKey {
    public const val AUTH: String = "polaris-key"
}

/** What a refusal does: answer the problem (the default), or throw [PolarisKeyError] into the error pipeline. */
public enum class ErrorMode { Respond, Throw }

/** Your own response to a refusal. The `no-store` and challenge headers are already set. */
public typealias RefusalHandler = suspend (call: ApplicationCall, problem: BackendProblem) -> Unit

public class PolarisKeyAuthConfig internal constructor(name: String?) : AuthenticationProvider.Config(name) {
    /** A server shared with other adapters. When set, the fields below are ignored and you close it. */
    public var server: PolarisServer? = null

    /** The products served; a document's `aud` picks its trust set. */
    public var products: List<PolarisProduct> = emptyList()

    /** Tighten the freshness window to this many seconds after `issuedAt` (plus the 300 s skew). */
    public var maxAgeSeconds: Long? = null

    /** False: verify against the pins alone, for an air-gapped server. */
    public var trustRefresh: Boolean = true
    public var transport: PolarisTransport? = null
    public var clock: (() -> Long)? = null

    /** Reports every verdict: the code (null for a pass) and the step. No header, no document. */
    public var onVerdict: ((code: String?, step: Int) -> Unit)? = null

    public var errors: ErrorMode = ErrorMode.Respond
    internal var refusal: RefusalHandler? = null

    /** Answer a refusal yourself. */
    public fun onRefusal(handler: RefusalHandler) {
        refusal = handler
    }
}

/** Adds the Polaris Key provider, named [PolarisKey.AUTH] unless [name] says otherwise. */
public fun AuthenticationConfig.polarisKey(name: String? = PolarisKey.AUTH, configure: PolarisKeyAuthConfig.() -> Unit) {
    val config = PolarisKeyAuthConfig(name).apply(configure)
    register(PolarisKeyProvider(config))
}

/** The server, its refusal and the request's problem, for the route plugins that run after the provider. */
internal class Gate(val server: PolarisServer, val errors: ErrorMode, val onRefusal: RefusalHandler?)

private val GateKey = AttributeKey<Gate>("polaris-key.gate")
private val LicenseKey = AttributeKey<PolarisLicense>("polaris-key.license")
private val ProblemKey = AttributeKey<BackendProblem>("polaris-key.problem")

private class PolarisKeyProvider(config: PolarisKeyAuthConfig) : AuthenticationProvider(config) {
    private val owned: Boolean = config.server == null
    private val server: PolarisServer = config.server ?: PolarisServer(
        PolarisServerOptions(
            products = config.products,
            maxAgeSeconds = config.maxAgeSeconds,
            trustRefresh = config.trustRefresh,
            transport = config.transport,
            clock = config.clock,
            onVerdict = config.onVerdict,
        ),
    )
    private val gate = Gate(server, config.errors, config.refusal)
    private val subscribed = AtomicBoolean(false)

    override suspend fun onAuthenticate(context: AuthenticationContext) {
        val call = context.call
        if (owned && subscribed.compareAndSet(false, true)) {
            call.application.closeWhenStopped(server)
        }
        server.start()
        call.attributes.put(GateKey, gate)
        val headers = call.request.headers.entries().flatMap { (name, values) -> values.map { name to it } }
        val auth = server.authenticate(headers, emptyList(), call.request.headers[HttpHeaders.AcceptLanguage])
        val license = auth.license
        if (license != null) {
            call.attributes.put(LicenseKey, license)
            context.principal(license)
            // A gated response is the caller's: shared caches must not keep it (§5.2).
            (call.response as PipelineResponse).pipeline.intercept(ApplicationSendPipeline.Before) {
                if (call.response.headers[HttpHeaders.CacheControl] == null) call.response.header(HttpHeaders.CacheControl, "private")
            }
            return
        }
        val problem = auth.problem!!
        call.attributes.put(ProblemKey, problem)
        context.challenge(PolarisKey.AUTH, AuthenticationFailedCause.InvalidCredentials) { challenge, failed ->
            refuse(failed, gate, problem)
            challenge.complete()
        }
    }
}

private fun Application.closeWhenStopped(server: PolarisServer) {
    monitor.subscribe(ApplicationStopped) { server.close() }
}

internal suspend fun refuse(call: ApplicationCall, gate: Gate, problem: BackendProblem) {
    if (gate.errors == ErrorMode.Throw) throw PolarisKeyError(problem)
    for ((name, value) in problem.headers) if (name != HttpHeaders.ContentType) call.response.header(name, value)
    val handler = gate.onRefusal
    if (handler != null) {
        handler(call, problem)
        return
    }
    call.respondText(problem.body, ContentType.parse(problem.headers.getValue(HttpHeaders.ContentType)), HttpStatusCode.fromValue(problem.status))
}

/** The request's licence and problem: `license` after a passing gate, `problem` after a refusal, neither on an open route. */
public val ApplicationCall.polarisAuth: PolarisAuth
    get() = PolarisAuth(attributes.getOrNull(LicenseKey), attributes.getOrNull(ProblemKey))

/** The licence a passing gate attached, or null. Same as `principal<PolarisLicense>()`. */
public val ApplicationCall.polarisLicense: PolarisLicense? get() = attributes.getOrNull(LicenseKey)

public class RequireEntitlementConfig {
    /** The boolean entitlement the route needs. */
    public var name: String = ""
}

public class RequireSignInConfig

private suspend fun check(call: ApplicationCall, pluginName: String, required: BackendRequirement) {
    val gate = call.attributes.getOrNull(GateKey) ?: error("install $pluginName inside authenticate(PolarisKey.AUTH)")
    val license = call.principal<PolarisLicense>() ?: error("install $pluginName inside authenticate(PolarisKey.AUTH)")
    val missing = when (required) {
        is BackendRequirement.Entitlement -> if (license.isEntitled(required.name)) null else BackendRefusal.NotEntitled
        BackendRequirement.SignIn -> if (license.user != null) null else BackendRefusal.SignInRequired
    }
    if (missing != null) gate.server.options.onVerdict?.invoke(missing.code, 6)
    if (missing != null) refuse(call, gate, gate.server.problem(missing.code, call.request.headers[HttpHeaders.AcceptLanguage]))
}

/** Step 6 for an entitlement: `install(RequireEntitlement) { name = "export.pdf" }` inside `authenticate(PolarisKey.AUTH)`. */
public val RequireEntitlement: RouteScopedPlugin<RequireEntitlementConfig> =
    createRouteScopedPlugin("PolarisRequireEntitlement", ::RequireEntitlementConfig) {
        val name = pluginConfig.name
        require(name.isNotEmpty()) { "RequireEntitlement.name is empty" }
        on(AuthenticationChecked) { call -> check(call, "RequireEntitlement", BackendRequirement.Entitlement(name)) }
    }

/** Step 6 for a signed-in account: `install(RequireSignIn)` inside `authenticate(PolarisKey.AUTH)`. */
public val RequireSignIn: RouteScopedPlugin<RequireSignInConfig> =
    createRouteScopedPlugin("PolarisRequireSignIn", ::RequireSignInConfig) {
        on(AuthenticationChecked) { call -> check(call, "RequireSignIn", BackendRequirement.SignIn) }
    }

/** A route that needs a usable licence document (steps 1 to 5). */
public fun Route.requireLicense(build: Route.() -> Unit): Route = authenticate(PolarisKey.AUTH, build = build)

/** A route that also needs boolean entitlement [name] (step 6). */
public fun Route.requireEntitlement(name: String, build: Route.() -> Unit): Route = requireLicense {
    install(RequireEntitlement) { this.name = name }
    build()
}

/** A route that also needs a signed-in account (step 6). */
public fun Route.requireSignIn(build: Route.() -> Unit): Route = requireLicense {
    install(RequireSignIn)
    build()
}
