@tool
class_name PKeyPeerSession
extends RefCounted
## WIRE-CONTRACT-V5 sections 15.5 and 15.6: one `pkey-peer/1` session in mode `a` (account), `v`
## (approver), `p` (pair) or `c` (contact) (CC-14.8 and .9, CC-19b.G2), ported from `packages/client-core/src/peer/session.ts`.
## It owns no socket: de-framed Noise messages come in through `receive` and go out through the
## `send` callback, so one machine runs over TCP, the relay or memory.
##
## Order: Noise XX (XXpsk0 in mode a) with the payload rules of section 15.5; in mode a each side
## verifies the other's certificate against the remote static key and the held ring; then HELLO each
## way, which must be the first record; then, in modes v and p, the commit-reveal SAS. Nothing is
## delivered to the host (`record` events) before that. Every failure ends the session; before the
## transport exists nothing is sent, after it a CLOSE record names the code.
##
## Options (a Dictionary given to `create`):
##   mode, role, slug   "a" | "v" | "p" | "c"; "initiator" | "responder"; the product slug
##   static_key         the X25519 private key (32 bytes): the device's agreement key in mode a, a
##                      one-time key in v and p. Or a key port with `public_key()` and `dh(remote)`
##                      (G1): the private key then never leaves the port. `dh` answers the 32-byte
##                      secret, or null when it refuses
##   account            mode a only: {trust, expected_aud, cert_jws, own_sub, own_device_id,
##                      held_ring: Callable() -> {jws, epoch} or null, disc_keys: [bytes or null]
##                      newest first}. The initiator uses the first key, the responder tries the
##                      first two (G2)
##   contacts           mode c, and a mode a responder that also serves contacts (the shared listener,
##                      section 15.10): Array of {secret: 32 bytes, agree_key: 43 characters} in
##                      `PKeyPeerContact.trial_order`. A mode c initiator names exactly one; a responder up
##                      to 72 and needs `admission`. The static key is the device's agreeKey (or a port)
##   exchange           mode p only: take part in the contact exchange, {agree_key, label?, cats, held?}.
##                      The session then owns CONFIRM and CONTACT and ends the exchange with a `contact`
##                      event; without it the host sees both as records
##   caps               the capabilities this side offers. Mode v adds `vouch/1` itself and requires
##                      it of the peer (section 15.6.1 rule 1)
##   hold_sas           the mode v initiator only: send no SAS_COMMIT at HELLO; the host starts the
##                      code with `start_sas()` once the person chose this approver (CC-15 N9)
##   hello              {label?, platform, app, max_message?}
##   send               Callable(noise: PackedByteArray), one Noise message to the peer
##   on_event           Callable(event: Dictionary), see below
##   crypto, now, mono  a PKeyPeerCrypto; Callable() -> epoch seconds; Callable() -> monotonic seconds
##   offload            Callable(work: Callable) -> Variant, a coroutine: runs `work` off the main
##                      thread and answers its result (PKeyPeerPump.offload). Empty: inline
##   admission          a PKeyPeerLimiter, required of a responder in modes v and p
##   rekey_messages, rekey_seconds   rekey after this many sent messages (2^20) or seconds (3600)
##
## Events (`type`): `established` {caps, hello {label?, platform, app, max_message},
## hello_authenticated (mode a only), remote_static, peer_device_id ("" outside mode a), contact_index
## (mode c: the index in `contacts`)}, `sas` {code, display},
## `record` {record_type, body}, `contact` {secret, agree_key, label?, cats, pending} (mode p with
## `exchange`; the secret is key material: store it, never log it), `ring` {jws, epoch}, `trust_unverified` {jws}, `ring_wanted`,
## `closed` {code, by_peer}.
##
## Threads (CC-14 D-2). `start` and `receive` are coroutines. A handshake step runs its Noise work
## (the X25519 ladders) through `offload`; while that task runs the session is busy and the main
## thread touches nothing the task uses: `close` is deferred to the end of the step, `tick` does
## nothing and later messages wait in a queue. The task closure only reads and writes the Noise
## handshake and the crypto port; every callback, event and JWS check runs on the calling thread.
## Everything after the transport exists runs inline. A secret is held in a PackedByteArray and
## filled with zeros when it is replaced or the session ends (best effort).
##
## Mode v (CC-15b.G1, R-6G ruling 5): one `PKeyPeerVouch.Flow` per session judges every vouch and Sync
## record in both directions (rule 7 and 12: what arrives, and what `send_record` is about to send), so
## a record in the wrong direction or order closes the session and nothing reaches the host. The host
## drives it through `vouch()`; a record the flow hands over is delivered as a `record` event (held first
## while the person's own code is unconfirmed). The code deadline restarts once: D's at `start_sas()`,
## M's when SAS_COMMIT arrives. A MORE chain over 16 KiB closes `peer_bad_frame` in modes v and p.
##
## Bounds on unauthenticated or hostile input (R-6G): a responder reads a first message of at most
## FIRST_MESSAGE_MAX bytes (a longer one closes `peer_bad_frame`, silently, with no AEAD run); an
## admitted peer's RING is worked on at most once in RING_GAP_SECONDS, and RING_DROP_LIMIT dropped ones
## close the session `peer_busy`. `abort()` ends a session with no CLOSE and no event.
##
## Errors are values: `create` and `send_record` answer a PKeyResult; a session failure is a
## `closed` event whose `code` is one of the `peer_*` close codes or `handshake_failed` (nothing is
## sent for that one). No key, nonce, ticket or certificate is put in `str()`.

