@tool
class_name PKeyJws
extends RefCounted
## Compact-JWS verify (WIRE-CONTRACT-V3 §1, §10): a port of packages/shared-jws `verifyJws`, in
## the frozen 13-step order (notes/A2 §1.1):
##
##    1. split into exactly three parts
##   2–3. bound the ENCODED header (b64Cap(1024)) and payload (b64Cap(cap)) before decoding;
##        the cap is max(65536, requested), so a caller can only raise it
##   4–6. strict base64url header, ≤ 1024 bytes, strict JSON (PKeyJson: no duplicate keys),
##        must be an object
##    7. alg == "EdDSA"
##    8. typ == the call site's typ when one is named; a present typ must be a string
##    9. kid is a string
##   10. the key is trust[kid] (never from the document): raw 32-byte Ed25519, base64url
##   11. strict base64url signature
##   12. Ed25519 over the bytes of "<header>.<payload>" exactly as received
##   13. ONLY THEN decode the payload, apply the cap and parse it strictly
##
## Returns {"kid": String, "payload": Variant}, or null on ANY failure.
##
## Steps 1–11 are `prepare`, step 12 is a `PKeyEd25519Job`, step 13 is `finish`. `verify` runs
## them inline. `verify_async` (a coroutine) runs step 12 on `WorkerThreadPool` when the
## signing input is over 4 KB (or when asked to: every verify during gameplay) and the build has
## threads, and slices it across frames when it has none (S-04).
##
## The per-kid cache keeps each trusted key decompressed with its odd-multiple table
## (PKeyEd25519.prepare_key), keyed by the key BYTES so a kid that names other bytes in another
## trust set can never reuse a stale entry.

const MAX_DOC_BYTES := 65536
const MAX_HEADER_BYTES := 1024
const MAX_BUNDLE_BYTES := 262144
## Signing inputs above this size leave the calling thread in `verify_async`.
const OFFLOAD_BYTES := 4096
const _KEY_CACHE_MAX := 32

enum Mode { AUTO, INLINE, THREAD, SLICED }

## How `verify_async` runs step 12. AUTO: inline up to OFFLOAD_BYTES unless offload is asked
## for, then a worker thread where `OS.has_feature("threads")`, else frame slices. The others
## force one path (tests and the profile suite).
static var mode: Mode = Mode.AUTO
## The per-frame budget for sliced verification, in microseconds (default 6 ms; 4–8 ms).
static var slice_budget_usec := 6000
static var _keys: Dictionary = {}


## Sets the slice budget, clamped to 4–8 ms.
static func set_slice_budget_ms(ms: float) -> void:
	slice_budget_usec = int(clampf(ms, 4.0, 8.0) * 1000.0)


static func clear_key_cache() -> void:
	_keys.clear()


static func _b64cap(n: int) -> int:
	return int(ceil(n * 4.0 / 3.0)) + 4


## Synchronous verify. `fast = false` uses the TweetNaCl-style reference verifier for step 12.
static func verify(jws: String, trust: Dictionary, typ: String = "", max_payload_bytes: int = 0, fast := true) -> Variant:
	var p = prepare(jws, trust, typ, max_payload_bytes)
	if p == null:
		return null
	var ok: bool
	if fast:
		var job := PKeyEd25519Job.new(p["sig"], p["input"], p["key"])
		job.run()
		ok = job.ok
	else:
		ok = PKeyEd25519Ref.verify(p["sig"], p["input"], p["key"][0])
	return finish(p) if ok else null


## Coroutine verify: step 12 leaves the calling thread for big inputs, or for every input when
## `offload` is true. Same result as `verify`.
static func verify_async(jws: String, trust: Dictionary, typ: String = "", max_payload_bytes: int = 0, offload := false) -> Variant:
	var p = prepare(jws, trust, typ, max_payload_bytes)
	if p == null:
		return null
	var job := PKeyEd25519Job.new(p["sig"], p["input"], p["key"])
	await run_job(job, offload or (p["input"] as PackedByteArray).size() > OFFLOAD_BYTES)
	return finish(p) if job.ok else null


