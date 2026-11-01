@tool
class_name PKeyConnectLan
extends RefCounted
## The LAN half of Cloud Connect (CC-14.12; WIRE-CONTRACT-V5 sections 15.4 to 15.6): advertise this
## device under the account instance name, browse for the person's other devices, listen on TCP and
## dial. Ported from sdk-node `connect/lan.ts` and the Python `connect/lan.py`, on the mDNS adapter
## `PKeyMdns`, the TCP pipe `PKeyPeerTcpPipe` and the pump `PKeyPeerPump`. Everything runs on the main
## thread, driven by `SceneTree.process_frame`; the only work off it is the pump's Noise tasks.
##
## Rules this file keeps:
##  - the advert is `p1-` plus HMAC(K_disc, epoch, deviceId) with TXT `v=1`, `m=a` and nothing else;
##    it is renewed at every 15-minute epoch boundary and when K_disc changes, and uses only the newest
##    key (G4);
##  - a browse hit is kept only if it names a roster device other than this one under the current or
##    previous epoch and either delivered key; everything else is dropped before it enters the
##    adapter's tables, and a name that did not match is not worked out twice;
##  - the listener starts a handshake only while this device holds a verified identity. The
##    handshake (XXpsk0) and admission run in the session engine; a failed tag closes the socket
##    without a word (G2);
##  - sockets that have not been admitted are bounded: 32 in total, 4 per source address and 16 per
##    group (the /24, the /64 or the link), each for at most 30 seconds, handshake frames at most 16 KiB
##    (G7);
##  - an address is allowed by `PKeyLanAddress.verdict` (V5 section 15.4.1). Godot sockets expose
##    neither their own address nor a zone, so `local` is unknown (D-6): an accepted socket is judged on
##    its peer address alone, before it takes a slot and before a byte is read; a global IPv6 address is
##    refused and a ULA one is judged on itself; a dial uses learned IPv4 and ULA addresses and skips
##    link-local ones, which need a zone. Loopback only when `allow_loopback` is set (tests, same-host);
##  - the certificate's device must be the one dialled, or the session is closed and the dial fails
##    `wrong_peer` (G8);
##  - several learned addresses are raced in first-seen order, at most two attempts in flight, a new one
##    every 250 ms (at once when one fails); the first connection that passes the verdict wins and any
##    other connected socket closes before a byte is sent on it;
##  - one listener serves both families (`TCPServer.listen(port, "*")`, dual-stack), on a random port
##    unless `port` is given;
##  - the device's X25519 private key never leaves the key store (G1): sessions get the PeerSource's key
##    port, whose `dh` calls the store;
##  - nothing here puts a key, K_disc or certificate in a `str()`, a notice or a result (G19).
##
## Use. `PKeyConnectLan.start(source, options)` answers a PKeyResult holding the running service, or the
## first failure (`no_identity`, `no_keys`, `not_listening`, or the adapter's `mdns_unavailable`).
## `dial(target)` is a coroutine. Signals: `peer_found`, `peer_lost`, `session_opened` (an inbound session,
## once admitted) and `notice` (a pushed RING or TRUST, once stored, applied or refused).

## A roster device seen on the network: {device_id, host, hosts, port}.
signal peer_found(peer: Dictionary)
signal peer_lost(device_id: String)
## An inbound session, once it is open and admitted.
signal session_opened(session: PKeyConnectSession)
signal notice(n: Dictionary)

const MAX_PENDING := 32
const MAX_PENDING_PER_ADDRESS := 4
const MAX_PENDING_PER_GROUP := 16
const MAX_SESSIONS := 64
const MAX_SESSIONS_PER_PEER := 4
const HANDSHAKE_SECONDS := 30.0
const DIAL_SECONDS := 10.0
const DIAL_STAGGER_SECONDS := 0.25
const DIAL_MAX_IN_FLIGHT := 2
const ACCEPTS_PER_FRAME := 8
const IDENTITY_TTL_S := 30
const CERT_MARGIN_S := 60
const MISS_CACHE := 1024
const MAX_BROWSE_ROSTER := 128

