class_name PKeyL10nParse
extends RefCounted
## `l10n.table` payloads (CONTENT §4.2; P4-16; client-core `packs/handlers/l10n.ts`): PO, CSV or
## JSON tables, read by plain parsers. Nothing here evaluates a byte: a table is text split into
## messages, never a script, a resource or an object graph (no `str_to_var`, `ConfigFile`,
## `JSON.to_native`, `ResourceLoader` or `.translation` load). Under content-key delegation
## (plans/P4-19.md §8.5) an `l10n.table` is effectively text, because `.translation` fails the
## data-only allow-list; this parser never reads a `.translation` resource at all.
##
## The format of a file is judged by its bytes, never its name: after a UTF-8 BOM and ASCII
## whitespace, `{` is a JSON table, `#`, `msgid` or `msgctxt` a PO file, anything else CSV.
##
##   message: {context: String or null, id, plural: String or null, strings: Array[String]}
##   table:   {path, locale (canonical: `_` written `-`, case kept), messages}

const _BCP47 := "\\A(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?\\z"
const _TAG_CHARS := "\\A[A-Za-z0-9-]{2,35}\\z"
const _PO_KEYWORD := "\\A(msgctxt|msgid_plural|msgid|msgstr(?:\\[([0-9]{1,2})\\])?)[ \\t]+(.*)\\z"
const _LANGUAGE := "\\ALanguage:(.*)\\z"

static var _res := {}


static func _re(pattern: String) -> RegEx:
	var r = _res.get(pattern)
	if r == null:
		r = RegEx.create_from_string(pattern)
		_res[pattern] = r
	return r


## Compile the patterns on the calling thread (the engine's check may run on a worker thread).
static func warm() -> void:
	for p in [_BCP47, _TAG_CHARS, _PO_KEYWORD, _LANGUAGE]:
		_re(p)


static func _ascii_lower(s: String) -> String:
	var out := s
	for i in out.length():
		var c := out.unicode_at(i)
		if c >= 65 and c <= 90:
			out[i] = String.chr(c + 32)
	return out


## A locale as a well-formed BCP-47 tag (RFC 5646 `langtag` and private use; no grandfathered
## tags), with `_` accepted as Godot writes it (`pt_BR`) and written `-`; "" when it is not one.
static func bcp47_canonical(tag: String) -> String:
	var canonical := tag.replace("_", "-")
	if _re(_TAG_CHARS).search(canonical) == null:
		return ""
	return canonical if _re(_BCP47).search(_ascii_lower(canonical)) != null else ""


## Whether two tags name the same locale (ASCII-case-insensitive, after canonicalisation).
static func same_locale(a: String, b: String) -> bool:
	return _ascii_lower(a.replace("_", "-")) == _ascii_lower(b.replace("_", "-"))


## Parse one file: {ok: true, tables} or {ok: false, detail: "table" | "locale"}. Locales are
## canonicalised and checked for well-formedness here; the variant match is the handler's.
static func parse_file(path: String, bytes: PackedByteArray) -> Dictionary:
	if bytes.find(0) != -1:
		return {"ok": false, "detail": "table"}
	var b := bytes
	if b.size() >= 3 and b[0] == 0xEF and b[1] == 0xBB and b[2] == 0xBF:
		b = b.slice(3)
	var body := b.get_string_from_utf8()
	if body.to_utf8_buffer() != b:
		return {"ok": false, "detail": "table"}
	var at := 0
	while at < body.length() and " \t\n\r".contains(body[at]):
		at += 1
	if at == body.length():
		return {"ok": false, "detail": "table"}
	var raw = null
	if body[at] == "{":
		raw = _json_table(b)
	elif body.substr(at, 1) == "#" or body.substr(at, 5) == "msgid" or body.substr(at, 7) == "msgctxt":
		raw = _po(body)
	else:
		raw = _csv(body)
	if raw == null:
		return {"ok": false, "detail": "table"}
	var tables: Array = []
	for t in raw:
		var locale := bcp47_canonical(t["locale"])
		if locale == "":
			return {"ok": false, "detail": "locale"}
		tables.append({"path": path, "locale": locale, "messages": t["messages"]})
	return {"ok": true, "tables": tables}


