@tool
class_name PKeyPeerVouch
extends RefCounted
## WIRE-CONTRACT-V5 section 15.6.1: the codecs and rules of mode v, the vouch (CC-15b.G1), ported from
## `packages/client-core/src/peer/vouch.ts`. D is the device with no sign-in (the initiator, the
## requester); M is the signed-in device nearby (the responder, the approver). The vectors are
## `peer-matrix.json` `vouch`.
##
## What lives here: the `VOUCH_REQ` body (build, parse, verify), the `VOUCH_RESULT` body, M's reading
## of the `nearby/approve` answer (`finish_map`), the number-matching decoys (`decoy_codes`), the
## approver's advert instance, the failure budget, and `Flow`, the order guard the session runs over
## the records of one mode-v session. What does not: the session itself, the routes, the sockets and
## the prompt. Nothing here prints or returns a request handle, `sig`, `h`, a nonce or a key in a
## message; every type that holds a record overrides `_to_string`.
##
## Threads. `build_request` and `verify_request` sign and verify with GDScript Ed25519 (the engine
## has none): the caller runs them through the pump's `offload`. The flow holds a `VOUCH_REQ` until the
## matching pick, so a verify runs at most once per session, at human pace.
##
## Dictionaries use snake_case members. A record is {type, body}; a verdict is {ok = true, deliver:
## Array of records} or {ok = false, close: a close code}.

## The capability both mode-v payloads list (rule 1).
const VOUCH_CAP := "vouch/1"
## A `VOUCH_REQ` body is at most this many bytes (rule 5).
const VOUCH_REQ_MAX := 4096
## Rule 12: records D holds before its person confirms the account, and their bytes.
const HELD_RECORDS := 16
const HELD_BYTES := 16 * 1024
## Rule 2: the advert's listener and instance are renewed this often.
const APPROVER_RENEW_SECONDS := 300
## Rule 2: this many prompted failures within the window stop the advert.
const FAILURE_LIMIT := 2
const FAILURE_WINDOW_SECONDS := 600
## Draws that may be rejected before a generator that cannot produce a value is given up on.
const MAX_DRAWS := 256

const STATUSES := ["approved", "denied", "expired"]

static var _request_re: RegEx
static var _device_re: RegEx


static func _static_init() -> void:
	_request_re = PKeyClaims.whole("nr_[A-Za-z0-9_-]{22}")
	_device_re = PKeyClaims.whole("[A-Za-z0-9_-]{32}")


static func _invalid(why: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "Vouch: bad input: %s." % why)


## A canonical base64url of 32 bytes, decoded, or null.
static func _key32(v: Variant) -> Variant:
	if not v is String or (v as String).length() != 43:
		return null
	var b: Variant = PKeyB64Url.decode_strict(v)
	if b == null or (b as PackedByteArray).size() != 32:
		return null
	return b


## WIRE-CONTRACT-V4 section 1.1 checks 2 and 3 for a raw Ed25519 key: canonical, not of small order.
static func _sign_key_ok(k: PackedByteArray) -> bool:
	if not PKeyEd25519.y_is_canonical(k):
		return false
	var hex := k.hex_encode()
	return not PKeyEd25519.NEGATIVE_ZERO_ENCODINGS.has(hex) and not PKeyEd25519.SMALL_ORDER_ENCODINGS.has(hex)


## The one X25519 spelling the Worker registers: bit 255 clear and u below p (section 15.8).
static func _agree_spelling(k: PackedByteArray) -> bool:
	if (k[31] & 0x80) != 0:
		return false
	if k[31] == 0x7f:
		for i in range(1, 31):
			if k[i] != 0xff:
				return true
		return k[0] < 0xed
	return true


# -- VOUCH_REQ -----------------------------------------------------------------------------------

