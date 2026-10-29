extends RefCounted
# @pkey-feature connect.identity
# The Cloud Connect suite (CC-14, D-10): one runner for tests/connect/*.gd. Each file is a group with
# `func run(t: PKeyTestContext) -> void` (it may await). Later slices add files only, so the runner
# line in tests/runner.gd never changes again. An extra argument names the groups to run
# (`connect cert,noise`); the suite ends with a coverage check that every group ran.

const DIR := "res://tests/connect"


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := args[0].split(",") if args.size() > 0 and not args[0].begins_with("-") else PackedStringArray()
	var names := _groups()
	t.check("there are groups", not names.is_empty(), DIR)
	for name in only:
		t.check("group %s exists" % name, names.has(name))
	var ran := 0
	var want := 0
	for name in names:
		if not only.is_empty() and not only.has(name):
			continue
		want += 1
		var path := "%s/%s.gd" % [DIR, name]
		var script = load(path)
		if not t.check("group %s loads" % name, script is GDScript and script.can_instantiate(), path):
			continue
		var started := Time.get_ticks_msec()
		await script.new().run(t)
		t.info("group %s finished in %d ms" % [name, Time.get_ticks_msec() - started])
		ran += 1
	t.check("coverage", ran == want, "%d/%d groups ran" % [ran, want])
	return true


## The group names: every `.gd` file directly under tests/connect, sorted. A pack lists a script as
## `.gd` or `.gdc`, and keeps `.remap` entries for resources, so each spelling is folded.
func _groups() -> Array[String]:
	var out: Array[String] = []
	for f in DirAccess.get_files_at(DIR):
		var name := f.trim_suffix(".remap")
		if name.ends_with(".gdc"):
			name = name.trim_suffix(".gdc") + ".gd"
		if name.ends_with(".gd") and not out.has(name.trim_suffix(".gd")):
			out.append(name.trim_suffix(".gd"))
	out.sort()
	return out
