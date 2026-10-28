"""The ``signIn`` ui-matrix family: SignIn and SignInHandoff.

A port of ``@polaris-key/ui-core``'s ``models/signIn.ts`` (SIGN-IN.md §3.17): the one sign-in form
whose body morphs in place through methods → handoff | code → finishing → done, with the key and
replace steps a native choice opens. SignIn is the form; SignInHandoff draws its step 2 (Finish in
your browser, the device code). These are pure functions of the session input.

``LicenseChoice`` (step 3, the licenses an account holds) is not here: it needs the pending sign-in
grant's roster, which the Python SDK's device-code sign-in does not return (the card chooses, as in
every device-code sign-in), so a Python kit never reaches it.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional
from urllib.parse import quote

from ...constants_generated import DEVICE_CODE_PAGE, SIGN_IN_PROVIDER_NAME, TV_CODE_PAGE
from .ui_activate import activation_copy, key_refusal_of, key_refusal_spec
from .ui_contract import Context, platform_class, system_confirm
from .ui_view import (
    LinkVerdict,
    View,
    code_expired,
    countdown,
    hidden_view,
    identity_text,
    link_verdict,
    make_view,
    valid_link,
)

__all__ = ["nearby_approval_view", "sign_in_handoff_view", "sign_in_view", "verification_url"]

_Copy = List[Optional[str]]


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _sign_in_on(ctx: Context) -> bool:
    """The sign-in is possible here: Identity is on and the build offers it."""
    return ctx.on("identity") and bool(ctx.caps["signIn"])


def _chooses_in_app(ctx: Context) -> bool:
    """True when the license choice happens in the app (inline or sheet, browser channel: D4)."""
    s = _mapping(ctx.input.get("signIn"))
    return bool(s) and s.get("presentation") != "browser" and s.get("channel") != "device-code"


def verification_url(ctx: Context) -> str:
    """The device-code page: the product's own ``deviceCodeUrl``, else the server's address, else
    Polaris Locker's (``/tv`` on a TV or console, ``/device`` elsewhere; SIGN-IN.md D-16). The first
    that passes the opener (DL14): a broken integrator address never hides the server's valid one."""
    for candidate in (
        _mapping(ctx.input.get("integrator")).get("deviceCodeUrl"),
        _mapping(ctx.input.get("deviceCode")).get("verificationUri"),
    ):
        if isinstance(candidate, str) and valid_link(candidate) is not None:
            return candidate
    return TV_CODE_PAGE if platform_class(ctx.platform) in ("tv", "console") else DEVICE_CODE_PAGE


def _target(ctx: Context, shown: str) -> str:
    """What opening, copying or scanning the link does: the Polaris Locker page we fall back to
    carries the code (``?user_code=``). The displayed address stays bare."""
    code = _mapping(ctx.input.get("deviceCode")).get("userCode")
    if not code or shown not in (DEVICE_CODE_PAGE, TV_CODE_PAGE):
        return shown
    return f"{shown}?user_code={quote(str(code), safe='')}"


# ── SignIn ─────────────────────────────────────────────────────────────────────────────────────


def _methods_primary(ctx: Context) -> str:
    return "signin.desktop.continue" if platform_class(ctx.platform) == "desktop" else "signin.provider.continue"


def _methods_copy(ctx: Context) -> _Copy:
    kind = platform_class(ctx.platform)
    key_path = bool(ctx.caps["keyEntry"]) and ctx.on("license")
    common: _Copy = [
        "signIn.title",
        "signin.methods.ledeApp",
        "signin.provider.group",
        "signin.provider.continue",
        "signin.choice.keyInstead" if key_path else None,
        "common.cancel",
    ]
    if kind == "desktop":  # leads with Continue in browser, no passkey or device-code row (D-69)
        return common + ["signin.desktop.continue", "signin.menu.signIn"]
    return common + [
        "signin.passkey",
        "signin.email.continue",
        "signin.link.deviceCode" if kind == "handheld" and ctx.caps["deviceCode"] else None,
    ]


def _per_developer(provider: str, reach: Any) -> bool:
    """The provider's identity is per developer: Apple always, Google unless shared across apps."""
    return provider == "Apple" or reach != "global"


