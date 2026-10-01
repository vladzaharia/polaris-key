extends RefCounted
# @pkey-feature devices.fingerprint
# PKeyFingerprint's readers over the committed captures (res://tests/fixtures/
# devices-captures.json), one host per platform, driven through PKeyFakeHost on any machine:
# every Windows, macOS and Linux reader, getmac/ifconfig/sysfs MAC normalisation, a missing
# command (the component is omitted, nothing fails), mobile and web, the device id's raw source,
# and the off-thread capture.

const PLATFORMS := ["windows", "macos", "linux", "ios", "android", "web"]


func run(t: PKeyTestContext) -> void:
	for p in PLATFORMS:
		var h := PKeyFakeHost.load_host(p)
		if not t.check("parsers: %s fixture present" % p, h != null):
			continue
		var raw := PKeyFingerprint.raw_components(h)
		t.check("parsers: %s reads exactly the expected components" % p, raw == h.host["expected"], "got %s" % JSON.stringify(raw))
	_windows(t)
	_macos(t)
	_linux(t)
	_missing(t)
	_macs(t)
	_device_id_raw(t)
	await _async(t)


func _windows(t: PKeyTestContext) -> void:
	var h := PKeyFakeHost.load_host("windows")
	PKeyFingerprint.raw_components(h)
	var programs := {}
	for c in h.calls:
		programs[PKeyFakeHost.basename(c["program"])] = c
	var want: Dictionary = h.host["expectedPrograms"]
	for name in want:
		t.check("windows: %s runs from System32" % name, programs.has(name) and programs[name]["program"] == want[name], str(programs.get(name, {}).get("program")))
	t.check("windows: the CIM call is the pinned command, byte for byte", programs.has("powershell") \
			and Array(programs["powershell"]["args"]) == PKeyFingerprint.WINDOWS_CIM_COMMAND["args"])
	t.check("windows: no wmic", not programs.has("wmic"))
	t.check("windows: reg query names MachineGuid", programs.has("reg") and Array(programs["reg"]["args"]) == PKeyFingerprint.WINDOWS_REG_ARGS)
	t.check("windows: no SystemRoot falls back to bare names", PKeyFingerprint.windows_system_path("", "reg.exe") == "reg.exe" \
			and PKeyFingerprint.windows_system_path("relative\\dir", "reg.exe") == "reg.exe" \
			and PKeyFingerprint.windows_system_path("C:\\Windows\\", "cmd.exe") == "C:\\Windows\\System32\\cmd.exe")
	t.check("windows: vol serial parses in English", PKeyFingerprint.parse_vol_serial(h.host["out"]["cmd"]) == "3C4D-5E6F")
	t.check("windows: vol serial parses from a localised console", PKeyFingerprint.parse_vol_serial(h.host["localizedVol"]) == "3C4D-5E6F")
	t.check("windows: reg output without the value yields nothing", PKeyFingerprint.parse_reg_machine_guid("ERROR: The system was unable to find the specified registry key or value.\r\n") == "")
	t.check("windows: CIM error text yields nothing", PKeyFingerprint.parse_windows_cim("Get-CimInstance : Access denied\r\n").is_empty())


func _macos(t: PKeyTestContext) -> void:
	var h := PKeyFakeHost.load_host("macos")
	var io := PKeyFingerprint.parse_ioreg(h.host["out"]["ioreg"])
	t.check("macos: ioreg gives IOPlatformUUID and the serial", io == {"uuid": "564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6", "serial": "C02XK1ABCDEF"}, str(io))
	t.check("macos: diskutil gives the VolumeUUID, not the DiskUUID", PKeyFingerprint.parse_diskutil_volume_uuid(h.host["out"]["diskutil"]) == "8F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0")
	t.check("macos: ifconfig lists every ether line", PKeyFingerprint.parse_ifconfig(h.host["out"]["ifconfig"]).size() == 5)
	t.check("macos: a sandbox that refuses ioreg yields no ioreg components", PKeyFingerprint.parse_ioreg(null).is_empty())


func _linux(t: PKeyTestContext) -> void:
	var h := PKeyFakeHost.load_host("linux")
	PKeyFingerprint.raw_components(h)
	var read_dmi := false
	for c in h.calls:
		read_dmi = read_dmi or String(c["program"]).contains("dmi")
	t.check("linux: findmnt is the only command", h.calls.size() == 1 and PKeyFakeHost.basename(h.calls[0]["program"]) == "findmnt", str(h.calls))
	var raw := PKeyFingerprint.raw_components(h)
	t.check("linux: no DMI serial or product UUID is read (no boardSerial, anchor is machine-id)", not raw.has("boardSerial") and raw.get("machineUuid") == "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c")
	var dbus := PKeyFakeHost.load_host("linux")
	dbus.missing = PackedStringArray(["/etc/machine-id"])
	t.check("linux: without /etc/machine-id the dbus file anchors", PKeyFingerprint.raw_components(dbus).get("machineUuid") == "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c")
	var none := PKeyFakeHost.load_host("linux")
	none.missing = PackedStringArray(["/etc/machine-id", "/var/lib/dbus/machine-id"])
	t.check("linux: no machine-id means no anchor (never a DMI fallback)", not PKeyFingerprint.raw_components(none).has("machineUuid"))
	t.check("linux: findmnt takes the first word", PKeyFingerprint.parse_findmnt_uuid("  abcd-1234 extra\nnext\n") == "abcd-1234")


