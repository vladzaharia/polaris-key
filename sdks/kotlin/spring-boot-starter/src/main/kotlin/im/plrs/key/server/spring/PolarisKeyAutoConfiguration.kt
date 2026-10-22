// The starter's auto-configuration: a PolarisServer bean from `polaris-key.*`, started with the
// context and closed with it. It adds no SecurityFilterChain: you gate routes in your own, with
// `http.polarisKey()` and `access(PolarisKey....)`. Back off by defining your own PolarisServer.

package im.plrs.key.server.spring

import im.plrs.key.server.PolarisServer
import org.apache.commons.logging.LogFactory
import org.springframework.boot.autoconfigure.AutoConfiguration
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.diagnostics.AbstractFailureAnalyzer
import org.springframework.boot.diagnostics.FailureAnalysis
import org.springframework.context.annotation.Bean
import org.springframework.security.config.annotation.web.builders.HttpSecurity

@AutoConfiguration
@ConditionalOnClass(HttpSecurity::class)
@ConditionalOnProperty(prefix = "polaris-key", name = ["enabled"], havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(PolarisKeyProperties::class)
public class PolarisKeyAutoConfiguration {
    private val log = LogFactory.getLog("im.plrs.key.server.spring")

    /** `debug` is this logger's debug level: the step, the key id and a short device hash per verdict, never the header. */
    @Bean(initMethod = "start")
    @ConditionalOnMissingBean
    public fun polarisServer(properties: PolarisKeyProperties): PolarisServer =
        PolarisServer(properties.toOptions(debug = if (log.isDebugEnabled) ({ line: String -> log.debug(line) }) else null))
}

/** A bad `polaris-key.*` configuration stops startup with the fix, not a stack trace. */
public class PolarisKeyFailureAnalyzer : AbstractFailureAnalyzer<IllegalArgumentException>() {
    override fun analyze(rootFailure: Throwable, cause: IllegalArgumentException): FailureAnalysis? {
        val message = cause.message ?: return null
        if (!message.startsWith("PolarisProduct:") && !message.startsWith("PolarisServerOptions:")) return null
        return FailureAnalysis(
            message,
            "Set polaris-key.product, polaris-key.pinned-keys.<kid> (the 43-character raw Ed25519 public key) and, if not https://key.plrs.im, polaris-key.base-url; " +
                "or polaris-key.products[n].slug / .pinned-keys / .base-url for several. `pkey sdk --lang kotlin --write` prints the slug and the keys.",
            cause,
        )
    }
}
