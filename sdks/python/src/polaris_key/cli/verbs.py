"""The CLI kit's full verb set (SDK parity pass §2.1 / §2.3, SP-P12), framework-agnostic.

Each verb is a function ``(client, ns) -> CommandResult`` over a plain namespace of parsed
values, described once in :data:`VERBS`. The argparse, click and typer front ends build their
commands from that table, so the three can never disagree:

==================  =======================================================================
``sign-in``         device-code sign-in: URL, code and a terminal QR; ``--browser`` opens it
``sign-out``        release this device's seat and forget the identity
``devices``         ``list`` (default) · ``rename <id> <label>`` · ``deauthorize <id>``
``config``          ``list`` · ``get <key>`` · ``set <key> <value>`` · ``reset <key>`` (and the
                    v3 shorthand ``config <key>``)
``secret``          ``secret <key>``: whether a managed secret is present (never printed)
``mint``            ``mint <recipe>``: an edge-minted token's expiry (never printed)
``update``          ``check`` (default) · ``download --to <path>`` · ``apply``
``changelog``       the published releases, newest first
``packs``           ``status`` (default) · ``ensure <pack…>`` with progress lines
``boot``            the one-call boot, one line per stage
``offline-request`` the request code for an offline activation bundle, with a QR
``doctor``          base URL, discovery, services, store, outlet and every ``supports()`` answer
==================  =======================================================================

Values are parsed from strings: ``config set`` reads its value as JSON when it is one
(``true``, ``3``, ``["a"]``) and as a string otherwise.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .. import qr
from ..copy import message as copy_message
from ..core.caps import Unsupported
from ..core.errors import PolarisError
from .core import CommandResult

__all__ = ["Opt", "Verb", "VERBS", "VERB_NAMES"]


@dataclass(frozen=True)
class Opt:
    """One option: ``kind`` is ``flag``, ``str`` or ``int``."""

    name: str
    kind: str = "str"
    help: str = ""
    default: Any = None


@dataclass(frozen=True)
class Verb:
    name: str
    group: str
    help: str
    run: Callable[[Any, Dict[str, Any]], CommandResult]
    #: Free positional words (the action and its arguments), or none.
    words: bool = False
    opts: Tuple[Opt, ...] = field(default_factory=tuple)


def _err(e: PolarisError, verb: str) -> CommandResult:
    return CommandResult(1, [f"{verb} failed: {copy_message(e.code)} ({e.code})"])


# ── identity ─────────────────────────────────────────────────────────────────────────
def sign_in(client: Any, ns: Dict[str, Any]) -> CommandResult:
    out: List[str] = []
    printer: Callable[[str], None] = ns.get("_print") or print

    def show(prompt: Any) -> None:
        printer(f"Open {prompt.verificationUri} and enter the code {prompt.userCode}")
        printer(f"or go straight to {prompt.verificationUriComplete}")
        if not ns.get("no_qr"):
            code = qr.terminal(prompt.verificationUriComplete, ascii=bool(ns.get("ascii")))
            if code:
                printer(code)

    def confirm(identity: Any, attachable: bool) -> Optional[bool]:
        who = identity.email or identity.name or "this account"
        printer(f"Signed in as {who}.")
        return bool(ns.get("attach")) and attachable

    try:
        if ns.get("browser"):
            r = client.identity.sign_in_with_browser(
                device_name=ns.get("device_name"),
                on_prompt=show,
                confirm_identity=bool(ns.get("attach")),
                on_confirm=confirm,
            )
        else:
            prompt = client.identity.begin_sign_in(
                ns.get("device_name"), confirm_identity=bool(ns.get("attach"))
            )
            show(prompt)
            r = client.identity.wait_for_sign_in(prompt, on_confirm=confirm)
    except PolarisError as e:
        return _err(e, "Sign-in")
    if r.status != "ready":
        code = "sign-in-expired" if r.status == "expired" else "sign-in-failed"
        return CommandResult(1, out + [f"Sign-in failed: {copy_message(code)}"])
    who = (r.identity.email or r.identity.name) if r.identity else None
    line = f"Signed in{' as ' + who if who else ''}. Status: {client.status().status}"
    if r.attached:
        line += f" (this device's licence was {r.attached})"
    return CommandResult(0, out + [line])


def sign_out(client: Any, ns: Dict[str, Any]) -> CommandResult:
    client.identity.sign_out()
    return CommandResult(0, ["Signed out. Local credentials wiped."])


# ── devices ──────────────────────────────────────────────────────────────────────────
def devices(client: Any, ns: Dict[str, Any]) -> CommandResult:
    words = list(ns.get("words") or ["list"])
    action = words[0]
    try:
        if action == "list":
            rows = client.list_devices()
            lines = []
            for d in rows:
                mark = "*" if d.current else " "
                label = d.label or "(unnamed)"
                extra = " ".join(x for x in (d.platform, d.appVersion) if x)
                lines.append(f"{mark} {d.id}  {label}  {d.status}  {extra}".rstrip())
            return CommandResult(0, lines or ["No devices."])
        if action == "rename" and len(words) >= 2:
            label = " ".join(words[2:]) or None
            client.rename_device(words[1], label)
            return CommandResult(0, [f"Renamed {words[1]}."])
        if action == "deauthorize" and len(words) == 2:
            client.deauthorize_device(words[1])
            return CommandResult(0, [f"Deauthorized {words[1]}."])
    except PolarisError as e:
        return _err(e, "devices")
    except Exception as e:  # DeviceManagementUnsupportedError
        code = getattr(e, "code", "device-management-unsupported")
        return CommandResult(1, [f"devices failed: {copy_message(code)}"])
    return CommandResult(2, ["usage: devices [list | rename <id> <label> | deauthorize <id>]"])


# ── config ───────────────────────────────────────────────────────────────────────────
def _parse_value(raw: str) -> Any:
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def config(client: Any, ns: Dict[str, Any]) -> CommandResult:
    words = list(ns.get("words") or ["list"])
    action = words[0]
    try:
        if action == "list":
            entries = client.config.list_user_config()
            local = client.config.local_values() if hasattr(client.config, "local_values") else {}
            lines = []
            for e in entries:
                lock = " [enforced]" if e.get("enforced") else ""
                lines.append(f"{e['key']} = {json.dumps(e['value'])}{lock}")
            for k, v in sorted(local.items()):
                if not any(e["key"] == k for e in entries):
                    lines.append(f"{k} = {json.dumps(v)} [local]")
            return CommandResult(0, lines or ["No settings."])
        if action == "get" and len(words) == 2:
            key = words[1]
        elif action == "set" and len(words) >= 3:
            client.config.set(words[1], _parse_value(" ".join(words[2:])))
            return CommandResult(0, [f"{words[1]} = {json.dumps(client.config.get_config(words[1]))} (source: local)"])
        elif action == "reset" and len(words) == 2:
            client.config.clear(words[1])
            value = client.config.get_config(words[1])
            return CommandResult(0, [f"{words[1]} reset (now {json.dumps(value)}, source: {client.config.get_config_source(words[1])})"])
        elif len(words) == 1 and action not in ("get", "set", "reset"):
            key = action  # the v3 shorthand: `config <key>`
        else:
            return CommandResult(2, ["usage: config [list | get <key> | set <key> <value> | reset <key>]"])
    except PolarisError as e:
        return _err(e, "config")
    value = client.config.get_config(key, ns.get("fallback"))
    source = client.config.get_config_source(key)
    return CommandResult(0, [f"{key} = {value!r} (source: {source})"])


def secret(client: Any, ns: Dict[str, Any]) -> CommandResult:
    words = list(ns.get("words") or [])
    if len(words) != 1:
        return CommandResult(2, ["usage: secret <key>"])
    present = client.config.get_secret(words[0]) is not None
    return CommandResult(0 if present else 1, [f"{words[0]}: {'present' if present else 'absent'} (values are never printed)"])


def mint(client: Any, ns: Dict[str, Any]) -> CommandResult:
    words = list(ns.get("words") or [])
    if len(words) != 1:
        return CommandResult(2, ["usage: mint <recipe>"])
    try:
        t = client.config.mint_token(words[0])
    except PolarisError as e:
        return _err(e, "mint")
    return CommandResult(0, [f"Minted a {words[0]} token, expires at {t.expiresAt} (the token is never printed)."])


# ── release / update ─────────────────────────────────────────────────────────────────
def update(client: Any, ns: Dict[str, Any]) -> CommandResult:
    words = list(ns.get("words") or ["check"])
    action = words[0]
    channel = ns.get("channel")
    try:
        if client.update._configured is None:
            if action != "check":
                return CommandResult(1, ["This build configures no signed updates (UpdateClientOptions)."])
            v = client.update.check(channel=channel)
            return CommandResult(0, [f"Newest: {v.version}{' (update available)' if v.updateAvailable else ' (up to date)'}"])
        check = client.update.decide(channel=channel)
        d = check.decision
        if action == "check":
            if d.release is None:
                return CommandResult(0, [f"Up to date ({d.reason or d.action})."])
            must = " (required)" if d.mandatory else ""
            return CommandResult(0, [f"Update available: {d.release.version}{must} [{d.action}]"])
        if action == "download":
            to = ns.get("to")
            if not to:
                return CommandResult(2, ["usage: update download --to <path>"])
            got = client.release.fetch(check, to=to, on_progress=_bar(ns))
            return CommandResult(0, [f"Downloaded {got.size} bytes to {got.path} (sha256 {got.sha256}, verified)."])
        if action == "apply":
            if client.update.driver is None and d.action == "binary":
                from ..update.drivers import SelfReplaceDriver

                client.update.set_driver(SelfReplaceDriver())
            out = client.update.install(check, on_progress=_bar(ns))
            if out.kind == "unsupported":
                return CommandResult(1, [f"Cannot apply: {out.detail} ({out.reason})"])
            return CommandResult(0, [{"restart-required": "Installed. Restart to finish.",
                                      "handed-off": "Handed off to the updater.",
                                      "store-opened": "Opened the store listing."}.get(out.kind, out.kind)])
    except PolarisError as e:
        return _err(e, "update")
    return CommandResult(2, ["usage: update [check | download --to <path> | apply]"])


def _bar(ns: Dict[str, Any]) -> Callable[[int, int], None]:
    printer: Callable[[str], None] = ns.get("_progress") or (lambda s: print(s, end="", file=sys.stderr, flush=True))
    last = {"pct": -1}

    def on(done: int, total: int) -> None:
        pct = int(done * 100 / total) if total else 100
        if pct != last["pct"] and (pct % 5 == 0 or pct == 100):
            last["pct"] = pct
            filled = pct // 5
            printer(f"\r[{'#' * filled}{'.' * (20 - filled)}] {pct:3d}%" + ("\n" if pct == 100 else ""))

    return on


def changelog(client: Any, ns: Dict[str, Any]) -> CommandResult:
    try:
        entries = client.release.changelog()
    except PolarisError as e:
        return _err(e, "changelog")
    limit = ns.get("limit")
    if isinstance(limit, int) and limit > 0:
        entries = entries[:limit]
    lines = []
    for e in entries:
        lines.append(f"{e.version}{'  ' + e.date if e.date else ''}")
        if e.summary:
            lines.extend("  " + s for s in e.summary.splitlines())
    return CommandResult(0, lines or ["No releases."])


def packs(client: Any, ns: Dict[str, Any]) -> CommandResult:
    words = list(ns.get("words") or ["status"])
    p = client.update.packs
    if not p.configured:
        return CommandResult(1, ["This build has no content stamp (UpdateClientOptions.packs)."])
    try:
        if words[0] == "status":
            st = p.state()
            lines = [f"{pid}  {i.get('version')}  {i.get('type')}" for pid, i in sorted(st.active.items())]
            return CommandResult(0, lines or ["No packs installed."])
        if words[0] == "ensure" and len(words) >= 2:
            off = p.on(lambda e: _bar(ns)(e.done, e.total) if e.phase == "download" and e.total else None)
            try:
                done = p.ensure(words[1:])
            finally:
                off()
            return CommandResult(0, [f"{i['packId']} {i['version']} ready" for i in done])
    except PolarisError as e:
        return _err(e, "packs")
    return CommandResult(2, ["usage: packs [status | ensure <pack…>]"])


def boot(client: Any, ns: Dict[str, Any]) -> CommandResult:
    printer: Callable[[str], None] = ns.get("_print") or print

    def on_stage(state: Any, emits: Any) -> None:
        for e in emits:
            if e.get("type") == "stage_changed":
                printer(f"… {e['stage']}")
            elif e.get("type") == "fetch_progress":
                _bar(ns)(e["done"], e["total"])

    def answer(size: int, metered: bool) -> bool:
        if ns.get("yes"):
            return True
        if not sys.stdin.isatty():
            return False
        reply = input(f"Download {size / 1_000_000:.1f} MB of required content? [y/N] ")
        return reply.strip().lower() in ("y", "yes")

    out = client.boot(on_stage=on_stage, answer=answer, consent="never" if ns.get("yes") else "always")
    if out.ready:
        msg = "Ready."
        if out.update_available:
            msg += " An update is available (`update check`)."
        return CommandResult(0, [msg])
    if out.needs_activation:
        return CommandResult(1, [copy_message(out.status or "needs-activation")])
    code = out.error or next((e.get("reason") for e in out.emits if e.get("type") == "blocked"), None) or out.outcome
    return CommandResult(1, [f"Boot stopped ({out.outcome}): {copy_message(code)}"])


def offline_request(client: Any, ns: Dict[str, Any]) -> CommandResult:
    device = client.core.device_id
    lines = [
        "Send this request code to whoever issues your licence:",
        f"  Product: {client.product}",
        f"  Request code: {device}",
        "Then import the file you receive with `import-bundle <file>`.",
    ]
    if not ns.get("no_qr"):
        code = qr.terminal(device, ascii=bool(ns.get("ascii")))
        if code:
            lines.insert(3, code)
    return CommandResult(0, lines)


def doctor(client: Any, ns: Dict[str, Any]) -> CommandResult:
    from ..constants_generated import FEATURE_VALUES

    lines = [
        f"Product: {client.product}  version {client.core.version}  channel {client.core.channel}",
        f"Base URL: {client.core.base_url}",
        f"Device: {client.core.device_id}",
    ]
    d = client.try_discover() if not client.core.local_only else None
    lines.append(f"Discovery: {getattr(d, 'kind', 'skipped')}")
    on = [s for s, v in client.capabilities().items() if v.get("enabled")]
    lines.append(f"Services: {', '.join(on) or 'none'}")
    store = client.store_status()
    if store is not None:
        from .core import format_store_status

        lines.append(format_store_status(store))
    lines.append(f"Outlet: {client.outlet_id() or 'unknown'}")
    lines.append(f"Gate: {client.status().status}")
    lines.append("Supports:")
    for f in FEATURE_VALUES:
        s = client.supports(f)
        lines.append(f"  {f}: " + ("yes" if not isinstance(s, Unsupported) else f"no ({s.reason})"))
    return CommandResult(0, lines)


_COMMON_QR = (Opt("no-qr", "flag", "Do not draw the QR code."), Opt("ascii", "flag", "Draw the QR code with ASCII only."))

#: The new verbs. ``activate``, ``enroll``, ``deactivate``, ``status``, ``register`` and
#: ``import-bundle`` keep their own wiring in each front end.
VERBS: Tuple[Verb, ...] = (
    Verb("sign-in", "identity", "Sign in with a device code (QR in the terminal).", sign_in,
         opts=(Opt("browser", "flag", "Open the sign-in page in the system browser."),
               Opt("device-name", "str", "A name for this device on the account."),
               Opt("attach", "flag", "Offer to attach this device's free licence to the account."),
               *_COMMON_QR)),
    Verb("sign-out", "identity", "Sign out and wipe local credentials.", sign_out),
    Verb("devices", "devices", "list | rename <id> <label> | deauthorize <id>", devices, words=True),
    Verb("config", "config", "list | get <key> | set <key> <value> | reset <key>", config, words=True,
         opts=(Opt("fallback", "str", "Value if the key is unset (get)."),)),
    Verb("secret", "config", "Whether a managed secret is present (never printed).", secret, words=True),
    Verb("mint", "config", "Mint an edge token through a recipe (never printed).", mint, words=True),
    Verb("update", "update", "check | download --to <path> | apply", update, words=True,
         opts=(Opt("channel", "str", "The channel to check."), Opt("to", "str", "Where to download the build."))),
    Verb("changelog", "release", "The published releases, newest first.", changelog,
         opts=(Opt("limit", "int", "Show at most this many."),)),
    Verb("packs", "update", "status | ensure <pack…>", packs, words=True),
    Verb("boot", "core", "Run the one-call boot, one line per stage.", boot,
         opts=(Opt("yes", "flag", "Download required content without asking."),)),
    Verb("offline-request", "core", "The request code for an offline activation bundle.", offline_request,
         opts=_COMMON_QR),
    Verb("doctor", "core", "Diagnostics: discovery, services, store, outlet, supports().", doctor),
)

VERB_NAMES = tuple(v.name for v in VERBS)


def option_dest(name: str) -> str:
    return name.replace("-", "_")


def namespace(verb: Verb, words: Sequence[str], values: Dict[str, Any]) -> Dict[str, Any]:
    ns = {option_dest(o.name): values.get(option_dest(o.name), o.default) for o in verb.opts}
    ns["words"] = list(words or [])
    return ns
