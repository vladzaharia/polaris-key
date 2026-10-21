# @pkey-feature ui.cli
"""Baselines for the screens a mounted kit adds (UK-48): the gate's refusal in a host's command, the
activate that finds no key, the value `secret` and `mint` keep back, the update check on a build
without signed updates, a verb offline, and a host's help at 32, 40 and 80 columns. Each is golden
ANSI text in both terminal themes and every variant (truecolor, ANSI-16, NO_COLOR, ascii; 80 and 60
columns; piped), as the fixture states are. Record with ``PKEY_GOLDEN=record``."""

from __future__ import annotations

import io
from types import SimpleNamespace
from typing import Any, Callable, List, Tuple

import pytest

from polaris_key.cli import gate
from polaris_key.cli.argparse_cli import GroupedHelpParser, register_argparse
from polaris_key.core.errors import PolarisError
from polaris_key.license.endpoints import ActivationError
from polaris_key.ui.terminal import flows
from polaris_key.ui.terminal.device import Device
from polaris_key.ui.terminal.flows import Terminal
from polaris_key.ui.terminal.text import Line, to_ansi

from . import svg
from .fixtures import kit
from .golden_support import GOLDEN, THEMES, check, sections, variants


def _terminal(e: Any, verb: str) -> Terminal:
    k = kit(e)
    return Terminal(k, Device(e, k.palette(), stdout=io.StringIO(), use_rich=False), verb)


_PORTAL = "https://polaris.locker/activate?product=tidewater"


def _gate(status: str, usable: bool = False, command: str = "export") -> Callable[[Any], List[Line]]:
    return lambda e: gate.refusal_outcome(_terminal(e, command), command, status, usable, None, _PORTAL).lines


def _outcome(fn: Callable[[Terminal], Any], verb: str) -> Callable[[Any], List[Line]]:
    return lambda e: fn(_terminal(e, verb)).lines


class _Update:
    configured = False

    def check(self, channel: Any = None) -> Any:
        return SimpleNamespace(updateAvailable=True, version="2.5.0", url="https://tidewater.app/releases/2.5")


def _offline(*a: Any, **k: Any) -> Any:
    raise PolarisError("network", "offline")


class _OfflineDiscovery:
    kind = "error"


class _OfflineUpdate:
    configured = True

    def decide(self, channel: Any = None) -> Any:
        raise PolarisError("network", "offline")

    def check(self, channel: Any = None) -> Any:
        raise PolarisError("service-unavailable", "discovery failed")


_OFFLINE = SimpleNamespace(
    product="tidewater",
    core=SimpleNamespace(version="2.4.1", channel="stable", local_only=False),
    try_discover=lambda: _OfflineDiscovery(),
    license=SimpleNamespace(activate_with_key=lambda key: ActivationError(message="offline"), deactivate=_offline),
    identity=SimpleNamespace(begin_sign_in=_offline, sign_out=_offline),
    update=_OfflineUpdate(),
    list_devices=_offline,
)
_OFFLINE.update.configured = False  # type: ignore[attr-defined]


_CLIENT = SimpleNamespace(
    product="tidewater",
    core=SimpleNamespace(version="2.4.1", channel="stable"),
    update=_Update(),
    list_devices=_offline,
    config=SimpleNamespace(get_secret=lambda k: "s3cr3t", mint_token=lambda r: SimpleNamespace(token="tok", expiresAt=1)),
)


