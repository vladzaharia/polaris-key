extends RefCounted
# @pkey-feature ui.kit.holders identity.devicecode.choice identity.attach
# The kit's AddToAccount model and driver (UK-43.12), three ways:
#   - the 20 `holdersFlow` scenarios of ui-matrix.json over a scripted driver (the same scenarios
#     every native port replays), and the typed values staying out of the views' input;
#   - `portal-matrix.json`: parse_portal and portal_link (core/portal.gd);
#   - PKeyPortalStore: the member survives a cold start (portal.json);
#   - the driver over the SDK: `holders-add-to-account-preview` replayed end to end through
#     suite_transcripts.gd's replayer (key activation, the sign-in the driver starts with channel
#     redirect and no redirect URI, which answers redirect-unavailable here so the driver asks for a
#     device code with the hints, the poll that answers choose, choice.complete keeping this
#     device's license, the attach preview, then the confirmed attach), and the driver's own rules
#     (the fallback only on redirect-unavailable).
#
#   godot --headless --path sdks/godot -- --pkey-test ui_add_to_account

const MATRIX_PATH := "res://tests/corpus/v2/ui-matrix.json"
const PORTAL_PATH := "res://tests/corpus/v2/portal-matrix.json"
const Model := preload("res://addons/polaris_key/ui/model/add_to_account.gd")
const Driver := preload("res://addons/polaris_key/ui/model/add_to_account_driver.gd")
const TRANSCRIPT_ID := "holders-add-to-account-preview"
const BASE := {
	"platform": {"os": "macos", "formFactor": "mac"},
	"presentation": {"name": "Tidewater Studio", "icon": true},
	"services": ["license", "identity"],
}


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var m = PKeyTestFixtures.read_json(MATRIX_PATH)
	if not t.check("ui-matrix.json: reads", m is Dictionary):
		return true
	await _flow(t, m["holdersFlow"])
	_typed_values_stay_out(t)
	_portal(t)
	_portal_store(t)
	await _transcript(t)
	await _driver_rules(t)
	return true


# ── holdersFlow ──────────────────────────────────────────────────────────────────────────

## A driver answering from a scenario's plan; a call past it answers ok (preview, attach) or
## cancelled (waits).
class Scripted extends RefCounted:
	var plan: Dictionary
	var waits: Array = []
	var preview: Array = []
	var attach_script: Array = []
	var calls: Array = []
	var hints: Array = []
	var during_first_wait: Callable = Callable()
	var waited := false

	func _init(p_plan: Dictionary) -> void:
		plan = p_plan
		waits = (p_plan.get("waits", [{"outcome": "signedIn"}]) as Array).duplicate(true)
		preview = (p_plan.get("preview", []) as Array).duplicate(true)
		attach_script = (p_plan.get("attach", []) as Array).duplicate(true)

	func sign_in(h: Dictionary) -> Object:
		calls.append("signIn")
		hints.append({"loginHint": h["login_hint"], "nameHint": h["name_hint"], "purpose": h["purpose"]})
		if plan.get("signInError"):
			return null
		return ScriptedHandle.new(self)

	func complete(grant: String, choice: Dictionary) -> Dictionary:
		calls.append("complete:%s:%s" % [grant, choice["kind"]])
		var done = plan.get("complete")
		return {"outcome": done["outcome"]} if done is Dictionary else {"outcome": "signedIn"}

	func attach(confirm: bool) -> Dictionary:
		calls.append("attach" if confirm else "preview")
		var queue: Array = attach_script if confirm else preview
		var raw = queue.pop_front() if not queue.is_empty() else {"kind": "ok"}
		if raw is String:
			return {"kind": "error"}
		return {"kind": raw["kind"], "code": raw.get("code")}


class ScriptedHandle extends RefCounted:
	var user_code := ""
	var driver: Scripted

	func _init(p_driver: Scripted) -> void:
		driver = p_driver

	func wait() -> Dictionary:
		var d := driver
		if not d.waited and d.during_first_wait.is_valid():
			d.waited = true
			d.during_first_wait.call()
		return d.waits.pop_front() if not d.waits.is_empty() else {"outcome": "cancelled"}

	func reopen() -> void:
		pass

	func cancel() -> void:
		driver.calls.append("cancel")


