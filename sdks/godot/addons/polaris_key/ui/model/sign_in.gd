extends RefCounted
## The signIn family (ui-matrix.json `signIn`): the port of ui-core's `models/signIn.ts`. The one
## sign-in form of SIGN-IN.md §3.17, whose body morphs in place through methods → handoff | code →
## finishing → choose ↔ replace | key → done (plans/I-04.md §G). SignIn is the form;
## SignInHandoff draws its step 2 (Finish in your browser, the device code); LicenseChoice its
## step 3 (with Replace a device). These are pure functions of the session; `sign_in_session.gd`
## (the port of `SignInModel`) is the state machine that drives the SDK primitives and feeds them.
##
## Precedence, where several states could hold (ui-matrix.json `vocabulary.precedence`):
##
##   SignIn          error, expired, done, key, replace, choose, finishing, code, handoff, methods
##   LicenseChoice   loading, grant-expired, raced, replace-open, none-keys | none-no-keys, new,
##                   create, all-full, keep, current, mixed, one, many
##
## A `browser` presentation or a device-code sign-in never reaches choose, replace or a
## LicenseChoice state (D4): the card chooses. `replace: "browser"` never opens the device list in
## the app; Replace opens the card instead (`replace-in-browser`).

const Activate := preload("res://addons/polaris_key/ui/model/activate.gd")
const Context := preload("res://addons/polaris_key/ui/model/context.gd")
const Errors := preload("res://addons/polaris_key/ui/model/errors.gd")
const Link := preload("res://addons/polaris_key/ui/model/link.gd")
const Loading := preload("res://addons/polaris_key/ui/model/loading.gd")
const View := preload("res://addons/polaris_key/ui/model/view.gd")

const DEFAULT_DEVICE_URL := PKeyConstants.DEVICE_CODE_PAGE
const DEFAULT_TV_URL := PKeyConstants.TV_CODE_PAGE


## The sign-in is possible here: Identity is on and the build offers it.
static func _sign_in_on(ctx: RefCounted) -> bool:
	return ctx.on("identity") and View.truthy(ctx.caps.get("signIn"))


## True when the license choice happens in the app (inline or sheet, browser channel: D4).
static func _chooses_in_app(ctx: RefCounted) -> bool:
	var s = ctx.input.get("signIn")
	return s is Dictionary and s.get("presentation") != "browser" and s.get("channel") != "device-code"


## The device-code page: the product's own `deviceCodeUrl`, else the server's address, else
## Polaris Key's (`/tv` on a TV or console, `/device` elsewhere; SIGN-IN.md D-16).
static func verification_url(ctx: RefCounted) -> String:
	# The first that passes the opener (DL14): a broken integrator address never hides the
	# server's valid one.
	for candidate in [ctx.member("integrator").get("deviceCodeUrl"), ctx.member("deviceCode").get("verificationUri")]:
		if Link.valid_link(candidate) != null:
			return candidate
	var c := Context.platform_class(ctx.platform)
	return DEFAULT_TV_URL if c == "tv" or c == "console" else DEFAULT_DEVICE_URL


## What opening, copying or scanning the link does: the Polaris Key page we fall back to carries the
## code (`?user_code=`), so the player need not type it. The displayed address stays bare.
static func verification_target(ctx: RefCounted, shown: String) -> String:
	var dc = ctx.member("deviceCode")
	var code = dc.get("userCode") if dc is Dictionary else null
	if not (code is String) or code == "" or (shown != DEFAULT_DEVICE_URL and shown != DEFAULT_TV_URL):
		return shown
	return "%s?user_code=%s" % [shown, code.uri_encode()]


# ── SignIn ─────────────────────────────────────────────────────────────────────────────────────

## `SignInState`.
const SIGN_IN_STATES := [
	"methods", "handoff", "code", "finishing", "choose", "replace", "key", "key-refused", "done", "error", "expired",
	"confirm", "link-offer", "link-done", "link-conflict", "nearby-prompt", "nearby-wait", "nearby-done", "device-limit", "hidden",
]


