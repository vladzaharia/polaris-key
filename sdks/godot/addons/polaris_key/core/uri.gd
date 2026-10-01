class_name PKeyUri
extends RefCounted
## Percent-encoding exactly as the Node SDK spells it, so a URL this SDK builds is byte-identical
## to sdk-node's (tests/fixtures/release-urls.json pins both sides).
##
##   component(s)   JS `encodeURIComponent`: keeps A-Z a-z 0-9 and - _ . ! ~ * ' ( ), encodes
##                  every other UTF-8 byte as %XX (upper-case hex)
##   form(s)        the WHATWG `application/x-www-form-urlencoded` serializer `URLSearchParams`
##                  uses: keeps A-Z a-z 0-9 and * - . _, a space becomes +, everything else %XX
##
## Godot's own `String.uri_encode()` keeps only RFC 3986's unreserved set, so it encodes
## ! ' ( ) * where JS does not: never use it for a URL that must match another SDK's.

const _COMPONENT_EXTRA := "-_.!~*'()"
const _FORM_EXTRA := "*-._"


static func component(s: String) -> String:
	return _encode(s, _COMPONENT_EXTRA, false)


static func form(s: String) -> String:
	return _encode(s, _FORM_EXTRA, true)


static func _encode(s: String, keep: String, space_plus: bool) -> String:
	var out := ""
	for b in s.to_utf8_buffer():
		if (b >= 0x30 and b <= 0x39) or (b >= 0x41 and b <= 0x5A) or (b >= 0x61 and b <= 0x7A) or keep.contains(char(b)):
			out += char(b)
		elif b == 0x20 and space_plus:
			out += "+"
		else:
			out += "%%%02X" % b
	return out
