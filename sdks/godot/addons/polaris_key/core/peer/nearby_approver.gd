@tool
class_name PKeyPeerNearbyApprover
extends RefCounted
## The approver half of nearby approval (CC-15b.G2a; WIRE-CONTRACT-V5 sections 15.4 and 15.6.1), ported from
## sdk-node `connect/nearbyApprover.ts` (references: Python `core/peer_nearby.py`, Kotlin
## `NearbyApprover.kt`): a signed-in device (M) advertises under a random instance, lets a nearby device
## (D) with no sign-in connect in mode v, shows three codes and, when the person picks the one D shows,
## hands the verified `VOUCH_REQ` to the host. The host calls `nearby/approve` and gives the answer back;
## this class maps it to `VOUCH_RESULT`. It calls no route, and it loads with Cloud Connect off.
##
## Rules this file keeps:
##  - the advert is `p1-` plus 10 random bytes in base32 with `v=1`, `m=v` and the product tag, in slot v.
##    It has a listener of its own (a `TCPServer`, or the native slot listener of the Apple lane), and the
##    instance and the port are both new at every listen and every 300 s; the old listener closes at once
##    and a session past the transport stays;
##  - it stands only while the device is signed in, discovery names `nearby` and `nearbyApprove` (both are
##    read again at every renewal) and the host opened the prompt or allowed background approval
##    (`background`, required with `prompt` false). It stops on `pause()`, on `stop()`, when the device
##    signs out, when discovery loses `nearby`, when a renewal fails and when the failure budget is spent
##    (two prompted failures in 10 minutes). `stop()`, a sign-out, a lost discovery and a failed renewal are
##    final: no later call brings the advert back. A budget stop is cleared by `reopen()` or
##    `set_prompt(true)` only; `pause()` works from `advertising` only, and `resume()` only from the host's
##    own pause, after sign-in and discovery are read again;
##  - `stop()` and a sign-out do not wait for a renewal: the state, the listener, the advert and the
##    sessions go down at once (`destroy()` also drops the sockets);
##  - accept is the mode-a gate (`PKeyPeerLanGate`): the same verdict on the socket's address and the same
##    pending limits, and here one waiting session per source address; `PKeyPeerLimiter` allows 5
##    handshakes a minute and 4 waiting per advert, and a new instance gets a new limiter;
##  - one prompt at a time, held until the picked session finishes or closes. A session that reaches the
##    code stage meanwhile waits with no code shown and its 120 s deadline running. With the prompt closed
##    a session only raises `notice`. A prompt that was shown and whose peer then closes before the person
##    answered counts as a failure;
##  - a wrong pick, "None of these match", the host's close and the deadline end the session before
##    `VOUCH_REQ` is delivered, and no route is called;
##  - `finish()` is refused unless the person picked the right code on this session and `VOUCH_REQ`
##    verified (no silent approval); records for Sync go out only after `approved`;
##  - the request handle, `sig`, `h`, the nonces and the one-time keys are in no message, `str()` or error;
##    the one-time static key is wiped once the session holds it.
##
## Threads. The one-time X25519 and the transport run through `PKeyPeerCrypto` (native lanes where there are
## any); the Ed25519 check of `VOUCH_REQ` is GDScript and runs through the pump's `offload`, once a session,
## after the pick.
##
## Use. `start(source, handler, options)` answers a PKeyResult holding the running approver, or
## `nearby-unsupported` (an older native binding, or a querier-only lane), or the lane's failure. `handler`
## is a Callable taking one `Approval`. `options`: `prompt` (the "Approve a nearby device" screen is open),
## `background`, `label` (the device's own name; never an account identifier), `mdns`, `host`,
## `allow_loopback`, `handshake_seconds`, `renew_seconds` (300), `keep_open_seconds` (300),
## `request_wait_seconds` (30), `check_seconds` (15), `max_sessions` (8), `max_pending_per_address` (1),
## `timer` (Callable(seconds, fn)), `mono` (Callable() -> monotonic seconds), `random` (Callable(n) -> n
## bytes), `pump`, `tree`, `interfaces`. Signals: `notice` (a session wants approval while the prompt is
## closed) and `stopped` (the advert stopped on its own: everything but the host's own pause and stop).

