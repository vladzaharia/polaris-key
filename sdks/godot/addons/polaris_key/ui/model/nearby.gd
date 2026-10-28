extends RefCounted
## NearbyApproval (plans/auto-sign-in.md §3, D-A9): the approving device's side of nearby sign-in,
## the port of ui-core's `models/nearby.ts`. A new device asks to sign in; the person sees three
## 6-digit codes, one of them the code the new device shows, and taps it (number matching). Any
## other code, or Not now, denies. The codes and the tap are the kit's; this model answers what
## the screen says.
##
## States: entry, ask, approved, not-nearby, hidden.

const View := preload("res://addons/polaris_key/ui/model/view.gd")


## The approver's prompt and its outcomes, and the account menu's entry that opens it.
static func nearby_approval_view(ctx: RefCounted) -> Dictionary:
	if not ctx.on("identity"):
		return View.hidden(ctx, "NearbyApproval")
	var n = ctx.input.get("nearbyApproval")
	if not (n is Dictionary):
		n = {}
	var args := {"device": n.get("device")}
	match n.get("step"):
		"ask":
			# No primary: choosing the matching code is the action, and Not now the only other.
			return View.make(ctx, "NearbyApproval", {
				"state": "ask",
				"copy": ["signin.nearby.ask", "signin.nearby.askBody", "signin.nearby.deny"],
				"args": args,
				"focus": "heading",
			})
		"approved":
			return View.make(ctx, "NearbyApproval", {
				"state": "approved",
				"copy": ["signin.nearby.approved"],
				"args": args,
			})
		"not-nearby":
			return View.make(ctx, "NearbyApproval", {
				"state": "not-nearby",
				"copy": ["signin.nearby.notNearby"],
				"args": args,
				"tone": "neutral",
			})
	return View.make(ctx, "NearbyApproval", {
		"state": "entry",
		"copy": ["signin.nearby.menu"],
		"args": args,
		"focus": null,
	})
