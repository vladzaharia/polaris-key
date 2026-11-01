@tool
class_name PKeyPeerNearbyRequester
extends RefCounted
## The requester half of nearby approval (WIRE-CONTRACT-V5 section 15.6.1; CC-15b.G2b), ported from
## sdk-node `connect/nearbyRequester.ts`. A device with no sign-in (D) browses for approvers, dials a
## few, lists them by their HELLO and lets its person pick one. Only then does the code run on that
## session; the others close `peer_bye` before any code record, so no other approver ever prompts. D
## shows its code, sends `VOUCH_REQ` and reads `VOUCH_RESULT`. It calls no route: the host holds the
## request from `nearby/start` and polls.
##
## Rules this file keeps:
##  - D connects out and never listens. It browses `_pkeypeer._tcp` for `m=v` with the product tag of the
##    current or the previous epoch (handed to the lane as `tags`, and checked again here), and judges
##    every address by the mode-a rule (`PKeyPeerDialRace`);
##  - at most 4 approvers are dialled at once, picked at random and never in arrival order, each with a
##    one-time X25519 key that is wiped when the handshake ends. A session that ends before the choice
##    is replaced while the request lives (3 tries per advert);
##  - every session stops after HELLO (`hold_sas`). The list has at most 8 entries and shows the
##    reported label and platform only; it is never chosen from for the person;
##  - the code on D's screen is D's confirmation; then `VOUCH_REQ` goes out, signed with D's device key
##    off the main thread;
##  - the session's vouch flow holds the Sync records (`0x0030` to `0x003F`, 16 records and 16 KiB)
##    until the person confirms the signed-in account (`confirm_account`, rule 12); a decline or a close
##    drops them all. Nothing here confirms for the person;
##  - a session held and not chosen for 20 s is closed `peer_bye` and replaced;
##  - one answer per request: once `VOUCH_RESULT` said `approved`, or `confirm_account()` ran, no other
##    approver is dialled or chosen;
##  - the request handle and the label are checked at the start; `expires_in` is above 0 and at most
##    300 s. The browse and the wait for `VOUCH_RESULT` end then, and every session closes `peer_bye`.
##    Mode v never uses the relay;
##  - the request handle, `sig`, `h` and the nonces are in no message, log or `str()`.
##
## Use. `PKeyPeerNearbyRequester.start(source, options)` is a coroutine answering a PKeyResult holding the
## request. `source`: {slug, now (Callable() -> epoch seconds), signer (Callable() -> coroutine answering a
## PKeyResult holding {port, device_id}: D's device key store and its `X-PKey-Device` value)}. `options`:
## `request` (the `nr_` handle), `label`, `expires_in`, `mdns` (a lane), `pump`, `tree`, `allow_loopback`,
## `handshake_seconds`, `mono`, `random`, `drive` (false: the host calls `tick()`), and for tests `dial`
## (Callable(candidate) -> a coroutine answering a pipe or null) and `connector` (see PKeyPeerDialRace).
##
## Signals are observers: `approvers_changed(list)` ({id, label, platform} each), `result(status)`
## (display only; the host's poll is the authority), `record(record_type, body)` (Sync records, once the
## account is confirmed) and `closed(code)` (the chosen session ended, or the request expired).

signal approvers_changed(list: Array)
signal result(status: String)
signal record(record_type: int, body: PackedByteArray)
signal closed(code: StringName)

const MAX_DIALS := 4
const MAX_LIST := 8
const MAX_CANDIDATES := 64
const EXPIRES_SECONDS := 300.0
const TRIES_PER_ADVERT := 3
const REDIAL_SECONDS := 0.25
const IDLE_SECONDS := 20.0
const HANDSHAKE_SECONDS := 30.0
const LABEL_MAX := 256
const EXPIRED := &"expired"
const UNKNOWN_PLATFORM := "unknown"

static var _request_re: RegEx

var _src: Dictionary
var _o: Dictionary
var _tree: SceneTree
var _pump: PKeyPeerPump
var _mdns: Object
var _native_filter := false
var _browse: Object
var _signer: Dictionary = {}
var _tags: Array = []
var _epoch := -1
var _candidates: Dictionary = {}
var _entries: Dictionary = {}
var _active: Dictionary = {}
var _chosen: Entry = null
var _result := ""
var _ended := false
## `approved` came, or the account was confirmed: this request has its answer.
var _answered := false
var _expires_at := 0.0
var _redial_at := -1.0
var _driven := false


