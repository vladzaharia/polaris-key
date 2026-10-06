@tool
class_name PKeyUiCopy
extends Resource
## Every string the UI kit shows, as English defaults keyed by a stable snake_case name, each
## passed through `tr()` when it is shown. A game localises the kit with an ordinary Translation
## whose source strings are these English defaults (or with `overrides`), and renames anything
## without forking a scene:
##
##   var copy := PKeyUiCopy.new()
##   copy.overrides = {"activation_title": "Unlock Diceroll"}
##   $PKeyGate.copy = copy
##
## `text(key, args)` looks the key up in `overrides`, then in DEFAULTS, translates the template
## with `tr()` and only then formats it (`template % args`), so a translation keeps its
## placeholders. An unknown key is returned as itself, which a snapshot shows at once.
##
## The keys follow React's `PolarisThemeCopy` where a screen exists in both (update_title is
## React's updateTitle), so a product's copy reads the same on every surface.

const DEFAULTS := {
	# ── PKeyBoot ────────────────────────────────────────────────────────────────────────────
	"boot_starting": "Starting…",
	"boot_syncing": "Checking for updates…",
	"boot_gate": "Checking your license…",
	"boot_deciding": "Looking for a newer version…",
	"boot_fetching": "Downloading content…",
	"boot_mounting": "Loading…",
	"boot_ready": "Ready",
	"boot_offline_title": "You're offline",
	"boot_offline_body": "Connect to the internet and try again.",
	"boot_error_title": "Something went wrong",
	"boot_error_body": "The game couldn't finish starting (%s).",
	"boot_blocked_update_title": "Update required",
	"boot_blocked_update_body": "This version can no longer be played. Update the game to continue.",
	"boot_blocked_unavailable_title": "Not available on your license",
	"boot_blocked_unavailable_body": "This build isn't available on your license.",
	"boot_rolled_back": "The last update didn't start, so the previous version was restored.",
	"boot_consent_title": "Download content?",
	"boot_consent_body": "The game needs %s of new content.",
	"boot_consent_body_metered": "The game needs %s of new content, and you're on a mobile connection.",
	"boot_consent_download": "Download",
	"boot_consent_later": "Not now",
	"boot_declined_title": "Content not downloaded",
	"boot_declined_body": "The game needs this content to start. Try again when you're ready.",
	"boot_background": "Downloading content… %d%%",
	"retry": "Try again",
	"play_offline": "Play offline",
	"cancel": "Cancel",
	"close": "Close",
	# ── PKeyGate (React's LicenseGate copy) ─────────────────────────────────────────────────
	"gate_loading": "Checking your license…",
	"grace_title": "Offline grace",
	"grace_body": "The licensing service can't be reached. You can keep playing until the grace period ends.",
	"grace_blocked_body": "The licensing service can't be reached and this game needs it now. Connect and try again.",
	"expired_title": "License expired",
	"expired_body": "Connect to the internet to continue.",
	"revoked_title": "Signed out",
	"revoked_body": "This device was signed out. Sign in or activate again to continue.",
	"version_too_old_title": "Update required",
	"version_too_old_body": "This version is no longer supported. Please update the game.",
	"version_min": "Minimum version: %s",
	"not_available_title": "Not available on this license",
	"version_too_new_body": "This build is newer than your license allows.",
	"channel_not_entitled_body": "Your license doesn't include this release channel.",
	"gate_error_title": "Couldn't check your license",
	"gate_error_body": "Check your connection and try again.",
	# ── PKeyActivationPanel (Swift's PolarisLoginView copy is the model) ────────────────────
	"activation_title": "Activate",
	"activation_subtitle": "Enter a license key or sign in to continue.",
	"activation_subtitle_key": "Enter a license key to continue.",
	"activation_subtitle_sign_in": "Sign in to continue.",
	"key_label": "License key",
	"key_placeholder": "Paste your key",
	"key_submit": "Activate",
	"sign_in": "Sign in",
	"continue_free": "Continue free",
	"offline_activation": "Offline activation…",
	"activation_working": "Activating…",
	"activation_ok": "Activated.",
	"activation_key_empty": "Enter a license key first.",
	"activation_device_limit": "This license has reached its device limit.",
	"activation_device_limit_count": "This license has reached its device limit (%s of %s devices).",
	"activation_unauthorized": "That license key wasn't accepted.",
	"activation_fingerprint_required": "This license needs a hardware fingerprint, which couldn't be read on this device.",
	"activation_enroll_disabled": "This game doesn't offer a free tier.",
	"activation_enroll_claimed": "This device's free license belongs to an account now. Sign in to use it.",
	"activation_license_disabled": "This license has been disabled.",
	"activation_hardware_mismatch": "This device's hardware changed. The previous authorization was released — activate again to re-bind.",
	"activation_rate_limited": "Too many attempts. Wait a moment and try again.",
	"activation_unsupported": "This isn't available on this platform.",
	"activation_license_expired": "This license has expired. Renew it to keep playing.",
	"activation_attestation_required": "This game needs to confirm it was installed from an official store before it can be activated here.",
	"activation_manage_devices": "Manage devices",
	"activation_error": "Activation failed. Check your connection and try again.",
	"free_device": "Replace a device",
	"free_device_scan": "Scan with your phone to free a device, then try again.",
	# ── PKeySignInDialog ────────────────────────────────────────────────────────────────────
	"sign_in_title": "Sign in",
	"sign_in_starting": "Starting sign-in…",
	"sign_in_instructions": "Scan the code, or go to %s and enter:",
	"sign_in_open_browser": "Open browser",
	"sign_in_copy_link": "Copy link",
	"sign_in_copied": "Link copied.",
	"sign_in_expires": "The code expires in %s.",
	"sign_in_confirm_title": "Is this you?",
	"sign_in_confirm_body": "Signed in as %s.",
	"sign_in_attach": "Also attach this device's license to my account",
	"sign_in_continue": "Continue",
	"sign_in_ok": "Signed in.",
	"sign_in_expired": "The code expired before sign-in finished.",
	"sign_in_cancelled": "Sign-in was cancelled.",
	"sign_in_denied": "Sign-in was declined.",
	"sign_in_device_mismatch": "Sign-in finished for a different device. Try again on this one.",
	"sign_in_rate_limited": "Too many attempts. Wait a moment and try again.",
	"sign_in_unavailable": "Sign-in isn't available right now.",
	"sign_in_error": "Sign-in failed. Check your connection and try again.",
	# ── PKeyOfflineDialog ───────────────────────────────────────────────────────────────────
	"offline_title": "Offline activation",
	"offline_request": "Send this request code to whoever issues your license:",
	"offline_product": "Product: %s",
	"offline_copy_code": "Copy code",
	"offline_copied": "Code copied.",
	"offline_load_hint": "Then load the activation file you receive, or paste its text:",
	"offline_load_file": "Load file…",
	"offline_paste_placeholder": "Paste the activation text here",
	"offline_import": "Activate",
	"offline_drop_hint": "You can also drop the file onto this window.",
	"offline_ok": "Activated from the offline file.",
	"offline_empty": "Load or paste an activation file first.",
	"offline_unreadable": "That file couldn't be read.",
	"offline_not_bundle": "That doesn't look like an activation file.",
	"offline_jws_rejected": "The file's signature isn't valid.",
	"offline_claims_rejected": "The file is for another product or device, or it has expired.",
	"offline_trust_rejected": "The file is signed by a key this game doesn't trust.",
	"offline_inner_rejected": "The license inside the file isn't valid.",
	"offline_unsupported": "Offline activation isn't available on this platform.",
	# ── PKeySettingsPanel (React's ConfigPanel copy) ────────────────────────────────────────
	"settings_title": "Settings",
	"settings_empty": "There are no settings to show.",
	"settings_advanced": "Show advanced settings",
	"settings_reset": "Reset to default",
	"settings_set_by": "Set by %s",
	"settings_locked": "Locked",
	"settings_badge_local": "Changed by you",
	"settings_badge_env": "Set by the environment",
	"settings_badge_remote_default": "Default",
	"settings_badge_fallback": "Built-in default",
	# ── PKeyStatusBanner ────────────────────────────────────────────────────────────────────
	"banner_grace": "Offline — %s left",
	"banner_checked": "Checked %s ago",
	"banner_checked_now": "Checked just now",
	"banner_update": "An update is available",
	"duration_days": "%d days",
	"duration_day": "1 day",
	"duration_hours": "%d hours",
	"duration_hour": "1 hour",
	"duration_minutes": "%d minutes",
	"duration_minute": "1 minute",
	# ── PKeyUpdatePrompt (React's UpdatePrompt copy) ────────────────────────────────────────
	"update_title": "An update is available",
	"update_body": "A newer version of this game has been released.",
	"update_body_version": "A newer version of this game has been released (%s).",
	"update_action": "Get the update",
	"update_dismiss": "Not now",
	"update_up_to_date": "You're up to date.",
	"update_ready_title": "An update is ready",
	"update_ready_body": "Restart the game to finish updating.",
	"update_restart": "Restart now",
	"update_store": "Open the store",
	"update_testflight": "Open TestFlight",
	"update_altstore": "Open AltStore",
	"update_install": "Update now",
	"update_download": "Download the update",
	"update_reload": "Reload",
	"update_platform_steam": "A newer version is available. Steam installs it; restart Steam if it has not arrived.",
	"update_platform_itch": "A newer version is available. The itch app installs it.",
	"update_platform_store": "A newer version is available. Your software center installs it.",
	"update_platform_app_installer": "A newer version is available. Windows installs it the next time the game starts.",
	"update_platform_winget": "A newer version is available. Run winget upgrade to install it.",
	"update_platform_web": "A newer version is available. Reload the page to play it.",
	"update_platform_package": "A newer version is available. Your package manager installs it.",
	"update_platform_body": "A newer version is available. It installs through the store or platform you got this game from.",
	"update_mandatory_body": "This version is below the minimum supported version. Please update; you can keep playing until you do.",
	"update_blocked_title": "This version is no longer supported",
	"update_blocked_body": "This version is below the minimum supported version, and no update is available here yet. You can keep playing.",
	"update_content_floor_body": "Some of this game's content needs a newer version. Please update; you can keep playing until you do.",
	"update_revoked_title": "Content withdrawn",
	"update_revoked_body": "Some of this game's content was withdrawn by its developer and can't be used. Update the app to keep playing.",
	# ── PKeyEntitlementBadge ────────────────────────────────────────────────────────────────
	"badge_included": "Included with %s",
	# ── PKeyDevMenuSection ──────────────────────────────────────────────────────────────────
	"dev_title": "Polaris Key",
	"dev_channel": "Channel",
	"dev_channel_locked": "Locked: this build's channel is set by its outlet (%s).",
	"dev_build": "Build",
	"dev_outlet": "Outlet",
	"dev_sdk": "SDK",
	"dev_engine": "Engine",
	"dev_device": "Device",
	"dev_gate": "License",
	"dev_last_sync": "Last sync",
	"dev_never": "never",
	"dev_copy": "COPY DIAGNOSTICS",
	"dev_copied": "Diagnostics copied.",
	"dev_force_check": "Force check",
	"dev_checking": "Checking…",
	"dev_checked": "Checked: %s",
	# ── Error copy by code (SDK parity §3.2, core.copy). `PKeyUiCopy.code_key(code, reason)`
	# picks `reason_<reason>`, then `error_<code>`, then `error_generic` with the code, so a raw
	# server body is never shown. Codes are the registry's (conformance/parity/errors.json).
	# In English an `error_<code>` key shows the core copy (PKeyCopy, generated from
	# copy.en.json); these lines stay as the source strings the kit's .po files translate. ──
	"error_generic": "Something went wrong (%s).",
	"error_unauthorized": "You're signed out. Activate or sign in again.",
	"error_forbidden": "This isn't allowed for your license.",
	"error_not_found": "That couldn't be found.",
	"error_bad_request": "The request wasn't accepted. Update the game and try again.",
	"error_rate_limited": "Too many attempts. Wait a moment and try again.",
	"error_device_limit": "This license has reached its device limit.",
	"error_license_disabled": "This license has been disabled.",
	"error_license_expired": "This license has expired.",
	"error_not_entitled": "Your license doesn't include this.",
	"error_version_blocked": "This version is no longer supported. Please update the game.",
	"error_channel_not_allowed": "Your license doesn't include this release channel.",
	"error_hardware_mismatch": "This device's hardware changed. Activate again to re-bind it.",
	"error_fingerprint_required": "This license needs a hardware fingerprint, which couldn't be read on this device.",
	"error_enroll_disabled": "This game doesn't offer a free tier.",
	"error_enroll_claimed": "This device's free license belongs to an account now. Sign in to use it.",
	"error_registration_closed": "New devices can't join right now. Activate with a license key or sign in.",
	"error_managed_by_admin": "This setting is managed by your organization and can't be changed here.",
	"error_attestation_required": "This needs a device that was installed from an official store.",
	"error_attestation_rejected": "This device couldn't be verified as an official store install.",
	"error_attestation_unavailable": "Device verification isn't set up for this game yet.",
	"error_catalog_unavailable": "Settings aren't available right now. Try again later.",
	"error_value_not_representable": "That value couldn't be issued. Try again later.",
	"error_document_not_representable": "That value couldn't be issued. Try again later.",
	"error_mint-unavailable": "This value can't be issued on this device.",
	"error_unavailable": "The store couldn't be reached. Try again later.",
	"error_download_auth_required": "Sign in or activate to download this.",
	"error_internal_error": "The service had a problem. Try again later.",
	"error_network-error": "Couldn't connect. Check your connection and try again.",
	"error_timeout": "The connection timed out. Try again.",
	"error_service-unavailable": "This isn't enabled for this game.",
	"error_no-token": "Activate or sign in first.",
	"error_local-only": "This copy runs offline only.",
	"error_unsupported": "This isn't available on this platform.",
	"error_not-configured": "Polaris Key isn't set up yet.",
	"error_store-failed": "Your license couldn't be saved on this device.",
	"error_pack-not-entitled": "Your license doesn't include this content.",
	"error_pack-not-pinned": "This content isn't part of this build.",
	"error_pack-revoked": "This content was withdrawn by its developer.",
	"error_pack-type-unsupported": "This content can't be used on this platform.",
	"error_pack-no-variant": "This content isn't available for this device.",
	"error_pack-rolled-back": "The last content update didn't load, so the previous version was restored.",
	"error_plan-insufficient-disk": "There isn't enough free space for this content.",
	"error_payload-hash-mismatch": "The download was damaged. Try again.",
	# Commerce refusals carry a reason (detail.error.reason) that is more specific than the code.
	"reason_no_license": "Activate this device or continue free before buying.",
	"reason_binding_mismatch": "This purchase belongs to a different license.",
	"reason_bound_elsewhere": "This purchase is already linked to another license.",
	"reason_unbound": "This purchase wasn't linked to your license. Restore purchases to try again.",
	"reason_not_owned": "This purchase couldn't be found on your store account.",
	"reason_test_purchase": "Test purchases don't unlock this build.",
	"reason_invalid_ticket": "The store couldn't confirm your purchase. Try again.",
	"reason_untrusted_chain": "The store's receipt couldn't be verified.",
	"reason_wrong_app": "This purchase is for another app.",
	"reason_environment": "This purchase was made in a different store environment.",
	# ── PKeyDeviceList ──────────────────────────────────────────────────────────────────────
	"devices_title": "Devices",
	"devices_loading": "Loading devices…",
	"devices_empty": "No devices are using this license.",
	"devices_this_device": "This device",
	"devices_last_seen": "Last seen %s",
	"devices_rename": "Rename",
	"devices_rename_save": "Save",
	"devices_remove": "Remove",
	"devices_remove_confirm": "Remove %s? It will need to be activated again.",
	"devices_sign_out": "Sign out this device",
	"devices_unsupported": "Devices can be managed from your account page.",
	"devices_manage_online": "Manage devices online",
	"devices_refresh": "Refresh",
	# ── PKeyAccount ─────────────────────────────────────────────────────────────────────────
	"account_signed_in_as": "Signed in as %s",
	"account_key_only": "Activated with a license key",
	"account_signed_out": "Not activated",
	"account_tier": "Plan: %s",
	"account_sign_out": "Sign out",
	"account_deactivate": "Deactivate this device",
	"account_sign_out_confirm": "Sign out on this device? You'll need to sign in or activate again.",
	"account_manage": "Manage account",
	"account_signed_out_done": "Signed out.",
	# ── PKeyPackProgress ────────────────────────────────────────────────────────────────────
	"packs_title": "Downloading content",
	"packs_queued": "Waiting to download…",
	"packs_downloading": "Downloading… %d%%",
	"packs_applying": "Installing…",
	"packs_ready": "Content ready.",
	"packs_failed": "The content couldn't be downloaded.",
	# ── PKeyWhatsNew ────────────────────────────────────────────────────────────────────────
	"whats_new_title": "What's new",
	"whats_new_loading": "Loading release notes…",
	"whats_new_empty": "No release notes yet.",
	"whats_new_version": "Version %s",
	"whats_new_refused": "Release notes aren't available right now.",
	# ── PKeyPurchaseButton ──────────────────────────────────────────────────────────────────
	"purchase_buy": "Buy",
	"purchase_buying": "Purchasing…",
	"purchase_owned": "Purchased",
	"purchase_restore": "Restore purchases",
	"purchase_restoring": "Restoring…",
	"purchase_restored": "Purchases restored.",
	"purchase_nothing_to_restore": "There were no purchases to restore.",
	"purchase_not_owned": "The purchase didn't complete.",
	"purchase_cancelled": "The purchase was cancelled.",
	"purchase_unsupported": "Purchases aren't available in this version of the game.",
	# ── PKeyChannelPicker ───────────────────────────────────────────────────────────────────
	"channel_title": "Release channel",
	"channel_locked": "This build's channel is set by where you got it (%s).",
	"channel_restart": "The new channel applies at the next update check.",
	# ── PKeyUpdatePrompt additions ──────────────────────────────────────────────────────────
	"update_notes": "What's new",
	"update_downloading": "Downloading the update… %d%%",
}

