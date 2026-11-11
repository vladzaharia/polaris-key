@tool
class_name PKeyConnectPairing
extends RefCounted
## Pairing two devices of two accounts (CC-19b.G3; WIRE-CONTRACT-V5 section 15.10), ported from sdk-node
## `connect/pairing.ts`. Both people open pairing; each device advertises a pair instance (`m=p`, slot p) and
## browses for the other's, the two run mode `p` to the code (commit-reveal), each person confirms it, and the
## session's contact exchange hands the link to the host's store.
##
## Rules this file keeps:
##  - the advert is `p1-` plus 10 random bytes in base32 with `v=1`, `m=p` and the product tag, on a listener of
##    its own, for at most 300 s and only while the window is open (`stop()`);
##  - who dials: both sides advertise and browse, so the one whose instance name sorts lower dials and the
##    other answers; both apply the same rule, so two devices open one session. A device that can only ask (a
##    querier-only desktop lane) advertises nothing and dials every `m=p` advert it finds, and the other side
##    accepts any inbound;
##  - the lane must offer slots and tags (`capabilities()`); an older native binding answers
##    `nearby-unsupported` and mode a is unchanged. A native lane browses once at a time: with a running LAN
##    service (`options.lan`) its account browse waits while the window is open;
##  - everything needs the cached discovery `interAccount` (`source.allowed`): when it is false the window does
##    not open, and when it turns false under an open window nothing more is accepted or dialled;
##  - an offer is shown only once a session reached the code. Its `label` and `platform` come from a device on
##    the LAN that nothing has authenticated: show them as "reported by the device", never as proof of who it is;
##  - nothing is stored before both people confirm and both CONTACTs are read in order; a session that ends
##    first stores nothing on either side. The host stores the link only through `source.store`;
##  - the one-time static key is wiped once the session holds it, the contact secret is handed to the store and
##    zeroed (best effort); no key, secret, nonce or handshake hash is in a signal, a result or `str()`;
##  - at most 4 sessions at once, one waiting socket per source address, and the approver limiter of section
##    15.6 (5 handshakes a minute, 4 waiting a code).
##
## Use. `PKeyConnectPairing.start(source, options)` answers a PKeyResult holding the open window, or
## `invalid-options`, `connect_links_disabled`, `nearby-unsupported` or the lane's failure. `options`:
## `categories` (at most 8 distinct `^[a-z0-9-]{1,32}$`), `on_offer` (Callable taking one `Offer`; it decides:
## the person's `confirm()` or `decline()`), `label` (at most 64 characters; never an account identifier),
## `seconds` (at most 300), `lan`, and for tests and same-host use `mdns`, `host`, `allow_loopback`,
## `handshake_seconds`, `max_pending_per_address`, `timer`, `mono`, `random`, `pump`, `tree`, `interfaces`,
## `crypto`, `dial` (Callable(candidate) -> a coroutine answering a pipe or null) and `connector`.
## Signals are observers: `linked(link)` ({id, label, categories, re_pair}), `failed(failure)` ({reason,
## close_code}; `declined`, `timeout`, `full` or `closed`) and `window_closed`.

## A link was made: both people confirmed and the store has it.
signal linked(link: Dictionary)
## A session that reached the code ended without a link.
signal failed(failure: Dictionary)
## The window closed (the time ran out, the host stopped it, or a link was made).
signal window_closed

const WINDOW_SECONDS := 300.0
const MAX_SESSIONS := 4
const WAITING := 4
const PER_GROUP := 2
const PER_MINUTE := 5
const TRIES_PER_ADVERT := 2
const MAX_CANDIDATES := 64
## Offers put to the host in one window; a device that reaches the code after that is closed unasked.
const MAX_OFFERS := 8
const LABEL_MAX := 64
const SLOT := "p"
const UNKNOWN_PLATFORM := "unknown"

static var _cat_re: RegEx

var _src: Source
var _o: Dictionary
var _cats: Array = []
var _tree: SceneTree
var _pump: PKeyPeerPump
var _mdns: Object
var _gate_dial: PKeyPeerLanGate
var _gen: Gen
var _browse: Object
var _tags: Array = []
var _epoch := -1
var _agree_key := ""
var _held: Array = []
var _live: Dictionary = {}
var _candidates: Dictionary = {}
var _dialing: Dictionary = {}
var _stopped := false
var _offers := 0
var _dial_all := false
var _framed := false
var _timer_gen := 0
var _held_browse := false


