class_name PKeyPackClaims
extends RefCounted
## Packs on the wire (plans/P4-01.md §2.3, §2.4, §2.8, §2.9; WIRE-CONTRACT-V4 §2.5.1, §2.5.2,
## §8): a port of client-core `packs/claims.ts`, `variant.ts`, `set.ts`, `stamp.ts` and the
## pack half of `record.ts`. Pure; nothing here throws or touches the disk.
##
##   is_pack_id(v)                       the one pack-id rule (DELIVERABLE_ID_PATTERN, ≤ 64 bytes,
##                                       never `app`)
##   object_ref(v, pointer, min_bytes, min_size, nw)   an object ref {sha256, bytes, size, codec}
##   content_claims(v, nw, pointer)      an app record's `content` (or a content stamp's top level)
##   pack_record_claims(doc, nw)         §2.3's `kind: pack` claims after the common ones
##   embeds_ok(v)                        `builds[].embeds`
##   variant_key(variant)                `axis=value;…` sorted by axis-name bytes
##   compare_bytes(a, b)                 UTF-8 byte order
##   pack_set_id(entries)                the active set's id, or null
##   parse_content_stamp(bytes|text)     {ok, content} or {ok: false, error: content-stamp-invalid}
##
## Every helper is thread-safe: no const Array is indexed or iterated (README "Writing GDScript
## here": the 4.4.1 shared read slot).

const DELIVERABLE_PATTERN := "[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*"
const VERSION_PATTERN := "[0-9A-Za-z][0-9A-Za-z.+-]{0,63}"
const SHA256_PATTERN := "[0-9a-f]{64}"
const PACK_TYPE_PATTERN := "[a-z][a-z0-9-]{0,31}\\.[a-z][a-z0-9-]{0,31}"
const VOCAB_TOKEN_PATTERN := "[a-z][a-z0-9-]{0,31}"
const OBJECT_FORMAT_PATTERN := "[a-z][a-z0-9-]{0,31}/[1-9][0-9]{0,8}"
const HANDLER_PREFIX_PATTERN := "res://([A-Za-z0-9_][A-Za-z0-9 ._@+-]*/)+"
const ENTITLEMENT_PATTERN := "[A-Za-z0-9][A-Za-z0-9._:-]{0,63}"
const VARIANT_AXIS_PATTERN := "[a-z][a-z0-9-]{0,15}"
const VARIANT_VALUE_PATTERN := "[A-Za-z0-9][A-Za-z0-9-]{0,34}"
const ENGINE_PATTERN := "godot-[0-9]+\\.[0-9]+"

const CONTENT_STAMP_INVALID := "content-stamp-invalid"

static var _res: Dictionary = {}


## One compiled whole-match RegEx per pattern. Built on first use (a non-tool script's
## `_static_init` never runs in the editor) and only read afterwards.
static func _re(pattern: String) -> RegEx:
	var re = _res.get(pattern)
	if re == null:
		re = PKeyClaims.whole(pattern)
		_res[pattern] = re
	return re


## Compile every pattern now (call once on the main thread before any worker uses them).
static func warm() -> void:
	for p in [DELIVERABLE_PATTERN, VERSION_PATTERN, SHA256_PATTERN, PACK_TYPE_PATTERN, VOCAB_TOKEN_PATTERN, OBJECT_FORMAT_PATTERN, HANDLER_PREFIX_PATTERN, ENTITLEMENT_PATTERN, VARIANT_AXIS_PATTERN, VARIANT_VALUE_PATTERN, ENGINE_PATTERN]:
		_re(p)


static func matches(pattern: String, v: Variant) -> bool:
	return PKeyClaims.matches_whole_re(_re(pattern), v)


static func is_sha256(v: Variant) -> bool:
	return matches(SHA256_PATTERN, v)


static func is_object(v: Variant) -> bool:
	return v is Dictionary


## Equality that never raises: GDScript's `==` between a String and a number, bool, Array or
## Dictionary is a runtime error (the editor aborts the function; a release template carries on
## with garbage), and every value read from JSON can be anything. Numbers compare as floats.
static func same(a: Variant, b: Variant) -> bool:
	if (a is float or a is int) and (b is float or b is int):
		return float(a) == float(b)
	if (a is String or a is StringName) and (b is String or b is StringName):
		return String(a) == String(b)
	if typeof(a) != typeof(b):
		return false
	return a == b


