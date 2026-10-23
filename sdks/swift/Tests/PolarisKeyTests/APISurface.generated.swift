// GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with `pnpm gen api`.
import PolarisKey

/// Compile-only and never called: a renamed or removed symbol fails the test target's build.
func apiSurface() async {
    _ = PolarisKeyClient.create  // client.create
    _ = PolarisKeyClient.boot  // client.boot
    _ = \CoreOptions.productSlug  // options.productSlug
    _ = \CoreOptions.pinnedKeys  // options.pinnedKeys
    _ = \PolarisKeyClientOptions.pinnedReleaseKeys  // options.pinnedReleaseKeys
    _ = \CoreOptions.baseUrl  // options.baseUrl
    _ = \CoreOptions.expectedServices  // options.expectedServices
    _ = ConfigClient.config(_:default:)  // config.get
    _ = ConfigClient.configSource  // config.getConfigSource
    _ = ConfigClient.secret  // config.getSecret
    _ = ConfigClient.mintToken  // config.mintToken
    _ = ConfigClient.set  // config.set
    _ = ConfigClient.clear  // config.clear
    _ = ConfigClient.clearAll  // config.clearAll
    _ = ConfigClient.onConfigChange  // config.onConfigChange
    _ = ConfigClient.setting  // config.setting
    _ = ConfigSetting.value(default:)  // config.setting.value
    _ = ConfigSetting.source  // config.setting.source
    _ = ConfigSetting.isLocked  // config.setting.locked
    _ = ConfigSetting.set  // config.setting.set
    _ = ConfigSetting.clear  // config.setting.clear
    _ = ConfigSetting.onChange  // config.setting.on
    _ = LicenseClient.activate(key:)  // license.activateWithKey
    _ = LicenseClient.isEntitled  // entitlements.has
    _ = LicenseClient.entitlementValue  // entitlements.value
    _ = LicenseClient.entitlements  // entitlements.all
    _ = IdentityClient.signOut  // identity.signOut
    _ = \PolarisKeyClient.changes  // events
}
