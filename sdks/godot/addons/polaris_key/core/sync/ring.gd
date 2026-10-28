@tool
class_name PKeySyncRing
extends RefCounted
## The Cloud Sync key ring client (U-40.6; WIRE-CONTRACT-V5 §13.10, §13.11): make the ring, hold its
## root `R`, wrap `R` to another device, set the recovery code and recover from it, reset, adopt,
## and seal and open values with the root's keys. Mirrors Swift's and Kotlin's `SyncKeyring`.
## Every verb is a coroutine returning a PKeyResult and is serialised (one at a time).
##
## Rules this file keeps:
##  * `R` is in memory and in one record (`PKeySyncRingVault`). It is in no result, error message,
##    log line or `str()`: every type that holds it prints as redacted. A restart gets it back from
##    the record, or through `unlock()`, which opens this device's own wrap.
##  * The device's agreement key never leaves its store: a wrap is opened through the store's `dh`.
##  * The recovery code is returned once, to the caller, and kept nowhere.
##  * A wrap or recovery blob is accepted only when `kid(R)` equals the ring's `rootKid`.
##  * The first root this client acquires (create, recover, unlock) pins `{ring_id, epoch,
##    root_kid}` before it is held: no root is held without a pin. A served ring that differs is
##    never opened: `unlock()` answers kind `ring-changed`, and only the recovery code (`recover`) or
##    an explicit `accept_ring_change` re-pins. `forget()` drops the pin and the stored root; the
##    sign-out hook calls it. The stored root is used only while it matches the pin.
##  * A bad recovery code is refused before any request.
##  * Host misuse (locked, a bad argument, no device keys) is a failure result, never an assert.
##
## The wire: `requester` is a coroutine `(method: String, path: String, body: Variant) -> PKeyResult`,
## ok with detail {status, body: PackedByteArray} for a 2xx, else a failure carrying the Worker's
## code. `for_core(core, keys, vault)` makes one over `PKeyCore.request` with the device token.
##
## Results (ok; `detail`):
##   status()                 {unlocked, ring_id, epoch, pinned, root_stored, root_persistence}
##   unlock(), accept_ring_change(confirmed)
##                            {kind: "unlocked", ring_id, epoch}
##                            {kind: "locked", reason: "no-ring" | "no-wrap" | "unusable-wrap"}
##                            {kind: "ring-changed", pinned, served, created_at, by}
##   create(), reset()        {ring_id, epoch, root_kid, recovery_code} (shown once; "" for none)
##   set_recovery_code()      the code text (shown once)
##   recover(text)            {ring_id, epoch, wrap_deposited}
##   open_adopted()           the ring ids opened (Array of String)
## A pin is `{ring_id, epoch, root_kid}` with `root_kid` lower-case hex.

const RING_ID_RE := "\\Arg_[A-Za-z0-9_-]{22}\\z"
const FEATURE := "sync.keyring"

var product: String
var device_id: String
var codec: Codec

var _requester: Callable
var _keys: Object
var _vault: PKeySyncRingVault
var _memory := _Memory.new()
var _ring: Dictionary = {}
var _busy := false
var _ring_id_re: RegEx


## The roots in memory, shared with the codec. Prints redacted.
class _Held extends RefCounted:
	var ring_id: String
	var epoch: int
	var kid: PackedByteArray
	var root: PackedByteArray

	func _init(p_ring_id: String, p_epoch: int, p_kid: PackedByteArray, p_root: PackedByteArray) -> void:
		ring_id = p_ring_id
		epoch = p_epoch
		kid = p_kid
		root = p_root

	func matches(p_ring_id: String, p_epoch: int, p_kid: PackedByteArray) -> bool:
		return ring_id == p_ring_id and epoch == p_epoch and PKeySyncAesGcm.equal_constant_time(kid, p_kid)

	func _to_string() -> String:
		return "HeldRoot(redacted)"