## What pairing reads of the host: `slug`, `now` () -> epoch seconds, `agree_key` () -> this device's agreeKey (43
## characters, a public key), `held` () -> Array of the agreeKey of every active contact (a peer in it is a
## re-pair), `store` (incoming {agree_key, secret, label?, cats}) -> PKeyResult (ok with {pending, id}, or a
## failure `full`), and `allowed` () -> bool, the cached discovery `interAccount`.
class Source extends RefCounted:
	var slug := ""
	var now: Callable
	var agree_key: Callable
	var held: Callable
	var store: Callable
	var allowed: Callable


	func _to_string() -> String:
		return "PKeyConnectPairing.Source()"


## One listen: the gate and limiter of an advert, and its listener and handle.
class Gen extends RefCounted:
	var gate: PKeyPeerLanGate
	var limiter: PKeyPeerLimiter
	var server: TCPServer
	var adv: Object
	var instance := ""


	func _to_string() -> String:
		return "PKeyConnectPairing.Gen()"


## One session of the window.
class Live extends RefCounted:
	signal ended(code: StringName, by_peer: bool)

	var link: PKeyPeerLink
	var slot: PKeyPeerLanGate.Slot
	var pipe: PKeyPeerPipe
	var hello: Dictionary = {}
	var code := ""
	var shown := false
	var confirmed := false
	var linked := false
	var dead := false
	var failure := ""
	var closed_code: StringName = &""


	func _to_string() -> String:
		return "PKeyConnectPairing.Live()"


## A nearby device at the code stage, as the host's `on_offer` sees it.
class Offer extends RefCounted:
	## The session ended (once).
	signal closed(code: StringName, by_peer: bool)

	## What the other device sent as its label ("" when it sent none). Unauthenticated display data: any device on
	## the network can send any label. Show it as "reported by the device" beside the code.
	var label := ""
	var platform := ""
	## The code both screens show, like `123 456`. The people compare it before anyone confirms.
	var code := ""
	## The categories this app asked for: list them before the person confirms.
	var categories: Array = []

	var _owner: PKeyConnectPairing
	var _live: Live


	func _init(owner: PKeyConnectPairing, live: Live, p_label: String, p_platform: String, p_code: String, p_cats: Array) -> void:
		_owner = owner
		_live = live
		label = p_label
		platform = p_platform
		code = p_code
		categories = p_cats.duplicate()
		live.ended.connect(_on_ended)


	func _to_string() -> String:
		return "PKeyConnectPairing.Offer()"


	func _on_ended(c: StringName, by_peer: bool) -> void:
		closed.emit(c, by_peer)


	func is_closed() -> bool:
		return _live.dead


	## The person confirmed the code on this device. The link is made when the other person does too; the other
	## devices that reached the code are closed (one link a window).
	func confirm() -> void:
		_owner._confirm(_live)


	## The person declined: the session closes and nothing is stored.
	func decline() -> void:
		_owner._decline(_live)


static func _static_init() -> void:
	_cat_re = PKeyClaims.whole("[a-z0-9-]{1,32}")


## Open the window. See the header for the options and the failures.
static func start(source: Source, options := {}) -> PKeyResult:
	var bad := _checked(source, options)
	if bad != null:
		return bad
	var p := PKeyConnectPairing.new(source, options)
	var r := p._begin()
	if not r.ok:
		p.stop()
		return r
	return PKeyResult.success(p)


static func _invalid(message: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, message, {"reason": "bad_input"})


static func _checked(source: Source, o: Dictionary) -> PKeyResult:
	if source == null or source.slug == "" or not source.now.is_valid() or not source.agree_key.is_valid() \
			or not source.held.is_valid() or not source.store.is_valid() or not source.allowed.is_valid():
		return _invalid("Pairing: bad source.")
	if not o.get("on_offer") is Callable or not (o["on_offer"] as Callable).is_valid():
		return _invalid("on_offer is required.")
	var cats: Variant = o.get("categories")
	if not cats is Array or (cats as Array).size() > PKeyPeerContact.MAX_CONTACT_CATS:
		return _invalid("categories must be at most 8 distinct strings of a-z, 0-9 and '-' (1 to 32 characters).")
	var seen := {}
	for c in cats:
		if not PKeyClaims.matches_whole_re(_cat_re, c) or seen.has(c):
			return _invalid("categories must be at most 8 distinct strings of a-z, 0-9 and '-' (1 to 32 characters).")
		seen[c] = true
	var label: Variant = o.get("label")
	if label != null and (not label is String or (label as String).length() > LABEL_MAX):
		return _invalid("The label is not valid.")
	var seconds: Variant = o.get("seconds")
	if seconds != null and (not (seconds is int or seconds is float) or not float(seconds) > 0.0 or is_inf(float(seconds))):
		return _invalid("seconds must be above 0.")
	return null


