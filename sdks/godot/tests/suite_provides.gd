extends RefCounted
# @pkey-feature packs.provides
# Save compatibility on the device (P4-20, CONTENT §6.7 item 8): PKeyPackProvides.provides_of,
# the reader of a pack record's reserved record-level `provides`, and is_available (the running
# set) and pack_for (the target set) over PKeyPackEngine and the fake transport. The same cases as
# client-core packsProvides.test.ts; Python and Swift pin them too.

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")
const P := preload("res://addons/polaris_key/packs/provides.gd")

## A marker for "no `provides` member at all".
const ABSENT := "<absent>"


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	PKeyPackClaims.warm()
	PKeyPck.warm()
	_reader(t)
	await _installed(t)
	await _target_only(t)
	await _explicit_targets(t)
	await _embedded(t)
	await _nothing(t)
	await _unfetchable(t)
	await _unentitled(t)
	await _facade(t)
	return true


## A one-file `files.tree` pack whose record carries `provides` (re-signed with the test key).
func _pack(pack_id: String, provides: Variant, opts: Dictionary = {}, version := "1.0.0", seq := 1, files: Dictionary = {}) -> Dictionary:
	var f := files if not files.is_empty() else {"%s.txt" % pack_id: pack_id}
	var p := F.tree_pack(pack_id, version, seq, f, null, opts)
	if not (provides is String and provides == ABSENT):
		p["record"]["provides"] = provides
		var s := F.sign_record(p["record"])
		p["jws"] = s["jws"]
		p["recordSha256"] = s["sha256"]
	return p


static func _target(p: Dictionary) -> Dictionary:
	return {"pack": p["packId"], "release": {"sha256": p["recordSha256"], "seq": p["seq"], "version": p["version"]}}


static func _provider(p: Dictionary) -> Dictionary:
	return {"packId": p["packId"], "release": _target(p)["release"]}


static func _ids(n: int) -> Array:
	var out: Array = []
	for i in n:
		out.append("id.%d" % i)
	return out


func _reader(t: PKeyTestContext) -> void:
	t.check("provides_of: a well-formed list", P.provides_of({"provides": ["foe.goblin", "item.sword"]}).keys() == ["foe.goblin", "item.sword"])
	t.check("provides_of: an empty list provides nothing", P.provides_of({"provides": []}).is_empty())
	t.check("provides_of: absent provides nothing", P.provides_of({}).is_empty())
	t.check("provides_of: a null record provides nothing", P.provides_of(null).is_empty())
	t.check("provides_of: an array record provides nothing", P.provides_of([]).is_empty())
	var unusable := [
		["a string", "foe.goblin"],
		["a dictionary", {"foe.goblin": true}],
		["a duplicate", ["foe.goblin", "foe.goblin"]],
		["an id with a space", ["foe goblin"]],
		["an empty id", [""]],
		["a 129-character id", ["x".repeat(129)]],
		["a non-ASCII id", ["é"]],
		["a number", [7]],
		["MAX_PROVIDES + 1 entries", _ids(P.MAX_PROVIDES + 1)],
	]
	for u in unusable:
		t.check("provides_of: %s is unusable (provides nothing)" % u[0], P.provides_of({"provides": u[1]}).is_empty())
	t.check("provides_of: exactly MAX_PROVIDES entries are read", P.provides_of({"provides": _ids(P.MAX_PROVIDES)}).size() == P.MAX_PROVIDES and P.MAX_PROVIDES == 4096)
	t.check("is_content_id: 128 characters", P.is_content_id("x".repeat(128)))
	t.check("is_content_id: punctuation is printable ASCII", P.is_content_id("~!res://a/b#c"))
	t.check("is_content_id: a tab is not", not P.is_content_id("a\tb"))
	t.check("facts: the entitlement, or null", P.facts({"entitlement": "hd"})["entitlement"] == "hd" and P.facts({})["entitlement"] == null and P.facts({"entitlement": 1})["entitlement"] == null)


