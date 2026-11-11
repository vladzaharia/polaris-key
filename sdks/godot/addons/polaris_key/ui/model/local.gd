extends RefCounted
## Pair with a Code (ui-matrix.json `local`): the port of ui-core's `models/local.ts`. LocalPairing is
## the window two devices of one app on one network pair in by an 8-digit code or a QR with no
## account; PairedDevices is the list of what they paired. Rules the rows pin:
##   - the code is the largest thing on the show screen; nothing else takes focus first on confirm,
##     so a stray Enter never pairs, and Pair on the field's screen is the person's yes: the
##     categories come before it;
##   - a name the other device sent is unauthenticated text: it is isolated (`device` is in the
##     view's `isolate`) and never truncated in the consent title;
##   - Pair is drawn but unavailable (`disabled`) with its reason on screen when the field holds
##     fewer than 8 digits, the code that just failed, or a prefix with no dial left;
##   - after Too many tries the code stays gone for 30 seconds (the cooldown is the model's), and a
##     window that ran out has none;
##   - the Can connect switches show only when more than 8 devices are paired or one is off.
##
## `layout()` is the window rule for the show screen (UI-KITS 4.3, LocalPairing).

const View := preload("res://addons/polaris_key/ui/model/view.gd")
const Link := preload("res://addons/polaris_key/ui/model/link.gd")

## The most paired devices that can connect at once (`MAX_LIVE_LOCAL_ADVERTS`).
const MAX_CONNECTABLE := 8
## The most paired devices one device holds (`MAX_LOCAL_LINKS`).
const MAX_PAIRED := 32
## The longest name a person may give a paired device.
const MAX_NAME := 64
## Seconds a new code waits after Too many tries.
const COOLDOWN_SECONDS := 30

const FAILED_BODY := {
	"declined": "linkPairing.failedDeclined",
	"timeout": "linkPairing.failedTimeout",
	"full": "localPairing.failedFull",
	"closed": "linkPairing.failedClosed",
}

const NOTICE := {
	"not-found": ["pairedDevices.notFoundTitle", "pairedDevices.notFoundBody"],
	"busy": ["pairedDevices.busyTitle", "common.tryAgain"],
	"unknown": ["core.codes.link-unknown.title", "core.codes.link-unknown.message"],
}


static func _shares_key(categories: Variant) -> String:
	var n: int = (categories as Array).size() if categories is Array else 0
	return "linkPairing.sharesNone" if n == 0 else "linkPairing.shares"


static func _has(d: Dictionary, key: String) -> bool:
	return d.get(key) != null


static func _int(v: Variant) -> int:
	return int(v) if v != null else 0


