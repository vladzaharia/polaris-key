@tool
class_name PKeySyncRingState
extends RefCounted
## The served key ring state (`GET devices/keyring`) checked against the contract shape (V5 section 13.10):
## split out of PKeySyncRing. `parse` answers `{ring, wrap}` (each a Dictionary or null) or null.

## `{ring: Dictionary|null, wrap: Dictionary|null}` from the served body, or null for a body that is
## not in the contract shape.
static func parse(body: Variant) -> Variant:
	var b: Variant = _json(body)
	if b == null or not b.has("ring") or not b.has("wrap"):
		return null
	var ring: Variant = null
	var wrap: Variant = null
	if b["ring"] != null:
		ring = _ring(b["ring"])
		if ring == null:
			return null
	if b["wrap"] != null:
		wrap = _wrap(b["wrap"])
		if wrap == null:
			return null
	return {"ring": ring, "wrap": wrap}


static func _ring(r: Variant) -> Variant:
	if not (r is Dictionary):
		return null
	var rec: Variant = r.get("recovery")
	var adopted_in: Variant = r.get("adopted")
	if not (rec is Dictionary) or not (rec.get("set") is bool) or not (adopted_in is Array):
		return null
	if not (r.get("ringId") is String) or not _is_num(r.get("epoch")) or not (r.get("rootKid") is String) or not (r.get("state") is String) or not _is_num(r.get("createdAt")):
		return null
	var adopted: Array = []
	for a in adopted_in:
		if not (a is Dictionary) or not (a.get("ringId") is String) or not _is_num(a.get("epoch")) or not (a.get("kid") is String) or not (a.get("ct") is String):
			return null
		adopted.append({"ring_id": a["ringId"], "epoch": int(a["epoch"]), "kid": a["kid"], "ct": a["ct"]})
	var prev: Variant = null
	var p: Variant = r.get("previous")
	if p != null:
		if not (p is Dictionary) or not (p.get("ringId") is String) or not (p.get("kid") is String) or not _is_num(p.get("until")):
			return null
		prev = {"ring_id": p["ringId"], "kid": p["kid"], "until": int(p["until"])}
	return {
		"ring_id": r["ringId"],
		"epoch": int(r["epoch"]),
		"root_kid": r["rootKid"],
		"state": r["state"],
		"created_at": int(r["createdAt"]),
		"recovery_set": rec["set"],
		"adopted": adopted,
		"previous": prev,
	}


static func _wrap(w: Variant) -> Variant:
	if not (w is Dictionary):
		return null
	var kem: Variant = w.get("kem")
	if not (kem is String or _is_num(kem)) or not _is_num(w.get("epoch")) or not (w.get("kid") is String) or not (w.get("enc") is String) or not (w.get("ct") is String):
		return null
	return {"epoch": int(w["epoch"]), "kid": w["kid"], "kem": kem, "enc": w["enc"], "ct": w["ct"], "by": w.get("by") if w.get("by") is String else null}


static func _json(body: Variant) -> Variant:
	if not (body is PackedByteArray):
		return null
	var p := PKeyJson.parse_bytes(body)
	return p["value"] if p["ok"] and p["value"] is Dictionary else null


static func _is_num(v: Variant) -> bool:
	return v is int or v is float


## The wrap with every member checked (type, shape, size), as a fresh Dictionary; null when any is not.
static func wrap_members(w: Dictionary) -> Variant:
	var ring_id: Variant = w.get("ring_id")
	var epoch: Variant = w.get("epoch")
	var kid: Variant = w.get("kid")
	var kem: Variant = w.get("kem")
	var enc: Variant = w.get("enc")
	var ct: Variant = w.get("ct")
	if not (ring_id is String) or RegEx.create_from_string(PKeySyncRing.RING_ID_RE).search(ring_id) == null:
		return null
	if not _is_num(epoch) or float(epoch) != floorf(float(epoch)) or float(epoch) < 1.0 or float(epoch) > 9007199254740991.0:
		return null
	if not (kid is String) or (kid as String).length() != 32 or not _lower_hex(kid):
		return null
	if not ((kem is String and kem == "x25519") or (_is_num(kem) and float(kem) == float(PKeySyncHpke.KEM_X25519))):
		return null
	if not (enc is String) or not (ct is String):
		return null
	var enc_bytes: Variant = PKeyB64Url.decode_strict(enc)
	var ct_bytes: Variant = PKeyB64Url.decode_strict(ct)
	if enc_bytes == null or (enc_bytes as PackedByteArray).size() != PKeySyncHpke.ENC_BYTES:
		return null
	if ct_bytes == null or (ct_bytes as PackedByteArray).size() != PKeySyncWrap.WRAP_CT_BYTES:
		return null
	return {"ring_id": ring_id, "epoch": int(epoch), "kid": kid, "kem": kem, "enc": enc, "ct": ct}


static func _lower_hex(s: String) -> bool:
	for i in s.length():
		var c := s.unicode_at(i)
		if not ((c >= 48 and c <= 57) or (c >= 97 and c <= 102)):
			return false
	return true
