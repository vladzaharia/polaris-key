class_name PKeyDataOnly
extends RefCounted
## The data-only rule for delegated installs (plans/P4-19.md §2.5 with Amendment A1,
## WIRE-CONTRACT-V4 §2.8): a port of client-core `packs/dataonly.ts`, pinned by the content
## corpus's `dataOnlyCases`. A pack release signed by a delegated content key may hold only files
## this rule admits. The extension allow-list is the real control (Godot chooses its resource
## loader by extension); the head, tail and text rules are defence in depth that fail closed. The
## engine runs the path rule over the files index before any payload object is fetched and the
## whole rule over each file's decoded bytes as the applier writes it (DataOnlySink).
##
##   data_only_extension(path)           the final segment's text after its last `.`, ASCII-
##                                       lowercased; "" when there is none (null in client-core)
##   data_only_path_refusal(path)        rules 1–2: "extension" or ""
##   data_only_text_refusal(bytes)       rule 5 over a text file's whole bytes: "content" or ""
##   data_only_refusal(path, head, tail, full)  rules 1–5: "extension", "content" or ""
##   data_only_file_refusal(path, bytes) data_only_refusal over a whole file
##   is_strict_utf8(bytes)               TextDecoder("utf-8", {fatal: true})'s verdict
##   DataOnlySink                        a tree sink that refuses what the rule refuses
##
## "" is client-core's null (admitted). Pure and thread-safe: the appliers run on a worker thread,
## so nothing here indexes or iterates a const Array (every list is built per call).

const RULE_EXTENSION := "extension"
const RULE_CONTENT := "content"


## `DATA_ONLY_EXTENSIONS` (rule 2), built per call; equal to PKeyConstants.DATA_ONLY_EXTENSION_VALUES
## (the tests compare them).
static func extensions() -> PackedStringArray:
	return PackedStringArray(["json", "csv", "tsv", "po", "txt", "png", "jpg", "jpeg", "webp", "ogg", "wav", "mp3", "ttf", "otf"])


## The extensions whose files are text a VariantParser reader could parse (Amendment A1): the
## whole decoded file passes the text rule.
static func text_extensions() -> PackedStringArray:
	return PackedStringArray(["json", "csv", "tsv", "po", "txt"])


## The script markers a text file may not hold (Amendment A1): the script types, then the
## properties that hold a script's source. The same list as client-core's
## `DATA_ONLY_SCRIPT_MARKERS` and P4-08's `packLint` `SCRIPT_MARKERS` (never the engine's extra
## Script classes, so every SDK gives the same verdict).
static func script_markers() -> PackedStringArray:
	return PackedStringArray(["GDScript", "CSharpScript", "ScriptExtension", "script/source", "source_code"])


## The refused heads (rule 3), after a UTF-8 BOM and ASCII whitespace are skipped: Godot resource,
## pack and script formats; archives and native code; scripts. With `extends` and `class_name`
## (word_heads) that makes client-core's 20.
static func heads() -> Array:
	return [
		# Godot.
		"RSRC".to_ascii_buffer(), "RSCC".to_ascii_buffer(), "GDPC".to_ascii_buffer(), "GDEC".to_ascii_buffer(),
		"GCPF".to_ascii_buffer(), "GDSC".to_ascii_buffer(), "[gd_".to_ascii_buffer(),
		# Archives and native code.
		"504b0304".hex_decode(), "7f454c46".hex_decode(), "MZ".to_ascii_buffer(),
		"feedface".hex_decode(), "feedfacf".hex_decode(), "cefaedfe".hex_decode(), "cffaedfe".hex_decode(),
		"cafebabe".hex_decode(), "0061736d".hex_decode(),
		# Scripts.
		"#!".to_ascii_buffer(), "@tool".to_ascii_buffer(),
	]


## The word heads: refused only when a space or a tab follows (or the window cuts them).
static func word_heads() -> Array:
	return ["extends".to_ascii_buffer(), "class_name".to_ascii_buffer()]


static func _is_ws(b: int) -> bool:
	return b == 0x20 or (b >= 0x09 and b <= 0x0D)


static func _starts_with(bytes: PackedByteArray, at: int, magic: PackedByteArray) -> bool:
	if at + magic.size() > bytes.size():
		return false
	for k in magic.size():
		if bytes[at + k] != magic[k]:
			return false
	return true


## True when the window ends inside `magic` read from `at`: what is visible is its prefix.
static func _straddles(bytes: PackedByteArray, at: int, magic: PackedByteArray) -> bool:
	if at + magic.size() <= bytes.size():
		return false
	for k in range(at, bytes.size()):
		if bytes[k] != magic[k - at]:
			return false
	return true


