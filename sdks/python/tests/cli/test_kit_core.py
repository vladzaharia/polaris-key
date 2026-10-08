# @pkey-feature ui.cli
"""The headless layer under the terminal kit (layer c, UI-KITS §1.3): the copy lookup and its ICU
subset (§4.7, plans/UK-02.md D3/D5, the reference formatter's vectors), product identity through
the presentation seam (§1.2), the theme (§3.1) and the models that map SDK results to a component
and a state."""

from __future__ import annotations

import pytest

from polaris_key.devices.client import RegisterOk  # noqa: F401  (imported for parity with flows)
from polaris_key.license.endpoints import (
    ActivationDeviceLimit,
    ActivationOk,
    ActivationRefused,
    ActivationUnauthorized,
)
from polaris_key.ui.core import Copy, ProductIdentity, Theme, format_message, plural_category, resolve_identity, resolve_locale
from polaris_key.ui.core.models import (
    SignInModel,
    activation_view,
    boot_view,
    gate_view,
    parse_key,
    release_notes_view,
    settings_view,
    update_view,
)
from polaris_key.ui.kit_copy_generated import KIT_COPY, KIT_COPY_LOCALES
from polaris_key.ui.terminal.env import TermEnv
from polaris_key.ui.terminal.parts import Kit

from .fixtures import FIXTURES, Presentation
from .golden_support import env, render


# ── Copy (UI-KITS §4.7) ──────────────────────────────────────────────────────────────────────


def test_the_reference_formatter_vectors() -> None:
    """packages/brand/test/kit-copy.test.ts, "formats plurals per locale …"."""
    m = "{limit, plural, one {# device} other {# devices}}"
    assert format_message("en", m, {"limit": 1}) == "1 device"
    assert format_message("en", m, {"limit": 0}) == "0 devices"
    fr = "{limit, plural, one {# appareil} many {# d’appareils} other {# appareils}}"
    assert format_message("fr", fr, {"limit": 0}) == "0 appareil"
    assert format_message("fr", fr, {"limit": 1000000}) == "1000000 d’appareils"
    ff = KIT_COPY["en"]["part.thisDevice"]
    assert format_message("en", ff, {"formFactor": "mac"}) == "this Mac"
    assert format_message("en", ff, {"formFactor": "toaster"}) == "this device"
    assert format_message("en", "Welcome to {product}") == "Welcome to {product}"


def test_lookup_order_override_locale_english_override_english() -> None:
    assert Copy("de")("common.cancel") == KIT_COPY["de"]["common.cancel"]
    assert Copy("de", {"de": {"common.cancel": "über"}})("common.cancel") == "über"
    assert Copy("de", {"en": {"common.cancel": "X"}})("common.cancel") == KIT_COPY["de"]["common.cancel"]
    assert Copy("en", {"en": {"common.cancel": "X"}})("common.cancel") == "X"
    assert Copy("en", {"common.cancel": "Nope"})("common.cancel") == "Nope"
    with pytest.raises(KeyError):
        Copy("en")("no.such.key")


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("de_DE.UTF-8", "de"),
        ("pt_BR", "pt-BR"),
        ("pt", "pt-BR"),
        ("zh_CN.UTF-8", "zh-Hans"),
        ("zh-Hans", "zh-Hans"),
        ("zh_TW", "en"),
        ("ja", "ja"),
        ("C", "en"),
        ("nl_NL", "en"),
    ],
)
def test_locale_resolution(raw: str, expected: str) -> None:
    assert resolve_locale(raw, {}) == expected


def test_locale_from_the_environment() -> None:
    assert resolve_locale(None, {"LANG": "ko_KR.UTF-8"}) == "ko"
    assert resolve_locale(None, {"LC_ALL": "it_IT", "LANG": "de_DE"}) == "it"
    assert resolve_locale(None, {}) == "en"


@pytest.mark.parametrize("locale", ["en", "de", "fr", "es", "pt-BR", "it", "ja", "ko", "zh-Hans"])
def test_plural_categories_match_cldr_for_integers(locale: str) -> None:
    cats = {plural_category(locale, n) for n in (0, 1, 2, 5, 21, 1_000_000)}
    expected = {
        "en": {"one", "other"},
        "de": {"one", "other"},
        "fr": {"one", "many", "other"},
        "es": {"one", "many", "other"},
        "pt-BR": {"one", "many", "other"},
        "it": {"one", "many", "other"},
        "ja": {"other"},
        "ko": {"other"},
        "zh-Hans": {"other"},
    }[locale]
    assert cats == expected


