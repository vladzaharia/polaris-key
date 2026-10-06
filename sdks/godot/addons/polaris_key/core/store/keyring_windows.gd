class_name PKeyWinCredBackend
extends PKeyKeyringBackend
## Windows Credential Manager (SP-27) through pkey_win.dll's PKeyWinCredentialNative
## (native/windows/credman/pkey_credman.cpp): generic credentials laid out as python-keyring's
## WinVaultKeyring writes them, so Python's, Kotlin's and Godot's desktop builds of one product
## name the same credential:
##
##   TargetName  the service (`pkey:<product>`), or `<account>@<service>` when a credential for
##               the service already exists under another user name (keyring's compound rule)
##   UserName    the account (`device-token`)
##   blob        the secret, UTF-16LE; Persist LOCAL_MACHINE (it never roams)
##
## Without pkey_win.dll (native/windows/build.ps1 -Install <project>) unavailable() says so and
## nothing is called.

const NATIVE_CLASS := "PKeyWinCredentialNative"

## The native object to call (a PKeyWinCredentialNative, or a test's stand-in with read / write /
## remove); built on first use when the class exists.
var native: Object = null
## The platform this answers for ("" means PKeyHeaders.platform()). Tests set it.
var platform := ""


func _init(p_native: Object = null, p_platform := "") -> void:
	native = p_native
	platform = p_platform


func id() -> String:
	return "credential-manager"


func _native() -> Object:
	if native == null and ClassDB.class_exists(NATIVE_CLASS):
		native = ClassDB.instantiate(NATIVE_CLASS)
	return native


func unavailable() -> String:
	var p := platform if platform != "" else PKeyHeaders.platform()
	if p != PKeyConstants.Platform.WINDOWS:
		return "Credential Manager runs on Windows, not %s" % (p if p != "" else "this platform")
	if _native() == null:
		return "the pkey_win.dll GDExtension (PKeyWinCredentialNative) is not in this build"
	return ""


func get_secret(service: String, account: String) -> Dictionary:
	var why := unavailable()
	if why != "":
		return {"ok": false, "error": why}
	for target in [service, _compound(service, account)]:
		var r := _read(target)
		if not r.get("ok", false):
			return {"ok": false, "error": str(r.get("error", "CredReadW failed"))}
		if r.get("found", false) and str(r.get("user", "")) == account:
			return {"ok": true, "value": str(r.get("value", ""))}
	return {"ok": true, "value": null}


func set_secret(service: String, account: String, secret: String) -> Dictionary:
	var why := unavailable()
	if why != "":
		return {"ok": false, "error": why}
	var existing := _read(service)
	if not existing.get("ok", false):
		return {"ok": false, "error": str(existing.get("error", "CredReadW failed"))}
	var target := service
	if existing.get("found", false) and str(existing.get("user", "")) != account:
		target = _compound(service, account)
	return _plain(_call("write", [target, account, secret]), "CredWriteW failed")


func delete_secret(service: String, account: String) -> Dictionary:
	var why := unavailable()
	if why != "":
		return {"ok": false, "error": why}
	for target in [service, _compound(service, account)]:
		var r := _read(target)
		if not r.get("ok", false):
			return {"ok": false, "error": str(r.get("error", "CredReadW failed"))}
		if r.get("found", false) and str(r.get("user", "")) == account:
			var d := _plain(_call("remove", [target]), "CredDeleteW failed")
			if not d["ok"]:
				return d
	return {"ok": true}


static func _compound(service: String, account: String) -> String:
	return "%s@%s" % [account, service]


func _read(target: String) -> Dictionary:
	return _call("read", [target])


func _call(method: String, args: Array) -> Dictionary:
	var r = _native().callv(method, args)
	return r if r is Dictionary else {"ok": false, "error": "PKeyWinCredentialNative.%s answered %s" % [method, type_string(typeof(r))]}


static func _plain(r: Dictionary, fallback: String) -> Dictionary:
	return {"ok": true} if r.get("ok", false) else {"ok": false, "error": str(r.get("error", fallback))}