## key -> replacement English (or already-translated) template.
@export var overrides: Dictionary = {}

static var _shared: PKeyUiCopy = null


## The copy every scene uses until it is given its own.
static func shared() -> PKeyUiCopy:
	if _shared == null:
		_shared = PKeyUiCopy.new()
	return _shared


## The English template for `key` (an override first), before translation.
func template(key: String) -> String:
	return _resolve(key)[0]


## The string to show: the template translated with `tr()`, then formatted with `args` (a value
## or an Array) when given. A sentence from the core copy has its `{name}` placeholders filled
## (`{code}` with the code) after translation.
func text(key: String, args: Variant = null) -> String:
	var r := _resolve(key)
	var s := tr(r[0])
	if r[1] != "":
		s = PKeyCopy.fill(s, r[1])
	if args == null:
		return s
	return s % (args if args is Array else [args])


## [template, core code] for `key`. An `error_<code>` key reads the core copy (PKeyCopy.shared(),
## the generated table plus the host's core overrides) where the code exists there, in this
## order: this object's `overrides`, a core host override, the kit's own line when the running
## locale translates it (the kit's .po files carry those until the core copy has its own
## translations), the core copy, the kit's own line. The core code is "" for a kit template.
func _resolve(key: String) -> Array:
	if overrides.get(key) is String:
		return [overrides[key], ""]
	var own := String(DEFAULTS.get(key, key))
	if not key.begins_with("error_") or key == "error_generic":
		return [own, ""]
	var code := key.substr(6)
	var core := PKeyCopy.shared()
	if core.has_override(code):
		return [core.message_template(code), code]
	if DEFAULTS.has(key) and tr(own) != own:
		return [own, ""]
	if core.has(code):
		return [core.message_template(code), code]
	return [own, ""]