## The `VOUCH_REQ` body D sends after it showed the code (rule 5). `o`: `port` (D's device key
## store), `slug`, `h` (this session's handshake hash, 32 bytes), `request` (the handle from
## `nearby/start`), `device_id` (the `X-PKey-Device` value sent on `start`), `hello` ({label?,
## platform}: the same members D's HELLO carried) and `verify` (a test seam, see
## `PKeyDeviceProof.verify`). ok with the body bytes, or a failure. Blocking: run it off the main thread.
static func build_request(o: Dictionary) -> PKeyResult:
	var h: Variant = o.get("h")
	var request: Variant = o.get("request")
	var device_id: Variant = o.get("device_id")
	var hello: Variant = o.get("hello")
	if not h is PackedByteArray or (h as PackedByteArray).size() != 32 or not o.get("port") is Object:
		return _invalid("session")
	if not PKeyClaims.matches_whole_re(_request_re, request) or not PKeyClaims.matches_whole_re(_device_re, device_id):
		return _invalid("handle")
	if not hello is Dictionary or not (hello as Dictionary).get("platform") is String or not o.get("slug") is String:
		return _invalid("hello")
	var proof := PKeyDeviceKeys.sign_device_proof(o["port"], {
		"purpose": "vouch", "product": o["slug"], "device_id": device_id,
		"value": "%s.%s" % [PKeyB64Url.encode(h), request], "verify": o.get("verify", Callable()),
	})
	if not proof.ok:
		return proof
	var keys: PKeyResult = (o["port"] as Object).call("public_keys")
	if not keys.ok or keys.detail == null or keys.detail["sign_key"] != proof.detail["sign_key"]:
		return PKeyResult.failure(PKeyDeviceKeys.PROOF_INVALID, "Vouch: the device keys changed.")
	var body := {
		"v": 1, "request": request, "deviceId": device_id,
		"signKey": keys.detail["sign_key"], "agreeKey": keys.detail["agree_key"],
	}
	var label: Variant = (hello as Dictionary).get("label", "")
	if label is String and label != "":
		body["label"] = label
	body["platform"] = hello["platform"]
	body["sig"] = proof.detail["sig"]
	var bytes := PKeyJson.stringify(body).to_utf8_buffer()
	if bytes.size() > VOUCH_REQ_MAX:
		return _invalid("too large")
	return PKeyResult.success(bytes)


## Strict JSON, size, shape and key checks (rule 5), the signature unread: {request, device_id,
## sign_key, agree_key, label (String or null), platform, sig}, or null (close `peer_bad_frame`).
static func parse_request(body: PackedByteArray) -> Variant:
	if body.size() > VOUCH_REQ_MAX:
		return null
	var scanned: Variant = PKeyPeerPayload.parse_object_scanned(body)
	if scanned == null:
		return null
	var o: Dictionary = scanned["value"]
	# `v` is the integer 1: `1.0` and `1e0` read as 1 in Godot and are refused here.
	if not PKeyClaims.is_wire_integer(o.get("v"), "/v", 1, scanned["non_wire_integers"]) or float(o["v"]) != 1.0:
		return null
	var request: Variant = o.get("request")
	var device_id: Variant = o.get("deviceId")
	if not PKeyClaims.matches_whole_re(_request_re, request) or not PKeyClaims.matches_whole_re(_device_re, device_id):
		return null
	var sk: Variant = _key32(o.get("signKey"))
	if sk == null or not _sign_key_ok(sk):
		return null
	var ak: Variant = _key32(o.get("agreeKey"))
	if ak == null or PKeyCurve25519.is_low_order(ak) or not _agree_spelling(ak):
		return null
	if o.has("label") and not o["label"] is String:
		return null
	if not o.get("platform") is String or not o.get("sig") is String:
		return null
	var label: Variant = null
	if o.has("label"):
		var cleaned := PKeyPeerPayload.clean_label(o["label"])
		label = cleaned if cleaned != "" else null
	return {
		"request": request, "device_id": device_id, "sign_key": o["signKey"], "agree_key": o["agreeKey"],
		"label": label, "platform": PKeyPeerPayload.clean_platform(o["platform"]), "sig": o["sig"],
	}


