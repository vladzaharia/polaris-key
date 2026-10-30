@tool
class_name PKeyMdns
extends RefCounted
## The mDNS adapter of the LAN path (CC-14.11; WIRE-CONTRACT-V5 section 15.4, plans CC-14 D-5 and
## D-6), ported from sdk-node `connect/mdns.ts` and the Python `core/peer_mdns.py` over the bounded
## codec `PKeyMdnsPacket`. It advertises this device and browses for the person's others on
## `_pkeypeer._tcp.local`. The LAN service holds it behind two calls, `advertise` and `browse`, so a
## test injects a fake socket.
##
## What this lane can and cannot do (CC-13, measured on Godot 4.7.2):
##  - One socket serves both halves. It tries `bind(5353)` first: when that works the device is a
##    RESPONDER and a querier (it hears multicast responses and queries). When it does not (macOS
##    holds 5353 with SO_REUSEPORT and Godot sets none; D-5) the device is QUERIER-ONLY: the socket is
##    bound to an ephemeral port, asks, and hears the unicast answers RFC 6762 section 6.7 owes a
##    legacy query. It then advertises nothing: `status()` says `querier_only`.
##  - Sockets are IPv4 multicast (224.0.0.251) on at most 8 interfaces that Godot lists: no
##    netmask, flag or zone is known, so no IPv6 socket is opened (D-6); a tunnel or virtual
##    interface is dropped by name. Sends leave on the system's default multicast interface.
##
## Rules this file keeps:
##  - the advert's host name is the instance name (`p1-....local`), never the machine's;
##  - an A or AAAA record is believed only when its address equals the packet's UDP source
##    (`get_packet_ip()`, G5); there is no filter on the address when it is learned, the dial-time
##    `PKeyLanAddress.verdict` decides what is dialled; TTL 0 removes it; four per name, first seen
##    first;
##  - a response is read only from a source in the same private block (10/8, 172.16/12, 192.168/16;
##    127/8 when loopback is allowed) as one of the device's own addresses. Godot lists no netmask, so
##    this is the union test of V5 section 15.4 widened to the block; a host in the block costs one
##    blind connect, never a trusted address;
##  - only a name `accept` allows (the roster's instance names) enters a table, one source adds at
##    most 16 new names a minute, an SRV port below 1024 is ignored, and the SRV target must be the
##    instance's own `.local` name;
##  - tables hold at most 256 entries, an entry lives 5 minutes after its last refresh, the least
##    recently refreshed goes first when full, and a PTR whose TTL lapses without a refresh reports
##    the peer down like a goodbye;
##  - a query is answered at most once a second per advert, a legacy (non-5353) query by a unicast
##    answer with its ID, and each poll reads at most MAX_PACKETS_PER_POLL datagrams so a flood
##    cannot stall a frame;
##  - nothing is bound or joined until `advertise` or `browse` is called, and the last `stop()`
##    closes the socket.
##
## Driving. The adapter polls once a frame (`SceneTree.process_frame`) while a handle is open;
## `poll()` does one round by hand (tests, hosts with no tree).

const GROUP := "224.0.0.251"
const PORT := 5353
const MAX_INSTANCES := 256
const MAX_ADDRESSES := 4
const MAX_INTERFACES := 8
const ENTRY_TTL_SECONDS := 300.0
const REPLY_GAP_SECONDS := 1.0
const MAX_NEW_PER_SOURCE := 16
const NEW_WINDOW_SECONDS := 60.0
const MAX_SOURCES := 256
const TTL := 120
const LEGACY_TTL := 10
const TXT_TTL := 4500
const ASK_QUESTIONS := 32
const MAX_PACKETS_PER_POLL := 64
const SWEEP_SECONDS := 5.0
const ASK_AGAIN_SECONDS := 30.0
const MIN_SRV_PORT := 1024
const REASON_QUERIER_ONLY := "querier_only"
const REASON_UNAVAILABLE := "mdns_unavailable"

