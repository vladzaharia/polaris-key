@tool
class_name PKeyConnectContactRelay
extends RefCounted
## The contact relay (CC-19b.G4; WIRE-CONTRACT-V5 sections 15.7 "Contact rooms" and 15.10), ported from sdk-node
## `connect/contactRelay.ts` and the Python `connect/contact_relay.py`. A contact room joins the two devices of
## one link, who may belong to two accounts. Each link has its own room, named by the `rid` both sides derive
## from the contact secret, and each session in it is a mode-c `PKeyPeerLink` over a `RelayPipe`: Noise
## XXpsk0 under the contact secret, the device's agreeKey as the static key and the pin on the contact's key.
## Everything runs on the main thread, driven by `SceneTree.process_frame`.
##
## Rules this file keeps:
##  - a ticket is asked for with `{room: "c", rid}` (`ticket`, a coroutine taking the rid); the answer must echo
##    `room: "c"`, else the client answers `contact_unsupported` and the room stops, links stay on the LAN;
##  - one `wss` socket per room (`PKeyConnectRelay.open_ws`: `TLSOptions.client()`, `wss:` only, the protocol
##    required echoed back), mode `c` and nothing else (G16);
##  - the room speaks aliases, never device ids: `from`, `to` and `MEMBERS` carry SHA-256(rid || deviceId)[0..24].
##    This device computes its own and learns the peer's as the member that is not it. A session is dialled only
##    to a peer MEMBERS lists (a SEND to an absent one is dropped by the room), and a first message is judged
##    against MEMBERS: up to 8 that arrive before it are held and judged on it;
##  - the room stamps `from`; the Noise pin on the contact's agreeKey names the peer. The first session of a
##    pending contact that passes the pin is reported to `contact_established`;
##  - an envelope that fails its layout, or a text frame, closes the socket with 1002. 4009 stops without
##    fighting back; 4003 stops after three in a row; 4008 after LIMIT 2 or 3 is a quota error;
##  - a room is kept for each link marked reachable (at most 8); any other link gets a one-dial room that stops
##    when its last session ends. The Worker allows 30 contact tickets an hour per device, so a reconnect backs
##    off to minutes (5 s doubling to 10 min, `Retry-After` honoured up to an hour);
##  - the secret is held as a copy for the room and zeroed when the room stops; no ticket, secret, alias or
##    room id is in a `str()`, a status or a notice.
##
## `source` is the LAN service's (`PKeyConnectLan.Source`: `load`, `now`, `contacts`, `contact_established`);
## `ticket` is Callable(rid) -> a coroutine answering a PKeyResult holding a `PKeyConnectClient.Grant`.
## `options`: `opener`, `mono`, `random`, `tree`, `pump`, `budget`, `caps`, `label`, `backoff_base`,
## `backoff_max`, `backoff_min`, `stable_seconds`, `ping_seconds`, `open_seconds`, `max_sessions`,
## `handshake_seconds`, `rekey_messages`, `rekey_seconds`, and the pacing `rate`, `burst`, `outbox_bytes`.

## An inbound session, once it is open and the pin has passed.
signal session_opened(session: PKeyConnectSession)

const RelayPipe := preload("relay_pipe.gd")
const MAX_ROOM_SESSIONS := 4
const MAX_DEFERRED := 8
const ENDED_MEMORY := 64
const HANDSHAKE_SECONDS := 30.0
const BACKOFF_BASE := 5.0
const BACKOFF_MAX := 600.0
const BACKOFF_MIN := 0.5
const MAX_RETRY_AFTER_S := 3600
const RATE_LIMITED_WAIT_S := 60.0
const STABLE_SECONDS := 30.0
const PING_SECONDS := 25.0
const OPEN_SECONDS := 15.0
const PACKETS_PER_FRAME := 32
const IDENTITY_TTL_S := 30
const CERT_MARGIN_S := 60
const MAX_SESSION_ID := 0xffffffff
const NOT_MEMBER_LIMIT := 3

var _src: PKeyConnectLan.Source
var _ticket: Callable
var _o: Dictionary
var _tree: SceneTree
var _pump: PKeyPeerPump
var _budget: PKeyConnectSession.Budget
var _rooms: Dictionary = {}
var _stopped := false