class _Memory extends RefCounted:
	var held: _Held = null
	var others: Array = []
	var listeners: Array[Callable] = []

	func set_held(h: _Held, p_others: Variant = null) -> void:
		held = h
		if p_others != null:
			others = p_others
		for l in listeners:
			if l.is_valid():
				l.call(held != null)

	func _to_string() -> String:
		return "RingMemory(redacted)"


## What the E2E machine's host seals and opens with. It holds no key: every call reads the ring's
## current root and refuses with `sync-locked` (an empty result) once locked.
class Codec extends RefCounted:
	var _m: _Memory

	func _init(m: _Memory) -> void:
		_m = m

	func _to_string() -> String:
		return "SyncCodec(locked=%s)" % locked()

	func locked() -> bool:
		return _m.held == null

	## The current root's `kid` as lower-case hex; "" while locked.
	func kid() -> String:
		return _m.held.kid.hex_encode() if _m.held != null else ""

	## The envelope, or an empty array while locked or for a value canonical JSON refuses.
	func seal(collection: String, name: Variant, value: Variant) -> PackedByteArray:
		if _m.held == null:
			return PackedByteArray()
		return PKeySyncEnvelope.seal_value(_m.held.root, collection, name, value)

	## `PKeySyncEnvelope.open_value`'s answer; `{"ok": false, "reason": "locked"}` while locked. Tries
	## the current root, then an adopted root whose kid the envelope names.
	func open(collection: String, name: Variant, envelope: PackedByteArray, aliases: Array = []) -> Dictionary:
		return _try(envelope, func(root: PackedByteArray) -> Dictionary: return PKeySyncEnvelope.open_value(root, collection, name, envelope, aliases))

	func open_any(collection: String, envelope: PackedByteArray) -> Dictionary:
		return _try(envelope, func(root: PackedByteArray) -> Dictionary: return PKeySyncEnvelope.open_value_any_name(root, collection, envelope))

	func blind(kind: String, ctx: String, name: String) -> String:
		if _m.held == null:
			return ""
		return PKeySyncBlind.blind(_m.held.root, kind, ctx, name)

	func _try(envelope: PackedByteArray, attempt: Callable) -> Dictionary:
		if _m.held == null:
			return {"ok": false, "reason": "locked"}
		var first: Dictionary = attempt.call(_m.held.root)
		if first["ok"] or first.get("reason") != "kid" or envelope.size() < 17:
			return first
		var kid := envelope.slice(1, 17)
		for o in _m.others:
			if PKeySyncAesGcm.equal_constant_time(o.kid, kid):
				var a: Dictionary = attempt.call(o.root)
				if a["ok"] or a.get("reason") != "kid":
					return a
		return first


## `keys` is a `PKeyDeviceKeyStore` (or any object with `ensure()` and `dh(peer)` answering the same
## PKeyResults). `vault` holds the pin and the root.
func _init(p_product: String, p_device_id: String, p_requester: Callable, p_keys: Object, p_vault: PKeySyncRingVault) -> void:
	product = p_product
	device_id = p_device_id
	_requester = p_requester
	_keys = p_keys
	_vault = p_vault
	_ring_id_re = RegEx.create_from_string(RING_ID_RE)
	codec = Codec.new(_memory)


func _to_string() -> String:
	return "PKeySyncRing"


## A ring over a started `PKeyCore`: requests carry the device token.
static func for_core(core: PKeyCore, keys: Object, vault: PKeySyncRingVault) -> PKeySyncRing:
	var req := func(method: String, path: String, body: Variant) -> PKeyResult:
		return await core.request(method, path, body, true)
	return PKeySyncRing.new(core.product, core.device_id, req, keys, vault)


# ── State ────────────────────────────────────────────────────────────────────────────────

## Whether this device holds a root right now.
func unlocked() -> bool:
	return _memory.held != null


## `listener(present: bool)` is told now, and on every unlock and lock. Returns a detach Callable.
func attach(listener: Callable) -> Callable:
	_memory.listeners.append(listener)
	listener.call(_memory.held != null)
	return func() -> void: _memory.listeners.erase(listener)


