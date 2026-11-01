extends RefCounted
# @pkey-feature identity.nearby
# The requester half of nearby approval (PKeyPeerNearbyRequester, WIRE-CONTRACT-V5 section 15.6.1),
# against approver sessions over in-memory pipes and a fake discovery lane: the request, label and
# lifetime checks, the tags handed to the lane (and handed again at an epoch change), the browse hits
# it keeps and drops, at most 4 dials picked at random, the list, the choice (the others close before
# any code record), the code, the signed request (and that the approver verifies it only after the
# pick), the display-only result, Sync records held until the person confirms, a decline, a wrong pick,
# the idle replacement, the expiry and the redaction. A native lane (a browse hit with no address) is
# dialled by instance name.

const SLUG := PKeyTestPeers.SLUG
const REQUEST := "nr_AAAAAAAAAAAAAAAAAAAAAA"
const DEVICE := "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"

var _tree: SceneTree
var _clock := Clock.new()
var _pump: PKeyPeerPump
var _approvers: Dictionary = {}
var _dials: Array = []


## The test clock: monotonic seconds and the epoch seconds, both moved by the test.
class Clock extends RefCounted:
	var t := 0.0


	func mono() -> float:
		return t


	func now() -> int:
		return PKeyTestPeers.NOW + int(t)


## A discovery lane that records what it was asked and lets the test push hits.
class Lane extends RefCounted:
	var on_up: Callable
	var on_down: Callable
	var accept: Callable
	var tags: Dictionary = {}
	var tag_sets: Array = []
	var stopped := false
	var caps := {"slots": true, "tags": true}


	func capabilities() -> Dictionary:
		return caps


	func browse(p_up: Callable, p_down := Callable(), p_accept := Callable(), p_tags := {}) -> PKeyResult:
		on_up = p_up
		on_down = p_down
		accept = p_accept
		tags = p_tags
		return PKeyResult.success(Handle.new(self))


	func set_tags(p_tags: Dictionary) -> bool:
		tag_sets.append(p_tags)
		return true


	func hit(instance: String, txt: Array, hosts := ["127.0.0.1"], native := false) -> void:
		on_up.call({"instance": instance, "host": hosts[0] if not hosts.is_empty() else "", "hosts": hosts, "port": 50000, "txt": txt, "native": native})


	class Handle extends RefCounted:
		var _lane: Lane


		func _init(lane: Lane) -> void:
			_lane = lane


		func stop() -> void:
			_lane.stopped = true


## A lane that filters natively and dials by instance name.
class NativeLane extends Lane:
	var dialled: Array = []
	var make_pipe: Callable


	func set_accepted(_names: Array) -> bool:
		return true


	func dial(instance: String) -> PKeyPeerPipe:
		dialled.append(instance)
		return make_pipe.call(instance)


## A pipe that reports itself connected, like the Apple lane's.
class NativePipe extends PKeyPeerMemoryPipe:
	func is_connected_native() -> bool:
		return true


## The approver's end: a mode-v responder link that records what it saw.
class Approver extends RefCounted:
	var link: PKeyPeerLink
	var hello: Dictionary = {}
	var established := false
	var sas_code := -1
	var records: Array = []
	var closes: Array = []
	var verifies := 0
	var request: Variant = null


	func on_established(info: Dictionary) -> void:
		established = true
		hello = info["hello"]


	func on_sas(code: int, _display: String) -> void:
		sas_code = code


	func on_record(record_type: int, body: PackedByteArray) -> void:
		records.append({"type": record_type, "body": body})


	func on_closed(code: StringName, by_peer: bool) -> void:
		closes.append([code, by_peer])


	func requests() -> Array:
		return records.filter(func(r: Dictionary) -> bool: return r["type"] == PKeyPeerRecord.VOUCH_REQ)


## What a requester reported, collected from its signals.
class Seen extends RefCounted:
	var lists: Array = []
	var results: Array = []
	var recs: Array = []
	var ends: Array = []


	func on_list(list: Array) -> void:
		lists.append(list)


	func on_result(status: String) -> void:
		results.append(status)


	func on_record(record_type: int, body: PackedByteArray) -> void:
		recs.append([record_type, body])


	func on_closed(code: StringName) -> void:
		ends.append(code)