## A command that is missing (or fails) omits its components and nothing else; nothing throws.
func _missing(t: PKeyTestContext) -> void:
	var cases := {
		"windows": [["powershell"], ["boardSerial", "machineModel"]],
		"macos": [["ioreg"], ["machineUuid", "boardSerial"]],
		"linux": [["findmnt"], ["bootVolumeUuid"]],
	}
	for p in cases:
		var h := PKeyFakeHost.load_host(p)
		h.missing = PackedStringArray(cases[p][0])
		var raw := PKeyFingerprint.raw_components(h)
		var expected: Dictionary = h.host["expected"].duplicate()
		for c in cases[p][1]:
			expected.erase(c)
		t.check("missing: %s without %s omits %s" % [p, cases[p][0][0], ", ".join(cases[p][1])], raw == expected, JSON.stringify(raw))
	var bare := PKeyFakeHost.load_host("windows")
	bare.missing = PackedStringArray(["reg", "powershell", "getmac", "cmd"])
	var raw := PKeyFingerprint.raw_components(bare)
	t.check("missing: every Windows command missing leaves cpuModel and ramBucket", raw.keys().size() == 2 and raw.has("cpuModel") and raw.has("ramBucket"), JSON.stringify(raw))


func _macs(t: PKeyTestContext) -> void:
	var getmac: String = PKeyFakeHost.load_host("windows").host["out"]["getmac"]
	var listed := PKeyFingerprint.parse_getmac(getmac)
	t.check("getmac: the first CSV column of every line", Array(listed) == ["00-1A-2B-3C-4D-5E", "N/A", "0A-00-27-00-00-0B", "00-15-5D-01-02-03"], str(listed))
	t.check("getmac: normalised to lower-case colon form", PKeyFingerprint.normalize_mac("00-1A-2B-3C-4D-5E") == "00:1a:2b:3c:4d:5e")
	t.check("getmac: N/A is not a MAC", PKeyFingerprint.normalize_mac("N/A") == "")
	t.check("mac: the lowest wins, whatever the order", PKeyFingerprint.primary_mac(PackedStringArray(["a4:83:e7:1b:2c:3d", "00-1A-2B-3C-4D-5E"])) == "00:1a:2b:3c:4d:5e")
	t.check("mac: all-zero, multicast and locally administered are ignored", \
			PKeyFingerprint.primary_mac(PackedStringArray(["00:00:00:00:00:00", "01:00:5e:00:00:01", "02:42:ac:11:00:01", "fe:ff:ff:ff:ff:ff", "f8:4d:89:00:00:02"])) == "f8:4d:89:00:00:02")
	t.check("mac: nothing usable yields nothing", PKeyFingerprint.primary_mac(PackedStringArray(["N/A", "02:00:00:00:00:00"])) == "")


func _device_id_raw(t: PKeyTestContext) -> void:
	var want := {
		"windows": "9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0",
		"macos": "564D3E2F-1A4B-4C8D-9E0F-A1B2C3D4E5F6",
		"linux": "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c",
		"ios": "E621E1F8-C36C-495A-93FC-0C247A3E6E5F",
		"android": "9774d56d682e549c",
		"web": "",
	}
	for p in want:
		var h := PKeyFakeHost.load_host(p)
		t.check("device-id raw: %s" % p, PKeyFingerprint.device_id_raw(h) == want[p], PKeyFingerprint.device_id_raw(h))
	var sandboxed := PKeyFakeHost.load_host("macos")
	sandboxed.missing = PackedStringArray(["ioreg"])
	t.check("device-id raw: macOS without ioreg falls back to OS.get_unique_id()", PKeyFingerprint.device_id_raw(sandboxed) == "C02XK1ABCDEF")
	var no_reg := PKeyFakeHost.load_host("windows")
	no_reg.missing = PackedStringArray(["reg"])
	t.check("device-id raw: Windows without reg falls back to OS.get_unique_id()", PKeyFingerprint.device_id_raw(no_reg) == "{846ee340-7039-11de-9d20-806e6f6e6963}")
	# The desktop device id is the corpus formula over MachineGuid / IOPlatformUUID.
	t.check("device-id: macOS derives from IOPlatformUUID (the corpus vector)", \
			PKeyDeviceId.from_raw("djdl", PKeyFingerprint.device_id_raw(PKeyFakeHost.load_host("macos"))) == "L7__1wpb_6MfkEu83MVYu0Wj2G2j2vSE")


func _async(t: PKeyTestContext) -> void:
	var h := PKeyFakeHost.load_host("macos")
	var fp = await PKeyFingerprint.collect("djdl", h)
	t.check("collect: the off-thread capture hashes the fixture host", fp is Dictionary and fp == PKeyFingerprint.hash_components("djdl", h.host["expected"]), JSON.stringify(fp))
	t.check("collect: the macOS-full fixture is the corpus's macos-full hwid", fp is Dictionary and fp["hwid"] == "BgNwYHns5OhGglcJmzuJGHxyMwGpwrYk", str(fp))
	var web = await PKeyFingerprint.collect("djdl", PKeyFakeHost.load_host("web"))
	t.check("collect: web has no fingerprint", web == null)
