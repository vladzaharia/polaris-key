class_name PKeyReleaseRecord
extends RefCounted
## The release record, `pkey-release+jws` (WIRE-CONTRACT-V4 §2.4; client steps 12–16 of
## plans/P3-01.md §2.5): a port of client-core `record.ts`, pinned by the corpus
## `releaseRecordCases`.
##
##   record_hash(body)                   lowercase hex SHA-256 of the exact bytes (HashingContext;
##                                       Godot has SHA-256 natively), synchronous
##   release_record_claims(payload, opts)  step 14: true when every claim of §2.4 holds
##   verify_release_record(body, opts)   steps 12–15 (a coroutine): {ok: true, record} or
##                                       {ok: false, step}, step "hash" | "jws" | "claims" |
##                                       "cross-check"
##   reload_release_records(cached, opts)  the reload path for the `releaseRecords` slice
##
## Hash before signature: a body over MAX_RECORD_JWS_BYTES (88 844) or with a byte outside ASCII
## is refused at step `hash` without hashing, and otherwise its SHA-256 must equal the feed's pin
## before any Ed25519 work. The key is chosen by `kid` from the PINNED release keys only
## (`pinned_release_keys`), never merged with the product trust set, and a release key whose raw
## bytes are also a product key is refused at step `jws`: a release key is never a product key.
## A `kind: pack` record must pass the pack claims and a `kind: app` record's `content` and
## `builds[].embeds` the app ones (PKeyPackClaims, plans/P4-01.md §2.3–§2.4).

const MAX_RECORD_JWS_BYTES := 88844
const MAX_BUILDS := 64
const MAX_ARTIFACTS := 32
const MAX_DELIVERABLE_BYTES := 64
## `@polaris-key/manifest`'s DELIVERABLE_ID_PATTERN.
const DELIVERABLE_PATTERN := "[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*"
## P2-04's VERSION_RE. The record names no scheme: the pin's version parses under the feed's.
const VERSION_PATTERN := "[0-9A-Za-z][0-9A-Za-z.+-]{0,63}"
## P2-04's BUILD_ID_RE (`BUILD_ID_PATTERN`), ASCII.
const BUILD_ID_PATTERN := "[a-z0-9][a-z0-9._-]{0,63}"

const STEP_HASH := "hash"
const STEP_JWS := "jws"
const STEP_CLAIMS := "claims"
const STEP_CROSS_CHECK := "cross-check"

static var _deliverable_re: RegEx
static var _version_re: RegEx
static var _build_id_re: RegEx
static var _sha256_re: RegEx
static var _optional_strings := PackedStringArray(["tag", "channel", "title", "notes"])


static func _static_init() -> void:
	_deliverable_re = PKeyClaims.whole(DELIVERABLE_PATTERN)
	_version_re = PKeyClaims.whole(VERSION_PATTERN)
	_build_id_re = PKeyClaims.whole(BUILD_ID_PATTERN)
	_sha256_re = PKeyClaims.whole("[0-9a-f]{64}")


static func _ready_res() -> void:
	if _deliverable_re == null:
		_static_init()


static func _non_empty(v: Variant) -> bool:
	return v is String and v != ""


## An optional string member: absent, or a string (a present null is refused).
static func _opt_string(o: Dictionary, key: String) -> bool:
	return not o.has(key) or o[key] is String


