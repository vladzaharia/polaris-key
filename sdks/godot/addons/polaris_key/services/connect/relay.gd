@tool
class_name PKeyConnectRelay
extends RefCounted
## The relay half of Cloud Connect, socket side (CC-14.13; WIRE-CONTRACT-V5 section 15.7), ported from
## the socket half of sdk-node `connect/relay.ts` and the Python `connect/relay.py`. One WebSocket to
## the account room carries envelopes (`PKeyPeerRelayCodec`), and the peer sessions ride it (CC-14.14).
## Everything runs on the main thread, driven by `SceneTree.process_frame`.
##
## Rules this file keeps:
##  - a ticket is single use and lives 60 seconds, so every connect fetches a new one (`ticket`, a
##    coroutine). The socket is opened offering `pkey-relay.1` and then the ticket as subprotocols, and
##    the client requires `pkey-relay.1` echoed back (G14). The ticket is read at the moment the socket
##    opens and handed to the opener; the service keeps no copy in a field, a `str()`, a result or a log, and
##    forgets the grant's own once the socket is open (G13). The engine's socket object holds the offered
##    subprotocols until it closes: the ticket is single use, spent at the upgrade, and only ever on TLS;
##  - the real opener (`WsSocket.open`) is `WebSocketPeer` with `TLSOptions.client()` and nothing laxer:
##    only a `wss:` URL opens (the grant already names the Worker's own host), a redirect is a failed
##    handshake, the inbound buffer is one message (65,564 bytes) and the outbound one holds four, and a
##    larger message is refused;
##  - a message is at most 65,564 bytes; an envelope that fails its layout, or a text frame, closes the
##    socket with 1002 and is never answered (G14); each running service has one socket;
##  - the room stamps `from`, and it is never trusted for identity: the certificate names the peer, and the
##    two must agree or the session closes and the dial fails `wrong_peer` (G8);
##  - every session is mode `a`: the relay builds each channel with the literal mode and `assert_relay_mode`
##    refuses `v` and `p` (`mode_not_allowed`, G16); only the person's own roster devices may open a session,
##    at most 64 at once and 4 per peer, and a short memory of ended sessions drops their late messages;
##  - a session is a `PKeyPeerLink` over a `RelayPipe`: the room delivers whole Noise messages and the pipe
##    frames them for the link, so the link's budget, deadlines, backpressure and teardown apply as on the
##    LAN. The room has no flow control, so a peer that sends faster than the host reads ends `peer_busy` at
##    the byte caps;
##  - outgoing envelopes are paced (`PKeyConnectPacer`, D-9: a token bucket of 180 a second with a burst of 360;
##    LIMIT 1 halves the rate for 10 seconds; an 8 MiB queue): a session message past the queue ends that
##    session `peer_busy` and says so to the peer; control envelopes and the last records of a closing session
##    are never refused;
##  - reconnects back off exponentially with jitter and a floor, and the backoff resets only after the
##    socket stayed up 30 seconds. `Retry-After` is capped at 3,600 seconds. A product that turned the
##    relay off, or a spent quota, ends the loop with a typed error; 4009 (replaced) stops without
##    fighting back; 4003 fetches the roster once and stops after three in a row; 4001 simply gets a new
##    ticket; 4008 after LIMIT 2 or 3 is a quota error and any other 4008 backs off; after five attempts
##    that never open the status is `unavailable` and a retry waits at least five minutes (G15);
##  - the room's MEMBERS are believed only for the person's own roster;
##  - nothing here puts a ticket, key or certificate in a `str()`, a notice or a result (G13, G19).
##
## Use. `PKeyConnectRelay.new(source, ticket, options)`, then `start()`. `status()` answers
## {state, error, attempts, reason}: `state` is idle, connecting, open, backoff, unavailable, blocked,
## stopped or off; `error` a relay failure (PKeyResult) or null. Signals: `state_changed(status)`,
## `members_changed(members)`, `notice(n)`.

signal state_changed(status: Dictionary)
signal members_changed(members: Array)
signal notice(n: Dictionary)
## An inbound session, once it is open and admitted.
signal session_opened(session: PKeyConnectSession)

