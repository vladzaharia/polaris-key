# @pkey-feature ui.cli
"""The terminal kit against UI-KITS (the spec pass): a refusal the person can resolve is ▲ with its
fix, never ✗ (DL6), and every failed ending keeps the action that starts again (DL7)."""

from __future__ import annotations

import re

import pytest

from .fixtures import FIXTURES
from .golden_support import env, render

BY_NAME = {fx.name: fx for fx in FIXTURES}


def _plain(name: str) -> str:
    _, text = render(BY_NAME[name], env("none", "unicode", 80, "dark"))
    return re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text)


@pytest.mark.parametrize(
    "name",
    ["boot-blocked", "update-prompt-revoked-required-content"],
)
def test_a_refusal_is_a_triangle_with_its_fix_never_a_cross(name: str) -> None:
    text = _plain(name)
    assert "▲" in text and "✗" not in text
    assert "tidewater update" in text, "the fix is a command"


def test_a_failed_check_is_still_a_cross() -> None:
    assert "✗" in _plain("boot-error")  # not a refusal: the start itself failed


def test_a_sign_in_that_could_not_start_offers_the_way_to_start_again() -> None:
    text = _plain("sign-in-error")
    assert "✗  Sign-in unavailable" in text
    assert "tidewater login" in text and "Sign in again" in text


@pytest.mark.parametrize("name", ["sign-in-handoff-expired", "sign-in-handoff-denied"])
def test_every_ending_of_a_sign_in_keeps_the_action_that_starts_again(name: str) -> None:
    assert "Sign in again" in _plain(name)


def test_cancelling_is_not_an_error_so_there_is_no_cross_and_no_way_to_start_again() -> None:
    text = _plain("sign-in-handoff-cancelled")
    assert "✗" not in text and "Sign in again" not in text
    assert text.rstrip().endswith("└  Nothing changed.")


@pytest.mark.parametrize("name", ["status-screen-version-too-new", "status-screen-channel-not-entitled"])
def test_a_refusal_no_command_fixes_labels_the_product_page(name: str) -> None:
    text = _plain(name)
    assert "Next step on the" in text and "page:" in text
