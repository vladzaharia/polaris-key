"""The drop-in flows (layer a): each CLI verb as one call over a client, drawing the kit's screens.

A flow takes a :class:`Terminal` (the kit plus the device it writes to) and returns an
:class:`Outcome`: the exit code, the final screen and the ``--json`` result. Interactive flows
(masked key entry, the sign-in wait, the device-limit hand-off, downloads) redraw in place on an
interactive terminal and print each state once anywhere else; with ``--json`` they print one JSON
object per state and never prompt (SIGN-IN.md D-68).

The JSON shapes are documented on the kit's page (``/docs/build/ui/frameworks/terminal-python/``):
every line is an object with ``"v": 1`` and ``"command"``; progress lines carry ``"event"`` (for
example ``"pending"`` or ``"progress"``), and the last line is always ``"event": "result"`` with
``"ok"`` and ``"exit"``.
"""

from __future__ import annotations

import json as _json
import sys
import threading
import time
from dataclasses import dataclass, field, replace
from typing import IO, Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from ...core.errors import PolarisError
from ..core.identity import ProductIdentity, presentation_source
from ..core.models import (
    BootView,
    DeviceRow,
    DevicesView,
    OfflineView,
    ProgressView,
    SettingsView,
    SignInModel,
    UpdateView,
    activation_view,
    boot_view,
    gate_view,
    parse_key,
    release_notes_view,
    settings_view,
    update_view,
)
from ..core.theme import Theme
from . import fmt, screens
from .device import Device, Worker, run_in_thread
from .env import TermEnv, detect
from .parts import Kit
from .text import Line, Span, plain

__all__ = ["JSON_VERSION", "Outcome", "Terminal"]

#: The ``--json`` schema version every object carries.
JSON_VERSION = 1


@dataclass
class Outcome:
    """A flow's result: exit code, the final lines and the ``--json`` result's fields."""

    code: int = 0
    lines: List[Line] = field(default_factory=list)
    data: Dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> List[str]:
        return [ln.text.rstrip() for ln in self.lines]


class Terminal:
    """The kit bound to one command's terminal: :class:`Kit` (copy, identity, theme, parts) plus
    the :class:`Device` it draws on."""

    def __init__(self, kit: Kit, device: Device, verb: str = "") -> None:
        self.kit = kit
        self.device = device
        self.verb = verb
        #: Ctrl-C ended an interactive step (exit 130, as Node's INTERRUPT); Esc is a plain cancel.
        self.interrupted = False
        # A resize (SIGWINCH, read by a live region) lays the kit's screens out at the new width.
        device.on_resize(self._resized)

    def _resized(self, env: TermEnv) -> None:
        self.kit.env = env

    @classmethod
    def create(
        cls,
        *,
        product: Optional[str] = None,
        client: Any = None,
        theme: Optional[Theme] = None,
        prog: str = "polaris-key",
        verb: str = "",
        json: bool = False,
        no_color: bool = False,
        ascii: bool = False,
        device_code: bool = False,
        env: Optional[Mapping[str, str]] = None,
        stdout: Optional[IO[str]] = None,
        stdin: Optional[IO[str]] = None,
        term_env: Optional[TermEnv] = None,
        use_rich: Optional[bool] = None,
        size: Optional[Callable[[], Tuple[int, int]]] = None,
    ) -> "Terminal":
        th = theme or Theme()
        te = term_env or detect(
            env=env,
            stdout=stdout,
            stdin=stdin,
            no_color=no_color,
            ascii=ascii,
            json=json,
            device_code=device_code,
            color_scheme=th.color_scheme,
            symbols=th.symbols,
            motion=th.motion,
        )
        slug = product or (getattr(client, "product", None) if client is not None else None)
        kit = Kit.create(te, theme=th, product=slug, source=presentation_source(client), prog=prog)
        return cls(kit, Device(te, kit.palette(), stdout=stdout, stdin=stdin, use_rich=use_rich, size=size), verb)

    @property
    def env(self) -> TermEnv:
        return self.kit.env

    def emit(self, event: str, **fields: Any) -> None:
        """One ``--json`` progress object (nothing without ``--json``)."""
        if self.env.json:
            self.device.emit({"v": JSON_VERSION, "command": self.verb, "event": event, **fields})

    def finish(self, outcome: Outcome) -> int:
        """Print the outcome: its lines, or its ``--json`` result object."""
        if self.env.json:
            self.device.emit(
                {"v": JSON_VERSION, "command": self.verb, "event": "result", "ok": outcome.code == 0, "exit": outcome.code, **outcome.data}
            )
        else:
            self.device.print(outcome.lines)
        return outcome.code

    def plain(self, outcome: Outcome) -> List[str]:
        return outcome.text


