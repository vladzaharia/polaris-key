class_name PKeyBootHost
extends RefCounted
## The work behind each boot stage, done with the SDK, reported as the one event the stage
## machine reads — exactly plans/P1-09.md §2.2 "What a host sends". PKeyBoot calls these when the
## machine enters a stage; each is a coroutine returning the event Dictionary. A test (or a game
## with its own pipeline) passes any object with the same methods as `host`.
##
##   shell(opts)     configure from `opts.options` or res://polaris_key.tres when PolarisKey is not
##                   configured yet (the build stamp is read there), then start(): the verified
##                   cache, offline. shell.done; `fail` only when that cannot run (a bad
##                   options file, a store that cannot be read)
##   guard()         guard.done ok until P3-10 owns slots and rollback
##   sync(force)     discovery (its failure does not count), then, with no token on a product
##                   without License whose registration policy is open, devices.register()
##                   first; then PolarisKey.sync(). sync.done: ok when everything counted was
##                   answered (200, 304, 401, 403, 429), offline when anything got no answer,
##                   error when an answer was unusable. A local-only build answers offline (it
##                   never asks). `fail` only when a store write failed during the pass
##   gate_status()   gate.status from PolarisKey.status()
##   decide()        decide.done optional when PolarisKey.update.decide() says the decision is one
##                   to show (or, without the signed decision, the v3 check found a newer
##                   version), otherwise none — also when the check failed or Update is off. Never
##                   required: no v4 decision stops play (plans/P3-01.md decision 1)
##   fetch(packs)    fetch.done ok with no installed packs until P4-08
##   mount()         mount.done after the first frame has been drawn (S-05 §4.1)
##
## `changed` fires when the licence state may have moved (an activation, a sign-in, a bundle
## import), so PKeyBoot sends gate.status again while the gate waits.

signal changed()

## The game's options file (the setup dock writes it), used when PolarisKey is not configured.
const OPTIONS_PATH := "res://polaris_key.tres"

## The PolarisKey node.
var sdk: Node
## The update answer DECIDE found to show, or null.
var update_result: PKeyResult = null
## Run discovery at the top of the sync stage.
var discover := true

var _store_errors := 0


func _init(p_sdk: Node) -> void:
	sdk = p_sdk
	if sdk != null and sdk.has_signal("state_changed"):
		sdk.state_changed.connect(func(_s): changed.emit())
		sdk.store_error.connect(func(_e): _store_errors += 1)


func shell(opts: Dictionary) -> Dictionary:
	if sdk == null:
		return _fail(PKeyErrors.NOT_CONFIGURED)
	if sdk.core == null:
		var o = opts.get("options")
		if o == null and ResourceLoader.exists(OPTIONS_PATH):
			o = load(OPTIONS_PATH)
		if not (o is PKeyOptions):
			return _fail(PKeyErrors.NOT_CONFIGURED)
		var c: PKeyResult = sdk.configure(o)
		if not c.ok:
			return _fail(c.code)
	if not sdk.core.started:
		var r: PKeyResult = await sdk.start()
		if not r.ok:
			return _fail(r.code)
	return {"type": "shell.done"}


func guard() -> Dictionary:
	return {"type": "guard.done", "result": "ok"}


func sync(force := false) -> Dictionary:
	var core: PKeyCore = sdk.core
	if core.local_only:
		return _sync("offline")
	var errors_before := _store_errors
	if discover:
		await sdk.discover()
	if not core.tokens.has_token() and registration_open(core):
		var reg: PKeyResult = await sdk.devices.register()
		if not reg.ok:
			var kind = reg.detail.get("kind") if reg.detail is Dictionary else ""
			return _sync("offline" if kind == "no-answer" else "error")
	var r: PKeySyncResult = await sdk.sync(force)
	if not r.ok:
		return _sync("offline") if r.code == PKeyErrors.LOCAL_ONLY else _fail(r.code)
	if _store_errors > errors_before:
		return _fail(PKeyErrors.STORE_FAILED)
	return _sync(r.classify())


func gate_status() -> Dictionary:
	return {"type": "gate.status", "status": String(sdk.status().get("status", "needs-activation"))}


func decide() -> Dictionary:
	update_result = null
	var core: PKeyCore = sdk.core
	if not core.enabled("update"):
		return _decided("none")
	var r: PKeyUpdateCheck = await sdk.update.decide()
	if r.ok:
		if r.boot == PKeyDecision.BOOT_OPTIONAL:
			update_result = r
			return _decided("optional")
		return _decided("none")
	if r.code == PKeyErrors.SERVICE_UNAVAILABLE or r.code == PKeyErrors.NOT_CONFIGURED:
		var v: PKeyVersionCheck = await sdk.update.check()
		if v.ok and v.update_available:
			update_result = v
			return _decided("optional")
	return _decided("none")


func fetch(_required: Array) -> Dictionary:
	return {"type": "fetch.done", "result": "ok", "installed": []}


func mount() -> Dictionary:
	var tree := Engine.get_main_loop() as SceneTree
	if tree != null:
		await tree.process_frame
	return {"type": "mount.done"}


## Whether a device with no token may get one without the player: a product without License
## whose registration policy is `open` (discovery's `core.registration` when this session has it,
## otherwise the WIRE-CONTRACT-V3 §6 default from the expected services).
static func registration_open(core: PKeyCore) -> bool:
	if core.enabled("license"):
		return false
	var m = core.discovery_manifest
	if m is Dictionary and m.get("core") is Dictionary and m["core"].get("registration") is String:
		return m["core"]["registration"] == "open"
	return not core.enabled("identity")


static func _sync(result: String) -> Dictionary:
	return {"type": "sync.done", "result": result}


static func _decided(decision: String) -> Dictionary:
	return {"type": "decide.done", "decision": decision}


static func _fail(code: StringName) -> Dictionary:
	return {"type": "fail", "code": String(code) if String(code) != "" else "unknown"}
