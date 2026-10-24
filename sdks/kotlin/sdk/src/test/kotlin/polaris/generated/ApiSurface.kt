// GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with `pnpm gen api`.
@file:Suppress("unused", "UNUSED_EXPRESSION")

package polaris.generated

import im.plrs.key.config.ConfigClient
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.PresentationSource
import im.plrs.key.identity.IdentityClient
import im.plrs.key.license.LicenseClient
import im.plrs.key.packs.PacksClient
import im.plrs.key.release.DistributionClient
import im.plrs.key.release.ReleaseClient
import im.plrs.key.sdk.BackendClient
import im.plrs.key.sdk.CommerceClient
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.boot
import im.plrs.key.sdk.bootHost
import im.plrs.key.update.UpdateClient
import im.plrs.key.update.UpdateClientOptions

/** Compile-only and never called: a renamed or removed symbol fails the test source set's build. */
internal suspend fun apiSurface() {
    PolarisKeyClient.Companion::create  // client.create
    PolarisKeyClient::boot  // client.boot
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
    PolarisKeyClient::events  // events
    PolarisKeyClient::discover  // client.discover
    PolarisKeyClient::presentation  // client.presentation
    PolarisKeyClient::presentationIcon  // client.presentationIcon
    PolarisKeyClient::presentationSource  // client.presentationSource
    PolarisKeyClient::servicesPinned  // client.servicesPinned
    PolarisKeyClient::capabilities  // client.capabilities
    PolarisKeyClient::supports  // client.supports
    PolarisKeyClient::caps  // client.caps
    PolarisKeyClient::sync  // client.sync
    PolarisKeyClient::syncState  // client.getSyncState
    PolarisKeyClient::importBundle  // client.importBundle
    PolarisKeyClient::crashTags  // client.crashTags
    PolarisKeyClient::status  // client.status
    PolarisKeyClient::storeStatus  // client.storeStatus
    PolarisKeyClient::isLicensed  // client.isLicensed
    PolarisKeyClient::listDevices  // client.listDevices
    PolarisKeyClient::deauthorizeDevice  // client.deauthorizeDevice
    PolarisKeyClient::renameDevice  // client.renameDevice
    PolarisKeyClient::startRefreshLoop  // client.startRefresh
    PolarisKeyClient::close  // client.close
    ConfigClient::listUserConfig  // config.listUserConfig
    ConfigClient::schemaVersion  // config.schemaVersion
    ConfigClient::fetchSchema  // config.fetchSchema
    LicenseClient::activation  // license.activation
    LicenseClient::licenseInfo  // license.licenseInfo
    LicenseClient::entitledChannels  // license.entitledChannels
    LicenseClient::profile  // license.getProfile
    LicenseClient::licenseId  // license.getLicenseId
    LicenseClient::enroll  // license.enroll
    LicenseClient::deactivate  // license.deactivate
    IdentityClient::beginSignIn  // identity.beginSignIn
    IdentityClient::pollSignIn  // identity.pollSignIn
    IdentityClient::waitForSignIn  // identity.waitForSignIn
    PolarisKeyClient.DevicesFacet::register  // devices.register
    PolarisKeyClient.DevicesFacet::list  // devices.list
    PolarisKeyClient.DevicesFacet::rename  // devices.rename
    PolarisKeyClient.DevicesFacet::deauthorize  // devices.deauthorize
    ReleaseClient::fetch  // release.fetch
    ReleaseClient::changelog  // release.changelog
    ReleaseClient::installUrl  // release.installUrl
    ReleaseClient::downloadUrl  // release.downloadUrl
    UpdateClient::offers  // update.onUpdateAvailable
    UpdateClient::install  // update.install
    UpdateClient::check  // update.check
    UpdateClient::appcastUrl  // update.appcastUrl
    UpdateClient::feedUrl  // update.feedUrl
    UpdateClient::decide  // update.decide
    UpdateClient::releaseRecord  // update.releaseRecord
    UpdateClient::buildUrl  // update.buildUrl
    DistributionClient::downloadModel  // distribution.downloadModel
    DistributionClient::thisPlatform  // distribution.thisPlatform
    CommerceClient::binding  // commerce.binding
    CommerceClient::claim  // commerce.claim
    CommerceClient::claimSteam  // commerce.claimSteam
    CommerceClient::claimAppStore  // commerce.claimAppStore
    CommerceClient::claimPlay  // commerce.claimPlay
    PacksClient::ensure  // packs.ensure
    PacksClient::state  // packs.state
    PacksClient::path  // packs.path
    PacksClient::registerHandler  // packs.registerHandler
    PacksClient::on  // packs.on
    PacksClient::isAvailable  // packs.isAvailable
    PacksClient::packFor  // packs.packFor
    PacksClient::rollback  // packs.rollback
    PacksClient::confirm  // packs.confirm
    PresentationSource::subscribe  // presentation.subscribe
    PresentationSource::icon  // presentation.icon
    PolarisKeyClient::register  // client.register
    PolarisKeyClient::currentDevice  // client.currentDevice
    PolarisKeyClient::deactivate  // client.deactivate
    LicenseClient::licenseUser  // license.getLicenseUser
    CommerceClient::hiddenHere  // commerce.hiddenHere
    CommerceClient::isUnlocked  // commerce.isUnlocked
    LicenseClient::status  // license.status
    LicenseClient::isLicensed  // license.isLicensed
    PresentationSource::current  // presentation.current
    PolarisKeyClient::start  // client.start
    PolarisKeyClient.Companion::createLocal  // client.createLocal
    PolarisKeyClient.Companion::createFromBundle  // client.createFromBundle
    ConfigClient::fetchCatalog  // config.fetchCatalog
    PolarisKeyClient.DevicesFacet::attest  // devices.attest
    PolarisKeyClient.DevicesFacet::attestUnavailable  // devices.attestSupport
    UpdateClient::channelFeed  // update.channelFeed
    CommerceClient::products  // commerce.products
    PolarisKeyClient::licenseChanges  // client.licenseChanges
    PolarisKeyClient::channelChoices  // client.channelChoices
    PolarisKeyClient::setChannel  // client.setChannel
    PolarisKeyClient::startInBackground  // client.startInBackground
    PolarisKeyClient::licenseState  // client.licenseState
    ConfigClient::catalog  // config.catalog
    BackendClient::origins  // backend.origins
    BackendClient::headers  // backend.headers
    BackendClient::install  // backend.install
    BackendClient::interceptor  // backend.interceptor
    BackendClient::networkInterceptor  // backend.networkInterceptor
    ReleaseClient::verifyRecord  // release.verifyRecord
    UpdateClient::reportedOutlet  // update.reportedOutlet
    PacksClient::estimate  // packs.estimate
    PolarisKeyClient::bootHost  // client.bootHost
}