func run(t: PKeyTestContext) -> void:
	_tree = Engine.get_main_loop() as SceneTree
	_pump = PKeyPeerPump.new(_tree, false)
	await _start_checks(t)
	await _tags_and_hits(t)
	await _happy(t)
	await _wrong_pick_and_decline(t)
	await _dials_and_clocks(t)
	await _native(t)
	await _ends(t)


# -- helpers -------------------------------------------------------------------------------------

func _source() -> Dictionary:
	return {"slug": SLUG, "now": Callable(_clock, "now"), "signer": Callable(self, "_signer")}


func _signer() -> PKeyResult:
	return PKeyResult.success({"port": PKeyDeviceKeyStore.memory_only(), "device_id": DEVICE})


func _options(lane: Object, extra := {}) -> Dictionary:
	var o := {
		"request": REQUEST, "label": "Living room", "mdns": lane, "pump": _pump, "tree": _tree, "drive": false,
		"allow_loopback": true, "mono": Callable(_clock, "mono"), "dial": Callable(self, "_dial"),
	}
	for k in extra:
		o[k] = extra[k]
	return o


static func _name(i: int) -> String:
	return "p1-" + "abcdefghij"[i].repeat(16)


func _tag(back := 0) -> String:
	return PKeyPeerAdvert.product_tag(SLUG, PKeyPeerAdvert.advert_epoch(_clock.now()) - back)


func _txt(h: String, m := "v") -> Array:
	return ["v=1", "m=" + m, "h=" + h]


## The test's dial: records the candidate and gives the requester one end of a memory pipe, with an
## approver on the other.
func _dial(c: Dictionary) -> PKeyPeerPipe:
	_dials.append(c["instance"])
	return _approver_pipe(str(c["instance"]))


func _approver_pipe(instance: String) -> PKeyPeerPipe:
	var ends := PKeyPeerMemoryPipe.pair()
	var a := Approver.new()
	var idx := "abcdefghij".find(instance.substr(3, 1))
	var so := {
		"mode": "v", "role": "responder", "slug": SLUG, "static_key": PKeyTestPeers.random32(), "caps": [],
		"hello": {"label": "Phone %d" % idx, "platform": "ios", "app": "demo"},
		"now": Callable(_clock, "now"), "mono": Callable(_clock, "mono"),
		"admission": PKeyPeerLimiter.new(5, 4, Callable(_clock, "mono")),
	}
	var made := PKeyPeerLink.create(ends[1], so, {"pump": _pump, "mono_ms": func() -> int: return int(_clock.t * 1000.0)})
	a.link = made.detail
	a.link.established.connect(a.on_established)
	a.link.sas.connect(a.on_sas)
	a.link.record.connect(a.on_record)
	a.link.closed.connect(a.on_closed)
	_approvers[instance] = a
	_pump.add(a.link)
	return ends[0]


## Wait for `cond` for up to `frames` frames and at least 8 s of wall clock (a loaded machine is slow).
func _until(cond: Callable, frames := 400) -> bool:
	var stop := Time.get_ticks_msec() + 8000
	var n := 0
	while not bool(cond.call()) and (n < frames or Time.get_ticks_msec() < stop):
		n += 1
		await _tree.process_frame
		if frames <= 20 and n >= frames:
			break
	return bool(cond.call())


func _begin(t: PKeyTestContext, lane: Lane, extra := {}) -> PKeyPeerNearbyRequester:
	_approvers.clear()
	_dials.clear()
	var r: PKeyResult = await PKeyPeerNearbyRequester.start(_source(), _options(lane, extra))
	if not t.check("start answers ok", r.ok, str(r.detail)):
		return null
	return r.detail


func _watch(r: PKeyPeerNearbyRequester) -> Seen:
	var s := Seen.new()
	r.approvers_changed.connect(s.on_list)
	r.result.connect(s.on_result)
	r.record.connect(s.on_record)
	r.closed.connect(s.on_closed)
	return s


# -- the checks at the start and the tags ----------------------------------------------------------

