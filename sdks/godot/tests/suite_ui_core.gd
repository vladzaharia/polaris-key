extends RefCounted
# @pkey-feature ui.gate ui.activate ui.signin ui.devicelimit ui.devices ui.update ui.settings ui.paywall ui.theme ui.i18n
#
# The Godot runner of conformance/corpus/v2/ui-matrix.json (plans/UK-02b.md §5), over the kit's
# headless layer (addons/polaris_key/ui/model/): every row of all ten families, never one
# skipped. Component rows drive the model `expect.component` names (the signIn family through
# the sign-in form's session, `sign_in_session.gd`) and compare the state, the sorted copy keys
# and the sorted actions, and a negative row's Must not; theme rows pin the theme resolver; i18n
# rows the catalog lookup and the ICU-subset formatter over brand's generated .po tables. A row a
# natural model fails is a bug against the row or the model, never a reason to weaken this
# runner (AGENTS.md rule 1).
#
#   godot --headless --path sdks/godot -- --pkey-test ui_core
#   godot --headless --path sdks/godot -- --pkey-test ui_core family=gate   # one family (dev)

const MATRIX_PATH := "res://tests/corpus/v2/ui-matrix.json"
const Models := preload("res://addons/polaris_key/ui/model/models.gd")
const Vocabulary := preload("res://addons/polaris_key/ui/model/vocabulary.gd")
const _MODEL_DIR := "res://addons/polaris_key/ui/model/"

## ui-matrix.json family → its `ui.*` feature (features.json).
const FAMILIES := {
	"gate": "ui.gate",
	"activate": "ui.activate",
	"signIn": "ui.signin",
	"deviceLimit": "ui.devicelimit",
	"devices": "ui.devices",
	"update": "ui.update",
	"settings": "ui.settings",
	"paywall": "ui.paywall",
}
const SIGN_IN := ["SignIn", "SignInHandoff", "LicenseChoice"]


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := ""
	for a in args:
		if a.begins_with("family="):
			only = a.substr(7)
	var m = PKeyTestFixtures.read_json(MATRIX_PATH)
	if not t.check("ui-matrix.json: reads", m is Dictionary):
		return true
	t.check("ui-matrix.json: uiMatrixVersion is the kit's and the generated constant", m.get("uiMatrixVersion") == float(Vocabulary.UI_MATRIX_VERSION) and Vocabulary.UI_MATRIX_VERSION == PKeyConstants.UI_MATRIX_VERSION, str(m.get("uiMatrixVersion")))
	for family in FAMILIES.keys() + ["theme", "i18n"]:
		t.check("ui-matrix.json: holds the %s family" % family, m.get(family) is Array)
	var defaults: Dictionary = m["vocabulary"]["defaults"]
	for family in FAMILIES:
		if only == "" or only == family:
			_components(t, family, m[family], defaults)
	if only == "" or only == "theme":
		_theme(t, m["theme"], defaults)
	if only == "" or only == "i18n":
		_i18n(t, m["i18n"])
	return true


## A member the input omits takes `vocabulary.defaults`; capabilities merge member by member.
static func with_defaults(input: Dictionary, defaults: Dictionary) -> Dictionary:
	var out := input.duplicate(true)
	for k in defaults:
		if k == "capabilities":
			var caps: Dictionary = (defaults[k] as Dictionary).duplicate(true)
			var mine = input.get(k)
			if mine is Dictionary:
				for c in mine:
					caps[c] = mine[c]
			out[k] = caps
		elif not input.has(k):
			out[k] = defaults[k] if not (defaults[k] is Dictionary or defaults[k] is Array) else defaults[k].duplicate(true)
	return out


## Drive the model the row names: the signIn family through the form's session, every other
## component through its view model.
static func view_for(row: Dictionary, defaults: Dictionary) -> Dictionary:
	var input := with_defaults(row["input"], defaults)
	var component: String = row["expect"]["component"]
	if SIGN_IN.has(component):
		var session_script: GDScript = load(_MODEL_DIR + "sign_in_session.gd")
		if session_script == null:
			return {}
		var session = session_script.restore(input)
		return session.view(component)
	return Models.view_of(component, input)


