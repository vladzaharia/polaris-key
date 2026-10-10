class_name PKeyKeyringStore
extends PKeyStore
## The desktop store (SP-27): the `pkeyt_` token in the OS keyring (macOS login keychain, Windows
## Credential Manager, Linux Secret Service; PKeyKeyringBackend), and the device id and the
## verified cache in the 0600 file store under `user://pkey/<product>/` (neither is a secret: the
## cache holds signed artifacts only and is re-verified at every load).
##
## It follows UK-40's Kotlin `KeyringStore`, itself a port of Python's (P1b-09), so the three
## desktop SDKs keep one product's token under one name and by one rule:
##
##   - service `pkey:<product>`, account `device-token`;
##   - every token write is VERIFIED (set, then read back). A write that cannot be verified keeps
##     the token in the 0600 token file instead and deletes the keyring entry (best effort);
##   - THE INVARIANT: the token file exists only when the last token write fell back (or the file
##     store of an earlier build left it), so reads are file-first and a stale keyring entry never
##     shadows a newer file token;
##   - migration: a file-store token moves into the keyring on the first read that can verify the
##     move; the file is then removed.
##
## Never a silent downgrade: every keyring failure (a read, a write that does not verify, a delete,
## a token file left behind) sets `last_error` and emits `failed`, which PKeyCore forwards as
## `store_error`, and status() says where the token is:
##
##   {backend: keyring}                                            the keyring holds it
##   {backend: file, degraded: {reason: keyring-unavailable, …}}   no keyring piece here (the
##                                                                 GDExtension or secret-tool is
##                                                                 missing, or PKEY_DESKTOP_KEYRING=0)
##   {backend: file, degraded: {reason: keyring-error, …}}         the keyring fails, or the last
##                                                                 write fell back to the file
##
## PKeyCore picks this store by default on macOS, Windows and Linux (preferred()); pass
## PKeyOptions.store to override. PKEY_DESKTOP_KEYRING=0 in the environment keeps the file store
## (status() still says why), for test runs that must not touch the developer's keyring; it is
## honoured only in DEBUG builds (env_switch_honoured), never in a shipped release build.

const SERVICE_PREFIX := "pkey:"
const ACCOUNT := "device-token"
## The environment switch that keeps a desktop build on the file store.
const ENV_SWITCH := "PKEY_DESKTOP_KEYRING"

var product: String
var service: String
var backend: PKeyKeyringBackend
var files: PKeyFileStore
## Why the keyring is off by configuration ("" when it is not): PKEY_DESKTOP_KEYRING=0.
var disabled := ""
## A file-token migration that failed this session is not retried on every read (set_token and
## clear_token try again); its failure was surfaced once.
var _migration_failed := false


func _init(p_product: String, p_backend: PKeyKeyringBackend = null, root := "user://pkey") -> void:
	product = p_product
	service = SERVICE_PREFIX + p_product
	backend = p_backend if p_backend != null else PKeyKeyringBackend.for_platform()
	files = PKeyFileStore.new(p_product, root)
	# A weak capture: `files` holds this connection and this holds `files`, and a lambda holding
	# `self` would keep both alive past the SDK's exit.
	var me: WeakRef = weakref(self)
	files.failed.connect(func(err: Dictionary) -> void:
		var store := me.get_ref() as PKeyKeyringStore
		if store != null:
			store.last_error = err
			store.failed.emit(err))


## The store PKeyCore uses when PKeyOptions.store is null, after the iOS Keychain and Android
## Keystore stores: this one on macOS, Windows and Linux (with the OS backend, which may be
## unavailable: then it is the file store with a recorded reason), else the file store (web).
static func preferred(p_product: String, root := "user://pkey") -> PKeyStore:
	match PKeyHeaders.platform():
		PKeyConstants.Platform.MACOS, PKeyConstants.Platform.WINDOWS, PKeyConstants.Platform.LINUX:
			var store := PKeyKeyringStore.new(p_product, null, root)
			if env_switch_honoured() and OS.get_environment(ENV_SWITCH) == "0":
				store.disabled = "the OS keyring is switched off (%s=0)" % ENV_SWITCH
			return store
	return PKeyFileStore.new(p_product, root)


## Whether the environment switch applies: only in debug builds (the editor, debug exports). A
## shipped (release) build ignores it, so a process environment cannot push a player's token out of
## the OS keyring into the 0600 file. Tests replace the answer with `debug_build_source`.
static var debug_build_source: Callable


