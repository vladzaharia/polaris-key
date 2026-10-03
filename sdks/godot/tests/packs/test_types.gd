extends RefCounted
# @pkey-feature packs.type.l10n.table packs.type.data.json packs.type.audio.bank packs.type.godot.zip packs.handlers
# P4-16's pack types in Godot (CONTENT §4.2, §13):
#
#   cases    every case of the shared fixture set (pack_type_cases.json, byte-identical to
#            client-core's test/fixtures/pack-type-cases.json) through the handlers' checks:
#            the BCP-47 rule, data.json, l10n.table and audio.bank (ml.model is a typed N/A here)
#   data     a data.json pack through the engine: stage, verify, activate, a swap, rollback,
#            uninstall (an old release collected), a formatVersion too new, a file not strict JSON
#   l10n     an l10n.table pack through the TranslationServer: activation, a swap removing the
#            previous release's translations, rollback, uninstall, a wrong locale, a format too new
#   audio    an audio.bank pack with a game-registered middleware: reload, unload on a swap,
#            rollback, a middleware mismatch, the type unregistered
#   custom   a custom.dialogue pack end to end with a game-registered handler; its payload keeps
#            the files.tree path rules and the v1 Godot tree rule; a game check's refusal
#   zip      godot.zip: a stored zip installs to store/<sha256>.zip and mounts; a deflated
#            entry, an out-of-prefix entry, a script, a comment and a data descriptor are refused

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")
const CASES := "res://tests/fixtures/pack_type_cases.json"


func run(t: PKeyTestContext) -> void:
	PKeyL10nParse.warm()
	_cases(t)
	await _data(t)
	await _l10n(t)
	await _audio(t)
	await _custom(t)
	await _zip(t)


# ── The shared cases ─────────────────────────────────────────────────────────────────────────

## The cases file as Godot reads it, with every `\u0000` escape kept as a real NUL byte (a Godot
## String cannot hold U+0000, so the escape is carried as U+E000 and swapped back in the bytes).
static func _load_cases() -> Dictionary:
	var text := FileAccess.get_file_as_string(CASES).replace("\\u0000", "\\ue000")
	var j := JSON.new()
	if j.parse(text) != OK:
		return {}
	return j.data


static func _bytes(f: Dictionary) -> PackedByteArray:
	if f.has("base64"):
		return Marshalls.base64_to_raw(f["base64"])
	var b := String(f["text"]).to_utf8_buffer()
	var out := PackedByteArray()
	var i := 0
	while i < b.size():
		if i + 2 < b.size() and b[i] == 0xEE and b[i + 1] == 0x80 and b[i + 2] == 0x80:
			out.append(0)
			i += 3
		else:
			out.append(b[i])
			i += 1
	return out


static func _entries(files: Array) -> Array:
	var out: Array = []
	for f in files:
		var b := _bytes(f)
		out.append({"path": f["path"], "size": b.size(), "bytes": b})
	return out


static func _verdict(r: Dictionary) -> Dictionary:
	if r["ok"]:
		return {"ok": true}
	return {"ok": false, "detail": r["detail"], "path": r["path"], "code": r["code"]}


func _cases(t: PKeyTestContext) -> void:
	var c := _load_cases()
	if not t.check("cases: the shared fixture set loads", not c.is_empty(), CASES):
		return
	var bad := PackedStringArray()
	for k in c["bcp47"]:
		var got := PKeyL10nParse.bcp47_canonical(k["tag"])
		var ok: bool = got != ""
		if ok != k["ok"] or (k.has("canonical") and got != k["canonical"]):
			bad.append("%s -> %s" % [k["tag"], got])
	t.check("cases: bcp47 (%d tags)" % c["bcp47"].size(), bad.is_empty(), ", ".join(bad))
	for k in c["dataJson"]:
		var limit := int(k.get("options", {}).get("maxFileBytes", 16777216))
		var r := PKeyDataJsonHandler.check_files(_entries(k["files"]), limit)
		var e: Dictionary = k["expect"]
		var pass_ := false
		if e["ok"]:
			pass_ = r["ok"] and r["documents"] == e["documents"]
		else:
			pass_ = not r["ok"] and r["detail"] == e["detail"] and r["path"] == e["path"] and r["code"] == PKeyConstants.ErrorCode.PACK_TYPE_CHECK_FAILED
		t.check("cases: data.json %s" % k["name"], pass_, S.canon(_verdict(r)))
	for k in c["l10nTable"]:
		var limit := int(k.get("options", {}).get("maxFileBytes", 16777216))
		var r := PKeyL10nTableHandler.check_files(_entries(k["files"]), k.get("variant", {}), limit)
		var e: Dictionary = k["expect"]
		var pass_ := false
		if e["ok"]:
			pass_ = r["ok"] and r["tables"] == e["tables"]
		else:
			pass_ = not r["ok"] and r["detail"] == e["detail"] and r["path"] == e["path"]
		t.check("cases: l10n.table %s" % k["name"], pass_, S.canon(r.get("tables", _verdict(r))))
	for k in c["audioBank"]:
		var paths: Array = []
		var desc = null
		for f in k["files"]:
			paths.append(f["path"])
			if f["path"] == "bank.json":
				desc = _bytes(f)
		var r := PKeyAudioBankHandler.check_descriptor(paths, desc, k["options"]["middleware"], k["options"]["version"])
		var e: Dictionary = k["expect"]
		var pass_ := false
		if e["ok"]:
			pass_ = r["ok"] and r["banks"] == e["banks"]
		else:
			pass_ = not r["ok"] and r["detail"] == e["detail"] and r["path"] == e["path"]
		t.check("cases: audio.bank %s" % k["name"], pass_, S.canon(r.get("banks", _verdict(r))))
	t.check("cases: ml.model is not a Godot type (a typed N/A; a game registers its own handler)", not PKeyPackEngine.new(PKeyPackStorage.new(S.scratch("types-ml"))).handlers.has("ml.model"))


