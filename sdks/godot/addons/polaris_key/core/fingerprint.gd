class_name PKeyFingerprint
extends RefCounted
## The hardware fingerprint (WIRE-CONTRACT-V3 §6, §6.1; sdk-node `devices/fingerprint.ts`),
## pinned by conformance/corpus/v2/fingerprint.json:
##
##   component = base64url(sha256(utf8("pkey-hw:<slug>:<component>:<raw>")))[0:22]
##   hwid      = base64url(sha256(utf8(join("\n", ["<c>=<hash>" in canonical order]))))[0:32]
##
## Raw values are hashed HERE, on the device, and never leave it (AGENTS.md rule 7): only the
## 22-character hashes travel, and the server recomputes the hwid. A component that cannot be
## read is OMITTED, never substituted. Nothing outside the seven components is ever read.
##
## Reading is two steps, so every reader is a pure parser over captured output:
##
##   capture(host)               the side effects (commands and files) through a PKeyHostIo;
##                               desktop commands block, so this runs on a WorkerThreadPool task
##   components_from_capture(c)  the per-platform parsers, pure, on the calling thread
##
## Per platform (notes/A2 §3.3, P1b-09's source rules):
##
##   Windows  machineUuid  `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`
##            boardSerial, machineModel  the one pinned PowerShell CIM call (no wmic)
##            primaryMac   `getmac /fo csv /nh`
##            bootVolumeUuid  `cmd /c vol C:`
##   macOS    machineUuid, boardSerial  `ioreg -rd1 -c IOPlatformExpertDevice` (IOPlatformUUID,
##            IOPlatformSerialNumber); bootVolumeUuid `diskutil info -plist /`; primaryMac
##            `ifconfig`; machineModel `OS.get_model_name()` (hw.model)
##   Linux    machineUuid  /etc/machine-id, else /var/lib/dbus/machine-id (never a DMI file: they
##            are root-only, so the fingerprint would change with privilege); primaryMac
##            /sys/class/net/*/address; bootVolumeUuid `findmnt -no UUID /`; machineModel
##            /sys/class/dmi/id/product_name; no boardSerial
##   desktop  cpuModel `OS.get_processor_name():OS.get_processor_count()`; ramBucket from
##            `OS.get_memory_info().physical`
##   iOS      machineUuid `OS.get_unique_id()` (identifierForVendor), cpuModel, ramBucket,
##            machineModel
##   Android  machineUuid `OS.get_unique_id()` (ANDROID_ID), ramBucket, machineModel (Godot's
##            processor name is empty there, so no cpuModel)
##   web      nothing: there is no fingerprint (an allowed runtime N/A)
##
## primaryMac is the lowest MAC, normalised to lower-case colon form, ignoring all-zero,
## multicast and locally administered addresses (randomised Wi-Fi MACs, docker bridges, VM and
## AWDL interfaces), so a virtual interface coming and going does not look like a NIC change.
##
## A Mac App Store sandbox may refuse `ioreg`: machineUuid and boardSerial are then omitted, and
## the device id falls back to `OS.get_unique_id()` (the platform serial).

const HASH_PREFIX := "pkey-hw"
const COMPONENT_LENGTH := 22
const HWID_LENGTH := 32
## The canonical order (fingerprint.json `componentOrder`). The hwid iterates THIS order, never
## the order a reader produced.
const COMPONENTS := ["machineUuid", "boardSerial", "cpuModel", "primaryMac", "bootVolumeUuid", "ramBucket", "machineModel"]
const ANCHOR := "machineUuid"