const CLOSE_CODES := [&"peer_revoked", &"peer_expired", &"peer_bad_frame", &"peer_unknown_critical", &"peer_not_allowed", &"peer_busy", &"peer_timeout", &"peer_bye"]
const HANDSHAKE_FAILED := &"handshake_failed"
const PEER_BYE := &"peer_bye"
const PEER_BAD_FRAME := &"peer_bad_frame"
const PEER_UNKNOWN_CRITICAL := &"peer_unknown_critical"
const PEER_NOT_ALLOWED := &"peer_not_allowed"
const PEER_BUSY := &"peer_busy"
const PEER_TIMEOUT := &"peer_timeout"
const PEER_EXPIRED := &"peer_expired"
const PEER_REVOKED := &"peer_revoked"
## Seconds from the first byte to the transport, and to the person's confirmation (v and p).
const TRANSPORT_DEADLINE_SECONDS := 30.0
const SAS_DEADLINE_SECONDS := 120.0
## Section 15.6: records held before the person's confirmation, modes v and p, and their bytes.
const MAX_QUEUED := 16
const MAX_QUEUED_BYTES := 16 * 1024
## The most a responder reads of a first message (R-6G B2): ephemeral key, tag and 256 bytes of
## payload. A real one is 55 bytes (`{"v":1}`); a longer one is refused before any HKDF or AEAD runs,
## so an unauthenticated peer cannot make the main thread open a frame of its choosing.
const FIRST_MESSAGE_MAX := 32 + 16 + 256
## At most one RING is worked on per this many seconds and session (R-6G B4): each costs up to two
## Ed25519 verifies. The rest are dropped, and RING_DROP_LIMIT of them in a window close the session.
const RING_GAP_SECONDS := 10.0
const RING_DROP_LIMIT := 8
const DEFAULT_REKEY_MESSAGES := 1 << 20
const DEFAULT_REKEY_SECONDS := 3600.0
const VOUCH_CAP := "vouch/1"
const MODES := ["a", "v", "p", "c"]

var _mode: String
var _role: String
var _slug: String
var _static: Variant
var _account: Dictionary = {}
var _caps: Array = []
var _hello: Dictionary = {}
var _send_cb: Callable
var _on_event: Callable
var _crypto: PKeyPeerCrypto
var _now_cb: Callable
var _mono_cb: Callable
var _offload: Callable
var _admission: PKeyPeerLimiter
var _rekey_messages: int
var _rekey_seconds: float

var _phase := &"hs"
var _hs: PKeyPeerNoise.Handshake
var _hs_step := 0
var _tp: PKeyPeerNoise.Transport
var _asm: PKeyPeerRecord.Assembler
var _hash := PackedByteArray()
var _queue: Array = []
var _busy := false
var _pending_close: StringName = &""
var _peer_caps: Array = []
var _peer_ring := 0
var _peer_cert_jws := ""
var _peer_remote := PackedByteArray()
var _peer_device_id := ""
var _max_send := PKeyPeerRecord.MAX_MESSAGE
var _sent_count := 0
var _keyed_at := 0.0
var _held: Array = []
var _flow: PKeyPeerVouch.Flow
var _hold_sas := false
var _contacts: Array = []
var _contact_idx := -1
var _xchg: PKeyPeerContact.Exchange
var _xchg_offer: Dictionary = {}
var _xchg_deadline := INF
var _ticket: PKeyPeerLimiter.Ticket
var _clock_started := false
var _transport_deadline := INF
var _sas_deadline := INF
var _expires_at := 0
var _ring_at := -INF
var _ring_dropped := 0
var _aborted := false
var _wipe_pending := false
# SAS state
var _n_d := PackedByteArray()
var _n_m := PackedByteArray()
var _commit := ""
var _sas_done := false
var _sas_step := 0


## A session from `options`, or `invalid-options` naming the problem. ok with the session.
static func create(options: Dictionary) -> PKeyResult:
	var mode: Variant = options.get("mode")
	var role: Variant = options.get("role")
	if not (mode is String and MODES.has(mode)) or not (role is String and ["initiator", "responder"].has(role)):
		return _invalid("mode and role")
	if not options.get("slug") is String or options["slug"] == "":
		return _invalid("slug")
	if not options.get("send") is Callable or not (options["send"] as Callable).is_valid():
		return _invalid("send")
	if not options.get("on_event") is Callable or not (options["on_event"] as Callable).is_valid():
		return _invalid("on_event")
	var port := _static_port(options.get("static_key"))
	if port == null:
		return _invalid("static_key")
	if (mode == "a") != options.has("account"):
		return _invalid("account")
	if mode == "a" and not _account_ok(options["account"]):
		return _invalid("account")
	if mode != "a" and role == "responder" and not options.get("admission") is PKeyPeerLimiter:
		return _invalid("an approver needs an admission limiter")
	var contacts_bad := PKeyPeerContactFlow.options_problem(mode, role, options)
	if contacts_bad != "":
		return _invalid(contacts_bad)
	if options.get("hold_sas", false) != false and not (options["hold_sas"] == true and mode == "v" and role == "initiator"):
		return _invalid("hold_sas is for the mode v initiator")
	var hello: Variant = options.get("hello")
	if not hello is Dictionary or not (hello as Dictionary).get("platform") is String or not (hello as Dictionary).get("app") is String:
		return _invalid("hello")
	return PKeyResult.success(PKeyPeerSession.new(options, port))


static func _invalid(what: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "Peer session: bad option: %s." % what)


static func _account_ok(a: Variant) -> bool:
	if not a is Dictionary:
		return false
	var d: Dictionary = a
	for k in ["expected_aud", "cert_jws", "own_sub", "own_device_id"]:
		if not d.get(k) is String or d[k] == "":
			return false
	return d.get("trust") is Dictionary and d.get("held_ring") is Callable and (d["held_ring"] as Callable).is_valid() and d.get("disc_keys") is Array


## The static key as a port whose public half is read once, here, on the calling thread.
static func _static_port(key: Variant) -> Variant:
	if key is PackedByteArray:
		return (key as PackedByteArray).duplicate() if (key as PackedByteArray).size() == 32 else null
	if key is Object and (key as Object).has_method("public_key") and (key as Object).has_method("dh"):
		var pub: Variant = (key as Object).call("public_key")
		if pub is PackedByteArray and (pub as PackedByteArray).size() == 32:
			return StaticPort.new(key, pub)
	return null


