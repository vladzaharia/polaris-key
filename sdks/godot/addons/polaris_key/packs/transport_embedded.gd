class_name PKeyPackEmbeddedTransport
extends PKeyPackTransport
## `embedded`: the packs shipped in the build, found in one `res://` directory (default
## `res://pkey_packs/`): a single-file payload `X` with its marker `X.pkey.json` beside it, or a
## tree directory `D/` with `D/.pkey/pack.json`. Its bytes are measured (SHA-256 and size, or the
## treeDigest) for the engine's marker match. The content stamp is not a pack and is skipped.

var dir := EMBEDDED_DIR


func _init(p_dir := EMBEDDED_DIR) -> void:
	dir = p_dir.trim_suffix("/")


func id() -> String:
	return PKeyConstants.Transport.EMBEDDED

## The baselines: {marker, location, payload} each, or {location, error} when one cannot be
## read (the engine reports it refused at `format`).


func embedded() -> Array:
	var out: Array = []
	var l := PKeyPackStorage.list_dir(dir)
	if not l["ok"]:
		return out
	var files: PackedStringArray = l["files"]
	for f in files:
		if not f.ends_with(".pkey.json"):
			continue
		var payload_path := dir.path_join(f.trim_suffix(".pkey.json"))
		var m := PKeyPackStorage.read_bytes(dir.path_join(f))
		var p := PKeyPackStorage.measure_file(payload_path)
		if not m["ok"] or m.has("missing") or not p["ok"]:
			out.append({"location": payload_path, "error": "format"})
			continue
		out.append({"marker": m["bytes"], "location": payload_path, "payload": {"kind": "file", "sha256": p["sha256"], "size": p["size"]}})
	for d in l["dirs"]:
		var root := dir.path_join(d)
		var m := PKeyPackStorage.read_bytes(root.path_join(".pkey/pack.json"))
		if not m["ok"] or m.has("missing"):
			continue
		var digest := PKeyPackStorage.directory_tree_digest(root)
		if digest == "":
			out.append({"location": root, "error": "format"})
			continue
		out.append({"marker": m["bytes"], "location": root, "payload": {"kind": "tree", "treeDigest": digest}})
	return out