## Interface names that are tunnels, VPNs, direct-link or virtual adapters: not a LAN.
const _NOT_A_LAN := ["awdl", "llw", "utun", "ppp", "tun", "tap", "wg", "gif", "stf", "ipsec", "docker", "veth", "virbr", "vmnet", "vboxnet", "ts0"]
## Substrings of a Windows friendly name for the same.
const _NOT_A_LAN_FRIENDLY := ["vethernet", "hyper-v", "wireguard", "tunnel", "vpn", "pseudo", "virtualbox", "vmware", "tap-", "teredo", "6to4", "isatap", "loopback"]

static var _fqdn_re: RegEx
static var _host_re: RegEx

var allow_loopback := false

var _make_socket: Callable
var _list_interfaces: Callable
var _own_addresses: Callable
var _only: Array
var _clock: Callable
var _tree: SceneTree
var _drive: bool
var _listening := false

var _socket: Socket = null
var _responder := false
var _faces: Array = []
var _blocks: Array[String] = []
var _refs := 0
var _adverts: Array[Advertisement] = []
var _browsers: Array[Browser] = []
var _next_sweep := 0.0


static func _static_init() -> void:
	_fqdn_re = PKeyClaims.whole("p1-[a-z2-7]{16}\\._pkeypeer\\._tcp\\.local")
	_host_re = PKeyClaims.whole("p1-[a-z2-7]{16}\\.local")


## `options`: `socket` (Callable(port: int, interface_names: Array) -> Socket or null; default: a
## real UDP socket), `interfaces` (Callable() -> Array shaped like `IP.get_local_interfaces()`),
## `addresses` (Callable() -> Array of own IPv4 addresses to advertise; default: the usable
## interfaces'), `only` (names or addresses of the interfaces to use; the `lan.interfaces` option),
## `allow_loopback`, `clock` (Callable() -> monotonic seconds), `tree` (a SceneTree; null: the
## running main loop) and `drive` (false: the host calls `poll()`).
func _init(options := {}) -> void:
	_make_socket = options.get("socket", Callable(PKeyMdns, "open_udp"))
	_list_interfaces = options.get("interfaces", Callable(PKeyMdns, "local_interfaces"))
	_own_addresses = options.get("addresses", Callable())
	_only = options.get("only", []) as Array
	allow_loopback = bool(options.get("allow_loopback", false))
	_clock = options.get("clock", Callable())
	_tree = options.get("tree", null) as SceneTree
	if _tree == null:
		_tree = Engine.get_main_loop() as SceneTree
	_drive = bool(options.get("drive", true))


func _to_string() -> String:
	return "PKeyMdns()"


# ── the seam ─────────────────────────────────────────────────────────────────────────────────


## Advertise `advert` {instance, port, txt}. ok with a Handle (`stop()` sends the goodbye and
## closes), or a connect-unavailable failure (reason `mdns_unavailable`) when no socket can be
## opened. A querier-only device returns a handle that says nothing: see `status()`.
func advertise(advert: Dictionary) -> PKeyResult:
	var instance := str(advert.get("instance", ""))
	var port := int(advert.get("port", 0))
	if not PKeyPeerAdvert.is_instance_name(instance):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad instance name.", {"reason": "instance_name"})
	if port < 1 or port > 65535:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad port.", {"reason": "port"})
	var opened := _acquire()
	if not opened.ok:
		return opened
	var ad := Advertisement.new()
	ad.instance = instance
	ad.fqdn = instance + "." + PKeyMdnsPacket.PEER_SERVICE
	ad.host = instance + ".local"
	ad.port = port
	ad.txt = (advert.get("txt", []) as Array).duplicate()
	ad.addresses = _advert_addresses()
	ad.next_again = _now() + 1.0
	_adverts.append(ad)
	_announce(ad, TTL)
	return PKeyResult.success(Handle.new(self, ad))