## A session that wants approval while the prompt is closed: {label, platform}. No code, no pick.
signal notice(info: Dictionary)
## The advert stopped on its own. `reason`: `budget`, `signed-out`, `discovery`.
signal stopped(reason: String)

const HELD_REQUEST_SECONDS := 30.0
const KEEP_OPEN_SECONDS := 300.0
const RENEW_SECONDS := 300.0
## The most a renewal waits on the host's sign-in or discovery read.
const CHECK_SECONDS := 15.0
## Waiting sessions from one /24 or /64 (rule 2).
const PER_GROUP := 2
const MAX_SESSIONS := 8
## Waiting sessions at once, and handshakes a minute (rule 2).
const WAITING := 4
const PER_MINUTE := 5
const SLOT := "v"

var _src: Source
var _handler: Callable
var _o: Dictionary
var _tree: SceneTree
var _pump: PKeyPeerPump
var _mdns: Object
var _random: Callable
var _budget: PKeyPeerVouch.FailureBudget
var _live: Dictionary = {}
var _queue: Array = []
var _active: Live
var _gens: Array = []
var _gen: Gen
var _renew: Array = [true]
var _prompt: bool
var _background: bool
var _state := "stopped"
var _reason := ""
## A stop that nothing undoes: `stop()`, a sign-out, lost discovery, a failed renewal.
var _final := false
## Bumped by every halt; a read or a restart that began before it gives up.
var _epoch := 0
var _restarting := false
var _framed := false


## What the approver reads of the client: `slug`, `now` () -> epoch seconds, `signed_in` () -> bool and
## `nearby_served` () -> bool (a fresh read of discovery: does it name `nearby` and `nearbyApprove`? both may
## be coroutines).
class Source extends RefCounted:
	var slug := ""
	var now: Callable
	var signed_in: Callable
	var nearby_served: Callable


	func _to_string() -> String:
		return "PKeyPeerNearbyApprover.Source()"


## One listen: the gate and limiter of an advert, and the listener and advert handle.
class Gen extends RefCounted:
	var gate: PKeyPeerLanGate
	var limiter: PKeyPeerLimiter
	var server: TCPServer
	var adv: Object
	var retired := false


	func _to_string() -> String:
		return "PKeyPeerNearbyApprover.Gen()"


## One inbound session of the approver.
class Live extends RefCounted:
	signal resolved
	signal pick_settled
	signal ended(code: StringName, by_peer: bool)

	var link: PKeyPeerLink
	var session: PKeyPeerSession
	var slot: PKeyPeerLanGate.Slot
	var hello: Dictionary = {}
	var sas := -1
	var noticed := false
	var shown := false
	var picked := false
	var dead := false
	## This class ended the session (a pick, a close, the host, a pause): not the peer's doing.
	var local := false
	var pipe: PKeyPeerPipe
	var keys_retried := false
	var request: Variant = null
	var request_done := false
	var pick_started := false
	var pick_done := false
	var pick_result: PKeyResult
	var closed_code: StringName = &""
	var cancels: Array = []


	func _to_string() -> String:
		return "PKeyPeerNearbyApprover.Live()"


	func resolve(value: Variant) -> void:
		if request_done:
			return
		request_done = true
		request = value
		resolved.emit()