## The copy key of the first sign-in method, the methods step's primary (DL9).
static func _methods_primary(ctx: RefCounted) -> String:
	return "signin.desktop.continue" if Context.platform_class(ctx.platform) == "desktop" else "signin.provider.continue"


static func _methods_copy(ctx: RefCounted) -> Array:
	var c := Context.platform_class(ctx.platform)
	var key_path: bool = View.truthy(ctx.caps.get("keyEntry")) and ctx.on("license")
	var common := [
		"signIn.title",
		"signin.methods.ledeApp",
		"signin.provider.group",
		"signin.provider.continue",
		_and(key_path, "signin.choice.keyInstead"),
		"common.cancel",
	]
	# Desktop leads with Continue in browser and has no passkey or device-code row (D-69).
	if c == "desktop":
		return common + ["signin.desktop.continue", "signin.menu.signIn"]
	return common + [
		"signin.passkey",
		"signin.email.continue",
		# Sign in on your phone or computer: a phone or tablet hands off; a page is already there.
		_and(c == "handheld" and View.truthy(ctx.caps.get("deviceCode")), "signin.link.deviceCode"),
	]


## The one sign-in form.
static func sign_in_view(ctx: RefCounted) -> Dictionary:
	var s = ctx.input.get("signIn")
	if not _sign_in_on(ctx) or not (s is Dictionary):
		return View.hidden(ctx, "SignIn")
	var dc = ctx.input.get("deviceCode")
	var id := View.identity_text(ctx)
	var args := {"product": id["name"], "app": id["name"]}
	var license: bool = ctx.on("license")
	var error = ctx.member("error").get("code")
	if View.truthy(error):
		var primary := _methods_primary(ctx)
		# Sign-in errors sit under Sign in (DL7); the methods stay.
		return View.make(ctx, "SignIn", {
			"state": "error",
			"copy": ["signIn.noMethods" if error == "sign-in-unavailable" else "signIn.methodError"],
			"args": args,
			"primary": primary,
			"tone": "danger",
			"errorSlot": primary,
		})
	var auto = ctx.input.get("autoSignIn")
	if View.truthy(auto):
		var extra := {"developer": id["developer"], "email": auto.get("email")}
		args.merge(extra, true)
		return _auto_step_view(ctx, auto, args)
	if s.get("outcome") == "expired" or (dc is Dictionary and (dc.get("phase") == "expired" or Link.code_expired(dc.get("secondsLeft")))):
		return View.make(ctx, "SignIn", {
			"state": "expired",
			"copy": (
				["core.codes.sign-in-expired.title", "core.codes.sign-in-expired.message", "signin.again"]
				if s.get("channel") == "device-code"
				else ["signin.handoff.tooLong", "signin.again"]
			),
			"args": args,
			"primary": "signin.again",
			"tone": "neutral",
		})
	if s.get("outcome") == "signedIn":
		# How the form ends (SIGN-IN.md §3.17 item 4): Done when a license was added or issued now;
		# otherwise the form closes and the app opens with the toast. License off: no tier to name.
		var copy: Array
		if not license:
			copy = ["signin.return.signedInShort"]
		elif View.truthy(s.get("issuedNow")):
			# One key for "You're signed in · Pro license", so no kit joins two with a separator.
			var acct = ctx.input.get("account")
			var tier = acct.get("tier") if acct is Dictionary else null
			copy = ["signin.done.start", "signin.return.signedInTier" if View.truthy(tier) else "signin.return.signedInShort"]
		else:
			copy = ["signin.desktop.toast"]
		var start := copy.has("signin.done.start")
		var spec := {"state": "done", "copy": copy, "args": args, "primary": "signin.done.start" if start else null}
		if not start:
			spec["focus"] = null
		return View.make(ctx, "SignIn", spec)
	var in_app := _chooses_in_app(ctx)
	if s.get("outcome") == "choose" and in_app:
		# Use a license key instead keeps the account: the key step is in the same form (Must not).
		if s.get("event") == "have-key" and license and View.truthy(ctx.caps.get("keyEntry")):
			var a = ctx.input.get("activation")
			var refused: bool = View.truthy(a) and a.get("result") != "ok"
			var refusal = Activate.key_refusal_of(a)
			# The refusals a different key cannot fix leave the field behind (DL6).
			if View.truthy(a) and refusal != null:
				var spec := Activate.key_refusal_spec(ctx, refusal, a)
				return View.make(ctx, "SignIn", {
					"state": "key-refused",
					"copy": spec["copy"],
					"args": args,
					"primary": spec["primary"],
					"tone": "neutral",
					"link": spec["link"],
					"qr": spec["qr"],
				})
			# `license_owned` never names the holder (S-16): only its core copy.
			var key_copy := ["signin.key.addTitle", "part.keyField.label"]
			if refused:
				key_copy += Errors.activation_copy(_str(a.get("result")), a.get("code"))
			return View.make(ctx, "SignIn", {
				"state": "key",
				"copy": key_copy,
				"args": args,
				"primary": "activate.submit",
				"tone": "neutral" if refused else null,
				"errorSlot": "part.keyField.label" if refused else null,
				"focus": "part.keyField.label",
			})
		if s.get("event") == "open-replace" and s.get("replace") == "inline" and View.truthy(ctx.input.get("replaceView")):
			var system := Context.system_confirm(ctx.platform, _str(s.get("presentation")))
			return View.make(ctx, "SignIn", {
				"state": "replace",
				"copy": [
					"signin.replace.open",
					"signin.replace.lede",
					"signin.replace.openSystem" if system else "signin.replace.title",
				],
				"args": args,
				"primary": "signin.replace.openSystem" if system else "signin.replace.open",
			})
		var desktop := Context.platform_class(ctx.platform) == "desktop"
		return View.make(ctx, "SignIn", {
			"state": "choose",
			"copy": ["signin.choice.title", _and(desktop, "signin.desktop.notifyChoose")],
			"args": args,
			"extraActions": (
				["replace-in-browser"] if s.get("event") == "open-replace" and s.get("replace") == "browser" else []
			),
			# LicenseChoice draws the rows and Continue.
			"primary": null,
			"focus": null,
		})
	if View.truthy(s.get("redeeming")) or (dc is Dictionary and dc.get("phase") == "ok"):
		return View.make(ctx, "SignIn", {
			"state": "finishing",
			"copy": ["signin.handoff.finishing", "a11y.busy"],
			"args": args,
			"focus": null,
		})
	if s.get("channel") == "device-code" or s.get("event") == "use-code":
		# SignInHandoff draws the code view in the form's body.
		return View.make(ctx, "SignIn", {"state": "code", "copy": [], "args": args, "focus": null})
	if s.get("outcome") == "pending":
		return View.make(ctx, "SignIn", {
			"state": "handoff",
			"copy": [
				"signin.handoff.title",
				"signin.handoff.browserBody",
				"signin.handoff.waiting",
				"signin.handoff.again",
				_and(ctx.caps.get("deviceCode"), "signin.handoff.useCode"),
			],
			"args": args,
			"primary": "signin.handoff.again",
		})
	# Cancel returns to step 1, with nothing else lost.
	return _methods_view(ctx, args)


