extends RefCounted
## The activate family (ui-matrix.json `activate`): Welcome, Activate and OfflineActivation, the
## port of ui-core's `models/activate.ts`. Welcome offers only the paths the build and the services
## support; the key field parses as the person types (UI-KITS.md §4.3 "Live verdict"); a full
## license hands off to DeviceLimit, never an error string; a floating key never needs an account;
## a loaded offline response is not an activation until its signature verifies.

const Errors := preload("res://addons/polaris_key/ui/model/errors.gd")
const Link := preload("res://addons/polaris_key/ui/model/link.gd")
const View := preload("res://addons/polaris_key/ui/model/view.gd")

# ── Welcome ───────────────────────────────────────────────────────────────────────────────────
#
# States: default, busy, capability-limited, hidden.


## The gate's first screen: product hero, Sign in, Use a license key and the product's extras.
static func welcome_view(ctx: RefCounted) -> Dictionary:
	var sign_in: bool = View.truthy(ctx.caps.get("signIn")) and ctx.on("identity")
	var key: bool = View.truthy(ctx.caps.get("keyEntry")) and ctx.on("license")
	# License off with open registration: there is nothing to sign in or activate for.
	if not ctx.on("license") and ctx.registration == "open":
		return View.hidden(ctx, "Welcome")
	var id := View.identity_text(ctx)
	var args := {"product": id["name"], "developer": id["developer"]}
	# The one primary follows the state: Sign in on an empty Welcome (DL4).
	var primary = "welcome.signIn" if sign_in else "welcome.useKey" if key else null
	if View.truthy(ctx.input.get("pending")):
		return View.make(ctx, "Welcome", {
			"state": "busy",
			"copy": ["welcome.title", "common.working", "a11y.busy"],
			"args": args,
			# A busy control keeps its label and its focus (DL4, DL9).
			"primary": primary,
		})
	if not sign_in or not key:
		return View.make(ctx, "Welcome", {
			"state": "capability-limited",
			"copy": [
				"welcome.title",
				"welcome.ledeSignInOnly" if sign_in else "welcome.ledeKeyOnly",
			],
			"args": args,
			"primary": primary,
		})
	return View.make(ctx, "Welcome", {
		"state": "default",
		"copy": [
			"a11y.productIcon",
			"welcome.title",
			"common.byDeveloper" if id["developer"] != null else null,
			"welcome.lede",
			"welcome.signIn",
			"welcome.useKey",
			"welcome.trial" if View.truthy(ctx.caps.get("trial")) else null,
			"welcome.continueFree" if View.truthy(ctx.caps.get("enroll")) else null,
			"welcome.restore" if View.truthy(ctx.caps.get("restore")) else null,
			"welcome.offline" if View.truthy(ctx.caps.get("offlineActivation")) else null,
		],
		"args": args,
		"primary": primary,
	})


# ── Activate: the key field ───────────────────────────────────────────────────────────────────

## A license key's secret: exactly 22 base64url characters (packages/worker/src/crypto.ts).
const KEY_SECRET_LENGTH := 22
const KEY_PREFIX := "pkey_"
## The input is trimmed first, so `$` (which PCRE also matches before a final newline) is JS's.
static var _key_shape := RegEx.create_from_string("^pkey_([a-z0-9-]+)_([A-Za-z0-9_-]*)$")
static var _key_typing := RegEx.create_from_string("^pkey_[a-z0-9-]*$")

## JavaScript's `String.prototype.trim` set: ECMAScript white space and line terminators.
const _JS_SPACE := [
	0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680,
	0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
	0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
]