const PROTOCOL := "pkey-relay.1"
const MAX_MESSAGE := PKeyPeerRelayCodec.MAX_MESSAGE
## Both WebSocket buffers hold one message with room for the frame.
const BUFFER_BYTES := MAX_MESSAGE + 64
## The outbound queue holds a few messages, so several records of one frame (the pacer allows a burst) do not
## trip a full queue; `_flush` also keeps a refused one queued.
const OUTBOUND_BYTES := BUFFER_BYTES * 4
const MAX_RETRY_AFTER_S := 3600
const UNAVAILABLE_AFTER := 5
const UNAVAILABLE_RETRY_S := 300.0
const BACKOFF_BASE := 1.0
const BACKOFF_MAX := 60.0
const BACKOFF_MIN := 0.5
const STABLE_SECONDS := 30.0
const PING_SECONDS := 25.0
const OPEN_SECONDS := 15.0
const PACKETS_PER_FRAME := 32
const IDENTITY_TTL_S := 30
const CERT_MARGIN_S := 60
## Sessions at once, handshakes and sessions with one device at once, and ended sessions remembered so that
## a late message for one is dropped without work.
const MAX_SESSIONS := 64
const MAX_SESSIONS_PER_PEER := 4
const ENDED_MEMORY := 256
const HANDSHAKE_SECONDS := 30.0
const MAX_SESSION_ID := 0xffffffff
## Noise messages the room delivered and a paused link has not read: past this the session ends `peer_busy`.
const RelayPipe := preload("relay_pipe.gd")
const MAX_PIPE_BUFFER := RelayPipe.MAX_BUFFER
## `RelayPipe.read` hands the link at most this much, as the TCP pipe does.
const READ_CHUNK := RelayPipe.READ_CHUNK

var _src: PKeyConnectLan.Source
var _ticket: Callable
var _o: Dictionary
var _tree: SceneTree
var _opener: Callable
var _docs: PKeyConnectChannel.Docs
var _state := "idle"
var _error: PKeyResult = null
var _reason := ""
var _attempts := 0
var _stopped := false
var _started := false
var _open := false
var _socket: Socket = null
var _pong_at := 0.0
var _members: Dictionary = {}
var _last_limit := 0
var _last_code := -1
var _not_member := 0
var _id: Variant = null
var _pump: PKeyPeerPump
var _budget: PKeyConnectSession.Budget
var _pacer: PKeyConnectPacer
var _outbox: PKeyConnectPacer.Outbox
var _links: Dictionary = {}
var _ended: Array[String] = []
var _timer_gen := 0
var _nap_cancel := false
var _napping := false
var _running := false
var _aborted := false


## `source` is the LAN service's (`PKeyConnectLan.Source`); `ticket` a Callable answering a coroutine
## PKeyResult holding a `PKeyConnectClient.Grant` (`client.relay_ticket`). `options`: `opener`
## (Callable(url, protocols: Array) -> Socket or null; default `WsSocket.open`), `mono` (Callable() ->
## monotonic seconds), `random` (Callable() -> 0..1), `timer` (Callable(seconds, fn)), `tree`, `caps`,
## `label`, `backoff_base`, `backoff_max`, `backoff_min`, `stable_seconds`, `ping_seconds`,
## `open_seconds`, `max_sessions`, `max_pending_per_peer`, `handshake_seconds`, `rekey_messages`,
## `rekey_seconds`, `budget`, `pump`, and the pacing: `rate` (envelopes a second), `burst`, `outbox_bytes`.
func _init(source: PKeyConnectLan.Source, ticket: Callable, options := {}) -> void:
	_src = source
	_ticket = ticket
	_o = options
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	var opener: Variant = options.get("opener")
	_opener = opener if opener is Callable and (opener as Callable).is_valid() else Callable(PKeyConnectRelay, "open_ws")
	_docs = PKeyConnectChannel.Docs.new({
		"adopt_ring": source.adopt_ring, "apply_trust": source.apply_trust, "refresh": source.refresh,
		"mono": Callable(self, "_mono"),
	}, Callable(self, "_stored"), Callable(self, "_after"))
	_docs.notice.connect(Callable(self, "_on_notice"))
	_pump = options.get("pump", null) as PKeyPeerPump
	if _pump == null:
		_pump = PKeyPeerPump.new(_tree)
	# One budget for every session's queue and every pipe's unread bytes (G10); the process-wide one when
	# the caller gives none.
	_budget = options.get("budget", null) as PKeyConnectSession.Budget
	if _budget == null:
		_budget = PKeyConnectSession.shared_budget


func _to_string() -> String:
	return "PKeyConnectRelay(%s)" % _state


func _on_notice(n: Dictionary) -> void:
	notice.emit(n)


# ── the surface ──────────────────────────────────────────────────────────────────────────────


## Begin connecting; use `ready()` to wait for the socket.
func start() -> void:
	if _started or _stopped:
		return
	_started = true
	_run()