## What this device holds, with no request. A stored root that matches the pin is taken back first,
## so a restart is unlocked offline.
func status() -> PKeyResult:
	await _enter()
	var r := _status_locked()
	_leave()
	return r


func _status_locked() -> PKeyResult:
	var restored := _restore_stored()
	if not restored.ok:
		return restored
	var pin := _vault.read_pin()
	if not pin.ok:
		return pin
	var stored := _vault.read_root()
	var h := _memory.held
	return PKeyResult.success({
		"unlocked": h != null,
		"ring_id": h.ring_id if h != null else null,
		"epoch": h.epoch if h != null else null,
		"pinned": pin.detail,
		"root_stored": stored.ok and stored.detail != null,
		"root_persistence": _vault.persistence(),
	})


## The pinned ring, or ok with a null detail before this client first acquired a root.
func pin() -> PKeyResult:
	return _vault.read_pin()


## Forgets every root held in memory (quit). The stored root, the pin and the server's rows and
## wraps are untouched; `forget` is the sign-out.
func lock() -> void:
	_memory.set_held(null, [])
	_ring = {}


## Sign-out: forgets every root, in memory and in storage, and drops the pin, so the next person on
## this device starts clean. A record that cannot be deleted is a failure, so the sign-out stops.
func forget() -> PKeyResult:
	await _enter()
	lock()
	var r := _vault.clear()
	_leave()
	return r


# ── Reads ────────────────────────────────────────────────────────────────────────────────

## `GET devices/keyring`: ok with `{ring, wrap}`, each a Dictionary or null.
func read() -> PKeyResult:
	await _enter()
	var r := await _read_state()
	_leave()
	return r


func _read_state() -> PKeyResult:
	var res := await _call("GET", "devices/keyring", null)
	if not res.ok:
		return res
	var parsed := _parse_state(res.detail)
	if parsed == null:
		return _bad_response("The key ring answer is not in the contract shape.")
	_ring = parsed["ring"] if parsed["ring"] != null else {}
	return PKeyResult.success(parsed)


## Opens this device's wrap and holds the root. A device with no ring, no wrap or an unusable wrap
## stays locked (a result, not an error); a network or server failure is a failure result.
func unlock() -> PKeyResult:
	await _enter()
	var r := await _unlock_with(null)
	_leave()
	return r


## The person confirmed that the ring they were shown (`served` of a `ring-changed` answer) is
## theirs: open this device's wrap for it and pin it. If the Worker now serves another, the answer
## is `ring-changed` again. Call it only from confirmed UI.
func accept_ring_change(confirmed: Dictionary) -> PKeyResult:
	if not (confirmed.get("ring_id") is String) or not (confirmed.get("root_kid") is String) or not (confirmed.get("epoch") is int or confirmed.get("epoch") is float):
		return _bad_arg("A confirmed ring is {ring_id, epoch, root_kid}.")
	await _enter()
	var r := await _unlock_with({"ring_id": confirmed["ring_id"], "epoch": int(confirmed["epoch"]), "root_kid": String(confirmed["root_kid"])})
	_leave()
	return r


func _unlock_with(accept: Variant) -> PKeyResult:
	var st := await _read_state()
	if not st.ok:
		return st
	var ring: Variant = st.detail["ring"]
	if ring == null:
		return _locked_result("no-ring")
	var pin_r := _vault.read_pin()
	if not pin_r.ok:
		return pin_r
	var pinned: Variant = pin_r.detail
	var expected: Variant = accept if accept != null else pinned
	var served := {"ring_id": ring["ring_id"], "epoch": ring["epoch"], "root_kid": ring["root_kid"]}
	if expected != null and not _same_pin(expected, served):
		var w: Variant = st.detail["wrap"]
		return PKeyResult.success({"kind": "ring-changed", "pinned": pinned if pinned != null else expected, "served": served, "created_at": ring["created_at"], "by": w["by"] if w != null else null})
	var unlocked_r := PKeyResult.success({"kind": "unlocked", "ring_id": ring["ring_id"], "epoch": ring["epoch"]})
	var kid := _unhex(ring["root_kid"], 16)
	if kid == null:
		return _locked_result("unusable-wrap")
	var h := _memory.held
	if h != null and h.matches(ring["ring_id"], ring["epoch"], kid):
		return unlocked_r
	var stored := _stored_root(served)
	if stored != null:
		_memory.set_held(stored, _others_with(stored))
		return unlocked_r
	var wrap: Variant = st.detail["wrap"]
	if wrap == null:
		return _locked_result("no-wrap")
	var open := _open_own_wrap(ring, wrap, kid)
	if not open.ok:
		return open
	if open.detail == null:
		return _locked_result("unusable-wrap")
	var held := _Held.new(ring["ring_id"], ring["epoch"], kid, open.detail)
	var hr := _hold(held, true)
	if not hr.ok:
		return hr
	return unlocked_r


