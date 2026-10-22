class_name PKeyPaywall
extends PKeyUiView
## An upsell for a tier the player has not unlocked (UI-KITS.md §4.1 Paywall; ui-core's
## `paywall_view` is the reference), as a card of its own: "Get more with <product> <tier>", what the
## tier includes, **Upgrade to <tier>** (the platform's store) or **Buy in your browser** (the
## product's page, https only), **Redeem a code** and **Restore purchases** where the game wires
## them. It never invents a checkout: where nothing is sold it says so and, with an https page,
## offers it. The words are catalog keys from the model's view (`PKeyPaywallController`).
##
## The game sets what it knows (`tier`, `includes`, `store_purchase`, `offers_url`…) and answers the
## signals; the scene sells nothing itself. States (the model's): loading, offers, purchasing,
## restore, purchased, not-available, and hidden when the License service is off.

## **Upgrade to <tier>** was chosen: the game starts the store purchase and sets `pending`.
signal purchase_requested()
## **Buy in your browser** was chosen (after the page, if any, was opened).
signal portal_requested()
## **Redeem a code** was chosen.
signal redeem_requested()
## **Restore purchases** was chosen.
signal restore_requested()
## **Done** after a purchase.
signal done()
## Escape or a pad's back button on a dismissable paywall.
signal dismissed()

## The tier on offer, as its name ("Pro").
@export var tier := ""
## What it includes, one line each.
@export var includes := PackedStringArray()
## Whether this build sells it (the store or the portal); false: "Purchases aren't available".
@export var offers_available := true
## The product's https page that sells it (the portal); never opened unless it is https.
@export var offers_url := ""
## A store purchase is the way to buy here (the game's store plugin answers `purchase_requested`).
@export var store_purchase := false
## Offer **Restore purchases** (a platform store).
@export var can_restore := false
## The purchase went through: **Done**.
@export var purchased := false
## "", "purchase" or "restore": a purchase or a restore is running.
@export var pending := ""
## The offers are loading.
@export var loading := false
## Dim the game behind it (a card over a running game) instead of replacing it with a page.
@export var modal := false

var model: Dictionary = {}

var _card: BoxContainer
var _right: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _body: Label
var _includes_head: Label
var _includes_body: Label
var _actions: BoxContainer
var _primary: Button
var _redeem: Button
var _restore: Button
var _hint_bar: PKeyHintBar


func _build() -> void:
	name = "PKeyPaywall"
	_card = columns(card_panel(), "Body")
	var text := vbox(_card, "Text", "PKeyStack")
	text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_right = vbox(_card, "Right", "PKeyStack")
	_right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_right.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_product = product_header(text, "Product")
	_product.card = true
	var words := vbox(text, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_body = label(words, "Message", "PKeyMuted")
	_includes_head = label(words, "IncludesHead", "PKeySection")
	_includes_body = label(words, "Includes", "PKeyMuted", true)
	loading_bar(text)
	_actions = actions_row(_right, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_primary = button(_actions, "Primary", _on_primary, "PKeyPrimary")
	_redeem = button(_actions, "Redeem", func() -> void: redeem_requested.emit(), "PKeyLink")
	_restore = button(_actions, "Restore", func() -> void: restore_requested.emit(), "PKeyLink")
	_hint_bar = hint_bar(_right, "HintBar", [{"action": PKeyInputGlyphs.CONFIRM, "copy": "hint_select"}, {"action": PKeyInputGlyphs.BACK, "copy": "hint_back"}])


func _bleeds() -> bool:
	return true


func _scrim_wanted() -> bool:
	return modal


func _guard_for_modal() -> bool:
	return modal and visible


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 2


func _screen_key() -> String:
	return "%s|%s" % [model.get("state", ""), modal]


## A landscape screen that holds both columns: the words on one side, the way to buy on the other.
func _side_by_side() -> bool:
	if phone_screen() or not is_landscape():
		return false
	return room_x() + 1.0 >= (role("card_width") - 2.0 * role("card_padding")) * 1.45


func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width_wide" if _side_by_side() else "card_width"), content_room().x))


func _render() -> void:
	model = PKeyPaywallController.view(PKeyPaywallController.input({
		"tier": tier, "store_purchase": store_purchase, "can_restore": can_restore, "available": offers_available,
		"url": offers_url, "purchased": purchased, "pending": pending, "loading": loading,
	}))
	var state := String(model.get("state", "hidden"))
	visible = state != "hidden"
	if not visible:
		return
	var args: Dictionary = (model.get("args", {}) as Dictionary).duplicate()
	args["product"] = PKeyUiTheme.isolate(String(PKeyUiTheme.product_identity()["name"]))
	args["tier"] = PKeyUiTheme.isolate(tier if tier != "" else String(PKeyUiTheme.product_identity()["name"]))
	var copy: Array = model.get("copy", [])
	var title := ""
	var body := ""
	match state:
		"offers", "not-available":
			title = "paywall.title"
			body = "paywall.notAvailable" if state == "not-available" else ""
		"purchasing":
			title = "paywall.purchasing"
		"restore":
			title = "paywall.restore"
		"purchased":
			title = "paywall.purchased"
		"loading":
			title = "common.loading" if copy.has("common.loading") else ""
	_product.refresh()
	cat_text(_title, title, args)
	cat_text(_body, body, args)
	var lines := "\n".join(includes) if state == "offers" and squeeze_level() < 1 else ""
	cat_text(_includes_head, "paywall.includes" if lines != "" else "", args)
	show_text(_includes_body, lines)
	var primary := PKeyPaywallController.primary_of(model)
	var busy := state in ["purchasing", "restore"]
	cat_text(_primary, primary, args)
	_primary.disabled = busy
	leaves_app(_primary, primary == "paywall.portal" and PKeyOutletAdapter.is_https(offers_url))
	var offers := state == "offers"
	cat_text(_redeem, "paywall.redeem" if offers and not redeem_requested.get_connections().is_empty() else "", args)
	cat_text(_restore, "paywall.restore" if offers and can_restore else "", args)
	set_loading(state == "loading" or busy)


func _arrange(m: Dictionary) -> void:
	_hint_bar.enabled = visible and (m["screen"] as Vector2).y >= PKeyHintBar.MIN_SCREEN_HEIGHT
	set_columns(_card, _side_by_side())
	_right.size_flags_vertical = Control.SIZE_EXPAND_FILL if phone_screen() else Control.SIZE_SHRINK_CENTER
	_actions.size_flags_horizontal = Control.SIZE_FILL
	super(m)


func _initial_focus() -> Control:
	return _primary if is_focusable(_primary) else (_redeem if is_focusable(_redeem) else null)


func _focus_chain() -> Array:
	return [_primary, _redeem, _restore]


func _on_primary() -> void:
	match PKeyPaywallController.action_of(PKeyPaywallController.primary_of(model)):
		PKeyPaywallController.ACTION_PURCHASE:
			purchase_requested.emit()
		PKeyPaywallController.ACTION_PORTAL:
			PKeyOutletAdapter.open_https(offers_url)
			portal_requested.emit()
		PKeyPaywallController.ACTION_DONE:
			done.emit()


func _cancel() -> bool:
	if visible and model.get("state") in ["offers", "not-available", "purchased"]:
		dismissed.emit()
		restore_opener()
		return true
	return false
