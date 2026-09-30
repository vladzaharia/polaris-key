extends RefCounted
# S-06: outlet-signal probe (prototype/outlet-signals/godot/outlet_probe.gd).

func run(args: PackedStringArray) -> void:
	load("res://outlet-signals/godot/outlet_probe.gd").new().run(args)