func _init(source: Source, options: Dictionary) -> void:
	_src = source
	_o = options
	_cats = (options["categories"] as Array).duplicate()
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	_pump = options.get("pump", null) as PKeyPeerPump
	if _pump == null:
		_pump = PKeyPeerPump.new(_tree)
	_mdns = options.get("mdns", null) as Object
	if _mdns == null:
		_mdns = PKeyMdns.new({"allow_loopback": bool(options.get("allow_loopback", false)), "only": options.get("interfaces", []), "tree": _tree})
	_gate_dial = _new_gate()


func _to_string() -> String:
	return "PKeyConnectPairing(%s)" % ("closed" if _stopped else "open")


func _new_gate() -> PKeyPeerLanGate:
	return PKeyPeerLanGate.new({
		"max_pending": WAITING * 2, "max_pending_per_address": int(_o.get("max_pending_per_address", 1)),
		"max_pending_per_group": PER_GROUP, "handshake_seconds": _o.get("handshake_seconds", PKeyPeerLanGate.HANDSHAKE_SECONDS),
		"allow_loopback": _o.get("allow_loopback", false), "mono": Callable(self, "_mono"), "tree": _tree,
		"connector": _o.get("connector"), "dial_stagger": _o.get("dial_stagger", PKeyPeerLanGate.DIAL_STAGGER_SECONDS),
	})


# -- the handle -------------------------------------------------------------------------------------


## True while the window is open.
func is_open() -> bool:
	return not _stopped


## Sessions open now, the ones still in the handshake included.
func session_count() -> int:
	return _live.size()


## The TCP port of the listener (0 when there is none: a native listener, or a device that only asks).
func port() -> int:
	return _gen.server.get_local_port() if _gen != null and _gen.server != null else 0


## The pair instance this window advertises ("" for a device that only asks).
func instance() -> String:
	return _gen.instance if _gen != null else ""


## Close the window now: the advert, the listener, the browse and every session (`peer_bye`).
func stop() -> void:
	if _stopped:
		return
	_stopped = true
	_timer_gen += 1
	var g := _gen
	_gen = null
	if g != null:
		_retire(g)
	if _native() and _mdns != null:
		_mdns.call("set_acceptor", SLOT, Callable())
	if _browse != null:
		_browse.call("stop")
		_browse = null
	_resume_account_browse()
	for live: Live in _live.values():
		_end(live, PKeyPeerSession.PEER_BYE)
	_candidates = {}
	_frames(false)
	window_closed.emit()


# -- start --------------------------------------------------------------------------------------------


func _fail(code: String, reason: String, message: String) -> PKeyResult:
	return PKeyResult.failure(code, message, {"reason": reason})


func _mono() -> float:
	var clock: Variant = _o.get("mono")
	return float((clock as Callable).call()) if clock is Callable and (clock as Callable).is_valid() else float(Time.get_ticks_msec()) / 1000.0


func _now() -> int:
	return int(_src.now.call())


func _random(n: int) -> PackedByteArray:
	var r: Variant = _o.get("random")
	if r is Callable and (r as Callable).is_valid():
		return (r as Callable).call(n)
	return Crypto.new().generate_random_bytes(n)


func _native() -> bool:
	return _mdns.has_method("set_acceptor")


func _allowed() -> bool:
	return bool(_src.allowed.call())


func _begin() -> PKeyResult:
	if not _allowed():
		return _fail(PKeyConstants.ErrorCode.CONNECT_LINKS_DISABLED, "disabled", "Links are not available for this account.")
	if _mdns.has_method("capabilities"):
		var caps: Variant = _mdns.call("capabilities")
		if not (caps is Dictionary and bool((caps as Dictionary).get("slots", false)) and bool((caps as Dictionary).get("tags", false))):
			return _fail(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, "slots", "Pairing is not available here.")
	_agree_key = str(_src.agree_key.call())
	var held: Variant = _src.held.call()
	_held = (held as Array).duplicate() if held is Array else []
	_hold_account_browse()
	var adv := _advertise()
	if not adv.ok:
		return adv
	_refresh_tags()
	var b: PKeyResult = _mdns.browse(Callable(self, "_found"), Callable(self, "_gone"), Callable(self, "_accepts"), {"p": _tags})
	if not b.ok:
		return b
	_browse = b.detail
	var seconds := minf(float(_o.get("seconds", WINDOW_SECONDS)), WINDOW_SECONDS)
	_after(seconds, Callable(self, "stop"))
	_frames(true)
	return PKeyResult.success()