## {state, error, attempts, reason, close_code}. `error` is a relay failure (PKeyResult) or null;
## `reason` is why the relay is `off`, else ""; `close_code` the code the last socket closed with
## (-1 for none).
func status() -> Dictionary:
	return {"state": _state, "error": _error, "attempts": _attempts, "reason": _reason, "close_code": _last_code}


func is_open() -> bool:
	return _open


## The person's devices online in the room, as of the last MEMBERS (this device included), sorted.
func members() -> Array:
	var out: Array = _members.keys()
	out.sort()
	return out


## Resolves once the socket is open: ok, or the typed failure when the loop is blocked, stopped or off, or
## `not_connected` after `timeout` seconds (default: the open timeout). A coroutine.
func ready(timeout := -1.0) -> PKeyResult:
	if _open:
		return PKeyResult.success()
	if _state == "blocked" or _state == "stopped" or _state == "off":
		return _error if _error != null else _stopped_error()
	if not _started:
		start()
	var limit := _mono() + (float(_o.get("open_seconds", OPEN_SECONDS)) if timeout < 0.0 else timeout)
	while not _open and _mono() < limit:
		if _state == "blocked" or _state == "stopped" or _state == "off":
			return _error if _error != null else _stopped_error()
		await _tree.process_frame
	if _open:
		return PKeyResult.success()
	return _error if _error != null else PKeyConnectErrors.relay("not_connected", "The relay is not connected.")


## Ask the room who is online now (a LIST); answers the members on the reply or after `timeout`
## seconds. The room never pushes joins, so this is how a device learns of a new arrival. A coroutine.
func refresh_members(timeout := 2.0) -> Array:
	if not _open:
		return members()
	var heard := [false]
	var on_members := func(_m: Array) -> void: heard[0] = true
	members_changed.connect(on_members)
	_send_env({"op": &"list"})
	var limit := _mono() + timeout
	while not heard[0] and _mono() < limit and _open:
		await _tree.process_frame
	if members_changed.is_connected(on_members):
		members_changed.disconnect(on_members)
	return members()


## After a block (a quota), try again now; otherwise cut a backoff short.
func resume() -> void:
	if _stopped:
		return
	if _state == "blocked":
		_error = null
		_attempts = 0
		_started = true
		if not _running:
			_run()
	elif _napping:
		_nap_cancel = true


## Stop: the socket is closed 1000, every pending wait fails `stopped`.
func stop() -> void:
	if _stopped:
		return
	_stopped = true
	_timer_gen += 1
	_docs.close()
	_enter("stopped")
	# Each session says goodbye; the goodbyes leave unpaced, then the socket closes.
	for rl: Rl in _links.values():
		rl.link.close(PKeyPeerSession.PEER_BYE)
	if _socket != null and _outbox != null:
		_flush_all(_socket)
	_close_socket(1000)
	_on_socket_lost()
	_nap_cancel = true
	_id = null


## Stop at once, with no close frame (the sign-out bound's force path).
func abort() -> void:
	if _stopped:
		return
	_stopped = true
	_aborted = true
	_timer_gen += 1
	_docs.close()
	_enter("stopped")
	_socket = null
	_open = false
	for rl: Rl in _links.values():
		rl.link.destroy()
	_nap_cancel = true
	_id = null


# ── the connect loop ─────────────────────────────────────────────────────────────────────────


func _run() -> void:
	_running = true
	while not _stopped:
		_enter("connecting")
		var code := -1
		var wait_s := 0.0
		var grant: PKeyResult = await _ticket.call()
		if _stopped:
			break
		if grant.ok:
			code = await _session(grant.detail as PKeyConnectClient.Grant)
			_last_code = code
		else:
			var reason := PKeyConnectErrors.reason_of(grant)
			_error = grant if _is_relay_failure(grant) else PKeyConnectErrors.relay("unavailable", "The relay could not be reached.")
			if reason == "disabled" or reason == "quota":
				_block(_error)
				break
			if grant.detail is Dictionary:
				wait_s = float((grant.detail as Dictionary).get("retry_after_seconds", 0))
		if _stopped:
			break
		var stop_error := _after_close(code)
		if stop_error != null:
			_block(stop_error)
			break
		_attempts += 1
		var delay := maxf(_backoff(), minf(wait_s, float(MAX_RETRY_AFTER_S)))
		if _attempts >= UNAVAILABLE_AFTER:
			_enter("unavailable")
			delay = maxf(delay, UNAVAILABLE_RETRY_S)
		else:
			_enter("backoff")
		await _nap(delay)
	_running = false


static func _is_relay_failure(r: PKeyResult) -> bool:
	return r.detail is Dictionary and (r.detail as Dictionary).has("reason")


