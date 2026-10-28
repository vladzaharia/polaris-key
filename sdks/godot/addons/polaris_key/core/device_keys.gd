class_name PKeyDeviceKeys
extends RefCounted
## The `pkey-proof/1` signer and the keys registration request (CC-26.6; plans/CC-01.md R-5,
## R-6). Pure: the host supplies a key port (PKeyDeviceKeyStore, or any object with `ensure`,
## `public_keys`, `sign`, `persistence` returning PKeyResult as that store does) and this file
## builds the bytes to sign, signs them through the port and checks the result against the
## strict verifier (PKeyDeviceProof.verify) before returning it. The private halves stay inside
## the port: nothing here asks for them. Mirrors client-core `deviceKeys.ts` and the Python
## `polaris_key.core.device_keys`.
##
## Every call answers a PKeyResult. A proof that could not be built or did not verify is
## PROOF_INVALID; the text never names a key or a signature.

const PROOF_INVALID := &"device-proof-invalid"
const _PRODUCT_RE := "\\A[a-z0-9][a-z0-9-]{0,63}\\z"

static var _product_re: RegEx


static func _static_init() -> void:
	_product_re = RegEx.create_from_string(_PRODUCT_RE)


static func _invalid(why: String) -> PKeyResult:
	return PKeyResult.failure(PROOF_INVALID, "device proof: " + why)


static func _now() -> int:
	return int(Time.get_unix_time_from_system())


## Builds the `pkey-proof/1` message for `opts.purpose`, signs it through the port and answers
## the re-verified proof as ok, detail {purpose, product, device_id, value, token_hash,
## sign_key, sig}. `opts`: purpose, product, device_id, value, token_hash (default "-"), now
## (epoch seconds, default the clock) and verify (a test seam, see PKeyDeviceProof.verify).
## Purpose `keys` goes through sign_keys_proof.
static func sign_device_proof(port: Object, opts: Dictionary) -> PKeyResult:
	if opts.get("purpose") == "keys":
		return _invalid("use sign_keys_proof for keys")
	var fields := {
		"purpose": opts.get("purpose"),
		"product": opts.get("product"),
		"device_id": opts.get("device_id"),
		"value": opts.get("value"),
		"token_hash": opts.get("token_hash", "-"),
	}
	return _sign_any(port, fields, opts.get("now", _now()), opts.get("verify", Callable()))


static func _sign_any(port: Object, fields: Dictionary, now: int, verify_fn: Callable) -> PKeyResult:
	var before: PKeyResult = port.ensure()
	if not before.ok:
		return before
	var msg = PKeyDeviceProof.message(fields)
	if msg == null:
		return _invalid("bad field")
	var signed: PKeyResult = port.sign(msg)
	if not signed.ok:
		return signed
	var after: PKeyResult = port.public_keys()
	if not after.ok:
		return after
	var b: Dictionary = before.detail
	if after.detail == null or after.detail["sign_key"] != b["sign_key"] or after.detail["generation"] != b["generation"]:
		return _invalid("keys changed while signing")
	var proof := fields.duplicate()
	proof["sign_key"] = b["sign_key"]
	proof["sig"] = PKeyB64Url.encode(signed.detail)
	if not PKeyDeviceProof.verify(proof, now, verify_fn):
		return _invalid("did not verify")
	return PKeyResult.success(proof)


## The `keys` proof: the value names the port's own sign and agree keys and `issued_at`.
## `opts`: product, device_id, issued_at (default the clock), allow_ephemeral (sign although
## the keys die with the process), verify. ok, detail {proof, keys, issued_at}. Refuses a
## memory-only port unless `allow_ephemeral` (`unsupported`).
static func sign_keys_proof(port: Object, opts: Dictionary) -> PKeyResult:
	var product = opts.get("product")
	if not (product is String) or _product_re.search(product) == null:
		return _invalid("bad product")
	if not opts.get("allow_ephemeral", false) and port.has_method("persistence") and port.persistence() == "memory":
		return PKeyResult.unsupported("core.devicekeys", PKeyConstants.UnsupportedReason.RUNTIME, "memory-only")
	var at: Variant = opts.get("issued_at", _now())
	if not (at is int) or at < 0:
		return _invalid("bad issued_at")
	var ens: PKeyResult = port.ensure()
	if not ens.ok:
		return ens
	var keys: Dictionary = ens.detail
	var fields := {
		"purpose": "keys",
		"product": product,
		"device_id": opts.get("device_id"),
		"value": PKeyDeviceProof.keys_value(keys["sign_key"], keys["agree_key"], at),
		"token_hash": "-",
	}
	var r := _sign_any(port, fields, at, opts.get("verify", Callable()))
	if not r.ok:
		return r
	if r.detail["sign_key"] != keys["sign_key"]:
		return _invalid("keys changed while signing")
	return PKeyResult.success({"proof": r.detail, "keys": keys, "issued_at": at})


## The request for `PUT <base>/<product>/devices/keys` for the port's keys, as ok, detail
## {path, body}. `body` is {signKey, agreeKey, issuedAt, sig}; `sig` is the `keys` proof. The
## caller sends it with the device bearer and `X-PKey-Device` (PKeyDevices.register_keys does);
## resending it is safe. `opts` as sign_keys_proof.
static func build_keys_request(port: Object, opts: Dictionary) -> PKeyResult:
	var r := sign_keys_proof(port, opts)
	if not r.ok:
		return r
	var d: Dictionary = r.detail
	return PKeyResult.success({
		"path": "/%s/devices/keys" % opts["product"],
		"body": {
			"signKey": d["keys"]["sign_key"],
			"agreeKey": d["keys"]["agree_key"],
			"issuedAt": d["issued_at"],
			"sig": d["proof"]["sig"],
		},
	})
