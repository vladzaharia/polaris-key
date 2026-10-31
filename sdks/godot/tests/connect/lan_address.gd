extends RefCounted
# @pkey-feature connect.lan
# The LAN address rule (PKeyLanAddress; WIRE-CONTRACT-V5 section 15.4.1) and mDNS address learning
# (PKeyMdnsPacket.learn; section 15.4 "Addresses"), row for row against the mirrored peer-matrix.json
# (generator-owned; never edit it): every `lanAddresses` row for `dial`, `key` and `group` (133
# rows), and every `mdnsAnswers` row (37). Godot does not read CANDIDATES entries (no
# `candidate_target` on this lane), so the `candidates` rows are counted only.

const MATRIX := "res://tests/corpus/v2/peer-matrix.json"
const LAN_ROWS := 133
const LAN_DIAL := 42
const LAN_REFUSED := 91
const CANDIDATE_ROWS := 73
const MDNS_ROWS := 37


func run(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("peer-matrix.json parses", j.parse(FileAccess.get_file_as_string(MATRIX)) == OK and j.data is Dictionary):
		return
	var m: Dictionary = j.data
	_lan_rows(t, m.get("lanAddresses"))
	_extra(t)
	_mdns_rows(t, m.get("mdnsAnswers"))


func _lan_rows(t: PKeyTestContext, section: Variant) -> void:
	if not t.check("lanAddresses is in the mirror", section is Dictionary):
		return
	var rows: Array = section["rows"]
	var dialled := 0
	var refused := 0
	var good := 0
	for row in rows:
		var local: Variant = row.get("local")
		var v := PKeyLanAddress.verdict(row["remote"], local, row["allowLoopback"])
		var group: Variant = PKeyLanAddress.group_key(v["key"])
		var ok: bool = v["dial"] == row["dial"] and v["key"] == row["key"] and group == row.get("group")
		if row["dial"]:
			dialled += 1
		else:
			refused += 1
		if t.check("lanAddresses %s" % row["id"], ok, "%s key=%s group=%s" % [v["dial"], v["key"], group]):
			good += 1
	t.check("lanAddresses: %d rows, all pass" % LAN_ROWS, rows.size() == LAN_ROWS and good == LAN_ROWS, "%d/%d" % [good, rows.size()])
	t.check("lanAddresses: %d dialled, %d refused" % [LAN_DIAL, LAN_REFUSED], dialled == LAN_DIAL and refused == LAN_REFUSED, "%d/%d" % [dialled, refused])
	var candidates: Array = section["candidates"]["rows"]
	t.check("lanAddresses: %d candidates rows (not read on this lane)" % CANDIDATE_ROWS, candidates.size() == CANDIDATE_ROWS, str(candidates.size()))


## What the corpus does not say: a refusal carries no key, a key that is not text has no group, and
## the verdict does not depend on a stray local address of another type.
func _extra(t: PKeyTestContext) -> void:
	var refused := PKeyLanAddress.verdict("8.8.8.8", null, false)
	t.check("a refusal has no key", refused["dial"] == false and refused["key"] == null)
	t.check("no key has no group", PKeyLanAddress.group_key(null) == null)
	t.check("a key that is not an address has no group", PKeyLanAddress.group_key("not an address") == null and PKeyLanAddress.group_key("") == null)
	t.check("a key that is not text has no group", PKeyLanAddress.group_key(5) == null)
	t.check("a link-local key's group keeps the zone", PKeyLanAddress.group_key("fe80::1%en0") == "fe80::/10%en0" and PKeyLanAddress.group_key("fe80::1") == "fe80::/10")
	t.check("an IPv6 key's group is its /64", PKeyLanAddress.group_key("fd12:3:4:5:6:7:8:9") == "fd12:3:4:5::/64")
	t.check("a ULA with a local that is not text is judged against nothing", not PKeyLanAddress.verdict("fd12::5", 7, false)["dial"])
	t.check("a very long text is refused", not PKeyLanAddress.verdict("1".repeat(4000), null, false)["dial"] and not PKeyLanAddress.verdict("a:".repeat(2000), null, false)["dial"])
	# The Godot lane's own case: a socket with no known local address (D-6).
	t.check("no local: a ULA is judged on its own", PKeyLanAddress.verdict("fd12::5", null, false)["dial"])
	t.check("no local: a global IPv6 address is refused", not PKeyLanAddress.verdict("2001:db8::5", null, false)["dial"])
	t.check("no local: link-local is accepted and keeps its zone", PKeyLanAddress.verdict("fe80::5%en0", null, false)["key"] == "fe80::5%en0")


## Every `mdnsAnswers` row through PKeyMdnsPacket.learn (a link-local source with no arrival zone
## learns nothing).
func _mdns_rows(t: PKeyTestContext, section: Variant) -> void:
	if not t.check("mdnsAnswers is in the mirror", section is Dictionary):
		return
	var rows: Array = section["rows"]
	var good := 0
	for row in rows:
		var packet := (row["packet"] as String).hex_decode()
		var prior: Array = row.get("prior", [])
		var r := PKeyMdnsPacket.learn(packet, row["source"], row["zone"], prior)
		if t.check("mdnsAnswers %s" % row["id"], r["ok"] and r["learned"] == row["learned"], str(r.get("learned"))):
			good += 1
	t.check("mdnsAnswers: %d rows, all pass" % MDNS_ROWS, rows.size() == MDNS_ROWS and good == MDNS_ROWS, "%d/%d" % [good, rows.size()])
