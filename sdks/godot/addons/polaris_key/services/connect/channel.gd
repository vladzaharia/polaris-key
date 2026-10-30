@tool
class_name PKeyConnectChannel
extends RefCounted
## What the LAN and relay transports share (CC-14.10b; WIRE-CONTRACT-V5 sections 15.3 and 15.5),
## ported from sdk-node `connect/channel.ts` and the Python `connect/channel.py`: the account context
## and session options a `PKeyPeerSession` is built from, the glue that makes a `PKeyConnectSession`
## when a link is admitted, and the handling of the two documents a peer may push on an open session,
## `RING` and `TRUST`.
##
## Rules this file keeps:
##  - the device's X25519 private key never leaves the key port: the session is given a port whose
##    `dh` calls the key store, and nothing here sees the key (G1);
##  - a pushed document is never trusted because a peer sent it. `RING` is re-verified and stored by
##    the identity client under its replacement rules (`adopt_ring`); `TRUST` is verified against the
##    usable pins and applied by the trust custodian. Each outcome, stored or refused, is a notice;
##    none is dropped silently (G11);
##  - the identity refresh a roster change calls for runs at most once a minute, with a deferred retry
##    at the end of the gap and after a failure (G12);
##  - nothing here puts a key, K_disc, certificate or roster in a `str()`, a notice or a result.

## The first platform name of the hello when the host has none, and the app name's source.
const UNKNOWN_PLATFORM := "unknown"


## The account context of a session (see PKeyPeerSession). `ring` is a Callable returning the newest
## roster a session handed up, {jws, epoch}, or null: it overrides the roster `src` was taken with.
static func peer_account(src: PKeyConnectClient.PeerSource, ring: Callable = Callable()) -> Dictionary:
	var held := func() -> Variant:
		var pushed: Variant = ring.call() if ring.is_valid() else null
		return pushed if pushed is Dictionary else {"jws": src.ring, "epoch": src.ring_epoch}
	return {
		"trust": src.trust, "expected_aud": src.slug, "cert_jws": src.certificate, "own_sub": src.sub,
		"own_device_id": src.device_id, "held_ring": held,
		"disc_keys": [src.disc_current, src.disc_previous if not src.disc_previous.is_empty() else null],
	}


## The Noise key port of a held identity: the agreement public key and `dh` through the key store.
static func key_port(src: PKeyConnectClient.PeerSource) -> Object:
	return KeyPort.new(src)


## The session options every transport shares (all but `send` and `on_event`, which the link adds):
## mode a, the held identity as the account, the key port as the static key. `o`: `role`
## ("initiator" or "responder", required), `caps` (default ["app/1"]), `label`, `ring` (see
## `peer_account`), `now`, `mono`, `rekey_messages`, `rekey_seconds`, `crypto`, `offload`.
static func session_options(src: PKeyConnectClient.PeerSource, o: Dictionary) -> Dictionary:
	var platform := PKeyHeaders.platform()
	var out := {
		"mode": "a", "role": o.get("role", ""), "slug": src.slug, "static_key": key_port(src),
		"account": peer_account(src, o.get("ring", Callable())), "caps": o.get("caps", ["app/1"]),
		"hello": {"label": str(o.get("label", "")), "platform": platform if platform != "" else UNKNOWN_PLATFORM, "app": src.slug},
	}
	for k in ["now", "mono", "rekey_messages", "rekey_seconds", "crypto", "offload"]:
		if o.has(k):
			out[k] = o[k]
	return out


## Binds a link to the host: when the link is admitted a `PKeyConnectSession` is made and `opened`
## fires; its APP records are routed to the session; pushed documents go to `docs`; the link's end
## ends the session. The caller keeps the Attachment (it is what holds the session).
static func attach(link: PKeyPeerLink, docs: Docs, role: String, remote_address := "", path := "lan", budget: PKeyConnectSession.Budget = null) -> Attachment:
	return Attachment.new(link, docs, role, remote_address, path, budget)


