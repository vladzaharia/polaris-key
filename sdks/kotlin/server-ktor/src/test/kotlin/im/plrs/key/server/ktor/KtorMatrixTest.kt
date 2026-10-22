// @pkey-feature server.license server.signin
//
// A gated Ktor route answers each verdict row of conformance/corpus/v2/backend-matrix.json over real
// request/response (Ktor's test host): the status, the problem body's code, the challenge, the
// no-store and, on a pass, the context the route reads from its principal.

package im.plrs.key.server.ktor

import im.plrs.key.core.JsonText
import im.plrs.key.core.TrustSet
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.server.BackendRequirement
import im.plrs.key.server.PolarisProduct
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.principal
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KtorMatrixTest {
    /** PolarisProduct refuses an empty pin set (nothing could verify). A row with no keys gets one pin that signed nothing: the same verdict. */
    private val noSigner: TrustSet = mapOf("unused-pin" to "A".repeat(43))

    private val root = File(System.getProperty("pkey.repoRoot"))
    private val matrix = JsonText.parse(File(root, "conformance/corpus/v2/backend-matrix.json").readText()) as JsonObject

    private fun ctxJson(l: im.plrs.key.server.PolarisLicense): JsonObject = buildJsonObject {
        put(
            "license",
            buildJsonObject {
                put("product", JsonPrimitive(l.product))
                put("id", JsonPrimitive(l.id))
                put("deviceId", JsonPrimitive(l.deviceId))
                put("tier", l.tier?.let { JsonPrimitive(it) } ?: JsonNull)
                put("issuedAt", JsonPrimitive(l.issuedAt))
                put("ageSeconds", JsonPrimitive(l.ageSeconds))
                put("holder", l.holder?.let { buildJsonObject { put("name", JsonPrimitive(it.name)); put("email", JsonPrimitive(it.email)) } } ?: JsonNull)
            },
        )
        put("user", l.user?.let { buildJsonObject { put("subject", JsonPrimitive(it.subject)) } } ?: JsonNull)
    }

    @Test
    fun everyVerdictRowIsAnsweredOverHttp() = runBlocking {
        var checked = 0
        val failures = ArrayList<String>()
        for (row in matrix["verdict"]!!.arrayValue!!.map { it.objectValue!! }) {
            val id = row["id"].stringValue!!
            val input = row["input"]!!.objectValue!!
            val opts = input["options"]!!.objectValue!!
            val products = opts["products"]!!.arrayValue!!.map { it.stringValue!! }
            val trust: Map<String, TrustSet> = input["trust"]!!.objectValue!!.mapValues { (_, k) -> k.objectValue!!.mapValues { it.value.stringValue!! } }
            val now = input["now"].longValue!!
            val max = opts["maxAgeSeconds"]?.takeIf { it !is JsonNull }.longValue
            val require = (opts["require"]?.arrayValue ?: emptyList()).map {
                val r = it.objectValue!!
                if (r["kind"].stringValue == "signIn") BackendRequirement.SignIn else BackendRequirement.Entitlement(r["name"].stringValue!!)
            }
            val expect = row["expect"]!!.objectValue!!
            val status = expect["status"].longValue!!.toInt()
            testApplication {
                application {
                    install(Authentication) {
                        polarisKey {
                            this.products = products.map { PolarisProduct(it, trust[it]?.takeIf { pins -> pins.isNotEmpty() } ?: noSigner) }
                            maxAgeSeconds = max
                            trustRefresh = false
                            clock = { now }
                        }
                    }
                    routing {
                        requireLicense {
                            // The route's requirements, in order, as the plugins install them.
                            for (r in require) {
                                when (r) {
                                    is BackendRequirement.Entitlement -> install(RequireEntitlement) { name = r.name }
                                    is BackendRequirement.Tier -> install(RequireTier) { tiers = r.tiers }
                                    BackendRequirement.SignIn -> install(RequireSignIn)
                                }
                            }
                            get("/gated") {
                                call.respondText(ctxJson(call.principal<im.plrs.key.server.PolarisLicense>()!!).toString())
                            }
                        }
                    }
                }
                val response = client.get("/gated") {
                    for (h in input["headers"]!!.arrayValue!!) header(h.arrayValue!![0].stringValue!!, h.arrayValue!![1].stringValue!!)
                }
                checked++
                if (response.status.value != status) failures += "$id: status ${response.status.value}, expected $status"
                else if (status == 200) {
                    if (JsonText.parse(response.bodyAsText()) != expect["context"]) failures += "$id: context differs"
                    if (response.headers[HttpHeaders.CacheControl] != "private") failures += "$id: a gated 200 must be private"
                } else {
                    val body = JsonText.parse(response.bodyAsText()).objectValue!!
                    if (body["code"].stringValue != expect["code"].stringValue) failures += "$id: code ${body["code"].stringValue}"
                    if (!response.headers[HttpHeaders.ContentType].orEmpty().startsWith("application/problem+json")) failures += "$id: content-type ${response.headers[HttpHeaders.ContentType]}"
                    if (response.headers[HttpHeaders.CacheControl] != "no-store") failures += "$id: refusals are no-store"
                    val challenge = response.headers[HttpHeaders.WWWAuthenticate]
                    if ((status == 401) != (challenge != null)) failures += "$id: challenge $challenge"
                    if (challenge != null && challenge != "PKey-License realm=\"${products.first()}\", error=\"${expect["code"].stringValue}\"") failures += "$id: challenge $challenge"
                }
            }
        }
        assertTrue("checked $checked", checked >= 70)
        assertEquals("failures:\n" + failures.joinToString("\n"), 0, failures.size)
    }
}