## Parse the key field: `{kind, slug?, prefix?, used?, limit}`, kind one of empty, typing,
## parsed, short, malformed. A prefix of `pkey_<slug>_` and a short secret are still `typing`; a
## short secret only becomes `short` when submitted (EXPERIENCE P2), and anything that can never
## become a key is `malformed` at once. `slug` is the product slug the key names, `prefix` its
## public `pkey_<slug>_`, `used` the secret characters present (the cut-short line counts them).
static func parse_key(text: String, submitted: bool = false) -> Dictionary:
	var key := _js_trim(text)
	var limit := KEY_SECRET_LENGTH
	if key == "":
		return {"kind": "empty", "limit": limit}
	if not key.begins_with(KEY_PREFIX):
		return {
			"kind": "typing" if KEY_PREFIX.begins_with(key) and not submitted else "malformed",
			"limit": limit,
		}
	var m := _key_shape.search(key)
	if m == null:
		return {
			"kind": "typing" if _key_typing.search(key) != null and not submitted else "malformed",
			"limit": limit,
		}
	var slug := m.get_string(1)
	var used := m.get_string(2).length()
	var prefix := KEY_PREFIX + slug + "_"
	var kind := (
		"parsed" if used == limit
		else "malformed" if used > limit
		else "short" if submitted
		else "typing"
	)
	return {"kind": kind, "slug": slug, "prefix": prefix, "used": used, "limit": limit}


# States: empty, typing, parsed, cut-short, busy, rejected, device-limit, done, hidden.

const FIELD := "part.keyField.label"
const SUBMIT := "activate.submit"


## License key entry with a live verdict, and the activation's answer.
static func activate_view(ctx: RefCounted) -> Dictionary:
	if not ctx.on("license"):
		return View.hidden(ctx, "Activate")
	var key_field: Dictionary = ctx.member("keyField")
	var pending = ctx.input.get("pending")
	var product: String = View.identity_text(ctx)["name"]
	if pending == "activate":
		return View.make(ctx, "Activate", {
			"state": "busy",
			"copy": ["activate.busy", "a11y.busy"],
			"primary": SUBMIT,
		})
	if View.truthy(ctx.input.get("activation")):
		var activation: Dictionary = ctx.member("activation")
		var result = activation.get("result")
		if result == "ok":
			return View.make(ctx, "Activate", {
				"state": "done",
				"copy": [
					"core.activation.ok.title",
					"core.activation.ok.message",
					"part.keyField.verdict",
				],
				"args": {"product": product},
				# The done step (UK-42's ActivateDone) carries the way on; the heading takes focus.
			})
		if result == "device-limit":
			var link := Link.verdict(activation.get("manageUrl"), ctx.platform, "replace-device")
			var known: bool = activation.get("limit") != null
			return View.make(ctx, "Activate", {
				"state": "device-limit",
				"copy": [
					"core.activation.device-limit.title",
					"core.activation.device-limit.message",
					"deviceLimit.title",
					"part.seatMeter.caption" if known else null,
					# With no link the fix is named in words (DL6).
					"deviceLimit.noManage" if link["url"] == null else null,
				],
				"args": {
					"product": product,
					"used": activation.get("deviceCount"),
					"limit": activation.get("limit"),
				},
				# The fix is the only primary and takes focus (DL6): Replace a device, which opens
				# the link (DeviceLimit's browser mode).
				"primary": "deviceLimit.title" if link["url"] != null else null,
				"tone": "neutral",
				"errorSlot": FIELD,
				"link": link,
			})
		# A refusal of a well-formed key: the key is not wrong, so no danger stroke on the field.
		return View.make(ctx, "Activate", {
			"state": "rejected",
			"copy": Errors.activation_copy(result if result is String else "", activation.get("code")),
			"args": {"product": product},
			"primary": SUBMIT,
			"tone": "danger" if result == "error" else "neutral",
			"errorSlot": FIELD,
			"focus": FIELD,
		})
	var text = View.first([key_field.get("text"), ""])
	var parse := parse_key(str(text), _is_true(key_field.get("submitted")))
	var args := {
		"product": product,
		"slug": parse.get("slug"),
		"prefix": parse.get("prefix"),
		"used": parse.get("used"),
		"limit": parse["limit"],
	}
	match parse["kind"]:
		"empty":
			if View.truthy(key_field.get("submitted")):
				return View.make(ctx, "Activate", {
					"state": "rejected",
					"copy": ["part.keyField.empty"],
					"args": args,
					"primary": SUBMIT,
					"tone": "danger",
					"errorSlot": FIELD,
					"focus": FIELD,
				})
			return View.make(ctx, "Activate", {
				"state": "empty",
				"copy": [
					"activate.title",
					"activate.lede",
					FIELD,
					"part.keyField.placeholder",
					"common.paste",
					SUBMIT,
				],
				"args": args,
				"primary": SUBMIT,
				"focus": FIELD,
			})
		"typing":
			return View.make(ctx, "Activate", {
				"state": "typing",
				"copy": [FIELD, SUBMIT],
				"args": args,
				"primary": SUBMIT,
				"focus": FIELD,
			})
		"parsed":
			return View.make(ctx, "Activate", {
				"state": "parsed",
				"copy": ["part.keyField.forProduct", SUBMIT],
				"args": args,
				"primary": SUBMIT,
				"focus": FIELD,
			})
		"short":
			return View.make(ctx, "Activate", {
				"state": "cut-short",
				"copy": ["part.keyField.cutShort"],
				"args": args,
				"primary": SUBMIT,
				"tone": "danger",
				"errorSlot": FIELD,
				"focus": FIELD,
			})
	# "malformed": the last kind.
	return View.make(ctx, "Activate", {
		"state": "rejected",
		"copy": ["part.keyField.malformed"],
		"args": args,
		"primary": SUBMIT,
		"tone": "danger",
		"errorSlot": FIELD,
		"focus": FIELD,
	})