var _src: Source
var _o: Dictionary
var _tree: SceneTree
var _pump: PKeyPeerPump
var _mdns: Object
var _budget: PKeyConnectSession.Budget
var _docs: PKeyConnectChannel.Docs
var _gate: PKeyPeerLanGate
var _server: TCPServer
var _port := 0
var _adv: Object
var _adv_name := ""
var _browse: Object
var _timer_gen := 0
var _id: Variant = null
var _names: Dictionary = {}
var _names_sig := ""
var _names_epoch := -1
var _peers: Dictionary = {}
var _miss: Dictionary = {}
## Sockets accepted and not yet admitted, sessions and links, each by instance id: a signal connection
## binds the id, never the object, so a connection does not keep its own emitter alive.
var _pending: Dictionary = {}
var _sessions: Dictionary = {}
var _links: Dictionary = {}
## The attachment of each link, by the link's instance id: it is what routes a link's records to its
## session, so it lives as long as the link does.
var _attached: Dictionary = {}
var _stopped := false
var _listening_frames := false


## What the LAN service needs of the client. Each is a Callable: `load` () -> PKeyResult holding a
## PeerSource (sync); `now` () -> epoch seconds; `refresh` () -> a coroutine answering a PKeyResult, the
## identity fetch; `adopt_ring` (jws) -> {stored, epoch | reason}; `apply_trust` (jws) -> a coroutine
## answering {applied | reason}. `refresh`, `adopt_ring` and `apply_trust` may be empty: the document
## is then refused `unsupported`.
class Source extends RefCounted:
	var load: Callable
	var now: Callable
	var refresh: Callable
	var adopt_ring: Callable
	var apply_trust: Callable
	## What the Callables belong to, held so that they stay valid (a Callable keeps no reference).
	var keep: RefCounted


	func _to_string() -> String:
		return "PKeyConnectLan.Source()"


## The source over a `PKeyConnectClient`. `apply_trust` is the host's trust custodian (optional).
static func source_of(client: PKeyConnectClient, apply_trust := Callable()) -> Source:
	var s := Source.new()
	s.keep = client
	s.load = Callable(client, "peer_source")
	s.now = Callable(PKeyClaims, "system_now")
	s.refresh = Callable(client, "identity").bind(true)
	s.adopt_ring = Callable(client, "adopt_ring")
	s.apply_trust = apply_trust
	return s


## Listen, then advertise and browse. ok with the service. `options`: `mdns` (a PKeyMdns, or anything
## with `advertise` and `browse`), `host` ("" or "*": dual-stack; or one address), `port` (0: random),
## `caps`, `label`, `advertise`, `browse` (true), `allow_loopback` (tests and same-host peers only),
## `interfaces` (names or addresses for the default adapter), `max_pending`, `max_pending_per_address`,
## `max_pending_per_group`, `max_sessions`, `max_sessions_per_peer`, `rekey_messages`, `rekey_seconds`,
## `handshake_seconds`, `dial_seconds`, `dial_stagger`, `connector` (Callable(host, port) -> an attempt, a
## test seam), `timer` (Callable(seconds, fn)), `mono` (Callable() -> monotonic seconds), `pump`, `tree`,
## `budget`.
static func start(source: Source, options := {}) -> PKeyResult:
	if source == null or not source.load.is_valid() or not source.now.is_valid():
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "LAN: bad source.")
	var s := PKeyConnectLan.new(source, options)
	var r := s._start()
	if not r.ok:
		s.stop()
		return r
	return PKeyResult.success(s)


func _init(source: Source, options := {}) -> void:
	_src = source
	_o = options
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	_pump = options.get("pump", null) as PKeyPeerPump
	if _pump == null:
		_pump = PKeyPeerPump.new(_tree)
	_mdns = options.get("mdns", null) as Object
	if _mdns == null:
		_mdns = PKeyMdns.new({"allow_loopback": _loopback(), "only": options.get("interfaces", []), "tree": _tree})
	_budget = options.get("budget", null) as PKeyConnectSession.Budget
	# The gate reads the same options Dictionary (a test moves `dial_stagger` after the start).
	_gate = PKeyPeerLanGate.new(options)
	_docs = PKeyConnectChannel.Docs.new({
		"adopt_ring": source.adopt_ring, "apply_trust": source.apply_trust, "refresh": source.refresh,
		"mono": Callable(self, "_mono"),
	}, Callable(self, "_stored"), Callable(self, "_after"))
	_docs.notice.connect(Callable(self, "_on_notice"))