func _init(options: Dictionary, port: Variant) -> void:
	_mode = options["mode"]
	_role = options["role"]
	_slug = options["slug"]
	_static = port
	_account = options.get("account", {})
	_caps = (options.get("caps", []) as Array).duplicate()
	# Both mode-v payloads list `vouch/1` (section 15.6.1 rule 1); the host cannot leave it out.
	if _mode == "v":
		if not _caps.has(VOUCH_CAP):
			_caps.append(VOUCH_CAP)
		_flow = PKeyPeerVouch.Flow.new("requester" if _role == "initiator" else "approver")
		_hold_sas = options.get("hold_sas", false) == true
	for c: Dictionary in options.get("contacts", []):
		_contacts.append({"secret": (c["secret"] as PackedByteArray).duplicate(), "agree_key": c["agree_key"]})
	if options.get("exchange") is Dictionary:
		_xchg_offer = (options["exchange"] as Dictionary).duplicate(true)
		_xchg = PKeyPeerContact.Exchange.new(_xchg_offer["agree_key"], _xchg_offer.get("held", []))
	_hello = options["hello"]
	_send_cb = options["send"]
	_on_event = options["on_event"]
	_crypto = options.get("crypto", null) if options.get("crypto") is PKeyPeerCrypto else PKeyPeerCrypto.for_platform()
	_now_cb = options.get("now", Callable())
	_mono_cb = options.get("mono", Callable())
	_offload = options.get("offload", Callable())
	_admission = options.get("admission", null)
	_rekey_messages = int(options.get("rekey_messages", DEFAULT_REKEY_MESSAGES))
	_rekey_seconds = float(options.get("rekey_seconds", DEFAULT_REKEY_SECONDS))
	_asm = PKeyPeerRecord.Assembler.new(_mode)
	_keyed_at = _mono()


func _to_string() -> String:
	return "PKeyPeerSession(%s %s %s)" % [_mode, _role, _phase]


# -- state ---------------------------------------------------------------------------------------

func mode() -> String:
	return _mode


func role() -> String:
	return _role


## True once the session is open: mode a after HELLO, modes v and p after the person's confirmation.
func is_open() -> bool:
	return _phase == &"open"


func is_closed() -> bool:
	return _phase == &"closed"


## True while a step is running (a handshake task, or an event handler called from a step).
func is_busy() -> bool:
	return _busy


## The admitted certificate's device id in mode a; "" before the HELLO and in modes v and p.
func peer_device_id() -> String:
	return _peer_device_id


## Mode c: the index, in `contacts`, of the contact the peer is; -1 before the first message is
## opened and in the other modes.
func contact_index() -> int:
	return _contact_idx


## The Noise handshake hash `h` (a copy) once the session is established; empty before.
func handshake_hash() -> PackedByteArray:
	return _hash.duplicate()


# -- driving it ----------------------------------------------------------------------------------

## Initiator only: write message 1. A coroutine.
func start() -> void:
	if _role != "initiator" or _hs != null or _hs_step != 0 or _phase == &"closed":
		return
	_queue.append(null)
	await _drain()


## One Noise message from the peer (a de-framed TCP frame, or a relay `RECV` body). A coroutine; a
## call made while a step is running only queues the message, and the running step takes it.
func receive(noise: PackedByteArray) -> void:
	if _phase == &"closed":
		return
	_queue.append(noise)
	await _drain()


## Send one message of the host's, split into records. Only once the session is open. ok on success;
## `state` when the session is not open or the type belongs to the session, `too_large` over the
## size the peer accepts.
func send_record(type: int, body: PackedByteArray) -> PKeyResult:
	if _phase != &"open":
		return PKeyResult.failure(&"state", "The session is not open.")
	if _owned(type):
		return PKeyResult.failure(&"state", "That record type belongs to the session.")
	if body.size() > _max_send:
		return PKeyResult.failure(&"too_large", "The message is larger than the peer accepts.")
	if _flow != null:
		# The sender's checks are the receiver's (rule 7): a record out of order or direction ends the session.
		var verdict := _flow.send({"type": type, "body": body})
		if not verdict["ok"]:
			close(verdict["close"])
			return PKeyResult.failure(&"state", "The record is not allowed now.")
	var code := _emit_records(type, body)
	if code != &"":
		_fail(code, false)
		return PKeyResult.failure(&"state", "The session is closed.")
	return PKeyResult.success()


## Close with a code; sends CLOSE when the transport exists. While a step is running the close waits
## for its end.
func close(code: StringName = PEER_BYE) -> void:
	if _busy:
		if _pending_close == &"":
			_pending_close = code
		return
	_fail(code, false)


## End the session now, with no CLOSE and no `closed` event (the link that owns it reports the end):
## the clocks stop, an approver's limiter slot is released, and the secrets are wiped (when a step is
## running, at its end). Nothing the session says after this reaches the host.
func abort() -> void:
	if _phase == &"closed" and _aborted:
		return
	_aborted = true
	_phase = &"closed"
	_stop_clock()
	_held = []
	_queue = []
	if _busy:
		_wipe_pending = true
	else:
		_wipe()


## Modes v and p: the person confirmed the code. Opens the session, sends `CONFIRM` in mode p and
## delivers the host records held meanwhile. Any other time it closes the session `peer_not_allowed`.
func confirm_sas() -> void:
	if _phase != &"sas_shown":
		close(PEER_NOT_ALLOWED)
		return
	_phase = &"open"
	_settle()
	if _mode == "p":
		var code := _emit_records(PKeyPeerRecord.CONFIRM, "{}".to_utf8_buffer())
		if code != &"":
			_fail(code, false)
			return
	if _xchg != null:
		# The peer's CONTACT must follow within CONTACT_EXCHANGE_SECONDS of this CONFIRM.
		_xchg_deadline = _mono() + PKeyPeerContact.CONTACT_EXCHANGE_SECONDS
		var failed := _exchange_step(PKeyPeerContact.Exchange.OWN_CONFIRM)
		if failed != &"":
			_fail(failed, false)
			return
	var held := _held
	_held = []
	for m in held:
		if _phase == &"closed":
			return
		_emit({"type": &"record", "record_type": m["type"], "body": m["body"]})