## Rule 1: the one Windows CIM call, byte for byte what fingerprint.json's `windowsCimCommand`
## pins. One line with no double quotes, pure-ASCII output. `program` is resolved by
## `windows_powershell_path`. `stdin: null` holds because `OS.execute` gives the child no stdin
## handle; `timeoutMs` bounds how long `collect` waits for the capture, since `OS.execute` cannot
## be timed out.
const WINDOWS_CIM_COMMAND := {
	"program": "powershell.exe",
	"args": [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"$ErrorActionPreference='Stop';$b=$null;$m=$null;try{$b=@(Get-CimInstance -ClassName Win32_BaseBoard -Property SerialNumber)[-1].SerialNumber}catch{};try{$m=@(Get-CimInstance -ClassName Win32_ComputerSystem -Property Model)[-1].Model}catch{};$j=ConvertTo-Json -Compress -InputObject @{boardSerial=$b;machineModel=$m};$o='';foreach($c in $j.ToCharArray()){$n=[int]$c;if($n -gt 126){$o+='\\u'+$n.ToString('x4')}else{$o+=$c}};$o",
	],
	"stdin": "null",
	"timeoutMs": 10000,
}
## Rule 2's sources, in order.
const LINUX_ANCHOR_PATHS := ["/etc/machine-id", "/var/lib/dbus/machine-id"]
const LINUX_MODEL_PATH := "/sys/class/dmi/id/product_name"
const LINUX_NET_DIR := "/sys/class/net"
const WINDOWS_REG_ARGS := ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]
## How long `collect` waits for a capture before going on without it (the CIM call's budget plus
## the other reads). The capture keeps running and is memoised when it lands.
const CAPTURE_WAIT_MS := 15000
const _GIB := 1073741824

static var _re := {}
## The memoised capture of THIS machine (default host), or null; and the task producing it.
static var _captured = null
static var _task := -1
static var _task_box: Array = []


static func _static_init() -> void:
	_re["reg"] = RegEx.create_from_string("MachineGuid\\s+REG_SZ\\s+([A-Za-z0-9-]+)")
	_re["uuid"] = RegEx.create_from_string("\"IOPlatformUUID\"\\s*=\\s*\"([^\"]+)\"")
	_re["serial"] = RegEx.create_from_string("\"IOPlatformSerialNumber\"\\s*=\\s*\"([^\"]+)\"")
	_re["volume"] = RegEx.create_from_string("<key>VolumeUUID</key>\\s*<string>([^<]+)</string>")
	_re["vol"] = RegEx.create_from_string("([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})\\s*\\z")
	_re["ether"] = RegEx.create_from_string("(?m)^\\s+ether\\s+([0-9A-Fa-f:]+)")
	_re["mac"] = RegEx.create_from_string("\\A[0-9a-f]{2}(?::[0-9a-f]{2}){5}\\z")
	_re["winroot"] = RegEx.create_from_string("\\A(?:[A-Za-z]:[\\\\/]|\\\\\\\\)")


# ── The pure derivation rules (WIRE-CONTRACT-V3 §6.1), pinned by fingerprint.json ─────────

## Hash raw component values into the wire form {components, hwid}. Unknown keys are ignored.
static func hash_components(slug: String, raw: Dictionary) -> Dictionary:
	var components := {}
	var parts := PackedStringArray()
	for c in COMPONENTS:
		if not (raw.get(c) is String):
			continue
		var digest := _sha256_b64url("%s:%s:%s:%s" % [HASH_PREFIX, slug, c, raw[c]], COMPONENT_LENGTH)
		components[c] = digest
		parts.append("%s=%s" % [c, digest])
	return {"components": components, "hwid": _sha256_b64url("\n".join(parts), HWID_LENGTH)}


static func _sha256_b64url(text: String, length: int) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(text.to_utf8_buffer())
	return PKeyB64Url.encode(ctx.finish()).substr(0, length)


## Trims exactly U+0009–U+000D and U+0020 at both ends (never a language's default trim, which
## also drops U+00A0 or U+001F).
static func trim_ascii(value: String) -> String:
	var start := 0
	var end := value.length()
	while start < end and _is_ascii_space(value.unicode_at(start)):
		start += 1
	while end > start and _is_ascii_space(value.unicode_at(end - 1)):
		end -= 1
	return value.substr(start, end - start)


