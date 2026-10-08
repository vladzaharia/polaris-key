# @pkey-feature core.discover license.gate
"""A misspelt ``expected_services`` is refused, never read as "this product runs no License".

Before 0.9 ``expected_services=["licence"]`` dropped the unknown slug, so License read as OFF; a
product without License is ``not-applicable`` and usable, and ``is_licensed()`` answered ``True``
on a device that was never activated. The constructor, ``create()``, the async ``create()``,
``services_from_list`` and the CLI's ``--service`` now all refuse an unknown slug.
"""

from __future__ import annotations

import asyncio
import io
from contextlib import redirect_stderr

import pytest

import polaris_key
from polaris_key import AsyncClient, PolarisError, PolarisKeyClient
from polaris_key.cli import core as cli_core
from polaris_key.cli.argparse_cli import main as cli_main
from polaris_key.devices.store import InMemoryStore
from polaris_key.discovery import check_service_slugs, services_from_list

from helpers import BASE_URL, PRODUCT, TRUST, make_client, mock_client, routes


def _opts(**kw):
    return dict(
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST,
        base_url=BASE_URL,
        store=InMemoryStore(PRODUCT),
        client=mock_client(routes()),
        **kw,
    )


def test_create_refuses_a_misspelt_service() -> None:
    """The acceptance line: ``create(expected_services=['licence'])`` raises."""
    with pytest.raises(PolarisError) as exc:
        polaris_key.create(**_opts(expected_services=["licence"]))
    assert exc.value.code == "invalid-options"
    assert "'licence'" in exc.value.message
    assert 'Did you mean "license"?' in exc.value.message


@pytest.mark.parametrize(
    "bad",
    [["licence"], ["license", "configs"], ["License"], ["update", ""], "license", [None]],
)
def test_every_constructor_refuses_an_unknown_slug(bad) -> None:
    with pytest.raises(PolarisError) as exc:
        PolarisKeyClient(**_opts(expected_services=bad))
    assert exc.value.code == "invalid-options"
    with pytest.raises(PolarisError):
        PolarisKeyClient.create(**_opts(expected_services=bad))
    with pytest.raises(PolarisError):
        asyncio.run(AsyncClient.create(**_opts(expected_services=bad)))
    with pytest.raises(PolarisError):
        services_from_list(bad)


def test_the_typo_can_no_longer_license_an_unactivated_device() -> None:
    """The fail-open itself: the correctly spelt expectation gates; the typo never builds."""
    c = make_client(routes(), expected_services=["license"])
    assert c.is_licensed() is False
    assert c.status().status == "needs-activation"
    c.close()
    with pytest.raises(PolarisError):
        make_client(routes(), expected_services=["licence"])


def test_known_slugs_and_the_empty_expectation_still_work() -> None:
    assert check_service_slugs(["license", "config", "release", "distribution", "update", "identity", "sync"])
    assert check_service_slugs(()) == []
    c = make_client(routes(), expected_services=("config",))
    assert c.status().status == "not-applicable"
    c.close()


def test_the_cli_reports_a_misspelt_service_as_a_usage_error() -> None:
    with pytest.raises(ValueError, match="'licence' names no service"):
        cli_core.parse_services(["licence"])
    assert cli_core.parse_services(["license"]) == ["license"]
    err = io.StringIO()
    with redirect_stderr(err), pytest.raises(SystemExit) as exc:
        cli_main(["status", "--product", PRODUCT, "--service", "licence"])
    assert "names no service" in str(exc.value.code)
