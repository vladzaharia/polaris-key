class_name PKeyAccent
extends RefCounted
## The accent resolver (docs/design/UI-KITS.md §3.3), a step-for-step port of
## packages/brand/src/accent.ts. The `brand` suite holds it to the shared vectors
## (tests/brand/accent-vectors.json, from packages/brand/fixtures/accent-vectors.json): change the
## algorithm only together with every port.
##
##   PKeyAccent.derive(image.get_data())   the input colour from a product icon (RGBA8) when the
##                                         product supplies none
##   PKeyAccent.resolve("#ff6a3d", true)   solid, on, fg, subtle and focus for one colour scheme
##
## Colours cross this API as lower-case "#rrggbb" strings; Color(hex) turns one into a Color.

const WHITE := "#ffffff"
const INK := "#060912"

const TEXT := 4.5
const UI := 3.0
const WHITE_SHIFT := 0.08
const FG_DARK_L := 0.78
const FG_LIGHT_L := 0.52
const STEPS := 32
const OPAQUE_ALPHA := 128
const GREY_CHROMA := 0.04
const HUE_BIN := 30.0
const MIN_SHARE := 0.08
const DERIVED_L_MIN := 0.45
const DERIVED_L_MAX := 0.6
const SUBTLE_ALPHA_DARK := 0.12
const SUBTLE_ALPHA_LIGHT := 0.1


## The scheme's surfaces, in the resolver's order: page, raised, overlay, sunken.
static func surfaces(dark: bool) -> Array:
	if dark:
		return [_html(PKeyBrand.Dark.SURFACE_PAGE), _html(PKeyBrand.Dark.SURFACE_RAISED), _html(PKeyBrand.Dark.SURFACE_OVERLAY), _html(PKeyBrand.Dark.SURFACE_SUNKEN)]
	return [_html(PKeyBrand.Light.SURFACE_PAGE), _html(PKeyBrand.Light.SURFACE_RAISED), _html(PKeyBrand.Light.SURFACE_OVERLAY), _html(PKeyBrand.Light.SURFACE_SUNKEN)]


## Resolve any input colour ("#rgb" or "#rrggbb") for one scheme: a Dictionary with solid, on,
## fg, subtle and focus, or an empty Dictionary for anything that is not a hex colour.
static func resolve(hex: String, dark: bool) -> Dictionary:
	var input := normalize(hex)
	if input == "":
		return {}
	var white_label := is_white_label(input)
	var s := solid(input, dark, white_label)
	var f := fg(input, dark)
	var alpha := SUBTLE_ALPHA_DARK if dark else SUBTLE_ALPHA_LIGHT
	return {
		"solid": s,
		"on": WHITE if white_label else INK,
		"fg": f,
		"subtle": _mix_over(s, alpha, surfaces(dark)[0]),
		"focus": f if dark else s,
	}


## True when darkening by at most 0.08 reaches 4.5:1 against white (a white label); false means
## an ink label. It depends on the colour alone, never the scheme.
static func is_white_label(hex: String) -> bool:
	var base := _hex_to_oklch(hex)
	var shifted := _at(base, base[0] - WHITE_SHIFT)
	return contrast(WHITE, shifted) >= TEXT


## `solid` for a colour, a scheme and a label (the danger solid passes white_label = true).
static func solid(hex: String, dark: bool, white_label: bool) -> String:
	var base := _hex_to_oklch(hex)
	var grounds := surfaces(dark)
	var on_ui := func(h: String) -> bool: return _clears(h, grounds, UI)
	if white_label:
		var s := _move_until(base, -1.0, func(h: String) -> bool: return contrast(WHITE, h) >= TEXT)
		if dark and not on_ui.call(s):
			return _move_until(_hex_to_oklch(s), 1.0, on_ui)
		return s
	var s2 := _move_until(base, 1.0, func(h: String) -> bool: return contrast(INK, h) >= TEXT)
	if not dark and not on_ui.call(s2):
		return _move_until(_hex_to_oklch(s2), -1.0, on_ui)
	return s2


