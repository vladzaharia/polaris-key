"""The ``LicenseChoice`` ui-matrix state family: step 3 of the sign-in form.

A port of the shared state matrix (``conformance/corpus/v2/ui-matrix.json``, ``signIn``), after the
Swift ``KitStates.licenseChoice``. The roster it reads (``choices``) is the pending sign-in grant's;
the Python SDK's device-code sign-in does not return one (the card chooses), so a Python kit reaches
this model only once the backend sends a roster (plans I-10b). Until then it is built and run against
the matrix and fixtures alone, and nothing in the runtime constructs its input.

Keep, create and add-to-account stay three outcomes (UI-KITS §4.1 Must not).
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence

from .ui_contract import Context
from .ui_loading import loading_visible
from .ui_view import View, hidden_view, identity_text, make_view, valid_link

__all__ = ["license_choice_view", "origin_key"]

_ORIGINS = {
    "signin": "signin.choice.origin.signIn",
    "store": "signin.choice.origin.store",
    "free": "signin.choice.origin.free",
    "developer": "signin.choice.origin.developer",
}


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def origin_key(choice: Mapping[str, Any]) -> str:
    """The origin line in plain words (SIGN-IN.md §3.6, O-17); a key or a purchase reads "Added with
    a key", since the roster carries no key's last six characters."""
    return _ORIGINS.get(str(choice.get("origin")), "signin.choice.origin.keyAdded")


def _full(choice: Mapping[str, Any]) -> bool:
    return choice.get("state") == "full"


def _replace_target(ctx: Context) -> Optional[str]:
    devices = [d for d in _mapping(ctx.input.get("replaceView")).get("devices", ()) if isinstance(d, Mapping)]
    if not devices:
        return None
    pick = next((d for d in devices if d.get("leastRecent")), None)
    if pick is None:
        pick = min(devices, key=lambda d: d.get("lastSeen") or 0)
    label = pick.get("label")
    return label if isinstance(label, str) else None


def license_choice_view(ctx: Context) -> View:
    """Choose the license this device uses."""
    if not (ctx.on("identity") and ctx.caps["signIn"] and ctx.on("license")):
        return hidden_view(ctx, "LicenseChoice")
    s = _mapping(ctx.input.get("signIn"))
    ident = identity_text(ctx)
    platform = _mapping(ctx.platform)
    args: Dict[str, Any] = {
        "product": ident.name,
        "developer": ident.developer,
        "formFactor": platform.get("formFactor") or "computer",
    }
    if ctx.input.get("loading") is True:
        shown = loading_visible(ctx.input.get("elapsedMs"))
        return make_view(
            ctx, "LicenseChoice", "loading", ("signin.choice.title", "common.loading") if shown else (), args=args, focus=None
        )
    if s.get("grantExpired") is True:
        return make_view(
            ctx, "LicenseChoice", "grant-expired", ("signin.handoff.tooLong", "signin.again"), args=args, primary="signin.again"
        )
    if s.get("raced") is True:
        key = "signin.replace.raced" if s.get("event") == "confirm-replace" else "signin.choice.raced"
        return make_view(
            ctx, "LicenseChoice", "raced", (key,), args=args, primary="signin.choice.continue" if _mapping(ctx.input.get("choices")).get("choices") else None, focus=None
        )
    if s.get("event") == "open-replace" and s.get("replace") == "inline" and ctx.input.get("replaceView"):
        return make_view(
            ctx,
            "LicenseChoice",
            "replace-open",
            (
                "signin.replace.open",
                "signin.replace.title",
                "signin.replace.consequence",
                "signin.replace.confirm",
                "signin.replace.back",
            ),
            args={**args, "device": _replace_target(ctx)},
            primary="signin.replace.confirm",
        )
    view = _mapping(ctx.input.get("choices"))
    if not view:
        return make_view(
            ctx, "LicenseChoice", "loading", ("signin.choice.title", "common.loading"), args=args, focus=None
        )
    get = _mapping(view.get("getLicense"))
    if view.get("state") == "none":
        if get.get("keyEntry") is True:
            return make_view(
                ctx,
                "LicenseChoice",
                "none-keys",
                ("signin.none.title", "signin.none.body", "signin.choice.keyInstead"),
                args=args,
            )
        purchase = valid_link(get.get("purchaseUrl")) is not None
        return make_view(
            ctx,
            "LicenseChoice",
            "none-no-keys",
            ("signin.none.title", "signin.none.body", "signin.none.get" if purchase else None, "signin.none.otherAccount"),
            args=args,
            primary="signin.none.get" if purchase else "signin.none.otherAccount",
        )
    if view.get("state") == "autoIssue":
        return make_view(
            ctx,
            "LicenseChoice",
            "new",
            ("signin.choice.ledeNew", "signin.choice.tag.new", "signin.choice.metaNew"),
            args=args,
            primary="signin.choice.continue",
        )
    choices: List[Mapping[str, Any]] = [
        c for c in (view.get("choices") or ()) if isinstance(c, Mapping)
    ] if isinstance(view.get("choices"), Sequence) else []
    extra = ["replace-in-browser"] if s.get("replace") == "browser" and s.get("event") == "open-replace" else []
    if ctx.input.get("selected") == "create" and view.get("create"):
        return make_view(
            ctx,
            "LicenseChoice",
            "create",
            ("signin.choice.create", "signin.choice.createMeta"),
            args=args,
            primary="signin.choice.continue",
        )
    if choices and all(_full(c) for c in choices):
        if view.get("create"):
            lead = "signin.choice.allFullCreate"
        elif all(not c.get("replace") for c in choices):
            lead = "signin.choice.noneReplaceable"
        else:
            lead = "signin.choice.allFull"
        return make_view(
            ctx, "LicenseChoice", "all-full", (lead, "signin.choice.tag.full"), args=args, extra_actions=extra
        )
    if view.get("keep") is True:
        return make_view(
            ctx,
            "LicenseChoice",
            "keep",
            ("signin.choice.keep", "signin.choice.keepMeta"),
            args=args,
            primary="signin.choice.continue",
        )
    if any(c.get("current") is True for c in choices):
        return make_view(
            ctx, "LicenseChoice", "current", ("signin.choice.tag.current",), args=args, primary="signin.choice.continue"
        )
    kinds = {c.get("access") for c in choices}
    if "account" in kinds and "seats" in kinds:
        # "Your other {product} items still apply" needs the entitlement model no SDK result carries
        # yet (vocabulary.unreached): the state shows no line of its own.
        return make_view(ctx, "LicenseChoice", "mixed", (), args=args, primary="signin.choice.continue")
    if len(choices) == 1:
        return make_view(
            ctx,
            "LicenseChoice",
            "one",
            ("signin.choice.title", "signin.choice.lede", "signin.choice.continue"),
            args=args,
            primary="signin.choice.continue",
        )
    origins = [origin_key(c) for c in choices]
    terms = ["signin.term.lifetime" if c.get("expiresAt") is None else "signin.term.until" for c in choices]
    return make_view(
        ctx,
        "LicenseChoice",
        "many",
        (
            "signin.choice.title",
            "signin.choice.lede",
            "signin.choice.group",
            "signin.choice.meta",
            "signin.choice.devices",
            "signin.choice.continue",
            *origins,
            *terms,
        ),
        args=args,
        primary="signin.choice.continue",
    )
