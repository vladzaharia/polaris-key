"""The settings ui-matrix family: AccountAndLicense and Settings."""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from .ui_contract import Context
from .ui_loading import loading_visible
from .ui_view import View, hidden_view, identity_text, make_view

__all__ = ["SETTINGS_SEARCH_ABOVE", "account_view", "settings_view"]

SETTINGS_SEARCH_ABOVE = 12
_SOURCES = frozenset(("default", "local", "env"))


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _rows(value: Any) -> Sequence[Mapping[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    return tuple(row for row in value if isinstance(row, Mapping))


def account_view(ctx: Context) -> View:
    """The account/license pane, never silently attaching a floating key."""
    identity = identity_text(ctx)
    args = {"product": identity.name, "developer": identity.developer}
    if ctx.input.get("loading") is True:
        return make_view(
            ctx,
            "AccountAndLicense",
            "loading",
            ("account.title", "common.loading") if loading_visible(ctx.input.get("elapsedMs")) else (),
            args=args,
            focus=None,
        )
    gate = _mapping(ctx.input.get("gate"))
    if ctx.on("license") and gate.get("status") == "grace":
        return make_view(
            ctx,
            "AccountAndLicense",
            "offline",
            ("account.offline", "part.status.grace"),
            args=args,
        )
    account = _mapping(ctx.input.get("account"))
    license_on = ctx.on("license")
    update_on = ctx.on("update")
    if not ctx.on("identity") or account.get("signedIn") is not True:
        return make_view(
            ctx,
            "AccountAndLicense",
            "key-only",
            (
                "account.title",
                "account.tier" if license_on else None,
                "account.keyOnly" if license_on else None,
                "account.updates" if update_on else None,
                "common.signOut",
            ),
            args=args,
        )
    integrator = _mapping(ctx.input.get("integrator"))
    return make_view(
        ctx,
        "AccountAndLicense",
        "signed-in",
        (
            "account.title",
            "account.tier" if license_on else None,
            "account.holder",
            "common.manage",
            "a11y.externalLink",
            "account.devices" if license_on else None,
            "account.cloudSync" if ctx.on("sync") else None,
            "account.updates" if update_on else None,
            "account.autoUpdate" if update_on else None,
            "account.channel" if update_on else None,
            "update.checkNow" if update_on else None,
            "account.version",
            "account.managedSettings" if ctx.on("config") else None,
            "common.signOut",
            "part.poweredBy" if "poweredBy" in integrator else None,
        ),
        args=args,
    )


def settings_view(ctx: Context) -> View:
    """Config-catalog rows with their real provenance and locked-state wording."""
    if not ctx.on("config"):
        return hidden_view(ctx, "Settings")
    rows = _rows(ctx.input.get("config"))
    edit = _mapping(ctx.input.get("edit"))
    error = _mapping(ctx.input.get("error"))
    identity = identity_text(ctx)
    args = {"developer": identity.developer or identity.name}
    if ctx.input.get("loading") is True:
        return make_view(
            ctx,
            "Settings",
            "loading",
            ("settings.title", "common.loading") if loading_visible(ctx.input.get("elapsedMs")) else (),
            args=args,
            focus=None,
        )
    if error:
        save = edit.get("kind") == "value"
        return make_view(
            ctx,
            "Settings",
            "error",
            ("settings.error" if save else "settings.loadFailed", "common.tryAgain"),
            args=args,
            primary="common.tryAgain",
            tone="danger",
            error_slot="common.save" if save else "screen",
        )
    if ctx.input.get("pending") == "save" or ctx.input.get("saved") is True:
        saving = ctx.input.get("pending") == "save"
        return make_view(
            ctx,
            "Settings",
            "saving",
            ("settings.saving" if saving else "settings.saved",),
            args=args,
            primary="common.save",
            focus=None if not saving else None,
        )
    if edit.get("kind") == "value":
        return make_view(
            ctx,
            "Settings",
            "dirty",
            ("settings.unsaved", "common.save"),
            args=args,
            primary="common.save",
            focus=None,
        )
    locked = next((row for row in rows if row.get("locked") is True), None)
    if locked is not None:
        org = locked.get("org") if isinstance(locked.get("org"), str) else None
        return make_view(
            ctx,
            "Settings",
            "locked",
            ("settings.setBy" if org else "settings.setByGuardian", "a11y.locked"),
            args={**args, "org": org},
        )
    if not rows:
        return make_view(ctx, "Settings", "list", ("settings.title", "settings.empty"), args=args)
    source_keys = tuple(
        "settings.source.%s" % row.get("source")
        for row in rows
        if row.get("source") in _SOURCES
    )
    has_boolean = any(row.get("type") == "boolean" for row in rows)
    has_range = any(
        row.get("type") == "number" and row.get("min") is not None and row.get("max") is not None
        for row in rows
    )
    return make_view(
        ctx,
        "Settings",
        "list",
        (
            "settings.title",
            "settings.search" if len(rows) > SETTINGS_SEARCH_ABOVE else None,
            "settings.fromDeveloper" if any(row.get("source") == "default" for row in rows) else None,
            *source_keys,
            "settings.reset" if any(row.get("source") == "local" for row in rows) else None,
            "settings.advanced" if any(row.get("advanced") is True for row in rows) else None,
            "settings.range" if has_range else None,
            "settings.on" if has_boolean else None,
            "settings.off" if has_boolean else None,
        ),
        args=args,
    )