func _nap(seconds: float) -> void:
	_nap_cancel = false
	_napping = true
	var until := _mono() + seconds
	while not _stopped and not _nap_cancel and _mono() < until:
		await _tree.process_frame
	_napping = false


## What a close means for the loop: null to reconnect, else the error that ends it.
func _after_close(code: int) -> PKeyResult:
	var limit := _last_limit
	_last_limit = 0
	if code < 0:
		return null
	if code == 4009:
		return PKeyConnectErrors.relay("replaced", "Another connection of this device took the relay socket.", {"close_code": code})
	if code == 4003:
		# The roster this device holds is out of date: fetch it, and stop if it keeps happening.
		_docs.want_ring()
		_not_member += 1
		if _not_member >= 3:
			return PKeyConnectErrors.relay("not_member", "The room does not know this device.", {"close_code": code})
		return null
	_not_member = 0
	if code == 4008 and (limit == 2 or limit == 3):
		return PKeyConnectErrors.relay("quota", "The relay quota is spent.", {"close_code": code, "scope": "product" if limit == 3 else "person"})
	return null


func _block(e: PKeyResult) -> void:
	_error = e
	_open = false
	_enter("blocked")


func _backoff() -> float:
	var cap := minf(float(_o.get("backoff_max", BACKOFF_MAX)), float(_o.get("backoff_base", BACKOFF_BASE)) * pow(2.0, float(mini(maxi(_attempts - 1, 0), 16))))
	# Equal jitter: half fixed, half random, never under the floor.
	return maxf(float(_o.get("backoff_min", BACKOFF_MIN)), cap / 2.0 + _random() * cap / 2.0)


func _random() -> float:
	var r: Variant = _o.get("random")
	return float((r as Callable).call()) if r is Callable and (r as Callable).is_valid() else randf()


# ── one socket ───────────────────────────────────────────────────────────────────────────────


## Open one socket and run it to its close. A coroutine answering the close code, -1 for none.
func _session(grant: PKeyConnectClient.Grant) -> int:
	# Held for the whole socket: the frame waits below must not outlive this object.
	var keep: PKeyConnectRelay = self
	# The ticket is read here and handed to the opener.
	var sock: Socket = _opener.call(grant.url, [PROTOCOL, grant.ticket()])
	if sock == null:
		return -1
	var open_limit := _mono() + float(_o.get("open_seconds", OPEN_SECONDS))
	while sock.state() == Socket.CONNECTING:
		sock.poll()
		if sock.state() != Socket.CONNECTING:
			break
		if _stopped or _mono() >= open_limit:
			sock.close(1000)
			return -1
		await _tree.process_frame
	if sock.state() != Socket.OPEN or sock.protocol() != PROTOCOL:
		# Refused, or opened without the protocol echoed back (G14).
		if sock.state() == Socket.OPEN:
			sock.close(1002)
			return 1002
		return sock.code()
	if _stopped:
		sock.close(1000)
		return -1
	# The ticket is spent at the upgrade: let the grant's own copy go.
	grant.forget()
	_socket = sock
	_open = true
	var opened_at := _mono()
	_pong_at = opened_at
	_last_limit = 0
	_error = null
	_outbox = PKeyConnectPacer.Outbox.new(int(_o.get("outbox_bytes", PKeyConnectPacer.MAX_QUEUED_BYTES)))
	_pacer = PKeyConnectPacer.new(float(_o.get("rate", PKeyConnectPacer.RATE)), float(_o.get("burst", PKeyConnectPacer.BURST)), Callable(self, "_mono"))
	_enter("open")
	_send_env({"op": &"list"})
	var next_ping := opened_at + float(_o.get("ping_seconds", PING_SECONDS))
	var code := -1
	while true:
		sock.poll()
		var refused := false
		for i in PACKETS_PER_FRAME:
			var m: Variant = sock.recv()
			if m == null:
				break
			if not m is PackedByteArray or not _handle(m):
				refused = true
				break
		if refused:
			sock.close(1002)
			code = 1002
			break
		_flush(sock)
		var now := _mono()
		if now >= next_ping:
			next_ping = now + float(_o.get("ping_seconds", PING_SECONDS))
			if now - _pong_at > 2.0 * float(_o.get("ping_seconds", PING_SECONDS)):
				# Two intervals without an answer: a half-open socket. Close it; the connect loop
				# reconnects with a new ticket.
				sock.close(1001)
				code = 1001
				break
			_send_env({"op": &"ping", "data": Crypto.new().generate_random_bytes(8)})
			_send_env({"op": &"list"})
		if sock.state() == Socket.CLOSED:
			code = sock.code()
			break
		if _aborted:
			break
		if _stopped:
			sock.close(1000)
			break
		await _tree.process_frame
	if keep._open and _mono() - opened_at >= float(_o.get("stable_seconds", STABLE_SECONDS)):
		_attempts = 0
	_open = false
	if _socket == sock:
		_socket = null
	_outbox = null
	_pacer = null
	var had := not _members.is_empty()
	_members = {}
	_on_socket_lost()
	if had:
		members_changed.emit(members())
	return code


