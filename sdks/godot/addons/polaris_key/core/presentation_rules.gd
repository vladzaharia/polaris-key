class_name PKeyPresentationRules
extends RefCounted
## Product presentation's rules (WIRE-CONTRACT-V4 §5.5), a rule-for-rule port of client-core
## `presentation.ts`, pinned by `presentation-matrix.json` (`parseCases`, `pickCases`,
## `verifyCases`). Pure and static: no disk, no network, no engine state.
##
##   parse(core, doc)                       discovery's `core.presentation`, normalised field by
##                                          field (a malformed field is dropped), or null
##   pick_icon_size(icon, px, scale, types) which bytes to fetch for an icon drawn at `px` points
##                                          on a `scale` screen: {source: "size", w, sha256, url},
##                                          {source: "original", sha256, url} or {source: "none"}
##   icon_matches(bytes, sha256)            whether the bytes' lower-case hex SHA-256 is `sha256`
##   usable_url_origin(url)                 rule 5: the URL's origin, or "" when it is not usable
##   safe_fetch_url(url, original)          the fetcher's safe-link rule: usable, https (or
##                                          loopback http), and on `original`'s origin
##
## Every limit is a generated `PKeyConstants.PRESENTATION_*` constant. Numbers arrive as floats
## (Godot's JSON); an integer field is one whose value is whole, as JavaScript's
## `Number.isInteger`, and it is emitted as an int. A Godot String holds neither U+0000 nor a lone
## surrogate (the engine substitutes U+FFFD; `suite_presentation` pins it), and the text rule
## refuses both anyway.

## The content types Godot decodes (`Image.load_png_from_buffer`, `load_jpg_from_buffer`,
## `load_webp_from_buffer`). An AVIF or GIF original with no sizes is no icon here.
const DECODABLE: Array[String] = ["image/png", "image/jpeg", "image/webp"]
const LOOPBACK_HOSTS: Array[String] = ["localhost", "127.0.0.1", "[::1]"]

static var _colour_re: RegEx
static var _sha_re: RegEx
static var _label_re: RegEx
static var _digits_re: RegEx
static var _hex_number_re: RegEx


static func _static_init() -> void:
	_colour_re = RegEx.create_from_string("\\A#[0-9A-Fa-f]{6}\\z")
	_sha_re = RegEx.create_from_string("\\A[0-9a-f]{64}\\z")
	_label_re = RegEx.create_from_string("\\A[a-z0-9-]{1,63}\\z")
	_digits_re = RegEx.create_from_string("\\A[0-9]+\\z")
	_hex_number_re = RegEx.create_from_string("\\A0x[0-9a-f]*\\z")


## `core.presentation` from a discovery document's `core` block, normalised, or null when the
## member is absent or not an object. `doc` carries the document's top-level `name` (the name's
## first fallback) and `product` (the slug, its last).
static func parse(core: Variant, doc: Dictionary) -> Variant:
	if not (core is Dictionary):
		return null
	var raw = core.get("presentation")
	if not (raw is Dictionary):
		return null
	var name = text(raw.get("name"))
	if name == null:
		name = text(doc.get("name"))
	if name == null:
		name = str(doc.get("product", ""))
	var out := {"name": name}
	var developer = text(raw.get("developerName"))
	if developer != null:
		out["developerName"] = developer
	var accent = colour(raw.get("accent"))
	if accent != null:
		out["accent"] = accent
	var accent_dark = colour(raw.get("accentDark"))
	if accent_dark != null:
		out["accentDark"] = accent_dark
	var parsed_icon = icon(raw.get("icon"))
	if parsed_icon != null:
		out["icon"] = parsed_icon
	return out


## Rule 2: a display text, or null. 1 to PRESENTATION_TEXT_MAX_BYTES UTF-8 bytes; no C0 control,
## DEL, C1 control or lone surrogate. Bidi and zero-width characters are kept.
static func text(v: Variant) -> Variant:
	if not (v is String):
		return null
	var s: String = v
	var bytes := 0
	for i in s.length():
		var c := s.unicode_at(i)
		if c <= 0x1f or (c >= 0x7f and c <= 0x9f) or (c >= 0xd800 and c <= 0xdfff):
			return null
		bytes += 1 if c < 0x80 else (2 if c < 0x800 else (3 if c < 0x10000 else 4))
	if bytes < 1 or bytes > PKeyConstants.PRESENTATION_TEXT_MAX_BYTES:
		return null
	return s


