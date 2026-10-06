class_name PKeyOutletEnv
extends RefCounted
## What PKeyOutletSignals reads, one method per OS call, so a test fakes a whole install by
## overriding them (tests/support/fake_outlet_env.gd). This class is the real runtime: OS,
## FileAccess, DirAccess, Engine singletons, JavaClassWrapper and JavaScriptBridge.
##
## Two readers are native: ios_app_distributor() and ios_bundle_evidence() answer this launch's
## `distributor` read through PKeyApple (P5-05's Apple plugin; null, no evidence, before it
## arrives or without the plugin), and windows_package() (package identity, SignatureKind, App
## Installer URI and external location) is a hook that answers null until a Windows native reader
## lands. Android needs no plugin: getInstallSourceInfo and the initiator's
## certificate digest are pure GDScript through AndroidRuntime and JavaClassWrapper (Godot 4.4+,
## measured on 4.7.2 in notes/S-06 §7).


## The report §3.1 platform this runs on (`macos`, `windows`, `linux`, `android`, `ios`, `web`).
func platform() -> String:
	return PKeyHeaders.update_platform()


func env(name: String) -> String:
	return OS.get_environment(name)


func executable_path() -> String:
	return OS.get_executable_path()


func has_feature(tag: String) -> bool:
	return OS.has_feature(tag)


func file_exists(path: String) -> bool:
	return FileAccess.file_exists(path)


## The whole file, or an empty array when it cannot be read.
func read_bytes(path: String) -> PackedByteArray:
	return FileAccess.get_file_as_bytes(path)


## The last `n` bytes of a file (the Mach-O code signature sits at the end), or empty.
func read_tail(path: String, n: int) -> PackedByteArray:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return PackedByteArray()
	var size := f.get_length()
	var take := mini(n, size)
	f.seek(size - take)
	return f.get_buffer(take)


## The directory's subdirectory names (empty when it cannot be opened).
func directories(path: String) -> PackedStringArray:
	return DirAccess.get_directories_at(path)


## The directory's file and link names, links included (empty when it cannot be opened).
func entries(path: String) -> PackedStringArray:
	var d := DirAccess.open(path)
	if d == null:
		return PackedStringArray()
	var out := PackedStringArray()
	out.append_array(d.get_files())
	out.append_array(d.get_directories())
	return out


## A symlink's target, or "" when `path` is not a link.
func link_target(path: String) -> String:
	var d := DirAccess.open(path.get_base_dir())
	if d == null or not d.is_link(path.get_file()):
		return ""
	return d.read_link(path.get_file())


## `window.matchMedia('(display-mode: standalone)').matches` and friends, on a web export:
## "standalone", "browser", or "" where JavaScriptBridge is unavailable.
func web_display_mode() -> String:
	if not OS.has_feature("web") or not ClassDB.class_exists("JavaScriptBridge"):
		return ""
	var bridge = Engine.get_singleton("JavaScriptBridge")
	if bridge == null:
		return ""
	var v = bridge.eval("(function(){try{return (window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true||String(document.referrer).indexOf('android-app://')===0}catch(e){return false}})()", true)
	return "standalone" if v == true else "browser"


## The Android install source (getInstallSourceInfo, API 30+): {installer, initiator,
## initiatorCertSha256, packageSource?, updateOwner?}, or null off Android or before API 30.
func android_install_source() -> Variant:
	if not Engine.has_singleton("AndroidRuntime"):
		return null
	var rt = Engine.get_singleton("AndroidRuntime")
	var ctx = rt.getApplicationContext()
	if ctx == null:
		return null
	var version = JavaClassWrapper.wrap("android.os.Build$VERSION")
	var sdk_int: int = int(version.SDK_INT) if version != null else 0
	if sdk_int < 30:
		return null
	var info = ctx.getPackageManager().getInstallSourceInfo(ctx.getPackageName())
	if info == null:
		return null
	var out := {
		"installer": _jstr(info.getInstallingPackageName()),
		"initiator": _jstr(info.getInitiatingPackageName()),
		"initiatorCertSha256": null,
	}
	var signing = info.getInitiatingPackageSigningInfo()
	if signing != null:
		var signers = signing.getApkContentsSigners()
		if signers is Array and signers.size() > 0 and signers[0] != null:
			var der = signers[0].toByteArray()
			if der is PackedByteArray:
				var h := HashingContext.new()
				h.start(HashingContext.HASH_SHA256)
				h.update(der)
				out["initiatorCertSha256"] = h.finish().hex_encode()
	if sdk_int >= 33:
		out["packageSource"] = int(info.getPackageSource())
	if sdk_int >= 34:
		out["updateOwner"] = _jstr(info.getUpdateOwnerPackageName())
	return out


static func _jstr(v: Variant) -> Variant:
	return v if v is String and v != "" else null


## AppDistributor.current as a signal value (`appStore`, `testFlight`, `marketplace:<id>`,
## `web`, `other`, `timeout`), or null (no evidence): this launch's PKeyApple distributor read,
## raced against its 2 s deadline (PKeyApple.start_launch_reads(), started by the PolarisKey
## autoload on iOS). Its `unavailable` maps to `timeout` after a timeout and to null otherwise.
func ios_app_distributor() -> Variant:
	var d = PKeyApple.launch_distributor()
	if not (d is Dictionary) or not (d.get("signal") is String):
		return null
	if d["signal"] == "unavailable":
		return "timeout" if d.get("reason") == "timeout" else null
	return d["signal"]


## The static bundle evidence read with the distributor: {provisioned: bool,
## altBundleIdentifier: String|null, bundleIdentifier: String|null}, or null without the plugin.
## It can veto a store outlet and never selects one.
func ios_bundle_evidence() -> Variant:
	var d = PKeyApple.launch_distributor()
	if not (d is Dictionary) or not d.has("provisioned"):
		return null
	return {
		"provisioned": d.get("provisioned") == true,
		"altBundleIdentifier": d.get("altBundleIdentifier") if d.get("altBundleIdentifier") is String else null,
		"bundleIdentifier": d.get("bundleIdentifier") if d.get("bundleIdentifier") is String else null,
	}


## The Windows package reader: {packageIdentity, signatureKind, appInstallerUri,
## externalLocation}, or null: unavailable until a Windows native reader lands.
func windows_package() -> Variant:
	return null