def _auto_step_view(ctx: Context, auto: Mapping[str, Any], args: Mapping[str, Any], provider: str) -> View:
    """Automatic sign-in's steps, drawn in the form's body: confirm the account, offer to link the
    provider, and the nearby wait (plans/auto-sign-in.md §3). Every outcome has a title that takes
    focus and one way on (Continue)."""
    step = auto.get("step")
    account = _mapping(ctx.input.get("account"))
    a = {**args, "provider": provider, "tier": account.get("tier"), "code": auto.get("code")}

    def view(state: str, copy: _Copy, primary: Optional[str] = None, tone: Optional[str] = None) -> View:
        return make_view(ctx, "SignIn", state, copy, args=a, primary=primary, tone=tone, focus="heading")

    if step == "confirm":
        license_kind = auto.get("license")
        also = bool(auto.get("alsoGets"))
        return view(
            "confirm",
            [
                "signin.auto.confirm.title",
                "signin.auto.confirm.as" if auto.get("email") else "signin.auto.confirm.asApple",
                "signin.consent.license" if license_kind else None,
                "signin.consent.newLicense" if license_kind == "new" else None,
                "signin.consent.licenseLine" if license_kind == "existing" else None,
                "signin.consent.alsoGets" if also else None,
                "signin.consent.profile" if also else None,
                "signin.consent.pairwise" if also else None,
                "signin.auto.confirm.primary",
                "signin.auto.confirm.other",
            ],
            "signin.auto.confirm.primary",
        )
    if step == "link-offer":
        if not _per_developer(provider, auto.get("reach")):
            body = "signin.linkOffer.bodyGlobal"
        elif a.get("developer"):
            body = "signin.linkOffer.bodyDeveloper"
        else:
            body = "signin.linkOffer.bodyApp"
        return view(
            "link-offer",
            ["signin.linkOffer.title", body, "signin.linkOffer.primary", "signin.linkOffer.decline"],
            "signin.linkOffer.primary",
        )
    if step == "link-done":
        return view("link-done", ["signin.linkOffer.done", "common.done"], "common.done")
    if step == "link-conflict":
        return view(
            "link-conflict",
            ["signin.linkOffer.conflictTitle", "signin.linkOffer.conflict", "signin.linkOffer.join", "common.done"],
            "common.done",
            "neutral",
        )
    if step == "nearby-prompt":
        return view(
            "nearby-prompt",
            ["signin.nearby.promptTitle", "signin.nearby.prePrompt", "common.continue", "common.notNow"],
            "common.continue",
        )
    if step == "nearby-wait":
        return view(
            "nearby-wait",
            [
                "signin.nearby.title",
                "signin.nearby.body",
                "signin.nearby.match",
                "a11y.nearbyCode" if auto.get("code") else None,
                "signin.nearby.code",
            ],
        )
    if step == "device-limit":
        # A device limit with no license rows: its own step, never the key screen. Replace opens the
        # refusal's manageUrl; without a usable link the fix is named in words.
        link = link_verdict(auto.get("manageUrl"), ctx.platform, "replace-device")
        replace = link.url is not None
        return make_view(
            ctx,
            "SignIn",
            "device-limit",
            [
                "core.codes.device_limit.title",
                "core.codes.device_limit.message" if replace else None,
                "signin.deviceLimit.replace" if replace else "deviceLimit.noManage",
                "a11y.externalLink" if replace else None,
                "signin.auto.confirm.other",
                "common.cancel",
            ],
            args=a,
            primary="signin.deviceLimit.replace" if replace else None,
            tone="neutral",
            focus="heading",
            link=link,
        )
    return view("nearby-done", ["signin.nearby.done", "common.continue", "signin.nearby.notYou"], "common.continue")


