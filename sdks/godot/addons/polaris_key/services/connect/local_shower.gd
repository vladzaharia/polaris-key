@tool
class_name PKeyConnectLocalShower
extends RefCounted
## The shower of a pairing window, `cloud_connect.local_links.pair` (CC-29b.G3; WIRE-CONTRACT-V5 section 15.12, "The
## pairing window"), ported from sdk-node `connect/localShower.ts`: it shows the code and the QR, advertises `m=q` on
## a listener of its own and answers one CPace attempt at a time. The window's accounting is `PKeyPeerLocalWindow`;
## this file wires it:
##  - the session is given the window's `begin_guess` as its required permit, so a guess is counted before its tag is
##    tried, and the session's `guess` event is the verdict (`guess_opened` / `guess_failed`);
##  - `rotated` is told only after the new password, the new QR secret and both generators exist;
##  - the password, the QR secret, the generators, the scalars and the ISK are wiped when the attempt or the window
##    ends (a password is a short string and is dropped, not overwritten);
##  - the nameplate of a window that closes goes into the product's `PKeyPeerLocalMemory`, and the next window's
##    draw skips it for 300 s;
##  - `on_end` is told once per window, after the advert is withdrawn; a window a `renew()` replaces ends silently.
## Everything runs on the main thread, once a frame; the CPace work (the map, the shares, the ISK) goes through the
## pump's offload.

const WAITING := 4
const PER_GROUP := 2

var _src: PKeyConnectLocalCommon.Source
var _o: Dictionary
var _cats: Array
var _window := PKeyPeerLocalWindow.new()
var _attempts: Dictionary = {}
var _sid: PackedByteArray
var _instance: String
var _ci: PackedByteArray
var _memory: PKeyPeerLocalMemory
var _expires_at := 0
var _deadline := 0.0
var _interrupted := 0
var _interrupted_at := -INF
var _nameplate := ""
var _password := ""
var _qr_secret := PackedByteArray()
var _gen_code := PackedByteArray()
var _gen_qr := PackedByteArray()
var _shown: Dictionary = {}
var _server: TCPServer
var _native := false
var _gate: PKeyPeerLanGate
var _adv: Object
var _stopped := false
var _framed := false
## Called once with (end: String or "", at: float) when the window closes; "" tells the floor nothing.
var _on_end: Callable


## Open a window. A coroutine answering a PKeyResult holding the shower, or the failure. `memory` is the product's
## nameplate memory; `on_end` is Callable(floor_end: String, t: float): "too-many-tries", "wrong-code" or "" (null: a
## window a renewal replaces is told as "").
static func start(
	src: PKeyConnectLocalCommon.Source, o: Dictionary, memory: PKeyPeerLocalMemory, on_end: Callable
) -> PKeyResult:
	var s := PKeyConnectLocalShower.new(src, o, memory)
	s._on_end = on_end
	var r: PKeyResult = await s._open()
	if not r.ok:
		s.close("")
		return r
	return PKeyResult.success(s)


func _init(src: PKeyConnectLocalCommon.Source, o: Dictionary, memory: PKeyPeerLocalMemory) -> void:
	_src = src
	_o = o
	_memory = memory
	_cats = (o["categories"] as Array).duplicate()
	_sid = _random(10)
	_instance = PKeyPeerLocal.pairing_instance(_sid)
	_ci = PKeyPeerNoise.prologue(src.slug, "q")


func _to_string() -> String:
	return "PKeyConnectLocalShower(%s)" % ("closed" if _stopped else "open")


func is_open() -> bool:
	return not _stopped


## The code on show now; empty once the window has closed.
func code() -> Dictionary:
	return {} if _stopped else _shown.duplicate()


## The pair instance this window advertises.
func instance() -> String:
	return _instance


## The TCP port of the window's listener (0 once closed).
func port() -> int:
	return _server.get_local_port() if _server != null else 0


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return (
		float((clock as Callable).call())
		if clock is Callable and (clock as Callable).is_valid()
		else float(_src.mono.call())
	)


func _random(n: int) -> Variant:
	var r: Variant = _o.get("random")
	if r is Callable and (r as Callable).is_valid():
		return (r as Callable).call(n)
	return Crypto.new().generate_random_bytes(n)


func _offload(work: Callable) -> Variant:
	if _src.pump != null:
		return await _src.pump.offload(work)
	return work.call()


func _allowed() -> bool:
	return bool(_src.allowed.call())