@pytest.mark.parametrize("locale", list(KIT_COPY_LOCALES))
def test_every_fixture_renders_in_every_launch_locale(locale: str) -> None:
    """Every key the terminal uses exists in every launch locale, and formats (no stray braces)."""
    for fx in FIXTURES:
        k = Kit.create(env("ansi16", "unicode", 80, "dark"), theme=Theme(copy={"locale": locale}), product="tidewater", source=Presentation())
        fx.draw(k)
        for key in set(k.used):
            assert key in KIT_COPY[locale] or key.startswith("core."), (locale, key)
        text = "".join(span.text for line in fx.draw(k) for span in line.spans)
        assert "{" not in text and "}" not in text, (locale, fx.name, text)


# ── Product identity (UI-KITS §1.2) ──────────────────────────────────────────────────────────


def test_a_fake_presentation_source_gives_the_product_accent_with_no_integrator_code() -> None:
    ident = resolve_identity(source=Presentation(), slug="tidewater")
    assert ident.name == "Tidewater Studio" and ident.developer == "Harbor Audio"
    assert ident.accent_source == "product"
    dark = ident.accent("dark")
    assert dark is not None and dark.solid == "#26847a" and dark.on == "#ffffff"
    k = Kit.create(env("truecolor", "unicode", 80, "dark"), source=Presentation(), product="tidewater")
    assert k.palette().chip == "1;38;2;255;255;255;48;2;38;132;122"


def test_the_kit_reads_the_sdk_accessor_when_the_client_has_one() -> None:
    from polaris_key.ui.core import presentation_source

    class Client:
        product = "tidewater"

        def presentation(self):
            return {"name": "Tidewater Studio", "accentDark": "#72cabe"}

    src = presentation_source(Client())
    ident = resolve_identity(source=src, slug="tidewater")
    assert ident.name == "Tidewater Studio" and ident.accent_dark == "#72cabe" and ident.accent_light is None
    assert presentation_source(object()) is None


def test_the_integrator_wins_then_presentation_then_icon_then_ink() -> None:
    mine = resolve_identity(integrator=ProductIdentity(name="Mine", accent="#ff6a3d"), source=Presentation())
    assert mine.name == "Mine" and mine.accent_source == "integrator"
    assert resolve_identity(source=Presentation(), accent="#123456").accent_source == "integrator"
    bare = resolve_identity(slug="tidewater")
    assert bare.name == "tidewater" and bare.accent_source == "ink" and bare.accent("dark") is None
    teal = [0x36, 0x91, 0x86, 255] * 64
    icon = resolve_identity(integrator=ProductIdentity(icon_rgba=teal), slug="tidewater")
    assert icon.accent_source == "icon"
    assert resolve_identity(slug="x", accent="core").accent_source == "core"


def test_a_broken_presentation_source_never_breaks_the_kit() -> None:
    class Broken:
        def current(self):
            raise RuntimeError("offline")

    assert resolve_identity(source=Broken(), slug="tidewater").name == "tidewater"


def test_ink_and_native_draw_no_product_colour() -> None:
    k = Kit.create(env("truecolor", "unicode", 80, "dark"), product="tidewater")
    assert k.palette().chip == "1;7" and k.palette().accent == "1"
    native = Kit.create(env("truecolor", "unicode", 80, "dark"), theme=Theme(preset="native"), source=Presentation(), product="tidewater")
    assert native.palette().chip == "1;7"
    ansi16 = Kit.create(env("ansi16", "unicode", 80, "dark"), source=Presentation(), product="tidewater")
    assert ansi16.palette().chip == "1;7;36" and ansi16.palette().accent == "36"


def test_light_and_dark_resolve_the_accent_per_scheme() -> None:
    dark = Kit.create(env("truecolor", "unicode", 80, "dark"), source=Presentation(), product="t").palette()
    light = Kit.create(env("truecolor", "unicode", 80, "light"), source=Presentation(), product="t").palette()
    assert dark.accent == "38;2;114;202;190" and light.accent == "38;2;20;121;111"


def test_theme_colors_override_a_role_per_scheme() -> None:
    th = Theme(colors={"dark": {"muted": "2"}})
    _, text = render(FIXTURES[0], env("ansi16", "unicode", 80, "dark"))
    k = Kit.create(env("ansi16", "unicode", 80, "dark"), theme=th, source=Presentation(), product="t")
    assert k.palette().params(("muted",)) == "2"
    assert "\x1b[90m" in text


def test_theme_validates_its_fields() -> None:
    with pytest.raises(ValueError):
        Theme(preset="neon")
    with pytest.raises(ValueError):
        Theme(color_scheme="sepia")
    with pytest.raises(ValueError):
        Theme(symbols="emoji")
    assert Theme(copy={"locale": "de", "common.cancel": "X"}).locale == "de"


