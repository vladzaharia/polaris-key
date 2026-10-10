extends RefCounted
## The copy formatter the Godot kit renders through (UI-KITS.md §4.7; plans/UK-02.md D5): the
## GDScript port of ui-core's `copy.ts`. A view names catalog keys and their arguments; this turns
## them into strings in the active locale.
##
##   lookup   the locale's override, the locale's table, the English override, then English; a
##            locale with no pack is English (ui-matrix.json `i18n` pins the order)
##   format   the catalog's ICU subset: plain `{arg}`; at most one `{n, plural, …}` (CLDR's
##            categories, `#` the number as text) or `{formFactor, select, …}` (an unknown value
##            takes `other`)
##
## The tables are brand's GENERATED gettext files, `ui/locale/<locale>.po` (packages/brand/scripts/
## kit-copy.ts): msgid is the catalog key; a plural is msgid_plural with one msgstr[i] per CLDR
## category of the locale, in CLDR order; a formFactor select is the bare msgid (`other`) plus one
## msgctxt <case> per form factor; any other msgctxt is a platform variant (`godot`, `macos`, …),
## which `format` never reads (as the TS tables keep them apart). Every msgstr is a whole string,
## `#` written as `{arg}`, so a plural or select entry is held already parsed.
##
## The .po files are read as text (FileAccess, never ResourceLoader or TranslationServer), with one
## cache per locale, so this works the same from an exported pack. An exported game must carry them:
## the export preset must list `*.po` in its non-resource include filter (an `all_resources` export
## may carry them anyway, as the editor indexes a .po as a Translation, but do not rely on it).
## Without a locale's file the kit formats in English; without en.po it has no strings at all.
##
##   const CopyFormat := preload("res://addons/polaris_key/ui/model/copy_format.gd")
##   var copy = CopyFormat.new({"locale": OS.get_locale()})
##   copy.format("devices.count", {"count": 3})   # "3 devices"

const Errors := preload("res://addons/polaris_key/ui/model/errors.gd")
const Vocabulary := preload("res://addons/polaris_key/ui/model/vocabulary.gd")
const _Self := preload("res://addons/polaris_key/ui/model/copy_format.gd")

## The launch locales (UI-KITS.md owner decisions, 2026-10-05).
const LAUNCH_LOCALES := ["en", "de", "fr", "es", "pt-BR", "it", "ja", "ko", "zh-Hans"]

## Where brand writes the Godot kit's tables, and each launch locale's file name (gettext's).
const LOCALE_DIR := "res://addons/polaris_key/ui/locale/"
const GETTEXT_LOCALE := {
	"en": "en", "de": "de", "fr": "fr", "es": "es", "pt-BR": "pt_BR", "it": "it",
	"ja": "ja", "ko": "ko", "zh-Hans": "zh_Hans",
}

## Each launch locale's CLDR plural categories, in CLDR order (the order of a plural's msgstr[i];
## brand's `pluralCategories`, which reads Intl.PluralRules).
const PLURAL_CATEGORIES := {
	"en": ["one", "other"],
	"de": ["one", "other"],
	"fr": ["one", "many", "other"],
	"es": ["one", "many", "other"],
	"pt-BR": ["one", "many", "other"],
	"it": ["one", "many", "other"],
	"ja": ["other"],
	"ko": ["other"],
	"zh-Hans": ["other"],
}

## The argument a gettext select entry chooses on (the .po header: "A formFactor select is
## msgctxt <case>").
const SELECT_ARG := "formFactor"