## M's whole check of a `VOUCH_REQ` (rule 5): the parse, the proof over this session's `h`, and the
## equality of `label` and `platform` with D's HELLO. `o`: `slug`, `h`, `hello` ({label?, platform}),
## `hello_cleaned` (the HELLO is what the session already cleaned; otherwise it is cleaned here), `body`
## and `verify` (a test seam). The request as {request, device_id, sign_key, agree_key, label, platform}
## (exactly what M sends to `nearby/approve`), or null: close `peer_bad_frame` and call no route.
## Blocking: run it off the main thread.
static func verify_request(o: Dictionary) -> Variant:
	var h: Variant = o.get("h")
	var hello: Variant = o.get("hello")
	if not h is PackedByteArray or (h as PackedByteArray).size() != 32 or not hello is Dictionary or not o.get("body") is PackedByteArray:
		return null
	var p: Variant = parse_request(o["body"])
	if p == null:
		return null
	var proven := PKeyDeviceProof.verify({
		"purpose": "vouch", "product": o.get("slug"), "device_id": p["device_id"],
		"value": "%s.%s" % [PKeyB64Url.encode(h), p["request"]], "token_hash": "-",
		"sign_key": p["sign_key"], "sig": p["sig"],
	}, null, o.get("verify", Callable()))
	if not proven:
		return null
	var hello_label: Variant = null
	var raw: Variant = (hello as Dictionary).get("label")
	if raw is String:
		var shown: String = raw if o.get("hello_cleaned", false) == true else PKeyPeerPayload.clean_label(raw)
		hello_label = shown if shown != "" else null
	if p["label"] != hello_label:
		return null
	if not (hello as Dictionary).get("platform") is String or p["platform"] != PKeyPeerPayload.clean_platform(hello["platform"]):
		return null
	p.erase("sig")
	return p


# -- VOUCH_RESULT --------------------------------------------------------------------------------

## The `VOUCH_RESULT` body M sends.
static func build_result(status: String) -> PackedByteArray:
	return PKeyJson.stringify({"status": status}).to_utf8_buffer()


## D's reading of a `VOUCH_RESULT` (rule 6): display data only. {status} (an unknown status reads as
## `denied`), or {refuse = "peer_bad_frame"} for a body that is not an object with a string `status`.
static func parse_result(body: PackedByteArray) -> Dictionary:
	var o: Variant = PKeyPeerPayload.parse_strict_object(body)
	if o == null or not (o as Dictionary).get("status") is String:
		return {"refuse": PKeyPeerRecord.CLOSE_BAD_FRAME}
	return {"status": o["status"] if STATUSES.has(o["status"]) else "denied"}


# -- M reads the answer of nearby/approve ---------------------------------------------------------

## Rule 6's table. `r`: `http` (the status, or null when there was no answer), `body` (text or null),
## `discovery_nearby` (M's fresh read: does discovery still name `nearby` and `nearbyApprove`?) and
## `keys_retried` (M already answered a `device_keys_required` by registering its keys). One of:
## {send: status} (after any status but `approved`, close `peer_bye`), {wait: "choice" | "keys"} (show
## the licence choice, or register keys, then call again), {close: true, stop_advert: bool}. Anything
## the table does not list closes.
static func finish_map(r: Dictionary) -> Dictionary:
	var http: Variant = r.get("http")
	if http == null:
		return _stop(false)
	var text: Variant = r.get("body")
	var o: Variant = PKeyPeerPayload.parse_strict_object(String(text).to_utf8_buffer()) if text is String else null
	var code: Variant = o.get("code") if o is Dictionary else null
	var status: Variant = o.get("status") if o is Dictionary else null
	match int(http):
		200:
			if status is String and status == "approved":
				return {"send": "approved"}
			return {"wait": "choice"} if status is String and status == "choose" else _stop(false)
		204:
			return {"send": "denied"}
		403:
			# D hears `denied` for both, so a session holder cannot tell which refusal an account hit.
			if code is String and (code == "not_nearby" or code == "device_limit"):
				return {"send": "denied"}
			return _stop(false)
		404:
			# The 404 is ambiguous (rule 6): `expired` only while discovery still names the routes.
			return {"send": "expired"} if r.get("discovery_nearby", false) == true else _stop(true)
		409:
			if code is String and code == "device_keys_required":
				return _stop(false) if r.get("keys_retried", false) == true else {"wait": "keys"}
			return {"wait": "choice"} if code is String and code == "license_choice_required" else _stop(false)
	return _stop(false)