# ── Engine helpers ───────────────────────────────────────────────────────────────────────────

static func _engine(tag: String, packs: Array, pin: Dictionary, axes := {}) -> PKeyPackEngine:
	var tr := F.FakeTransport.new()
	for p in packs:
		tr.add(p)
	var e := F.engine(S.scratch(tag), tr, F.stamp_for([pin]))
	e.prefs["axes"] = axes
	return e


## A new process over the same root pinning `pin` (the same handlers registered again).
static func _next(e: PKeyPackEngine, packs: Array, pin: Dictionary, handlers: Array, axes := {}) -> PKeyPackEngine:
	var tr := F.FakeTransport.new()
	for p in packs:
		tr.add(p)
	var n := F.engine(e.storage.root, tr, F.stamp_for([pin]))
	n.prefs["axes"] = axes
	for h in handlers:
		n.register_handler(h)
	return n


static func _code(r: PKeyResult) -> String:
	return "" if r.ok else String(r.code)


# ── data.json ────────────────────────────────────────────────────────────────────────────────

func _data(t: PKeyTestContext) -> void:
	var seen: Array = []
	var h := PKeyDataJsonHandler.new({
		"on_activate": func(id, docs): seen.append(["on", id, docs.size()]),
		"on_deactivate": func(id): seen.append(["off", id]),
	})
	var o := {"type": "data.json"}
	var v1 := F.tree_pack("djdl.events", "1.0.0", 1, {"winter.json": "{\"snow\": 1}", "spring.txt": "{\"bloom\": true}"}, null, o)
	var v2 := F.tree_pack("djdl.events", "1.1.0", 2, {"winter.json": "{\"snow\": 2}"}, null, o)
	var v3 := F.tree_pack("djdl.events", "1.2.0", 3, {"winter.json": "{\"snow\": 3}"}, null, o)
	var all := [v1, v2, v3]
	var e := _engine("types-data", all, v1)
	e.register_handler(h)
	await e.load_state([])
	var r := await e.ensure(["djdl.events"])
	t.check("data: stage, verify and activate (documents by path, content not extension)", r.ok and h.documents("djdl.events") == {"spring.txt": {"bloom": true}, "winter.json": {"snow": 1.0}} and seen == [["on", "djdl.events", 2]], str(r))
	var loc1: String = e.doc["active"]["djdl.events"]["location"]
	var e2 := _next(e, all, v2, [h])
	await e2.load_state([])
	seen.clear()
	r = await e2.ensure(["djdl.events"])
	t.check("data: a newer release swaps the documents (the old one deactivated first)", r.ok and h.documents("djdl.events") == {"winter.json": {"snow": 2.0}} and seen.size() >= 2 and seen[-2] == ["off", "djdl.events"] and seen[-1][0] == "on", S.canon(seen))
	var rb := await e2.rollback("djdl.events")
	t.check("data: rollback re-activates the previous documents", rb.ok and rb.detail == true and h.documents("djdl.events") == {"spring.txt": {"bloom": true}, "winter.json": {"snow": 1.0}})
	var e3 := _next(e, all, v3, [h])
	await e3.load_state([])
	r = await e3.ensure(["djdl.events"])
	var e4 := _next(e, all, v2, [h])
	await e4.load_state([])
	r = await e4.ensure(["djdl.events"])
	t.check("data: uninstall: a release no longer active or previous is collected", r.ok and not DirAccess.dir_exists_absolute(loc1) and h.documents("djdl.events") == {"winter.json": {"snow": 2.0}}, loc1)
	S.remove_tree(e.storage.root)

	var dir := S.scratch("types-data-unreadable")
	DirAccess.make_dir_recursive_absolute(dir)
	var fa := FileAccess.open(dir.path_join("a.json"), FileAccess.WRITE)
	fa.store_string("{}")
	fa.close()
	if OS.get_name() in ["macOS", "Linux"] and OS.execute("chmod", ["000", ProjectSettings.globalize_path(dir.path_join("a.json"))]) == 0 and FileAccess.open(dir.path_join("a.json"), FileAccess.READ) == null:
		var und := PKeyDataJsonHandler.new().check_payload(dir, {}, {})
		t.check("data: a staged file that cannot be read is unreadable (its path)", not und["ok"] and und["detail"] == "unreadable" and und["path"] == "a.json", S.canon(und))
		var un := PKeyL10nTableHandler.new().check_payload(dir, {}, {"variant": {}})
		t.check("l10n: a staged file that cannot be read is unreadable (its path)", not un["ok"] and un["detail"] == "unreadable" and un["path"] == "a.json", S.canon(un))
		OS.execute("chmod", ["644", ProjectSettings.globalize_path(dir.path_join("a.json"))])
	S.remove_tree(dir)
	var too_new := F.tree_pack("djdl.balance", "1.0.0", 1, {"a.json": "{}"}, null, {"type": "data.json", "formatVersion": 2})
	var e5 := _engine("types-data-fv", [too_new], too_new)
	await e5.load_state([])
	r = await e5.ensure(["djdl.balance"])
	t.check("data: a formatVersion the handler does not list is pack-type-unsupported", _code(r) == PKeyConstants.ErrorCode.PACK_TYPE_UNSUPPORTED, str(r))
	e5.register_handler(PKeyDataJsonHandler.new({"format_versions": [1, 2]}))
	r = await e5.ensure(["djdl.balance"])
	t.check("data: …and installs once the host lists it", r.ok, str(r))
	S.remove_tree(e5.storage.root)

	var bad := F.tree_pack("djdl.balance", "1.0.0", 1, {"a.json": "{}", "b.json": "{\"x\": 1,}"}, null, o)
	var e6 := _engine("types-data-bad", [bad], bad)
	await e6.load_state([])
	r = await e6.ensure(["djdl.balance"])
	t.check("data: a file that is not strict JSON is pack-type-check-failed (json, its path) and nothing commits", _code(r) == PKeyConstants.ErrorCode.PACK_TYPE_CHECK_FAILED and r.detail.get("path") == "b.json" and r.detail.get("detail") == "json" and e6.doc["active"].is_empty() and not DirAccess.dir_exists_absolute(e6.storage.tree_path(bad["treeDigest"])), str(r))
	S.remove_tree(e6.storage.root)