## `fg` for a colour in a scheme: text that clears 4.5:1 on every surface.
static func fg(hex: String, dark: bool) -> String:
	var base := _hex_to_oklch(hex)
	var grounds := surfaces(dark)
	var readable := func(h: String) -> bool: return _clears(h, grounds, TEXT)
	if dark:
		return _move_until([maxf(base[0], FG_DARK_L), base[1], base[2]], 1.0, readable)
	return _move_until([minf(base[0], FG_LIGHT_L), base[1], base[2]], -1.0, readable)


## The input colour for a product without one, from its icon's RGBA8 bytes (Image.get_data() of an
## FORMAT_RGBA8 image): the mean of the most saturated 30° hue cluster covering at least 8 % of the
## opaque pixels, at an accent lightness; "" for a near-greyscale or empty icon (the kit uses ink).
static func derive(rgba: PackedByteArray) -> String:
	var count := int(360.0 / HUE_BIN)
	var n := PackedInt64Array()
	var sum_l := PackedFloat64Array()
	var sum_a := PackedFloat64Array()
	var sum_b := PackedFloat64Array()
	var sum_c := PackedFloat64Array()
	n.resize(count)
	sum_l.resize(count)
	sum_a.resize(count)
	sum_b.resize(count)
	sum_c.resize(count)
	var opaque := 0
	var i := 0
	while i + 3 < rgba.size():
		if rgba[i + 3] >= OPAQUE_ALPHA:
			opaque += 1
			var lab := _rgb_to_oklab([rgba[i] / 255.0, rgba[i + 1] / 255.0, rgba[i + 2] / 255.0])
			var lch := _oklab_to_oklch(lab)
			if lch[1] >= GREY_CHROMA:
				var k := mini(count - 1, int(floor(lch[2] / HUE_BIN)))
				n[k] += 1
				sum_l[k] += lab[0]
				sum_a[k] += lab[1]
				sum_b[k] += lab[2]
				sum_c[k] += lch[1]
		i += 4
	if opaque == 0:
		return ""
	var best := -1
	for k in count:
		if float(n[k]) < MIN_SHARE * opaque:
			continue
		if best < 0:
			best = k
			continue
		var chroma := sum_c[k] / n[k]
		var best_chroma := sum_c[best] / n[best]
		if chroma > best_chroma or (chroma == best_chroma and n[k] > n[best]):
			best = k
	if best < 0:
		return ""
	var total := float(n[best])
	var mean := _oklab_to_oklch([sum_l[best] / total, sum_a[best] / total, sum_b[best] / total])
	return _oklch_to_hex([minf(DERIVED_L_MAX, maxf(DERIVED_L_MIN, mean[0])), mean[1], mean[2]])


## WCAG 2 contrast ratio between two "#rrggbb" colours.
static func contrast(a: String, b: String) -> float:
	var la := _luminance(a)
	var lb := _luminance(b)
	if la > lb:
		return (la + 0.05) / (lb + 0.05)
	return (lb + 0.05) / (la + 0.05)


## Lower-case "#rrggbb" for "#rgb" or "#rrggbb"; "" for anything else.
static func normalize(hex: String) -> String:
	var rgb := _parse_hex(hex)
	if rgb.is_empty():
		return ""
	return _to_hex(rgb)


# ── Search ────────────────────────────────────────────────────────────────────────────────────

static func _at(base: Array, l: float) -> String:
	return _oklch_to_hex([minf(1.0, maxf(0.0, l)), base[1], base[2]])


static func _move_until(base: Array, dir: float, ok: Callable) -> String:
	var start := _at(base, base[0])
	if ok.call(start):
		return start
	var lo := 0.0
	var hi: float = base[0] if dir < 0 else 1.0 - base[0]
	if not ok.call(_at(base, base[0] + dir * hi)):
		return _at(base, base[0] + dir * hi)
	for _step in STEPS:
		var mid := (lo + hi) / 2.0
		if ok.call(_at(base, base[0] + dir * mid)):
			hi = mid
		else:
			lo = mid
	return _at(base, base[0] + dir * hi)


static func _clears(hex: String, grounds: Array, minimum: float) -> bool:
	for g in grounds:
		if contrast(hex, g) < minimum:
			return false
	return true


# ── Colour science (packages/brand/src/color.ts). Triples are Arrays of 64-bit floats: rgb,
# (L, a, b) or (L, C, h); never Vector3, whose components are 32-bit in a standard engine build. ──

static func _html(c: Color) -> String:
	return "#" + c.to_html(false)