# ── OfflineActivation ─────────────────────────────────────────────────────────────────────────
#
# States: default, loaded, rejected-signature, done, hidden.


## Two numbered actions: send the request, load the response; then the verdict.
static func offline_activation_view(ctx: RefCounted) -> Dictionary:
	if not ctx.on("license"):
		return View.hidden(ctx, "OfflineActivation")
	var o: Dictionary = ctx.member("offline")
	var product: String = View.identity_text(ctx)["name"]
	var submitted := View.truthy(o.get("submitted"))
	var file := View.truthy(o.get("file"))
	var copied := View.truthy(o.get("copied"))
	var verified = o.get("verified")
	if submitted and file and _is_true(verified):
		return View.make(ctx, "OfflineActivation", {
			"state": "done",
			"copy": ["offlineActivation.done"],
			"args": {"product": product},
		})
	if submitted and file and verified is bool and not verified:
		return View.make(ctx, "OfflineActivation", {
			"state": "rejected-signature",
			"copy": [
				"core.codes.bundle-jws-rejected.title",
				"core.codes.bundle-jws-rejected.message",
			],
			"primary": "offlineActivation.loadFile",
			"tone": "danger",
			"errorSlot": "offlineActivation.loadFile",
			"focus": "offlineActivation.loadFile",
		})
	# A loaded file is not an activation until its signature verifies (Must not).
	if file or copied:
		var empty := submitted and not file
		return View.make(ctx, "OfflineActivation", {
			"state": "loaded",
			"copy": [
				"offlineActivation.codeCopied" if copied and not submitted and not file else null,
				"offlineActivation.empty" if empty else null,
				"offlineActivation.submit",
			],
			"primary": "offlineActivation.submit",
			"tone": "danger" if empty else null,
			"errorSlot": "offlineActivation.submit" if empty else null,
			# The request code may be drawn as a QR on any screen that fits it (DL14).
			"qr": true,
		})
	return View.make(ctx, "OfflineActivation", {
		"state": "default",
		"copy": [
			"offlineActivation.title",
			"offlineActivation.request",
			"offlineActivation.product",
			"offlineActivation.copyCode",
			"offlineActivation.loadHint",
			"offlineActivation.loadFile",
			"offlineActivation.paste",
			"offlineActivation.dropHint",
			"offlineActivation.submit",
		],
		"args": {"product": product},
		"primary": "offlineActivation.copyCode",
		"qr": true,
	})


## TS `x === true`.
static func _is_true(v: Variant) -> bool:
	return v is bool and v


## JavaScript's `s.trim()`: Godot's `strip_edges` strips every control character but keeps
## U+00A0, U+FEFF and the other Unicode spaces JS trims.
static func _js_trim(s: String) -> String:
	var start := 0
	var end := s.length()
	while start < end and _JS_SPACE.has(s.unicode_at(start)):
		start += 1
	while end > start and _JS_SPACE.has(s.unicode_at(end - 1)):
		end -= 1
	return s.substr(start, end - start)