## A native lane browses once at a time: the running LAN service's account browse waits for the window.
func _hold_account_browse() -> void:
	var lan: Variant = _o.get("lan")
	if lan is PKeyConnectLan and _native():
		_held_browse = (lan as PKeyConnectLan).suspend_browse()


func _resume_account_browse() -> void:
	var lan: Variant = _o.get("lan")
	if _held_browse and lan is PKeyConnectLan:
		_held_browse = false
		(lan as PKeyConnectLan).resume_browse()


func _advertise() -> PKeyResult:
	var instance := PKeyPeerVouch.approver_instance(Callable(self, "_random"))
	if instance == "":
		return _fail(PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE, "random", "Pairing could not start.")
	var gen := Gen.new()
	gen.instance = instance
	gen.gate = _new_gate()
	gen.limiter = PKeyPeerLimiter.new(PER_MINUTE, WAITING, Callable(self, "_mono"))
	var advert := {"instance": instance, "txt": ["v=1", "m=p", "h=" + PKeyPeerAdvert.product_tag(_src.slug, PKeyPeerAdvert.advert_epoch(_now()))], "slot": SLOT}
	if _native():
		_mdns.call("set_acceptor", SLOT, Callable(self, "_accept_native"))
	else:
		var listened := PKeyPeerLanGate.listen(str(_o.get("host", "")), 0)
		if not listened.ok:
			return listened
		gen.server = listened.detail
		advert["port"] = gen.server.get_local_port()
	# Set before the advert goes out: a device can find it and dial before `advertise` returns.
	_gen = gen
	var made: PKeyResult = _mdns.advertise(advert)
	if not made.ok:
		_gen = null
		if gen.server != null:
			gen.server.stop()
		return made
	gen.adv = made.detail
	if _querier_only():
		_gen = null
		# A device that can only ask is never found: it advertises nothing and dials every `m=p` advert.
		_retire(gen)
		if _native():
			_mdns.call("set_acceptor", SLOT, Callable())
		_dial_all = true
		return PKeyResult.success()
	return PKeyResult.success()


func _querier_only() -> bool:
	if not _mdns.has_method("status"):
		return false
	var st: Variant = _mdns.call("status")
	return st is Dictionary and str((st as Dictionary).get("reason", "")) == "querier_only"


func _retire(g: Gen) -> void:
	if g.server != null:
		g.server.stop()
		g.server = null
	g.gate.destroy_pending(false)
	if g.adv != null:
		g.adv.call("stop")
		g.adv = null


func _refresh_tags() -> void:
	var epoch := PKeyPeerAdvert.advert_epoch(_now())
	if epoch == _epoch:
		return
	var first := _epoch < 0
	_epoch = epoch
	_tags = [PKeyPeerAdvert.product_tag(_src.slug, epoch), PKeyPeerAdvert.product_tag(_src.slug, epoch - 1)]
	if not first and _mdns.has_method("set_tags"):
		var target: Object = _browse if _browse != null and _browse.has_method("set_tags") else _mdns
		target.call("set_tags", {"p": _tags})


# -- clocks and frames --------------------------------------------------------------------------------


func _after(seconds: float, fn: Callable) -> void:
	var guarded := Callable(self, "_fire").bind(_timer_gen, fn)
	var timer: Variant = _o.get("timer")
	if timer is Callable and (timer as Callable).is_valid():
		(timer as Callable).call(seconds, guarded)
	elif _tree != null:
		_tree.create_timer(maxf(0.05, seconds)).timeout.connect(guarded)


func _fire(gen: int, fn: Callable) -> void:
	if gen == _timer_gen:
		fn.call()


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
	if _gen != null and _gen.server != null:
		_gen.gate.drain(_gen.server, Callable(self, "_on_peer").bind(_gen))
	if _gen != null:
		_gen.gate.tick()


# -- browse and dial ----------------------------------------------------------------------------------


## A native lane filters on the tags; the shared lane admits any well-formed name and the TXT is judged here.
func _accepts(_instance: String) -> bool:
	return not _mdns.has_method("set_tags")