## UTF-8 length of a string.
static func utf8_length(s: String) -> int:
	return s.to_utf8_buffer().size()


## A pack id (§2.3): DELIVERABLE_ID_PATTERN, at most 64 bytes, and not `app`.
static func is_pack_id(v: Variant) -> bool:
	return v is String and v != "app" and utf8_length(v) <= 64 and matches(DELIVERABLE_PATTERN, v)


## An object ref `{sha256, bytes, size, codec}` at `pointer` (§2.3): `sha256` 64 lowercase hex;
## `bytes` and `size` integer claims from `min_bytes` and `min_size`; `codec` a vocabulary token;
## `codec: "none"` only with `bytes == size`. An unknown codec verifies.
static func object_ref(v: Variant, pointer: String, min_bytes: int, min_size: int, nw: PKeyJson.PointerSet = null) -> bool:
	if not (v is Dictionary):
		return false
	if not is_sha256(v.get("sha256")):
		return false
	if not PKeyClaims.is_wire_integer(v.get("bytes"), pointer + "/bytes", min_bytes, nw):
		return false
	if not PKeyClaims.is_wire_integer(v.get("size"), pointer + "/size", min_size, nw):
		return false
	if not matches(VOCAB_TOKEN_PATTERN, v.get("codec")):
		return false
	if v["codec"] == "none" and float(v["bytes"]) != float(v["size"]):
		return false
	return true


## The `content` claims (§2.4): an integer `contentApi` ≥ 1, `pins` (0–256, `pack` a unique pack
## id, `release {sha256, seq ≥ 1, version}`) and `expects` (0–256, `pack` unique, a boolean
## `required`, a vocabulary-token `delivery`). Unknown members are ignored. `pointer` is where
## the object sits: `/content` in an app record, "" in a content stamp.
static func content_claims(v: Variant, nw: PKeyJson.PointerSet = null, pointer := "/content") -> bool:
	if not (v is Dictionary):
		return false
	if not PKeyClaims.is_wire_integer(v.get("contentApi"), pointer + "/contentApi", 1, nw):
		return false
	var pins = v.get("pins")
	if not (pins is Array) or pins.size() > PKeyConstants.MAX_CONTENT_PINS:
		return false
	var pinned := {}
	for i in pins.size():
		var pin = pins[i]
		if not (pin is Dictionary) or not is_pack_id(pin.get("pack")):
			return false
		if pinned.has(pin["pack"]):
			return false
		pinned[pin["pack"]] = true
		var r = pin.get("release")
		if not (r is Dictionary):
			return false
		if not is_sha256(r.get("sha256")):
			return false
		if not PKeyClaims.is_wire_integer(r.get("seq"), "%s/pins/%d/release/seq" % [pointer, i], 1, nw):
			return false
		if not matches(VERSION_PATTERN, r.get("version")):
			return false
	var expects = v.get("expects")
	if not (expects is Array) or expects.size() > PKeyConstants.MAX_CONTENT_PINS:
		return false
	var expected := {}
	for e in expects:
		if not (e is Dictionary) or not is_pack_id(e.get("pack")):
			return false
		if expected.has(e["pack"]):
			return false
		expected[e["pack"]] = true
		if not (e.get("required") is bool):
			return false
		if not matches(VOCAB_TOKEN_PATTERN, e.get("delivery")):
			return false
	return true


## `builds[].embeds` (§2.4): 0–64 unique pack ids.
static func embeds_ok(v: Variant) -> bool:
	if not (v is Array) or v.size() > PKeyConstants.MAX_BUILD_EMBEDS:
		return false
	var seen := {}
	for id in v:
		if not is_pack_id(id) or seen.has(id):
			return false
		seen[id] = true
	return true


## An optional member that must match `pattern` when present (a present null is refused).
static func _opt_pattern(o: Dictionary, key: String, pattern: String) -> bool:
	return not o.has(key) or matches(pattern, o[key])


## A `{sha256, bytes}` member (a delta's `artifact` or `data`): bytes ≥ 1.
static func _hash_bytes_ok(v: Variant, pointer: String, nw: PKeyJson.PointerSet) -> bool:
	return v is Dictionary and is_sha256(v.get("sha256")) and PKeyClaims.is_wire_integer(v.get("bytes"), pointer + "/bytes", 1, nw)


