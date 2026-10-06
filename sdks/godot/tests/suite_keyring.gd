extends RefCounted
# @pkey-feature core.store
# The desktop keyring store (SP-27): PKeyKeyringStore and its three OS backends.
#
#   contract   PKeyKeyringStore over PKeyFakeKeyring: service pkey:<product> / account
#              device-token, verified writes, the file fallback that is surfaced (failed signal,
#              status keyring-error), file-first reads, the migration of a file-store token into
#              the keyring, unavailable = the file store with keyring-unavailable and no error,
#              PKEY_DESKTOP_KEYRING=0, the device id and cache in the files, preferred() per OS
#   windows    PKeyWinCredBackend over a fake PKeyWinCredentialNative: python-keyring's target
#              layout and its <user>@<service> compound rule, errors passed through
#   macos      PKeyMacKeychainBackend over PKeyApple and the fake native: the login keychain is
#              asked for, OSStatus failures named
#   linux      PKeySecretServiceBackend over tests/support/fake_secret_tool.sh (editor on macOS
#              and Linux): stdin for the secret, exit 1 = absent, stderr = failure
#   real       PKEY_KEYRING_TESTS=1 only (the CI keyring job): the contract and the migration
#              against this OS's real keyring through the real backend. Linux may record an N/A
#              when no Secret Service is reachable; macOS and Windows may not.

const PRODUCT := "diceroll"


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_contract(t)
	_windows(t)
	_macos(t)
	_linux(t)
	_real(t)
	return true


static func _root(tag: String) -> String:
	return "user://pkey_test_keyring_%s_%d" % [tag, Time.get_ticks_usec()]


static func _store(kr: PKeyKeyringBackend, root: String, errors: Array) -> PKeyKeyringStore:
	var s := PKeyKeyringStore.new(PRODUCT, kr, root)
	s.failed.connect(func(e: Dictionary) -> void: errors.append(e))
	return s