## One session asking for approval, as the host's handler sees it.
class Approval extends RefCounted:
	## The session ended (once).
	signal closed(code: StringName, by_peer: bool)

	## What D's HELLO showed ("" when it sent none). Unauthenticated display data: any device on the network
	## can send any label, and the cleaning leaves some invisible blanks, so a label can look empty or like
	## another device's. Show it as "reported by the device" beside the platform and the codes, never as
	## proof of who is asking; the person's pick of the matching code is the only check.
	var label := ""
	var platform := ""
	## The three codes, in the order to show them, each like `123 456`.
	var codes: Array = []

	## Weak: a host that keeps its approvals would otherwise keep the approver (and its sessions) alive.
	var _owner: WeakRef
	var _live: Live


	func _init(owner: PKeyPeerNearbyApprover, live: Live, p_label: String, p_platform: String, p_codes: Array) -> void:
		_owner = weakref(owner)
		_live = live
		label = p_label
		platform = p_platform
		codes = p_codes
		live.ended.connect(_on_ended)


	func _to_string() -> String:
		return "PKeyPeerNearbyApproval()"


	func _on_ended(code: StringName, by_peer: bool) -> void:
		closed.emit(code, by_peer)


	func is_closed() -> bool:
		return _live.dead


	## The close code once the session ended, else an empty name.
	func close_code() -> StringName:
		return _live.closed_code


	## The person picked this code (`123 456`, `123456` or the number). The right one delivers D's
	## `VOUCH_REQ`, which is verified here: ok with the request as {request, device_id, sign_key, agree_key,
	## label, platform}, exactly what `nearby/approve` gets. A wrong code closes the session, calls no route
	## and fails with reason `mismatch`; a request that does not verify closes it and fails `invalid`. A
	## second call answers the first one's result. A coroutine.
	func pick(code: Variant) -> PKeyResult:
		var owner := _approver()
		if owner == null:
			return _gone()
		return await owner._pick(_live, code)


	## "None of these match": the session closes, nothing is delivered and no route is called.
	func decline() -> void:
		var owner := _approver()
		if owner != null:
			owner._decline(_live)


	## Give the answer of `nearby/approve` back; sends `VOUCH_RESULT` (rule 6). `answer`: `http` (the
	## status, or null when there was no answer), `body` (text or null) and `discovery_nearby` (the host's
	## fresh read: does discovery still name `nearby` and `nearbyApprove`?). ok with {sent: status}, {wait:
	## "choice" | "keys"} (nothing sent: show the choice, or register this device's keys, then call again) or
	## {closed: true} (nothing sent; the session closed `peer_bye`). Refused (reason `not_picked`) unless
	## the person picked the right code on this session and the request verified.
	func finish(answer: Dictionary) -> PKeyResult:
		var owner := _approver()
		return owner._finish(_live, answer) if owner != null else _gone()


	## After `approved`: a Sync record (0x0030 to 0x003F) to D.
	func send_record(type: int, body: PackedByteArray) -> PKeyResult:
		var owner := _approver()
		return owner._send(_live, type, body) if owner != null else _gone()


	## The host leaves: the session closes `peer_bye`. Before a pick this counts for nothing.
	func close() -> void:
		var owner := _approver()
		if owner != null:
			owner._end(_live, PKeyPeerSession.PEER_BYE)


	func _approver() -> PKeyPeerNearbyApprover:
		return _owner.get_ref() as PKeyPeerNearbyApprover


	## The approver is gone (stopped and freed): there is no session to answer on.
	func _gone() -> PKeyResult:
		return PKeyResult.failure(PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE, "The nearby approval is over.", {"reason": "closed"})


## Start advertising. The caller has checked that the device is signed in and that discovery names `nearby`;
## both are read again at every renewal.
static func start(source: Source, handler: Callable, options := {}) -> PKeyResult:
	if source == null or not handler.is_valid() or source.slug == "" or not source.now.is_valid() \
			or not source.signed_in.is_valid() or not source.nearby_served.is_valid():
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "Nearby approver: bad source or handler.")
	if not bool(options.get("prompt", false)) and not bool(options.get("background", false)):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "Without the prompt, background approval must be allowed (background: true).")
	var a := PKeyPeerNearbyApprover.new(source, handler, options)
	var lane := a._lane_ready()
	if not lane.ok:
		return lane
	var r := a._advertise()
	if not r.ok:
		a._halt("stopped", "host")
		return r
	return PKeyResult.success(a)


func _init(source: Source, handler: Callable, options := {}) -> void:
	_src = source
	_handler = handler
	_o = options
	_prompt = bool(options.get("prompt", false))
	_background = bool(options.get("background", false))
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	_pump = options.get("pump", null) as PKeyPeerPump
	if _pump == null:
		_pump = PKeyPeerPump.new(_tree)
	_mdns = options.get("mdns", null) as Object
	if _mdns == null:
		_mdns = PKeyMdns.new({"allow_loopback": bool(options.get("allow_loopback", false)), "only": options.get("interfaces", []), "tree": _tree})
	var rnd: Variant = options.get("random")
	_random = rnd if rnd is Callable and (rnd as Callable).is_valid() else Callable(self, "_system_random")
	_budget = PKeyPeerVouch.FailureBudget.new(Callable(self, "_mono"))


func _to_string() -> String:
	return "PKeyPeerNearbyApprover(%s)" % _state


func _system_random(n: int) -> PackedByteArray:
	return Crypto.new().generate_random_bytes(n)


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return float((clock as Callable).call()) if clock is Callable and (clock as Callable).is_valid() else float(Time.get_ticks_msec()) / 1000.0