func _close_socket(code: int) -> void:
	var sock := _socket
	_open = false
	if sock != null:
		sock.close(code)


## The socket is gone: every session ends without a word.
func _on_socket_lost() -> void:
	for rl: Rl in _links.values():
		rl.pipe.lost()


## Send what is queued, as fast as the pacer allows.
func _flush(sock: Socket) -> void:
	while not _outbox.is_empty():
		if _pacer.try_take() > 0.0:
			return
		# Leave the envelope queued until the socket took it: a refused one that was dropped would
		# leave a gap in the session's nonce, and the peer's next record would fail to open.
		if not sock.send(_outbox.peek()):
			_pacer.refund()
			return
		_outbox.pop()


## Send everything queued now, ignoring the pace (the goodbyes of a stop).
func _flush_all(sock: Socket) -> void:
	while not _outbox.is_empty():
		if not sock.send(_outbox.peek()):
			return
		_outbox.pop()


## Queue one envelope. False when it is refused: only a non-forced one past the queue's byte cap. While the
## socket is not open an envelope is dropped (and counts as sent).
func _send_env(m: Dictionary, force := true) -> bool:
	if not _open or _outbox == null:
		return true
	var data := PKeyPeerRelayCodec.encode(m)
	return data.is_empty() or _outbox.put(data, force)


## A session's Noise message (the pipe's call): paced like all, forced only for a session that is closing.
func _send_session(peer: PackedByteArray, session_id: int, noise: PackedByteArray, force: bool) -> bool:
	return _send_env({"op": &"send", "to": peer, "session": session_id, "noise": noise}, force)


## One envelope from the room. False when it is refused (the socket then closes 1002).
func _handle(data: PackedByteArray) -> bool:
	var m := PKeyPeerRelayCodec.decode(PKeyPeerRelayCodec.DIR_TO_CLIENT, data)
	if m.is_empty():
		return false
	match m["op"]:
		&"recv":
			_on_recv(m["from"], m["session"], m["noise"])
		&"members":
			# Only the person's own devices: a room that lists others is not believed.
			var ident: Variant = _identity(false)
			var roster: Array = (ident as PKeyConnectClient.PeerSource).roster if ident != null else []
			var seen := {}
			for d: PackedByteArray in m["devices"]:
				var text := PKeyB64Url.encode(d)
				if roster.has(text):
					seen[text] = true
			_members = seen
			members_changed.emit(members())
		&"ring":
			# The roster changed. Fetch the newer one under the normal replacement rules; the epoch is
			# only a hint of whether it is newer than the one held.
			var held: Variant = _identity(false)
			if held == null or int(m["epoch"]) > (held as PKeyConnectClient.PeerSource).ring_epoch:
				_docs.want_ring()
		&"gone":
			_members.erase(PKeyB64Url.encode(m["device"]))
			_on_gone(m["device"])
			members_changed.emit(members())
		&"limit":
			_limit(int(m["reason"]))
		&"pong":
			_pong_at = _mono()
	return true


## The room dropped a device, so its sessions end without a word.
func _on_gone(device: PackedByteArray) -> void:
	for rl: Rl in _links.values():
		if rl.peer == device:
			rl.pipe.lost()


func _limit(reason: int) -> void:
	_last_limit = reason
	var why := "rate_limited" if reason == 1 else ("paused" if reason == 4 else "quota")
	var message := "The relay is paused." if why == "paused" else ("The relay quota is spent." if why == "quota" else "Slow down: the relay is rate limiting this device.")
	var extra := {}
	if reason == 2 or reason == 3:
		extra["scope"] = "product" if reason == 3 else "person"
	_error = PKeyConnectErrors.relay(why, message, extra)
	_on_limit(reason)
	_enter(_state)


## LIMIT 1 halves the pace for ten seconds (D-9).
func _on_limit(reason: int) -> void:
	if reason == 1 and _pacer != null:
		_pacer.halve()


# ── sessions (CC-14.14) ──────────────────────────────────────────────────────────────────────