## Map a POSIX or BCP 47 locale onto a launch locale; English when none matches.
static func resolve_locale(requested: Variant) -> String:
	if not (requested is String or requested is StringName) or String(requested).is_empty():
		return "en"
	var tag := String(requested)
	var cut := tag.length()
	for mark in [".", "@"]:
		var at := tag.find(mark)
		if at >= 0 and at < cut:
			cut = at
	tag = tag.substr(0, cut).replace("_", "-").to_lower()
	for l in LAUNCH_LOCALES:
		if (l as String).to_lower() == tag:
			return l
	var parts := tag.split("-")
	var lang := parts[0]
	var region := parts[1] if parts.size() > 1 else ""
	if lang == "zh":
		# Traditional Chinese has no pack yet: English, never Simplified.
		return "en" if region in ["tw", "hk", "mo", "hant"] else "zh-Hans"
	if lang == "pt":
		return "pt-BR"
	return lang if LAUNCH_LOCALES.has(lang) else "en"


# ── Messages ─────────────────────────────────────────────────────────────────────────────────
#
# A parsed message: {head: pieces, complex: {arg, kind: "plural" | "select", cases: {name: pieces}}
# or null, tail: pieces}; a piece is {text}, {arg} or {hash: true}.

static var _parsed_cache := {}


## Parse one message of the ICU subset; null (and an error pushed) on anything outside it, where
## the TS throws.
static func parse_message(src: String) -> Variant:
	var hit = _parsed_cache.get(src)
	if hit != null:
		return hit
	var st := {"i": 0, "error": ""}
	var n := src.length()
	var head := _pieces(src, st, false, false)
	var parsed := {"head": head, "complex": null, "tail": []}
	if st["error"] == "" and st["i"] < n:
		var i: int = st["i"]
		# {arg, *(plural|select) *,
		var arg_end := _ident_end(src, i + 1)
		var kind := ""
		if src[i] == "{" and arg_end > 0 and arg_end < n and src[arg_end] == ",":
			var j := _skip_spaces(src, arg_end + 1)
			for k in ["plural", "select"]:
				if src.substr(j, k.length()) == k:
					var after := _skip_spaces(src, j + k.length())
					if after < n and src[after] == ",":
						kind = k
						st["i"] = after + 1
		if kind == "":
			st["error"] = "a bad plural or select"
		else:
			# No prototype in TS either: a select value such as "constructor" is never a case.
			var cases := {}
			while st["error"] == "":
				st["i"] = _skip_spaces(src, st["i"])
				if st["i"] < n and src[st["i"]] == "}":
					st["i"] += 1
					break
				# ([a-z]+) *\{
				var c_start: int = st["i"]
				var c_end := c_start
				while c_end < n and src.unicode_at(c_end) >= 97 and src.unicode_at(c_end) <= 122:
					c_end += 1
				var brace := _skip_spaces(src, c_end)
				if c_end == c_start or brace >= n or src[brace] != "{":
					st["error"] = "a bad case"
					break
				st["i"] = brace + 1
				cases[src.substr(c_start, c_end - c_start)] = _pieces(src, st, kind == "plural", true)
				if st["error"] != "":
					break
				if st["i"] >= n or src[st["i"]] != "}":
					st["error"] = "an unclosed case"
					break
				st["i"] += 1
			if st["error"] == "":
				var tail := _pieces(src, st, false, false)
				if st["error"] == "" and st["i"] < n:
					st["error"] = "trailing text"
				parsed = {"head": head, "complex": {"arg": src.substr(i + 1, arg_end - i - 1), "kind": kind, "cases": cases}, "tail": tail}
	if st["error"] != "":
		push_error("ui-core copy: %s in \"%s\"" % [st["error"], src])
		return null
	_parsed_cache[src] = parsed
	return parsed


## One run of pieces from `st.i`, up to a `}`, a `{arg,` or the end.
static func _pieces(src: String, st: Dictionary, in_plural: bool, in_case: bool) -> Array:
	var out := []
	var n := src.length()
	var run: int = st["i"]
	var i: int = st["i"]
	while i < n:
		var ch := src[i]
		if ch == "}":
			break
		if ch == "#" and in_plural:
			if i > run:
				out.append({"text": src.substr(run, i - run)})
			out.append({"hash": true})
			i += 1
			run = i
			continue
		if ch == "{":
			var end := _ident_end(src, i + 1)
			if end < 0 or end >= n or (src[end] != "}" and src[end] != ","):
				st["error"] = "a bad argument"
				break
			if src[end] == ",":
				if in_case:
					st["error"] = "a nested plural or select"
				break
			if i > run:
				out.append({"text": src.substr(run, i - run)})
			out.append({"arg": src.substr(i + 1, end - i - 1)})
			i = end + 1
			run = i
			continue
		i += 1
	if i > run and st["error"] == "":
		out.append({"text": src.substr(run, i - run)})
	st["i"] = i
	return out


