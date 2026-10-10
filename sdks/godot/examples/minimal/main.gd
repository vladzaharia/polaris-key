extends Control
## The Polaris Key minimal sample: boot, gate, settings and commerce, in one script.
##
## 1. `PolarisKey.boot()` reads res://polaris_key.tres (the setup dock writes it), syncs, gates on
##    the licence (the activation and sign-in card appear on their own), checks for an update and
##    fetches packs, on the PKeyBoot screen. `await` returns at READY: a stop keeps its card and
##    Try again on screen, and the await waits through the retries.
## 2. The game then reads its licence (`is_entitled`), its config (`get_value`) and offers the
##    kit's settings panel and a store purchase of one licence flag.
##
## Replace SKINS_FLAG with a flag your product maps to a store product, and "difficulty" with a
## key from your config catalog.

const SKINS_FLAG := "extras.diceSkins"
const SKINS_ENTITLEMENT := "dice-skins"
const DIFFICULTY_KEY := "difficulty"

var _status: Label
var _menu: VBoxContainer
var _buy: Button


func _ready() -> void:
	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_menu = VBoxContainer.new()
	_menu.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	_menu.add_child(_status)
	add_child(_menu)
	_menu.hide()
	# Boot: everything before the game. BLOCKED, OFFLINE and ERROR stay on the PKeyBoot card with
	# Try again; the await returns once the player is through.
	await PolarisKey.boot({allow_offline = true})
	_menu.show()
	_add_button("Settings", _open_settings)
	_buy = _add_button("Buy dice skins", _purchase)
	_add_button("Restore purchases", _restore)
	_render()
	PolarisKey.sync_finished.connect(func(_r): _render())


func _add_button(text: String, cb: Callable) -> Button:
	var b := Button.new()
	b.text = text
	b.pressed.connect(cb)
	_menu.add_child(b)
	return b


## Gate: what this licence unlocks, read from the verified licence document.
func _render() -> void:
	var skins := PolarisKey.license.is_entitled(SKINS_ENTITLEMENT) or PolarisKey.commerce.is_unlocked(SKINS_FLAG)
	var difficulty = PolarisKey.config.get_value(DIFFICULTY_KEY)
	_status.text = "Dice skins: %s\nDifficulty: %s" % ["unlocked" if skins else "locked", str(difficulty)]
	_buy.disabled = skins


## Settings: the kit's panel lists every user-adjustable config key and persists the player's
## choices (user://pkey_settings.cfg). One line opens it over the game; Close, Escape or a pad's B
## closes it and gives the focus back.
func _open_settings() -> void:
	PKeySettingsPanel.open(self)


## Commerce: one call buys the flag in this build's store (App Store, Steam), claims it and syncs.
func _purchase() -> void:
	_show(await PolarisKey.commerce.purchase(SKINS_FLAG))


func _restore() -> void:
	_show(await PolarisKey.commerce.restore())


func _show(r: PKeyPurchaseResult) -> void:
	match r.kind:
		PKeyPurchaseResult.KIND_OK:
			_render()
		PKeyPurchaseResult.KIND_PENDING:
			_status.text = "Purchase pending: it unlocks when the store confirms it."
		PKeyPurchaseResult.KIND_CANCELLED:
			pass
		_:
			_status.text = PKeyUiCopy.shared().for_result(r)
