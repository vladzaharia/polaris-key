// The Ktor plugin of the server drop-ins (SP-57): an `Authentication` provider that decides steps 1
// to 5 of WIRE-CONTRACT-V4 §14.2, and route plugins for step 6.
//
//     install(Authentication) { polarisKey { product(PolarisConfig.PRODUCT_SLUG, PolarisConfig.pinnedKeys, PolarisConfig.BASE_URL) } }
//     routing {
//         get("/health") { call.respondText("ok") }                         // no gate: open
//         requireLicense { get("/api/me") { call.respond(call.requirePolarisLicense().tier ?: "none") } }
//         requireEntitlement("export.pdf") { get("/api/export") { … } }
//         requireTier("pro", "team") { get("/api/team") { … } }
//         requireAll(Require.signIn(), Require.tier("pro")) { get("/api/me/pro") { … } }
//     }
//
// A refusal is `application/problem+json` with `Cache-Control: no-store` and, on a 401, the
// `PKey-License` challenge. `onRefusal` replaces the response; `errors = ErrorMode.Throw` raises a
// `PolarisKeyError` into StatusPages instead. A passing request has the `PolarisLicense` as its
// principal, and a gated response that sets no `Cache-Control` gets `private` when it is sent. A CORS
// preflight (`OPTIONS` with `Access-Control-Request-Method`) passes every gate: it carries no licence.
//
// The header, the JWS and the holder never reach a log from here: `debug` carries the step, the key
// id and a short device hash, nothing else.

package im.plrs.key.server.ktor

import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.TrustSet
import im.plrs.key.server.BackendProblem
import im.plrs.key.server.BackendRefusal
import im.plrs.key.server.BackendRequirement
import im.plrs.key.server.Require
import im.plrs.key.server.PolarisAuth
import im.plrs.key.server.PolarisKeyError
import im.plrs.key.server.PolarisLicense
import im.plrs.key.server.PolarisProduct
import im.plrs.key.server.PolarisServer
import im.plrs.key.server.PolarisServerOptions
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.ApplicationStopped
import io.ktor.server.application.createRouteScopedPlugin
import io.ktor.server.application.install
import io.ktor.server.application.pluginOrNull
import io.ktor.server.application.RouteScopedPlugin
import io.ktor.server.auth.Authentication
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
import io.ktor.server.routing.application
import kotlinx.serialization.json.JsonElement
import io.ktor.util.AttributeKey
import java.util.concurrent.atomic.AtomicBoolean

/** The provider's name for `authenticate(PolarisKey.AUTH)`. */
public object PolarisKey {
    public const val AUTH: String = "polaris-key"
}

/** What a refusal does: answer the problem (the default), or throw [PolarisKeyError] into the error pipeline. */
public enum class ErrorMode { Respond, Throw }

/** What a CORS preflight does at a gate: [Pass] (the default) lets it through, [Gate] refuses it like any other request. */
public enum class PreflightMode { Pass, Gate }

/** Your own response to a refusal. The `no-store` and challenge headers are already set. */
public typealias RefusalHandler = suspend (call: ApplicationCall, problem: BackendProblem) -> Unit

public class PolarisKeyAuthConfig internal constructor(name: String?) : AuthenticationProvider.Config(name) {
    /** A server shared with other adapters. When set, the fields below are ignored and you close it. */
    public var server: PolarisServer? = null

    /** The products served; a document's `aud` picks its trust set. See [product]. */
    public var products: List<PolarisProduct> = emptyList()

    /** Add one product: `product(PolarisConfig.PRODUCT_SLUG, PolarisConfig.pinnedKeys, PolarisConfig.BASE_URL)`. */
    public fun product(slug: String, pinnedKeys: TrustSet, baseUrl: String = "https://key.plrs.im") {
        products = products + PolarisProduct(slug, pinnedKeys, baseUrl)
    }

    /** Tighten the freshness window to this many seconds after `issuedAt` (plus the 300 s skew). */
    public var maxAgeSeconds: Long? = null

    /** False: verify against the pins alone, for an air-gapped server. */
    public var trustRefresh: Boolean = true
    public var transport: PolarisTransport? = null
    public var clock: (() -> Long)? = null

    /** Reports every verdict: the code (null for a pass) and the step. No header, no document. */
    public var onVerdict: ((code: String?, step: Int) -> Unit)? = null

    /**
     * Debug lines: the step, the key id and a short device hash per verdict, and why a trust fetch
     * failed (the pinned keys keep verifying). Never the header: `debug = logger::debug` is safe.
     */
    public var debug: ((line: String) -> Unit)? = null

    public var errors: ErrorMode = ErrorMode.Respond