## The pack record's claims (§2.3), after the common ones (PKeyReleaseRecord checks those): the
## `kind: pack` checks of §4.6 and the integer rule at §2.5's paths. A value outside a v1
## vocabulary is never refused here; it only makes the governed thing unusable (§2.2).
static func pack_record_claims(doc: Dictionary, nw: PKeyJson.PointerSet = null) -> bool:
	if same(doc.get("deliverable"), "app"):
		return false
	if doc.has("builds"):
		return false
	if not matches(PACK_TYPE_PATTERN, doc.get("type")):
		return false
	if not PKeyClaims.is_wire_integer(doc.get("formatVersion"), "/formatVersion", 1, nw):
		return false
	if doc.has("handler"):
		var h = doc["handler"]
		if not (h is Dictionary):
			return false
		if h.has("mountOrder") and not PKeyClaims.is_wire_integer(h["mountOrder"], "/handler/mountOrder", 0, nw):
			return false
		if h.has("prefixes"):
			var p = h["prefixes"]
			if not (p is Array) or p.size() < 1 or p.size() > 32:
				return false
			var seen := {}
			for prefix in p:
				if not matches(HANDLER_PREFIX_PATTERN, prefix):
					return false
				if utf8_length(prefix) > 256 or seen.has(prefix):
					return false
				seen[prefix] = true
		if not _opt_pattern(h, "activation", VOCAB_TOKEN_PATTERN):
			return false
	if not _opt_pattern(doc, "entitlement", ENTITLEMENT_PATTERN):
		return false

	var variants = doc.get("variants")
	if not (variants is Array) or variants.size() < 1 or variants.size() > PKeyConstants.MAX_PACK_VARIANTS:
		return false
	var keys := {}
	var axes = null
	for i in variants.size():
		var v = variants[i]
		if not (v is Dictionary):
			return false
		var at := "/variants/%d" % i
		var sel = v.get("variant")
		if not (sel is Dictionary):
			return false
		var names: Array = sel.keys()
		if names.size() > 4:
			return false
		for name in names:
			if not matches(VARIANT_AXIS_PATTERN, name):
				return false
			if not matches(VARIANT_VALUE_PATTERN, sel[name]):
				return false
		var p = v.get("payload")
		if not (p is Dictionary):
			return false
		if not PKeyClaims.is_wire_integer(p.get("size"), at + "/payload/size", 0, nw):
			return false
		if not is_sha256(p.get("sha256")):
			return false
		if not object_ref(v.get("full"), at + "/full", 0, 0, nw):
			return false
		var f = v.get("files")
		if not (f is Dictionary):
			return false
		if not matches(OBJECT_FORMAT_PATTERN, f.get("format")):
			return false
		if not matches(VOCAB_TOKEN_PATTERN, f.get("layout")):
			return false
		if not object_ref(f, at + "/files", 1, 1, nw):
			return false
		if f.has("gaps"):
			if not (f["gaps"] is Dictionary):
				return false
			if f["layout"] == "tree":
				return false
			if not object_ref(f["gaps"], at + "/files/gaps", 0, 0, nw):
				return false
		elif f["layout"] == "container":
			return false
		if v.has("deltas"):
			var deltas = v["deltas"]
			if not (deltas is Array) or deltas.size() > PKeyConstants.MAX_VARIANT_DELTAS:
				return false
			var ids := {}
			for j in deltas.size():
				var d = deltas[j]
				if not (d is Dictionary):
					return false
				var dt := "%s/deltas/%d" % [at, j]
				if not matches(VOCAB_TOKEN_PATTERN, d.get("method")):
					return false
				if not matches(VOCAB_TOKEN_PATTERN, d.get("scope")):
					return false
				if d["scope"] == "payload" and f["layout"] == "tree":
					return false
				if not is_sha256(d.get("from")):
					return false
				if not PKeyClaims.is_wire_integer(d.get("memBytes"), dt + "/memBytes", 1, nw):
					return false
				var id = null
				if d["scope"] == "payload":
					if not _hash_bytes_ok(d.get("artifact"), dt + "/artifact", nw):
						return false
					id = d["artifact"]["sha256"]
				elif d["scope"] == "files":
					if not object_ref(d.get("patch"), dt + "/patch", 1, 1, nw):
						return false
					if not _hash_bytes_ok(d.get("data"), dt + "/data", nw):
						return false
					id = d["patch"]["sha256"]
				if id != null:
					if ids.has(id):
						return false
					ids[id] = true
		if v.has("requires"):
			var r = v["requires"]
			if not (r is Dictionary) or not _opt_pattern(r, "engine", ENGINE_PATTERN):
				return false
		# plans/P4-10.md §2.2: checks 81-83 and the object ref at `chunks` (`bytes` and `size` from
		# 1); other members are ignored (reserved: an index delta).
		if v.has("chunks"):
			var c = v["chunks"]
			if not (c is Dictionary):
				return false
			if not matches(OBJECT_FORMAT_PATTERN, c.get("format")):
				return false
			if not object_ref(c, at + "/chunks", 1, 1, nw):
				return false
			if c.has("params") and not (c["params"] is Dictionary):
				return false
		var key := variant_key(sel)
		if keys.has(key):
			return false
		keys[key] = true
		var sorted_names := names.duplicate()
		sorted_names.sort_custom(func(a, b): return compare_bytes(a, b) < 0)
		var axis_set := ",".join(PackedStringArray(sorted_names))
		if axes == null:
			axes = axis_set
		elif axes != axis_set:
			return false
	return true


