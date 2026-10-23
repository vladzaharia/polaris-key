// GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with `pnpm gen api`.
@file:Suppress("unused", "UNUSED_EXPRESSION")

package polaris.generated

import im.plrs.key.config.ConfigClient
import im.plrs.key.core.CoreOptions
import im.plrs.key.identity.IdentityClient
import im.plrs.key.license.LicenseClient
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.bootHost
import im.plrs.key.update.UpdateClientOptions

/** Compile-only and never called: a renamed or removed symbol fails the test source set's build. */
internal suspend fun apiSurface() {
    PolarisKeyClient.Companion::create  // client.create
    PolarisKeyClient::bootHost  // client.boot
    CoreOptions::productSlug  // options.productSlug
    CoreOptions::pinnedKeys  // options.pinnedKeys
    UpdateClientOptions::pinnedReleaseKeys  // options.pinnedReleaseKeys
    CoreOptions::baseUrl  // options.baseUrl
    CoreOptions::expectedServices  // options.expectedServices
    ConfigClient::config  // config.get
    ConfigClient::configSource  // config.getConfigSource
    ConfigClient::secret  // config.getSecret
    ConfigClient::mintToken  // config.mintToken
    ConfigClient::set  // config.set
    ConfigClient::clear  // config.clear
    ConfigClient::clearAll  // config.clearAll
    ConfigClient::changes  // config.onConfigChange
    ConfigClient::setting  // config.setting
    LicenseClient::activate  // license.activateWithKey
    LicenseClient::isEntitled  // entitlements.has
    LicenseClient::entitlementValue  // entitlements.value
    LicenseClient::entitlements  // entitlements.all
    PolarisKeyClient::licenseChanges  // events
}
