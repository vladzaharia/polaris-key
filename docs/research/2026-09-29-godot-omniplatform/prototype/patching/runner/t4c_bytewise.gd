class_name T4cBytewise
extends SceneTree
## Cost of a bsdiff-style byte-wise "old + diff" loop in GDScript (what a pure-GDScript bspatch would need).
const L = preload("res://lib.gd")
func _init() -> void:
	var n := 4 << 20
	var old := PackedByteArray(); old.resize(n)
	var diff := PackedByteArray(); diff.resize(n)
	for i in range(0, n, 997):
		old[i] = i & 255; diff[i] = (i >> 3) & 255
	var out := PackedByteArray(); out.resize(n)
	var t := L.now_ms()
	for i in n:
		out[i] = (old[i] + diff[i]) & 255
	var ms := L.now_ms() - t
	print("bytewise add loop: %.1f MB/s" % [n / 1048576.0 / (ms / 1000.0)])
	# vectorised alternative: none in the API (no PackedByteArray element-wise ops); XOR via PackedInt64Array view is also a loop
	var o64 := old.to_int64_array(); var d64 := diff.to_int64_array(); var r64 := PackedInt64Array(); r64.resize(o64.size())
	t = L.now_ms()
	for i in o64.size():
		r64[i] = o64[i] ^ d64[i]
	ms = L.now_ms() - t
	print("xor loop over int64 view: %.1f MB/s" % [n / 1048576.0 / (ms / 1000.0)])
	quit()
