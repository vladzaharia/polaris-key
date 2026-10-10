extends RefCounted
## The gate family (ui-matrix.json `gate`): PolarisKeyGate, Boot, StatusScreen, GraceBanner and
## Toast, the port of ui-core's `models/gate.ts`. The gate routes; Boot draws the stage machine
## (client-core `stages.ts`, `ui.stages`); StatusScreen draws each blocking status with its own fix
## (never one collapsed error); the grace banner never extends grace visually; a toast is never the
## only record of an error.

const Errors := preload("res://addons/polaris_key/ui/model/errors.gd")
const Loading := preload("res://addons/polaris_key/ui/model/loading.gd")
const View := preload("res://addons/polaris_key/ui/model/view.gd")

## The statuses that block the app, each a StatusScreen state with its own fix.
const BLOCKING_STATUSES := [
	"revoked",
	"expired",
	"version-too-old",
	"version-too-new",
	"channel-not-entitled",
]


static func _is_blocking(s: Variant) -> bool:
	return s is String and BLOCKING_STATUSES.has(s)


# ── PolarisKeyGate ────────────────────────────────────────────────────────────────────────────
#
# States: booting, needs-activation, licensed, grace, blocked, error.


## The drop-in root: which screen the gate shows over (or instead of) the app.
static func gate_view(ctx: RefCounted) -> Dictionary:
	var gate: Dictionary = ctx.member("gate")
	var stage: Dictionary = ctx.member("stage")
	var status = gate.get("status")
	# License off: the gate never stands between the person and the app.
	if not ctx.on("license") or status == "not-applicable" or status == "ok":
		return View.make(ctx, "PolarisKeyGate", {
			"state": "licensed",
			"copy": [],
			"focus": null,
		})
	if stage.get("outcome") == "error":
		return View.make(ctx, "PolarisKeyGate", {
			"state": "error",
			"copy": ["gate.error.title", "common.tryAgain"],
			"primary": "common.tryAgain",
			"tone": "danger",
			"errorSlot": "screen",
		})
	# A cached license being re-checked stays `booting`: activation never flashes (Must not).
	if View.truthy(gate.get("checking")) or status == null:
		return View.make(ctx, "PolarisKeyGate", {
			"state": "booting",
			"copy": ["gate.checking"] if Loading.visible(ctx.input.get("elapsedMs")) else [],
			"focus": null,
		})
	if status == "needs-activation":
		return View.make(ctx, "PolarisKeyGate", {
			"state": "needs-activation",
			"copy": [
				"core.gate.needs-activation.title",
				"core.gate.needs-activation.message",
			],
			# Welcome draws the paths; the gate itself has no control.
			"focus": null,
		})
	if status == "grace":
		return View.make(ctx, "PolarisKeyGate", {
			"state": "grace",
			"copy": [
				"core.gate.grace.title",
				"core.gate.grace.message",
				"common.reconnect",
			],
			# The app renders; the grace banner carries Reconnect and never takes focus.
			"focus": null,
		})
	if _is_blocking(status):
		return View.make(ctx, "PolarisKeyGate", {
			"state": "blocked",
			"copy": ["part.status.blocked"],
			"tone": "neutral",
			# StatusScreen draws the fix.
			"focus": null,
		})
	return View.make(ctx, "PolarisKeyGate", {
		"state": "error",
		"copy": ["gate.error.title", "common.tryAgain"],
		"primary": "common.tryAgain",
		"tone": "danger",
		"errorSlot": "screen",
	})


# ── Boot ──────────────────────────────────────────────────────────────────────────────────────
#
# States: progress, consent, fetching, offline, blocked, declined, rolled-back, error.

## The progress line for each running stage (no invented progress: one label, a still shimmer).
const STAGE_LABEL := {
	"idle": "boot.starting",
	"shell": "boot.starting",
	"guard": "boot.starting",
	"sync": "boot.syncing",
	"gate": "gate.checking",
	"decide": "boot.deciding",
	"mount": "common.loading",
	"background": "common.loading",
}


