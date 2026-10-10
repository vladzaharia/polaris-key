class_name PKeyPresentationSource
extends RefCounted
## The product's presentation (`core.presentation`, WIRE-CONTRACT-V4 §5.5): its name, developer,
## accents and verified icon, from discovery. The seam every kit reads (client-core
## `PresentationSource`): the UI kit takes its default name, icon and accent from here, and the
## integrator's `ui_product_name`, `ui_product_icon` and `ui_accent` always win over it.
##
##   current()            the last parsed member (PKeyPresentationRules.parse), or {} for none
##   icon(px, scale)      a coroutine: an ImageTexture of the verified icon for a hero drawn at
##                        `px` points on a `scale` screen, or null (the kit then shows the
##                        project's icon or a monogram)
##   changed(member)      the member changed ({} when it went away)
##
## `PolarisKey.presentation_source` is one, made before `configure()` so a signal connected early
## survives it. After every successful discovery the member is parsed again: a document without
## one (or with an invalid one) clears it, and a failed discovery keeps the last. `changed` fires
## only when the member differs. `start()` loads the last member from `presentation.json` through
## the same parser, so an offline start still shows the product and a tampered file is dropped.
##
## **Fetch.** A transport of its own: `follow_redirects = false` (a 3xx is a status, and anything
## but 200 is a miss), the PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS deadline, the
## PRESENTATION_ICON_MAX_BYTES cap, local-only from Core, and no headers at all (no
## `Authorization`, no `X-PKey-*`: the image host is public). The URL must be https (or loopback
## http) and on the original's origin. Nothing is retried and no error is surfaced. On web the
## browser's fetch follows redirects itself and cannot be told not to (`redirect_rule()` is the
## typed N/A); no credential is sent and the SHA-256 check gates the bytes there.
##
## **Verify, then decode.** Bytes are shown and cached only when their SHA-256 (`HashingContext`)
## is the pick's `sha256`. Then the magic bytes must be the expected type (WebP for a size, the
## original's `contentType` otherwise), and the header's dimensions (PNG IHDR, WebP VP8/VP8L/VP8X,
## JPEG SOF) are read BEFORE decoding: above PRESENTATION_ICON_MAX_DIMENSION a side, or above a
## local 16-megapixel budget, they are refused, since a 10 MiB file can inflate to gigabytes.
## Only then `Image.load_{png,jpg,webp}_from_buffer`. A decode failure caches nothing.
##
## **Cache.** `user://polaris_key/presentation/<sha256>`, and the last member as
## `presentation.json` beside it, both written to a temporary name and renamed. A cached file is
## re-hashed on every read and deleted on a mismatch. After each discovery the files the member no
## longer names are removed, keeping at most PRESENTATION_CACHE_MAX_FILES icon files. On web
## `user://` is IndexedDB and may not persist; the in-memory textures still serve the session.

## The member changed: the new one, or {} when it went away.
signal changed(presentation: Dictionary)

const CACHE_DIR := "user://polaris_key/presentation"
const MEMBER_FILE := "presentation.json"
const MEMBER_FILE_VERSION := 1
## The decode budget, in pixels: a local guard (not a wire limit). 16384 × 16384 RGBA is 1 GiB.
const DECODE_BUDGET_PIXELS := 16 * 1024 * 1024

## Where icons and `presentation.json` live. One per install (plans/HA-14.md D3).
var cache_dir := CACHE_DIR
## The content types this platform decodes (PKeyPresentationRules.DECODABLE).
var decodable: Array = PKeyPresentationRules.DECODABLE.duplicate()
## The icon transport (attach() makes it), or null before configure().
var transport: PKeyTransport = null
## The configured product's slug.
var product := ""

## Work counter (test hook, the P1-13 rule): `Image.load_*` calls made. A refused header never
## reaches one.
static var decodes := 0

var _current = null
var _discovered := false
var _memo := {}
var _pending := {}


class _Pending:
	signal done
	var finished := false
	var texture: ImageTexture = null


## Bind to a configured Core: the icon transport on `host`, and Core's discovery hook. A new
## product drops the old product's member.
func attach(core: PKeyCore, host: Node) -> void:
	if product != "" and product != core.product:
		_discovered = false
		_memo.clear()
		_set_current(null)
	product = core.product
	transport = PKeyTransport.new(host)
	transport.timeout = float(PKeyConstants.PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS)
	transport.body_limit = PKeyConstants.PRESENTATION_ICON_MAX_BYTES
	transport.local_only = core.local_only
	transport.follow_redirects = false
	core.presentation_source = self


