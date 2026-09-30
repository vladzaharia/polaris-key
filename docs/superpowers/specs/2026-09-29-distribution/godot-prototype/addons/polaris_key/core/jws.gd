extends RefCounted
## Polaris Key wire contract v3 — compact JWS (EdDSA) verification + v3 claim validation,
## ported from @polaris-key/jws + @polaris-key/client-core (verify.ts, trust.ts) to GDScript.
## Prototype for the Godot SDK; driven by conformance/corpus/v2 (run_corpus.gd).
##
## Normative order (WIRE-CONTRACT-V3 §1): split -> encoded caps -> strict b64url header ->
## header cap -> dup-key-rejecting parse -> alg -> typ -> kid -> trust[kid] -> strict b64url sig ->
## Ed25519 over ASCII(encHeader "." encPayload) -> ONLY THEN decode + parse the payload.

const Ed25519 := preload("res://addons/polaris_key/crypto/ed25519.gd")

const ISSUER := "key.plrs.im"
const MAX_DOC_BYTES := 65536
const MAX_HEADER_BYTES := 1024
const CLOCK_SKEW_SECONDS := 300
const MAX_GRACE_SECONDS := 31536000

static var _b64re: RegEx


static func _b64cap(n: int) -> int:
	return int(ceil(n * 4.0 / 3.0)) + 4


## Strict base64url (unpadded alphabet only). Returns null on any out-of-alphabet byte.
static func b64url_decode_strict(s: String) -> Variant:
	if _b64re == null:
		_b64re = RegEx.create_from_string("^[A-Za-z0-9_-]*$")
	if _b64re.search(s) == null:
		return null
	if s.length() % 4 == 1:
		return null
	var b := s.replace("-", "+").replace("_", "/")
	while b.length() % 4 != 0:
		b += "="
	if b == "":
		return PackedByteArray()
	return Marshalls.base64_to_raw(b)


## True if any JSON object in `text` declares the same key twice (port of shared-jws).
static func has_duplicate_keys(text: String) -> bool:
	var stack: Array = []
	var expect_key := false
	var i := 0
	var n := text.length()
	while i < n:
		var c := text[i]
		if c == "\"":
			i += 1
			var start := i
			while i < n:
				var ch := text[i]
				if ch == "\\":
					i += 2
					continue
				if ch == "\"":
					break
				i += 1
			var literal := text.substr(start, i - start)
			i += 1
			if expect_key:
				var top: Variant = stack.back() if not stack.is_empty() else null
				if top is Dictionary:
					var key: Variant = JSON.parse_string("\"" + literal + "\"")
					if key == null:
						return true
					if top.has(key):
						return true
					top[key] = true
				expect_key = false
			continue
		if c == "{":
			stack.append({})
			expect_key = true
		elif c == "[":
			stack.append(null)
			expect_key = false
		elif c == "}" or c == "]":
			if not stack.is_empty():
				stack.pop_back()
			expect_key = false
		elif c == ",":
			expect_key = not stack.is_empty() and stack.back() is Dictionary
		i += 1
	return false


static func _parse_strict(bytes: PackedByteArray) -> Variant:
	var text := bytes.get_string_from_utf8()
	if text == "" and bytes.size() > 0:
		return null
	if has_duplicate_keys(text):
		return null
	var j := JSON.new()
	if j.parse(text) != OK:
		return null
	return j.data


## Verify a compact JWS against `trust` ({kid: base64url raw pubkey}). Returns
## {"kid", "payload"} or {} on ANY failure. `typ` "" = no domain separation (never used).
static func verify_jws(jws: String, trust: Dictionary, typ: String, max_payload_bytes := 0) -> Dictionary:
	var parts := jws.split(".", true)
	if parts.size() != 3:
		return {}
	var enc_h := parts[0]
	var enc_p := parts[1]
	var enc_s := parts[2]
	var cap := maxi(MAX_DOC_BYTES, max_payload_bytes)
	if enc_h.length() > _b64cap(MAX_HEADER_BYTES) or enc_p.length() > _b64cap(cap):
		return {}
	var hb: Variant = b64url_decode_strict(enc_h)
	if hb == null or hb.size() > MAX_HEADER_BYTES:
		return {}
	var header: Variant = _parse_strict(hb)
	if typeof(header) != TYPE_DICTIONARY:
		return {}
	if header.get("alg") != "EdDSA":
		return {}
	if typ != "" and header.get("typ") != typ:
		return {}
	if header.has("typ") and typeof(header["typ"]) != TYPE_STRING:
		return {}
	if typeof(header.get("kid")) != TYPE_STRING:
		return {}
	var kid: String = header["kid"]
	if not trust.has(kid):
		return {}
	var pub: Variant = b64url_decode_strict(String(trust[kid]))
	if pub == null or pub.size() != 32:
		return {}
	var sig: Variant = b64url_decode_strict(enc_s)
	if sig == null:
		return {}
	if not Ed25519.verify(pub, (enc_h + "." + enc_p).to_ascii_buffer(), sig):
		return {}
	var pb: Variant = b64url_decode_strict(enc_p)
	if pb == null or pb.size() > cap:
		return {}
	var payload: Variant = _parse_strict(pb)
	if payload == null:
		return {}
	return {"kid": kid, "payload": payload}


