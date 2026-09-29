extends RefCounted

func run(_args: PackedStringArray) -> void:
	print("OS.get_name()=", OS.get_name())
	print("OS.get_distribution_name()=", OS.get_distribution_name())
	print("OS.get_version()=", OS.get_version(), "  get_version_alias()=", OS.get_version_alias())
	print("OS.get_unique_id()=", OS.get_unique_id(), "  (cat /etc/machine-id to compare)")
	print("OS.get_model_name()=", OS.get_model_name())
	print("OS.get_processor_name()=", OS.get_processor_name(), "  count=", OS.get_processor_count())
	print("OS.get_memory_info()=", OS.get_memory_info())
	print("OS.get_locale()=", OS.get_locale(), "  get_locale_language()=", OS.get_locale_language())
	print("OS.is_debug_build()=", OS.is_debug_build(), "  OS.is_sandboxed()=", OS.is_sandboxed())
	print("Engine.get_version_info()=", Engine.get_version_info())
	print("Engine.get_architecture_name()=", Engine.get_architecture_name())
	print("OS.get_executable_path()=", OS.get_executable_path())
	print("OS.get_user_data_dir()=", OS.get_user_data_dir())
	var tags := ["editor", "editor_hint", "editor_runtime", "template", "debug", "release", "template_debug", "template_release",
		"linux", "linuxbsd", "windows", "macos", "android", "ios", "visionos", "web", "web_linuxbsd", "web_windows", "web_macos", "web_android", "web_ios",
		"pc", "mobile", "movie", "x86_64", "x86_32", "x86", "arm64", "arm32", "arm", "rv64", "wasm32", "64", "32",
		"threads", "nothreads", "double", "single", "dedicated_server", "server", "headless", "shader_baker", "etc2", "s3tc", "bptc", "astc", "system_fonts"]
	var on := []
	for t in tags:
		if OS.has_feature(t): on.append(t)
	print("OS.has_feature() true for: ", on)
