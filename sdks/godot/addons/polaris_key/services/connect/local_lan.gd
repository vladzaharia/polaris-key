@tool
class_name PKeyConnectLocalLan
extends RefCounted
## The LAN half of local links (CC-29b.G3b; WIRE-CONTRACT-V5 sections 15.5 and 15.12, "Mode l"), ported from the local
## parts of sdk-node `connect/lan.ts` (`startLocal`): it listens for the local links this device holds, advertises the
## reachable ones as `m=l`, browses for the other device of each link and dials it. It holds no account identity, so it
## serves local links with no account at all. It runs on the discovery lane, the TCP gate and the pump the other LAN
## service uses (`PKeyPeerLanGate`, `PKeyPeerPump`), on the main thread; the only work off it is the pump's Noise tasks.
##
## Rules this file keeps:
##  - nothing runs without a link: the owner starts the service only while the gate is on and a link is held, and
##    stops it when either ends. A listener that serves nothing closes every connection before a byte is read;
##  - at most 8 adverts are live (`m=l`, slot l), one per reachable link, named by `PKeyPeerLocal.local_instance` with
##    this device's own link key, and renewed at every 15-minute epoch;
##  - a browse hit is kept only when one of the first 32 links would announce that name, with the peer's link key, in
##    this or the previous epoch; it is worked out once per epoch, so a forged name is an O(1) miss;
##  - the listener tries the held links' secrets in held order under one limiter, with the source group's budget
##    first, and pads a miss to the fixed number of trials (`PKeyPeerLocalFlow`);
##  - sockets that have not been admitted are bounded and judged on their address by `PKeyPeerLanGate`;
##  - the keys and secrets are the owner's copies, replaced on `refresh()` and zeroed on `stop()`; a session gets its own.
##    No key, secret or name is put in `str()`, a notice or a result.
##
## Use. `PKeyConnectLocalLan.start(options)` answers a PKeyResult holding the running service. `options`: `slug`, `now`
## (Callable() -> epoch seconds), `locals` (Callable() -> the live links as `PKeyConnectLocalState.live_all` answers
## them, none while the gate is off), `allowed` (Callable() -> bool, the gate), `mdns` (the lane), `pump`, `tree`,
## `budget`, `caps`, `label`, `mono`, `timer`, `host`, `port`, `allow_loopback`, `advertise` (true), `browse` (true),
## `xfer`, plus the gate's own options (`dial_seconds`, `dial_stagger`, `handshake_seconds`, `connector`).

## An inbound mode-l session, once it is open and the pin has passed.
signal session_opened(session: PKeyConnectSession)
## A link was seen on the network (its `m=l` advert matched): the owner moves its last-seen time.
signal sighted(id: String)

const HANDSHAKE_SECONDS := 30.0
const MAX_SESSIONS := 64
const MAX_SESSIONS_PER_LINK := 4
const MISS_CACHE := 1024

var _o: Dictionary
var _tree: SceneTree
var _pump: PKeyPeerPump
var _mdns: Object
var _budget: PKeyConnectSession.Budget
var _gate: PKeyPeerLanGate
var _limiter: PKeyPeerLimiter
var _server: TCPServer
var _native := false
var _port := 0
var _stopped := false
var _framed := false
var _timer_gen := 0
var _locals: Array = []
var _names: Dictionary = {}
var _names_epoch := -1
var _peers: Dictionary = {}
var _miss: Dictionary = {}
var _adverts: Dictionary = {}
var _browse: Object
var _pending: Dictionary = {}
var _sessions: Dictionary = {}
var _links: Dictionary = {}


static func start(options: Dictionary) -> PKeyResult:
	if (
		not options.get("slug") is String
		or not options.get("now") is Callable
		or not options.get("locals") is Callable
	):
		return PKeyResult.failure(
			PKeyConstants.ErrorCode.INVALID_OPTIONS, "Local LAN: bad options."
		)
	var s := PKeyConnectLocalLan.new(options)
	var r := s._start()
	if not r.ok:
		s.stop()
		return r
	return PKeyResult.success(s)


