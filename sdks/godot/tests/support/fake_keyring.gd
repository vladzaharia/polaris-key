class_name PKeyFakeKeyring
extends PKeyKeyringBackend
## An in-memory keyring for the desktop keyring store's contract (suite_keyring). Switches:
##
##   why          unavailable()'s answer ("" = usable)
##   fail_get     every read fails
##   fail_set     every write fails
##   fail_delete  every delete fails
##   lie          writes "succeed" but store something else (an unverifiable write)

var entries := {}
var why := ""
var fail_get := false
var fail_set := false
var fail_delete := false
var lie := false
var calls := []


func id() -> String:
	return "fake"


func unavailable() -> String:
	return why


func get_secret(service: String, account: String) -> Dictionary:
	calls.append("get %s/%s" % [service, account])
	if fail_get:
		return {"ok": false, "error": "fake read failure"}
	return {"ok": true, "value": entries.get("%s/%s" % [service, account])}


func set_secret(service: String, account: String, secret: String) -> Dictionary:
	calls.append("set %s/%s" % [service, account])
	if fail_set:
		return {"ok": false, "error": "fake write failure"}
	entries["%s/%s" % [service, account]] = ("not-" + secret) if lie else secret
	return {"ok": true}


func delete_secret(service: String, account: String) -> Dictionary:
	calls.append("delete %s/%s" % [service, account])
	if fail_delete:
		return {"ok": false, "error": "fake delete failure"}
	entries.erase("%s/%s" % [service, account])
	return {"ok": true}