static func _claims_ok(doc: Dictionary, expected_aud: String, nw: PKeyJson.PointerSet) -> bool:
	var sv = doc.get("schemaVersion")
	if not PKeyClaims.is_wire_integer(sv, "/schemaVersion", 1, nw) or float(sv) != 1.0:
		return false
	if not (doc.get("aud") is String) or doc["aud"] != expected_aud:
		return false
	var deliverable = doc.get("deliverable")
	if not (deliverable is String) or (deliverable as String).to_utf8_buffer().size() > MAX_DELIVERABLE_BYTES:
		return false
	if not PKeyClaims.matches_whole_re(_deliverable_re, deliverable):
		return false
	if not _non_empty(doc.get("kind")):
		return false
	if not PKeyClaims.matches_whole_re(_version_re, doc.get("version")):
		return false
	if not PKeyClaims.is_wire_integer(doc.get("seq"), "/seq", 1, nw):
		return false
	if not PKeyClaims.is_wire_integer(doc.get("issuedAt"), "/issuedAt", 0, nw):
		return false
	if doc.has("minSupportedSeq") and not PKeyClaims.is_wire_integer(doc["minSupportedSeq"], "/minSupportedSeq", 1, nw):
		return false
	for key in _optional_strings:
		if not _opt_string(doc, key):
			return false
	if doc.has("provenance"):
		var p = doc["provenance"]
		if not (p is Dictionary) or not _opt_string(p, "commit") or not _opt_string(p, "workflowRun"):
			return false

	# plans/P4-01.md §2.2: §2.3 applies to `kind: pack` and §2.4 to `kind: app`; a record of any
	# other kind keeps the common claims only.
	if doc["kind"] == "pack":
		return PKeyPackClaims.pack_record_claims(doc, nw)
	if doc["kind"] == "app" and doc.has("content") and not PKeyPackClaims.content_claims(doc["content"], nw, "/content"):
		return false

	if not doc.has("builds"):
		return doc["kind"] != "app"
	var builds = doc["builds"]
	if not (builds is Array) or builds.size() < 1 or builds.size() > MAX_BUILDS:
		return false
	var ids := {}
	for i in builds.size():
		var build = builds[i]
		if not (build is Dictionary):
			return false
		if not PKeyClaims.matches_whole_re(_build_id_re, build.get("id")):
			return false
		if ids.has(build["id"]):
			return false
		ids[build["id"]] = true
		if not _non_empty(build.get("platform")) or not _non_empty(build.get("arch")) or not _non_empty(build.get("format")):
			return false
		if not _opt_string(build, "buildNumber") or not _opt_string(build, "minOS"):
			return false
		if build.has("requires") and not (build["requires"] is Dictionary):
			return false
		var artifacts = build.get("artifacts")
		if not (artifacts is Array) or artifacts.size() > MAX_ARTIFACTS:
			return false
		var payloads := 0
		for j in artifacts.size():
			var artifact = artifacts[j]
			if not (artifact is Dictionary):
				return false
			if not _non_empty(artifact.get("name")) or not _non_empty(artifact.get("role")):
				return false
			if artifact["role"] == "payload":
				payloads += 1
			if not PKeyClaims.matches_whole_re(_sha256_re, artifact.get("sha256")):
				return false
			if not PKeyClaims.is_wire_integer(artifact.get("size"), "/builds/%d/artifacts/%d/size" % [i, j], 0, nw):
				return false
			if not _opt_string(artifact, "contentType"):
				return false
		if payloads > 1:
			return false
		if doc["kind"] == "app" and build.has("embeds") and not PKeyPackClaims.embeds_ok(build["embeds"]):
			return false
	return true


## Client step 14 over a verified record payload: true when every claim of §2.4 holds. A caller
## holding a parsed JWS passes PKeyJws' `non_wire_integers`; one checking an object it built
## passes none. Reserved and unknown kinds pass here; the cross-check refuses them where an app
## record is expected. `opts`: {expected_aud, non_wire_integers?}.
static func release_record_claims(payload: Variant, opts: Dictionary) -> bool:
	_ready_res()
	if not (payload is Dictionary):
		return false
	var nw = opts.get("non_wire_integers")
	return _claims_ok(payload, String(opts.get("expected_aud", "")), nw if nw is PKeyJson.PointerSet else null)


## The record hash (WIRE-CONTRACT-V4 §8): the lowercase hex SHA-256 of the body exactly as
## received. `body` is the raw PackedByteArray, or a String (hashed as its UTF-8 bytes).
static func record_hash(body: Variant) -> String:
	var bytes: PackedByteArray = body if body is PackedByteArray else String(body).to_utf8_buffer()
	return sha256_hex(bytes)