## [copy key, args] for an error code (and an optional reason, as commerce refusals carry):
## `reason_<reason>`, then `error_<code>` (a kit line or a core copy entry, see _resolve), then
## `error_generic` with the code (SDK parity §3.2: a missing code falls back to a generic message
## plus the code, never the raw body).
static func code_key(code: Variant, reason: Variant = "") -> Array:
	var r := str(reason) if reason != null else ""
	if r != "" and DEFAULTS.has("reason_" + r):
		return ["reason_" + r, null]
	var c := str(code) if code != null else ""
	if c != "" and (DEFAULTS.has("error_" + c) or PKeyCopy.shared().has(c)):
		return ["error_" + c, null]
	return ["error_generic", c if c != "" else "unknown"]


## The shown message for an error code (see code_key).
func for_code(code: Variant, reason: Variant = "") -> String:
	var k := code_key(code, reason)
	return text(k[0], k[1])


## The shown message for a failed PKeyResult: its code, and `detail.error.reason` or
## `detail.reason` when the server sent one.
func for_result(r: PKeyResult) -> String:
	if r == null:
		return for_code("unknown")
	var reason := ""
	if r.detail is Dictionary:
		var e = r.detail.get("error")
		if e is Dictionary and e.get("reason") is String:
			reason = e["reason"]
		elif r.detail.get("reason") is String:
			reason = r.detail["reason"]
	return for_code(r.code, reason)


## A duration in whole days, else hours, else minutes ("3 days", "1 hour"), for the banner.
func duration(seconds: float) -> String:
	var s := maxf(seconds, 0.0)
	var days := int(floor(s / 86400.0))
	if days >= 1:
		return text("duration_day") if days == 1 else text("duration_days", days)
	var hours := int(floor(s / 3600.0))
	if hours >= 1:
		return text("duration_hour") if hours == 1 else text("duration_hours", hours)
	var minutes := maxi(int(floor(s / 60.0)), 1)
	return text("duration_minute") if minutes == 1 else text("duration_minutes", minutes)