def _now() -> int:
    return int(time.time())


def _error_outcome(t: Terminal, code: str, verb: str) -> Outcome:
    k = t.kit
    title, message = screens._code_title_message(k, code)
    lines = [k.header(verb)] + ([k.rail()] if k.decor else []) + k.step("fail", [title]) + k.body([message]) + k.end()
    return Outcome(1, lines, {"error": code})


# ── license ──────────────────────────────────────────────────────────────────────────────────


def status(client: Any, t: Terminal, *, store_line: Optional[str] = None) -> Outcome:
    """``status``: the account summary, the grace line, or the blocked state with its fix."""
    st = client.status()
    profile = None
    try:
        profile = client.license.get_profile()
    except Exception:
        profile = None
    signed_in = False
    ident = getattr(client, "identity", None)
    try:
        signed_in = bool(ident is not None and ident.current())
    except Exception:
        signed_in = False
    ar = getattr(st, "allowedRange", None)
    core = getattr(client, "core", None)
    view = gate_view(
        st.status,
        now=_now(),
        grace_until=getattr(st, "graceUntil", None),
        allowed_min=getattr(ar, "min", None) if ar else None,
        allowed_max=getattr(ar, "max", None) if ar else None,
        holder=(getattr(profile, "name", None) or None) if profile else None,
        email=(getattr(profile, "email", None) or None) if profile else None,
        signed_in=signed_in or bool(profile and getattr(profile, "email", None)),
        version=getattr(core, "version", None),
        channel=getattr(core, "channel", None),
        developer=t.kit.identity.developer,
    )
    usable = bool(client.is_licensed())
    lines = screens.gate(t.kit, view, t.verb or "status")
    if store_line:
        k = t.kit
        warn = k.body(k.icon("warn", "warning") + [Span(store_line, (), None, "data:diagnostic")])
        lines = lines[:-1] + warn + lines[-1:] if k.decor else lines + warn
    data: Dict[str, Any] = {
        "status": st.status,
        "usable": usable,
        "component": view.component,
        "state": view.state,
        "graceUntil": getattr(st, "graceUntil", None),
        "allowedRange": {"min": view.allowed_min, "max": view.allowed_max} if ar else None,
        "profile": {"name": view.holder, "email": view.email} if profile else None,
        "version": view.version,
        "channel": view.channel,
    }
    return Outcome(0 if usable else 1, lines, data)


def _activation_data(result: Any) -> Dict[str, Any]:
    return {
        "kind": getattr(result, "kind", None),
        "code": getattr(result, "code", None) if getattr(result, "kind", None) != "ok" else None,
        "deviceCount": getattr(result, "deviceCount", None),
        "limit": getattr(result, "limit", None),
        "manageUrl": getattr(result, "manage_url", None),
    }


def _busy(t: Terminal, fn: Callable[[], Any], draw: Callable[[int], List[Line]]) -> Any:
    """Run ``fn`` on a worker while ``draw(frame)`` spins in a live region."""
    if not t.env.motion:
        return fn()
    w = run_in_thread(fn)
    frame = 0
    with t.device.live() as live:
        while w.is_alive():
            live.update(lambda f=frame: draw(f))
            frame += 1
            w.join(0.08)
    if w.error is not None:
        raise w.error
    return w.result


def read_key(t: Terminal) -> Optional[str]:
    """Masked key entry (UI-KITS §4.3): the prefix stays clear, the body is bullets, the last six
    characters show; the verdict updates as you type, a cut-short key is caught on Enter, a key for
    another product is a warning that does not submit, and the key never touches argv or shell
    history. ``None`` when the person cancels (Esc, or Ctrl-C with ``t.interrupted`` set)."""
    k = t.kit
    raw = ""
    show_empty = False
    final = False
    try:
        with t.device.keys() as keys, t.device.live() as live:
            while True:
                verdict = parse_key(raw, final=final)
                live.update(lambda r=raw, v=verdict, e=show_empty: screens.key_entry(k, r, v, show_empty=e))
                key = keys.read(None)
                if not key:
                    continue  # a wake (a resize) or nothing: draw again
                if key == "esc":
                    return None
                if key == "enter":
                    v = parse_key(raw, final=True)
                    if v.state == "parsed" and not screens.other_product(k, v):
                        return v.key
                    show_empty, final = v.state == "empty", True
                    continue
                final, show_empty = False, False
                if key == "backspace":
                    raw = raw[:-1]
                elif key == "ctrl-u":
                    raw = ""
                elif key not in ("up", "down"):
                    raw += "".join(ch for ch in key if not ch.isspace())
    except KeyboardInterrupt:
        t.interrupted = True
        return None