func _to_string() -> String:
	return "PKeyConnectLan(port=%d)" % _port


func _on_notice(n: Dictionary) -> void:
	notice.emit(n)


# ── the surface ──────────────────────────────────────────────────────────────────────────────


## The TCP port this listen uses.
## The discovery lane this service runs on (shared with nearby approval).
func lane() -> Object:
	return _mdns


func port() -> int:
	return _port


func is_stopped() -> bool:
	return _stopped


## Roster devices seen on the network right now: [{device_id, host, hosts, port}].
func peers() -> Array:
	var out: Array = []
	for id: String in _peers:
		out.append((_peers[id]["peer"] as Dictionary).duplicate(true))
	return out


## Sockets that have been accepted and not yet admitted (a test reads it).
func pending_count() -> int:
	return _pending.size()


## Sessions that are open now, both ways.
func session_count() -> int:
	return _sessions.size()


## {port, advertising, browsing, mdns} (no key, no address).
func status() -> Dictionary:
	return {"port": _port, "advertising": _adv != null, "browsing": _browse != null, "mdns": _mdns.call("status") if _mdns != null and _mdns.has_method("status") else {}}


## Dial a discovered device (a device id, or a peer Dictionary as `peers()` lists) and run the
## handshake. ok with a PKeyConnectSession, or a LAN failure: `not_listening`, `unknown_peer`,
## `connect_failed`, `handshake_failed`, `wrong_peer`. A coroutine.
func dial(target: Variant) -> PKeyResult:
	if _stopped:
		return PKeyConnectErrors.lan("not_listening", "The LAN service is stopped.")
	var want := ""
	var peer: Dictionary = {}
	if target is String:
		want = target
		if _peers.has(want):
			peer = (_peers[want]["peer"] as Dictionary).duplicate(true)
	elif target is Dictionary:
		peer = (target as Dictionary).duplicate(true)
		want = str(peer.get("device_id", ""))
	if bool(peer.get("native", false)) and want != "":
		return await PKeyConnectLanNative.dial(self, peer, want)
	return await _dial_hosts(peer, want)


## Dial a peer by its learned addresses: race them, and run the handshake with the winner.
func _dial_hosts(peer: Dictionary, want: String) -> PKeyResult:
	var hosts: Array = []
	if not peer.is_empty():
		var all: Array = [peer.get("host", "")]
		all.append_array(peer.get("hosts", []))
		for h in all:
			if h is String and h != "" and not hosts.has(h) and _dialable(h):
				hosts.append(h)
	if peer.is_empty() or hosts.is_empty() or want == "":
		return PKeyConnectErrors.lan("unknown_peer", "That device was not found on this network.")
	var idr := _identity(false)
	if not idr.ok:
		return idr
	var ident: PKeyConnectClient.PeerSource = idr.detail
	# A neighbour can answer first with its own address (S4): when the winner of the race fails the
	# handshake, the race runs again over the addresses left, so the real device is still reached.
	var left: Array = hosts
	var failure: PKeyResult = null
	var session: PKeyConnectSession = null
	while not left.is_empty() and session == null and not _stopped:
		var one := await _dial_once(left, int(peer.get("port", 0)), ident)
		if one.has("session"):
			session = one["session"]
			break
		failure = one["error"]
		var failed: String = one.get("host", "")
		if failed == "":
			break  # nothing connected: there is no address left to try
		left = left.filter(func(h: String) -> bool: return h != failed)
	if session == null:
		return failure if failure != null else PKeyConnectErrors.lan("handshake_failed", "The handshake failed.")
	if session.peer_device_id != want:
		session.close()
		return PKeyConnectErrors.lan("wrong_peer", "The device that answered is not the one that advertised.")
	return PKeyResult.success(session)


## Stop: sessions are closed with a goodbye (the pump delivers it), the advert says goodbye, the
## listener closes.
func stop() -> void:
	if _stopped:
		return
	_stopped = true
	_shutdown(true)
	_forget()


## Stop at once: no goodbyes, nothing waited on, the held identity dropped (the sign-out bound's
## force path).
func abort() -> void:
	if _stopped:
		return
	_stopped = true
	_shutdown(false)
	_forget()