SCENES: Tuple[Tuple[str, Callable[[Any], List[Line]]], ...] = (
    ("gate-needs-activation", _gate("needs-activation")),
    ("gate-expired", _gate("expired")),
    ("gate-version-too-old", _gate("version-too-old")),
    ("gate-not-entitled", _gate("ok", usable=True)),
    ("gate-version-too-new", _gate("version-too-new")),
    ("gate-channel-not-entitled", _gate("channel-not-entitled")),
    # No product page to link to: the developer's name stands in.
    ("gate-not-entitled-contact", lambda e: gate.refusal_outcome(_terminal(e, "export"), "export", "ok", True, None, None).lines),
    ("activate-no-key", _outcome(lambda t: flows.no_key(t, piped=False), "activate")),
    ("activate-no-key-piped", _outcome(lambda t: flows.no_key(t, piped=True), "activate")),
    ("secret-hidden", _outcome(lambda t: flows.secret(_CLIENT, t, ["api_key"]), "secret")),
    ("mint-hidden", _outcome(lambda t: flows.mint(_CLIENT, t, ["cdn"]), "mint")),
    ("update-check-unconfigured", _outcome(lambda t: flows.update(_CLIENT, t, ["check"]), "update")),
    ("update-apply-unconfigured", _outcome(lambda t: flows.update(_CLIENT, t, ["apply"]), "update")),
    ("devices-offline", _outcome(lambda t: flows.devices(_CLIENT, t, ["list"]), "devices")),
    ("activate-offline", _outcome(lambda t: flows.activate(_OFFLINE, t, "pkey_tidewater_7Q2MzK8vRb1xLp4n3WPLDA"), "activate")),
    ("login-offline", _outcome(lambda t: flows.sign_in(_OFFLINE, t), "login")),
    ("logout-offline", _outcome(lambda t: flows.sign_out(_OFFLINE, t, yes=True), "logout")),
    ("deactivate-offline", _outcome(lambda t: flows.deactivate(_OFFLINE, t), "deactivate")),
    ("update-check-offline", _outcome(lambda t: flows.update(_OFFLINE, t, ["check"]), "update")),
    ("update-apply-offline", _outcome(lambda t: flows.update(_OFFLINE, t, ["apply"]), "update")),
    ("gate-cannot-check", lambda e: gate.fail_outcome(_terminal(e, "export"), "export").lines),
    ("activate-empty-key-file", _outcome(lambda t: flows.key_file_problem(t, "~/.config/tidewater/license.key", True), "activate")),
)


def _variants(theme: str) -> List[Tuple[str, Any]]:
    """The fixture variants, plus the narrow terminals the gate is held to: 40 and 32 columns."""
    from .golden_support import env

    narrow = [(f"{name} · {w}", env(color, sym, w, theme)) for w in (40, 32) for name, color, sym in (("truecolor", "truecolor", "unicode"), ("no-color", "none", "unicode"))]
    return variants(theme) + narrow


def _document(draw: Callable[[Any], List[Line]], theme: str) -> str:
    parts = []
    for label, e in _variants(theme):
        k = kit(e)
        pal = k.palette()
        parts.append(f"── {label} ──\n" + "\n".join(to_ansi(ln, pal) for ln in draw(e)) + "\n")
    return "".join(parts)


CASES = [(name, draw, theme) for name, draw in SCENES for theme in THEMES]


@pytest.mark.parametrize("case", CASES, ids=[f"{n}-{t}" for n, _, t in CASES])
def test_scene_golden(case: Any) -> None:
    name, draw, theme = case
    doc = _document(draw, theme)
    check(GOLDEN / "scenes" / f"{name}-{theme}.ans", doc)
    check(GOLDEN / "scenes" / f"{name}-{theme}.svg", svg.render(sections(doc)["truecolor · 80"], theme, 80, f"{name}, terminal, {theme} theme"))


@pytest.mark.parametrize("columns", [32, 40, 80])
@pytest.mark.parametrize("theme", THEMES)
def test_host_help_golden(columns: int, theme: str) -> None:
    from .golden_support import env

    e = env("none", "unicode", 80, theme, tty=False)
    check(GOLDEN / "scenes" / f"host-help-{columns}-{theme}.txt", _help_text(e, columns))


def _help_text(e: Any, columns: int) -> str:
    from polaris_key.ui.terminal import env as envmod

    original = envmod.detect
    envmod.detect = lambda **kw: e.but(width=columns, columns=columns)  # type: ignore[assignment]
    try:
        parser = GroupedHelpParser(prog="tidewater", description="Tidewater Studio license and updates")
        sub = parser.add_subparsers(dest="command")
        sub.add_parser("build", help="Build the project", group="Build")
        sub.add_parser("export", help="Export a mix", group="Commands")
        register_argparse(sub, config={"product_slug": "tidewater"}, version="2.4.1")
        return parser.format_help()
    finally:
        envmod.detect = original  # type: ignore[assignment]


def test_every_scene_golden_has_a_scene() -> None:
    names = {f"{n}-{t}" for n, _ in SCENES for t in THEMES}
    for p in (GOLDEN / "scenes").glob("*.ans"):
        assert p.stem in names, f"stale baseline scenes/{p.name}"
    for p in (GOLDEN / "scenes").glob("*.svg"):
        assert p.stem in names, f"stale baseline scenes/{p.name}"
