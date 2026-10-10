extends RefCounted
## The update family (ui-matrix.json `update`): UpdatePrompt, UpdateProgress and ReleaseNotes over
## the update decision (update-matrix.json actions and outlets): the port of ui-core's
## `models/update.ts`. The verb follows the outlet; the web never offers a restart the browser
## cannot perform; nothing says installed when only the download verified; release notes are
## text, never markup.

const Loading := preload("res://addons/polaris_key/ui/model/loading.gd")
const View := preload("res://addons/polaris_key/ui/model/view.gd")

# ── UpdatePrompt ─────────────────────────────────────────────────────────────────────────────
#
# States: available, downloading, ready, mandatory, blocked, store, platform,
# revoked-required-content, up-to-date, hidden.

## The store an outlet opens, by its verb ("Update on the App Store", "Get it on Steam").
const STORE_VERB := {
	"app-store": "update.appStore",
	"play": "update.googlePlay",
	"play-testing": "update.googlePlay",
	"testflight": "update.testflight",
	"altstore": "update.altstore",
	"altstore-pal": "update.altstore",
	"steam": "update.steam",
}

## Who installs an update the app cannot install itself (update-matrix.json `platform`).
const PLATFORM_BODY := {
	"steam": "update.platform.steam",
	"itch": "update.platform.itch",
	"flathub": "update.platform.store",
	"snap": "update.platform.store",
	"ms-store": "update.platform.store",
	"app-installer": "update.platform.appInstaller",
	"winget": "update.platform.command",
	"fdroid-repo": "update.platform.package",
	"web": "update.platform.web",
}


## The update decision as a prompt, with the verb its outlet allows.
static func update_prompt_view(ctx: RefCounted) -> Dictionary:
	var raw = ctx.input.get("update")
	if not ctx.on("update") or not View.truthy(raw):
		return View.hidden(ctx, "UpdatePrompt")
	var u := _dict(raw)
	var id := View.identity_text(ctx)
	var args := {"product": id["name"], "version": u.get("version")}
	var phase = _dict(u.get("progress")).get("phase")
	var action = u.get("action")
	if _eq(action, "binary") and (_eq(phase, "download") or _eq(phase, "verify")):
		var downloading := args.duplicate()
		downloading["fraction"] = _dict(u.get("progress")).get("fraction")
		return View.make(ctx, "UpdatePrompt", {
			"state": "downloading",
			# Restart when ready queues the restart, so the primary is never disabled mid-download.
			"copy": [
				"update.downloading",
				"update.timeLeft",
				"a11y.progress",
				"update.restartWhenReady",
				"update.later",
			],
			"args": downloading,
			"primary": "update.restartWhenReady",
		})
	match action:
		"binary":
			if View.truthy(u.get("mandatory")):
				# A mandatory update has no dismissal.
				return View.make(ctx, "UpdatePrompt", {
					"state": "mandatory",
					"copy": [
						"update.mandatoryTitle",
						"update.mandatoryBody",
						"update.install",
					],
					"args": args,
					"primary": "update.install",
				})
			var copy: Array
			if View.truthy(u.get("version")):
				copy = [
					"update.title",
					"update.current",
					"update.critical" if View.truthy(u.get("critical")) else "",
					"update.whatsNew",
					"update.allChanges",
					"update.install",
					"update.restartWhenReady",
					"update.later",
					"update.skipVersion",
				]
			else:
				copy = [
					"update.availableTitle",
					"update.install",
					"update.restartWhenReady",
					"update.later",
					"update.skipVersion",
				]
			return View.make(ctx, "UpdatePrompt", {
				"state": "available",
				"copy": copy,
				"args": args,
				"primary": "update.install",
			})
		"code-ready":
			return View.make(ctx, "UpdatePrompt", {
				"state": "ready",
				"copy": [
					"update.readyTitle",
					"update.readyBody",
					"update.restartNow",
					"update.later",
				],
				"args": args,
				"primary": "update.restartNow",
			})
		"blocked":
			if _eq(u.get("reason"), "revoked-content"):
				return View.make(ctx, "UpdatePrompt", {
					"state": "revoked-required-content",
					"copy": [
						"core.codes.pack-revoked.title",
						"update.revokedContent",
						"update.install",
					],
					"args": args,
					"primary": "update.install",
					"tone": "neutral",
				})
			return View.make(ctx, "UpdatePrompt", {
				"state": "blocked",
				"copy": ["update.blockedTitle", "update.blockedBody"],
				"args": args,
				"tone": "neutral",
			})
		"store":
			var verb = STORE_VERB.get(_outlet(u), "update.openStore")
			return View.make(ctx, "UpdatePrompt", {
				"state": "store",
				"copy": [verb],
				"args": args,
				"primary": verb,
			})
		"platform":
			# The host installs it; the web never offers a restart (Must not).
			return View.make(ctx, "UpdatePrompt", {
				"state": "platform",
				"copy": [
					"update.availableTitle",
					PLATFORM_BODY.get(_outlet(u), "update.platform.generic"),
				],
				"args": args,
			})
		"none":
			return View.make(ctx, "UpdatePrompt", {
				"state": "up-to-date",
				"copy": ["update.upToDate", "update.checkNow"],
				"args": args,
			})
	return View.hidden(ctx, "UpdatePrompt")