static func _is_num(v: Variant) -> bool:
	return typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT


## v3 envelope + per-type claims (client-core verify.ts). opts: trust, expectedAud, expectedIss,
## deviceId, now, lastAcceptedIssuedAt, checkFreshness. Returns the payload or null.
static func verify_doc(jws: String, typ: String, opts: Dictionary) -> Variant:
	var v := verify_jws(jws, opts.get("trust", {}), typ)
	if v.is_empty():
		return null
	var doc: Variant = v["payload"]
	if typeof(doc) != TYPE_DICTIONARY:
		return null
	var now: float = float(opts.get("now", Time.get_unix_time_from_system()))
	if doc.get("aud") != opts.get("expectedAud"):
		return null
	var iss: Variant = opts.get("expectedIss")
	if doc.get("iss") != (ISSUER if iss == null else iss):
		return null
	if doc.get("deviceId") != opts.get("deviceId"):
		return null
	if not (_is_num(doc.get("issuedAt")) and _is_num(doc.get("expiresAt")) and _is_num(doc.get("graceUntil"))):
		return null
	var ia := float(doc["issuedAt"])
	var ea := float(doc["expiresAt"])
	var gu := float(doc["graceUntil"])
	var floor_v: Variant = opts.get("lastAcceptedIssuedAt")
	if floor_v != null and ia <= float(floor_v):
		return null
	if gu < ea or gu > ia + MAX_GRACE_SECONDS:
		return null
	if opts.get("checkFreshness", true) != false:
		if ia > now + CLOCK_SKEW_SECONDS or ea <= now - CLOCK_SKEW_SECONDS:
			return null
	if typ == "pkey-license+jws":
		if typeof(doc.get("licenseId")) != TYPE_STRING or doc["licenseId"] == "":
			return null
		if typeof(doc.get("entitlements")) != TYPE_DICTIONARY:
			return null
		if doc.has("profile") and typeof(doc["profile"]) != TYPE_DICTIONARY:
			return null
	elif typ == "pkey-config+jws":
		var sv: Variant = doc.get("schemaVersion")
		if not _is_num(sv) or float(sv) != floor(float(sv)) or float(sv) < 1:
			return null
		if typeof(doc.get("config")) != TYPE_DICTIONARY or typeof(doc.get("secrets")) != TYPE_DICTIONARY:
			return null
	return doc


## Trust manifest (client-core trust.ts): verified against PINS only. Returns
## {"doc": Dictionary|null, "discovered": {kid: key}}; discovered REPLACES the previous set.
static func verify_trust_manifest(jws: String, opts: Dictionary) -> Dictionary:
	var rejected := {"doc": null, "discovered": {}}
	var pinned: Dictionary = opts.get("pinned", {})
	var v := verify_jws(jws, pinned, "pkey-trust+jws")
	if v.is_empty():
		return rejected
	var doc: Variant = v["payload"]
	if typeof(doc) != TYPE_DICTIONARY:
		return rejected
	var now: float = float(opts.get("now", Time.get_unix_time_from_system()))
	if not _is_num(doc.get("schemaVersion")) or int(doc["schemaVersion"]) != 1:
		return rejected
	if doc.get("aud") != opts.get("expectedAud") or doc.get("iss") != opts.get("expectedIss", ISSUER):
		return rejected
	if not (_is_num(doc.get("issuedAt")) and _is_num(doc.get("expiresAt"))):
		return rejected
	var last: Variant = opts.get("lastTrustIssuedAt")
	if last != null and float(doc["issuedAt"]) <= float(last):
		return rejected
	if opts.get("checkFreshness", true) != false:
		if float(doc["issuedAt"]) > now + CLOCK_SKEW_SECONDS or float(doc["expiresAt"]) <= now - CLOCK_SKEW_SECONDS:
			return rejected
	if typeof(doc.get("keys")) != TYPE_ARRAY:
		return rejected
	var discovered := {}
	for key in doc["keys"]:
		if typeof(key) != TYPE_DICTIONARY:
			return rejected
		if typeof(key.get("kid")) != TYPE_STRING or typeof(key.get("publicKey")) != TYPE_STRING:
			return rejected
		if pinned.has(key["kid"]) and pinned[key["kid"]] != key["publicKey"]:
			return rejected
		if key.get("status") == "revoked":
			continue
		if key.get("alg") != "EdDSA" or key.get("kty") != "OKP" or key.get("crv") != "Ed25519":
			continue
		discovered[key["kid"]] = key["publicKey"]
	return {"doc": doc, "discovered": discovered}


static func merge_trust(pinned: Dictionary, discovered: Dictionary) -> Dictionary:
	var out := discovered.duplicate()
	out.merge(pinned, true)
	return out
