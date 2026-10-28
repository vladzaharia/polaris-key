extends RefCounted
## The cloudSync family (ui-matrix.json `cloudSync`, U-42.0): CloudSyncStatus and the three Cloud
## Sync screens, UnlockSync, RecoveryCode and RingChange. The port of ui-core's
## `models/cloudSync.ts`. Security points the rows pin (U-sync clients plan §9, S5, S13, T22, T23):
##   - the recovery code is entered only in the app, and the screen says no one will ask for it;
##   - the code is never an input or a copy argument: the kit draws it from the host, once;
##   - Start over warns that synced data will be lost before it runs;
##   - nearby unlock is never offered in v0.10.0 (NearbyApproval does not ship);
##   - a changed ring is confirmed on its own screen: `ring-changed` never offers Unlock, Accept
##     hands the host the ring the person was shown (`changed.served`), and without one there is
##     nothing to accept, only the recovery code.

const View := preload("res://addons/polaris_key/ui/model/view.gd")

# ── CloudSyncStatus ──────────────────────────────────────────────────────────────────────────
#
# States: synced, syncing, offline, conflict, error, locked, ring-changed, hidden.


## A small Cloud Sync status. It never implies universal backup.
static func cloud_sync_status_view(ctx: RefCounted) -> Dictionary:
	var raw = ctx.input.get("cloudSync")
	if not ctx.on("sync") or not View.truthy(raw):
		return View.hidden(ctx, "CloudSyncStatus")
	var sync := _dict(raw)
	var state = sync.get("state")
	# A locked device holds no key: it says so and offers Unlock sync, never a sync time.
	if _eq(state, "locked"):
		return View.make(ctx, "CloudSyncStatus", {
			"state": "locked",
			"copy": ["cloudSync.locked", "cloudSync.unlock"],
			"primary": "cloudSync.unlock",
			"tone": "neutral",
			"focus": null,
		})
	# A changed ring is confirmed first (S5). The kit owns that screen, so Review always shows.
	if _eq(state, "ring-changed"):
		return View.make(ctx, "CloudSyncStatus", {
			"state": "ring-changed",
			"copy": ["cloudSync.ringChanged", "common.review"],
			"primary": "common.review",
			"tone": "neutral",
			"focus": null,
		})
	var error := _eq(state, "error")
	# A sync that failed because nobody is signed in is not a fault: it says so and offers Sign in
	# to sync, in a neutral tone (DL6). Review shows only when the host handles it.
	var signed_out := error and _eq(sync.get("signedIn"), false)
	var review := _eq(state, "conflict") and _eq(sync.get("canReview"), true)
	var copy: Array = ["cloudSync.signedOut", "cloudSync.signIn"] if signed_out else [
		"cloudSync.%s" % [state],
		"common.review" if review else "",
	]
	return View.make(ctx, "CloudSyncStatus", {
		"state": state,
		"copy": copy,
		"args": {"time": sync.get("lastSynced")},
		"primary": "cloudSync.signIn" if signed_out else ("common.review" if review else null),
		"tone": "neutral" if signed_out else ("danger" if error else null),
		"focus": null,
	})


# ── UnlockSync ───────────────────────────────────────────────────────────────────────────────
#
# States: code, invalid, working, failed, start-over-failed, no-code, start-over, hidden.


