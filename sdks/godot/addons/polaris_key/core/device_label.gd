class_name PKeyDeviceLabel
extends RefCounted
## The device label (WIRE-CONTRACT-V5 §12.7.1, plans/PX-W13.md §2.1), pinned by
## `device-label.json` (`deviceLabelVersion` 2): the human name of this device the sign-in page
## shows ("Living room TV"), sent as `deviceName` on device-code sign-in, licence activation and
## registration. Display data only; no server decision reads it. The Worker applies the same
## normalisation on receipt:
##
##   1. map every White_Space code point and U+2800 to a space;
##   2. delete the controls, format characters, default-ignorable code points and surrogates;
##   3. collapse runs of spaces to one, then trim;
##   4. keep at most DEVICE_LABEL_MAX_CODEPOINTS code points (a Godot String is UTF-32, so one
##      character is one code point), and trim a space the cut exposes;
##   5. an empty result is no label ("").
##
## `normalize` applies no Unicode normalisation; nothing is ever rejected. The peer HELLO cleaner
## (§15.6: steps 1 and 2, NFC, then 3 to 5) is `clean_hello`, over `PKeyNfc` (CC-14 D-20).

## Frozen at Unicode 16.0 as inclusive [lo, hi] pairs; the corpus `ranges` section pins both.
const SPACE_RANGES := [
	[0x0009, 0x000D], [0x0085, 0x0085], [0x00A0, 0x00A0], [0x1680, 0x1680], [0x2000, 0x200A],
	[0x2028, 0x2029], [0x202F, 0x202F], [0x205F, 0x205F], [0x2800, 0x2800], [0x3000, 0x3000],
]
const STRIP_RANGES := [
	[0x0000, 0x001F], [0x007F, 0x009F], [0x00AD, 0x00AD], [0x034F, 0x034F], [0x0600, 0x0605],
	[0x061C, 0x061C], [0x06DD, 0x06DD], [0x070F, 0x070F], [0x0890, 0x0891], [0x08E2, 0x08E2],
	[0x115F, 0x1160], [0x17B4, 0x17B5], [0x180B, 0x180F], [0x200B, 0x200F], [0x202A, 0x202E],
	[0x2060, 0x206F], [0x3164, 0x3164], [0xD800, 0xDFFF], [0xFE00, 0xFE0F], [0xFEFF, 0xFEFF],
	[0xFFA0, 0xFFA0], [0xFFF0, 0xFFFB], [0x110BD, 0x110BD], [0x110CD, 0x110CD], [0x13430, 0x1343F],
	[0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE0FFF],
]


static func _in(cp: int, ranges: Array) -> bool:
	for r in ranges:
		if cp >= r[0] and cp <= r[1]:
			return true
	return false


## `_in` for a table sorted ascending (both range tables are): a binary search, so a megabyte of
## deleted code points costs a few comparisons each.
static func _in_sorted(cp: int, ranges: Array) -> bool:
	var lo := 0
	var hi := ranges.size() - 1
	while lo <= hi:
		var mid := (lo + hi) >> 1
		var r: Array = ranges[mid]
		if cp < r[0]:
			hi = mid - 1
		elif cp > r[1]:
			lo = mid + 1
		else:
			return true
	return false


## §12.7.1: the label to send and store; "" when nothing is left of `raw`.
static func normalize(raw: String) -> String:
	var kept := PackedInt32Array()
	for i in raw.length():
		var cp := raw.unicode_at(i)
		if _in(cp, SPACE_RANGES):
			cp = 0x20
		elif _in(cp, STRIP_RANGES):
			continue
		if cp == 0x20 and (kept.is_empty() or kept[kept.size() - 1] == 0x20):
			continue
		kept.append(cp)
	while not kept.is_empty() and kept[kept.size() - 1] == 0x20:
		kept.remove_at(kept.size() - 1)
	if kept.size() > PKeyConstants.DEVICE_LABEL_MAX_CODEPOINTS:
		kept.resize(PKeyConstants.DEVICE_LABEL_MAX_CODEPOINTS)
	while not kept.is_empty() and kept[kept.size() - 1] == 0x20:
		kept.remove_at(kept.size() - 1)
	var out := ""
	for cp in kept:
		out += String.chr(cp)
	return out


## §15.6: the label or app a peer HELLO carries. Steps 1 and 2 of §12.7.1, then NFC, then steps 3 to
## 5; "" when nothing is left. The cut counts code points AFTER NFC. Streams segment by segment and
## stops once more than DEVICE_LABEL_MAX_CODEPOINTS output code points exist, so a mode-a HELLO of
## a megabyte costs a bounded amount of NFC work.
static func clean_hello(raw: String) -> String:
	return _clean_nfc(raw, PKeyConstants.DEVICE_LABEL_MAX_CODEPOINTS)


