// @pkey-feature server.license server.signin
//
// The starter as a developer meets it: properties bind, the context gates routes with tier / entitlement /
// all, the CORS preflight passes, a refusal is the localized problem (or PolarisKeyError for
// @ControllerAdvice), a custom 402, bad configuration stops startup with the fix, and the test support.

package im.plrs.key.server.spring

import im.plrs.key.server.BackendRefusal
import im.plrs.key.server.PolarisKeyError
import im.plrs.key.server.PolarisLicense
import im.plrs.key.server.PolarisServer
import im.plrs.key.server.Require
import im.plrs.key.server.spring.testing.PolarisKeyTestConfiguration
import im.plrs.key.server.spring.testing.license
import im.plrs.key.server.spring.testing.refusing
import im.plrs.key.server.testing.PolarisTestKit
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.springframework.boot.autoconfigure.AutoConfigurations
import org.springframework.boot.autoconfigure.ImportAutoConfiguration
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.boot.test.context.runner.WebApplicationContextRunner
import org.springframework.context.ConfigurableApplicationContext
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Import
import org.springframework.http.MediaType
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers
import org.springframework.security.web.SecurityFilterChain
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.DefaultMockMvcBuilder
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.web.bind.annotation.CrossOrigin
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.context.WebApplicationContext
import org.springframework.web.servlet.config.annotation.EnableWebMvc

@RestController
open class AppController {
    @GetMapping("/health")
    fun health() = "ok"

    @GetMapping("/api/me")
    fun me(@AuthenticationPrincipal license: PolarisLicense) = "tier:${license.tier}"

    @CrossOrigin(origins = ["https://app.example.com"], allowedHeaders = ["x-pkey-license", "x-pkey-device"])
    @GetMapping("/api/export")
    fun export() = "exported"

    @GetMapping("/api/team")
    fun team(request: jakarta.servlet.http.HttpServletRequest) = "team:${request.requirePolarisLicense().tier}"

    @GetMapping("/api/all")
    fun all() = "all"

    @GetMapping("/api/seats")
    fun seats() = "seats"

    @GetMapping("/api/own")
    fun own(response: jakarta.servlet.http.HttpServletResponse): String {
        response.setHeader("Cache-Control", "max-age=60")
        return "own"
    }

    @GetMapping("/oops")
    fun oops(request: jakarta.servlet.http.HttpServletRequest): String = request.requirePolarisLicense().id
}

@RestControllerAdvice
open class Advice {
    @ExceptionHandler(PolarisKeyError::class)
    fun refused(e: PolarisKeyError): org.springframework.http.ResponseEntity<String> =
        org.springframework.http.ResponseEntity.status(e.status).contentType(MediaType.TEXT_PLAIN).body("advice:${e.code}")
}

@Configuration(proxyBeanMethods = false)
@EnableWebSecurity
@EnableWebMvc
@ImportAutoConfiguration(PolarisKeyAutoConfiguration::class)
@Import(AppController::class, Advice::class, PolarisKeyTestConfiguration::class)
open class AppConfig {
    @Bean
    open fun chain(http: HttpSecurity): SecurityFilterChain {
        http.csrf { it.disable() }
        http.polarisKey()
        http.authorizeHttpRequests {
            it.requestMatchers("/health").permitAll()
                .requestMatchers("/api/me").access(PolarisKey.license())
                .requestMatchers("/api/export").access(PolarisKey.entitlement("export.pdf"))
                .requestMatchers("/api/team").access(PolarisKey.tier("pro", "team"))
                .requestMatchers("/api/all").access(PolarisKey.all(Require.signIn(), Require.tier("pro"), Require.entitlement("export.pdf")))
                .requestMatchers("/api/seats").access(PolarisKey.entitlement("seats") { v -> (v.jsonPrimitive.intOrNull ?: 0) >= 5 })
                .requestMatchers("/api/own").access(PolarisKey.license())
                .requestMatchers("/oops").permitAll()
                .anyRequest().denyAll()
        }
        return http.build()
    }
}

class SpringStarterTest {
    private fun runner(vararg configs: Class<*>): WebApplicationContextRunner =
        WebApplicationContextRunner()
            .withAllowBeanDefinitionOverriding(true)
            .withUserConfiguration(AppConfig::class.java, *configs)

    private fun mvcOf(ctx: org.springframework.boot.test.context.assertj.AssertableWebApplicationContext): MockMvc {
        assertNull(ctx.startupFailure)
        return MockMvcBuilders.webAppContextSetup(ctx.sourceApplicationContext as WebApplicationContext).apply<DefaultMockMvcBuilder>(SecurityMockMvcConfigurers.springSecurity()).build()
    }

