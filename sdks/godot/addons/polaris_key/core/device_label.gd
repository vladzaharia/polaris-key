class_name PKeyDeviceLabel
extends RefCounted
## The device label (WIRE-CONTRACT-V4 §12.7.1, plans/PX-W13.md §2.1), pinned by
## `device-label.json`: the human name of this device the sign-in page shows ("Living room TV"),
## sent as `deviceName` on device-code sign-in, licence activation and registration. Display data
## only; no server decision reads it. The Worker applies the same normalisation on receipt:
##
##   1. map the whitespace controls (U+0009-000D, U+0085, U+00A0, U+2028, U+2029, U+3000) to a
##      space;
##   2. delete the controls, zero-width and bidi code points;
##   3. collapse runs of spaces to one, then trim;
##   4. keep at most DEVICE_LABEL_MAX_CODEPOINTS code points (a Godot String is UTF-32, so one
##      character is one code point), and trim a space the cut exposes;
##   5. an empty result is no label ("").
##
## No Unicode normalisation (Godot has none); nothing is ever rejected.

const _SPACE := [[0x0009, 0x000D], [0x0085, 0x0085], [0x00A0, 0x00A0], [0x2028, 0x2029], [0x3000, 0x3000]]
const _STRIP := [
	[0x0000, 0x001F], [0x007F, 0x009F], [0x061C, 0x061C], [0x200B, 0x200F],
	[0x202A, 0x202E], [0x2060, 0x2064], [0x2066, 0x2069], [0xFEFF, 0xFEFF],
]


static func _in(cp: int, ranges: Array) -> bool:
	for r in ranges:
		if cp >= r[0] and cp <= r[1]:
			return true
	return false


## §12.7.1: the label to send and store; "" when nothing is left of `raw`.
static func normalize(raw: String) -> String:
	var kept := PackedInt32Array()
	for i in raw.length():
		var cp := raw.unicode_at(i)
		if _in(cp, _SPACE):
			cp = 0x20
		elif _in(cp, _STRIP):
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


## The platform's own name for this device: the model where the OS reports a real one, else the
## OS name ("macOS", "Linux", …).
static func platform_default() -> String:
	var model := OS.get_model_name()
	if model != "" and model != "GenericDevice":
		return model
	return OS.get_name()


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