def test_the_symbols_hook_selects_ascii() -> None:
    from polaris_key.ui.terminal.env import detect

    e = detect(env={"TERM": "xterm"}, stdout=_Tty(), stdin=_Tty(), symbols="ascii", osc11=lambda: None)
    assert e.symbols == "ascii"


# ── Models ───────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "status,component,state",
    [
        ("ok", "AccountAndLicense", "key-only"),
        ("grace", "GraceBanner", "days-left"),
        ("expired", "StatusScreen", "expired"),
        ("revoked", "StatusScreen", "revoked"),
        ("needs-activation", "PolarisKeyGate", "needs-activation"),
        ("version-too-old", "StatusScreen", "version-too-old"),
        ("version-too-new", "StatusScreen", "version-too-new"),
        ("channel-not-entitled", "StatusScreen", "channel-not-entitled"),
        ("not-applicable", "PolarisKeyGate", "licensed"),
    ],
)
def test_gate_view_maps_every_license_status(status: str, component: str, state: str) -> None:
    v = gate_view(status, now=0, grace_until=3 * 86_400)
    assert (v.component, v.state) == (component, state)
    assert v.usable is (status in ("ok", "grace", "not-applicable"))


def test_grace_last_day_and_signed_in() -> None:
    assert gate_view("grace", now=0, grace_until=3600).state == "last-day"
    assert gate_view("ok", now=0, signed_in=True).state == "signed-in"


@pytest.mark.parametrize(
    "raw,final,state",
    [
        ("", False, "empty"),
        ("pk", False, "typing"),
        ("TIDE-1234", True, "malformed"),
        ("pkey_tidewater_7Q2M", False, "typing"),
        ("pkey_tidewater_7Q2M", True, "cut-short"),
        ("pkey_tidewater_7Q2MzK8vRb1xLp4n3WPLDA", False, "parsed"),
        ("pkey_tidewater_7Q2MzK8vRb1xLp4n3WPLDAxx", False, "malformed"),
        ("pkey_Tide_abc", True, "malformed"),
    ],
)
def test_parse_key(raw: str, final: bool, state: str) -> None:
    v = parse_key(raw, final=final)
    assert v.state == state
    if state == "cut-short":
        assert (v.prefix, v.used, v.limit) == ("pkey_tidewater_", 4, 22)


def test_activation_view() -> None:
    assert activation_view(ActivationOk(token="t")).state == "done"
    lim = activation_view(ActivationDeviceLimit(limit=3, deviceCount=3, manage_url="https://k/m"), "k")
    assert (lim.component, lim.state, lim.used, lim.limit, lim.manage_url) == ("DeviceLimit", "browser-mode", 3, 3, "https://k/m")
    assert activation_view(ActivationDeviceLimit()).state == "failed"
    assert activation_view(ActivationUnauthorized()).kind == "unauthorized"
    assert activation_view(ActivationRefused("key_entry_limit", 403)).kind == "key-entry-limit"


def test_sign_in_model_walks_its_states() -> None:
    class P:
        userCode = "WDJB-MJHT"
        verificationUri = "https://key.plrs.im/device"
        verificationUriComplete = "https://key.plrs.im/device?user_code=WDJB-MJHT"
        expiresAt = 600

    m = SignInModel()
    assert m.view.state == "starting"
    assert m.prompted(P(), 0).state == "handoff" and m.view.seconds_left == 600
    assert m.use_code().state == "code"
    assert m.tick(-5).seconds_left == 0
    h = SignInModel(headless=True, device_code_url="https://driftkart.gg/tv")
    assert h.prompted(P(), 0).url == "https://driftkart.gg/tv"
    assert SignInModel().cancelled().state == "cancelled"
    done = SignInModel().finished(type("R", (), {"status": "ready", "identity": type("I", (), {"name": "M", "email": "m@x"})()})())
    assert (done.state, done.name, done.email) == ("done", "M", "m@x")
    assert SignInModel().finished(type("R", (), {"status": "expired"})()).state == "expired"
    assert SignInModel().finished(type("R", (), {"status": "error", "message": "access_denied"})()).state == "denied"


