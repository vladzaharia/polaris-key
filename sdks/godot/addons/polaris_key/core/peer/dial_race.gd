@tool
class_name PKeyPeerDialRace
extends RefCounted
## The outgoing dial of the LAN lanes (V5 section 15.4.1): several learned addresses are raced in
## first-seen order, at most two attempts in flight, a new one every 250 ms (at once when one fails).
## The first connection whose own address passes `PKeyLanAddress.verdict` wins; every other attempt
## closes before a byte is sent on it. Godot sockets carry no zone, so a link-local address is not
## dialled. Loopback only when `allow_loopback` is set (tests, same-host).
##
## `race` is a coroutine over the main thread's frames. Options: `allow_loopback`, `stagger` (seconds),
## `seconds` (the whole dial), `mono` (Callable() -> monotonic seconds), `connector` (Callable(host,
## port) -> an Attempt, for tests), `cancelled` (Callable() -> bool, true ends the race).

const MAX_IN_FLIGHT := 2
const STAGGER_SECONDS := 0.25
const DIAL_SECONDS := 10.0


## May this address text be dialled? The verdict with no local address, and not link-local.
static func dialable(host: String, allow_loopback := false) -> bool:
	if host.contains("%"):
		return false
	var raw := PKeyMdnsPacket.address_bytes(host)
	if raw.size() == 16 and raw[0] == 0xfe and (raw[1] & 0xc0) == 0x80:
		return false
	return bool(PKeyLanAddress.verdict(host, null, allow_loopback)["dial"])


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


## Race `hosts` on `port`. Answers {pipe, host} for the winner, or {} when none connected in time.
static func race(tree: SceneTree, hosts: Array, port: int, o := {}) -> Dictionary:
	var allow_loopback := bool(o.get("allow_loopback", false))
	var stagger := float(o.get("stagger", STAGGER_SECONDS))
	var mono: Callable = o.get("mono", Callable())
	var cancelled: Callable = o.get("cancelled", Callable())
	var connector: Callable = o.get("connector", Callable())
	var deadline := _now(mono) + float(o.get("seconds", DIAL_SECONDS))
	var tries: Array[Attempt] = []
	var nxt := 0
	var next_at := -INF
	while true:
		while nxt < hosts.size() and tries.size() < MAX_IN_FLIGHT and (tries.is_empty() or _now(mono) >= next_at):
			var host: String = hosts[nxt]
			nxt += 1
			if not dialable(host, allow_loopback):
				continue
			var a: Attempt = connector.call(host, port) if connector.is_valid() else TcpAttempt.start(host, port)
			if a != null:
				tries.append(a)
				next_at = _now(mono) + stagger
		if tries.is_empty() and nxt >= hosts.size():
			return {}
		var winner: Attempt = null
		for a: Attempt in tries.duplicate():
			var state: int = a.poll()
			if state == Attempt.CONNECTING:
				continue
			tries.erase(a)
			if state == Attempt.FAILED:
				next_at = -INF
			elif winner == null and bool(PKeyLanAddress.verdict(a.remote(), null, allow_loopback)["dial"]):
				winner = a
			else:
				a.abort()
		if winner != null:
			for a: Attempt in tries:
				a.abort()
			return {"pipe": winner.take(), "host": winner.host}
		if (cancelled.is_valid() and bool(cancelled.call())) or _now(mono) >= deadline:
			for a: Attempt in tries:
				a.abort()
			return {}
		await tree.process_frame
	return {}


static func _now(mono: Callable) -> float:
	return float(mono.call()) if mono.is_valid() else float(Time.get_ticks_msec()) / 1000.0


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
	func take() -> PKeyPeerPipe:
		return null


	func abort() -> void:
		pass


class TcpAttempt extends Attempt:
	var _peer: StreamPeerTCP


	static func start(p_host: String, port: int) -> Attempt:
		var peer := StreamPeerTCP.new()
		if peer.connect_to_host(PKeyPeerDialRace.connect_text(p_host), port) != OK:
			return null
		var a := TcpAttempt.new()
		a.host = p_host
		a._peer = peer
		return a


	func _to_string() -> String:
		return "PKeyPeerDialRace.TcpAttempt()"


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


	func take() -> PKeyPeerPipe:
		return PKeyPeerTcpPipe.from_peer(_peer)


	func abort() -> void:
		_peer.disconnect_from_host()