    /** A CORS preflight passes every gate by default: it carries no licence. [PreflightMode.Gate] refuses it. */
    public var preflight: PreflightMode = PreflightMode.Pass
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
internal class Gate(val server: PolarisServer, val errors: ErrorMode, val onRefusal: RefusalHandler?, val preflight: PreflightMode)

private val GateKey = AttributeKey<Gate>("polaris-key.gate")
private val LicenseKey = AttributeKey<PolarisLicense>("polaris-key.license")
private val ProblemKey = AttributeKey<BackendProblem>("polaris-key.problem")
private val PrivateGuardKey = AttributeKey<Boolean>("polaris-key.private-guard")

/** The principal of a CORS preflight that passed: no licence, and no requirement is checked. */
internal object PolarisPreflight

private fun ApplicationCall.isCorsPreflight(): Boolean =
    request.local.method == HttpMethod.Options && request.headers["Access-Control-Request-Method"] != null

private class PolarisKeyProvider(config: PolarisKeyAuthConfig) : AuthenticationProvider(config) {
    private val owned: Boolean = config.server == null
    private val server: PolarisServer = config.server?.also {
        require(config.products.isEmpty()) {
            "polarisKey { }: both server and products are set; products belong to the server you pass, so drop them here"
        }
    } ?: PolarisServer(
        PolarisServerOptions(
            products = config.products,
            maxAgeSeconds = config.maxAgeSeconds,
            trustRefresh = config.trustRefresh,
            transport = config.transport,
            clock = config.clock,
            onVerdict = config.onVerdict,
            debug = config.debug,
        ),
    )
    private val gate = Gate(server, config.errors, config.refusal, config.preflight)
    private val subscribed = AtomicBoolean(false)

