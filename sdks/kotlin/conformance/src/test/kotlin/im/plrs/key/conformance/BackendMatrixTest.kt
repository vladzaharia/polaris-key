// @pkey-feature server.license server.signin
//
// Product backends — WIRE-CONTRACT-V4 §14, conformance/corpus/v2/"backend-matrix.json"
// (backendMatrixVersion 1, plans/SP-53.md §4), read in place, through :server:
//
//   verdict   the six-step verdict on X-PKey-License   → backendVerdict
//   problem   the refusal's body, challenge and locale → backendProblem
//
// The `client` section is the client halves' (SP-58, SP-59), not a server core's. Like every suite
// this one runs on the JCA and again with Tink forced.

package im.plrs.key.conformance

import im.plrs.key.core.BACKEND_MATRIX_VERSION
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.server.BACKEND_LOCALES
import im.plrs.key.server.BackendOptions
import im.plrs.key.server.BackendRequirement
import im.plrs.key.server.BackendWire
import im.plrs.key.server.PROBLEM_CONTENT_TYPE
import im.plrs.key.server.PROBLEM_TYPE_BASE
import im.plrs.key.server.backendProblem
import im.plrs.key.server.backendVerdict
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class BackendMatrixTest : ConformanceSuite() {
    private val matrix: JsonObject = Corpus.v2("backend-matrix.json")

    private fun section(name: String): List<JsonObject> = matrix[name]!!.arrayValue!!.map { it.obj }

    @Test
    fun theMatrixVersionAndConstantsAreTheOnesTheModuleImplements() {
        assertEquals(BACKEND_MATRIX_VERSION.toLong(), matrix["backendMatrixVersion"].longValue)
        val c = matrix["constants"]!!.obj
        assertEquals(BackendWire.HEADER_LICENSE, c["headerLicense"].stringValue)
        assertEquals(BackendWire.HEADER_DEVICE, c["headerDevice"].stringValue)
        assertEquals(BackendWire.LICENSE_MAX_BYTES.toLong(), c["licenseMaxBytes"].longValue)
        assertEquals(BackendWire.AUTH_SCHEME, c["authScheme"].stringValue)
        assertEquals(PROBLEM_TYPE_BASE, c["typeBase"].stringValue)
        assertEquals(PROBLEM_CONTENT_TYPE, c["contentType"].stringValue)
        assertEquals(BACKEND_LOCALES, c["locales"]!!.arrayValue!!.map { it.stringValue })
        assertEquals(im.plrs.key.core.CLOCK_SKEW_SECONDS, c["clockSkewSeconds"].longValue)
    }

    @Test
    fun verdict() {
        val problems = Failures("backend verdict")
        for (row in section("verdict")) {
            val input = row["input"]!!.obj
            val o = input["options"]!!.obj
            val options = BackendOptions(
                products = o["products"]!!.arrayValue!!.map { it.stringValue!! },
                maxAgeSeconds = o["maxAgeSeconds"]?.takeIf { it !is JsonNull }.longValue,
                require = (o["require"]?.arrayValue ?: emptyList()).map {
                    val r = it.obj
                    when (r["kind"].stringValue) {
                        "entitlement" -> BackendRequirement.Entitlement(r["name"].stringValue!!)
                        "signIn" -> BackendRequirement.SignIn
                        else -> error("unknown requirement ${r["kind"]}")
                    }
                },
            )
            val headers = input["headers"]!!.arrayValue!!.map { h -> h.arrayValue!![0].stringValue!! to h.arrayValue!![1].stringValue!! }
            val trust = input["trust"]!!.obj.mapValues { (_, keys) -> keys.obj.mapValues { it.value.stringValue!! } }
            val verdict = backendVerdict(headers, input["now"].longValue!!, options, trust)
            val expect = row["expect"]!!.obj
            val actual = buildJsonObject {
                put("status", JsonPrimitive(verdict.status))
                put("code", verdict.code?.let { JsonPrimitive(it) } ?: JsonNull)
                val ctx = verdict.context
                put(
                    "context",
                    if (ctx == null) JsonNull else buildJsonObject {
                        put(
                            "license",
                            buildJsonObject {
                                put("product", JsonPrimitive(ctx.license.product))
                                put("id", JsonPrimitive(ctx.license.id))
                                put("deviceId", JsonPrimitive(ctx.license.deviceId))
                                put("tier", ctx.license.tier?.let { JsonPrimitive(it) } ?: JsonNull)
                                put("issuedAt", JsonPrimitive(ctx.license.issuedAt))
                                put("ageSeconds", JsonPrimitive(ctx.license.ageSeconds))
                                put(
                                    "holder",
                                    ctx.license.holder?.let { buildJsonObject { put("name", JsonPrimitive(it.name)); put("email", JsonPrimitive(it.email)) } } ?: JsonNull,
                                )
                            },
                        )
                        put("user", ctx.user?.let { buildJsonObject { put("subject", JsonPrimitive(it.subject)) } } ?: JsonNull)
                    },
                )
            }
            problems.equal(expect, actual) { row["id"].stringValue!! }
        }
        problems.done(minimum = 70)
    }

    @Test
    fun problem() {
        val problems = Failures("backend problem")
        for (row in section("problem")) {
            val input = row["input"]!!.obj
            val expect = row["expect"]!!.obj
            val p = backendProblem(input["code"].stringValue!!, input["acceptLanguage"].stringValue, input["realm"].stringValue!!)
            val actual = buildJsonObject {
                put("status", JsonPrimitive(p.status))
                put("locale", JsonPrimitive(p.locale))
                put("challenge", p.challenge?.let { JsonPrimitive(it) } ?: JsonNull)
                put("type", JsonPrimitive(p.type))
                put("title", JsonPrimitive(p.title))
                put("detail", JsonPrimitive(p.detail))
            }
            problems.equal(expect, actual) { row["id"].stringValue!! }
            // The response: the body is {type, title, status, detail, code}; the headers are fixed.
            val body = im.plrs.key.core.JsonText.parse(p.body).obj
            problems.equal(listOf("type", "title", "status", "detail", "code"), body.keys.toList()) { row["id"].stringValue + "/body" }
            problems.equal(input["code"].stringValue, body["code"].stringValue) { row["id"].stringValue + "/code" }
            problems.equal("application/problem+json", p.headers["Content-Type"]) { row["id"].stringValue + "/content-type" }
            problems.equal("no-store", p.headers["Cache-Control"]) { row["id"].stringValue + "/cache" }
            problems.equal(expect["challenge"].stringValue, p.headers["WWW-Authenticate"]) { row["id"].stringValue + "/www" }
        }
        problems.done(minimum = 60)
    }
}
