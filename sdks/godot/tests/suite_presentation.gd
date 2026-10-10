extends RefCounted
# @pkey-feature core.presentation
# Product presentation (core.presentation, WIRE-CONTRACT-V4 §5.5, plans/HA-14.md §6):
#
#   matrix     PKeyPresentationRules over the generator-owned mirror
#              res://tests/corpus/v2/presentation-matrix.json: every parseCases row deep-equal,
#              every pickCases row with its own `decodable` (and the rows whose set is Godot's
#              again with PKeyPresentationRules.DECODABLE), every verifyCases row
#   strings    a Godot String holds no U+0000 and no lone surrogate (the engine substitutes
#              U+FFFD), pinned; the text rule's controls and bidi
#   decode     magic bytes and header dimensions read before any decode: a dimension or 16 MP
#              budget bomb never reaches Image.load_* (PKeyPresentationSource.decodes, a work
#              counter); PNG, JPEG and WebP (VP8, VP8L, VP8X) decode on this engine
#   transport  `follow_redirects = false` hands a 3xx back as its status and makes one request
#   fetch      against PKeyFakeServer: no Authorization and no X-PKey-* header; 3xx (any of five,
#              no second request), non-200, over the cap, wrong hash, wrong type and a header bomb
#              are misses that cache nothing; the right hash is shown and cached; local-only never
#              dials; an AVIF original with no sizes is no icon (no request); one fetch for
#              concurrent callers; the safe-link rule
#   cache      prune to PRESENTATION_CACHE_MAX_FILES, files the member stops naming go, a tampered
#              file is deleted (and fetched again), cold boot from presentation.json, a corrupt,
#              tampered or other product's presentation.json is dropped
#   hook       PolarisKey.discover() feeds the source: `changed` only when the member differs, a
#              document without one clears it, a failed discovery keeps it; the autoload's
#              presentation() and presentation_icon() forward; the kit is bound at configure()

const MATRIX := "res://tests/corpus/v2/presentation-matrix.json"
const F := preload("res://tests/support/presentation_fixtures.gd")
const NOW := 1700000000.0

var _routes := {}
var _server: PKeyFakeServer
var _host: Node


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_matrix(t)
	_strings(t)
	_decode(t)
	_server = PKeyTestFixtures.new_server(_serve)
	_host = Node.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(_host)
	await PKeyTestFixtures.frames(2)
	await _transport(t)
	await _fetch(t)
	await _cache(t)
	await _hook(t)
	_host.queue_free()
	_server.queue_free()
	PKeyUiTheme.use_presentation(null)
	return true


func _serve(req: Dictionary) -> Dictionary:
	var path: String = req["path"]
	if _routes.has(path):
		var r = _routes[path]
		return r.call(req) if r is Callable else r
	return {"status": 404}


static func _same(a: Variant, b: Variant) -> bool:
	return PKeyPresentationSource.same(a, b)


# ── The matrix ───────────────────────────────────────────────────────────────────────────

func _matrix(t: PKeyTestContext) -> void:
	var m = PKeyTestFixtures.read_json(MATRIX)
	if not t.check("matrix: present at %s" % MATRIX, m is Dictionary and _same(m.get("presentationMatrixVersion"), PKeyConstants.PRESENTATION_MATRIX_VERSION)):
		return
	var parse_cases: Array = m["parseCases"]
	var parsed := 0
	var ints := true
	for c in parse_cases:
		var got = PKeyPresentationRules.parse(c.get("core"), c.get("doc", {}))
		if t.check("parse: %s" % c["name"], _same(got, c["expect"]), "got %s, want %s" % [JSON.stringify(got), JSON.stringify(c["expect"])]):
			parsed += 1
		ints = ints and _ints_are_ints(got)
	t.check("parse: integer fields are ints (width, height, w)", ints)
	t.check("parse: coverage", parsed == parse_cases.size() and parsed >= 100, "%d/%d" % [parsed, parse_cases.size()])

	var pick_cases: Array = m["pickCases"]
	var picked := 0
	var godot_rows := 0
	for c in pick_cases:
		var got := PKeyPresentationRules.pick_icon_size(c["icon"], float(c["px"]), float(c["scale"]), c["decodable"])
		if t.check("pick: %s" % c["name"], _same(got, c["expect"]), "got %s, want %s" % [JSON.stringify(got), JSON.stringify(c["expect"])]):
			picked += 1
		if _same_set(c["decodable"], PKeyPresentationRules.DECODABLE):
			godot_rows += 1
			var mine := PKeyPresentationRules.pick_icon_size(c["icon"], float(c["px"]), float(c["scale"]), PKeyPresentationSource.new().decodable)
			t.check("pick (Godot's decodable set): %s" % c["name"], _same(mine, c["expect"]), JSON.stringify(mine))
	t.check("pick: coverage", picked == pick_cases.size() and picked >= 30, "%d/%d" % [picked, pick_cases.size()])
	t.check("pick: the Godot-decodable rows ran", godot_rows >= 4, "%d rows" % godot_rows)
	t.check("decodable: Godot's set is png, jpeg and webp", _same_set(PKeyPresentationRules.DECODABLE, ["image/png", "image/jpeg", "image/webp"]))

	var verify_cases: Array = m["verifyCases"]
	var verified := 0
	for c in verify_cases:
		var bytes := Marshalls.base64_to_raw(c["bytes"]) if String(c["bytes"]) != "" else PackedByteArray()
		if t.check("verify: %s" % c["name"], PKeyPresentationRules.icon_matches(bytes, c["sha256"]) == c["expect"]):
			verified += 1
	t.check("verify: coverage", verified == verify_cases.size() and verified >= 6, "%d/%d" % [verified, verify_cases.size()])