static func _static_init() -> void:
	_request_re = PKeyClaims.whole("nr_[A-Za-z0-9_-]{22}")


## Start browsing and dialling. The caller holds the request from `nearby/start`. A coroutine.
static func start(source: Dictionary, options := {}) -> PKeyResult:
	var bad := _checked(source, options)
	if bad != null:
		return bad
	var r := PKeyPeerNearbyRequester.new(source, options)
	var signer: Variant = await (source["signer"] as Callable).call()
	if not signer is PKeyResult or not (signer as PKeyResult).ok or not (signer as PKeyResult).detail is Dictionary:
		return signer if signer is PKeyResult and not (signer as PKeyResult).ok else _fail(PKeyConstants.ErrorCode.NOT_CONFIGURED, "no_keys", "This device has no keys.")
	r._signer = (signer as PKeyResult).detail
	var started := r._begin()
	if not started.ok:
		r._stop(&"")
		return started
	return PKeyResult.success(r)


static func _fail(code: String, reason: String, message: String) -> PKeyResult:
	return PKeyResult.failure(code, message, {"reason": reason})


## The request, the label and the lifetime are the host's input: refuse a bad one now, not at the tap.
static func _checked(source: Dictionary, o: Dictionary) -> PKeyResult:
	if not source.get("slug") is String or source["slug"] == "" or not source.get("now") is Callable or not source.get("signer") is Callable:
		return _fail(PKeyConstants.ErrorCode.INVALID_OPTIONS, "bad_input", "Nearby request: bad source.")
	if not PKeyClaims.matches_whole_re(_request_re, o.get("request")):
		return _fail(PKeyConstants.ErrorCode.INVALID_OPTIONS, "bad_input", "The request handle is not valid.")
	var label: Variant = o.get("label")
	if label != null and (not label is String or (label as String).length() > LABEL_MAX):
		return _fail(PKeyConstants.ErrorCode.INVALID_OPTIONS, "bad_input", "The label is not valid.")
	var n: Variant = o.get("expires_in", EXPIRES_SECONDS)
	if not (n is int or n is float) or float(n) <= 0.0 or is_inf(float(n)) or is_nan(float(n)):
		return _fail(PKeyConstants.ErrorCode.INVALID_OPTIONS, "bad_input", "expires_in must be above 0.")
	return null


func _init(source: Dictionary, options: Dictionary) -> void:
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
		_mdns = PKeyMdns.new({"allow_loopback": _loopback(), "tree": _tree})
	_native_filter = _mdns.has_method("set_accepted")
	_expires_at = _mono() + minf(float(options.get("expires_in", EXPIRES_SECONDS)), EXPIRES_SECONDS)


func _to_string() -> String:
	return "PKeyPeerNearbyRequester()"


## The approvers that said HELLO, at most 8: [{id, label (String or null), platform}]. Once the person
## chose, the list is over.
func approvers() -> Array:
	var out: Array = []
	if _chosen != null:
		return out
	for e: Entry in _entries.values():
		if e.hello != null and not e.closed and out.size() < MAX_LIST:
			out.append({"id": e.id, "label": e.hello.get("label"), "platform": str(e.hello.get("platform", ""))})
	return out


## What `VOUCH_RESULT` said ("" before it came). For display only.
func get_result() -> String:
	return _result


func is_closed() -> bool:
	return _ended


## The person tapped this approver. Starts the code on that session only and closes the others `peer_bye`;
## answers {code} (D's code to show, "123 456") once `VOUCH_REQ` has gone. A coroutine.
func choose(id: String) -> PKeyResult:
	var refused := _unchoosable(id)
	if refused != null:
		return refused
	var e: Entry = _entries[id]
	_chosen = e
	# The others close before any code record is sent on them: no other approver ever prompts.
	for other: Entry in _entries.values():
		if other != e:
			other.link.close(PKeyPeerSession.PEER_BYE)
	approvers_changed.emit([])
	e.link.session.start_sas()
	while e.display == "" and not e.closed and not _ended:
		await _tree.process_frame
	var body: Variant = null
	if e.display != "" and not e.closed:
		# Showing the code is D's confirmation; then the request goes to the chosen approver.
		e.link.session.vouch().shown()
		e.link.session.confirm_sas()
		body = await _signed_request(e)
	if body == null or e.closed or not e.link.send_record(PKeyPeerRecord.VOUCH_REQ, body).ok:
		e.link.close(PKeyPeerSession.PEER_BYE)
		return _fail(PKeyConstants.ErrorCode.NETWORK_ERROR, "closed", "The session is closed.")
	return PKeyResult.success({"code": e.display})