## First paint while the stage machine runs.
static func boot_view(ctx: RefCounted) -> Dictionary:
	var stage = ctx.input.get("stage")
	if not (stage is Dictionary):
		stage = {"stage": "idle", "outcome": "running"}
	var emit: Dictionary = stage.get("emit") if stage.get("emit") is Dictionary else {}
	var product: String = View.identity_text(ctx)["name"]
	if emit.get("type") == "boot_rolled_back":
		return View.make(ctx, "Boot", {
			"state": "rolled-back",
			"copy": ["boot.rolledBack"],
			"args": {"product": product},
			"focus": null,
		})
	match stage.get("outcome"):
		"error":
			return View.make(ctx, "Boot", {
				"state": "error",
				"copy": ["gate.error.title", "boot.error.body", "common.tryAgain"],
				"primary": "common.tryAgain",
				"tone": "danger",
				"errorSlot": "screen",
			})
		"blocked":
			if emit.get("reason") == "content-declined":
				return View.make(ctx, "Boot", {
					"state": "declined",
					"copy": [
						"boot.declined.title",
						"boot.declined.body",
						"common.tryAgain",
					],
					"primary": "common.tryAgain",
					"tone": "neutral",
				})
			# `update-required` and `not-available`: StatusScreen names the exact refusal; Boot
			# stops on the update it needs.
			return View.make(ctx, "Boot", {
				"state": "blocked",
				"copy": [
					"core.gate.version-too-old.title",
					"core.gate.version-too-old.message",
					"status.update",
				],
				"primary": "status.update",
				"tone": "neutral",
			})
		"offline":
			var playable := _is_true(emit.get("canPlayOffline"))
			return View.make(ctx, "Boot", {
				"state": "offline",
				"copy": [
					"boot.offline.title",
					"boot.offline.playable" if playable else "boot.offline.body",
					"boot.continueOffline" if playable else null,
					"common.tryAgain",
				],
				"args": {"product": product},
				"primary": "boot.continueOffline" if playable else "common.tryAgain",
			})
		"waiting":
			if emit.get("type") == "consent_needed":
				var metered := _is_true(emit.get("metered"))
				var bytes = emit.get("bytes")
				return View.make(ctx, "Boot", {
					"state": "consent",
					# Both choices stay on screen, metered or not (Must not).
					"copy": [
						"boot.consent.title",
						"boot.consent.bodyMetered" if metered else "boot.consent.body",
						"boot.consent.download",
						"common.notNow",
					],
					"args": {"size": bytes if (bytes is float or bytes is int) else null},
					"primary": "boot.consent.download",
				})
		"ready":
			return View.make(ctx, "Boot", {
				"state": "progress",
				"copy": ["boot.ready"],
				"focus": null,
			})
	if stage.get("stage") == "fetch":
		# A determinate bar only for counted bytes (DL7): before the first report there is none.
		var counted: bool = emit.get("type") == "fetch_progress"
		return View.make(ctx, "Boot", {
			"state": "fetching",
			"copy": ["boot.fetchingProgress", "a11y.progress"] if counted else ["boot.fetching"],
			"args": {"done": emit.get("done"), "total": emit.get("total")} if counted else {},
			"focus": null,
		})
	return View.make(ctx, "Boot", {
		"state": "progress",
		"copy": [STAGE_LABEL.get(stage.get("stage"), "common.loading"), "a11y.busy"],
		"focus": null,
	})


# ── StatusScreen ──────────────────────────────────────────────────────────────────────────────
#
# States: each of BLOCKING_STATUSES, or hidden.