## Browse for peers. `on_up` is called with {instance, host, hosts, port, txt} once a peer's SRV,
## TXT and at least one address are known (again when they change); `on_down` with the instance
## when it leaves or lapses; `accept` (Callable(instance) -> bool) says whether a name may enter
## the tables (default: every well-formed name). ok with a Handle, or a failure as `advertise`.
func browse(on_up: Callable, on_down := Callable(), accept := Callable()) -> PKeyResult:
	var opened := _acquire()
	if not opened.ok:
		return opened
	var b := Browser.new()
	b.on_up = on_up
	b.on_down = on_down
	b.accept = accept
	var now := _now()
	b.next_again = now + ASK_AGAIN_SECONDS
	b.first_again = now + 1.0
	_browsers.append(b)
	_ask(b)
	return PKeyResult.success(Handle.new(self, b))


## {active, responder, querier, reason}: `reason` is "" when the device both asks and answers,
## `querier_only` when it can only ask, `mdns_unavailable` when no socket is open.
func status() -> Dictionary:
	if _socket == null:
		return {"active": false, "responder": false, "querier": false, "reason": ""}
	return {"active": true, "responder": _responder, "querier": true, "reason": "" if _responder else REASON_QUERIER_ONLY}


func is_open() -> bool:
	return _socket != null


## One round: read what arrived, run the timers.
func poll() -> void:
	if _socket == null:
		return
	var now := _now()
	var n := 0
	while n < MAX_PACKETS_PER_POLL and _socket != null:
		var pkt := _socket.receive()
		if pkt.is_empty():
			break
		n += 1
		_on_packet(pkt, now)
	if _socket == null:
		return
	for ad in _adverts.duplicate():
		if not ad.stopped and ad.next_again >= 0.0 and now >= ad.next_again:
			ad.next_again = -1.0
			_announce(ad, TTL)
	for b in _browsers.duplicate():
		_browser_timers(b, now)
	if now >= _next_sweep:
		_next_sweep = now + SWEEP_SECONDS
		for b in _browsers:
			_sweep(b, now)


# ── the socket ───────────────────────────────────────────────────────────────────────────────


func _acquire() -> PKeyResult:
	if _socket == null:
		var open := _open()
		if not open.ok:
			return open
	_refs += 1
	_listen()
	return PKeyResult.success()


func _release() -> void:
	_refs = maxi(0, _refs - 1)
	if _refs > 0:
		return
	_unlisten()
	if _socket != null:
		_socket.close()
	_socket = null
	_responder = false
	_faces = []
	_blocks = []


func _open() -> PKeyResult:
	_faces = usable_interfaces(_list_interfaces.call() as Array, allow_loopback, _only)
	if _faces.is_empty():
		return _unavailable("No LAN interface to use; LAN discovery is off.")
	var names: Array = _faces.map(func(f: Dictionary) -> String: return f["name"])
	_blocks = []
	for f: Dictionary in _faces:
		for a: String in f["addresses"]:
			var block := private_block(a)
			if block != "" and not _blocks.has(block):
				_blocks.append(block)
	var s: Socket = _make_socket.call(PORT, names)
	_responder = s != null
	if s == null:
		s = _make_socket.call(0, names)
	if s == null:
		return _unavailable("The mDNS socket could not be opened; LAN discovery is off.")
	_socket = s
	_next_sweep = _now() + SWEEP_SECONDS
	return PKeyResult.success()


static func _unavailable(message: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.CONNECT_UNAVAILABLE, message, {"reason": REASON_UNAVAILABLE})


func _listen() -> void:
	if _listening or not _drive or _tree == null:
		return
	_listening = true
	_tree.process_frame.connect(poll)


func _unlisten() -> void:
	if not _listening or _tree == null:
		return
	_listening = false
	if _tree.process_frame.is_connected(poll):
		_tree.process_frame.disconnect(poll)


func _now() -> float:
	return float(_clock.call()) if _clock.is_valid() else float(Time.get_ticks_msec()) / 1000.0


func _send(data: PackedByteArray) -> void:
	if _socket != null and not data.is_empty():
		_socket.send(data)


# ── interfaces and addresses ─────────────────────────────────────────────────────────────────


## The system's interface list: [{index, name, friendly, addresses}].
static func local_interfaces() -> Array:
	return IP.get_local_interfaces()