## Mode v, a `hold_sas` initiator: the person chose this approver. Sends SAS_COMMIT now and starts the
## code deadline over. Only once and only after `established`; any other call closes the session
## `peer_not_allowed`.
func start_sas() -> void:
	if not _hold_sas or _phase != &"sas" or _sas_step != 0 or not _n_d.is_empty():
		close(PEER_NOT_ALLOWED)
		return
	# The code deadline counts from the person's choice, not from the first byte (N9).
	_sas_deadline = _mono() + SAS_DEADLINE_SECONDS
	var code := _commit_sas()
	if code != &"":
		_fail(code, false)


## Mode v: the host's handle on this session's vouch flow (`PKeyPeerVouchPort`); a new one each call.
func vouch() -> PKeyPeerVouchPort:
	return PKeyPeerVouchPort.new(self)


## The deadlines: call it every frame (the link does). A transport or code that takes too long closes
## `peer_timeout`; a peer certificate past its end closes `peer_expired`. It does nothing while a step
## is running.
func tick() -> void:
	if _phase == &"closed" or _busy:
		return
	var t := _mono()
	if t >= _transport_deadline or t >= _sas_deadline:
		_fail(PEER_TIMEOUT, false)
	elif t >= _xchg_deadline:
		_xchg_deadline = INF
		var late := _exchange_step(PKeyPeerContact.Exchange.TIMEOUT)
		if late != &"":
			_fail(late, false)
	elif _expires_at > 0 and _now() >= _expires_at:
		_fail(PEER_EXPIRED, false)


# -- the step loop -------------------------------------------------------------------------------

func _drain() -> void:
	if _busy:
		return
	_busy = true
	while not _queue.is_empty() and _phase != &"closed":
		var item: Variant = _queue.pop_front()
		var code: StringName
		if item is PackedByteArray:
			code = await _receive_step(item)
		else:
			code = await _start_step()
		if _pending_close != &"":
			code = _pending_close
		_pending_close = &""
		if code != &"":
			_fail(code, false)
	_busy = false
	if _wipe_pending:
		_wipe_pending = false
		_wipe()
	if _pending_close != &"":
		var late := _pending_close
		_pending_close = &""
		_fail(late, false)


func _start_step() -> StringName:
	var key: Variant = null
	if _mode == "a":
		key = _disc_key(0)
		if key == null:
			return HANDSHAKE_FAILED
	elif _mode == "c":
		_contact_idx = 0
		key = _contacts[0]["secret"]
	_start_clock()
	var hs := _new_handshake(_mode, PKeyPeerContactFlow.psk_for(_slug, _mode, key))
	if hs == null:
		return HANDSHAKE_FAILED
	var first := await _noise(func() -> PKeyResult: return hs.write_message(PKeyPeerPayload.payload1()))
	if not first.ok:
		return HANDSHAKE_FAILED
	_hs = hs
	_send_cb.call(first.detail)
	_hs_step = 1
	return &""


func _receive_step(noise: PackedByteArray) -> StringName:
	if not _clock_started and _role == "responder":
		# An approver counts the attempt only now that a session starts. A contact responder is
		# admitted at its contact trial instead (message 1 is tried under the account's keys first).
		if _admission != null and (_mode == "v" or _mode == "p"):
			_ticket = _admission.begin()
			if _ticket == null:
				return PEER_BUSY
		_start_clock()
	if _phase == &"hs":
		return await _on_handshake(noise)
	return _on_transport(noise)


## The discovery key `i` (newest first) as bytes, or null when it is absent or unusable.
func _disc_key(i: int) -> Variant:
	var keys: Array = _account["disc_keys"]
	if i >= keys.size() or not keys[i] is PackedByteArray or (keys[i] as PackedByteArray).size() != 32:
		return null
	return keys[i]


func _new_handshake(mode: String, psk: Variant) -> PKeyPeerNoise.Handshake:
	if psk is PackedByteArray and (psk as PackedByteArray).is_empty():
		return null
	var r := PKeyPeerNoise.start(_role, PKeyPeerNoise.protocol_name(mode), PKeyPeerNoise.prologue(_slug, mode), _static, psk, null, _crypto)
	return r.detail if r.ok else null


## Runs Noise work through the offload hook. The closure may touch only what it was handed.
func _noise(work: Callable) -> PKeyResult:
	var out: Variant = work.call() if not _offload.is_valid() else await _offload.call(work)
	# A task that failed to run answers nothing: that is a refusal, not an error.
	return out if out is PKeyResult else PKeyResult.failure(&"state")


func _on_handshake(noise: PackedByteArray) -> StringName:
	if _role == "responder" and _hs == null:
		return await _on_first_message(noise)
	var hs := _hs
	var initiator := _role == "initiator"
	if hs == null or _hs_step != (1 if initiator else 2):
		return HANDSHAKE_FAILED
	var read := await _noise(func() -> PKeyResult: return hs.read_message(noise))
	var verdict := PKeyPeerPayload.parse_handshake_payload(_mode, 2 if initiator else 3, read.detail) if read.ok else {"ok": false}
	var refused := _remote_refusal(verdict, hs.remote_static())
	if refused != &"":
		return refused
	var remote := hs.remote_static()
	var peer_device_id := ""
	if _mode == "a":
		var admitted := _admit_account(verdict, remote)
		if admitted["code"] != &"":
			return admitted["code"]
		peer_device_id = admitted["device_id"]
	_peer_caps = verdict["caps"]
	if initiator:
		var sent := await _write_third(hs)
		if sent != &"":
			return sent
	return _open_transport(hs, remote, peer_device_id)