## The pairing screens, by state.
static func local_pairing_view(ctx: RefCounted) -> Dictionary:
	var p: Variant = ctx.input.get("localPairing")
	if not ctx.on("connect") or not (p is Dictionary):
		return View.hidden(ctx, "LocalPairing")
	var dev: Variant = p.get("device")
	var device: Variant = (
		dev if dev is String and not (dev as String).strip_edges().is_empty() else null
	)
	var inline_name := String(View.identity_text(ctx)["inlineName"])
	var app: Variant = inline_name if inline_name != "" else null
	var c := "LocalPairing"
	var step := String(p.get("step", ""))
	var full: bool = p.get("full") == true
	match step:
		"choose":
			var pre: bool = p.get("prePrompt") == true
			return (
				View
				. make(
					ctx,
					c,
					{
						"state": "choose",
						"copy":
						[
							"localPairing.title",
							"localPairing.chooseBody",
							"localPairing.show",
							"localPairing.enter",
							"localPairing.prePrompt" if pre and not full else null,
							"core.codes.local-links-full.title" if full else null,
							"core.codes.local-links-full.message" if full else null,
							"localPairing.pairedDevices" if full else null,
							"common.cancel",
						],
						"args": {"app": app},
						"disabled": ["localPairing.show", "localPairing.enter"] if full else [],
						"tone": "neutral" if full else null,
						# Neither way is the primary: either device can show the code.
						"focus": "heading",
					}
				)
			)
		"opening":
			# The window is being opened: the code tile is a placeholder until the first code arrives.
			return (
				View
				. make(
					ctx,
					c,
					{
						"state": "opening",
						"copy":
						[
							"localPairing.title",
							"localPairing.showBody",
							"a11y.busy",
							"localPairing.toEnter",
							"common.cancel"
						],
						"focus": "heading",
					}
				)
			)
		"show":
			var n: Variant = p.get("notice")
			var renewing: bool = p.get("busy") == "new-code"
			var guessing: bool = n == "guessing"
			return (
				View
				. make(
					ctx,
					c,
					{
						"state": "show",
						"copy":
						[
							"localPairing.title",
							"localPairing.showBody",
							"a11y.linkCode" if View.truthy(p.get("code")) else null,
							"a11y.qrPairing",
							"localPairing.expires",
							"localPairing.waitingDevice",
							"localPairing.toEnter",
							"common.cancel",
							"localPairing.rotatedTitle" if n == "rotated" or guessing else null,
							(
								"localPairing.rotatedBody"
								if n == "rotated" or n == "declined"
								else null
							),
							"localPairing.notPairedWith" if n == "declined" else null,
							(
								"a11y.newCode"
								if n == "rotated" or n == "declined" or guessing
								else null
							),
							"localPairing.blockedTitle" if n == "blocked" else null,
							"localPairing.blockedBody" if n == "blocked" else null,
							"localPairing.tooManyAgainBody" if guessing else null,
							"localPairing.showNew" if n != null and n != "blocked" else null,
							"a11y.busy" if renewing else null,
						],
						"args":
						{
							"code": p.get("code"),
							"time": Link.countdown(float(_int(p.get("secondsLeft")))),
							"device": device
						},
						"disabled": ["localPairing.showNew"] if renewing else [],
						"tone": "neutral" if n != null else null,
						"focus": "heading",
					}
				)
			)
		"closed":
			var cooling := _int(p.get("cooldownLeft")) > 0
			var shown := "localPairing.showNewIn" if cooling else "localPairing.showNew"
			var warn: bool = p.get("warn") == true
			return (
				View
				. make(
					ctx,
					c,
					{
						"state": "closed",
						"copy":
						[
							"linkPairing.failedTitle",
							(
								"localPairing.failedTooMany"
								if p.get("closedBy") == "too-many-tries"
								else "localPairing.failedExpired"
							),
							"localPairing.tooManyAgainTitle" if warn else null,
							"localPairing.tooManyAgainBody" if warn else null,
							shown,
							"common.close",
						],
						"args": {"time": Link.countdown(float(_int(p.get("cooldownLeft"))))},
						"disabled": ["localPairing.showNewIn"] if cooling else [],
						"primary": shown,
						"tone": "neutral",
						# The primary cannot be pressed during the wait: focus rests on the heading.
						"focus": "heading" if cooling else shown,
					}
				)
			)
		"enter", "joining":
			var busy := step == "joining"
			var e: Variant = p.get("error")
			var tries: Variant = p.get("triesLeft")
			var spent := not busy and tries != null and _int(tries) == 0 and e == null
			var wrong_or_none: bool = e == "wrong" or e == null
			var danger: bool = e == "wrong" or e == "not-a-code"
			return (
				View
				. make(
					ctx,
					c,
					{
						"state": step,
						"copy":
						[
							"localPairing.title",
							"localPairing.enterBody",
							"localPairing.codeLabel",
							(
								"localPairing.codePlaceholder"
								if not busy and not View.truthy(p.get("entry"))
								else null
							),
							_shares_key(p.get("categories")),
							"localPairing.pair",
							"a11y.busy" if busy else "localPairing.toShow",
							"common.cancel" if busy else "common.back",
							"localPairing.wrongCode" if not busy and e == "wrong" else null,
							(
								"localPairing.triesLeft"
								if not busy and wrong_or_none and tries != null and _int(tries) == 1
								else null
							),
							(
								"localPairing.spentCode"
								if not busy and (e == "spent" or spent)
								else null
							),
							"localPairing.cooldownTitle" if not busy and e == "too-many" else null,
							"localPairing.cooldownBody" if not busy and e == "too-many" else null,
							"localPairing.notFoundTitle" if not busy and e == "not-found" else null,
							"localPairing.notFoundBody" if not busy and e == "not-found" else null,
							"localPairing.notACode" if not busy and e == "not-a-code" else null,
						],
						"args": {"left": tries},
						"disabled":
						["localPairing.pair"] if busy or p.get("pairDisabled") == true else [],
						"primary": "localPairing.pair",
						"tone": "danger" if danger else null,
						"errorSlot": "localPairing.codeLabel" if danger else null,
						# The field takes focus on a fine pointer (DL9 sends a coarse one to the heading); a
						# busy Pair keeps it, so the screen reader keeps its place.
						"focus": "localPairing.pair" if busy else "localPairing.codeLabel",
					}
				)
			)
		"confirm":
			var busy_press: bool = p.get("busy") != null
			return (
				View
				. make(
					ctx,
					c,
					{
						"state": "confirm",
						"copy":
						[
							(
								"localPairing.confirmTitle"
								if device != null
								else "localPairing.confirmUnnamed"
							),
							"localPairing.confirmBody",
							_shares_key(p.get("categories")),
							"localPairing.pair",
							"common.notNow",
							"a11y.busy" if busy_press else null,
						],
						"args": {"device": device},
						# A press is being answered: both controls wait, whichever was pressed.
						"disabled": ["localPairing.pair", "common.notNow"] if busy_press else [],
						"primary": "localPairing.pair",
						# Not now first, behind the 250 ms guard: Enter on arrival never pairs.
						"focus": "common.notNow",
					}
				)
			)
		"waiting":
			return (
				View
				. make(
					ctx,
					c,
					{
						"state": "waiting",
						"copy":
						[
							"linkPairing.waiting",
							"localPairing.waitingWith" if device != null else null,
							_shares_key(p.get("categories")),
							"common.cancel"
						],
						"args": {"device": device},
						"focus": "heading",
					}
				)
			)
		"paired":
			var cant: bool = p.get("cantConnect") == true
			var name_error: bool = p.get("nameError") != null
			var mx: Variant = p.get("max")
			return (
				View
				. make(
					ctx,
					c,
					{
						"state": "paired",
						"copy":
						[
							"localPairing.pairedTitle",
							"localPairing.pairedBody",
							"localPairing.nameLabel",
							"localPairing.nameHint",
							"localPairing.cantConnectTitle" if cant else null,
							"localPairing.cantConnectBody" if cant else null,
							"localPairing.pairedDevices" if cant else null,
							"devices.renameFailed" if name_error else null,
							"common.done",
						],
						"args":
						{
							"device": device if device != null else "",
							"max": mx if mx != null else MAX_CONNECTABLE
						},
						"primary": "common.done",
						"tone": "danger" if name_error else ("neutral" if cant else null),
						"errorSlot": "localPairing.nameLabel" if name_error else null,
						"focus": "heading",
					}
				)
			)
		"failed":
			var reason := String(p.get("reason", "closed"))
			return (
				View
				. make(
					ctx,
					c,
					{
						"state": "failed",
						"copy":
						[
							"linkPairing.failedTitle",
							FAILED_BODY.get(reason, FAILED_BODY["closed"]),
							"common.tryAgain",
							"common.close"
						],
						# "full" cannot succeed until a pairing is forgotten: Close leads.
						"primary": "common.close" if reason == "full" else "common.tryAgain",
						"tone": "neutral",
						"focus": "heading",
					}
				)
			)
		"network-blocked":
			var settings: bool = p.get("canOpenSettings") == true
			return (
				View
				. make(
					ctx,
					c,
					{
						"state": "network-blocked",
						"copy":
						[
							"core.codes.nearby-permission-denied.title",
							"core.codes.nearby-permission-denied.message",
							"localPairing.openSettings" if settings else null,
							"common.tryAgain",
							"common.close",
						],
						# Try again returns to the step the person was on, with the field kept.
						"primary": "localPairing.openSettings" if settings else "common.tryAgain",
						"tone": "neutral",
						"focus": "heading",
					}
				)
			)
	return (
		View
		. make(
			ctx,
			c,
			{
				"state": "off",
				"copy":
				[
					"core.codes.local-pairing-off.title",
					"core.codes.local-pairing-off.message",
					"common.close"
				],
				# Close is the only way out of a refusal: it is not the filled one.
				"tone": "neutral",
				"focus": "heading",
			}
		)
	)