def test_update_view_maps_every_action() -> None:
    from polaris_key.core.models import DecisionRelease, UpdateDecision

    rel = DecisionRelease("2.5", 9)
    assert update_view(UpdateDecision("none", reason="latest")).state == "up-to-date"
    assert update_view(UpdateDecision("binary", release=rel)).state == "available"
    assert update_view(UpdateDecision("binary", release=rel, mandatory=True)).state == "mandatory"
    assert update_view(UpdateDecision("store", release=rel, listingUrl="u")).state == "store"
    assert update_view(UpdateDecision("platform", release=rel)).state == "platform"
    assert update_view(UpdateDecision("blocked", reason="app-floor")).state == "blocked"
    assert update_view(UpdateDecision("blocked", reason="app-floor", contentBlock="revoked-content")).state == "revoked-required-content"


def test_boot_release_notes_and_settings_views() -> None:
    class Out:
        outcome = "offline"
        stage = "offline"
        emits = ()
        status = "ok"
        state = type("S", (), {"canPlayOffline": True})()
        error = None

    assert (boot_view(Out()).state, boot_view(Out()).playable) == ("offline", True)
    Out.outcome, Out.status = "waiting", "needs-activation"
    assert boot_view(Out()).component == "PolarisKeyGate"
    Out.outcome, Out.emits = "ready", ({"type": "boot_rolled_back"},)
    assert boot_view(Out()).state == "rolled-back"
    assert release_notes_view([]).state == "empty" and release_notes_view(None, error=True).state == "error"
    v = settings_view([{"key": "a", "value": 1, "enforced": True}], {"b": 2})
    assert v.state == "locked" and [r.source for r in v.rows] == ["enforced", "local"]


class _Tty:
    def isatty(self) -> bool:
        return True


# ── Terminal detection (UI-KITS §1.4 Terminal) ───────────────────────────────────────────────


def _detect(**kw):
    from polaris_key.ui.terminal.env import detect

    kw.setdefault("stdout", _Tty())
    kw.setdefault("stdin", _Tty())
    kw.setdefault("osc11", lambda: None)
    kw.setdefault("platform", "darwin")
    kw.setdefault("size", lambda: (120, 40))
    return detect(**kw)


def test_detect_colour_modes() -> None:
    assert _detect(env={"TERM": "xterm-256color"}).color == "ansi16"
    assert _detect(env={"COLORTERM": "truecolor"}).color == "truecolor"
    assert _detect(env={"NO_COLOR": "1", "COLORTERM": "truecolor"}).color == "none"
    assert _detect(env={}, no_color=True).color == "none"
    assert _detect(env={}, json=True).color == "none"
    assert _detect(env={}, stdout=object()).color == "none"
    assert _detect(env={"FORCE_COLOR": "1"}, stdout=object()).color == "ansi16"
    dumb = _detect(env={"TERM": "dumb"})
    assert (dumb.color, dumb.symbols, dumb.motion) == ("none", "ascii", False)


def test_detect_width_scheme_motion_and_headless() -> None:
    assert _detect(env={}).width == 80
    assert _detect(env={}, size=lambda: (64, 24)).width == 64
    assert _detect(env={}, size=lambda: (40, 24)).width == 60
    assert _detect(env={}).scheme == "dark"
    assert _detect(env={"COLORFGBG": "0;15"}).scheme == "light"
    assert _detect(env={"PKEY_THEME": "light"}).scheme == "light"
    assert _detect(env={"COLORTERM": "truecolor"}, osc11=lambda: "light").scheme == "light"
    assert _detect(env={}, osc11=lambda: "light").scheme == "dark", "ANSI-16 never asks"
    assert _detect(env={}, color_scheme="dark", osc11=lambda: "light").scheme == "dark"
    assert _detect(env={"CI": "1"}).motion is False and _detect(env={}).motion is True
    assert _detect(env={}, motion="reduced").motion is False
    assert _detect(env={"SSH_CONNECTION": "x"}).headless is True
    assert _detect(env={}, platform="linux").headless is True
    assert _detect(env={"DISPLAY": ":0"}, platform="linux").headless is False
    assert _detect(env={}, device_code=True).headless is True


def test_osc11_and_colorfgbg_parsing() -> None:
    from polaris_key.ui.terminal.env import parse_colorfgbg, parse_osc11

    assert parse_osc11("\x1b]11;rgb:ffff/ffff/ffff\x1b\\") == "light"
    assert parse_osc11("\x1b]11;rgb:1010/1111/1414\x07") == "dark"
    assert parse_osc11("nonsense") is None
    assert parse_colorfgbg("15;0") == "dark" and parse_colorfgbg("0;default;15") == "light"
    assert parse_colorfgbg("x") is None and parse_colorfgbg(None) is None


def test_a_bare_termenv_is_plain() -> None:
    e = TermEnv()
    assert (e.tty, e.color, e.interactive) == (False, "none", False)
