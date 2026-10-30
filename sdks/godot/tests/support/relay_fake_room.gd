class_name PKeyRelayFakeRoom
extends RefCounted
## TEST ONLY: an in-memory relay room (CC-14.13; WIRE-CONTRACT-V5 section 15.7) and the sockets of the
## clients in it. It speaks the envelopes of `PKeyPeerRelayCodec`: a client's LIST is answered with
## MEMBERS, PING with PONG, SEND is stamped with the sender and delivered as RECV to the addressed
## device, and a device that leaves is announced with GONE. The room can also push what the Worker
## pushes (RING, LIMIT), close a client with a code, and misbehave (a text frame, a garbage envelope,
## an open without the protocol echoed back).
##
## `opener` is the `opener` option of `PKeyConnectRelay`: it makes a client for the next device in
## `devices` (24 raw bytes each; the last one repeats). Every open is recorded in `opens`: the URL and
## the subprotocols offered, the second of which is the ticket. Nothing here prints one.
##
## Knobs (read at each open): `refuse_open` (the opener answers null), `open_after` (polls before the
## socket opens), `echo` (the protocol the server selects; "" selects none), `tickets` (every ticket
## offered, for a test that checks they differ).

var devices: Array = []
var opens: Array[Dictionary] = []
var clients: Array = []
var refuse_open := false
var open_after := 0
var echo := PKeyConnectRelay.PROTOCOL
var auto := true
var tickets: Array = []

var _next := 0


func _to_string() -> String:
	return "PKeyRelayFakeRoom(%d clients)" % clients.size()


## The opener a service is given.
func opener(url: String, protocols: Array) -> PKeyConnectRelay.Socket:
	opens.append({"url": url, "protocols": protocols.duplicate()})
	if protocols.size() > 1:
		tickets.append(str(protocols[1]))
	if refuse_open:
		return null
	var device: PackedByteArray = devices[mini(_next, devices.size() - 1)] if not devices.is_empty() else PackedByteArray()
	_next += 1
	var c := Client.new(self, device)
	c.open_after = open_after
	c.echo = echo
	clients.append(c)
	return c


## The newest client of `device` (24 bytes), or null.
func client_of(device: PackedByteArray) -> Client:
	for i in range(clients.size() - 1, -1, -1):
		if clients[i].device == device and clients[i].state() != PKeyConnectRelay.Socket.CLOSED:
			return clients[i]
	return null


## The newest client.
func last() -> Client:
	return clients[clients.size() - 1] if not clients.is_empty() else null


## Every device that is open now.
func online() -> Array:
	var out: Array = []
	for c in clients:
		if c.state() == PKeyConnectRelay.Socket.OPEN and not out.has(c.device):
			out.append(c.device)
	return out


func _from_client(c: PKeyConnectRelay.Socket, data: PackedByteArray) -> void:
	c.sent.append(data)
	if not auto:
		return
	var m := PKeyPeerRelayCodec.decode(PKeyPeerRelayCodec.DIR_TO_ROOM, data)
	match m.get("op"):
		&"list":
			c.push(PKeyPeerRelayCodec.encode({"op": &"members", "devices": online()}))
		&"ping":
			c.push(PKeyPeerRelayCodec.encode({"op": &"pong", "data": m["data"]}))
		&"send":
			var to := client_of(m["to"])
			if to != null:
				to.push(PKeyPeerRelayCodec.encode({"op": &"recv", "from": c.device, "session": m["session"], "noise": m["noise"]}))


func _left(c: PKeyConnectRelay.Socket) -> void:
	for o in clients:
		if o != c and o.state() == PKeyConnectRelay.Socket.OPEN and c.device != o.device:
			o.push(PKeyPeerRelayCodec.encode({"op": &"gone", "device": c.device}))


## One client's socket.
class Client extends PKeyConnectRelay.Socket:
	var device: PackedByteArray
	var open_after := 0
	var echo := PKeyConnectRelay.PROTOCOL
	## Every message the client sent, as bytes; `closed_by_client` is the code it closed with, -1 for none.
	var sent: Array = []
	var closed_by_client := -1
	var inbox: Array = []
	var polls := 0

	var _state := CONNECTING
	var _code := -1
	## The room holds its clients, so a client holds the room weakly.
	var _room: WeakRef


	func _init(p_room: RefCounted, p_device: PackedByteArray) -> void:
		_room = weakref(p_room)
		device = p_device


	func _to_string() -> String:
		return "PKeyRelayFakeRoom.Client()"


	func poll() -> void:
		polls += 1
		if _state == CONNECTING and polls > open_after:
			_state = OPEN


	func state() -> int:
		return _state


	func protocol() -> String:
		return echo if _state == OPEN else ""


	func recv() -> Variant:
		if _state != OPEN or inbox.is_empty():
			return null
		return inbox.pop_front()


	func send(data: PackedByteArray) -> bool:
		if _state != OPEN:
			return false
		var room: Object = _room.get_ref()
		if room != null:
			room.call("_from_client", self, data)
		return true


	func close(code: int) -> void:
		if _state == CLOSED:
			return
		closed_by_client = code
		_code = code
		_state = CLOSED
		_announce_leave()


	func code() -> int:
		return _code


	# What the server does.

	## Deliver a binary message to the client.
	func push(data: PackedByteArray) -> void:
		inbox.append(data)


	## Deliver a text frame.
	func push_text(text: String) -> void:
		inbox.append(text)


	## The server closes the socket with `status` (-1: dropped with no close frame).
	func remote_close(status: int) -> void:
		if _state == CLOSED:
			return
		_code = status
		_state = CLOSED
		_announce_leave()


	func _announce_leave() -> void:
		var room: Object = _room.get_ref()
		if room != null:
			room.call("_left", self)