static func _is_ascii_space(c: int) -> bool:
	return (c >= 0x09 and c <= 0x0d) or c == 0x20


## Rule 1: parse what WINDOWS_CIM_COMMAND printed. One leading U+FEFF is stripped; the text must
## be a strict-JSON object; `boardSerial` and `machineModel` are kept when each is a String that
## is non-empty after trim_ascii. Anything else yields {}.
static func parse_windows_cim(stdout: Variant) -> Dictionary:
	if not (stdout is String) or (stdout as String).is_empty():
		return {}
	var text: String = stdout
	if text.unicode_at(0) == 0xFEFF:
		text = text.substr(1)
	var parsed := PKeyJson.parse(text)
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return {}
	var out := {}
	for key in ["boardSerial", "machineModel"]:
		var v = parsed["value"].get(key)
		if v is String:
			var trimmed := trim_ascii(v)
			if trimmed != "":
				out[key] = trimmed
	return out


## Rule 2: the first of LINUX_ANCHOR_PATHS whose content, trimmed, is non-empty and not
## systemd's `uninitialized`: {source, value}, or null. `files` maps each READABLE path to its
## content; an absent or null entry is unreadable. Also the Linux device id's raw input.
static func linux_anchor_source(files: Dictionary) -> Variant:
	# A packed copy: on 4.4 two threads iterating one const Array race (the capture and the
	# device id run on worker tasks), so thread-reachable code converts it first.
	for source in PackedStringArray(LINUX_ANCHOR_PATHS):
		var content = files.get(source)
		if not (content is String):
			continue
		var value := trim_ascii(content)
		if value != "" and value != "uninitialized":
			return {"source": source, "value": value}
	return null


## Rule 3: floor(bytes / 2^30), then the largest power of two not above it, in decimal; "" (the
## component is omitted) below 1 GiB. Integer arithmetic only.
static func ram_bucket(bytes: int) -> String:
	if bytes < _GIB:
		return ""
	var g := bytes / _GIB
	var p := 1
	while p * 2 <= g:
		p *= 2
	return str(p)


# ── Per-platform parsers over captured output ─────────────────────────────────────────────

static func _first(text: Variant, key: String) -> String:
	if not (text is String):
		return ""
	var m: RegExMatch = _re[key].search(text)
	return trim_ascii(m.get_string(1)) if m != null else ""


## `reg query …\Cryptography /v MachineGuid` -> the GUID, or "".
static func parse_reg_machine_guid(text: Variant) -> String:
	return _first(text, "reg")


## `ioreg -rd1 -c IOPlatformExpertDevice` -> {uuid?, serial?}.
static func parse_ioreg(text: Variant) -> Dictionary:
	var out := {}
	var uuid := _first(text, "uuid")
	if uuid != "":
		out["uuid"] = uuid
	var serial := _first(text, "serial")
	if serial != "":
		out["serial"] = serial
	return out


## `diskutil info -plist /` -> the boot volume's VolumeUUID, or "".
static func parse_diskutil_volume_uuid(text: Variant) -> String:
	return _first(text, "volume")


## `cmd /c vol C:` -> the volume serial (XXXX-XXXX), or "". Matched by shape on the output's
## last line rather than by the English "Volume Serial Number is", which Windows localises.
static func parse_vol_serial(text: Variant) -> String:
	if not (text is String):
		return ""
	return _first(trim_ascii(text), "vol").to_upper()


## `findmnt -no UUID /` -> the root filesystem UUID (the first word), or "".
static func parse_findmnt_uuid(text: Variant) -> String:
	if not (text is String):
		return ""
	var t := trim_ascii(text)
	if t == "":
		return ""
	return trim_ascii(t.split("\n")[0]).split(" ")[0].split("\t")[0]


## `getmac /fo csv /nh` -> every MAC in the first column (`"00-1A-2B-3C-4D-5E","\Device\…"`,
## or `"N/A","Disconnected"`), unnormalised.
static func parse_getmac(text: Variant) -> PackedStringArray:
	var out := PackedStringArray()
	if not (text is String):
		return out
	for line in (text as String).split("\n"):
		var l := trim_ascii(line)
		if l == "":
			continue
		var first := l.split(",")[0].strip_edges().trim_prefix("\"").trim_suffix("\"")
		out.append(first)
	return out