func _contract(t: PKeyTestContext) -> void:
	var kr := PKeyFakeKeyring.new()
	var errors := []
	var root := _root("c")
	var s := _store(kr, root, errors)
	var token_path := root.path_join(PRODUCT).path_join("token")
	t.check("contract: the service is pkey:<product> and the account device-token (UK-40)", s.service == "pkey:diceroll" and PKeyKeyringStore.ACCOUNT == "device-token")
	t.check("contract: an empty keyring has no token", s.get_token() == "" and errors.is_empty())
	t.check("contract: a token write lands in the keyring, verified by a read-back", s.set_token("pkeyt_one") and kr.entries.get("pkey:diceroll/device-token") == "pkeyt_one" \
			and kr.calls.slice(-2) == ["set pkey:diceroll/device-token", "get pkey:diceroll/device-token"])
	t.check("contract: no token file is written when the keyring holds the token", not FileAccess.file_exists(token_path))
	t.check("contract: the token reads back", s.get_token() == "pkeyt_one")
	t.check("contract: status is keyring", s.status() == {"backend": "keyring"} and errors.is_empty())
	var id := s.get_device_id()
	t.check("contract: the device id is the file store's, stable", PKeyDeviceId.is_well_formed(id) and s.has_device_id() and FileAccess.file_exists(root.path_join(PRODUCT).path_join("device")) \
			and PKeyKeyringStore.new(PRODUCT, kr, root).get_device_id() == id)
	t.check("contract: the cache is the file store's", s.write_cache({"v": 3, "x": 1}) and s.read_cache() is Dictionary and s.read_cache().get("x") == 1.0 and s.clear_cache() and s.read_cache() == null)
	t.check("contract: clear removes the keyring entry", s.clear_token() and not kr.entries.has("pkey:diceroll/device-token") and s.get_token() == "")

	# An unverifiable write keeps the token in the file, deletes the entry and is surfaced.
	kr.lie = true
	errors.clear()
	t.check("contract: an unverifiable write keeps the token in the 0600 file", s.set_token("pkeyt_two") and FileAccess.get_file_as_string(token_path) == "pkeyt_two")
	t.check("contract: the fallback is surfaced (failed), not swallowed", errors.size() == 1 and str(errors[0]["message"]).contains("kept in the 0600 file") \
			and str(errors[0]["path"]) == "fake:pkey:diceroll/device-token")
	t.check("contract: the unverified keyring entry is deleted", not kr.entries.has("pkey:diceroll/device-token"))
	var st := s.status()
	t.check("contract: status says the file holds the token (keyring-error)", st.get("backend") == "file" and st.get("degraded", {}).get("reason") == "keyring-error")
	kr.lie = false
	kr.entries["pkey:diceroll/device-token"] = "pkeyt_stale"
	kr.fail_set = true
	t.check("contract: reads are file-first, so a stale keyring entry never shadows the file token", s.get_token() == "pkeyt_two")
	kr.fail_set = false
	errors.clear()
	t.check("contract: a failed move is not retried on every read", s.get_token() == "pkeyt_two" and errors.is_empty())
	t.check("contract: the next verified write moves the token and removes the file", s.set_token("pkeyt_three") and not FileAccess.file_exists(token_path) \
			and kr.entries.get("pkey:diceroll/device-token") == "pkeyt_three" and s.status() == {"backend": "keyring"})

	# A failing read or delete is surfaced.
	kr.fail_get = true
	errors.clear()
	t.check("contract: a failed keyring read answers no token and is surfaced", s.get_token() == "" and errors.size() == 1 and str(errors[0]["message"]).contains("fake read failure"))
	t.check("contract: status reports keyring-error while the keyring cannot be read", s.status().get("degraded", {}).get("reason") == "keyring-error")
	kr.fail_get = false
	kr.fail_delete = true
	errors.clear()
	t.check("contract: a failed delete is surfaced and clear answers false", not s.clear_token() and errors.size() == 1)
	kr.fail_delete = false
	s.clear_token()

	# Migration: an earlier build's file token moves into the keyring on the first read.
	var root2 := _root("m")
	var legacy := PKeyFileStore.new(PRODUCT, root2)
	legacy.set_token("pkeyt_legacy")
	var legacy_id := legacy.get_device_id()
	var kr2 := PKeyFakeKeyring.new()
	var errors2 := []
	var m := _store(kr2, root2, errors2)
	t.check("migration: the file-store token is read", m.get_token() == "pkeyt_legacy")
	t.check("migration: it moved into the keyring and its file is gone", kr2.entries.get("pkey:diceroll/device-token") == "pkeyt_legacy" \
			and not FileAccess.file_exists(root2.path_join(PRODUCT).path_join("token")) and errors2.is_empty())
	t.check("migration: the device id stays the file store's", m.get_device_id() == legacy_id)
	t.check("migration: status is keyring afterwards", m.status() == {"backend": "keyring"})
	var root3 := _root("mf")
	PKeyFileStore.new(PRODUCT, root3).set_token("pkeyt_stuck")
	var kr3 := PKeyFakeKeyring.new()
	kr3.fail_set = true
	var errors3 := []
	var mf := _store(kr3, root3, errors3)
	t.check("migration: a move that fails is surfaced once and the file token kept", mf.get_token() == "pkeyt_stuck" and mf.get_token() == "pkeyt_stuck" \
			and errors3.size() == 1 and str(errors3[0]["message"]).contains("stays in the 0600 file") and FileAccess.file_exists(root3.path_join(PRODUCT).path_join("token")))

	# No keyring here: the file store, with the reason recorded and nothing surfaced.
	var kr4 := PKeyFakeKeyring.new()
	kr4.why = "the fake GDExtension is not in this build"
	var errors4 := []
	var root4 := _root("u")
	var u := _store(kr4, root4, errors4)
	t.check("unavailable: the token lives in the 0600 file", u.set_token("pkeyt_file") and u.get_token() == "pkeyt_file" \
			and FileAccess.get_file_as_string(root4.path_join(PRODUCT).path_join("token")) == "pkeyt_file" and kr4.calls.is_empty())
	t.check("unavailable: status is file with keyring-unavailable and the reason", u.status() == {"backend": "file", "degraded": {"reason": "keyring-unavailable", "detail": "the fake GDExtension is not in this build"}})
	t.check("unavailable: nothing is surfaced as an error (it is the recorded state)", errors4.is_empty() and u.clear_token() and u.get_token() == "")

	# Selection.
	var p := PKeyHeaders.platform()
	var desktop: bool = p in ["macos", "windows", "linux"]
	var saved := OS.get_environment(PKeyKeyringStore.ENV_SWITCH)
	OS.set_environment(PKeyKeyringStore.ENV_SWITCH, "1")
	var pref := PKeyKeychainStore.preferred(PRODUCT, _root("p"))
	t.check("preferred: the keyring store on the desktops, the file store elsewhere", (pref is PKeyKeyringStore) if desktop else (pref is PKeyFileStore))
	if desktop:
		var backend_class: String = {"macos": "PKeyMacKeychainBackend", "windows": "PKeyWinCredBackend", "linux": "PKeySecretServiceBackend"}[p]
		t.check("preferred: the backend is this OS's (%s)" % backend_class, (pref as PKeyKeyringStore).backend.get_script().get_global_name() == backend_class)
		OS.set_environment(PKeyKeyringStore.ENV_SWITCH, "0")
		var off := PKeyKeychainStore.preferred(PRODUCT, _root("p0")) as PKeyKeyringStore
		t.check("preferred: PKEY_DESKTOP_KEYRING=0 keeps the file store and says why", off != null and off.keyring_unavailable().contains("PKEY_DESKTOP_KEYRING=0") \
				and off.status().get("degraded", {}).get("reason") == "keyring-unavailable")
		t.info("preferred: this run's backend says %s" % ("available" if (pref as PKeyKeyringStore).keyring_unavailable() == "" else "unavailable: " + (pref as PKeyKeyringStore).keyring_unavailable()))
	OS.set_environment(PKeyKeyringStore.ENV_SWITCH, saved)
	t.check("preferred: off the desktops the base backend is never usable", PKeyKeyringBackend.for_platform("web").unavailable() != "" and PKeyKeyringBackend.for_platform("ios").get_secret("s", "a")["ok"] == false)