def nearby_approval_view(ctx: Context) -> View:
    """NearbyApproval: the approving device's side of nearby sign-in (D-A9). No primary on the prompt:
    choosing the matching code is the action, and Deny the only other. Every outcome has a title that
    takes focus and one way on."""
    if not ctx.on("identity"):
        return hidden_view(ctx, "NearbyApproval")
    n = _mapping(ctx.input.get("nearbyApproval"))
    args = {"device": n.get("device"), "product": identity_text(ctx).name}
    step = n.get("step")

    def outcome(state: str, copy: _Copy, primary: Optional[str], tone: Optional[str] = None) -> View:
        return make_view(ctx, "NearbyApproval", state, copy, args=args, primary=primary, tone=tone, focus="heading")

    if step == "ask":
        return make_view(
            ctx,
            "NearbyApproval",
            "ask",
            ["signin.nearby.ask", "signin.nearby.askBody", "signin.approve.warning", "signin.approve.deny"],
            args=args,
            focus="heading",
        )
    if step == "approved":
        return outcome("approved", ["signin.nearby.approved", "common.done"], "common.done")
    if step == "not-nearby":
        return outcome(
            "not-nearby",
            ["signin.nearby.notNearby", "signin.nearby.notNearbyBody", "common.done"],
            "common.done",
            "neutral",
        )
    if step == "mismatch":
        return outcome("mismatch", ["signin.nearby.mismatch", "common.done"], "common.done")
    if step == "denied":
        return outcome("denied", ["signin.approve.deniedDone", "common.done"], "common.done")
    if step == "expired":
        return outcome(
            "expired",
            ["core.codes.sign-in-expired.title", "signin.nearby.expiredBody", "common.done"],
            "common.done",
            "neutral",
        )
    if step == "device-limit":
        return outcome(
            "device-limit",
            ["core.codes.device_limit.title", "signin.nearby.deviceLimitBody", "devices.manage"],
            "devices.manage",
            "neutral",
        )
    if step == "choose":
        return outcome(
            "choose",
            ["signin.nearby.chooseTitle", "signin.nearby.chooseLede", "signin.choice.continue"],
            "signin.choice.continue",
        )
    if step == "account-required":
        return outcome(
            "account-required",
            ["core.codes.account_required.title", "core.codes.account_required.message", "signin.key.signIn"],
            "signin.key.signIn",
            "neutral",
        )
    if step == "rate-limited":
        return outcome(
            "rate-limited",
            ["core.codes.rate_limited.title", "signin.nearby.rateLimitedBody", "common.done"],
            "common.done",
            "neutral",
        )
    return make_view(ctx, "NearbyApproval", "entry", ["signin.nearby.menu"], args=args, focus=None)


def _methods_view(ctx: Context, args: Mapping[str, Any]) -> View:
    return make_view(ctx, "SignIn", "methods", _methods_copy(ctx), args=args, primary=_methods_primary(ctx))