## Rule 3: a colour, lower-cased, or null.
static func colour(v: Variant) -> Variant:
	if v is String and _colour_re.search(v) != null:
		return (v as String).to_lower()
	return null


## Rule 5: the URL's origin (scheme and authority, lower-cased) when it is usable, else "".
static func usable_url_origin(v: Variant) -> String:
	if not (v is String):
		return ""
	var s: String = v
	if s.length() < 1 or s.length() > PKeyConstants.PRESENTATION_URL_MAX_BYTES:
		return ""
	for i in s.length():
		var c := s.unicode_at(i)
		if c < 0x21 or c > 0x7e or c == 0x23 or c == 0x5c:
			return ""
	var lower := s.to_lower()
	var scheme := ""
	if lower.begins_with("https://"):
		scheme = "https"
	elif lower.begins_with("http://"):
		scheme = "http"
	else:
		return ""
	var rest := lower.substr(scheme.length() + 3)
	var end := -1
	for i in rest.length():
		var ch := rest[i]
		if ch == "/" or ch == "?":
			end = i
			break
	var authority := rest if end == -1 else rest.substr(0, end)
	var host := _authority_host(authority)
	if host == "":
		return ""
	# Only the loopback hosts may be plain http.
	if scheme == "http" and not LOOPBACK_HOSTS.has(host):
		return ""
	return "%s://%s" % [scheme, authority]


## A lower-cased authority's host when it has a usable host and port, else "".
static func _authority_host(authority: String) -> String:
	var host: String
	var port = null
	if authority.begins_with("["):
		var close := authority.find("]")
		if close == -1:
			return ""
		host = authority.substr(0, close + 1)
		var after := authority.substr(close + 1)
		if after != "" and not after.begins_with(":"):
			return ""
		port = null if after == "" else after.substr(1)
	else:
		var colon := authority.find(":")
		host = authority if colon == -1 else authority.substr(0, colon)
		port = null if colon == -1 else authority.substr(colon + 1)
	if port != null:
		var p: String = port
		if p.length() < 1 or p.length() > 5 or _digits_re.search(p) == null or p.to_int() > 65535:
			return ""
	if host == "[::1]" or host == "127.0.0.1":
		return host
	var labels := host.split(".", true)
	for l in labels:
		if _label_re.search(l) == null:
			return ""
	var last: String = labels[labels.size() - 1]
	if _digits_re.search(last) != null or _hex_number_re.search(last) != null:
		return ""
	return host


## A whole number in [lo, hi] as an int, or null (JavaScript's Number.isInteger plus the range).
static func _integer(v: Variant, lo: int, hi: int) -> Variant:
	if v is int:
		return v if v >= lo and v <= hi else null
	if v is float and is_finite(v) and v == floorf(v) and v >= lo and v <= hi:
		return int(v)
	return null


## Rule 4's `sizes`: the entries, [] when absent, or null when any entry is bad.
static func _sizes(raw: Dictionary) -> Variant:
	if not raw.has("sizes"):
		return []
	var v = raw["sizes"]
	if not (v is Array) or (v as Array).size() > PKeyConstants.PRESENTATION_MAX_ICON_SIZES:
		return null
	var out: Array = []
	var last := 0
	for e in v:
		if not (e is Dictionary):
			return null
		var w = _integer(e.get("w"), 1, PKeyConstants.PRESENTATION_MAX_ICON_WIDTH)
		if w == null or w <= last:
			return null
		var sha = e.get("sha256")
		if not (sha is String) or _sha_re.search(sha) == null:
			return null
		out.append({"w": w, "sha256": sha})
		last = w
	return out