## Why `id` cannot be chosen now, or null.
func _unchoosable(id: String) -> PKeyResult:
	if _ended or _answered:
		return _fail(PKeyConstants.ErrorCode.NETWORK_ERROR, "closed", "The request is closed or has its answer.")
	if _chosen != null:
		return _fail(PKeyConstants.ErrorCode.NOT_CONFIGURED, "not_started", "An approver is already chosen.")
	var e: Entry = _entries.get(id)
	if e == null or e.hello == null or e.closed:
		return _fail(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "unknown_peer", "That approver is no longer on the list.")
	return null


## The person confirmed that the signed-in account is theirs: the held Sync records go to `record`. It
## counts for the session that was chosen; it is not a standing consent, and after it (or after
## `approved`) no other approver can be chosen.
func confirm_account() -> PKeyResult:
	if _chosen == null or _chosen.closed:
		return _fail(PKeyConstants.ErrorCode.NOT_CONFIGURED, "not_started", "Nobody is chosen.")
	_answered = true
	_chosen.link.session.vouch().confirm_account()
	return PKeyResult.success()


## The person declined, or the screen timed out: every held record is dropped and the session closes.
func decline_account() -> void:
	if _chosen != null and not _chosen.closed:
		_chosen.link.session.vouch().decline_account()


## End the request: the browse stops and every session closes `peer_bye`.
func close() -> void:
	_stop(&"")


## Drop every socket now, with no goodbye (the sign-out bound's force path).
func destroy() -> void:
	_stop(&"")
	for e: Entry in _entries.values():
		e.link.destroy()


## One round of the clocks: the expiry, the epoch of the tags, idle sessions and the next dials. Called
## every frame unless `drive` is false.
func tick() -> void:
	if _ended:
		return
	var now := _mono()
	if now >= _expires_at:
		_stop(EXPIRED)
		return
	_refresh_tags()
	for e: Entry in _entries.values():
		if e.hello != null and e != _chosen and not e.closed and now - e.since >= IDLE_SECONDS:
			_replace(e)
	if _redial_at >= 0.0 and now >= _redial_at:
		_redial_at = -1.0
		_dial_more()


# -- start ---------------------------------------------------------------------------------------

func _begin() -> PKeyResult:
	if _mdns.has_method("capabilities") and not bool((_mdns.call("capabilities") as Dictionary).get("tags", false)):
		return _fail(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, "unsupported", "Nearby discovery is not available here.")
	_refresh_tags()
	var b: PKeyResult = _mdns.browse(Callable(self, "_found"), Callable(self, "_gone"), Callable(self, "_accepts"), {"v": _tags})
	if not b.ok:
		return b
	_browse = b.detail
	if bool(_o.get("drive", true)) and _tree != null:
		_tree.process_frame.connect(tick)
		_driven = true
	return PKeyResult.success()


func _refresh_tags() -> void:
	var epoch := PKeyPeerAdvert.advert_epoch(int((_src["now"] as Callable).call()))
	if epoch == _epoch:
		return
	var first := _epoch < 0
	_epoch = epoch
	_tags = [PKeyPeerAdvert.product_tag(_src["slug"], epoch), PKeyPeerAdvert.product_tag(_src["slug"], epoch - 1)]
	if not first and _mdns.has_method("set_tags"):
		_mdns.call("set_tags", {"v": _tags})


## A native lane filters on the tags; the shared lane admits any well-formed name and the TXT is judged here.
func _accepts(_instance: String) -> bool:
	return not _native_filter


# -- browse and dial -----------------------------------------------------------------------------

func _found(f: Dictionary) -> void:
	if _ended or _answered or _chosen != null:
		return
	var txt := PKeyPeerAdvert.parse_txt(f.get("txt", []))
	if not txt["ok"] or txt["mode"] != "v":
		return
	# The product tag of this epoch or the last: an advert of another product is not ours.
	_refresh_tags()
	if not _tags.has(txt.get("h")):
		return
	var native := bool(f.get("native", false))
	var hosts: Array = []
	for h in f.get("hosts", [f.get("host", "")]):
		if h is String and PKeyPeerDialRace.dialable(h, _loopback()) and not hosts.has(h):
			hosts.append(h)
	if hosts.is_empty() and not native:
		return
	var instance := str(f.get("instance", ""))
	if not _candidates.has(instance) and _candidates.size() >= MAX_CANDIDATES:
		return
	var had: Variant = _candidates.get(instance)
	_candidates[instance] = {"instance": instance, "hosts": hosts, "port": int(f.get("port", 0)), "native": native, "tries": int(had["tries"]) if had != null else 0}
	_dial_more()