## Strict UTF-8, exactly TextDecoder("utf-8", {fatal: true})'s verdict (the WHATWG ranges): no
## overlong form, no encoded surrogate, nothing above U+10FFFF, no truncated sequence and no stray
## continuation byte.
static func is_strict_utf8(b: PackedByteArray) -> bool:
	var i := 0
	var n := b.size()
	while i < n:
		var c := b[i]
		if c < 0x80:
			i += 1
			continue
		var need := 0
		var lo := 0x80
		var hi := 0xBF
		if c >= 0xC2 and c <= 0xDF:
			need = 1
		elif c == 0xE0:
			need = 2
			lo = 0xA0
		elif (c >= 0xE1 and c <= 0xEC) or c == 0xEE or c == 0xEF:
			need = 2
		elif c == 0xED:
			need = 2
			hi = 0x9F
		elif c == 0xF0:
			need = 3
			lo = 0x90
		elif c >= 0xF1 and c <= 0xF3:
			need = 3
		elif c == 0xF4:
			need = 3
			hi = 0x8F
		else:
			return false
		if i + need >= n:
			return false
		var x := b[i + 1]
		if x < lo or x > hi:
			return false
		for k in range(2, need + 1):
			var y := b[i + k]
			if y < 0x80 or y > 0xBF:
				return false
		i += need + 1
	return true


static func _is_hex(s: String) -> bool:
	for k in s.length():
		var c := s.unicode_at(k)
		if not ((c >= 0x30 and c <= 0x39) or (c >= 0x41 and c <= 0x46) or (c >= 0x61 and c <= 0x66)):
			return false
	return true


## True when the text holds a `\u` or `\U` escape that could spell ASCII (Amendment A1): `\u` not
## followed by exactly 4 hex digits, `\U` not followed by exactly 6 (VariantParser's form), or
## either decoding below 0x80. Escapes of non-ASCII characters (surrogate halves included) pass.
## Each `\u`/`\U` occurrence is found natively; client-core looks at every backslash, which reaches
## exactly the same occurrences.
static func _ascii_escape(text: String) -> bool:
	return _escape_hit(text, "\\u", 4) or _escape_hit(text, "\\U", 6)


static func _escape_hit(text: String, needle: String, n: int) -> bool:
	var at := text.find(needle)
	while at >= 0:
		var digits := text.substr(at + 2, n)
		if digits.length() != n or not _is_hex(digits):
			return true
		if digits.hex_to_int() < 0x80:
			return true
		at = text.find(needle, at + 2)
	return false


## Rule 5 (Amendment A1), over a text file's whole decoded bytes: "content" when the bytes are not
## strict UTF-8 or hold a NUL; when it holds a `\u` or `\U` escape that could spell ASCII; or when
## the text, or the text with every backslash removed, holds a script marker. A VariantParser
## reader (`str_to_var`, ConfigFile, `JSON.to_native` with objects) builds an inline
## `Object(GDScript, "script/source": …)`, which compiles when set; this refuses every spelling of
## one, failing closed. "" when admitted.
static func data_only_text_refusal(bytes: PackedByteArray) -> String:
	if not is_strict_utf8(bytes):
		return RULE_CONTENT
	if bytes.find(0) != -1:
		return RULE_CONTENT
	# Strict UTF-8 without a NUL decodes losslessly (a leading BOM is dropped, as TextDecoder drops
	# it; it holds no ASCII, so no verdict below changes).
	var text := bytes.get_string_from_utf8()
	if _ascii_escape(text):
		return RULE_CONTENT
	var bare := text.replace("\\", "")
	for m in script_markers():
		if text.contains(m) or bare.contains(m):
			return RULE_CONTENT
	return ""


## Rule 2's extension: the final segment's text after its last `.`, ASCII-lowercased; "" when the
## segment has no `.` (client-core's null; a trailing `.` gives "" too, which no rule admits).
static func data_only_extension(path: String) -> String:
	var last := path.substr(path.rfind("/") + 1)
	var dot := last.rfind(".")
	if dot < 0:
		return ""
	return PKeyPackFiles.ascii_lower(last.substr(dot + 1))


## Rules 1 and 2 alone, over a path: "extension" when the path is not already normalised (it fails
## the files index's path rules, or Godot's `simplify_path()` would change it, which those rules
## make impossible: P4-08's finding, asserted here) or its extension is not in
## DATA_ONLY_EXTENSIONS. "" when admitted.
static func data_only_path_refusal(path: Variant) -> String:
	if not (path is String) or not PKeyPackFiles.path_safe(path):
		return RULE_EXTENSION
	if (path as String).simplify_path() != path:
		return RULE_EXTENSION
	var ext := data_only_extension(path)
	if ext == "" or not extensions().has(ext):
		return RULE_EXTENSION
	return ""


