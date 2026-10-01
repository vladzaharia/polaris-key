class_name PKeyTestContext
extends RefCounted
## What a suite reports through. A suite never uses `assert` and never relies on a runtime
## error: a release template skips GDScript runtime checks (a method call on null, a missing key
## read and `assert(false)` all continue silently), so only an explicit `check` can fail a run.
## Every suite ends with a coverage check (vectors evaluated == vectors loaded, with a floor).

var suite: String
var checks := 0
var failed := 0


func _init(suite_name: String) -> void:
	suite = suite_name


## Records one check and prints `PASS|FAIL <suite> <name>[ — detail]`. Returns `ok`, so a suite
## can stop early when a precondition fails.
func check(name: String, ok: bool, detail: String = "") -> bool:
	checks += 1
	if not ok:
		failed += 1
	var line := "%s %s %s" % ["PASS" if ok else "FAIL", suite, name]
	if detail != "":
		line += " — " + detail
	print(line)
	return ok


## Prints `INFO <suite> <text>`. Never a check: timings and diagnostics only.
func info(text: String) -> void:
	print("INFO %s %s" % [suite, text])
