"""The ``activate`` ui-matrix family: Welcome, Activate and OfflineActivation."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from .ui_contract import Context
from .ui_view import View, hidden_view, identity_text, link_verdict, make_view

__all__ = [
    "KEY_SECRET_LENGTH",
    "KeyParse",
    "activate_view",
    "activation_copy",
    "offline_activation_view",
    "parse_key",
    "welcome_view",
]

KEY_SECRET_LENGTH = 22
_KEY_PREFIX = "pkey_"
_KEY_SHAPE = re.compile(r"^pkey_([a-z0-9-]+)_([A-Za-z0-9_-]*)$")
_PREFIX_SHAPE = re.compile(r"^pkey_[a-z0-9-]*$")
_FIELD = "part.keyField.label"
_SUBMIT = "activate.submit"
# The results that mean the input itself is wrong (DL7): a key the service does not know, or a check
# that failed. Every other refusal of a well-formed key is a neutral callout (DL6).
_WRONG_KEY = frozenset(("unauthorized", "error"))
# What every field-state screen carries: its heading, lede and the key field (ui-matrix v4).
_BASE = ("activate.title", "activate.lede", _FIELD, "part.keyField.placeholder", "common.paste")


def _message_only(lines):
    """The refusal's lines less its title: the screen's own heading is already in the base."""
    return tuple(k for k in lines if not k.endswith(".title"))
_ACTIVATION_KINDS = frozenset(
    (
        "ok",
        "device-limit",
        "fingerprint-required",
        "hardware-mismatch",
        "enroll-claimed",
        "license-disabled",
        "license-expired",
        "attestation-required",
        "rate-limited",
        "unauthorized",
        "enroll-disabled",
        "key-entry-limit",
        "refused",
        "error",
    )
)
_CODE_KIND = {"key_entry_limit": "key-entry-limit", "device_limit": "device-limit"}


@dataclass(frozen=True)
class KeyParse:
    """The public verdict of a license-key field, never the secret itself."""

    kind: str
    slug: Optional[str]
    prefix: Optional[str]
    used: Optional[int]
    limit: int = KEY_SECRET_LENGTH


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def activation_copy(result: Any, code: Any = None) -> tuple:
    """The core catalog pair for a key activation result."""
    if result in ("refused", "error") and isinstance(code, str) and code:
        kind = _CODE_KIND.get(code)
        if kind:
            return ("core.activation.%s.title" % kind, "core.activation.%s.message" % kind)
        return ("core.codes.%s.title" % code, "core.codes.%s.message" % code)
    if isinstance(result, str) and result in _ACTIVATION_KINDS:
        return ("core.activation.%s.title" % result, "core.activation.%s.message" % result)
    return ("core.fallback.title", "core.fallback.message")


def parse_key(text: Any, submitted: bool = False) -> KeyParse:
    """Parse the public shape of a key while keeping its body out of all view data."""
    key = text.strip() if isinstance(text, str) else ""
    if key == "":
        return KeyParse("empty", None, None, None)
    if not key.startswith(_KEY_PREFIX):
        return KeyParse("typing" if _KEY_PREFIX.startswith(key) and not submitted else "malformed", None, None, None)
    match = _KEY_SHAPE.match(key)
    if match is None:
        return KeyParse("typing" if _PREFIX_SHAPE.match(key) and not submitted else "malformed", None, None, None)
    slug, body = match.groups()
    used = len(body)
    if used == KEY_SECRET_LENGTH:
        kind = "parsed"
    elif used > KEY_SECRET_LENGTH:
        kind = "malformed"
    elif submitted:
        kind = "short"
    else:
        kind = "typing"
    return KeyParse(kind, slug, _KEY_PREFIX + slug + "_", used)


def welcome_view(ctx: Context) -> View:
    """The product-first gate chooser and only the paths this build can offer."""
    sign_in = ctx.caps["signIn"] and ctx.on("identity")
    key = ctx.caps["keyEntry"] and ctx.on("license")
    if not ctx.on("license") and ctx.registration == "open":
        return hidden_view(ctx, "Welcome")
    identity = identity_text(ctx)
    args = {"product": identity.name, "developer": identity.developer}
    # No name anywhere: a neutral "Welcome", never "Welcome to" with nothing after it.
    nameless = identity.name == ""
    title = "common.welcomeNoProductTitle" if nameless else "welcome.title"
    sign_in_only_lede = "common.signInToContinue" if nameless else "welcome.ledeSignInOnly"
    primary = "welcome.signIn" if sign_in else "welcome.useKey" if key else None
    if ctx.input.get("pending") is not None:
        return make_view(
            ctx,
            "Welcome",
            "busy",
            (title, "common.working", "a11y.busy"),
            args=args,
            primary=primary,
        )
    if not sign_in or not key:
        return make_view(
            ctx,
            "Welcome",
            "capability-limited",
            (
                title,
                sign_in_only_lede if sign_in else "welcome.ledeKeyOnly",
            ),
            args=args,
            primary=primary,
        )
    return make_view(
        ctx,
        "Welcome",
        "default",
        (
            "a11y.productIcon",
            title,
            "common.byDeveloper" if identity.developer is not None else None,
            "welcome.lede",
            "welcome.signIn",
            "welcome.useKey",
            "welcome.trial" if ctx.caps["trial"] else None,
            "welcome.continueFree" if ctx.caps["enroll"] else None,
            "welcome.restore" if ctx.caps["restore"] else None,
            "welcome.offline" if ctx.caps["offlineActivation"] else None,
        ),
        args=args,
        primary=primary,
    )


def activate_view(ctx: Context) -> View:
    """License-key entry with a live public verdict and a neutral full-seat outcome."""
    if not ctx.on("license"):
        return hidden_view(ctx, "Activate")
    key_field = _mapping(ctx.input.get("keyField"))
    activation = _mapping(ctx.input.get("activation"))
    product = identity_text(ctx).name
    if ctx.input.get("pending") == "activate":
        return make_view(
            ctx,
            "Activate",
            "busy",
            _BASE + ("activate.busy", "a11y.busy"),
            primary=_SUBMIT,
        )
    if activation:
        result = activation.get("result")
        if result == "ok":
            return make_view(
                ctx,
                "Activate",
                "done",
                ("core.activation.ok.title", "core.activation.ok.message", "part.keyField.verdict"),
                args={"product": product},
            )
        if result == "device-limit":
            link = link_verdict(activation.get("manageUrl"), ctx.platform, "replace-device")
            known = isinstance(activation.get("limit"), int) and not isinstance(activation.get("limit"), bool)
            return make_view(
                ctx,
                "Activate",
                "device-limit",
                (
                    "core.activation.device-limit.title",
                    "core.activation.device-limit.message",
                    "deviceLimit.title",
                    "part.seatMeter.caption" if known else None,
                    "deviceLimit.noManage" if link.url is None else None,
                ),
                args={
                    "product": product,
                    "used": activation.get("deviceCount"),
                    "limit": activation.get("limit"),
                },
                primary="deviceLimit.title" if link.url is not None else None,
                tone="neutral",
                error_slot=_FIELD,
                link=link,
            )
        result_name = result if isinstance(result, str) else "error"
        return make_view(
            ctx,
            "Activate",
            "rejected",
            _BASE + _message_only(activation_copy(result_name, activation.get("code"))),
            args={"product": product},
            primary=_SUBMIT,
            tone="danger" if result_name in _WRONG_KEY else "neutral",
            error_slot=_FIELD,
            focus=_FIELD,
        )
    parsed = parse_key(key_field.get("text"), key_field.get("submitted") is True)
    args = {
        "product": product,
        "slug": parsed.slug,
        "prefix": parsed.prefix,
        "used": parsed.used,
        "limit": parsed.limit,
    }
    if parsed.kind == "empty":
        if key_field.get("submitted") is True:
            return make_view(
                ctx,
                "Activate",
                "rejected",
                _BASE + ("part.keyField.empty",),
                args=args,
                primary=_SUBMIT,
                tone="danger",
                error_slot=_FIELD,
                focus=_FIELD,
            )
        return make_view(
            ctx,
            "Activate",
            "empty",
            _BASE + (_SUBMIT,),
            args=args,
            primary=_SUBMIT,
            focus=_FIELD,
        )
    if parsed.kind == "typing":
        return make_view(ctx, "Activate", "typing", _BASE + (_SUBMIT,), args=args, primary=_SUBMIT, focus=_FIELD)
    if parsed.kind == "parsed":
        return make_view(
            ctx,
            "Activate",
            "parsed",
            _BASE + ("part.keyField.forProduct", _SUBMIT),
            args=args,
            primary=_SUBMIT,
            focus=_FIELD,
        )
    if parsed.kind == "short":
        return make_view(
            ctx,
            "Activate",
            "cut-short",
            _BASE + ("part.keyField.cutShort",),
            args=args,
            primary=_SUBMIT,
            tone="danger",
            error_slot=_FIELD,
            focus=_FIELD,
        )
    return make_view(
        ctx,
        "Activate",
        "rejected",
        _BASE + ("part.keyField.malformed",),
        args=args,
        primary=_SUBMIT,
        tone="danger",
        error_slot=_FIELD,
        focus=_FIELD,
    )


def offline_activation_view(ctx: Context) -> View:
    """Offline request/response flow; loading a response is never enough to activate it."""
    if not ctx.on("license"):
        return hidden_view(ctx, "OfflineActivation")
    offline = _mapping(ctx.input.get("offline"))
    submitted = offline.get("submitted") is True
    loaded = offline.get("file") is True
    copied = offline.get("copied") is True
    if submitted and loaded and offline.get("verified") is True:
        return make_view(
            ctx,
            "OfflineActivation",
            "done",
            ("offlineActivation.title", "offlineActivation.done", "common.done"),
            primary="common.done",
        )
    # The two-step form stays in every state but done; the request QR fits wherever the screen
    # has room (DL14, DL3).
    base = (
        "offlineActivation.title",
        "offlineActivation.request",
        "offlineActivation.copyCode",
        "a11y.qrRequest",
        "offlineActivation.loadHint",
        "offlineActivation.loadFile",
        "offlineActivation.paste",
        "offlineActivation.dropHint",
        "offlineActivation.submit",
    )
    if submitted and loaded and offline.get("verified") is False:
        return make_view(
            ctx,
            "OfflineActivation",
            "rejected-signature",
            base + ("core.codes.bundle-jws-rejected.message",),
            primary="offlineActivation.loadFile",
            tone="danger",
            error_slot="offlineActivation.loadFile",
            focus="offlineActivation.loadFile",
        )
    if loaded or copied:
        missing = submitted and not loaded
        return make_view(
            ctx,
            "OfflineActivation",
            "loaded",
            base
            + (
                "offlineActivation.codeCopied" if copied and not submitted and not loaded else None,
                "offlineActivation.empty" if missing else None,
            ),
            primary="offlineActivation.submit",
            tone="danger" if missing else None,
            error_slot="offlineActivation.submit" if missing else None,
            qr=True,
        )
    return make_view(
        ctx,
        "OfflineActivation",
        "default",
        base,
        primary="offlineActivation.copyCode",
        qr=True,
    )
