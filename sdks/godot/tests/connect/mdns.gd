extends RefCounted
# @pkey-feature connect.lan
# The mDNS adapter (PKeyMdns, CC-14.11; WIRE-CONTRACT-V5 section 15.4, plan CC-14 D-5 and D-6) over a
# fake `PacketPeerUDP` and a fake clock, ported from the Node `connectMdns.test.ts` and the Python
# `test_peer_mdns`: the interface filter, the address book against every `mdnsAnswers` row, the
# advert (what it says, when, and the goodbye), the once-a-second reply and the unicast answer to a
# legacy query, the browse rules (the A record equals the packet source, the private block, the
# roster filter, the SRV port, the per-source limit, tables of 256, PTR expiry), the querier-only and
# unavailable lanes, the datagram budget of a poll, and the real socket class on loopback. Under
# `PKEY_LIVE_MDNS=1` it also asks the real network for a few seconds (sockets closed on every path).

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"
const INST_A := "p1-aaaaaaaaaaaaaaaa"
const INST_B := "p1-bbbbbbbbbbbbbbbb"
const SERVICE := PKeyMdnsPacket.PEER_SERVICE
const PORT_A := 40001


## A fake multicast socket: datagrams in `inbox` arrive one per receive(), what is sent is recorded.
class FakeSocket extends PKeyMdns.Socket:
	var inbox: Array = []
	var multicast: Array = []
	var unicast: Array = []
	var closed := false
	var port := 0
	var joined: Array = []


	func receive() -> Dictionary:
		return inbox.pop_front() if not inbox.is_empty() else {}


	func send(data: PackedByteArray) -> void:
		multicast.append(data)


	func send_to(data: PackedByteArray, host: String, p: int) -> void:
		unicast.append({"data": data, "host": host, "port": p})


	func join(names: Array) -> void:
		joined.append_array(names)


	func close() -> void:
		closed = true


	func push(data: PackedByteArray, source: String, p := 5353) -> void:
		inbox.append({"data": data, "source": source, "port": p})


## The fake network and clock one adapter runs on.
class World extends RefCounted:
	var t := 1000.0
	var sockets: Array = []
	var calls: Array = []
	var refuse_5353 := false
	var refuse_all := false
	var interfaces: Array = [
		{"index": 1, "name": "lo0", "friendly": "lo0", "addresses": ["127.0.0.1", "::1"]},
		{"index": 4, "name": "en0", "friendly": "en0", "addresses": ["fe80::1", "192.168.1.10"]},
	]


	func clock() -> float:
		return t


	func make_socket(port: int, names: Array) -> PKeyMdns.Socket:
		calls.append([port, names])
		if refuse_all or (refuse_5353 and port == 5353):
			return null
		var s := FakeSocket.new()
		s.port = port
		sockets.append(s)
		return s


	func list() -> Array:
		return interfaces


	func adapter(extra := {}) -> PKeyMdns:
		var o := {"socket": Callable(self, "make_socket"), "interfaces": Callable(self, "list"), "clock": Callable(self, "clock"), "drive": false}
		for k in extra:
			o[k] = extra[k]
		return PKeyMdns.new(o)


	func last() -> FakeSocket:
		return sockets[sockets.size() - 1]


class Found extends RefCounted:
	var up: Array = []
	var down: Array = []
	var allowed: Array = []
	var allow := true


	func on_up(f: Dictionary) -> void:
		up.append(f)


	func on_down(i: String) -> void:
		down.append(i)


	func accept(i: String) -> bool:
		allowed.append(i)
		return allow


func run(t: PKeyTestContext) -> void:
	_names(t)
	_interfaces(t)
	_address_book(t)
	_address_lapse(t)
	_book_rows(t)
	_limiter(t)
	_advertise(t)
	_replies(t)
	_browse(t)
	_browse_rules(t)
	_tables(t)
	_expiry(t)
	_lanes(t)
	_off_link(t)
	_legacy_ttl(t)
	_interface_refresh(t)
	_budget(t)
	_real_socket(t)
	await _live(t)


# ── helpers ──────────────────────────────────────────────────────────────────────────────────


## The i-th instance name: 16 base32 letters (digits 0, 1, 8 and 9 are not in the alphabet).
static func _inst(i: int) -> String:
	var letters := ""
	var n := i
	for k in 16:
		letters = char(97 + n % 26) + letters
		n /= 26
	return "p1-" + letters


static func _srv(inst: String, port := PORT_A, target := "") -> Dictionary:
	return {"name": inst + "." + SERVICE, "type": &"SRV", "ttl": 120, "data": {"port": port, "target": target if target != "" else inst + ".local", "priority": 0, "weight": 0}}


static func _txt(inst: String, entries := ["v=1", "m=a"]) -> Dictionary:
	return {"name": inst + "." + SERVICE, "type": &"TXT", "ttl": 4500, "data": entries}


static func _ptr(inst: String, ttl := 120) -> Dictionary:
	return {"name": SERVICE, "type": &"PTR", "ttl": ttl, "data": inst + "." + SERVICE}


static func _a(inst: String, ip: String, ttl := 120) -> Dictionary:
	return {"name": inst + ".local", "type": &"A", "ttl": ttl, "data": ip}


static func _advert_packet(inst: String, ip: String, port := PORT_A) -> PackedByteArray:
	return PKeyMdnsPacket.build_response([_ptr(inst), _srv(inst, port), _txt(inst), _a(inst, ip)])


## A browse over a fresh world, the socket open and the first query sent.
func _browser(w: World, f: Found, extra := {}) -> Array:
	var m := w.adapter(extra)
	var r := m.browse(Callable(f, "on_up"), Callable(f, "on_down"), Callable(f, "accept"))
	return [m, r]


func _types(packet: PackedByteArray) -> Array:
	var p := PKeyMdnsPacket.parse(packet)
	if not p["ok"]:
		return []
	var out: Array = []
	for r: Dictionary in p["answers"]:
		out.append(str(r["type"]))
	return out


# ── pure helpers ─────────────────────────────────────────────────────────────────────────────


func _names(t: PKeyTestContext) -> void:
	t.check("fold_name folds A to Z only", PKeyMdns.fold_name("P1-ABCdef._PkeyPeer.Local") == "p1-abcdef._pkeypeer.local" and PKeyMdns.fold_name("ÉA") == "Éa")
	t.check("an instance is read from its FQDN", PKeyMdns.instance_of_fqdn(INST_A + "._pkeypeer._tcp.local") == INST_A)
	t.check("not from a wrong service, suffix, case or length", PKeyMdns.instance_of_fqdn(INST_A + "._other._tcp.local") == "" and
		PKeyMdns.instance_of_fqdn(INST_A + "._pkeypeer._tcp.local.x") == "" and PKeyMdns.instance_of_fqdn("p1-AAAAAAAAAAAAAAAA._pkeypeer._tcp.local") == "" and
		PKeyMdns.instance_of_fqdn("p1-aaaaaaaaaaaaaaa._pkeypeer._tcp.local") == "")
	t.check("and from its host name", PKeyMdns.instance_of_host(INST_A + ".local") == INST_A and PKeyMdns.instance_of_host("laptop.local") == "" and
		PKeyMdns.instance_of_host(INST_A + ".local\n") == "")
	t.check("private blocks", PKeyMdns.private_block("10.1.2.3") == "10" and PKeyMdns.private_block("172.16.0.1") == "172.16" and PKeyMdns.private_block("172.31.255.1") == "172.16" and
		PKeyMdns.private_block("192.168.9.9") == "192.168" and PKeyMdns.private_block("127.0.0.1") == "127")
	t.check("and nothing else is a block", PKeyMdns.private_block("172.15.0.1") == "" and PKeyMdns.private_block("172.32.0.1") == "" and PKeyMdns.private_block("8.8.8.8") == "" and
		PKeyMdns.private_block("169.254.1.1") == "" and PKeyMdns.private_block("100.64.0.1") == "" and PKeyMdns.private_block("fe80::1") == "" and PKeyMdns.private_block("") == "")