func _gone(instance: String) -> void:
	_candidates.erase(instance)


## Uniform in [0, n) by rejection sampling over 32-bit draws.
func _below(n: int) -> int:
	var limit := (4294967296 / n) * n
	while true:
		var b := _random(4)
		var x := (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]
		if x < limit:
			return x % n
	return 0


func _random(n: int) -> PackedByteArray:
	var r: Variant = _o.get("random")
	if r is Callable and (r as Callable).is_valid():
		return (r as Callable).call(n)
	return Crypto.new().generate_random_bytes(n)


## Dial candidates at random until 4 are in flight.
func _dial_more() -> void:
	while not _ended and not _answered and _chosen == null and _active.size() < MAX_DIALS:
		var free: Array = []
		for c: Dictionary in _candidates.values():
			if not _active.has(c["instance"]) and int(c["tries"]) < TRIES_PER_ADVERT:
				free.append(c)
		if free.is_empty():
			return
		var c: Dictionary = free[_below(free.size())]
		c["tries"] = int(c["tries"]) + 1
		_active[c["instance"]] = true
		_dial(c)


func _dial(c: Dictionary) -> void:
	var pipe: PKeyPeerPipe = await _open_pipe(c)
	if pipe == null:
		_active.erase(c["instance"])
		_later()
		return
	if _ended or _answered or _chosen != null:
		pipe.abort()
		_active.erase(c["instance"])
		return
	var key := _random(32)
	var id := "ap_" + _random(6).hex_encode()
	var made := _make_link(pipe, key)
	key.fill(0)
	if not made.ok:
		pipe.abort()
		_active.erase(c["instance"])
		_later()
		return
	var e := Entry.new()
	e.id = id
	e.instance = c["instance"]
	e.link = made.detail
	_entries[id] = e
	e.link.established.connect(_on_established.bind(id))
	e.link.sas.connect(_on_sas.bind(id))
	e.link.record.connect(_on_record.bind(id))
	e.link.closed.connect(_on_closed.bind(id))
	_pump.add(e.link)
	await e.link.start()


## The socket to an approver: a test's `dial`, a native pipe by instance name, or a raced TCP dial.
func _open_pipe(c: Dictionary) -> PKeyPeerPipe:
	var custom: Variant = _o.get("dial")
	if custom is Callable and (custom as Callable).is_valid():
		return await (custom as Callable).call(c.duplicate(true))
	if bool(c["native"]):
		return await _open_native(str(c["instance"]))
	var won := await PKeyPeerDialRace.race(_tree, c["hosts"], int(c["port"]), {
		"allow_loopback": _loopback(), "mono": Callable(self, "_mono"), "connector": _o.get("connector", Callable()),
		"cancelled": Callable(self, "_dial_cancelled"),
	})
	return won.get("pipe")


func _open_native(instance: String) -> PKeyPeerPipe:
	if not _mdns.has_method("dial"):
		return null
	var pipe: PKeyPeerPipe = _mdns.call("dial", instance)
	if pipe == null:
		return null
	var deadline := _mono() + PKeyPeerDialRace.DIAL_SECONDS
	while not _ended and not pipe.is_finished() and not pipe.call("is_connected_native") and _mono() < deadline:
		await _tree.process_frame
	if not _ended and not pipe.is_finished() and pipe.call("is_connected_native"):
		return pipe
	pipe.abort()
	return null


func _dial_cancelled() -> bool:
	return _ended or _answered or _chosen != null


## A link as the initiator of mode v on a one-time key, held after HELLO.
func _make_link(pipe: PKeyPeerPipe, key: PackedByteArray) -> PKeyResult:
	var platform := PKeyHeaders.platform()
	var hello := {"platform": platform if platform != "" else UNKNOWN_PLATFORM, "app": _src["slug"]}
	if _label() != "":
		hello["label"] = _label()
	var so := {
		"mode": "v", "role": "initiator", "slug": _src["slug"], "static_key": key, "hold_sas": true, "hello": hello,
		"now": _src["now"], "mono": Callable(self, "_mono"),
	}
	if _o.get("crypto") is PKeyPeerCrypto:
		so["crypto"] = _o["crypto"]
	var seconds := float(_o.get("handshake_seconds", HANDSHAKE_SECONDS))
	return PKeyPeerLink.create(pipe, so, {"pump": _pump, "handshake_ms": int(seconds * 1000.0), "mono_ms": Callable(self, "_mono_ms")})