func _flow(t: PKeyTestContext, flow: Dictionary) -> void:
	var scenarios: Array = flow["scenarios"]
	t.check("holdersFlow: 20 scenarios", scenarios.size() == 20, str(scenarios.size()))
	var ran := 0
	for sc in scenarios:
		var driver := Scripted.new(sc["driver"])
		var base: Dictionary = BASE.duplicate(true)
		base["licenseHolder"] = flow["base"]["licenseHolder"]
		var model := Model.new(driver, base, flow["base"]["deviceKind"])
		var fields: Dictionary = sc.get("fields", {})
		model.set_field("name", fields.get("name", "Ada Lovelace"))
		model.set_field("email", fields.get("email", "ada@example.com"))
		var steps: Array = []
		for action in sc["actions"]:
			match action:
				"submit-then-cancel":
					# The cancel lands while the sign-in's first wait is in flight.
					driver.during_first_wait = model.cancel
					await model.submit()
				"submit":
					await model.submit()
				"tryAgain":
					await model.try_again()
				"cancel":
					model.cancel()
			steps.append(model.step())
		var want: Dictionary = sc["expect"]
		var snap := model.snapshot()
		var view := model.view()
		var problems: Array = []
		if steps != want["steps"]:
			problems.append("steps %s != %s" % [steps, want["steps"]])
		if driver.calls != want["calls"]:
			problems.append("calls %s != %s" % [driver.calls, want["calls"]])
		if driver.hints != want["hints"]:
			problems.append("hints %s != %s" % [driver.hints, want["hints"]])
		if view.get("state") != want["viewState"]:
			problems.append("view %s != %s" % [view.get("state"), want["viewState"]])
		if want.has("field") and snap["field"] != want["field"]:
			problems.append("field %s != %s" % [snap["field"], want["field"]])
		if want.has("typedEmail") and snap["typed_email"] != want["typedEmail"]:
			problems.append("typedEmail %s != %s" % [snap["typed_email"], want["typedEmail"]])
		if want.has("signedEmail") and snap["signed_email"] != want["signedEmail"]:
			problems.append("signedEmail %s != %s" % [snap["signed_email"], want["signedEmail"]])
		t.check("ui-matrix.json holdersFlow (ui.kit.holders): %s" % sc["name"], problems.is_empty(), "; ".join(problems))
		ran += 1
	t.check("ui-matrix.json holdersFlow: every scenario ran (%d/%d)" % [ran, scenarios.size()], ran == scenarios.size() and ran > 0)


func _typed_values_stay_out(t: PKeyTestContext) -> void:
	var model := Model.new(Scripted.new({}), BASE, "Mac")
	model.set_field("name", "Ada Lovelace")
	model.set_field("email", "ada@example.com")
	var text := JSON.stringify(model.input())
	t.check("the typed values stay out of the views' input", not text.contains("Ada Lovelace") and not text.contains("ada@example.com"))
	t.check("the input holds the step and the device kind", model.input()["addToAccount"] == {"step": "form", "deviceKind": "Mac"})
	t.check("will_open_browser: valid fields, no sign-in yet", model.will_open_browser())
	model.set_field("email", "nope")
	t.check("will_open_browser: an invalid email is false", not model.will_open_browser())


# ── portal-matrix ────────────────────────────────────────────────────────────────────────

func _portal(t: PKeyTestContext) -> void:
	var m = PKeyTestFixtures.read_json(PORTAL_PATH)
	if not t.check("portal-matrix.json: reads", m is Dictionary):
		return
	var ran := 0
	for c in m["parseCases"]:
		var got = PKeyPortal.parse_portal(c["core"])
		t.check("portal-matrix.json parseCases: %s" % c["name"], _same(got, c["expect"]), "%s != %s" % [JSON.stringify(got), JSON.stringify(c["expect"])])
		ran += 1
	for c in m["linkCases"]:
		var got = PKeyPortal.portal_link(c["served"], c["portal"], c["baseUrl"], c["product"])
		t.check("portal-matrix.json linkCases: %s" % c["name"], _same(got, c["expect"]), "%s != %s" % [JSON.stringify(got), JSON.stringify(c["expect"])])
		ran += 1
	t.check("portal-matrix.json: every case ran (%d)" % ran, ran == m["parseCases"].size() + m["linkCases"].size() and ran > 0)


