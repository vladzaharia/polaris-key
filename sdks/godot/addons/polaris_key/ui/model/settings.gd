extends RefCounted
## The settings and paywall families (ui-matrix.json `settings`, `paywall`): AccountAndLicense,
## Settings, Paywall and EntitlementGate, and the should-tier CloudSyncStatus, About and
## ChannelPicker: the port of ui-core's `models/settings.ts`. A floating license is never
## silently attached to an account; a theme never reveals a hidden value; the paywall never
## invents checkout; a style override is never authorization.

const Context := preload("res://addons/polaris_key/ui/model/context.gd")
const Loading := preload("res://addons/polaris_key/ui/model/loading.gd")
const View := preload("res://addons/polaris_key/ui/model/view.gd")

# ── AccountAndLicense ────────────────────────────────────────────────────────────────────────
#
# States: loading, signed-in, key-only, offline.


## The settings pane for the license and the account.
static func account_view(ctx: RefCounted) -> Dictionary:
	var id := View.identity_text(ctx)
	var args := {"product": id["name"], "developer": id["developer"]}
	if View.truthy(ctx.input.get("loading")):
		return View.make(ctx, "AccountAndLicense", {
			"state": "loading",
			"copy": ["account.title", "common.loading"] if Loading.visible(ctx.input.get("elapsedMs")) else [],
			"args": args,
			"focus": null,
		})
	if ctx.on("license") and _eq(ctx.member("gate").get("status"), "grace"):
		return View.make(ctx, "AccountAndLicense", {
			"state": "offline",
			"copy": ["account.offline", "part.status.grace"],
			"args": args,
		})
	var account: Dictionary = ctx.member("account")
	var license: bool = ctx.on("license")
	var update: bool = ctx.on("update")
	# A floating license shows no holder: it is never attached to an account behind the person's
	# back (Must not), and the holder is only ever the account signed in on this device (S-19).
	if not ctx.on("identity") or not View.truthy(account.get("signedIn")):
		return View.make(ctx, "AccountAndLicense", {
			"state": "key-only",
			"copy": [
				"account.title",
				_when(license, "account.tier"),
				_when(license, "account.keyOnly"),
				_when(update, "account.updates"),
				"common.signOut",
			],
			"args": args,
		})
	return View.make(ctx, "AccountAndLicense", {
		"state": "signed-in",
		"copy": [
			"account.title",
			_when(license, "account.tier"),
			"account.holder",
			"common.manage",
			"a11y.externalLink",
			_when(license, "account.devices"),
			_when(ctx.on("sync"), "account.cloudSync"),
			_when(update, "account.updates"),
			_when(update, "account.autoUpdate"),
			_when(update, "account.channel"),
			_when(update, "update.checkNow"),
			"account.version",
			_when(ctx.on("config"), "account.managedSettings"),
			"common.signOut",
			_when(_powered_by(ctx), "part.poweredBy"),
		],
		"args": args,
	})


# ── Settings ─────────────────────────────────────────────────────────────────────────────────
#
# States: loading, list, dirty, saving, locked, error, hidden.

## Settings rows are shown with a search field above this many (UI-KITS.md §4.1).
const SETTINGS_SEARCH_ABOVE := 12

## The sources a row's provenance names in text (`settings.source.*`).
const SOURCES := ["default", "local", "env"]