func _open() -> PKeyResult:
	var t := _mono()
	_window.open(t)
	# Two tiers, from this device's own memory only: the adverts of other windows are not authenticated.
	var np := _memory.draw(Callable(self, "_random"), t)
	if np == "":
		return PKeyConnectLocalCommon.bad_input("No random source.")
	_nameplate = np
	await _renew()
	if _stopped:
		return PKeyConnectLocalCommon.peer_closed("closed", "The window closed.")
	_gate = (
		PKeyPeerLanGate
		. new(
			{
				"max_pending": WAITING * 2,
				"max_pending_per_address": 1,
				"max_pending_per_group": PER_GROUP,
				"handshake_seconds": _o.get("handshake_seconds", PKeyPeerLanGate.HANDSHAKE_SECONDS),
				"allow_loopback": _o.get("allow_loopback", false),
				"mono": Callable(self, "_mono"),
				"tree": _src.tree,
			}
		)
	)
	var mdns := _o["mdns"] as Object
	var epoch := PKeyPeerAdvert.advert_epoch(int(_src.now.call()))
	var advert := {
		"instance": _instance,
		"slot": "q",
		"txt":
		["v=1", "m=q", "h=" + PKeyPeerAdvert.product_tag(_src.slug, epoch), "n=" + _nameplate],
	}
	# An OS lane (the Apple one) listens itself and hands over the accepted sockets; otherwise the window listens.
	_native = mdns.has_method("set_acceptor")
	if _native:
		mdns.call("set_acceptor", "q", Callable(self, "_accept_native"))
	else:
		var listened := PKeyPeerLanGate.listen(str(_o.get("host", "")), 0)
		if not listened.ok:
			return listened
		_server = listened.detail
		advert["port"] = _server.get_local_port()
	var made: PKeyResult = mdns.call("advertise", advert)
	if not made.ok:
		if _native:
			mdns.call("set_acceptor", "q", Callable())
		return made
	_adv = made.detail
	var seconds := minf(
		float(_o.get("seconds", PKeyPeerLocal.LOCAL_PAIR_SECONDS)),
		float(PKeyPeerLocal.LOCAL_PAIR_SECONDS)
	)
	_deadline = _mono() + seconds
	_expires_at = int(floorf(float(_src.now.call()) + seconds))
	_frames(true)
	return PKeyResult.success()


## Show the first code (`on_code`, reason `opened`): the caller does so once the gate has been checked.
func reveal() -> void:
	_show("opened")


## A new password and QR secret, and both generators made from them.
func _renew() -> void:
	var password := PKeyPeerLocal.draw_password(Callable(self, "_random"))
	var secret: PackedByteArray = _random(PKeyPeerLocal.LOCAL_QR_SECRET_BYTES)
	if password == "":
		return
	var ci := _ci
	var sid := _sid
	var code_prs := PKeyPeerCpace.prs_code(password)
	var qr_prs := PKeyPeerCpace.prs_qr(secret)
	var made: Variant = await _offload(
		func() -> Array:
			return [
				PKeyPeerCpace.generator(code_prs, ci, sid), PKeyPeerCpace.generator(qr_prs, ci, sid)
			]
	)
	code_prs.fill(0)
	qr_prs.fill(0)
	# Stopped while the generators were made: nothing new is kept.
	if _stopped or not made is Array:
		secret.fill(0)
		return
	_qr_secret.fill(0)
	_gen_code.fill(0)
	_gen_qr.fill(0)
	_password = password
	_qr_secret = secret
	_gen_code = made[0]
	_gen_qr = made[1]


func _show(reason: String) -> void:
	if _stopped or _password == "" or _qr_secret.is_empty():
		return
	var c := {
		"code": PKeyPeerLocal.display_code(_nameplate, _password),
		"qr": PKeyPeerLocal.make_qr(_src.slug, _instance, _qr_secret),
		"nameplate": _nameplate,
		"reason": reason,
		"expires_at": _expires_at,
		"failures": int(_window.state()["failures"]),
	}
	_shown = c
	_interrupted = 0
	_interrupted_at = -INF
	var on_code: Variant = _o.get("on_code")
	if on_code is Callable and (on_code as Callable).is_valid():
		(on_code as Callable).call(c.duplicate())


## Make the next code, then tell the window. `rotated` comes only after the new password, the new QR secret and both
## generators exist; until then a C1 meets a busy window.
func _rotate(why: String) -> void:
	await _renew()
	if _stopped:
		return
	if _password == "":
		close("person")
		return
	_show(why)
	_window.rotated(_mono())


