// @pkey-feature server.license server.signin
//
// The Ktor plugin as a developer meets it: tiers and requireAll, a valued entitlement, the CORS
// preflight, Cache-Control on streamed responses, the typed accessor, a custom 402, misconfiguration
// at startup and the test kit.

package im.plrs.key.server.ktor

import im.plrs.key.server.BackendRefusal
import im.plrs.key.server.PolarisProduct
import im.plrs.key.server.Require
import im.plrs.key.server.testing.PolarisTestKit
import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.options
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.basic
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respondText
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.get
import io.ktor.server.routing.options
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class KtorDxTest {
    private val kit = PolarisTestKit(product = "acme")

    private fun Application.setup(configure: PolarisKeyAuthConfig.() -> Unit = {}) {
        install(Authentication) { polarisKey { useTestKit(kit); configure() } }
    }

    private suspend fun HttpClient.getWith(path: String, headers: Map<String, String>): HttpResponse =
        get(path) { for ((n, v) in headers) header(n, v) }

    @Test
    fun tiersAndRequireAllRefuseWithTheFirstUnmetRequirement() = testApplication {
        application {
            setup()
            routing {
                requireTier("pro", "team") { get("/team") { call.respondText("team:${call.requirePolarisLicense().tier}") } }
                requireAll(Require.signIn(), Require.tier("pro"), Require.entitlement("export.pdf")) { get("/all") { call.respondText("all") } }
                requireEntitlement("seats", test = { it is JsonPrimitive && (it.intOrNull ?: 0) >= 5 }) { get("/seats") { call.respondText("seats") } }
            }
        }
        assertEquals("team:team", client.getWith("/team", kit.signedHeaders { tier = "team" }).bodyAsText())
        val free = client.getWith("/team", kit.signedHeaders { tier = "free" })
        assertEquals(HttpStatusCode.Forbidden, free.status)
        assertTrue(free.bodyAsText().contains("not_entitled"))
        assertEquals(HttpStatusCode.Unauthorized, client.get("/team").status)
        // requireAll: the sign-in is checked before the tier.
        val keyOnly = client.getWith("/all", kit.signedHeaders { tier = "free" })
        assertTrue(keyOnly.bodyAsText().contains("sign_in_required"))
        val signedIn = client.getWith("/all", kit.signedHeaders { signedIn(); tier = "free" })
        assertTrue(signedIn.bodyAsText().contains("not_entitled"))
        assertEquals("all", client.getWith("/all", kit.signedHeaders { signedIn(); tier = "pro"; entitle("export.pdf") }).bodyAsText())
        assertEquals("seats", client.getWith("/seats", kit.signedHeaders { entitlements["seats"] = 5 }).bodyAsText())
        assertEquals(HttpStatusCode.Forbidden, client.getWith("/seats", kit.signedHeaders { entitlements["seats"] = 2 }).status)
    }

    @Test
    fun theKitMakesEachVerdictOverHttp() = testApplication {
        application {
            setup()
            routing { requireEntitlement("export.pdf") { get("/x") { call.respondText("in") } } }
        }
        val statuses = listOf(BackendRefusal.LicenseRequired, BackendRefusal.LicenseInvalid, BackendRefusal.LicenseStale, BackendRefusal.NotEntitled)
            .associateWith { client.getWith("/x", kit.headersFor(it)).status.value }
        assertEquals(mapOf(BackendRefusal.LicenseRequired to 401, BackendRefusal.LicenseInvalid to 401, BackendRefusal.LicenseStale to 401, BackendRefusal.NotEntitled to 403), statuses)
        assertEquals("in", client.getWith("/x", kit.headersFor(null) { entitle("export.pdf") }).bodyAsText())
    }

    @Test
    fun aCorsPreflightPassesEveryGateUnlessAskedToGate() = testApplication {
        application {
            setup()
            routing {
                requireEntitlement("export.pdf") {
                    options("/x") { call.respondText("preflight-ok") }
                    get("/x") { call.respondText("in") }
                }
            }
        }
        fun HttpRequestBuilder.preflight() {
            header(HttpHeaders.Origin, "https://app.example.com")
            header("Access-Control-Request-Method", "GET")
            header("Access-Control-Request-Headers", "x-pkey-license, x-pkey-device")
        }
        assertEquals("preflight-ok", client.options("/x") { preflight() }.bodyAsText())
        // A plain OPTIONS without Access-Control-Request-Method is not a preflight: it is gated.
        assertEquals(HttpStatusCode.Unauthorized, client.options("/x").status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/x").status)
    }

    @Test
    fun preflightGateRefusesAPreflight() = testApplication {
        application {
            setup { preflight = PreflightMode.Gate }
            routing { requireLicense { options("/x") { call.respondText("preflight-ok") } } }
        }
        val r = client.options("/x") { header("Access-Control-Request-Method", "GET") }
        assertEquals(HttpStatusCode.Unauthorized, r.status)
    }

    @Test
    fun aStreamedResponseKeepsPrivateAndItsOwnCacheControl() = testApplication {
        application {
            setup()
            routing {
                requireLicense {
                    get("/stream") { call.respondTextWriter { write("chunk-1\n"); flush(); write("chunk-2\n") } }
                    get("/own") {
                        call.response.headers.append(HttpHeaders.CacheControl, "max-age=60")
                        call.respondTextWriter { write("x") }
                    }
                }
            }
        }
        val stream = client.getWith("/stream", kit.signedHeaders())
        assertEquals("chunk-1\nchunk-2\n", stream.bodyAsText())
        assertEquals("private", stream.headers[HttpHeaders.CacheControl])
        assertEquals("max-age=60", client.getWith("/own", kit.signedHeaders()).headers[HttpHeaders.CacheControl])
    }

    @Test
    fun theTypedAccessorThrowsAnActionableErrorOnAnUngatedRoute() = testApplication {
        var message: String? = null
        application {
            setup()
            install(StatusPages) { exception<IllegalStateException> { call, e -> message = e.message; call.respondText("misconfigured", status = HttpStatusCode.InternalServerError) } }
            routing {
                get("/oops") { call.respondText(call.requirePolarisLicense().id) }
                requireLicense { get("/ok") { call.respondText(call.requirePolarisLicense().id) } }
            }
        }
        assertEquals("lic_test", client.getWith("/ok", kit.signedHeaders()).bodyAsText())
        assertEquals(HttpStatusCode.InternalServerError, client.getWith("/oops", kit.signedHeaders()).status)
        assertTrue(message, message!!.contains("requireLicense { }"))
    }

    @Test
    fun onRefusalAnswersWithYourOwnStatusAndTheLocalizedBody() = testApplication {
        application {
            setup {
                onRefusal { call, problem ->
                    call.respondProblem(problem, if (problem.refusal == BackendRefusal.NotEntitled) HttpStatusCode.PaymentRequired else null)
                }
            }
            routing { requireTier("pro") { get("/x") { call.respondText("in") } } }
        }
        val r = client.getWith("/x", kit.signedHeaders { tier = "free" }.plus(HttpHeaders.AcceptLanguage to "de"))
        assertEquals(HttpStatusCode.PaymentRequired, r.status)
        assertEquals("no-store", r.headers[HttpHeaders.CacheControl])
        val body = r.bodyAsText()
        assertTrue(body, body.contains("\"code\":\"not_entitled\"") && !body.contains("\"title\":\"Not included\""))
        assertEquals(HttpStatusCode.Unauthorized, client.get("/x").status)
    }

    @Test
    fun nestedGatesAuthenticateOnce() = testApplication {
        val seen = CopyOnWriteArrayList<Pair<String?, Int>>()
        application {
            setup { onVerdict = { c, s -> seen += c to s } }
            routing {
                requireEntitlement("export.pdf") { requireTier("pro") { get("/x") { call.respondText("in") } } }
            }
        }
        assertEquals("in", client.getWith("/x", kit.signedHeaders { tier = "pro"; entitle("export.pdf") }).bodyAsText())
        assertEquals(listOf<Pair<String?, Int>>(null to 0), seen.toList())
        val r = client.getWith("/x", kit.signedHeaders { entitle("export.pdf") })
        assertEquals(HttpStatusCode.Forbidden, r.status)
    }

    @Test
    fun misconfigurationFailsAtStartupWithTheFix() {
        val noProducts = assertThrows(IllegalArgumentException::class.java) {
            testApplication { application { install(Authentication) { polarisKey { } } }; startApplication() }
        }
        assertTrue(noProducts.message!!, noProducts.message!!.contains("pkey sdk --lang kotlin --write"))
        val emptyPins = assertThrows(IllegalArgumentException::class.java) {
            testApplication { application { install(Authentication) { polarisKey { product("acme", emptyMap()) } } }; startApplication() }
        }
        assertTrue(emptyPins.message!!, emptyPins.message!!.contains("pinned keys for \"acme\" are empty"))
    }

    @Test
    fun aGateWithoutTheProviderSaysSoAtStartup() {
        val noAuth = assertThrows(IllegalStateException::class.java) {
            testApplication {
                application { routing { requireLicense { get("/x") { call.respondText("in") } } } }
                startApplication()
            }
        }
        assertTrue(noAuth.message!!, noAuth.message!!.contains("install(Authentication) { polarisKey"))
    }

    @Test
    fun aGateWithAnotherProviderOnlySaysSoAtStartup() {
        val other = assertThrows(IllegalStateException::class.java) {
            testApplication {
                application {
                    install(Authentication) { basic("other") { validate { null } } }
                    routing { requireLicense { get("/x") { call.respondText("in") } } }
                }
                startApplication()
            }
        }
        assertTrue(other.message!!, other.message!!.contains("found no polarisKey provider"))
    }

    @Test
    fun debugReportsATrustFetchThatFailed() = testApplication {
        val lines = CopyOnWriteArrayList<String>()
        application {
            setup {
                useTestKit(kit, trustRefresh = true)
                debug = { lines += it }
            }
            routing { requireLicense { get("/x") { call.respondText("in") } } }
        }
        kit.trust.offline = true
        assertEquals("in", client.getWith("/x", kit.signedHeaders()).bodyAsText())
        // The fetch runs in the background; the verdict line is already there.
        assertTrue(lines.toString(), lines.any { it.startsWith("polaris-key: pass ok kid=pkey-test-2026 aud=acme") })
    }

    @Test
    fun productBuilderTakesTheGeneratedConfigsValues() {
        val config = PolarisKeyAuthConfig("polaris-key")
        config.product("acme", kit.pinnedKeys, "http://localhost:8787")
        assertEquals(listOf(PolarisProduct("acme", kit.pinnedKeys, "http://localhost:8787")), config.products)
        assertFalse(config.products.isEmpty())
        assertNull(config.server)
    }
}