## Compare two strings by their UTF-8 bytes (equal to code-point order): < 0, 0 or > 0.
static func compare_bytes(a: String, b: String) -> int:
	if a == b:
		return 0
	var x := a.to_utf8_buffer()
	var y := b.to_utf8_buffer()
	var n := mini(x.size(), y.size())
	for i in n:
		if x[i] != y[i]:
			return x[i] - y[i]
	return x.size() - y.size()


## The variant key: the variant's `axis=value` pairs sorted by axis-name bytes and joined with
## `;` (`locale=fr;texture=astc`), and "" for `{}`.
static func variant_key(variant: Variant) -> String:
	if not (variant is Dictionary):
		return ""
	var axes: Array = variant.keys()
	axes.sort_custom(func(a, b): return compare_bytes(String(a), String(b)) < 0)
	var parts := PackedStringArray()
	for axis in axes:
		parts.append("%s=%s" % [axis, variant[axis]])
	return ";".join(parts)


## `packSetId` (§2.9): the lowercase hex SHA-256 of the UTF-8 lines `<packId> <releaseSha256>\n`,
## sorted by pack-id bytes. null when a pack id is invalid, a release is not 64 lowercase hex, or
## a pack is listed twice. The empty set hashes the empty string. `entries`: Array of
## {packId, releaseSha256}.
static func pack_set_id(entries: Variant) -> Variant:
	if not (entries is Array):
		return null
	var seen := {}
	for e in entries:
		if not (e is Dictionary):
			return null
		if not is_pack_id(e.get("packId")):
			return null
		if not is_sha256(e.get("releaseSha256")):
			return null
		if seen.has(e["packId"]):
			return null
		seen[e["packId"]] = true
	var sorted: Array = (entries as Array).duplicate()
	sorted.sort_custom(func(a, b): return compare_bytes(a["packId"], b["packId"]) < 0)
	var text := ""
	for e in sorted:
		text += "%s %s\n" % [e["packId"], e["releaseSha256"]]
	return sha256_hex(text.to_utf8_buffer())


## Lowercase hex SHA-256 of bytes (HashingContext).
static func sha256_hex(bytes: PackedByteArray) -> String:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	if not bytes.is_empty():
		h.update(bytes)
	return h.finish().hex_encode()


## Parse a content stamp file's bytes (or text) (§2.6, §2.8): strict JSON (V4 §1.2),
## `format == "pkey-content/1"` and §2.4's claims over `contentApi`, `pins` and `expects` (pointers
## at the stamp's top level). Unknown members are ignored. {ok: true, content: {contentApi, pins,
## expects}} or {ok: false, error: "content-stamp-invalid"}.
static func parse_content_stamp(input: Variant) -> Dictionary:
	var invalid := {"ok": false, "error": CONTENT_STAMP_INVALID}
	var parsed: Dictionary
	if input is PackedByteArray:
		parsed = PKeyJson.parse_bytes(input)
	elif input is String:
		if (input as String).begins_with(char(0xFEFF)):
			return invalid
		parsed = PKeyJson.parse(input)
	else:
		return invalid
	if not parsed.get("ok", false):
		return invalid
	var doc = parsed["value"]
	if not (doc is Dictionary) or not same(doc.get("format"), PKeyConstants.CONTENT_STAMP_FORMAT):
		return invalid
	if not content_claims(doc, parsed["non_wire_integers"], ""):
		return invalid
	return {"ok": true, "content": {"contentApi": doc["contentApi"], "pins": doc["pins"], "expects": doc["expects"]}}