    private fun run(vararg props: String, block: (MockMvc, PolarisTestKit, ConfigurableApplicationContext) -> Unit) {
        runner().withPropertyValues(*props).run { ctx ->
            block(mvcOf(ctx), ctx.getBean(PolarisTestKit::class.java), ctx.sourceApplicationContext as ConfigurableApplicationContext)
        }
    }

    @Test
    fun tiersEntitlementsAndAllRefuseWithTheFirstUnmetRequirement() = run { mvc, kit, _ ->
        mvc.perform(get("/health")).andExpect(status().isOk)
        mvc.perform(get("/api/team").with(kit.license { tier = "team" })).andExpect(status().isOk).andExpect(content().string("team:team"))
        mvc.perform(get("/api/team").with(kit.license { tier = "free" })).andExpect(status().isForbidden).andExpect(content().string(org.hamcrest.Matchers.containsString("not_entitled")))
        mvc.perform(get("/api/team")).andExpect(status().isUnauthorized).andExpect(header().string("WWW-Authenticate", "PKey-License realm=\"test-product\", error=\"license_required\""))
        // requireAll: the sign-in is checked before the tier.
        mvc.perform(get("/api/all").with(kit.license { tier = "free" })).andExpect(content().string(org.hamcrest.Matchers.containsString("sign_in_required")))
        mvc.perform(get("/api/all").with(kit.license { signedIn(); tier = "free" })).andExpect(content().string(org.hamcrest.Matchers.containsString("not_entitled")))
        mvc.perform(get("/api/all").with(kit.license { signedIn(); tier = "pro"; entitle("export.pdf") })).andExpect(content().string("all"))
        mvc.perform(get("/api/seats").with(kit.license { entitlements["seats"] = 5 })).andExpect(content().string("seats"))
        mvc.perform(get("/api/seats").with(kit.license { entitlements["seats"] = 2 })).andExpect(status().isForbidden)
    }

    @Test
    fun theKitMakesEachVerdictThroughSpringSecurity() = run { mvc, kit, _ ->
        val statuses = listOf(BackendRefusal.LicenseRequired, BackendRefusal.LicenseInvalid, BackendRefusal.LicenseStale, BackendRefusal.NotEntitled)
            .associateWith { mvc.perform(get("/api/export").with(kit.refusing(it))).andReturn().response.status }
        assertEquals(mapOf(BackendRefusal.LicenseRequired to 401, BackendRefusal.LicenseInvalid to 401, BackendRefusal.LicenseStale to 401, BackendRefusal.NotEntitled to 403), statuses)
        mvc.perform(get("/api/export").with(kit.license { entitle("export.pdf") })).andExpect(content().string("exported"))
        // The sign-in refusal is a 403, not a 401.
        mvc.perform(get("/api/all").with(kit.refusing(BackendRefusal.SignInRequired))).andExpect(status().isForbidden)
    }

    private fun MockMvc.preflight(): Int = perform(
        options("/api/export").header("Origin", "https://app.example.com").header("Access-Control-Request-Method", "GET")
            .header("Access-Control-Request-Headers", "x-pkey-license, x-pkey-device"),
    ).andReturn().response.status

    @Test
    fun aCorsPreflightPassesEveryGate() = run { mvc, _, _ ->
        // The gate lets it through, so Spring MVC answers it from @CrossOrigin.
        assertEquals(200, mvc.preflight())
        // A plain OPTIONS without Access-Control-Request-Method is not a preflight: it is gated.
        mvc.perform(options("/api/export")).andExpect(status().isUnauthorized)
    }

    @Test
    fun preflightGateRefusesAPreflight() = run("polaris-key.preflight=gate") { mvc, _, _ ->
        assertEquals(401, mvc.preflight())
    }

    @Test
    fun aGatedResponseIsPrivateUnlessTheRouteSetsItsOwnCacheControl() = run { mvc, kit, _ ->
        mvc.perform(get("/api/me").with(kit.license())).andExpect(header().string("Cache-Control", "private"))
        mvc.perform(get("/api/own").with(kit.license())).andExpect(header().string("Cache-Control", "max-age=60"))
        mvc.perform(get("/api/export")).andExpect(header().string("Cache-Control", "no-store"))
    }

    @Test
    fun theTypedAccessorThrowsAnActionableErrorOnAnUngatedRoute() = run { mvc, kit, _ ->
        val e = runCatching { mvc.perform(get("/oops")).andReturn() }.exceptionOrNull()
        assertTrue(e.toString(), e!!.toString().contains("PolarisKey.license()") || e.cause?.message?.contains("PolarisKey.license()") == true)
        // The licence reaches an ungated route too when the header is sent, so the accessor works there.
        mvc.perform(get("/oops").with(kit.license())).andExpect(content().string("lic_test"))
    }