## Refuses a mode the relay must never carry (`v`, `p`, anything else): `mode_not_allowed`. ok("a") for `a`.
static func assert_relay_mode(mode: String) -> PKeyResult:
	if mode != "a":
		return PKeyConnectErrors.relay("mode_not_allowed", "Mode %s never crosses the relay; it is LAN only." % mode)
	return PKeyResult.success("a")


## Sessions that are open or opening now.
func link_count() -> int:
	return _links.size()


## Dial a device of the person over the relay and run the handshake. ok with a PKeyConnectSession, or a relay
## failure: `unknown_peer`, `busy`, `handshake_failed`, `wrong_peer`, or the reason the relay is not
## connected. A coroutine.
func dial(device_id: String) -> PKeyResult:
	var up: PKeyResult = await ready()
	if not up.ok:
		return up
	var checked := _check_target(device_id)
	if checked.has("error"):
		return checked["error"]
	var peer: PackedByteArray = checked["peer"]
	var rl := _make_link(peer, _new_session_id(peer), "initiator", checked["ident"])
	if rl == null:
		return PKeyConnectErrors.relay("busy", "Too many relay sessions are open.")
	rl.link.start()
	while rl.session == null and not rl.ended:
		await rl.settled
	if rl.session != null:
		# Resumed from inside the session's own step: give the caller a clean stack, so that a close it
		# asks for at once is not deferred behind that step.
		await _tree.process_frame
		if rl.session.is_closed():
			return PKeyConnectErrors.relay("handshake_failed", "The session closed before it could be used.", {"close_code": rl.close_code})
		return PKeyResult.success(rl.session)
	return PKeyConnectErrors.relay(rl.why, "The peer was not admitted over the relay.", {"close_code": rl.close_code})


## {peer, ident} for a device of the person that is not this one, else {error}.
func _check_target(device_id: String) -> Dictionary:
	var peer: Variant = PKeyPeerAdvert.device_id_bytes(device_id)
	if peer == null:
		return {"error": PKeyConnectErrors.relay("unknown_peer", "That is not a device id.")}
	var ident: Variant = _identity(false)
	if ident == null:
		return {"error": PKeyConnectErrors.lan("no_identity", "No Cloud Connect identity is held.")}
	var me: PKeyConnectClient.PeerSource = ident
	if device_id == me.device_id or not me.roster.has(device_id):
		return {"error": PKeyConnectErrors.relay("unknown_peer", "That device is not one of this person's devices.")}
	return {"peer": peer, "ident": me}


func _key(peer: PackedByteArray, session_id: int) -> String:
	return "%s:%d" % [peer.hex_encode(), session_id]


func _new_session_id(peer: PackedByteArray) -> int:
	while true:
		var raw := Crypto.new().generate_random_bytes(4)
		var n := (raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]
		var k := _key(peer, n)
		if n <= MAX_SESSION_ID and not _links.has(k) and not _ended.has(k):
			return n
	return 0


## A first message of a session the peer opened, or a later one of a session we know.
func _on_recv(frm: PackedByteArray, session_id: int, noise: PackedByteArray) -> void:
	var key := _key(frm, session_id)
	var known: Rl = _links.get(key)
	if known != null:
		_deliver(known, noise)
		return
	if _ended.has(key):
		return
	# Only the person's own devices may open a session.
	var ident: Variant = _identity(false)
	if ident == null or _stopped or not _open:
		return
	var me: PKeyConnectClient.PeerSource = ident
	var from_id := PKeyB64Url.encode(frm)
	if from_id == me.device_id or not me.roster.has(from_id):
		return
	var pending := 0
	for other: Rl in _links.values():
		if not other.ended and other.peer == frm:
			pending += 1
	if pending >= int(_o.get("max_pending_per_peer", MAX_SESSIONS_PER_PEER)):
		return
	var rl := _make_link(frm, session_id, "responder", me)
	if rl != null:
		_deliver(rl, noise)


## The room has no flow control: a session whose messages pile up unread ends `peer_busy`.
func _deliver(rl: Rl, noise: PackedByteArray) -> void:
	if not rl.pipe.deliver(noise):
		rl.link.close(PKeyPeerSession.PEER_BUSY)