## `ifconfig` (macOS) -> every `ether` address, unnormalised.
static func parse_ifconfig(text: Variant) -> PackedStringArray:
	var out := PackedStringArray()
	if not (text is String):
		return out
	for m in _re["ether"].search_all(text):
		out.append(m.get_string(1))
	return out


## Lower-case, colon-separated, or "" when `mac` is not six two-digit hex octets.
static func normalize_mac(mac: String) -> String:
	var m := trim_ascii(mac).to_lower().replace("-", ":")
	return m if _re["mac"].search(m) != null else ""


## The lowest usable MAC, normalised, or "": all-zero, multicast and locally administered
## addresses (the first octet's two low bits) are ignored.
static func primary_mac(macs: PackedStringArray) -> String:
	var keep := PackedStringArray()
	for raw in macs:
		var m := normalize_mac(raw)
		if m == "" or m == "00:00:00:00:00:00":
			continue
		if m.substr(0, 2).hex_to_int() & 0x03 != 0:
			continue
		if not keep.has(m):
			keep.append(m)
	if keep.is_empty():
		return ""
	keep.sort()
	return keep[0]


## `%SystemRoot%\System32\<exe>` when SystemRoot is an absolute path, else the bare name.
static func windows_system_path(system_root: String, exe: String, subdir := "") -> String:
	if system_root == "" or _re["winroot"].search(system_root) == null:
		return exe
	var root := system_root
	while root.ends_with("\\") or root.ends_with("/"):
		root = root.substr(0, root.length() - 1)
	var dir := root + "\\System32"
	if subdir != "":
		dir += "\\" + subdir
	return dir + "\\" + exe


static func windows_powershell_path(system_root: String) -> String:
	return windows_system_path(system_root, WINDOWS_CIM_COMMAND["program"], "WindowsPowerShell\\v1.0")


# ── Capture (side effects) and assembly (pure) ────────────────────────────────────────────

## Runs every read this platform needs and returns what came back, unparsed:
## {platform, out: {name: stdout|null}, files: {path: text|null}, net: {iface: text|null},
## cpu_name, cpu_count, memory, model, unique_id}. Blocks (desktop commands); call it off the
## main thread. Web: {platform: "web"}.
static func capture(host: PKeyHostIo = null) -> Dictionary:
	var h: PKeyHostIo = host if host != null else PKeyHostIo.new()
	var platform := h.platform()
	var cap := {"platform": platform, "out": {}, "files": {}, "net": {}}
	match platform:
		"windows":
			var root := h.env("SystemRoot")
			if root == "":
				root = h.env("SYSTEMROOT")
			cap["out"]["reg"] = h.run(windows_system_path(root, "reg.exe"), PackedStringArray(WINDOWS_REG_ARGS))
			cap["out"]["cim"] = h.run(windows_powershell_path(root), PackedStringArray(WINDOWS_CIM_COMMAND["args"]))
			cap["out"]["getmac"] = h.run(windows_system_path(root, "getmac.exe"), PackedStringArray(["/fo", "csv", "/nh"]))
			cap["out"]["vol"] = h.run(windows_system_path(root, "cmd.exe"), PackedStringArray(["/c", "vol", "C:"]))
		"macos":
			cap["out"]["ioreg"] = h.run("/usr/sbin/ioreg", PackedStringArray(["-rd1", "-c", "IOPlatformExpertDevice"]))
			cap["out"]["diskutil"] = h.run("/usr/sbin/diskutil", PackedStringArray(["info", "-plist", "/"]))
			cap["out"]["ifconfig"] = h.run("/sbin/ifconfig", PackedStringArray())
		"linux":
			for p in PackedStringArray(LINUX_ANCHOR_PATHS):
				cap["files"][p] = h.read(p)
			cap["files"][LINUX_MODEL_PATH] = h.read(LINUX_MODEL_PATH)
			for iface in h.list_dir(LINUX_NET_DIR):
				if iface != "lo":
					cap["net"][iface] = h.read("%s/%s/address" % [LINUX_NET_DIR, iface])
			cap["out"]["findmnt"] = h.run("findmnt", PackedStringArray(["-no", "UUID", "/"]))
		"web", "":
			return cap
	cap["cpu_name"] = h.processor_name()
	cap["cpu_count"] = h.processor_count()
	cap["memory"] = h.memory_bytes()
	cap["model"] = h.model_name()
	if platform == "ios" or platform == "android":
		cap["unique_id"] = h.unique_id()
	return cap