# ── l10n.table ───────────────────────────────────────────────────────────────────────────────

func _l10n(t: PKeyTestContext) -> void:
	var before := TranslationServer.get_locale()
	TranslationServer.set_locale("fr")
	var h := PKeyL10nTableHandler.new()
	var axes := {"locale": ["fr"]}
	var o := {"type": "l10n.table", "variant": {"locale": "fr"}}
	var po := "msgid \"\"\nmsgstr \"Language: fr\\n\"\n\nmsgid \"pkey_t_hello\"\nmsgstr \"Bonjour\"\n\nmsgctxt \"menu\"\nmsgid \"pkey_t_open\"\nmsgstr \"Ouvrir\"\n"
	var v1 := F.tree_pack("djdl.l10n.fr", "1.0.0", 1, {"fr.po": po}, null, o)
	var v2 := F.tree_pack("djdl.l10n.fr", "1.1.0", 2, {"fr.csv": "keys,fr\npkey_t_hello,Salut\n"}, null, o)
	var v3 := F.tree_pack("djdl.l10n.fr", "1.2.0", 3, {"fr.json": "{\"locale\": \"fr\", \"messages\": {\"pkey_t_hello\": \"Coucou\"}}"}, null, o)
	var all := [v1, v2, v3]
	var e := _engine("types-l10n", all, v1, axes)
	e.register_handler(h)
	await e.load_state([])
	var r := await e.ensure(["djdl.l10n.fr"])
	t.check("l10n: stage, verify and activate through the TranslationServer (PO, context kept)", r.ok and _t("pkey_t_hello") == "Bonjour" and TranslationServer.translate("pkey_t_open", "menu") == "Ouvrir" and h.translations("djdl.l10n.fr").size() == 1, str(r))
	var loc1: String = e.doc["active"]["djdl.l10n.fr"]["location"]
	var old: Array = h.translations("djdl.l10n.fr").duplicate()
	var e2 := _next(e, all, v2, [h], axes)
	await e2.load_state([])
	r = await e2.ensure(["djdl.l10n.fr"])
	t.check("l10n: a swap (CSV) removes the previous release's translations", r.ok and _t("pkey_t_hello") == "Salut" and TranslationServer.translate("pkey_t_open", "menu") == "pkey_t_open" and h.translations("djdl.l10n.fr") != old, str(r))
	var rb := await e2.rollback("djdl.l10n.fr")
	t.check("l10n: rollback re-activates the previous table", rb.ok and rb.detail == true and _t("pkey_t_hello") == "Bonjour")
	var e3 := _next(e, all, v3, [h], axes)
	await e3.load_state([])
	await e3.ensure(["djdl.l10n.fr"])
	var e4 := _next(e, all, v2, [h], axes)
	await e4.load_state([])
	r = await e4.ensure(["djdl.l10n.fr"])
	t.check("l10n: uninstall: an old release is collected and only the active one answers", r.ok and not DirAccess.dir_exists_absolute(loc1) and _t("pkey_t_hello") == "Salut" and h.tables("djdl.l10n.fr").size() == 1, loc1)
	h.deactivate(e4.doc["active"]["djdl.l10n.fr"])
	t.check("l10n: deactivate leaves no translation behind", _t("pkey_t_hello") == "pkey_t_hello" and h.tables("djdl.l10n.fr") == null)
	S.remove_tree(e.storage.root)

	var wrong := F.tree_pack("djdl.l10n.fr", "1.0.0", 1, {"de.json": "{\"locale\": \"de\", \"messages\": {\"a\": \"b\"}}"}, null, o)
	var e5 := _engine("types-l10n-wrong", [wrong], wrong, axes)
	await e5.load_state([])
	r = await e5.ensure(["djdl.l10n.fr"])
	t.check("l10n: a table whose locale is not the variant's is pack-type-check-failed (locale)", _code(r) == PKeyConstants.ErrorCode.PACK_TYPE_CHECK_FAILED and r.detail.get("path") == "de.json" and r.detail.get("detail") == "locale" and e5.doc["active"].is_empty(), str(r))
	S.remove_tree(e5.storage.root)
	var too_new := F.tree_pack("djdl.l10n.fr", "1.0.0", 1, {"fr.csv": "keys,fr\na,b\n"}, null, {"type": "l10n.table", "variant": {"locale": "fr"}, "formatVersion": 9})
	var e6 := _engine("types-l10n-fv", [too_new], too_new, axes)
	await e6.load_state([])
	r = await e6.ensure(["djdl.l10n.fr"])
	t.check("l10n: a formatVersion too new is pack-type-unsupported", _code(r) == PKeyConstants.ErrorCode.PACK_TYPE_UNSUPPORTED, str(r))
	S.remove_tree(e6.storage.root)
	TranslationServer.set_locale(before)


