class_name PKeyFacts
extends RefCounted
## Software facts for `POST /<p>/devices/report` (shared-protocol `DeviceFacts`; sdk-node
## `devices/facts.ts`, notes/A2 §8), plus the two Godot report keys, `engine` and `outlet`.
##
## Deliberately narrow (AGENTS.md rule 7): no installed-application enumeration. A product
## declares the companion apps it cares about (`PKeyOptions.probes`) and only those paths are
## tested, on the desktop only.
##
##   os        {name, version?, build?, kernel}: name in Node's family form (win32, darwin,
##             linux, ios, android, web), version `OS.get_version()`, build the Linux
##             distribution (or, on web, the host OS from the feature tags), kernel `OS.get_name()`
##   hardware  {cpuModel?, cpuCores, ramMb?, machineModel?}
##   runtime   {name: "godot", version: Engine.get_version_info().string}
##   locale    `OS.get_locale()` in BCP 47 form (en_US -> en-US)
##   timezone  IANA only: web through JavaScriptBridge, macOS and Linux from /etc/localtime (or
##             /etc/timezone, or TZ); omitted where only an abbreviation is known (Windows)
##   probes    {id: {present, version?}} for the declared probes with a target on this OS
##
## Each `collect` reads only cheap getters and file existence, so it runs on the calling thread.

const MAX_PROBES := 32
const BUILD_STAMP := PKeyBuildStamp.PATH
const OS_NAMES := {
	"Windows": "win32",
	"macOS": "darwin",
	"Linux": "linux",
	"FreeBSD": "linux",
	"NetBSD": "linux",
	"OpenBSD": "linux",
	"BSD": "linux",
	"iOS": "ios",
	"Android": "android",
	"Web": "web",
}
const _WEB_HOSTS := ["web_android", "web_ios", "web_windows", "web_macos", "web_linuxbsd"]


## DeviceFacts for this device. `probes`: the product's declarations (PKeyOptions.probes).
static func collect(probes: Array = []) -> Dictionary:
	var name := OS.get_name()
	var os := {"name": OS_NAMES.get(name, name.to_lower()), "kernel": name}
	var version := OS.get_version().strip_edges()
	if version != "":
		os["version"] = version
	var build := _os_build()
	if build != "":
		os["build"] = build
	var hardware := {}
	var cpu := OS.get_processor_name().strip_edges()
	if cpu != "":
		hardware["cpuModel"] = cpu
	hardware["cpuCores"] = OS.get_processor_count()
	var mem := int(OS.get_memory_info().get("physical", -1))
	if mem > 0:
		hardware["ramMb"] = int(round(mem / 1048576.0))
	var model := OS.get_model_name().strip_edges()
	if model != "" and model != "GenericDevice":
		hardware["machineModel"] = model
	var out := {
		"os": os,
		"hardware": hardware,
		"runtime": {"name": "godot", "version": Engine.get_version_info().get("string", "")},
	}
	var locale := bcp47(OS.get_locale())
	if locale != "":
		out["locale"] = locale
	var tz := timezone()
	if tz != "":
		out["timezone"] = tz
	if not probes.is_empty():
		var results := run_probes(probes)
		if not results.is_empty():
			out["probes"] = results
	return out


static func _os_build() -> String:
	if OS.has_feature("web"):
		for tag in _WEB_HOSTS:
			if OS.has_feature(tag):
				return tag.trim_prefix("web_")
		return ""
	if OS.get_name() == "Linux":
		return OS.get_distribution_name().strip_edges()
	return ""


## `en_US` / `en_US.UTF-8` / `sr_Latn_RS` -> `en-US` / `en-US` / `sr-Latn-RS`.
static func bcp47(locale: String) -> String:
	var l := locale.strip_edges().split(".")[0].split("@")[0]
	return l.replace("_", "-")


## The IANA zone name, or "".
static func timezone() -> String:
	if OS.has_feature("web"):
		var v = JavaScriptBridge.eval("Intl.DateTimeFormat().resolvedOptions().timeZone", true)
		return v if v is String and is_iana(v) else ""
	if OS.get_name() == "Windows" or not OS.has_feature("pc"):
		return ""
	var tz := OS.get_environment("TZ").trim_prefix(":")
	if is_iana(tz):
		return tz
	var d := DirAccess.open("/etc")
	if d != null and d.is_link("/etc/localtime"):
		var zone := iana_from_zoneinfo_path(d.read_link("/etc/localtime"))
		if zone != "":
			return zone
	if FileAccess.file_exists("/etc/timezone"):
		var text := FileAccess.get_file_as_string("/etc/timezone").strip_edges()
		if is_iana(text):
			return text
	return ""


