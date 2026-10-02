class_name PKeyFdroidRepoAdapter
extends PKeyStoreAdapter
## An F-Droid repository: the feed carries no listing; the answer opens the repository page compiled into the game (PKeyOptions.update_page_url).


func _init() -> void:
	kind = "fdroid-repo"
	action_key = "update_store"
