// @pkey-feature server.license server.signin
//
// The Ktor plugin's own behaviour beyond the matrix: onRefusal, errors = throw into StatusPages, the
// locale of the problem, Cache-Control, the principal and PolarisAuth, and that nothing the holder
// or the header carries reaches a log line or a toString.

package im.plrs.key.server.ktor

import im.plrs.key.core.testing.TestSigner
import im.plrs.key.server.PolarisKeyError
import im.plrs.key.server.PolarisLicense
import im.plrs.key.server.PolarisProduct
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.principal
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class KtorPluginTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner("acme-key")
    private val subject = "ps_" + "A".repeat(22)
    private val profile = JsonObject(mapOf("name" to JsonPrimitive("Grace Hopper"), "email" to JsonPrimitive("grace@example.com")))
    private val signedIn = JsonObject(profile + ("user" to JsonObject(mapOf("subject" to JsonPrimitive(subject)))))

    private fun doc(entitlements: Map<String, kotlinx.serialization.json.JsonElement> = emptyMap(), profile: JsonObject? = this.profile, at: Long = now) =
        signer.licenseDoc("acme", "dev_1", at, entitlements + ("license.tier" to JsonPrimitive("pro")), profile = profile)

    private fun Application.setup(configure: PolarisKeyAuthConfig.() -> Unit = {}) {
        install(Authentication) {
            polarisKey {
                products = listOf(PolarisProduct("acme", signer.trust))
                trustRefresh = false
                clock = { now }
                configure()
            }
        }
    }

    @Test
    fun aPassingRouteReadsThePrincipalAndGetsPrivateCacheControl() = testApplication {
        application {
            setup()
            routing {
                requireEntitlement("export.pdf") {
                    get("/api/export") {
                        val l = call.principal<PolarisLicense>()!!
                        assertEquals(l.id, call.polarisLicense!!.id)
                        assertEquals(l.id, call.polarisAuth.license!!.id)
                        call.respondText("${l.tier}:${l.holder!!.name}:${l.isEntitled("export.pdf")}:${l.user}")
                    }
                }
                requireLicense {
                    get("/api/own-cache") {
                        call.response.header(HttpHeaders.CacheControl, "max-age=5")
                        call.respondText("ok")
                    }
                }
            }
        }
        val ok = client.get("/api/export") { header("X-PKey-License", doc(mapOf("export.pdf" to JsonPrimitive(true)))) }
        assertEquals(HttpStatusCode.OK, ok.status)
        assertEquals("pro:Grace Hopper:true:null", ok.bodyAsText())
        assertEquals("private", ok.headers[HttpHeaders.CacheControl])
        val own = client.get("/api/own-cache") { header("X-PKey-License", doc()) }
        assertEquals("max-age=5", own.headers[HttpHeaders.CacheControl])
    }

    @Test
    fun anOpenRouteNeedsNothing() = testApplication {
        application {
            setup()
            routing {
                get("/open") { call.respondText("open:${call.polarisAuth.license}:${call.polarisAuth.problem}") }
                requireLicense { get("/gated") { call.respondText("in") } }
            }
        }
        assertEquals("open:null:null", client.get("/open").bodyAsText())
        assertEquals(HttpStatusCode.Unauthorized, client.get("/gated").status)
    }

    @Test
    fun theProblemSpeaksTheAcceptedLanguage() = testApplication {
        application {
            setup()
            routing { requireLicense { get("/gated") { call.respondText("in") } } }
        }
        val en = client.get("/gated")
        val de = client.get("/gated") { header(HttpHeaders.AcceptLanguage, "de-DE,de;q=0.9,en;q=0.5") }
        assertTrue(en.bodyAsText().contains("\"title\":\"License needed\""))
        assertTrue(de.bodyAsText().contains("\"code\":\"license_required\""))
        assertFalse(de.bodyAsText() == en.bodyAsText())
        assertEquals("PKey-License realm=\"acme\", error=\"license_required\"", de.headers[HttpHeaders.WWWAuthenticate])
    }

    @Test
    fun signInNeedsAnAccount() = testApplication {
        application {
            setup()
            routing { requireSignIn { get("/me") { call.respondText(call.principal<PolarisLicense>()!!.user!!.subject) } } }
        }
        val keyOnly = client.get("/me") { header("X-PKey-License", doc()) }
        assertEquals(HttpStatusCode.Forbidden, keyOnly.status)
        assertTrue(keyOnly.bodyAsText().contains("sign_in_required"))
        assertNull(keyOnly.headers[HttpHeaders.WWWAuthenticate])
        assertEquals(subject, client.get("/me") { header("X-PKey-License", doc(profile = signedIn)) }.bodyAsText())
    }

    @Test
    fun onRefusalReplacesTheResponseButKeepsNoStore() = testApplication {
        application {
            setup {
                onRefusal { call, problem -> call.respondText("custom:${problem.code}", status = HttpStatusCode.fromValue(problem.status)) }
            }
            routing { requireEntitlement("export.pdf") { get("/x") { call.respondText("in") } } }
        }
        val missing = client.get("/x")
        assertEquals(HttpStatusCode.Unauthorized, missing.status)
        assertEquals("custom:license_required", missing.bodyAsText())
        assertEquals("no-store", missing.headers[HttpHeaders.CacheControl])
        assertTrue(missing.headers[HttpHeaders.WWWAuthenticate]!!.startsWith("PKey-License realm=\"acme\""))
        val notEntitled = client.get("/x") { header("X-PKey-License", doc()) }
        assertEquals(HttpStatusCode.Forbidden, notEntitled.status)
        assertEquals("custom:not_entitled", notEntitled.bodyAsText())
    }

    @Test
    fun errorsThrowRaisesPolarisKeyErrorIntoStatusPages() = testApplication {
        application {
            install(StatusPages) {
                exception<PolarisKeyError> { call, e ->
                    call.respondText("mine:${e.problem.code}:${e.status}:${e.headers["Cache-Control"]}", status = HttpStatusCode.fromValue(e.status))
                }
            }
            setup { errors = ErrorMode.Throw }
            routing {
                requireEntitlement("export.pdf") { get("/x") { call.respondText("in") } }
            }
        }
        assertEquals("mine:license_required:401:no-store", client.get("/x").bodyAsText())
        val r = client.get("/x") { header("X-PKey-License", doc()) }
        assertEquals(HttpStatusCode.Forbidden, r.status)
        assertEquals("mine:not_entitled:403:no-store", r.bodyAsText())
    }

    @Test
    fun aRequirementOutsideAuthenticateFailsClosed() = testApplication {
        application {
            setup()
            install(StatusPages) { exception<IllegalStateException> { call, _ -> call.respondText("misconfigured", status = HttpStatusCode.InternalServerError) } }
            routing {
                authenticate(PolarisKey.AUTH, optional = true) {
                    install(RequireEntitlement) { name = "x" }
                    get("/x") { call.respondText("in") }
                }
            }
        }
        // optional: no principal, the requirement must not let it through.
        val r = client.get("/x")
        assertTrue(r.status.value >= 400)
        assertFalse(r.bodyAsText() == "in")
    }

    @Test
    fun noHolderDataInTheTypesStringForms() {
        val license = im.plrs.key.server.PolarisServer(
            im.plrs.key.server.PolarisServerOptions(listOf(PolarisProduct("acme", signer.trust)), trustRefresh = false, clock = { now }),
        )
        val v = kotlinx.coroutines.runBlocking {
            license.verdict(listOf("X-PKey-License" to doc(profile = signedIn)))
        }
        val shown = listOf(v.toString(), v.context.toString(), v.context!!.license.toString(), v.context!!.license.holder.toString())
        for (s in shown) {
            assertFalse(s, s.contains("Grace") || s.contains("example.com") || s.contains(subject))
        }
        license.close()
    }
}