func _start_checks(t: PKeyTestContext) -> void:
	var lane := Lane.new()
	for bad: Dictionary in [
		{"request": "nr_short"}, {"request": "xx_AAAAAAAAAAAAAAAAAAAAAA"}, {"label": "x".repeat(257)},
		{"expires_in": 0}, {"expires_in": -5}, {"expires_in": NAN}, {"expires_in": "300"},
	]:
		var r: PKeyResult = await PKeyPeerNearbyRequester.start(_source(), _options(lane, bad))
		t.check("start refuses %s" % str(bad.keys()[0]), not r.ok and r.code == PKeyConstants.ErrorCode.INVALID_OPTIONS and lane.on_up == Callable(), str(bad))
	var no_signer := _source()
	no_signer.erase("signer")
	var bad_source: PKeyResult = await PKeyPeerNearbyRequester.start(no_signer, _options(lane))
	t.check("start refuses a source with no signer", not bad_source.ok)
	var old := Lane.new()
	old.caps = {"slots": false, "tags": false}
	var unsupported: PKeyResult = await PKeyPeerNearbyRequester.start(_source(), _options(old))
	t.check("an older native binding answers nearby-unsupported", not unsupported.ok and unsupported.code == PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED and old.on_up == Callable())
	var long: PKeyResult = await PKeyPeerNearbyRequester.start(_source(), _options(lane, {"expires_in": 1000}))
	t.check("a long lifetime is accepted and cut to 300 s", long.ok)
	if long.ok:
		(long.detail as PKeyPeerNearbyRequester).close()
	var r := await _begin(t, Lane.new())
	r.close()


func _tags_and_hits(t: PKeyTestContext) -> void:
	_clock.t = 0.0
	var lane := Lane.new()
	var r := await _begin(t, lane)
	t.check("the browse gets the tags of this epoch and the last", lane.tags == {"v": [_tag(), _tag(1)]} and lane.tags["v"][0] != lane.tags["v"][1])
	t.check("the shared lane admits any name; the TXT is judged here", bool(lane.accept.call(_name(0))))
	for h in [_tag(), _tag(1)]:
		lane.hit(_name(0), _txt(h))
		lane.on_down.call(_name(0))
	t.check("both tags are dialled", _dials.size() == 1 or _dials.size() == 2)
	_dials.clear()
	_approvers.clear()
	r.close()
	r = await _begin(t, lane)
	lane.hit(_name(1), _txt("0123456789abcdef"))
	lane.hit(_name(2), _txt(_tag(), "p"))
	lane.hit(_name(3), _txt(_tag(), "a"))
	lane.hit(_name(4), ["v=2", "m=v", "h=" + _tag()])
	lane.hit(_name(5), ["v=1", "m=v"])
	lane.hit(_name(6), _txt(_tag()), ["8.8.8.8"])
	lane.hit(_name(7), _txt(_tag()), [])
	lane.hit(_name(8), _txt(_tag()), ["169.254.1.1", "fe80::1"])
	await _tree.process_frame
	t.check("other tags, modes, versions, public and link-local addresses are never dialled", _dials.is_empty(), str(_dials))
	lane.hit(_name(9), _txt(_tag(1)))
	t.check("the previous epoch's tag is dialled", await _until(func() -> bool: return _dials == [_name(9)]))
	r.close()
	# The epoch changes under a running request: the lane gets the new tags.
	_clock.t = 700.0
	var r2 := await _begin(t, lane)
	_clock.t = 800.0
	r2.tick()
	t.check("inside the epoch the tags stay", lane.tag_sets.is_empty())
	_clock.t = 901.0
	r2.tick()
	t.check("a new epoch hands the lane new tags", lane.tag_sets.size() == 1 and lane.tag_sets[0] == {"v": [_tag(), _tag(1)]})
	r2.close()
	_clock.t = 0.0


# -- the happy path ---------------------------------------------------------------------------------