## The close code for a handshake payload or remote key this session refuses, or "". The pin (section 15.10):
## in mode c the remote static key must be the agreeKey of the contact the secret belongs to; the initiator
## asks after message 2, the responder after message 3, and a mismatch is `peer_revoked` with nothing sent.
func _remote_refusal(verdict: Dictionary, remote: PackedByteArray) -> StringName:
	if not verdict["ok"]:
		return HANDSHAKE_FAILED
	if _mode == "c" and not PKeyPeerContact.pin(_contacts[_contact_idx]["agree_key"], remote):
		return PEER_REVOKED
	return &""


## The initiator's message 3.
func _write_third(hs: PKeyPeerNoise.Handshake) -> StringName:
	var own := _own_payload()
	if own.is_empty():
		return HANDSHAKE_FAILED
	var third := await _noise(func() -> PKeyResult: return hs.write_message(own))
	if not third.ok or _aborted:
		return HANDSHAKE_FAILED
	_send_cb.call(third.detail)
	return &""


## Message 1 of a responder (section 15.5 and 15.10): the keys are tried in a fixed order by
## `PKeyPeerContactFlow.first_message`, one offloaded task (R-6G B2: a first message over
## `FIRST_MESSAGE_MAX` bytes is refused before any key is tried).
func _on_first_message(noise: PackedByteArray) -> StringName:
	if noise.size() > FIRST_MESSAGE_MAX:
		# Nothing is sent and no HKDF or AEAD runs over a frame nobody has authenticated (R-6G B2).
		return PEER_BAD_FRAME
	var ctx := {
		"mode": _mode, "slug": _slug, "static_key": _static, "crypto": _crypto, "admission": _admission,
		"account": [_disc_key(0), _disc_key(1)] if _mode == "a" else null,
		"secrets": _contacts.map(func(c: Dictionary) -> PackedByteArray: return c["secret"]),
	}
	var res := await PKeyPeerContactFlow.first_message(noise, ctx, _offload)
	if res["ticket"] != null:
		# Held until the transport opens (a contact hit) or the session ends.
		_ticket = res["ticket"]
	var hit: String = res["hit"]
	if hit == "":
		return res["close"] if res["close"] != &"" else HANDSHAKE_FAILED
	if hit.begins_with("c:"):
		_contact_idx = int(hit.substr(2))
		_mode = "c"
		_asm = PKeyPeerRecord.Assembler.new("c")
	if _aborted or not PKeyPeerPayload.parse_handshake_payload(_mode, 1, res["payload"])["ok"]:
		return HANDSHAKE_FAILED
	var own := _own_payload()
	if own.is_empty():
		return HANDSHAKE_FAILED
	var hs: PKeyPeerNoise.Handshake = res["hs"]
	var second := await _noise(func() -> PKeyResult: return hs.write_message(own))
	if not second.ok:
		return HANDSHAKE_FAILED
	_hs = hs
	_send_cb.call(second.detail)
	_hs_step = 2
	return &""


func _own_payload() -> PackedByteArray:
	if _mode != "a":
		return PKeyPeerPayload.payload23(_mode, _caps)
	var ring: Variant = (_account["held_ring"] as Callable).call()
	return PKeyPeerPayload.payload23(_mode, _caps, {"cert": _account["cert_jws"], "ring": int(ring["epoch"]) if ring is Dictionary else 1})


## Mode a: the peer's certificate against the remote static key and the held ring (section 15.3).
## {code, device_id}; a code of "" admits. A held roster that is expired, unverifiable or another
## account's must not admit: ask for a fresh one and refuse. Only a device with no roster at all
## (first run) admits on the certificate.
func _admit_account(verdict: Dictionary, remote: PackedByteArray) -> Dictionary:
	var a := _account
	var held: Variant = (a["held_ring"] as Callable).call()
	var held_jws: Variant = null
	if held is Dictionary:
		held_jws = held["jws"]
		var v := PKeyPeerCert.verify_ring(held_jws, a["trust"], a["expected_aud"])
		if not v["ok"] or PKeyPeerCert.ring_expired(v["ring"], _now()) or v["ring"]["sub"] != a["own_sub"]:
			_emit({"type": &"ring_wanted"})
			return {"code": HANDSHAKE_FAILED}
	else:
		_emit({"type": &"ring_wanted"})
	var adm := _admit(verdict["cert"], held_jws, remote)
	if not adm["admit"]:
		return {"code": PEER_REVOKED if adm["reason"] == "peer_revoked" else HANDSHAKE_FAILED}
	_peer_cert_jws = verdict["cert"]
	_peer_remote = remote
	var wait: int = int(adm["cert"]["expires_at"]) - _now()
	if wait <= 0:
		return {"code": PEER_EXPIRED}
	_expires_at = int(adm["cert"]["expires_at"])
	_peer_ring = int(verdict["ring"])
	if adm["ring_sync"] == "request":
		_emit({"type": &"ring_wanted"})
	return {"code": &"", "device_id": adm["cert"]["device_id"]}


func _admit(cert_jws: String, ring_jws: Variant, remote: PackedByteArray) -> Dictionary:
	var a := _account
	return PKeyPeerCert.admit_peer(cert_jws, ring_jws, a["trust"], a["expected_aud"], _now(), {
		"mode": "a", "remote_static": PKeyB64Url.encode(remote), "own_sub": a["own_sub"], "own_device_id": a["own_device_id"],
	})


## The handshake is done: the transport ciphers, then HELLO.
func _open_transport(hs: PKeyPeerNoise.Handshake, remote: PackedByteArray, peer_device_id: String) -> StringName:
	if _aborted:
		# Aborted mid-step (the wipe is pending): do not come back to life as `hello` (R-6G2 N8).
		return HANDSHAKE_FAILED
	_hash = hs.handshake_hash()
	var tp := hs.transport()
	if not tp.ok:
		return HANDSHAKE_FAILED
	_tp = tp.detail
	_hs = null
	_transport_deadline = INF
	_keyed_at = _mono()
	_phase = &"hello"
	_peer_remote = remote
	_peer_device_id = peer_device_id
	var h := _hello
	var body := PKeyPeerPayload.hello_body(str(h.get("label", "")), h["platform"], h["app"], int(h.get("max_message", PKeyPeerPayload.DEFAULT_MAX_MESSAGE)))
	return _emit_records(PKeyPeerRecord.HELLO, body)