## Let go of the held identity and of every name worked out from K_disc (R-6G2 N3).
func _forget() -> void:
	_id = null
	_names = {}
	_names_sig = ""
	_names_epoch = -1


# ── start ────────────────────────────────────────────────────────────────────────────────────


func _start() -> PKeyResult:
	var idr := _identity(true)
	if not idr.ok:
		return idr
	var listened := _listen()
	if not listened.ok:
		return listened
	_frames(true)
	if _mdns.has_method("set_acceptor"):
		_mdns.call("set_acceptor", Callable(self, "_admit_native"))
	if bool(_o.get("advertise", true)):
		var r := _rotate()
		if not r.ok:
			return r
	if bool(_o.get("browse", true)):
		var b: PKeyResult = _mdns.browse(Callable(self, "_found"), Callable(self, "_gone"), Callable(self, "_accepts"))
		if not b.ok:
			return b
		_browse = b.detail
		_push_accepted()
	return PKeyResult.success()


func _shutdown(graceful: bool) -> void:
	_timer_gen += 1
	_docs.close()
	_frames(false)
	for pid: int in _pending.keys():
		var gone: Pending = _pending[pid]
		_release(gone)
		gone.link.destroy()
	_pending = {}
	for sid: int in _sessions.keys():
		if graceful:
			(_sessions[sid] as PKeyConnectSession).close()
	if not graceful:
		for lid: int in _links.keys():
			(_links[lid] as PKeyPeerLink).destroy()
	_sessions = {}
	if not graceful:
		_attached = {}
	if _adv != null:
		_adv.stop()
		_adv = null
	if _browse != null:
		_browse.stop()
		_browse = null
	if _mdns != null and _mdns.has_method("set_acceptor"):
		_mdns.call("set_acceptor", Callable())
		if not graceful and _mdns.has_method("close_pipes"):
			_mdns.call("close_pipes")
	if _server != null:
		_server.stop()
		_server = null
	_peers = {}


func _loopback() -> bool:
	return bool(_o.get("allow_loopback", false))


func _now() -> int:
	return int(_src.now.call())


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return float((clock as Callable).call()) if clock is Callable and (clock as Callable).is_valid() else float(Time.get_ticks_msec()) / 1000.0


## Call `fn` once, `seconds` from now. A stop cancels what is waiting (by generation).
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


# ── identity ─────────────────────────────────────────────────────────────────────────────────


## The held identity, re-read at most every IDENTITY_TTL_S and when its certificate nears its end.
## ok with a PeerSource, or the source's own failure (`no_identity`, `no_keys`).
func _identity(force: bool) -> PKeyResult:
	var now := _now()
	if not force and _id != null:
		var held: Dictionary = _id
		var v: PKeyConnectClient.PeerSource = held["v"]
		if now - int(held["at"]) < IDENTITY_TTL_S and v.certificate_expires_at - now > CERT_MARGIN_S:
			return PKeyResult.success(v)
	var r: PKeyResult = _src.load.call()
	if not r.ok or not r.detail is PKeyConnectClient.PeerSource:
		return r if not r.ok else PKeyConnectErrors.lan("no_identity", "No Cloud Connect identity is held.")
	var fresh: PKeyConnectClient.PeerSource = r.detail
	if _id != null and (_id["v"] as PKeyConnectClient.PeerSource).ring_epoch != fresh.ring_epoch:
		_miss = {}
	_id = {"at": now, "v": fresh}
	_refresh_names(fresh)
	var pushed: Variant = _docs.pushed
	if pushed is Dictionary and int((pushed as Dictionary)["epoch"]) <= fresh.ring_epoch:
		_docs.pushed = null
	return PKeyResult.success(fresh)


func _pushed() -> Variant:
	return _docs.pushed