## A stand-in for PKeyWinCredentialNative: targets -> {user, value}.
class _FakeCred:
	extends RefCounted
	var creds := {}
	var fail := ""
	var log: Array[String] = []

	func read(target: String) -> Dictionary:
		log.append("read " + target)
		if fail == "read":
			return {"ok": false, "error": "CredReadW failed (Win32 error 5)", "win32": 5}
		if not creds.has(target):
			return {"ok": true, "found": false}
		return {"ok": true, "found": true, "user": creds[target]["user"], "value": creds[target]["value"]}

	func write(target: String, user: String, secret: String) -> Dictionary:
		log.append("write " + target)
		if fail == "write":
			return {"ok": false, "error": "CredWriteW failed (Win32 error 1312)", "win32": 1312}
		creds[target] = {"user": user, "value": secret}
		return {"ok": true}

	func remove(target: String) -> Dictionary:
		log.append("remove " + target)
		creds.erase(target)
		return {"ok": true}


func _windows(t: PKeyTestContext) -> void:
	var off := PKeyWinCredBackend.new(null, "linux")
	t.check("windows: off Windows the backend is unavailable (runtime)", off.unavailable().contains("runs on Windows") and not off.get_secret("s", "a")["ok"])
	var missing := PKeyWinCredBackend.new(null, "windows")
	t.check("windows: without pkey_win.dll it says so", ClassDB.class_exists(PKeyWinCredBackend.NATIVE_CLASS) or missing.unavailable().contains("pkey_win.dll"))
	var fake := _FakeCred.new()
	var w := PKeyWinCredBackend.new(fake, "windows")
	t.check("windows: usable over the native class", w.unavailable() == "" and w.id() == "credential-manager")
	t.check("windows: absent is a null value", w.get_secret("pkey:diceroll", "device-token") == {"ok": true, "value": null})
	t.check("windows: the target is the service, the user name the account", w.set_secret("pkey:diceroll", "device-token", "pkeyt_w")["ok"] \
			and fake.creds.get("pkey:diceroll") == {"user": "device-token", "value": "pkeyt_w"})
	t.check("windows: it reads back", w.get_secret("pkey:diceroll", "device-token") == {"ok": true, "value": "pkeyt_w"})
	fake.creds["pkey:other"] = {"user": "someone", "value": "theirs"}
	t.check("windows: a service held under another user name gets the <user>@<service> target", w.set_secret("pkey:other", "device-token", "mine")["ok"] \
			and fake.creds.get("device-token@pkey:other", {}).get("value") == "mine" and fake.creds["pkey:other"]["value"] == "theirs")
	t.check("windows: the compound target reads back", w.get_secret("pkey:other", "device-token") == {"ok": true, "value": "mine"})
	t.check("windows: delete removes only the account's credential", w.delete_secret("pkey:other", "device-token")["ok"] \
			and not fake.creds.has("device-token@pkey:other") and fake.creds.has("pkey:other"))
	t.check("windows: deleting an absent credential is success", w.delete_secret("pkey:none", "device-token") == {"ok": true})
	fake.fail = "write"
	var r := w.set_secret("pkey:diceroll", "device-token", "x")
	t.check("windows: a failed write passes the Win32 error through", not r["ok"] and str(r["error"]).contains("1312"))
	fake.fail = "read"
	r = w.get_secret("pkey:diceroll", "device-token")
	t.check("windows: a failed read is an error, not an absent token", not r["ok"] and str(r["error"]).contains("Win32 error 5"))