def activate(client: Any, t: Terminal, key: Optional[str]) -> Outcome:
    """``activate``: the key (masked entry when interactive and none was given), the busy line,
    then done, a refusal with its copy, or Replace a device in the browser and Try again."""
    k = t.kit
    verb = t.verb or "activate"
    if key is None:
        if not t.env.interactive:
            return usage(t, "activate --key-stdin | --key-file <path>")
        key = read_key(t)
        if key is None:
            # Nothing changed: the header, the step and the line saying so (never a blank screen).
            lines = screens._frame(k, verb, k.step("done", [k.t("part.keyField.label")]), [k.t("cli.nothingChanged", "muted")])
            return Outcome(130 if t.interrupted else 1, lines, {"kind": "cancelled"})
    verdict = parse_key(key, final=True)
    while True:
        result = _busy(t, lambda: client.license.activate_with_key(key), lambda f: screens.key_entry(k, key, verdict, busy=True, frame=f))
        view = activation_view(result, key)
        data = _activation_data(result)
        if getattr(result, "kind", None) == "ok":
            try:
                data["status"] = client.status().status
            except Exception:
                pass
            return Outcome(0, screens.activate(k, view, verb), data)
        if view.component == "DeviceLimit" and view.manage_url and t.env.interactive:
            if not _replace_in_browser(t, view, verb):
                # The hints give way to the line that says what to run: nothing live-looking is
                # left above the shell prompt.
                return Outcome(130 if t.interrupted else 1, screens.device_limit(k, view, verb, ended=True), data)
            continue
        return Outcome(1, screens.activate(k, view, verb), data)


def _replace_in_browser(t: Terminal, view: Any, verb: str) -> bool:
    """Replace a device: Enter opens ``manageUrl``; once opened, Enter tries again. ``False``
    when the person leaves (Esc, or Ctrl-C with ``t.interrupted`` set)."""
    k = t.kit
    opened = False
    try:
        with t.device.keys() as keys, t.device.live() as live:
            while True:
                live.update(lambda o=opened: screens.device_limit(k, view, verb, opened=o))
                key = keys.read(None)
                if key == "esc":
                    return False
                if key == "enter":
                    if opened:
                        return True
                    t.device.open_url(view.manage_url)
                    opened = True
    except KeyboardInterrupt:
        t.interrupted = True
        return False


def enroll(client: Any, t: Terminal) -> Outcome:
    k = t.kit
    result = _busy(t, client.license.enroll, lambda f: [Line([Span(screens._spinner(k, f), ("muted",)), Span("  "), k.t("activate.busy")])])
    view = activation_view(result)
    data = _activation_data(result)
    if view.state == "done":
        try:
            data["status"] = client.status().status
        except Exception:
            pass
    lines = screens.activate(k, view, t.verb or "enroll")
    return Outcome(0 if view.state == "done" else 1, lines, data)


def deactivate(client: Any, t: Terminal) -> Outcome:
    client.license.deactivate()
    return _signed_out(t)


def _signed_out(t: Terminal) -> Outcome:
    k = t.kit
    lines = [k.header(t.verb or "sign-out")] + ([k.rail()] if k.decor else []) + k.step("ok", [k.t("core.gate.revoked.title", "strong")]) + k.end()
    return Outcome(0, lines, {"signedOut": True})


# ── identity ─────────────────────────────────────────────────────────────────────────────────