## The end of an identifier `[A-Za-z][A-Za-z0-9]*` starting at `i`, or -1.
static func _ident_end(src: String, i: int) -> int:
	if i >= src.length() or not _alpha(src.unicode_at(i)):
		return -1
	var j := i + 1
	while j < src.length() and (_alpha(src.unicode_at(j)) or (src.unicode_at(j) >= 48 and src.unicode_at(j) <= 57)):
		j += 1
	return j


static func _alpha(c: int) -> bool:
	return (c >= 65 and c <= 90) or (c >= 97 and c <= 122)


static func _skip_spaces(src: String, i: int) -> int:
	while i < src.length() and src[i] == " ":
		i += 1
	return i


## Format one message (ICU-subset text, or a message already parsed) for `locale`. A missing
## argument stays visible as `{name}`. A message outside the subset pushes an error and comes back
## as it is.
static func format_message(src: Variant, args: Dictionary = {}, locale: String = "en") -> String:
	var p = src if src is Dictionary else parse_message(str(src))
	if p == null:
		return str(src)
	var complex = p["complex"]
	var body: Array = []
	if complex != null:
		var arg: String = complex["arg"]
		var cases: Dictionary = complex["cases"]
		var c := "other"
		if complex["kind"] == "plural":
			c = plural_category(locale, _js_number(args[arg]) if args.has(arg) else NAN)
			if not cases.has(c):
				c = "other"
		else:
			var v = args.get(arg)
			c = String(v) if (v is String or v is StringName) and cases.has(String(v)) else "other"
		body = cases.get(c, [])
	var out := ""
	for pieces in [p["head"], body, p["tail"]]:
		for x in pieces:
			if x.has("text"):
				out += x["text"]
			else:
				var name: String = x["arg"] if x.has("arg") else complex["arg"]
				out += _js_string(args[name]) if args.has(name) else "{%s}" % name
	return out


## The CLDR plural category of `n` in `locale` (Intl.PluralRules' `select`), for the launch locales;
## any other tag takes its launch locale's rules (resolve_locale), as Copy only ever formats in a
## launch locale. Like Intl (ICU), the number is read as it prints: the absolute value's shortest
## decimal, rounded half away from zero to at most three fraction digits, trailing zeros dropped.
## Exact for every |n| < 2^53; ICU's own operand truncation above 10^18 is not mirrored.
static func plural_category(locale: String, n: float) -> String:
	if is_nan(n) or is_inf(n):
		return "other"
	var a := absf(n)
	var i := floorf(a)
	var f := 0
	if a != i:
		var fp := _shortest_decimal(a).get_slice(".", 1)
		f = int(fp.substr(0, 3).rpad(3, "0"))
		if fp.length() > 3 and fp.unicode_at(3) >= 53:  # "5"…"9": half away from zero
			f += 1
		if f >= 1000:
			i += 1.0
			f = 0
	# CLDR's operands: i the integer digits; v == 0 when no fraction digit shows.
	var v0 := f == 0
	var million := i != 0.0 and fmod(i, 1000000.0) == 0.0 and v0
	match resolve_locale(locale):
		"en", "de":
			# one: i = 1 and v = 0
			return "one" if i == 1.0 and v0 else "other"
		"it", "es":
			# it one: i = 1 and v = 0; es one: n = 1 (the same once trailing zeros drop).
			# many: e = 0 and i != 0 and i % 1000000 = 0 and v = 0
			if i == 1.0 and v0:
				return "one"
			return "many" if million else "other"
		"fr", "pt-BR":
			# one: i = 0,1 (pt: i = 0..1); many as above
			if i == 0.0 or i == 1.0:
				return "one"
			return "many" if million else "other"
	# ja, ko, zh-Hans: other only.
	return "other"


