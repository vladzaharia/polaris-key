extends RefCounted
# @pkey-feature connect.lan
# The discovery port of the GDScript mDNS lane (CC-15b): `advertise` slots, `capabilities()`, `set_tags`,
# `browse` tags (accepted, ignored) and a handle's `update`, over the fake socket of mdns.gd.

const MDNS_TEST := preload("res://tests/connect/mdns.gd")
const INST_A := MDNS_TEST.INST_A
const INST_B := MDNS_TEST.INST_B
const SERVICE := MDNS_TEST.SERVICE
const PORT_A := MDNS_TEST.PORT_A
const TAG := "0123456789abcdef"


func run(t: PKeyTestContext) -> void:
	_slots(t)
	_update(t)


func _slots(t: PKeyTestContext) -> void:
	var w := MDNS_TEST.World.new()
	var m := w.adapter()
	t.check("capabilities: slots and tags", m.capabilities() == {"slots": true, "tags": true})
	t.check("set_tags: accepted, changes nothing, opens nothing", m.set_tags({"v": [TAG]}) and not m.is_open())
	for slot in ["a", "v", "p", "c"]:
		var r := m.advertise({"instance": INST_A, "port": PORT_A, "txt": [], "slot": slot})
		t.check("advertise: slot %s is advertised" % slot, r.ok)
	var calls := w.calls.size()
	var bad := m.advertise({"instance": INST_A, "port": PORT_A, "txt": [], "slot": "x"})
	t.check("advertise: an unknown slot is refused", not bad.ok and bad.code == &"invalid-argument")
	var fresh := MDNS_TEST.World.new().adapter().advertise({"instance": INST_A, "port": PORT_A, "txt": [], "slot": "c0"})
	t.check("advertise: a native slot name is not a lane slot", not fresh.ok and calls == w.calls.size())


func _update(t: PKeyTestContext) -> void:
	var w := MDNS_TEST.World.new()
	var m := w.adapter()
	var advert := m.advertise({"instance": INST_A, "port": PORT_A, "txt": ["v=1", "m=a"], "slot": "v"})
	var handle: PKeyMdns.Handle = advert.detail
	t.check("update: moves the advert", handle.update(INST_B, ["v=1", "m=v"]))
	var sent: Array = w.last().multicast.map(MDNS_TEST._ttls)
	t.check("update: the old name says goodbye, the new one is announced", sent.size() == 3 and sent[1] == [0, 0, 0, 0] and sent[2] == [120, 120, 4500, 120], str(sent))
	var ptr: Dictionary = (PKeyMdnsPacket.parse(w.last().multicast[2])["answers"] as Array)[0]
	t.check("update: the new name is the PTR target, on the same port", ptr["data"] == INST_B + "." + SERVICE)
	t.check("update: a bad name does not move it", not handle.update("laptop", []))
	var browse := m.browse(MDNS_TEST.Found.new().on_up, Callable(), Callable(), {"v": [TAG]})
	t.check("browse: takes tags, which it ignores", browse.ok)
	t.check("update: a browse handle has nothing to move", not browse.detail.update(INST_A, []))
	handle.stop()
	t.check("update: a stopped advert is not moved", not handle.update(INST_A, []))
	browse.detail.stop()