## The last parsed member, or {} when none is known.
func current() -> Dictionary:
	return (_current as Dictionary).duplicate(true) if _current != null else {}


## Cold boot: the last member from `presentation.json`, unless this session already discovered
## one. A file that does not parse, names another product, or does not read back exactly as the
## parser normalises it is deleted.
func load_cached() -> void:
	if _discovered:
		return
	var m = _read_member()
	if m != null:
		_set_current(m)


## A successful discovery's manifest (PKeyCore.discover): parse, store, prune, and emit `changed`
## when the member differs. No member (or an invalid one) clears it.
func accept(manifest: Variant) -> void:
	_discovered = true
	var m = null
	if manifest is Dictionary:
		m = PKeyPresentationRules.parse(manifest.get("core"), {"name": manifest.get("name"), "product": String(manifest.get("product", product))})
	_write_member(m)
	prune(m)
	_set_current(m)


func _set_current(m: Variant) -> void:
	if same(m, _current):
		return
	_current = m
	changed.emit(current())


## The verified icon for a hero drawn at `px` points on a `scale` screen, or null: no member, no
## icon, nothing decodable, or a fetch, hash or decode that failed. Concurrent calls for the same
## bytes share one fetch. A coroutine.
func icon(px: float, scale := 1.0) -> ImageTexture:
	var m = _current
	if m == null or not (m.get("icon") is Dictionary):
		return null
	var ic: Dictionary = m["icon"]
	var pick := PKeyPresentationRules.pick_icon_size(ic, px, scale, decodable)
	if pick["source"] == "none":
		return null
	var sha: String = pick["sha256"]
	if _memo.has(sha):
		return _memo[sha]
	if _pending.has(sha):
		var waiting: _Pending = _pending[sha]
		if not waiting.finished:
			await waiting.done
		return waiting.texture
	var p := _Pending.new()
	_pending[sha] = p
	var expected: String = "image/webp" if pick["source"] == "size" else String(ic["contentType"])
	var tex := await _load(pick, String(ic["original"]), expected)
	_pending.erase(sha)
	if tex != null:
		_memo[sha] = tex
	p.texture = tex
	p.finished = true
	p.done.emit()
	return tex


## `icon(px, scale)`, handed to `done(texture)` unless `done`'s object is gone by then (a kit node
## freed while the fetch ran).
func icon_to(px: float, scale: float, done: Callable) -> void:
	var tex := await icon(px, scale)
	if done.is_valid():
		done.call(tex)


## The disk cache (re-hashed), else the network; verified, decoded, then cached.
func _load(pick: Dictionary, original: String, expected: String) -> ImageTexture:
	var sha: String = pick["sha256"]
	var path := cache_dir.path_join(sha)
	if FileAccess.file_exists(path):
		var held := FileAccess.get_file_as_bytes(path)
		if PKeyPresentationRules.icon_matches(held, sha):
			var cached := decode(held, expected)
			if cached != null:
				return cached
		# Tampered, truncated, or bytes that no longer decode: gone, and fetched again below.
		DirAccess.remove_absolute(path)
	if transport == null or not PKeyPresentationRules.safe_fetch_url(String(pick["url"]), original):
		return null
	var r := await transport.request("GET", String(pick["url"]))
	if not r.ok or int(r.detail.get("status", 0)) != 200:
		return null
	var body: PackedByteArray = r.detail["body"]
	if not PKeyPresentationRules.icon_matches(body, sha):
		return null
	var tex := decode(body, expected)
	if tex == null:
		return null
	if _write(sha, body):
		_cap_files(sha)
	return tex


## Whether a 3xx icon response is refused on this runtime: ok, or the typed N/A on web (reason
## `runtime`), where the browser's fetch follows redirects itself and the hash gates the bytes.
static func redirect_rule() -> PKeyResult:
	if OS.has_feature("web"):
		return PKeyResult.unsupported(PKeyConstants.Feature.CORE_PRESENTATION, PKeyConstants.UnsupportedReason.RUNTIME, "The browser's fetch follows an icon redirect itself; no credential is sent and the SHA-256 check gates the bytes.")
	return PKeyResult.success()


