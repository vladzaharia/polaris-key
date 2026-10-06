# @pkey-feature core.errors
"""Every error code this SDK raises is in the shared registry.

The registry is ``conformance/parity/errors.json``, generated into
``polaris_key/constants_generated.py`` by ``pnpm gen:constants``. The SDK's code constants are
checked directly (the error classes' ``code`` attributes and the §7 bundle refusal reasons), and
``src/`` is scanned for ``PolarisError("<code>", …)`` literals and ``code = "<code>"``
attributes. A new code goes into errors.json first; then this test passes.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple

import polaris_key
from polaris_key import constants_generated as constants
from polaris_key.core.bundle import BUNDLE_REFUSAL_REASONS
from polaris_key.core.errors import InsecureBaseUrlError
from polaris_key.devices.client import DeviceManagementUnsupportedError

SRC = Path(__file__).resolve().parent.parent / "src" / "polaris_key"

_RAISED = (
    re.compile(r"\bPolarisError\(\s*(?:[^,]*?\bor\s+)?\"([a-z][a-z0-9_-]*)\""),
    re.compile(r"^\s*code\s*(?::\s*\w+\s*)?=\s*\"([a-z][a-z0-9_-]*)\"", re.MULTILINE),
    # devices/client.py's roster refusals: the fallback code when the server names none.
    re.compile(r"\b_refusal\(\s*\w+,\s*\"([a-z][a-z0-9_-]*)\""),
)


def raised_codes(text: str) -> List[str]:
    """Every code literal one source text raises."""
    return [m.group(1) for pattern in _RAISED for m in pattern.finditer(text)]


def unregistered(files: Iterable[Tuple[str, str]], registry: Sequence[str]) -> List[str]:
    """The raised codes the registry lacks, each with where it was seen."""
    known = set(registry)
    return [
        f'{path}: "{code}"'
        for path, text in files
        for code in raised_codes(text)
        if code not in known
    ]


def _sources() -> List[Tuple[str, str]]:
    return [
        (str(path.relative_to(SRC)), path.read_text(encoding="utf-8"))
        for path in sorted(SRC.rglob("*.py"))
        if path.name != "constants_generated.py"
    ]


def test_every_code_src_raises_is_registered() -> None:
    files = _sources()
    assert len(files) > 10
    raised = {code for _, text in files for code in raised_codes(text)}
    for code in ("service-unavailable", "local-only", "insecure-base-url", "device_list_failed"):
        assert code in raised
    assert unregistered(files, constants.ERROR_CODE_VALUES) == []


def test_code_constants_are_registered() -> None:
    known = set(constants.ERROR_CODE_VALUES)
    for code in (
        InsecureBaseUrlError.code,
        DeviceManagementUnsupportedError.code,
        *BUNDLE_REFUSAL_REASONS,
    ):
        assert code in known, code


def test_fails_on_an_unregistered_literal() -> None:
    fixture = (
        "fixture.py",
        "\n".join(
            [
                'raise PolarisError("local-only", "registered")',
                'raise PolarisError("brand-new-code", "not registered")',
                'raise PolarisError(body.get("code") or "another_new_code", "fallback")',
                "class X(Exception):",
                '    code = "third-new-code"',
            ]
        ),
    )
    assert unregistered([fixture], constants.ERROR_CODE_VALUES) == [
        'fixture.py: "brand-new-code"',
        'fixture.py: "another_new_code"',
        'fixture.py: "third-new-code"',
    ]


def test_the_generated_module_is_the_registry() -> None:
    assert constants.ErrorCode.SERVICE_UNAVAILABLE == "service-unavailable"
    assert constants.ErrorCode.DEVICE_LIMIT == "device_limit"
    assert constants.ERROR_CODE_KINDS["local-only"] == "client"
    assert constants.ERROR_CODE_KINDS["unauthorized"] == "wire"
    assert tuple(constants.ERROR_CODE_KINDS) == constants.ERROR_CODE_VALUES
    assert polaris_key.ErrorCode is constants.ErrorCode
    assert polaris_key.PROTOCOL_VERSION == 4


def test_the_package_root_reexports_every_generated_constant() -> None:
    # A constant the generator gains (the channel vocabulary, a new enum) reaches the root through
    # the generated ``__all__``, unedited.
    missing = [
        name
        for name in constants.__all__
        if getattr(polaris_key, name, None) is not getattr(constants, name)
        or name not in polaris_key.__all__
    ]
    assert missing == []
    assert polaris_key.CHANNEL_STABLE == "stable"
    assert dict(polaris_key.CHANNEL_ALIASES) == {"staging": "beta", "latest": "stable"}
    assert polaris_key.PR_NUMBER_MAX_DIGITS == 7