## One session: a mode-a link over a RelayPipe, null when too many are open.
func _make_link(peer: PackedByteArray, session_id: int, role: String, ident: PKeyConnectClient.PeerSource) -> Rl:
	if _links.size() >= int(_o.get("max_sessions", MAX_SESSIONS)):
		return null
	var so := PKeyConnectChannel.session_options(ident, {
		"role": role, "caps": _o.get("caps", ["app/1"]), "label": str(_o.get("label", "")), "ring": Callable(self, "_pushed"),
		"now": _src.now, "mono": Callable(self, "_mono"), "rekey_messages": _o.get("rekey_messages", PKeyPeerSession.DEFAULT_REKEY_MESSAGES),
		"rekey_seconds": _o.get("rekey_seconds", PKeyPeerSession.DEFAULT_REKEY_SECONDS),
	})
	if not assert_relay_mode(str(so["mode"])).ok:
		return null
	var pipe := RelayPipe.new()
	pipe.budget = _budget
	pipe.peer = peer
	pipe.session_id = session_id
	pipe.sender = Callable(self, "_send_session")
	var seconds := float(_o.get("handshake_seconds", HANDSHAKE_SECONDS))
	var made := PKeyPeerLink.create(pipe, so, {
		"pump": _pump, "handshake_ms": int(seconds * 1000.0), "mono_ms": Callable(self, "_mono_ms"), "can_send": Callable(self, "_has_room"),
	})
	if not made.ok:
		return null
	var rl := Rl.new()
	rl.key = _key(peer, session_id)
	rl.peer = peer
	rl.session_id = session_id
	rl.role = role
	rl.pipe = pipe
	rl.link = made.detail
	pipe.closing = Callable(rl.link.session, "is_closed")
	rl.attachment = PKeyConnectChannel.attach(rl.link, _docs, role, "relay", "relay", _budget, _o.get("xfer", Callable()))
	rl.attachment.opened.connect(_on_opened.bind(rl.key))
	rl.link.closed.connect(_on_link_closed.bind(rl.key))
	_links[rl.key] = rl
	_pump.add(rl.link)
	return rl


## Room for a host message of `size` bytes in the outgoing queue, asked BEFORE it is encrypted, so the session's
## keys never advance for a message that was not queued (a refused one ends the session `peer_busy` and the
## CLOSE that says so is the next message the peer can read).
func _has_room(size: int) -> bool:
	return _outbox != null and _outbox.room_for(size + 128 * (size / 60000 + 1))


func _mono_ms() -> int:
	return int(_mono() * 1000.0)


## The link admitted the peer. The certificate, not the room's stamp, names it; they must agree (G8).
func _on_opened(session: PKeyConnectSession, key: String) -> void:
	var rl: Rl = _links.get(key)
	if rl == null:
		return
	if session.peer_device_id != PKeyB64Url.encode(rl.peer):
		rl.why = "wrong_peer"
		session.close()
		return
	rl.session = session
	rl.settled.emit()
	if rl.role == "responder":
		session_opened.emit(session)


func _on_link_closed(code: StringName, _by_peer: bool, key: String) -> void:
	var rl: Rl = _links.get(key)
	if rl == null:
		return
	rl.ended = true
	rl.close_code = code
	rl.pipe.release()
	_links.erase(key)
	_remember_ended(key)
	rl.settled.emit()


## A short memory of ended sessions, so a late message for one is dropped without work.
func _remember_ended(key: String) -> void:
	_ended.append(key)
	if _ended.size() > ENDED_MEMORY:
		_ended.pop_front()


# ── identity and documents ───────────────────────────────────────────────────────────────────


## The held identity (a PeerSource), re-read at most every IDENTITY_TTL_S; null when there is none.
func _identity(force: bool) -> Variant:
	if _stopped:
		return null
	var now := int(_src.now.call())
	if not force and _id != null:
		var held: Dictionary = _id
		var v: PKeyConnectClient.PeerSource = held["v"]
		if now - int(held["at"]) < IDENTITY_TTL_S and v.certificate_expires_at - now > CERT_MARGIN_S:
			return v
	var r: PKeyResult = _src.load.call()
	if not r.ok or not r.detail is PKeyConnectClient.PeerSource:
		return null
	var fresh: PKeyConnectClient.PeerSource = r.detail
	_id = {"at": now, "v": fresh}
	var pushed: Variant = _docs.pushed
	if pushed is Dictionary and int((pushed as Dictionary)["epoch"]) <= fresh.ring_epoch:
		_docs.pushed = null
	return fresh


func _stored() -> void:
	_id = null


# ── bookkeeping ──────────────────────────────────────────────────────────────────────────────


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return float((clock as Callable).call()) if clock is Callable and (clock as Callable).is_valid() else float(Time.get_ticks_msec()) / 1000.0


func _after(seconds: float, fn: Callable) -> void:
	var guarded := Callable(self, "_fire").bind(_timer_gen, fn)
	var timer: Variant = _o.get("timer")
	if timer is Callable and (timer as Callable).is_valid():
		(timer as Callable).call(seconds, guarded)
	elif _tree != null:
		_tree.create_timer(maxf(0.05, seconds)).timeout.connect(guarded)