func _macos(t: PKeyTestContext) -> void:
	var nat := PKeyFakeAppleNative.new()
	var apple := PKeyApple.new()
	apple.platform = "macos"
	apple.native = nat
	var m := PKeyMacKeychainBackend.new(apple)
	t.check("macos: usable over PolarisKeyApple on macOS", m.unavailable() == "" and m.id() == "keychain")
	t.check("macos: absent is a null value", m.get_secret("pkey:diceroll", "device-token") == {"ok": true, "value": null})
	t.check("macos: a write is a Keychain item of product diceroll, account device-token", m.set_secret("pkey:diceroll", "device-token", "pkeyt_m")["ok"] \
			and nat.keychain.get("diceroll/device-token") == "pkeyt_m")
	t.check("macos: it reads back and deletes", m.get_secret("pkey:diceroll", "device-token") == {"ok": true, "value": "pkeyt_m"} \
			and m.delete_secret("pkey:diceroll", "device-token")["ok"] and not nat.keychain.has("diceroll/device-token"))
	t.check("macos: every call asks for the login keychain", not nat.keychain_flavors.is_empty() and nat.keychain_flavors.all(func(f): return f == "login"))
	t.check("macos: a service that is not pkey:<product> is refused", not m.get_secret("other", "device-token")["ok"])
	nat.keychain["__fail__"] = true
	var r := m.set_secret("pkey:diceroll", "device-token", "x")
	t.check("macos: a failed write names the OSStatus", not r["ok"] and str(r["error"]).contains("-34018"))
	nat.keychain.erase("__fail__")
	var ios_only := PKeyApple.new()
	ios_only.platform = "windows"
	ios_only.native_class = "PolarisKeyAppleMissingForTests"
	t.check("macos: off macOS and iOS the backend is unavailable", PKeyMacKeychainBackend.new(ios_only).unavailable() != "")
	var mac_missing := PKeyApple.new()
	mac_missing.platform = "macos"
	mac_missing.native_class = "PolarisKeyAppleMissingForTests"
	t.check("macos: without libpkey_apple.dylib it says so", PKeyMacKeychainBackend.new(mac_missing).unavailable().contains("libpkey_apple.dylib"))
	t.check("macos: with no facade and no class the default backend says so", ClassDB.class_exists(PKeyApple.NATIVE_CLASS) or PKeyMacKeychainBackend.new().unavailable().contains("libpkey_apple.dylib"))
	apple.free()
	ios_only.free()
	mac_missing.free()