## The raw component values from a capture: component -> String, unreadable ones omitted.
static func components_from_capture(cap: Dictionary) -> Dictionary:
	var raw := {}
	var platform: String = cap.get("platform", "")
	var out: Dictionary = cap.get("out", {})
	match platform:
		"windows":
			_put(raw, "machineUuid", parse_reg_machine_guid(out.get("reg")))
			var cim := parse_windows_cim(out.get("cim"))
			_put(raw, "boardSerial", cim.get("boardSerial", ""))
			_put(raw, "machineModel", cim.get("machineModel", ""))
			_put(raw, "primaryMac", primary_mac(parse_getmac(out.get("getmac"))))
			_put(raw, "bootVolumeUuid", parse_vol_serial(out.get("vol")))
		"macos":
			var io := parse_ioreg(out.get("ioreg"))
			_put(raw, "machineUuid", io.get("uuid", ""))
			_put(raw, "boardSerial", io.get("serial", ""))
			_put(raw, "primaryMac", primary_mac(parse_ifconfig(out.get("ifconfig"))))
			_put(raw, "bootVolumeUuid", parse_diskutil_volume_uuid(out.get("diskutil")))
			_put(raw, "machineModel", _model(cap))
		"linux":
			var anchor = linux_anchor_source(cap.get("files", {}))
			if anchor != null:
				raw["machineUuid"] = anchor["value"]
			var addrs := PackedStringArray()
			var net: Dictionary = cap.get("net", {})
			for iface in net:
				if net[iface] is String:
					addrs.append(net[iface])
			_put(raw, "primaryMac", primary_mac(addrs))
			_put(raw, "bootVolumeUuid", parse_findmnt_uuid(out.get("findmnt")))
			var model = cap.get("files", {}).get(LINUX_MODEL_PATH)
			_put(raw, "machineModel", trim_ascii(model) if model is String else "")
		"ios", "android":
			_put(raw, "machineUuid", trim_ascii(str(cap.get("unique_id", ""))))
			_put(raw, "machineModel", _model(cap))
		_:
			return raw
	if platform != "android":
		var cpu := trim_ascii(str(cap.get("cpu_name", "")))
		var n := int(cap.get("cpu_count", 0))
		if cpu != "" and n > 0:
			raw["cpuModel"] = "%s:%d" % [cpu, n]
	_put(raw, "ramBucket", ram_bucket(int(cap.get("memory", -1))))
	return raw


static func _model(cap: Dictionary) -> String:
	var m := trim_ascii(str(cap.get("model", "")))
	return "" if m == "GenericDevice" else m


static func _put(raw: Dictionary, component: String, value: String) -> void:
	if value != "":
		raw[component] = value


## The raw values of `host` (default: this machine), synchronously. Blocks on desktop.
static func raw_components(host: PKeyHostIo = null) -> Dictionary:
	return components_from_capture(capture(host))