func _happy(t: PKeyTestContext) -> void:
	_clock.t = 0.0
	var lane := Lane.new()
	var r := await _begin(t, lane)
	var seen := _watch(r)
	lane.hit(_name(0), _txt(_tag()))
	lane.hit(_name(1), _txt(_tag()))
	var listed := await _until(func() -> bool: return r.approvers().size() == 2)
	t.check("both approvers are listed by label and platform", listed)
	var list := r.approvers()
	var labels := list.map(func(a: Dictionary) -> String: return str(a["label"]))
	labels.sort()
	t.check("the list shows the cleaned label and the platform only", labels == ["Phone 0", "Phone 1"] and list[0]["platform"] == "ios" and list[0].keys().size() == 3)
	t.check("the list was announced", not seen.lists.is_empty())
	# The two sessions stopped after HELLO: no code record on either.
	t.check("no session started a code before the choice", _approvers[_name(0)].sas_code == -1 and _approvers[_name(1)].sas_code == -1)
	var chosen: Dictionary = list[0]
	var which: String = _name(0) if chosen["label"] == "Phone 0" else _name(1)
	var other: String = _name(1) if which == _name(0) else _name(0)
	var m: Approver = _approvers[which]
	var o: Approver = _approvers[other]
	var picked: Array = [null]
	var go := func() -> void: picked[0] = await r.choose(chosen["id"])
	go.call()
	var shown := await _until(func() -> bool: return m.sas_code >= 0 and picked[0] != null)
	t.check("choose answers D's code", shown and picked[0].ok and picked[0].detail["code"] is String and (picked[0].detail["code"] as String).length() == 7, str(picked[0]))
	t.check("both screens show the same code", m.sas_code >= 0 and PKeyPeerSas.display(m.sas_code) == picked[0].detail["code"])
	t.check("the list is over once the person chose", r.approvers().is_empty() and seen.lists.back() == [])
	await _until(func() -> bool: return not o.closes.is_empty())
	t.check("the other approver closed peer_bye and never saw a code record", o.closes == [[&"peer_bye", true]] and o.sas_code == -1)
	t.check("the chosen approver holds the request until the pick", await _until(func() -> bool: return m.link.session.is_open() == false and m.records.is_empty(), 20))
	# M: its screen shows the codes, the person picks the right one, the request verifies.
	m.link.session.vouch().shown()
	m.link.session.confirm_sas()
	t.check("D's request waits for the approver's pick", m.requests().is_empty())
	m.link.session.vouch().picked()
	t.check("the pick delivers one request", await _until(func() -> bool: return m.requests().size() == 1))
	var body: PackedByteArray = m.requests()[0]["body"]
	var counter := func(sig: PackedByteArray, msg: PackedByteArray, key: PackedByteArray) -> bool:
		m.verifies += 1
		return PKeyEd25519.verify(sig, msg, key)
	var verified: Variant = PKeyPeerVouch.verify_request({
		"slug": SLUG, "h": m.link.session.handshake_hash(), "hello": m.hello, "hello_cleaned": true, "body": body, "verify": counter,
	})
	t.check("the request verifies once, under this session's h", verified is Dictionary and m.verifies == 1)
	t.check("it names the handle, D's device and the label D showed", verified is Dictionary and verified["request"] == REQUEST and verified["device_id"] == DEVICE and verified["label"] == "Living room")
	t.check("the request is no more than 4 KiB and never in a notice", body.size() <= 4096 and not str(r).contains(REQUEST))
	m.link.session.vouch().verified()
	t.check("the approver may finish", m.link.session.vouch().may_finish())
	m.link.send_record(PKeyPeerRecord.VOUCH_RESULT, PKeyPeerVouch.build_result("approved"))
	m.link.send_record(PKeyPeerRecord.KEYRING_WRAP, PackedByteArray([1, 2, 3, 4]))
	t.check("the result arrives for display", await _until(func() -> bool: return seen.results == ["approved"]) and r.get_result() == "approved")
	t.check("a Sync record is held until the person confirms", seen.recs.is_empty())
	t.check("confirm_account answers ok", r.confirm_account().ok)
	t.check("the held record is delivered at the confirmation, once", seen.recs.size() == 1 and seen.recs[0][0] == PKeyPeerRecord.KEYRING_WRAP)
	m.link.send_record(PKeyPeerRecord.KEYRING_WRAP, PackedByteArray([5]))
	t.check("a record after the confirmation goes straight through", await _until(func() -> bool: return seen.recs.size() == 2))
	var again := await r.choose(chosen["id"])
	t.check("once answered, no approver can be chosen", not again.ok)
	var count := _dials.size()
	lane.hit(_name(5), _txt(_tag()))
	await _tree.process_frame
	t.check("and none is dialled", _dials.size() == count)
	r.close()
	await _until(func() -> bool: return not m.closes.is_empty())
	t.check("close ends the chosen session peer_bye", m.closes.back()[0] == &"peer_bye")
	t.check("one closed signal for the end", seen.ends == [&"peer_bye"], str(seen.ends))
	t.check("the lane's browse stopped", lane.stopped)