## The instance names the roster can announce now (both delivered keys, this and the last epoch), worked
## out again when the epoch, the keys or the roster change: a forged name is an O(1) miss, not up to 512
## HMACs.
func _refresh_names(v: PKeyConnectClient.PeerSource) -> void:
	var epoch := PKeyPeerAdvert.advert_epoch(_now())
	# A digest, not the keys' hex: a String cannot be wiped, so none holds K_disc for the service's life.
	var material := PackedByteArray()
	material.append_array(("%d|" % epoch).to_utf8_buffer())
	material.append_array(v.disc_current)
	material.append_array("|".to_utf8_buffer())
	material.append_array(v.disc_previous)
	material.append_array(("|" + ",".join(PackedStringArray(v.roster))).to_utf8_buffer())
	var sig := PKeySyncHkdf.sha256(material).hex_encode()
	if sig == _names_sig:
		return
	var keys: Array = [v.disc_current]
	if not v.disc_previous.is_empty():
		keys.append(v.disc_previous)
	var names := {}
	for back in 2:
		for k: PackedByteArray in keys:
			for d: String in v.roster.slice(0, MAX_BROWSE_ROSTER):
				if d != v.device_id:
					names[PKeyPeerAdvert.account_instance(k, epoch - back, d)] = d
	_names = names
	_names_sig = sig
	_names_epoch = epoch


## The adapter's roster filter. When the epoch has moved the names are worked out again first.
func _accepts(instance: String) -> bool:
	if _id != null and _names_epoch != PKeyPeerAdvert.advert_epoch(_now()):
		_refresh_names((_id as Dictionary)["v"])
	return _names.has(instance)


## An adapter that filters natively (`set_accepted`, the Apple lane) is told the instance names to report.
func _push_accepted() -> void:
	if _mdns == null or not _mdns.has_method("set_accepted"):
		return
	var idr := _identity(false)
	if idr.ok:
		_refresh_names(idr.detail)
		_mdns.call("set_accepted", _names.keys())


## K_disc or the roster was stored (a pushed RING, or a refresh): the next read reloads, and the
## advert follows a new K_disc inside the epoch.
func _stored() -> void:
	_id = null
	if not _stopped and _adv != null:
		_rotate()
	if not _stopped and _browse != null:
		_push_accepted()


# ── mDNS ─────────────────────────────────────────────────────────────────────────────────────


## Advertise under the current epoch and the newest key; set the timer for the next boundary.
func _rotate() -> PKeyResult:
	if _stopped:
		return PKeyResult.success()
	var idr := _identity(true)
	if not idr.ok:
		return idr
	var v: PKeyConnectClient.PeerSource = idr.detail
	var now := _now()
	var epoch := PKeyPeerAdvert.advert_epoch(now)
	var name := PKeyPeerAdvert.account_instance(v.disc_current, epoch, v.device_id)
	if name != _adv_name:
		var old: Object = _adv
		var made: PKeyResult = _mdns.advertise({"instance": name, "port": _port, "txt": ["v=1", "m=a"]})
		if not made.ok:
			return made
		_adv = made.detail
		_adv_name = name
		if old != null:
			old.stop()
	if _browse != null:
		_push_accepted()
	var next := (epoch + 1) * PKeyPeerAdvert.ADVERT_EPOCH_SECONDS - now
	_after(float(maxi(1, next)), Callable(self, "_rotate_later"))
	return PKeyResult.success()


func _rotate_later() -> void:
	_rotate()


func _found(f: Dictionary) -> void:
	# Keep the addresses that could be dialled; the connected socket is judged again.
	var hosts: Array = []
	for h in f.get("hosts", [f.get("host", "")]):
		if h is String and _dialable(h) and not hosts.has(h):
			hosts.append(h)
	var native := bool(f.get("native", false))
	if _stopped or (hosts.is_empty() and not native):
		return
	var txt := PKeyPeerAdvert.parse_txt(f.get("txt", []))
	if not txt["ok"] or txt["mode"] != "a":
		return
	var instance := str(f["instance"])
	if _miss.has(instance):
		return
	var idr := _identity(false)
	if not idr.ok:
		return
	if _id != null and _names_epoch != PKeyPeerAdvert.advert_epoch(_now()):
		_refresh_names(idr.detail)
	var device_id: Variant = _names.get(instance)
	if device_id == null:
		# Bounded negative cache: a forged instance is not worked out twice.
		if _miss.size() >= MISS_CACHE:
			_miss.erase(_miss.keys()[0])
		_miss[instance] = _now()
		return
	var peer := {"device_id": device_id, "host": hosts[0] if not hosts.is_empty() else "", "hosts": hosts, "port": int(f["port"])}
	if native:
		# The OS resolves the address: the peer is dialled by its instance name through the adapter.
		peer["native"] = true
		peer["instance"] = instance
	var had: Variant = _peers.get(device_id)
	_peers[device_id] = {"peer": peer, "instance": instance}
	# A new address for a device already known is not a new peer.
	if had == null or int((had["peer"] as Dictionary)["port"]) != peer["port"] or had["instance"] != instance:
		peer_found.emit(peer.duplicate(true))