## JavaScript's `String(v)` for an argument: a whole number without ".0", NaN and Infinity by
## their JS names.
static func _js_string(v: Variant) -> String:
	match typeof(v):
		TYPE_STRING, TYPE_STRING_NAME:
			return String(v)
		TYPE_NIL:
			return "null"
		TYPE_BOOL:
			return "true" if v else "false"
		TYPE_INT:
			return str(v)
		TYPE_FLOAT:
			var x: float = v
			if is_nan(x):
				return "NaN"
			if is_inf(x):
				return "Infinity" if x > 0.0 else "-Infinity"
			if x == floorf(x) and absf(x) < 1e21:
				return str(int(x)) if absf(x) < 9007199254740992.0 else String.num(x, 0)
			if absf(x) >= 1e-6 and absf(x) < 1e21:
				var s := _shortest_decimal(x)
				if s != "":
					return s
	return str(v)


## The shortest decimal (never an exponent) that reads back as the same double, as JavaScript and
## ICU print one; "" when it would need more than 17 fraction digits.
static func _shortest_decimal(x: float) -> String:
	for d in range(1, 18):
		var s := String.num(x, d)
		if s.to_float() == x:
			return s
	return ""


## JavaScript's `Number(v)`, for a plural argument.
static func _js_number(v: Variant) -> float:
	match typeof(v):
		TYPE_INT, TYPE_FLOAT:
			return float(v)
		TYPE_BOOL:
			return 1.0 if v else 0.0
		TYPE_NIL:
			return 0.0
		TYPE_STRING, TYPE_STRING_NAME:
			var s := String(v).strip_edges()
			if s.is_empty():
				return 0.0
			if s == "Infinity" or s == "+Infinity":
				return INF
			if s == "-Infinity":
				return -INF
			if (s.begins_with("0x") or s.begins_with("0X")) and s.substr(2).is_valid_hex_number(false):
				return float(s.substr(2).hex_to_int())
			if s.is_valid_float():
				return s.to_float()
	return NAN


# ── Copy ─────────────────────────────────────────────────────────────────────────────────────

## The locale strings are formatted in: a launch locale with a table, else English.
var locale: String
## Injected tables (launch locale → {key: message}), or null for brand's generated .po tables.
var _tables: Variant = null
## `theme.copy`: partial overrides per locale, which fall back key by key.
var _overrides: Dictionary = {}


## One locale's view of the catalog. `options`: {locale (BCP 47 or POSIX; unknown or absent is
## English), overrides (launch locale → {key: ICU-subset message}), tables (optional; `en` required
## and every key falls back to it)}.
func _init(options: Dictionary = {}) -> void:
	var t = options.get("tables")
	_tables = t if t is Dictionary else null
	var wanted := resolve_locale(options.get("locale"))
	locale = wanted if _table(wanted) != null else "en"
	var o = options.get("overrides")
	_overrides = o if o is Dictionary else {}


## The raw message for `key` (ICU-subset text, or a parsed .po plural or select): the override,
## the table, the English override, English. Null when none has it.
func raw(key: String) -> Variant:
	for layer in [_overrides.get(locale), _table(locale), _overrides.get("en"), _table("en")]:
		if layer is Dictionary:
			var v = layer.get(key)
			if v != null:
				return v
	return null


func has(key: String) -> bool:
	return raw(key) != null


