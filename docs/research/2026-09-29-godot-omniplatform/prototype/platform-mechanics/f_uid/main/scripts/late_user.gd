extends RefCounted
func run() -> String:
	return MainA.new().tag() + "+" + MainE.new().tag()
