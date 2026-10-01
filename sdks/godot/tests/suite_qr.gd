extends RefCounted
# @pkey-feature identity.devicecode
# The QR encoder (P1-07) against res://tests/qr/fixtures.json, written by
# tests/qr/gen_fixtures.py from a reference encoder (Nayuki's qrcodegen): for every case the
# module matrix equals the reference's at the same version, level M and mask: with the mask
# forced, and with the encoder choosing it by its own penalty scoring. Then PKeyQrRect: a quiet zone and nearest
# filtering. `bench` times an encode.

const FIXTURES := "res://tests/qr/fixtures.json"
const FLOOR := 15


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var f = PKeyTestFixtures.read_json(FIXTURES)
	if not t.check("fixtures present", f is Dictionary and f.get("cases") is Array, FIXTURES):
		return true
	t.info("reference: %s" % f.get("reference", "?"))
	var evaluated := 0
	var urls := 0
	for c in f["cases"]:
		var label := "%s (%d bytes, v%d, mask %d)" % [String(c["text"]).left(48), int(c["bytes"]), int(c["version"]), int(c["mask"])]
		var min_version: int = int(c["forcedVersion"]) if c["forcedVersion"] != null else 1
		# At the reference's version and mask: the matrix must be identical.
		var at := PKeyQr.encode(c["text"], min_version, int(c["mask"]))
		var ok: bool = at != null and at.version == int(c["version"]) and at.mask == int(c["mask"]) and Array(at.rows()) == c["rows"]
		t.check("matrix at the reference's version and mask: %s" % label, ok, _diff(at, c))
		# Choosing the mask itself: the same symbol (unless the case forced the reference's mask).
		if c["forcedMask"] == null:
			var auto := PKeyQr.encode(c["text"], min_version)
			t.check("mask choice matches the reference: %s" % label, auto != null and auto.mask == int(c["mask"]) and Array(auto.rows()) == c["rows"],
					"chose mask %s" % (str(auto.mask) if auto != null else "null"))
		evaluated += 1
		if String(c["text"]).begins_with("https://") and c["forcedVersion"] == null and c["forcedMask"] == null and int(c["bytes"]) <= 120:
			urls += 1
	t.check("coverage", evaluated == f["cases"].size() and evaluated >= FLOOR and urls >= 5, "%d cases, %d URLs up to 120 characters" % [evaluated, urls])

	t.check("capacity: version 1 holds 14 bytes, version 10 holds 213", PKeyQr.capacity(1) == 14 and PKeyQr.capacity(10) == 213)
	t.check("too long for version 10: null", PKeyQr.encode("x".repeat(214)) == null)
	t.check("bad arguments: null", PKeyQr.encode("x", 0) == null and PKeyQr.encode("x", 11) == null and PKeyQr.encode("x", 1, 8) == null)

	await _rect(t)
	if args.has("bench"):
		var started := Time.get_ticks_usec()
		for i in 10:
			PKeyQr.encode("https://key.plrs.im/djdl/identity/auth/device?user_code=WDJB-MJHT")
		t.info("bench: %.1f ms per encode (version 5, all eight masks scored)" % ((Time.get_ticks_usec() - started) / 10000.0))
	return true


func _rect(t: PKeyTestContext) -> void:
	var rect := PKeyQrRect.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(rect)
	rect.text = "https://key.plrs.im/djdl/identity/auth/device?user_code=WDJB-MJHT"
	var code := rect.code
	if not t.check("rect: encodes its text", code != null and rect.texture != null and not rect.encode_failed):
		rect.queue_free()
		return
	var img := rect.texture.get_image()
	var n := code.size + 8
	t.check("rect: one texel per module plus a four-module quiet zone on every side", img.get_width() == n and img.get_height() == n, "%dx%d for a %d-module symbol" % [img.get_width(), img.get_height(), code.size])
	var light := true
	for i in n:
		for q in 4:
			for p in [img.get_pixel(i, q), img.get_pixel(i, n - 1 - q), img.get_pixel(q, i), img.get_pixel(n - 1 - q, i)]:
				light = light and p.is_equal_approx(Color.WHITE)
	t.check("rect: the quiet zone is all light", light)
	var same := true
	for y in code.size:
		for x in code.size:
			same = same and img.get_pixel(x + 4, y + 4).is_equal_approx(Color.BLACK if code.is_dark(x, y) else Color.WHITE)
	t.check("rect: the texels are the modules", same)
	t.check("rect: nearest filtering, square and centred, any size", rect.texture_filter == CanvasItem.TEXTURE_FILTER_NEAREST \
			and rect.stretch_mode == TextureRect.STRETCH_KEEP_ASPECT_CENTERED and rect.expand_mode == TextureRect.EXPAND_IGNORE_SIZE)
	rect.quiet_zone = 2
	t.check("rect: the quiet zone never drops below four modules", rect.quiet_zone == 4 and rect.texture.get_width() == n)
	var th := Theme.new()
	th.set_color("dark", "PKeyQrRect", Color(0.1, 0.1, 0.3))
	th.set_color("light", "PKeyQrRect", Color(0.95, 0.95, 0.9))
	rect.theme = th
	await PKeyTestFixtures.frames(2)
	var tex_img := rect.texture.get_image()
	t.check("rect: theme colours", rect.colors() == [Color(0.1, 0.1, 0.3), Color(0.95, 0.95, 0.9)] and _near(tex_img.get_pixel(0, 0), Color(0.95, 0.95, 0.9)) and _near(tex_img.get_pixel(4, 4), Color(0.1, 0.1, 0.3)), str(rect.colors()))
	rect.text = "x".repeat(300)
	t.check("rect: text too long renders nothing and says so", rect.encode_failed and rect.texture == null and rect.code == null)
	rect.queue_free()


## Colours equal within 8-bit quantisation.
static func _near(a: Color, b: Color) -> bool:
	return absf(a.r - b.r) < 0.01 and absf(a.g - b.g) < 0.01 and absf(a.b - b.b) < 0.01 and absf(a.a - b.a) < 0.01


static func _diff(code: PKeyQrCode, c: Dictionary) -> String:
	if code == null:
		return "encode returned null"
	if code.version != int(c["version"]) or code.mask != int(c["mask"]):
		return "got v%d mask %d" % [code.version, code.mask]
	var rows := code.rows()
	for y in rows.size():
		if y >= c["rows"].size() or rows[y] != c["rows"][y]:
			return "first difference at row %d:\n  got %s\n  ref %s" % [y, rows[y], c["rows"][y] if y < c["rows"].size() else "-"]
	return ""
