class_name PKeyPortal
extends RefCounted
## `PolarisKey.portal`: links into the customer portal (SDK parity §3.5), for "Manage devices",
## "Manage account", "Buy" and "Download" buttons. Built from the configured base URL and the
## portal's shipped routes (packages/admin/src/portal/router.ts):
##
##   url("account")                          <base>/#/account
##   url("library")                          <base>/#/
##   url("activate", {key = k})              <base>/#/?activate=<k>
##   url("devices")                          <base>/#/p/<product>/devices
##   url("free-device", {for = label, return_to = url})
##                                           <base>/#/p/<product>/free-device?for=&return=
##   url("download", {platform = "windows"}) <base>/#/p/<product>/download?platform=
##
## `return_to` is offered to the portal, which follows it only when it matches the product's
## declared return URLs; anything that is not an absolute http(s) or custom-scheme URL is dropped
## here. "" for an unknown flow or before configure(). `open(flow, opts)` opens it in the system
## browser. The routes are the portal's public contract until the Worker hands out its own
## manage URL (PX-W8), which then wins.

const FLOWS := ["account", "library", "activate", "devices", "free-device", "freeDevice", "download"]
## The device label the free-device flow shows is cut to this many characters (the portal's).
const MAX_FOR := 64

var _core_ref: WeakRef = null


func attach(core: PKeyCore) -> void:
	_core_ref = weakref(core)


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## The portal URL for `flow` (see the class doc). Options: key, for, return_to, platform.
func url(flow: String, opts: Dictionary = {}) -> String:
	var core := _core()
	if core == null:
		return ""
	return build(core.base_url, core.product, flow, opts)


## Open url(flow, opts) in the system browser: the OS.shell_open error, or ERR_INVALID_PARAMETER
## when there is no URL.
func open(flow: String, opts: Dictionary = {}) -> int:
	var u := url(flow, opts)
	return OS.shell_open(u) if u != "" else ERR_INVALID_PARAMETER


## The URL itself, from a base URL and product slug (pure; tests and custom hosts).
static func build(base_url: String, product: String, flow: String, opts: Dictionary = {}) -> String:
	var base := base_url.rstrip("/")
	if base == "" or not FLOWS.has(flow):
		return ""
	var p := PKeyUri.component(product)
	match flow:
		"account":
			return "%s/#/account" % base
		"library":
			return "%s/#/" % base
		"activate":
			var key := str(opts.get("key", ""))
			return "%s/#/?activate=%s" % [base, PKeyUri.form(key)]
		"devices":
			return "%s/#/p/%s/devices" % [base, p]
		"free-device", "freeDevice":
			var q: Array = []
			var label := str(opts.get("for", "")).strip_edges().substr(0, MAX_FOR)
			if label != "":
				q.append("for=%s" % PKeyUri.form(label))
			var ret := str(opts.get("return_to", ""))
			if acceptable_return(ret):
				q.append("return=%s" % PKeyUri.form(ret))
			return "%s/#/p/%s/free-device%s" % [base, p, ("?" + "&".join(q)) if not q.is_empty() else ""]
		"download":
			var plat := str(opts.get("platform", ""))
			return "%s/#/p/%s/download%s" % [base, p, ("?platform=" + PKeyUri.form(plat)) if plat != "" else ""]
	return ""


## An absolute http(s) URL or a custom-scheme deep link (`mygame://…`); never a relative or
## javascript: URL.
static func acceptable_return(u: String) -> bool:
	if u == "" or u.length() > 2048:
		return false
	var re := RegEx.create_from_string("^([a-zA-Z][a-zA-Z0-9+.-]*):")
	var m := re.search(u)
	if m == null:
		return false
	var scheme := m.get_string(1).to_lower()
	if scheme in ["javascript", "data", "vbscript", "file"]:
		return false
	if scheme == "http" or scheme == "https":
		return u.substr(scheme.length()).begins_with("://")
	return true