## The zone in a zoneinfo path (`/var/db/timezone/zoneinfo/America/Los_Angeles`,
## `../usr/share/zoneinfo/Europe/Paris`), or "".
static func iana_from_zoneinfo_path(path: String) -> String:
	var at := path.rfind("zoneinfo/")
	if at < 0:
		return ""
	var zone := path.substr(at + "zoneinfo/".length())
	for prefix in ["posix/", "right/"]:
		zone = zone.trim_prefix(prefix)
	return zone if is_iana(zone) else ""


## A plausible IANA name: `UTC`, or `Area/Location[/More]` of letters, digits, `_`, `-`, `+`.
static func is_iana(name: String) -> bool:
	if name == "UTC" or name == "Etc/UTC":
		return true
	return RegEx.create_from_string("\\A[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)+\\z").search(name) != null


## The declared probes for this OS: {id: {present, version?}}. A probe with no target here is
## not applicable and is left out (reporting it absent would be a lie). Desktop only; at most
## MAX_PROBES. A macOS bundle's CFBundleShortVersionString is read when it is present.
static func run_probes(declarations: Array) -> Dictionary:
	var out := {}
	if not OS.has_feature("pc") or OS.has_feature("web"):
		return out
	var key: String = {"Windows": "windows", "macOS": "macos"}.get(OS.get_name(), "linux")
	for p in declarations:
		if out.size() >= MAX_PROBES:
			break
		if not (p is Dictionary) or not (p.get("id") is String) or p["id"] == "":
			continue
		var target = p.get(key)
		if not (target is String) or target == "":
			continue
		var present := FileAccess.file_exists(target) or DirAccess.dir_exists_absolute(target)
		var result := {"present": present}
		if present and key == "macos":
			var v := mac_app_version(target)
			if v != "":
				result["version"] = v
		out[p["id"]] = result
	return out


static func mac_app_version(bundle: String) -> String:
	var plist := bundle.path_join("Contents/Info.plist")
	if not FileAccess.file_exists(plist):
		return ""
	var m := RegEx.create_from_string("<key>CFBundleShortVersionString</key>\\s*<string>([^<]+)</string>") \
			.search(FileAccess.get_file_as_string(plist))
	return m.get_string(1).strip_edges() if m != null else ""


## The `engine` report key: {id: "godot-<major>.<minor>", version, renderer?, videoAdapter?,
## videoVendor?, videoApi?, display?, debug}. Empty strings are left out (a headless run has no
## adapter). Call it on the main thread: it reads the RenderingServer.
static func engine() -> Dictionary:
	var info := Engine.get_version_info()
	var out := {
		"id": "godot-%d.%d" % [int(info.get("major", 0)), int(info.get("minor", 0))],
		"version": str(info.get("string", "")),
		"debug": OS.is_debug_build(),
	}
	var renderer := ""
	if RenderingServer.has_method("get_current_rendering_method"):
		renderer = str(RenderingServer.call("get_current_rendering_method"))
	if renderer == "":
		renderer = str(ProjectSettings.get_setting("rendering/renderer/rendering_method", ""))
	_put(out, "renderer", renderer)
	_put(out, "videoAdapter", RenderingServer.get_video_adapter_name())
	_put(out, "videoVendor", RenderingServer.get_video_adapter_vendor())
	_put(out, "videoApi", RenderingServer.get_video_adapter_api_version())
	_put(out, "display", DisplayServer.get_name())
	return out


static func _put(d: Dictionary, key: String, value: String) -> void:
	var v := value.strip_edges()
	if v != "":
		d[key] = v


## The outlet the build was stamped with (P1-11's `res://.polaris_key/build.json`), or "" when
## there is no stamp or it names none. Never detected at runtime here (that is P3-11's).
static func outlet(path := PKeyBuildStamp.PATH) -> String:
	var stamp = PKeyBuildStamp.read(path)
	return stamp["outlet"].strip_edges() if stamp != null else ""
