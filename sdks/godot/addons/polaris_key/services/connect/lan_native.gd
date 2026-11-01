@tool
class_name PKeyConnectLanNative
extends RefCounted
## The native-pipe half of the LAN service (CC-14b.5): peers the OS found by name (the Apple lane) are
## dialled through the adapter, and sockets the OS side accepted are admitted into the same handshake as
## a TCP socket. It works on a `PKeyConnectLan` and uses its internals; nothing here is a second state.
##
## The OS side judges the source address (G6) and holds the unadmitted limits (G7, 32 total, 4 per
## address, 16 per group, 30 s); the LAN service keeps the session caps and tells the adapter once a
## session is open (`admit`), which frees the pipe from the pre-admission limits.


## Dial a peer by instance name. The adapter's pipe is connecting: wait for the connection (a finished
## pipe is a dial that failed), then run the handshake and check the device that answered.
static func dial(lan: PKeyConnectLan, peer: Dictionary, want: String) -> PKeyResult:
	var idr := lan._identity(false)
	var mdns: Object = lan._mdns
	var pipe: PKeyPeerPipe = null
	if idr.ok and mdns != null and mdns.has_method("dial"):
		pipe = mdns.call("dial", str(peer.get("instance", "")))
	if not idr.ok:
		return idr
	if mdns == null or not mdns.has_method("dial"):
		return PKeyConnectErrors.lan("unknown_peer", "That device was not found on this network.")
	var failure := PKeyConnectErrors.lan("connect_failed", "The device did not answer.")
	if pipe == null:
		return failure
	var deadline: float = lan._mono() + float(lan._o.get("dial_seconds", PKeyConnectLan.DIAL_SECONDS))
	while not lan._stopped and not pipe.is_finished() and not pipe.call("is_connected_native") and lan._mono() < deadline:
		await lan._tree.process_frame
	var one := {"error": failure}
	if not lan._stopped and not pipe.is_finished() and pipe.call("is_connected_native"):
		one = await lan._handshake(pipe, idr.detail, "")
	else:
		pipe.abort()
	if not one.has("session"):
		return one["error"]
	var session: PKeyConnectSession = one["session"]
	if session.peer_device_id != want:
		session.close()
		return PKeyConnectErrors.lan("wrong_peer", "The device that answered is not the one that advertised.")
	return PKeyResult.success(session)


## An inbound native pipe: into the handshake as the responder, or aborted when the service is stopped,
## full or has no identity.
static func admit(lan: PKeyConnectLan, pipe: PKeyPeerPipe) -> void:
	var idr := lan._identity(false) if not lan._stopped else null
	var full: bool = lan._sessions.size() >= int(lan._o.get("max_sessions", PKeyConnectLan.MAX_SESSIONS)) \
			or lan._pending.size() >= int(lan._o.get("max_pending", PKeyConnectLan.MAX_PENDING))
	var made: Dictionary = lan._make_link(pipe, idr.detail, "responder") if idr != null and idr.ok and not full else {}
	if made.is_empty():
		pipe.abort()
		return
	var p := PKeyConnectLan.Pending.new()
	p.link = made["link"]
	p.attachment = made["attachment"]
	p.pipe = pipe
	p.at = lan._mono()
	lan._pending[p.get_instance_id()] = p
	p.attachment.opened.connect(lan._on_inbound.bind(p.get_instance_id()))
	p.link.closed.connect(lan._on_pending_closed.bind(p.get_instance_id()))