## ok with the 32-byte root, ok with a null detail when the wrap is unusable, or a failure (the
## device keys are unreadable).
func _open_own_wrap(ring: Dictionary, wrap: Dictionary, kid: PackedByteArray) -> PKeyResult:
	if _keys == null:
		return PKeyResult.success(null)
	var enc: Variant = PKeyB64Url.decode_strict(wrap["enc"])
	var ct: Variant = PKeyB64Url.decode_strict(wrap["ct"])
	var usable: bool = enc != null and ct != null and (enc as PackedByteArray).size() == PKeySyncHpke.ENC_BYTES and wrap["kid"] == ring["root_kid"] and wrap["epoch"] == ring["epoch"] and _kem_ok(wrap["kem"])
	if not usable:
		return PKeyResult.success(null)
	var pub := _agree_public()
	if not pub.ok:
		return pub
	var dh := PKeySyncHpke.dh_of_store(_keys)
	var root: Variant = PKeySyncWrap.unwrap_root(dh, pub.detail, product, device_id, ring["ring_id"], ring["epoch"], kid, int(PKeySyncHpke.KEM_X25519), enc, ct)
	if root == null or not PKeySyncAesGcm.equal_constant_time(PKeySyncHkdf.derive_kid(root), kid):
		return PKeyResult.success(null)
	return PKeyResult.success(root)


func _kem_ok(k: Variant) -> bool:
	return (k is String and k == "x25519") or ((k is int or k is float) and int(k) == PKeySyncHpke.KEM_X25519)


# ── Writes ───────────────────────────────────────────────────────────────────────────────

## Makes the ring: a fresh root, a wrap to this device and (by default) a recovery blob. The root is
## held on success. `keyring_conflict` (a ring exists) leaves nothing held: use `unlock`.
func create(with_recovery := true) -> PKeyResult:
	await _enter()
	var r := await _make_ring("devices/keyring", with_recovery)
	_leave()
	return r


## Starts over: a new ring and root, optionally a new recovery code. The server keeps the old ring
## as `previous` for 30 days; a root this device held is kept in memory for `adopt`.
func reset(with_recovery := true) -> PKeyResult:
	await _enter()
	var r := await _make_ring("devices/keyring/reset", with_recovery)
	_leave()
	return r


## Wraps the root to another device of the same person (`PUT .../wraps/{deviceId}`). `agree_key` is
## that device's X25519 key, raw or as base64url text, from the nearby approval.
func wrap_to(p_device_id: String, agree_key: Variant) -> PKeyResult:
	await _enter()
	var r := await _put_wrap(p_device_id, agree_key)
	_leave()
	return r


func _put_wrap(p_device_id: String, agree_key: Variant) -> PKeyResult:
	var h := _memory.held
	if h == null:
		return _locked()
	if not _device_id_ok(p_device_id):
		return _bad_arg("A device id is required.")
	var key: Variant = agree_key
	if key is String:
		key = PKeyB64Url.decode_strict(key)
	if not (key is PackedByteArray) or (key as PackedByteArray).size() != PKeySyncHpke.ENC_BYTES:
		return _bad_arg("The agreement key must be 32 bytes.")
	var w := PKeySyncWrap.wrap_root(key, product, p_device_id, h.ring_id, h.epoch, h.kid, h.root)
	if w.is_empty():
		return _bad_arg("The agreement key is not usable.")
	var body := {"epoch": h.epoch, "kid": h.kid.hex_encode()}
	body.merge(_wire_wrap(w))
	return await _call("PUT", "devices/keyring/wraps/%s" % p_device_id.uri_encode(), body)