func _components(t: PKeyTestContext, family: String, rows: Array, defaults: Dictionary) -> void:
	var feature: String = FAMILIES[family]
	var ran := 0
	for row in rows:
		var name := "ui-matrix.json %s (%s): %s" % [family, feature, row["name"]]
		var view := view_for(row, defaults)
		var want: Dictionary = row["expect"]
		var got := {
			"component": view.get("component"),
			"state": view.get("state"),
			"copy": _sorted(view.get("copy", [])),
			"actions": _sorted(view.get("actions", [])),
		}
		var expect := {
			"component": want["component"],
			"state": want["state"],
			"copy": _sorted(want.get("copy", [])),
			"actions": _sorted(want.get("actions", [])),
		}
		var ok := got == expect
		var detail := "" if ok else _diff(got, expect)
		var must_not = row.get("mustNot")
		if ok and must_not is Dictionary:
			for s in must_not.get("states", []):
				if got["state"] == s:
					ok = false
					detail = "Must not (%s): state %s" % [must_not.get("invariant", ""), s]
			for k in must_not.get("copy", []):
				if (got["copy"] as Array).has(k):
					ok = false
					detail = "Must not (%s): copy %s" % [must_not.get("invariant", ""), k]
			for a in must_not.get("actions", []):
				if (got["actions"] as Array).has(a):
					ok = false
					detail = "Must not (%s): action %s" % [must_not.get("invariant", ""), a]
		if t.check(name, ok, detail):
			ran += 1
	t.check("ui-matrix.json %s: every row passes (%d/%d)" % [family, ran, rows.size()], ran == rows.size() and rows.size() > 0)


## Theme rows: the resolver's summary (`{name, accentSource, colorScheme, icon, preset}`).
func _theme(t: PKeyTestContext, rows: Array, defaults: Dictionary) -> void:
	var script: GDScript = load(_MODEL_DIR + "theme.gd")
	var ran := 0
	for row in rows:
		var name := "ui-matrix.json theme (ui.theme): %s" % row["name"]
		var got = script.summary_for_row(row["input"], defaults) if script != null else null
		var want: Dictionary = row["expect"]
		if t.check(name, got == want, "got %s, want %s" % [got, want]):
			ran += 1
	t.check("ui-matrix.json theme: every row passes (%d/%d)" % [ran, rows.size()], ran == rows.size() and rows.size() > 0)


## i18n rows: the catalog lookup and the formatter in the row's locale.
func _i18n(t: PKeyTestContext, rows: Array) -> void:
	var script: GDScript = load(_MODEL_DIR + "copy_format.gd")
	var ran := 0
	for row in rows:
		var name := "ui-matrix.json i18n (ui.i18n): %s" % row["name"]
		var got = script.format_in(row["locale"], row["key"], row.get("args", {}), row.get("overrides", {})) if script != null else null
		if t.check(name, got == row["expect"], "got %s, want %s" % [got, row["expect"]]):
			ran += 1
	t.check("ui-matrix.json i18n: every row passes (%d/%d)" % [ran, rows.size()], ran == rows.size() and rows.size() > 0)


static func _sorted(a: Variant) -> Array:
	var out: Array = (a as Array).duplicate() if a is Array else []
	out.sort()
	return out


static func _diff(got: Dictionary, want: Dictionary) -> String:
	var parts := []
	for k in want:
		if got.get(k) != want[k]:
			if want[k] is Array and got.get(k) is Array:
				var extra := []
				var missing := []
				for x in got[k]:
					if not (want[k] as Array).has(x):
						extra.append(x)
				for x in want[k]:
					if not (got[k] as Array).has(x):
						missing.append(x)
				parts.append("%s: extra %s missing %s" % [k, extra, missing])
			else:
				parts.append("%s: got %s want %s" % [k, got.get(k), want[k]])
	return "; ".join(parts)