func _t(id: String) -> String:
	return String(TranslationServer.translate(id))


# ── audio.bank ───────────────────────────────────────────────────────────────────────────────

func _audio(t: PKeyTestContext) -> void:
	var calls: Array = []
	var h := PKeyAudioBankHandler.new({
		"middleware": "fmod", "version": "2.02.22",
		"reload": func(paths): calls.append(["reload", Array(paths).map(func(p): return String(p).get_file())]),
		"unload": func(paths): calls.append(["unload", Array(paths).map(func(p): return String(p).get_file())]),
	})
	var probe := _engine("types-audio-cfg", [], F.tree_pack("djdl.x", "1.0.0", 1, {"a": "b"}))
	t.check("audio: a handler configured with an invalid middleware or version is not registered", not probe.register_handler(PKeyAudioBankHandler.new({"middleware": "FMOD", "version": "2.02"})) and not probe.register_handler(PKeyAudioBankHandler.new({"middleware": "fmod", "version": "2"})) and not probe.handlers.has("audio.bank"))
	S.remove_tree(probe.storage.root)
	t.check("audio: hot when the game can reload banks", h.activation == "hot" and PKeyAudioBankHandler.new({"middleware": "fmod", "version": "2.02"}).activation == "restart")
	var o := {"type": "audio.bank"}
	var desc := "{\"middleware\": \"fmod\", \"version\": \"2.02.10\", \"banks\": [\"Master.strings.bank\", \"Master.bank\"]}"
	var v1 := F.tree_pack("djdl.sfx", "1.0.0", 1, {"bank.json": desc, "Master.bank": "RIFF1", "Master.strings.bank": "RIFF1s"}, null, o)
	var v2 := F.tree_pack("djdl.sfx", "1.1.0", 2, {"bank.json": "{\"middleware\": \"fmod\", \"version\": \"2.02.22\"}", "Main.bank": "RIFF2"}, null, o)
	var all := [v1, v2]
	var e0 := _engine("types-audio-none", all, v1)
	await e0.load_state([])
	var r := await e0.ensure(["djdl.sfx"])
	t.check("audio: without a game-registered handler the type is pack-type-unsupported", _code(r) == PKeyConstants.ErrorCode.PACK_TYPE_UNSUPPORTED, str(r))
	S.remove_tree(e0.storage.root)
	var e := _engine("types-audio", all, v1)
	e.register_handler(h)
	await e.load_state([])
	r = await e.ensure(["djdl.sfx"])
	t.check("audio: stage, verify and activate: the banks reload in the descriptor's order", r.ok and calls == [["reload", ["Master.strings.bank", "Master.bank"]]] and String(h.banks("djdl.sfx")[0]).is_absolute_path(), S.canon(calls))
	var e2 := _next(e, all, v2, [h])
	await e2.load_state([])
	calls.clear()
	r = await e2.ensure(["djdl.sfx"])
	t.check("audio: a swap unloads the previous banks, then reloads", r.ok and calls == [["unload", ["Master.strings.bank", "Master.bank"]], ["reload", ["Main.bank"]]], S.canon(calls))
	calls.clear()
	var rb := await e2.rollback("djdl.sfx")
	t.check("audio: rollback re-points to the previous banks", rb.ok and rb.detail == true and calls == [["unload", ["Main.bank"]], ["reload", ["Master.strings.bank", "Master.bank"]]], S.canon(calls))
	S.remove_tree(e.storage.root)
	var wwise := F.tree_pack("djdl.sfx", "1.0.0", 1, {"bank.json": "{\"middleware\": \"wwise\", \"version\": \"2.02\"}", "Init.bnk": "BKHD"}, null, o)
	var e3 := _engine("types-audio-bad", [wwise], wwise)
	e3.register_handler(h)
	await e3.load_state([])
	r = await e3.ensure(["djdl.sfx"])
	t.check("audio: a bank for another middleware is pack-type-check-failed (middleware)", _code(r) == PKeyConstants.ErrorCode.PACK_TYPE_CHECK_FAILED and r.detail.get("path") == "bank.json" and r.detail.get("detail") == "middleware" and e3.doc["active"].is_empty(), str(r))
	S.remove_tree(e3.storage.root)