func _five(n: int) -> PackedByteArray:
	return PackedByteArray([0, 0, 0, 5]).slice(0, n)


func _choose_first(r: PKeyPeerNearbyRequester, out: Array) -> void:
	out[0] = await r.choose(r.approvers()[0]["id"])


# -- a wrong pick, a decline, a denial ----------------------------------------------------------------

func _wrong_pick_and_decline(t: PKeyTestContext) -> void:
	_clock.t = 0.0
	var lane := Lane.new()
	var r := await _begin(t, lane)
	var seen := _watch(r)
	lane.hit(_name(0), _txt(_tag()))
	await _until(func() -> bool: return r.approvers().size() == 1)
	var m: Approver = _approvers[_name(0)]
	var out: Array = [null]
	_choose_first(r, out)
	await _until(func() -> bool: return out[0] != null)
	await _until(func() -> bool: return m.sas_code >= 0)
	m.link.session.vouch().shown()
	m.link.session.confirm_sas()
	# A wrong pick: the approver abandons; nothing is delivered and D's session ends.
	m.link.session.vouch().abandon("wrong-pick")
	t.check("a wrong pick: no request was delivered, and the approver cannot finish", m.requests().is_empty() and not m.link.session.vouch().may_finish())
	t.check("D's chosen session ends and the closed signal says peer_bye", await _until(func() -> bool: return seen.ends == [&"peer_bye"]))
	t.check("no result, no answer", r.get_result() == "")
	r.close()

	# A decline of the account drops the held records and closes the session.
	var r2 := await _begin(t, lane)
	var seen2 := _watch(r2)
	lane.hit(_name(1), _txt(_tag()))
	await _until(func() -> bool: return r2.approvers().size() == 1)
	var m2: Approver = _approvers[_name(1)]
	out = [null]
	_choose_first(r2, out)
	await _until(func() -> bool: return out[0] != null and m2.sas_code >= 0)
	m2.link.session.vouch().shown()
	m2.link.session.confirm_sas()
	m2.link.session.vouch().picked()
	await _until(func() -> bool: return m2.requests().size() == 1)
	m2.link.session.vouch().verified()
	m2.link.send_record(PKeyPeerRecord.VOUCH_RESULT, PKeyPeerVouch.build_result("denied"))
	t.check("a denial reads as denied", await _until(func() -> bool: return seen2.results == ["denied"]))
	m2.link.send_record(PKeyPeerRecord.VOUCH_RESULT, PKeyPeerVouch.build_result("approved"))
	await _until(func() -> bool: return m2.link.session.is_closed() or r2.is_closed(), 20)
	r2.close()
	t.check("no Sync record reached the host without a confirmation", seen2.recs.is_empty())

	# decline_account after an approval: held records are dropped and the session ends.
	var r3 := await _begin(t, lane)
	var seen3 := _watch(r3)
	lane.hit(_name(2), _txt(_tag()))
	await _until(func() -> bool: return r3.approvers().size() == 1)
	var m3: Approver = _approvers[_name(2)]
	out = [null]
	_choose_first(r3, out)
	await _until(func() -> bool: return out[0] != null and m3.sas_code >= 0)
	m3.link.session.vouch().shown()
	m3.link.session.confirm_sas()
	m3.link.session.vouch().picked()
	await _until(func() -> bool: return m3.requests().size() == 1)
	m3.link.session.vouch().verified()
	m3.link.send_record(PKeyPeerRecord.VOUCH_RESULT, PKeyPeerVouch.build_result("approved"))
	m3.link.send_record(PKeyPeerRecord.KEYRING_WRAP, PackedByteArray([9, 9]))
	await _until(func() -> bool: return seen3.results == ["approved"])
	r3.decline_account()
	var ended3 := await _until(func() -> bool: return not seen3.ends.is_empty())
	t.check("a decline drops the held records and ends the session", ended3 and seen3.ends == [&"peer_bye"] and seen3.recs.is_empty(), str(seen3.ends))
	t.check("a decline is not a confirmation", not r3.confirm_account().ok)
	r3.close()
	var none := await _begin(t, lane)
	t.check("confirm_account before a choice is refused", not none.confirm_account().ok)
	none.close()