func _gone(instance: String) -> void:
	for id: String in _peers.keys():
		if _peers[id]["instance"] == instance:
			_peers.erase(id)
			peer_lost.emit(id)


# ── addresses ────────────────────────────────────────────────────────────────────────────────


## May this address text be dialled? (The gate's rule: `PKeyPeerLanGate.dialable`.)
func _dialable(host: String) -> bool:
	return _gate.dialable(host)


## The text to connect to: an IPv4-mapped address connects as its IPv4 address.
static func connect_text(host: String) -> String:
	return PKeyPeerLanGate.connect_text(host)


# ── TCP ──────────────────────────────────────────────────────────────────────────────────────


func _listen() -> PKeyResult:
	var r := PKeyPeerLanGate.listen(str(_o.get("host", "")), int(_o.get("port", 0)))
	if not r.ok:
		return r
	_server = r.detail
	_port = _server.get_local_port()
	return PKeyResult.success()


func _frames(on: bool) -> void:
	if _tree == null or on == _listening_frames:
		return
	_listening_frames = on
	if on:
		_tree.process_frame.connect(_tick)
	elif _tree.process_frame.is_connected(_tick):
		_tree.process_frame.disconnect(_tick)


## Once a frame: take what is waiting on the listener, and end the sockets that have not been
## admitted in time.
func _tick() -> void:
	if _stopped:
		return
	_accept_ready()
	var now := _mono()
	var window := float(_o.get("handshake_seconds", HANDSHAKE_SECONDS))
	for pid: int in _pending.keys():
		var p: Pending = _pending[pid]
		if now - p.at >= window:
			_release(p)
			p.link.destroy()


## Take at most ACCEPTS_PER_FRAME connections a frame, each judged first on its own address, before
## a slot and before any byte is read: a source off the LAN is closed at once and costs nothing.
func _accept_ready() -> void:
	_gate.drain(_server, Callable(self, "_admit"))


func _admit(peer: StreamPeerTCP) -> void:
	var slot := _gate.admit(peer, _stopped or _sessions.size() >= int(_o.get("max_sessions", MAX_SESSIONS)))
	if slot == null:
		return
	var release := Callable(slot, "settle")
	# The identity is read before the first byte is handled; the socket buffers meanwhile.
	var idr := _identity(false)
	if not idr.ok:
		release.call()
		peer.disconnect_from_host()
		return
	var pipe := PKeyPeerTcpPipe.from_peer(peer)
	if pipe == null:
		release.call()
		return
	var made := _make_link(pipe, idr.detail, "responder")
	if made.is_empty():
		release.call()
		pipe.abort()
		return
	var p := Pending.new()
	p.link = made["link"]
	p.attachment = made["attachment"]
	p.release = release
	p.at = _mono()
	_pending[p.get_instance_id()] = p
	p.attachment.opened.connect(_on_inbound.bind(p.get_instance_id()))
	p.link.closed.connect(_on_pending_closed.bind(p.get_instance_id()))


func _on_link_closed(_code: StringName, _by_peer: bool, lid: int) -> void:
	_links.erase(lid)
	_attached.erase(lid)


func _release(p: Pending) -> void:
	_pending.erase(p.get_instance_id())
	if p.release.is_valid():
		p.release.call()
		p.release = Callable()


func _on_pending_closed(_code: StringName, _by_peer: bool, pid: int) -> void:
	if _pending.has(pid):
		_release(_pending[pid])


func _on_inbound(session: PKeyConnectSession, pid: int) -> void:
	if _pending.has(pid):
		var admitted: Pending = _pending[pid]
		if admitted.pipe != null and admitted.pipe.has_method("admit"):
			admitted.pipe.call("admit")
		_release(admitted)
	if _stopped or _count_peer(session.peer_device_id) >= int(_o.get("max_sessions_per_peer", MAX_SESSIONS_PER_PEER)):
		session.close(PKeyPeerSession.PEER_BUSY)
		return
	_track(session)
	session_opened.emit(session)