static func _stop(stop_advert: bool) -> Dictionary:
	return {"close": true, "stop_advert": stop_advert}


# -- randomness: decoys, positions and the advert instance ------------------------------------------

static func _system_random(n: int) -> PackedByteArray:
	return Crypto.new().generate_random_bytes(n)


static func _draw(random: Callable, n: int) -> PackedByteArray:
	var b: Variant = random.call(n) if random.is_valid() else _system_random(n)
	return b if b is PackedByteArray and (b as PackedByteArray).size() == n else PackedByteArray()


## A uniform integer in [0, n) by rejection sampling over 32-bit draws, never `x % n` alone; -1 when
## the source is unusable.
static func _uniform_below(n: int, random: Callable) -> int:
	@warning_ignore("integer_division")
	var limit := (4294967296 / n) * n
	for i in MAX_DRAWS:
		var b := _draw(random, 4)
		if b.is_empty():
			return -1
		var x := (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]
		if x < limit:
			return x % n
	return -1


## The three codes M shows (rule 4): the session's `real` code and two decoys by rejection sampling,
## distinct, and the real one at a uniform position by a partial Fisher-Yates shuffle. ok with
## {codes: [a, b, c], index}, or a failure. `random` is Callable(n) -> n bytes (empty: the CSPRNG).
static func decoy_codes(real: int, random: Callable = Callable()) -> PKeyResult:
	if real < 0 or real >= 1000000:
		return _invalid("code")
	var codes: Array[int] = [real]
	var real_at: Array[bool] = [true]
	var tries := 0
	while codes.size() < 3:
		tries += 1
		if tries > MAX_DRAWS:
			return PKeyResult.failure(&"state", "Vouch: the random source repeats.")
		var code := _uniform_below(1000000, random)
		if code < 0:
			return PKeyResult.failure(&"state", "Vouch: the random source failed.")
		if not codes.has(code):
			codes.append(code)
			real_at.append(false)
	for i in [2, 1]:
		var j := _uniform_below(i + 1, random)
		if j < 0:
			return PKeyResult.failure(&"state", "Vouch: the random source failed.")
		var c := codes[i]
		codes[i] = codes[j]
		codes[j] = c
		var f := real_at[i]
		real_at[i] = real_at[j]
		real_at[j] = f
	return PKeyResult.success({"codes": codes, "index": real_at.find(true)})


## The approver's advert instance (rule 2): `p1-` and 10 CSPRNG bytes in base32, 16 characters. "" when
## the source is unusable.
static func approver_instance(random: Callable = Callable()) -> String:
	var b := _draw(random, 10)
	return "p1-" + PKeyPeerAdvert.base32_lower(b) if not b.is_empty() else ""


# -- the failure budget (rule 2) ------------------------------------------------------------------

## M counts the failures of sessions whose prompt was shown (a wrong pick, "None of these match", a
## 120 s timeout) against a monotonic clock. The second within 10 minutes stops the advert, and it
## stays stopped until the person reopens "Approve a nearby device". A session that was only queued, or
## shown the passive notice, counts for nothing: the caller does not report it.
class FailureBudget extends RefCounted:
	var _mono: Callable
	var _at: Array[float] = []
	var _halted := false


	## `mono` returns monotonic seconds (empty: the engine's tick counter).
	func _init(mono: Callable = Callable()) -> void:
		_mono = mono


	func _to_string() -> String:
		return "PKeyPeerVouch.FailureBudget()"


	func _now() -> float:
		return float(_mono.call()) if _mono.is_valid() else float(Time.get_ticks_msec()) / 1000.0


	## Record one failure; true when the advert must stop now.
	func fail() -> bool:
		var now := _now()
		var kept: Array[float] = []
		for t in _at:
			if now - t < PKeyPeerVouch.FAILURE_WINDOW_SECONDS:
				kept.append(t)
		kept.append(now)
		_at = kept
		if _at.size() >= PKeyPeerVouch.FAILURE_LIMIT:
			_halted = true
		return _halted


	## True while the advert must stay off.
	func stopped() -> bool:
		return _halted


	## The person reopened "Approve a nearby device": the count starts again.
	func reopen() -> void:
		_at = []
		_halted = false