# -- the dials and the clocks -----------------------------------------------------------------------------

func _dials_and_clocks(t: PKeyTestContext) -> void:
	_clock.t = 0.0
	var lane := Lane.new()
	var held: Array = []
	var stuck := func(c: Dictionary) -> PKeyPeerPipe:
		_dials.append(c["instance"])
		held.append(c["instance"])
		return null
	# A random draw of 5 over 6 candidates picks the sixth first: never arrival order.
	var r := await _begin(t, lane, {"dial": stuck, "random": Callable(self, "_five")})
	for i in 6:
		r._candidates[_name(i)] = {"instance": _name(i), "hosts": ["127.0.0.1"], "port": 50000, "native": false, "tries": 0}
	r._dial_more()
	t.check("the first dial is the random pick, not the first arrival", not _dials.is_empty() and _dials[0] == _name(5), str(_dials))
	r.close()

	# At most 4 dials in flight: a dial that never returns holds its slot.
	var release := [false]
	var pending := func(c: Dictionary) -> PKeyPeerPipe:
		_dials.append(c["instance"])
		while not release[0]:
			await _tree.process_frame
		return null
	var r2 := await _begin(t, lane, {"dial": pending})
	for i in 7:
		lane.hit(_name(i), _txt(_tag()))
	await _tree.process_frame
	t.check("at most 4 approvers are dialled at once", _dials.size() == 4, str(_dials.size()))
	r2.close()
	# Let the held dials return, so none resumes after this test is gone.
	release[0] = true
	await _tree.process_frame
	await _tree.process_frame

	# Three tries per advert, a pause between them.
	var r3 := await _begin(t, lane, {"dial": stuck})
	held.clear()
	lane.hit(_name(0), _txt(_tag()))
	for i in 6:
		_clock.t += 1.0
		r3.tick()
		await _tree.process_frame
	t.check("an advert is tried three times, then left", held.size() == 3, str(held.size()))
	r3.close()

	# A held session nobody chose is replaced after 20 s and gets its try back.
	_clock.t = 0.0
	var r4 := await _begin(t, lane)
	var seen4 := _watch(r4)
	lane.hit(_name(0), _txt(_tag()))
	await _until(func() -> bool: return r4.approvers().size() == 1)
	_clock.t = 19.0
	r4.tick()
	t.check("a session is kept under 20 s", r4.approvers().size() == 1)
	_clock.t = 21.0
	r4.tick()
	var m4: Approver = _approvers[_name(0)]
	var dropped := await _until(func() -> bool: return r4.approvers().is_empty() and not m4.closes.is_empty())
	t.check("past 20 s it is closed peer_bye and dropped from the list", dropped and m4.closes[0][0] == &"peer_bye")
	t.check("the replacement is dialled again", await _until(func() -> bool: _clock.t += 0.3; r4.tick(); return _dials.size() == 2), str(_dials.size()))
	t.check("the idle close is not the chosen session's end", seen4.ends.is_empty())
	r4.close()

	# The request ends at expires_in: a closed signal, sessions closed, the browse stopped.
	_clock.t = 0.0
	var lane5 := Lane.new()
	var r5 := await _begin(t, lane5, {"expires_in": 10})
	var seen5 := _watch(r5)
	lane5.hit(_name(0), _txt(_tag()))
	await _until(func() -> bool: return r5.approvers().size() == 1)
	_clock.t = 9.0
	r5.tick()
	t.check("before the lifetime ends it runs on", not r5.is_closed())
	_clock.t = 10.0
	r5.tick()
	t.check("at expires_in the request ends: expired, browse stopped, sessions bye", r5.is_closed() and seen5.ends == [&"expired"] and lane5.stopped)
	t.check("the approver's session closed peer_bye", await _until(func() -> bool: return not _approvers[_name(0)].closes.is_empty()) and _approvers[_name(0)].closes[0][0] == &"peer_bye")
	lane5.hit(_name(1), _txt(_tag()))
	t.check("a late hit dials nothing", _dials.size() == 1)
	r5.close()
	t.check("closing again says nothing more", seen5.ends == [&"expired"])

	# A full candidate table gives a stale place up to a fresh advert, and holds a fresh one.
	_clock.t = 0.0
	var lane6 := Lane.new()
	var r6 := await _begin(t, lane6, {"dial": stuck})
	for i in PKeyPeerNearbyRequester.MAX_CANDIDATES:
		var key := "p1-x%015d" % i
		r6._candidates[key] = {"instance": key, "hosts": [], "port": 1, "native": true, "tries": 3, "seen": 0.0}
	var full: int = r6._candidates.size()
	_clock.t = 10.0
	lane6.hit(_name(1), _txt(_tag()))
	t.check("a fresh table keeps its candidates: a new advert is not listed", r6._candidates.size() == full and not r6._candidates.has(_name(1)))
	_clock.t = PKeyPeerNearbyRequester.CANDIDATE_TTL_SECONDS + 5.0
	lane6.hit(_name(1), _txt(_tag()))
	t.check("a stale candidate gives its place to a new advert", r6._candidates.has(_name(1)) and r6._candidates.size() == full)
	r6.close()


