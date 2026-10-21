extends RefCounted
# @pkey-feature ui.i18n
#
# The de and ja test tables (tools/ui_matrix/locales.gd) are keyed by the English string the kit
# passes to `tr()`: PKeyUiCopy.DEFAULTS and the core copy templates. A reworded English string
# (bug package H2: US "canceled", "Last used", "this channel", the expired line) silently loses
# its translation unless the key moves with it. This suite pins, for each string the package
# changed, that a German and a Japanese lookup still resolves, and that no table key is a retired
# English string.
#
#   godot --headless --path sdks/godot -- --pkey-test ui_locales

const TABLES_PATH := "res://tools/ui_matrix/locales.gd"

## The kit's DEFAULTS keys whose English text H2 changed.
const CHANGED_DEFAULTS := ["sign_in_cancelled", "purchase_cancelled", "error_channel_not_allowed", "devices_last_seen"]


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	if not ResourceLoader.exists(TABLES_PATH):
		# An exported pack carries no tools/; the editor run checks the tables.
		t.check("locales: the test tables are an editor-run fixture", OS.has_feature("template"))
		return true
	var tables = load(TABLES_PATH)
	var sources := {}
	for k in PKeyUiCopy.DEFAULTS:
		sources[PKeyUiCopy.DEFAULTS[k]] = true
	for group in [PKeyCoreCopy.COPY_CODES, PKeyCoreCopy.COPY_GATE, PKeyCoreCopy.COPY_ACTIVATION]:
		for code in group:
			var e: Dictionary = group[code]
			sources[String(e.get("title", ""))] = true
			sources[String(e.get("message", ""))] = true
	var strings: Array = []
	for k in CHANGED_DEFAULTS:
		strings.append(String(PKeyUiCopy.DEFAULTS[k]))
	strings.append(String(PKeyCoreCopy.COPY_GATE["expired"]["message"]))
	strings.append(String(PKeyCoreCopy.COPY_CODES["channel_not_allowed"]["message"]))
	strings.append(String(PKeyCoreCopy.COPY_CODES["cancelled"]["message"]))
	var made: Array = []
	for pair in [["de", tables.DE], ["ja", tables.JA]]:
		var tr_ := Translation.new()
		tr_.locale = pair[0]
		var table: Dictionary = pair[1]
		for k in table:
			tr_.add_message(k, table[k])
		TranslationServer.add_translation(tr_)
		made.append(tr_)
		for s in strings:
			t.check("locales: %s still translates \"%s\"" % [pair[0], s], table.has(s))
		# No key is a retired English string (a spelling change that left its translation behind).
		var stale: Array = []
		for k in table:
			if not sources.has(k) and (String(k).contains("cancelled") or String(k).contains("Last seen") or String(k).contains("release channel")):
				stale.append(k)
		t.check("locales: %s has no retired English key" % pair[0], stale.is_empty(), str(stale))
	for loc in ["de", "ja"]:
		TranslationServer.set_locale(loc)
		var copy := PKeyUiCopy.new()
		for k in CHANGED_DEFAULTS:
			var english := String(PKeyUiCopy.DEFAULTS[k])
			var shown := copy.text(k, "x" if english.contains("%s") else null)
			t.check("locales: %s lookup of %s differs from English" % [loc, k], shown != english.replace("%s", "x"), shown)
		for s in strings:
			t.check("locales: %s tr() of \"%s\" resolves" % [loc, s], TranslationServer.translate(s) != s)
	TranslationServer.set_locale("en")
	for tr_ in made:
		TranslationServer.remove_translation(tr_)
	return true
