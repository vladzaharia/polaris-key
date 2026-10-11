"""Pure view, focus and link policy tests for ``polaris_key.ui.core``."""

from __future__ import annotations

from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.core.ui_view import (
    actions_for,
    bidi_isolate,
    code_expired,
    countdown,
    hidden_view,
    identity_text,
    link_verdict,
    make_view,
    valid_link,
)


def test_view_normalizes_copy_derives_actions_and_marks_identity_arguments() -> None:
    ctx = context_of()
    view = make_view(
        ctx,
        "Welcome",
        "default",
        ("welcome.signIn", "common.cancel", "welcome.signIn"),
        args={"product": "Tidewater Studio", "count": 3, "absent": None},
        primary="welcome.signIn",
    )
    assert view.copy == ("common.cancel", "welcome.signIn")
    assert view.actions == ("cancel",)
    assert view.args == {"product": "Tidewater Studio", "count": 3}
    assert view.isolate == ("product",)
    assert view.decisions.primary == "welcome.signIn"
    assert view.decisions.focus == "welcome.signIn"


def test_focus_policy_preserves_keyboard_rules() -> None:
    phone = context_of({"platform": {"os": "ios", "formFactor": "iphone"}})
    tv = context_of({"platform": {"os": "tvos", "formFactor": "tv"}})
    field = make_view(phone, "Activate", "empty", (), primary="part.keyField.label")
    opener = make_view(tv, "SignIn", "methods", (), primary="signin.desktop.continue")
    assert field.decisions.focus == "heading"
    assert opener.decisions.focus == "heading"


def test_identity_precedence_and_hidden_state() -> None:
    ctx = context_of(
        {
            "integrator": {"name": "Integrates", "shortName": "Int", "icon": True},
            "presentation": {"name": "Presentation", "developerName": "Harbor", "icon": True},
            "bundle": {"slug": "bundle", "name": "Bundle"},
        }
    )
    identity = identity_text(ctx)
    assert identity.name == "Integrates"
    assert identity.inline_name == "Int"
    assert identity.developer == "Harbor"
    assert identity.icon
    hidden = hidden_view(ctx, "Settings")
    assert hidden.state == "hidden"
    assert hidden.copy == ()
    assert hidden.decisions.focus is None


def test_safe_links_and_qr_policy_fail_closed() -> None:
    desktop = context_of({"platform": {"os": "windows", "formFactor": "computer"}})
    tv = context_of({"platform": {"os": "tvos", "formFactor": "tv"}})
    assert valid_link("tidewater.example/device") == "https://tidewater.example/device"
    assert valid_link("https://example.test/path") == "https://example.test/path"
    assert valid_link("javascript:alert(1)") is None
    assert valid_link("https://user@example.test/") is None
    browser = link_verdict("tidewater.example/device", desktop.platform, "sign-in")
    code = link_verdict("tidewater.example/device", tv.platform, "sign-in")
    assert browser.open and not browser.qr and browser.display == "tidewater.example/device"
    assert not code.open and code.qr
    assert link_verdict("https://example.test/a", desktop.platform, "purchase").qr is False


def test_countdown_and_bidi_isolation() -> None:
    assert countdown(61.1) == "1:02"
    assert countdown(None) == "0:00"
    assert code_expired(0)
    assert code_expired(-1)
    assert not code_expired(0.1)
    assert bidi_isolate("Tidewater") == "\u2068Tidewater\u2069"
    assert actions_for(("common.tryAgain",)) == ("retry",)