static func _message(context: Variant, id: String, plural: Variant, strings: Array) -> Dictionary:
	return {"context": context, "id": id, "plural": plural, "strings": strings}


# ── JSON ───────────────────────────────────────────────────────────────────────────────────

static func _json_table(b: PackedByteArray) -> Variant:
	var r := PKeyJson.parse_bytes(b)
	if not r["ok"] or not (r["value"] is Dictionary):
		return null
	var o: Dictionary = r["value"]
	if not (o.get("locale") is String) or not (o.get("messages") is Dictionary):
		return null
	var m: Dictionary = o["messages"]
	# Member order is not portable, so a JSON table's messages are in UTF-8 byte order of ids.
	var ids: Array = m.keys()
	ids.sort_custom(func(x, y): return PKeyPackClaims.compare_bytes(x, y) < 0)
	var messages: Array = []
	for id in ids:
		if not (m[id] is String):
			return null
		messages.append(_message(null, id, null, [m[id]]))
	return [{"locale": o["locale"], "messages": messages}]


# ── PO ─────────────────────────────────────────────────────────────────────────────────────

## A PO string literal (`"…"` and trailing spaces or tabs), unescaped; null when malformed.
static func _po_string(s: String) -> Variant:
	if s.is_empty() or s[0] != "\"":
		return null
	var out := ""
	var i := 1
	var n := s.length()
	var run := 1
	while i < n:
		var c := s[i]
		if c == "\"":
			break
		if c != "\\":
			i += 1
			continue
		out += s.substr(run, i - run)
		i += 1
		var e := s[i] if i < n else ""
		if e == "\\":
			out += "\\"
		elif e == "\"":
			out += "\""
		elif e == "n":
			out += "\n"
		elif e == "t":
			out += "\t"
		elif e == "r":
			out += "\r"
		else:
			return null
		i += 1
		run = i
	if i >= n:
		return null
	out += s.substr(run, i - run)
	for j in range(i + 1, n):
		if s[j] != " " and s[j] != "\t":
			return null
	return out


static func _complete(e: Dictionary) -> bool:
	return e["id"] != null and not e["strings"].is_empty()


static func _po(text: String) -> Variant:
	var entries: Array = []
	var cur = null
	# Which string a continuation line extends: "ctxt", "id", "plural", "str" or "" (none).
	var last := ""
	for raw_line in text.split("\n"):
		var line: String = raw_line
		if line.ends_with("\r"):
			line = line.substr(0, line.length() - 1)
		if line.replace(" ", "").replace("\t", "").is_empty():
			last = ""
			continue
		if line.begins_with("#"):
			last = ""
			continue
		if line.begins_with("\""):
			var s = _po_string(line)
			if s == null or cur == null or last == "":
				return null
			match last:
				"ctxt":
					cur["context"] += s
				"id":
					cur["id"] += s
				"plural":
					cur["plural"] += s
				_:
					cur["strings"][cur["strings"].size() - 1] += s
			continue
		var m := _re(_PO_KEYWORD).search(line)
		if m == null:
			return null
		var kw := m.get_string(1)
		var sv = _po_string(m.get_string(3))
		if sv == null:
			return null
		if kw == "msgctxt" or kw == "msgid":
			var opens_new: bool = cur == null or _complete(cur) or (kw == "msgid" and cur["id"] != null) or kw == "msgctxt"
			if opens_new:
				if cur != null and not _complete(cur):
					return null
				if cur != null:
					entries.append(cur)
				cur = {"context": null, "id": null, "plural": null, "strings": []}
			if kw == "msgctxt":
				cur["context"] = sv
				last = "ctxt"
			else:
				cur["id"] = sv
				last = "id"
			continue
		if cur == null or cur["id"] == null:
			return null
		if kw == "msgid_plural":
			if cur["plural"] != null or not cur["strings"].is_empty():
				return null
			cur["plural"] = sv
			last = "plural"
			continue
		# msgstr or msgstr[N]
		if m.get_start(2) == -1:
			if cur["plural"] != null or not cur["strings"].is_empty():
				return null
		else:
			if cur["plural"] == null or int(m.get_string(2)) != cur["strings"].size():
				return null
		cur["strings"].append(sv)
		last = "str"
	if cur != null:
		if not _complete(cur):
			return null
		entries.append(cur)
	var locale = null
	var headers := 0
	var messages: Array = []
	var seen := {}
	for e in entries:
		if e["id"] == "" and e["context"] == null:
			headers += 1
			if headers > 1 or e["plural"] != null:
				return null
			for l in String(e["strings"][0]).split("\n"):
				var mm := _re(_LANGUAGE).search(l)
				if mm != null and locale == null:
					locale = _trim_blank(mm.get_string(1))
			continue
		var key := [e["context"] == null, "" if e["context"] == null else String(e["context"]), String(e["id"])]
		if seen.has(key):
			return null
		seen[key] = true
		messages.append(_message(e["context"], e["id"], e["plural"], e["strings"]))
	if headers == 0 or locale == null or locale == "":
		return null
	return [{"locale": locale, "messages": messages}]