## Config-catalog-driven settings with typed controls and provenance as text.
static func settings_view(ctx: RefCounted) -> Dictionary:
	if not ctx.on("config"):
		return View.hidden(ctx, "Settings")
	var config = ctx.input.get("config")
	var edit: Dictionary = ctx.member("edit")
	var error = ctx.input.get("error")
	var pending = ctx.input.get("pending")
	var saving_now := _eq(pending, "save")
	var id := View.identity_text(ctx)
	var args := {"developer": View.first([id["developer"], id["name"]])}
	if View.truthy(ctx.input.get("loading")):
		return View.make(ctx, "Settings", {
			"state": "loading",
			"copy": ["settings.title", "common.loading"] if Loading.visible(ctx.input.get("elapsedMs")) else [],
			"args": args,
			"focus": null,
		})
	if View.truthy(error):
		var save := _eq(edit.get("kind"), "value")
		return View.make(ctx, "Settings", {
			"state": "error",
			"copy": [
				"settings.error" if save else "settings.loadFailed",
				"common.tryAgain",
			],
			"args": args,
			"primary": "common.tryAgain",
			"tone": "danger",
			"errorSlot": "common.save" if save else "screen",
		})
	if saving_now or View.truthy(ctx.input.get("saved")):
		var saving := {
			"state": "saving",
			"copy": ["settings.saving" if saving_now else "settings.saved"],
			"args": args,
			"primary": "common.save",
		}
		# Saving focuses the primary (`focus` left out); saved never takes focus.
		if not saving_now:
			saving["focus"] = null
		return View.make(ctx, "Settings", saving)
	if _eq(edit.get("kind"), "value"):
		return View.make(ctx, "Settings", {
			"state": "dirty",
			"copy": ["settings.unsaved", "common.save"],
			"args": args,
			"primary": "common.save",
			"focus": null,
		})
	var rows := []
	if config is Array:
		for r in config:
			rows.append(_dict(r))
	var locked = null
	for r in rows:
		if View.truthy(r.get("locked")):
			locked = r
			break
	if locked != null:
		# A locked row names who set it: the organization, or the platform's guardian controls. A
		# host's own reason is the host's string, never invented here.
		var locked_args := args.duplicate()
		locked_args["org"] = locked.get("org")
		return View.make(ctx, "Settings", {
			"state": "locked",
			"copy": [
				"settings.setBy" if View.truthy(locked.get("org")) else "settings.setByGuardian",
				"a11y.locked",
			],
			"args": locked_args,
		})
	if rows.is_empty():
		return View.make(ctx, "Settings", {
			"state": "list",
			"copy": ["settings.title", "settings.empty"],
			"args": args,
		})
	# The theme decides nothing here: the rows are what config.list returned (Must not).
	var copy := [
		"settings.title",
		_when(rows.size() > SETTINGS_SEARCH_ABOVE, "settings.search"),
		_when(_some(rows, "source", "default"), "settings.fromDeveloper"),
	]
	for r in rows:
		var s = r.get("source")
		if s is String and SOURCES.has(s):
			copy.append("settings.source.%s" % s)
	copy.append(_when(_some(rows, "source", "local"), "settings.reset"))
	var advanced := false
	var ranged := false
	for r in rows:
		if View.truthy(r.get("advanced")):
			advanced = true
		if _eq(r.get("type"), "number") and r.has("min") and r.has("max"):
			ranged = true
	copy.append(_when(advanced, "settings.advanced"))
	copy.append(_when(ranged, "settings.range"))
	copy.append(_when(_some(rows, "type", "boolean"), "settings.on"))
	copy.append(_when(_some(rows, "type", "boolean"), "settings.off"))
	return View.make(ctx, "Settings", {
		"state": "list",
		"copy": copy,
		"args": args,
	})


# ── Paywall ──────────────────────────────────────────────────────────────────────────────────
#
# States: loading, offers, purchasing, purchased, restore, not-available, hidden.


## True where the platform's own store sells the offer in the app (StoreKit, Play Billing).
static func _store_purchase(ctx: RefCounted) -> bool:
	var os = _dict(ctx.platform).get("os")
	return (
		View.truthy(ctx.caps.get("purchase"))
		and (_eq(os, "ios") or _eq(os, "android"))
		and Context.platform_class(ctx.platform) == "handheld"
	)


## Entitlement-gated upsell: the platform's store, or the portal; never an invented checkout.
static func paywall_view(ctx: RefCounted) -> Dictionary:
	if not ctx.on("license"):
		return View.hidden(ctx, "Paywall")
	var offers: Dictionary = ctx.member("offers")
	var args := {"product": View.identity_text(ctx)["name"]}
	if View.truthy(ctx.input.get("loading")):
		return View.make(ctx, "Paywall", {
			"state": "loading",
			"copy": ["common.loading"] if Loading.visible(ctx.input.get("elapsedMs")) else [],
			"args": args,
			"focus": null,
		})
	var buy := "paywall.upgrade" if _store_purchase(ctx) else "paywall.portal"
	if _eq(ctx.input.get("pending"), "purchase"):
		return View.make(ctx, "Paywall", {
			"state": "purchasing",
			"copy": ["paywall.purchasing", "a11y.busy"],
			"args": args,
			"primary": buy,
		})
	if _eq(ctx.input.get("pending"), "restore"):
		return View.make(ctx, "Paywall", {
			"state": "restore",
			"copy": ["paywall.restore"],
			"args": args,
			"focus": null,
		})
	if View.truthy(offers.get("purchased")):
		return View.make(ctx, "Paywall", {
			"state": "purchased",
			"copy": ["paywall.purchased", "common.done"],
			"args": args,
			"primary": "common.done",
		})
	if not View.truthy(offers.get("available")):
		return View.make(ctx, "Paywall", {
			"state": "not-available",
			"copy": ["paywall.notAvailable"],
			"args": args,
			"tone": "neutral",
		})
	return View.make(ctx, "Paywall", {
		"state": "offers",
		"copy": ["paywall.title", "paywall.includes", buy, "paywall.redeem"],
		"args": args,
		"primary": buy,
	})