## `why` is the reason the next code carries when the outcome rotates it.
func _apply(out: Dictionary, why: String) -> void:
	if out.get("rotate", false):
		_rotate(why)
	if out.get("result") == "too-many-tries":
		_call("on_failed", {"reason": "too-many-tries"})
		_shutdown(false, "too-many-tries")


func _call(name: String, arg: Variant) -> void:
	var fn: Variant = _o.get(name)
	if fn is Callable and (fn as Callable).is_valid():
		(fn as Callable).call(arg)


## A connection closed without counting a guess.
func _interrupt() -> void:
	if _stopped:
		return
	_interrupted += 1
	var t := _mono()
	# Counted every time, told at most once a second: a flood does not flood the host.
	if t - _interrupted_at < 1.0:
		return
	_interrupted_at = t
	_call("on_interrupted", _interrupted)


## Close the window, telling the host why (`""`: tell no one, for a window a renewal replaces).
func close(end: String) -> void:
	_shutdown(false, end)


## Close the window: the advert, the listener and the connections (`keep_sessions` spares those past the transport).
func _shutdown(keep_sessions: bool, end: String) -> void:
	if _stopped:
		return
	_stopped = true
	_frames(false)
	var t := _mono()
	# For the SDK's renewal floor: how this window ended, and whether it had counted a failed guess.
	var failures := int(_window.state()["failures"])
	_window.close(t)
	# The next window of this product does not draw this nameplate for 300 s.
	if _nameplate != "":
		_memory.shown(_nameplate, t)
	if _server != null:
		_server.stop()
		_server = null
	if _gate != null:
		_gate.destroy_pending(keep_sessions)
	if _adv != null:
		_adv.call("stop")
		_adv = null
	if _native:
		(_o["mdns"] as Object).call("set_acceptor", "q", Callable())
	for a: PKeyConnectLocalCommon.Attempt in _attempts.values():
		if not keep_sessions or a.phase != "session":
			_end(a, PKeyPeerSession.PEER_BYE)
	# The code, the QR secret and the generators are of no use to anyone now.
	_qr_secret.fill(0)
	_gen_code.fill(0)
	_gen_qr.fill(0)
	_qr_secret = PackedByteArray()
	_password = ""
	_shown = {}
	if _on_end.is_valid():
		var floor_end := ""
		if end == "too-many-tries":
			floor_end = "too-many-tries"
		elif end != "stored" and failures > 0:
			floor_end = "wrong-code"
		_on_end.call(floor_end, t)
	if end != "":
		_call("on_end", {"reason": end})


# -- clocks and frames ----------------------------------------------------------------------------


func _frames(on: bool) -> void:
	var tree := _src.tree
	if tree == null or on == _framed:
		return
	_framed = on
	if on:
		tree.process_frame.connect(_tick)
	elif tree.process_frame.is_connected(_tick):
		tree.process_frame.disconnect(_tick)


func _tick() -> void:
	if _stopped:
		return
	var t := _mono()
	if t >= _deadline:
		# The window's 300 s: the advert and the listener go, a session past the transport runs on.
		_shutdown(true, "expired")
		return
	if _gate != null:
		_gate.drain(_server, Callable(self, "_on_peer"))
		_gate.tick()
	_expire_native(t)
	var out := _window.tick(t)
	if out.get("rotate", false) or out.has("result"):
		_apply(out, "wrong-code")
	for a: PKeyConnectLocalCommon.Attempt in _attempts.values():
		if a.state == "c1":
			_poll(a)


# -- connections ----------------------------------------------------------------------------------


func _on_peer(peer: StreamPeerTCP) -> void:
	var slot := _gate.admit(peer, _stopped or not _allowed())
	if slot == null:
		_interrupt()
		return
	var pipe := PKeyPeerTcpPipe.from_peer(peer)
	if pipe == null:
		slot.settle()
		return
	var a := PKeyConnectLocalCommon.Attempt.new()
	a.pipe = pipe
	a.slot = slot
	a.at = _mono()
	var key := a.get_instance_id()
	slot.on_expire = Callable(self, "_expired").bind(key)
	_attempts[key] = a


## An inbound socket of the OS lane (slot q). The OS side judged the source and holds the unadmitted limits; the
## window keeps the same bound on waiting sockets as for TCP, and times them out like `PKeyPeerLanGate` does.
func _accept_native(pipe: PKeyPeerPipe) -> void:
	if _stopped or not _allowed() or _waiting() >= WAITING * 2:
		_interrupt()
		pipe.abort()
		return
	var a := PKeyConnectLocalCommon.Attempt.new()
	a.pipe = pipe
	a.at = _mono()
	_attempts[a.get_instance_id()] = a