# -- the handle -------------------------------------------------------------------------------------


## {state: "advertising" | "paused" | "stopped", reason: why it stopped ("" when running), prompt}.
func status() -> Dictionary:
	return {"state": _state, "reason": _reason, "prompt": _prompt}


## The TCP port of the running listener (0 when there is none, or on a native listener).
func port() -> int:
	return _gen.server.get_local_port() if _gen != null and _gen.server != null else 0


## Sessions open now (including the ones still in the handshake).
func session_count() -> int:
	return _live.size()


## Final, and not queued: the state, the listener, the advert and the sessions go down at once.
func stop() -> void:
	_final = true
	_halt("stopped", "host")


## Drop everything now, with no goodbye (the sign-out bound's force path).
func destroy() -> void:
	_final = true
	_halt("stopped", "host")
	for live: Live in _live.values():
		live.local = true
		live.link.destroy()


## Stop advertising and close live sessions until `resume()`. Works from `advertising` only.
func pause() -> void:
	if _final or _state != "advertising":
		return
	_halt("paused", "host")


## Start again after the host's own `pause()`. It reads sign-in and discovery again first, and does nothing
## after a stop, a sign-out or a spent budget. A coroutine.
func resume() -> void:
	if _final or _state != "paused" or _reason != "host":
		return
	await _restart()


## The "Approve a nearby device" screen opens (true) or closes (false). Opening it also counts the failure
## budget from zero and starts a stopped (budget) or paused advert again; closing it ends the prompt that is
## showing and, without `background`, pauses the advert. A coroutine.
func set_prompt(open: bool) -> void:
	if _final or open == _prompt:
		return
	_prompt = open
	if not open:
		# The screen closed: the prompt that is showing ends, and the others go passive.
		var live := _active
		_active = null
		if live != null and not live.picked:
			_end(live, PKeyPeerSession.PEER_BYE)
		for l: Live in _queue:
			l.noticed = false
		# Without background approval nothing stands for a closed screen.
		if not _background and _state == "advertising":
			_halt("paused", "host")
		_prompt_next()
		return
	_budget.reopen()
	if (_state == "stopped" and _reason == "budget") or (_state == "paused" and _reason == "host"):
		await _restart()
	_prompt_next()


## Count the failure budget from zero and start a budget-stopped advert again. A coroutine.
func reopen() -> void:
	if _final:
		return
	_budget.reopen()
	if _state == "stopped" and _reason == "budget":
		await _restart()


## A host read that may hang or fail: past `check_seconds`, or on no answer, it reads as "no". A coroutine.
func _check(read: Callable) -> bool:
	var box := {"done": false, "value": false}
	_read(read, box)
	var deadline := _mono() + float(_o.get("check_seconds", CHECK_SECONDS))
	while not bool(box["done"]) and _mono() < deadline and _tree != null:
		await _tree.process_frame
	return bool(box["done"]) and bool(box["value"])


func _read(read: Callable, box: Dictionary) -> void:
	var v: Variant = await read.call()
	box["value"] = v == true
	box["done"] = true


## Start the advert again from a pause or a budget stop, after reading sign-in and discovery again. A stop,
## or a halt that landed meanwhile, wins. A coroutine.
func _restart() -> void:
	if _budget.stopped():
		if _state == "paused":
			_halt("stopped", "budget")
		return
	if _restarting:
		return
	_restarting = true
	var epoch := _epoch
	var signed := await _check(_src.signed_in)
	if _final or epoch != _epoch:
		_restarting = false
		return
	if not signed:
		_restarting = false
		_halt("stopped", "signed-out")
		return
	var served := await _check(_src.nearby_served)
	_restarting = false
	if _final or epoch != _epoch:
		return
	if not served:
		_halt("stopped", "discovery")
		return
	if not _advertise().ok:
		_halt("stopped", "discovery")


# -- the advert -------------------------------------------------------------------------------------


func _unsupported(reason: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, "Nearby approval is not available here.", {"reason": reason})


## An older native binding has no slot v: nearby answers unsupported and mode a is unchanged.
func _lane_ready() -> PKeyResult:
	if _mdns.has_method("capabilities"):
		var caps: Variant = _mdns.call("capabilities")
		if not (caps is Dictionary and bool((caps as Dictionary).get("slots", false))):
			return _unsupported("slots")
	return PKeyResult.success()


