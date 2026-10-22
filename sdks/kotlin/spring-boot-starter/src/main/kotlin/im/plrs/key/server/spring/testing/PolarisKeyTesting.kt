// Test support for the starter. Import PolarisKeyTestConfiguration and the context serves a
// PolarisTestKit's product from its throwaway pins and clock, with no network and no `polaris-key.*`
// properties; sign requests with the kit:
//
//     @SpringBootTest @AutoConfigureMockMvc @Import(PolarisKeyTestConfiguration::class)
//     class ExportTest(@Autowired val mvc: MockMvc, @Autowired val kit: PolarisTestKit) {
//         @Test fun entitled() { mvc.perform(get("/api/export").with(kit.license { entitle("export.pdf") })).andExpect(status().isOk) }
//         @Test fun refused() { mvc.perform(get("/api/export").with(kit.refusing(BackendRefusal.NotEntitled))).andExpect(status().isForbidden) }
//     }
//
// Never use this from production code: the key the kit makes signs anything.

package im.plrs.key.server.spring.testing

import im.plrs.key.server.BackendRefusal
import im.plrs.key.server.PolarisServer
import im.plrs.key.server.testing.PolarisTestKit
import im.plrs.key.server.testing.TestLicense
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.test.web.servlet.request.RequestPostProcessor

/** A [PolarisTestKit] bean (its product is `polaris-key.test.product`, default `test-product`) and the [PolarisServer] over it. */
@TestConfiguration(proxyBeanMethods = false)
public class PolarisKeyTestConfiguration {
    @Bean
    public fun polarisTestKit(@Value("\${polaris-key.test.product:test-product}") product: String): PolarisTestKit = PolarisTestKit(product = product)

    @Bean
    public fun polarisServer(kit: PolarisTestKit): PolarisServer = PolarisServer(kit.options())
}

/** Send exactly [headers] (the kit's `X-PKey-License` and `X-PKey-Device`). */
public fun polarisHeaders(headers: Map<String, String>): RequestPostProcessor = RequestPostProcessor { request ->
    headers.forEach { (name, value) -> request.addHeader(name, value) }
    request
}

/** Sign what [configure] says and send it: `mvc.perform(get("/x").with(kit.license { entitle("a") }))`. */
public fun PolarisTestKit.license(configure: TestLicense.() -> Unit = {}): RequestPostProcessor = polarisHeaders(signedHeaders(configure))

/** Send the headers that make a gate answer [refusal]; see [PolarisTestKit.headersFor]. */
public fun PolarisTestKit.refusing(refusal: BackendRefusal, configure: TestLicense.() -> Unit = {}): RequestPostProcessor =
    polarisHeaders(headersFor(refusal, configure))