    override suspend fun onAuthenticate(context: AuthenticationContext) {
        val call = context.call
        if (owned && subscribed.compareAndSet(false, true)) {
            call.application.closeWhenStopped(server)
        }
        server.start()
        call.attributes.put(GateKey, gate)
        if (gate.preflight == PreflightMode.Pass && call.isCorsPreflight()) {
            // A browser sends no custom header on a preflight; let the CORS plugin or the route's own OPTIONS answer.
            context.principal(PolarisPreflight)
            return
        }
        val headers = call.request.headers.entries().flatMap { (name, values) -> values.map { name to it } }
        val auth = server.authenticate(headers, emptyList(), call.request.headers[HttpHeaders.AcceptLanguage])
        val license = auth.license
        if (license != null) {
            call.attributes.put(LicenseKey, license)
            context.principal(license)
            // A gated response is the caller's: shared caches must not keep it (§5.2). Set when the response
            // is sent, so a streamed or raw response that set its own Cache-Control keeps it.
            if (call.attributes.getOrNull(PrivateGuardKey) == null) {
                call.attributes.put(PrivateGuardKey, true)
                (call.response as PipelineResponse).pipeline.intercept(ApplicationSendPipeline.Before) {
                    if (call.response.headers[HttpHeaders.CacheControl] == null) call.response.header(HttpHeaders.CacheControl, "private")
                }
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

/**
 * The licence of a request behind a `requireLicense { }` (or another `require*`) gate, non-null.
 * Throws `IllegalStateException` on a route with no gate, where [polarisLicense] is null.
 */
public fun ApplicationCall.requirePolarisLicense(): PolarisLicense = polarisLicense ?: error(
    "this request has no verified license: put the route inside requireLicense { } (or requireEntitlement, requireTier, requireSignIn, requireAll) before calling requirePolarisLicense()",
)

/**
 * Answer [problem] as `application/problem+json`, with its headers and, unless [status] says
 * otherwise, its status. For an `onRefusal` hook that changes the status and keeps the body:
 *
 *     onRefusal { call, problem -> call.respondProblem(problem, if (problem.refusal == BackendRefusal.NotEntitled) HttpStatusCode.PaymentRequired else null) }
 */
public suspend fun ApplicationCall.respondProblem(problem: BackendProblem, status: HttpStatusCode? = null) {
    for ((name, value) in problem.headers) if (name != HttpHeaders.ContentType) response.header(name, value)
    respondText(problem.body, ContentType.parse(problem.headers.getValue(HttpHeaders.ContentType)), status ?: HttpStatusCode.fromValue(problem.status))
}

public class RequireEntitlementConfig {
    /** The boolean entitlement the route needs. */
    public var name: String = ""

    /** Set: the entitlement is valued and this accepts it (a seat count, a list). Null: it must be boolean true. */
    public var test: ((JsonElement) -> Boolean)? = null
}

public class RequireSignInConfig

public class RequireTierConfig {
    /** The tiers that may use the route: the `license.tier` entitlement must be one of them. */
    public var tiers: List<String> = emptyList()
}

public class RequireAllConfig {
    /** The requirements, checked in order; the first that fails refuses. Build them with [Require]. */
    public var requirements: List<BackendRequirement> = emptyList()
}

private suspend fun check(call: ApplicationCall, pluginName: String, required: List<BackendRequirement>) {
    val gate = call.attributes.getOrNull(GateKey) ?: error("install $pluginName inside authenticate(PolarisKey.AUTH), and install(Authentication) { polarisKey { } } first")
    val license = call.principal<PolarisLicense>()
    if (license == null) {
        // A passing preflight carries no licence and nothing to check.
        if (call.principal<PolarisPreflight>() != null) return
        error("install $pluginName inside authenticate(PolarisKey.AUTH) (not optional)")
    }
    val problem = gate.server.refusalFor(license, required, call.request.headers[HttpHeaders.AcceptLanguage])
    if (problem != null) {
        call.attributes.put(ProblemKey, problem)
        refuse(call, gate, problem)
    }
}

/** Step 6 for an entitlement: `install(RequireEntitlement) { name = "export.pdf" }` inside `authenticate(PolarisKey.AUTH)`. */
public val RequireEntitlement: RouteScopedPlugin<RequireEntitlementConfig> =
    createRouteScopedPlugin("PolarisRequireEntitlement", ::RequireEntitlementConfig) {
        val name = pluginConfig.name
        require(name.isNotEmpty()) { "RequireEntitlement.name is empty; name the entitlement the route needs, for example install(RequireEntitlement) { name = \"export.pdf\" }" }
        val requirement = BackendRequirement.Entitlement(name, pluginConfig.test)
        on(AuthenticationChecked) { call -> check(call, "RequireEntitlement", listOf(requirement)) }
    }

/** Step 6 for a tier: `install(RequireTier) { tiers = listOf("pro", "team") }` inside `authenticate(PolarisKey.AUTH)`. */
public val RequireTier: RouteScopedPlugin<RequireTierConfig> =
    createRouteScopedPlugin("PolarisRequireTier", ::RequireTierConfig) {
        val requirement = BackendRequirement.Tier(pluginConfig.tiers)
        on(AuthenticationChecked) { call -> check(call, "RequireTier", listOf(requirement)) }
    }

/** Step 6 for a signed-in account: `install(RequireSignIn)` inside `authenticate(PolarisKey.AUTH)`. */
public val RequireSignIn: RouteScopedPlugin<RequireSignInConfig> =
    createRouteScopedPlugin("PolarisRequireSignIn", ::RequireSignInConfig) {
        on(AuthenticationChecked) { call -> check(call, "RequireSignIn", listOf(BackendRequirement.SignIn)) }
    }

/** Step 6 for several requirements, in order: `install(RequireAll) { requirements = listOf(Require.signIn(), Require.tier("pro")) }`. */
public val RequireAll: RouteScopedPlugin<RequireAllConfig> =
    createRouteScopedPlugin("PolarisRequireAll", ::RequireAllConfig) {
        val requirements = pluginConfig.requirements
        on(AuthenticationChecked) { call -> check(call, "RequireAll", requirements) }
    }

/** A route that needs a usable licence document (steps 1 to 5). */
public fun Route.requireLicense(build: Route.() -> Unit): Route {
    check(application.pluginOrNull(Authentication) != null) {
        "requireLicense { } needs the provider first: add install(Authentication) { polarisKey { product(PolarisConfig.PRODUCT_SLUG, PolarisConfig.pinnedKeys, PolarisConfig.BASE_URL) } } before routing { }"
    }
    return try {
        authenticate(PolarisKey.AUTH, build = build)
    } catch (e: IllegalArgumentException) {
        // Ktor's own message when Authentication has no provider by this name; a failure inside `build` passes through.
        if (e.message?.contains("name ${PolarisKey.AUTH} was not found") != true) throw e
        throw IllegalStateException(
            "requireLicense { } found no polarisKey provider: add polarisKey { product(PolarisConfig.PRODUCT_SLUG, PolarisConfig.pinnedKeys, PolarisConfig.BASE_URL) } inside install(Authentication) { } before routing { }, and keep its name \"${PolarisKey.AUTH}\"",
            e,
        )
    }
}

/** A route that also needs boolean entitlement [name] (step 6). */
public fun Route.requireEntitlement(name: String, build: Route.() -> Unit): Route = requireLicense {
    install(RequireEntitlement) { this.name = name }
    build()
}

/** A route that also needs valued entitlement [name] to satisfy [test], for example a seat count (step 6). */
public fun Route.requireEntitlement(name: String, test: (JsonElement) -> Boolean, build: Route.() -> Unit): Route = requireLicense {
    install(RequireEntitlement) {
        this.name = name
        this.test = test
    }
    build()
}

/** A route that also needs the license's tier to be one of [tiers] (step 6). */
public fun Route.requireTier(vararg tiers: String, build: Route.() -> Unit): Route = requireLicense {
    install(RequireTier) { this.tiers = tiers.toList() }
    build()
}

/** A route that also needs a signed-in account (step 6). */
public fun Route.requireSignIn(build: Route.() -> Unit): Route = requireLicense {
    install(RequireSignIn)
    build()
}

/** A route that needs every one of [requirements], checked in order: `requireAll(Require.signIn(), Require.tier("pro")) { … }`. */
public fun Route.requireAll(vararg requirements: BackendRequirement, build: Route.() -> Unit): Route = requireLicense {
    install(RequireAll) { this.requirements = requirements.toList() }
    build()
}