func _init(source: PKeyConnectLan.Source, ticket: Callable, options := {}) -> void:
	_src = source
	_ticket = ticket
	_o = options
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	_pump = options.get("pump", null) as PKeyPeerPump
	if _pump == null:
		_pump = PKeyPeerPump.new(_tree)
	_budget = options.get("budget", null) as PKeyConnectSession.Budget
	if _budget == null:
		_budget = PKeyConnectSession.shared_budget


func _to_string() -> String:
	return "PKeyConnectContactRelay(rooms=%d)" % _rooms.size()


## Keep a room for each link marked reachable now. Call again when the links or the gate move.
func start() -> void:
	sync()


## The rooms and their state, for `status()`: [{id, pending, transient, state}].
func rooms() -> Array:
	var out: Array = []
	for r: Room in _rooms.values():
		out.append({"id": r.id, "pending": r.pending, "transient": r.transient, "state": r.state(), "peer_online": r.peer_online()})
	return out


## Bring the standing rooms to match the links: one per reachable link, at most 8. A one-dial room stays while
## its link does.
func sync() -> void:
	if _stopped:
		return
	var list: Array = _src.contacts.call() if _src.contacts.is_valid() else []
	var want := {}
	var known := {}
	for c: Dictionary in list:
		known[str(c["id"])] = true
		if bool(c.get("reachable", false)) and want.size() < PKeyPeerContact.MAX_LIVE_CONTACT_ADVERTS:
			want[_key(str(c["id"]), bool(c["pending"]))] = c
	for k: String in _rooms.keys():
		var room: Room = _rooms[k]
		var current: Dictionary = want.get(k, {})
		if not (known.has(room.id) if room.transient else want.has(k)) or (not room.transient and str(current.get("tag", room.tag)) != room.tag):
			_rooms.erase(k)
			room.stop()
	for k: String in want:
		if not _rooms.has(k):
			var room := _make_room(want[k], false)
			_rooms[k] = room
			room.start()
	PKeyConnectContacts.wipe_live(list)


## A session to a link over its room (a one-dial room when it has none). A pending link is the pending secret of
## a re-pair. ok with a PKeyConnectSession, or a relay failure: `unknown_peer`, `busy`, `handshake_failed`,
## `contact_unsupported`, `links_disabled`, or why the relay is not connected. A coroutine.
func dial(id: String, pending := false) -> PKeyResult:
	if _stopped:
		return PKeyConnectErrors.relay("stopped", "The relay is stopped.")
	var k := _key(id, pending)
	var room: Room = _rooms.get(k)
	if room == null:
		var list: Array = _src.contacts.call() if _src.contacts.is_valid() else []
		for c: Dictionary in list:
			if str(c["id"]) == id and bool(c["pending"]) == pending:
				room = _make_room(c, true)
				break
		PKeyConnectContacts.wipe_live(list)
		if room == null:
			return PKeyConnectErrors.relay("unknown_peer", "That is not a link.")
		_rooms[k] = room
		room.start()
	var r: PKeyResult = await room.dial()
	if not r.ok and room.transient:
		_drop(room)
	return r


## Stop every room: each session says goodbye, the sockets close 1000.
func stop() -> void:
	if _stopped:
		return
	_stopped = true
	var held := _rooms.values()
	_rooms = {}
	for r: Room in held:
		r.stop()


## Stop at once, with no close frame.
func abort() -> void:
	if _stopped:
		return
	_stopped = true
	var held := _rooms.values()
	_rooms = {}
	for r: Room in held:
		r.abort()


## Close the sessions of one link (it was removed): `peer_revoked`, and its rooms go.
func drop_link(id: String) -> void:
	for k: String in _rooms.keys():
		var room: Room = _rooms[k]
		if room.id == id:
			_rooms.erase(k)
			room.revoke()


static func _key(id: String, pending: bool) -> String:
	return "%s|%s" % [id, pending]


func _make_room(contact: Dictionary, transient: bool) -> Room:
	return Room.new({
		"src": _src, "ticket": _ticket, "o": _o, "tree": _tree, "pump": _pump, "budget": _budget,
	}, contact, transient, Callable(self, "_on_session"), Callable(self, "_on_idle"))


func _on_session(session: PKeyConnectSession) -> void:
	session_opened.emit(session)


func _on_idle(room: Room) -> void:
	_drop(room)