## The provider's identity is per developer: Apple always, Google unless it is shared across apps.
static func _per_developer(provider: String, reach: Variant) -> bool:
	return provider == "Apple" or reach != "global"


## Automatic sign-in's steps, drawn in the form's body (plans/auto-sign-in.md §3): confirm the
## account, offer to link the provider, and the nearby wait. Every outcome has a title that takes
## focus and one way on (Continue).
static func _auto_step_view(ctx: RefCounted, auto: Dictionary, base_args: Dictionary) -> Dictionary:
	var provider: String = str(View.first([ctx.input.get("provider"), PKeyConstants.SIGN_IN_PROVIDER_NAME]))
	var args := base_args.duplicate()
	args["provider"] = provider
	var account = ctx.input.get("account")
	args["tier"] = account.get("tier") if account is Dictionary else null
	args["code"] = auto.get("code")
	var step: String = str(auto.get("step"))
	var copy: Array
	var primary = null
	var tone = null
	match step:
		"confirm":
			var kind = auto.get("license")
			var also := View.truthy(auto.get("alsoGets"))
			copy = [
				"signin.auto.confirm.title",
				"signin.auto.confirm.as" if View.truthy(auto.get("email")) else "signin.auto.confirm.asApple",
				"signin.consent.license" if View.truthy(kind) else null,
				"signin.consent.newLicense" if kind == "new" else null,
				"signin.consent.licenseLine" if kind == "existing" else null,
				"signin.consent.alsoGets" if also else null,
				"signin.consent.profile" if also else null,
				"signin.consent.pairwise" if also else null,
				"signin.auto.confirm.primary",
				"signin.auto.confirm.other",
			]
			primary = "signin.auto.confirm.primary"
		"link-offer":
			var body := "signin.linkOffer.bodyGlobal"
			if _per_developer(provider, auto.get("reach")):
				body = "signin.linkOffer.bodyDeveloper" if View.truthy(args.get("developer")) else "signin.linkOffer.bodyApp"
			copy = ["signin.linkOffer.title", body, "signin.linkOffer.primary", "signin.linkOffer.decline"]
			primary = "signin.linkOffer.primary"
		"link-done":
			copy = ["signin.linkOffer.done", "common.done"]
			primary = "common.done"
		"link-conflict":
			copy = ["signin.linkOffer.conflictTitle", "signin.linkOffer.conflict", "signin.linkOffer.join", "common.done"]
			primary = "common.done"
			tone = "neutral"
		"nearby-prompt":
			copy = ["signin.nearby.promptTitle", "signin.nearby.prePrompt", "common.continue", "common.notNow"]
			primary = "common.continue"
		"nearby-wait":
			copy = [
				"signin.nearby.title",
				"signin.nearby.body",
				"signin.nearby.match",
				"a11y.nearbyCode" if View.truthy(auto.get("code")) else null,
				"signin.nearby.code",
			]
		"device-limit":
			# A device limit with no license rows: its own step, never the key screen. Replace opens
			# the refusal's manageUrl; without a usable link the fix is named in words.
			var link := Link.verdict(auto.get("manageUrl"), ctx.platform, "replace-device")
			var replace: bool = link["url"] != null
			copy = [
				"core.codes.device_limit.title",
				"core.codes.device_limit.message" if replace else null,
				"signin.deviceLimit.replace" if replace else "deviceLimit.noManage",
				"a11y.externalLink" if replace else null,
				"signin.auto.confirm.other",
				"common.cancel",
			]
			primary = "signin.deviceLimit.replace" if replace else null
			tone = "neutral"
			return View.make(ctx, "SignIn", {"state": step, "copy": copy, "args": args, "primary": primary, "tone": tone, "focus": "heading", "link": link})
		_:
			step = "nearby-done"
			copy = ["signin.nearby.done", "common.continue", "signin.nearby.notYou"]
			primary = "common.continue"
	return View.make(ctx, "SignIn", {"state": step, "copy": copy, "args": args, "primary": primary, "tone": tone, "focus": "heading"})


