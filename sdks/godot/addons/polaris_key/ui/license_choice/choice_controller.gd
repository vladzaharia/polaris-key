class_name PKeyLicenseChoiceController
extends RefCounted
## PKeyLicenseChoice's headless logic (the port of the React kit's licenseRows and ui-core's
## `LicenseChoiceView`): the rows the license step offers, which one is selected, what a row says
## about itself, and the model input a view reads. No node and no SDK call here.
##
## `choices` is the sign-in session's LicenseChoiceView (plans/I-04.md): `{state, choices: [{id,
## tierName, name, origin, access, seats: {used, limit}, current, expiresAt, state: free | full,
## replace: {allowed}, freeDeviceUrl}], keep, create: {tierName}, preselected, getLicense:
## {activateUrl, purchaseUrl, keyEntry}}`.

const Models := preload("res://addons/polaris_key/ui/model/models.gd")

## The copy key a model copy key (the catalog's) is drawn with.
const COPY := {
	"signin.choice.title": "choice_title",
	"signin.choice.continue": "choice_continue",
	"signin.choice.keyInstead": "sign_in_use_key",
	"signin.choice.create": "choice_create",
	"signin.again": "choice_again",
	"signin.none.get": "choice_none_get",
	"signin.none.otherAccount": "choice_none_other",
	"signin.replace.open": "replace_open",
	"signin.replace.confirm": "replace_confirm",
}

## An origin's copy key; an origin with no word of its own (a purchase) says only the term.
const ORIGIN := {
	"store": "choice_origin_store",
	"key": "choice_origin_key_added",
	"free": "choice_origin_free",
	"developer": "choice_origin_developer",
	"signin": "choice_origin_sign_in",
}


## The entries of the list, in order: a new license (first sign-in), keep, each license, create.
## `{id, kind: license | keep | create | new, row?, selectable}`.
static func entries(ch: Dictionary, state: String) -> Array:
	var out: Array = []
	var create = ch.get("create")
	if ch.get("state") == "autoIssue" and create is Dictionary:
		out.append({"id": "new", "kind": "new", "tier": create.get("tierName"), "selectable": true})
	if ch.get("keep") == true:
		out.append({"id": "keep", "kind": "keep", "selectable": true})
	var rows = ch.get("choices")
	for r in (rows if rows is Array else []):
		if r is Dictionary:
			out.append({"id": r.get("id"), "kind": "license", "row": r, "selectable": r.get("state") == "free"})
	if create is Dictionary and ch.get("state") != "autoIssue" and state != "all-full":
		out.append({"id": "create", "kind": "create", "tier": create.get("tierName"), "selectable": true})
	return out


## The selected id: the wanted one when it can be chosen, else the first that can.
static func selected_id(list: Array, wanted: Variant) -> String:
	for e in list:
		if e["id"] == wanted and e["selectable"]:
			return String(e["id"])
	for e in list:
		if e["selectable"]:
			return String(e["id"])
	return ""


## The model input (ui-matrix.json `signIn` family) for a view of `choices`.
static func input(ch: Variant, selected: Variant = null, flags: Dictionary = {}, extra: Dictionary = {}) -> Dictionary:
	var sign_in := {"presentation": "inline", "replace": "inline", "channel": "browser", "outcome": "choose"}
	for k in flags:
		sign_in[k] = flags[k]
	var out := {"signIn": sign_in}
	if ch is Dictionary:
		out["choices"] = ch
	if selected != null and selected != "":
		out["selected"] = selected
	for k in extra:
		out[k] = extra[k]
	return out


static func view(inp: Dictionary) -> Dictionary:
	return Models.view_of("LicenseChoice", inp)


## The label of an action the model names by its catalog key ("" for a key this view has no button for).
static func label_key(model_key: Variant) -> String:
	return String(COPY.get(String(model_key), "")) if model_key != null else ""


## The meta line's origin and term words for a license row, as `[origin_key, origin_arg, term_key,
## term_arg]`: an origin that names someone it cannot name is left out, never drawn as "From {store}".
static func meta_parts(r: Dictionary, developer: String) -> Array:
	var origin_key := String(ORIGIN.get(String(r.get("origin", "")), ""))
	var origin_arg: Variant = null
	if origin_key == "choice_origin_developer":
		origin_arg = developer if developer != "" else null
		if origin_arg == null:
			origin_key = ""
	elif origin_key == "choice_origin_store":
		# The store's name is not in the view; "From a store" would be invented.
		origin_key = ""
	var exp = r.get("expiresAt")
	var term_key := "choice_term_lifetime" if exp == null else "choice_term_until"
	var term_arg: Variant = null if exp == null else date_text(float(exp))
	return [origin_key, origin_arg, term_key, term_arg]


## A date as a number the person reads in any language: "2027-01-01".
static func date_text(epoch: float) -> String:
	var d := Time.get_datetime_dict_from_unix_time(int(epoch))
	return "%04d-%02d-%02d" % [d["year"], d["month"], d["day"]]