func _linux(t: PKeyTestContext) -> void:
	var off := PKeySecretServiceBackend.new("", "windows")
	t.check("linux: off Linux the backend is unavailable", off.unavailable().contains("runs on Linux"))
	var no_tool := PKeySecretServiceBackend.new("/nonexistent/secret-tool", "linux")
	t.check("linux: without secret-tool it says so", no_tool.unavailable().contains("secret-tool"))
	if not (OS.has_feature("editor") and (OS.has_feature("macos") or OS.has_feature("linuxbsd"))):
		t.info("linux: the fake secret-tool runs from the editor on macOS and Linux only; skipped here")
		return
	var script := ProjectSettings.globalize_path("res://tests/support/fake_secret_tool.sh")
	var dir := ProjectSettings.globalize_path(_root("st"))
	var saved_bus := OS.get_environment("DBUS_SESSION_BUS_ADDRESS")
	OS.set_environment("DBUS_SESSION_BUS_ADDRESS", "unix:path=/fake/bus")
	OS.set_environment("PKEY_FAKE_SECRET_DIR", dir)
	var b := PKeySecretServiceBackend.new(script, "linux")
	if not PKeySecretServiceBackend.engine_pipes_stdin():
		# Godot 4.4 (the floor): no stdin through OS.execute_with_pipe, so the backend steps aside
		# and the store keeps its 0600 file (the fake-tool checks below need 4.5 or later).
		t.check("linux: before Godot 4.5 the backend says it needs 4.5", b.unavailable().contains("Godot 4.5"), b.unavailable())
		var kr_floor := PKeyKeyringStore.new(PRODUCT, b, _root("st44"))
		t.check("linux: before Godot 4.5 the store keeps the 0600 file and says why", kr_floor.set_token("pkeyt_ss") and kr_floor.get_token() == "pkeyt_ss" \
				and kr_floor.status().get("backend") == "file" and kr_floor.status().get("degraded", {}).get("reason") == "keyring-unavailable" \
				and kr_floor.clear_token(), str(kr_floor.status()))
		OS.set_environment("DBUS_SESSION_BUS_ADDRESS", saved_bus)
		OS.set_environment("PKEY_FAKE_SECRET_DIR", "")
		return
	t.check("linux: usable with secret-tool and a session bus", b.unavailable() == "" and b.id() == "secret-service")
	t.check("linux: absent (exit 1, silent) is a null value", b.get_secret("pkey:diceroll", "device-token") == {"ok": true, "value": null})
	var secret := "pkeyt_" + "a".repeat(40) + " with spaces\tand tabs"
	t.check("linux: store reads the secret from stdin", b.set_secret("pkey:diceroll", "device-token", secret)["ok"])
	t.check("linux: lookup returns it byte for byte", b.get_secret("pkey:diceroll", "device-token") == {"ok": true, "value": secret})
	t.check("linux: another account is another item", b.get_secret("pkey:diceroll", "other") == {"ok": true, "value": null})
	t.check("linux: clear removes it, and clearing again is success", b.delete_secret("pkey:diceroll", "device-token")["ok"] and b.delete_secret("pkey:diceroll", "device-token")["ok"] \
			and b.get_secret("pkey:diceroll", "device-token")["value"] == null)
	var kr_store := PKeyKeyringStore.new(PRODUCT, b, _root("sts"))
	t.check("linux: the store's contract holds over secret-tool", kr_store.set_token("pkeyt_ss") and kr_store.get_token() == "pkeyt_ss" and kr_store.status() == {"backend": "keyring"} and kr_store.clear_token())
	OS.set_environment("PKEY_FAKE_SECRET_FAIL", "1")
	var r := b.get_secret("pkey:diceroll", "device-token")
	t.check("linux: a message on stderr is a failure, not an absent item", not r["ok"] and str(r["error"]).contains("collection is locked"))
	t.check("linux: a failed store is reported", not b.set_secret("pkey:diceroll", "device-token", "x")["ok"])
	OS.set_environment("PKEY_FAKE_SECRET_FAIL", "")
	var slow := PKeySecretServiceBackend.new("/bin/sleep", "linux")
	slow.timeout_ms = 200
	var res := slow._run(["5"])
	t.check("linux: a call past its deadline is killed and reported", res["timed_out"] and PKeySecretServiceBackend._why("lookup", res).contains("did not finish"))
	OS.set_environment("DBUS_SESSION_BUS_ADDRESS", saved_bus)
	OS.set_environment("PKEY_FAKE_SECRET_DIR", "")


