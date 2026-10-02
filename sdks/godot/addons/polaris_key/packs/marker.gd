class_name PKeyPackMarker
extends RefCounted
## The marker, `pkey-marker/1` (plans/P4-01.md §2.6, §2.8; WIRE-CONTRACT-V4 §3.7): the compact
## pack record beside an embedded single-file payload (`X.pkey.json`) or inside an embedded tree
## (`D/.pkey/pack.json`). A port of client-core `packs/marker.ts`; `cases.json#markerCases` pins
## `verify_marker`, and `match_embedded` is the host's byte match.

const MARKER_REJECTED := "marker-rejected"
const MAX_RECORD_JWS_BYTES := 88844


static func _refuse(step: String) -> Dictionary:
	return {"ok": false, "error": MARKER_REJECTED, "step": step}


## `verifyMarker(marker, opts)` (§2.6, V4 §3.7), in order: strict JSON (`format`); `format ==
## "pkey-marker/1"`, `packId` a pack id, `version` matching VERSION_RE, `release` a string
## (`format`); steps 12–14 with `release` as the body and its own SHA-256 as the pin hash (`hash`,
## `jws`, `claims`); `kind == "pack"`, `deliverable == packId`, `version == version`
## (`cross-check`). `opts`: {release_keys, product_trust, expected_aud, offload?}. A coroutine
## returning {ok: true, packId, version, record, recordSha256, release} or {ok: false, error:
## "marker-rejected", step}.
static func verify_marker(marker: Variant, opts: Dictionary) -> Dictionary:
	var bytes: PackedByteArray
	if marker is PackedByteArray:
		bytes = marker
	elif marker is String:
		bytes = (marker as String).to_utf8_buffer()
	else:
		return _refuse("format")
	var parsed = PKeyPackFiles.strict_parse(bytes)
	if parsed == null or not (parsed["value"] is Dictionary):
		return _refuse("format")
	var m: Dictionary = parsed["value"]
	if not PKeyPackClaims.same(m.get("format"), PKeyConstants.MARKER_FORMAT):
		return _refuse("format")
	if not PKeyPackClaims.is_pack_id(m.get("packId")):
		return _refuse("format")
	if not PKeyPackClaims.matches(PKeyPackClaims.VERSION_PATTERN, m.get("version")):
		return _refuse("format")
	if not (m.get("release") is String):
		return _refuse("format")
	var release: String = m["release"]
	var rb := release.to_utf8_buffer()
	if rb.size() != release.length() or release.length() > MAX_RECORD_JWS_BYTES:
		return _refuse("hash")
	for b in rb:
		if b > 0x7F:
			return _refuse("hash")
	var record_sha := PKeyPackClaims.sha256_hex(rb)
	var v: Dictionary = await PKeyReleaseRecord.verify_release_record(rb, {
		"release_keys": opts.get("release_keys", {}),
		"product_trust": opts.get("product_trust", {}),
		"expected_aud": opts.get("expected_aud", ""),
		"expected_hash": record_sha,
		"offload": opts.get("offload", false),
	})
	if not v["ok"]:
		return _refuse(v["step"])
	var record: Dictionary = v["record"]
	if not PKeyPackClaims.same(record.get("kind"), "pack") or not PKeyPackClaims.same(record.get("deliverable"), m["packId"]) or not PKeyPackClaims.same(record.get("version"), m["version"]):
		return _refuse("cross-check")
	return {"ok": true, "packId": m["packId"], "version": m["version"], "record": record, "recordSha256": record_sha, "release": release}


## The host's match of an embedded payload against its verified marker (§2.6): the variant whose
## `payload` the bytes match (`payload` {kind: "file", sha256, size} or {kind: "tree",
## treeDigest}), and, when the content stamp pins the pack, `recordSha256` equal to the pin's.
## {ok: true, variant} or {ok: false, error: "marker-rejected", step: "payload" | "pin"}.
static func match_embedded(verified: Dictionary, payload: Dictionary, stamp: Variant) -> Dictionary:
	var variants = verified["record"].get("variants", [])
	var index := -1
	for i in variants.size():
		var v = variants[i]
		var p = v.get("payload")
		if not (p is Dictionary):
			continue
		if payload.get("kind") == "file":
			if PKeyPackClaims.same(p.get("sha256"), payload.get("sha256")) and PKeyPackClaims.same(p.get("size"), payload.get("size")):
				index = i
				break
		elif v.get("files") is Dictionary and PKeyPackClaims.same(v["files"].get("layout"), "tree") and PKeyPackClaims.same(p.get("sha256"), payload.get("treeDigest")):
			index = i
			break
	if index < 0:
		return _refuse("payload")
	if stamp is Dictionary:
		for pin in stamp.get("pins", []):
			if PKeyPackClaims.same(pin.get("pack"), verified["packId"]):
				if not PKeyPackClaims.same(pin["release"].get("sha256"), verified["recordSha256"]):
					return _refuse("pin")
				break
	return {"ok": true, "variant": index}
