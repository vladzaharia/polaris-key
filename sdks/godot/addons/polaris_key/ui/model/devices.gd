extends RefCounted
## The deviceLimit and devices families (ui-matrix.json `deviceLimit`, `devices`): Replace a
## device (PORTAL §4.25, SIGN-IN.md §3.7, D-08) and the license's device list, the port of
## ui-core's `models/devices.ts`. Replacing another device never touches this device's files;
## "This device" shows only when the runtime knows it.

const Context := preload("res://addons/polaris_key/ui/model/context.gd")
const Link := preload("res://addons/polaris_key/ui/model/link.gd")
const Loading := preload("res://addons/polaris_key/ui/model/loading.gd")
const View := preload("res://addons/polaris_key/ui/model/view.gd")

# ── DeviceLimit ───────────────────────────────────────────────────────────────────────────────
#
# States: default, busy, removed, failed, browser-mode, hidden.


## The device a Replace preselects: the least recently used one that is not this device, or null.
## A device is `{name, platform, formFactor, lastSeenDays, current}` (`vocabulary.inputs`).
static func least_recent(devices: Array) -> Variant:
	var pick = null
	for d in devices:
		if not (d is Dictionary):
			continue
		if not View.truthy(d.get("current")) and (
			pick == null or _last_seen(d) > _last_seen(pick)
		):
			pick = d
	return pick


## TS `d.lastSeenDays ?? -1`.
static func _last_seen(d: Dictionary) -> float:
	var days = d.get("lastSeenDays")
	return float(days) if (days is float or days is int) else -1.0


## The focused Replace a device flow on the key path.
static func device_limit_view(ctx: RefCounted) -> Dictionary:
	if not ctx.on("license"):
		return View.hidden(ctx, "DeviceLimit")
	var a: Dictionary = ctx.member("activation")
	var product: String = View.identity_text(ctx)["name"]
	var args := {
		"product": product,
		"used": a.get("deviceCount"),
		"limit": a.get("limit"),
	}
	var replacement: Dictionary = ctx.member("replacement")
	if replacement.get("outcome") == "done":
		return View.make(ctx, "DeviceLimit", {
			"state": "removed",
			"copy": ["deviceLimit.removed"],
			"args": _with(args, {"device": replacement.get("device")}),
		})
	if replacement.get("outcome") == "failed":
		return View.make(ctx, "DeviceLimit", {
			"state": "failed",
			"copy": ["deviceLimit.failed", "common.tryAgain"],
			"args": _with(args, {"device": replacement.get("device")}),
			"primary": "common.tryAgain",
			"tone": "danger",
			"errorSlot": "deviceLimit.primary",
		})
	if ctx.input.get("pending") == "replace":
		return View.make(ctx, "DeviceLimit", {
			"state": "busy",
			"copy": ["deviceLimit.primary", "common.working", "a11y.busy"],
			"args": args,
			"primary": "deviceLimit.primary",
		})
	var devices = ctx.input.get("devices")
	var link := Link.verdict(a.get("manageUrl"), ctx.platform, "replace-device")
	# Layer 1 has no device list on the key path: Replace a device opens the link (PX-W8), as a
	# QR on a TV or a console.
	if link["url"] != null and not View.truthy(devices):
		var c := Context.platform_class(ctx.platform)
		var tv := c == "tv" or c == "console"
		return View.make(ctx, "DeviceLimit", {
			"state": "browser-mode",
			"copy": [
				"deviceLimit.title",
				"deviceLimit.browser",
				"deviceLimit.scan" if tv else "deviceLimit.openBrowser",
				"a11y.qr" if tv else "a11y.externalLink",
			],
			"args": args,
			"primary": null if tv else "deviceLimit.openBrowser",
			"tone": "neutral",
			"link": link,
		})
	var list: Array = devices if devices is Array else []
	var pick = least_recent(list)
	var known: bool = a.get("limit") != null
	var listed := list.size() > 0
	var picked: bool = pick != null
	return View.make(ctx, "DeviceLimit", {
		"state": "default",
		"copy": [
			"deviceLimit.title",
			"deviceLimit.heading",
			"deviceLimit.lede",
			"part.seatMeter.caption" if known else null,
			"a11y.seatMeter" if known else null,
			"signin.replace.meta" if listed else null,
			"a11y.formFactor" if listed else null,
			"signin.replace.leastRecent" if picked else null,
			"deviceLimit.confirmTitle" if picked else null,
			"deviceLimit.consequence" if picked else null,
			"deviceLimit.primary",
			"common.back",
		],
		"args": _with(args, {"device": pick.get("name") if picked else null}),
		# A full license is a limit, not an error: Replace and continue is its fix (DL6).
		"primary": "deviceLimit.primary",
		"tone": "neutral",
	})