## The string for `key`. A `core.codes.*` key the catalog lacks reads as the fallback sentence
## (DL7); any other unknown key is a bug (every visible string is a catalog key, DL8): the TS
## throws, this pushes an error and answers the key.
func format(key: String, args: Dictionary = {}) -> String:
	var src = raw(key)
	if src != null:
		return format_message(src, args, locale)
	if key.begins_with("core.codes."):
		var rest := key.substr(11)
		for part in ["title", "message"]:
			if rest.ends_with("." + part) and rest.length() > part.length() + 1:
				var with_code := {"code": rest.substr(0, rest.length() - part.length() - 1)}
				with_code.merge(args, true)
				return format(Errors.FALLBACK_COPY[0] if part == "title" else Errors.FALLBACK_COPY[1], with_code)
	push_error("ui-core copy: no catalog string for %s" % key)
	return key


## Every string a view shows, by key: the plain renderer's `{key, args}` made text.
func strings(view: Dictionary) -> Dictionary:
	var out := {}
	var args: Dictionary = view.get("args", {})
	for key in view.get("copy", []):
		out[key] = format(key, args)
	return out


func _table(l: String) -> Variant:
	if _tables != null:
		var t = _tables.get(l)
		return t if t is Dictionary else null
	return table(l)


## `new Copy({tables, locale, overrides}).format(key, args)` over the generated tables (what
## ui-core's uiMatrix.test.ts runs for an `i18n` row).
static func format_in(locale: String, key: String, args: Dictionary, overrides: Dictionary) -> String:
	return _Self.new({"locale": locale, "overrides": overrides}).format(key, args)


# ── The gettext tables ───────────────────────────────────────────────────────────────────────

## Launch locale → {messages: {key: message}, variants: {key: {platform: text}}}, or null when the
## locale has no table. Filled on first use.
static var _po_cache := {}


## One launch locale's table from its .po file (key → ICU-subset text, or a parsed plural or
## select), or null when it has none.
static func table(launch_locale: String) -> Variant:
	var t = _loaded(launch_locale)
	return t["messages"] if t != null else null


## The text of a platform variant (`godot`, `macos`, `tv`, …) of `key` in a launch locale, or null.
## Brand writes every locale's variant entry (a translation's is its plain text), so a lookup never
## leaves the locale. `format` never reads these, as ui-core's tables keep them apart too.
static func platform_variant(launch_locale: String, key: String, platform: String) -> Variant:
	var t = _loaded(launch_locale)
	if t == null:
		return null
	var v = t["variants"].get(key)
	return v.get(platform) if v is Dictionary else null


static func _loaded(launch_locale: String) -> Variant:
	if not _po_cache.has(launch_locale):
		_po_cache[launch_locale] = _load_po(launch_locale)
	return _po_cache[launch_locale]


static func _load_po(launch_locale: String) -> Variant:
	var file = GETTEXT_LOCALE.get(launch_locale)
	if file == null:
		return null
	var path := LOCALE_DIR + String(file) + ".po"
	if not FileAccess.file_exists(path):
		return null
	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		push_error("ui-core copy: cannot read %s" % path)
		return null
	return _read_po(text, launch_locale)


