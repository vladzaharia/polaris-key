# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm gen:constants` (tools/gen-sdk-constants.ts) from conformance/parity/
# copy.en.json, checked against errors.json and enums.json (licenseStatus, activationResult).
# `pnpm gen:constants -- --check` fails the green gate on any difference. To change a string,
# edit copy.en.json and regenerate.
"""Polaris Key's core copy (core.copy). The core copy (core.copy): a title and message per error code, gate status (licenseStatus) and activation result (activationResult). A code missing from COPY_CODES shows COPY_FALLBACK with {code} filled in, never the raw body."""

from __future__ import annotations

from types import MappingProxyType
from typing import Final, Mapping, NamedTuple, Tuple

__all__ = [
    "CopyEntry",
    "COPY_VERSION",
    "COPY_LOCALE",
    "COPY_PLACEHOLDERS",
    "COPY_FALLBACK",
    "COPY_CODES",
    "COPY_GATE",
    "COPY_ACTIVATION",
]


class CopyEntry(NamedTuple):
    """One piece of core copy."""

    title: str
    message: str


COPY_VERSION: Final = 1
COPY_LOCALE: Final = "en"
#: The only placeholders a copy string may hold, each written ``{name}``.
COPY_PLACEHOLDERS: Tuple[str, ...] = ("code", "detail", "limit", "deviceCount", "retryAfterSeconds", "product")
#: Shown for a code this table does not know, with {code} filled in.
COPY_FALLBACK: Final = CopyEntry("Something went wrong", "Something went wrong ({code}). Try again.")