## [r, g, b] in 0..1, or [] when `hex` is not "#rgb" or "#rrggbb".
static func _parse_hex(hex: String) -> Array:
	if not hex.begins_with("#"):
		return []
	var digits := hex.substr(1).to_lower()
	if digits.length() != 3 and digits.length() != 6:
		return []
	for ch in digits:
		if not "0123456789abcdef".contains(ch):
			return []
	if digits.length() == 3:
		digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2]
	var v := digits.hex_to_int()
	return [((v >> 16) & 0xFF) / 255.0, ((v >> 8) & 0xFF) / 255.0, (v & 0xFF) / 255.0]


static func _to_hex(rgb: Array) -> String:
	var out := "#"
	for x in rgb:
		out += "%02x" % int(floor(minf(1.0, maxf(0.0, x)) * 255.0 + 0.5))
	return out


static func _to_linear(v: float) -> float:
	return v / 12.92 if v <= 0.04045 else pow((v + 0.055) / 1.055, 2.4)


static func _from_linear(v: float) -> float:
	return v * 12.92 if v <= 0.0031308 else 1.055 * pow(v, 1.0 / 2.4) - 0.055


## The real cube root. GDScript has no cbrt: pow() gives it to within an ulp or two, and one
## Newton step lands on the value the other runtimes' cbrt returns.
static func _cbrt(x: float) -> float:
	if x == 0.0:
		return 0.0
	var a := absf(x)
	var r := pow(a, 1.0 / 3.0)
	r = r - (r * r * r - a) / (3.0 * r * r)
	return r if x > 0.0 else -r


static func _rgb_to_oklab(c: Array) -> Array:
	var lr := _to_linear(c[0])
	var lg := _to_linear(c[1])
	var lb := _to_linear(c[2])
	var l := _cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
	var m := _cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
	var s := _cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	]


static func _oklab_to_rgb(c: Array) -> Array:
	var l := pow(c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2], 3.0)
	var m := pow(c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2], 3.0)
	var s := pow(c[0] - 0.0894841775 * c[1] - 1.291485548 * c[2], 3.0)
	return [
		_from_linear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		_from_linear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		_from_linear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
	]


static func _oklab_to_oklch(c: Array) -> Array:
	var h := atan2(c[2], c[1]) * 180.0 / PI
	if h < 0.0:
		h += 360.0
	return [c[0], sqrt(c[1] * c[1] + c[2] * c[2]), h]


static func _oklch_to_oklab(c: Array) -> Array:
	var rad: float = c[2] * PI / 180.0
	return [c[0], c[1] * cos(rad), c[1] * sin(rad)]


static func _hex_to_oklch(hex: String) -> Array:
	var rgb := _parse_hex(hex)
	return _oklab_to_oklch(_rgb_to_oklab(rgb if not rgb.is_empty() else [0.0, 0.0, 0.0]))


static func _in_gamut(c: Array) -> bool:
	var eps := 1e-6
	for x in c:
		if x < -eps or x > 1.0 + eps:
			return false
	return true


static func _oklch_to_hex(color: Array) -> String:
	var rgb := _oklab_to_rgb(_oklch_to_oklab(color))
	if not _in_gamut(rgb):
		var lo := 0.0
		var hi: float = color[1]
		while hi - lo > 1e-5:
			var mid := (lo + hi) / 2.0
			if _in_gamut(_oklab_to_rgb(_oklch_to_oklab([color[0], mid, color[2]]))):
				lo = mid
			else:
				hi = mid
		rgb = _oklab_to_rgb(_oklch_to_oklab([color[0], lo, color[2]]))
	return _to_hex(rgb)


static func _luminance(hex: String) -> float:
	var c := _parse_hex(hex)
	if c.is_empty():
		c = [0.0, 0.0, 0.0]
	return 0.2126 * _to_linear(c[0]) + 0.7152 * _to_linear(c[1]) + 0.0722 * _to_linear(c[2])


static func _mix_over(fg_hex: String, alpha: float, bg_hex: String) -> String:
	var f := _parse_hex(fg_hex)
	var b := _parse_hex(bg_hex)
	return _to_hex([f[0] * alpha + b[0] * (1.0 - alpha), f[1] * alpha + b[1] * (1.0 - alpha), f[2] * alpha + b[2] * (1.0 - alpha)])
