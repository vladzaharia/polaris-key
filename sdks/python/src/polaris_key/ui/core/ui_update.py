"""The ``update`` ui-matrix family: prompts, progress and release notes."""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from .ui_contract import Context
from .ui_loading import loading_visible
from .ui_view import View, hidden_view, identity_text, make_view

__all__ = ["release_notes_view", "update_progress_view", "update_prompt_view"]

_STORE_VERB = {
    "app-store": "update.appStore",
    "play": "update.googlePlay",
    "play-testing": "update.googlePlay",
    "testflight": "update.testflight",
    "altstore": "update.altstore",
    "altstore-pal": "update.altstore",
    "steam": "update.steam",
}
_PLATFORM_BODY = {
    "steam": "update.platform.steam",
    "itch": "update.platform.itch",
    "flathub": "update.platform.store",
    "snap": "update.platform.store",
    "ms-store": "update.platform.store",
    "app-installer": "update.platform.appInstaller",
    "winget": "update.platform.command",
    "fdroid-repo": "update.platform.package",
    "web": "update.platform.web",
}


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _sequence(value: Any) -> Sequence[Any]:
    return value if isinstance(value, Sequence) and not isinstance(value, (str, bytes)) else ()


def update_prompt_view(ctx: Context) -> View:
    """An outlet-correct update prompt which never offers an impossible browser restart."""
    raw = ctx.input.get("update")
    if not ctx.on("update") or raw is None:
        return hidden_view(ctx, "UpdatePrompt")
    update = _mapping(raw)
    identity = identity_text(ctx)
    args = {"product": identity.name, "version": update.get("version")}
    action = update.get("action")
    progress = _mapping(update.get("progress"))
    phase = progress.get("phase")
    if action == "binary" and phase in ("download", "verify"):
        return make_view(
            ctx,
            "UpdatePrompt",
            "downloading",
            ("update.downloading", "update.timeLeft", "a11y.progress", "update.restartWhenReady", "update.later"),
            args={**args, "fraction": progress.get("fraction")},
            primary="update.restartWhenReady",
        )
    if action == "binary":
        if update.get("mandatory") is True:
            return make_view(
                ctx,
                "UpdatePrompt",
                "mandatory",
                ("update.mandatoryTitle", "update.mandatoryBody", "update.install"),
                args=args,
                primary="update.install",
            )
        if update.get("version"):
            copy = (
                "update.title",
                "update.current",
                "update.critical" if update.get("critical") is True else None,
                "update.whatsNew",
                "update.allChanges",
                "update.install",
                "update.restartWhenReady",
                "update.later",
                "update.skipVersion",
            )
        else:
            copy = (
                "update.availableTitle",
                "update.install",
                "update.restartWhenReady",
                "update.later",
                "update.skipVersion",
            )
        return make_view(ctx, "UpdatePrompt", "available", copy, args=args, primary="update.install")
    if action == "code-ready":
        return make_view(
            ctx,
            "UpdatePrompt",
            "ready",
            ("update.readyTitle", "update.readyBody", "update.restartNow", "update.later"),
            args=args,
            primary="update.restartNow",
        )
    if action == "blocked":
        if update.get("reason") == "revoked-content":
            return make_view(
                ctx,
                "UpdatePrompt",
                "revoked-required-content",
                ("core.codes.pack-revoked.title", "update.revokedContent", "update.install"),
                args=args,
                primary="update.install",
                tone="neutral",
            )
        return make_view(
            ctx,
            "UpdatePrompt",
            "blocked",
            ("update.blockedTitle", "update.blockedBody"),
            args=args,
            tone="neutral",
        )
    if action == "store":
        outlet = update.get("outlet")
        verb = _STORE_VERB.get(outlet, "update.openStore")
        return make_view(ctx, "UpdatePrompt", "store", (verb,), args=args, primary=verb)
    if action == "platform":
        outlet = update.get("outlet")
        return make_view(
            ctx,
            "UpdatePrompt",
            "platform",
            ("update.availableTitle", _PLATFORM_BODY.get(outlet, "update.platform.generic")),
            args=args,
        )
    if action == "none":
        return make_view(
            ctx,
            "UpdatePrompt",
            "up-to-date",
            ("update.upToDate", "update.checkNow"),
            args=args,
        )
    return hidden_view(ctx, "UpdatePrompt")


def update_progress_view(ctx: Context) -> View:
    """The compact progress state; verify remains part of downloading until apply starts."""
    raw = ctx.input.get("update")
    if not ctx.on("update") or raw is None:
        return hidden_view(ctx, "UpdateProgress")
    update = _mapping(raw)
    progress = _mapping(update.get("progress"))
    if not progress:
        return hidden_view(ctx, "UpdateProgress")
    phase = progress.get("phase")
    args = {"fraction": progress.get("fraction")}
    if phase == "queued":
        return make_view(
            ctx,
            "UpdateProgress",
            "queued",
            ("updateProgress.contentTitle" if update.get("action") == "packs" else None, "updateProgress.queued"),
            args=args,
            focus=None,
        )
    if phase in ("download", "verify"):
        return make_view(
            ctx,
            "UpdateProgress",
            "downloading",
            ("updateProgress.downloading", "a11y.progress"),
            args=args,
            focus=None,
        )
    if phase == "install":
        return make_view(
            ctx,
            "UpdateProgress",
            "installing",
            ("updateProgress.installing", "update.verifying"),
            args=args,
            focus=None,
        )
    if phase == "paused":
        return make_view(
            ctx,
            "UpdateProgress",
            "paused",
            ("updateProgress.paused", "updateProgress.resume"),
            args=args,
            primary="updateProgress.resume",
            focus=None,
        )
    if phase == "failed":
        return make_view(
            ctx,
            "UpdateProgress",
            "failed",
            ("updateProgress.failed", "common.tryAgain"),
            args=args,
            primary="common.tryAgain",
            tone="danger",
            error_slot="updateProgress.failed",
            focus=None,
        )
    if phase == "done":
        return make_view(ctx, "UpdateProgress", "done", ("updateProgress.done",), args=args, focus=None)
    return hidden_view(ctx, "UpdateProgress")


def release_notes_view(ctx: Context) -> View:
    """Plain-text release notes: remote markup never becomes executable kit content."""
    if not ctx.on("release"):
        return hidden_view(ctx, "ReleaseNotes")
    if ctx.input.get("loading") is True:
        return make_view(
            ctx,
            "ReleaseNotes",
            "loading",
            ("releaseNotes.title", "common.loading") if loading_visible(ctx.input.get("elapsedMs")) else (),
            focus=None,
        )
    if _mapping(ctx.input.get("error")):
        return make_view(
            ctx,
            "ReleaseNotes",
            "error",
            ("releaseNotes.error", "common.tryAgain"),
            primary="common.tryAgain",
            tone="danger",
            error_slot="screen",
        )
    notes = _sequence(ctx.input.get("releaseNotes"))
    if not notes:
        return make_view(ctx, "ReleaseNotes", "empty", ("releaseNotes.empty",))
    return make_view(
        ctx,
        "ReleaseNotes",
        "list",
        ("releaseNotes.title", "releaseNotes.version", "releaseNotes.released"),
    )