func _init(options: Dictionary) -> void:
	_o = options
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	_pump = options.get("pump", null) as PKeyPeerPump
	if _pump == null:
		_pump = PKeyPeerPump.new(_tree)
	_mdns = options.get("mdns", null) as Object
	if _mdns == null:
		_mdns = PKeyMdns.new(
			{"allow_loopback": _loopback(), "only": options.get("interfaces", []), "tree": _tree}
		)
	_budget = options.get("budget", null) as PKeyConnectSession.Budget
	_gate = PKeyPeerLanGate.new(options)
	_limiter = PKeyPeerLimiter.new(5, 4, Callable(self, "_mono"))


func _to_string() -> String:
	return "PKeyConnectLocalLan(port=%d)" % _port


# -- the surface ----------------------------------------------------------------------------------


func port() -> int:
	return _port


func is_stopped() -> bool:
	return _stopped


## {port, advertising, browsing, mdns} (no key, no address).
func status() -> Dictionary:
	return {
		"port": _port,
		"advertising": not _adverts.is_empty(),
		"browsing": _browse != null,
		"mdns": _mdns.call("status") if _mdns != null and _mdns.has_method("status") else {},
	}


## The local links seen on this network now: their ids.
func seen() -> Array:
	return _peers.keys()


## The names of the live adverts (a test reads it).
func advert_names() -> Array:
	return _adverts.keys()


## Sessions that are open now, both ways.
func session_count() -> int:
	return _sessions.size()


## Sockets accepted and not yet admitted.
func pending_count() -> int:
	return _pending.size()


## Read the links again (stored, removed, re-marked, or the gate moved) and bring the adverts, the accepted names and the
## listener's trial order to match. A handshake still running under a link that is gone ends. Safe to call at any time.
func refresh() -> void:
	if _stopped:
		return
	_load()
	_end_stale_handshakes()
	_advertise(PKeyPeerAdvert.advert_epoch(_now()))
	_names_for(PKeyPeerAdvert.advert_epoch(_now()))
	_push_accepted()


## Close every session under link `id` (all when empty) with `code`.
func end_sessions(code: StringName, id := "") -> void:
	for s: PKeyConnectSession in _sessions.values():
		if id == "" or str(s.local.get("id", "")) == id:
			s.close(code)


## Dial the other device of link `id`, found by its `m=l` advert, and run mode l. ok with a PKeyConnectSession whose
## `local` names the link, or a LAN failure: `not_listening`, `unknown_peer` (not held, or not seen), `connect_failed`,
## `handshake_failed`. A coroutine.
func connect_local(id: String) -> PKeyResult:
	if _stopped:
		return PKeyConnectErrors.lan("not_listening", "The LAN service is stopped.")
	var index := _find(id)
	var peer: Dictionary = (_peers.get(id, {}) as Dictionary).duplicate(true)
	var native := bool(peer.get("native", false))
	var hosts: Array = []
	for h in peer.get("hosts", []):
		if h is String and _gate.dialable(h):
			hosts.append(h)
	if index < 0 or peer.is_empty() or (hosts.is_empty() and not native):
		return PKeyConnectErrors.lan("unknown_peer", "That link was not found on this network.")
	var row: Dictionary = (_locals[index] as Dictionary).duplicate()
	var failure: PKeyResult = PKeyConnectErrors.lan("handshake_failed", "The handshake failed.")
	var left: Array = hosts
	while not _stopped:
		var pipe: PKeyPeerPipe = null
		var host := ""
		if native:
			pipe = await _gate.open_native(
				_mdns, str(peer["instance"]), Callable(self, "is_stopped")
			)
		elif not left.is_empty():
			var won := await _gate.race(
				left, int(peer.get("port", 0)), Callable(self, "is_stopped")
			)
			pipe = won.get("pipe")
			host = str(won.get("host", ""))
		if pipe == null:
			failure = PKeyConnectErrors.lan("connect_failed", "The device did not answer.")
			break
		var one := await _handshake(pipe, row, host)
		if one.has("session"):
			return PKeyResult.success(one["session"])
		failure = one["error"]
		# A neighbour can answer first with its own address: the race runs again over the addresses left.
		if native or host == "":
			break
		left = left.filter(func(h: String) -> bool: return h != host)
	return failure