func _waiting() -> int:
	var n := 0
	for a: PKeyConnectLocalCommon.Attempt in _attempts.values():
		if a.slot == null and a.link == null:
			n += 1
	return n


## A native socket that has not become a session within the handshake time is closed.
func _expire_native(t: float) -> void:
	var window := float(_o.get("handshake_seconds", PKeyPeerLanGate.HANDSHAKE_SECONDS))
	for a: PKeyConnectLocalCommon.Attempt in _attempts.values():
		if _native and a.slot == null and a.link == null and t - a.at >= window:
			_drop(a)


func _expired(key: int) -> void:
	var a: PKeyConnectLocalCommon.Attempt = _attempts.get(key)
	if a != null:
		_end(a, PKeyPeerSession.PEER_BYE)


## Read the attempt's first frame, C1. More than one frame before C2 is a peer that sent past its C1.
func _poll(a: PKeyConnectLocalCommon.Attempt) -> void:
	a.pipe.poll()
	var chunk := a.pipe.read()
	if not chunk.is_empty():
		var cut := a.reader.push(chunk)
		if not cut["ok"] or (cut["frames"] as Array).size() > 1:
			_drop(a)
			return
		if (cut["frames"] as Array).size() == 1:
			a.state = "c1-busy"
			_c1(a, cut["frames"][0])
			return
	if a.pipe.is_finished():
		_drop(a)


## An attempt that has no session: its socket goes, and so does its place in the window.
func _drop(a: PKeyConnectLocalCommon.Attempt) -> void:
	if a.closed:
		return
	a.closed = true
	a.state = "done"
	a.pipe.abort()
	if a.slot != null:
		a.slot.settle()
	_over(a, true)
	a.ended.emit(PKeyPeerSession.PEER_BYE, false)


func _c1(a: PKeyConnectLocalCommon.Attempt, frame: PackedByteArray) -> void:
	var v := PKeyPeerCpace.parse_c1(frame)
	var out := _window.c1(_mono(), v.ok)
	# Closed, busy, limited and refused: closed silently; none of them counts a failure.
	if out.get("result") != "attempt" or not v.ok:
		_drop(a)
		_interrupt()
		return
	a.id = int(out["id"])
	var g := _gen_code if v.detail["kind"] == "code" else _gen_qr
	if g.is_empty():
		_drop(a)
		return
	var ya: PackedByteArray = v.detail["share"]
	var y := PKeyPeerCpace.scalar()
	var sid := _sid
	var yb: Variant = await _offload(func() -> Variant: return PKeyPeerCpace.share(y, g))
	if yb == null or a.closed or _stopped:
		_drop(a)
		return
	a.pipe.write(PKeyPeerFrame.encode(PKeyPeerCpace.encode_c2(yb)))
	var secret := y
	var isk: Variant = await _offload(
		func() -> Variant: return PKeyPeerCpace.isk(sid, secret, ya, yb, "responder")
	)
	if isk == null or a.closed or _stopped:
		_drop(a)
		return
	var psk := PKeyPeerCpace.psk(isk, _src.slug)
	var held_r := _src.store.count()
	var held: int = held_r.detail if held_r.ok else PKeyPeerLocal.MAX_LOCAL_LINKS
	_begin_session(a, psk, isk, held)


func _begin_session(
	a: PKeyConnectLocalCommon.Attempt, psk: PackedByteArray, isk: PackedByteArray, held: int
) -> void:
	var key: PackedByteArray = _random(32)
	a.link_key = key
	var elapsed := _mono() - a.at
	var label := str(_o.get("label", ""))
	var key_id := a.get_instance_id()
	var pair := {
		"psk": psk,
		"isk": isk,
		"held": held,
		"cats": _cats.duplicate(),
		"elapsed": elapsed,
		# The required permit: it counts the guess before the tag is tried.
		"permit": Callable(self, "_permit").bind(key_id),
	}
	if label != "":
		pair["label"] = label
	var so := {
		"mode": "q",
		"role": "responder",
		"slug": _src.slug,
		"static_key": key,
		"caps": [],
		"pair": pair,
		"hello": PKeyConnectLocalCommon.hello(_src.slug, label),
		"now": _src.now,
		"mono": Callable(self, "_mono"),
	}
	if _o.get("crypto") is PKeyPeerCrypto:
		so["crypto"] = _o["crypto"]
	var seconds := maxf(0.001, PKeyPeerLocalPairing.TRANSPORT_SECONDS - elapsed)
	var lr := PKeyPeerLink.create(
		a.pipe, so, {"pump": _src.pump, "handshake_ms": int(seconds * 1000.0)}
	)
	psk.fill(0)
	isk.fill(0)
	if not lr.ok:
		_drop(a)
		return
	a.state = "link"
	a.link = lr.detail
	a.link.established.connect(_on_established.bind(key_id))
	a.link.guess.connect(_on_guess.bind(key_id))
	a.link.local_link.connect(_on_local_link.bind(key_id))
	a.link.closed.connect(_on_closed.bind(key_id))
	if a.slot != null:
		a.slot.on_expire = Callable(a.link, "destroy")
	_src.pump.add(a.link)


