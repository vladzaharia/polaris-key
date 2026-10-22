// @pkey-feature server.license server.signin
//
// A gated Spring MVC route answers each verdict row of conformance/corpus/v2/backend-matrix.json through
// Spring Security: the status, the problem body's code, the challenge, the no-store and, on a pass, the
// context the route reads from its principal. One small web context per row (the row names the
// products, the pins and the clock).

package im.plrs.key.server.spring

import im.plrs.key.core.JsonText
import im.plrs.key.core.TrustSet
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.server.BackendRequirement
import im.plrs.key.server.PolarisLicense
import im.plrs.key.server.PolarisProduct
import im.plrs.key.server.PolarisServer
import im.plrs.key.server.PolarisServerOptions
import java.io.File
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers
import org.springframework.security.web.SecurityFilterChain
import org.springframework.mock.web.MockServletContext
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext
import org.springframework.web.servlet.config.annotation.EnableWebMvc

/** What the row under test asks of the context; set before the context refreshes. */
private object Row {
    @Volatile var options: PolarisServerOptions? = null

    @Volatile var requirements: List<BackendRequirement> = emptyList()
}

@RestController
class ProbeController {
    @GetMapping("/gated")
    fun gated(@AuthenticationPrincipal license: PolarisLicense): String = MatrixContext.of(license).toString()
}

object MatrixContext {
    fun of(l: PolarisLicense): JsonObject = buildJsonObject {
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
}

@Configuration(proxyBeanMethods = false)
@EnableWebSecurity
@EnableWebMvc
open class MatrixConfig {
    @Bean
    open fun server(): PolarisServer = PolarisServer(Row.options!!)

    @Bean
    open fun probe(): ProbeController = ProbeController()

    @Bean
    open fun chain(http: HttpSecurity): SecurityFilterChain {
        http.csrf { it.disable() }
        http.polarisKey()
        http.authorizeHttpRequests { it.requestMatchers("/gated").access(PolarisKey.all(*Row.requirements.toTypedArray())).anyRequest().permitAll() }
        return http.build()
    }
}

class SpringMatrixTest {
    private val noSigner: TrustSet = mapOf("unused-pin" to "A".repeat(43))
    private val root = File(System.getProperty("pkey.repoRoot"))
    private val matrix = JsonText.parse(File(root, "conformance/corpus/v2/backend-matrix.json").readText()) as JsonObject

    private fun mvc(context: AnnotationConfigWebApplicationContext): MockMvc =
        MockMvcBuilders.webAppContextSetup(context).apply<org.springframework.test.web.servlet.setup.DefaultMockMvcBuilder>(SecurityMockMvcConfigurers.springSecurity()).build()

    @Test
    fun everyVerdictRowIsAnsweredThroughSpringSecurity() {
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
            Row.options = PolarisServerOptions(
                products = products.map { PolarisProduct(it, trust[it]?.takeIf { pins -> pins.isNotEmpty() } ?: noSigner) },
                maxAgeSeconds = max,
                trustRefresh = false,
                clock = { now },
            )
            Row.requirements = require
            val context = AnnotationConfigWebApplicationContext().apply {
                servletContext = MockServletContext()
                register(MatrixConfig::class.java)
                refresh()
            }
            try {
                val response = mvc(context).perform(
                    get("/gated").apply { for (h in input["headers"]!!.arrayValue!!) header(h.arrayValue!![0].stringValue!!, h.arrayValue!![1].stringValue!!) },
                ).andReturn().response
                checked++
                if (response.status != status) failures += "$id: status ${response.status}, expected $status"
                else if (status == 200) {
                    if (JsonText.parse(response.contentAsString) != expect["context"]) failures += "$id: context differs"
                    if (response.getHeader("Cache-Control") != "private") failures += "$id: a gated 200 must be private, was ${response.getHeader("Cache-Control")}"
                } else {
                    val body = JsonText.parse(response.contentAsString).objectValue!!
                    if (body["code"].stringValue != expect["code"].stringValue) failures += "$id: code ${body["code"].stringValue}"
                    if (!response.contentType.orEmpty().startsWith("application/problem+json")) failures += "$id: content-type ${response.contentType}"
                    if (response.getHeader("Cache-Control") != "no-store") failures += "$id: refusals are no-store"
                    val challenge = response.getHeader("WWW-Authenticate")
                    if ((status == 401) != (challenge != null)) failures += "$id: challenge $challenge"
                    if (challenge != null && challenge != "PKey-License realm=\"${products.first()}\", error=\"${expect["code"].stringValue}\"") failures += "$id: challenge $challenge"
                }
            } finally {
                context.close()
            }
        }
        assertTrue("checked $checked", checked >= 70)
        assertEquals("failures:\n" + failures.joinToString("\n"), 0, failures.size)
    }
}
