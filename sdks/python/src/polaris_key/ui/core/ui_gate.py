"""The ``gate`` ui-matrix family: gate, boot, status, grace and toast views."""

from __future__ import annotations

from typing import Any, Mapping, Optional, Tuple

from .ui_contract import Context
from .ui_loading import loading_visible
from .ui_view import View, hidden_view, identity_text, make_view

__all__ = [
    "BLOCKING_STATUSES",
    "boot_view",
    "gate_view",
    "grace_banner_view",
    "status_screen_view",
    "toast_view",
]

BLOCKING_STATUSES: Tuple[str, ...] = (
    "revoked",
    "expired",
    "version-too-old",
    "version-too-new",
    "channel-not-entitled",
)


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


# ── PolarisKeyGate ─────────────────────────────────────────────────────────────────────────────


def gate_view(ctx: Context) -> View:
    """The drop-in root: which screen the app needs before it may proceed."""
    gate = _mapping(ctx.input.get("gate"))
    stage = _mapping(ctx.input.get("stage"))
    status = gate.get("status")
    # License off, a healthy licence and no applicable licence all leave the app alone.
    if not ctx.on("license") or status in ("not-applicable", "ok"):
        return make_view(ctx, "PolarisKeyGate", "licensed", (), focus=None)
    if stage.get("outcome") == "error":
        return make_view(
            ctx,
            "PolarisKeyGate",
            "error",
            ("gate.error.title", "common.tryAgain"),
            primary="common.tryAgain",
            tone="danger",
            error_slot="screen",
        )
    # A cached state being rechecked remains booting: activation must never flash.
    if gate.get("checking") is True or status is None:
        return make_view(
            ctx,
            "PolarisKeyGate",
            "booting",
            ("gate.checking",) if loading_visible(ctx.input.get("elapsedMs")) else (),
            focus=None,
        )
    if status == "needs-activation":
        return make_view(
            ctx,
            "PolarisKeyGate",
            "needs-activation",
            ("core.gate.needs-activation.title", "core.gate.needs-activation.message"),
            focus=None,
        )
    if status == "grace":
        return make_view(
            ctx,
            "PolarisKeyGate",
            "grace",
            ("core.gate.grace.title", "core.gate.grace.message", "common.reconnect"),
            focus=None,
        )
    if status in BLOCKING_STATUSES:
        return make_view(
            ctx,
            "PolarisKeyGate",
            "blocked",
            ("part.status.blocked",),
            tone="neutral",
            focus=None,
        )
    return make_view(
        ctx,
        "PolarisKeyGate",
        "error",
        ("gate.error.title", "common.tryAgain"),
        primary="common.tryAgain",
        tone="danger",
        error_slot="screen",
    )


# ── Boot ──────────────────────────────────────────────────────────────────────────────────────

_STAGE_LABEL = {
    "idle": "boot.starting",
    "shell": "boot.starting",
    "guard": "boot.starting",
    "sync": "boot.syncing",
    "gate": "gate.checking",
    "decide": "boot.deciding",
    "mount": "common.loading",
    "background": "common.loading",
}