func _found(f: Dictionary) -> void:
	var instance := str(f.get("instance", ""))
	if _stopped or (_gen != null and instance == _gen.instance):
		return
	var txt := PKeyPeerAdvert.parse_txt(f.get("txt", []))
	if not txt["ok"] or txt["mode"] != "p":
		return
	# The product tag of this epoch or the last: a pair advert of another product is not ours.
	_refresh_tags()
	if not _tags.has(txt.get("h")):
		return
	var native := bool(f.get("native", false))
	var hosts: Array = []
	for h in f.get("hosts", [f.get("host", "")]):
		if h is String and _gate_dial.dialable(h) and not hosts.has(h):
			hosts.append(h)
	if hosts.is_empty() and not native:
		return
	if not _candidates.has(instance) and _candidates.size() >= MAX_CANDIDATES:
		return
	var had: Variant = _candidates.get(instance)
	_candidates[instance] = {"instance": instance, "hosts": hosts, "port": int(f.get("port", 0)), "native": native, "tries": int(had["tries"]) if had != null else 0}
	_pump_dials()


func _gone(instance: String) -> void:
	_candidates.erase(instance)


## Dial the adverts that sort above this device's own (the other side dials the rest); a device with no
## advert of its own dials them all.
## The cached discovery answer is read here (section 15.10, "Gates"): a closed gate dials nothing.
func _pump_dials() -> void:
	if _stopped or not _allowed():
		return
	for c: Dictionary in _candidates.values():
		if _live.size() + _dialing.size() >= MAX_SESSIONS:
			return
		if _gen != null and _gen.instance >= str(c["instance"]):
			continue
		if _dialing.has(c["instance"]) or int(c["tries"]) >= TRIES_PER_ADVERT:
			continue
		c["tries"] = int(c["tries"]) + 1
		_dialing[c["instance"]] = true
		_dial(c)


func _dial(c: Dictionary) -> void:
	var pipe: PKeyPeerPipe = await _open_pipe(c)
	_dialing.erase(c["instance"])
	if pipe == null:
		_pump_dials()
		return
	if _stopped:
		pipe.abort()
		return
	var live := _open(pipe, "initiator", null, null)
	if live != null:
		await live.link.start()


func _open_pipe(c: Dictionary) -> PKeyPeerPipe:
	var custom: Variant = _o.get("dial")
	if custom is Callable and (custom as Callable).is_valid():
		return await (custom as Callable).call(c.duplicate(true))
	if bool(c["native"]):
		return await _gate_dial.open_native(_mdns, str(c["instance"]), Callable(self, "_dial_cancelled"))
	var won := await _gate_dial.race(c["hosts"], int(c["port"]), Callable(self, "_dial_cancelled"))
	return won.get("pipe")


func _dial_cancelled() -> bool:
	return _stopped


# -- sessions -----------------------------------------------------------------------------------------


func _refuse() -> bool:
	return _stopped or not _allowed() or _live.size() >= MAX_SESSIONS


func _on_peer(peer: StreamPeerTCP, g: Gen) -> void:
	var slot := g.gate.admit(peer, _refuse())
	if slot == null:
		return
	var pipe := PKeyPeerTcpPipe.from_peer(peer)
	if pipe == null:
		slot.settle()
		return
	_open(pipe, "responder", g, slot)


## An inbound native pipe (the slot p listener): the OS side judged the source and holds the unadmitted limits.
func _accept_native(pipe: PKeyPeerPipe) -> void:
	if _gen == null or _refuse():
		pipe.abort()
		return
	_open(pipe, "responder", _gen, null)