static func _methods_view(ctx: RefCounted, args: Dictionary) -> Dictionary:
	return View.make(ctx, "SignIn", {
		"state": "methods",
		"copy": _methods_copy(ctx),
		"args": args,
		"primary": _methods_primary(ctx),
	})


# ── SignInHandoff ──────────────────────────────────────────────────────────────────────────────

## `HandoffState`.
const HANDOFF_STATES := ["starting", "waiting", "no-browser", "code", "link-copied", "finishing", "denied", "failed", "expired", "cancelled", "hidden"]


## Step 2 of the form: Finish in your browser, or the device code. Moves on by itself.
static func sign_in_handoff_view(ctx: RefCounted) -> Dictionary:
	var s = ctx.input.get("signIn")
	if not _sign_in_on(ctx) or not (s is Dictionary):
		return View.hidden(ctx, "SignInHandoff")
	var id := View.identity_text(ctx)
	var dc = ctx.input.get("deviceCode")
	var d: Dictionary = dc if dc is Dictionary else {}
	var c := Context.platform_class(ctx.platform)
	var link := Link.verdict(verification_url(ctx), ctx.platform, "sign-in")
	if link["url"] != null:
		link["url"] = verification_target(ctx, link["url"])
	var seconds_left = d.get("secondsLeft")
	var args := {
		"product": id["name"],
		"url": link["display"],
		"code": d.get("userCode"),
		"time": Link.countdown(float(seconds_left)) if seconds_left != null else null,
	}
	if s.get("channel") == "device-code" or s.get("event") == "use-code":
		# The device-code poll's phase alone selects the state (plans/UK-02b.md §4.5). At 0:00 the
		# view switches to expired locally while any poll finishes (DL14).
		var phase = View.first([d.get("phase"), "starting"])
		var lapsed := Link.code_expired(seconds_left)
		if phase == "expired" or lapsed:
			return View.make(ctx, "SignInHandoff", {
				"state": "expired",
				# A lapsed code is never polled again, and its code is gone from the screen (Must not).
				"copy": [
					"core.codes.sign-in-expired.title",
					"core.codes.sign-in-expired.message",
					"signInHandoff.newCode",
				],
				"args": args,
				"primary": "signInHandoff.newCode",
				"tone": "neutral",
			})
		match phase:
			"starting":
				return View.make(ctx, "SignInHandoff", {
					"state": "starting",
					"copy": ["signInHandoff.starting", "a11y.busy"],
					"args": args,
					"focus": null,
				})
			"ok":
				return View.make(ctx, "SignInHandoff", {
					"state": "finishing",
					"copy": ["signin.handoff.finishing", "signInHandoff.ok"],
					"args": args,
					"focus": null,
				})
			"denied":
				return View.make(ctx, "SignInHandoff", {
					"state": "denied",
					"copy": [
						"core.codes.sign-in-denied.title",
						"core.codes.sign-in-denied.message",
						"signInHandoff.newCode",
					],
					"args": args,
					"primary": "signInHandoff.newCode",
					"tone": "danger",
					"errorSlot": "screen",
				})
			"failed":
				return View.make(ctx, "SignInHandoff", {
					"state": "failed",
					"copy": [
						"core.codes.sign-in-failed.title",
						"core.codes.sign-in-failed.message",
						"signInHandoff.newCode",
					],
					"args": args,
					"primary": "signInHandoff.newCode",
					"tone": "danger",
					"errorSlot": "screen",
				})
			"cancelled":
				return View.make(ctx, "SignInHandoff", {
					"state": "cancelled",
					"copy": ["signin.handoff.cancelled", "signInHandoff.newCode"],
					"args": args,
					"primary": "signInHandoff.newCode",
				})
		return _code_view(ctx, c, link, args)
	if View.truthy(s.get("redeeming")):
		return View.make(ctx, "SignInHandoff", {
			"state": "finishing",
			"copy": ["signin.handoff.finishing"],
			"args": args,
			"focus": null,
		})
	if s.get("outcome") == "pending":
		# The opener failed: the screen stays, with Copy link (DL14).
		var opened = s.get("browserOpened")
		if opened is bool and not opened:
			if s.get("event") == "copy-link":
				return View.make(ctx, "SignInHandoff", {
					"state": "link-copied",
					"copy": ["signInHandoff.linkCopied"],
					"args": args,
					"focus": null,
				})
			return View.make(ctx, "SignInHandoff", {
				"state": "no-browser",
				"copy": [
					"signin.handoff.noBrowser",
					"signin.handoff.noBrowserBody",
					"signin.handoff.copyLink",
				],
				"args": args,
				"primary": "signin.handoff.copyLink",
				"tone": "neutral",
			})
		return View.make(ctx, "SignInHandoff", {
			"state": "waiting",
			"copy": [
				"signin.handoff.title",
				"signin.handoff.waiting",
				"signin.handoff.again",
				_and(ctx.caps.get("deviceCode"), "signin.handoff.useCode"),
				"common.cancel",
			],
			"args": args,
			# Open browser again reuses the request in flight; it never starts a second one.
			"primary": "signin.handoff.again",
		})
	if s.get("outcome") == "expired":
		return View.make(ctx, "SignInHandoff", {
			"state": "expired",
			"copy": ["signInHandoff.newCode"],
			"args": args,
			"primary": "signInHandoff.newCode",
			"tone": "neutral",
		})
	if s.get("outcome") == "cancelled":
		return View.make(ctx, "SignInHandoff", {
			"state": "cancelled",
			"copy": ["signin.handoff.cancelled", "signInHandoff.newCode"],
			"args": args,
			"primary": "signInHandoff.newCode",
		})
	return View.make(ctx, "SignInHandoff", {
		"state": "starting",
		"copy": ["signInHandoff.starting", "a11y.busy"],
		"args": args,
		"focus": null,
	})