func _installed(t: PKeyTestContext) -> void:
	var foes := _pack("djdl.foes", ["foe.goblin", "foe.orc"])
	var root := S.scratch("provides-installed")
	var e := F.engine(root, F.FakeTransport.new().add(foes), F.stamp_for([foes]))
	var pr := P.new(e)
	t.check("installed: before load nothing is available", not pr.is_available("foe.goblin"))
	await e.load_state([])
	t.check("installed: before ensure the id is not available", not pr.is_available("foe.goblin"))
	var r := await e.ensure(["djdl.foes"])
	t.check("installed: the pack installs", r.ok, str(r))
	t.check("installed: an id the active pack provides is available", pr.is_available("foe.goblin"))
	t.check("installed: an id it does not provide is not", not pr.is_available("foe.dragon"))
	S.check_same(t, "installed: pack_for names the pack", await pr.pack_for("foe.orc"), _provider(foes))
	# A new process re-verifies the stored install and answers from it.
	var e2 := F.engine(root, F.FakeTransport.new(), F.stamp_for([foes]))
	await e2.load_state([])
	var pr2 := P.new(e2)
	t.check("installed: the next process answers from the stored install", pr2.is_available("foe.orc"))
	S.check_same(t, "installed: and pack_for without fetching", await pr2.pack_for("foe.goblin"), _provider(foes))
	S.remove_tree(root)


func _target_only(t: PKeyTestContext) -> void:
	var l10n := _pack("djdl.l10n", ["l10n.en"])
	var foes := _pack("djdl.foes", ["foe.goblin"])
	var root := S.scratch("provides-target")
	var tr := F.FakeTransport.new().add(l10n).add(foes)
	var e := F.engine(root, tr, F.stamp_for([l10n, foes]))
	var pr := P.new(e)
	await e.load_state([])
	await e.ensure(["djdl.l10n"])
	var before := tr.calls.size()
	t.check("target: an id only the target set provides is not available", not pr.is_available("foe.goblin"))
	S.check_same(t, "target: pack_for names the target pack", await pr.pack_for("foe.goblin"), _provider(foes))
	t.check("target: only the record was read (no object fetched)", tr.calls.size() == before and tr.record_calls.has(foes["recordSha256"]), S.canon(tr.calls))
	t.check("target: nothing was installed", not e.doc["active"].has("djdl.foes") and not pr.is_available("foe.goblin"))
	var n := tr.record_calls.size()
	await pr.pack_for("foe.goblin")
	t.check("target: a second ask answers from the memo", tr.record_calls.size() == n)
	S.remove_tree(root)


func _explicit_targets(t: PKeyTestContext) -> void:
	var v1 := _pack("djdl.events", ["event.halloween"])
	var v2 := _pack("djdl.events", ["event.halloween", "event.winter"], {}, "1.1.0", 2, {"e.txt": "e2"})
	var root := S.scratch("provides-targets")
	var e := F.engine(root, F.FakeTransport.new().add(v1).add(v2), F.stamp_for([v1]))
	var pr := P.new(e)
	await e.load_state([])
	t.check("targets: the stamp's pins do not provide the id", await pr.pack_for("event.winter") == null)
	S.check_same(t, "targets: a decision's targets replace the stamp's pins", await pr.pack_for("event.winter", [_target(v2)]), _provider(v2))
	t.check("targets: an empty target list answers null", await pr.pack_for("event.winter", []) == null)
	S.remove_tree(root)


