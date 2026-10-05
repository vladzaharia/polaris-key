class_name PKeyLicenseEndpoints
extends RefCounted
## The License service's mint and release routes (WIRE-CONTRACT-V3 §5; sdk-node
## `license/endpoints.ts`): `POST /<p>/license/{activate,enroll,token,deauthorize}`. Pure
## transport: each builds the request through PKeyCore.request (so every call carries the seven
## X-PKey-* headers and the deadline) and maps the answer. Verification, the cache and the gate
## live elsewhere on purpose.
##
## activate, enroll and token share one response ladder and return
## [PKeyActivationResult, token: String] (the token is "" unless the result is ok). The body is
## omitted entirely when there is no fingerprint, so a host that opted out sends the same bytes
## as one with nothing to report.


## `POST /<p>/license/activate` with the licence key as the bearer. A coroutine.
static func activate(core: PKeyCore, key: String, fingerprint: Variant) -> Array:
	return await _activation_like(core, "license/activate", {"Authorization": "Bearer %s" % key}, fingerprint)


## `POST /<p>/license/enroll`: keyless, no Authorization; a product without a free tier answers
## 404 (`enroll-disabled`). A coroutine.
static func enroll(core: PKeyCore, fingerprint: Variant) -> Array:
	return await _activation_like(core, "license/enroll", {}, fingerprint)


## `POST /<p>/license/token` with the current device token: the licensed device's §5 re-acquire.
## A coroutine.
static func token(core: PKeyCore, current: String) -> Array:
	return await _activation_like(core, "license/token", {"Authorization": "Bearer %s" % current}, null)


## `POST /<p>/license/deauthorize`: release this device's seat. The caller treats it as
## best-effort (the local wipe is what it depends on). A coroutine.
static func deauthorize(core: PKeyCore, current: String) -> PKeyResult:
	return await core.request("POST", "license/deauthorize", null, false, {"Authorization": "Bearer %s" % current})


static func _activation_like(core: PKeyCore, path: String, auth: Dictionary, fingerprint: Variant) -> Array:
	var body = {"fingerprint": fingerprint} if fingerprint is Dictionary else null
	# PX-W13 §8 Q2: the device label, on activation only (never enroll or token rotation).
	if path == "license/activate":
		var label := PKeyDeviceLabel.resolve("", core.options)
		if label != "":
			if body == null:
				body = {}
			body["deviceName"] = label
	var r := await core.request("POST", path, body, false, auth)
	return map_response(r, path == "license/enroll")


## The shared ladder over one PKeyCore.request result: [PKeyActivationResult, token].
static func map_response(r: PKeyResult, is_enroll := false) -> Array:
	var status := int(r.detail.get("status", 0)) if r.detail is Dictionary else 0
	if status == 0:
		return [PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, r.code, r.message), ""]
	if r.ok:
		var parsed := PKeyJson.parse_bytes(r.detail["body"])
		var v = parsed["value"] if parsed["ok"] else null
		if status == 200 and v is Dictionary and v.get("token") is String and String(v["token"]).begins_with("pkeyt_"):
			var ok := PKeyActivationResult.of(PKeyActivationResult.KIND_OK, &"", "", status)
			if PKeyClaims.is_number(v.get("schemaVersion")):
				ok.schema_version = int(v["schemaVersion"])
			return [ok, v["token"]]
		return [PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.INVALID_RESPONSE, "The server answered %d without a usable token." % status, status), ""]
	var e: Dictionary = r.detail["error"] if r.detail.get("error") is Dictionary else PKeyErrors.read_body(PackedByteArray())
	var wire: String = e["code"]
	var top: Dictionary = e["body"]
	var nested: Dictionary = top["error"] if top.get("error") is Dictionary else {}
	var res: PKeyActivationResult
	match status:
		401:
			res = _wire(PKeyActivationResult.KIND_UNAUTHORIZED, wire, PKeyErrors.UNAUTHORIZED, r.message, status)
		409:
			res = _wire(PKeyActivationResult.KIND_HARDWARE_MISMATCH, wire, PKeyErrors.HARDWARE_MISMATCH, r.message, status)
			res.drift = _int_or_null(_field(top, nested, "drift"))
			var changed = _field(top, nested, "changed")
			if changed is Array:
				res.changed = changed.filter(func(c): return c is String)
		403:
			match wire:
				"fingerprint_required":
					res = _wire(PKeyActivationResult.KIND_FINGERPRINT_REQUIRED, wire, PKeyErrors.FINGERPRINT_REQUIRED, r.message, status)
				"enroll_claimed":
					res = _wire(PKeyActivationResult.KIND_ENROLL_CLAIMED, wire, PKeyErrors.ENROLL_CLAIMED, r.message, status)
				"license_disabled":
					res = _wire(PKeyActivationResult.KIND_LICENSE_DISABLED, wire, PKeyErrors.LICENSE_DISABLED, r.message, status)
				"device_limit", "":
					res = _wire(PKeyActivationResult.KIND_DEVICE_LIMIT, wire, PKeyErrors.DEVICE_LIMIT, r.message, status)
					res.limit = _int_or_null(_field(top, nested, "limit"))
					res.device_count = _int_or_null(_field(top, nested, "deviceCount"))
				_:
					res = _wire(PKeyActivationResult.KIND_ERROR, wire, PKeyErrors.FORBIDDEN, r.message, status)
		404:
			var kind := PKeyActivationResult.KIND_ENROLL_DISABLED if is_enroll else PKeyActivationResult.KIND_ERROR
			res = _wire(kind, wire, PKeyErrors.ENROLL_DISABLED if is_enroll else PKeyErrors.NOT_FOUND, r.message, status)
		429:
			res = _wire(PKeyActivationResult.KIND_RATE_LIMITED, wire, PKeyErrors.RATE_LIMITED, r.message, status)
		_:
			res = _wire(PKeyActivationResult.KIND_ERROR, wire, PKeyErrors.HTTP_ERROR, r.message, status)
	return [res, ""]


## The server's own code when it sent one, else `fallback`.
static func _wire(kind: StringName, wire: String, fallback: StringName, message: String, status: int) -> PKeyActivationResult:
	return PKeyActivationResult.of(kind, StringName(wire) if wire != "" else fallback, message, status)


## An extra field from the top level (where the Worker puts it), else from inside a nested
## `error` object.
static func _field(top: Dictionary, nested: Dictionary, key: String) -> Variant:
	if top.get(key) != null:
		return top[key]
	return nested.get(key)


static func _int_or_null(v: Variant) -> Variant:
	return int(v) if PKeyClaims.is_number(v) else null