## Runs `job` per `mode`: inline, on a worker thread, or in frame slices.
static func run_job(job: PKeyEd25519Job, offload: bool) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var how := mode
	if how == Mode.AUTO:
		if not offload:
			how = Mode.INLINE
		elif OS.has_feature("threads"):
			how = Mode.THREAD
		else:
			how = Mode.SLICED
	if tree == null:
		how = Mode.INLINE
	match how:
		Mode.THREAD:
			var id := WorkerThreadPool.add_task(job.run, false, "PolarisKey verify")
			while not WorkerThreadPool.is_task_completed(id):
				await tree.process_frame
			WorkerThreadPool.wait_for_task_completion(id)
		Mode.SLICED:
			while not job.step(slice_budget_usec):
				await tree.process_frame
		_:
			job.run()


## Steps 1–11. Returns the pending verification (a Dictionary: kid, sig, input, key, payload
## segment and cap) or null.
static func prepare(jws: String, trust: Dictionary, typ: String = "", max_payload_bytes: int = 0) -> Variant:
	var parts := jws.split(".", true)
	if parts.size() != 3:
		return null
	var enc_header: String = parts[0]
	var enc_payload: String = parts[1]
	var enc_sig: String = parts[2]

	var payload_cap: int = maxi(MAX_DOC_BYTES, max_payload_bytes)
	if enc_header.length() > _b64cap(MAX_HEADER_BYTES):
		return null
	if enc_payload.length() > _b64cap(payload_cap):
		return null

	var header_bytes = PKeyB64Url.decode_strict(enc_header)
	if header_bytes == null or (header_bytes as PackedByteArray).size() > MAX_HEADER_BYTES:
		return null
	var parsed := PKeyJson.parse_bytes(header_bytes)
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return null
	var header: Dictionary = parsed["value"]

	if not (header.get("alg") is String) or header["alg"] != "EdDSA":
		return null
	if typ != "" and (not (header.get("typ") is String) or header["typ"] != typ):
		return null
	if header.has("typ") and not (header["typ"] is String):
		return null
	if not (header.get("kid") is String):
		return null
	var kid: String = header["kid"]
	if not (trust.get(kid) is String) or trust[kid] == "":
		return null
	var key := _prepared_key(trust[kid])
	if key.is_empty():
		return null

	var sig = PKeyB64Url.decode_strict(enc_sig)
	if sig == null:
		return null
	return {
		"kid": kid,
		"sig": sig,
		"input": (enc_header + "." + enc_payload).to_utf8_buffer(),
		"key": key,
		"payload": enc_payload,
		"cap": payload_cap,
	}


## Step 13, for a pending verification whose signature has verified.
static func finish(p: Dictionary) -> Variant:
	var payload_bytes = PKeyB64Url.decode_strict(p["payload"])
	if payload_bytes == null or (payload_bytes as PackedByteArray).size() > int(p["cap"]):
		return null
	var parsed := PKeyJson.parse_bytes(payload_bytes)
	if not parsed["ok"] or parsed["value"] == null:
		return null
	return {"kid": p["kid"], "payload": parsed["value"]}


## The trust-set value decoded (leniently, as shared-jws `importVerifyKey` does) and prepared
## once per key. [] when it is not a valid Ed25519 public key.
static func _prepared_key(encoded: String) -> Array:
	var raw = PKeyB64Url.decode_lenient(encoded)
	if raw == null or (raw as PackedByteArray).size() != 32:
		return []
	var id := (raw as PackedByteArray).hex_encode()
	if _keys.has(id):
		return _keys[id]
	var key := PKeyEd25519.prepare_key(raw)
	if _keys.size() >= _KEY_CACHE_MAX:
		_keys.clear()
	_keys[id] = key
	return key