func _embedded(t: PKeyTestContext) -> void:
	var core := _pack("djdl.core", ["dice.d6"])
	var root := S.scratch("provides-embedded")
	var emb := root.path_join("res-pkey_packs")
	for path in core["files"]:
		S.write_file(emb.path_join("core").path_join(path), core["files"][path])
	S.write_file(emb.path_join("core/.pkey/pack.json"), F.marker_for(core).to_utf8_buffer())
	# The transport holds nothing: the embedded marker's record answers both questions.
	var tr := F.FakeTransport.new()
	var e := F.engine(root.path_join("store-root"), tr, F.stamp_for([core]))
	var pr := P.new(e)
	var loaded := await e.load_state(PKeyPackEmbeddedTransport.new(emb).embedded())
	t.check("embedded: the baseline is accepted", loaded["refused"].is_empty() and e.running.has("djdl.core"), S.canon(loaded))
	t.check("embedded: the baseline's record makes the id available", pr.is_available("dice.d6"))
	S.check_same(t, "embedded: pack_for names the baseline's pack", await pr.pack_for("dice.d6"), _provider(core))
	t.check("embedded: nothing was fetched", tr.record_calls.is_empty() and tr.calls.is_empty())
	S.remove_tree(root)


func _nothing(t: PKeyTestContext) -> void:
	var plain := _pack("djdl.plain", ABSENT)
	var broken := _pack("djdl.broken", ["ok.id", "ok.id"])
	var root := S.scratch("provides-nothing")
	var e := F.engine(root, F.FakeTransport.new().add(plain).add(broken), F.stamp_for([plain, broken]))
	var pr := P.new(e)
	await e.load_state([])
	var r := await e.ensure(["djdl.plain", "djdl.broken"])
	t.check("nothing: both packs install (provides is never a claim)", r.ok, str(r))
	t.check("nothing: a duplicated id is not available", not pr.is_available("ok.id"))
	t.check("nothing: pack_for answers null for it", await pr.pack_for("ok.id") == null)
	t.check("nothing: pack_for answers null for an id nothing provides", await pr.pack_for("anything") == null)
	S.remove_tree(root)


func _unfetchable(t: PKeyTestContext) -> void:
	var gone := _pack("djdl.gone", ["foe.ghost"])
	var other := _pack("djdl.other", ["foe.ghost"])
	var root := S.scratch("provides-unfetchable")
	var e := F.engine(root, F.FakeTransport.new().add(other), F.stamp_for([gone]))
	var pr := P.new(e)
	await e.load_state([])
	t.check("unfetchable: a target whose record cannot be fetched is skipped", await pr.pack_for("foe.ghost") == null)
	S.check_same(t, "unfetchable: the next target still answers", await pr.pack_for("foe.ghost", [_target(gone), _target(other)]), _provider(other))
	# A target whose hash names another pack's record fails the pin and is skipped.
	var wrong := _target(other)
	wrong["pack"] = "djdl.gone"
	t.check("unfetchable: a record that is not the target's release is skipped", await pr.pack_for("foe.ghost", [wrong]) == null)
	S.remove_tree(root)


func _unentitled(t: PKeyTestContext) -> void:
	var skins := _pack("djdl.skins", ["skin.gold"], {"entitlement": "extras.skins"})
	var root := S.scratch("provides-entitled")
	var e := F.engine(root, F.FakeTransport.new().add(skins), F.stamp_for([skins]))
	var granted := {}
	e.entitlements = func() -> Variant: return granted
	var pr := P.new(e)
	await e.load_state([])
	t.check("entitlement: an unentitled pack is hidden from pack_for", await pr.pack_for("skin.gold") == null)
	granted["extras.skins"] = true
	S.check_same(t, "entitlement: granted, it answers", await pr.pack_for("skin.gold"), _provider(skins))
	var r := await e.ensure(["djdl.skins"])
	t.check("entitlement: installed while granted, it is available", r.ok and pr.is_available("skin.gold"), str(r))
	granted.erase("extras.skins")
	t.check("entitlement: the grant gone, it is hidden from is_available", not pr.is_available("skin.gold"))
	e.entitlements = Callable()
	t.check("entitlement: no License service (null) never hides a pack", pr.is_available("skin.gold"))
	S.remove_tree(root)


func _facade(t: PKeyTestContext) -> void:
	var packs := PKeyPacks.new()
	packs.stamp_path = "res://tests/fixtures/no-such-stamp.json"
	t.check("facade: is_available is false before packs start", packs.is_available("foe.goblin") == false)
	t.check("facade: pack_for is null without a content stamp", await packs.pack_for("foe.goblin") == null)