## Stop: sessions are closed with a goodbye, the adverts say goodbye, the listener closes and the secrets are zeroed.
func stop() -> void:
	if _stopped:
		return
	_stopped = true
	_timer_gen += 1
	_frames(false)
	for pid: int in _pending.keys():
		var gone: PKeyConnectLan.Pending = _pending[pid]
		_release(gone)
		gone.link.destroy()
	_pending = {}
	for s: PKeyConnectSession in _sessions.values():
		s.close()
	_sessions = {}
	_stop_adverts()
	if _browse != null:
		_browse.call("stop")
		_browse = null
	if _server != null:
		_server.stop()
		_server = null
	if _native and _mdns != null:
		_mdns.call("set_acceptor", "l", Callable())
	_peers = {}
	_names = {}
	_wipe(_locals)
	_locals = []


# -- start ----------------------------------------------------------------------------------------


func _start() -> PKeyResult:
	_load()
	# An OS lane (the Apple one) listens itself and hands over the accepted sockets (slot l); otherwise this does.
	_native = _mdns.has_method("set_acceptor")
	if _native:
		_mdns.call("set_acceptor", "l", Callable(self, "_accept_native"))
	else:
		var listened := PKeyPeerLanGate.listen(str(_o.get("host", "")), int(_o.get("port", 0)))
		if not listened.ok:
			return listened
		_server = listened.detail
		_port = _server.get_local_port()
	_frames(true)
	var epoch := PKeyPeerAdvert.advert_epoch(_now())
	if bool(_o.get("advertise", true)):
		_advertise(epoch)
		_after_epoch(epoch)
	_names_for(epoch)
	if bool(_o.get("browse", true)):
		var b: PKeyResult = _mdns.browse(
			Callable(self, "_found"), Callable(self, "_gone"), Callable(self, "_accepts")
		)
		if not b.ok:
			return b
		_browse = b.detail
		_push_accepted()
	return PKeyResult.success()


# -- the held links -------------------------------------------------------------------------------


func _load() -> void:
	var fn: Callable = _o["locals"]
	var next: Array = fn.call() if fn.is_valid() else []
	if not _allowed():
		_wipe(next)
		next = []
	var old := _locals
	_locals = next
	_wipe(old)
	_names_epoch = -1
	var have := {}
	for l: Dictionary in _locals:
		have[l["id"]] = true
	for id: String in _peers.keys():
		if not have.has(id):
			_peers.erase(id)
	_miss = {}


func _allowed() -> bool:
	var fn: Variant = _o.get("allowed")
	return not (fn is Callable and (fn as Callable).is_valid()) or bool((fn as Callable).call())


static func _wipe(rows: Array) -> void:
	PKeyConnectLocalState.wipe_live(rows)
	for l in rows:
		if l is Dictionary and (l as Dictionary).get("secret") is PackedByteArray:
			((l as Dictionary)["secret"] as PackedByteArray).fill(0)


func _find(id: String) -> int:
	for i in _locals.size():
		if _locals[i]["id"] == id:
			return i
	return -1


## A handshake still running under a link that is gone, replaced or switched off is ended: it must not open a session.
func _end_stale_handshakes() -> void:
	for pid: int in _pending.keys():
		var p: PKeyConnectLan.Pending = _pending[pid]
		for ref: Dictionary in p.attachment.locals:
			if not _holds(str(ref["id"]), str(ref["tag"])):
				_release(p)
				p.link.destroy()
				break


## Whether link `id` is held now with the secret `tag` names.
func _holds(id: String, tag: String) -> bool:
	for l: Dictionary in _locals:
		if l["id"] == id and l["tag"] == tag:
			return true
	return false


# -- adverts and browse ---------------------------------------------------------------------------