# ── custom.* ─────────────────────────────────────────────────────────────────────────────────

class DialogueHandler extends PKeyPackHandler:
	var activated: Array = []
	var deactivated: Array = []
	var refuse := ""

	func _init() -> void:
		type = "custom.dialogue"
		layout = "tree"
		activation = "hot"

	func supports(format_version: int) -> bool:
		return format_version == 1

	func check_payload(dir: String, _record: Dictionary, _variant: Dictionary) -> Dictionary:
		if refuse != "":
			return {"ok": false, "detail": refuse, "path": "lines.txt"}
		return {"ok": FileAccess.file_exists(dir.path_join("lines.txt"))}

	func activate(install: Dictionary) -> void:
		activated.append(FileAccess.get_file_as_string(String(install["location"]).path_join("lines.txt")))

	func deactivate(install: Dictionary) -> void:
		deactivated.append(install["version"])


func _custom(t: PKeyTestContext) -> void:
	var h := DialogueHandler.new()
	var o := {"type": "custom.dialogue"}
	var v1 := F.tree_pack("djdl.dialogue", "1.0.0", 1, {"lines.txt": "hello there"}, null, o)
	var e := _engine("types-custom", [v1], v1)
	await e.load_state([])
	var r := await e.ensure(["djdl.dialogue"])
	t.check("custom: without the game's handler a custom type is pack-type-unsupported", _code(r) == PKeyConstants.ErrorCode.PACK_TYPE_UNSUPPORTED, str(r))
	t.check("custom: register_handler accepts the game's handler", e.register_handler(h))
	r = await e.ensure(["djdl.dialogue"])
	t.check("custom: a custom.dialogue pack installs end to end and the game activates it", r.ok and h.activated == ["hello there"] and e.running.has("djdl.dialogue"), str(r))
	S.remove_tree(e.storage.root)
	# The payload keeps the files.tree path rules (checked before any byte is written)...
	var unsafe := F.tree_pack("djdl.dialogue", "1.0.0", 1, {"lines.txt": "x", "a/../b.txt": "y"}, null, o)
	var e2 := _engine("types-custom-path", [unsafe], unsafe)
	e2.register_handler(h)
	await e2.load_state([])
	r = await e2.ensure(["djdl.dialogue"])
	t.check("custom: an unsafe path is refused like a files.tree's", not r.ok and String(r.code) == "files-unsafe-path" and e2.doc["active"].is_empty(), str(r))
	S.remove_tree(e2.storage.root)
	# ...and the v1 Godot tree rule (a game handler that does not override check_tree keeps it).
	var script := F.tree_pack("djdl.dialogue", "1.0.0", 1, {"lines.txt": "x", "mod.gd": "extends Node"}, null, o)
	var e3 := _engine("types-custom-script", [script], script)
	e3.register_handler(h)
	await e3.load_state([])
	r = await e3.ensure(["djdl.dialogue"])
	t.check("custom: a script in a custom payload is refused by the v1 tree rule", not r.ok and String(r.code) == PKeyPck.DIRECTORY_REFUSED and r.detail.get("path") == "mod.gd", str(r))
	S.remove_tree(e3.storage.root)
	# A game check's refusal: its token kept, anything else read as `check`.
	for c in [["too-long-line", "too-long-line"], ["Bad Token!", "check"]]:
		h.refuse = c[0]
		var e4 := _engine("types-custom-refuse", [v1], v1)
		e4.register_handler(h)
		await e4.load_state([])
		r = await e4.ensure(["djdl.dialogue"])
		t.check("custom: a game check's refusal %s is pack-type-check-failed (%s)" % [c[0], c[1]], _code(r) == PKeyConstants.ErrorCode.PACK_TYPE_CHECK_FAILED and r.detail.get("detail") == c[1] and r.detail.get("path") == "lines.txt", str(r))
		S.remove_tree(e4.storage.root)
	h.refuse = ""


# ── godot.zip ────────────────────────────────────────────────────────────────────────────────

static var _crc_table := PackedInt64Array()


