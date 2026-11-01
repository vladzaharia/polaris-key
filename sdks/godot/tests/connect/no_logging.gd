extends RefCounted
# @pkey-feature connect.app connect.relay connect.lan
# CC-14.N6: Cloud Connect writes nothing to the engine's log. A verbose run of the connect suites holds no
# ticket, key, token, code or payload (checked by grepping that log), and this keeps it so: no file of the
# Connect service, the peer engine or the facade calls print, printerr, push_error, push_warning or
# print_debug, so a new line in one has to be argued for here.

const ROOTS := [
	"res://addons/polaris_key/services/connect",
	"res://addons/polaris_key/core/peer",
]
const FILES := ["res://addons/polaris_key/services/cloud_connect.gd"]
const CALLS := ["print(", "prints(", "printerr(", "printraw(", "print_rich(", "print_debug(", "push_error(", "push_warning("]


func run(t: PKeyTestContext) -> void:
	var files: Array = FILES.duplicate()
	for root: String in ROOTS:
		for f in DirAccess.get_files_at(root):
			if f.ends_with(".gd"):
				files.append(root.path_join(f))
	var read := 0
	var hits: Array = []
	for path: String in files:
		var text := FileAccess.get_file_as_string(path)
		if text.is_empty():
			continue
		read += 1
		var n := 0
		for line in text.split("\n"):
			n += 1
			var code := line.strip_edges()
			if code.begins_with("#"):
				continue
			for call in CALLS:
				if _calls(code, call):
					hits.append("%s:%d" % [path, n])
	if read == 0:
		# An exported pack carries compiled scripts, not their text: nothing to read there.
		t.check("N6: the connect sources are not readable here (an export); checked in the editor run", true)
		return
	t.check("N6: %d connect source files read" % read, read >= 20)
	t.check("N6: none of them prints, logs a warning or pushes an error", hits.is_empty(), str(hits))


## True when `call` appears in `code` as a call, not as the tail of a longer name (`reprint(`, `_print(`).
static func _calls(code: String, call: String) -> bool:
	var from := 0
	while true:
		var at := code.find(call, from)
		if at < 0:
			return false
		var before := code[at - 1] if at > 0 else " "
		if not (before == "_" or (before >= "a" and before <= "z") or (before >= "A" and before <= "Z") or (before >= "0" and before <= "9")):
			return true
		from = at + 1
	return false