## Read brand's generated .po text: entries (comments skipped, but `#. Plural on {arg}.` names a
## plural's argument), then plurals and formFactor selects parsed, platform variants set apart.
static func _read_po(text: String, launch_locale: String) -> Dictionary:
	var entries := []
	var cur = null
	var last := ""
	var plural_arg = null
	for raw_line in text.split("\n"):
		var line := (raw_line as String).strip_edges(false, true)
		if line.is_empty():
			last = ""
			continue
		if line.begins_with("#"):
			if line.begins_with("#. Plural on {") and line.ends_with("}."):
				plural_arg = line.substr(14, line.length() - 16)
			last = ""
			continue
		if line.begins_with("\""):
			if cur != null and last != "":
				if last == "str":
					cur["strings"][cur["strings"].size() - 1] += _unquote(line)
				else:
					cur[last] += _unquote(line)
			continue
		var sp := line.find(" ")
		if sp < 0:
			continue
		var kw := line.substr(0, sp)
		var value := _unquote(line.substr(sp + 1).strip_edges())
		if kw == "msgctxt" or (kw == "msgid" and (cur == null or cur["id"] != null)):
			if cur != null and cur["id"] != null:
				entries.append(cur)
			cur = {"context": null, "id": null, "plural": null, "strings": [], "arg": plural_arg}
			plural_arg = null
		if cur == null:
			continue
		if kw == "msgctxt":
			cur["context"] = value
			last = "context"
		elif kw == "msgid":
			cur["id"] = value
			last = "id"
		elif kw == "msgid_plural":
			cur["plural"] = value
			last = "plural"
		elif kw == "msgstr" or kw.begins_with("msgstr["):
			cur["strings"].append(value)
			last = "str"
	if cur != null and cur["id"] != null:
		entries.append(cur)

	var cats: Array = PLURAL_CATEGORIES.get(launch_locale, ["other"])
	var messages := {}
	var contexts := {}
	for e in entries:
		var key: String = e["id"]
		var strs: Array = e["strings"]
		if key == "" and e["context"] == null:
			continue  # the header
		if e["plural"] != null:
			if strs.size() != cats.size():
				push_error("ui-core copy: %s has %d plural forms, %s has %d categories" % [key, strs.size(), launch_locale, cats.size()])
			var cases := {}
			for idx in mini(strs.size(), cats.size()):
				cases[cats[idx]] = _whole_pieces(strs[idx])
			var arg = e["arg"] if e["arg"] != null else _first_arg(strs)
			messages[key] = {"head": [], "complex": {"arg": arg, "kind": "plural", "cases": cases}, "tail": []}
		elif e["context"] == null:
			messages[key] = strs[0] if not strs.is_empty() else ""
		else:
			if not contexts.has(key):
				contexts[key] = {}
			contexts[key][e["context"]] = strs[0] if not strs.is_empty() else ""
	var variants := {}
	for key in contexts:
		var ctx: Dictionary = contexts[key]
		if _is_select(ctx):
			var cases := {"other": _whole_pieces(String(messages.get(key, "")))}
			for ff in ctx:
				cases[ff] = _whole_pieces(ctx[ff])
			messages[key] = {"head": [], "complex": {"arg": SELECT_ARG, "kind": "select", "cases": cases}, "tail": []}
		else:
			variants[key] = ctx
	return {"messages": messages, "variants": variants}


## A select names every form factor but `other` (the bare msgid); a platform variant never does
## (`tv` is both a form factor and a variant platform).
static func _is_select(ctx: Dictionary) -> bool:
	for ff in Vocabulary.FORM_FACTORS:
		if ff != "other" and not ctx.has(ff):
			return false
	return true


## The pieces of one whole msgstr (plain `{arg}` text, a `#` literal).
static func _whole_pieces(text: String) -> Array:
	var p = parse_message(text)
	if p == null or p["complex"] != null:
		push_error("ui-core copy: a .po string outside the subset: \"%s\"" % text)
		return [{"text": text}]
	return p["head"]


## A plural with no `Plural on` comment: the first argument its last form names.
static func _first_arg(strs: Array) -> String:
	var p = parse_message(String(strs[-1])) if not strs.is_empty() else null
	if p != null:
		for x in p["head"]:
			if x.has("arg"):
				return x["arg"]
	return "count"


## A PO string literal's contents, unescaped.
static func _unquote(s: String) -> String:
	if s.length() < 2 or not s.begins_with("\"") or not s.ends_with("\""):
		return s
	var body := s.substr(1, s.length() - 2)
	if not body.contains("\\"):
		return body
	var out := ""
	var i := 0
	while i < body.length():
		var c := body[i]
		if c == "\\" and i + 1 < body.length():
			var e := body[i + 1]
			match e:
				"n":
					out += "\n"
				"t":
					out += "\t"
				"r":
					out += "\r"
				_:
					out += e
			i += 2
			continue
		out += c
		i += 1
	return out