def boot_view(ctx: Context) -> View:
    """Map the stage machine's honest progress/no-progress states to Boot."""
    stage = _mapping(ctx.input.get("stage"))
    emit = _mapping(stage.get("emit"))
    outcome = stage.get("outcome") or "running"
    product = identity_text(ctx).name
    if emit.get("type") == "boot_rolled_back":
        return make_view(
            ctx,
            "Boot",
            "rolled-back",
            ("boot.rolledBack",),
            args={"product": product},
            focus=None,
        )
    if outcome == "error":
        return make_view(
            ctx,
            "Boot",
            "error",
            ("gate.error.title", "boot.error.body", "common.tryAgain"),
            primary="common.tryAgain",
            tone="danger",
            error_slot="screen",
        )
    if outcome == "blocked":
        if emit.get("reason") == "content-declined":
            return make_view(
                ctx,
                "Boot",
                "declined",
                ("boot.declined.title", "boot.declined.body", "common.tryAgain"),
                primary="common.tryAgain",
                tone="neutral",
            )
        return make_view(
            ctx,
            "Boot",
            "blocked",
            (
                "core.gate.version-too-old.title",
                "core.gate.version-too-old.message",
                "status.update",
            ),
            primary="status.update",
            tone="neutral",
        )
    if outcome == "offline":
        playable = emit.get("canPlayOffline") is True
        return make_view(
            ctx,
            "Boot",
            "offline",
            (
                "boot.offline.title",
                "boot.offline.playable" if playable else "boot.offline.body",
                "boot.continueOffline" if playable else None,
                "common.tryAgain",
            ),
            args={"product": product},
            primary="boot.continueOffline" if playable else "common.tryAgain",
        )
    if outcome == "waiting" and emit.get("type") == "consent_needed":
        metered = emit.get("metered") is True
        return make_view(
            ctx,
            "Boot",
            "consent",
            (
                "boot.consent.title",
                "boot.consent.bodyMetered" if metered else "boot.consent.body",
                "boot.consent.download",
                "common.notNow",
            ),
            args={"size": emit.get("bytes") if isinstance(emit.get("bytes"), (int, float)) else None},
            primary="boot.consent.download",
        )
    if outcome == "ready":
        return make_view(ctx, "Boot", "progress", ("boot.ready",), focus=None)
    if stage.get("stage") == "fetch":
        counted = emit.get("type") == "fetch_progress"
        return make_view(
            ctx,
            "Boot",
            "fetching",
            ("boot.fetchingProgress", "a11y.progress") if counted else ("boot.fetching",),
            args={"done": emit.get("done"), "total": emit.get("total")} if counted else {},
            focus=None,
        )
    return make_view(
        ctx,
        "Boot",
        "progress",
        (_STAGE_LABEL.get(stage.get("stage"), "common.loading"), "a11y.busy"),
        focus=None,
    )


# ── StatusScreen ──────────────────────────────────────────────────────────────────────────────


def status_screen_view(ctx: Context) -> View:
    """A distinct resolvable blocking state, never a collapsed generic error."""
    gate = _mapping(ctx.input.get("gate"))
    status = gate.get("status")
    if not ctx.on("license") or status not in BLOCKING_STATUSES:
        return hidden_view(ctx, "StatusScreen")
    allowed = _mapping(gate.get("allowed"))
    minimum = allowed.get("min") if isinstance(allowed.get("min"), str) else None
    maximum = allowed.get("max") if isinstance(allowed.get("max"), str) else None
    range_key: Optional[str]
    if minimum is not None and maximum is not None:
        range_key = "status.allowedRange"
    elif minimum is not None:
        range_key = "status.allowedMin"
    elif maximum is not None:
        range_key = "status.allowedMax"
    else:
        range_key = None
    identity = identity_text(ctx)
    head = ("core.gate.%s.title" % status, "core.gate.%s.message" % status)
    args = {"product": identity.name, "developer": identity.developer, "min": minimum, "max": maximum}
    if status == "revoked":
        # Sign in first when the build offers it (Welcome's rule), then Use a different key when
        # key entry is on; a device already signed out is never offered Sign out.
        sign_in = bool(ctx.caps["signIn"] and ctx.on("identity"))
        key = bool(ctx.caps["keyEntry"])
        return make_view(
            ctx,
            "StatusScreen",
            status,
            head + ("welcome.signIn" if sign_in else None, "signin.key.differentKey" if key else None),
            args=args,
            primary="welcome.signIn" if sign_in else ("signin.key.differentKey" if key else None),
            tone="neutral",
        )
    if status == "expired":
        return make_view(
            ctx,
            "StatusScreen",
            status,
            head + ("status.renew", "status.useAnotherLicense"),
            args=args,
            primary="status.renew",
            tone="neutral",
        )
    if status == "version-too-old":
        return make_view(
            ctx,
            "StatusScreen",
            status,
            head + (range_key, "status.update"),
            args=args,
            primary="status.update",
            tone="neutral",
        )
    if status == "version-too-new":
        return make_view(
            ctx,
            "StatusScreen",
            status,
            head + (None if range_key == "status.allowedMin" else range_key, "common.tryAgain"),
            args=args,
            primary="common.tryAgain",
            tone="neutral",
        )
    return make_view(
        ctx,
        "StatusScreen",
        status,
        head + ("status.switchChannel", "status.contact"),
        args=args,
        primary="status.switchChannel",
        tone="neutral",
    )


