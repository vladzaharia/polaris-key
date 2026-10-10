extends RefCounted
# @pkey-feature ui.kit
# No leak warning at exit (UK-50). Godot prints "ObjectDB instances were leaked at exit" and
# "resources still in use at exit" when a debug or editor build quits with a reference cycle alive;
# a game that boots Polaris Key must not cause either. tests/exit_probe.gd runs the SDK as a game
# does (configure, start, the drop-in boot with its gate and a persistent gate, an update prompt,
# the settings panel, a sign-in dialog, a sign-out) and quits; this suite runs it as a child
# process of this editor and requires a clean exit. Not run on an exported template (a template
# ignores --script), where the probe cannot start.

const LEAK_LINES := ["ObjectDB instances were leaked", "resources still in use", "Leaked instance", "ObjectDB instances leaked"]


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	if not OS.has_feature("editor"):
		t.check("exit leaks: skipped on an exported template", true)
		return true
	var output: Array = []
	var code := OS.execute(OS.get_executable_path(), PackedStringArray(["--headless", "--path", ProjectSettings.globalize_path("res://"), "-s", "res://tests/exit_probe.gd"]), output, true)
	var log := "\n".join(PackedStringArray(output.map(func(o): return String(o))))
	t.check("exit leaks: the probe ran to its end", code == 0 and log.contains("PROBE done"), "exit %d: %s" % [code, log.right(600)])
	for line in LEAK_LINES:
		t.check("exit leaks: no '%s' at exit" % line, not log.contains(line), log.right(800))
	return true