#: Per error code (errors.json order).
COPY_CODES: Mapping[str, CopyEntry] = MappingProxyType(
    {
        "unauthorized": CopyEntry("Not signed in", "This device isn't signed in, or its license is no longer valid. Sign in or activate again."),
        "not_found": CopyEntry("Not found", "That wasn't found. It may have been removed."),
        "bad_request": CopyEntry("Request refused", "The request wasn't valid. Update the app, then try again."),
        "forbidden": CopyEntry("Not allowed", "You don't have permission to do that."),
        "attestation_required": CopyEntry("Device check needed", "This needs a verified device. Let the app check this device, then try again."),
        "attestation_rejected": CopyEntry("Device check failed", "This device couldn't be verified. Try again."),
        "attestation_unavailable": CopyEntry("Device check unavailable", "Device verification isn't available for this app right now. Try again in a few minutes."),
        "rate_limited": CopyEntry("Too many attempts", "Too many attempts. Wait a moment and try again."),
        "body_too_large": CopyEntry("Too large", "That is too large to send."),
        "method_not_allowed": CopyEntry("Request refused", "The request wasn't valid. Update the app, then try again."),
        "misconfigured": CopyEntry("Service not set up", "This service isn't set up correctly. Contact the developer."),
        "registration_closed": CopyEntry("Registration closed", "New devices can't register right now. Activate with a license key or sign in."),
        "value_not_representable": CopyEntry("Value not accepted", "A value couldn't be saved. Change it and try again."),
        "document_not_representable": CopyEntry("Service problem", "The service couldn't prepare your settings. Contact the developer."),
        "device_limit": CopyEntry("Device limit reached", "This license is already on all its devices. Replace a device to use it here."),
        "license_disabled": CopyEntry("License disabled", "This license has been disabled. Contact the developer."),
        "license_expired": CopyEntry("License expired", "This license has expired. Renew it to continue."),
        "not_entitled": CopyEntry("Not included", "Your license doesn't include this."),
        "version_blocked": CopyEntry("Update required", "This version can't be used with your license. Update the app to continue."),
        "channel_not_allowed": CopyEntry("Channel not included", "Your license doesn't include this release channel."),
        "hardware_mismatch": CopyEntry("Device changed", "This device's hardware changed. Activate again to use your license here."),
        "fingerprint_required": CopyEntry("Device check failed", "This license needs a hardware fingerprint, which couldn't be read on this device."),
        "enroll_disabled": CopyEntry("No free license", "This app doesn't offer a free license. Enter a license key or sign in."),
        "enroll_claimed": CopyEntry("Sign in to continue", "This device's free license belongs to an account now. Sign in to use it."),
        "enroll_failed": CopyEntry("Couldn't get a free license", "A free license couldn't be issued. Try again in a few minutes."),
        "managed_by_admin": CopyEntry("Set by your organization", "This setting is managed by your organization and can't be changed here."),
        "catalog_unavailable": CopyEntry("Settings unavailable", "Settings can't be loaded right now. Try again in a few minutes."),
        "license_unusable": CopyEntry("License no longer valid", "Your license is no longer valid, so settings can't be loaded. Sign in or activate again."),
        "disabled": CopyEntry("Sign-in unavailable", "Sign-in isn't turned on for this app."),
        "oidc_error": CopyEntry("Sign-in failed", "Sign-in didn't finish. Try again."),
        "unavailable": CopyEntry("Sign-in unavailable", "Sign-in isn't available right now. Try again in a few minutes."),
        "auth_method_disabled": CopyEntry("Sign-in method unavailable", "That sign-in method is turned off. Choose another one."),
        "email_not_configured": CopyEntry("Email sign-in unavailable", "Email sign-in isn't available right now. Choose another sign-in method."),
        "license_owned": CopyEntry("License in another account", "This license is already in another Polaris Key account. A license never moves by its key: sign in to that account, or use a different key."),
        "email_mismatch": CopyEntry("Email not verified", "This license belongs to an email address your account hasn't verified. Add and verify that email, then try again."),
        "link_conflict": CopyEntry("Already linked", "That sign-in method belongs to another Polaris Key account. Sign in to that account, or join the two accounts."),
        "last_link": CopyEntry("Can't remove", "This is your account's only sign-in method. Add another one before removing it."),
        "step_up_required": CopyEntry("Sign in again", "For your security, sign in again to continue."),
        "not_eligible": CopyEntry("Offer unavailable", "This offer isn't available to your account anymore. Refresh and try again."),
        "download_auth_required": CopyEntry("Sign in to download", "Sign in or activate a license to download this."),
        "delivery_gate_missing": CopyEntry("Download unavailable", "This download isn't set up yet. Contact the developer."),
        "upstream_rate_limited": CopyEntry("Download busy", "Downloads are busy right now. Try again in a few minutes."),
        "server_misconfigured": CopyEntry("Service not set up", "This service isn't set up correctly. Contact the developer."),
        "internal_error": CopyEntry("Download failed", "The download server had a problem. Try again in a few minutes."),
        "release_record_rejected": CopyEntry("Release refused", "The release wasn't published because a check failed. The publish log names the check."),
        "release_tag_is_pack_release": CopyEntry("Release skipped", "A release was skipped because its tag matches a content pack release. Rename the tag."),
        "feed_not_composable": CopyEntry("Update check unavailable", "Updates can't be checked right now. Try again in a few minutes."),
        "service-unavailable": CopyEntry("Not available", "This app doesn't use this service."),
        "service-disabled": CopyEntry("Not available", "This service is turned off for this app."),
        "local-only": CopyEntry("Offline mode", "This app is running offline, so it didn't connect."),
        "insecure-base-url": CopyEntry("Insecure connection", "The app refused an insecure connection. Contact the developer."),
        "bundle-jws-rejected": CopyEntry("Activation file not valid", "The activation file's signature isn't valid."),
        "bundle-claims-rejected": CopyEntry("Activation file not valid", "The activation file is for another product or device, or it has expired."),
        "bundle-trust-rejected": CopyEntry("Activation file not trusted", "The activation file is signed by a key this app doesn't trust."),
        "inner-doc-rejected": CopyEntry("Activation file not valid", "The license inside the activation file isn't valid."),
        "bundle": CopyEntry("Activation file not valid", "The activation file couldn't be read."),
        "transport": CopyEntry("Connection problem", "Check your connection and try again."),
        "network": CopyEntry("Can't connect", "Can't reach Polaris Key. Check your connection and try again."),
        "refresh-failed": CopyEntry("Couldn't refresh", "Your license and settings couldn't be refreshed. Check your connection and try again."),
        "sync-failed": CopyEntry("Couldn't check your license", "Your license couldn't be checked, so the app can't start. Check your connection and try again."),
        "fetch-failed": CopyEntry("Content missing", "Required content couldn't be downloaded, so the app can't start. Check your connection and try again."),
        "bridge-missing": CopyEntry("App problem", "The app's licensing bridge is missing. Reinstall the app or contact the developer."),
        "unknown": CopyEntry("Something went wrong", "Something went wrong. Try again."),
        "release-refused": CopyEntry("Not included", "Your license doesn't include this release."),
        "bundle-rejected": CopyEntry("Activation file not valid", "The activation file was refused."),
        "bundle-import-unsupported": CopyEntry("Not available here", "Offline activation isn't available here."),
        "report-unsupported": CopyEntry("Not available here", "Device reports aren't available here."),
        "device-management-unsupported": CopyEntry("Not available here", "Devices can't be managed from here. Manage them in your account."),
        "device_list_failed": CopyEntry("Couldn't load devices", "Your devices couldn't be loaded. Check your connection and try again."),
        "device_rename_failed": CopyEntry("Couldn't rename", "The device couldn't be renamed. Try again."),
        "device_deauthorize_failed": CopyEntry("Couldn't remove device", "The device couldn't be removed. Try again."),
        "key-entry-unsupported": CopyEntry("Not available here", "License keys can't be entered here. Sign in instead."),
        "sign-in-failed": CopyEntry("Sign-in failed", "Sign-in didn't finish. Try again."),
        "sign-out-failed": CopyEntry("Sign-out failed", "Sign-out didn't finish. Try again."),
        "bad_response": CopyEntry("Unexpected answer", "The service sent an answer the app couldn't use. Try again."),
        "network-error": CopyEntry("Can't connect", "Can't reach Polaris Key. Check your connection and try again."),
        "server-error": CopyEntry("Service problem", "The service had a problem. Trying again…"),
        "cancelled": CopyEntry("Sign-in cancelled", "Sign-in was cancelled."),
        "sign-in-expired": CopyEntry("Code expired", "The code expired before sign-in finished. Start again."),
        "sign-in-denied": CopyEntry("Sign-in declined", "Sign-in was declined. Start again."),
        "sign-in-unavailable": CopyEntry("Sign-in unavailable", "Sign-in isn't available right now. Try again in a few minutes."),
        "invalid-options": CopyEntry("App not set up", "The app's licensing isn't set up correctly. Contact the developer."),
        "not-configured": CopyEntry("App not set up", "The app's licensing isn't set up yet. Contact the developer."),
        "unsupported": CopyEntry("Not available here", "This isn't available here."),
        "timeout": CopyEntry("Timed out", "The service took too long to answer. Check your connection and try again."),
        "response-too-large": CopyEntry("Unexpected answer", "The service sent an answer the app couldn't use. Try again."),
        "too-many-redirects": CopyEntry("Connection problem", "The connection was redirected too many times. Try again."),
        "insecure-redirect": CopyEntry("Insecure connection", "The app refused an insecure redirect."),
        "http-error": CopyEntry("Service problem", "The service answered with an error. Try again."),
        "invalid-response": CopyEntry("Unexpected answer", "The service sent an answer the app couldn't use. Try again."),
        "store-failed": CopyEntry("Storage problem", "The app couldn't read or save its license on this device. Check that the app can write its data folder."),
        "platform-error": CopyEntry("Platform problem", "The platform reported an error. Try again."),
        "no-token": CopyEntry("Not activated", "This device isn't activated yet. Activate it or sign in."),
        "mint-unavailable": CopyEntry("Not available", "This isn't available for this app."),
        "feed-rejected": CopyEntry("Update check failed", "The update information couldn't be verified, so nothing was installed."),
        "feed-rollback": CopyEntry("Update check failed", "The update information was older than what this device already has, so it was refused."),
        "record-rejected": CopyEntry("Update not verified", "The update couldn't be verified, so it wasn't installed."),
        "record-mismatch": CopyEntry("Update not verified", "The update didn't match what was published, so it wasn't installed."),
        "payload-mismatch": CopyEntry("Download corrupted", "The update didn't download correctly, so it wasn't installed. Try again."),
        "swap-refused": CopyEntry("Can't update here", "This installation can't update itself. Update it the way you installed it."),
        "swap-failed": CopyEntry("Update not finished", "The update couldn't be applied. It will be tried again next launch."),
        "files-index-invalid": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "files-unsafe-path": CopyEntry("Content refused", "Some content was refused because it contains an unsafe file path."),
        "files-duplicate-path": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "files-case-collision": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "files-path-conflict": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "files-layout-mismatch": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "content-stamp-invalid": CopyEntry("App build problem", "This build's content information isn't valid. Reinstall the app or contact the developer."),
        "full-corrupt": CopyEntry("Download corrupted", "Some content couldn't be installed. It will be downloaded again next time."),
        "delta-artifact-mismatch": CopyEntry("Download corrupted", "Some content couldn't be installed. It will be downloaded again next time."),
        "delta-base-mismatch": CopyEntry("Content changed", "Installed content changed on this device, so a full download is needed."),
        "delta-apply-failed": CopyEntry("Update not applied", "Some content couldn't be installed. It will be downloaded again next time."),
        "file-corrupt": CopyEntry("Download corrupted", "Some content couldn't be installed. It will be downloaded again next time."),
        "file-source-missing": CopyEntry("Content missing", "Some content couldn't be installed. It will be downloaded again next time."),
        "payload-hash-mismatch": CopyEntry("Download corrupted", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-ref-mismatch": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-bad-length": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-bad-magic": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-unsupported-version": CopyEntry("Content not supported", "This content needs a newer version of the app. Update the app."),
        "chunks-bad-record-size": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-bad-flags": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-reserved-nonzero": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-zero-length": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-bad-clen": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-bad-bundle-ref": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-bad-bundle-range": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-size-mismatch": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunks-payload-mismatch": CopyEntry("Content not valid", "Some content couldn't be installed. It will be downloaded again next time."),
        "chunk-bundle-truncated": CopyEntry("Download interrupted", "A download was cut short. Check your connection and try again."),
        "chunk-corrupt": CopyEntry("Download corrupted", "Some content couldn't be installed. It will be downloaded again next time."),
        "plan-transport-unsupported": CopyEntry("Can't download here", "This content can't be downloaded on this platform."),
        "plan-insufficient-disk": CopyEntry("Not enough space", "There isn't enough free space for this content. Free up some space and try again."),
        "plan-no-strategy": CopyEntry("Can't install content", "This content can't be installed on this device."),
        "pack-no-variant": CopyEntry("Content not available", "This content isn't available for this device."),
        "pack-type-unsupported": CopyEntry("Content not supported", "This content needs a newer version of the app. Update the app."),
        "pack-type-check-failed": CopyEntry("Content not valid", "Some content failed its check and wasn't installed."),
        "pack-not-pinned": CopyEntry("Content not available", "This content isn't part of this version of the app."),
        "pack-not-entitled": CopyEntry("Not included", "Your license doesn't include this content."),
        "pack-state-unreadable": CopyEntry("Storage problem", "Installed content couldn't be read, so nothing new was installed. Restart the app."),
        "pck-directory-refused": CopyEntry("Content refused", "Some content was refused because it contains files a content pack may not hold."),
        "pck-engine-mismatch": CopyEntry("Content not supported", "This content needs a different version of the game. Update the game."),
        "pack-rolled-back": CopyEntry("Content restored", "The last content update didn't start, so the previous version was restored."),
        "pack-revoked": CopyEntry("Content withdrawn", "This content was withdrawn by its developer and can't be used."),
        "pack-not-data-only": CopyEntry("Content refused", "Some content was refused because it contains files a data pack may not hold."),
        "marker-rejected": CopyEntry("App build problem", "This build's built-in content isn't valid. Reinstall the app or contact the developer."),
    }
)


#: Per licenseStatus.
COPY_GATE: Mapping[str, CopyEntry] = MappingProxyType(
    {
        "ok": CopyEntry("License active", "Your license is active."),
        "grace": CopyEntry("Offline grace", "The licensing service can't be reached. You can keep using the app until the grace period ends."),
        "expired": CopyEntry("License expired", "Your license has expired. Connect to the internet or renew it to continue."),
        "revoked": CopyEntry("Signed out", "This device was signed out. Sign in or activate again to continue."),
        "needs-activation": CopyEntry("Activate", "Enter a license key or sign in to continue."),
        "version-too-old": CopyEntry("Update required", "This version is no longer supported. Update the app to continue."),
        "version-too-new": CopyEntry("Not available on this license", "This build is newer than your license allows."),
        "channel-not-entitled": CopyEntry("Channel not included", "Your license doesn't include this release channel."),
        "not-applicable": CopyEntry("No license needed", "This app doesn't need a license."),
    }
)


#: Per activationResult.
COPY_ACTIVATION: Mapping[str, CopyEntry] = MappingProxyType(
    {
        "ok": CopyEntry("Activated", "Your license is active on this device."),
        "device-limit": CopyEntry("Device limit reached", "This license is already on all its devices. Replace a device to use it here."),
        "fingerprint-required": CopyEntry("Device check failed", "This license needs a hardware fingerprint, which couldn't be read on this device."),
        "hardware-mismatch": CopyEntry("Device changed", "This device's hardware changed. Activate again to use your license here."),
        "enroll-claimed": CopyEntry("Sign in to continue", "This device's free license belongs to an account now. Sign in to use it."),
        "license-disabled": CopyEntry("License disabled", "This license has been disabled. Contact the developer."),
        "license-expired": CopyEntry("License expired", "This license has expired. Renew it to continue."),
        "attestation-required": CopyEntry("Device check needed", "This license needs a verified device. Let the app check this device, then try again."),
        "rate-limited": CopyEntry("Too many attempts", "Too many attempts. Wait a moment and try again."),
        "unauthorized": CopyEntry("Key not accepted", "That license key wasn't accepted. Check it and try again."),
        "enroll-disabled": CopyEntry("No free license", "This app doesn't offer a free license. Enter a license key or sign in."),
        "refused": CopyEntry("Activation refused", "Activation was refused ({code})."),
        "error": CopyEntry("Activation failed", "Activation didn't finish. Check your connection and try again."),
    }
)