## The glue between one link and the host (sdk-node `SocketLink`'s session half).
class Attachment extends RefCounted:
	## The peer was admitted; `session` is the host's handle.
	signal opened(session: PKeyConnectSession)
	## The link ended before the peer was admitted.
	signal refused(close_code: StringName)
	signal settled

	var session: PKeyConnectSession

	var _link: PKeyPeerLink
	var _docs: Docs
	var _role: String
	var _remote: String
	var _path: String
	var _budget: PKeyConnectSession.Budget
	var _refused_code: StringName = &""


	func _init(p_link: PKeyPeerLink, p_docs: Docs, p_role: String, p_remote: String, p_path: String, p_budget: PKeyConnectSession.Budget) -> void:
		_link = p_link
		_docs = p_docs
		_role = p_role
		_remote = p_remote
		_path = p_path
		_budget = p_budget
		_link.established.connect(_on_established)
		_link.record.connect(_on_record)
		_link.ring.connect(_on_ring)
		_link.trust.connect(_on_trust)
		_link.ring_wanted.connect(_on_ring_wanted)
		_link.closed.connect(_on_closed)


	func _to_string() -> String:
		return "PKeyConnectChannel.Attachment()"


	## Waits for the peer's admission: ok with the session, or `peer-cert-invalid` (reason
	## `handshake_failed`, `close_code` naming why) when the link ended first. A coroutine.
	func wait_opened() -> PKeyResult:
		while session == null and _refused_code == &"":
			await settled
		if session != null:
			return PKeyResult.success(session)
		return PKeyConnectErrors.lan("handshake_failed", "The peer was not admitted.", {"close_code": _refused_code})


	func _on_established(info: Dictionary) -> void:
		# Mode a only: a session in another mode has no device id and is not a Connect session.
		if str(info.get("peer_device_id", "")) == "" or session != null:
			return
		session = PKeyConnectSession.new(_link, info["peer_device_id"], info["caps"], info["hello"], _role, _remote, _path, _budget)
		opened.emit(session)
		settled.emit()


	func _on_record(type: int, body: PackedByteArray) -> void:
		PKeyConnectSession.route_record(_link, session, type, body)


	func _on_ring(jws: String, epoch: int) -> void:
		if _docs != null:
			_docs.on_ring(jws, epoch)


	func _on_trust(jws: String) -> void:
		if _docs != null:
			_docs.on_trust(jws)


	func _on_ring_wanted() -> void:
		if _docs != null:
			_docs.on_ring_wanted()


	func _on_closed(code: StringName, by_peer: bool) -> void:
		if session != null:
			session.ended(code, by_peer)
		else:
			_refused_code = code
			refused.emit(code)
			settled.emit()


## The Noise key port: the public half is held, `dh` calls the key store through the source.
class KeyPort extends RefCounted:
	var _src: PKeyConnectClient.PeerSource


	func _init(src: PKeyConnectClient.PeerSource) -> void:
		_src = src


	func _to_string() -> String:
		return "PKeyConnectChannel.KeyPort()"


	func public_key() -> PackedByteArray:
		return _src.agree_public.duplicate()


	## The shared secret, or null when the store refuses (a low-order point, no keys, a fault).
	func dh(remote: PackedByteArray) -> Variant:
		var r := _src.dh(remote)
		return r.detail if r.ok and r.detail is PackedByteArray else null


