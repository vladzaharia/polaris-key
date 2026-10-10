extends RefCounted
## DL14: QR codes and links fail closed: the port of ui-core's `link.ts`.
##
## A link is shown, encoded or opened only after it passes client-core's one validating opener
## (`PKeyManage.is_valid`): an absolute `https:` URL, or `http:` to a loopback host, with no
## userinfo and no whitespace. A missing or invalid link hides its control and its QR and leaves
## the rest of the screen working: a kit never makes up a URL. A QR appears only where the device
## cannot browse (a TV, a pad-only screen) or for an offline-activation request.

const Context := preload("res://addons/polaris_key/ui/model/context.gd")

static var _scheme := RegEx.create_from_string("^[A-Za-z][A-Za-z0-9+.-]*:")


## The link to open for `raw`, or null. An integrator's `deviceCodeUrl` may be written without a
## scheme (`driftkart.gg/tv`); it is read as `https://`, never as `http://`.
static func valid_link(raw: Variant) -> Variant:
	if not (raw is String) or (raw as String).is_empty():
		return null
	var candidate: String = raw if _scheme.search(raw) != null else "https://" + raw
	return candidate if PKeyManage.is_valid(candidate) else null


## The address as people read it: the scheme and a trailing slash dropped.
static func display_link(url: String) -> String:
	var out := url
	var lower := out.to_lower()
	if lower.begins_with("https://"):
		out = out.substr(8)
	elif lower.begins_with("http://"):
		out = out.substr(7)
	if out.ends_with("/"):
		out = out.left(out.length() - 1)
	return out


## True when a QR may be drawn for `purpose` on `platform` (DL14 "Where"). Purposes: `sign-in`,
## `replace-device`, `manage`, `purchase`, `offline-request`.
static func qr_allowed(platform: Variant, purpose: String) -> bool:
	if purpose == "offline-request":
		return true
	if purpose == "purchase":
		return false
	var c := Context.platform_class(platform)
	return c == "tv" or c == "console"


## The verdict for one link on one platform: `{purpose, url, display, open, qr}`.
static func verdict(raw: Variant, platform: Variant, purpose: String) -> Dictionary:
	var url = valid_link(raw)
	return {
		"purpose": purpose,
		"url": url,
		"display": null if url == null else display_link(url),
		"open": url != null and Context.can_browse(platform),
		"qr": url != null and qr_allowed(platform, purpose),
	}


## DL14 "Expiry": at 0:00 the code view switches to expired locally while any poll finishes.
static func code_expired(seconds_left: Variant) -> bool:
	return seconds_left != null and float(seconds_left) <= 0.0


## `m:ss` for a countdown.
static func countdown(seconds: float) -> String:
	var s := maxi(0, ceili(seconds))
	return "%d:%02d" % [s / 60, s % 60]