## The interfaces mDNS uses: [{name, addresses}] (the IPv4 addresses a LAN peer may have, by
## `PKeyLanAddress`), sorted by name, at most MAX_INTERFACES. An interface with no such address,
## a tunnel, a VPN, a direct-link or a virtual adapter (by name) is dropped; loopback only when
## `allow_loopback`. `only`, when not empty, names the interfaces (or their addresses) to use.
static func usable_interfaces(raw: Array, allow_loopback: bool, only := []) -> Array:
	var out: Array = []
	for item in raw:
		if not item is Dictionary:
			continue
		var name := str(item.get("name", ""))
		if name == "" or _not_a_lan(name, str(item.get("friendly", ""))):
			continue
		var mine: Array = []
		for a in item.get("addresses", []):
			var text := str(a)
			if not text.contains(".") or text.contains(":"):
				continue
			if PKeyLanAddress.verdict(text, null, allow_loopback)["dial"] and not mine.has(text):
				mine.append(text)
		if mine.is_empty():
			continue
		if not only.is_empty() and not only.has(name) and mine.filter(func(a: String) -> bool: return only.has(a)).is_empty():
			continue
		out.append({"name": name, "addresses": mine})
	out.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return str(a["name"]) < str(b["name"]))
	return out.slice(0, MAX_INTERFACES)


static func _not_a_lan(name: String, friendly: String) -> bool:
	var n := name.to_lower()
	for p: String in _NOT_A_LAN:
		if n.begins_with(p):
			return true
	var f := friendly.to_lower()
	for s: String in _NOT_A_LAN_FRIENDLY:
		if f.contains(s):
			return true
	return false


## The private block an IPv4 address sits in: "10", "172.16", "192.168" or "127"; "" for any other
## address (and for text that is not IPv4).
static func private_block(address: String) -> String:
	var p := address.split(".")
	if p.size() != 4:
		return ""
	var a := p[0].to_int()
	var b := p[1].to_int()
	if a == 10:
		return "10"
	if a == 172 and b >= 16 and b <= 31:
		return "172.16"
	if a == 192 and b == 168:
		return "192.168"
	if a == 127:
		return "127"
	return ""


## True when `source` is in a private block that one of the device's own addresses is in.
func source_on_link(source: String) -> bool:
	var block := private_block(source)
	return block != "" and _blocks.has(block)


func _advert_addresses() -> Array:
	var found: Array = []
	if _own_addresses.is_valid():
		found = _own_addresses.call()
	else:
		for f: Dictionary in _faces:
			found.append_array(f["addresses"])
	var out: Array = []
	for a in found:
		if PKeyLanAddress.verdict(str(a), null, allow_loopback)["dial"] and not out.has(str(a)):
			out.append(str(a))
	return out.slice(0, MAX_ADDRESSES)


# ── names ────────────────────────────────────────────────────────────────────────────────────


## ASCII fold: `A` to `Z` only (DNS names, V5 section 15.4).
static func fold_name(name: String) -> String:
	var out := PackedByteArray()
	for b in name.to_utf8_buffer():
		out.append(b + 32 if b >= 65 and b <= 90 else b)
	return out.get_string_from_utf8()


## "p1-..." out of an instance's FQDN or its host name, "" when it is not one.
static func instance_of_fqdn(name: String) -> String:
	return name.substr(0, 19) if PKeyClaims.matches_whole_re(_fqdn_re, name) else ""


static func instance_of_host(name: String) -> String:
	return name.substr(0, 19) if PKeyClaims.matches_whole_re(_host_re, name) else ""


# ── advertise ────────────────────────────────────────────────────────────────────────────────


func _records(ad: Advertisement, ttl: int) -> Array:
	var out: Array = [
		{"name": PKeyMdnsPacket.PEER_SERVICE, "type": &"PTR", "ttl": ttl, "data": ad.fqdn},
		{"name": ad.fqdn, "type": &"SRV", "ttl": ttl, "data": {"port": ad.port, "target": ad.host, "priority": 0, "weight": 0}},
		{"name": ad.fqdn, "type": &"TXT", "ttl": 0 if ttl == 0 else TXT_TTL, "data": ad.txt},
	]
	for a: String in ad.addresses:
		out.append({"name": ad.host, "type": &"A", "ttl": ttl, "data": a})
	return out