# -- a native lane --------------------------------------------------------------------------------------

func _native(t: PKeyTestContext) -> void:
	_clock.t = 0.0
	var lane := NativeLane.new()
	lane.make_pipe = func(instance: String) -> PKeyPeerPipe:
		var ends := PKeyPeerMemoryPipe.pair()
		var a := Approver.new()
		var so := {
			"mode": "v", "role": "responder", "slug": SLUG, "static_key": PKeyTestPeers.random32(), "caps": [],
			"hello": {"platform": "android", "app": "demo"}, "now": Callable(_clock, "now"), "mono": Callable(_clock, "mono"),
			"admission": PKeyPeerLimiter.new(5, 4, Callable(_clock, "mono")),
		}
		a.link = PKeyPeerLink.create(NativePipe.new(ends[1]._shared, 1), so, {"pump": _pump}).detail
		a.link.established.connect(a.on_established)
		a.link.closed.connect(a.on_closed)
		_approvers[instance] = a
		_pump.add(a.link)
		return NativePipe.new(ends[0]._shared, 0)
	_approvers.clear()
	var r: PKeyResult = await PKeyPeerNearbyRequester.start(_source(), _options(lane, {"dial": Callable(), "label": null}))
	if not t.check("a native lane starts", r.ok):
		return
	var req: PKeyPeerNearbyRequester = r.detail
	t.check("a native lane filters on the tags: the name list refuses every name", not bool(lane.accept.call(_name(0))) and lane.tags == {"v": [_tag(), _tag(1)]})
	lane.hit(_name(0), _txt(_tag()), [], true)
	t.check("a native hit needs no address and is dialled by instance name", await _until(func() -> bool: return lane.dialled == [_name(0)] and req.approvers().size() == 1))
	t.check("a missing label is listed as none", req.approvers()[0]["label"] == null and req.approvers()[0]["platform"] == "android")
	req.close()


# -- the end and the redaction ---------------------------------------------------------------------------

func _ends(t: PKeyTestContext) -> void:
	_clock.t = 0.0
	var lane := Lane.new()
	var r := await _begin(t, lane)
	var seen := _watch(r)
	lane.hit(_name(0), _txt(_tag()))
	await _until(func() -> bool: return r.approvers().size() == 1)
	r.close()
	t.check("closing before a choice says nothing to the host", seen.ends.is_empty() and r.is_closed())
	var c := await r.choose("ap_000000000000")
	t.check("a closed request chooses nobody", not c.ok)
	t.check("str() shows nothing of the request", str(r) == "PKeyPeerNearbyRequester()")
	var r2 := await _begin(t, lane)
	var unknown := await r2.choose("ap_nobody")
	t.check("an unknown approver is refused", not unknown.ok and unknown.detail["reason"] == "unknown_peer")
	r2.destroy()
	t.check("destroy ends the request", r2.is_closed())
