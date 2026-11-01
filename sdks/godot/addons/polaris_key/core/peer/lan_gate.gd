@tool
class_name PKeyPeerLanGate
extends RefCounted
## The accept gate and the dial race the LAN transports share (CC-08.2, CC-15b.G2a; WIRE-CONTRACT-V5
## sections 15.4.1 and 15.6.1 rule 2), ported from sdk-node `connect/lanGate.ts`: mode a (`PKeyConnectLan`)
## and the mode-v approver (`PKeyPeerNearbyApprover`) admit an inbound socket by the same rule, written once.
##
## Rules this file keeps:
##  - an accepted socket is judged (`PKeyLanAddress.verdict` on its peer address; Godot sockets expose no
##    local address, so `local` is unknown) before a slot is taken and before a byte is read; one that
##    fails, or one refused for capacity, is closed at once and costs no slot;
##  - unauthenticated sockets are bounded in number, per address and per group (a /24, a /64 or a link),
##    each for the handshake window; a slot lives until `settle()`;
##  - the handshake window ends at `established()`; a socket past it lives on, one that never reaches it is
##    expired when the window lapses (`tick`);
##  - at most ACCEPTS_PER_FRAME connections are taken a frame;
##  - a dial races its addresses (RFC 8305): first-seen order, at most DIAL_MAX_IN_FLIGHT attempts, a new one
##    every stagger (at once when one fails); the first connection that passes the verdict wins and any
##    other connected socket closes before a byte is sent on it.
##
## Options: `max_pending` (32), `max_pending_per_address` (4), `max_pending_per_group` (16),
## `handshake_seconds` (30), `allow_loopback` (tests and same-host peers only), `mono` (Callable() ->
## monotonic seconds), `tree`, `dial_stagger`, `dial_seconds`, `connector` (Callable(host, port) -> an
## Attempt, a test seam).

const MAX_PENDING := 32
const MAX_PENDING_PER_ADDRESS := 4
const MAX_PENDING_PER_GROUP := 16
const HANDSHAKE_SECONDS := 30.0
const DIAL_SECONDS := 10.0
const DIAL_STAGGER_SECONDS := 0.25
const DIAL_MAX_IN_FLIGHT := 2
const ACCEPTS_PER_FRAME := 8

var _o: Dictionary
var _tree: SceneTree
var _limit: PendingLimiter
var _slots: Dictionary = {}


func _init(options := {}) -> void:
	_o = options
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	_limit = PendingLimiter.new(
			int(options.get("max_pending", MAX_PENDING)),
			int(options.get("max_pending_per_address", MAX_PENDING_PER_ADDRESS)),
			int(options.get("max_pending_per_group", MAX_PENDING_PER_GROUP)))


func _to_string() -> String:
	return "PKeyPeerLanGate()"


## The handshake window in seconds.
func window() -> float:
	return float(_o.get("handshake_seconds", HANDSHAKE_SECONDS))


## Sockets that hold a slot.
func size() -> int:
	return _slots.size()


func is_empty() -> bool:
	return _limit.is_empty()


func loopback_allowed() -> bool:
	return bool(_o.get("allow_loopback", false))


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return float((clock as Callable).call()) if clock is Callable and (clock as Callable).is_valid() else float(Time.get_ticks_msec()) / 1000.0


# -- admission ------------------------------------------------------------------------------------


## Take at most ACCEPTS_PER_FRAME connections waiting on `server`, handing each to `on_peer(peer)`.
func drain(server: TCPServer, on_peer: Callable) -> void:
	if server == null:
		return
	for i in ACCEPTS_PER_FRAME:
		if not server.is_connection_available():
			return
		var peer := server.take_connection()
		if peer != null:
			on_peer.call(peer)


## Judge, limit and time a new inbound socket. A Slot, or null when the socket was closed: its source is
## off the LAN, `refuse` is set (stopped, or no room for a session), or a limit is met.
func admit(peer: StreamPeerTCP, refuse := false) -> Slot:
	var v := PKeyLanAddress.verdict(peer.get_connected_host(), null, loopback_allowed())
	if not v["dial"] or v["key"] == null or refuse:
		peer.disconnect_from_host()
		return null
	var release := _limit.take(peer, PendingLimiter.keys_of(v["key"]))
	if not release.is_valid():
		peer.disconnect_from_host()
		return null
	var slot := Slot.new(self, release, str(v["key"]), _mono())
	_slots[slot.get_instance_id()] = slot
	return slot


func _forget(slot: Slot) -> void:
	_slots.erase(slot.get_instance_id())


## Once a frame: expire the slots that never reached `established()` within the window. A slot with an
## `on_expire` Callable has it called (the owner ends its link); the slot is then settled.
func tick() -> void:
	var now := _mono()
	var span := window()
	for id: int in _slots.keys():
		var slot: Slot = _slots.get(id)
		if slot != null and not slot.up and slot.on_expire.is_valid() and now - slot.at >= span:
			slot.expire()