func _interfaces(t: PKeyTestContext) -> void:
	var raw: Array = [
		{"name": "en0", "friendly": "en0", "addresses": ["fe80::1", "192.168.1.10", "8.8.8.8"]},
		{"name": "lo0", "addresses": ["127.0.0.1"]},
		{"name": "utun3", "addresses": ["10.9.9.9"]},
		{"name": "awdl0", "addresses": ["192.168.7.7"]},
		{"name": "rmnet_data0", "addresses": ["10.64.12.5"]},
		{"name": "ccmni1", "addresses": ["10.65.1.1"]},
		{"name": "pdp_ip0", "addresses": ["10.66.2.2"]},
		{"name": "v4-rmnet_data0", "addresses": ["192.0.0.4"]},
		{"name": "clat4", "addresses": ["10.67.0.1"]},
		{"name": "{AB-CD}", "friendly": "vEthernet (Default Switch)", "addresses": ["172.20.0.1"]},
		{"name": "{EF-GH}", "friendly": "Ethernet", "addresses": ["10.0.0.5", "10.0.0.5"]},
		{"name": "br0", "addresses": ["169.254.3.3", "100.64.0.5"]},
		{"name": "wlan9", "addresses": ["fd12::5"]},
		"junk",
		{"addresses": ["10.1.1.1"]},
	]
	var u := PKeyMdns.usable_interfaces(raw, false)
	var names: Array = u.map(func(f: Dictionary) -> String: return f["name"])
	t.check("interfaces: a LAN one is kept, sorted by name, v4 only, no duplicate", names == ["en0", "{EF-GH}"] and u[0]["addresses"] == ["192.168.1.10"] and
		u[1]["addresses"] == ["10.0.0.5"], str(u))
	t.check("interfaces: loopback, tunnel, direct-link, virtual, link-local, CGNAT and v6-only are dropped", not names.has("lo0") and not names.has("utun3") and not names.has("awdl0") and
		not names.has("{AB-CD}") and not names.has("br0") and not names.has("wlan9"))
	t.check("interfaces: so are the carrier's mobile-data interfaces (R-6G2 N4)", not names.has("rmnet_data0") and not names.has("ccmni1") and not names.has("pdp_ip0") and
		not names.has("v4-rmnet_data0") and not names.has("clat4"), str(names))
	var withlo := PKeyMdns.usable_interfaces(raw, true)
	t.check("interfaces: loopback only when allowed", withlo.map(func(f: Dictionary) -> String: return f["name"]).has("lo0"))
	var only_name := PKeyMdns.usable_interfaces(raw, false, ["en0"])
	var only_addr := PKeyMdns.usable_interfaces(raw, false, ["10.0.0.5"])
	t.check("interfaces: `only` names an interface or one of its addresses", only_name.size() == 1 and only_name[0]["name"] == "en0" and only_addr.size() == 1 and
		only_addr[0]["name"] == "{EF-GH}")
	var many: Array = []
	for i in 12:
		many.append({"name": "eth%02d" % i, "addresses": ["10.0.%d.1" % i]})
	var capped := PKeyMdns.usable_interfaces(many, false)
	t.check("interfaces: at most eight", capped.size() == PKeyMdns.MAX_INTERFACES and capped[0]["name"] == "eth00" and capped[7]["name"] == "eth07")
	t.check("interfaces: the engine's own list is an Array", PKeyMdns.local_interfaces() is Array)


# ── the address book ─────────────────────────────────────────────────────────────────────────


func _rec(name: String, ip: String, ttl := 120) -> Dictionary:
	return {"name": name, "type": &"A" if ip.contains(".") else &"AAAA", "ttl": ttl, "data": ip}


func _address_book(t: PKeyTestContext) -> void:
	var b := PKeyMdns.AddressBook.new()
	b.learn(_rec("P1-X.local", "192.168.1.5"), "192.168.1.5", null, 1.0)
	t.check("book: a record equal to the source is kept, the name is folded", b.hosts("p1-x.local") == ["192.168.1.5"] and b.hosts("P1-X.LOCAL") == ["192.168.1.5"])
	b.learn(_rec("p1-x.local", "192.168.1.6"), "192.168.1.5", null, 2.0)
	t.check("book: a record that is not the source teaches nothing", b.hosts("p1-x.local") == ["192.168.1.5"])
	b.learn(_rec("p1-x.local", "192.168.1.5"), "::ffff:192.168.1.5", null, 3.0)
	t.check("book: an IPv4-mapped source is its IPv4 address, and a repeat is not a second", b.hosts("p1-x.local") == ["192.168.1.5"])
	for ip in ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]:
		b.learn(_rec("p1-x.local", ip), ip, null, 4.0)
	t.check("book: four addresses per name, first seen first, a fifth is dropped", b.hosts("p1-x.local") == ["192.168.1.5", "10.0.0.1", "10.0.0.2", "10.0.0.3"])
	b.learn(_rec("p1-x.local", "10.0.0.1", 0), "10.0.0.1", null, 5.0)
	t.check("book: TTL 0 removes that address and keeps the order of the rest", b.hosts("p1-x.local") == ["192.168.1.5", "10.0.0.2", "10.0.0.3"])
	b.learn(_rec("p1-x.local", "10.0.0.9", 0), "10.0.0.9", null, 5.0)
	t.check("book: a goodbye for an address never held learns nothing", b.hosts("p1-x.local").size() == 3 and b.hosts("p1-nobody.local").is_empty())
	b.learn(_rec("p1-x.local", "fe80::5"), "fe80::5", null, 6.0)
	t.check("book: link-local with no arrival zone teaches nothing", b.hosts("p1-x.local").size() == 3)
	b.learn(_rec("p1-x.local", "fe80::5"), "fe80::5", "en0", 6.0)
	t.check("book: link-local with a zone is kept with it", b.hosts("p1-x.local").has("fe80::5%en0"))
	b.learn(_rec("p1-y.local", "10.5.5.5"), "10.5.5.5", null, 7.0, func() -> bool: return false)
	t.check("book: admit is asked for a new name, and a no keeps it out", b.hosts("p1-y.local").is_empty())
	var asked := [0]
	b.learn(_rec("p1-x.local", "10.0.0.2"), "10.0.0.2", null, 7.0, func() -> bool:
		asked[0] += 1
		return false)
	t.check("book: but not for a name already held", asked[0] == 0)

	var small := PKeyMdns.AddressBook.new(3)
	for i in 4:
		small.learn(_rec("p1-%d.local" % i, "10.0.0.%d" % (i + 1)), "10.0.0.%d" % (i + 1), null, float(i))
	t.check("book: when full the least recently refreshed name goes", small.size() == 3 and small.hosts("p1-0.local").is_empty() and small.hosts("p1-3.local") == ["10.0.0.4"])
	small.learn(_rec("p1-1.local", "10.0.0.2"), "10.0.0.2", null, 10.0)
	small.learn(_rec("p1-4.local", "10.0.0.5"), "10.0.0.5", null, 11.0)
	t.check("book: a refresh moves a name to the back", small.hosts("p1-1.local") == ["10.0.0.2"] and small.hosts("p1-2.local").is_empty())
	var aged := PKeyMdns.AddressBook.new()
	aged.learn(_rec("p1-a.local", "10.0.0.1"), "10.0.0.1", null, 0.0)
	aged.expire(PKeyMdns.ENTRY_TTL_SECONDS + 1.0)
	t.check("book: an entry lives five minutes", aged.size() == 0)
	var seeded := PKeyMdns.AddressBook.new()
	seeded.hold("P1-Z.local", "10.0.0.1")
	t.check("book: hold seeds, table lists", seeded.table() == [{"name": "p1-z.local", "address": "10.0.0.1"}])