static func _ints_are_ints(m: Variant) -> bool:
	if not (m is Dictionary) or not (m.get("icon") is Dictionary):
		return true
	var ic: Dictionary = m["icon"]
	for k in ["width", "height"]:
		if ic.has(k) and typeof(ic[k]) != TYPE_INT:
			return false
	for s in ic["sizes"]:
		if typeof(s["w"]) != TYPE_INT:
			return false
	return true


static func _same_set(a: Array, b: Array) -> bool:
	if a.size() != b.size():
		return false
	for x in a:
		if not b.has(x):
			return false
	return true


# ── Strings ──────────────────────────────────────────────────────────────────────────────

func _strings(t: PKeyTestContext) -> void:
	# A Godot String cannot carry U+0000 or a lone surrogate (plans/HA-14.md §4): the engine
	# substitutes U+FFFD (4.4 drops a NUL from chr() altogether), so the text rule never sees one.
	var nul := String.chr(0)
	t.check("strings: String.chr(0) holds no U+0000", not _has_code(nul, 0) and (nul == "" or nul == String.chr(0xfffd)), str(_codes(nul)))
	t.check("strings: String.chr(0xD800) holds no lone surrogate (U+FFFD)", _codes(String.chr(0xd800)) == [0xfffd])
	t.check("strings: String.chr(0xDC00) holds no lone surrogate (U+FFFD)", _codes(String.chr(0xdc00)) == [0xfffd])
	var j := PKeyJson.parse("{\"name\":\"a\\u0000b\"}")
	t.check("strings: a JSON \\u0000 escape reads as U+FFFD (wire V4 §10)", j["ok"] and _codes(String(j["value"]["name"])) == [0x61, 0xfffd, 0x62])
	t.check("strings: a lone-surrogate escape refuses the document (strict JSON)", not PKeyJson.parse("{\"name\":\"a\\ud800b\"}")["ok"])
	t.check("strings: a surrogate pair is one code point", PKeyJson.parse("\"\\ud83d\\ude00\"")["value"] == String.chr(0x1f600))
	t.check("text rule: U+FFFD is text", PKeyPresentationRules.text("a" + String.chr(0xfffd)) != null)
	t.check("text rule: tab, DEL and a C1 control are refused", PKeyPresentationRules.text("a\tb") == null and PKeyPresentationRules.text("a" + String.chr(0x7f)) == null and PKeyPresentationRules.text("a" + String.chr(0x85)) == null)
	var bidi := String.chr(0x202e) + "abc" + String.chr(0x2066)
	t.check("text rule: bidi controls are kept", PKeyPresentationRules.text(bidi) == bidi)
	t.check("text rule: 1024 astral bytes pass, 1028 do not", PKeyPresentationRules.text(String.chr(0x1f600).repeat(256)) != null and PKeyPresentationRules.text(String.chr(0x1f600).repeat(257)) == null)
	t.check("kit: isolate wraps in FSI and PDI", PKeyUiTheme.isolate("ab") == String.chr(0x2068) + "ab" + String.chr(0x2069) and PKeyUiTheme.isolate("") == "")


static func _codes(s: String) -> Array:
	var out: Array = []
	for i in s.length():
		out.append(s.unicode_at(i))
	return out


static func _has_code(s: String, code: int) -> bool:
	return _codes(s).has(code)


# ── Decode ───────────────────────────────────────────────────────────────────────────────

