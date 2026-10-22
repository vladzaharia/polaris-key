// Test wiring for the Ktor plugin: point `polarisKey { }` at a PolarisTestKit (a throwaway key, the
// kit's clock, no network). Never use it from production code.
//
//     install(Authentication) { polarisKey { useTestKit(kit) } }

package im.plrs.key.server.ktor

import im.plrs.key.server.testing.PolarisTestKit

/**
 * Serve [kit]'s product from its throwaway pins and clock. With [trustRefresh] the refresh runs
 * against `kit.trust`, the fake trust service; without it only the pins verify.
 */
public fun PolarisKeyAuthConfig.useTestKit(kit: PolarisTestKit, trustRefresh: Boolean = false) {
    val options = kit.options(trustRefresh)
    products = options.products
    this.trustRefresh = options.trustRefresh
    transport = options.transport
    clock = options.clock
}