## An address lapses five minutes after it was last seen, even while its name is refreshed.
func _address_lapse(t: PKeyTestContext) -> void:
	var life := PKeyMdns.ENTRY_TTL_SECONDS
	var b := PKeyMdns.AddressBook.new()
	for ip in ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]:
		b.learn(_rec("p1-x.local", ip), ip, null, 0.0)
	t.check("lapse: a place is held while its address is fresh", b.hosts("p1-x.local", life - 1.0).size() == 4)
	t.check("lapse: and left out of hosts once it is older than five minutes", b.hosts("p1-x.local", life + 1.0).is_empty())
	b.learn(_rec("p1-x.local", "10.0.0.9"), "10.0.0.9", null, life + 1.0)
	t.check("lapse: a new address frees the places of lapsed ones", b.hosts("p1-x.local") == ["10.0.0.9"], str(b.hosts("p1-x.local")))
	var kept := PKeyMdns.AddressBook.new()
	for ip in ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]:
		kept.learn(_rec("p1-x.local", ip), ip, null, 0.0)
	kept.learn(_rec("p1-x.local", "10.0.0.1"), "10.0.0.1", null, 200.0)
	t.check("lapse: a refresh of the name does not keep the others", kept.hosts("p1-x.local", life + 1.0) == ["10.0.0.1"], str(kept.hosts("p1-x.local", life + 1.0)))
	kept.learn(_rec("p1-x.local", "10.0.0.7"), "10.0.0.7", null, life + 2.0)
	t.check("lapse: a re-seen address stays and the lapsed places are free", kept.hosts("p1-x.local") == ["10.0.0.1", "10.0.0.7"], str(kept.hosts("p1-x.local")))


