class_name PKeyFakeUpdaterEnv
extends PKeyUpdaterEnv
## A recording PKeyUpdaterEnv for the updater suite: an install anywhere (its executable in a
## scratch `user://` directory, or a Windows path that never touches the disk), any environment,
## and every side effect recorded instead of performed — links opened, restarts, relaunches,
## AppImageUpdate runs, page reloads. Never inert.

var os := "linux"
var exe := ""
var vars := {}
## Paths reported as existing without being on disk (`/.flatpak-info`, `…/Update.exe`).
var files := {}
## name -> path for find_program.
var programs := {}
## Engine singletons standing in for P5-07's plugins.
var singletons := {}
var exec_code := 0

var opened: Array = []
var restarts := 0
var relaunched: Array = []
var executed: Array = []
var reloads := 0


func platform() -> String:
	return os


func executable_path() -> String:
	return exe


func env(name: String) -> String:
	return String(vars.get(name, ""))


func file_exists(path: String) -> bool:
	return files.has(path) or FileAccess.file_exists(path)


func has_feature(tag: String) -> bool:
	return tag == os


func inert() -> bool:
	return false


func shell_open(url: String) -> int:
	opened.append(url)
	return OK


func restart() -> void:
	restarts += 1


func relaunch(path: String) -> int:
	relaunched.append(path)
	return 4242


func quit() -> void:
	pass


func execute(path: String, args: PackedStringArray) -> int:
	executed.append([path, args])
	return exec_code


func find_program(name: String) -> String:
	return String(programs.get(name, ""))


func reload_web() -> bool:
	reloads += 1
	return os == "web"


func native_singleton(name: String) -> Object:
	return singletons.get(name)
