extends RefCounted
# The minimal sample project (examples/minimal, SP-G17) compiles against this SDK's real API:
# its script is built from source here, so a renamed method or class the sample calls fails this
# group (the sample is its own project, which this one's import never scans). Its scene and
# project file point at that script and at the autoload and plugin the SDK ships.

const DIR := "res://examples/minimal"


func run(t: PKeyTestContext) -> void:
	if not FileAccess.file_exists(DIR.path_join("main.gd")):
		# An exported pack carries resources only; the editor run checks the sample.
		t.check("sample: present in the editor run", not OS.has_feature("editor"))
		return
	var source := FileAccess.get_file_as_string(DIR.path_join("main.gd"))
	var script := GDScript.new()
	script.source_code = source
	t.check("sample: main.gd compiles against the SDK", script.reload() == OK)
	t.check("sample: main.gd can be instantiated", script.can_instantiate())
	for call in ["PolarisKey.boot(", "PolarisKey.license.is_entitled(", "PolarisKey.config.get_value(", "PolarisKey.commerce.purchase(", "PolarisKey.commerce.restore()", "PKeySettingsPanel.open("]:
		t.check("sample: uses %s" % call, source.contains(call))
	# DL18: the kit's one line, with no layout code of the game's around it.
	t.check("sample: no dialog wrapped around the settings", not source.contains("AcceptDialog"))
	var scene := FileAccess.get_file_as_string(DIR.path_join("main.tscn"))
	t.check("sample: main.tscn runs main.gd", scene.contains("path=\"res://main.gd\""))
	var project := ConfigFile.new()
	t.check("sample: project.godot parses", project.load(DIR.path_join("project.godot")) == OK)
	t.check("sample: the autoload is the SDK's", project.get_value("autoload", "PolarisKey", "") == "*res://addons/polaris_key/polaris_key.gd")
	t.check("sample: the plugin is enabled", PackedStringArray(project.get_value("editor_plugins", "enabled", PackedStringArray())).has("res://addons/polaris_key/plugin.cfg"))
	t.check("sample: the main scene is main.tscn", project.get_value("application", "run/main_scene", "") == "res://main.tscn")
	t.check("sample: the plugin file it enables exists here", FileAccess.file_exists("res://addons/polaris_key/plugin.cfg"))