func _native() -> bool:
	return _mdns.has_method("set_acceptor")


## A new listener, port and instance; the old generation retires. Starts the renewal clock.
func _advertise() -> PKeyResult:
	var instance := PKeyPeerVouch.approver_instance(_random)
	if instance == "":
		return PKeyResult.failure(PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE, "Nearby approval could not start.", {"reason": "random"})
	var tag := PKeyPeerAdvert.product_tag(_src.slug, PKeyPeerAdvert.advert_epoch(int(_src.now.call())))
	var gen := Gen.new()
	gen.gate = PKeyPeerLanGate.new({
		"max_pending": WAITING * 2, "max_pending_per_address": int(_o.get("max_pending_per_address", 1)),
		"max_pending_per_group": PER_GROUP, "handshake_seconds": _o.get("handshake_seconds", PKeyPeerLanGate.HANDSHAKE_SECONDS),
		"allow_loopback": _o.get("allow_loopback", false), "mono": Callable(self, "_mono"), "tree": _tree,
	})
	gen.limiter = PKeyPeerLimiter.new(PER_MINUTE, WAITING, Callable(self, "_mono"))
	var advert := {"instance": instance, "txt": ["v=1", "m=v", "h=" + tag], "slot": SLOT}
	var old := _gen
	if _native():
		# The OS side holds one listener per slot: the old one goes first, and its pipes arrive here.
		if old != null:
			_retire(old)
			old = null
		_mdns.call("set_acceptor", SLOT, Callable(self, "_accept_native"))
	else:
		var listened := PKeyPeerLanGate.listen(str(_o.get("host", "")), 0)
		if not listened.ok:
			return listened
		gen.server = listened.detail
		advert["port"] = gen.server.get_local_port()
	var made: PKeyResult = _mdns.advertise(advert)
	if not made.ok:
		if gen.server != null:
			gen.server.stop()
		return made
	gen.adv = made.detail
	if _querier_only():
		gen.adv.stop()
		if gen.server != null:
			gen.server.stop()
		return _unsupported("querier_only")
	_gen = gen
	_gens.append(gen)
	_state = "advertising"
	_reason = ""
	if old != null:
		_retire(old)
	_frames(true)
	_renew[0] = true
	_renew = _after(float(_o.get("renew_seconds", RENEW_SECONDS)), Callable(self, "_renew_later"))
	return PKeyResult.success()


## A lane that can only ask cannot be found: M answers unsupported rather than advertise to nobody.
func _querier_only() -> bool:
	if not _mdns.has_method("status"):
		return false
	var st: Variant = _mdns.call("status")
	return st is Dictionary and str((st as Dictionary).get("reason", "")) == "querier_only"


func _renew_later() -> void:
	_renew_run()


func _renew_run() -> void:
	if _state != "advertising":
		return
	var epoch := _epoch
	var signed := await _check(_src.signed_in)
	if epoch != _epoch:
		return
	if not signed:
		_halt("stopped", "signed-out")
		return
	var served := await _check(_src.nearby_served)
	if epoch != _epoch:
		return
	if not served:
		_halt("stopped", "discovery")
		return
	# The advert cannot be renewed (the interface went away, the port is gone): it must not stand on,
	# unrenewed and unchecked. It stops, and the host hears why.
	if not _advertise().ok and epoch == _epoch:
		_halt("stopped", "discovery")


## The old listener accepts nothing more; a connection short of the transport is closed.
func _retire(g: Gen) -> void:
	g.retired = true
	if g.server != null:
		g.server.stop()
		g.server = null
	g.gate.destroy_pending(true)
	if g.adv != null:
		g.adv.call("stop")
		g.adv = null


## Take everything down. The state, the listener and the session closes happen at once.
func _halt(state: String, reason: String) -> void:
	_epoch += 1
	if state == "stopped" and reason != "budget":
		_final = true
	_renew[0] = true
	var g := _gen
	_gen = null
	_state = state
	_reason = reason
	if g != null:
		_retire(g)
	if _native() and _mdns != null:
		_mdns.call("set_acceptor", SLOT, Callable())
	for live: Live in _live.values():
		_end(live, PKeyPeerSession.PEER_BYE)
	_queue = []
	_active = null
	if _final:
		_frames(false)
	# The host's own stop and pause need no word back.
	if reason != "host":
		stopped.emit(reason)


