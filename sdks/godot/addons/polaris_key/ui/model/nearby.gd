extends RefCounted
## NearbyApproval (plans/auto-sign-in.md §3, D-A9): the approving device's side of nearby sign-in,
## the port of ui-core's `models/nearby.ts`. A new device asks to sign in; the person sees three
## 6-digit codes, one of them the code the new device shows, and taps it (number matching). Any
## other code, or Not now, denies. The codes and the tap are the kit's; this model answers what
## the screen says.
##
## States: entry, ask, approved, not-nearby, mismatch, denied, expired, device-limit, choose,
## account-required, rate-limited, hidden.

const View := preload("res://addons/polaris_key/ui/model/view.gd")


## The approver's prompt and its outcomes, and the account menu's entry that opens it. Every
## outcome has a title that takes focus and one way on (Done).
static func nearby_approval_view(ctx: RefCounted) -> Dictionary:
	if not ctx.on("identity"):
		return View.hidden(ctx, "NearbyApproval")
	var n = ctx.input.get("nearbyApproval")
	if not (n is Dictionary):
		n = {}
	var args := {"device": n.get("device"), "product": View.identity_text(ctx)["name"]}
	var step = n.get("step")
	if step == "ask":
		# No primary: choosing the matching code is the action, and Deny the only other.
		return View.make(ctx, "NearbyApproval", {
			"state": "ask",
			"copy": ["signin.nearby.ask", "signin.nearby.askBody", "signin.approve.warning", "signin.approve.deny"],
			"args": args,
			"focus": "heading",
		})
	var outcomes := {
		"approved": [["signin.nearby.approved", "common.done"], "common.done", null],
		"not-nearby": [["signin.nearby.notNearby", "signin.nearby.notNearbyBody", "common.done"], "common.done", "neutral"],
		"mismatch": [["signin.nearby.mismatch", "common.done"], "common.done", null],
		"denied": [["signin.approve.deniedDone", "common.done"], "common.done", null],
		"expired": [["core.codes.sign-in-expired.title", "signin.nearby.expiredBody", "common.done"], "common.done", "neutral"],
		"device-limit": [["core.codes.device_limit.title", "signin.nearby.deviceLimitBody", "devices.manage"], "devices.manage", "neutral"],
		"choose": [["signin.nearby.chooseTitle", "signin.nearby.chooseLede", "signin.choice.continue"], "signin.choice.continue", null],
		"account-required": [["core.codes.account_required.title", "core.codes.account_required.message", "signin.key.signIn"], "signin.key.signIn", "neutral"],
		"rate-limited": [["core.codes.rate_limited.title", "signin.nearby.rateLimitedBody", "common.done"], "common.done", "neutral"],
	}
	if step is String and outcomes.has(step):
		var o: Array = outcomes[step]
		return View.make(ctx, "NearbyApproval", {
			"state": step, "copy": o[0], "args": args, "primary": o[1], "tone": o[2], "focus": "heading",
		})
	return View.make(ctx, "NearbyApproval", {
		"state": "entry",
		"copy": ["signin.nearby.menu"],
		"args": args,
		"focus": null,
	})