## The code view (UI-KITS.md §4.3, DL14): the code, the address and the countdown everywhere; a QR
## only on a TV or a console; Open browser where the device can browse. The QR, Copy and the
## visible text carry exactly the same code and link.
static func _code_view(ctx: RefCounted, c: String, link: Dictionary, args: Dictionary) -> Dictionary:
	var head := ["signin.handoff.codeTitle", "part.code.label", "a11y.code"]
	var has_url: bool = link["url"] != null
	if c == "tv":
		return View.make(ctx, "SignInHandoff", {
			"state": "code",
			# The QR beside the code, the address on its own line.
			"copy": head + [
				_and(link["qr"], "a11y.qr"),
				_and(link["qr"], "signInHandoff.scanTv"),
				_and(has_url, "signin.handoff.url"),
			],
			"args": args,
			"link": link,
		})
	if c == "console":
		return View.make(ctx, "SignInHandoff", {
			"state": "code",
			# A larger QR the person can enlarge; the address inside the sentence.
			"copy": head + [
				_and(link["qr"], "a11y.qr"),
				_and(link["qr"], "part.qr.enlarge"),
				"signInHandoff.scan",
			],
			"args": args,
			"link": link,
		})
	var open = _and(link["open"], "signin.handoff.openBrowser")
	if c == "handheld":
		return View.make(ctx, "SignInHandoff", {
			"state": "code",
			# A phone leads with Open browser, then the code with Copy and the address with Copy.
			"copy": head + [
				"a11y.copyCode",
				_and(has_url, "signin.handoff.url"),
				_and(has_url, "a11y.copyAddress"),
				open,
			],
			"args": args,
			"primary": "signin.handoff.openBrowser" if link["open"] else null,
			"link": link,
		})
	return View.make(ctx, "SignInHandoff", {
		"state": "code",
		"copy": head + [
			"a11y.copyCode",
			_and(has_url, "signin.handoff.codeBody"),
			open,
		],
		"args": args,
		"primary": "signin.handoff.openBrowser" if link["open"] else null,
		"link": link,
	})


