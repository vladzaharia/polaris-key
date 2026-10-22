# @pkey-feature ui.paywall
# @pkey-feature ui.signin
"""The Qt rows and layout of the paywall family and of LicenseChoice (built from the matrix and
fixtures: no runtime path hands the kit a grant roster before I-10b)."""

from __future__ import annotations

import pytest

pytest.importorskip("PySide6.QtQuick")

from polaris_key.ui.core.copy import Copy
from polaris_key.ui.qt.layout import build_spec
from polaris_key.ui.qt.rows import row_data
from qt_fixtures import BY_STATE_VIEWS, SNAPSHOTS, TIDEWATER, FakeSource
from snapshots_util import check


def _spec(component, state):
    view = BY_STATE_VIEWS[(component, state)]
    return build_spec(view, Copy(), product="Tidewater Studio", data=row_data(view.rows))


def _rows(spec):
    return [r for g in spec.groups for r in g.rows]


def test_many_lists_every_license_with_its_seats_and_one_chosen():
    spec = _spec("LicenseChoice", "many")
    rows = _rows(spec)
    assert len(rows) == 6 and sum(r.selected for r in rows) == 1
    assert [r.tag for r in rows][-1] == "All devices in use" and not rows[-1].enabled
    assert all(r.seat is not None for r in rows)
    assert [b.key for b in spec.buttons] == ["signin.choice.continue"] and spec.buttons[0].role == "primary"
    assert "will use it on this Mac" in spec.body[0]


def test_keep_create_and_new_are_their_own_choice():
    keep = _rows(_spec("LicenseChoice", "keep"))
    assert keep[0].id == "keep" and keep[0].selected and sum(r.selected for r in keep) == 1
    create = _rows(_spec("LicenseChoice", "create"))
    assert create[-1].id == "create" and create[-1].selected and all(not r.enabled for r in create[:-1])
    new = _rows(_spec("LicenseChoice", "new"))
    assert [r.id for r in new] == ["new"] and new[0].tag == "New"


def test_all_full_draws_no_continue_and_replace_lists_devices():
    full = _spec("LicenseChoice", "all-full")
    assert full.buttons == [] and all(not r.enabled for r in _rows(full))
    replace = _spec("LicenseChoice", "replace-open")
    rows = _rows(replace)
    assert replace.title.endswith("Work laptop⁩?") and rows[0].selected and rows[0].tag == "Least recent"
    assert not rows[-1].enabled  # this browser is never the one replaced
    assert [b.key for b in replace.buttons] == ["signin.replace.confirm", "signin.replace.back"]
    assert replace.after and "Work laptop" in replace.after[0][0]


def test_paywall_offers_names_the_tier_and_never_invents_checkout():
    offers = _spec("Paywall", "offers")
    assert "Pro" in offers.title and [b.key for b in offers.buttons] == ["paywall.upgrade", "paywall.redeem"]
    assert offers.buttons[0].role == "primary" and offers.buttons[1].role == "quiet"
    assert any("Export to every format" in line for line in offers.body)
    away = _spec("Paywall", "not-available")
    assert away.buttons == []  # no https offers.url, so no control


def test_entitlement_gate_locked_offers_unlock_and_entitled_draws_nothing():
    locked = _spec("EntitlementGate", "not-entitled")
    assert [b.key for b in locked.buttons] == ["entitlement.unlock"] and "Pro" in locked.body[0]
    assert _spec("EntitlementGate", "entitled").as_dict()["hidden"] is True


@pytest.mark.parametrize("state", ["many", "raced"])
def test_a_long_list_keeps_its_continue_when_the_window_is_tall(kit_app, state):
    from polaris_key.ui.core.theme import Theme
    from polaris_key.ui.qt.kit import KitView

    kit = KitView(Theme(color_scheme="dark", platform="gnome"), source=FakeSource(TIDEWATER), size=(480, 900), loading_delay_ms=0)
    try:
        kit.set_view(BY_STATE_VIEWS[("LicenseChoice", state)])
        image = kit.grab()
    finally:
        kit.close()
    check(image, SNAPSHOTS / f"licensechoice-{state}.tall.dark.png")
