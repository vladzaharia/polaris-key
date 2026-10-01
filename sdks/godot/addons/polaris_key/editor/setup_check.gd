class_name PKeySetupCheck
extends RefCounted
## The setup dock's logic (editor/setup_dock.gd), kept free of editor classes so the test runner
## exercises it on the editor binary and on a release template alike.
##
## "Check" fetches the product's discovery document and its `/.well-known/polaris-trust.jws`, and
## verifies the manifest against the PASTED pins only (PKeyTrust.verify_manifest, P1-02's code):
## a manifest signed by another key, or for another product, is refused. Pins are compiled in,
## never learned (notes/A2 §1.5): discovery's `trust.pinnedKeys` come back as `candidates` the
## dock may pre-fill, and saving any pins needs an explicit confirmation that they match
## `pkey trust` or the console.

const FINGERPRINT_BYTES := 16


## The pins in pasted text: a JSON object of kid -> base64url key, or any snippet `pkey trust`
## prints around one (`const PINNED_TRUST_KEYS := {...}`, `trust_keys = {...}`). The first
## `{…}` span that is such an object wins. {ok, pins, message}.
static func parse_pins(text: String) -> Dictionary:
	var t := text.strip_edges()
	if t == "":
		return {"ok": false, "pins": {}, "message": "Paste the pinned trust keys printed by `pkey trust`."}
	var starts: Array[int] = []
	var ends: Array[int] = []
	for i in t.length():
		if t[i] == "{":
			starts.append(i)
		elif t[i] == "}":
			ends.push_front(i)
	for s in starts:
		for e in ends:
			if e <= s:
				break
			var parsed := PKeyJson.parse(t.substr(s, e - s + 1))
			if not parsed["ok"] or not (parsed["value"] is Dictionary) or parsed["value"].is_empty():
				continue
			var pins: Dictionary = parsed["value"]
			var bad := ""
			for kid in pins:
				if not (pins[kid] is String) or PKeyB64Url.decode_lenient(pins[kid]) == null or (PKeyB64Url.decode_lenient(pins[kid]) as PackedByteArray).size() != 32:
					bad = str(kid)
					break
			if bad != "":
				return {"ok": false, "pins": {}, "message": "The key for '%s' is not a 32-byte base64url Ed25519 public key." % bad}
			return {"ok": true, "pins": pins, "message": ""}
	return {"ok": false, "pins": {}, "message": "No {\"kid\": \"key\"} object found in the pasted text."}


## `aa:bb:…`: the first FINGERPRINT_BYTES of SHA-256 over the raw public key, or "" when the key
## does not decode.
static func fingerprint(public_key: String) -> String:
	var raw = PKeyB64Url.decode_lenient(public_key)
	if not (raw is PackedByteArray) or (raw as PackedByteArray).is_empty():
		return ""
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(raw)
	var digest := ctx.finish().slice(0, FINGERPRINT_BYTES)
	var parts := PackedStringArray()
	for b in digest:
		parts.append("%02x" % b)
	return ":".join(parts)


## The unverified `aud` of a compact JWS payload, or "" (only to explain a refusal).
static func _claimed_aud(jws: String) -> String:
	var parts := jws.split(".")
	if parts.size() != 3:
		return ""
	var raw = PKeyB64Url.decode_lenient(parts[1])
	if not (raw is PackedByteArray):
		return ""
	var parsed := PKeyJson.parse((raw as PackedByteArray).get_string_from_utf8())
	if parsed["ok"] and parsed["value"] is Dictionary and parsed["value"].get("aud") is String:
		return parsed["value"]["aud"]
	return ""


