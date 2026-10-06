"""User-facing copy for every code the SDK can surface (SDK parity pass §3.2, ``core.copy``).

``message(code, detail=None, locale=None)`` and ``title(code)`` turn a registry error code
(``conformance/parity/errors.json``), a gate status or an activation / claim kind into a short
English sentence for a CLI line, a dialog or a log. A code without curated copy falls back to a
generic sentence that names the code — never the raw response body.

The English base here is hand-kept until the shared ``copy.en.json`` and its generated emitters
land (SP-03); ``tests/test_copy.py`` checks that every registry code, gate status and kind
resolves. More locales are content: :func:`register_locale` adds a table (missing keys fall back
to English).
"""

from __future__ import annotations

from typing import Dict, Mapping, Optional, Tuple

__all__ = ["message", "title", "register_locale", "EN", "GENERIC"]

#: The fallback for a code without curated copy.
GENERIC = ("Something went wrong", "Something went wrong ({code}). Try again, or contact support if it keeps happening.")

#: code → (title, message). ``{detail}`` and ``{code}`` are filled in when present.
EN: Dict[str, Tuple[str, str]] = {
    # ── Gate statuses ───────────────────────────────────────────────────────────────
    "ok": ("Licensed", "This device is licensed."),
    "grace": ("Offline grace", "Running offline on your licence's grace period. Connect to the internet to renew it."),
    "expired": ("Licence expired", "Your licence has expired. Renew it or activate another key."),
    "revoked": ("Licence revoked", "This device is no longer licensed. Activate it again or contact support."),
    "needs-activation": ("Activation needed", "Activate this device with a licence key, or sign in."),
    "version-too-old": ("Update required", "This version is no longer supported. Update to continue."),
    "version-too-new": ("Version not available", "Your licence does not cover this version."),
    "channel-not-entitled": ("Channel not available", "Your licence does not include this release channel."),
    "not-applicable": ("No licence needed", "This product does not need a licence."),
    # ── Activation and enrolment ────────────────────────────────────────────────────
    "device_limit": ("Device limit reached", "This licence is already in use on all of its devices. Free a device in your account, then try again."),
    "device-limit": ("Device limit reached", "This licence is already in use on all of its devices. Free a device in your account, then try again."),
    "fingerprint_required": ("Hardware check needed", "This licence needs a hardware fingerprint, and this device could not provide one."),
    "fingerprint-required": ("Hardware check needed", "This licence needs a hardware fingerprint, and this device could not provide one."),
    "hardware_mismatch": ("Hardware changed", "This device's hardware changed. Activate again to re-bind it (this uses a device seat)."),
    "hardware-mismatch": ("Hardware changed", "This device's hardware changed. Activate again to re-bind it (this uses a device seat)."),
    "enroll_claimed": ("Sign in to continue", "This device's free licence now belongs to an account. Sign in to use it."),
    "enroll-claimed": ("Sign in to continue", "This device's free licence now belongs to an account. Sign in to use it."),
    "enroll_disabled": ("Free use not offered", "This product does not offer free use. Activate with a licence key instead."),
    "enroll-disabled": ("Free use not offered", "This product does not offer free use. Activate with a licence key instead."),
    "enroll_failed": ("Could not start free use", "Free use could not be set up right now. Try again later."),
    "license_disabled": ("Licence disabled", "This licence has been disabled. Contact support."),
    "license-disabled": ("Licence disabled", "This licence has been disabled. Contact support."),
    "license_expired": ("Licence expired", "This licence has expired. Renew it or use another key."),
    "license-expired": ("Licence expired", "This licence has expired. Renew it or use another key."),
    "license_owned": ("Licence owned by another account", "This licence belongs to another account. Sign in with that account to use it."),
    "attestation_required": ("Verified install required", "This product only runs on verified store installs."),
    "attestation-required": ("Verified install required", "This product only runs on verified store installs."),
    "attestation_rejected": ("Install could not be verified", "This install could not be verified. Reinstall it from the store."),
    "attestation_unavailable": ("Verification unavailable", "Install verification is not set up for this product."),
    "unauthorized": ("Not authorised", "The licence key or sign-in was not accepted."),
    "rate_limited": ("Too many attempts", "Too many attempts. Wait a moment and try again."),
    "rate-limited": ("Too many attempts", "Too many attempts. Wait a moment and try again."),
    "registration_closed": ("Activation needed", "This product needs a licence or a sign-in before this device can be used."),
    "registration-closed": ("Activation needed", "This product needs a licence or a sign-in before this device can be used."),
    "refused": ("Request refused", "The request was refused ({code})."),
    "forbidden": ("Not allowed", "This action is not allowed for this device or licence."),
    "not_found": ("Not found", "That could not be found."),
    "bad_request": ("Invalid request", "The request was not valid{detail_sep}{detail}"),
    "not_entitled": ("Not included", "Your licence does not include this."),
    "channel_not_allowed": ("Channel not available", "Your licence does not include this release channel."),
    "version_blocked": ("Update required", "This version is not allowed. Update to continue."),
    "managed_by_admin": ("Managed setting", "This setting is managed by your administrator."),
    # ── Transport ───────────────────────────────────────────────────────────────────
    "network-error": ("No connection", "Could not reach the server. Check your internet connection and try again."),
    "network": ("No connection", "Could not reach the server. Check your internet connection and try again."),
    "server-error": ("Server problem", "The server had a problem. Try again in a moment."),
    "http-error": ("Request failed", "The server refused the request."),
    "bad_response": ("Unexpected answer", "The server's answer could not be read. Try again later."),
    "timeout": ("Timed out", "The server took too long to answer."),
    "local-only": ("Offline build", "This build does not connect to the internet."),
    "service-unavailable": ("Not available", "This feature is not available for this product."),
    "unsupported": ("Not supported here", "This is not supported on this device."),
    "insecure-base-url": ("Insecure server address", "The server address is not secure."),
    "insecure-redirect": ("Insecure redirect", "The download was redirected to an insecure address."),
    "too-many-redirects": ("Too many redirects", "The download was redirected too many times."),
    "invalid-options": ("Configuration problem", "The app is not configured correctly{detail_sep}{detail}"),
    "not-configured": ("Not configured", "This feature is not configured in the app."),
    "no-token": ("Activation needed", "Activate this device or sign in first."),
    "device-management-unsupported": ("Activation needed", "Activate this device or sign in to manage devices."),
    "cancelled": ("Cancelled", "Cancelled."),
    # ── Devices ─────────────────────────────────────────────────────────────────────
    "device_list_failed": ("Could not load devices", "Your devices could not be loaded. Try again later."),
    "device_rename_failed": ("Could not rename", "The device could not be renamed."),
    "device_deauthorize_failed": ("Could not remove device", "The device could not be removed."),
    # ── Sign-in ─────────────────────────────────────────────────────────────────────
    "sign-in-unavailable": ("Sign-in unavailable", "Sign-in is not available right now."),
    "sign-in-expired": ("Code expired", "The sign-in code expired. Start again."),
    "sign-in-denied": ("Sign-in failed", "The sign-in was not completed."),
    "sign-in-failed": ("Sign-in failed", "The sign-in did not complete."),
    "disabled": ("Sign-in not offered", "This product does not offer sign-in."),
    "pending": ("Waiting for sign-in", "Finish signing in on the page that opened, then come back."),
    "expired-code": ("Code expired", "The sign-in code expired. Start again."),
    # ── Offline bundles ─────────────────────────────────────────────────────────────
    "bundle-jws-rejected": ("Invalid activation file", "This activation file is not valid."),
    "bundle-claims-rejected": ("Wrong activation file", "This activation file is for another device or has expired."),
    "bundle-trust-rejected": ("Untrusted activation file", "This activation file is not signed by this product."),
    "inner-doc-rejected": ("Invalid activation file", "This activation file holds a document that is not valid."),
    # ── Updates and downloads ───────────────────────────────────────────────────────
    "download_auth_required": ("Licence needed to download", "Downloading this needs a valid licence."),
    "payload-mismatch": ("Download damaged", "The download did not match its signature and was discarded. Try again."),
    "record-rejected": ("Update not trusted", "The update's signature could not be verified."),
    "record-mismatch": ("Update not trusted", "The update does not match its release record."),
    "feed-rejected": ("Update check failed", "The update feed could not be verified."),
    "feed-rollback": ("Update check failed", "The update feed is older than one already seen."),
    "update-available": ("Update available", "A new version is available."),
    "update-required": ("Update required", "Update to continue."),
    # ── Packs ───────────────────────────────────────────────────────────────────────
    "pack-not-entitled": ("Content not included", "Your licence does not include this content."),
    "pack-revoked": ("Content withdrawn", "This content was withdrawn by the publisher."),
    "plan-insufficient-disk": ("Not enough space", "There is not enough free disk space for this download."),
    "fetch-failed": ("Download failed", "Required content could not be downloaded."),
    "sync-failed": ("Could not check your licence", "Your licence could not be checked. Try again."),
    "content-declined": ("Download needed", "This content is needed to continue."),
    # ── Commerce ────────────────────────────────────────────────────────────────────
    "not-owned": ("Purchase not found", "The store does not show this purchase on your account."),
    "store-opened": ("Store opened", "Finish the update in the store."),
}

_LOCALES: Dict[str, Dict[str, Tuple[str, str]]] = {"en": EN}


def register_locale(locale: str, table: Mapping[str, Tuple[str, str]]) -> None:
    """Add (or extend) a locale's table; missing keys fall back to English."""
    _LOCALES.setdefault(locale.lower(), {}).update(table)


def _entry(code: str, locale: Optional[str]) -> Optional[Tuple[str, str]]:
    if locale:
        loc = locale.lower().replace("_", "-")
        for candidate in (loc, loc.split("-")[0]):
            table = _LOCALES.get(candidate)
            if table and code in table:
                return table[code]
    return EN.get(code)


def message(code: str, detail: Optional[str] = None, locale: Optional[str] = None) -> str:
    """One sentence for ``code`` (``detail`` appended where the copy takes it)."""
    entry = _entry(code, locale)
    text = entry[1] if entry is not None else GENERIC[1]
    return text.format(
        code=code,
        detail=detail or "",
        detail_sep=(": " if detail else "."),
    )


def title(code: str, locale: Optional[str] = None) -> str:
    """A short heading for ``code``."""
    entry = _entry(code, locale)
    return entry[0] if entry is not None else GENERIC[0]
