class_name PKeyFakeOutletEnv
extends PKeyOutletEnv
## A faked install for PKeyOutletSignals: the platform, environment, executable, files (path ->
## bytes or text), symlinks (path -> target), feature tags and the three native answers, all set
## by the test. Directories are derived from the file and link paths.

var platform_name := "linux"
var env_vars := {}
var exe := ""
var files := {}
var links := {}
var features := PackedStringArray()
var android = null
var app_distributor = null
## {provisioned, altBundleIdentifier, bundleIdentifier} or null (ios_bundle_evidence()).
var bundle_evidence = null
var windows = null
var display := ""


func platform() -> String:
	return platform_name


func env(name: String) -> String:
	return str(env_vars.get(name, ""))


func executable_path() -> String:
	return exe


func has_feature(tag: String) -> bool:
	return features.has(tag)


func file_exists(path: String) -> bool:
	return files.has(path) or links.has(path)


func read_bytes(path: String) -> PackedByteArray:
	var f = files.get(path)
	if f is PackedByteArray:
		return f
	if f is String:
		return f.to_utf8_buffer()
	return PackedByteArray()


func read_tail(path: String, n: int) -> PackedByteArray:
	var b := read_bytes(path)
	return b.slice(maxi(0, b.size() - n))


func directories(path: String) -> PackedStringArray:
	var out := PackedStringArray()
	var all: Array = files.keys() + links.keys()
	for p in all:
		if p.begins_with(path + "/"):
			var rest: String = p.substr(path.length() + 1)
			if rest.contains("/"):
				var d := rest.get_slice("/", 0)
				if not out.has(d):
					out.append(d)
	return out


func entries(path: String) -> PackedStringArray:
	var out := directories(path)
	var all: Array = files.keys() + links.keys()
	for p in all:
		if p.get_base_dir() == path and not out.has(p.get_file()):
			out.append(p.get_file())
	return out


func link_target(path: String) -> String:
	return str(links.get(path, ""))


func web_display_mode() -> String:
	return display


func android_install_source() -> Variant:
	return android


func ios_app_distributor() -> Variant:
	return app_distributor


func ios_bundle_evidence() -> Variant:
	return bundle_evidence


func windows_package() -> Variant:
	return windows