## One blocking status and its fix (DL6: a neutral refusal whose fix is the primary).
static func status_screen_view(ctx: RefCounted) -> Dictionary:
	var gate: Dictionary = ctx.member("gate")
	var status = gate.get("status")
	if not ctx.on("license") or not _is_blocking(status):
		return View.hidden(ctx, "StatusScreen")
	var allowed: Dictionary = gate.get("allowed") if gate.get("allowed") is Dictionary else {}
	var has_min: bool = allowed.get("min") != null
	var has_max: bool = allowed.get("max") != null
	var range_key = (
		"status.allowedRange" if has_min and has_max
		else "status.allowedMin" if has_min
		else "status.allowedMax" if has_max
		else null
	)
	var head := ["core.gate.%s.title" % status, "core.gate.%s.message" % status]
	var id := View.identity_text(ctx)
	var args := {
		"product": id["name"],
		"developer": id["developer"],
		"min": allowed.get("min"),
		"max": allowed.get("max"),
	}
	match status:
		"revoked":
			return View.make(ctx, "StatusScreen", {
				"state": status,
				"copy": head + ["signin.key.differentKey", "common.signOut"],
				"args": args,
				"primary": "signin.key.differentKey",
				"tone": "neutral",
			})
		"expired":
			return View.make(ctx, "StatusScreen", {
				"state": status,
				"copy": head + ["status.renew", "status.useAnotherLicense"],
				"args": args,
				"primary": "status.renew",
				"tone": "neutral",
			})
		"version-too-old":
			return View.make(ctx, "StatusScreen", {
				"state": status,
				"copy": head + [range_key, "status.update"],
				"args": args,
				"primary": "status.update",
				"tone": "neutral",
			})
		"version-too-new":
			# No fix the kit can reach: it is named in words (DL6), and the heading takes focus.
			return View.make(ctx, "StatusScreen", {
				"state": status,
				"copy": head + [null if range_key == "status.allowedMin" else range_key],
				"args": args,
				"tone": "neutral",
			})
	# "channel-not-entitled": the last blocking status.
	return View.make(ctx, "StatusScreen", {
		"state": status,
		"copy": head + ["status.switchChannel", "status.contact"],
		"args": args,
		"primary": "status.switchChannel",
		"tone": "neutral",
	})


# ── GraceBanner ───────────────────────────────────────────────────────────────────────────────
#
# States: days-left, last-day, expired, hidden.


## Offline grace: never shows a day that is not left (Must not).
static func grace_banner_view(ctx: RefCounted) -> Dictionary:
	var gate: Dictionary = ctx.member("gate")
	if not ctx.on("license"):
		return View.hidden(ctx, "GraceBanner")
	if gate.get("status") == "expired":
		return View.make(ctx, "GraceBanner", {
			"state": "expired",
			"copy": ["core.gate.expired.title", "core.gate.expired.message"],
			"tone": "neutral",
			"focus": null,
		})
	if gate.get("status") != "grace":
		return View.hidden(ctx, "GraceBanner")
	var days = gate.get("graceDaysLeft")
	if (days is float or days is int) and days <= 1:
		return View.make(ctx, "GraceBanner", {
			"state": "last-day",
			"copy": ["grace.lastDay", "common.reconnect"],
			"primary": "common.reconnect",
			"focus": null,
		})
	return View.make(ctx, "GraceBanner", {
		"state": "days-left",
		"copy": [
			"grace.daysLeft",
			"grace.deadline",
			"common.reconnect",
			"common.dismiss",
		],
		"args": {"days": days},
		"primary": "common.reconnect",
		"focus": null,
	})


# ── Toast ─────────────────────────────────────────────────────────────────────────────────────
#
# States: info, success, warning, error, with-progress, hidden.


## One toast. An error toast persists (no timer) and never stands alone (Must not).
static func toast_view(ctx: RefCounted) -> Dictionary:
	var kind = ctx.member("toast").get("kind")
	match kind:
		"update":
			if not ctx.on("update"):
				return View.hidden(ctx, "Toast")
			return View.make(ctx, "Toast", {
				"state": "info",
				"copy": ["toast.updateAvailable", "common.dismiss", "a11y.toastTimer"],
				"args": {"version": ctx.member("update").get("version")},
				"focus": null,
			})
		"copied":
			return View.make(ctx, "Toast", {
				"state": "success",
				"copy": ["common.copied"],
				"focus": null,
			})
		"warning":
			return View.make(ctx, "Toast", {
				"state": "warning",
				"copy": ["common.dismiss"],
				"focus": null,
			})
		"error":
			return View.make(ctx, "Toast", {
				"state": "error",
				"copy": Errors.code_copy(ctx.member("error").get("code")) + ["common.dismiss"],
				"tone": "danger",
				"focus": null,
			})
		"progress":
			var progress = ctx.member("update").get("progress")
			return View.make(ctx, "Toast", {
				"state": "with-progress",
				"copy": ["updateProgress.downloading", "toast.undo"],
				"args": {"fraction": progress.get("fraction") if progress is Dictionary else null},
				"focus": null,
			})
	return View.hidden(ctx, "Toast")


## TS `x === true`.
static func _is_true(v: Variant) -> bool:
	return v is bool and v
