# Fixture for tools/api-check.test.ts (rule 1, GDScript).
extends RefCounted

signal status
signal _private_signal

func get(key):
	return key

func get_config(key):
	return key

func helper():
	var x = 1
	return x

static func extra():
	pass

func _ready():
	pass