## §15.11: a transfer's `name` as shown. The HELLO cleaning (`clean_hello`) without the cut to
## DEVICE_LABEL_MAX_CODEPOINTS; null when `raw` is not a String or nothing is left. U+FFFD, which a
## JSON `\u0000` escape becomes here, is dropped first (as for a HELLO label). Display data only:
## it never reaches a path.
static func clean_name(raw: Variant) -> Variant:
	if not raw is String:
		return null
	var cleaned := _clean_nfc((raw as String).replace(char(0xFFFD), ""), 0x7FFFFFFF)
	return cleaned if cleaned != "" else null


static func _clean_nfc(raw: String, cap: int) -> String:
	var res := PackedInt32Array()
	var seg := PackedInt32Array()
	var parts := PackedInt32Array()
	var n := raw.length()
	var i := 0
	while i < n and res.size() <= cap:
		var cp := raw.unicode_at(i)
		i += 1
		if cp < 0x21 or cp > 0x7E:
			if _in_sorted(cp, SPACE_RANGES):
				cp = 0x20
			elif _in_sorted(cp, STRIP_RANGES):
				continue
		parts.clear()
		PKeyNfc.decompose(cp, parts)
		for d in parts:
			if not seg.is_empty() and PKeyNfc.is_boundary(d):
				_emit_collapsed(PKeyNfc.compose_segment(seg), res)
				seg.clear()
			seg.append(d)
	if res.size() <= cap and not seg.is_empty():
		_emit_collapsed(PKeyNfc.compose_segment(seg), res)
	while not res.is_empty() and res[res.size() - 1] == 0x20:
		res.remove_at(res.size() - 1)
	if res.size() > cap:
		res.resize(cap)
	while not res.is_empty() and res[res.size() - 1] == 0x20:
		res.remove_at(res.size() - 1)
	return PKeyNfc.to_string_cps(res)


## Step 3 on a stream: a space is dropped at the start and after a space.
static func _emit_collapsed(cps: PackedInt32Array, res: PackedInt32Array) -> void:
	for cp in cps:
		if cp == 0x20 and (res.is_empty() or res[res.size() - 1] == 0x20):
			continue
		res.append(cp)


## The platform's own name for this device (the contract's default, WIRE-CONTRACT-V4 §12.7.1): the
## model where the OS reports a real one, else the OS name ("macOS", "Linux", …). The drop-in
## `boot()` replaces it with `computer_name()` where it has one (see `friendly_default()`).
static func platform_default() -> String:
	var model := OS.get_model_name()
	if model != "" and model != "GenericDevice":
		return model
	return OS.get_name()


## What a game's drop-in names this device when its configuration names none: the model where the OS
## reports a real one, else the computer's own name, else the OS name.
static func friendly_default() -> String:
	var model := OS.get_model_name()
	if model != "" and model != "GenericDevice":
		return model
	var host := computer_name()
	return host if host != "" else OS.get_name()


## The computer's own name on a desktop, "" where there is none to read (a phone reports a model,
## a browser has no name). Read once per run: macOS asks `scutil`, Windows its COMPUTERNAME,
## Linux /etc/hostname. A `.local`, `.lan` or `.home` suffix goes, as in the other SDKs.
static func computer_name() -> String:
	if _computer_name_read:
		return _computer_name
	_computer_name_read = true
	var raw := ""
	match OS.get_name():
		"macOS":
			var out: Array = []
			if OS.execute("/usr/sbin/scutil", PackedStringArray(["--get", "ComputerName"]), out, false) == 0 and not out.is_empty():
				raw = String(out[0]).strip_edges()
			if raw == "":
				out = []
				if OS.execute("/bin/hostname", PackedStringArray(), out, false) == 0 and not out.is_empty():
					raw = String(out[0]).strip_edges()
		"Windows":
			raw = OS.get_environment("COMPUTERNAME")
		"Linux", "FreeBSD", "NetBSD", "OpenBSD", "BSD":
			if FileAccess.file_exists("/etc/hostname"):
				raw = FileAccess.get_file_as_string("/etc/hostname").strip_edges()
			if raw == "":
				raw = OS.get_environment("HOSTNAME")
	for suffix in [".local", ".lan", ".home"]:
		if raw.to_lower().ends_with(suffix):
			raw = raw.substr(0, raw.length() - suffix.length())
	_computer_name = normalize(raw)
	return _computer_name


static var _computer_name_read := false
static var _computer_name := ""


## The label to send: a non-empty `override` (per call) wins; else nothing when
## `options.send_device_name` is off; else `options.device_name`; else `platform_default()`.
## "" means send none.
static func resolve(override: String, options: PKeyOptions, platform: Callable = Callable()) -> String:
	if override != "":
		return normalize(override)
	if options != null and not options.send_device_name:
		return ""
	if options != null and options.device_name != "":
		return normalize(options.device_name)
	return normalize(String(platform.call()) if platform.is_valid() else platform_default())
