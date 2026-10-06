"""`pkey sdk --lang python --write` (SDK parity pass §3.19, SP-02).

``sdk_config_sample.py`` is the module the CLI writes, committed and pinned to the renderer by
packages/cli/test/sdkConfig.test.ts. It must build a client with nothing but the app's version.
"""

from polaris_key import PolarisKeyClient, UpdateClientOptions

import sdk_config_sample


def test_generated_module_builds_a_client(tmp_path):
    client = PolarisKeyClient.create(
        **sdk_config_sample.CONFIG,
        version="1.2.3",
        config_dir=str(tmp_path / "config"),
        data_dir=str(tmp_path / "data"),
        cache_dir=str(tmp_path / "cache"),
        state_dir=str(tmp_path / "state"),
    )
    try:
        assert not client.is_licensed()
        assert isinstance(sdk_config_sample.CONFIG["update"], UpdateClientOptions)
        assert sdk_config_sample.EXPECTED_SERVICES == ["license", "config", "release", "update"]
        assert sdk_config_sample.PINNED_RELEASE_KEYS == {
            "acme-release-2026": "Z6FCkd1K7Om4lxUk4og_J0m73saH4BrrLk8igXzwcJM"
        }
    finally:
        client.close()