## `DELETE .../wraps/{deviceId}`: the Worker removes a device's own wrap only.
func remove_wrap(p_device_id: String) -> PKeyResult:
	if not _device_id_ok(p_device_id):
		return _bad_arg("A device id is required.")
	await _enter()
	var r := await _call("DELETE", "devices/keyring/wraps/%s" % p_device_id.uri_encode(), null)
	_leave()
	return r


## Makes a new recovery code, seals the root under it and stores the blob. The previous code stops
## working. ok with the code text to show the person; it is kept nowhere.
func set_recovery_code() -> PKeyResult:
	await _enter()
	var r := await _set_recovery()
	_leave()
	return r


func _set_recovery() -> PKeyResult:
	var h := _memory.held
	if h == null:
		return _locked()
	var code := PKeySyncRecoveryCode.new_code()
	var blob := PKeySyncWrap.wrap_recovery(code, h.ring_id, h.epoch, h.kid, h.root)
	if blob.is_empty():
		code.fill(0)
		return _bad_arg("The recovery blob could not be made.")
	var res := await _call("PUT", "devices/keyring/recovery", {"ct": PKeyB64Url.encode(blob), "epoch": h.epoch, "kid": h.kid.hex_encode()})
	var text := PKeySyncRecoveryCode.encode(code)
	code.fill(0)
	if not res.ok:
		return res
	return PKeyResult.success(text)


## `GET .../recovery`: ok with `{ct, epoch, kid}` (5 reads a day per device; the account is emailed).
func recovery_blob() -> PKeyResult:
	await _enter()
	var r := await _read_recovery_blob()
	_leave()
	return r


func _read_recovery_blob() -> PKeyResult:
	var res := await _call("GET", "devices/keyring/recovery", null)
	if not res.ok:
		return res
	var v := _json(res.detail)
	if v == null or not (v.get("ct") is String) or not _is_num(v.get("epoch")) or not (v.get("kid") is String):
		return _bad_response("The recovery answer is not in the contract shape.")
	return PKeyResult.success({"ct": v["ct"], "epoch": int(v["epoch"]), "kid": v["kid"]})


## Recovers the root from the typed or pasted recovery code. The code is checked before any request;
## a bad checksum or a failed unwrap is `recovery-code-invalid`. On success the root is held and
## pinned, and this device deposits its own wrap so the next start unlocks without the code.
func recover(code_text: String) -> PKeyResult:
	var code: Variant = PKeySyncRecoveryCode.parse(code_text)
	if code == null:
		return _invalid_code()
	await _enter()
	var r := await _recover(code)
	(code as PackedByteArray).fill(0)
	_leave()
	return r


func _recover(code: PackedByteArray) -> PKeyResult:
	var st := await _read_state()
	if not st.ok:
		return st
	var ring: Variant = st.detail["ring"]
	if ring == null or not ring["recovery_set"]:
		return PKeyResult.failure(PKeyErrors.NOT_FOUND, "There is no recovery code for this key ring.")
	var kid := _unhex(ring["root_kid"], 16)
	if kid == null:
		return _bad_response("Bad ring kid.")
	var blob_r := await _read_recovery_blob()
	if not blob_r.ok:
		return blob_r
	var blob: Dictionary = blob_r.detail
	if blob["epoch"] != ring["epoch"] or blob["kid"] != ring["root_kid"]:
		return _bad_response("The recovery blob does not belong to the current ring.")
	var bytes: Variant = PKeyB64Url.decode_strict(blob["ct"])
	var root: Variant = PKeySyncWrap.unwrap_recovery(code, ring["ring_id"], ring["epoch"], kid, bytes) if bytes != null else null
	if root == null or not PKeySyncAesGcm.equal_constant_time(PKeySyncHkdf.derive_kid(root), kid):
		return _invalid_code()
	var hr := _hold(_Held.new(ring["ring_id"], ring["epoch"], kid, root), true)
	if not hr.ok:
		return hr
	var deposited := false
	var pub := _agree_public()
	if pub.ok:
		deposited = (await _put_wrap(device_id, pub.detail)).ok
	return PKeyResult.success({"ring_id": ring["ring_id"], "epoch": ring["epoch"], "wrap_deposited": deposited})