## The discovered member persists as portal.json and a new store reads it back on a cold start.
func _portal_store(t: PKeyTestContext) -> void:
	var dir := "user://pkey_test_portal_store"
	var file := dir.path_join(PKeyPortalStore.MEMBER_FILE)
	if FileAccess.file_exists(file):
		DirAccess.remove_absolute(file)
	var link := "https://pkey.example/activate?product=drift"
	var on := {"core": {"portal": {"enabled": true, "activate": link}}}

	var a := PKeyPortalStore.new()
	a.cache_dir = dir
	a.product = "drift"
	a.base_url = "https://pkey.example"
	t.check("portal store: nothing known before a discovery", a.current() == null)
	a.accept(on)
	t.check("portal store: accept holds the member", _same(a.current(), {"enabled": true, "activate": link}))

	var b := PKeyPortalStore.new()
	b.cache_dir = dir
	b.product = "drift"
	b.base_url = "https://pkey.example"
	b.load_cached()
	t.check("portal store: a cold start reads the member back", _same(b.current(), {"enabled": true, "activate": link}))

	var other := PKeyPortalStore.new()
	other.cache_dir = dir
	other.product = "other"
	other.base_url = "https://pkey.example"
	other.load_cached()
	t.check("portal store: another product's file is refused and deleted", other.current() == null and not FileAccess.file_exists(file))

	a.accept(on)
	var c := PKeyPortalStore.new()
	c.cache_dir = dir
	c.product = "drift"
	c.base_url = "https://elsewhere.example"
	c.load_cached()
	t.check("portal store: another base is refused", c.current() == null)

	a.accept(on)
	var d := PKeyPortalStore.new()
	d.cache_dir = dir
	d.product = "drift"
	d.base_url = "https://pkey.example"
	d.accept({"core": {"portal": {"enabled": false}}})
	d.load_cached()
	t.check("portal store: this session's discovery wins over the file", _same(d.current(), {"enabled": false}))

	a.accept({"core": {}})
	t.check("portal store: a document with no member clears it and the file", a.current() == null and not FileAccess.file_exists(file))

	var f := FileAccess.open(file, FileAccess.WRITE)
	f.store_string('{"v":1,"product":"drift","baseUrl":"https://pkey.example","portal":{"enabled":false,"activate":"x"}}')
	f.close()
	var e := PKeyPortalStore.new()
	e.cache_dir = dir
	e.product = "drift"
	e.base_url = "https://pkey.example"
	e.load_cached()
	t.check("portal store: a file that is not the parser's normal form is deleted", e.current() == null and not FileAccess.file_exists(file))


## Deep equality on parsed JSON (member order is not significant).
static func _same(a: Variant, b: Variant) -> bool:
	if a is Dictionary and b is Dictionary:
		if a.size() != b.size():
			return false
		for k in a:
			if not b.has(k) or not _same(a[k], b[k]):
				return false
		return true
	return a == b and typeof(a) == typeof(b)


# ── The transcript, end to end ───────────────────────────────────────────────────────────

## The transcript with every request after the activation on the sign-in's step, ordered (the model
## runs the sign-in, the choice and both attaches itself, so the replayer asserts every request in
## order and nothing else is sent). The later steps stay, with nothing left to assert: the replayer
## reads the verbs for the discovery it serves (the account endpoints for an attach).
func _merged(original: Dictionary) -> Dictionary:
	var tr: Dictionary = original.duplicate(true)
	var first: Dictionary = tr["steps"][0]
	var rest: Array = tr["steps"].slice(1)
	var actions: Array = rest.map(func(s): return s["action"])
	if actions != ["beginSignIn", "pollSignIn", "choiceComplete", "attach", "attach"]:
		return {}
	var items: Array = []
	var args := {}
	for s in rest:
		items.append_array(s["exchanges"]["items"])
		args.merge(s["args"], true)
	var step: Dictionary = rest[0].duplicate(true)
	step["args"] = args
	step["exchanges"] = {"ordered": true, "items": items}
	step["expect"] = {}
	var steps: Array = [first, step]
	for s in rest.slice(1):
		var later: Dictionary = s.duplicate(true)
		later["exchanges"] = {"ordered": false, "items": []}
		later["expect"] = {}
		steps.append(later)
	tr["steps"] = steps
	return tr