func _count_peer(device_id: String) -> int:
	var n := 0
	for sid: int in _sessions:
		if (_sessions[sid] as PKeyConnectSession).peer_device_id == device_id:
			n += 1
	return n


func _track(session: PKeyConnectSession) -> void:
	_sessions[session.get_instance_id()] = session
	session.closed.connect(_on_session_closed.bind(session.get_instance_id()))


func _on_session_closed(_code: StringName, _by_peer: bool, sid: int) -> void:
	_sessions.erase(sid)


## A link and its attachment for `pipe`: {link, attachment}, or {} when the options are refused.
func _make_link(pipe: PKeyPeerPipe, src: PKeyConnectClient.PeerSource, role: String) -> Dictionary:
	var so := PKeyConnectChannel.session_options(src, {
		"role": role, "caps": _o.get("caps", ["app/1"]), "label": str(_o.get("label", "")), "ring": Callable(self, "_pushed"),
		"now": _src.now, "mono": Callable(self, "_mono"), "rekey_messages": _o.get("rekey_messages", PKeyPeerSession.DEFAULT_REKEY_MESSAGES),
		"rekey_seconds": _o.get("rekey_seconds", PKeyPeerSession.DEFAULT_REKEY_SECONDS),
	})
	var seconds := float(_o.get("handshake_seconds", HANDSHAKE_SECONDS))
	var lr := PKeyPeerLink.create(pipe, so, {"pump": _pump, "handshake_ms": int(seconds * 1000.0)})
	if not lr.ok:
		return {}
	var link: PKeyPeerLink = lr.detail
	var att := PKeyConnectChannel.attach(link, _docs, role, pipe.remote_address(), "lan", _budget, _o.get("xfer", Callable()))
	_links[link.get_instance_id()] = link
	_attached[link.get_instance_id()] = att
	link.closed.connect(_on_link_closed.bind(link.get_instance_id()))
	_pump.add(link)
	return {"link": link, "attachment": att}


## An inbound native pipe (the Apple lane, CC-14b.5): PKeyConnectLanNative holds the code.
func _admit_native(pipe: PKeyPeerPipe) -> void:
	PKeyConnectLanNative.admit(self, pipe)


# ── dialling ─────────────────────────────────────────────────────────────────────────────────


## Race `hosts`, then handshake with the winner: {session}, or {error, host}: `host` is the winner whose
## handshake failed, "" when no address connected.
func _dial_once(hosts: Array, port: int, ident: PKeyConnectClient.PeerSource) -> Dictionary:
	var won := await _race(hosts, port)
	if not won.has("pipe"):
		return {"error": PKeyConnectErrors.lan("connect_failed", "The device did not answer."), "host": ""}
	return await _handshake(won["pipe"], ident, won["host"])


## Race the addresses through the shared gate (`PKeyPeerLanGate.race`).
func _race(hosts: Array, port: int) -> Dictionary:
	return await _gate.race(hosts, port, Callable(self, "is_stopped"))


## Link `pipe` as the initiator and wait for the session: {session}, or {error, host}.
func _handshake(pipe: PKeyPeerPipe, ident: PKeyConnectClient.PeerSource, host: String) -> Dictionary:
	var made := _make_link(pipe, ident, "initiator")
	if made.is_empty():
		pipe.abort()
		return {"error": PKeyConnectErrors.lan("handshake_failed", "The handshake failed."), "host": host}
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
		# Closed while the caller's stack was being cleaned: not a success (R-6G2 N7).
		link.destroy()
		return {"error": PKeyConnectErrors.lan("handshake_failed", "The session closed before it could be used."), "host": host}
	_track(session)
	return {"session": session}


# ── types ────────────────────────────────────────────────────────────────────────────────────


## An accepted socket that has not been admitted.
class Pending extends RefCounted:
	var link: PKeyPeerLink
	var attachment: PKeyConnectChannel.Attachment
	var release: Callable
	var at := 0.0
	## The native pipe of an inbound socket the OS side counts as unadmitted (null for a TCP socket).
	var pipe: PKeyPeerPipe
