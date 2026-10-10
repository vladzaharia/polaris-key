class_name PKeyPresentationFixtures
extends RefCounted
## Product presentation for the tests (core.presentation): icon bytes drawn here (the engine
## encodes them, so their hashes are computed, never pinned), discovery manifests carrying a member,
## and a source bound to the UI kit whose icon is already in its disk cache (verified from disk as
## after an earlier session's fetch; no network).

## Drift Kart, the ui-matrix.json theme rows' product.
const DRIFT_KART := {"name": "Drift Kart", "developerName": "Lanternworks", "accent": "#ff6a3d"}
const LONG_NAME := "Tidewater Studio Professional Edition for Teams and Classrooms"
## A right-to-left name (Hebrew, which Rubik carries): "Studio Gal".
const RTL_NAME := "סטודיו גל"
const ORIGIN := "https://img.plrs.im"
## The scratch cache the kit scenarios share (cleared by each `present()`).
const UI_CACHE := "user://pkey-test/presentation-ui"


## An icon `size` pixels square: a rounded tile in `colour` with a lighter diagonal band, so a
## render shows an icon and the icon-derived accent has a hue to find.
static func icon_image(size := 64, colour := Color("#ff6a3d")) -> Image:
	var img := Image.create(size, size, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	var r := size * 0.22
	for y in size:
		for x in size:
			var dx := maxf(0.0, maxf(r - x, x - (size - 1 - r)))
			var dy := maxf(0.0, maxf(r - y, y - (size - 1 - r)))
			if dx * dx + dy * dy > r * r:
				continue
			var band := absf(float(x - y)) < size * 0.18
			img.set_pixel(x, y, colour.lightened(0.35) if band else colour)
	return img


static func png(size := 64, colour := Color("#ff6a3d")) -> PackedByteArray:
	return icon_image(size, colour).save_png_to_buffer()


static func webp(size := 64, colour := Color("#ff6a3d")) -> PackedByteArray:
	return icon_image(size, colour).save_webp_to_buffer(false)


static func sha(bytes: PackedByteArray) -> String:
	return PKeyPresentationRules.sha256_hex(bytes)


## A presentation member as discovery serves it: `fields` (name, developerName, accent, accentDark)
## plus, when `icon` is a Dictionary, that icon.
static func member(fields: Dictionary, icon: Variant = null) -> Dictionary:
	var m := fields.duplicate(true)
	if icon is Dictionary:
		m["icon"] = icon
	return m


## An icon whose original is `original_bytes` at `<origin>/<product>/a/<sha>` and whose WebP ladder
## is `sizes` ([[w, bytes], …]) at `<original>/{w}.webp`.
static func icon(original_bytes: PackedByteArray, content_type := "image/png", sizes: Array = [], origin := ORIGIN, width := 0) -> Dictionary:
	var s := sha(original_bytes)
	var original := "%s/djdl/a/%s" % [origin, s]
	var out := {"sha256": s, "contentType": content_type, "original": original}
	if width > 0:
		out["width"] = width
		out["height"] = width
	if not sizes.is_empty():
		out["url"] = original + "/{w}.webp"
		var ladder: Array = []
		for e in sizes:
			ladder.append({"w": e[0], "sha256": sha(e[1])})
		out["sizes"] = ladder
	return out


## A discovery manifest (as PKeyDiscovery.parse keeps it) carrying `presentation`, or none when it is
## null.
static func manifest(presentation: Variant, product := "djdl") -> Dictionary:
	var core := {"registration": "requires-license"}
	if presentation != null:
		core["presentation"] = presentation
	return {"version": 2, "protocolVersion": 4, "product": product, "slug": product, "name": product, "services": {}, "core": core}


## A source over the scratch kit cache, holding `fields` as its member and (when `with_icon`) an
## icon whose PNG is already cached, bound to the kit (PKeyUiTheme.use_presentation). No transport:
## nothing is fetched.
static func present(fields: Dictionary, with_icon := true) -> PKeyPresentationSource:
	PKeyTestFixtures.remove_tree(UI_CACHE)
	DirAccess.make_dir_recursive_absolute(UI_CACHE)
	var src := PKeyPresentationSource.new()
	src.cache_dir = UI_CACHE
	src.product = "djdl"
	var ic = null
	if with_icon:
		var bytes := png(128)
		ic = icon(bytes, "image/png", [], ORIGIN, 128)
		var f := FileAccess.open(UI_CACHE.path_join(sha(bytes)), FileAccess.WRITE)
		f.store_buffer(bytes)
		f.close()
	src.accept(manifest(member(fields, ic)))
	PKeyUiTheme.use_presentation(src)
	return src