def sign_in(
    client: Any,
    t: Terminal,
    *,
    device_name: Optional[str] = None,
    attach: bool = False,
    browser: bool = False,
    open_url: Optional[Callable[[str], bool]] = None,
) -> Outcome:
    """``login`` / ``sign-in`` (SIGN-IN.md §4.15, frame 32): open the browser and wait, or, when
    headless or with ``--device-code``, show the code. No QR, no license rows (the card chooses).
    Keys: Enter opens the browser again, ``c`` uses a code (then copies it), Esc cancels.
    ``browser`` (``--browser``) opens the browser even when the terminal looks headless."""
    k = t.kit
    verb = t.verb or "sign-in"
    # --browser opens the browser even where the kit would show the code (SSH, CI, a pipe).
    headless = not browser and (t.env.headless or t.env.json or not t.env.interactive)
    model = SignInModel(headless=headless, device_code_url=k.identity.device_code_url)
    opener = open_url or t.device.open_url

    def on_confirm(identity: Any, attachable: bool) -> Optional[bool]:
        return bool(attach) and attachable

    try:
        prompt = _busy(t, lambda: client.identity.begin_sign_in(device_name, confirm_identity=bool(attach)), lambda f: screens.sign_in(k, model.view, verb, frame=f))
    except PolarisError as e:
        model.failed(e.code)
        return Outcome(1, screens.sign_in(k, model.view, verb), {"state": "error", "error": e.code})
    view = model.prompted(prompt, _now())
    t.emit(
        "pending",
        verificationUri=prompt.verificationUri,
        verificationUriComplete=prompt.verificationUriComplete,
        userCode=prompt.userCode,
        expiresAt=prompt.expiresAt,
    )
    if not headless:
        if not opener(prompt.verificationUriComplete):
            view = model.browser_failed()

    cancel = threading.Event()
    worker = run_in_thread(lambda: client.identity.wait_for_sign_in(prompt, cancel=cancel, on_confirm=on_confirm))
    cancelled = False
    if t.env.interactive:
        frame = 0
        copied_at = 0.0
        try:
            with t.device.keys() as keys, t.device.live() as live:
                while worker.is_alive():
                    model.tick(prompt.expiresAt - _now())
                    if model.view.copied and time.monotonic() - copied_at > 2:
                        model.uncopy()  # "Copied" is on the hints row for about two seconds
                    live.update(lambda v=model.view, f=frame: screens.sign_in(k, v, verb, frame=f))
                    frame += 1
                    key = keys.read(0.08)
                    if key == "esc":
                        cancel.set()
                        cancelled = True
                        break
                    code_view = model.view.state in ("code", "no-browser")
                    if key == "c":
                        if code_view:
                            if t.device.copy(prompt.userCode):
                                model.copied()
                                copied_at = time.monotonic()
                        else:
                            model.use_code()
                    elif key == "enter" and model.view.state == "handoff":
                        opener(prompt.verificationUriComplete)
                    elif key == "o" and code_view and not model.view.headless and not model.view.no_browser:
                        opener(prompt.verificationUriComplete)
        except KeyboardInterrupt:
            cancel.set()
            cancelled = True
            t.interrupted = True
        worker.join(5)
    else:
        if not t.env.json:
            t.device.print(screens.sign_in(k, view, verb))
            # Piped output prints its header once: the result that follows is only the result.
            t.device.header_gone = True
        worker.join()
    if cancelled or (isinstance(worker.error, PolarisError) and worker.error.code == "cancelled"):
        model.cancelled()
        return Outcome(130 if t.interrupted else 1, screens.sign_in(k, model.view, verb), {"state": "cancelled"})
    if worker.error is not None:
        code = getattr(worker.error, "code", "sign-in-failed")
        model.failed(code if isinstance(code, str) else "sign-in-failed")
        return Outcome(1, screens.sign_in(k, model.view, verb), {"state": "error", "error": model.view.code})
    result = worker.result
    final = model.finished(result)
    data: Dict[str, Any] = {"state": "signedIn" if final.state == "done" else final.state}
    if final.state == "done":
        data.update(name=final.name, email=final.email, attached=getattr(result, "attached", None))
        try:
            data["status"] = client.status().status
        except Exception:
            pass
        return Outcome(0, screens.sign_in(k, final, verb), data)
    data["error"] = final.code
    return Outcome(1, screens.sign_in(k, final, verb), data)


def sign_out(client: Any, t: Terminal, *, yes: bool = False) -> Outcome:
    """``logout`` / ``sign-out`` (D-71): asks ``(y/N)`` on an interactive terminal unless
    ``--yes``; anywhere else it signs out as it always has."""
    k = t.kit
    if t.env.interactive and not yes:
        lines = [k.header(t.verb or "sign-out")] + [k.rail()] + k.step("warn", [k.t("signin.cli.logoutConfirm", "strong", product=k.inline_product)])
        t.device.print(lines)
        with t.device.keys() as keys:
            key = keys.read(None)
        if key not in ("y", "Y"):
            return Outcome(1, [], {"signedOut": False, "state": "cancelled"})
    client.identity.sign_out()
    return _signed_out(t)


# ── devices ──────────────────────────────────────────────────────────────────────────────────


def _rows(client: Any, locale: str = "en") -> Tuple[DeviceRow, ...]:
    rows = []
    for d in client.list_devices():
        seen = getattr(d, "lastVerifiedAt", None) if d.current else None
        when = fmt.relative(seen, time.time(), locale) if seen else None
        platform = " ".join(p for p in (d.platform, getattr(d, "arch", None)) if p) or None
        rows.append(DeviceRow(d.id, d.label, platform, bool(d.current), when))
    # This device first, as the Node kit lists them.
    return tuple(sorted(rows, key=lambda r: not r.current))