## Multicast `ad`'s records (a querier-only device says nothing, and without an address there is
## nothing to say: the PTR alone cannot be dialled).
func _announce(ad: Advertisement, ttl: int) -> void:
	if ad.stopped or not _responder or ad.addresses.is_empty():
		return
	_send(PKeyMdnsPacket.build_response(_records(ad, ttl)))


func _stop_advert(ad: Advertisement) -> void:
	if ad.stopped:
		return
	_announce(ad, 0)
	ad.stopped = true
	_adverts.erase(ad)
	_release()


func _on_query(parsed: Dictionary, data: PackedByteArray, source: String, port: int, now: float) -> void:
	if not _responder:
		return
	for ad in _adverts:
		if ad.stopped or ad.addresses.is_empty():
			continue
		var hit := false
		for q: Dictionary in parsed["questions"]:
			var n := fold_name(str(q["name"]))
			if n == PKeyMdnsPacket.PEER_SERVICE or n == ad.fqdn or n == ad.host:
				hit = true
				break
		if not hit or now - ad.last_reply < REPLY_GAP_SECONDS:
			continue
		ad.last_reply = now
		if port == PORT:
			_send(PKeyMdnsPacket.build_response(_records(ad, TTL)))
		else:
			# A legacy query (RFC 6762 section 6.7): a unicast answer carrying its ID, with a short TTL.
			var reply := PKeyMdnsPacket.build_response(_records(ad, LEGACY_TTL))
			if reply.size() >= 2 and data.size() >= 2:
				reply[0] = data[0]
				reply[1] = data[1]
				_socket.send_to(reply, source, port)


# ── packets ──────────────────────────────────────────────────────────────────────────────────


func _on_packet(pkt: Dictionary, now: float) -> void:
	var data: PackedByteArray = pkt.get("data", PackedByteArray())
	var parsed := PKeyMdnsPacket.parse(data)
	if not parsed["ok"]:
		return
	var source := str(pkt.get("source", ""))
	if parsed["response"]:
		# A response from outside the link's private blocks teaches nothing (RFC 6762 section 11).
		if not source_on_link(source):
			return
		for b in _browsers.duplicate():
			if not b.stopped:
				_learn(b, parsed["answers"], source, now)
	else:
		_on_query(parsed, data, source, int(pkt.get("port", 0)), now)


# ── browse ───────────────────────────────────────────────────────────────────────────────────


func _accepts(b: Browser, instance: String) -> bool:
	return not b.accept.is_valid() or bool(b.accept.call(instance))


func _learn(b: Browser, records: Array, source: String, now: float) -> void:
	for r: Dictionary in records:
		var type: StringName = r["type"]
		if type == &"A" or type == &"AAAA":
			# Only the host name of an accepted instance has a place in the book.
			var inst := instance_of_host(str(r["name"]))
			if inst == "" or not _accepts(b, inst):
				continue
			b.book.learn(r, source, null, now, func() -> bool: return b.fresh.admit(source, now))
			continue
		var named: String = str(r["data"]) if type == &"PTR" else str(r["name"])
		var instance := instance_of_fqdn(named)
		if instance == "" or (type == &"PTR" and str(r["name"]) != PKeyMdnsPacket.PEER_SERVICE):
			continue
		if not _accepts(b, instance):
			continue
		if type == &"SRV":
			var srv: Dictionary = r["data"]
			var p := int(srv.get("port", 0))
			if p < MIN_SRV_PORT or p > 65535:
				continue  # a port a random listen cannot have drawn
		if type == &"PTR" and int(r["ttl"]) == 0:
			if b.seen.has(instance):
				var gone: Seen = b.seen[instance]
				b.seen.erase(instance)
				_down(b, instance, gone)
			continue
		var e: Seen = b.seen.get(instance)
		if e == null:
			# No source owns a name; each may add 16 new ones a minute.
			if not b.fresh.admit(source, now):
				continue
			if b.seen.size() >= MAX_INSTANCES:
				_trim_seen(b, now)
			e = Seen.new()
			e.exp = now + TTL
		else:
			b.seen.erase(instance)
		e.at = now
		# A PTR is the refresh signal: its own TTL (capped) restarts the clock.
		if type == &"PTR":
			e.exp = now + minf(float(r["ttl"]), ENTRY_TTL_SECONDS)
		b.seen[instance] = e
		if type == &"SRV":
			var srv2: Dictionary = r["data"]
			e.port = int(srv2["port"])
			# Only our own host name shape: the target is the instance's `.local` name.
			if fold_name(str(srv2.get("target", ""))) == instance + ".local":
				e.target = instance + ".local"
		elif type == &"TXT":
			var txt: Array = r["data"]
			e.txt = txt.slice(0, PKeyMdnsPacket.MAX_TXT)
	_publish(b)