## A short pause before a replacement dial, so a refusing approver is not hammered.
func _later() -> void:
	if not _ended and not _answered:
		_redial_at = _mono() + REDIAL_SECONDS


func _replace(e: Entry) -> void:
	# The advert gets its try back: this is not a failure of the approver.
	var c: Variant = _candidates.get(e.instance)
	if c != null and int(c["tries"]) > 0:
		c["tries"] = int(c["tries"]) - 1
	e.link.close(PKeyPeerSession.PEER_BYE)


# -- a session's events --------------------------------------------------------------------------

func _on_established(info: Dictionary, id: String) -> void:
	var e: Entry = _entries.get(id)
	if e == null:
		return
	e.hello = info["hello"]
	e.since = _mono()
	approvers_changed.emit(approvers())


func _on_sas(_code: int, display: String, id: String) -> void:
	var e: Entry = _entries.get(id)
	if e != null:
		e.display = display


func _on_record(record_type: int, body: PackedByteArray, id: String) -> void:
	var e: Entry = _entries.get(id)
	if e == null or e != _chosen:
		return
	if record_type == PKeyPeerRecord.VOUCH_RESULT:
		# Display only: an unknown status reads as `denied` (rule 6).
		var got := PKeyPeerVouch.parse_result(body)
		if got.has("refuse"):
			return
		_result = str(got["status"])
		if _result == "approved":
			_answered = true
		result.emit(_result)
	elif record_type >= 0x0030 and record_type <= 0x003f:
		record.emit(record_type, body)


func _on_closed(code: StringName, _by_peer: bool, id: String) -> void:
	var e: Entry = _entries.get(id)
	if e == null or e.closed:
		return
	e.closed = true
	_entries.erase(id)
	_active.erase(e.instance)
	if e == _chosen:
		# The chosen session is over. Without an answer the request goes on: the person may choose again
		# from a fresh list.
		_chosen = null
		if not _ended:
			closed.emit(code)
			if _result == "" and not _answered:
				_later()
	elif not _ended:
		approvers_changed.emit(approvers())
		_later()


# -- the signed request --------------------------------------------------------------------------

func _signed_request(e: Entry) -> Variant:
	var hello := {"platform": PKeyHeaders.platform() if PKeyHeaders.platform() != "" else UNKNOWN_PLATFORM}
	if _label() != "":
		hello["label"] = _label()
	var args := {
		"port": _signer["port"], "slug": _src["slug"], "h": e.link.session.handshake_hash(),
		"request": _o["request"], "device_id": _signer["device_id"], "hello": hello,
	}
	var built: Variant = await _pump.offload(func() -> Variant: return PKeyPeerVouch.build_request(args))
	args.clear()
	if not built is PKeyResult or not (built as PKeyResult).ok:
		return null
	return (built as PKeyResult).detail


# -- the end -------------------------------------------------------------------------------------

func _stop(why: StringName) -> void:
	if _ended:
		return
	var had_chosen := _chosen != null
	_ended = true
	if _driven and _tree != null and _tree.process_frame.is_connected(tick):
		_tree.process_frame.disconnect(tick)
	if why != &"" or had_chosen:
		closed.emit(why if why != &"" else PKeyPeerSession.PEER_BYE)
	var browse := _browse
	_browse = null
	# The sessions close before the browse stops: a browse that hangs cannot hold them up.
	for e: Entry in _entries.values():
		e.link.close(PKeyPeerSession.PEER_BYE)
	if browse != null:
		browse.call("stop")


# -- helpers -------------------------------------------------------------------------------------

func _label() -> String:
	var label: Variant = _o.get("label")
	return label if label is String else ""


func _loopback() -> bool:
	return bool(_o.get("allow_loopback", false))


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return float((clock as Callable).call()) if clock is Callable and (clock as Callable).is_valid() else float(Time.get_ticks_msec()) / 1000.0


func _mono_ms() -> int:
	return int(_mono() * 1000.0)


## One approver session: its link, what its HELLO said and the code it reached.
class Entry extends RefCounted:
	var id := ""
	var instance := ""
	var link: PKeyPeerLink
	var hello: Variant = null
	var display := ""
	var since := 0.0
	var closed := false


	func _to_string() -> String:
		return "PKeyPeerNearbyRequester.Entry()"