def devices(client: Any, t: Terminal, words: Sequence[str], *, yes: bool = False) -> Outcome:
    k = t.kit
    action = words[0] if words else "list"
    # The header names the sub-verb, as the Node kit's does (`devices list`, `devices rename`, …).
    verb = f"{t.verb or 'devices'} {action}" if action in ("list", "rename", "deauthorize") else (t.verb or "devices")
    try:
        if action == "list":
            rows = _rows(client, k.copy.locale)
            view = DevicesView("Devices", "list" if rows else "empty", rows)
            data = {"devices": [{"id": r.id, "label": r.label, "platform": r.platform, "current": r.current} for r in rows]}
            return Outcome(0, screens.devices(k, view, verb), data)
        if action == "rename" and len(words) >= 2:
            label = " ".join(words[2:]) or None
            client.rename_device(words[1], label)
            done = DevicesView("Devices", "done", target=DeviceRow(words[1], label, None))
            return Outcome(0, screens.devices(k, done, verb), {"renamed": words[1], "label": label})
        if action == "deauthorize" and len(words) == 2:
            if t.env.interactive and not yes:
                target = next((r for r in _rows(client) if r.id == words[1]), DeviceRow(words[1], None, None))
                t.device.print(screens.devices(k, DevicesView("Devices", "confirming", target=target), verb))
                with t.device.keys() as keys:
                    if keys.read(None) not in ("y", "Y"):
                        return Outcome(1, [], {"deauthorized": None, "state": "cancelled"})
            client.deauthorize_device(words[1])
            done = DevicesView("Devices", "done", target=DeviceRow(words[1], None, None))
            return Outcome(0, screens.devices(k, done, verb), {"deauthorized": words[1]})
    except PolarisError as e:
        if e.code == "device-management-unsupported":
            return Outcome(1, screens.devices(k, DevicesView("Devices", "browser-mode"), verb), {"error": e.code})
        return _error_outcome(t, e.code, verb)
    except Exception as e:  # DeviceManagementUnsupportedError
        code = getattr(e, "code", None)
        if code == "device-management-unsupported" or type(e).__name__.startswith("DeviceManagementUnsupported"):
            return Outcome(1, screens.devices(k, DevicesView("Devices", "browser-mode"), verb), {"error": "device-management-unsupported"})
        raise
    return usage(t, "devices [list | rename <id> <label> | deauthorize <id>]")


def usage(t: Terminal, text: str) -> Outcome:
    k = t.kit
    lines = screens.diagnostic(k, t.verb, [("usage:", f"{k.prog} {text}")])
    return Outcome(2, lines, {"error": "usage", "usage": f"{k.prog} {text}"})


# ── config ───────────────────────────────────────────────────────────────────────────────────


def _parse_value(raw: str) -> Any:
    try:
        return _json.loads(raw)
    except ValueError:
        return raw


def config(client: Any, t: Terminal, words: Sequence[str], *, fallback: Optional[str] = None) -> Outcome:
    k = t.kit
    verb = t.verb or "config"
    action = words[0] if words else "list"
    try:
        if action == "list":
            entries = client.config.list_user_config()
            local = client.config.local_values() if hasattr(client.config, "local_values") else {}
            view = settings_view(entries, local)
            data = {"settings": [{"key": r.key, "value": r.value, "source": r.source} for r in view.rows]}
            return Outcome(0, screens.settings(k, view, verb), data)
        if action == "set" and len(words) >= 3:
            client.config.set(words[1], _parse_value(" ".join(words[2:])))
            return _one_setting(client, t, words[1], saved=True)
        if action == "reset" and len(words) == 2:
            client.config.clear(words[1])
            return _one_setting(client, t, words[1], saved=True)
        if action == "get" and len(words) == 2:
            return _one_setting(client, t, words[1], fallback=fallback)
        if len(words) == 1 and action not in ("get", "set", "reset"):
            return _one_setting(client, t, action, fallback=fallback)
    except PolarisError as e:
        return _error_outcome(t, e.code, verb)
    return usage(t, "config [list | get <key> | set <key> <value> | reset <key>]")


def _one_setting(client: Any, t: Terminal, key: str, *, saved: bool = False, fallback: Any = None) -> Outcome:
    value = client.config.get_config(key, fallback)
    source = client.config.get_config_source(key)
    src = {"enforced": "enforced", "local": "local", "env": "env"}.get(source, "default")
    from ..core.models import SettingRow

    view = SettingsView("Settings", "saved" if saved else "list", (SettingRow(key, value, src),))
    return Outcome(0, screens.settings(t.kit, view, t.verb or "config"), {"key": key, "value": value, "source": source})