## Report each peer whose SRV, TXT and an address are known and that changed since last time.
func _publish(b: Browser) -> void:
	for instance: String in b.seen.keys():
		var e: Seen = b.seen[instance]
		if e.port < 0 or e.txt == null:
			continue
		var hosts: Array = b.book.hosts(e.target) if e.target != "" else []
		if hosts.is_empty():
			# Every address was withdrawn: the peer cannot be dialled until one is learned again.
			if e.up != "":
				e.up = ""
				_down_call(b, instance)
			continue
		var sig := "%s|%d|%s" % [",".join(PackedStringArray(hosts)), e.port, "\n".join(PackedStringArray(e.txt))]
		if e.up == sig:
			continue
		e.up = sig
		if b.on_up.is_valid():
			b.on_up.call({"instance": instance, "host": hosts[0], "hosts": hosts, "port": e.port, "txt": (e.txt as Array).duplicate()})


func _down(b: Browser, instance: String, e: Seen) -> void:
	if e.up != "":
		_down_call(b, instance)


func _down_call(b: Browser, instance: String) -> void:
	if b.on_down.is_valid():
		b.on_down.call(instance)


## Drop expired entries, then the oldest while the table is full.
func _trim_seen(b: Browser, now: float) -> void:
	for k: String in b.seen.keys():
		var e: Seen = b.seen[k]
		if now - e.at > ENTRY_TTL_SECONDS:
			b.seen.erase(k)
			_down(b, k, e)
	while b.seen.size() >= MAX_INSTANCES:
		var k: String = b.seen.keys()[0]
		var e: Seen = b.seen[k]
		b.seen.erase(k)
		_down(b, k, e)


## An advert whose PTR lapsed without a refresh is gone, as if it had said goodbye.
func _sweep(b: Browser, now: float) -> void:
	for k: String in b.seen.keys():
		var e: Seen = b.seen[k]
		if e.exp <= now or now - e.at > ENTRY_TTL_SECONDS:
			b.seen.erase(k)
			_down(b, k, e)
	b.book.expire(now)


func _browser_timers(b: Browser, now: float) -> void:
	if b.stopped:
		return
	if b.first_again >= 0.0 and now >= b.first_again:
		b.first_again = -1.0
		_ask(b)
	if now >= b.next_again:
		b.next_again = now + ASK_AGAIN_SECONDS
		_ask(b)


## One query: the service, and for each peer not yet complete its SRV, TXT and address.
func _ask(b: Browser) -> void:
	var questions: Array = [{"name": PKeyMdnsPacket.PEER_SERVICE, "type": &"PTR"}]
	for instance: String in b.seen.keys():
		var e: Seen = b.seen[instance]
		if e.up == "":
			var fq := instance + "." + PKeyMdnsPacket.PEER_SERVICE
			questions.append({"name": fq, "type": &"SRV"})
			questions.append({"name": fq, "type": &"TXT"})
			questions.append({"name": instance + ".local", "type": &"A"})
	_send(PKeyMdnsPacket.build_query(questions.slice(0, ASK_QUESTIONS)))


func _stop_browser(b: Browser) -> void:
	if b.stopped:
		return
	b.stopped = true
	_browsers.erase(b)
	_release()