## Adopts an earlier root under the current one (`POST .../adopt`): the id of a ring whose root this
## client holds (kept by `reset` or `open_adopted`).
func adopt(ring_id: String) -> PKeyResult:
	await _enter()
	var r: PKeyResult
	if _memory.held == null:
		r = _locked()
	else:
		var found: Variant = null
		for o in _memory.others:
			if o.ring_id == ring_id:
				found = o
				break
		r = _bad_arg("No root is held for that ring.") if found == null else await _post_adopt(found)
	_leave()
	return r


## Adopts a root the host has.
func adopt_root(ring_id: String, epoch: int, root: PackedByteArray) -> PKeyResult:
	await _enter()
	var r: PKeyResult
	if _memory.held == null:
		r = _locked()
	elif _ring_id_re.search(ring_id) == null or root.size() != PKeySyncHkdf.ROOT_BYTES:
		r = _bad_arg("No root is held for that ring.")
	else:
		r = await _post_adopt(_Held.new(ring_id, epoch, PKeySyncHkdf.derive_kid(root), root))
	_leave()
	return r


func _post_adopt(old: _Held) -> PKeyResult:
	var h := _memory.held
	if h == null:
		return _locked()
	if _ring_id_re.search(old.ring_id) == null or old.epoch < 1:
		return _bad_arg("No root is held for that ring.")
	var blob := PKeySyncWrap.seal_adopt(h.root, old.ring_id, old.epoch, old.kid, old.root)
	if blob.is_empty():
		return _bad_arg("The adopt blob could not be made.")
	return await _call("POST", "devices/keyring/adopt", {"fromRingId": old.ring_id, "epoch": old.epoch, "kid": old.kid.hex_encode(), "ct": PKeyB64Url.encode(blob)})


## Opens the ring's `adopted` candidates with the current root and keeps the roots they hold, so
## `codec.open` reads data sealed under them. ok with the ring ids it opened; a candidate that does
## not open (or names a different kid) is skipped.
func open_adopted() -> PKeyResult:
	await _enter()
	var r := await _open_adopted()
	_leave()
	return r


func _open_adopted() -> PKeyResult:
	var h := _memory.held
	if h == null:
		return _locked()
	if _ring.is_empty():
		var st := await _read_state()
		if not st.ok:
			return st
	var opened: Array = []
	for a in _ring.get("adopted", []):
		var kid := _unhex(a["kid"], 16)
		var ct: Variant = PKeyB64Url.decode_strict(a["ct"])
		if kid == null or ct == null:
			continue
		var root: Variant = PKeySyncWrap.open_adopt(h.root, a["ring_id"], a["epoch"], kid, ct)
		if root != null and PKeySyncAesGcm.equal_constant_time(PKeySyncHkdf.derive_kid(root), kid):
			var kept: Array = _memory.others.filter(func(o: _Held) -> bool: return o.ring_id != a["ring_id"])
			kept.append(_Held.new(a["ring_id"], a["epoch"], kid, root))
			_memory.others = kept
			opened.append(a["ring_id"])
	return PKeyResult.success(opened)


# ── Internals ────────────────────────────────────────────────────────────────────────────