func _drop(room: Room) -> void:
	var k := _key(room.id, room.pending)
	if _rooms.get(k) == room:
		_rooms.erase(k)
	room.stop()


## One session inside a room.
class Rl extends RefCounted:
	signal settled

	var key := ""
	var peer := PackedByteArray()
	var session_id := 0
	var role := ""
	var link: PKeyPeerLink
	var pipe: PKeyConnectRelayPipe
	var attachment: PKeyConnectChannel.Attachment
	var session: PKeyConnectSession
	var ended := false
	var close_code: StringName = &""


	func _to_string() -> String:
		return "PKeyConnectContactRelay.Rl()"


## The room of one link: a socket, its members and the sessions inside.
class Room extends RefCounted:
	var id := ""
	var pending := false
	var transient := false
	var rid := ""
	## A one-way tag of the secret this room serves.
	var tag := ""

	var _c: Dictionary
	var _src: PKeyConnectLan.Source
	var _ticket: Callable
	var _o: Dictionary
	var _tree: SceneTree
	var _pump: PKeyPeerPump
	var _budget: PKeyConnectSession.Budget
	var _on_session: Callable
	var _on_idle: Callable
	var _agree_key := ""
	var _secret := PackedByteArray()
	var _state := "idle"
	var _error: PKeyResult = null
	var _attempts := 0
	var _stopped := false
	var _started := false
	var _running := false
	var _open := false
	var _socket: PKeyConnectRelay.Socket = null
	var _pong_at := 0.0
	var _own := PackedByteArray()
	var _own_for := ""
	var _peer := PackedByteArray()
	var _deferred: Array = []
	var _links: Dictionary = {}
	var _ended: Array[String] = []
	var _last_limit := 0
	var _lists_sent := 0
	var _members_seen := 0
	var _not_member := 0
	var _id: Variant = null
	var _pacer: PKeyConnectPacer
	var _outbox: PKeyConnectPacer.Outbox
	var _limiter: PKeyPeerLimiter
	var _nap_cancel := false
	var _napping := false
	var _aborted := false
	## A running loop keeps its room alive until it ends (a stopped room may already be let go).
	var _hold: Room = null


	func _init(ctx: Dictionary, contact: Dictionary, p_transient: bool, on_session: Callable, on_idle: Callable) -> void:
		_src = ctx["src"]
		_ticket = ctx["ticket"]
		_o = ctx["o"]
		_tree = ctx["tree"]
		_pump = ctx["pump"]
		_budget = ctx["budget"]
		_on_session = on_session
		_on_idle = on_idle
		id = str(contact["id"])
		pending = bool(contact["pending"])
		transient = p_transient
		_agree_key = str(contact["agree_key"])
		_secret = (contact["secret"] as PackedByteArray).duplicate()
		tag = PKeyConnectContacts.tag_of(_secret)
		rid = PKeyPeerContact.rid(_secret)
		_limiter = PKeyPeerLimiter.new(5, 4, Callable(self, "_mono"))


	func _to_string() -> String:
		return "PKeyConnectContactRelay.Room(%s)" % _state


	func state() -> String:
		return _state


	func peer_online() -> bool:
		return not _peer.is_empty()


	func start() -> void:
		if _started or _stopped:
			return
		_started = true
		_run()


	## Resolves once the socket is open: ok, or the typed failure when the loop is blocked or stopped, or
	## `not_connected` after the open timeout. A coroutine.
	func ready() -> PKeyResult:
		if _open:
			return PKeyResult.success()
		if _state == "blocked" or _state == "stopped":
			return _error if _error != null else _stopped_error()
		start()
		var limit := _mono() + float(_o.get("open_seconds", OPEN_SECONDS))
		while not _open and _mono() < limit:
			if _state == "blocked" or _state == "stopped":
				return _error if _error != null else _stopped_error()
			await _tree.process_frame
		if _open:
			return PKeyResult.success()
		return _error if _error != null else PKeyConnectErrors.relay("not_connected", "The relay is not connected.")


	## Ask the room who is in it; answers on the reply to this request (an earlier request's reply does not
	## count) or after `timeout` seconds. A coroutine.
	func refresh_members(timeout := 2.0) -> void:
		if not _open:
			return
		var target := _send_list()
		var limit := _mono() + timeout
		while _members_seen < target and _mono() < limit and _open:
			await _tree.process_frame


	## A session to the link in this room: the peer must be listed (a SEND to an absent one is dropped). A
	## coroutine.
	func dial() -> PKeyResult:
		var up: PKeyResult = await ready()
		if not up.ok:
			return up
		if _peer.is_empty():
			await refresh_members()
		var ident: Variant = _identity()
		var failure: PKeyResult = null
		if _peer.is_empty():
			failure = PKeyConnectErrors.relay("unknown_peer", "That contact is not online.")
		elif ident == null:
			failure = PKeyConnectErrors.lan("no_identity", "No Cloud Connect identity is held.")
		if failure != null:
			return failure
		var rl := _make_link(_peer, _new_session_id(_peer), "initiator", ident)
		if rl == null:
			return PKeyConnectErrors.relay("busy", "Too many relay sessions are open.")
		rl.link.start()
		while rl.session == null and not rl.ended:
			await rl.settled
		if rl.session == null:
			return PKeyConnectErrors.relay("handshake_failed", "The contact was not admitted over the relay.", {"close_code": rl.close_code})
		# Resumed from inside the session's own step: hand the caller a clean stack.
		await _tree.process_frame
		if rl.session.is_closed():
			return PKeyConnectErrors.relay("handshake_failed", "The session closed before it could be used.", {"close_code": rl.close_code})
		return PKeyResult.success(rl.session)


	## Stop: each session says goodbye, the socket closes 1000, every wait fails `stopped`, the secret is zeroed.
	func stop() -> void:
		if _stopped:
			return
		_stopped = true
		_enter("stopped")
		for rl: Rl in _links.values():
			rl.link.close(PKeyPeerSession.PEER_BYE)
		if _socket != null and _outbox != null:
			_flush_all(_socket)
		_close_socket(1000)
		_lose_links()
		_nap_cancel = true
		_id = null
		_wipe()
		# A stopped room needs no one to keep it alive. Its loop ends the next time it is woken; if the ticket
		# call it waits on never answers (its object is gone), nothing would ever release the room.
		_hold = null


	## The link was removed: its sessions end `peer_revoked`, then the room stops.
	func revoke() -> void:
		for rl: Rl in _links.values():
			rl.link.close(PKeyPeerSession.PEER_REVOKED)
		stop()


	func abort() -> void:
		if _stopped:
			return
		_stopped = true
		_aborted = true
		_enter("stopped")
		_socket = null
		_open = false
		for rl: Rl in _links.values():
			rl.link.destroy()
		_nap_cancel = true
		_id = null
		_wipe()
		# A stopped room needs no one to keep it alive. Its loop ends the next time it is woken; if the ticket
		# call it waits on never answers (its object is gone), nothing would ever release the room.
		_hold = null


	func _wipe() -> void:
		_secret.fill(0)
		_secret = PackedByteArray()


	# ── the connect loop ──────────────────────────────────────────────────────────────────────

	func _run() -> void:
		_running = true
		_hold = self
		while not _stopped:
			_enter("connecting")
			var code := -1
			var wait_s := 0.0
			var grant: PKeyResult = await _ticket.call(rid)
			if _stopped:
				break
			if grant.ok:
				code = await _session(grant.detail as PKeyConnectClient.Grant)
			else:
				var reason := PKeyConnectErrors.reason_of(grant)
				_error = grant if reason != "" else PKeyConnectErrors.relay("unavailable", "The relay could not be reached.")
				if reason in ["disabled", "links_disabled", "contact_unsupported", "quota"]:
					_block(_error)
					break
				if grant.detail is Dictionary:
					wait_s = float((grant.detail as Dictionary).get("retry_after_seconds", 0))
				# A refusal the loop cannot read through waits its turn.
				if String(grant.code) == PKeyConstants.ErrorCode.RATE_LIMITED and wait_s == 0.0:
					wait_s = RATE_LIMITED_WAIT_S
			if _stopped:
				break
			var stop_error := _after_close(code)
			if stop_error != null:
				_block(stop_error)
				break
			_attempts += 1
			_enter("backoff")
			await _nap(maxf(_backoff(), minf(wait_s, float(MAX_RETRY_AFTER_S))))
		_running = false
		_hold = null


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
			return PKeyConnectErrors.relay("replaced", "Another connection of this device took the room.", {"close_code": code})
		if code == 4003:
			# The room is full, or links were switched off: a few tries, then stop.
			_not_member += 1
			if _not_member >= NOT_MEMBER_LIMIT:
				return PKeyConnectErrors.relay("not_member", "The room does not admit this device.", {"close_code": code})
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
		var r: Variant = _o.get("random")
		var jitter := float((r as Callable).call()) if r is Callable and (r as Callable).is_valid() else randf()
		return maxf(float(_o.get("backoff_min", BACKOFF_MIN)), cap / 2.0 + jitter * cap / 2.0)


	# ── one socket ────────────────────────────────────────────────────────────────────────────

	## Open one socket and run it to its close. A coroutine answering the close code, -1 for none.
	func _session(grant: PKeyConnectClient.Grant) -> int:
		var opener: Variant = _o.get("opener")
		var open_call: Callable = opener if opener is Callable and (opener as Callable).is_valid() else Callable(PKeyConnectRelay, "open_ws")
		# The ticket is read here and handed to the opener.
		var sock: PKeyConnectRelay.Socket = open_call.call(grant.url, [PKeyConnectRelay.PROTOCOL, grant.ticket()])
		if sock == null:
			return -1
		var open_limit := _mono() + float(_o.get("open_seconds", OPEN_SECONDS))
		while sock.state() == PKeyConnectRelay.Socket.CONNECTING:
			sock.poll()
			if sock.state() != PKeyConnectRelay.Socket.CONNECTING:
				break
			if _stopped or _mono() >= open_limit:
				sock.close(1000)
				return -1
			await _tree.process_frame
		if sock.state() != PKeyConnectRelay.Socket.OPEN or sock.protocol() != PKeyConnectRelay.PROTOCOL:
			if sock.state() == PKeyConnectRelay.Socket.OPEN:
				sock.close(1002)
				return 1002
			return sock.code()
		if _stopped:
			sock.close(1000)
			return -1
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
		_lists_sent = 0
		_members_seen = 0
		_send_list()
		var ping := float(_o.get("ping_seconds", PING_SECONDS))
		var next_ping := opened_at + ping
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
				next_ping = now + ping
				if now - _pong_at > 2.0 * ping:
					sock.close(1001)
					code = 1001
					break
				_send_env({"op": &"ping", "data": Crypto.new().generate_random_bytes(8)})
			if sock.state() == PKeyConnectRelay.Socket.CLOSED:
				code = sock.code()
				break
			if _aborted:
				break
			if _stopped:
				sock.close(1000)
				break
			await _tree.process_frame
		if _open and _mono() - opened_at >= float(_o.get("stable_seconds", STABLE_SECONDS)):
			_attempts = 0
		_open = false
		if _socket == sock:
			_socket = null
		_outbox = null
		_pacer = null
		_peer = PackedByteArray()
		_deferred = []
		_lose_links()
		return code


	func _close_socket(code: int) -> void:
		var sock := _socket
		_open = false
		if sock != null:
			sock.close(code)


	## The socket is gone: every session ends without a word.
	func _lose_links() -> void:
		for rl: Rl in _links.values():
			rl.pipe.lost()


	func _flush(sock: PKeyConnectRelay.Socket) -> void:
		while not _outbox.is_empty():
			if _pacer.try_take() > 0.0:
				return
			# Leave the envelope queued until the socket took it: a dropped one would leave a gap in the session's
			# nonce, and the peer's next record would fail to open.
			if not sock.send(_outbox.peek()):
				_pacer.refund()
				return
			_outbox.pop()


	func _flush_all(sock: PKeyConnectRelay.Socket) -> void:
		while not _outbox.is_empty():
			if not sock.send(_outbox.peek()):
				return
			_outbox.pop()


	## Queue one envelope. False when it is refused: only a non-forced one past the queue's byte cap.
	func _send_env(m: Dictionary, force := true) -> bool:
		if not _open or _outbox == null:
			return true
		var data := PKeyPeerRelayCodec.encode(m)
		return data.is_empty() or _outbox.put(data, force)


	## A LIST; the room answers each with one MEMBERS. The number of LISTs sent so far.
	func _send_list() -> int:
		_lists_sent += 1
		_send_env({"op": &"list"})
		return _lists_sent


	func _send_session(peer: PackedByteArray, session_id: int, noise: PackedByteArray, force: bool) -> bool:
		return _send_env({"op": &"send", "to": peer, "session": session_id, "noise": noise}, force)


	func _has_room(size: int) -> bool:
		return _outbox != null and _outbox.room_for(size + 128 * (size / 60000 + 1))


	## One envelope from the room. False when it is refused (the socket then closes 1002).
	func _handle(data: PackedByteArray) -> bool:
		var m := PKeyPeerRelayCodec.decode(PKeyPeerRelayCodec.DIR_TO_CLIENT, data)
		if m.is_empty():
			return false
		match m["op"]:
			&"recv":
				_on_recv(m["from"], int(m["session"]), m["noise"], true)
			&"members":
				_on_members(m["devices"])
			&"gone":
				if not _peer.is_empty() and _peer == m["device"]:
					_peer = PackedByteArray()
					for rl: Rl in _links.values():
						if rl.peer == m["device"]:
							rl.pipe.lost()
			&"limit":
				_limit(int(m["reason"]))
			&"pong":
				_pong_at = _mono()
		# `ring` never comes from a contact room.
		return true


	func _limit(reason: int) -> void:
		_last_limit = reason
		var why := "rate_limited" if reason == 1 else ("paused" if reason == 4 else "quota")
		var message := "The relay is paused." if why == "paused" else ("The relay quota is spent." if why == "quota" else "Slow down: the relay is rate limiting this device.")
		var extra := {}
		if reason == 2 or reason == 3:
			extra["scope"] = "product" if reason == 3 else "person"
		_error = PKeyConnectErrors.relay(why, message, extra)
		if reason == 1 and _pacer != null:
			_pacer.halve()
		_enter(_state)


	## The room holds this device and the one peer: the member that is not this device.
	func _on_members(devices: Array) -> void:
		_members_seen += 1
		var own := _own_alias()
		var peer := PackedByteArray()
		if not own.is_empty():
			for d: PackedByteArray in devices:
				if d != own:
					peer = d
					break
		_peer = peer
		var held := _deferred
		_deferred = []
		for h: Dictionary in held:
			_on_recv(h["from"], h["session"], h["noise"], false)


	# ── sessions ──────────────────────────────────────────────────────────────────────────────

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
	func _on_recv(frm: PackedByteArray, session_id: int, noise: PackedByteArray, can_defer: bool) -> void:
		var key := _key(frm, session_id)
		var known: Rl = _links.get(key)
		if known != null:
			_deliver(known, noise)
			return
		if _ended.has(key) or _stopped or not _open:
			return
		var ident: Variant = _admit_first(frm)
		if ident == null:
			# The peer is whom MEMBERS says, never whom a first message claims: hold it (bounded) until MEMBERS.
			if _peer.is_empty() and can_defer and _deferred.size() < MAX_DEFERRED and not _own_alias().is_empty() and frm != _own_alias():
				_deferred.append({"from": frm, "session": session_id, "noise": noise})
				_send_list()
			return
		var rl := _make_link(frm, session_id, "responder", ident)
		if rl != null:
			_deliver(rl, noise)


	## The identity to answer a first message from `frm` with, or null when it is not admitted: not from the
	## peer MEMBERS lists (this device's own alias included), no identity, or the room is full.
	func _admit_first(frm: PackedByteArray) -> Variant:
		var own := _own_alias()
		if own.is_empty() or frm == own or _peer.is_empty() or frm != _peer:
			return null
		var live := 0
		for other: Rl in _links.values():
			if not other.ended:
				live += 1
		if live >= int(_o.get("max_sessions", MAX_ROOM_SESSIONS)):
			return null
		return _identity()


	## The room has no flow control: a session whose messages pile up unread ends `peer_busy`.
	func _deliver(rl: Rl, noise: PackedByteArray) -> void:
		if not rl.pipe.deliver(noise):
			rl.link.close(PKeyPeerSession.PEER_BUSY)


	## One session: a mode-c link over a RelayPipe, null when too many are open.
	func _make_link(peer: PackedByteArray, session_id: int, role: String, ident: PKeyConnectClient.PeerSource) -> Rl:
		if _links.size() >= int(_o.get("max_sessions", MAX_ROOM_SESSIONS)) or _secret.is_empty():
			return null
		var served := {"secret": _secret.duplicate(), "agree_key": _agree_key}
		var so := PKeyConnectChannel.contact_session_options(ident, {
			"role": role, "caps": _o.get("caps", ["app/1"]), "label": str(_o.get("label", "")),
			"now": _src.now, "mono": Callable(self, "_mono"), "rekey_messages": _o.get("rekey_messages", PKeyPeerSession.DEFAULT_REKEY_MESSAGES),
			"rekey_seconds": _o.get("rekey_seconds", PKeyPeerSession.DEFAULT_REKEY_SECONDS),
		}, served)
		if role == "responder":
			so["admission"] = _limiter
		if str(so["mode"]) != "c":
			PKeyConnectContacts.wipe_live([served])
			return null
		var pipe: PKeyConnectRelayPipe = PKeyConnectContactRelay.RelayPipe.new()
		pipe.budget = _budget
		pipe.peer = peer
		pipe.session_id = session_id
		pipe.sender = Callable(self, "_send_session")
		var seconds := float(_o.get("handshake_seconds", HANDSHAKE_SECONDS))
		var made := PKeyPeerLink.create(pipe, so, {
			"pump": _pump, "handshake_ms": int(seconds * 1000.0), "mono_ms": Callable(self, "_mono_ms"), "can_send": Callable(self, "_has_room"),
		})
		# The session holds its own copy of the secret.
		PKeyConnectContacts.wipe_live([served])
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
		rl.attachment = PKeyConnectChannel.attach(rl.link, null, role, "relay", "relay", _budget, _o.get("xfer", Callable()))
		rl.attachment.contacts = [{"id": id, "pending": pending, "tag": tag}]
		rl.attachment.opened.connect(_on_opened.bind(rl.key))
		rl.link.closed.connect(_on_link_closed.bind(rl.key))
		_links[rl.key] = rl
		_pump.add(rl.link)
		return rl


	## The link admitted the peer and the pin passed. A pending link is promoted by its first session.
	func _on_opened(session: PKeyConnectSession, key: String) -> void:
		var rl: Rl = _links.get(key)
		if rl == null:
			return
		rl.session = session
		rl.settled.emit()
		if pending and _src.contact_established.is_valid():
			_src.contact_established.call({"id": id, "agree_key": _agree_key, "tag": tag})
		if rl.role == "responder" and _on_session.is_valid():
			_on_session.call(session)


	func _on_link_closed(code: StringName, _by_peer: bool, key: String) -> void:
		var rl: Rl = _links.get(key)
		if rl == null:
			return
		rl.ended = true
		rl.close_code = code
		rl.pipe.release()
		_links.erase(key)
		_ended.append(key)
		if _ended.size() > ENDED_MEMORY:
			_ended.pop_front()
		rl.settled.emit()
		if transient and _links.is_empty() and not _stopped and _on_idle.is_valid():
			_on_idle.call(self)


	# ── identity and bookkeeping ──────────────────────────────────────────────────────────────

	## The held identity (a PeerSource), re-read at most every IDENTITY_TTL_S; null when there is none.
	func _identity() -> Variant:
		if _stopped:
			return null
		var now := int(_src.now.call())
		if _id != null:
			var held: Dictionary = _id
			var v: PKeyConnectClient.PeerSource = held["v"]
			if now - int(held["at"]) < IDENTITY_TTL_S and v.certificate_expires_at - now > CERT_MARGIN_S:
				return v
		var r: PKeyResult = _src.load.call()
		if not r.ok or not r.detail is PKeyConnectClient.PeerSource:
			return null
		_id = {"at": now, "v": r.detail}
		return r.detail


	## This device's alias in the room; empty without an identity.
	func _own_alias() -> PackedByteArray:
		var ident: Variant = _identity()
		if ident == null:
			return PackedByteArray()
		var device_id: String = (ident as PKeyConnectClient.PeerSource).device_id
		if _own_for != device_id:
			_own = PKeyPeerContact.alias(rid, device_id)
			_own_for = device_id
		return _own


	func _mono() -> float:
		var clock: Variant = _o.get("mono")
		return float((clock as Callable).call()) if clock is Callable and (clock as Callable).is_valid() else float(Time.get_ticks_msec()) / 1000.0


	func _mono_ms() -> int:
		return int(_mono() * 1000.0)


	func _enter(state: String) -> void:
		_state = state


	func _stopped_error() -> PKeyResult:
		return PKeyConnectErrors.relay("stopped", "The relay is stopped.")