## End every slot that has an `on_expire`; `keep_up` spares those past `established()`.
func destroy_pending(keep_up := false) -> void:
	for id: int in _slots.keys():
		var slot: Slot = _slots.get(id)
		if slot != null and slot.on_expire.is_valid() and not (keep_up and slot.up):
			slot.expire()


## Listen on `host` ("" or "*": dual-stack, then IPv4 only on the same single port) and `port` (0: random).
## ok with the TCPServer, or `not_listening`.
static func listen(host: String, port: int) -> PKeyResult:
	var srv := TCPServer.new()
	var err := srv.listen(port, "*" if host == "" else host)
	if err != OK and host == "":
		# No IPv6 here: IPv4 only, on the same single port.
		err = srv.listen(port, "0.0.0.0")
	if err != OK:
		return PKeyConnectErrors.lan("not_listening", "The LAN listener could not be opened.")
	return PKeyResult.success(srv)


# -- addresses ------------------------------------------------------------------------------------


## May this address text be dialled? The verdict with no local address (D-6), and not link-local (a
## dial needs a zone Godot's sockets cannot carry).
func dialable(host: String) -> bool:
	if host.contains("%"):
		return false
	var raw := PKeyMdnsPacket.address_bytes(host)
	if raw.size() == 16 and raw[0] == 0xfe and (raw[1] & 0xc0) == 0x80:
		return false
	return bool(PKeyLanAddress.verdict(host, null, loopback_allowed())["dial"])


## The text to connect to: an IPv4-mapped address connects as its IPv4 address.
static func connect_text(host: String) -> String:
	var raw := PKeyMdnsPacket.address_bytes(host)
	if raw.size() == 16:
		var mapped := raw[10] == 0xff and raw[11] == 0xff
		for i in 10:
			if raw[i] != 0:
				mapped = false
		if mapped:
			return PKeyMdnsPacket.address_text(raw.slice(12))
	return host


# -- dialling -------------------------------------------------------------------------------------


## Race the addresses: first-seen order, at most DIAL_MAX_IN_FLIGHT attempts, a new one every stagger (at
## once when one fails). The first connection that passes the verdict on its own address wins; every
## other attempt closes before a byte is sent on it. `stopped` (Callable() -> bool) ends the race. A
## coroutine answering {pipe, host}, or {} when none connected in time.
func race(hosts: Array, port: int, stopped := Callable()) -> Dictionary:
	var stagger := float(_o.get("dial_stagger", DIAL_STAGGER_SECONDS))
	var deadline := _mono() + float(_o.get("dial_seconds", DIAL_SECONDS))
	var tries: Array[Attempt] = []
	var nxt := 0
	var next_at := -INF
	while true:
		while nxt < hosts.size() and tries.size() < DIAL_MAX_IN_FLIGHT and (tries.is_empty() or _mono() >= next_at):
			var host: String = hosts[nxt]
			nxt += 1
			if not dialable(host):
				continue
			var a := _attempt(host, port)
			if a != null:
				tries.append(a)
				next_at = _mono() + stagger
		if tries.is_empty() and nxt >= hosts.size():
			return {}
		var winner: Attempt = null
		for a: Attempt in tries.duplicate():
			var state: int = a.poll()
			if state == Attempt.CONNECTING:
				continue
			tries.erase(a)
			if state == Attempt.FAILED:
				next_at = -INF  # a failure starts the next at once
			elif winner == null and bool(PKeyLanAddress.verdict(a.remote(), null, loopback_allowed())["dial"]):
				winner = a
			else:
				a.abort()  # a second winner, or an address the connected socket fails
		if winner != null:
			for a: Attempt in tries:
				a.abort()
			return {"pipe": winner.take(), "host": winner.host}
		if (stopped.is_valid() and bool(stopped.call())) or _mono() >= deadline:
			for a: Attempt in tries:
				a.abort()
			return {}
		await _tree.process_frame
	return {}


## A native pipe to an advert the OS resolves (the Apple lane): `mdns.dial(instance)`, then the wait for the
## connection. The pipe, or null (no dial, a pipe that finished, or `stopped` / the dial window first). A
## coroutine.
func open_native(mdns: Object, instance: String, stopped := Callable()) -> PKeyPeerPipe:
	if mdns == null or not mdns.has_method("dial"):
		return null
	var pipe: PKeyPeerPipe = mdns.call("dial", instance)
	if pipe == null:
		return null
	var deadline := _mono() + float(_o.get("dial_seconds", DIAL_SECONDS))
	var cancelled := func() -> bool: return stopped.is_valid() and bool(stopped.call())
	while not cancelled.call() and not pipe.is_finished() and not pipe.call("is_connected_native") and _mono() < deadline:
		await _tree.process_frame
	if not cancelled.call() and not pipe.is_finished() and pipe.call("is_connected_native"):
		return pipe
	pipe.abort()
	return null


