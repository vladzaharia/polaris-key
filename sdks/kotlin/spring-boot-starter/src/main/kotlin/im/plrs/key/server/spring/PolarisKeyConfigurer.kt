// Applies the starter to a SecurityFilterChain:
//
//     @Bean
//     fun api(http: HttpSecurity): SecurityFilterChain {
//         http.polarisKey()
//         http.authorizeHttpRequests { it.requestMatchers("/api/export").access(PolarisKey.entitlement("export.pdf")).anyRequest().permitAll() }
//         return http.build()
//     }
//
// It adds the authentication filter, the refusal handlers (only for requests a gate refused, so your
// own entry point and denied handler keep every other case) and the `private` marker.

package im.plrs.key.server.spring

import im.plrs.key.server.PolarisServer
import org.springframework.context.ApplicationContext
import org.springframework.security.config.Customizer
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer
import org.springframework.security.web.access.intercept.AuthorizationFilter
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter
import org.springframework.security.web.util.matcher.RequestMatcher
import org.springframework.web.servlet.HandlerExceptionResolver

public class PolarisKeyConfigurer : AbstractHttpConfigurer<PolarisKeyConfigurer, HttpSecurity>() {
    /** A server shared with other adapters. Default: the `PolarisServer` bean. */
    public var server: PolarisServer? = null

    /** Default: `polaris-key.errors`. */
    public var errors: ErrorMode? = null

    /** Default: `polaris-key.preflight`. */
    public var preflight: PreflightMode? = null
    private var refusal: PolarisKeyRefusalHandler? = null

    /** Answer a refusal yourself (`errors = Respond`). [respondProblem] sends the problem with a status you choose. */
    public fun onRefusal(handler: PolarisKeyRefusalHandler): PolarisKeyConfigurer {
        refusal = handler
        return this
    }

    private lateinit var refusals: PolarisKeyRefusals
    private lateinit var filter: PolarisKeyAuthenticationFilter

    override fun init(http: HttpSecurity) {
        val context = http.getSharedObject(ApplicationContext::class.java)
            ?: error("PolarisKeyConfigurer needs the Spring ApplicationContext; build the HttpSecurity as a bean")
        val properties = context.getBeanProvider(PolarisKeyProperties::class.java).getIfAvailable { PolarisKeyProperties() }
        val polarisServer = server ?: context.getBeanProvider(PolarisServer::class.java).getIfAvailable()
            ?: error("PolarisKeyConfigurer found no PolarisServer: set polaris-key.product and polaris-key.pinned-keys (the starter then makes one), or define a PolarisServer bean")
        val mode = errors ?: properties.errors
        val resolver = if (context.containsBean("handlerExceptionResolver")) context.getBean("handlerExceptionResolver", HandlerExceptionResolver::class.java) else null
        val handler = refusal ?: context.getBeanProvider(PolarisKeyRefusalHandler::class.java).getIfAvailable()
        refusals = PolarisKeyRefusals(mode, resolver, handler)
        filter = PolarisKeyAuthenticationFilter(polarisServer, PolarisKeyAuthenticationProvider(polarisServer), preflight ?: properties.preflight)
        val refused = RequestMatcher { PolarisKeyRequest.of(it)?.refusal != null }
        http.exceptionHandling {
            it.defaultAuthenticationEntryPointFor(PolarisKeyAuthenticationEntryPoint(refusals), refused)
            it.defaultAccessDeniedHandlerFor(PolarisKeyAccessDeniedHandler(refusals), refused)
        }
    }

    override fun configure(http: HttpSecurity) {
        http.addFilterBefore(filter, AnonymousAuthenticationFilter::class.java)
        http.addFilterAfter(PolarisKeyPrivateFilter(), AuthorizationFilter::class.java)
    }

    public companion object {
        /** `http.with(PolarisKeyConfigurer.polarisKey(), Customizer.withDefaults())` for Java. */
        @JvmStatic
        public fun polarisKey(): PolarisKeyConfigurer = PolarisKeyConfigurer()
    }
}

/** Apply the starter: `http.polarisKey()`, or `http.polarisKey { it.errors = ErrorMode.Throw }`. */
public fun HttpSecurity.polarisKey(customizer: Customizer<PolarisKeyConfigurer> = Customizer.withDefaults()): HttpSecurity =
    with(PolarisKeyConfigurer(), customizer)
