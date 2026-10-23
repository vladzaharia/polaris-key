# GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with `pnpm gen api`.
import inspect

import pytest

from polaris_key.client import PolarisKeyClient
from polaris_key.config.client import ConfigClient, ConfigSetting
from polaris_key.identity.client import IdentityClient
from polaris_key.license.client import LicenseClient

CLASSES = {
    "PolarisKeyClient": PolarisKeyClient,
    "ConfigClient": ConfigClient,
    "ConfigSetting": ConfigSetting,
    "IdentityClient": IdentityClient,
    "LicenseClient": LicenseClient,
}

ATTRS = [
    ("client.create", "PolarisKeyClient", "create"),
    ("client.boot", "PolarisKeyClient", "boot"),
    ("config.get", "ConfigClient", "get_config"),
    ("config.getConfigSource", "ConfigClient", "get_config_source"),
    ("config.getSecret", "ConfigClient", "get_secret"),
    ("config.mintToken", "ConfigClient", "mint_token"),
    ("config.set", "ConfigClient", "set"),
    ("config.clear", "ConfigClient", "clear"),
    ("config.onConfigChange", "ConfigClient", "on_change"),
    ("config.setting", "ConfigClient", "setting"),
    ("config.setting.value", "ConfigSetting", "value"),
    ("config.setting.source", "ConfigSetting", "source"),
    ("config.setting.locked", "ConfigSetting", "enforced"),
    ("config.setting.set", "ConfigSetting", "set"),
    ("config.setting.clear", "ConfigSetting", "clear"),
    ("config.setting.on", "ConfigSetting", "subscribe"),
    ("license.activateWithKey", "LicenseClient", "activate_with_key"),
    ("entitlements.has", "LicenseClient", "is_entitled"),
    ("entitlements.value", "LicenseClient", "entitlement_value"),
    ("entitlements.all", "LicenseClient", "get_entitlements"),
    ("identity.signOut", "IdentityClient", "sign_out"),
]
OPTION_PARAMS = [
    ("options.productSlug", "product_slug"),
    ("options.pinnedKeys", "trust"),
    ("options.pinnedReleaseKeys", "update"),
    ("options.baseUrl", "base_url"),
    ("options.expectedServices", "expected_services"),
]


@pytest.mark.parametrize("concept,cls,name", ATTRS)
def test_present(concept, cls, name):
    assert hasattr(CLASSES[cls], name), concept


@pytest.mark.parametrize("concept,name", OPTION_PARAMS)
def test_option(concept, name):
    assert name in inspect.signature(PolarisKeyClient.__init__).parameters, concept