static func env_switch_honoured() -> bool:
	if debug_build_source.is_valid():
		return bool(debug_build_source.call())
	return OS.is_debug_build()


## Why the OS keyring is not used here, or "" when it is. Reads nothing from the keyring.
func keyring_unavailable() -> String:
	return disabled if disabled != "" else backend.unavailable()


func get_token() -> String:
	var from_file := files.get_token()
	if from_file != "":
		# An earlier file-store build, or a write that fell back: move it when the move verifies.
		if not _migration_failed and keyring_unavailable() == "":
			var why := _write_verified(from_file)
			if why == "":
				_remove_token_file("the token was moved into the keyring but its file could not be removed; reads stay file-first")
			else:
				_migration_failed = true
				_keyring_fail("migrate", "the file token could not be moved into the keyring (%s); it stays in the 0600 file" % why)
		return from_file
	if keyring_unavailable() != "":
		return ""
	var r := backend.get_secret(service, ACCOUNT)
	if not r.get("ok", false):
		_keyring_fail("read", "the keyring read failed (%s)" % r.get("error", "unknown error"))
		return ""
	var v = r.get("value")
	return v if v is String else ""


func set_token(token: String) -> bool:
	_migration_failed = false
	var usable := keyring_unavailable() == ""
	var why := _write_verified(token) if usable else ""
	if usable and why == "":
		if not _remove_token_file("the token is in the keyring but the old token file could not be removed; it is rewritten with the new token so no older token survives"):
			# A surviving file must never hold an OLDER token than the keyring (reads are file-first).
			return files.set_token(token)
		return true
	# Losing the token silently is worse than an error: the file store's failure is surfaced too.
	var kept := files.set_token(token)
	if usable:
		backend.delete_secret(service, ACCOUNT)
		_keyring_fail("write", "the keyring write could not be verified (%s); the token was kept in the 0600 file" % why)
	return kept


func clear_token() -> bool:
	_migration_failed = false
	var ok := true
	if keyring_unavailable() == "":
		var r := backend.delete_secret(service, ACCOUNT)
		if not r.get("ok", false):
			ok = false
			_keyring_fail("remove", "the keyring entry could not be removed (%s)" % r.get("error", "unknown error"))
	return files.clear_token() and ok


func has_device_id() -> bool:
	return files.has_device_id()


func get_device_id() -> String:
	return files.get_device_id()


func bindable() -> bool:
	return true


func set_device_id(id: String) -> bool:
	return files.set_device_id(id)


func read_cache() -> Variant:
	return files.read_cache()


func write_cache(record: Dictionary) -> bool:
	return files.write_cache(record)


func clear_cache() -> bool:
	return files.clear_cache()


## Where the token is (see the class comment). Probes the keyring with one read, as Kotlin's and
## Python's status() do; it never emits `failed`.
func status() -> Dictionary:
	var why := keyring_unavailable()
	if why != "":
		return {"backend": "file", "degraded": {"reason": "keyring-unavailable", "detail": why}}
	var r := backend.get_secret(service, ACCOUNT)
	if not r.get("ok", false):
		return {"backend": "file", "degraded": {"reason": "keyring-error", "detail": "the %s read failed (%s)" % [backend.id(), r.get("error", "unknown error")]}}
	if FileAccess.file_exists(files.path_of(PKeyFileStore.TOKEN_FILE)):
		return {"backend": "file", "degraded": {"reason": "keyring-error", "detail": "the token is in the 0600 file (an earlier write fell back, or an earlier build left it); the next verified write moves it to the keyring"}}
	return {"backend": "keyring"}


func _where() -> String:
	return "%s:%s/%s" % [backend.id(), service, ACCOUNT]


## Set, then read back: "" when the keyring now holds exactly `token`, else why not.
func _write_verified(token: String) -> String:
	var w := backend.set_secret(service, ACCOUNT, token)
	if not w.get("ok", false):
		return str(w.get("error", "the write failed"))
	var r := backend.get_secret(service, ACCOUNT)
	if not r.get("ok", false):
		return "the read-back failed: %s" % r.get("error", "unknown error")
	if r.get("value") != token:
		return "the read-back did not return the token just written"
	return ""


func _remove_token_file(message: String) -> bool:
	var path := files.path_of(PKeyFileStore.TOKEN_FILE)
	if not FileAccess.file_exists(path):
		return true
	if files.clear_token():
		return true
	_fail("remove", path, ERR_FILE_CANT_WRITE, message)
	return false


func _keyring_fail(op: String, message: String) -> void:
	_fail(op, _where(), ERR_UNAVAILABLE, message)