def sign_in_view(ctx: Context) -> View:
    """The one sign-in form."""
    s = _mapping(ctx.input.get("signIn"))
    if not _sign_in_on(ctx) or not s:
        return hidden_view(ctx, "SignIn")
    dc = _mapping(ctx.input.get("deviceCode"))
    ident = identity_text(ctx)
    provider = ctx.input.get("provider") or SIGN_IN_PROVIDER_NAME
    args = {"product": ident.name, "app": ident.name, "provider": provider, "method": provider}
    license_on = ctx.on("license")
    error = _mapping(ctx.input.get("error")).get("code")
    if error:
        primary = _methods_primary(ctx)
        return make_view(
            ctx,
            "SignIn",
            "error",
            ["signIn.noMethods" if error == "sign-in-unavailable" else "signIn.methodError"],
            args=args,
            primary=primary,
            tone="danger",
            error_slot=primary,
        )
    auto = _mapping(ctx.input.get("autoSignIn"))
    if auto:
        return _auto_step_view(ctx, auto, {**args, "developer": ident.developer, "email": auto.get("email")}, provider)
    if s.get("outcome") == "expired" or (dc and (dc.get("phase") == "expired" or code_expired(dc.get("secondsLeft")))):
        return make_view(
            ctx,
            "SignIn",
            "expired",
            ["core.codes.sign-in-expired.title", "core.codes.sign-in-expired.message", "signin.again"]
            if s.get("channel") == "device-code"
            else ["signin.handoff.tooLong", "signin.again"],
            args=args,
            primary="signin.again",
            tone="neutral",
        )
    if s.get("outcome") == "signedIn":
        # How the form ends (SIGN-IN.md §3.17 item 4): Done when a license was added or issued now;
        # otherwise the form closes and the app opens with the toast. License off: no tier to name.
        account = _mapping(ctx.input.get("account"))
        copy: List[str] = (
            ["signin.return.signedInShort"]
            if not license_on
            else [
                "signin.done.start",
                "signin.return.signedInTier" if account.get("tier") else "signin.return.signedInShort",
            ]
            if s.get("issuedNow")
            else ["signin.desktop.toast"]
        )
        start = "signin.done.start" in copy
        no_focus: Dict[str, Any] = {} if start else {"focus": None}
        return make_view(
            ctx,
            "SignIn",
            "done",
            copy,
            args={**args, "name": account.get("holder"), "tier": account.get("tier")},
            primary="signin.done.start" if start else None,
            **no_focus,
        )
    in_app = _chooses_in_app(ctx)
    if s.get("outcome") == "choose" and in_app:
        # Use a license key instead keeps the account: the key step is in the same form (Must not).
        if s.get("event") == "have-key" and license_on and ctx.caps["keyEntry"]:
            a = _mapping(ctx.input.get("activation"))
            refused = bool(a) and a.get("result") != "ok"
            refusal = key_refusal_of(a) if a else None
            if refusal is not None:  # a different key cannot fix it: the field is left behind (DL6)
                spec = key_refusal_spec(ctx, refusal, a)
                return make_view(
                    ctx,
                    "SignIn",
                    "key-refused",
                    spec["copy"],
                    args=args,
                    primary=spec["primary"],
                    tone="neutral",
                    link=spec["link"],
                    qr=spec["qr"],
                )
            return make_view(
                ctx,
                "SignIn",
                "key",
                [
                    "signin.key.addTitle",
                    "part.keyField.label",
                    *(activation_copy(a.get("result"), a.get("code")) if refused else ()),
                ],
                args={**args, "code": a.get("code")},
                primary="activate.submit",
                tone="neutral" if refused else None,
                error_slot="part.keyField.label" if refused else None,
                focus="part.keyField.label",
            )
        replace_view = _mapping(ctx.input.get("replaceView"))
        if s.get("event") == "open-replace" and s.get("replace") == "inline" and replace_view:
            system = system_confirm(ctx.platform, str(s.get("presentation")))
            devices = [d for d in replace_view.get("devices", ()) if isinstance(d, Mapping)]
            pick = next((d for d in devices if d.get("leastRecent")), devices[0] if devices else None)
            return make_view(
                ctx,
                "SignIn",
                "replace",
                [
                    "signin.replace.open",
                    "signin.replace.lede",
                    "signin.replace.openSystem" if system else "signin.replace.title",
                ],
                args={**args, "device": pick.get("label") if pick else None},
                primary="signin.replace.openSystem" if system else "signin.replace.open",
            )
        desktop = platform_class(ctx.platform) == "desktop"
        return make_view(
            ctx,
            "SignIn",
            "choose",
            ["signin.choice.title", "signin.desktop.notifyChoose" if desktop else None],
            args=args,
            extra_actions=(
                ["replace-in-browser"] if s.get("event") == "open-replace" and s.get("replace") == "browser" else []
            ),
            primary=None,  # LicenseChoice draws the rows and Continue
            focus=None,
        )
    if s.get("redeeming") or dc.get("phase") == "ok":
        return make_view(ctx, "SignIn", "finishing", ["signin.handoff.finishing", "a11y.busy"], args=args, focus=None)
    if s.get("channel") == "device-code" or s.get("event") == "use-code":
        return make_view(ctx, "SignIn", "code", [], args=args, focus=None)  # SignInHandoff draws the code
    if s.get("outcome") == "pending":
        return make_view(
            ctx,
            "SignIn",
            "handoff",
            [
                "signin.handoff.title",
                "signin.handoff.browserBody",
                "signin.handoff.waiting",
                "signin.handoff.again",
                "signin.handoff.useCode" if ctx.caps["deviceCode"] else None,
            ],
            args=args,
            primary="signin.handoff.again",
        )
    return _methods_view(ctx, args)  # Cancel returns to step 1, with nothing else lost


# ── SignInHandoff ──────────────────────────────────────────────────────────────────────────────


