class_name PKeyPlayTestingAdapter
extends PKeyPlayAdapter
## Play testing tracks: Play installs these builds too, so In-App Updates work as on `play`
## (PKeyPlayAdapter); otherwise the testing opt-in page or the listing.


func _init() -> void:
	kind = "play-testing"
	action_key = "update_store"