## The raw values, with the capture on a WorkerThreadPool task (inline where the build has no
## threads). This machine's capture is memoised for the session; a host's never is. A capture
## that has not landed within CAPTURE_WAIT_MS yields {} this time. A coroutine.
static func raw_components_async(host: PKeyHostIo = null) -> Dictionary:
	if host == null and _captured != null:
		return components_from_capture(_captured)
	if not OS.has_feature("threads") or OS.has_feature("web"):
		var cap := capture(host)
		if host == null:
			_captured = cap
		return components_from_capture(cap)
	var tree := Engine.get_main_loop() as SceneTree
	var box: Array = []
	var id := -1
	if host == null:
		if _task < 0:
			_task_box = []
			var shared := _task_box
			_task = WorkerThreadPool.add_task(func() -> void: shared.append(capture(null)), false, "PolarisKey fingerprint")
		id = _task
		box = _task_box
	else:
		var h := host
		id = WorkerThreadPool.add_task(func() -> void: box.append(capture(h)), false, "PolarisKey fingerprint")
	var deadline := Time.get_ticks_msec() + CAPTURE_WAIT_MS
	while not WorkerThreadPool.is_task_completed(id):
		if Time.get_ticks_msec() >= deadline or tree == null:
			return {}
		await tree.process_frame
	if host == null:
		if _task == id:
			WorkerThreadPool.wait_for_task_completion(id)
			_task = -1
			if not box.is_empty():
				_captured = box[0]
		if _captured == null:
			return {}
		return components_from_capture(_captured)
	WorkerThreadPool.wait_for_task_completion(id)
	return components_from_capture(box[0]) if not box.is_empty() else {}


## Collect and hash `slug`'s fingerprint: {components, hwid}, or null when nothing could be read
## (always on web). A coroutine.
static func collect(slug: String, host: PKeyHostIo = null) -> Variant:
	var raw := await raw_components_async(host)
	if raw.is_empty():
		return null
	return hash_components(slug, raw)


## Forget this machine's memoised capture (tests).
static func reset_memo() -> void:
	_captured = null


# ── The device id's raw source (desktop: the same value Node and Swift hash) ─────────────

## The raw identifier the device id hashes: MachineGuid on Windows, IOPlatformUUID on macOS, the
## rule-2 machine-id on Linux; `OS.get_unique_id()` elsewhere and wherever those cannot be read
## (a sandbox that refuses `ioreg`). "" when nothing is readable (web). Blocks: one short read.
static func device_id_raw(host: PKeyHostIo = null) -> String:
	var h: PKeyHostIo = host if host != null else PKeyHostIo.new()
	var raw := device_anchor(h)
	if raw == "":
		raw = trim_ascii(h.unique_id())
	return raw


## The desktop platform anchor ALONE (MachineGuid, IOPlatformUUID, the rule-2 machine-id), or ""
## where none is readable (mobile, web, a sandbox that refuses the probe). Never the
## `OS.get_unique_id()` fallback: a device id is re-derived from this at every start (PKeyDeviceBinding)
## and a stored id is kept when it is empty. The probes run by ABSOLUTE path (`/usr/sbin/ioreg`,
## `%SystemRoot%\\System32\\reg.exe`), never through PATH; a Windows without a usable SystemRoot has
## no anchor rather than a PATH lookup. Blocks: one short read.
static func device_anchor(host: PKeyHostIo = null) -> String:
	var h: PKeyHostIo = host if host != null else PKeyHostIo.new()
	match h.platform():
		"windows":
			var root := h.env("SystemRoot")
			if root == "":
				root = h.env("SYSTEMROOT")
			var reg := windows_system_path(root, "reg.exe")
			if reg == "reg.exe":
				return ""
			return parse_reg_machine_guid(h.run(reg, PackedStringArray(WINDOWS_REG_ARGS)))
		"macos":
			return parse_ioreg(h.run("/usr/sbin/ioreg", PackedStringArray(["-rd1", "-c", "IOPlatformExpertDevice"]))).get("uuid", "")
		"linux":
			var files := {}
			for p in PackedStringArray(LINUX_ANCHOR_PATHS):
				files[p] = h.read(p)
			var anchor = linux_anchor_source(files)
			return anchor["value"] if anchor != null else ""
	return ""