# ── LicenseChoice ──────────────────────────────────────────────────────────────────────────────

## `LicenseChoiceState`.
const LICENSE_CHOICE_STATES := [
	"loading", "many", "one", "current", "keep", "new", "create", "all-full", "mixed", "replace-open",
	"raced", "none-keys", "none-no-keys", "grant-expired", "hidden",
]

## A license's origin in plain words (SIGN-IN.md O-17); `purchase` needs none. Keys whose facts
## `LicenseChoice` does not carry (a key's last six, a gift, an organization) wait for the
## packages that add them.
const ORIGIN_KEY := {
	"store": "signin.choice.origin.store",
	"key": "signin.choice.origin.keyAdded",
	"free": "signin.choice.origin.free",
	"developer": "signin.choice.origin.developer",
	"signin": "signin.choice.origin.signIn",
}


## Step 3 of the form: choose a license for this device.
static func license_choice_view(ctx: RefCounted) -> Dictionary:
	var s = ctx.input.get("signIn")
	if (
		not _sign_in_on(ctx)
		or not ctx.on("license")
		or not (s is Dictionary)
		or not _chooses_in_app(ctx)
		or s.get("outcome") != "choose"
	):
		return View.hidden(ctx, "LicenseChoice")
	var id := View.identity_text(ctx)
	var args := {"product": id["name"]}
	if View.truthy(ctx.input.get("loading")):
		return View.make(ctx, "LicenseChoice", {
			"state": "loading",
			"copy": ["signin.choice.title", "common.loading"] if Loading.visible(ctx.input.get("elapsedMs")) else [],
			"args": args,
			"focus": null,
		})
	if View.truthy(s.get("grantExpired")):
		return View.make(ctx, "LicenseChoice", {
			"state": "grant-expired",
			"copy": ["signin.handoff.tooLong", "signin.again"],
			"args": args,
			"primary": "signin.again",
			"tone": "neutral",
		})
	var view = ctx.input.get("choices")
	if not View.truthy(view):
		return View.make(ctx, "LicenseChoice", {
			"state": "loading",
			"copy": ["signin.choice.title", "common.loading"],
			"args": args,
			"focus": null,
		})
	var rows := _arr(view.get("choices"))
	var replace_browser: bool = s.get("event") == "open-replace" and s.get("replace") == "browser"
	var extra_actions := ["replace-in-browser"] if replace_browser else []
	var full := rows.filter(func(r): return r.get("state") != "free")
	var replaceable = null
	for r in full:
		if View.truthy(_dict(r.get("replace")).get("allowed")):
			replaceable = r
			break
	var replace_link := Link.verdict(_dict(replaceable).get("freeDeviceUrl"), ctx.platform, "replace-device")
	if View.truthy(s.get("raced")):
		return View.make(ctx, "LicenseChoice", {
			"state": "raced",
			"copy": ["signin.replace.raced" if s.get("event") == "confirm-replace" else "signin.choice.raced"],
			"args": args,
			"primary": "signin.choice.continue",
			"tone": "neutral",
		})
	if s.get("event") == "open-replace" and s.get("replace") == "inline" and View.truthy(ctx.input.get("replaceView")):
		var devices := _arr(_dict(ctx.input["replaceView"]).get("devices"))
		var pick = null
		for d in devices:
			if View.truthy(d.get("leastRecent")):
				pick = d
				break
		if pick == null and not devices.is_empty():
			pick = devices[0]
		var open_args := args.duplicate()
		open_args["device"] = _dict(pick).get("label")
		return View.make(ctx, "LicenseChoice", {
			"state": "replace-open",
			"copy": [
				"signin.replace.title",
				"signin.replace.open",
				"signin.replace.confirm",
				"signin.replace.consequence",
				"signin.replace.back",
			],
			"args": open_args,
			"primary": "signin.replace.confirm",
		})
	if view.get("state") == "none":
		var get_license := _dict(view.get("getLicense"))
		if View.truthy(get_license.get("keyEntry")) and View.truthy(ctx.caps.get("keyEntry")):
			return View.make(ctx, "LicenseChoice", {
				"state": "none-keys",
				"copy": ["signin.none.title", "signin.none.body", "signin.choice.keyInstead"],
				"args": args,
				"primary": "signin.choice.keyInstead",
			})
		var purchase := Link.verdict(get_license.get("purchaseUrl"), ctx.platform, "purchase")
		var can_get: bool = purchase["url"] != null
		return View.make(ctx, "LicenseChoice", {
			"state": "none-no-keys",
			"copy": [
				"signin.none.title",
				"signin.none.body",
				_and(can_get, "signin.none.get"),
				"signin.none.otherAccount",
			],
			"args": args,
			"primary": "signin.none.get" if can_get else "signin.none.otherAccount",
			"link": purchase if can_get else null,
		})
	var create = view.get("create")
	if view.get("state") == "autoIssue":
		var new_args := args.duplicate()
		new_args["tier"] = _dict(create).get("tierName")
		return View.make(ctx, "LicenseChoice", {
			"state": "new",
			"copy": ["signin.choice.ledeNew", "signin.choice.metaNew", "signin.choice.tag.new"],
			"args": new_args,
			"primary": "signin.choice.continue",
		})
	if View.first([ctx.input.get("selected"), view.get("preselected")]) == "create" and View.truthy(create):
		var create_args := args.duplicate()
		create_args["tier"] = create.get("tierName")
		return View.make(ctx, "LicenseChoice", {
			"state": "create",
			"copy": ["signin.choice.create", "signin.choice.createMeta"],
			"args": create_args,
			"primary": "signin.choice.continue",
		})
	var free := rows.filter(func(r): return r.get("state") == "free")
	if free.is_empty() and not View.truthy(view.get("keep")):
		# A full license is a limit, not an error (DL6): its fix is the primary.
		var fix = null
		var message := "signin.choice.noneReplaceable"
		if View.truthy(create):
			fix = "signin.choice.create"
			message = "signin.choice.allFullCreate"
		elif View.truthy(replaceable):
			fix = "signin.replace.open"
			message = "signin.choice.allFull"
		return View.make(ctx, "LicenseChoice", {
			"state": "all-full",
			"copy": ["signin.choice.tag.full", message],
			"args": args,
			"extraActions": extra_actions,
			"primary": fix,
			"tone": "neutral",
			"link": replace_link if replace_browser else null,
		})
	if View.truthy(view.get("keep")):
		# Keep is its own row and outcome: never blurred with create or a new license (Must not).
		return View.make(ctx, "LicenseChoice", {
			"state": "keep",
			"copy": ["signin.choice.keep", "signin.choice.keepMeta"],
			"args": args,
			"extraActions": extra_actions,
			"primary": "signin.choice.continue",
		})
	if rows.any(func(r): return View.truthy(r.get("current"))):
		return View.make(ctx, "LicenseChoice", {
			"state": "current",
			"copy": ["signin.choice.tag.current"],
			"args": args,
			"extraActions": extra_actions,
			"primary": "signin.choice.continue",
		})
	var access := {}
	for r in rows:
		access[r.get("access")] = true
	if access.has("account") and access.has("seats"):
		return View.make(ctx, "LicenseChoice", {
			"state": "mixed",
			# `signin.choice.combined` waits for an SDK result that carries the entitlement model.
			"copy": [],
			"args": args,
			"extraActions": extra_actions,
			"primary": "signin.choice.continue",
		})
	if rows.size() == 1:
		var one_args := args.duplicate()
		one_args["tier"] = rows[0].get("tierName")
		return View.make(ctx, "LicenseChoice", {
			"state": "one",
			"copy": ["signin.choice.title", "signin.choice.lede", "signin.choice.continue"],
			"args": one_args,
			"extraActions": extra_actions,
			"primary": "signin.choice.continue",
		})
	return View.make(ctx, "LicenseChoice", {
		"state": "many",
		"copy": [
			"signin.choice.title",
			"signin.choice.lede",
			"signin.choice.group",
			"signin.choice.meta",
			"signin.choice.devices",
			"signin.choice.continue",
		] + _row_copy(rows),
		"args": args,
		"extraActions": extra_actions,
		"primary": "signin.choice.continue",
	})


## The origin and term keys the rows' meta lines use.
static func _row_copy(rows: Array) -> Array:
	var out := []
	for r in rows:
		var origin = ORIGIN_KEY.get(r.get("origin"))
		if origin != null:
			out.append(origin)
		# `expiresAt === null` (a lifetime license); an absent member is not null in TS.
		out.append("signin.term.lifetime" if r.has("expiresAt") and r["expiresAt"] == null else "signin.term.until")
	return out


# ── Helpers (GDScript only) ────────────────────────────────────────────────────────────────────

## TS's `cond && "key"`: the key when `cond` is truthy, else null (View.make drops it).
static func _and(cond: Variant, key: String) -> Variant:
	return key if View.truthy(cond) else null


## `v` when it is a Dictionary, else {} (TS's `v?.member` on an absent or null value).
static func _dict(v: Variant) -> Dictionary:
	return v if v is Dictionary else {}


## `v` when it is an Array, else [].
static func _arr(v: Variant) -> Array:
	return v if v is Array else []


## `v` when it is a String, else "" (an absent enum member compares unequal either way).
static func _str(v: Variant) -> String:
	return v if v is String else ""