## Unlock the synced data with the recovery code, or start over.
static func unlock_sync_view(ctx: RefCounted) -> Dictionary:
	var raw = ctx.input.get("unlockSync")
	if not ctx.on("sync") or not View.truthy(raw):
		return View.hidden(ctx, "UnlockSync")
	var u := _dict(raw)
	var step = u.get("step")
	# `u.nearby` is read by no branch: v0.10.0 never offers a nearby unlock.
	if _eq(step, "working"):
		return View.make(ctx, "UnlockSync", {
			"state": "working",
			"copy": ["unlockSync.title", "common.working"],
			"focus": null,
		})
	if _eq(step, "failed"):
		return View.make(ctx, "UnlockSync", {
			"state": "failed",
			"copy": ["unlockSync.title", "unlockSync.failed", "common.tryAgain", "common.cancel"],
			"primary": "common.tryAgain",
			"tone": "danger",
			"errorSlot": "screen",
		})
	if _eq(step, "start-over-failed"):
		# Start over did not run: not an unlock failure. Try again repeats it.
		return View.make(ctx, "UnlockSync", {
			"state": "start-over-failed",
			"copy": ["unlockSync.title", "unlockSync.startOverFailed", "common.tryAgain", "common.cancel"],
			"primary": "common.tryAgain",
			"tone": "danger",
			"errorSlot": "screen",
		})
	if _eq(step, "no-code"):
		# The account holds no recovery code: nothing to enter, so Start over is the way on.
		return View.make(ctx, "UnlockSync", {
			"state": "no-code",
			"copy": ["unlockSync.title", "unlockSync.noCode", "unlockSync.startOver", "common.cancel"],
			"primary": "unlockSync.startOver",
			"tone": "neutral",
			"focus": null,
		})
	if _eq(step, "start-over"):
		# The warning comes first: the sync key is replaced only from this step (T22). Cancel takes
		# the first focus, never the destructive control. `focus` means KEYBOARD focus (and the
		# focus engine); a screen reader's first stop is the heading.
		return View.make(ctx, "UnlockSync", {
			"state": "start-over",
			"copy": ["unlockSync.startOverTitle", "unlockSync.startOverWarning", "unlockSync.startOverConfirm", "common.cancel"],
			"primary": "unlockSync.startOverConfirm",
			"tone": "neutral",
			"focus": "common.cancel",
		})
	var invalid := _eq(step, "invalid")
	return View.make(ctx, "UnlockSync", {
		"state": "invalid" if invalid else "code",
		"copy": [
			"unlockSync.title",
			"unlockSync.lede",
			"unlockSync.field",
			"unlockSync.invalid" if invalid else "",
			"recoveryCode.noAsk",
			"unlockSync.unlock",
			"unlockSync.startOver",
			"common.cancel",
		],
		"primary": "unlockSync.unlock",
		"tone": "danger" if invalid else null,
		"errorSlot": "unlockSync.field" if invalid else null,
		"focus": "unlockSync.field",
	})


# ── RecoveryCode ─────────────────────────────────────────────────────────────────────────────
#
# States: show, saved, hidden.


## The new recovery code, shown once. Done waits for the person to confirm they saved it.
static func recovery_code_view(ctx: RefCounted) -> Dictionary:
	var raw = ctx.input.get("recoveryCode")
	if not ctx.on("sync") or not View.truthy(raw):
		return View.hidden(ctx, "RecoveryCode")
	var saved := _eq(_dict(raw).get("saved"), true)
	return View.make(ctx, "RecoveryCode", {
		"state": "saved" if saved else "show",
		"copy": [
			"recoveryCode.title",
			"recoveryCode.lede",
			"recoveryCode.noAsk",
			"recoveryCode.copy",
			"recoveryCode.saved",
			"common.done" if saved else "",
		],
		"primary": "common.done" if saved else null,
		"focus": View.UNSET if saved else "heading",
	})


# ── RingChange ───────────────────────────────────────────────────────────────────────────────
#
# States: confirm, failed, hidden.


## Confirm a changed ring: it names the device (`changed.by`) and offers to accept the ring that
## was shown (`changed.served`). The recovery code is the primary, safer way in.
static func ring_change_view(ctx: RefCounted) -> Dictionary:
	var raw = ctx.input.get("ringChange")
	if not ctx.on("sync") or not View.truthy(raw):
		return View.hidden(ctx, "RingChange")
	var r := _dict(raw)
	var by = r.get("by")
	var named: bool = by is String and not (by as String).strip_edges().is_empty()
	var failed := _eq(r.get("failed"), true)
	var served := View.truthy(r.get("served"))
	return View.make(ctx, "RingChange", {
		"state": "failed" if failed else "confirm",
		"copy": [
			"ringChange.title",
			"ringChange.body" if named else "ringChange.bodyUnknown",
			# Nothing was served to confirm: no Accept, only the recovery code.
			"ringChange.warning" if served else "ringChange.warningNoServed",
			"ringChange.failed" if failed else "",
			"ringChange.accept" if served else "",
			"ringChange.useCode",
			"common.cancel",
		],
		"args": {"device": by if named else null},
		"primary": "ringChange.useCode",
		"tone": "danger" if failed else "neutral",
		"errorSlot": "screen" if failed else null,
	})


static func _eq(a: Variant, b: Variant) -> bool:
	return typeof(a) == typeof(b) and a == b


static func _dict(v: Variant) -> Dictionary:
	return v if v is Dictionary else {}