func _decode(t: PKeyTestContext) -> void:
	var rgba := F.icon_image(8)
	var rgb := F.icon_image(8)
	rgb.convert(Image.FORMAT_RGB8)
	var png := rgba.save_png_to_buffer()
	var jpg := rgb.save_jpg_to_buffer()
	var lossless := rgba.save_webp_to_buffer(false)
	var lossy := rgb.save_webp_to_buffer(true, 0.8)
	var lossy_alpha := rgba.save_webp_to_buffer(true, 0.8)
	var cases := [["png", png, "image/png"], ["jpeg", jpg, "image/jpeg"], ["webp lossless (VP8L)", lossless, "image/webp"], ["webp lossy (VP8)", lossy, "image/webp"], ["webp lossy with alpha (VP8X)", lossy_alpha, "image/webp"]]
	for c in cases:
		var head := PKeyPresentationSource.inspect(c[1])
		t.check("header: %s reads %s 8x8" % [c[0], c[2]], head.get("type") == c[2] and head.get("width") == 8 and head.get("height") == 8, str(head))
		var tex := PKeyPresentationSource.decode(c[1], c[2])
		t.check("decode: %s on this engine" % c[0], tex != null and tex.get_width() == 8 and tex.get_height() == 8 and tex.get_image().has_mipmaps())
	t.check("header: the three WebP chunk kinds were all exercised", PackedStringArray([_fourcc(lossless), _fourcc(lossy), _fourcc(lossy_alpha)]) == PackedStringArray(["VP8L", "VP8 ", "VP8X"]), "%s %s %s" % [_fourcc(lossless), _fourcc(lossy), _fourcc(lossy_alpha)])

	var before := PKeyPresentationSource.decodes
	t.check("decode: bytes that are not the expected type are refused", PKeyPresentationSource.decode(png, "image/webp") == null and PKeyPresentationSource.decode(lossless, "image/png") == null)
	t.check("decode: a GIF or AVIF is not decoded here", PKeyPresentationSource.decode(png, "image/gif") == null and PKeyPresentationSource.decode(png, "image/avif") == null)
	t.check("decode: a header cut short is refused", PKeyPresentationSource.decode(png.slice(0, 20), "image/png") == null and PKeyPresentationSource.decode(jpg.slice(0, 3), "image/jpeg") == null)
	# Bombs: a header over a side's limit, or within it but over the 16 MP budget.
	var side_bomb := _png_dims(png, 20000, 8)
	var budget_bomb := _png_dims(png, 8000, 8000)
	t.check("bomb: a PNG header of 20000 px a side is refused", PKeyPresentationSource.inspect(side_bomb)["width"] == 20000 and PKeyPresentationSource.decode(side_bomb, "image/png") == null)
	t.check("bomb: a PNG header of 8000x8000 (64 MP) is over the budget", PKeyPresentationSource.decode(budget_bomb, "image/png") == null)
	var vp8x := _vp8x(16384, 16384)
	t.check("bomb: a WebP VP8X canvas of 16384x16384 is over the budget", PKeyPresentationSource.inspect(vp8x)["width"] == 16384 and PKeyPresentationSource.decode(vp8x, "image/webp") == null)
	var jpeg_bomb := _jpeg_dims(jpg, 0xffff, 0xffff)
	t.check("bomb: a JPEG SOF of 65535x65535 is refused", PKeyPresentationSource.inspect(jpeg_bomb)["height"] == 0xffff and PKeyPresentationSource.decode(jpeg_bomb, "image/jpeg") == null)
	t.check("bomb: no refused header reached Image.load_*", PKeyPresentationSource.decodes == before, "%d decodes" % (PKeyPresentationSource.decodes - before))
	t.check("budget: 4096x4096 is exactly 16 MP and allowed; one more row is not", PKeyPresentationSource.within_budget(4096, 4096) and not PKeyPresentationSource.within_budget(4096, 4097))
	t.check("budget: a side is 1 to PRESENTATION_ICON_MAX_DIMENSION", not PKeyPresentationSource.within_budget(0, 1) and not PKeyPresentationSource.within_budget(PKeyConstants.PRESENTATION_ICON_MAX_DIMENSION + 1, 1) and PKeyPresentationSource.within_budget(PKeyConstants.PRESENTATION_ICON_MAX_DIMENSION, 1))
	t.check("budget: 16 MP is the local decode budget", PKeyPresentationSource.DECODE_BUDGET_PIXELS == 16 * 1024 * 1024)


static func _fourcc(webp: PackedByteArray) -> String:
	return webp.slice(12, 16).get_string_from_ascii()


static func _png_dims(png: PackedByteArray, w: int, h: int) -> PackedByteArray:
	var b := png.duplicate()
	for i in 4:
		b[16 + i] = (w >> (24 - 8 * i)) & 0xff
		b[20 + i] = (h >> (24 - 8 * i)) & 0xff
	return b