## Bring the live adverts to the reachable links (at most 8) for `epoch`. A lane that cannot take an `m=l` advert
## refuses it; the service stands without it.
func _advertise(epoch: int) -> void:
	if not bool(_o.get("advertise", true)) or _stopped:
		return
	var want: Array = []
	for l: Dictionary in _locals:
		if want.size() < PKeyPeerLocal.MAX_LIVE_LOCAL_ADVERTS and bool(l["reachable"]):
			var name := PKeyPeerLocal.local_instance(l["secret"], l["own_public"], epoch)
			if name != "" and not want.has(name):
				want.append(name)
	for name: String in _adverts.keys():
		if not want.has(name):
			(_adverts[name] as Object).call("stop")
			_adverts.erase(name)
	for name: String in want:
		if _adverts.has(name):
			continue
		var made: PKeyResult = _mdns.advertise(
			{"instance": name, "port": _port, "txt": ["v=1", "m=l"], "slot": "l"}
		)
		if made.ok:
			_adverts[name] = made.detail


func _stop_adverts() -> void:
	for h: Object in _adverts.values():
		h.call("stop")
	_adverts = {}


func _after_epoch(epoch: int) -> void:
	var seconds := float(maxi(1, (epoch + 1) * PKeyPeerAdvert.ADVERT_EPOCH_SECONDS - _now()))
	var guarded := Callable(self, "_epoch_fire").bind(_timer_gen)
	var timer: Variant = _o.get("timer")
	if timer is Callable and (timer as Callable).is_valid():
		(timer as Callable).call(seconds, guarded)
	elif _tree != null:
		_tree.create_timer(maxf(0.05, seconds)).timeout.connect(guarded)


func _epoch_fire(gen: int) -> void:
	if gen != _timer_gen or _stopped:
		return
	refresh()
	_after_epoch(PKeyPeerAdvert.advert_epoch(_now()))


## The names the peers of the first 32 links can announce in `epoch` and the one before.
func _names_for(epoch: int) -> void:
	_names = {}
	for i in mini(_locals.size(), PKeyPeerLocal.MAX_LOCAL_LINKS):
		var l: Dictionary = _locals[i]
		for back in 2:
			if epoch - back < 0:
				continue
			var name := PKeyPeerLocal.local_instance(l["secret"], l["peer_key"], epoch - back)
			if name != "" and not _names.has(name):
				_names[name] = i
	_names_epoch = epoch


## The adapter's roster filter. When the epoch has moved the names are worked out again first.
func _accepts(instance: String) -> bool:
	var epoch := PKeyPeerAdvert.advert_epoch(_now())
	if _names_epoch != epoch:
		_names_for(epoch)
	return _names.has(instance)


func _push_accepted() -> void:
	if _mdns != null and _mdns.has_method("set_accepted") and _browse != null:
		var target: Object = _browse if _browse.has_method("set_accepted") else _mdns
		target.call("set_accepted", _names.keys())


func _found(f: Dictionary) -> void:
	var hosts: Array = []
	for h in f.get("hosts", [f.get("host", "")]):
		if h is String and _gate.dialable(h) and not hosts.has(h):
			hosts.append(h)
	var native := bool(f.get("native", false))
	if (
		_stopped
		or (hosts.is_empty() and not native)
		or not PKeyPeerLocal.parse_local_txt(f.get("txt", []))["ok"]
	):
		return
	var instance := str(f["instance"])
	if _miss.has(instance) or _locals.is_empty():
		return
	if _names_epoch != PKeyPeerAdvert.advert_epoch(_now()):
		_names_for(PKeyPeerAdvert.advert_epoch(_now()))
	var index: Variant = _names.get(instance)
	if index == null or int(index) >= _locals.size():
		# Bounded negative cache: a forged instance is not worked out twice.
		if _miss.size() >= MISS_CACHE:
			_miss.erase(_miss.keys()[0])
		_miss[instance] = _now()
		return
	var id: String = _locals[int(index)]["id"]
	var had := _peers.has(id)
	_peers[id] = {
		"id": id,
		"instance": instance,
		"hosts": hosts,
		"port": int(f.get("port", 0)),
		"native": native
	}
	if not had:
		sighted.emit(id)


func _gone(instance: String) -> void:
	for id: String in _peers.keys():
		if _peers[id]["instance"] == instance:
			_peers.erase(id)


# -- TCP ------------------------------------------------------------------------------------------


func _frames(on: bool) -> void:
	if _tree == null or on == _framed:
		return
	_framed = on
	if on:
		_tree.process_frame.connect(_tick)
	elif _tree.process_frame.is_connected(_tick):
		_tree.process_frame.disconnect(_tick)


