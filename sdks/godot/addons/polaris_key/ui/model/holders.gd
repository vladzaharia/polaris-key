extends RefCounted
## The holders family (ui-matrix.json `holders`): activation without an account, the port of
## ui-core's `models/holders.ts`. After a key activates the license is floating, held by the key
## alone; ActivateDone says so and recommends an account once, quietly; AddToAccount collects a
## name and an email, and the browser confirms the email. The rules the rows pin:
##
##   - the reasons are written once (`recommend_reasons`): Cloud Sync only when the product has it;
##     getting the license back and moving it to a new device only when Identity is on; with
##     Identity off the one line sends the person to the portal;
##   - the holder is `licenseHolder.email`: empty is floating, set is waiting for that email, with Identity on (with it
##     off the license is `ready` with the portal line), which
##     a screen shows masked (`mask_email`) and never in full;
##   - skipping is never a refusal: Start using is always the one primary.
##
## Like the Cloud Sync screens they are not in `Vocabulary.COMPONENTS`; `Models.view_of` answers them.

const Context := preload("res://addons/polaris_key/ui/model/context.gd")
const View := preload("res://addons/polaris_key/ui/model/view.gd")

const NAME := "activate.attach.name"
const EMAIL := "signin.email.label"


## An email with its middle hidden: the first character and the domain, `a•••@example.com`. An
## address with no local part or no domain, or one that is not text, is "".
static func mask_email(email: Variant) -> String:
	if not (email is String):
		return ""
	var text: String = email
	var at := text.rfind("@")
	if at < 1:
		return ""
	var domain := text.substr(at + 1)
	if domain.is_empty():
		return ""
	return text.substr(0, 1) + "•••@" + domain


## The copy keys of the recommendation's reason lines, in the order they show.
static func recommend_reasons(identity: bool, sync: bool) -> Array:
	if not identity:
		return ["activate.recommend.portal"]
	var out := []
	if sync:
		out.append("activate.recommend.sync")
	out.append("activate.recommend.recover")
	out.append("activate.recommend.devices")
	return out


## The reasons for what the input's services turn on.
static func reasons_of(ctx: RefCounted) -> Array:
	return recommend_reasons(ctx.on("identity"), ctx.on("sync"))


## Split a formatted reason on `**` into runs, `[{text, strong}]`; odd-numbered pieces are the
## strong lead-in. A renderer draws each run itself (push_bold/add_text) and never hands the
## string to a markup parser.
static func lead_parts(text: String) -> Array:
	var out := []
	var pieces := text.split("**", true)
	for i in pieces.size():
		if not pieces[i].is_empty():
			out.append({"text": pieces[i], "strong": i % 2 == 1})
	return out


static func _when(cond: bool, key: String) -> String:
	return key if cond else ""


static func _dict(v: Variant) -> Dictionary:
	return v if v is Dictionary else {}


## The step after a license key activates: `<Product> is ready`, the license line, and the
## recommendation when no email holds the license; a license sent to an email that has no account
## yet shows the waiting line instead, but only with Identity on; with Identity off it stays
## `ready` with the portal line.
static func activate_done_view(ctx: RefCounted) -> Dictionary:
	var done = ctx.input.get("activateDone")
	if not ctx.on("license") or not (done is Dictionary):
		return View.hidden(ctx, "ActivateDone")
	var id := View.identity_text(ctx)
	var a := _dict(ctx.input.get("activation"))
	var developer = id["developer"] if id["developer"] != null else id["name"]
	var args := {
		"product": id["name"],
		"developer": developer,
		"tier": View.first([done.get("tier"), a.get("tier")]),
		"term": View.first([done.get("term"), a.get("term")]),
		"deviceKind": done.get("deviceKind"),
		"n": done.get("position"),
		"limit": done.get("limit"),
	}
	var holder := _dict(ctx.input.get("licenseHolder"))
	# A holder email too malformed to mask counts as none: no sentence renders with an empty email.
	var masked := mask_email(holder.get("email"))
	if not masked.is_empty() and ctx.on("identity"):
		args["maskedEmail"] = masked
		return View.make(ctx, "ActivateDone", {
			"state": "waiting",
			"copy": ["activate.done.title", "activate.done.device", "activate.waiting", "activate.waitingSignIn", "signin.done.start"],
			"args": args,
			"primary": "signin.done.start",
		})
	var add_in = View.first([done.get("addIn"), holder.get("addIn")])
	var portal: bool = not ctx.on("identity") or add_in == "portal"
	var copy := ["activate.done.title", "activate.done.device", "activate.recommend.title", "activate.recommend.badge"]
	copy.append_array(reasons_of(ctx))
	# With Identity off, or a kit with no in-app channel, the action opens polaris.locker, so it
	# says that (an external link).
	copy.append("signin.key.addInLocker" if portal else "activate.recommend.action")
	copy.append(_when(portal, "a11y.externalLink"))
	copy.append("activate.recommend.skip")
	copy.append("signin.done.start")
	var spec := {"state": "ready", "copy": copy, "args": args, "primary": "signin.done.start"}
	if View.truthy(done.get("returned")) and ctx.on("identity"):
		spec["focus"] = "signin.key.addInLocker" if portal else "activate.recommend.action"
	return View.make(ctx, "ActivateDone", spec)