def secret(client: Any, t: Terminal, words: Sequence[str]) -> Outcome:
    if len(words) != 1:
        return usage(t, "secret <key>")
    present = client.config.get_secret(words[0]) is not None
    lines = screens.diagnostic(t.kit, t.verb, [(words[0], ("present" if present else "absent") + " (values are never printed)")])
    return Outcome(0 if present else 1, lines, {"key": words[0], "present": present})


def mint(client: Any, t: Terminal, words: Sequence[str]) -> Outcome:
    if len(words) != 1:
        return usage(t, "mint <recipe>")
    try:
        tok = client.config.mint_token(words[0])
    except PolarisError as e:
        return _error_outcome(t, e.code, t.verb or "mint")
    lines = screens.diagnostic(t.kit, t.verb, [(words[0], f"expires at {tok.expiresAt} (the token is never printed)")])
    return Outcome(0, lines, {"recipe": words[0], "expiresAt": tok.expiresAt})


# ── release / update ─────────────────────────────────────────────────────────────────────────


class _Progress:
    """Download progress into a live region (≤ 10 Hz) and ``--json`` progress lines (each 5 %). On an
    interactive terminal Esc cancels the download (a key watcher beside it); Ctrl-C raises
    ``KeyboardInterrupt`` out of it, and both leave a result block, never a blank screen."""

    def __init__(self, t: Terminal, draw: Callable[[float, int, int, Optional[float]], List[Line]]) -> None:
        self.t = t
        self.draw = draw
        self.live = t.device.live()
        self.started = time.monotonic()
        self.last = 0.0
        self.pct = -1
        self.total = 0
        self.cancelled = threading.Event()
        self._stop = threading.Event()
        self._watcher: Optional[threading.Thread] = None

    def __enter__(self) -> "_Progress":
        self.live.__enter__()
        if self.t.env.interactive:
            self._watcher = threading.Thread(target=self._watch, daemon=True)
            self._watcher.start()
        return self

    def _watch(self) -> None:
        try:
            with self.t.device.keys() as keys:
                while not self._stop.is_set():
                    if keys.read(0.1) == "esc":
                        self.cancelled.set()
                        return
        except Exception:
            return

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        if self._watcher is not None:
            self._watcher.join(1)
        self.live.__exit__(*exc)

    def __call__(self, done: int, total: int) -> None:
        if self.cancelled.is_set():
            raise PolarisError("cancelled", "The download was cancelled; the next call resumes.")
        self.total = total
        f = done / total if total else 1.0
        pct = int(f * 100)
        if pct != self.pct and (pct % 5 == 0 or pct == 100):
            self.pct = pct
            self.t.emit("progress", done=done, total=total)
        now = time.monotonic()
        if now - self.last < 0.1 and done < total:
            return
        self.last = now
        elapsed = now - self.started
        eta = elapsed * (total - done) / done if done and done < total else None
        self.live.update(lambda: self.draw(f, done, total, eta))


def _update_lines(k: Kit, verb: str, view: UpdateView, f: float, done: int, total: int, eta: Optional[float]) -> List[Line]:
    loc = k.copy.locale
    shown = replace(
        view,
        state="downloading",
        fraction=f,
        done=fmt.size(done, loc),
        total=fmt.size(total, loc),
        eta=fmt.duration(eta, loc) if eta else None,
        done_bytes=done,
        total_bytes=total,
        eta_seconds=eta,
    )
    return screens.update(k, shown, verb)


def _fetch(
    client: Any,
    t: Terminal,
    view: UpdateView,
    current: Optional[str],
    verb: str,
    data: Dict[str, Any],
    run: Callable[["_Progress"], Any],
    extra: Callable[[Any], Dict[str, Any]],
    unsupported_check: bool = False,
) -> Outcome:
    """Download (or install) with progress, ending in one result block: ready, cancelled (Esc exits 1,
    Ctrl-C 130, nothing installed) or failed (what happened, that nothing was installed, and the
    command to try again)."""
    k = t.kit
    base = replace(view, current=current)
    bar = _Progress(t, lambda f, a, b, e: _update_lines(k, verb, base, f, a, b, e))
    try:
        with bar:
            out = run(bar)
    except KeyboardInterrupt:
        t.interrupted = True
        return Outcome(130, screens.update(k, replace(base, state="cancelled"), verb), {**data, "state": "cancelled"})
    except PolarisError as e:
        if e.code == "cancelled":
            return Outcome(1, screens.update(k, replace(base, state="cancelled"), verb), {**data, "state": "cancelled"})
        return Outcome(1, screens.update(k, replace(base, state="failed", code=e.code), verb), {**data, "state": "error", "error": e.code})
    if unsupported_check and getattr(out, "kind", None) == "unsupported":
        return _error_outcome(t, "unsupported", verb)
    size = fmt.size(bar.total, k.copy.locale) if bar.total else None
    done = replace(base, state="ready", size=size)
    return Outcome(0, screens.update(k, done, verb), {**data, **extra(out)})