# ── UpdateProgress ───────────────────────────────────────────────────────────────────────────
#
# States: queued, downloading, installing, paused, failed, done, hidden.


## Download and install progress for an app update or content packs.
static func update_progress_view(ctx: RefCounted) -> Dictionary:
	var raw = ctx.input.get("update")
	var u := _dict(raw)
	var p = u.get("progress")
	if not ctx.on("update") or not View.truthy(raw) or not View.truthy(p):
		return View.hidden(ctx, "UpdateProgress")
	var progress := _dict(p)
	var args := {"fraction": progress.get("fraction")}
	match progress.get("phase"):
		"queued":
			return View.make(ctx, "UpdateProgress", {
				"state": "queued",
				"copy": [
					"updateProgress.contentTitle" if _eq(u.get("action"), "packs") else "",
					"updateProgress.queued",
				],
				"args": args,
				"focus": null,
			})
		"download", "verify":
			# Verification happens inside downloading: never "installed" before apply (Must not).
			return View.make(ctx, "UpdateProgress", {
				"state": "downloading",
				"copy": ["updateProgress.downloading", "a11y.progress"],
				"args": args,
				"focus": null,
			})
		"install":
			return View.make(ctx, "UpdateProgress", {
				"state": "installing",
				# The update is checked before it is applied: the copy never says installed early.
				"copy": ["updateProgress.installing", "update.verifying"],
				"args": args,
				"focus": null,
			})
		"paused":
			return View.make(ctx, "UpdateProgress", {
				"state": "paused",
				"copy": ["updateProgress.paused", "updateProgress.resume"],
				"args": args,
				"primary": "updateProgress.resume",
				"focus": null,
			})
		"failed":
			return View.make(ctx, "UpdateProgress", {
				"state": "failed",
				"copy": ["updateProgress.failed", "common.tryAgain"],
				"args": args,
				"primary": "common.tryAgain",
				"tone": "danger",
				"errorSlot": "updateProgress.failed",
				"focus": null,
			})
		"done":
			return View.make(ctx, "UpdateProgress", {
				"state": "done",
				"copy": ["updateProgress.done"],
				"args": args,
				"focus": null,
			})
	# ui-core's switch is exhaustive over the typed phase and falls through to undefined; an
	# untyped input with an unknown phase renders nothing here.
	return View.hidden(ctx, "UpdateProgress")


# ── ReleaseNotes ─────────────────────────────────────────────────────────────────────────────
#
# States: loading, list, empty, error, hidden.


## The changelog. Notes are plain text: a renderer never executes their markup (Must not).
static func release_notes_view(ctx: RefCounted) -> Dictionary:
	if not ctx.on("release"):
		return View.hidden(ctx, "ReleaseNotes")
	if View.truthy(ctx.input.get("loading")):
		return View.make(ctx, "ReleaseNotes", {
			"state": "loading",
			"copy": ["releaseNotes.title", "common.loading"] if Loading.visible(ctx.input.get("elapsedMs")) else [],
			"focus": null,
		})
	if View.truthy(ctx.input.get("error")):
		return View.make(ctx, "ReleaseNotes", {
			"state": "error",
			"copy": ["releaseNotes.error", "common.tryAgain"],
			"primary": "common.tryAgain",
			"tone": "danger",
			"errorSlot": "screen",
		})
	var notes = ctx.input.get("releaseNotes")
	if not (notes is Array) or (notes as Array).is_empty():
		return View.make(ctx, "ReleaseNotes", {
			"state": "empty",
			"copy": ["releaseNotes.empty"],
		})
	return View.make(ctx, "ReleaseNotes", {
		"state": "list",
		"copy": [
			"releaseNotes.title",
			"releaseNotes.version",
			"releaseNotes.released",
		],
	})


# ── Helpers ──────────────────────────────────────────────────────────────────────────────────


## `v` when it is a Dictionary, else {} (TS optional chaining: a missing member reads undefined).
static func _dict(v: Variant) -> Dictionary:
	return v if v is Dictionary else {}


## TS `a === b` for a value from the input: GDScript's `==` raises on operands of different types
## (a number where a string was expected), so the types must match first.
static func _eq(a: Variant, b: Variant) -> bool:
	return typeof(a) == typeof(b) and a == b


## `u.outlet ?? ""`, as a lookup key.
static func _outlet(u: Dictionary) -> String:
	var o = u.get("outlet")
	return o if o is String else ""