# ── Decode ──────────────────────────────────────────────────────────────────────────────

## Verified bytes as a mipmapped ImageTexture, or null: not `content_type` by their magic bytes,
## not a decodable type, dimensions over the limits in the header, or a failed decode.
static func decode(bytes: PackedByteArray, content_type: String) -> ImageTexture:
	var img := decode_image(bytes, content_type)
	if img == null:
		return null
	img.generate_mipmaps()
	return ImageTexture.create_from_image(img)


static func decode_image(bytes: PackedByteArray, content_type: String) -> Image:
	if not PKeyPresentationRules.DECODABLE.has(content_type):
		return null
	var head := inspect(bytes)
	if head.is_empty() or head["type"] != content_type or not within_budget(head["width"], head["height"]):
		return null
	var img := Image.new()
	decodes += 1
	var err := ERR_INVALID_DATA
	match content_type:
		"image/png":
			err = img.load_png_from_buffer(bytes)
		"image/jpeg":
			err = img.load_jpg_from_buffer(bytes)
		"image/webp":
			err = img.load_webp_from_buffer(bytes)
	if err != OK or img.is_empty() or img.get_width() != head["width"] or img.get_height() != head["height"]:
		return null
	return img


## Whether a `width` × `height` image may be decoded: each side 1…PRESENTATION_ICON_MAX_DIMENSION
## and at most DECODE_BUDGET_PIXELS in all.
static func within_budget(width: int, height: int) -> bool:
	return width >= 1 and height >= 1 \
			and width <= PKeyConstants.PRESENTATION_ICON_MAX_DIMENSION and height <= PKeyConstants.PRESENTATION_ICON_MAX_DIMENSION \
			and width * height <= DECODE_BUDGET_PIXELS


## The type and dimensions an image's header declares, read without decoding it:
## {type: "image/png" | "image/jpeg" | "image/webp", width, height}, or {} when the bytes are none
## of those or the header is cut short.
static func inspect(b: PackedByteArray) -> Dictionary:
	var n := b.size()
	if n >= 24 and b.slice(0, 8) == PackedByteArray([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) and b.slice(12, 16).get_string_from_ascii() == "IHDR":
		return _dims("image/png", _be32(b, 16), _be32(b, 20))
	if n >= 4 and b[0] == 0xff and b[1] == 0xd8 and b[2] == 0xff:
		return _jpeg(b)
	if n >= 30 and b.slice(0, 4).get_string_from_ascii() == "RIFF" and b.slice(8, 12).get_string_from_ascii() == "WEBP":
		match b.slice(12, 16).get_string_from_ascii():
			"VP8 ":
				if b[23] != 0x9d or b[24] != 0x01 or b[25] != 0x2a:
					return {}
				return _dims("image/webp", (b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff)
			"VP8L":
				if b[20] != 0x2f:
					return {}
				return _dims("image/webp", 1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)))
			"VP8X":
				return _dims("image/webp", 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)))
	return {}


## A JPEG's first frame header (SOF0–3, 5–7, 9–11, 13–15), walking the marker segments.
static func _jpeg(b: PackedByteArray) -> Dictionary:
	var n := b.size()
	var i := 2
	while i + 1 < n:
		if b[i] != 0xff:
			return {}
		var marker := b[i + 1]
		if marker == 0xff:
			i += 1
			continue
		i += 2
		if marker == 0x01 or marker == 0xd8 or (marker >= 0xd0 and marker <= 0xd7):
			continue
		if marker == 0xd9 or marker == 0xda or i + 1 >= n:
			return {}
		var length := (b[i] << 8) | b[i + 1]
		if length < 2:
			return {}
		if marker >= 0xc0 and marker <= 0xcf and marker != 0xc4 and marker != 0xc8 and marker != 0xcc:
			if i + 7 > n:
				return {}
			return _dims("image/jpeg", (b[i + 5] << 8) | b[i + 6], (b[i + 3] << 8) | b[i + 4])
		i += length
	return {}


static func _dims(type: String, width: int, height: int) -> Dictionary:
	return {"type": type, "width": width, "height": height}


static func _be32(b: PackedByteArray, at: int) -> int:
	return (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]


# ── Cache files ─────────────────────────────────────────────────────────────────────────