# ── types ────────────────────────────────────────────────────────────────────────────────────


## The multicast socket the adapter drives. The base class is a closed socket.
class Socket extends RefCounted:
	## The next datagram: {data, source, port}; empty for none.
	func receive() -> Dictionary:
		return {}


	## Multicast `data` to the group.
	func send(_data: PackedByteArray) -> void:
		pass


	## Unicast `data` to `host`:`port` (the answer to a legacy query).
	func send_to(_data: PackedByteArray, _host: String, _port: int) -> void:
		pass


	func close() -> void:
		pass


## The real socket: a `PacketPeerUDP` bound to `0.0.0.0` and joined to the group on each interface
## by name (never "*", never an empty name: CC-13).
class UdpSocket extends Socket:
	var _udp: PacketPeerUDP


	func _init(udp: PacketPeerUDP) -> void:
		_udp = udp


	func _to_string() -> String:
		return "PKeyMdns.UdpSocket()"


	func receive() -> Dictionary:
		if _udp == null or _udp.get_available_packet_count() <= 0:
			return {}
		var data := _udp.get_packet()
		if _udp.get_packet_error() != OK:
			return {"data": PackedByteArray(), "source": "", "port": 0}
		return {"data": data, "source": _udp.get_packet_ip(), "port": _udp.get_packet_port()}


	func send(data: PackedByteArray) -> void:
		send_to(data, PKeyMdns.GROUP, PKeyMdns.PORT)


	func send_to(data: PackedByteArray, host: String, port: int) -> void:
		if _udp == null:
			return
		if _udp.set_dest_address(host, port) == OK:
			_udp.put_packet(data)


	func close() -> void:
		if _udp != null:
			_udp.close()
		_udp = null


## A socket on `port` (5353, or 0 for an ephemeral port), joined to the group on `names`; null when
## it cannot be bound or joined anywhere.
static func open_udp(port: int, names: Array) -> Socket:
	var udp := PacketPeerUDP.new()
	if udp.bind(port, "0.0.0.0") != OK:
		return null
	var joined := 0
	for n in names:
		if udp.join_multicast_group(GROUP, str(n)) == OK:
			joined += 1
	if joined == 0:
		udp.close()
		return null
	return UdpSocket.new(udp)


## What `advertise` and `browse` return. `stop()` may be called twice.
class Handle extends RefCounted:
	var _owner: PKeyMdns
	var _what: RefCounted


	func _init(owner: PKeyMdns, what: RefCounted) -> void:
		_owner = owner
		_what = what


	func _to_string() -> String:
		return "PKeyMdns.Handle()"


	## A browse handle: how many instances its table holds (0 for an advert, or once stopped).
	func tracked() -> int:
		return (_what as Browser).seen.size() if _owner != null and _what is Browser else 0


	func stop() -> void:
		if _owner == null:
			return
		var owner := _owner
		_owner = null
		if _what is Advertisement:
			owner._stop_advert(_what)
		elif _what is Browser:
			owner._stop_browser(_what)


class Advertisement extends RefCounted:
	var instance := ""
	var fqdn := ""
	var host := ""
	var port := 0
	var txt: Array = []
	var addresses: Array = []
	var last_reply := -INF
	var next_again := -1.0
	var stopped := false


class Seen extends RefCounted:
	var port := -1
	var target := ""
	var txt: Variant = null
	var up := ""
	var at := 0.0
	var exp := 0.0


class Browser extends RefCounted:
	var on_up: Callable
	var on_down: Callable
	var accept: Callable
	var seen := {}
	var book := AddressBook.new()
	var fresh := NewNameLimiter.new()
	var first_again := -1.0
	var next_again := 0.0
	var stopped := false