func _fire(gen: int, fn: Callable) -> void:
	if gen == _timer_gen and not _stopped:
		fn.call()


func _enter(state: String) -> void:
	_state = state
	state_changed.emit(status())


static func _stopped_error() -> PKeyResult:
	return PKeyConnectErrors.relay("stopped", "The relay is stopped.")


# ── the socket port ──────────────────────────────────────────────────────────────────────────


## What the service uses of a WebSocket: binary messages in and out. The base class is a closed socket.
class Socket extends RefCounted:
	const CONNECTING := 0
	const OPEN := 1
	const CLOSED := 2


	## Drive the transport; the service calls it once a frame.
	func poll() -> void:
		pass


	func state() -> int:
		return CLOSED


	## The subprotocol the server chose, "" for none.
	func protocol() -> String:
		return ""


	## The next message: a PackedByteArray (binary), a String (a text frame, which the service refuses), or null
	## for none.
	func recv() -> Variant:
		return null


	func send(_data: PackedByteArray) -> bool:
		return false


	## Close with a status code; the socket is CLOSED once the close completes.
	func close(_code: int) -> void:
		pass


	## The close code the peer sent, or the one this side closed with; -1 for none.
	func code() -> int:
		return -1


## One session inside the room.
class Rl extends RefCounted:
	signal settled

	var key := ""
	var peer := PackedByteArray()
	var session_id := 0
	var role := ""
	var link: PKeyPeerLink
	var pipe: RelayPipe
	var attachment: PKeyConnectChannel.Attachment
	var session: PKeyConnectSession
	## Why a link that never admitted the peer ended: `handshake_failed`, or `wrong_peer`.
	var why := "handshake_failed"
	var ended := false
	var close_code: StringName = &""


	func _to_string() -> String:
		return "PKeyConnectRelay.Rl(%d)" % session_id


## The real socket: a `WebSocketPeer`. Its `str()` shows nothing.
class WsSocket extends Socket:
	var _ws: WebSocketPeer
	var _closing_with := -1


	func _init(ws: WebSocketPeer) -> void:
		_ws = ws


	func _to_string() -> String:
		return "PKeyConnectRelay.WsSocket()"


	func poll() -> void:
		_ws.poll()


	func state() -> int:
		match _ws.get_ready_state():
			WebSocketPeer.STATE_CONNECTING:
				return CONNECTING
			WebSocketPeer.STATE_OPEN:
				return OPEN
		# Closing is closed for the service: nothing more is read or sent.
		return CLOSED


	func protocol() -> String:
		return _ws.get_selected_protocol()


	func recv() -> Variant:
		if _ws.get_ready_state() != WebSocketPeer.STATE_OPEN or _ws.get_available_packet_count() <= 0:
			return null
		var data := _ws.get_packet()
		if _ws.was_string_packet():
			return data.get_string_from_utf8()
		if data.size() > PKeyConnectRelay.MAX_MESSAGE:
			return "oversize"
		return data


	func send(data: PackedByteArray) -> bool:
		return _ws.get_ready_state() == WebSocketPeer.STATE_OPEN and _ws.send(data, WebSocketPeer.WRITE_MODE_BINARY) == OK


	func close(code: int) -> void:
		_closing_with = code
		# A browser socket takes only 1000 or 3000 to 4999, so a refusal closes it 1000 there.
		var wire := 1000 if OS.has_feature("web") and code != 1000 and (code < 3000 or code > 4999) else code
		_ws.close(wire, "")
		# Let the close frame leave now: the socket may be dropped before its next poll.
		_ws.poll()


	func code() -> int:
		var c := _ws.get_close_code()
		return c if c >= 0 else _closing_with


## Open `url` offering `protocols` (the first is the protocol, the second the ticket). Null when the URL is not
## `wss:` (`ws:` only with `allow_ws`, for a test server on loopback), or the socket cannot start. TLS
## is `TLSOptions.client()`: the system's roots and the host name checked, never the unsafe options.
static func open_ws(url: String, protocols: Array, allow_ws := false) -> Socket:
	var wss := url.to_lower().begins_with("wss://")
	if not wss and not (allow_ws and url.to_lower().begins_with("ws://")):
		return null
	var ws := WebSocketPeer.new()
	ws.supported_protocols = PackedStringArray(protocols)
	ws.inbound_buffer_size = BUFFER_BYTES
	ws.outbound_buffer_size = OUTBOUND_BYTES
	ws.max_queued_packets = 256
	var err := ws.connect_to_url(url, TLSOptions.client() if wss else null)
	if err != OK:
		return null
	return WsSocket.new(ws)
