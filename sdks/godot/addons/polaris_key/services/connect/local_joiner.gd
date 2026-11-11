@tool
class_name PKeyConnectLocalJoiner
extends RefCounted
## The joiner of a pairing, `cloud_connect.local_links.join` (CC-29b.G3; WIRE-CONTRACT-V5 section 15.12, "The joiner"),
## ported from sdk-node `connect/localJoiner.ts`: it reads the typed code or the scanned QR, browses for the matching
## `m=q` advert and dials it, at most 2 dials a join and, for a typed code, at most 2 per nameplate in 300 s across
## joins (`PKeyPeerLocalJoin.DialBudget`, spent when the dial is made). It never retries a failed code by itself, and a
## QR is never limited. The choices over one browse are `PKeyPeerLocalJoin`, which also says why a
## `pairing-code-failed` was one.
##
## Cancelling (`cancel`, the gate going off) closes the dial, stops the browse and wipes the QR secret, the generator,
## the scalar, the ISK and the PSK of the dial in flight. It refunds no dial: the budget was spent when the dial was
## made. Everything runs on the main thread, once a frame; the CPace work goes through the pump's offload.

var _src: PKeyConnectLocalCommon.Source
var _budget: PKeyPeerLocalJoin.DialBudget
var _o: Dictionary
var _plan: PKeyPeerLocalJoin
var _cands: Dictionary = {}
var _ci: PackedByteArray
var _cats: Array
var _password := ""
var _nameplate := ""
var _qr_instance := ""
var _qr_secret := PackedByteArray()
var _qr_gen := PackedByteArray()
var _browse: Object
var _gate: PKeyPeerLanGate
var _deadline := 0.0
var _busy := false
var _dials := 0
var _browse_over := false
var _done := false
var _result: PKeyResult
var _current: PKeyConnectLocalCommon.Attempt
var _pipe: PKeyPeerPipe
var _secrets: Array = []


## `src` is the facade's source, `budget` the product's dial budget, `o` the options of `join` (exactly one of `code` and
## `qr`).
func _init(
	src: PKeyConnectLocalCommon.Source, budget: PKeyPeerLocalJoin.DialBudget, o: Dictionary
) -> void:
	_src = src
	_budget = budget
	_o = o
	_ci = PKeyPeerNoise.prologue(src.slug, "q")
	_cats = (o["categories"] as Array).duplicate()
	var input := {"kind": "invalid"}
	if o.has("code"):
		var c := PKeyPeerLocal.parse_code(str(o["code"]))
		if c["ok"]:
			input = {"kind": "code", "nameplate": c["nameplate"]}
			_password = c["password"]
			_nameplate = c["nameplate"]
	else:
		var q := PKeyPeerLocal.parse_qr(str(o["qr"]), src.slug)
		if q["result"] == "ok":
			input = {"kind": "qr", "instance": q["instance"]}
			_qr_instance = q["instance"]
			_qr_secret = q["secret"]
		elif q["result"] == "other-app":
			input = {"kind": "other-app"}
	_plan = PKeyPeerLocalJoin.new(input)
	_gate = PKeyPeerLanGate.new(
		{
			"allow_loopback": o.get("allow_loopback", false),
			"mono": Callable(self, "_mono"),
			"tree": src.tree
		}
	)


func _to_string() -> String:
	return "PKeyConnectLocalJoiner()"


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return (
		float((clock as Callable).call())
		if clock is Callable and (clock as Callable).is_valid()
		else float(_src.mono.call())
	)


func _random(n: int) -> PackedByteArray:
	var r: Variant = _o.get("random")
	if r is Callable and (r as Callable).is_valid():
		return (r as Callable).call(n)
	return Crypto.new().generate_random_bytes(n)


func _offload(work: Callable) -> Variant:
	if _src.pump != null:
		return await _src.pump.offload(work)
	return work.call()


func is_done() -> bool:
	return _done


## Stop the join: `cancelled` is the host's cancel, `closed` the gate going off.
func cancel(why := "closed") -> void:
	_finish(
		(
			PKeyConnectLocalCommon.cancelled()
			if why == "cancelled"
			else PKeyConnectLocalCommon.peer_closed("closed", "The pairing was closed.")
		)
	)