def update(client: Any, t: Terminal, words: Sequence[str], *, channel: Optional[str] = None, to: Optional[str] = None) -> Outcome:
    k = t.kit
    verb = t.verb or "update"
    action = words[0] if words else "check"
    current = getattr(getattr(client, "core", None), "version", None)
    try:
        if client.update._configured is None:
            if action != "check":
                return Outcome(1, screens.diagnostic(k, verb, [("", "This build configures no signed updates (UpdateClientOptions).")], ok=False), {"error": "not-configured"})
            vc = client.update.check(channel=channel)
            state = "available" if vc.updateAvailable else "up-to-date"
            view = UpdateView("UpdatePrompt", state, vc.version if vc.updateAvailable else None, current, notes_url=vc.url or None, installable=False)
            return Outcome(0, screens.update(k, view, verb), {"state": state, "version": vc.version, "updateAvailable": vc.updateAvailable})
        check = client.update.decide(channel=channel)
        d = check.decision
        view = update_view(d, current=current)
        data: Dict[str, Any] = {"state": view.state, "decision": d.to_dict(), "channel": check.channel}
        if action == "check":
            return Outcome(0, screens.update(k, view, verb), data)
        if action == "download":
            if not to:
                return usage(t, "update download --to <path>")
            return _fetch(client, t, view, current, verb, data, lambda bar: client.release.fetch(check, to=to, on_progress=bar), lambda got: {"path": got.path, "size": got.size, "sha256": got.sha256})
        if action == "apply":
            if client.update.driver is None and d.action == "binary":
                from ...update.drivers import SelfReplaceDriver

                client.update.set_driver(SelfReplaceDriver())

            def finish(out: Any) -> Dict[str, Any]:
                return {"installed": out.kind}

            return _fetch(client, t, view, current, verb, data, lambda bar: client.update.install(check, on_progress=bar), finish, unsupported_check=True)
    except PolarisError as e:
        return _error_outcome(t, e.code, verb)
    return usage(t, "update [check | download --to <path> | apply]")


def changelog(client: Any, t: Terminal, *, limit: Optional[int] = None) -> Outcome:
    try:
        entries = client.release.changelog()
    except PolarisError as e:
        view = release_notes_view(None, error=True)
        return Outcome(1, screens.release_notes(t.kit, view, t.verb or "changelog"), {"error": e.code})
    if isinstance(limit, int) and limit > 0:
        entries = entries[:limit]
    view = release_notes_view(entries)
    data = {"entries": [{"version": e.version, "date": e.date, "summary": e.summary, "url": e.url} for e in entries]}
    return Outcome(0, screens.release_notes(t.kit, view, t.verb or "changelog"), data)


def packs(client: Any, t: Terminal, words: Sequence[str]) -> Outcome:
    k = t.kit
    verb = t.verb or "packs"
    p = client.update.packs
    if not p.configured:
        return Outcome(1, screens.diagnostic(k, verb, [("", "This build has no content stamp (UpdateClientOptions.packs).")], ok=False), {"error": "not-configured"})
    action = words[0] if words else "status"
    try:
        if action == "status":
            st = p.state()
            rows = [(pid, f"{i.get('version')} · {i.get('type')}") for pid, i in sorted(st.active.items())]
            if not rows:
                view = ProgressView("UpdateProgress", "queued")
                return Outcome(0, screens.update_progress(k, view, verb), {"packs": []})
            lines = screens.diagnostic(k, verb, rows)
            return Outcome(0, lines, {"packs": [{"pack": pid, **i} for pid, i in sorted(st.active.items())]})
        if action == "ensure" and len(words) >= 2:
            name = ", ".join(words[1:])
            draw = lambda f, a, b, e: screens.update_progress(k, ProgressView("UpdateProgress", "downloading", name, f, a, b, e), verb)  # noqa: E731
            with _Progress(t, draw) as bar:
                off = p.on(lambda e: bar(e.done, e.total) if e.phase == "download" and e.total else None)
                try:
                    done = p.ensure(words[1:])
                finally:
                    off()
            view = ProgressView("UpdateProgress", "done", name)
            return Outcome(0, screens.update_progress(k, view, verb), {"packs": [{"pack": i["packId"], "version": i["version"]} for i in done]})
    except PolarisError as e:
        view = ProgressView("UpdateProgress", "failed", ", ".join(words[1:]) or None, code=e.code)
        return Outcome(1, screens.update_progress(k, view, verb), {"error": e.code})
    return usage(t, "packs [status | ensure <pack…>]")