func _open(pipe: PKeyPeerPipe, role: String, g: Gen, slot: PKeyPeerLanGate.Slot) -> Live:
	var key := _random(32)
	var platform := PKeyHeaders.platform()
	var label := str(_o.get("label", ""))
	var offer := {"agree_key": _agree_key, "held": _held.duplicate(), "cats": _cats.duplicate()}
	if label != "":
		offer["label"] = label
	var hello := {"label": label, "platform": platform if platform != "" else UNKNOWN_PLATFORM, "app": _src.slug}
	var so := {
		"mode": "p", "role": role, "slug": _src.slug, "static_key": key, "caps": [], "exchange": offer, "hello": hello,
		"now": _src.now, "mono": Callable(self, "_mono"),
	}
	if role == "responder" and g != null:
		so["admission"] = g.limiter
	if _o.get("crypto") is PKeyPeerCrypto:
		so["crypto"] = _o["crypto"]
	var seconds := float(_o.get("handshake_seconds", PKeyPeerLanGate.HANDSHAKE_SECONDS))
	var lr := PKeyPeerLink.create(pipe, so, {"pump": _pump, "handshake_ms": int(seconds * 1000.0)})
	# The session holds its own copy of the one-time key.
	key.fill(0)
	if not lr.ok:
		pipe.abort()
		if slot != null:
			slot.settle()
		return null
	var live := Live.new()
	live.link = lr.detail
	live.slot = slot
	live.pipe = pipe
	var id := live.get_instance_id()
	live.link.established.connect(_on_established.bind(id))
	live.link.sas.connect(_on_sas.bind(id))
	live.link.contact.connect(_on_contact.bind(id))
	live.link.closed.connect(_on_closed.bind(id))
	if slot != null:
		slot.on_expire = Callable(live.link, "destroy")
	_live[id] = live
	_pump.add(live.link)
	return live


func _on_established(info: Dictionary, id: int) -> void:
	var live: Live = _live.get(id)
	if live == null:
		return
	live.hello = (info.get("hello", {}) as Dictionary).duplicate()
	if live.slot != null:
		live.slot.established()
	if live.pipe != null and live.pipe.has_method("admit"):
		live.pipe.call("admit")


func _on_sas(_code: int, display: String, id: int) -> void:
	var live: Live = _live.get(id)
	if live == null or live.dead or live.shown or _stopped:
		return
	live.shown = true
	live.code = display
	_offers += 1
	if _offers > MAX_OFFERS:
		live.failure = "declined"
		_end(live, PKeyPeerSession.PEER_BUSY)
		return
	var offer := Offer.new(self, live, str(live.hello.get("label", "")), str(live.hello.get("platform", "")), display, _cats)
	(_o["on_offer"] as Callable).call(offer)


func _confirm(live: Live) -> void:
	if live.dead or live.confirmed or not live.shown:
		return
	live.confirmed = true
	# One link a window: the other devices that reached the code are closed.
	for other: Live in _live.values():
		if other != live and not other.confirmed:
			_end(other, PKeyPeerSession.PEER_BYE)
	live.link.session.confirm_sas()


func _decline(live: Live) -> void:
	if live.dead:
		return
	live.failure = "declined"
	_end(live, PKeyPeerSession.PEER_BYE)


## Both CONTACTs are in: the host stores the link, then the exchange is over (section 15.10).
func _on_contact(e: Dictionary, id: int) -> void:
	var live: Live = _live.get(id)
	if live == null or live.dead:
		return
	var incoming := {"agree_key": e["agree_key"], "secret": e["secret"], "cats": PKeyPeerContact.categories(_cats, e["cats"])}
	if e.has("label"):
		incoming["label"] = e["label"]
	var stored: Variant = _src.store.call(incoming)
	# The store keeps its own copy of the secret; ours is zeroed (best effort).
	PKeyConnectContacts.wipe_live([incoming])
	if not stored is PKeyResult or not (stored as PKeyResult).ok:
		live.failure = "full"
		_end(live, PKeyPeerSession.PEER_NOT_ALLOWED)
		return
	live.linked = true
	var detail: Dictionary = (stored as PKeyResult).detail if (stored as PKeyResult).detail is Dictionary else {}
	linked.emit({
		"id": str(detail.get("id", "")), "label": e.get("label"), "categories": (incoming["cats"] as Array).duplicate(),
		"re_pair": bool(detail.get("pending", false)),
	})
	_end(live, PKeyPeerSession.PEER_BYE)


func _on_closed(code: StringName, by_peer: bool, id: int) -> void:
	var live: Live = _live.get(id)
	if live == null or live.dead:
		return
	live.dead = true
	live.closed_code = code
	if live.slot != null:
		live.slot.settle()
	_live.erase(id)
	live.ended.emit(code, by_peer)
	if live.shown and not live.linked and not _stopped:
		var reason := live.failure if live.failure != "" else ("timeout" if code == PKeyPeerSession.PEER_TIMEOUT else "closed")
		failed.emit({"reason": reason, "close_code": code})
	if live.linked and not _stopped:
		stop()
	else:
		# A session that ended frees a place, and an advert whose dial failed gets its second try.
		_pump_dials()


func _end(live: Live, code: StringName) -> void:
	if live.dead:
		return
	live.link.close(code)
