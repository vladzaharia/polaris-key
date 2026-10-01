@tool
class_name PKeyQrCode
extends RefCounted
## One encoded QR symbol (PKeyQr.encode): its version, the mask that was applied, its size in
## modules (version * 4 + 17, without the quiet zone) and the modules, row-major, 1 = dark.

var version := 0
var mask := 0
var size := 0
var modules := PackedByteArray()


func _init(p_version := 0, p_mask := 0, p_size := 0, p_modules := PackedByteArray()) -> void:
	version = p_version
	mask = p_mask
	size = p_size
	modules = p_modules


## True when the module at column `x`, row `y` is dark; outside the symbol (the quiet zone) is
## light.
func is_dark(x: int, y: int) -> bool:
	if x < 0 or y < 0 or x >= size or y >= size:
		return false
	return modules[y * size + x] == 1


## The rows as strings of "1" (dark) and "0" (light): the fixtures' format.
func rows() -> PackedStringArray:
	var out := PackedStringArray()
	for y in size:
		var line := ""
		for x in size:
			line += "1" if modules[y * size + x] == 1 else "0"
		out.append(line)
	return out


## The symbol as an Image: one pixel per module, `quiet_zone` light modules on every side.
func to_image(dark: Color = Color.BLACK, light: Color = Color.WHITE, quiet_zone := 4) -> Image:
	var q := maxi(quiet_zone, 0)
	var n := size + q * 2
	var img := Image.create_empty(n, n, false, Image.FORMAT_RGBA8)
	img.fill(light)
	for y in size:
		for x in size:
			if modules[y * size + x] == 1:
				img.set_pixel(x + q, y + q, dark)
	return img