# -- the frame --------------------------------------------------------------------------------------


func _frames(on: bool) -> void:
	if _tree == null or on == _framed:
		return
	_framed = on
	if on:
		_tree.process_frame.connect(_tick)
	elif _tree.process_frame.is_connected(_tick):
		_tree.process_frame.disconnect(_tick)


func _tick() -> void:
	for g: Gen in _gens.duplicate():
		if g.server != null and not g.retired:
			g.gate.drain(g.server, Callable(self, "_on_peer").bind(g))
		g.gate.tick()
		if g.retired and g.gate.size() == 0:
			_gens.erase(g)


## Call `fn` once, `seconds` from now. Returns the box whose first element cancels it when set true.
func _after(seconds: float, fn: Callable) -> Array:
	var box := [false]
	var guarded := Callable(self, "_fire").bind(box, fn)
	var timer: Variant = _o.get("timer")
	if timer is Callable and (timer as Callable).is_valid():
		(timer as Callable).call(seconds, guarded)
	elif _tree != null:
		# Real time: a paused game clock (Engine.time_scale) must not stretch the advert or session bounds.
		_tree.create_timer(maxf(0.05, seconds), true, false, true).timeout.connect(guarded)
	return box


func _fire(box: Array, fn: Callable) -> void:
	if not bool(box[0]):
		box[0] = true
		fn.call()


# -- sessions ---------------------------------------------------------------------------------------


func _refuse() -> bool:
	return _state != "advertising" or _live.size() >= int(_o.get("max_sessions", MAX_SESSIONS))


func _on_peer(peer: StreamPeerTCP, g: Gen) -> void:
	var slot := g.gate.admit(peer, g.retired or _refuse())
	if slot == null:
		return
	var pipe := PKeyPeerTcpPipe.from_peer(peer)
	if pipe == null:
		slot.settle()
		return
	_open(g, pipe, slot)


## An inbound native pipe (the Apple slot listener): the OS side judged the source and holds the
## unadmitted limits.
func _accept_native(pipe: PKeyPeerPipe) -> void:
	if _gen == null or _gen.retired or _refuse():
		pipe.abort()
		return
	_open(_gen, pipe, null)


func _open(g: Gen, pipe: PKeyPeerPipe, slot: PKeyPeerLanGate.Slot) -> void:
	var key := (_random.call(32) as PackedByteArray)
	var platform := PKeyHeaders.platform()
	var seconds := float(_o.get("handshake_seconds", PKeyPeerLanGate.HANDSHAKE_SECONDS))
	var options := {
		"mode": "v", "role": "responder", "slug": _src.slug, "static_key": key, "caps": [], "admission": g.limiter,
		"hello": {"label": str(_o.get("label", "")), "platform": platform if platform != "" else "unknown", "app": _src.slug},
		"now": _src.now, "mono": Callable(self, "_mono"),
	}
	var lr := PKeyPeerLink.create(pipe, options, {"pump": _pump, "handshake_ms": int(seconds * 1000.0)})
	# The session holds its own copy of the key.
	key.fill(0)
	if not lr.ok:
		pipe.abort()
		if slot != null:
			slot.settle()
		return
	var live := Live.new()
	live.link = lr.detail
	live.session = live.link.session
	live.slot = slot
	var id := live.get_instance_id()
	live.link.established.connect(_on_established.bind(id))
	live.link.sas.connect(_on_sas.bind(id))
	live.link.record.connect(_on_record.bind(id))
	live.link.closed.connect(_on_closed.bind(id))
	if slot != null:
		slot.on_expire = Callable(live.link, "destroy")
	_live[id] = live
	live.pipe = pipe
	_pump.add(live.link)


func _on_established(info: Dictionary, id: int) -> void:
	var live: Live = _live.get(id)
	if live == null:
		return
	live.hello = (info.get("hello", {}) as Dictionary).duplicate()
	if live.slot != null:
		live.slot.established()
	if live.pipe != null and live.pipe.has_method("admit"):
		live.pipe.call("admit")


func _on_sas(code: int, _display: String, id: int) -> void:
	var live: Live = _live.get(id)
	if live == null or live.dead:
		return
	live.sas = code
	_queue.append(live)
	_prompt_next()