# -- the transport -------------------------------------------------------------------------------

func _on_transport(noise: PackedByteArray) -> StringName:
	var plain := _tp.receive.decrypt(PackedByteArray(), noise)
	if not plain.ok:
		return PEER_BAD_FRAME
	var rec := PKeyPeerRecord.parse(plain.detail)
	if not rec["ok"]:
		return PEER_BAD_FRAME
	var r := _asm.push(rec)
	if r["kind"] == &"close":
		return r["code"]
	if r["kind"] != &"message":
		return &""
	return _on_message(r["type"], r["body"])


func _on_message(type: int, body: PackedByteArray) -> StringName:
	if _phase == &"hello":
		return _on_hello(type, body)
	var control: Variant = _on_control(type, body)
	if control != null:
		return control
	return _on_host_record(type, body)


## The records the session owns. A failure code or "" for one of them; null for any other type, which
## belongs to the host.
func _on_control(type: int, body: PackedByteArray) -> Variant:
	var code: Variant = null
	match type:
		PKeyPeerRecord.HELLO:
			code = PEER_BAD_FRAME
		PKeyPeerRecord.PING:
			code = _emit_records(PKeyPeerRecord.PONG, body)
		PKeyPeerRecord.PONG:
			code = &""
		PKeyPeerRecord.REKEY:
			code = &"" if _tp.receive.rekey().ok else PEER_BAD_FRAME
		PKeyPeerRecord.CLOSE:
			code = _on_peer_close(body)
		PKeyPeerRecord.TRUST:
			code = _on_trust(body) if _mode == "a" else PEER_NOT_ALLOWED
		PKeyPeerRecord.SAS_COMMIT, PKeyPeerRecord.SAS_NONCE, PKeyPeerRecord.SAS_REVEAL:
			code = _on_sas(type, body)
		PKeyPeerRecord.RING:
			code = _on_ring(body) if _mode == "a" else PEER_NOT_ALLOWED
		PKeyPeerRecord.CONFIRM, PKeyPeerRecord.CONTACT:
			if _xchg != null:
				code = _on_exchange_record(type, body)
	return code


## With the exchange on, the session owns CONFIRM and CONTACT, and only once the code is shown.
func _on_exchange_record(type: int, body: PackedByteArray) -> StringName:
	if _phase != &"sas_shown" and _phase != &"open":
		return PEER_NOT_ALLOWED
	if type == PKeyPeerRecord.CONFIRM:
		return _exchange_step(PKeyPeerContact.Exchange.PEER_CONFIRM)
	return _exchange_step(PKeyPeerContact.Exchange.PEER_CONTACT, body)


## One event through the contact exchange: the failure code, or "". CONFIRM is sent by `confirm_sas`
## itself; only CONTACT is the exchange's to send. The peer's valid CONTACT becomes a `contact` event.
func _exchange_step(event: String, body := PackedByteArray()) -> StringName:
	var r := _xchg.step(event, body)
	if r.has("close"):
		return r["close"]
	if (r["sends"] as Array).has("CONTACT"):
		var built := PKeyPeerContact.build_contact(_xchg_offer)
		if not built.ok:
			return PEER_BAD_FRAME
		var code := _emit_records(PKeyPeerRecord.CONTACT, built.detail)
		if code != &"":
			return code
	if r.has("stored"):
		var event_out := PKeyPeerContactFlow.contact_event(r["stored"], _xchg_offer["agree_key"], _hash, _n_d, _n_m)
		if event_out.is_empty():
			return PEER_BAD_FRAME
		_n_d.fill(0)
		_n_m.fill(0)
		_emit(event_out)
	return &""


func _on_trust(body: PackedByteArray) -> StringName:
	var o: Variant = PKeyPeerPayload.parse_strict_object(body)
	if o == null or not (o as Dictionary).get("trust") is String:
		return PEER_BAD_FRAME
	_emit({"type": &"trust_unverified", "jws": o["trust"]})
	return &""


## A record the host owns, and only once the code is settled.
func _on_host_record(type: int, body: PackedByteArray) -> StringName:
	if _flow == null:
		return _deliver_host_record(type, body)
	# Before the code is settled on this side there is nothing to hold a record for.
	if _phase != &"sas_shown" and _phase != &"open":
		return PEER_NOT_ALLOWED
	var verdict := _flow.receive({"type": type, "body": body})
	if not verdict["ok"]:
		return verdict["close"]
	for r in verdict["deliver"]:
		var code := _deliver_host_record(r["type"], r["body"])
		if code != &"":
			return code
	return &""


## Hands a record to the host: held (bounded) until this side's person confirms, delivered after.
func _deliver_host_record(type: int, body: PackedByteArray) -> StringName:
	if _phase == &"sas_shown":
		# The peer may confirm first: hold the record (bounded) until this side's person does.
		var bytes := 0
		for m in _held:
			bytes += (m["body"] as PackedByteArray).size()
		if _held.size() >= MAX_QUEUED or bytes + body.size() > MAX_QUEUED_BYTES:
			return PEER_BUSY
		_held.append({"type": type, "body": body})
		return &""
	if _phase != &"open":
		return PEER_NOT_ALLOWED
	_emit({"type": &"record", "record_type": type, "body": body})
	return &""