## Run the join. A coroutine answering ok with {id, label, categories}, or the failure.
func run() -> PKeyResult:
	if not _plan.browses():
		return _failed("pairing-code-failed")
	# A code whose dials are spent answers at once and browses nothing; a QR is never limited.
	if _nameplate != "" and not bool(_budget.check(_nameplate, _mono())["allowed"]):
		_plan.start_spent()
		return _failed("pairing-code-failed")
	await _prepare_qr()
	if not _done:
		_start_browse()
	while not _done:
		await _src.tree.process_frame
		_step()
	return _result


## A QR's generator is made before anything is dialled.
func _prepare_qr() -> void:
	if _qr_instance == "":
		return
	var sid: Variant = PKeyConnectLocalCommon.sid_of(_qr_instance)
	if sid == null:
		_failed("pairing-code-failed")
		return
	var prs := PKeyPeerCpace.prs_qr(_qr_secret)
	var ci := _ci
	var gen: Variant = await _offload(
		func() -> Variant: return PKeyPeerCpace.generator(prs, ci, sid)
	)
	prs.fill(0)
	if not _done:
		_qr_gen = gen


func _start_browse() -> void:
	var epoch := PKeyPeerAdvert.advert_epoch(int(_src.now.call()))
	var tags := [
		PKeyPeerAdvert.product_tag(_src.slug, epoch),
		PKeyPeerAdvert.product_tag(_src.slug, epoch - 1)
	]
	var mdns := _o["mdns"] as Object
	var b: PKeyResult = mdns.call(
		"browse",
		Callable(self, "_found").bind(tags),
		Callable(self, "_gone"),
		Callable(self, "_accepts"),
		{"q": tags}
	)
	if not b.ok:
		_finish(b)
		return
	_browse = b.detail
	_deadline = (
		_mono()
		+ minf(
			float(_o.get("browse_seconds", PKeyPeerLocal.LOCAL_JOIN_BROWSE_SECONDS)),
			float(PKeyPeerLocal.LOCAL_JOIN_BROWSE_SECONDS)
		)
	)


## A native lane filters on the tags; the shared lane admits any well-formed name and the TXT is judged here.
func _accepts(_instance: String) -> bool:
	return true


func _step() -> void:
	if _done:
		return
	if not _browse_over and _mono() >= _deadline:
		_browse_over = true
		_stop_browse()
		_maybe_end()
	_pump()


func _stop_browse() -> void:
	if _browse != null:
		_browse.call("stop")
		_browse = null


## The error of a code that did not work, with the plan's reason; or of no device found.
func _failed(code: String) -> PKeyResult:
	if code == "pairing-not-found":
		_finish(PKeyConnectLocalCommon.not_found())
	else:
		var reason := _plan.reason()
		_finish(PKeyConnectLocalCommon.code_failed(reason if reason != "" else "wrong"))
	return _result


## Browse over and nothing is dialling: the answer is the plan's.
func _maybe_end() -> void:
	if _done or _busy or not _browse_over:
		return
	_failed("pairing-not-found" if _plan.result() == "pairing-not-found" else "pairing-code-failed")


func _found(f: Dictionary, tags: Array) -> void:
	if _done or _browse_over:
		return
	var txt := PKeyPeerAdvert.parse_txt(f.get("txt", []))
	if not txt["ok"] or txt["mode"] != "q":
		return
	var hosts: Array = []
	for h in f.get("hosts", [f.get("host", "")]):
		if h is String and _gate.dialable(h) and not hosts.has(h):
			hosts.append(h)
	var native := bool(f.get("native", false))
	if hosts.is_empty() and not native:
		return
	var instance := str(f.get("instance", ""))
	if _plan.see(instance, tags.has(txt["h"]), str(txt["n"])):
		_cands[instance] = {
			"instance": instance, "hosts": hosts, "port": int(f.get("port", 0)), "native": native
		}
	_pump()


func _gone(instance: String) -> void:
	_cands.erase(instance)