func _on_record(type: int, body: PackedByteArray, id: int) -> void:
	var live: Live = _live.get(id)
	if live == null or live.dead:
		return
	if type == PKeyPeerRecord.VOUCH_REQ:
		_verify(live, body)
	elif type >= 0x8100 and type <= 0xfffd:
		_end(live, PKeyPeerSession.PEER_UNKNOWN_CRITICAL)


## Verify D's request off the main thread, once the person's pick has delivered it.
func _verify(live: Live, body: PackedByteArray) -> void:
	var ok: Variant = null
	if not live.hello.is_empty() and body.size() <= PKeyPeerVouch.VOUCH_REQ_MAX:
		var shown := {"platform": str(live.hello.get("platform", ""))}
		if live.hello.has("label"):
			shown["label"] = live.hello["label"]
		var input := {"slug": _src.slug, "h": live.session.handshake_hash(), "hello": shown, "hello_cleaned": true, "body": body}
		# `HELLO` was cleaned when the session read it; cleaning it again is not idempotent.
		ok = await _pump.offload(func() -> Variant: return PKeyPeerVouch.verify_request(input))
	if live.dead:
		return
	if ok == null:
		live.resolve("invalid")
		_end(live, PKeyPeerSession.PEER_BAD_FRAME)
		return
	live.session.vouch().verified()
	live.resolve(ok)


func _on_closed(code: StringName, by_peer: bool, id: int) -> void:
	var live: Live = _live.get(id)
	if live == null or live.dead:
		return
	live.dead = true
	live.closed_code = code
	if live.slot != null:
		live.slot.settle()
	for box: Array in live.cancels:
		box[0] = true
	_live.erase(id)
	_queue.erase(live)
	live.resolve("invalid")
	# A prompt that was shown and ended before the person answered, by anything but this class (the 120 s
	# deadline, the peer closing or the connection dropping), counts (rule 2).
	if live.shown and not live.picked and not live.local:
		_failure()
	live.ended.emit(code, by_peer)
	if _active == live:
		_active = null
		_prompt_next()


## Close a session with `code`.
func _end(live: Live, code: StringName) -> void:
	if live.dead:
		return
	live.local = true
	live.link.close(code)


## Count one prompted failure; the second in the window stops the advert.
func _failure() -> void:
	if _budget.fail() and _state == "advertising":
		_halt("stopped", "budget")


# -- the prompt, one at a time -----------------------------------------------------------------------


func _prompt_next() -> void:
	if _state != "advertising":
		return
	if not _prompt:
		for l: Live in _queue:
			if not l.noticed:
				l.noticed = true
				notice.emit({"label": str(l.hello.get("label", "")), "platform": str(l.hello.get("platform", ""))})
		return
	if _active != null:
		return
	var next: Live = null
	for l: Live in _queue:
		if not l.shown and not l.dead:
			next = l
			break
	if next == null:
		return
	_active = next
	next.shown = true
	next.session.vouch().shown()
	var drawn := PKeyPeerVouch.decoy_codes(next.sas, _random)
	if not drawn.ok:
		_end(next, PKeyPeerSession.PEER_BYE)
		return
	var shown: Array = []
	for c: int in drawn.detail["codes"]:
		shown.append(PKeyPeerSas.display(c))
	var approval := Approval.new(self, next, str(next.hello.get("label", "")), str(next.hello.get("platform", "")), shown)
	_handler.call(approval)


## The prompt is over (a pick, a decline): the next waiting session may show its codes.
func _release(live: Live) -> void:
	_queue.erase(live)
	if _active == live:
		_active = null
	_prompt_next()


## A code the person picked: `123 456`, `123456` or the number; -1 when it is none of those.
static func code_value(code: Variant) -> int:
	if code is int:
		return code if code >= 0 and code < 1000000 else -1
	if not code is String:
		return -1
	var digits := (code as String).replace(" ", "")
	if digits.length() != 6:
		return -1
	for c in digits:
		if c < "0" or c > "9":
			return -1
	return int(digits)


func _failed(code: String, reason: String, message: String) -> PKeyResult:
	return PKeyResult.failure(StringName(code), message, {"reason": reason})


func _closed() -> PKeyResult:
	return _failed(PKeyConstants.ErrorCode.PEER_CLOSED, "closed", "The session is closed.")