## The data-only rule over one file (plans/P4-19.md §2.5, Amendment A1): `path` its index path,
## `head` its first DATA_ONLY_HEAD_BYTES decoded bytes (fewer for a shorter file), `tail` its last
## DATA_ONLY_TAIL_BYTES (fewer for a shorter file; the two may overlap), `full` its whole decoded
## bytes (null when not supplied). In order:
##  1. the path is already normalised, else "extension";
##  2. its extension is in DATA_ONLY_EXTENSIONS, else "extension";
##  3. after a UTF-8 BOM and then ASCII whitespace inside `head`, what remains starts with none of
##     the refused heads, else "content". When `head` is a full window (it may cut the file), the
##     skip reaching its end, or a refused head that the window's end cuts (a prefix of it, or a
##     word head whose following byte lies beyond the window), is "content" too;
##  4. `tail` does not end with `GDPC` and holds no `PK\x05\x06`, else "content";
##  5. a text file (json, csv, tsv, po, txt) passes data_only_text_refusal over `full`; without
##     `full` such a file is refused ("content").
## "" when the file is admitted. Never raises.
static func data_only_refusal(path: Variant, head: PackedByteArray, tail: PackedByteArray, full: Variant = null) -> String:
	var p := data_only_path_refusal(path)
	if p != "":
		return p
	var h := head.slice(0, PKeyConstants.DATA_ONLY_HEAD_BYTES)
	var at := 0
	if h.size() >= 3 and h[0] == 0xEF and h[1] == 0xBB and h[2] == 0xBF:
		at = 3
	while at < h.size() and _is_ws(h[at]):
		at += 1
	# A full window may cut the file: what it cannot see is refused (fails closed).
	var cut := h.size() == PKeyConstants.DATA_ONLY_HEAD_BYTES
	if cut and at == h.size():
		return RULE_CONTENT
	for m in heads():
		if _starts_with(h, at, m) or (cut and _straddles(h, at, m)):
			return RULE_CONTENT
	for m in word_heads():
		var magic: PackedByteArray = m
		if _starts_with(h, at, magic):
			var k := at + magic.size()
			if k < h.size():
				if h[k] == 0x20 or h[k] == 0x09:
					return RULE_CONTENT
			elif cut:
				return RULE_CONTENT
		elif cut and _straddles(h, at, magic):
			return RULE_CONTENT
	var t := tail
	if t.size() > PKeyConstants.DATA_ONLY_TAIL_BYTES:
		t = tail.slice(tail.size() - PKeyConstants.DATA_ONLY_TAIL_BYTES)
	if t.size() >= 4 and _starts_with(t, t.size() - 4, "GDPC".to_ascii_buffer()):
		return RULE_CONTENT
	if PKeyPck.first_present(t, ["504b0506".hex_decode()]) != -1:
		return RULE_CONTENT
	if text_extensions().has(data_only_extension(path)):
		return RULE_CONTENT if not (full is PackedByteArray) else data_only_text_refusal(full)
	return ""


## data_only_refusal over a whole file's decoded bytes.
static func data_only_file_refusal(path: String, bytes: PackedByteArray) -> String:
	return data_only_refusal(
		path,
		bytes.slice(0, PKeyConstants.DATA_ONLY_HEAD_BYTES),
		bytes.slice(maxi(0, bytes.size() - PKeyConstants.DATA_ONLY_TAIL_BYTES)),
		bytes,
	)


## A tree sink (`write_file(path, bytes) -> bool`, `close() -> bool`) around the store's, for a
## delegated install: every file passes data_only_file_refusal before it reaches the inner sink.
## The first refusal is kept in `refusal` ({path, rule}) and the write answers false, which fails
## the applier; the engine then aborts the plan with `pack-not-data-only`. Written on the
## applier's worker thread, read on the main thread after it finished.
class DataOnlySink extends RefCounted:
	var inner: Object
	var refusal: Variant = null

	func _init(p_inner: Object) -> void:
		inner = p_inner

	func write_file(path: String, bytes: PackedByteArray) -> bool:
		var rule := PKeyDataOnly.data_only_file_refusal(path, bytes)
		if rule != "":
			if refusal == null:
				refusal = {"path": path, "rule": rule}
			return false
		return inner.write_file(path, bytes) == true

	func close() -> bool:
		return inner.close() == true