func _transcript(t: PKeyTestContext) -> void:
	var manifest = PKeyTestFixtures.read_json(PKeyTestFixtures.MANIFEST)
	var original = PKeyTestFixtures.transcript(TRANSCRIPT_ID)
	if not t.check("%s: parses" % TRANSCRIPT_ID, original is Dictionary and manifest is Dictionary):
		return
	if not PKeyTranscriptReplay.applies(original, manifest):
		t.info("skip %s: parity.json does not claim its features" % TRANSCRIPT_ID)
		return
	var tr := _merged(original)
	if not t.check("%s: the steps are the recorded ones" % TRANSCRIPT_ID, not tr.is_empty()):
		return
	var seen := {}
	var hook := func(sdk: Node, step: Dictionary) -> Variant:
		if step["action"] != "beginSignIn":
			# The model drove them with the sign-in.
			return {} if step["action"] in ["pollSignIn", "choiceComplete", "attach"] else null
		# The poll interval is real time; the clock is pinned, so skip the sleep.
		sdk.identity.sleeper = func(_s: float) -> void: pass
		var model := Model.new(Driver.new(sdk.identity), BASE.merged({"licenseHolder": {"email": "ada@example.com"}}), "Mac")
		model.set_field("name", "Ada")
		model.set_field("email", "ada@example.com")
		await model.submit()
		seen["step"] = model.step()
		seen["view"] = model.view().get("state")
		return {}
	var fails: Array = await load("res://tests/suite_transcripts.gd").replay(tr, hook)
	t.check("%s: the model replays the recorded conversation" % TRANSCRIPT_ID, fails.is_empty(), "\n  ".join(fails))
	t.check("%s: the model ends added" % TRANSCRIPT_ID, seen.get("step") == "added" and seen.get("view") == "added", JSON.stringify(seen))


# ── The driver's rules ───────────────────────────────────────────────────────────────────

## A stand-in for `identity.sign_in` recording each start's options and answering from a list.
class FakeSignIn extends PKeySignInNamespace:
	var starts: Array = []
	var answers: Array = []

	func start(opts: Dictionary = {}) -> PKeySignInSession:
		starts.append(opts.duplicate())
		return answers.pop_front()




func _driver_rules(t: PKeyTestContext) -> void:
	var identity := PKeyIdentity.new()
	var fake := FakeSignIn.new(identity)
	identity.sign_in = fake
	var driver := Driver.new(identity)
	var hints := {"login_hint": "ada@example.com", "name_hint": "Ada", "purpose": "attach"}
	# redirect-unavailable: the device code, once, with the same hints.
	fake.answers = [PKeySignInSession.new(false, PKeyConstants.ErrorCode.REDIRECT_UNAVAILABLE, "no class"), PKeySignInSession.new(true)]
	var handle = await driver.sign_in(hints)
	t.check("driver: redirect-unavailable falls back to the device code", handle != null and fake.starts.size() == 2)
	var want_redirect := {"login_hint": "ada@example.com", "name_hint": "Ada", "purpose": "attach", "license_choice": "app", "channel": "redirect"}
	t.check("driver: the first start is channel redirect, no redirect URI, the hints, purpose attach, license_choice app", fake.starts[0] == want_redirect, JSON.stringify(fake.starts[0]))
	t.check("driver: the fallback is the device code with the same hints", fake.starts[1] == want_redirect.merged({"channel": "device-code"}, true), JSON.stringify(fake.starts[1]))
	# Any other failure is a sign-in that could not start: no second start.
	fake.starts.clear()
	fake.answers = [PKeySignInSession.new(false, PKeyErrors.NETWORK, "down")]
	handle = await driver.sign_in(hints)
	t.check("driver: another failure does not fall back", handle == null and fake.starts.size() == 1)
	# A redirect that starts is the whole story.
	fake.starts.clear()
	fake.answers = [PKeySignInSession.new(true)]
	handle = await driver.sign_in(hints)
	t.check("driver: a redirect that starts is used as is", handle != null and fake.starts.size() == 1)