## TS `{...base, ...extra}`.
static func _with(base: Dictionary, extra: Dictionary) -> Dictionary:
	var out := base.duplicate()
	for k in extra:
		out[k] = extra[k]
	return out


# ── Devices ───────────────────────────────────────────────────────────────────────────────────
#
# States: loading, list, renaming, confirming, empty, browser-mode, error, hidden.


## The license's devices: rename and remove inline, "This device" only when known.
static func devices_view(ctx: RefCounted) -> Dictionary:
	if not ctx.on("license"):
		return View.hidden(ctx, "Devices")
	var devices = ctx.input.get("devices")
	var edit: Dictionary = ctx.member("edit")
	var error = ctx.input.get("error")
	if View.truthy(ctx.input.get("loading")):
		return View.make(ctx, "Devices", {
			"state": "loading",
			"copy": ["devices.title", "common.loading"] if Loading.visible(ctx.input.get("elapsedMs")) else [],
			"focus": null,
		})
	if View.truthy(error):
		# A failed load is an error state with Try again, never "No devices" (DL7); a failed edit's
		# message sits in its row.
		var pair: Array = (
			["devices.renameFailed", "devices.renameLabel"] if edit.get("kind") == "rename"
			else ["devices.removeFailed", "devices.remove"] if edit.get("kind") == "remove"
			else ["devices.loadFailed", "screen"]
		)
		return View.make(ctx, "Devices", {
			"state": "error",
			"copy": [pair[0], "common.tryAgain"],
			"args": {"device": edit.get("device")},
			"primary": "common.tryAgain",
			"tone": "danger",
			"errorSlot": pair[1],
		})
	if View.truthy(ctx.input.get("browserMode")):
		return View.make(ctx, "Devices", {
			"state": "browser-mode",
			"copy": ["devices.browser", "devices.manage", "a11y.externalLink"],
			"primary": "devices.manage",
		})
	if edit.get("kind") == "rename":
		return View.make(ctx, "Devices", {
			"state": "renaming",
			"copy": ["devices.renameLabel", "common.save", "common.cancel"],
			"args": {"device": edit.get("device")},
			"primary": "common.save",
			"focus": "devices.renameLabel",
		})
	if edit.get("kind") == "remove":
		return View.make(ctx, "Devices", {
			"state": "confirming",
			"copy": ["devices.removeConfirm", "devices.remove", "common.cancel"],
			"args": {"device": edit.get("device")},
			"primary": "devices.remove",
		})
	var list: Array = devices if devices is Array else []
	if list.is_empty():
		return View.make(ctx, "Devices", {
			"state": "empty",
			"copy": ["devices.empty"],
		})
	var any_current := false
	var any_unnamed := false
	for d in list:
		var row: Dictionary = d if d is Dictionary else {}
		if View.truthy(row.get("current")):
			any_current = true
		if not View.truthy(row.get("name")):
			any_unnamed = true
	return View.make(ctx, "Devices", {
		"state": "list",
		"copy": [
			"devices.title",
			"devices.lede",
			"devices.count",
			"devices.meta",
			"a11y.formFactor",
			"devices.rename",
			"devices.remove",
			"a11y.renameDevice",
			"a11y.removeDevice",
			# "This device" only when the runtime knows which row it is (Must not).
			"part.thisDeviceTitle" if any_current else null,
			"devices.unnamed" if any_unnamed else null,
		],
		"args": {"count": list.size()},
		# An embedded pane: row actions only, none filled; the heading takes focus.
	})
