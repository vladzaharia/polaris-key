"""The ``holders`` ui-matrix family: ActivateDone and AddToAccount (activation without an account).

A port of ``@polaris-key/ui-core``'s ``models/holders.ts`` (UK-42, UK-43). After a key activates the
license is floating, held by the key alone; ActivateDone says so and recommends an account once,
quietly; AddToAccount collects a name and an email, and the browser confirms the email. The rules the
rows pin:

* the reasons are written once (:func:`recommend_reasons`): Cloud Sync only when the product has it;
  getting the license back and moving it to a new device only when Identity is on; with Identity off
  the one line sends the person to the portal;
* the holder is ``licenseHolder.email``: empty is floating, set is waiting for that email (with Identity on), which a
  screen shows masked (:func:`~polaris_key.ui.core.format.mask_email`) and never in full;
* skipping is never a refusal: Start using is always the one primary.

Pure functions of the input; no I/O.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

from .format import mask_email
from .ui_contract import Context, coarse_pointer
from .ui_view import View, hidden_view, identity_text, make_view

__all__ = [
    "HOLDER_MODELS",
    "activate_done_view",
    "add_to_account_view",
    "lead_parts",
    "reasons_of",
    "recommend_reasons",
]

_NAME = "activate.attach.name"
_EMAIL = "signin.email.label"


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def recommend_reasons(identity: bool, sync: bool) -> List[str]:
    """The copy keys of the recommendation's reason lines, in the order they show.

    Cloud Sync only when the product has it (it counts only with Identity), getting the license back
    and moving it to a new device when Identity is on, and with Identity off the single
    ``activate.recommend.portal`` line. The first words of each line are a lead-in a renderer may
    style (:func:`lead_parts`).
    """
    if not identity:
        return ["activate.recommend.portal"]
    return [*(["activate.recommend.sync"] if sync else []), "activate.recommend.recover", "activate.recommend.devices"]


def reasons_of(ctx: Context) -> List[str]:
    """The reasons for what the input's services turn on."""
    return recommend_reasons(ctx.on("identity"), ctx.on("sync"))


def lead_parts(text: str) -> List[Dict[str, Any]]:
    """Split a formatted reason on ``**`` into runs, ``[{"text": ..., "strong": bool}]``.

    Odd-numbered pieces are the strong lead-in, as ui-core's ``leadParts`` splits them. A
    renderer draws each run itself and never hands the string to a markup parser.
    """
    return [
        {"text": piece, "strong": index % 2 == 1}
        for index, piece in enumerate(text.split("**"))
        if piece != ""
    ]


def _holder_addin(ctx: Context) -> Any:
    return _mapping(ctx.input.get("licenseHolder")).get("addIn")


def activate_done_view(ctx: Context) -> View:
    """The step after a license key activates: ``<Product> is ready``, the license line, and the
    recommendation when no email holds the license; a license sent to an email that has no account
    yet shows the waiting line instead.
    With Identity off a holder email still draws the ready state with the portal line."""
    done = ctx.input.get("activateDone")
    if not ctx.on("license") or not isinstance(done, Mapping):
        return hidden_view(ctx, "ActivateDone")
    ident = identity_text(ctx)
    activation = _mapping(ctx.input.get("activation"))
    args = {
        "product": ident.name,
        "developer": ident.developer or ident.name,
        "tier": done.get("tier") if done.get("tier") is not None else activation.get("tier"),
        "term": done.get("term") if done.get("term") is not None else activation.get("term"),
        "deviceKind": done.get("deviceKind"),
        "n": done.get("position"),
        "limit": done.get("limit"),
    }
    # A holder email too malformed to mask counts as none: no sentence renders with an empty email.
    masked = mask_email(_mapping(ctx.input.get("licenseHolder")).get("email"))
    if masked and ctx.on("identity"):
        return make_view(
            ctx,
            "ActivateDone",
            "waiting",
            (
                "activate.done.title",
                "activate.done.device",
                "activate.waiting",
                "activate.waitingSignIn",
                "signin.done.start",
            ),
            args={**args, "maskedEmail": masked},
            primary="signin.done.start",
        )
    add_in = done.get("addIn") if done.get("addIn") is not None else _holder_addin(ctx)
    portal = not ctx.on("identity") or add_in == "portal"
    extra: Dict[str, Any] = {}
    if done.get("returned") and ctx.on("identity"):
        extra["focus"] = "signin.key.addInLocker" if portal else "activate.recommend.action"
    return make_view(
        ctx,
        "ActivateDone",
        "ready",
        (
            "activate.done.title",
            "activate.done.device",
            "activate.recommend.title",
            "activate.recommend.badge",
            *reasons_of(ctx),
            # With Identity off, or a kit with no in-app channel, the action opens polaris.locker, so
            # it says that (an external link).
            "signin.key.addInLocker" if portal else "activate.recommend.action",
            "a11y.externalLink" if portal else None,
            "activate.recommend.skip",
            "signin.done.start",
        ),
        args=args,
        primary="signin.done.start",
        **extra,
    )


