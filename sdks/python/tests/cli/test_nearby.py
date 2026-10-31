# @pkey-feature identity.nearby
"""Nearby sign-in in the Python terminal kit (I-47.13; plans/I-47-slices.md D-5, D-6, D-10): ``login`` looks
for the person's other devices first (a lone approver after 3 s, several by number, ``c`` for a code, nothing
in 2 s hands over to the regular sign-in), the account is confirmed after the poll signed in (``n`` = Not
you? signs out), and ``devices approve`` shows the three codes as choices 1-3 with ``d`` = Deny. Never under
``--json``, in CI or on a pipe. Everything from the other device is display data from an unverified peer: it
is cleaned before it is drawn (SR-47). The windows run on a fake clock (``WhenKeys``), so nothing here waits."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

from polaris_key.core.errors import PolarisError
from polaris_key.ui.terminal import flows
from polaris_key.ui.terminal.exit import EXIT
from polaris_key.ui.terminal.nearby import APPROVE_S, LISTEN_S, LONE_S

from .fake_session import FakeAsk, FakeNearbySession, FakeSession, WhenKeys, approver, approver_identity, nearby_identity, signed_in
from .test_cli_contract import _terminal, plain

ANA = approver("a1", "Ana's laptop")
BEN = approver("a2", "Ben's phone", "ios")


class _Client:
    product = "tidewater"

    def __init__(self, identity: Any, state_dir: Optional[str] = None) -> None:
        self.identity = identity
        if state_dir is not None:
            self.core = SimpleNamespace(dirs=SimpleNamespace(state=state_dir))

    def status(self) -> Any:
        return SimpleNamespace(status="ok")


def _login(keys: WhenKeys, client: Any, **kw: Any) -> Any:
    t = _terminal("login", interactive=True, keys=keys, **kw)
    return t, flows.sign_in(client, t)


def _screen(t: Any) -> str:
    return plain(t.device.out.getvalue())


def test_the_windows_are_the_plan_s() -> None:
    assert (LISTEN_S, LONE_S, APPROVE_S) == (2.0, 3.0, 300.0)


class TestLogin:
    def test_a_lone_approver_is_chosen_after_3_s_its_code_is_shown_and_enter_confirms_the_account(self) -> None:
        s = FakeNearbySession([ANA])
        calls: List[str] = []
        client = _Client(nearby_identity(s, calls=calls))
        keys = WhenKeys([("Enter continue", "enter")])
        t, out = _login(keys, client)
        shown = _screen(t)
        assert calls == ["available:requester", "start"]
        assert s.chosen == ["a1"]
        # The code, the a11y line and the key hints were on the screen while the poll waited.
        assert "482 913" in shown and "c use a code instead" in shown
        # The code once, naming the device; its screen reader line is its a11y name, never a second row (UXR-47 B3).
        assert shown.count("482 913") == 1 and "Code to tap" not in shown
        assert "on Ana's laptop." in shown
        assert "Waiting…" in shown and "approve it on the other device" not in shown
        assert "browser" not in shown.split("Signed in as")[0]
        assert "Signed in as mara@fennick.studio" in shown and "n or Esc not you, sign out" in shown
        # Still held: the active mark, not the check; the check is the committed frame after Enter (UXR-47 B2).
        assert "◆  Signed in as" in shown
        assert (out.code, out.data["state"]) == (EXIT.ok, "signedIn")
        assert (s.confirmed, s.declined) == (1, 0)

    def test_a_lone_approver_is_not_chosen_before_the_window_has_passed(self) -> None:
        s = FakeNearbySession([ANA], sign_in_after_choose=False)
        keys = WhenKeys([])
        client = _Client(nearby_identity(s))
        t = _terminal("login", interactive=True, keys=keys)
        # 2.9 s of ticks, then Esc: the 3 s window never ended.
        keys.script = [(None, None)] * 0
        ticks = {"n": 0}
        original = keys.read

        def read(timeout: Optional[float] = None) -> Optional[str]:
            if ticks["n"] >= 36:  # 36 x 0.08 s = 2.88 s
                return "esc"
            ticks["n"] += 1
            return original(timeout)

        keys.read = read  # type: ignore[method-assign]
        out = flows.sign_in(client, t)
        assert s.chosen == [] and s.cancelled
        assert out.data["state"] == "cancelled"

    def test_n_is_not_you_the_held_records_are_dropped_the_device_signs_out_and_the_exit_is_1(self) -> None:
        s = FakeNearbySession([ANA])
        t, out = _login(WhenKeys([("not you, sign out", "n")]), _Client(nearby_identity(s)))
        assert (s.declined, s.confirmed) == (1, 0)
        assert (out.code, out.data["state"]) == (EXIT.failed, "declined")
        shown = _screen(t) + "\n".join(out.text)
        assert "Signed out" in "\n".join(out.text) and "tidewater login" in "\n".join(out.text)
        assert shown

    def test_esc_at_the_confirmation_is_not_a_confirmation(self) -> None:
        s = FakeNearbySession([ANA])
        _, out = _login(WhenKeys([("not you, sign out", "esc")]), _Client(nearby_identity(s)))
        assert (s.declined, s.confirmed) == (1, 0)

    def test_several_approvers_are_listed_and_picked_by_number(self) -> None:
        s = FakeNearbySession([ANA, BEN], sign_in_after_choose=False)
        keys = WhenKeys([("2  Ben", "2"), ("Tap this code there", "esc")])
        t, _ = _login(keys, _Client(nearby_identity(s)))
        shown = _screen(t)
        assert "1  Ana's laptop" in shown and "2  Ben's phone" in shown
        # The hint shows the real range (UXR-47 B5).
        assert "1-2 choose a device" in shown and "1-9" not in shown
        assert s.chosen == ["a2"]

    def test_a_lone_approver_shows_its_row_during_the_wait_and_1_skips_it(self) -> None:
        s = FakeNearbySession([ANA], sign_in_after_choose=False)
        keys = WhenKeys([("1  Ana", "1"), ("Tap this code there", "esc")])
        t, _ = _login(keys, _Client(nearby_identity(s)))
        shown = _screen(t)
        assert "1 choose this device" in shown and s.chosen == ["a1"]

    def test_c_uses_a_code_instead_nearby_is_cancelled_and_the_device_code_sign_in_runs(self) -> None:
        s = FakeNearbySession([ANA], sign_in_after_choose=False)
        ran: List[str] = []
        code = FakeSession(behave=lambda token: (ran.append("wait"), signed_in(after=0.3)(token))[1])
        client = _Client(nearby_identity(s, device_code=code))
        t, out = _login(WhenKeys([("Tap this code there", "c")]), client)
        assert s.cancelled and ran == ["wait"]
        assert out.data["state"] == "signedIn"
        # The regular sign-in went to the code view (`c`), not to the browser.
        assert "WDJB-MJHT" in _screen(t)

    def test_esc_cancels_without_an_error_and_ctrl_c_is_an_interrupt(self) -> None:
        for end, code in ((None, EXIT.failed), (KeyboardInterrupt(), EXIT.interrupted)):
            s = FakeNearbySession([ANA], sign_in_after_choose=False)
            keys = WhenKeys([("Tap this code there", "esc")] if end is None else [], end=end)
            t, out = _login(keys, _Client(nearby_identity(s)))
            assert s.cancelled and out.code == code
            assert "✗" not in _screen(t)

    def test_nobody_answering_in_2_s_cancels_nearby_and_the_regular_sign_in_runs(self) -> None:
        s = FakeNearbySession([])
        ran: List[str] = []
        code = FakeSession(behave=lambda token: (ran.append("wait"), signed_in(after=0)(token))[1])
        t, out = _login(WhenKeys([]), _Client(nearby_identity(s, device_code=code)))
        assert s.cancelled and s.chosen == [] and ran == ["wait"]
        assert out.code == EXIT.ok

    def test_a_refused_poll_after_the_tap_is_the_sign_in_s_own_refusal(self) -> None:
        s = FakeNearbySession([ANA], outcome=PolarisError("sign-in-denied", "refused"))
        t, out = _login(WhenKeys([]), _Client(nearby_identity(s)))
        assert out.code == EXIT.failed and out.data["error"] == "sign-in-denied"
        assert "tidewater login" in "\n".join(out.text)

    @pytest.mark.parametrize(
        "kw",
        [dict(json_mode=True), dict(interactive=False), dict(headless=True)],
        ids=["--json", "no terminal", "headless"],
    )
    def test_does_not_start_under_json_without_a_terminal_or_on_a_headless_computer(self, kw: Dict[str, Any]) -> None:
        calls: List[str] = []
        client = _Client(nearby_identity(FakeNearbySession([ANA]), calls=calls))
        keys = WhenKeys([])
        t = _terminal("login", **{"interactive": True, "keys": keys, **kw})
        flows.sign_in(client, t)
        assert calls == []

    def test_device_code_asks_for_a_code_and_never_starts_nearby(self) -> None:
        calls: List[str] = []
        client = _Client(nearby_identity(FakeNearbySession([ANA]), calls=calls))
        t = _terminal("login", interactive=True, keys=WhenKeys([]))
        t.kit.env = t.kit.env.but(device_code=True)
        flows.sign_in(client, t)
        assert calls == []

    def test_it_is_off_where_nearby_is_not_on_offer(self) -> None:
        calls: List[str] = []
        client = _Client(nearby_identity(FakeNearbySession([ANA]), available=False, calls=calls))
        _, out = _login(WhenKeys([]), client)
        assert calls == ["available:requester"] and out.code == EXIT.ok

    @pytest.mark.parametrize("code", ["nearby-unsupported", "service-unavailable"])
    def test_an_unsupported_runtime_or_a_product_with_no_nearby_falls_through(self, code: str) -> None:
        def start(device_name: Any = None, **kw: Any) -> Any:
            if kw.get("channel") == "nearby":
                raise PolarisError(code, "nope")
            return FakeSession(behave=signed_in(after=0))

        identity = SimpleNamespace(nearby=SimpleNamespace(available=lambda *, role: True), sign_in=SimpleNamespace(start=start))
        _, out = _login(WhenKeys([]), _Client(identity))
        assert out.code == EXIT.ok

    def test_a_label_from_the_other_device_is_text_never_an_escape(self) -> None:
        evil = approver("a1", "Ana\x1b]52;c;ZXZpbA==\x07's ‮laptop\x1b[2J\x9b")
        s = FakeNearbySession([evil, BEN], sign_in_after_choose=False)
        t, _ = _login(WhenKeys([("2  Ben", "esc")]), _Client(nearby_identity(s)))
        raw = t.device.out.getvalue()
        assert "Ana" in raw
        for bad in ("\x1b]52", "\x1b[2J", "‮", "\x9b", "\x07"):
            assert bad not in raw, repr(bad)


class TestMacOS:
    def test_it_explains_first_and_remembers_that_a_browse_worked(self, tmp_path: Path) -> None:
        s = FakeNearbySession([ANA], sign_in_after_choose=False)
        client = _Client(nearby_identity(s), str(tmp_path))
        t, _ = _login_on("darwin", WhenKeys([("Enter continue", "enter"), ("Tap this code there", "esc")]), client)
        shown = _screen(t)
        assert "Sign in with your phone" in shown and "allow Tidewater Studio to find devices on your network" in shown
        assert s.chosen == ["a1"]
        assert (tmp_path / "nearby-browsed").read_text(encoding="utf-8") == "1\n"
        # The next run starts at once: no explanation.
        again = FakeNearbySession([ANA], sign_in_after_choose=False)
        t2, _ = _login_on("darwin", WhenKeys([("Tap this code there", "esc")]), _Client(nearby_identity(again), str(tmp_path)))
        assert "Sign in with your phone" not in _screen(t2) and again.chosen == ["a1"]

    def test_not_now_goes_to_the_regular_sign_in_and_starts_nothing(self, tmp_path: Path) -> None:
        calls: List[str] = []
        client = _Client(nearby_identity(FakeNearbySession([ANA]), calls=calls), str(tmp_path))
        _, out = _login_on("darwin", WhenKeys([("Enter continue", "esc")]), client)
        assert calls == ["available:requester"] and out.code == EXIT.ok
        assert not (tmp_path / "nearby-browsed").exists()


def _login_on(platform: str, keys: WhenKeys, client: Any) -> Any:
    t = _terminal("login", interactive=True, keys=keys)
    t.platform = platform
    return t, flows.sign_in(client, t)


class TestApprove:
    def _run(self, ask: Optional[FakeAsk], script: Any, *, raises_: Optional[BaseException] = None, end: Optional[BaseException] = None) -> Any:
        calls: List[str] = []
        client = _Client(approver_identity(ask, raises_=raises_, calls=calls))
        keys = WhenKeys(script, end=end)
        t = _terminal("devices approve", interactive=True, keys=keys)
        out = flows.devices(client, t, ["approve"])
        return t, out, calls

    def test_the_three_codes_are_choices_1_to_3_and_it_picks_exactly_the_code_pressed(self) -> None:
        ask = FakeAsk()
        # 4 and x mean nothing; 3 picks the third code.
        t, out, calls = self._run(ask, [("choose a code", "4"), (None, "x"), (None, "3")])
        shown = _screen(t)
        assert "Let New phone sign in?" in shown
        for line in ("1  111 111", "2  482 913", "3  777 777", "1-3 choose a code · d or Esc deny"):
            assert line in shown
        assert ask.picks == ["777 777"]
        assert (out.code, out.data["state"]) == (EXIT.ok, "approved")
        assert "New phone is signed in" in "\n".join(out.text)
        # The advert stands only while the command runs (D-6): the prompt open, stopped on the way out.
        assert calls == ["on_request:[('prompt', True)]", "stop"]

    @pytest.mark.parametrize("key", ["d", "esc"])
    def test_d_denies_without_picking_esc_denies_quietly_and_both_stop_the_advert(self, key: str) -> None:
        ask = FakeAsk()
        _, out, calls = self._run(ask, [("choose a code", key)])
        assert ask.picks == [] and ask.denied == 1 and "stop" in calls
        assert (out.code, out.data["state"]) == (EXIT.failed, "denied")

    def test_the_license_choice_a_number_gives_that_license_the_last_row_creates_one_esc_denies(self) -> None:
        chosen: List[Any] = []
        view = {
            "choices": [
                {"id": "lic_1", "tierName": "Pro", "name": None, "state": "free"},
                {"id": "lic_2", "tierName": "Team", "name": "Harbor Audio team", "state": "free"},
                {"id": "lic_3", "tierName": "Full", "name": "Full one", "state": "full"},
            ],
            "create": {"tierName": "Pro", "access": "account"},
        }

        def step(_: str) -> Any:
            return SimpleNamespace(
                kind="choose",
                choices=view,
                choose=lambda c: (chosen.append(c), SimpleNamespace(kind="approved"))[1],
                cancel=lambda: SimpleNamespace(kind="denied"),
            )

        def play(key: str) -> Any:
            chosen.clear()
            return self._run(FakeAsk(step), [("choose a code", "2"), ("Choose a license for", key)])

        t, out, _ = play("2")
        shown = _screen(t)
        assert "1  Pro" in shown and "2  Harbor Audio team" in shown and "3  Create a new free license" in shown
        assert "Full one" not in shown  # a full license cannot be given
        assert chosen == [{"kind": "license", "licenseId": "lic_2"}] and out.data["state"] == "approved"
        play("3")
        assert chosen == [{"kind": "create"}]
        _, out, _ = play("esc")
        assert chosen == [] and out.data["state"] == "denied"

    @pytest.mark.parametrize(
        "kind,state,words",
        [
            ("mismatch", "mismatch", "That code didn't match"),
            ("not-nearby", "not-nearby", "isn't on this network"),
            ("expired", "expired", "Start again on New phone."),
            ("device-limit", "device-limit", "This license is on all its devices"),
            ("rate-limited", "rate-limited", "Wait a moment"),
            ("account-required", "account-required", "tidewater login"),
        ],
    )
    def test_each_outcome_of_the_pick_has_its_own_screen_and_exit(self, kind: str, state: str, words: str) -> None:
        _, out, _ = self._run(FakeAsk(SimpleNamespace(kind=kind)), [("choose a code", "1")])
        assert out.data["state"] == state and out.code == EXIT.failed
        assert words in "\n".join(out.text)

    def test_an_unnamed_device_is_the_new_device_and_a_hostile_name_is_only_text(self) -> None:
        _, out, _ = self._run(FakeAsk(device=None), [("choose a code", "2")])
        assert "The new device is signed in" in "\n".join(out.text)
        evil = "Evil\x1b]52;c;ZXZpbA==\x07 ‮phone\x1b[2J"
        t, _, _ = self._run(FakeAsk(device=evil), [("choose a code", "d")])
        raw = t.device.out.getvalue()
        assert "Evil" in raw
        for bad in ("\x1b]52", "\x1b[2J", "‮", "\x07"):
            assert bad not in raw, repr(bad)

    def test_it_waits_300_s_for_a_device_to_ask_then_stops_with_nothing_changed_and_esc_stops_sooner(self, monkeypatch: pytest.MonkeyPatch) -> None:
        t, out, calls = self._run(None, [("Waiting for a device to ask", "esc")])
        assert out.data["state"] == "cancelled" and "stop" in calls
        assert "Waiting for a device to ask" in _screen(t) and "Esc stop" in _screen(t)
        # The 300 s wait, shortened so the fake clock needs a few ticks, not four thousand.
        monkeypatch.setattr("polaris_key.ui.terminal.nearby.APPROVE_S", 2.0)
        t, out, calls = self._run(None, [])
        assert out.data["state"] == "timeout" and out.code == EXIT.failed and calls[-1] == "stop"
        assert "Nothing changed." in "\n".join(out.text)

    @pytest.mark.parametrize("kw", [dict(json_mode=True), dict(interactive=False)], ids=["--json", "no terminal"])
    def test_it_is_refused_before_anything_starts_under_json_and_without_a_terminal(self, kw: Dict[str, Any]) -> None:
        calls: List[str] = []
        client = _Client(approver_identity(FakeAsk(), calls=calls))
        t = _terminal("devices approve", **{"keys": WhenKeys([]), **kw})
        out = flows.devices(client, t, ["approve"])
        assert calls == [] and out.code == EXIT.usage and out.data["error"] == "usage"
        t.finish(out)
        if kw.get("json_mode"):
            last = json.loads(t.device.out.getvalue().splitlines()[-1])
            assert last["error"] == "usage" and last["exit"] == 2

    @pytest.mark.parametrize("code,state", [("nearby-unsupported", "unsupported"), ("account_required", "account-required")])
    def test_an_unsupported_runtime_and_a_signed_out_device_are_typed_results_not_crashes(self, code: str, state: str) -> None:
        _, out, _ = self._run(None, [], raises_=PolarisError(code, "x"))
        assert out.data == {"state": state} and out.code == EXIT.failed
