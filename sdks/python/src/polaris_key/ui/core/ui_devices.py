"""The ``deviceLimit`` and ``devices`` ui-matrix families."""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from .ui_contract import Context, platform_class
from .ui_loading import loading_visible
from .ui_view import View, hidden_view, identity_text, link_verdict, make_view

__all__ = ["device_limit_view", "devices_view", "least_recent"]


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _rows(value: Any) -> Sequence[Mapping[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    return tuple(item for item in value if isinstance(item, Mapping))


def least_recent(devices: Sequence[Mapping[str, Any]]) -> Optional[Mapping[str, Any]]:
    """The oldest non-current row, preselected for replace."""
    picked: Optional[Mapping[str, Any]] = None
    for device in devices:
        if device.get("current") is True:
            continue
        days = device.get("lastSeenDays")
        value = days if isinstance(days, (int, float)) and not isinstance(days, bool) else -1
        if picked is None:
            picked = device
            continue
        previous = picked.get("lastSeenDays")
        old = previous if isinstance(previous, (int, float)) and not isinstance(previous, bool) else -1
        if value > old:
            picked = device
    return picked


def device_limit_view(ctx: Context) -> View:
    """Replace-a-device on a key refusal, without ever deleting this device's files."""
    if not ctx.on("license"):
        return hidden_view(ctx, "DeviceLimit")
    activation = _mapping(ctx.input.get("activation"))
    product = identity_text(ctx).name
    args = {
        "product": product,
        "used": activation.get("deviceCount"),
        "limit": activation.get("limit"),
    }
    replacement = _mapping(ctx.input.get("replacement"))
    if replacement.get("outcome") == "done":
        return make_view(
            ctx,
            "DeviceLimit",
            "removed",
            ("deviceLimit.removed",),
            args={**args, "device": replacement.get("device")},
        )
    if replacement.get("outcome") == "failed":
        return make_view(
            ctx,
            "DeviceLimit",
            "failed",
            ("deviceLimit.failed", "common.tryAgain"),
            args={**args, "device": replacement.get("device")},
            primary="common.tryAgain",
            tone="danger",
            error_slot="deviceLimit.primary",
        )
    if ctx.input.get("pending") == "replace":
        return make_view(
            ctx,
            "DeviceLimit",
            "busy",
            ("deviceLimit.primary", "common.working", "a11y.busy"),
            args=args,
            primary="deviceLimit.primary",
        )
    raw_devices = ctx.input.get("devices")
    devices = _rows(raw_devices)
    link = link_verdict(activation.get("manageUrl"), ctx.platform, "replace-device")
    # Layer 1 has no key-authenticated roster.  Browser mode has the only allowed replacement.
    if link.url is not None and raw_devices is None:
        tv = platform_class(ctx.platform) in ("tv", "console")
        return make_view(
            ctx,
            "DeviceLimit",
            "browser-mode",
            (
                "deviceLimit.title",
                "deviceLimit.browser",
                "deviceLimit.scan" if tv else "deviceLimit.openBrowser",
                "a11y.qr" if tv else "a11y.externalLink",
            ),
            args=args,
            primary=None if tv else "deviceLimit.openBrowser",
            tone="neutral",
            link=link,
        )
    picked = least_recent(devices)
    known_limit = activation.get("limit") is not None
    return make_view(
        ctx,
        "DeviceLimit",
        "default",
        (
            "deviceLimit.title",
            "deviceLimit.heading",
            "deviceLimit.lede",
            "part.seatMeter.caption" if known_limit else None,
            "a11y.seatMeter" if known_limit else None,
            "signin.replace.meta" if devices else None,
            "a11y.formFactor" if devices else None,
            "signin.replace.leastRecent" if picked is not None else None,
            "deviceLimit.confirmTitle" if picked is not None else None,
            "deviceLimit.consequence" if picked is not None else None,
            "deviceLimit.primary",
            "common.back",
        ),
        args={**args, "device": picked.get("name") if picked is not None else None},
        primary="deviceLimit.primary",
        tone="neutral",
    )


def devices_view(ctx: Context) -> View:
    """The device list, with inline rename/remove and a real failed-load state."""
    if not ctx.on("license"):
        return hidden_view(ctx, "Devices")
    raw_devices = ctx.input.get("devices")
    devices = _rows(raw_devices)
    edit = _mapping(ctx.input.get("edit"))
    error = _mapping(ctx.input.get("error"))
    if ctx.input.get("loading") is True:
        return make_view(
            ctx,
            "Devices",
            "loading",
            ("devices.title", "common.loading") if loading_visible(ctx.input.get("elapsedMs")) else (),
            focus=None,
        )
    if error:
        kind = edit.get("kind")
        if kind == "rename":
            key, slot = "devices.renameFailed", "devices.renameLabel"
        elif kind == "remove":
            key, slot = "devices.removeFailed", "devices.remove"
        else:
            key, slot = "devices.loadFailed", "screen"
        return make_view(
            ctx,
            "Devices",
            "error",
            (key, "common.tryAgain"),
            args={"device": edit.get("device")},
            primary="common.tryAgain",
            tone="danger",
            error_slot=slot,
        )
    if ctx.input.get("browserMode") is True:
        return make_view(
            ctx,
            "Devices",
            "browser-mode",
            ("devices.browser", "devices.manage", "a11y.externalLink"),
            primary="devices.manage",
        )
    if edit.get("kind") == "rename":
        return make_view(
            ctx,
            "Devices",
            "renaming",
            ("devices.renameLabel", "common.save", "common.cancel"),
            args={"device": edit.get("device")},
            primary="common.save",
            focus="devices.renameLabel",
        )
    if edit.get("kind") == "remove":
        return make_view(
            ctx,
            "Devices",
            "confirming",
            ("devices.removeConfirm", "devices.remove", "common.cancel"),
            args={"device": edit.get("device")},
            primary="devices.remove",
        )
    if not devices:
        return make_view(ctx, "Devices", "empty", ("devices.empty",))
    return make_view(
        ctx,
        "Devices",
        "list",
        (
            "devices.title",
            "devices.lede",
            "devices.count",
            "devices.meta",
            "a11y.formFactor",
            "devices.rename",
            "devices.remove",
            "a11y.renameDevice",
            "a11y.removeDevice",
            "part.thisDeviceTitle" if any(row.get("current") is True for row in devices) else None,
            "devices.unnamed" if any(not row.get("name") for row in devices) else None,
        ),
        args={"count": len(devices)},
    )