## Remove every icon file `member` does not name (and any interrupted write), then keep at most
## PRESENTATION_CACHE_MAX_FILES of the rest, newest first.
func prune(member: Variant) -> void:
	var keep := named(member)
	for sha in _memo.keys():
		if not keep.has(sha):
			_memo.erase(sha)
	var d := DirAccess.open(cache_dir)
	if d == null:
		return
	for f in d.get_files():
		if f == MEMBER_FILE:
			continue
		if not keep.has(f):
			d.remove(f)
	_cap_files("")


## The icon hashes `member` names: the original's and each size's.
static func named(member: Variant) -> Dictionary:
	var out := {}
	if member is Dictionary and member.get("icon") is Dictionary:
		out[member["icon"]["sha256"]] = true
		for s in member["icon"].get("sizes", []):
			out[s["sha256"]] = true
	return out


## The icon files in the cache, as names.
func cached_files() -> PackedStringArray:
	var out := PackedStringArray()
	var d := DirAccess.open(cache_dir)
	if d == null:
		return out
	for f in d.get_files():
		if f != MEMBER_FILE and not f.contains(".tmp-"):
			out.append(f)
	return out


## At most PRESENTATION_CACHE_MAX_FILES icon files: the oldest go first; `fresh` (just written)
## never does.
func _cap_files(fresh: String) -> void:
	var files: Array = []
	for f in cached_files():
		if f != fresh:
			files.append([FileAccess.get_modified_time(cache_dir.path_join(f)), f])
	var room := PKeyConstants.PRESENTATION_CACHE_MAX_FILES - (1 if fresh != "" else 0)
	if files.size() <= room:
		return
	files.sort_custom(func(a, b): return a[0] < b[0] or (a[0] == b[0] and a[1] < b[1]))
	var d := DirAccess.open(cache_dir)
	for k in files.size() - room:
		d.remove(files[k][1])


## Write `bytes` to `name` in the cache: a temporary file, renamed over the target.
func _write(name: String, bytes: PackedByteArray) -> bool:
	if DirAccess.make_dir_recursive_absolute(cache_dir) != OK:
		return false
	var tmp := "%s.tmp-%s" % [name, Crypto.new().generate_random_bytes(6).hex_encode()]
	var f := FileAccess.open(cache_dir.path_join(tmp), FileAccess.WRITE)
	if f == null:
		return false
	f.store_buffer(bytes)
	var err := f.get_error()
	f.close()
	var d := DirAccess.open(cache_dir)
	if err == OK and d != null:
		err = d.rename(tmp, name)
	if err != OK:
		DirAccess.remove_absolute(cache_dir.path_join(tmp))
		return false
	return true


func _write_member(m: Variant) -> void:
	if m == null:
		var path := cache_dir.path_join(MEMBER_FILE)
		if FileAccess.file_exists(path):
			DirAccess.remove_absolute(path)
		return
	_write(MEMBER_FILE, PKeyJson.stringify({"v": MEMBER_FILE_VERSION, "product": product, "presentation": m}).to_utf8_buffer())


func _read_member() -> Variant:
	var path := cache_dir.path_join(MEMBER_FILE)
	if not FileAccess.file_exists(path):
		return null
	var parsed := PKeyJson.parse_bytes(FileAccess.get_file_as_bytes(path))
	var value = parsed.get("value") if parsed["ok"] else null
	var m = null
	if value is Dictionary and same(value.get("v"), MEMBER_FILE_VERSION) and value.get("product") == product and product != "":
		m = PKeyPresentationRules.parse({"presentation": value.get("presentation")}, {"product": product})
		# Only a member this SDK wrote reads back: the parser's normal form, exactly.
		if m != null and not same(m, value.get("presentation")):
			m = null
	if m == null:
		DirAccess.remove_absolute(path)
	return m


## Deep equality over JSON-shaped values, numbers by value (Godot reads every JSON number as a
## float; the parser emits integers).
static func same(a: Variant, b: Variant) -> bool:
	if (a is int or a is float) and (b is int or b is float):
		return float(a) == float(b)
	if a is Dictionary and b is Dictionary:
		if a.size() != b.size():
			return false
		for k in a:
			if not b.has(k) or not same(a[k], b[k]):
				return false
		return true
	if a is Array and b is Array:
		if a.size() != b.size():
			return false
		for i in a.size():
			if not same(a[i], b[i]):
				return false
		return true
	return typeof(a) == typeof(b) and a == b