## The addresses learned for each host name (V5 section 15.4 "Addresses"; the `mdnsAnswers` rows):
## a record counts only when its address equals the packet's source (an IPv4-mapped source as its
## IPv4 address), whatever the address is; TTL 0 removes it; names fold by ASCII; four per name, first
## seen first. A link-local address needs the arrival interface as its zone, which this lane never
## knows (the adapter passes none), so there it learns nothing. Bounded in names: the least recently refreshed is evicted.
class AddressBook extends RefCounted:
	var _max: int
	var _m := {}


	func _init(max_names := PKeyMdns.MAX_INSTANCES) -> void:
		_max = max_names


	func _to_string() -> String:
		return "PKeyMdns.AddressBook()"


	## Apply one address record {name, type, ttl, data} from a packet sent by `source` and received on
	## `zone` (null: unknown). `admit` (Callable() -> bool) is asked only when the record would add a
	## name.
	func learn(r: Dictionary, source: String, zone: Variant, now: float, admit := Callable()) -> void:
		var want := PKeyMdnsPacket.source_address(source)
		var got := PKeyMdnsPacket.address_bytes(str(r["data"]))
		if want.is_empty() or got.is_empty() or want != got:
			return
		var address := str(r["data"])
		if got.size() == 16 and got[0] == 0xfe and (got[1] & 0xc0) == 0x80:
			# A link-local address is learned with its arrival zone; with none, it teaches nothing.
			if not (zone is String) or zone == "":
				return
			address = "%s%%%s" % [address, zone]
		var name := PKeyMdns.fold_name(str(r["name"]))
		var e: Dictionary = _m.get(name, {})
		if int(r["ttl"]) == 0:
			if e.is_empty():
				return
			var kept: Array = (e["ips"] as Array).filter(func(x: String) -> bool: return x != address)
			if kept.is_empty():
				_m.erase(name)
			else:
				e["ips"] = kept
			return
		if e.is_empty():
			if admit.is_valid() and not bool(admit.call()):
				return
			if _m.size() >= _max:
				trim(now)
			e = {"ips": [], "at": now}
		else:
			_m.erase(name)
		if not (e["ips"] as Array).has(address) and (e["ips"] as Array).size() < PKeyMdns.MAX_ADDRESSES:
			(e["ips"] as Array).append(address)
		e["at"] = now
		_m[name] = e  # most recently refreshed last


	## The addresses held for `name`, first seen first.
	func hosts(name: String) -> Array:
		var e: Dictionary = _m.get(PKeyMdns.fold_name(name), {})
		return (e["ips"] as Array).duplicate() if not e.is_empty() else []


	## Seed the table (a conformance row's `prior`).
	func hold(name: String, address: String, now := 0.0) -> void:
		var n := PKeyMdns.fold_name(name)
		var e: Dictionary = _m.get(n, {"ips": [], "at": now})
		(e["ips"] as Array).append(address)
		_m[n] = e


	## The table as [{name, address}], grouped by name, each name first seen first.
	func table() -> Array:
		var out: Array = []
		for n: String in _m.keys():
			for a: String in _m[n]["ips"]:
				out.append({"name": n, "address": a})
		return out


	func size() -> int:
		return _m.size()


	func expire(now: float) -> void:
		for k: String in _m.keys():
			if now - float(_m[k]["at"]) > PKeyMdns.ENTRY_TTL_SECONDS:
				_m.erase(k)


	## Drop expired entries, then the oldest while full.
	func trim(now: float) -> void:
		expire(now)
		while _m.size() >= _max:
			_m.erase(_m.keys()[0])


## At most MAX_NEW_PER_SOURCE new names per source in NEW_WINDOW_SECONDS, so one host cannot crowd
## the tables. The least recently seen source is forgotten when MAX_SOURCES are tracked.
class NewNameLimiter extends RefCounted:
	var _m := {}


	func _to_string() -> String:
		return "PKeyMdns.NewNameLimiter()"


	## May `source` add one more new name now? Counts the name when it may.
	func admit(source: String, now: float) -> bool:
		var held: Array = []
		for t: float in _m.get(source, []):
			if now - t < PKeyMdns.NEW_WINDOW_SECONDS:
				held.append(t)
		_m.erase(source)
		var ok := held.size() < PKeyMdns.MAX_NEW_PER_SOURCE
		if ok:
			held.append(now)
		_m[source] = held
		while _m.size() > PKeyMdns.MAX_SOURCES:
			_m.erase(_m.keys()[0])
		return ok