static func _vp8x(w: int, h: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.append_array("RIFF".to_ascii_buffer())
	b.append_array(PackedByteArray([22, 0, 0, 0]))
	b.append_array("WEBPVP8X".to_ascii_buffer())
	b.append_array(PackedByteArray([10, 0, 0, 0, 0, 0, 0, 0]))
	for v in [w - 1, h - 1]:
		b.append_array(PackedByteArray([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]))
	return b


## `jpg` with its first frame header's dimensions replaced.
static func _jpeg_dims(jpg: PackedByteArray, w: int, h: int) -> PackedByteArray:
	var b := jpg.duplicate()
	var i := 2
	while i + 8 < b.size():
		var marker := b[i + 1]
		if marker >= 0xc0 and marker <= 0xcf and marker != 0xc4 and marker != 0xc8 and marker != 0xcc:
			b[i + 5] = (h >> 8) & 0xff
			b[i + 6] = h & 0xff
			b[i + 7] = (w >> 8) & 0xff
			b[i + 8] = w & 0xff
			return b
		i += 2 + ((b[i + 2] << 8) | b[i + 3])
	return b


# ── The transport option ─────────────────────────────────────────────────────────────────

func _transport(t: PKeyTestContext) -> void:
	_routes["/hop"] = {"status": 302, "headers": {"Location": "/landed"}}
	_routes["/landed"] = {"status": 200, "body": "landed"}
	var tr := PKeyTransport.new(_host)
	tr.timeout = 10.0
	t.check("transport: follows redirects by default", tr.follow_redirects)
	var before := _server.requests.size()
	var r := await tr.request("GET", _server.base_url() + "/hop")
	t.check("transport: by default a 3xx is followed", r.ok and r.detail["status"] == 200 and _server.requests.size() == before + 2, str(r))
	tr.follow_redirects = false
	before = _server.requests.size()
	r = await tr.request("GET", _server.base_url() + "/hop")
	t.check("transport: follow_redirects = false hands the 3xx back as its status", r.ok and r.detail["status"] == 302 and not r.detail.has("redirect") and (r.detail["body"] as PackedByteArray).is_empty(), str(r))
	t.check("transport: follow_redirects = false makes one request", _server.requests.size() == before + 1)


# ── Fetch ────────────────────────────────────────────────────────────────────────────────

## A source attached to a Core for `base`, over a fresh scratch cache.
func _source(local_only := false) -> PKeyPresentationSource:
	var opts := PKeyTestFixtures.options(_server.base_url(), PKeyMemoryStore.new(), [NOW])
	opts.local_only = local_only
	var core: PKeyCore = PKeyCore.create(opts, _host, "0.1.0").detail
	var src := PKeyPresentationSource.new()
	src.cache_dir = PKeyTestFixtures.scratch_dir("presentation")
	src.attach(core, _host)
	return src


func _path(url: String) -> String:
	return url.substr(_server.base_url().length())


func _fetch(t: PKeyTestContext) -> void:
	var src := _source()
	t.check("fetch: the icon transport is its own, with the wire's limits", src.transport != null and is_equal_approx(src.transport.timeout, float(PKeyConstants.PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS)) and src.transport.body_limit == PKeyConstants.PRESENTATION_ICON_MAX_BYTES and not src.transport.follow_redirects and not src.transport.local_only)
	t.check("fetch: a 3xx is refused on this runtime (web: the typed N/A)", PKeyPresentationSource.redirect_rule().ok if not OS.has_feature("web") else String(PKeyPresentationSource.redirect_rule().detail["reason"]) == PKeyConstants.UnsupportedReason.RUNTIME, str(PKeyPresentationSource.redirect_rule()))
	t.check("fetch: nothing before a member", await src.icon(64) == null and src.current().is_empty())

	# The right hash: shown and cached, and the request carries no credential.
	var png := F.png(32)
	var ic := F.icon(png, "image/png", [], _server.base_url(), 32)
	_routes[_path(ic["original"])] = {"status": 200, "body": png, "headers": {"Content-Type": "image/png"}}
	src.accept(F.manifest(F.member(F.DRIFT_KART, ic)))
	var before := _server.requests.size()
	var tex := await src.icon(64)
	var req: Dictionary = _server.requests.back()
	t.check("fetch: the right hash is shown", tex != null and tex.get_width() == 32, str(tex))
	t.check("fetch: the right hash is cached under its sha", FileAccess.get_file_as_bytes(src.cache_dir.path_join(ic["sha256"])) == png)
	t.check("fetch: one GET to the original", _server.requests.size() == before + 1 and req["method"] == "GET" and req["path"] == _path(ic["original"]))
	var credentials: Array = req["headers"].keys().filter(func(k): return k == "authorization" or String(k).begins_with("x-pkey-") or k == "cookie")
	t.check("fetch: no Authorization, no cookie and no X-PKey-* header", credentials.is_empty(), str(req["headers"]))
	before = _server.requests.size()
	t.check("fetch: the texture is kept in memory (no second request)", await src.icon(64) == tex and _server.requests.size() == before)

	# The ladder: a WebP size at the URL's {w}, the smallest that covers px × scale.
	var sizes := [[64, F.webp(16, Color("#3d9bff"))], [128, F.webp(24, Color("#3dff9b"))]]
	ic = F.icon(F.png(48), "image/png", sizes, _server.base_url(), 48)
	for s in sizes:
		_routes[_path(String(ic["url"]).replace("{w}", str(s[0])))] = {"status": 200, "body": s[1]}
	src.accept(F.manifest(F.member(F.DRIFT_KART, ic)))
	before = _server.requests.size()
	tex = await src.icon(48, 2.0)
	t.check("fetch: 48 pt at 2x takes the 128 px WebP", tex != null and tex.get_width() == 24 and _server.requests.back()["path"].ends_with("/128.webp"), str(_server.requests.back()["path"]))
	# Concurrent callers share one fetch.
	var got: Array = []
	before = _server.requests.size()
	src.icon_to(32, 1.0, func(x): got.append(x))
	src.icon_to(32, 1.0, func(x): got.append(x))
	await _until(func(): return got.size() == 2)
	t.check("fetch: two callers at once make one request", got.size() == 2 and got[0] != null and got[0] == got[1] and _server.requests.size() == before + 1, "%d requests" % (_server.requests.size() - before))

	# Misses: each caches nothing.
	var fails := [
		["a 301", {"status": 301}],
		["a 302", {"status": 302}],
		["a 303", {"status": 303}],
		["a 307", {"status": 307}],
		["a 308", {"status": 308}],
		["a 404", {"status": 404}],
		["a 500", {"status": 500}],
		["a 204", {"status": 204}],
		["a 206 carrying the icon's own bytes", {"status": 206, "body": "@icon"}],
		["a 404 carrying the icon's own bytes", {"status": 404, "body": "@icon"}],
		["the wrong bytes", {"status": 200, "body": F.png(9)}],
	]
	for k in fails.size():
		var f: Array = fails[k]
		var bytes := F.png(10, Color(0.1 * k, 0.4, 0.6))
		var one := F.icon(bytes, "image/png", [], _server.base_url(), 10)
		var answer: Dictionary = f[1].duplicate()
		if answer.get("body") is String and answer["body"] == "@icon":
			# Bytes that verify: only the status refuses them.
			answer["body"] = bytes
		if answer["status"] >= 300 and answer["status"] < 400:
			# The redirect leads to the right bytes: following it would show them.
			var elsewhere := "/elsewhere/%s" % one["sha256"]
			_routes[elsewhere] = {"status": 200, "body": bytes}
			answer["headers"] = {"Location": _server.base_url() + elsewhere}
		_routes[_path(one["original"])] = answer
		src.accept(F.manifest(F.member(F.DRIFT_KART, one)))
		before = _server.requests.size()
		tex = await src.icon(10)
		var cached := FileAccess.file_exists(src.cache_dir.path_join(one["sha256"]))
		var label: String = f[0]
		if label.begins_with("a 3") and OS.has_feature("web"):
			t.check("fetch: %s — N/A on web (runtime): the browser follows it; the hash gates the bytes" % label, not PKeyPresentationSource.redirect_rule().ok)
			continue
		t.check("fetch: %s is a miss, cached nowhere" % label, tex == null and not cached)
		t.check("fetch: %s makes one request (no retry, no hop)" % label, _server.requests.size() == before + 1, "%d requests" % (_server.requests.size() - before))

	# Over the cap: PRESENTATION_ICON_MAX_BYTES + 1, the body hash matching (only the cap refuses it).
	var big := PackedByteArray()
	big.resize(PKeyConstants.PRESENTATION_ICON_MAX_BYTES + 1)
	var huge := F.icon(big, "image/png", [], _server.base_url())
	_routes[_path(huge["original"])] = {"status": 200, "body": big}
	src.accept(F.manifest(F.member(F.DRIFT_KART, huge)))
	var t0 := Time.get_ticks_msec()
	tex = await src.icon(64)
	t.check("fetch: a body over PRESENTATION_ICON_MAX_BYTES is a miss", tex == null and not FileAccess.file_exists(src.cache_dir.path_join(huge["sha256"])))
	t.info("fetch: the over-cap body was refused after %d ms" % (Time.get_ticks_msec() - t0))

	# Verified bytes of the wrong type, and a decode bomb whose hash matches.
	var not_webp := F.png(12)
	var typed := F.icon(F.png(40), "image/png", [[64, not_webp]], _server.base_url(), 40)
	_routes[_path(String(typed["url"]).replace("{w}", "64"))] = {"status": 200, "body": not_webp}
	src.accept(F.manifest(F.member(F.DRIFT_KART, typed)))
	var decodes := PKeyPresentationSource.decodes
	t.check("fetch: a PNG served for a WebP size is refused", await src.icon(32) == null and not FileAccess.file_exists(src.cache_dir.path_join(F.sha(not_webp))) and PKeyPresentationSource.decodes == decodes)
	var bomb := _png_dims(F.png(8), 8000, 8000)
	var bombed := F.icon(bomb, "image/png", [], _server.base_url())
	_routes[_path(bombed["original"])] = {"status": 200, "body": bomb}
	src.accept(F.manifest(F.member(F.DRIFT_KART, bombed)))
	t.check("fetch: a header-dimension bomb is refused before decode, cached nowhere", await src.icon(64) == null and PKeyPresentationSource.decodes == decodes and not FileAccess.file_exists(src.cache_dir.path_join(bombed["sha256"])))

	# Nothing to fetch: an AVIF (or GIF) original with no sizes is the monogram.
	for ctype in ["image/avif", "image/gif"]:
		var raw := F.png(6)
		var odd := F.icon(raw, ctype, [], _server.base_url())
		_routes[_path(odd["original"])] = {"status": 200, "body": raw}
		src.accept(F.manifest(F.member(F.DRIFT_KART, odd)))
		before = _server.requests.size()
		t.check("fetch: a %s original with no sizes is no icon, and no request" % ctype, await src.icon(64) == null and _server.requests.size() == before)

	# The host freed with a fetch in flight: a miss, never a script error (the kit fetches without
	# waiting, and a game may change scenes meanwhile).
	var gone_host := Node.new()
	_host.add_child(gone_host)
	var gone := _source()
	gone.transport.host = gone_host
	var gp := F.png(15)
	var gic := F.icon(gp, "image/png", [], _server.base_url())
	_routes[_path(gic["original"])] = {"hang": true}
	gone.accept(F.manifest(F.member(F.DRIFT_KART, gic)))
	var answers: Array = []
	gone.icon_to(64, 1.0, func(x): answers.append(x))
	await PKeyTestFixtures.frames(3)
	gone_host.free()
	await _until(func(): return answers.size() == 1)
	t.check("fetch: a host freed mid-fetch is a miss", answers == [null], str(answers))
	var direct := PKeyTransport.new(Node.new())
	_host.add_child(direct.host)
	var pending := {"r": null}
	(func(): pending["r"] = await direct.request("GET", _server.base_url() + _path(gic["original"]))).call()
	await PKeyTestFixtures.frames(3)
	direct.host.free()
	await _until(func(): return pending["r"] != null)
	t.check("transport: a host freed mid-request is a network failure", pending["r"] != null and not pending["r"].ok and pending["r"].code == PKeyErrors.NETWORK, str(pending["r"]))

	# Local-only never dials.
	var local := _source(true)
	var lp := F.png(14)
	var lic := F.icon(lp, "image/png", [], _server.base_url())
	_routes[_path(lic["original"])] = {"status": 200, "body": lp}
	local.accept(F.manifest(F.member(F.DRIFT_KART, lic)))
	before = _server.requests.size()
	t.check("fetch: local-only refuses at the dial", local.transport.local_only and await local.icon(64) == null and _server.requests.size() == before)

	# The safe-link rule (defence in depth: the parser already keeps `url` on the original's origin).
	var links := [
		["https://img.plrs.im/djdl/a/x/64.webp", "https://img.plrs.im/djdl/a/x", true],
		["https://IMG.plrs.im/djdl/a/x", "https://img.plrs.im/djdl/a/x", true],
		["https://img.plrs.im.evil.example/x", "https://img.plrs.im/x", false],
		["https://evil.example/x", "https://img.plrs.im/x", false],
		["http://img.plrs.im/x", "http://img.plrs.im/y", false],
		["https://img.plrs.im:8443/x", "https://img.plrs.im/x", false],
		["http://127.0.0.1:9000/x", "http://127.0.0.1:9000/y", true],
		["http://127.0.0.1:9001/x", "http://127.0.0.1:9000/y", false],
		["https://u@img.plrs.im/x", "https://img.plrs.im/x", false],
		["ftp://img.plrs.im/x", "ftp://img.plrs.im/x", false],
	]
	for l in links:
		t.check("safe link: %s from %s is %s" % [l[0], l[1], "fetched" if l[2] else "refused"], PKeyPresentationRules.safe_fetch_url(l[0], l[1]) == l[2])


func _until(cond: Callable, max_frames := 600) -> void:
	for i in max_frames:
		if cond.call():
			return
		await PKeyTestFixtures.frames(1)


# ── Cache ────────────────────────────────────────────────────────────────────────────────

func _cache(t: PKeyTestContext) -> void:
	# Six sizes fetched one after another: never more than four icon files on disk.
	var src := _source()
	var ladder: Array = []
	var colours := ["#ff6a3d", "#3d9bff", "#3dff9b", "#ff3d9b", "#9b3dff", "#ffd23d"]
	for i in 6:
		ladder.append([32 << i, F.webp(4 + i, Color(colours[i]))])
	var ic := F.icon(F.png(64), "image/png", ladder, _server.base_url(), 64)
	for s in ladder:
		_routes[_path(String(ic["url"]).replace("{w}", str(s[0])))] = {"status": 200, "body": s[1]}
	src.accept(F.manifest(F.member(F.DRIFT_KART, ic)))
	var most := 0
	var shown := 0
	for s in ladder:
		if await src.icon(float(s[0])) != null:
			shown += 1
		most = maxi(most, src.cached_files().size())
	t.check("cache: six sizes fetched", shown == 6)
	t.check("cache: never more than PRESENTATION_CACHE_MAX_FILES icon files", most <= PKeyConstants.PRESENTATION_CACHE_MAX_FILES and most == 4, "%d at most" % most)
	src.accept(F.manifest(F.member(F.DRIFT_KART, ic)))
	var named := PKeyPresentationSource.named(src.current())
	t.check("cache: after a discovery, at most four, all named", src.cached_files().size() <= 4 and Array(src.cached_files()).all(func(f): return named.has(f)), str(src.cached_files()))
	var other := F.icon(F.png(20), "image/png", [], _server.base_url())
	src.accept(F.manifest(F.member(F.DRIFT_KART, other)))
	t.check("cache: files the member no longer names are removed", src.cached_files().is_empty(), str(src.cached_files()))
	src.accept(F.manifest(null))
	t.check("cache: no member, no presentation.json", not FileAccess.file_exists(src.cache_dir.path_join(PKeyPresentationSource.MEMBER_FILE)))

	# A tampered icon file is deleted when read, and fetched again.
	var bytes := F.png(18)
	ic = F.icon(bytes, "image/png", [], _server.base_url(), 18)
	_routes[_path(ic["original"])] = {"status": 200, "body": bytes}
	src.accept(F.manifest(F.member(F.DRIFT_KART, ic)))
	await src.icon(64)
	var file := src.cache_dir.path_join(ic["sha256"])
	var f := FileAccess.open(file, FileAccess.WRITE)
	f.store_buffer(F.png(19))
	f.close()
	_routes[_path(ic["original"])] = {"status": 404}
	var fresh := _source()
	fresh.cache_dir = src.cache_dir
	fresh.load_cached()
	t.check("cache: a tampered icon file is deleted on read (and not shown)", await fresh.icon(64) == null and not FileAccess.file_exists(file))
	_routes[_path(ic["original"])] = {"status": 200, "body": bytes}
	var again := _source()
	again.cache_dir = src.cache_dir
	again.load_cached()
	t.check("cache: then fetched and cached again", await again.icon(64) != null and FileAccess.get_file_as_bytes(file) == bytes)

	# Cold boot: the member and the icon from disk, with the network gone.
	_routes[_path(ic["original"])] = {"status": 500}
	var cold := _source()
	cold.cache_dir = src.cache_dir
	var events: Array = []
	cold.changed.connect(func(m): events.append(m))
	cold.load_cached()
	t.check("cold boot: presentation.json is the last member", _same(cold.current(), src.current()) and events.size() == 1, JSON.stringify(cold.current()))
	var before := _server.requests.size()
	t.check("cold boot: the icon comes from the cache, offline", await cold.icon(64) != null and _server.requests.size() == before)
	cold.accept(F.manifest(F.member({"name": "Renamed"}, null)))
	cold.load_cached()
	t.check("cold boot: never overrides this session's discovery", cold.current()["name"] == "Renamed")

	# presentation.json that is not this SDK's own normal form is dropped.
	var bad := [
		["corrupt", "{not json"],
		["tampered (an accent not in its normal form)", JSON.stringify({"v": 1, "product": "djdl", "presentation": {"name": "X", "accent": "#FFFFFF"}})],
		["tampered (a field the parser drops)", JSON.stringify({"v": 1, "product": "djdl", "presentation": {"name": "X", "extra": true}})],
		["another product's", JSON.stringify({"v": 1, "product": "other", "presentation": {"name": "X"}})],
		["another version", JSON.stringify({"v": 2, "product": "djdl", "presentation": {"name": "X"}})],
		["a duplicate key", "{\"v\":1,\"product\":\"djdl\",\"presentation\":{\"name\":\"X\",\"name\":\"Y\"}}"],
	]
	for b in bad:
		var dir := PKeyTestFixtures.scratch_dir("presentation-bad")
		var w := FileAccess.open(dir.path_join(PKeyPresentationSource.MEMBER_FILE), FileAccess.WRITE)
		w.store_string(b[1])
		w.close()
		var s := _source()
		s.cache_dir = dir
		s.load_cached()
		t.check("cold boot: a %s presentation.json is dropped" % b[0], s.current().is_empty() and not FileAccess.file_exists(dir.path_join(PKeyPresentationSource.MEMBER_FILE)))
	var good := PKeyTestFixtures.scratch_dir("presentation-good")
	var gw := FileAccess.open(good.path_join(PKeyPresentationSource.MEMBER_FILE), FileAccess.WRITE)
	gw.store_string(JSON.stringify({"v": 1, "product": "djdl", "presentation": {"name": "X", "accent": "#ffffff"}}))
	gw.close()
	var gs := _source()
	gs.cache_dir = good
	gs.load_cached()
	t.check("cold boot: the normal form reads back", gs.current() == {"name": "X", "accent": "#ffffff"}, JSON.stringify(gs.current()))


# ── The discovery hook, the autoload, the kit binding ──────────────────────────────────────

func _hook(t: PKeyTestContext) -> void:
	var doc := {"value": F.manifest(null)}
	_routes["/djdl/.well-known/polaris.json"] = func(_req): return doc["value"] if doc["value"] is Dictionary and doc["value"].has("status") else {"status": 200, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify(doc["value"])}
	var sdk := PKeyTestFixtures.new_sdk()
	var src: PKeyPresentationSource = sdk.presentation_source
	src.cache_dir = PKeyTestFixtures.scratch_dir("presentation-hook")
	var events: Array = []
	# Connected before configure(): it survives it.
	src.changed.connect(func(m): events.append(m))
	t.check("hook: presentation() is {} before configure()", sdk.presentation().is_empty())
	var cr: PKeyResult = sdk.configure(PKeyTestFixtures.options(_server.base_url(), PKeyMemoryStore.new(), [NOW]))
	await sdk.start()
	t.check("hook: configure() binds the kit to the source", cr.ok and PKeyUiTheme.presentation == src and sdk.core.presentation_source == src)

	var bytes := F.png(22)
	var ic := F.icon(bytes, "image/png", [], _server.base_url(), 22)
	_routes[_path(ic["original"])] = {"status": 200, "body": bytes}
	var drift := F.member(F.DRIFT_KART, ic)
	drift["accent"] = "#FF6A3D"
	drift["accentDark"] = "#5EE6F0"
	doc["value"] = F.manifest(drift)
	var r: PKeyResult = await sdk.discover()
	var want := {"name": "Drift Kart", "developerName": "Lanternworks", "accent": "#ff6a3d", "accentDark": "#5ee6f0", "icon": PKeyPresentationRules.icon(ic)}
	t.check("hook: a discovery with a member: presentation() is it, normalised", r.ok and _same(sdk.presentation(), want), JSON.stringify(sdk.presentation()))
	t.check("hook: changed fired once, with the member", events.size() == 1 and _same(events[0], want))
	t.check("hook: the kit took the name and both accents", PKeyUiTheme.presentation_name == "Drift Kart" and PKeyUiTheme.presentation_accent == "#ff6a3d" and PKeyUiTheme.presentation_accent_dark == "#5ee6f0" and PKeyUiTheme.presentation_icon_sha == ic["sha256"])
	var tex: ImageTexture = await sdk.presentation_icon(64)
	t.check("hook: presentation_icon() is the verified icon", tex != null and tex.get_width() == 22)
	await _until(func(): return PKeyUiTheme.presentation_icon != null)
	t.check("hook: the kit's identity icon is the fetched one", PKeyUiTheme.product_identity()["icon"] != null and PKeyUiTheme.presentation_icon != null)

	r = await sdk.discover()
	t.check("hook: the same member again fires nothing", r.ok and events.size() == 1)
	doc["value"] = {"status": 500}
	r = await sdk.discover()
	t.check("hook: a failed discovery keeps the member", not r.ok and _same(sdk.presentation(), want) and events.size() == 1)
	var invalid := F.manifest(null)
	invalid["core"]["presentation"] = "Drift Kart"
	doc["value"] = invalid
	r = await sdk.discover()
	t.check("hook: an invalid member clears it", r.ok and sdk.presentation().is_empty() and events.size() == 2 and (events[1] as Dictionary).is_empty())
	t.check("hook: and the kit's", PKeyUiTheme.presentation_name == "" and PKeyUiTheme.presentation_accent == "" and PKeyUiTheme.presentation_icon == null)
	doc["value"] = F.manifest(drift)
	await sdk.discover()
	doc["value"] = F.manifest(null)
	r = await sdk.discover()
	t.check("hook: a document without the member clears it", r.ok and sdk.presentation().is_empty() and events.size() == 4)
	t.check("hook: presentation_icon() is null without a member", await sdk.presentation_icon(64) == null)
	sdk.queue_free()
	PKeyUiTheme.use_presentation(null)