# ── core ─────────────────────────────────────────────────────────────────────────────────────


def boot(client: Any, t: Terminal, *, yes: bool = False) -> Outcome:
    """``boot``: one live line per stage, the consent question for a metered download, then
    Ready, or the stop with its fix."""
    k = t.kit
    verb = t.verb or "boot"
    state = {"stage": "idle", "frame": 0, "done": None, "total": None}
    live = t.device.live()
    live.__enter__()

    def draw() -> None:
        st, fr, dn, tt = state["stage"], state["frame"], state["done"], state["total"]
        live.update(lambda: screens.boot_progress(k, st, fr, done=dn, total=tt))
        state["frame"] += 1

    def on_stage(_: Any, emits: Any) -> None:
        for e in emits:
            if e.get("type") == "stage_changed":
                state["stage"] = e["stage"]
                t.emit("stage", stage=e["stage"])
            elif e.get("type") == "fetch_progress":
                loc = k.copy.locale
                state["done"], state["total"] = fmt.size(e["done"], loc), fmt.size(e["total"], loc)
                t.emit("progress", done=e["done"], total=e["total"])
        draw()

    def answer(size: int, metered: bool) -> bool:
        if yes:
            return True
        if not t.env.interactive:
            return False
        live.clear()
        view = BootView("Boot", "consent", size=fmt.size(size, k.copy.locale), metered=metered)
        t.device.print(screens.boot(k, view, verb))
        with t.device.keys() as keys:
            return keys.read(None) in ("y", "Y", "enter")

    try:
        out = client.boot(on_stage=on_stage, answer=answer, consent="never" if yes else "always")
    finally:
        live.__exit__(None, None, None)
    view = boot_view(out)
    data = {"outcome": out.outcome, "stage": out.stage, "status": out.status, "updateAvailable": out.update_available, "error": out.error}
    code = 0 if out.ready else 1
    return Outcome(code, screens.boot(k, view, verb), data)


def offline_request(client: Any, t: Terminal) -> Outcome:
    device = client.core.device_id
    view = OfflineView("OfflineActivation", "default", request_code=device)
    return Outcome(0, screens.offline_activation(t.kit, view, t.verb or "offline-request"), {"product": client.product, "requestCode": device})


def import_bundle(client: Any, t: Terminal, jws: str) -> Outcome:
    verb = t.verb or "import-bundle"
    try:
        r = client.import_bundle(jws)
    except PolarisError as e:
        view = OfflineView("OfflineActivation", "rejected-signature" if e.code == "bundle-jws-rejected" else "rejected", code=e.code)
        return Outcome(1, screens.offline_activation(t.kit, view, verb), {"error": e.code, "message": e.message})
    view = OfflineView("OfflineActivation", "done", imported=tuple(r.imported))
    try:
        st = client.status().status
    except Exception:
        st = None
    return Outcome(0, screens.offline_activation(t.kit, view, verb), {"bundleId": r.bundleId, "imported": list(r.imported), "status": st})


def register(client: Any, t: Terminal) -> Outcome:
    """``register``: the keyless device mint (§6). A ``requires-license`` product's refusal is
    reported, never retried against ``activate``."""
    k = t.kit
    verb = t.verb or "register"
    r = client.devices.register()
    kind = getattr(r, "kind", "error")
    if kind == "ok":
        client.sync(force=True)
        st = client.status()
        lines = [k.header(verb)] + ([k.rail()] if k.decor else [])
        lines += k.step("ok", [k.t(f"core.gate.{st.status}.title", "strong")])
        lines += k.body([k.d(r.deviceId, "id", "muted", nobreak=True)])
        lines += k.end()
        return Outcome(0, lines, {"deviceId": r.deviceId, "status": st.status})
    code = {"registration-closed": "registration_closed", "rate-limited": "rate_limited", "not-configured": "not-configured"}.get(kind, getattr(r, "code", None) or "server-error")
    out = _error_outcome(t, code, verb)
    out.data["kind"] = kind
    return out