## Pushed documents (sdk-node `PeerDocs`, with the G11 and G12 bounds the Python port carries).
## `src` holds the host calls: `adopt_ring` (Callable(jws) -> {stored, epoch} or {stored = false,
## reason}), `apply_trust` (Callable(jws) -> coroutine {applied} or {applied = false, reason}),
## `refresh` (Callable() -> coroutine PKeyResult, the identity fetch) and `mono` (Callable() ->
## monotonic seconds; default the engine's tick counter). `on_stored` is called after a roster was
## stored or a refresh succeeded. `timer` is Callable(seconds, fn) that calls `fn` once later
## (default: a SceneTree timer). A call may be absent: the document is then refused `unsupported`.
class Docs extends RefCounted:
	## One outcome per pushed document: {type: "ring" | "trust", outcome: "stored" | "applied" |
	## "refused", epoch?, reason?}.
	signal notice(n: Dictionary)

	const REFRESH_GAP_SECONDS := 60.0
	## Pushed documents waiting at once; the rest are refused `busy`. A TRUST flood cannot take the
	## last slot: it is kept for a RING.
	const MAX_DOCS_QUEUED := 8
	const MAX_RETRIES := 5
	## At most one `busy` notice per kind per second; the rest are dropped, not notified.
	const BUSY_NOTICE_GAP_SECONDS := 1.0

	## The newest roster a session handed up, {jws, epoch}, held until an identity load catches up.
	var pushed: Variant = null

	var _src: Dictionary
	var _on_stored: Callable
	var _timer: Callable
	var _active := {}
	var _queue: Array = []
	var _running := false
	var _closed := false
	var _last_refresh := -INF
	var _retry_pending := false
	var _tries := 0
	var _last_busy := {}


	func _init(src: Dictionary, on_stored := Callable(), timer := Callable()) -> void:
		_src = src
		_on_stored = on_stored
		_timer = timer


	func _to_string() -> String:
		return "PKeyConnectChannel.Docs()"


	## Stop a pending retry; nothing runs or is stored after this.
	func close() -> void:
		_closed = true
		_queue = []


	# What a link reports; PKeyConnectChannel.Attachment calls these.

	func on_ring(jws: String, epoch: int) -> void:
		if pushed == null or epoch > int((pushed as Dictionary)["epoch"]):
			pushed = {"jws": jws, "epoch": epoch}
		ring(jws)


	func on_trust(jws: String) -> void:
		trust(jws)


	func on_ring_wanted() -> void:
		want_ring()


	## A roster a peer pushed (already verified once by the session).
	func ring(jws: String) -> void:
		_enqueue("ring", jws)


	## A trust manifest a peer pushed (not verified by the session).
	func trust(jws: String) -> void:
		_enqueue("trust", jws)


	## A peer is on a newer roster, or the relay said the roster changed: fetch it (a fresh identity
	## fetch, verified under the normal replacement rules). At most one a minute, on the monotonic
	## clock, so a wall clock set back cannot hold refreshes off. True when a fetch started.
	func want_ring() -> bool:
		return _want(false)


	func _want(retry: bool) -> bool:
		var refresh: Variant = _src.get("refresh")
		if not refresh is Callable or not (refresh as Callable).is_valid() or _closed:
			return false
		var t := _mono()
		if t - _last_refresh < REFRESH_GAP_SECONDS:
			if retry:
				_defer(_last_refresh + REFRESH_GAP_SECONDS - t)
			return false
		_last_refresh = t
		_refresh(refresh, retry)
		return true


	func _refresh(refresh: Callable, retry: bool) -> void:
		var r: Variant = await refresh.call()
		if _closed:
			return
		if r is PKeyResult and (r as PKeyResult).ok:
			_tries = 0
			_stored()
			return
		_tries += 1
		if retry and _tries <= MAX_RETRIES:
			_defer(REFRESH_GAP_SECONDS)


	func _defer(seconds: float) -> void:
		if _retry_pending or _closed:
			return
		_retry_pending = true
		var fire := Callable(self, "_retry")
		if _timer.is_valid():
			_timer.call(maxf(1.0, seconds), fire)
			return
		var tree := Engine.get_main_loop() as SceneTree
		if tree == null:
			_retry_pending = false
			return
		tree.create_timer(maxf(1.0, seconds)).timeout.connect(fire)


	func _retry() -> void:
		_retry_pending = false
		if not _closed:
			_want(true)


	## One at a time, at most MAX_DOCS_QUEUED waiting (a TRUST one fewer), and a document already
	## waiting is not queued twice: the excess is refused visibly, not worked on.
	func _enqueue(kind: String, jws: String) -> void:
		if _closed:
			return
		var key := kind + ":" + jws
		var limit := MAX_DOCS_QUEUED if kind == "ring" else MAX_DOCS_QUEUED - 1
		if _active.has(key) or _active.size() >= limit:
			var t := _mono()
			if t - float(_last_busy.get(kind, -INF)) >= BUSY_NOTICE_GAP_SECONDS:
				_last_busy[kind] = t
				notice.emit({"type": kind, "outcome": "refused", "reason": "busy"})
			return
		_active[key] = true
		_queue.append({"kind": kind, "jws": jws, "key": key})
		if not _running:
			_drain()


	func _drain() -> void:
		_running = true
		while not _queue.is_empty():
			var item: Dictionary = _queue.pop_front()
			if not _closed:
				if item["kind"] == "ring":
					_handle_ring(item["jws"])
				else:
					await _handle_trust(item["jws"])
			_active.erase(item["key"])
		_running = false


	func _handle_ring(jws: String) -> void:
		var adopt: Variant = _src.get("adopt_ring")
		if not adopt is Callable or not (adopt as Callable).is_valid():
			notice.emit({"type": "ring", "outcome": "refused", "reason": "unsupported"})
			return
		var r: Variant = (adopt as Callable).call(jws)
		if not r is Dictionary:
			notice.emit({"type": "ring", "outcome": "refused", "reason": "failed"})
			return
		if not r.get("stored", false):
			notice.emit({"type": "ring", "outcome": "refused", "reason": str(r.get("reason", "failed"))})
			return
		notice.emit({"type": "ring", "outcome": "stored", "epoch": int(r.get("epoch", 0))})
		_stored()
		# The certificate and K_disc that go with the new roster come from the Worker. If the
		# minute's slot is taken, or the fetch fails, it is tried again.
		_want(true)


	func _handle_trust(jws: String) -> void:
		var apply: Variant = _src.get("apply_trust")
		if not apply is Callable or not (apply as Callable).is_valid():
			notice.emit({"type": "trust", "outcome": "refused", "reason": "unsupported"})
			return
		var r: Variant = await (apply as Callable).call(jws)
		if not r is Dictionary:
			notice.emit({"type": "trust", "outcome": "refused", "reason": "failed"})
		elif r.get("applied", false):
			notice.emit({"type": "trust", "outcome": "applied"})
		else:
			notice.emit({"type": "trust", "outcome": "refused", "reason": str(r.get("reason", "failed"))})


	func _stored() -> void:
		if _on_stored.is_valid():
			_on_stored.call()


	func _mono() -> float:
		var clock: Variant = _src.get("mono")
		return float((clock as Callable).call()) if clock is Callable and (clock as Callable).is_valid() else float(Time.get_ticks_msec()) / 1000.0