func _tick() -> void:
	if _stopped:
		return
	_gate.drain(_server, Callable(self, "_admit"))
	var window := float(_o.get("handshake_seconds", HANDSHAKE_SECONDS))
	var now := _mono()
	for pid: int in _pending.keys():
		var p: PKeyConnectLan.Pending = _pending[pid]
		if now - p.at >= window:
			_release(p)
			p.link.destroy()


func _admit(peer: StreamPeerTCP) -> void:
	# With no link to try (or the gate off) a connection is closed before a byte is read.
	var slot := _gate.admit(
		peer, _stopped or _sessions.size() >= MAX_SESSIONS or _locals.is_empty() or not _allowed()
	)
	if slot == null:
		return
	var pipe := PKeyPeerTcpPipe.from_peer(peer)
	if pipe == null:
		slot.settle()
		return
	_accept(pipe, Callable(slot, "settle"), PKeyLanAddress.group_key(slot.address))


## An inbound socket of the OS lane (slot l): the OS side judged the source and holds the unadmitted limits. With no
## link to try (or the gate off) it is closed before a byte is read.
func _accept_native(pipe: PKeyPeerPipe) -> void:
	if _stopped or _sessions.size() >= MAX_SESSIONS or _locals.is_empty() or not _allowed():
		pipe.abort()
		return
	_accept(pipe, Callable(), PKeyLanAddress.group_key(pipe.remote_address()))


func _accept(pipe: PKeyPeerPipe, release: Callable, group: Variant) -> void:
	var made := _make_link(pipe, "responder", {}, group if group is String else "")
	if made.is_empty():
		if release.is_valid():
			release.call()
		pipe.abort()
		return
	var p := PKeyConnectLan.Pending.new()
	p.link = made["link"]
	p.attachment = made["attachment"]
	p.release = release
	p.pipe = pipe
	p.at = _mono()
	_pending[p.get_instance_id()] = p
	p.attachment.opened.connect(_on_inbound.bind(p.get_instance_id()))
	p.link.closed.connect(_on_pending_closed.bind(p.get_instance_id()))


func _release(p: PKeyConnectLan.Pending) -> void:
	_pending.erase(p.get_instance_id())
	if p.release.is_valid():
		p.release.call()
		p.release = Callable()


func _on_pending_closed(_code: StringName, _by_peer: bool, pid: int) -> void:
	if _pending.has(pid):
		_release(_pending[pid])


func _on_inbound(session: PKeyConnectSession, pid: int) -> void:
	if _pending.has(pid):
		var admitted: PKeyConnectLan.Pending = _pending[pid]
		if admitted.pipe != null and admitted.pipe.has_method("admit"):
			admitted.pipe.call("admit")
		_release(admitted)
	if _stopped or _count(str(session.local.get("id", ""))) >= MAX_SESSIONS_PER_LINK:
		session.close(PKeyPeerSession.PEER_BUSY)
		return
	# The handshake may have begun before the link was forgotten or the gate went off.
	if not _held(session):
		return
	_track(session)
	session_opened.emit(session)


## Close `session` unless its link is still held with the same secret and the gate is on. False when it was closed.
func _held(session: PKeyConnectSession) -> bool:
	if _allowed() and _holds(str(session.local.get("id", "")), session.local_tag):
		return true
	session.close(PKeyPeerSession.PEER_REVOKED if _allowed() else PKeyPeerSession.PEER_BYE)
	return false


func _count(id: String) -> int:
	var n := 0
	for s: PKeyConnectSession in _sessions.values():
		if str(s.local.get("id", "")) == id:
			n += 1
	return n


func _track(session: PKeyConnectSession) -> void:
	_sessions[session.get_instance_id()] = session
	session.closed.connect(_on_session_closed.bind(session.get_instance_id()))


func _on_session_closed(_code: StringName, _by_peer: bool, sid: int) -> void:
	_sessions.erase(sid)