func _pump() -> void:
	if _done or _busy:
		return
	var name := _plan.next()
	if name == "":
		_maybe_end()
		return
	var c: Variant = _cands.get(name)
	if c == null:
		return
	if not bool(_src.allowed.call()):
		cancel()
		return
	_busy = true
	await _dial(name, c)
	_busy = false
	# No dial is left: the answer is the plan's, without waiting out the browse. A QR names one instance, so one dial
	# is all there can be.
	if _dials >= PKeyPeerLocal.LOCAL_JOIN_CANDIDATES or _qr_instance != "":
		_browse_over = true
		_stop_browse()
	_maybe_end()


## One dial. It ends the plan's turn as `before-c2`, `after-c2` or `transport`.
func _dial(instance: String, c: Dictionary) -> void:
	_dials += 1
	var t := _mono()
	if _nameplate != "":
		# Spent when the dial is made, so joins that overlap cannot multiply the dials.
		if not bool(_budget.check(_nameplate, t)["allowed"]):
			_plan.ended("budget")
			_browse_over = true
			return
		_budget.spend(_nameplate, t, 1)
	var sid: Variant = PKeyConnectLocalCommon.sid_of(instance)
	if sid == null:
		_plan.ended("before-c2")
		return
	var keys: Dictionary = await _first_move(sid, c)
	if keys.is_empty():
		return
	var pipe: PKeyPeerPipe = keys["pipe"]
	var at: float = keys["at"]
	var reply: Variant = await _read_c2(pipe, at)
	if reply == null:
		pipe.abort()
		_plan.ended("before-c2")
		return
	var y: PackedByteArray = keys["y"]
	var ya: PackedByteArray = keys["ya"]
	var isk: Variant = await _offload(
		func() -> Variant: return PKeyPeerCpace.isk(sid, y, ya, reply, "initiator")
	)
	if isk == null or _done:
		pipe.abort()
		if not _done:
			_plan.ended("before-c2")
		return
	_keep(isk)
	var psk := PKeyPeerCpace.psk(isk, _src.slug)
	_keep(psk)
	var held_r := _src.store.count()
	var held: int = held_r.detail if held_r.ok else PKeyPeerLocal.MAX_LOCAL_LINKS
	await _session(pipe, psk, isk, held, _mono() - at)


## The generator, the scalar and the share, then the connection and C1. {pipe, at, y, ya}, or {} when the dial ended
## (the plan has been told, or the join is over).
func _first_move(sid: PackedByteArray, c: Dictionary) -> Dictionary:
	# A typed code's map runs now, once per dial and at most twice per code in 300 s.
	var gen := _qr_gen
	if _qr_gen.is_empty():
		var prs := PKeyPeerCpace.prs_code(_password)
		var ci := _ci
		var made: Variant = await _offload(
			func() -> Variant: return PKeyPeerCpace.generator(prs, ci, sid)
		)
		prs.fill(0)
		gen = made if made is PackedByteArray else PackedByteArray()
		_keep(gen)
	var y := PKeyPeerCpace.scalar()
	_keep(y)
	var ya: Variant = (
		await _offload(func() -> Variant: return PKeyPeerCpace.share(y, gen)) if not _done else null
	)
	var pipe: PKeyPeerPipe = null
	if ya != null and bool(c.get("native", false)):
		# The OS lane resolves and dials the advert by its name.
		pipe = await _gate.open_native(
			_o["mdns"] as Object, str(c["instance"]), Callable(self, "is_done")
		)
	elif ya != null:
		var won := await _gate.race(c["hosts"], int(c["port"]), Callable(self, "is_done"))
		pipe = won.get("pipe")
	if pipe == null or _done:
		if pipe != null:
			pipe.abort()
		if not _done:
			_plan.ended("before-c2")
		return {}
	_pipe = pipe
	pipe.write(
		PKeyPeerFrame.encode(PKeyPeerCpace.encode_c1("qr" if _qr_instance != "" else "code", ya))
	)
	return {"pipe": pipe, "at": _mono(), "y": y, "ya": ya}