## The mDNS corpus rows through the adapter's book, as the codec's `learn` runs them.
func _book_rows(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var rows: Array = (j.data as Dictionary)["mdnsAnswers"]["rows"]
	var good := 0
	for row in rows:
		var book := PKeyMdns.AddressBook.new()
		for e in row.get("prior", []):
			book.hold(e["name"], e["address"])
		var p := PKeyMdnsPacket.parse((row["packet"] as String).hex_decode())
		if p["ok"]:
			for r: Dictionary in p["answers"]:
				if r["type"] == &"A" or r["type"] == &"AAAA":
					book.learn(r, row["source"], row["zone"], 0.0)
		if t.check("book row %s" % row["id"], p["ok"] and book.table() == _regroup(row["learned"]), str(book.table())):
			good += 1
	t.check("book: %d mdnsAnswers rows, all pass" % rows.size(), good == rows.size() and rows.size() == 37, "%d/%d" % [good, rows.size()])


## A corpus table (first-seen order) as the book lists it: grouped by name, names in first-seen order.
static func _regroup(learned: Array) -> Array:
	var order: Array = []
	for e in learned:
		if not order.has(e["name"]):
			order.append(e["name"])
	var out: Array = []
	for n in order:
		for e in learned:
			if e["name"] == n:
				out.append(e)
	return out


func _limiter(t: PKeyTestContext) -> void:
	var l := PKeyMdns.NewNameLimiter.new()
	var ok := 0
	for i in 20:
		if l.admit("10.0.0.7", 100.0 + i):
			ok += 1
	t.check("new names: 16 a minute from one source", ok == 16)
	t.check("new names: another source has its own allowance", l.admit("10.0.0.8", 110.0))
	t.check("new names: the window slides", l.admit("10.0.0.7", 100.0 + 61.0))
	var many := PKeyMdns.NewNameLimiter.new()
	for i in 300:
		many.admit("10.1.%d.%d" % [i / 250, i % 250], 1.0)
	t.check("new names: at most 256 sources are tracked", many._m.size() == PKeyMdns.MAX_SOURCES)


# ── advertise ────────────────────────────────────────────────────────────────────────────────


func _advertise(t: PKeyTestContext) -> void:
	var w := World.new()
	var m := w.adapter()
	var r := m.advertise({"instance": INST_A, "port": PORT_A, "txt": ["v=1", "m=a"]})
	t.check("advertise: ok with a handle", r.ok and r.detail is PKeyMdns.Handle and str(r.detail) == "PKeyMdns.Handle()")
	t.check("advertise: the 5353 socket is tried first, on the usable interface only", w.calls == [[5353, ["en0"]]], str(w.calls))
	var s := w.last()
	t.check("advertise: it says its records at once", s.multicast.size() == 1)
	var p := PKeyMdnsPacket.parse(s.multicast[0])
	t.check("advertise: a response of PTR, SRV, TXT and A", p["ok"] and p["response"] and _types(s.multicast[0]) == ["PTR", "SRV", "TXT", "A"])
	var by := {}
	for rec: Dictionary in p["answers"]:
		by[str(rec["type"])] = rec
	t.check("advertise: the PTR names the instance under the service", by["PTR"]["name"] == SERVICE and by["PTR"]["data"] == INST_A + "." + SERVICE and by["PTR"]["ttl"] == 120)
	t.check("advertise: the SRV is the port, with the host named after the instance", by["SRV"]["data"]["port"] == PORT_A and by["SRV"]["data"]["target"] == INST_A + ".local")
	t.check("advertise: the TXT is the advert's, with its own TTL", by["TXT"]["data"] == ["v=1", "m=a"] and by["TXT"]["ttl"] == 4500)
	t.check("advertise: the A record is the interface's LAN address", by["A"]["name"] == INST_A + ".local" and by["A"]["data"] == "192.168.1.10")
	t.check("advertise: the machine's name is nowhere in it", not (s.multicast[0] as PackedByteArray).get_string_from_ascii().contains("laptop"))
	m.poll()
	t.check("advertise: nothing more before the second announce", s.multicast.size() == 1)
	w.t += 1.0
	m.poll()
	t.check("advertise: and once more a second later", s.multicast.size() == 2)
	w.t += 5.0
	m.poll()
	t.check("advertise: but no more after that", s.multicast.size() == 2)
	t.check("advertise: status is a responder", m.status() == {"active": true, "responder": true, "querier": true, "reason": ""})
	(r.detail as PKeyMdns.Handle).stop()
	t.check("advertise: stop sends the goodbye, every record at TTL 0", s.multicast.size() == 3 and _ttls(s.multicast[2]) == [0, 0, 0, 0])
	t.check("advertise: and closes the socket", s.closed and not m.is_open())
	(r.detail as PKeyMdns.Handle).stop()
	t.check("advertise: stopping twice is nothing", s.multicast.size() == 3)

	var bad_name := w.adapter().advertise({"instance": "laptop", "port": 1234, "txt": []})
	var bad_port := w.adapter().advertise({"instance": INST_A, "port": 0, "txt": []})
	var big_port := w.adapter().advertise({"instance": INST_A, "port": 65536, "txt": []})
	t.check("advertise: a bad name or port is refused before a socket is opened", not bad_name.ok and not bad_port.ok and not big_port.ok and bad_name.code == &"invalid-argument" and
		w.calls.size() == 1)
	var w2 := World.new()
	w2.interfaces = [{"name": "lo0", "addresses": ["127.0.0.1"]}]
	var lo := w2.adapter({"allow_loopback": true}).advertise({"instance": INST_A, "port": PORT_A, "txt": []})
	var a_rec: Dictionary = PKeyMdnsPacket.parse(w2.last().multicast[0])["answers"][3] if lo.ok else {}
	t.check("advertise: loopback is advertised only when allowed", lo.ok and a_rec.get("data") == "127.0.0.1")
	var w3 := World.new()
	var own := w3.adapter({"addresses": func() -> Array: return ["10.9.9.9", "8.8.8.8", "169.254.1.1", "10.9.9.9", "192.168.4.4"]})
	own.advertise({"instance": INST_A, "port": PORT_A, "txt": []})
	var shown: Array = PKeyMdnsPacket.parse(w3.last().multicast[0])["answers"].filter(func(x: Dictionary) -> bool: return x["type"] == &"A").map(func(x: Dictionary) -> String: return x["data"])
	t.check("advertise: own addresses are filtered to LAN ones, once each", shown == ["10.9.9.9", "192.168.4.4"], str(shown))
	var w4 := World.new()
	var none := w4.adapter({"addresses": func() -> Array: return ["8.8.8.8"]})
	none.advertise({"instance": INST_A, "port": PORT_A, "txt": []})
	t.check("advertise: with no address there is nothing to say", w4.last().multicast.is_empty())


static func _ttls(packet: PackedByteArray) -> Array:
	return (PKeyMdnsPacket.parse(packet)["answers"] as Array).map(func(r: Dictionary) -> int: return r["ttl"])


func _replies(t: PKeyTestContext) -> void:
	var w := World.new()
	var m := w.adapter()
	m.advertise({"instance": INST_A, "port": PORT_A, "txt": ["v=1", "m=a"]})
	var s := w.last()
	var service_q := PKeyMdnsPacket.build_query([{"name": SERVICE, "type": &"PTR"}])
	s.push(service_q, "192.168.1.20")
	m.poll()
	t.check("reply: a query for the service is answered by multicast", s.multicast.size() == 2 and _types(s.multicast[1]) == ["PTR", "SRV", "TXT", "A"] and s.unicast.is_empty())
	s.push(service_q, "192.168.1.21")
	m.poll()
	t.check("reply: but at most once a second", s.multicast.size() == 2)
	w.t += 1.0
	s.push(PKeyMdnsPacket.build_query([{"name": INST_A + "." + SERVICE, "type": &"SRV"}]), "192.168.1.20")
	m.poll()
	t.check("reply: a query for the instance is answered a second later", s.multicast.size() == 4)
	var before := s.multicast.size()
	w.t += 2.0
	s.push(PKeyMdnsPacket.build_query([{"name": INST_A.to_upper() + ".LOCAL", "type": &"A"}]), "192.168.1.20")
	m.poll()
	t.check("reply: and one for the host name, by ASCII fold", s.multicast.size() == before + 1)
	w.t += 2.0
	var count := s.multicast.size()
	s.push(PKeyMdnsPacket.build_query([{"name": "_other._tcp.local", "type": &"PTR"}, {"name": "laptop.local", "type": &"A"}]), "192.168.1.20")
	s.push(PKeyMdnsPacket.build_response([_ptr(INST_B)]), "192.168.1.20")
	s.push(PackedByteArray([1, 2, 3]), "192.168.1.20")
	m.poll()
	t.check("reply: another service, another host, a response and noise are not answered", s.multicast.size() == count)
	# A legacy query (source port other than 5353): a unicast answer that carries the query's ID, short TTL.
	w.t += 2.0
	var legacy := PKeyMdnsPacket.build_query([{"name": SERVICE, "type": &"PTR"}], 0x1234)
	s.push(legacy, "192.168.1.30", 51515)
	m.poll()
	t.check("reply: a legacy query is answered by unicast to its source and port", s.unicast.size() == 1 and s.unicast[0]["host"] == "192.168.1.30" and s.unicast[0]["port"] == 51515 and
		s.multicast.size() == count)
	var answer: PackedByteArray = s.unicast[0]["data"]
	var ttls := _ttls(answer)
	var short := ttls.all(func(x: int) -> bool: return x == PKeyMdns.LEGACY_TTL)
	t.check("reply: carrying its ID, and every record, TXT included, at TTL 10", answer[0] == 0x12 and answer[1] == 0x34 and short and ttls.size() == 4, str(ttls))
	var parsed_answer := PKeyMdnsPacket.parse(answer)
	t.check("reply: repeating the question (RFC 6762 section 6.7)", parsed_answer["ok"] and parsed_answer["questions"] == [{"name": SERVICE, "type": &"PTR"}], str(parsed_answer.get("questions")))
	# No cache-flush bit on any record: only the class bytes differ from the multicast build, one per unique record.
	var recs := m._records(m._adverts[0], PKeyMdns.LEGACY_TTL)
	var flushed := PKeyMdnsPacket.build_response(recs, true, [{"name": SERVICE, "type": &"PTR"}])
	var diff := 0
	for i in answer.size():
		if i > 1 and answer[i] != flushed[i]:
			diff += 1
	var plain := PKeyMdnsPacket.build_response(recs, false, [{"name": SERVICE, "type": &"PTR"}])
	t.check("reply: and no cache-flush bit (the three unique records would carry it)", answer.size() == flushed.size() and diff == 3 and plain.slice(2) == answer.slice(2), str(diff))
	# At most four of a query's questions are repeated.
	w.t += 2.0
	var many := PKeyMdnsPacket.build_query([{"name": SERVICE, "type": &"PTR"}, {"name": INST_A + "." + SERVICE, "type": &"SRV"}, {"name": INST_A + "." + SERVICE, "type": &"TXT"},
		{"name": INST_A + ".local", "type": &"A"}, {"name": INST_A + ".local", "type": &"AAAA"}, {"name": "x.local", "type": &"A"}], 0x0707)
	s.push(many, "192.168.1.30", 51516)
	m.poll()
	var repeated := PKeyMdnsPacket.parse(s.unicast[s.unicast.size() - 1]["data"])
	var echoed: Array = repeated.get("questions", [])
	t.check("reply: a query with six questions is answered repeating four", repeated["ok"] and echoed.size() == PKeyMdnsPacket.MAX_REPEATED_QUESTIONS, str(echoed))
	m.advertise({"instance": INST_B, "port": PORT_A, "txt": []})
	t.check("reply: a second advert shares the socket", w.sockets.size() == 1 and w.calls.size() == 1)

	var w2 := World.new()
	var m2 := w2.adapter()
	m2.advertise({"instance": INST_A, "port": PORT_A, "txt": []})
	var s2 := w2.last()
	s2.push(service_q, "192.168.1.20")
	s2.push(service_q, "192.168.1.20")
	m2.poll()
	t.check("reply: two queries in one poll get one answer", s2.multicast.size() == 2)


## A datagram from outside the link's private blocks is neither parsed, answered nor learned from, and
## burns no reply gap (R-6G2 B2). A legacy unicast answer goes only to a port at or above 1024.
func _off_link(t: PKeyTestContext) -> void:
	var w := World.new()
	var m := w.adapter()
	m.advertise({"instance": INST_A, "port": PORT_A, "txt": ["v=1", "m=a"]})
	var s := w.last()
	var legacy := PKeyMdnsPacket.build_query([{"name": SERVICE, "type": &"PTR"}], 0x4321)
	var base := s.multicast.size()
	s.push(legacy, "8.8.8.8", 40000)
	s.push(legacy, "10.0.0.9", 40000)
	s.push(legacy, "172.20.1.1", 40000)
	s.push(PKeyMdnsPacket.build_query([{"name": SERVICE, "type": &"PTR"}]), "8.8.8.8", 5353)
	s.push(PKeyMdnsPacket.build_query([{"name": SERVICE, "type": &"PTR"}]), "10.0.0.9", 5353)
	m.poll()
	t.check("off-link: a legacy query from a public or an off-block source is answered by nothing", s.unicast.is_empty() and s.multicast.size() == base)
	# The refusals took no turn of the reply gap: an on-link query in the same second is answered.
	s.push(legacy, "192.168.1.30", 40000)
	m.poll()
	t.check("off-link: and burned no reply gap: the next on-link legacy query is answered with its ID", s.unicast.size() == 1 and s.unicast[0]["host"] == "192.168.1.30" and
		s.unicast[0]["data"][0] == 0x43 and s.unicast[0]["data"][1] == 0x21)
	# A port below 1024 is never answered by unicast, and takes no turn either.
	w.t += 2.0
	m.poll()  # the advert's second announcement goes out now
	base = s.multicast.size()
	s.push(legacy, "192.168.1.30", 53)
	s.push(legacy, "192.168.1.30", 1023)
	m.poll()
	t.check("off-link: a legacy query from a port under 1024 is answered by nothing", s.unicast.size() == 1 and s.multicast.size() == base)
	s.push(legacy, "192.168.1.30", 1024)
	m.poll()
	t.check("off-link: and from 1024 up it is", s.unicast.size() == 2 and s.unicast[1]["port"] == 1024)
	# 5353 is the multicast answer, never a unicast one.
	w.t += 2.0
	s.push(PKeyMdnsPacket.build_query([{"name": SERVICE, "type": &"PTR"}]), "192.168.1.30", 5353)
	m.poll()
	t.check("off-link: a query from 5353 is answered by multicast", s.unicast.size() == 2 and s.multicast.size() == base + 1)
	# Nothing is parsed: a response from outside teaches nothing, and a flood of garbage costs no parse.
	var f := Found.new()
	var made := _browser(w, f)
	var bs := w.last()
	bs.push(_advert_packet(INST_B, "10.0.0.9"), "10.0.0.9")
	bs.push(_advert_packet(INST_B, "8.8.8.8"), "8.8.8.8")
	(made[0] as PKeyMdns).poll()
	t.check("off-link: a response from outside the block teaches nothing", f.up.is_empty() and f.allowed.is_empty())
	bs.push(_advert_packet(INST_B, "192.168.1.31"), "192.168.1.31")
	(made[0] as PKeyMdns).poll()
	t.check("off-link: one from the block does", f.up.size() == 1)


## A legacy answer carries PTR TTL 10; a querier-only device asks every 30 s, so the peer must stay up
## in between (R-6G2 N1).
func _legacy_ttl(t: PKeyTestContext) -> void:
	var w := World.new()
	w.refuse_5353 = true
	var f := Found.new()
	var made := _browser(w, f)
	var m: PKeyMdns = made[0]
	var s := w.last()
	var answer := func() -> PackedByteArray:
		return PKeyMdnsPacket.build_response([_ptr(INST_A, PKeyMdns.LEGACY_TTL), _srv(INST_A), _txt(INST_A), _a(INST_A, "192.168.1.20")])
	s.push(answer.call(), "192.168.1.20", 5353)
	m.poll()
	t.check("legacy ttl: the first answer reports the peer up", f.up.size() == 1)
	for i in 6:
		w.t += 5.0
		m.poll()
	t.check("legacy ttl: 30 s later, before the re-ask, the peer is still up (no lost)", f.down.is_empty() and f.up.size() == 1, str(f.down))
	s.push(answer.call(), "192.168.1.20", 5353)
	m.poll()
	for i in 6:
		w.t += 5.0
		m.poll()
	t.check("legacy ttl: a refreshed answer keeps it up another 30 s, and never found again", f.down.is_empty() and f.up.size() == 1)
	# Unrefreshed it does lapse, soon after the next ask would have been answered.
	for i in 3:
		w.t += 5.0
		m.poll()
	t.check("legacy ttl: with no refresh it lapses", f.down == [INST_A], str(f.down))


## The interface list is read again in the sweep: the link's blocks follow a network change, a new
## interface is joined, and an advert's addresses follow (R-6G2 N4).
func _interface_refresh(t: PKeyTestContext) -> void:
	var w := World.new()
	var f := Found.new()
	var m := w.adapter()
	var adv := m.advertise({"instance": INST_A, "port": PORT_A, "txt": []})
	var made := m.browse(Callable(f, "on_up"), Callable(f, "on_down"), Callable(f, "accept"))
	var s := w.last()
	t.check("refresh: on 192.168 a 10.x source is off the link", not m.source_on_link("10.0.0.9") and m.source_on_link("192.168.1.9") and made.ok)
	var sent := s.multicast.size()
	# Wi-Fi to a 10.x network, and a second interface.
	w.interfaces = [
		{"index": 4, "name": "en0", "friendly": "en0", "addresses": ["10.0.0.20"]},
		{"index": 5, "name": "en1", "friendly": "en1", "addresses": ["172.20.0.5"]},
		{"index": 9, "name": "rmnet_data0", "friendly": "rmnet_data0", "addresses": ["192.168.77.7"]},
	]
	w.t += PKeyMdns.SWEEP_SECONDS + 0.1
	m.poll()
	m.poll()
	t.check("refresh: after a sweep the blocks follow the network", m.source_on_link("10.0.0.9") and m.source_on_link("172.20.1.1") and not m.source_on_link("192.168.1.9"))
	t.check("refresh: the group is joined on the new interface only", s.joined == ["en1"], str(s.joined))
	var ads := PKeyMdnsPacket.parse(s.multicast[s.multicast.size() - 1])
	var addrs: Array = (ads["answers"] as Array).filter(func(r: Dictionary) -> bool: return r["type"] == &"A").map(func(r: Dictionary) -> String: return r["data"])
	t.check("refresh: and the advert is announced again with the new addresses", s.multicast.size() > sent and addrs == ["10.0.0.20", "172.20.0.5"], str(addrs))
	# No usable interface: fail closed.
	w.interfaces = []
	w.t += PKeyMdns.SWEEP_SECONDS + 0.1
	m.poll()
	t.check("refresh: with no interface left no source is on the link", not m.source_on_link("10.0.0.9") and not m.source_on_link("192.168.1.9"))
	(adv.detail as PKeyMdns.Handle).stop()
	(made.detail as PKeyMdns.Handle).stop()


# ── browse ───────────────────────────────────────────────────────────────────────────────────


func _browse(t: PKeyTestContext) -> void:
	var w := World.new()
	var f := Found.new()
	var made := _browser(w, f)
	var m: PKeyMdns = made[0]
	var r: PKeyResult = made[1]
	t.check("browse: ok with a handle", r.ok and r.detail is PKeyMdns.Handle)
	var s := w.last()
	var q := PKeyMdnsPacket.parse(s.multicast[0])
	t.check("browse: it asks for the service at once, as a query", s.multicast.size() == 1 and q["ok"] and not q["response"] and q["questions"] == [{"name": SERVICE, "type": &"PTR"}])
	t.check("browse: the socket joined the usable interface", w.calls == [[5353, ["en0"]]])
	w.t += 1.0
	m.poll()
	t.check("browse: and once more a second later", s.multicast.size() == 2)
	w.t += 29.0
	m.poll()
	t.check("browse: then every thirty seconds", s.multicast.size() == 3)
	# A complete advert from a neighbour: up, once.
	s.push(_advert_packet(INST_A, "192.168.1.20"), "192.168.1.20")
	m.poll()
	t.check("browse: a complete advert reports the peer up", f.up.size() == 1 and f.up[0]["instance"] == INST_A and f.up[0]["host"] == "192.168.1.20" and
		f.up[0]["hosts"] == ["192.168.1.20"] and f.up[0]["port"] == PORT_A and f.up[0]["txt"] == ["v=1", "m=a"], str(f.up))
	t.check("browse: the roster filter was asked, with the instance", f.allowed.has(INST_A))
	s.push(_advert_packet(INST_A, "192.168.1.20"), "192.168.1.20")
	m.poll()
	t.check("browse: the same advert again is not a change", f.up.size() == 1)
	s.push(PKeyMdnsPacket.build_response([_a(INST_A, "192.168.1.21")]), "192.168.1.21")
	m.poll()
	t.check("browse: a second address is a change, first seen first", f.up.size() == 2 and f.up[1]["hosts"] == ["192.168.1.20", "192.168.1.21"] and f.up[1]["host"] == "192.168.1.20")
	s.push(PKeyMdnsPacket.build_response([_txt(INST_A, ["v=1", "m=a", "k=1"])]), "192.168.1.20")
	m.poll()
	t.check("browse: a new TXT is a change", f.up.size() == 3 and f.up[2]["txt"] == ["v=1", "m=a", "k=1"])
	s.push(PKeyMdnsPacket.build_response([_srv(INST_A, 40002)]), "192.168.1.20")
	m.poll()
	t.check("browse: a new port is a change", f.up.size() == 4 and f.up[3]["port"] == 40002)
	# An address withdrawn one by one: the peer goes down when the last goes.
	s.push(PKeyMdnsPacket.build_response([_a(INST_A, "192.168.1.21", 0)]), "192.168.1.21")
	m.poll()
	t.check("browse: a withdrawn address is a change, not a loss", f.up.size() == 5 and f.up[4]["hosts"] == ["192.168.1.20"] and f.down.is_empty())
	s.push(PKeyMdnsPacket.build_response([_a(INST_A, "192.168.1.20", 0)]), "192.168.1.20")
	m.poll()
	t.check("browse: with the last address gone the peer is down", f.down == [INST_A])
	s.push(PKeyMdnsPacket.build_response([_a(INST_A, "192.168.1.22")]), "192.168.1.22")
	m.poll()
	t.check("browse: and up again when one is learned", f.up.size() == 6 and f.up[5]["hosts"] == ["192.168.1.22"])
	# While a peer is incomplete, the next question asks for its pieces.
	s.push(PKeyMdnsPacket.build_response([_ptr(INST_B)]), "192.168.1.40")
	m.poll()
	w.t += 30.0
	m.poll()
	var last: Dictionary = PKeyMdnsPacket.parse(s.multicast[s.multicast.size() - 1])
	var asked: Array = (last["questions"] as Array).map(func(x: Dictionary) -> String: return "%s %s" % [x["type"], x["name"]])
	t.check("browse: an incomplete peer is asked for its SRV, TXT and A", asked == ["PTR " + SERVICE, "SRV %s.%s" % [INST_B, SERVICE], "TXT %s.%s" % [INST_B, SERVICE],
		"A %s.local" % INST_B], str(asked))
	# Goodbye.
	s.push(PKeyMdnsPacket.build_response([_ptr(INST_A, 0)]), "192.168.1.22")
	m.poll()
	t.check("browse: a PTR goodbye reports the peer down", f.down == [INST_A, INST_A])
	(r.detail as PKeyMdns.Handle).stop()
	t.check("browse: stop closes the socket", s.closed and not m.is_open())
	w.t += 100.0
	m.poll()
	t.check("browse: and nothing runs after it", s.multicast.size() == 4)


func _browse_rules(t: PKeyTestContext) -> void:
	var w := World.new()
	var f := Found.new()
	var made := _browser(w, f)
	var m: PKeyMdns = made[0]
	var s := w.last()
	# The A record must equal the packet's source.
	s.push(_advert_packet(INST_A, "192.168.1.99"), "192.168.1.20")
	m.poll()
	t.check("rules: an A record that is not the packet's source teaches nothing", f.up.is_empty())
	# A source outside the private block of the device is ignored whole.
	s.push(_advert_packet(INST_B, "10.7.7.7"), "10.7.7.7")
	s.push(_advert_packet(INST_B, "8.8.8.8"), "8.8.8.8")
	s.push(_advert_packet(INST_B, "169.254.1.1"), "169.254.1.1")
	m.poll()
	t.check("rules: a response from outside the device's private block is ignored", f.up.is_empty() and not f.allowed.has(INST_B))
	# The filter.
	f.allow = false
	s.push(_advert_packet(INST_B, "192.168.1.30"), "192.168.1.30")
	m.poll()
	t.check("rules: a name the roster filter refuses never enters", f.up.is_empty() and f.allowed.has(INST_B) and made[1].detail.tracked() == 1)
	f.allow = true
	# SRV port.
	s.push(PKeyMdnsPacket.build_response([_ptr(INST_B), _srv(INST_B, 80), _txt(INST_B), _a(INST_B, "192.168.1.30")]), "192.168.1.30")
	m.poll()
	t.check("rules: an SRV port below 1024 is ignored", f.up.is_empty())
	s.push(PKeyMdnsPacket.build_response([_srv(INST_B, 1024)]), "192.168.1.30")
	m.poll()
	t.check("rules: 1024 is allowed", f.up.size() == 1 and f.up[0]["port"] == 1024)
	# Target.
	s.push(PKeyMdnsPacket.build_response([_ptr("p1-cccccccccccccccc"), _srv("p1-cccccccccccccccc", 4000, "laptop.local"), _txt("p1-cccccccccccccccc"), _a("p1-cccccccccccccccc",
		"192.168.1.31"), _a("laptop.local", "192.168.1.31")]), "192.168.1.31")
	m.poll()
	t.check("rules: an SRV target that is not the instance's own host name makes no peer", f.up.size() == 1)
	# A name that is not ours, a PTR for another service, a bad SRV port.
	s.push(PKeyMdnsPacket.build_response([{"name": "_other._tcp.local", "type": &"PTR", "ttl": 120, "data": "p1-dddddddddddddddd._other._tcp.local"}, {"name": "x.local", "type": &"A",
		"ttl": 120, "data": "192.168.1.32"}]), "192.168.1.32")
	m.poll()
	t.check("rules: other services and hosts are not tracked", made[1].detail.tracked() == 3)
	# A query packet is not a response.
	s.push(PKeyMdnsPacket.build_query([{"name": SERVICE, "type": &"PTR"}]), "192.168.1.33")
	m.poll()
	t.check("rules: a query from a neighbour is not learned from", made[1].detail.tracked() == 3)
	# Loopback sources are ignored unless allowed.
	s.push(_advert_packet("p1-eeeeeeeeeeeeeeee", "127.0.0.1"), "127.0.0.1")
	m.poll()
	t.check("rules: a loopback source is off the link", not f.allowed.has("p1-eeeeeeeeeeeeeeee"))
	var w2 := World.new()
	w2.interfaces = [{"name": "lo0", "addresses": ["127.0.0.1"]}]
	var f2 := Found.new()
	var made2 := _browser(w2, f2, {"allow_loopback": true})
	w2.last().push(_advert_packet(INST_A, "127.0.0.1"), "127.0.0.1")
	(made2[0] as PKeyMdns).poll()
	t.check("rules: with loopback allowed, a loopback peer is found", f2.up.size() == 1 and f2.up[0]["host"] == "127.0.0.1")
	# Several blocks: a device on 10/8 and 192.168/16 reads both.
	var w3 := World.new()
	w3.interfaces = [{"name": "en0", "addresses": ["192.168.1.10"]}, {"name": "en1", "addresses": ["10.4.4.4"]}]
	var f3 := Found.new()
	var made3 := _browser(w3, f3)
	w3.last().push(_advert_packet(INST_A, "10.4.4.9"), "10.4.4.9")
	w3.last().push(_advert_packet(INST_B, "172.20.0.9"), "172.20.0.9")
	(made3[0] as PKeyMdns).poll()
	t.check("rules: each block the device is in counts, others do not", f3.up.size() == 1 and f3.up[0]["instance"] == INST_A and w3.calls[0][1] == ["en0", "en1"])
	# The per-source allowance of new names.
	var w4 := World.new()
	var f4 := Found.new()
	var made4 := _browser(w4, f4)
	for i in 20:
		w4.last().push(PKeyMdnsPacket.build_response([_ptr(_inst(i))]), "192.168.1.50")
	(made4[0] as PKeyMdns).poll()
	t.check("rules: one source adds at most 16 new names a minute", made4[1].detail.tracked() == 16)
	for i in 20:
		w4.last().push(PKeyMdnsPacket.build_response([_ptr(_inst(i + 100))]), "192.168.1.51")
	w4.t += 1.0
	(made4[0] as PKeyMdns).poll()
	t.check("rules: another source has its own", made4[1].detail.tracked() == 32)
	# A bad packet ends only itself.
	var w5 := World.new()
	var f5 := Found.new()
	var made5 := _browser(w5, f5)
	var loop := PackedByteArray([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 12])
	w5.last().push(loop, "192.168.1.20")
	w5.last().push(PackedByteArray(), "192.168.1.20")
	w5.last().push(PackedByteArray([0, 0, 0x84, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]), "192.168.1.20")
	var huge := PackedByteArray()
	huge.resize(9001)
	w5.last().push(huge, "192.168.1.20")
	w5.last().push(_advert_packet(INST_A, "192.168.1.20"), "192.168.1.20")
	(made5[0] as PKeyMdns).poll()
	t.check("rules: malformed packets are dropped and the next one is read", f5.up.size() == 1)


func _tables(t: PKeyTestContext) -> void:
	var w := World.new()
	var f := Found.new()
	var made := _browser(w, f)
	var m: PKeyMdns = made[0]
	var s := w.last()
	# Complete peers from many sources: 300 names, each its own source (the source must equal the A).
	for i in 300:
		var inst := _inst(i)
		var ip := "192.168.%d.%d" % [2 + i / 200, 1 + i % 200]
		s.push(_advert_packet(inst, ip), ip)
	var polls := 0
	while not s.inbox.is_empty() and polls < 20:
		m.poll()
		polls += 1
	t.check("tables: 300 names with 300 sources hold at most 256 instances", made[1].detail.tracked() == PKeyMdns.MAX_INSTANCES, str(made[1].detail.tracked()))
	t.check("tables: the oldest were reported down when they were pushed out", f.down.size() == 300 - 256 and f.down[0] == _inst(0), str(f.down.size()))
	t.check("tables: a flood did not stop discovery: the newest is up", f.up.size() == 300 and f.up[299]["instance"] == _inst(299))
	t.check("tables: and the book holds at most 256 names", (made[1].detail._what as PKeyMdns.Browser).book.size() <= PKeyMdns.MAX_INSTANCES)


func _expiry(t: PKeyTestContext) -> void:
	var w := World.new()
	var f := Found.new()
	var made := _browser(w, f)
	var m: PKeyMdns = made[0]
	var s := w.last()
	s.push(_advert_packet(INST_A, "192.168.1.20"), "192.168.1.20")
	m.poll()
	t.check("expiry: up", f.up.size() == 1)
	# TTL 120: refreshed by a PTR at 100 s, so still up at 200 s.
	w.t += 100.0
	s.push(PKeyMdnsPacket.build_response([_ptr(INST_A)]), "192.168.1.20")
	m.poll()
	w.t += 100.0
	m.poll()
	t.check("expiry: a PTR refresh keeps the peer up past the first TTL", f.down.is_empty() and made[1].detail.tracked() == 1)
	w.t += 30.0
	m.poll()
	t.check("expiry: a PTR whose TTL lapses without a refresh reports the peer down", f.down == [INST_A] and made[1].detail.tracked() == 0, str(f.down))
	# A long PTR TTL is capped at five minutes.
	s.push(PKeyMdnsPacket.build_response([_ptr(INST_B, 99999), _srv(INST_B), _txt(INST_B), _a(INST_B, "192.168.1.21")]), "192.168.1.21")
	m.poll()
	w.t += 301.0
	m.poll()
	t.check("expiry: a long PTR TTL is capped at five minutes", f.down == [INST_A, INST_B])
	# An entry unrefreshed by anything lives five minutes at most, even with TTL that says longer.
	var w2 := World.new()
	var f2 := Found.new()
	var made2 := _browser(w2, f2)
	w2.last().push(PKeyMdnsPacket.build_response([_srv(INST_A), _txt(INST_A), _a(INST_A, "192.168.1.20")]), "192.168.1.20")
	(made2[0] as PKeyMdns).poll()
	t.check("expiry: a peer with no PTR yet is tracked", made2[1].detail.tracked() == 1)
	w2.t += 125.0
	(made2[0] as PKeyMdns).poll()
	t.check("expiry: and lapses on the default TTL", made2[1].detail.tracked() == 0)


# ── lanes ────────────────────────────────────────────────────────────────────────────────────


func _lanes(t: PKeyTestContext) -> void:
	# Querier-only: 5353 is refused, an ephemeral socket is used; it asks, and says nothing.
	var w := World.new()
	w.refuse_5353 = true
	var m := w.adapter()
	var f := Found.new()
	var adv := m.advertise({"instance": INST_A, "port": PORT_A, "txt": ["v=1", "m=a"]})
	var brw := m.browse(Callable(f, "on_up"), Callable(f, "on_down"))
	t.check("querier-only: both calls work on an ephemeral socket", adv.ok and brw.ok and w.calls.size() == 2 and w.calls[0][0] == 5353 and w.calls[1][0] == 0)
	t.check("querier-only: status says so", m.status() == {"active": true, "responder": false, "querier": true, "reason": "querier_only"})
	var s := w.last()
	t.check("querier-only: the advert says nothing, the browse asks", s.multicast.size() == 1 and not (PKeyMdnsPacket.parse(s.multicast[0])["response"] as bool))
	w.t += 5.0
	m.poll()
	s.push(PKeyMdnsPacket.build_query([{"name": SERVICE, "type": &"PTR"}]), "192.168.1.20", 5353)
	m.poll()
	t.check("querier-only: nothing answers a query, and no announce follows", s.multicast.size() == 2 and s.unicast.is_empty())
	# It still hears the unicast answers.
	s.push(_advert_packet(INST_B, "192.168.1.40"), "192.168.1.40", 5353)
	m.poll()
	t.check("querier-only: it still hears a unicast answer", f.up.size() == 1 and f.up[0]["instance"] == INST_B)
	(adv.detail as PKeyMdns.Handle).stop()
	t.check("querier-only: stopping the advert sends no goodbye and keeps the socket", s.multicast.size() == 2 and not s.closed)
	(brw.detail as PKeyMdns.Handle).stop()
	t.check("querier-only: the last stop closes it", s.closed)

	# Unavailable: no socket at all, then no interface.
	var w2 := World.new()
	w2.refuse_all = true
	var m2 := w2.adapter()
	var a2 := m2.advertise({"instance": INST_A, "port": PORT_A, "txt": []})
	var b2 := m2.browse(Callable(f, "on_up"))
	t.check("unavailable: no socket fails both calls with connect-unavailable and a reason", not a2.ok and not b2.ok and a2.code == &"connect-unavailable" and
		PKeyConnectErrors.reason_of(a2) == "mdns_unavailable")
	t.check("unavailable: the probe tried 5353 then an ephemeral port, per call", w2.calls.size() == 4 and not m2.is_open() and m2.status()["active"] == false)
	var w3 := World.new()
	w3.interfaces = [{"name": "lo0", "addresses": ["127.0.0.1"]}, {"name": "utun2", "addresses": ["10.2.2.2"]}]
	var a3 := w3.adapter().browse(Callable(f, "on_up"))
	t.check("unavailable: no usable interface fails without opening a socket", not a3.ok and w3.calls.is_empty() and a3.code == &"connect-unavailable")
	var w3b := World.new()
	w3b.interfaces = []
	t.check("unavailable: an unreadable interface list is the same", not w3b.adapter().advertise({"instance": INST_A, "port": PORT_A, "txt": []}).ok)

	# Sharing: one socket for an advert and a browse; a rotation keeps it alive.
	var w4 := World.new()
	var m4 := w4.adapter()
	var one := m4.advertise({"instance": INST_A, "port": PORT_A, "txt": []})
	var two := m4.advertise({"instance": INST_B, "port": PORT_A, "txt": []})
	var br := m4.browse(Callable(f, "on_up"))
	t.check("sharing: advertise, advertise and browse use one socket", w4.calls.size() == 1 and w4.sockets.size() == 1)
	(one.detail as PKeyMdns.Handle).stop()
	t.check("sharing: stopping the first (a rotation) keeps the socket open", not w4.last().closed and m4.is_open())
	(two.detail as PKeyMdns.Handle).stop()
	t.check("sharing: and so does the second", not w4.last().closed)
	(br.detail as PKeyMdns.Handle).stop()
	t.check("sharing: the last one out closes it", w4.last().closed and not m4.is_open())
	var again := m4.browse(Callable(f, "on_up"))
	t.check("sharing: and a later call opens a new one", again.ok and w4.sockets.size() == 2 and not w4.last().closed)
	(again.detail as PKeyMdns.Handle).stop()
	t.check("nothing is bound before a call", w4.adapter().is_open() == false)


func _budget(t: PKeyTestContext) -> void:
	var w := World.new()
	var f := Found.new()
	var made := _browser(w, f)
	var m: PKeyMdns = made[0]
	var s := w.last()
	for i in 200:
		s.push(PackedByteArray([1, 2, 3]), "192.168.1.20")
	m.poll()
	t.check("budget: one poll reads at most 64 datagrams", s.inbox.size() == 200 - PKeyMdns.MAX_PACKETS_PER_POLL)
	m.poll()
	m.poll()
	m.poll()
	t.check("budget: and the rest follow, a poll at a time", s.inbox.is_empty())
	(made[1].detail as PKeyMdns.Handle).stop()
	m.poll()
	t.check("budget: poll on a closed adapter is nothing", not m.is_open() and s.multicast.size() == 1)


# ── the real socket class ────────────────────────────────────────────────────────────────────


func _real_socket(t: PKeyTestContext) -> void:
	# Nothing to join: no socket is left bound.
	t.check("real: no interface names, no socket", PKeyMdns.open_udp(0, []) == null)
	t.check("real: an interface that does not exist, no socket", PKeyMdns.open_udp(0, ["no-such-interface-0"]) == null)
	t.check("real: the engine's class names", str(PKeyMdns.new()) == "PKeyMdns()")
	# Two plain loopback sockets wrapped in the adapter's class: a unicast datagram, both ways.
	var ua := PacketPeerUDP.new()
	var ub := PacketPeerUDP.new()
	if not t.check("real: two loopback sockets bind", ua.bind(0, "127.0.0.1") == OK and ub.bind(0, "127.0.0.1") == OK):
		ua.close()
		ub.close()
		return
	var a := PKeyMdns.UdpSocket.new(ua)
	var b := PKeyMdns.UdpSocket.new(ub)
	var pa := ua.get_local_port()
	var pb := ub.get_local_port()
	t.check("real: nothing waiting is an empty answer", a.receive().is_empty())
	a.send_to("hello".to_utf8_buffer(), "127.0.0.1", pb)
	var got := {}
	var tree := Engine.get_main_loop() as SceneTree
	var tries := 0
	while got.is_empty() and tries < 100:
		await tree.process_frame
		got = b.receive()
		tries += 1
	t.check("real: send_to arrives with its source and port", not got.is_empty() and (got["data"] as PackedByteArray).get_string_from_utf8() == "hello" and got["source"] == "127.0.0.1" and
		got["port"] == pa, str(got))
	b.send_to(PackedByteArray([1, 2, 3]), "127.0.0.1", pa)
	got = {}
	tries = 0
	while got.is_empty() and tries < 100:
		await tree.process_frame
		got = a.receive()
		tries += 1
	t.check("real: and the other way", not got.is_empty() and got["data"] == PackedByteArray([1, 2, 3]) and got["port"] == pb)
	a.close()
	b.close()
	t.check("real: a closed socket receives and sends nothing", a.receive().is_empty() and b.receive().is_empty())
	a.send_to(PackedByteArray([1]), "127.0.0.1", pb)
	t.check("real: and the port is free again", _port_free(pa) and _port_free(pb))


static func _port_free(port: int) -> bool:
	var u := PacketPeerUDP.new()
	var ok := u.bind(port, "127.0.0.1") == OK
	u.close()
	return ok


## Opt-in (PKEY_LIVE_MDNS=1): the real adapter on the real network for a few seconds. It asks for the
## service, reports what answered, and closes every socket on every path.
func _live(t: PKeyTestContext) -> void:
	if OS.get_environment("PKEY_LIVE_MDNS") != "1":
		t.info("live mDNS: skipped (set PKEY_LIVE_MDNS=1)")
		return
	var tree := Engine.get_main_loop() as SceneTree
	var m := PKeyMdns.new({"tree": tree})
	var heard: Array = []
	var r := m.browse(func(f: Dictionary) -> void: heard.append(f))
	if not t.check("live: the adapter opens on this network", r.ok, str(r)):
		return
	var st := m.status()
	t.info("live mDNS: responder=%s reason=%s" % [st["responder"], st["reason"]])
	var started := Time.get_ticks_msec()
	while Time.get_ticks_msec() - started < 4000:
		await tree.process_frame
	(r.detail as PKeyMdns.Handle).stop()
	t.check("live: the socket is closed again", not m.is_open())
	t.info("live mDNS: %d _pkeypeer peers heard in 4 s" % heard.size())