## A link and its attachment for `pipe`: {link, attachment}, or {} when the options are refused. An initiator dials the
## one link in `row`; a responder serves every held link, in held order.
func _make_link(pipe: PKeyPeerPipe, role: String, row: Dictionary, group := "") -> Dictionary:
	var served: Array = [row] if not row.is_empty() else _locals
	var held: Array = []
	var refs: Array = []
	for l: Dictionary in served:
		held.append(
			{
				"secret": (l["secret"] as PackedByteArray).duplicate(),
				"own_key": (l["own_key"] as PackedByteArray).duplicate(),
				"peer_key": (l["peer_key"] as PackedByteArray).duplicate()
			}
		)
		refs.append(
			{"id": l["id"], "tag": l["tag"], "label": l.get("label"), "categories": l["cats"]}
		)
	var slug := str(_o["slug"])
	var so := {
		"mode": "l",
		"role": role,
		"slug": slug,
		"caps": _o.get("caps", ["app/1"]),
		"locals": held,
		"hello": PKeyConnectLocalCommon.hello(slug, str(_o.get("label", ""))),
		"now": _o["now"],
		"mono": Callable(self, "_mono"),
	}
	if role == "responder":
		so["admission"] = _limiter
		if group != "":
			so["admission_group"] = group
	for k in ["rekey_messages", "rekey_seconds"]:
		if _o.has(k):
			so[k] = _o[k]
	var seconds := float(_o.get("handshake_seconds", HANDSHAKE_SECONDS))
	var lr := PKeyPeerLink.create(pipe, so, {"pump": _pump, "handshake_ms": int(seconds * 1000.0)})
	# The session holds its own copies of the secrets.
	for h: Dictionary in held:
		(h["secret"] as PackedByteArray).fill(0)
		(h["own_key"] as PackedByteArray).fill(0)
	if not lr.ok:
		return {}
	var link: PKeyPeerLink = lr.detail
	var att := PKeyConnectChannel.attach(
		link, null, role, pipe.remote_address(), "lan", _budget, _o.get("xfer", Callable())
	)
	att.locals = refs
	_links[link.get_instance_id()] = link
	link.closed.connect(_on_link_closed.bind(link.get_instance_id(), att))
	_pump.add(link)
	return {"link": link, "attachment": att}


func _on_link_closed(
	_code: StringName, _by_peer: bool, lid: int, _att: PKeyConnectChannel.Attachment
) -> void:
	_links.erase(lid)


## Link `pipe` as the initiator and wait for the session: {session}, or {error, host}.
func _handshake(pipe: PKeyPeerPipe, row: Dictionary, host: String) -> Dictionary:
	var made := _make_link(pipe, "initiator", row)
	if made.is_empty():
		pipe.abort()
		return {
			"error": PKeyConnectErrors.lan("handshake_failed", "The handshake failed."),
			"host": host
		}
	var link: PKeyPeerLink = made["link"]
	var att: PKeyConnectChannel.Attachment = made["attachment"]
	link.start()
	var opened: PKeyResult = await att.wait_opened()
	if opened.ok:
		# Resumed from inside the session's own step: hand the caller a clean stack.
		await _tree.process_frame
	if not opened.ok:
		link.destroy()
		# A socket that was reset before the peer admitted us is an address that did not answer.
		if (opened.detail as Dictionary).get("close_code") == PKeyPeerLink.CONNECTION_LOST:
			opened = PKeyConnectErrors.lan("connect_failed", "The device did not answer.")
		return {"error": opened, "host": host}
	var session: PKeyConnectSession = opened.detail
	if session.is_closed():
		link.destroy()
		return {
			"error":
			PKeyConnectErrors.lan(
				"handshake_failed", "The session closed before it could be used."
			),
			"host": host
		}
	# The link may have been removed, or the gate cleared, while the handshake ran.
	if not _held(session):
		return {
			"error": PKeyConnectErrors.lan("unknown_peer", "That link was removed."), "host": ""
		}
	_track(session)
	return {"session": session}


# -- wiring ---------------------------------------------------------------------------------------


func _loopback() -> bool:
	return bool(_o.get("allow_loopback", false))


func _now() -> int:
	return int((_o["now"] as Callable).call())


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return (
		float((clock as Callable).call())
		if clock is Callable and (clock as Callable).is_valid()
		else float(Time.get_ticks_msec()) / 1000.0
	)