## Read C2 within the attempt's 30 s; null for anything but a valid C2.
func _read_c2(pipe: PKeyPeerPipe, at: float) -> Variant:
	var reader := PKeyPeerFrame.Reader.new()
	while not _done and _mono() - at < PKeyPeerLocalPairing.TRANSPORT_SECONDS:
		pipe.poll()
		var chunk := pipe.read()
		if not chunk.is_empty():
			var cut := reader.push(chunk)
			if not cut["ok"] or (cut["frames"] as Array).size() > 1:
				return null
			if (cut["frames"] as Array).size() == 1:
				var v := PKeyPeerCpace.parse_c2(cut["frames"][0])
				return v.detail["share"] if v.ok else null
		if pipe.is_finished():
			return null
		await _src.tree.process_frame
	return null


func _session(
	pipe: PKeyPeerPipe, psk: PackedByteArray, isk: PackedByteArray, held: int, elapsed: float
) -> void:
	var a := PKeyConnectLocalCommon.Attempt.new()
	_current = a
	a.pipe = pipe
	a.state = "link"
	a.link_key = _random(32)
	var label := str(_o.get("label", ""))
	var pair := {
		"psk": psk, "isk": isk, "held": held, "cats": _cats.duplicate(), "elapsed": elapsed
	}
	if label != "":
		pair["label"] = label
	var so := {
		"mode": "q",
		"role": "initiator",
		"slug": _src.slug,
		"static_key": a.link_key,
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
		pipe, so, {"pump": _src.pump, "handshake_ms": int(seconds * 1000.0)}
	)
	if not lr.ok:
		pipe.abort()
		_plan.ended("after-c2")
		a.wipe()
		return
	a.link = lr.detail
	a.link.established.connect(_on_established)
	a.link.local_link.connect(_on_local_link)
	a.link.closed.connect(_on_closed)
	_src.pump.add(a.link)
	await a.link.start()
	while not a.closed:
		await _src.tree.process_frame
	_current = null


func _on_established(info: Dictionary) -> void:
	var a := _current
	if a == null:
		return
	a.up = true
	# The first session that reaches the transport ends the dial.
	_plan.ended("transport")
	a.hello = (info.get("hello", {}) as Dictionary).duplicate()
	a.shown = true
	if not _done:
		(_o["on_confirm"] as Callable).call(PKeyConnectLocalCommon.Offer.new(a, _cats))


func _on_local_link(info: Dictionary) -> void:
	var a := _current
	if a != null:
		_finish(PKeyConnectLocalCommon.store_link(_src, a, info))


func _on_closed(code: StringName, by_peer: bool) -> void:
	var a := _current
	if a == null or a.closed:
		return
	a.closed = true
	a.closed_code = code
	a.wipe()
	a.ended.emit(code, by_peer)
	if not a.up:
		_plan.ended("after-c2")
	if not a.linked and not _done and a.up:
		if a.failure == "full":
			_finish(PKeyConnectLocalCommon.full())
		else:
			# This person said no, or the other device did (a `peer_bye` before any link was exchanged).
			var reason := (
				"declined"
				if a.declined or (by_peer and code == PKeyPeerSession.PEER_BYE)
				else ("timeout" if code == PKeyPeerSession.PEER_TIMEOUT else "closed")
			)
			_finish(
				PKeyConnectLocalCommon.peer_closed(
					reason,
					(
						"The pairing was declined."
						if reason == "declined"
						else "The pairing ended before it finished."
					)
				)
			)


## Hold a secret until the join ends; one made after it ended is wiped at once.
func _keep(secret: PackedByteArray) -> void:
	if _done:
		secret.fill(0)
	else:
		_secrets.append(secret)


func _finish(res: PKeyResult) -> void:
	if _done:
		return
	_done = true
	_result = res
	_stop_browse()
	_qr_secret.fill(0)
	_qr_gen.fill(0)
	for i in _secrets.size():
		var zeros := PackedByteArray()
		zeros.resize((_secrets[i] as PackedByteArray).size())
		_secrets[i] = zeros
	_secrets = []
	if not res.ok:
		# A connection still in flight is closed; a stored link has closed itself.
		var a := _current
		if a != null and a.link != null and not a.linked and not a.closed:
			a.link.close(PKeyPeerSession.PEER_BYE)
		elif _pipe != null and a == null:
			_pipe.abort()
