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
	"activation_error": "Activation failed. Check your connection and try again.",
	# ── PKeySignInDialog ────────────────────────────────────────────────────────────────────
	"sign_in_title": "Sign in",
	"sign_in_starting": "Starting sign-in…",
	"sign_in_instructions": "Scan the code, or go to %s and enter:",
	"sign_in_open_browser": "Open browser",
	"sign_in_copy_link": "Copy link",
	"sign_in_copied": "Link copied.",
	"sign_in_expires": "The code expires in %s.",
	"sign_in_device": "The sign-in page will show “%s”.",
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
	if overrides.get(key) is String:
		return overrides[key]
	return String(DEFAULTS.get(key, key))


## The string to show: the template translated with `tr()`, then formatted with `args` (a value
## or an Array) when given.
func text(key: String, args: Variant = null) -> String:
	var s := tr(template(key))
	if args == null:
		return s
	return s % (args if args is Array else [args])


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