# ── GraceBanner and Toast ─────────────────────────────────────────────────────────────────────


def grace_banner_view(ctx: Context) -> View:
    """Offline grace without inventing an extra day."""
    if not ctx.on("license"):
        return hidden_view(ctx, "GraceBanner")
    gate = _mapping(ctx.input.get("gate"))
    status = gate.get("status")
    if status == "expired":
        return make_view(
            ctx,
            "GraceBanner",
            "expired",
            ("core.gate.expired.title", "core.gate.expired.message"),
            tone="neutral",
            focus=None,
        )
    if status != "grace":
        return hidden_view(ctx, "GraceBanner")
    days = gate.get("graceDaysLeft")
    if isinstance(days, (int, float)) and not isinstance(days, bool) and days <= 1:
        return make_view(
            ctx,
            "GraceBanner",
            "last-day",
            ("grace.lastDay", "common.reconnect"),
            primary="common.reconnect",
            focus=None,
        )
    return make_view(
        ctx,
        "GraceBanner",
        "days-left",
        ("grace.daysLeft", "grace.deadline", "common.reconnect", "common.dismiss"),
        args={"days": days},
        primary="common.reconnect",
        focus=None,
    )


def toast_view(ctx: Context) -> View:
    """A transient consequence, never the only record of an error."""
    toast = _mapping(ctx.input.get("toast"))
    kind = toast.get("kind")
    update = _mapping(ctx.input.get("update"))
    error = _mapping(ctx.input.get("error"))
    if kind == "update":
        if not ctx.on("update"):
            return hidden_view(ctx, "Toast")
        return make_view(
            ctx,
            "Toast",
            "info",
            ("toast.updateAvailable", "common.dismiss", "a11y.toastTimer"),
            args={"version": update.get("version")},
            focus=None,
        )
    if kind == "signedIn":
        # After a sign-in the gate ran: "Signed in as Ada · Pro license" (UI-KITS 1198-1200, D-63..D-65);
        # without a tier, "Signed in as Ada". Not in the ui-matrix: a kit that shows it says so.
        name, tier = toast.get("name"), toast.get("tier")
        if not isinstance(name, str) or not name:
            return hidden_view(ctx, "Toast")
        if isinstance(tier, str) and tier:
            return make_view(
                ctx, "Toast", "success", ("signin.desktop.toast", "common.dismiss", "a11y.toastTimer"),
                args={"name": name, "tier": tier}, focus=None,
            )
        return make_view(
            ctx, "Toast", "success", ("account.holder", "common.dismiss", "a11y.toastTimer"),
            args={"name": name}, focus=None,
        )
    if kind == "copied":
        return make_view(ctx, "Toast", "success", ("common.copied",), focus=None)
    if kind == "warning":
        return make_view(ctx, "Toast", "warning", ("common.dismiss",), focus=None)
    if kind == "error":
        code = error.get("code")
        copy = (
            "core.codes.%s.title" % code,
            "core.codes.%s.message" % code,
        ) if isinstance(code, str) and code else ("core.fallback.title", "core.fallback.message")
        return make_view(
            ctx,
            "Toast",
            "error",
            copy + ("common.dismiss",),
            tone="danger",
            focus=None,
        )
    if kind == "progress":
        return make_view(
            ctx,
            "Toast",
            "with-progress",
            ("updateProgress.downloading", "toast.undo"),
            args={"fraction": _mapping(update.get("progress")).get("fraction")},
            focus=None,
        )
    return hidden_view(ctx, "Toast")