func _pick(live: Live, code: Variant) -> PKeyResult:
	if live.pick_started:
		if not live.pick_done:
			await live.pick_settled
		return live.pick_result
	live.pick_started = true
	var r := await _pick_run(live, code)
	live.pick_result = r
	live.pick_done = true
	live.pick_settled.emit()
	return r


func _pick_refusal(live: Live, code: Variant) -> PKeyResult:
	if live.dead:
		return _closed()
	if live.sas < 0 or live.picked:
		return _failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "not_picked", "There is no code to pick.")
	if code_value(code) != live.sas:
		_failure()
		_abandon(live, "wrong-pick")
		return _failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "mismatch", "That is not the code D shows.")
	return null


func _pick_run(live: Live, code: Variant) -> PKeyResult:
	var refused := _pick_refusal(live, code)
	if refused != null:
		return refused
	live.session.vouch().picked()
	if live.dead:
		return _failed(PKeyConstants.ErrorCode.PEER_CLOSED, "invalid", "The session is closed.")
	live.picked = true
	if live.slot != null:
		live.slot.settle()
	# The prompt slot stays with this session until it finishes or closes: the next waiting session shows no
	# code meanwhile. The session stays for records after `approved`, and no longer than 300 s past the pick.
	live.cancels.append(_after(float(_o.get("keep_open_seconds", KEEP_OPEN_SECONDS)), func() -> void: _end(live, PKeyPeerSession.PEER_BYE)))
	# The person's pick is M's confirmation; the held `VOUCH_REQ` is delivered from here on.
	live.session.confirm_sas()
	if live.dead:
		return _failed(PKeyConstants.ErrorCode.PEER_CLOSED, "invalid", "The session is closed.")
	var wait := _after(float(_o.get("request_wait_seconds", HELD_REQUEST_SECONDS)), func() -> void: _end(live, PKeyPeerSession.PEER_TIMEOUT))
	live.cancels.append(wait)
	if not live.request_done:
		await live.resolved
	wait[0] = true
	if live.request is Dictionary:
		return PKeyResult.success(live.request)
	return _failed(PKeyConstants.ErrorCode.PEER_CLOSED, "invalid", "D's request did not verify.")


func _decline(live: Live) -> void:
	if live.dead or live.picked:
		return
	_failure()
	_abandon(live, "none-match")


## A session ended before the right pick: nothing is delivered and no route is called.
func _abandon(live: Live, reason: String) -> void:
	live.local = true
	live.session.vouch().abandon(reason)
	_release(live)


func _finish(live: Live, answer: Dictionary) -> PKeyResult:
	if live.dead:
		return _closed()
	# No silent approval: the right pick on this session and a verified request, or nothing.
	if not live.session.vouch().may_finish():
		return _failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "not_picked", "The person has not picked the code on this session.")
	var act := PKeyPeerVouch.finish_map({
		"http": answer.get("http"), "body": answer.get("body"),
		"discovery_nearby": answer.get("discovery_nearby", false), "keys_retried": live.keys_retried,
	})
	if act.has("send"):
		var sent := live.link.send_record(PKeyPeerRecord.VOUCH_RESULT, PKeyPeerVouch.build_result(act["send"]))
		if not sent.ok:
			_end(live, PKeyPeerSession.PEER_BYE)
			return _closed()
		# Finished: the next waiting session may show its codes.
		_release(live)
		if act["send"] != "approved":
			_end(live, PKeyPeerSession.PEER_BYE)
		return PKeyResult.success({"sent": act["send"]})
	if act.has("wait"):
		if act["wait"] == "keys":
			live.keys_retried = true
		return PKeyResult.success({"wait": act["wait"]})
	_release(live)
	_end(live, PKeyPeerSession.PEER_BYE)
	if bool(act.get("stop_advert", false)):
		_halt("stopped", "discovery")
	return PKeyResult.success({"closed": true})


func _send(live: Live, type: int, body: PackedByteArray) -> PKeyResult:
	if live.dead:
		return _closed()
	if type < 0x0030 or type > 0x003f:
		return _failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "bad_type", "Sync records are 0x0030 to 0x003F.")
	var r := live.link.send_record(type, body)
	if r.ok:
		return r
	if r.code == &"too_large":
		return _failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "too_large", "The message is larger than D accepts.")
	return _failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "not_picked", "A record needs an approved vouch.")