func _make_ring(path: String, with_recovery: bool) -> PKeyResult:
	var pub := _agree_public()
	if not pub.ok:
		return pub
	var rnd := Crypto.new()
	var root := rnd.generate_random_bytes(PKeySyncHkdf.ROOT_BYTES)
	var kid := PKeySyncHkdf.derive_kid(root)
	var ring_id := "rg_" + PKeyB64Url.encode(rnd.generate_random_bytes(16))
	var epoch := 1
	var w := PKeySyncWrap.wrap_root(pub.detail, product, device_id, ring_id, epoch, kid, root)
	if w.is_empty():
		root.fill(0)
		return PKeyResult.failure(PKeyConstants.ErrorCode.DEVICE_KEYS_INVALID, "The device agreement key is not usable.")
	var body := {"ringId": ring_id, "rootKid": kid.hex_encode(), "wrap": _wire_wrap(w)}
	var code := PackedByteArray()
	if with_recovery:
		code = PKeySyncRecoveryCode.new_code()
		body["recovery"] = {"ct": PKeyB64Url.encode(PKeySyncWrap.wrap_recovery(code, ring_id, epoch, kid, root))}
	var res := await _call("POST", path, body)
	if not res.ok:
		root.fill(0)
		code.fill(0)
		return res
	var hr := _hold(_Held.new(ring_id, epoch, kid, root), true)
	_ring = {}
	var text := PKeySyncRecoveryCode.encode(code) if with_recovery else ""
	code.fill(0)
	if not hr.ok:
		return hr
	return PKeyResult.success({"ring_id": ring_id, "epoch": epoch, "root_kid": kid.hex_encode(), "recovery_code": text})


## Takes a freshly acquired root: pinned first (no root is held without a pin; a pin that cannot be
## written leaves nothing held), then stored (a failure there leaves the root in memory only), then held.
func _hold(h: _Held, store: bool) -> PKeyResult:
	var want := {"ring_id": h.ring_id, "epoch": h.epoch, "root_kid": h.kid.hex_encode()}
	var cur := _vault.read_pin()
	if not cur.ok or cur.detail == null or not _same_pin(cur.detail, want):
		var w := _vault.write_pin(want)
		if not w.ok:
			return w
	if store:
		_vault.write_root(h.ring_id, h.epoch, h.kid, h.root)
	_memory.set_held(h, _others_with(h))
	return PKeyResult.success()


func _others_with(h: _Held) -> Array:
	var old := _memory.held
	if old != null and (old.ring_id != h.ring_id or old.epoch != h.epoch):
		var out: Array = _memory.others.filter(func(o: _Held) -> bool: return o.ring_id != old.ring_id)
		out.append(old)
		return out
	return _memory.others


## The stored root, when it is for `ring` and still derives its own kid; else null.
func _stored_root(ring: Dictionary) -> _Held:
	var r := _vault.read_root()
	if not r.ok or r.detail == null:
		return null
	var s: Dictionary = r.detail
	if s["ring_id"] != ring["ring_id"] or s["epoch"] != ring["epoch"] or s["kid"] != ring["root_kid"]:
		return null
	var kid := _unhex(s["kid"], 16)
	if kid == null or not PKeySyncAesGcm.equal_constant_time(PKeySyncHkdf.derive_kid(s["root"]), kid):
		return null
	return _Held.new(s["ring_id"], s["epoch"], kid, s["root"])


## A restart: the stored root comes back only while it is the pinned ring's.
func _restore_stored() -> PKeyResult:
	if _memory.held != null:
		return PKeyResult.success()
	var p := _vault.read_pin()
	if not p.ok:
		return p
	if p.detail != null:
		var h := _stored_root(p.detail)
		if h != null:
			_memory.set_held(h)
	return PKeyResult.success()


## ok with this device's 32-byte agreement public key, or a failure.
func _agree_public() -> PKeyResult:
	if _keys == null:
		return PKeyResult.failure(PKeyConstants.ErrorCode.DEVICE_KEYS_REQUIRED, "Device keys are needed for the key ring; give the ring a key store.")
	var r: PKeyResult = _keys.ensure()
	if not r.ok:
		return r
	var pub: Variant = PKeyB64Url.decode_strict(r.detail["agree_key"])
	if pub == null or (pub as PackedByteArray).size() != 32:
		return PKeyResult.failure(PKeyConstants.ErrorCode.DEVICE_KEYS_INVALID, "The device agreement key is not usable.")
	return PKeyResult.success(pub)