## Lowercase hex SHA-256 through the engine's HashingContext.
static func sha256_hex(bytes: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	if not bytes.is_empty():
		ctx.update(bytes)
	return ctx.finish().hex_encode()


## The protected header's `kid`, read without trusting anything else in it (PKeyJws re-reads
## the header strictly). null when there is none to read.
static func _header_kid(jws: String) -> Variant:
	var enc := jws.get_slice(".", 0)
	if enc == "":
		return null
	var raw = PKeyB64Url.decode_strict(enc)
	if raw == null:
		return null
	var parsed := PKeyJson.parse_bytes(raw)
	if not parsed["ok"] or not (parsed["value"] is Dictionary) or not (parsed["value"].get("kid") is String):
		return null
	return parsed["value"]["kid"]


static func _fail(step: String) -> Dictionary:
	return {"ok": false, "step": step}


## Client steps 12–15 (a coroutine), in the contract's order:
##   12. a body over 88 844 bytes or with a byte outside ASCII is refused without hashing;
##       otherwise its SHA-256 must equal `expected_hash`, before any Ed25519 work;
##   13. the key is chosen by `kid` from `release_keys` only, refused when its raw bytes are also
##       in `product_trust`; then PKeyJws with that ONE key and `typ` `pkey-release+jws`;
##   14. the claims (release_record_claims);
##   15. with a `pin` ({kind?, deliverable, version, seq}): `kind` equals the pin's (`app` when
##       the pin names none; `pack` for a content stamp's pin, plans/P4-01.md §2.6), and
##       `deliverable`, `version` and `seq` equal the pin's.
## `body`: a PackedByteArray (the HTTP body) or a String. `opts`: {release_keys, product_trust,
## expected_aud, expected_hash, pin?, offload?}.
static func verify_release_record(body: Variant, opts: Dictionary) -> Dictionary:
	# 12. Hash before signature.
	if not (body is String or body is PackedByteArray):
		return _fail(STEP_HASH)
	var bytes: PackedByteArray = body if body is PackedByteArray else (body as String).to_utf8_buffer()
	if bytes.size() > MAX_RECORD_JWS_BYTES:
		return _fail(STEP_HASH)
	for b in bytes:
		if b > 0x7F:
			return _fail(STEP_HASH)
	if sha256_hex(bytes) != String(opts.get("expected_hash", "")):
		return _fail(STEP_HASH)
	var jws := bytes.get_string_from_ascii()

	# 13. The pinned release keys only, and never a product key.
	var release_keys = opts.get("release_keys")
	var kid = _header_kid(jws)
	if kid == null or not (release_keys is Dictionary) or not release_keys.has(kid) or not (release_keys[kid] is String):
		return _fail(STEP_JWS)
	var key: String = release_keys[kid]
	var raw = PKeyB64Url.decode_lenient(key)
	if raw == null:
		return _fail(STEP_JWS)
	var product_trust = opts.get("product_trust", {})
	if product_trust is Dictionary:
		for pk in product_trust:
			var value = product_trust[pk]
			if value is String:
				var other = PKeyB64Url.decode_lenient(value)
				if other != null and other == raw:
					return _fail(STEP_JWS)
	var v = await PKeyJws.verify_async(jws, {kid: key}, PKeyClaims.TYP_RELEASE, 0, PKeyClaims.is_true(opts.get("offload", false)))
	if v == null:
		return _fail(STEP_JWS)

	# 14. The claims.
	if not release_record_claims(v["payload"], {"expected_aud": opts.get("expected_aud", ""), "non_wire_integers": v["non_wire_integers"]}):
		return _fail(STEP_CLAIMS)
	var record: Dictionary = v["payload"]

	# 15. The cross-check against the pin.
	var pin = opts.get("pin")
	if pin is Dictionary:
		var want_kind: String = pin["kind"] if pin.get("kind") is String else "app"
		if record["kind"] != want_kind or not (pin.get("deliverable") is String) or record["deliverable"] != pin["deliverable"]:
			return _fail(STEP_CROSS_CHECK)
		if not (pin.get("version") is String) or record["version"] != pin["version"]:
			return _fail(STEP_CROSS_CHECK)
		if not PKeyClaims.is_number(pin.get("seq")) or float(record["seq"]) != float(pin["seq"]):
			return _fail(STEP_CROSS_CHECK)
	return {"ok": true, "record": record}


## The reload path for `releaseRecords` (a coroutine): each `cached[h]` goes through steps 12–14
## with `h` as the pin, and is kept only when `pinned` (the hashes a surviving committed feed's
## target for this platform pins) holds `h`. `opts`: {release_keys, product_trust, expected_aud,
## pinned: Dictionary used as a set}. Returns {h: {jws, record}}.
static func reload_release_records(cached: Variant, opts: Dictionary) -> Dictionary:
	var out := {}
	if not (cached is Dictionary):
		return out
	var pinned: Dictionary = opts.get("pinned", {})
	for h in cached:
		if not (h is String) or not (cached[h] is String) or not pinned.has(h):
			continue
		var r := await verify_release_record(cached[h], {
			"release_keys": opts.get("release_keys", {}),
			"product_trust": opts.get("product_trust", {}),
			"expected_aud": opts.get("expected_aud", ""),
			"expected_hash": h,
			"offload": opts.get("offload", false),
		})
		if r["ok"]:
			out[h] = {"jws": cached[h], "record": r["record"]}
	return out
