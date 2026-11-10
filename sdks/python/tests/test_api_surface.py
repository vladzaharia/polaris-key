# GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with `pnpm gen api`.
import inspect

import pytest

from polaris_key.client import PolarisKeyClient
from polaris_key.config.client import ConfigClient, ConfigSetting
from polaris_key.connect.cloud_connect import CloudConnect
from polaris_key.connect.links import CloudLinks
from polaris_key.connect.local_links import LocalLinks
from polaris_key.connect.nearby import CloudNearby
from polaris_key.connect.transfer import IncomingOffer, Transfer
from polaris_key.identity.client import IdentityClient
from polaris_key.identity.auto_sign_in import NearbyNamespace
from polaris_key.identity.native_redirect import push_request
from polaris_key.identity.nearby_session import NearbySignInSession
from polaris_key.identity.sign_in import SignInNamespace, SignInSession
from polaris_key.license.client import LicenseClient
from polaris_key.license.entitlements import EntitlementsClient

CLASSES = {
    "PolarisKeyClient": PolarisKeyClient,
    "ConfigClient": ConfigClient,
    "ConfigSetting": ConfigSetting,
    "IdentityClient": IdentityClient,
    "SignInNamespace": SignInNamespace,
    "SignInSession": SignInSession,
    "NearbyNamespace": NearbyNamespace,
    "NearbySignInSession": NearbySignInSession,
    "LicenseClient": LicenseClient,
    "EntitlementsClient": EntitlementsClient,
    "CloudConnect": CloudConnect,
    "CloudLinks": CloudLinks,
    "LocalLinks": LocalLinks,
    "CloudNearby": CloudNearby,
    "IncomingOffer": IncomingOffer,
    "Transfer": Transfer,
}