## The first record each way is HELLO; anything else is refused and closed.
func _on_hello(type: int, body: PackedByteArray) -> StringName:
	var hello := PKeyPeerPayload.parse_hello(_mode, body) if type == PKeyPeerRecord.HELLO else {"ok": false}
	if not hello["ok"]:
		return PEER_BAD_FRAME
	_max_send = mini(PKeyPeerRecord.MAX_MESSAGE, int(hello["max_message"]))
	var caps := PKeyPeerPayload.caps_intersection(_caps, _peer_caps)
	# Rule 1 (section 15.6.1): without `vouch/1` on both sides, close before any SAS record.
	if _flow != null:
		var negotiated := _flow.negotiate(_caps, _peer_caps)
		if not negotiated["ok"]:
			return negotiated["close"]
	_caps = caps
	var direct := _mode == "a" or _mode == "c"
	_phase = &"open" if direct else &"sas"
	if direct:
		# A contact responder's slot among the connections waiting for message 3 ends here.
		_settle()
	var shown := {"platform": hello["platform"], "app": hello["app"], "max_message": hello["max_message"]}
	if hello.has("label"):
		shown["label"] = hello["label"]
	_emit({
		"type": &"established", "caps": caps.duplicate(), "hello": shown, "hello_authenticated": _mode == "a",
		"remote_static": _peer_remote.duplicate(), "peer_device_id": _peer_device_id,
		"contact_index": _contact_idx if _mode == "c" else -1,
	})
	if _phase == &"closed":
		return &""
	if direct:
		return _push_ring() if _mode == "a" else &""
	# D commits first, unless the host holds the code back until the person chose this approver.
	return _commit_sas() if _role == "initiator" and not _hold_sas else &""


func _on_peer_close(body: PackedByteArray) -> StringName:
	var o: Variant = PKeyPeerPayload.parse_strict_object(body)
	var code := ""
	if o != null and (o as Dictionary).get("code") is String:
		code = o["code"]
	_phase = &"closed"
	_stop_clock()
	_held = []
	var named := StringName(code) if CLOSE_CODES.has(StringName(code)) else PEER_BAD_FRAME
	_wipe()
	_emit({"type": &"closed", "code": named, "by_peer": true})
	return &""


func _push_ring() -> StringName:
	var held: Variant = (_account["held_ring"] as Callable).call()
	if held is Dictionary and int(held["epoch"]) > _peer_ring:
		return _emit_records(PKeyPeerRecord.RING, PKeyJson.stringify({"ring": held["jws"]}).to_utf8_buffer())
	return &""


func _on_ring(body: PackedByteArray) -> StringName:
	# One RING in RING_GAP_SECONDS is worked on; the rest are dropped without a parse or a verify, and a
	# peer that keeps sending them is closed (R-6G B4). The host refetches through `ring_wanted`.
	var t := _mono()
	if t - _ring_at < RING_GAP_SECONDS:
		_ring_dropped += 1
		return PEER_BUSY if _ring_dropped >= RING_DROP_LIMIT else &""
	_ring_at = t
	_ring_dropped = 0
	var a := _account
	var o: Variant = PKeyPeerPayload.parse_strict_object(body)
	if o == null or not (o as Dictionary).get("ring") is String:
		return PEER_BAD_FRAME
	var held: Variant = (a["held_ring"] as Callable).call()
	var r := PKeyPeerCert.replace_ring(held["jws"] if held is Dictionary else null, o["ring"], a["trust"], a["expected_aud"], _now())
	# A roster that is stale, older or another account's changes nothing.
	if not r["replace"] or r["ring"]["sub"] != a["own_sub"]:
		return &""
	_emit({"type": &"ring", "jws": o["ring"], "epoch": int(r["ring"]["epoch"])})
	if _phase == &"closed":
		return &""
	# The new roster may have dropped this peer.
	if not _admit(_peer_cert_jws, o["ring"], _peer_remote)["admit"]:
		return PEER_REVOKED
	return &""


## The host stored a newer roster: judge the peer's certificate against it again, as the handshake does, and
## close `peer_revoked` when the roster no longer lists the peer with the keys it holds (mode a).
func recheck(ring_jws: String) -> void:
	if _phase == &"closed" or _account.is_empty() or _peer_cert_jws == "":
		return
	if not _admit(_peer_cert_jws, ring_jws, _peer_remote)["admit"]:
		close(PEER_REVOKED)


# -- the short authentication code (modes v and p) ----------------------------------------------

func _commit_sas() -> StringName:
	_n_d = _crypto.random_bytes(32)
	var code := _emit_records(PKeyPeerRecord.SAS_COMMIT, PKeyPeerSas.body("c", PKeyPeerSas.commit(_n_d)))
	_sas_step = 1
	return code


func _on_sas(type: int, body: PackedByteArray) -> StringName:
	if _phase != &"sas" or _sas_done:
		return PEER_BAD_FRAME
	var initiator := _role == "initiator"
	# Responder (M): COMMIT then REVEAL. Initiator (D): NONCE.
	if type == PKeyPeerRecord.SAS_COMMIT and not initiator and _sas_step == 0:
		return _sas_commit_received(body)
	if type == PKeyPeerRecord.SAS_NONCE and initiator and _sas_step == 1:
		return _sas_nonce_received(body)
	if type == PKeyPeerRecord.SAS_REVEAL and not initiator and _sas_step == 1:
		return _sas_reveal_received(body)
	return PEER_BAD_FRAME


func _sas_commit_received(body: PackedByteArray) -> StringName:
	var c: Variant = PKeyPeerSas.parse_body("c", body)
	if c == null:
		return PEER_BAD_FRAME
	_commit = PKeyPeerSas.encode_value(c)
	if _mode == "v":
		# The code deadline counts from D's choice, as D's does from `start_sas()` (N5).
		_sas_deadline = _mono() + SAS_DEADLINE_SECONDS
	_n_m = _crypto.random_bytes(32)
	var sent := _emit_records(PKeyPeerRecord.SAS_NONCE, PKeyPeerSas.body("nM", _n_m))
	_sas_step = 1
	return sent


