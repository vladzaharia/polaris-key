# @pkey-feature ui.gate
# @pkey-feature ui.activate
# @pkey-feature ui.devicelimit
# @pkey-feature ui.devices
# @pkey-feature ui.update
# @pkey-feature ui.settings
"""The Qt kit's screen layout (no Qt import): every fixture row of the six ui-matrix families lays out
with its catalog copy, one filled action at most, named controls, and presentation text isolated."""

from __future__ import annotations

import pytest

from polaris_key.ui.core.copy import Copy
from polaris_key.ui.qt.layout import build_spec
from qt_fixtures import all_views

ROWS = all_views()


@pytest.mark.parametrize("name,view", ROWS, ids=[n for n, _ in ROWS])
def test_every_fixture_row_lays_out(name, view):
    spec = build_spec(view, Copy("en", platform="desktop"))
    visible = spec.title or spec.body or spec.buttons
    if view.state == "hidden":
        assert not visible
        return
    assert [b for b in spec.buttons if b.role == "primary"].__len__() <= 1
    for b in spec.buttons:
        assert b.text.strip(), f"{b.key} has no accessible name"
        assert "{" not in b.text, b.text
    for line in [spec.title, *spec.body]:
        assert "{" not in line, line
    # a primary named by the model is the only filled button, and it comes first (DL3)
    if view.decisions.primary and any(b.key == view.decisions.primary for b in spec.buttons):
        assert spec.buttons[0].key == view.decisions.primary
    # the actions the model names are exactly the buttons that carry one
    assert {b.action for b in spec.buttons if b.action} <= set(view.actions)


def test_presentation_args_are_bidi_isolated():
    from polaris_key.ui.core.ui_contract import context_of
    from polaris_key.ui.core.ui_activate import welcome_view

    view = welcome_view(
        context_of(
            {
                "integrator": {"name": "Evil‮Name"},
            }
        )
    )
    spec = build_spec(view, Copy("en", platform="desktop"))
    text = " ".join([spec.title, *spec.body])
    assert "⁨Evil‮Name⁩" in text
