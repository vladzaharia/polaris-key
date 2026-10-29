@tool
class_name PKeyPeerPayload
extends RefCounted
## WIRE-CONTRACT-V5 sections 15.5 and 15.6: the handshake payloads and the HELLO record of
## `pkey-peer/1` (CC-14.6), ported from `packages/client-core/src/peer/payload.ts`, `display.ts`
## and `session.ts` (`parseHello`).
##
## Pure functions over bytes. A handshake payload is strict JSON (section 1.2), an object, at most
## 8 KiB. `parse_handshake_payload` answers {ok = true, caps, ring?, cert?} or {ok = false}; `ring`
## and `cert` are present in mode a, messages 2 and 3, only.
##
## HELLO display data from a peer that is not yet verified (modes v and p) is cleaned the same way
## wherever it is read (section 15.6): `platform` is shown as sent only when it is up to 32 of
## `[A-Za-z0-9 ._+-]`, otherwise "Unknown"; `app` and `label` get the device-label cleaning (section
## 12.7.1) and 64 code points, and `app` is "Unknown" when nothing is left. A HELLO in mode v or p
## is at most 4 KiB. Godot has no Unicode normalisation, so the NFC step Node applies first is not
## done (a decomposed accent is shown as sent), and U+FFFD, which is what a JSON `\u0000` escape
## becomes here (V3 section 10), is dropped from display data so that it vanishes as in Node.

const MAX_HANDSHAKE_PAYLOAD := 8192
const MAX_CAPS := 32
## Section 15.6: a HELLO in mode v or p is at most this many bytes.
const MAX_UNVERIFIED_HELLO := 4096
const UNKNOWN_DISPLAY := "Unknown"
const DEFAULT_MAX_MESSAGE := 1048576

static var _cap_re: RegEx
static var _platform_re: RegEx


static func _static_init() -> void:
	_cap_re = PKeyClaims.whole("[a-z0-9]+/[0-9]+")
	_platform_re = PKeyClaims.whole("[A-Za-z0-9 ._+-]{1,32}")


## Parse a payload as strict JSON; null unless it is an object.
static func parse_strict_object(bytes: PackedByteArray) -> Variant:
	var r := _parse(bytes)
	return r["value"] if r["ok"] else null


## Judge one handshake payload: message 1, or message 2 or 3 in a mode ("a", "v" or "p").
static func parse_handshake_payload(
		mode: String, message: int, bytes: PackedByteArray) -> Dictionary:
	var no := {"ok": false}
	if bytes.size() > MAX_HANDSHAKE_PAYLOAD:
		return no
	var r := _parse(bytes)
	if not r["ok"]:
		return no
	var o: Dictionary = r["value"]
	var nonwire: PKeyJson.PointerSet = r["non_wire_integers"]
	if not _is_one(o.get("v")):
		return no
	if message == 1:
		return no if o.has("cert") else {"ok": true, "caps": []}
	var raw: Variant = o.get("caps")
	if not raw is Array or (raw as Array).size() > MAX_CAPS:
		return no
	var caps: Array = []
	for c in raw:
		if not c is String or not PKeyClaims.matches_whole_re(_cap_re, c):
			return no
		caps.append(c)
	if mode != "a":
		return no if o.has("cert") else {"ok": true, "caps": caps}
	var cert: Variant = o.get("cert")
	if not cert is String or cert == "":
		return no
	if not PKeyClaims.is_wire_integer(o.get("ring"), "/ring", 1, nonwire):
		return no
	return {"ok": true, "caps": caps, "ring": int(o["ring"]), "cert": cert}


## The capabilities both sides list, once each, in byte order (a String sorts by code point, which
## is the byte order of its UTF-8).
static func caps_intersection(a: Array, b: Array) -> Array:
	var out: Array = []
	for c in a:
		if b.has(c) and not out.has(c):
			out.append(c)
	out.sort()
	return out


## The bytes of message 1's payload.
static func payload1() -> PackedByteArray:
	return '{"v":1}'.to_utf8_buffer()


## The bytes of message 2 or 3: `cert` and `ring` in mode a only (`account` = {cert, ring}). Empty
## when mode a has no account, or the payload would pass 8 KiB.
static func payload23(mode: String, caps: Array, account: Variant = null) -> PackedByteArray:
	var o := {"v": 1}
	if mode == "a":
		if not account is Dictionary:
			return PackedByteArray()
		o["cert"] = (account as Dictionary)["cert"]
		o["ring"] = int((account as Dictionary)["ring"])
	o["caps"] = caps.duplicate()
	var bytes := PKeyJson.stringify(o).to_utf8_buffer()
	return PackedByteArray() if bytes.size() > MAX_HANDSHAKE_PAYLOAD else bytes


## The platform as sent when it is up to 32 plain characters, else "Unknown".
static func clean_platform(raw: String) -> String:
	return raw if PKeyClaims.matches_whole_re(_platform_re, raw) else UNKNOWN_DISPLAY


## The device-label cleaning (section 12.7.1) of display data; "" when nothing is left.
static func clean_label(raw: String) -> String:
	return PKeyDeviceLabel.normalize(raw.replace(char(0xFFFD), ""))


## The app name, cleaned like a label; "Unknown" when nothing is left.
static func clean_app(raw: String) -> String:
	var cleaned := clean_label(raw)
	return cleaned if cleaned != "" else UNKNOWN_DISPLAY


## The body of a HELLO record. `label` "" sends none.
static func hello_body(
		label: String, platform: String, app: String,
		max_message := DEFAULT_MAX_MESSAGE) -> PackedByteArray:
	var o := {}
	if label != "":
		o["label"] = label
	o["platform"] = platform
	o["app"] = app
	o["maxMessage"] = max_message
	return PKeyJson.stringify(o).to_utf8_buffer()


## Read a HELLO body: {ok = true, label? (cleaned; absent when none), platform, app, max_message}
## or {ok = false}. Modes v and p take it from a peer that is not yet verified, so it is at most
## 4 KiB there and every display member is cleaned (mode a cleans them too, as Node does).
static func parse_hello(mode: String, body: PackedByteArray) -> Dictionary:
	var no := {"ok": false}
	if mode != "a" and body.size() > MAX_UNVERIFIED_HELLO:
		return no
	var r := _parse(body)
	if not r["ok"]:
		return no
	var o: Dictionary = r["value"]
	if not o.get("platform") is String or not o.get("app") is String:
		return no
	if o.has("label") and not o["label"] is String:
		return no
	if not PKeyClaims.is_wire_integer(
			o.get("maxMessage"), "/maxMessage", 1, r["non_wire_integers"]):
		return no
	var out := {
		"ok": true,
		"platform": clean_platform(o["platform"]),
		"app": clean_app(o["app"]),
		"max_message": int(o["maxMessage"]),
	}
	if o.has("label"):
		var label := clean_label(o["label"])
		if label != "":
			out["label"] = label
	return out


static func _parse(bytes: PackedByteArray) -> Dictionary:
	var r := PKeyJson.parse_bytes(bytes)
	if not r["ok"] or not r["value"] is Dictionary:
		return {"ok": false}
	return r


static func _is_one(v: Variant) -> bool:
	return (v is float or v is int) and float(v) == 1.0