static func _same_pin(a: Dictionary, b: Dictionary) -> bool:
	return a["ring_id"] == b["ring_id"] and int(a["epoch"]) == int(b["epoch"]) and String(a["root_kid"]).to_lower() == String(b["root_kid"]).to_lower()


static func _wire_wrap(w: Dictionary) -> Dictionary:
	return {"kem": int(w["kem"]), "enc": PKeyB64Url.encode(w["enc"]), "ct": PKeyB64Url.encode(w["ct"])}


func _device_id_ok(s: String) -> bool:
	if s.is_empty():
		return false
	for c in s:
		if c == "/" or c == "?" or c == "#" or c.strip_edges() == "":
			return false
	return true


## The Worker's answer for one request: ok with `{status, body}`, or the failure it carries.
func _call(method: String, path: String, body: Variant) -> PKeyResult:
	if not _requester.is_valid():
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "The key ring has no way to reach the Worker.")
	var r: PKeyResult = await _requester.call(method, path, body)
	if not r.ok:
		return PKeyResult.failure(r.code, r.message, r.detail)
	var d: Variant = r.detail
	return PKeyResult.success(d["body"] if d is Dictionary and d.has("body") else PackedByteArray())


static func _json(body: Variant) -> Variant:
	if not (body is PackedByteArray):
		return null
	var p := PKeyJson.parse_bytes(body)
	return p["value"] if p["ok"] and p["value"] is Dictionary else null


static func _is_num(v: Variant) -> bool:
	return v is int or v is float


## `{ring: Dictionary|null, wrap: Dictionary|null}` from the served body, or null for a body that is
## not in the contract shape.
static func _parse_state(body: Variant) -> Variant:
	var b: Variant = _json(body)
	if b == null or not b.has("ring") or not b.has("wrap"):
		return null
	var ring: Variant = null
	var wrap: Variant = null
	if b["ring"] != null:
		ring = _parse_ring(b["ring"])
		if ring == null:
			return null
	if b["wrap"] != null:
		wrap = _parse_wrap(b["wrap"])
		if wrap == null:
			return null
	return {"ring": ring, "wrap": wrap}


static func _parse_ring(r: Variant) -> Variant:
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
	return {"ring_id": r["ringId"], "epoch": int(r["epoch"]), "root_kid": r["rootKid"], "state": r["state"], "created_at": int(r["createdAt"]), "recovery_set": rec["set"], "adopted": adopted, "previous": prev}


static func _parse_wrap(w: Variant) -> Variant:
	if not (w is Dictionary):
		return null
	var kem: Variant = w.get("kem")
	if not (kem is String or _is_num(kem)) or not _is_num(w.get("epoch")) or not (w.get("kid") is String) or not (w.get("enc") is String) or not (w.get("ct") is String):
		return null
	return {"epoch": int(w["epoch"]), "kid": w["kid"], "kem": kem, "enc": w["enc"], "ct": w["ct"], "by": w.get("by") if w.get("by") is String else null}


## `n` bytes from `n * 2` hex characters, or null.
static func _unhex(s: String, n: int) -> Variant:
	if s.length() != n * 2 or not s.is_valid_hex_number(false):
		return null
	return s.hex_decode()


func _locked_result(reason: String) -> PKeyResult:
	return PKeyResult.success({"kind": "locked", "reason": reason})


func _locked() -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.SYNC_LOCKED, "This device holds no root for the key ring; unlock it first.")


func _invalid_code() -> PKeyResult:
	return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.RECOVERY_CODE_INVALID), "The recovery code is not valid for this key ring.")


func _bad_arg(what: String) -> PKeyResult:
	return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.INVALID_ARGUMENT), what)


func _bad_response(what: String) -> PKeyResult:
	return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.BAD_RESPONSE), what)


## One verb at a time: a second caller waits a frame at a time until the first is done.
func _enter() -> void:
	while _busy:
		await (Engine.get_main_loop() as SceneTree).process_frame
	_busy = true


func _leave() -> void:
	_busy = false