func _sas_nonce_received(body: PackedByteArray) -> StringName:
	var n_m: Variant = PKeyPeerSas.parse_body("nM", body)
	if n_m == null:
		return PEER_BAD_FRAME
	_n_m = n_m
	var revealed := _emit_records(PKeyPeerRecord.SAS_REVEAL, PKeyPeerSas.body("nD", _n_d))
	return revealed if revealed != &"" else _finish_sas()


func _sas_reveal_received(body: PackedByteArray) -> StringName:
	var n_d: Variant = PKeyPeerSas.parse_body("nD", body)
	if n_d == null or not PKeyPeerSas.reveal_ok(_commit, PKeyPeerSas.encode_value(n_d)):
		return PEER_BAD_FRAME
	_n_d = n_d
	return _finish_sas()


func _finish_sas() -> StringName:
	var code := PKeyPeerSas.value(_hash, _n_d, _n_m, _mode)
	_sas_done = true
	_phase = &"sas_shown"
	_emit({"type": &"sas", "code": code, "display": PKeyPeerSas.display(code)})
	return &""


# -- sending -------------------------------------------------------------------------------------

## Seal records onto the wire, one message at a time so a REKEY never interleaves. The failure code,
## or "".
func _emit_records(type: int, body: PackedByteArray) -> StringName:
	if _tp == null or (_phase == &"closed" and type != PKeyPeerRecord.CLOSE):
		return PEER_BAD_FRAME
	var rekeyed := _maybe_rekey()
	if rekeyed != &"":
		return rekeyed
	var parts := PKeyPeerRecord.split_message(type, body)
	if parts.is_empty():
		return PEER_BAD_FRAME
	for plain in parts:
		var sealed := _tp.send.encrypt(PackedByteArray(), plain)
		if not sealed.ok:
			return PEER_BAD_FRAME
		_send_cb.call(sealed.detail)
		_sent_count += 1
	return &""


func _maybe_rekey() -> StringName:
	var by_count := _sent_count >= _rekey_messages
	var by_seconds := _mono() - _keyed_at >= _rekey_seconds
	if not by_count and not by_seconds:
		return &""
	var sealed := _tp.send.encrypt(PackedByteArray(), PKeyPeerRecord.encode(PKeyPeerRecord.REKEY, 0, PackedByteArray()))
	if not sealed.ok:
		return PEER_BAD_FRAME
	_send_cb.call(sealed.detail)
	if not _tp.send.rekey().ok:
		return PEER_BAD_FRAME
	_sent_count = 0
	_keyed_at = _mono()
	return &""


func _fail(code: StringName, by_peer: bool) -> void:
	if _phase == &"closed":
		return
	var was_up := _tp != null
	_phase = &"closed"
	_stop_clock()
	_held = []
	if was_up and not by_peer and code != HANDSHAKE_FAILED:
		# The connection may be gone already; a CLOSE that cannot be sent changes nothing.
		_emit_records(PKeyPeerRecord.CLOSE, ('{"code":"%s"}' % code).to_utf8_buffer())
	_wipe()
	_emit({"type": &"closed", "code": code, "by_peer": by_peer})


func _wipe() -> void:
	if _tp != null:
		_tp.send.wipe()
		_tp.receive.wipe()
	_hs = null
	# Let go of the discovery keys and the roster this session was handed (a copy of a shared
	# PackedByteArray cannot be zeroed in place; dropping the references is what is cheap).
	_account = {}
	for c: Dictionary in _contacts:
		var zeros := PackedByteArray()
		zeros.resize((c["secret"] as PackedByteArray).size())
		c["secret"] = zeros
	_n_d.fill(0)
	_n_m.fill(0)
	if _static is PackedByteArray:
		(_static as PackedByteArray).fill(0)


func _emit(event: Dictionary) -> void:
	if not _aborted:
		_on_event.call(event)


# -- clocks --------------------------------------------------------------------------------------

func _start_clock() -> void:
	if _clock_started:
		return
	_clock_started = true
	var t := _mono()
	_transport_deadline = t + TRANSPORT_DEADLINE_SECONDS
	if _mode == "v" or _mode == "p":
		_sas_deadline = t + SAS_DEADLINE_SECONDS


## Modes v and p: the person confirmed. The deadline and the limiter slot end.
func _settle() -> void:
	_sas_deadline = INF
	if _ticket != null:
		_ticket.release()
		_ticket = null


func _stop_clock() -> void:
	_xchg_deadline = INF
	_transport_deadline = INF
	_expires_at = 0
	_settle()


func _mono() -> float:
	return float(_mono_cb.call()) if _mono_cb.is_valid() else float(Time.get_ticks_msec()) / 1000.0


func _now() -> int:
	return int(_now_cb.call()) if _now_cb.is_valid() else PKeyClaims.system_now()


## Records the session owns: the host cannot send them (CONFIRM is the session's in mode p).
func _owned(type: int) -> bool:
	return [
		PKeyPeerRecord.HELLO, PKeyPeerRecord.CLOSE, PKeyPeerRecord.REKEY, PKeyPeerRecord.SAS_COMMIT,
		PKeyPeerRecord.SAS_NONCE, PKeyPeerRecord.SAS_REVEAL,
	].has(type) or (type == PKeyPeerRecord.CONFIRM and _mode == "p") or (type == PKeyPeerRecord.CONTACT and _xchg != null)


## A key port whose public half was read at `create`, on the calling thread: the Noise task may run
## on another, and the port's `dh` is the only call it makes (the device key store locks inside it).
class StaticPort extends RefCounted:
	var _inner: Object
	var _pub: PackedByteArray


	func _init(inner: Object, pub: PackedByteArray) -> void:
		_inner = inner
		_pub = pub.duplicate()


	func _to_string() -> String:
		return "PKeyPeerSession.StaticPort()"


	func public_key() -> PackedByteArray:
		return _pub.duplicate()


	func dh(remote: PackedByteArray) -> Variant:
		return _inner.call("dh", remote)