## The CI keyring job (PKEY_KEYRING_TESTS=1): the store against this OS's real keyring.
func _real(t: PKeyTestContext) -> void:
	if OS.get_environment("PKEY_KEYRING_TESTS") != "1":
		t.info("real: PKEY_KEYRING_TESTS is not 1; the real-keyring contract runs in the CI keyring job")
		return
	var p := PKeyHeaders.platform()
	var backend := PKeyKeyringBackend.for_platform()
	var why := backend.unavailable()
	if why != "":
		if p == "linux":
			t.info("real: N/A on linux: %s" % why)
			t.check("real: N/A recorded (no Secret Service reachable)", true)
			print("PKEY-KEYRING N/A %s %s" % [p, why])
			return
		t.check("real: the %s keyring backend is available (%s)" % [p, why], false)
		return
	# A product nobody else uses, removed at the end.
	var product := "pkey-ci-%d-%d" % [int(Time.get_unix_time_from_system()), randi() % 100000]
	var service := PKeyKeyringStore.SERVICE_PREFIX + product
	var errors := []
	var root := _root("real")
	var s := PKeyKeyringStore.new(product, backend, root)
	s.failed.connect(func(e: Dictionary) -> void: errors.append(e))
	var token := "pkeyt_real_" + Crypto.new().generate_random_bytes(12).hex_encode()
	t.check("real: %s: a verified write" % backend.id(), s.set_token(token) and errors.is_empty())
	t.check("real: %s: the raw entry is pkey:<product> / device-token" % backend.id(), backend.get_secret(service, "device-token").get("value") == token)
	t.check("real: %s: no token file" % backend.id(), not FileAccess.file_exists(root.path_join(product).path_join("token")))
	t.check("real: %s: a new store instance reads it" % backend.id(), PKeyKeyringStore.new(product, backend, root).get_token() == token)
	t.check("real: %s: status is keyring" % backend.id(), s.status() == {"backend": "keyring"})
	t.check("real: %s: an overwrite verifies" % backend.id(), s.set_token(token + "_2") and s.get_token() == token + "_2")
	t.check("real: %s: clear removes the entry" % backend.id(), s.clear_token() and backend.get_secret(service, "device-token") == {"ok": true, "value": null})
	# Migration from the file store of an earlier build.
	var legacy := PKeyFileStore.new(product, root)
	legacy.set_token(token + "_legacy")
	var m := PKeyKeyringStore.new(product, backend, root)
	m.failed.connect(func(e: Dictionary) -> void: errors.append(e))
	t.check("real: %s: migration reads the file token" % backend.id(), m.get_token() == token + "_legacy")
	t.check("real: %s: migration moved it into the keyring and removed the file" % backend.id(), backend.get_secret(service, "device-token").get("value") == token + "_legacy" \
			and not FileAccess.file_exists(root.path_join(product).path_join("token")) and m.status() == {"backend": "keyring"})
	t.check("real: %s: no failure was surfaced" % backend.id(), errors.is_empty())
	for e in errors:
		t.info("real: surfaced: %s %s: %s" % [e.get("op"), e.get("path"), e.get("message")])
	m.clear_token()
	t.check("real: %s: cleaned up" % backend.id(), backend.get_secret(service, "device-token") == {"ok": true, "value": null})
	print("PKEY-KEYRING REAL %s %s" % [p, backend.id()])
