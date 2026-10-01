extends RefCounted
# @pkey-feature devices.fingerprint
# This machine's own fingerprint, through the real PKeyHostIo (the CI editor legs on Linux,
# Windows and macOS run it): the capture runs off the main thread, the desktop anchor is
# present, and the derived device id is the corpus formula over the SAME raw value Node and
# Swift hash (MachineGuid / IOPlatformUUID / the rule-2 machine-id), read here independently of
# PKeyFingerprint. Which components were produced is printed (never their values: only names
# and hashes appear in the log).

const SLUG := "pkey-platform-check"


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var platform := PKeyHeaders.platform()
	t.info("platform=%s os=%s" % [platform, OS.get_name()])
	PKeyFingerprint.reset_memo()
	var t0 := Time.get_ticks_msec()
	var raw := await PKeyFingerprint.raw_components_async()
	t.info("capture took %d ms off the main thread" % (Time.get_ticks_msec() - t0))
	var names: Array = []
	for c in PKeyFingerprint.COMPONENTS:
		if raw.has(c):
			names.append(c)
	t.info("components produced: %s" % ", ".join(names))
	var fp = await PKeyFingerprint.collect(SLUG)
	t.check("collect is memoised and hashes the same capture", fp is Dictionary and fp == PKeyFingerprint.hash_components(SLUG, raw) if not raw.is_empty() else fp == null)
	if fp is Dictionary:
		t.info("hwid=%s" % fp["hwid"])
		var shaped := true
		for c in fp["components"]:
			shaped = shaped and String(fp["components"][c]).length() == PKeyFingerprint.COMPONENT_LENGTH
		t.check("every component is a 22-character hash", shaped)

	if platform == "web" or platform == "":
		t.check("no fingerprint off the supported platforms", raw.is_empty())
		return true
	if not OS.has_feature("pc"):
		t.check("mobile: the anchor is OS.get_unique_id()", raw.get("machineUuid", "") == OS.get_unique_id())
		return true

	t.check("desktop: cpuModel is present", raw.has("cpuModel"))
	var direct := _direct_anchor(platform)
	if platform == "linux" and direct == "":
		# A container image without /etc/machine-id (Docker's ubuntu, for one; docs/PRIVACY.md):
		# rule 2 has no source, so the anchor is OMITTED, never replaced by a DMI file. The CI
		# runners are VMs with a machine-id and take the strict path below.
		t.info("no machine-id on this Linux host (a container?): checking the anchor is omitted")
		t.check("linux without machine-id: the anchor is omitted", not raw.has(PKeyFingerprint.ANCHOR), str(names))
		t.check("linux without machine-id: no boardSerial either", not raw.has("boardSerial"))
		return true
	t.check("desktop: the anchor (machineUuid) is present", raw.has(PKeyFingerprint.ANCHOR), str(names))
	t.check("desktop: the anchor was read independently", direct != "", platform)
	t.check("desktop: the fingerprint anchor is that value", raw.get(PKeyFingerprint.ANCHOR, "") == direct)
	t.check("desktop: the device id's raw source is that value", PKeyFingerprint.device_id_raw() == direct)
	PKeyDeviceId.set_raw_source(Callable())
	await PKeyDeviceId.prepare()
	t.check("desktop: the derived device id is from_raw(slug, %s)" % _source_name(platform), PKeyDeviceId.derive(SLUG) == PKeyDeviceId.from_raw(SLUG, direct))
	return true


static func _source_name(platform: String) -> String:
	return {"windows": "MachineGuid", "macos": "IOPlatformUUID", "linux": "machine-id"}.get(platform, "?")


## The anchor read without PKeyFingerprint's parsers, as Node reads it.
static func _direct_anchor(platform: String) -> String:
	match platform:
		"windows":
			var out: Array = []
			OS.execute("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], out)
			var m := RegEx.create_from_string("MachineGuid\\s+REG_SZ\\s+(\\S+)").search(str(out[0]) if not out.is_empty() else "")
			return m.get_string(1) if m != null else ""
		"macos":
			var out: Array = []
			OS.execute("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], out)
			var m := RegEx.create_from_string("\"IOPlatformUUID\" = \"([^\"]+)\"").search(str(out[0]) if not out.is_empty() else "")
			return m.get_string(1) if m != null else ""
		"linux":
			for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"]:
				if FileAccess.file_exists(p):
					var v := FileAccess.get_file_as_string(p).strip_edges()
					if v != "" and v != "uninitialized":
						return v
	return ""