static func _crc32(b: PackedByteArray) -> int:
	if _crc_table.is_empty():
		_crc_table.resize(256)
		for n in 256:
			var c := n
			for k in 8:
				c = (0xEDB88320 ^ (c >> 1)) if (c & 1) else (c >> 1)
			_crc_table[n] = c
	var crc := 0xFFFFFFFF
	for x in b:
		crc = _crc_table[(crc ^ x) & 0xFF] ^ (crc >> 8)
	return crc ^ 0xFFFFFFFF


static func _u16(v: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(2)
	b.encode_u16(0, v)
	return b


static func _u32(v: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(4)
	b.encode_u32(0, v)
	return b


## A zip of `files` (name → text). `opts`: method (default 0), flags, comment.
static func _make_zip(files: Dictionary, opts := {}) -> PackedByteArray:
	var out := PackedByteArray()
	var cd := PackedByteArray()
	var method := int(opts.get("method", 0))
	var flags := int(opts.get("flags", 0))
	for name in files:
		var data := String(files[name]).to_utf8_buffer()
		var nb := String(name).to_utf8_buffer()
		var crc := _crc32(data)
		var at := out.size()
		for part in [_u32(0x04034b50), _u16(20), _u16(flags), _u16(method), _u16(0), _u16(0x21), _u32(crc), _u32(data.size()), _u32(data.size()), _u16(nb.size()), _u16(0), nb, data]:
			out.append_array(part)
		var ec := String(opts.get("entry_comment", "")).to_utf8_buffer()
		for part in [_u32(0x02014b50), _u16(20), _u16(20), _u16(flags), _u16(method), _u16(0), _u16(0x21), _u32(crc), _u32(data.size()), _u32(data.size()), _u16(nb.size()), _u16(0), _u16(ec.size()), _u16(0), _u16(0), _u32(0), _u32(at), nb, ec]:
			cd.append_array(part)
	var cd_at := out.size()
	if opts.get("zip64_locator", false):
		# A locator just before the end record (cd_at then points past it, as the record says).
		var locator := PackedByteArray()
		for part in [_u32(0x07064b50), _u32(0), _u32(0), _u32(0), _u32(1)]:
			locator.append_array(part)
		cd.append_array(locator)
	out.append_array(cd)
	var comment := String(opts.get("comment", "")).to_utf8_buffer()
	for part in [_u32(0x06054b50), _u16(0), _u16(0), _u16(files.size()), _u16(files.size()), _u32(cd.size()), _u32(cd_at), _u16(comment.size()), comment]:
		out.append_array(part)
	return out


## Two stored entries whose data overlap: the second entry's local header and data sit inside the
## first entry's data, so both headers agree with their central records.
static func _overlapping_zip() -> PackedByteArray:
	var name2 := "pkey_zip_test/inner.txt".to_utf8_buffer()
	var data2 := "inner".to_utf8_buffer()
	var inner := PackedByteArray()
	for part in [_u32(0x04034b50), _u16(20), _u16(0), _u16(0), _u16(0), _u16(0x21), _u32(_crc32(data2)), _u32(data2.size()), _u32(data2.size()), _u16(name2.size()), _u16(0), name2, data2]:
		inner.append_array(part)
	var name1 := "pkey_zip_test/outer.bin".to_utf8_buffer()
	var out := PackedByteArray()
	for part in [_u32(0x04034b50), _u16(20), _u16(0), _u16(0), _u16(0), _u16(0x21), _u32(_crc32(inner)), _u32(inner.size()), _u32(inner.size()), _u16(name1.size()), _u16(0), name1, inner]:
		out.append_array(part)
	var at2 := 30 + name1.size()
	var cd := PackedByteArray()
	for e in [[name1, inner, 0], [name2, data2, at2]]:
		for part in [_u32(0x02014b50), _u16(20), _u16(20), _u16(0), _u16(0), _u16(0), _u16(0x21), _u32(_crc32(e[1])), _u32(e[1].size()), _u32(e[1].size()), _u16(e[0].size()), _u16(0), _u16(0), _u16(0), _u16(0), _u32(0), _u32(e[2]), e[0]]:
			cd.append_array(part)
	var cd_at := out.size()
	out.append_array(cd)
	for part in [_u32(0x06054b50), _u16(0), _u16(0), _u16(2), _u16(2), _u32(cd.size()), _u32(cd_at), _u16(0)]:
		out.append_array(part)
	return out


## A signed godot.zip release over `bytes` (full strategy only).
static func _zip_pack(pack_id: String, seq: int, bytes: PackedByteArray, prefixes: Array) -> Dictionary:
	var full := {"sha256": F.sha(bytes), "bytes": bytes.size(), "size": bytes.size(), "codec": "none"}
	var record := {
		"schemaVersion": 1, "aud": F.PRODUCT, "deliverable": pack_id, "kind": "pack", "version": "1.0.%d" % seq, "seq": seq,
		"issuedAt": 1759600000 + seq, "type": "godot.zip", "formatVersion": 1,
		"handler": {"mountOrder": 3, "prefixes": prefixes, "activation": "restart"},
		"variants": [{"variant": {}, "payload": {"size": bytes.size(), "sha256": F.sha(bytes)}, "full": full,
			"files": {"format": "pkey-files/1", "layout": "container", "sha256": "ab".repeat(32), "bytes": 10, "size": 10, "codec": "zstd", "gaps": {"sha256": "cd".repeat(32), "bytes": 1, "size": 1, "codec": "none"}}}],
	}
	var s := F.sign_record(record)
	return {"packId": pack_id, "version": record["version"], "seq": seq, "jws": s["jws"], "recordSha256": s["sha256"], "record": record, "objects": {F.sha(bytes): bytes}}


func _zip(t: PKeyTestContext) -> void:
	var prefixes := ["res://pkey_zip_test/"]
	var good := _make_zip({"pkey_zip_test/hello.txt": "zip says hi", "pkey_zip_test/data/n.json": "{\"n\": 1}"})
	var chk := PKeyGodotZipHandler.check(PKeyByteSource.memory(good), {"handler": {"prefixes": prefixes}}, {})
	t.check("zip: a stored zip passes the zip and admission checks", chk["ok"] and int(chk["count"]) == 2, S.canon(chk))
	# P4-28: the reference check applies to a zip too, with the app's attachable list forwarded.
	var scene := "[gd_scene load_steps=2 format=3]\n\n[ext_resource type=\"Script\" path=\"res://scripts/die.gd\" id=\"1\"]\n\n[node name=\"Die\" type=\"Node3D\"]\nscript = ExtResource(\"1\")\n"
	var refzip := _make_zip({"pkey_zip_test/die.tscn": scene})
	var unlisted := PKeyGodotZipHandler.check(PKeyByteSource.memory(refzip), {"handler": {"prefixes": prefixes}}, {})
	t.check("zip: an unlisted app script reference is refused (P4-28)", not unlisted["ok"] and unlisted.get("path") == "pkey_zip_test/die.tscn" and String(unlisted.get("detail", "")).contains("which the app does not list as attachable"), S.canon(unlisted))
	var zipref := PKeyGodotZipHandler.new()
	zipref.attachable = PackedStringArray(["res://scripts/die.gd"])
	t.check("zip: listed (the handler's attachable, as PolarisKey.update.packs sets it), it is admitted", zipref.check_output(PKeyByteSource.memory(refzip), {"handler": {"prefixes": prefixes}}, {})["ok"])
	var p := _zip_pack("djdl.zipdlc", 1, good, prefixes)
	var e := _engine("types-zip", [p], p)
	await e.load_state([])
	var r := await e.ensure(["djdl.zipdlc"])
	var loc: String = e.doc["active"]["djdl.zipdlc"]["location"] if r.ok else ""
	t.check("zip: it installs to store/<sha256>.zip (Godot's ZIP source opens only .zip paths)", r.ok and loc == e.storage.zip_path(p["record"]["variants"][0]["payload"]["sha256"]) and FileAccess.file_exists(loc), str(r))
	var h: PKeyGodotZipHandler = e.handlers["godot.zip"]
	t.check("zip: a restart pack, it joins this boot's mounts", h.to_mount.has("djdl.zipdlc"))
	var facade := PKeyPacks.new()
	facade.engine = e
	facade.content = F.stamp_for([p])
	var mounted: Dictionary = await facade.mount()
	t.check("zip: the boot's mount mounts it from its .zip path and its files read through res://", mounted["mounted"] == ["djdl.zipdlc"] and FileAccess.get_file_as_string("res://pkey_zip_test/hello.txt") == "zip says hi" and h.mounted.has("djdl.zipdlc"), S.canon(mounted))
	var again: Dictionary = await facade.mount()
	t.check("zip: never mounted twice in a process", again["mounted"].is_empty())
	var e2 := _next(e, [p], p, [])
	await e2.load_state([])
	t.check("zip: the next load re-verifies the stored zip and runs it", e2.running.has("djdl.zipdlc") and e2.storage.list()["locations"].has(loc))
	# mount() refuses a godot.zip install whose location is not a `.zip` (bytes of the other kind).
	var h2: PKeyGodotZipHandler = e2.handlers["godot.zip"]
	var as_pck := loc.get_basename() + ".pck"
	DirAccess.copy_absolute(loc, as_pck)
	var moved: Dictionary = h2.to_mount["djdl.zipdlc"].duplicate()
	moved["location"] = as_pck
	h2.to_mount["djdl.zipdlc"] = moved
	var f2 := PKeyPacks.new()
	f2.engine = e2
	f2.content = F.stamp_for([p])
	var m2: Dictionary = await f2.mount()
	t.check("zip: mount() refuses a godot.zip stored under a .pck name", m2["mounted"].is_empty() and m2["refused"].size() == 1 and m2["refused"][0]["code"] == PKeyPck.DIRECTORY_REFUSED, S.canon(m2))
	S.remove_tree(e.storage.root)

	var cases := [
		["a deflated entry", _make_zip({"pkey_zip_test/a.txt": "x"}, {"method": 8}), "pkey_zip_test/a.txt"],
		["an out-of-prefix entry", _make_zip({"pkey_zip_test/a.txt": "x", "other/b.txt": "y"}), "other/b.txt"],
		["a script", _make_zip({"pkey_zip_test/a.gd": "extends Node"}), "pkey_zip_test/a.gd"],
		["an archive comment (a GDPC trailer could hide in it)", _make_zip({"pkey_zip_test/a.txt": "x"}, {"comment": "GDPC"}), ""],
		["a data descriptor", _make_zip({"pkey_zip_test/a.txt": "x"}, {"flags": 8}), "pkey_zip_test/a.txt"],
		["an encrypted entry", _make_zip({"pkey_zip_test/a.txt": "x"}, {"flags": 1}), "pkey_zip_test/a.txt"],
		["an unsafe path", _make_zip({"pkey_zip_test/../x.txt": "x"}), "pkey_zip_test/../x.txt"],
		["a duplicate path", _make_zip({"pkey_zip_test/a.txt": "x", "pkey_zip_test/A.txt": "y"}), "pkey_zip_test/A.txt"],
		["a ZIP64 locator before the end record", _make_zip({"pkey_zip_test/a.txt": "x"}, {"zip64_locator": true}), ""],
		["an entry comment", _make_zip({"pkey_zip_test/a.txt": "x"}, {"entry_comment": "hi"}), "pkey_zip_test/a.txt"],
		["an empty zip", _make_zip({}), ""],
		["the bytes GDPC inside an entry (a PCK Godot's offset search could find)", _make_zip({"pkey_zip_test/a.bin": "xxGDPCyy"}), ""],
	]
	var zh := PKeyGodotZipHandler.new()
	zh.activate({"packId": "djdl.zipdlc", "recordSha256": "0".repeat(64), "delegation": "d".repeat(64)})
	t.check("zip: a delegated install never joins the mounts (defence in depth)", not zh.to_mount.has("djdl.zipdlc"))
	# Code-bearing entries and overlapping data, under an admitted prefix: refused like a godot.pck.
	var code_cases := [
		["a .tres that embeds a GDScript", _make_zip({"pkey_zip_test/evil.tres": "[gd_resource type=\"Resource\" load_steps=2 format=3]\n\n[sub_resource type=\"GDScript\" id=\"1\"]\nscript/source = \"extends Node\"\n\n[resource]\nscript = SubResource(\"1\")\n"})],
		["a .remap to a script", _make_zip({"pkey_zip_test/level.tscn.remap": "[remap]\n\npath=\"res://pkey_zip_test/evil.gd\"\n"})],
		["overlapping entries (a local header inside another entry's data)", _overlapping_zip()],
	]
	for c in code_cases:
		var rc := PKeyGodotZipHandler.check(PKeyByteSource.memory(c[1]), {"handler": {"prefixes": prefixes}}, {})
		t.check("zip: %s is refused (pck-directory-refused)" % c[0], not rc["ok"] and rc["code"] == PKeyPck.DIRECTORY_REFUSED, S.canon(rc))
	for c in cases:
		var rc := PKeyGodotZipHandler.check(PKeyByteSource.memory(c[1]), {"handler": {"prefixes": prefixes}}, {})
		t.check("zip: %s is refused (pck-directory-refused, its path)" % c[0], not rc["ok"] and rc["code"] == PKeyPck.DIRECTORY_REFUSED and String(rc.get("path", "")) == c[2], S.canon(rc))
	# "GDPC" + a PCK + an empty end record: once accepted as a zip with no entries, stored as .pck
	# and mounted by the PCK source.
	var pckish := "GDPC".to_ascii_buffer()
	pckish.resize(64)
	pckish.append_array(_make_zip({}))
	var rp := PKeyGodotZipHandler.check(PKeyByteSource.memory(pckish), {"handler": {"prefixes": prefixes}}, {})
	t.check("zip: GDPC + an empty end record is refused", not rp["ok"] and rp["code"] == PKeyPck.DIRECTORY_REFUSED, S.canon(rp))
	var gd := PKeyGodotZipHandler.check(PKeyByteSource.memory(cases[11][1]), {"handler": {"prefixes": prefixes}}, {})
	t.check("zip: the GDPC refusal names its offset", String(gd.get("detail", "")).contains("GDPC") and String(gd.get("detail", "")).contains("offset"), S.canon(gd))
	var tail := good.duplicate()
	tail.append_array("GDPC".to_ascii_buffer())
	t.check("zip: trailing bytes after the end record are refused", not PKeyGodotZipHandler.check(PKeyByteSource.memory(tail), {"handler": {"prefixes": prefixes}}, {})["ok"])
	var bad := _zip_pack("djdl.zipdlc", 2, cases[0][1], prefixes)
	var e3 := _engine("types-zip-bad", [bad], bad)
	await e3.load_state([])
	r = await e3.ensure(["djdl.zipdlc"])
	t.check("zip: a refused zip never commits", _code(r) == PKeyPck.DIRECTORY_REFUSED and e3.doc["active"].is_empty() and e3.storage.list()["locations"].is_empty(), str(r))
	S.remove_tree(e3.storage.root)