## Trim spaces and tabs only (never other whitespace).
static func _trim_blank(s: String) -> String:
	var a := 0
	var b := s.length()
	while a < b and (s[a] == " " or s[a] == "\t"):
		a += 1
	while b > a and (s[b - 1] == " " or s[b - 1] == "\t"):
		b -= 1
	return s.substr(a, b - a)


# ── CSV ────────────────────────────────────────────────────────────────────────────────────

static func _record_end(text: String, i: int, n: int) -> bool:
	return text[i] == "\n" or (text[i] == "\r" and i + 1 < n and text[i + 1] == "\n")


## RFC 4180 records (comma only); null when a quote is malformed.
static func _csv_records(text: String) -> Variant:
	var records: Array = []
	var record: Array = []
	var i := 0
	var n := text.length()
	# Whether the current record has any characters (an empty line is no record).
	var started := false
	while i < n:
		var field := ""
		if text[i] == "\"":
			started = true
			i += 1
			var run := i
			while true:
				if i >= n:
					return null
				if text[i] == "\"":
					if i + 1 < n and text[i + 1] == "\"":
						field += text.substr(run, i - run) + "\""
						i += 2
						run = i
						continue
					field += text.substr(run, i - run)
					i += 1
					break
				i += 1
			if i < n and text[i] != "," and not _record_end(text, i, n):
				return null
		else:
			var run := i
			while i < n and text[i] != "," and not _record_end(text, i, n):
				if text[i] == "\"":
					return null
				i += 1
			field = text.substr(run, i - run)
			if field.length() > 0:
				started = true
		record.append(field)
		if i >= n:
			break
		if text[i] == ",":
			started = true
			i += 1
			if i >= n:
				record.append("")
			continue
		i += 2 if text[i] == "\r" else 1
		if started:
			records.append(record)
		record = []
		started = false
	if started:
		records.append(record)
	return records


static func _csv(text: String) -> Variant:
	var records = _csv_records(text)
	if records == null or records.is_empty():
		return null
	var header: Array = records[0]
	if header.size() < 2:
		return null
	var lower := {}
	var tables: Array = []
	for c in range(1, header.size()):
		var k := _ascii_lower(String(header[c]).replace("_", "-"))
		if lower.has(k):
			return null
		lower[k] = true
		tables.append({"locale": header[c], "messages": []})
	var keys := {}
	for r in range(1, records.size()):
		var rec: Array = records[r]
		if rec.size() != header.size():
			return null
		var key: String = rec[0]
		if key == "" or keys.has(key):
			return null
		keys[key] = true
		for c in range(1, rec.size()):
			tables[c - 1]["messages"].append(_message(null, key, null, [rec[c]]))
	return tables
