class_name PKeyFakeSteam
extends RefCounted
## A stand-in for GodotSteam's `Steam` singleton with the calls PKeyPackSteamTransport makes
## (getAppID, getAppInstallDir, isDLCInstalled, installDLC, run_callbacks with the dlc_installed
## signal, getAppBuildId, getCurrentBetaName, isSteamRunning), so the steam-depot transport runs
## headless. installDLC queues the install; the next run_callbacks finishes it (or never, when
## `install_hangs`).

signal dlc_installed(app_id: int)

var app_id := 480
var directory := ""
var running := true
var build := 1234567
var beta := "pkey-test"
## DLC app ids Steam has installed.
var installed_dlc := {}
var install_hangs := false
var calls: Array = []
var _pending: Array = []


func getAppID() -> int:
	return app_id


func getAppInstallDir(id: int) -> Dictionary:
	calls.append(["getAppInstallDir", id])
	return {"directory": directory, "install_size": 0}


func isSteamRunning() -> bool:
	return running


func isDLCInstalled(id: int) -> bool:
	return installed_dlc.has(id)


func installDLC(id: int) -> void:
	calls.append(["installDLC", id])
	_pending.append(id)


func run_callbacks() -> void:
	if install_hangs:
		return
	var done := _pending.duplicate()
	_pending.clear()
	for id in done:
		installed_dlc[id] = true
		dlc_installed.emit(id)


func getAppBuildId() -> int:
	return build


func getCurrentBetaName() -> Dictionary:
	return {"ret": true, "name": beta}