    @Test
    fun refusalsAreLocalized() = run { mvc, kit, _ ->
        val de = mvc.perform(get("/api/team").with(kit.license { tier = "free" }).header("Accept-Language", "de")).andReturn().response
        assertEquals(403, de.status)
        val en = mvc.perform(get("/api/team").with(kit.license { tier = "free" })).andReturn().response
        assertTrue(de.contentAsString != en.contentAsString)
        assertTrue(de.contentAsString.contains("\"code\":\"not_entitled\""))
    }

    @Test
    fun errorsThrowHandsARefusalToControllerAdvice() = run("polaris-key.errors=throw") { mvc, kit, _ ->
        mvc.perform(get("/api/team").with(kit.license { tier = "free" })).andExpect(status().isForbidden).andExpect(content().string("advice:not_entitled"))
        mvc.perform(get("/api/team")).andExpect(status().isUnauthorized).andExpect(content().string("advice:license_required"))
    }

    @Test
    fun theCustomRefusalHandlerChangesTheStatusAndKeepsTheBody() {
        runner(Custom402::class.java).run { ctx ->
            val mvc = mvcOf(ctx)
            val kit = ctx.getBean(PolarisTestKit::class.java)
            mvc.perform(get("/api/team").with(kit.license { tier = "free" })).andExpect(status().isPaymentRequired)
                .andExpect(content().string(org.hamcrest.Matchers.containsString("not_entitled"))).andExpect(header().string("Cache-Control", "no-store"))
            mvc.perform(get("/api/team")).andExpect(status().isUnauthorized)
        }
    }

    @Test
    fun verdictsAreReportedOncePerRequest() {
        val seen = CopyOnWriteArrayList<Pair<String?, Int>>()
        Counting.seen = seen
        runner(Counting::class.java).run { ctx ->
            val kit = ctx.getBean(PolarisTestKit::class.java)
            mvcOf(ctx).perform(get("/api/team").with(kit.license { tier = "pro" })).andExpect(status().isOk)
            assertEquals(listOf<Pair<String?, Int>>(null to 0), seen.toList())
        }
    }

    @Test
    fun propertiesBindAProductAndItsPins() {
        val kit = PolarisTestKit(product = "acme", start = System.currentTimeMillis() / 1000)
        val kid = kit.pinnedKeys.keys.single()
        WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(PolarisKeyAutoConfiguration::class.java))
            .withPropertyValues("polaris-key.product=acme", "polaris-key.pinned-keys.$kid=${kit.pinnedKeys.getValue(kid)}", "polaris-key.trust-refresh=false", "polaris-key.max-age-seconds=600")
            .run { ctx ->
                val server = ctx.getBean(PolarisServer::class.java)
                assertEquals(kit.pinnedKeys, server.trustFor("acme"))
                assertEquals(600L, server.options.maxAgeSeconds)
                assertEquals(false, server.options.trustRefresh)
            }
    }

    @Test
    fun badConfigurationStopsStartupWithTheFix() {
        ApplicationContextRunner().withConfiguration(AutoConfigurations.of(PolarisKeyAutoConfiguration::class.java))
            .run { ctx ->
                val root = generateSequence(ctx.startupFailure) { it.cause }.last()
                assertTrue(root.message!!, root.message!!.contains("pkey sdk --lang kotlin --write"))
                val analysis = PolarisKeyFailureAnalyzer().analyze(ctx.startupFailure!!)
                assertNotNull(analysis)
                assertTrue(analysis!!.action, analysis.action.contains("polaris-key.pinned-keys"))
            }
        ApplicationContextRunner().withConfiguration(AutoConfigurations.of(PolarisKeyAutoConfiguration::class.java))
            .withPropertyValues("polaris-key.product=acme", "polaris-key.pinned-keys.k=short")
            .run { ctx ->
                val root = generateSequence(ctx.startupFailure) { it.cause }.last()
                assertTrue(root.message!!, root.message!!.contains("not a raw Ed25519 public key"))
            }
        ApplicationContextRunner().withConfiguration(AutoConfigurations.of(PolarisKeyAutoConfiguration::class.java))
            .withPropertyValues("polaris-key.enabled=false")
            .run { ctx -> assertTrue(ctx.getBeanNamesForType(PolarisServer::class.java).isEmpty()) }
    }

    @Configuration(proxyBeanMethods = false)
    open class Custom402 {
        @Bean
        open fun refusal(): PolarisKeyRefusalHandler = PolarisKeyRefusalHandler { _, response, problem ->
            response.respondProblem(problem, if (problem.refusal == BackendRefusal.NotEntitled) 402 else null)
        }
    }

    @Configuration(proxyBeanMethods = false)
    open class Counting {
        @Bean
        open fun polarisServer(kit: PolarisTestKit): PolarisServer =
            PolarisServer(kit.options().copy(onVerdict = { c, s -> seen.add(c to s) }))

        companion object {
            var seen: CopyOnWriteArrayList<Pair<String?, Int>> = CopyOnWriteArrayList()
        }
    }
}