## Rule 4: the icon, or null.
static func icon(v: Variant) -> Variant:
	if not (v is Dictionary):
		return null
	var raw: Dictionary = v
	var sha = raw.get("sha256")
	if not (sha is String) or _sha_re.search(sha) == null:
		return null
	var content_type = raw.get("contentType")
	if not (content_type is String) or not PKeyConstants.PRESENTATION_ICON_TYPES.has(content_type):
		return null
	var original = raw.get("original")
	var origin := usable_url_origin(original)
	if origin == "":
		return null
	var width = _integer(raw.get("width"), 1, PKeyConstants.PRESENTATION_ICON_MAX_DIMENSION)
	var height = _integer(raw.get("height"), 1, PKeyConstants.PRESENTATION_ICON_MAX_DIMENSION)
	var ladder = _sizes(raw)
	var url = raw.get("url")
	# `{w}` sits after the authority: the template begins with the original's own origin and then
	# `/` or `?`, so the width can never change the host or the port.
	var templated: bool = ladder != null and not (ladder as Array).is_empty() and url is String \
			and (url as String).length() <= PKeyConstants.PRESENTATION_URL_MAX_BYTES \
			and (url as String).split("{w}", true).size() == 2 \
			and ((url as String).to_lower().begins_with(origin + "/") or (url as String).to_lower().begins_with(origin + "?")) \
			and usable_url_origin((url as String).replace("{w}", "1")) == origin
	# Members in the contract's order (§5.5), so a stored member reads as the contract shows it.
	var out := {"sha256": sha, "contentType": content_type}
	if width != null:
		out["width"] = width
	if height != null:
		out["height"] = height
	out["original"] = original
	if templated:
		out["url"] = url
	out["sizes"] = ladder if templated else []
	return out


## Which bytes to fetch for an icon drawn at `px` points on a `scale` screen, given the content
## types this platform decodes. need = ceil(px × scale), at least 1:
##
##   1. With sizes and WebP decodable: the smallest w ≥ need, else the largest w.
##   2. The original instead when it is decodable, its width is known and exceeds the largest w,
##      and need exceeds the largest w.
##   3. With no usable size: the original, when it is decodable.
##   4. Otherwise none.
static func pick_icon_size(p_icon: Dictionary, px: float, scale: float, decodable: Array) -> Dictionary:
	var product := ceilf(px * scale)
	var need := int(product) if is_finite(product) and product >= 1.0 else 1
	var original_ok := decodable.has(p_icon.get("contentType"))
	var original := {"source": "original", "sha256": p_icon["sha256"], "url": p_icon["original"]}
	var sizes: Array = p_icon.get("sizes", [])
	if not sizes.is_empty() and p_icon.get("url") is String and decodable.has("image/webp"):
		var largest: Dictionary = sizes[sizes.size() - 1]
		var fit := largest
		for s in sizes:
			if int(s["w"]) >= need:
				fit = s
				break
		var width = p_icon.get("width")
		if original_ok and need > int(largest["w"]) and width != null and int(width) > int(largest["w"]):
			return original
		return {
			"source": "size",
			"w": int(fit["w"]),
			"sha256": fit["sha256"],
			"url": String(p_icon["url"]).replace("{w}", str(int(fit["w"]))),
		}
	return original if original_ok else {"source": "none"}


## The lower-case hex SHA-256 of `bytes` (`HashingContext`; the engine stops at SHA-256, which is
## all this needs).
static func sha256_hex(bytes: PackedByteArray) -> String:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	if not bytes.is_empty():
		h.update(bytes)
	return h.finish().hex_encode()


## Whether `bytes` hash to `sha256` exactly (an upper-case expectation never matches). Bytes that
## do not match are neither shown nor cached.
static func icon_matches(bytes: PackedByteArray, sha256: String) -> bool:
	return sha256_hex(bytes) == sha256


## The fetcher's safe-link rule (UI-KITS DL14 `safeLink`, plans/HA-13.md §3): `url` is usable,
## https or loopback http (rule 5 already allows plain http only there), and on `original`'s
## origin, so an expanded `{w}` can never reach another host or port.
static func safe_fetch_url(url: String, original: String) -> bool:
	var origin := usable_url_origin(url)
	return origin != "" and origin == usable_url_origin(original)