func _attempt(host: String, port: int) -> Attempt:
	var connector: Variant = _o.get("connector")
	if connector is Callable and (connector as Callable).is_valid():
		return (connector as Callable).call(host, port) as Attempt
	return TcpAttempt.start(host, port)


# -- types ----------------------------------------------------------------------------------------


## What `admit` hands back for an admitted socket.
class Slot extends RefCounted:
	## The judged source address.
	var address := ""
	var at := 0.0
	## The transport is up: the window ended and the slot is kept.
	var up := false
	## Called (no argument) when the window lapses or `destroy_pending` reaches the slot.
	var on_expire: Callable

	var _gate: PKeyPeerLanGate
	var _release: Callable


	func _init(gate: PKeyPeerLanGate, release: Callable, p_address: String, p_at: float) -> void:
		_gate = gate
		_release = release
		address = p_address
		at = p_at


	func _to_string() -> String:
		return "PKeyPeerLanGate.Slot()"


	func established() -> void:
		up = true


	## Release the slot and end the window. Idempotent.
	func settle() -> void:
		if _gate != null:
			_gate._forget(self)
			_gate = null
		if _release.is_valid():
			_release.call()
			_release = Callable()


	func expire() -> void:
		var fn := on_expire
		settle()
		if fn.is_valid():
			fn.call()


## Counts of sockets that have not finished the handshake: in total, per address and per group. A slot
## is taken with `take`, which answers the Callable that gives it back, or an invalid Callable when a
## limit is met.
class PendingLimiter extends RefCounted:
	var _max: int
	var _per_address: int
	var _per_group: int
	var _total := {}
	var _addr := {}
	var _group := {}


	func _init(maximum := 32, per_address := 4, per_group := 16) -> void:
		_max = maximum
		_per_address = per_address
		_per_group = per_group


	func _to_string() -> String:
		return "PKeyPeerLanGate.PendingLimiter()"


	func size() -> int:
		return _total.size()


	func is_empty() -> bool:
		return _total.is_empty() and _addr.is_empty() and _group.is_empty()


	## The keys a verdict `key` is counted under: {address, group}.
	static func keys_of(key: String) -> Dictionary:
		return {"address": key, "group": PKeyLanAddress.group_key(key)}


	func take(who: Object, keys: Dictionary) -> Callable:
		var address: String = keys["address"]
		var group: Variant = keys["group"]
		if _total.size() >= _max or int(_addr.get(address, 0)) >= _per_address:
			return Callable()
		if group != null and int(_group.get(group, 0)) >= _per_group:
			return Callable()
		var id := who.get_instance_id()
		_total[id] = true
		_bump(_addr, address, 1)
		if group != null:
			_bump(_group, group, 1)
		var done := [false]
		return func() -> void:
			if done[0]:
				return
			done[0] = true
			_total.erase(id)
			_bump(_addr, address, -1)
			if group != null:
				_bump(_group, group, -1)


	static func _bump(m: Dictionary, key: Variant, by: int) -> void:
		var n := int(m.get(key, 0)) + by
		if n <= 0:
			m.erase(key)
		else:
			m[key] = n


## One connection attempt of a race. The base class has already failed.
class Attempt extends RefCounted:
	const CONNECTING := 0
	const CONNECTED := 1
	const FAILED := -1

	var host := ""


	## CONNECTING, CONNECTED or FAILED.
	func poll() -> int:
		return FAILED


	## The remote address of a connected attempt, as text.
	func remote() -> String:
		return ""


	## The connected socket as a pipe; no byte has been sent on it.
	func take() -> PKeyPeerTcpPipe:
		return null


	func abort() -> void:
		pass


class TcpAttempt extends Attempt:
	var _peer: StreamPeerTCP


	static func start(p_host: String, port: int) -> Attempt:
		var peer := StreamPeerTCP.new()
		if peer.connect_to_host(PKeyPeerLanGate.connect_text(p_host), port) != OK:
			return null
		var a := TcpAttempt.new()
		a.host = p_host
		a._peer = peer
		return a


	func _to_string() -> String:
		return "PKeyPeerLanGate.TcpAttempt()"


	func poll() -> int:
		_peer.poll()
		match _peer.get_status():
			StreamPeerTCP.STATUS_CONNECTED:
				return CONNECTED
			StreamPeerTCP.STATUS_CONNECTING:
				return CONNECTING
		return FAILED


	func remote() -> String:
		return _peer.get_connected_host()


	func take() -> PKeyPeerTcpPipe:
		return PKeyPeerTcpPipe.from_peer(_peer)


	func abort() -> void:
		_peer.disconnect_from_host()