## Check `pins` against the live trust manifest of `product` at `base_url`. A coroutine; `host`
## must be inside the scene tree (the dock, or a test's root). `now`: epoch seconds for the
## freshness check (default: the system clock).
## {ok, message, keys: [{kid, fingerprint, pinned, status}], candidates: {kid: key}}.
static func check(host: Node, base_url: String, product: String, pins: Dictionary, now := -1.0) -> Dictionary:
	var out := {"ok": false, "message": "", "keys": [], "candidates": {}}
	if not RegEx.create_from_string("\\A[a-z0-9][a-z0-9_-]*\\z").search(product):
		out["message"] = "The product must be a lower-case slug."
		return out
	var base := PKeyTransport.check_base_url(base_url)
	if not base.ok:
		out["message"] = base.message
		return out
	var transport := PKeyTransport.new(host)
	transport.timeout = 15.0
	var root: String = base.detail
	var disc := await transport.request("GET", "%s/%s/.well-known/polaris.json" % [root, product.uri_encode()])
	if not disc.ok:
		out["message"] = "Discovery failed: %s" % disc.message
		return out
	if disc.detail["status"] != 200:
		out["message"] = "Discovery answered %d for '%s'." % [disc.detail["status"], product]
		return out
	var parsed := PKeyJson.parse_bytes(disc.detail["body"])
	if not parsed["ok"]:
		out["message"] = "Discovery is not valid JSON."
		return out
	var d := PKeyDiscovery.parse(parsed["value"], product)
	if d["kind"] != "ok":
		out["message"] = d["message"]
		return out
	var trust_block = parsed["value"].get("trust")
	if trust_block is Dictionary and trust_block.get("pinnedKeys") is Dictionary:
		for kid in trust_block["pinnedKeys"]:
			if kid is String and trust_block["pinnedKeys"][kid] is String:
				out["candidates"][kid] = trust_block["pinnedKeys"][kid]
	if pins.is_empty():
		out["message"] = "No pins to check. Paste the keys `pkey trust` prints, or fill the candidates from discovery and confirm them."
		return out
	var tr := await transport.request("GET", "%s/%s/.well-known/polaris-trust.jws" % [root, product.uri_encode()], {"Accept": "application/jose"})
	if not tr.ok or tr.detail["status"] != 200:
		out["message"] = "The trust manifest could not be fetched (%s)." % (tr.message if not tr.ok else "HTTP %d" % tr.detail["status"])
		return out
	var jws: String = (tr.detail["body"] as PackedByteArray).get_string_from_utf8().strip_edges()
	var opts := {"pinned": pins, "expected_aud": product}
	opts["now"] = now if now >= 0.0 else float(PKeyClaims.system_now())
	var v := await PKeyTrust.verify_manifest(jws, opts)
	if v["doc"] == null:
		var aud := _claimed_aud(jws)
		if aud != "" and aud != product:
			out["message"] = "Refused: the trust manifest is for product '%s', not '%s'." % [aud, product]
		else:
			out["message"] = "Refused: the trust manifest is not signed by a pasted key (or it is expired, or a pinned kid carries different bytes)."
		return out
	for key in v["doc"]["keys"]:
		var kid: String = key["kid"]
		out["keys"].append({
			"kid": kid,
			"fingerprint": fingerprint(key["publicKey"]),
			"pinned": pins.has(kid),
			"status": str(key.get("status", "active")),
		})
	out["ok"] = true
	out["message"] = "The trust manifest verifies against the pasted pins (%d key%s published)." % [out["keys"].size(), "" if out["keys"].size() == 1 else "s"]
	return out


## Write `res://polaris_key.tres` (or `path`): the existing PKeyOptions there with the dock's four
## fields replaced, so the rest of a hand-edited file survives. Refuses without `confirmed`.
## {ok, message}.
static func save(path: String, product: String, base_url: String, pins: Dictionary, editor_channel: String, confirmed: bool) -> Dictionary:
	if not confirmed:
		return {"ok": false, "message": "Confirm that the pins match `pkey trust` or the console before saving."}
	if not RegEx.create_from_string("\\A[a-z0-9][a-z0-9_-]*\\z").search(product):
		return {"ok": false, "message": "The product must be a lower-case slug."}
	var base := PKeyTransport.check_base_url(base_url)
	if not base.ok:
		return {"ok": false, "message": base.message}
	if editor_channel != "" and PKeyChannel.header_for(editor_channel, "1.0.0") == null:
		return {"ok": false, "message": "The editor channel must be a channel name (stable, beta, pr-<n>, dev or a manual channel)."}
	var opts: PKeyOptions = null
	if ResourceLoader.exists(path):
		var existing = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		if existing is PKeyOptions:
			opts = existing
	if opts == null:
		opts = PKeyOptions.new()
	opts.product = product
	opts.base_url = base.detail
	opts.pinned_trust_keys = pins.duplicate()
	opts.default_channel = editor_channel
	var err := ResourceSaver.save(opts, path)
	if err != OK:
		return {"ok": false, "message": "Could not write %s (error %d)." % [path, err]}
	return {"ok": true, "message": "Saved %s." % path}