## Add your name and email: the person types them here, the browser confirms the email.
## `step_override` ("added") is the sign-in form's own step.
static func add_to_account_view(ctx: RefCounted, step_override: Variant = null) -> Dictionary:
	var a = ctx.input.get("addToAccount")
	if not ctx.on("identity") or not ctx.on("license") or not (a is Dictionary):
		return View.hidden(ctx, "AddToAccount")
	var id := View.identity_text(ctx)
	var masked = View.first([_nonempty(a.get("typedEmail")), _nonempty(mask_email(_dict(ctx.input.get("licenseHolder")).get("email")))])
	var args := {
		"product": id["name"],
		"deviceKind": a.get("deviceKind"),
		"maskedEmail": masked,
		"email": _nonempty(a.get("signedEmail")),
	}
	var step = step_override if step_override != null else a.get("step")
	# DL9: Name takes focus; a field never does under a coarse pointer, where the heading does.
	var name_focus: String = "heading" if Context.coarse_pointer(ctx.platform) else NAME
	var fields := ["activate.recommend.action", "activate.attach.lede", NAME, EMAIL, "activate.attach.fine", "common.continue", "common.cancel"]
	match step:
		"form":
			return View.make(ctx, "AddToAccount", {"state": "form", "copy": fields, "args": args, "primary": "common.continue", "focus": name_focus})
		"invalid":
			var field = a.get("field") if View.truthy(a.get("field")) else "both"
			var bad: Array = [NAME, EMAIL] if field == "both" else [NAME if field == "name" else EMAIL]
			var copy := fields.duplicate()
			copy.append(_when(bad.has(NAME), "activate.attach.nameRequired"))
			copy.append(_when(bad.has(EMAIL), "signin.email.invalid"))
			return View.make(ctx, "AddToAccount", {
				"state": "invalid",
				"copy": copy,
				"args": args,
				"primary": "common.continue",
				"tone": "danger",
				# The message sits under the first field that is wrong (DL7).
				"errorSlot": bad[0],
				"focus": name_focus if bad[0] == NAME else bad[0],
			})
		"busy":
			# The person confirms the email in Polaris Locker: the form gives way to `waiting`, the
			# code they check there. With no code to show, the form stays greyed behind Working.
			if View.truthy(_dict(ctx.input.get("deviceCode")).get("userCode")):
				return View.make(ctx, "AddToAccount", {
					"state": "waiting",
					"copy": ["activate.attach.waitTitle", "part.code.label", "a11y.code", "a11y.copyCode", "activate.attach.waitCheck", "activate.attach.reopen", "common.cancel"],
					"args": args,
					"focus": "heading",
				})
			var busy := fields.filter(func(k): return k != "common.cancel")
			busy.append_array(["common.working", "signin.handoff.again", "common.cancel"])
			return View.make(ctx, "AddToAccount", {"state": "busy", "copy": busy, "args": args, "primary": "common.continue", "focus": null})
		"added":
			# From Settings the app is already running: the screen closes with Done.
			var closing := "common.done" if View.truthy(a.get("fromSettings")) else "signin.done.start"
			return View.make(ctx, "AddToAccount", {
				"state": "added",
				# Cloud Sync is named only when the product has it.
				"copy": ["activate.attach.done", _when(ctx.on("sync"), "activate.attach.syncOn"), closing],
				"args": args,
				"primary": closing,
			})
		"owned":
			# Someone attached the license while this screen was open.
			return View.make(ctx, "AddToAccount", {
				"state": "owned",
				"copy": ["activate.owned.title", "activate.owned.lede", "signin.key.ownedSignIn", "common.cancel"],
				"args": args,
				"primary": "signin.key.ownedSignIn",
				"tone": "neutral",
			})
		"email-bound":
			# The license's email is not the account's; the license keeps working. The sentence and
			# "Verify that email" name the email; with none known both are left out.
			var known := View.truthy(masked)
			return View.make(ctx, "AddToAccount", {
				"state": "email-bound",
				"copy": [
					"activate.otherEmail.title",
					_when(known, "activate.otherEmail.body"),
					_when(known, "activate.otherEmail.verify"),
					"signin.auto.confirm.other",
					"signin.done.start",
				],
				"args": args,
				"primary": "activate.otherEmail.verify" if known else "signin.auto.confirm.other",
				"tone": "neutral",
			})
		"other-account":
			# A different account signed in than the email typed: the license was added nowhere.
			return View.make(ctx, "AddToAccount", {
				"state": "other-account",
				"copy": [
					"activate.otherAccount.title",
					_when(View.truthy(masked) and View.truthy(args["email"]), "activate.otherAccount.body"),
					"common.tryAgain",
					"signin.done.start",
				],
				"args": args,
				"primary": "common.tryAgain",
				"tone": "neutral",
			})
		"failed":
			return View.make(ctx, "AddToAccount", {
				"state": "failed",
				"copy": ["activate.recommend.action", "activate.attach.failed", "common.tryAgain", "common.cancel"],
				"args": args,
				"primary": "common.tryAgain",
				"tone": "danger",
				"errorSlot": "common.tryAgain",
			})
	return View.hidden(ctx, "AddToAccount")


## `v` when it is a non-empty string, else null (JS `x || undefined`).
static func _nonempty(v: Variant) -> Variant:
	return v if v is String and not (v as String).is_empty() else null
