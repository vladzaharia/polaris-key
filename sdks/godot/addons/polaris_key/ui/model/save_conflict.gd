extends RefCounted
## The saveConflict family (ui-matrix.json `saveConflict`, K.0): SaveConflict, shown when the same
## save changed on two devices. The port of ui-core's `models/saveConflict.ts`. The person picks
## one; the kit never settles it for them.
##   - a save is never discarded without a choice: `choose` offers every way on and takes no
##     default, so nothing is focused but the heading and there is no filled control;
##   - Keep both is a copy of the other save under a new name and needs a free slot of the 16: with
##     none (or when the input does not say) it is drawn disabled, with its reason, and not offered;
##   - when the other copy was deleted there is nothing to keep or copy: Keep the other becomes
##     Delete it here too, its own button (danger), Keep both goes, and the screen has its own
##     title and lede;
##   - a choice is applied once: while it runs no control is offered (the busy bar shows), and `kept`
##     titles itself with the choice that was made, never another, and never after a failure;
##   - failed offers Try again, Choose again and Cancel, none filled;
##   - Newer tags the card the app names (never when the other copy was deleted) and chooses nothing.
##
## States: choose, keeping, kept, failed, hidden.

const View := preload("res://addons/polaris_key/ui/model/view.gd")

## The result titles of `kept`, by the choice made (`deleted` when the other copy was gone).
const KEPT := {
	"local": "saveConflict.keptLocalTitle",
	"remote": "saveConflict.keptRemoteTitle",
	"both": "saveConflict.keptBothTitle",
	"deleted": "saveConflict.keptDeletedTitle",
}


## A save conflict: choose, being applied, applied, or failed.
static func save_conflict_view(ctx: RefCounted) -> Dictionary:
	var raw = ctx.input.get("saveConflict")
	if not ctx.on("sync") or not View.truthy(raw):
		return View.hidden(ctx, "SaveConflict")
	var c := _dict(raw)
	var local := _dict(c.get("local"))
	var has_remote: bool = c.get("remote") is Dictionary
	var remote := _dict(c.get("remote"))
	var gone: bool = c.has("remote") and c["remote"] == null
	# The situation's own title: one copy and a deletion is never "two versions".
	var situation: String = "saveConflict.deletedTitle" if gone else "saveConflict.title"
	match c.get("step"):
		"keeping":
			return View.make(ctx, "SaveConflict", {
				"state": "keeping",
				"copy": [situation, "saveConflict.keeping", "a11y.busy"],
				# Nothing to press while it runs: the choice cannot be made twice.
				"focus": "heading",
			})
		"kept":
			var keep = c.get("keep")
			# With one copy there is no "both": it reads as the local choice.
			var kind: String = String(keep) if keep != null else "local"
			if gone:
				kind = "deleted" if kind == "remote" else "local"
			var copy: Array = [KEPT.get(kind, KEPT["local"])]
			if kind == "both":
				copy.append("saveConflict.keptCopy")
			copy.append("common.done")
			return View.make(ctx, "SaveConflict", {
				"state": "kept",
				"copy": copy,
				"primary": "common.done",
				"focus": "heading",
			})
		"failed":
			# Both copies are as they were. Try again repeats the choice, Choose again goes back to
			# the versions, Cancel leaves; none is filled, since a stray Enter must not run an overwrite.
			return View.make(ctx, "SaveConflict", {
				"state": "failed",
				"copy": [situation, "saveConflict.failedDeleted" if gone else "saveConflict.failed", "common.tryAgain", "saveConflict.chooseAgain", "common.cancel"],
				"primary": null,
				"tone": "danger",
				"errorSlot": "screen",
				"focus": "heading",
			})
	# Keep both needs a free slot and a copy to keep. Without the host saying so it is drawn
	# disabled with its reason (the fail-safe), never silently available.
	var both: bool = not gone and c.get("bothAvailable") == true
	var local_when = local.get("when")
	var remote_when = remote.get("when")
	var newer = c.get("newer")
	return View.make(ctx, "SaveConflict", {
		"state": "choose",
		"copy": [
			situation,
			"saveConflict.deletedLede" if gone else "saveConflict.lede",
			"saveConflict.thisDevice",
			"saveConflict.savedThis" if local_when != null else "",
			# Newer tags the card the app names; it never fills, focuses or reorders, and one copy has nothing to compare.
			"saveConflict.newerThis" if not gone and newer == "local" else "",
			"saveConflict.deletedElsewhere" if gone else ("saveConflict.otherDevice" if View.truthy(remote.get("device")) else "saveConflict.otherUnknown"),
			"saveConflict.savedOther" if not gone and has_remote and remote_when != null else "",
			"saveConflict.newerOther" if not gone and newer == "remote" else "",
			"saveConflict.keepThis",
			"saveConflict.acceptDelete" if gone else "saveConflict.keepOther",
			"" if gone else "saveConflict.keepBoth",
			"saveConflict.bothFull" if not gone and not both else "",
			"common.cancel",
		],
		# Each card's time is its own key, so each takes its own `when`.
		"args": {"device": remote.get("device")},
		"keyArgs": {
			"saveConflict.savedThis": {"when": local_when},
			"saveConflict.savedOther": {"when": remote_when},
		},
		"disabledActions": [] if both else ["keep-both"],
		# No filled control and no default focus: every way on is the person's pick.
		"primary": null,
		"tone": null,
		"focus": "heading",
	})


static func _dict(v: Variant) -> Dictionary:
	return v if v is Dictionary else {}