def add_to_account_view(ctx: Context, step_override: Optional[str] = None) -> View:
    """Add your name and email: the person types them here, the browser confirms the email."""
    a = _mapping(ctx.input.get("addToAccount"))
    if not ctx.on("identity") or not ctx.on("license") or not a:
        return hidden_view(ctx, "AddToAccount")
    ident = identity_text(ctx)
    masked = a.get("typedEmail") or mask_email(_mapping(ctx.input.get("licenseHolder")).get("email")) or None
    args = {
        "product": ident.name,
        "deviceKind": a.get("deviceKind"),
        "maskedEmail": masked,
        "email": a.get("signedEmail") or None,
    }
    step = step_override or a.get("step")
    # DL9: Name takes focus; a field never does under a coarse pointer, where the heading does.
    name_focus = "heading" if coarse_pointer(ctx.platform) else _NAME
    fields = [
        "activate.recommend.action",
        "activate.attach.lede",
        _NAME,
        _EMAIL,
        "activate.attach.fine",
        "common.continue",
        "common.cancel",
    ]
    if step == "form":
        return make_view(
            ctx, "AddToAccount", "form", fields, args=args, primary="common.continue", focus=name_focus
        )
    if step == "invalid":
        field = a.get("field") or "both"
        bad = [_NAME, _EMAIL] if field == "both" else [_NAME if field == "name" else _EMAIL]
        return make_view(
            ctx,
            "AddToAccount",
            "invalid",
            [
                *fields,
                "activate.attach.nameRequired" if _NAME in bad else None,
                "signin.email.invalid" if _EMAIL in bad else None,
            ],
            args=args,
            primary="common.continue",
            tone="danger",
            # The message sits under the first field that is wrong (DL7).
            error_slot=bad[0],
            focus=name_focus if bad[0] == _NAME else bad[0],
        )
    if step == "busy":
        # The person confirms the email in Polaris Locker: the form gives way to `waiting`, the code
        # they check there. With no code to show, the form stays greyed behind Working.
        if _mapping(ctx.input.get("deviceCode")).get("userCode"):
            return make_view(
                ctx,
                "AddToAccount",
                "waiting",
                [
                    "activate.attach.waitTitle",
                    "part.code.label",
                    "a11y.code",
                    "a11y.copyCode",
                    "activate.attach.waitCheck",
                    "activate.attach.reopen",
                    "common.cancel",
                ],
                args=args,
                focus="heading",
            )
        return make_view(
            ctx,
            "AddToAccount",
            "busy",
            # The person is in the browser, which can take minutes: Continue stays (busy), Open the
            # browser again brings the tab back, and Cancel is the way out (DL9).
            [*[k for k in fields if k != "common.cancel"], "common.working", "signin.handoff.again", "common.cancel"],
            args=args,
            primary="common.continue",
            focus=None,
        )
    if step == "added":
        # From Settings the app is already running: the screen closes with Done.
        closing = "common.done" if a.get("fromSettings") else "signin.done.start"
        return make_view(
            ctx,
            "AddToAccount",
            "added",
            [
                "activate.attach.done",
                # Cloud Sync is named only when the product has it.
                "activate.attach.syncOn" if ctx.on("sync") else None,
                closing,
            ],
            args=args,
            primary=closing,
        )
    if step == "owned":
        # Someone attached the license while this screen was open.
        return make_view(
            ctx,
            "AddToAccount",
            "owned",
            ["activate.owned.title", "activate.owned.lede", "signin.key.ownedSignIn", "common.cancel"],
            args=args,
            primary="signin.key.ownedSignIn",
            tone="neutral",
        )
    if step == "email-bound":
        # The license's email is not the account's; the license keeps working. The sentence and
        # "Verify that email" name the email; with none known both are left out, never half-written.
        return make_view(
            ctx,
            "AddToAccount",
            "email-bound",
            [
                "activate.otherEmail.title",
                "activate.otherEmail.body" if masked else None,
                "activate.otherEmail.verify" if masked else None,
                "signin.auto.confirm.other",
                "signin.done.start",
            ],
            args=args,
            primary="activate.otherEmail.verify" if masked else "signin.auto.confirm.other",
            tone="neutral",
        )
    if step == "other-account":
        # A different account signed in than the email typed: the license was added nowhere.
        return make_view(
            ctx,
            "AddToAccount",
            "other-account",
            [
                "activate.otherAccount.title",
                "activate.otherAccount.body" if masked and args["email"] else None,
                "common.tryAgain",
                "signin.done.start",
            ],
            args=args,
            primary="common.tryAgain",
            tone="neutral",
        )
    if step == "failed":
        return make_view(
            ctx,
            "AddToAccount",
            "failed",
            ["activate.recommend.action", "activate.attach.failed", "common.tryAgain", "common.cancel"],
            args=args,
            primary="common.tryAgain",
            tone="danger",
            error_slot="common.tryAgain",
        )
    return hidden_view(ctx, "AddToAccount")


HOLDER_MODELS = {
    "ActivateDone": activate_done_view,
    "AddToAccount": lambda ctx: add_to_account_view(ctx),
}
