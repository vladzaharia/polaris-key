"""The paywall ui-matrix family: Paywall and EntitlementGate.

A port of the shared state matrix (``conformance/corpus/v2/ui-matrix.json``, ``paywall``), after the
Swift ``KitStates.paywall``: the entitlement-gated upsell never invents checkout (UI-KITS §4.1 Must
not). With no offer to make it says so; where the platform has no in-app purchase it hands off to the
portal, and only when the host passes an https ``offers.url`` (DL14). An entitlement decides
alone: a style override is never authorization.
"""

from __future__ import annotations

from typing import Any, Mapping

from .ui_contract import Context
from .ui_loading import loading_visible
from .ui_view import View, hidden_view, identity_text, make_view, valid_link

__all__ = ["entitlement_gate_view", "paywall_view"]


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _tier(*sources: Mapping[str, Any]) -> Any:
    for source in sources:
        tier = source.get("tier")
        if isinstance(tier, str) and tier:
            return tier
    return None


def paywall_view(ctx: Context) -> View:
    """What a tier adds, and how to get it where this app can."""
    if not ctx.on("license"):
        return hidden_view(ctx, "Paywall")
    ident = identity_text(ctx)
    offers = _mapping(ctx.input.get("offers"))
    tier = _tier(offers, _mapping(ctx.input.get("entitlement")))
    args = {"product": ident.name, "tier": tier}
    pending = ctx.input.get("pending")
    if ctx.input.get("loading") is True or (not offers and pending not in ("purchase", "restore")):
        shown = ctx.input.get("loading") is not True or loading_visible(ctx.input.get("elapsedMs"))
        return make_view(ctx, "Paywall", "loading", ("common.loading",) if shown else (), args=args, focus=None)
    if pending == "purchase":
        return make_view(ctx, "Paywall", "purchasing", ("paywall.purchasing", "a11y.busy"), args=args, focus=None)
    if pending == "restore":
        return make_view(ctx, "Paywall", "restore", ("paywall.restore",), args=args, focus=None)
    if offers.get("purchased") is True:
        return make_view(ctx, "Paywall", "purchased", ("paywall.purchased", "common.done"), args=args, primary="common.done")
    if offers.get("available") is not True:
        portal = valid_link(offers.get("url")) is not None
        return make_view(
            ctx,
            "Paywall",
            "not-available",
            ("paywall.title", "paywall.notAvailable", "paywall.portal" if portal else None),
            args=args,
            primary="paywall.portal" if portal else None,
        )
    store = bool(ctx.caps["purchase"])
    features = offers.get("features")
    # "{tier} includes" introduces a list: without a tier and its features the line has nothing to
    # introduce, but the matrix keeps the key, so the renderer drops an open sentence (DL8).
    args = {**args, "features": list(features) if isinstance(features, (list, tuple)) else None}
    return make_view(
        ctx,
        "Paywall",
        "offers",
        ("paywall.title", "paywall.includes", "paywall.upgrade" if store else "paywall.portal", "paywall.redeem"),
        args=args,
        primary="paywall.upgrade" if store else "paywall.portal",
    )


def entitlement_gate_view(ctx: Context) -> View:
    """Children only when the entitlement holds; otherwise the slot or the Paywall."""
    entitlement = _mapping(ctx.input.get("entitlement"))
    args = {"tier": _tier(entitlement)}
    if ctx.input.get("loading") is True:
        shown = loading_visible(ctx.input.get("elapsedMs"))
        return make_view(ctx, "EntitlementGate", "loading", ("common.loading",) if shown else (), args=args, focus=None)
    if not ctx.on("license"):
        # No license document, so no entitlement holds; the Paywall Unlock opens is hidden too.
        return make_view(ctx, "EntitlementGate", "not-entitled", ("entitlement.locked",), args=args, focus=None)
    if entitlement.get("entitled") is True:
        return make_view(ctx, "EntitlementGate", "entitled", (), args=args, focus=None)
    return make_view(
        ctx,
        "EntitlementGate",
        "not-entitled",
        ("entitlement.locked", "entitlement.unlock"),
        args=args,
        primary="entitlement.unlock",
    )