## The Can connect column (M8): only when more than 8 are paired or one is off; with every device on
## and 8 or fewer, the switch would do nothing useful.
static func show_switch_column(devices: Array) -> bool:
	if devices.size() > MAX_CONNECTABLE:
		return true
	for d in devices:
		if d.get("reachable") != true:
			return true
	return false


## True when the eight that can connect are all on and more are paired: the off switches wait.
static func reachable_full(devices: Array) -> bool:
	if devices.size() <= MAX_CONNECTABLE:
		return false
	var on := 0
	for d in devices:
		if d.get("reachable") == true:
			on += 1
	return on >= MAX_CONNECTABLE


static func _last_seen(devices: Array) -> bool:
	for d in devices:
		if d.get("lastSeen") != null:
			return true
	return false


## The paired devices and what the person is doing to one row.
static func paired_devices_view(ctx: RefCounted) -> Dictionary:
	var p: Variant = ctx.input.get("pairedDevices")
	if not ctx.on("connect") or not (p is Dictionary):
		return View.hidden(ctx, "PairedDevices")
	var c := "PairedDevices"
	var devices: Array = p.get("devices") if p.get("devices") is Array else []
	var full := devices.size() >= MAX_PAIRED
	var step := String(p.get("step", ""))
	# Until the first read answers nothing is said about what is paired, not even "none yet".
	if step == "loading":
		return View.make(
			ctx,
			c,
			{
				"state": "loading",
				"copy": ["pairedDevices.title", "a11y.busy", "common.done"],
				"focus": "heading"
			}
		)
	if step == "load-failed":
		return (
			View
			. make(
				ctx,
				c,
				{
					"state": "load-failed",
					"copy":
					[
						"pairedDevices.title",
						"pairedDevices.loadFailed",
						"common.tryAgain",
						"common.done"
					],
					"primary": "common.tryAgain",
					"tone": "danger",
					"errorSlot": "screen",
					"focus": "heading",
				}
			)
		)
	if step == "off":
		var first: Variant = devices[0].get("label") if devices.size() > 0 else null
		return (
			View
			. make(
				ctx,
				c,
				{
					"state": "off",
					"copy":
					[
						"pairedDevices.title",
						"core.codes.local-pairing-off.title",
						"pairedDevices.offBody",
						"pairedDevices.lastSeen" if _last_seen(devices) else null,
						"a11y.deviceOptions" if devices.size() > 0 else null,
						"devices.rename" if devices.size() > 0 else null,
						"pairedDevices.forget" if devices.size() > 0 else null,
						"common.done",
					],
					"args": {"device": first},
					"primary": "common.done",
					"tone": "neutral",
					"focus": "heading",
				}
			)
		)
	if devices.is_empty():
		return (
			View
			. make(
				ctx,
				c,
				{
					"state": "empty",
					"copy":
					[
						"pairedDevices.title",
						"pairedDevices.empty",
						"pairedDevices.pair",
						"common.done"
					],
					"primary": "pairedDevices.pair",
					"focus": "heading",
				}
			)
		)
	var switches := show_switch_column(devices)
	var state := (
		"renaming" if step == "renaming" else ("forgetting" if step == "forgetting" else "list")
	)
	# A row being edited is the one thing on screen: the list's notices wait.
	var waits := state == "list" and reachable_full(devices)
	var notice: Variant = (
		NOTICE.get(p["notice"].get("kind"))
		if state == "list" and p.get("notice") is Dictionary
		else null
	)
	var target: Dictionary = {}
	for d in devices:
		if d.get("id") == p.get("target"):
			target = d
			break
	var tl: Variant = target.get("label")
	var name := ""
	if tl is String and not (tl as String).strip_edges().is_empty():
		name = tl
	elif devices[0].get("label") != null:
		name = String(devices[0]["label"])
	var rename_error: Variant = p.get("renameError")
	var renaming := state == "renaming"
	var forgetting := state == "forgetting"
	var host_device: Variant = p["notice"].get("device") if p.get("notice") is Dictionary else null
	return (
		View
		. make(
			ctx,
			c,
			{
				"state": state,
				"copy":
				[
					"pairedDevices.title",
					"pairedDevices.lede",
					"pairedDevices.lastSeen" if _last_seen(devices) else null,
					"a11y.deviceOptions",
					"devices.rename",
					"pairedDevices.forget",
					"pairedDevices.canConnect" if switches else null,
					"a11y.letConnect" if switches else null,
					"pairedDevices.reachableFullTitle" if waits else null,
					"pairedDevices.reachableFullBody" if waits else null,
					"core.codes.local-links-full.title" if state == "list" and full else null,
					"pairedDevices.fullBody" if state == "list" and full else null,
					notice[0] if notice != null else null,
					notice[1] if notice != null else null,
					"devices.renameLabel" if renaming else null,
					"localPairing.nameHint" if renaming else null,
					"common.save" if renaming else null,
					"common.cancel" if renaming or forgetting else null,
					"pairedDevices.renameLong" if renaming and rename_error == "long" else null,
					"pairedDevices.renameEmpty" if renaming and rename_error == "empty" else null,
					"devices.renameFailed" if renaming and rename_error == "failed" else null,
					"pairedDevices.forgetConfirm" if forgetting else null,
					"pairedDevices.forgetBody" if forgetting else null,
					(
						"pairedDevices.forgetFailed"
						if forgetting and p.get("forgetError") == true
						else null
					),
					"pairedDevices.pair",
					"common.done",
				],
				"args":
				{
					"device": host_device if host_device != null else name,
					"max": MAX_NAME if rename_error == "long" else MAX_CONNECTABLE
				},
				"disabled": ["pairedDevices.pair"] if full else [],
				# The row being edited owns the filled control; otherwise Pair with a Code is the one
				"primary":
				(
					# primary (drawn unavailable when there is no room).
					"common.save"
					if renaming
					else ("pairedDevices.forget" if forgetting else "pairedDevices.pair")
				),
				"tone": "danger" if renaming and rename_error != null else null,
				"errorSlot": "devices.renameLabel" if renaming and rename_error != null else null,
				"focus":
				(
					"devices.renameLabel"
					if renaming
					else ("common.cancel" if forgetting else "heading")
				),
			}
		)
	)


## How the show screen lays out for a window (UI-KITS 4.3, LocalPairing): `{width, height, textScale?,
## tv?}` in px at the root text size. Two panes from 600 px of window at the root text size (so 200 %
## text keeps one column), at any height, and always on a TV. A window under 480 tall drops the logo.
## A window both narrow and short keeps one column that scrolls, with the notice before the QR.
## Answers `{panes, logo, scrolls, noticeBeforeQr}`.
static func layout(w: Dictionary) -> Dictionary:
	var scale := float(w.get("textScale", 1.0)) if float(w.get("textScale", 0.0)) > 0.0 else 1.0
	var tv: bool = w.get("tv") == true
	var panes := 2 if tv or float(w["width"]) / scale >= 600.0 else 1
	var short := float(w["height"]) < 480.0 and not tv
	return {
		"panes": panes,
		"logo": not short,
		"scrolls": panes == 1 and short,
		"noticeBeforeQr": panes == 1 and short
	}