ATTRS = [
    ("client.create", "PolarisKeyClient", "create"),
    ("client.boot", "PolarisKeyClient", "boot"),
    ("config.get", "ConfigClient", "get"),
    ("config.getConfigSource", "ConfigClient", "get_config_source"),
    ("config.getSecret", "ConfigClient", "get_secret"),
    ("config.mintToken", "ConfigClient", "mint_token"),
    ("config.set", "ConfigClient", "set"),
    ("config.clear", "ConfigClient", "clear"),
    ("config.clearAll", "ConfigClient", "clear_all"),
    ("config.onConfigChange", "ConfigClient", "on_config_change"),
    ("config.setting", "ConfigClient", "setting"),
    ("config.setting.value", "ConfigSetting", "value"),
    ("config.setting.source", "ConfigSetting", "source"),
    ("config.setting.locked", "ConfigSetting", "locked"),
    ("config.setting.visibility", "ConfigSetting", "visibility"),
    ("config.setting.set", "ConfigSetting", "set"),
    ("config.setting.clear", "ConfigSetting", "clear"),
    ("config.setting.on", "ConfigSetting", "on"),
    ("config.setting.sync", "ConfigSetting", "sync"),
    ("license.activateWithKey", "LicenseClient", "activate_with_key"),
    ("entitlements.has", "EntitlementsClient", "has"),
    ("entitlements.value", "EntitlementsClient", "value"),
    ("entitlements.all", "EntitlementsClient", "all"),
    ("identity.signIn", "IdentityClient", "sign_in"),
    ("identity.subject", "IdentityClient", "subject"),
    ("identity.signOut", "IdentityClient", "sign_out"),
    ("identity.signIn.start", "SignInNamespace", "start"),
    ("identity.signIn.handleRedirect", "SignInNamespace", "handle_redirect"),
    ("identity.signIn.session.reopen", "SignInSession", "reopen"),
    ("identity.signIn.session.cancel", "SignInSession", "cancel"),
    ("identity.signIn.session.wait", "SignInSession", "wait"),
    ("identity.autoSignIn", "IdentityClient", "auto_sign_in"),
    ("identity.useLicenseChoice", "IdentityClient", "choice"),
    ("identity.attachLicense", "IdentityClient", "attach"),
    ("identity.openAccount", "IdentityClient", "open_account"),
    ("client.discover", "PolarisKeyClient", "discover"),
    ("client.init", "PolarisKeyClient", "init"),
    ("client.portal", "PolarisKeyClient", "portal"),
    ("client.presentation", "PolarisKeyClient", "presentation"),
    ("client.presentationIcon", "PolarisKeyClient", "presentation_icon"),
    ("client.discovery", "PolarisKeyClient", "discovery"),
    ("client.ensureActivated", "PolarisKeyClient", "ensure_activated"),
    ("client.capabilities", "PolarisKeyClient", "capabilities"),
    ("client.supports", "PolarisKeyClient", "supports"),
    ("client.caps", "PolarisKeyClient", "caps"),
    ("client.sync", "PolarisKeyClient", "sync"),
    ("client.getSyncState", "PolarisKeyClient", "get_sync_state"),
    ("client.importBundle", "PolarisKeyClient", "import_bundle"),
    ("client.crashTags", "PolarisKeyClient", "crash_tags"),
    ("client.status", "PolarisKeyClient", "status"),
    ("client.storeStatus", "PolarisKeyClient", "store_status"),
    ("client.isLicensed", "PolarisKeyClient", "is_licensed"),
    ("client.listDevices", "PolarisKeyClient", "list_devices"),
    ("client.deauthorizeDevice", "PolarisKeyClient", "deauthorize_device"),
    ("client.renameDevice", "PolarisKeyClient", "rename_device"),
    ("client.close", "PolarisKeyClient", "close"),
    ("config.listUserConfig", "ConfigClient", "list_user_config"),
    ("config.schemaVersion", "ConfigClient", "schema_version"),
    ("config.fetchSchema", "ConfigClient", "fetch_schema"),
    ("license.activation", "LicenseClient", "activation"),
    ("license.licenseInfo", "LicenseClient", "license_info"),
    ("license.entitledChannels", "LicenseClient", "entitled_channels"),
    ("license.getProfile", "LicenseClient", "get_profile"),
    ("license.getLicenseId", "LicenseClient", "get_license_id"),
    ("license.enroll", "LicenseClient", "enroll"),
    ("license.deactivate", "LicenseClient", "deactivate"),
    ("identity.current", "IdentityClient", "current"),
    ("client.tryDiscover", "PolarisKeyClient", "try_discover"),
    ("client.subscribe", "PolarisKeyClient", "subscribe"),
    ("client.outletId", "PolarisKeyClient", "outlet_id"),
    ("client.register", "PolarisKeyClient", "register"),
    ("client.currentDevice", "PolarisKeyClient", "current_device"),
    ("client.deactivate", "PolarisKeyClient", "deactivate"),
    ("license.getLicenseUser", "LicenseClient", "get_license_user"),
    ("license.status", "LicenseClient", "status"),
    ("license.isLicensed", "LicenseClient", "is_licensed"),
    ("cloudConnect.start", "CloudConnect", "start"),
    ("cloudConnect.stop", "CloudConnect", "stop"),
    ("cloudConnect.peers", "CloudConnect", "peers"),
    ("cloudConnect.devices", "CloudConnect", "devices"),
    ("cloudConnect.open", "CloudConnect", "open"),
    ("cloudConnect.onChannel", "CloudConnect", "on_channel"),
    ("cloudConnect.refreshPeers", "CloudConnect", "refresh_peers"),
    ("cloudConnect.status", "CloudConnect", "status"),
    ("cloudConnect.onNotice", "CloudConnect", "on_notice"),
    ("cloudConnect.nearby.request", "CloudNearby", "request"),
    ("cloudConnect.nearby.onRequest", "CloudNearby", "on_request"),
    ("identity.nearby.available", "NearbyNamespace", "available"),
    ("identity.nearby.onRequest", "NearbyNamespace", "on_request"),
    ("identity.signIn.session.approvers", "NearbySignInSession", "approvers"),
    ("identity.signIn.session.onApprovers", "NearbySignInSession", "on_approvers"),
    ("identity.signIn.session.code", "NearbySignInSession", "code"),
    ("identity.signIn.session.result", "NearbySignInSession", "result"),
    ("identity.signIn.session.onResult", "NearbySignInSession", "on_result"),
    ("identity.signIn.session.choose", "NearbySignInSession", "choose"),
    ("identity.signIn.session.confirmAccount", "NearbySignInSession", "confirm_account"),
    ("identity.signIn.session.declineAccount", "NearbySignInSession", "decline_account"),
    ("identity.signIn.session.wrap", "NearbySignInSession", "wrap"),
    ("identity.signIn.session.onWrap", "NearbySignInSession", "on_wrap"),
    ("cloudConnect.links.pair", "CloudLinks", "pair"),
    ("cloudConnect.links.list", "CloudLinks", "list"),
    ("cloudConnect.links.remove", "CloudLinks", "remove"),
    ("cloudConnect.links.setReachable", "CloudLinks", "set_reachable"),
    ("cloudConnect.links.open", "CloudLinks", "open"),
    ("cloudConnect.links.onLink", "CloudLinks", "on_link"),
    ("cloudConnect.links.interAccount", "CloudLinks", "inter_account"),
    ("cloudConnect.localLinks.pair", "LocalLinks", "pair"),
    ("cloudConnect.localLinks.join", "LocalLinks", "join"),
    ("cloudConnect.localLinks.list", "LocalLinks", "list"),
    ("cloudConnect.localLinks.rename", "LocalLinks", "rename"),
    ("cloudConnect.localLinks.remove", "LocalLinks", "remove"),
    ("cloudConnect.localLinks.setReachable", "LocalLinks", "set_reachable"),
    ("cloudConnect.localLinks.open", "LocalLinks", "open"),
    ("cloudConnect.localLinks.onLink", "LocalLinks", "on_link"),
    ("cloudConnect.localLinks.localPairing", "LocalLinks", "local_pairing"),
    ("cloudConnect.transfer.send", "Transfer", "send"),
    ("cloudConnect.transfer.onOffer", "Transfer", "on_offer"),
    ("cloudConnect.transfer.onResult", "Transfer", "on_result"),
    ("cloudConnect.transfer.cancel", "Transfer", "cancel"),
    ("cloudConnect.transfer.accept", "IncomingOffer", "accept"),
    ("cloudConnect.transfer.decline", "IncomingOffer", "decline"),
]
OPTION_PARAMS = [
    ("options.productSlug", "product_slug"),
    ("options.pinnedKeys", "pinned_keys"),
    ("options.pinnedReleaseKeys", "update"),
    ("options.baseUrl", "base_url"),
    ("options.expectedServices", "expected_services"),
    ("cloudSync.encryption", "cloud_sync"),
]
START_PARAMS = [
    ("identity.signIn.keyReturn", "key_return"),
]
REMOVED = [
    ("config.get_config", "ConfigClient", "get_config"),
    ("client.get_config", "PolarisKeyClient", "get_config"),
    ("client.on_config_change", "PolarisKeyClient", "on_config_change"),
    ("config.on_change", "ConfigClient", "on_change"),
    ("license.is_entitled", "LicenseClient", "is_entitled"),
    ("license.entitlement_value", "LicenseClient", "entitlement_value"),
    ("license.get_entitlements", "LicenseClient", "get_entitlements"),
    ("identity.sign_in_with_browser", "IdentityClient", "sign_in_with_browser"),
    ("identity.begin_sign_in", "IdentityClient", "begin_sign_in"),
    ("identity.poll_sign_in", "IdentityClient", "poll_sign_in"),
    ("identity.wait_for_sign_in", "IdentityClient", "wait_for_sign_in"),
    ("identity.accept_sign_in", "IdentityClient", "accept_sign_in"),
]

@pytest.mark.parametrize("concept,cls,name", ATTRS)
def test_present(concept, cls, name):
    assert hasattr(CLASSES[cls], name), concept


@pytest.mark.parametrize("concept,name", OPTION_PARAMS)
def test_option(concept, name):
    assert name in inspect.signature(PolarisKeyClient.__init__).parameters, concept


@pytest.mark.parametrize("concept,name", START_PARAMS)
def test_start_param(concept, name):
    assert name in inspect.signature(push_request).parameters, concept
    assert name in (SignInNamespace.start.__doc__ or ""), concept


@pytest.mark.parametrize("concept,cls,name", REMOVED)
def test_removed(concept, cls, name):
    assert not hasattr(CLASSES[cls], name), concept