# ── EntitlementGate ──────────────────────────────────────────────────────────────────────────
#
# States: entitled, not-entitled, loading.


## Renders its children only when the entitlement holds.
static func entitlement_gate_view(ctx: RefCounted) -> Dictionary:
	if View.truthy(ctx.input.get("loading")):
		return View.make(ctx, "EntitlementGate", {
			"state": "loading",
			"copy": ["common.loading"] if Loading.visible(ctx.input.get("elapsedMs")) else [],
			"focus": null,
		})
	# License off: no license document, so the entitlement is false; the paywall is hidden, so
	# there is no unlock. An integrator's style never changes this (Must not).
	var license: bool = ctx.on("license")
	if license and _eq(ctx.member("entitlement").get("entitled"), true):
		return View.make(ctx, "EntitlementGate", {
			"state": "entitled",
			"copy": [],
			"focus": null,
		})
	return View.make(ctx, "EntitlementGate", {
		"state": "not-entitled",
		"copy": ["entitlement.locked", _when(license, "entitlement.unlock")],
		"primary": "entitlement.unlock" if license else null,
		"focus": null,
	})


# ── The should tier: CloudSyncStatus, About, ChannelPicker ───────────────────────────────────
#
# CloudSyncStatus states: synced, syncing, offline, conflict, error, hidden.


## A small Cloud Sync status. It never implies universal backup.
static func cloud_sync_status_view(ctx: RefCounted) -> Dictionary:
	var raw = ctx.input.get("cloudSync")
	if not ctx.on("sync") or not View.truthy(raw):
		return View.hidden(ctx, "CloudSyncStatus")
	var sync := _dict(raw)
	var state = sync.get("state")
	var error := _eq(state, "error")
	var sign_in := error and _eq(sync.get("signedIn"), false)
	return View.make(ctx, "CloudSyncStatus", {
		"state": state,
		"copy": [
			"cloudSync.%s" % [state],
			_when(sign_in, "cloudSync.signIn"),
		],
		"primary": "cloudSync.signIn" if sign_in else null,
		"tone": "danger" if error else null,
		"focus": null,
	})


## Product, version, build, notices and Copy diagnostics (always redacted).
static func about_view(ctx: RefCounted) -> Dictionary:
	var id := View.identity_text(ctx)
	return View.make(ctx, "About", {
		"state": "default",
		"copy": [
			"about.title",
			"about.version",
			"about.licenses",
			"about.copyDiagnostics",
			_when(_powered_by(ctx), "part.poweredBy"),
		],
		"args": {"product": id["name"]},
	})


## The release channel choice: locked only with its reason.
static func channel_picker_view(ctx: RefCounted) -> Dictionary:
	if not ctx.on("release"):
		return View.hidden(ctx, "ChannelPicker")
	if View.truthy(ctx.member("channel").get("locked")):
		return View.make(ctx, "ChannelPicker", {
			"state": "locked",
			"copy": ["channel.locked", "a11y.locked"],
		})
	return View.make(ctx, "ChannelPicker", {
		"state": "default",
		"copy": ["channel.title"],
	})


# ── Helpers ──────────────────────────────────────────────────────────────────────────────────


## ui-core's `cond && "key"`: the key when `cond` holds, else "" (View.make drops it).
static func _when(cond: bool, key: String) -> String:
	return key if cond else ""


## `ctx.input.integrator?.poweredBy !== undefined`: the member is present, whatever its value.
static func _powered_by(ctx: RefCounted) -> bool:
	return ctx.member("integrator").has("poweredBy")


## `rows.some((r) => r[field] === value)`.
static func _some(rows: Array, field: String, value: Variant) -> bool:
	for r in rows:
		if _eq(r.get(field), value):
			return true
	return false


## TS `a === b` for a value from the input: GDScript's `==` raises on operands of different types
## (a number where a string was expected), so the types must match first.
static func _eq(a: Variant, b: Variant) -> bool:
	return typeof(a) == typeof(b) and a == b


## `v` when it is a Dictionary, else {} (TS optional chaining: a missing member reads undefined).
static func _dict(v: Variant) -> Dictionary:
	return v if v is Dictionary else {}
