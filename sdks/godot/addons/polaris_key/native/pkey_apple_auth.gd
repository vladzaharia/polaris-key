@tool
class_name PKeyAppleAuth
extends RefCounted
## The system browser sheet of a native redirect sign-in on iOS and macOS (I-48.17): an
## `ASWebAuthenticationSession` shown on the key window by the Swift binary ops `auth_open` and
## `auth_cancel` (PolarisKeyPlatform/WebAuthHost.swift), reported as the binary events `auth_done`
## and `auth_fail`. PKeyIdentity opens the pushed request's authorize URL through it when the
## registered-scheme class is chosen; the delivered URL goes to `sign_in.handle_redirect`.
##
## The native side refuses a URL that is not https on the issuer host, and a callback scheme the web
## owns; it hands back only a URL at the registered scheme. One sheet at a time: `open` closes the
## one still showing first (the person asked to open the page again). A sheet the person closes is
## `on_fail("cancelled")`, and the sign-in keeps waiting. The delivered URL carries a one-time code:
## it is passed to `on_done` and never printed, stored or put in `str()`.
##
## Without the binary entry (any other OS, an older build) `create()` answers null and the caller
## opens the system browser itself. Events are drained once per frame while a sheet is open.

const BIN_OK := 1
const BIN_BUSY := 7

## The one instance of this process (`create()` with no argument).
static var _shared: PKeyAppleAuth = null

## The id of the sheet last shown: `cancel_sheet(id)` closes only that one, so a sign-in that ended
## cannot close the sheet of a newer one.
var sheet_id := 0

var _apple: PKeyApple
var _tree: SceneTree = null
var _on_done := Callable()
var _on_fail := Callable()
var _open := false
var _frames := false


## The opener over `apple` (a PKeyApple, or one over a fake native in tests), else the process's
## shared one. Null when the binary entry or the sheet ops are not in this build.
static func create(apple: PKeyApple = null, tree: SceneTree = null) -> PKeyAppleAuth:
	var process_wide := apple == null
	if process_wide:
		if _shared != null:
			return _shared
		if OS.get_name() != "iOS" and OS.get_name() != "macOS":
			return null
		if not ClassDB.class_exists(PKeyApple.NATIVE_CLASS):
			return null
		apple = PKeyApple.shared()
	if not apple.binary_available():
		return null
	var out := PKeyAppleAuth.new()
	out._apple = apple
	out._tree = tree if tree != null else (Engine.get_main_loop() as SceneTree)
	if process_wide:
		_shared = out
	return out


static func shared(tree: SceneTree = null) -> PKeyAppleAuth:
	return create(null, tree)


func _to_string() -> String:
	return "PKeyAppleAuth(open=%s)" % _open


## Show `url` (the pushed request's authorize URL) with the registered `callback_scheme`; `issuer_host`
## is the only host the native side lets it reach. `on_done(url: String)` gets the delivered URL;
## `on_fail(reason: String)` gets "cancelled" (the person closed the sheet) or "failed". True when the
## sheet was shown.
func open(url: String, callback_scheme: String, issuer_host: String, on_done: Callable, on_fail: Callable, ephemeral := false) -> bool:
	cancel()
	var q := {"url": url, "callback_scheme": callback_scheme, "issuer_host": issuer_host, "prefers_ephemeral": ephemeral}
	var r := _apple.cmd_bin("auth_open", JSON.stringify(q).to_utf8_buffer())
	if r.is_empty() or r[0] != BIN_OK:
		return false
	_open = true
	sheet_id += 1
	_on_done = on_done
	_on_fail = on_fail
	_frame_on()
	return true


## Close the sheet if one is showing. No event follows.
func cancel() -> void:
	if not _open:
		return
	_open = false
	_on_done = Callable()
	_on_fail = Callable()
	_frame_off()
	_apple.cmd_bin("auth_cancel", PackedByteArray())


## Close the sheet with `id` if it is still the one showing.
func cancel_sheet(id: int) -> void:
	if _open and id == sheet_id:
		cancel()


## Drain the sheet's events and route them.
func poll() -> void:
	for e in _apple.poll_bin("auth_"):
		if not _open:
			continue
		var kind: String = e[0]
		var j := JSON.new()
		if j.parse((e[1] as PackedByteArray).get_string_from_utf8()) != OK or not (j.data is Dictionary):
			continue
		var d: Dictionary = j.data
		var done := _on_done
		var fail := _on_fail
		if kind == "auth_done" and d.get("url") is String:
			_end()
			if done.is_valid():
				done.call(d["url"])
		elif kind == "auth_fail":
			_end()
			if fail.is_valid():
				fail.call(String(d.get("reason", "failed")))


func _end() -> void:
	_open = false
	_on_done = Callable()
	_on_fail = Callable()
	_frame_off()


func _frame_on() -> void:
	if _tree == null or _frames:
		return
	_frames = true
	_tree.process_frame.connect(poll)


func _frame_off() -> void:
	if _tree != null and _frames and _tree.process_frame.is_connected(poll):
		_tree.process_frame.disconnect(poll)
	_frames = false