func _permit(key: int) -> bool:
	var a: PKeyConnectLocalCommon.Attempt = _attempts.get(key)
	if a == null or a.id < 0:
		return false
	var ok := _window.begin_guess(a.id, _mono())
	if ok:
		a.permitted = true
	return ok


func _on_guess(opens: bool, key: int) -> void:
	var a: PKeyConnectLocalCommon.Attempt = _attempts.get(key)
	if a == null:
		return
	var t := _mono()
	# The verdict of the permitted guess: opened (the count is refunded and the attempt is the session) or failed
	# (the code rotates).
	var out := {}
	if a.id >= 0:
		out = _window.guess_opened(a.id, t) if opens else _window.guess_failed(a.id, t)
	a.phase = "session" if opens else "done"
	if not out.is_empty():
		_apply(out, "wrong-code")


func _on_established(info: Dictionary, key: int) -> void:
	var a: PKeyConnectLocalCommon.Attempt = _attempts.get(key)
	if a == null:
		return
	if a.slot != null:
		a.slot.established()
	elif a.pipe != null and a.pipe.has_method("admit"):
		# The socket leaves the OS side's unadmitted limits.
		a.pipe.call("admit")
	a.hello = (info.get("hello", {}) as Dictionary).duplicate()
	if a.shown or _stopped:
		return
	a.shown = true
	_interrupted = 0
	_interrupted_at = -INF
	_call("on_confirm", PKeyConnectLocalCommon.Offer.new(a, _cats))


func _on_local_link(info: Dictionary, key: int) -> void:
	var a: PKeyConnectLocalCommon.Attempt = _attempts.get(key)
	if a == null:
		return
	a.storing = true
	var r := PKeyConnectLocalCommon.store_link(_src, a, info)
	a.storing = false
	if r.ok:
		_call("on_linked", r.detail)


func _on_closed(code: StringName, by_peer: bool, key: int) -> void:
	var a: PKeyConnectLocalCommon.Attempt = _attempts.get(key)
	if a == null or a.closed:
		return
	a.closed = true
	a.closed_code = code
	a.closed_by_peer = by_peer
	if a.slot != null:
		a.slot.settle()
	var t := _mono()
	var out := {"rotate": false}
	# What the next code says when this end rotates it (`LocalCode.reason`).
	var why := "wrong-code"
	var reason := (
		a.failure
		if a.failure != ""
		else ("timeout" if code == PKeyPeerSession.PEER_TIMEOUT else "closed")
	)
	if a.phase == "session":
		out = _window.session_end(t, a.linked)
		why = reason if reason == "declined" or reason == "timeout" else "closed"
	elif a.id >= 0 and a.phase != "done":
		# A permitted guess that has no verdict is a failed guess; one that never reached its guess counts nothing.
		out = _window.abandon(a.id, t)
		if not a.permitted:
			_interrupt()
	_over(a, false)
	a.ended.emit(code, by_peer)
	if a.shown and not a.linked and not _stopped:
		_call("on_failed", {"reason": reason, "close_code": code})
	if a.linked:
		_shutdown(false, "stored")
	else:
		_apply(out, why)


## The attempt is over: its key and its place go; `pre` is a socket that closed before its session began.
func _over(a: PKeyConnectLocalCommon.Attempt, pre: bool) -> void:
	_attempts.erase(a.get_instance_id())
	a.wipe()
	if pre and a.id >= 0 and a.phase == "c1":
		_apply(_window.abandon(a.id, _mono()), "wrong-code")
		_interrupt()


func _end(a: PKeyConnectLocalCommon.Attempt, code: StringName) -> void:
	if a.link != null:
		a.link.close(code)
	else:
		_drop(a)