def sign_in_handoff_view(ctx: Context) -> View:
    """Step 2 of the form: Finish in your browser, or the device code. Moves on by itself."""
    s = _mapping(ctx.input.get("signIn"))
    if not _sign_in_on(ctx) or not s:
        return hidden_view(ctx, "SignInHandoff")
    ident = identity_text(ctx)
    dc = _mapping(ctx.input.get("deviceCode"))
    kind = platform_class(ctx.platform)
    shown = verification_url(ctx)
    bare = link_verdict(shown, ctx.platform, "sign-in")
    link = (
        LinkVerdict(bare.purpose, _target(ctx, bare.url), bare.display, bare.open, bare.qr) if bare.url else bare
    )
    seconds = dc.get("secondsLeft")
    args = {
        "product": ident.name,
        "url": link.display,
        "code": dc.get("userCode"),
        "time": countdown(seconds) if seconds is not None else None,
    }
    if s.get("channel") == "device-code" or s.get("event") == "use-code":
        # The device-code poll's phase alone selects the state (plans/UK-02b.md §4.5). At 0:00 the
        # view switches to expired locally while any poll finishes (DL14).
        phase = dc.get("phase") or "starting"
        if phase == "expired" or code_expired(seconds):
            return make_view(
                ctx,
                "SignInHandoff",
                "expired",
                # A lapsed code is never polled again, and its code is gone from the screen (Must not).
                ["core.codes.sign-in-expired.title", "core.codes.sign-in-expired.message", "signInHandoff.newCode"],
                args=args,
                primary="signInHandoff.newCode",
                tone="neutral",
            )
        if phase == "starting":
            return make_view(
                ctx, "SignInHandoff", "starting", ["signInHandoff.starting", "a11y.busy"], args=args, focus=None
            )
        if phase == "ok":
            return make_view(
                ctx,
                "SignInHandoff",
                "finishing",
                ["signin.handoff.finishing", "signInHandoff.ok"],
                args=args,
                focus=None,
            )
        if phase in ("denied", "failed"):
            return make_view(
                ctx,
                "SignInHandoff",
                phase,
                [f"core.codes.sign-in-{phase}.title", f"core.codes.sign-in-{phase}.message", "signInHandoff.newCode"],
                args=args,
                primary="signInHandoff.newCode",
                tone="danger",
                error_slot="screen",
            )
        if phase == "cancelled":
            return make_view(
                ctx,
                "SignInHandoff",
                "cancelled",
                ["signin.handoff.cancelled", "signInHandoff.newCode"],
                args=args,
                primary="signInHandoff.newCode",
            )
        return _code_view(ctx, kind, link, args)
    if s.get("redeeming"):
        return make_view(ctx, "SignInHandoff", "finishing", ["signin.handoff.finishing"], args=args, focus=None)
    outcome = s.get("outcome")
    if outcome == "pending":
        # The opener failed: the screen stays, with Copy link (DL14).
        if s.get("browserOpened") is False:
            if s.get("event") == "copy-link":
                return make_view(
                    ctx, "SignInHandoff", "link-copied", ["signInHandoff.linkCopied"], args=args, focus=None
                )
            return make_view(
                ctx,
                "SignInHandoff",
                "no-browser",
                ["signin.handoff.noBrowser", "signin.handoff.noBrowserBody", "signin.handoff.copyLink"],
                args=args,
                primary="signin.handoff.copyLink",
                tone="neutral",
            )
        return make_view(
            ctx,
            "SignInHandoff",
            "waiting",
            [
                "signin.handoff.title",
                "signin.handoff.waiting",
                "signin.handoff.again",
                "signin.handoff.useCode" if ctx.caps["deviceCode"] else None,
                "common.cancel",
            ],
            args=args,
            primary="signin.handoff.again",  # Open browser again reuses the request in flight
        )
    if outcome == "expired":
        return make_view(
            ctx,
            "SignInHandoff",
            "expired",
            ["signInHandoff.newCode"],
            args=args,
            primary="signInHandoff.newCode",
            tone="neutral",
        )
    if outcome == "cancelled":
        return make_view(
            ctx,
            "SignInHandoff",
            "cancelled",
            ["signin.handoff.cancelled", "signInHandoff.newCode"],
            args=args,
            primary="signInHandoff.newCode",
        )
    return make_view(ctx, "SignInHandoff", "starting", ["signInHandoff.starting", "a11y.busy"], args=args, focus=None)


def _code_view(ctx: Context, kind: str, link: LinkVerdict, args: Mapping[str, Any]) -> View:
    """The code view (UI-KITS §4.3, DL14): the code, the address and the countdown everywhere; a QR
    only on a TV or a console; Open browser where the device can browse. The QR, Copy and the visible
    text carry exactly the same code and link."""
    head: _Copy = ["signin.handoff.codeTitle", "part.code.label", "a11y.code"]
    if kind == "tv":
        return make_view(
            ctx,
            "SignInHandoff",
            "code",
            head
            + [
                "a11y.qr" if link.qr else None,
                "signInHandoff.scanTv" if link.qr else None,
                "signin.handoff.url" if link.url else None,
            ],
            args=args,
            link=link,
        )
    if kind == "console":
        return make_view(
            ctx,
            "SignInHandoff",
            "code",
            head + ["a11y.qr" if link.qr else None, "part.qr.enlarge" if link.qr else None, "signInHandoff.scan"],
            args=args,
            link=link,
        )
    opener: Optional[str] = "signin.handoff.openBrowser" if link.open else None
    if kind == "handheld":
        return make_view(
            ctx,
            "SignInHandoff",
            "code",
            head
            + [
                "a11y.copyCode",
                "signin.handoff.url" if link.url else None,
                "a11y.copyAddress" if link.url else None,
                opener,
            ],
            args=args,
            primary="signin.handoff.openBrowser" if link.open else None,
            link=link,
        )
    return make_view(
        ctx,
        "SignInHandoff",
        "code",
        head + ["a11y.copyCode", "signin.handoff.codeBody" if link.url else None, opener],
        args=args,
        primary="signin.handoff.openBrowser" if link.open else None,
        link=link,
    )