# -- the order guard (rules 1, 4, 5, 7, 8, 12) ------------------------------------------------------

## One end's order guard over the vouch records of one session. D is the `requester`, M the
## `approver`. Every record is checked in both directions: `receive` for what arrives, `send` for what
## this end is about to send, with the same codes (rule 7). After a close verdict the flow is dead and
## answers with that code again.
##
## - `VOUCH_REQ`: D to M, once, after D showed the code. M's flow holds it until the person's right
##   pick (`picked`), so a wrong pick, "None of these match", a timeout or a stop (`abandon`) never
##   delivers it.
## - `VOUCH_RESULT`: M to D, at most once, after a verified `VOUCH_REQ`.
## - `0x0030` to `0x003F`: M to D, only after an `approved` result; D holds them (16 records, 16 KiB,
##   then `peer_busy`) until its person confirms the account (`confirm_account`, rule 12).
##
## No silent approval (rule 10): `may_finish` is true only after the right pick and a verified request,
## which is when `nearby/approve` may be called.
class Flow extends RefCounted:
	var role: String
	var _dead: StringName = &""
	var _negotiated := false
	var _shown := false
	var _picked := false
	var _request_seen := false
	var _request_sent := false
	var _held: Variant = null
	var _verified := false
	var _result_sent := false
	var _result_seen := false
	var _status := ""
	var _confirmed := false
	var _queue: Array = []
	var _queue_bytes := 0


	## `role` is "requester" or "approver".
	func _init(p_role: String) -> void:
		role = p_role


	func _to_string() -> String:
		return "PKeyPeerVouch.Flow(%s)" % role


	func _close(code: StringName) -> Dictionary:
		if _dead == &"":
			_dead = code
		_held = null
		_queue = []
		_queue_bytes = 0
		return {"ok": false, "close": _dead}


	static func _ok(deliver: Array) -> Dictionary:
		return {"ok": true, "deliver": deliver}


	static func _is_sync(type: int) -> bool:
		return type >= 0x0030 and type <= 0x003f


	## True once a close verdict was given.
	func is_dead() -> bool:
		return _dead != &""


	## Rule 1: both payloads list `vouch/1`; call once, when the session is `established`.
	func negotiate(local: Array, remote: Array) -> Dictionary:
		if is_dead():
			return _close(_dead)
		if not PKeyPeerPayload.caps_intersection(local, remote).has(PKeyPeerVouch.VOUCH_CAP):
			return _close(PKeyPeerRecord.CLOSE_NOT_ALLOWED)
		_negotiated = true
		return _ok([])


	## This side's screen shows the code (D: the code; M: the three codes).
	func code_shown() -> void:
		_shown = true


	## M: the person picked the code D shows. Hands over the held request, if it arrived.
	func picked() -> Dictionary:
		if is_dead():
			return _close(_dead)
		if role != "approver" or not _negotiated or not _shown:
			return _close(PKeyPeerRecord.CLOSE_NOT_ALLOWED)
		_picked = true
		var out: Array = [] if _held == null else [_held]
		_held = null
		return _ok(out)


	## M: the session ends before a right pick (`wrong-pick`, `none-match`, `stop` or `timeout`); the
	## request is never delivered (rule 4).
	func abandon(reason: String) -> Dictionary:
		return _close(&"peer_timeout" if reason == "timeout" else &"peer_bye")


	## M: the delivered request verified (`PKeyPeerVouch.verify_request`).
	func verified() -> void:
		if _picked and _request_seen:
			_verified = true


	## M: may `nearby/approve` be called for this session? (rule 10; N12)
	func may_finish() -> bool:
		return not is_dead() and _verified and not _result_sent and role == "approver"


	## D: the person confirmed the signed-in account; held records are handed over (rule 12).
	func confirm_account() -> Dictionary:
		if is_dead():
			return _close(_dead)
		_confirmed = true
		var out := _queue
		_queue = []
		_queue_bytes = 0
		return _ok(out)


	## D: the person declined, or the screen timed out: every held record is dropped (rule 12).
	func decline_account() -> Dictionary:
		return _close(&"peer_bye")


	## A record arrived from the peer.
	func receive(r: Dictionary) -> Dictionary:
		if is_dead():
			return _close(_dead)
		var type: int = r["type"]
		if type == PKeyPeerRecord.VOUCH_REQ:
			return _receive_request(r)
		if type == PKeyPeerRecord.VOUCH_RESULT:
			return _receive_result(r)
		if _is_sync(type):
			return _receive_sync(r)
		return _ok([r])


	func _receive_request(r: Dictionary) -> Dictionary:
		if role != "approver" or not _negotiated:
			return _close(PKeyPeerRecord.CLOSE_NOT_ALLOWED)
		if _request_seen:
			return _close(PKeyPeerRecord.CLOSE_BAD_FRAME)
		_request_seen = true
		if _picked:
			return _ok([r])
		_held = r
		return _ok([])


	func _receive_result(r: Dictionary) -> Dictionary:
		if role != "requester" or not _negotiated or not _request_sent:
			return _close(PKeyPeerRecord.CLOSE_NOT_ALLOWED)
		if _result_seen:
			return _close(PKeyPeerRecord.CLOSE_BAD_FRAME)
		var got := PKeyPeerVouch.parse_result(r["body"])
		if got.has("refuse"):
			return _close(got["refuse"])
		_result_seen = true
		_status = got["status"]
		return _ok([r])


	func _receive_sync(r: Dictionary) -> Dictionary:
		if role != "requester" or not _negotiated or _status != "approved":
			return _close(PKeyPeerRecord.CLOSE_NOT_ALLOWED)
		if _confirmed:
			return _ok([r])
		var size: int = (r["body"] as PackedByteArray).size()
		if _queue.size() >= PKeyPeerVouch.HELD_RECORDS or _queue_bytes + size > PKeyPeerVouch.HELD_BYTES:
			return _close(&"peer_busy")
		_queue.append(r)
		_queue_bytes += size
		return _ok([])


	## This end is about to send a record. The sender's checks are the receiver's.
	func send(r: Dictionary) -> Dictionary:
		if is_dead():
			return _close(_dead)
		var type: int = r["type"]
		if type == PKeyPeerRecord.VOUCH_REQ:
			return _send_request(r)
		if type == PKeyPeerRecord.VOUCH_RESULT:
			return _send_result(r)
		if _is_sync(type) and (role != "approver" or _status != "approved"):
			return _close(PKeyPeerRecord.CLOSE_NOT_ALLOWED)
		return _ok([r])


	func _send_request(r: Dictionary) -> Dictionary:
		if role != "requester" or not _negotiated or not _shown:
			return _close(PKeyPeerRecord.CLOSE_NOT_ALLOWED)
		if _request_sent:
			return _close(PKeyPeerRecord.CLOSE_BAD_FRAME)
		_request_sent = true
		return _ok([r])


	func _send_result(r: Dictionary) -> Dictionary:
		if role != "approver" or not _verified:
			return _close(PKeyPeerRecord.CLOSE_NOT_ALLOWED)
		if _result_sent:
			return _close(PKeyPeerRecord.CLOSE_BAD_FRAME)
		var got := PKeyPeerVouch.parse_result(r["body"])
		if got.has("refuse"):
			return _close(got["refuse"])
		_result_sent = true
		_status = got["status"]
		return _ok([r])
