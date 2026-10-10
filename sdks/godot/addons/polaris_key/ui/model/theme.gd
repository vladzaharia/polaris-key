extends RefCounted
## The one theme value of UI-KITS.md §3.1, resolved for a kit, and the `ProductIdentity` resolver
## of §1.2: the GDScript port of ui-core's `theme/index.ts` (same functions, same order). Colours
## come from the SDK's own brand port, never re-derived here: PKeyAccent (packages/brand's
## `resolveAccent`, `deriveAccent` and `contrastRatio`) and PKeyBrand (the generated tokens).
##
##   resolve_theme             preset, scheme, accent source, icon, density, motion, platform
##   theme_summary             the five fields ui-matrix.json's `theme` rows pin
##   resolve_kit_colors        the accent's roles through PKeyAccent for one scheme, on the brand's
##                             surfaces, so a product accent never gives an unreadable primary (DL13)
##   resolve_product_identity  integrator → presentation source → bundle → the icon's accent → ink
##
## Not ported: `watchProductIdentity` (the live kit re-resolves through
## PKeyUiTheme.use_presentation and PKeyPresentationSource.changed), and `resolveKitColors` on a
## host's own grounds (PKeyAccent resolves on the brand's surfaces only; under `native` the kit
## takes the game theme's own accent, PKeyUiTheme.neutral_with).
##
## Options, contexts and results are plain Dictionaries with the TS member names (`colorScheme`,
## `accentSource`, …); a member the TS leaves `undefined` is absent or null.

const View := preload("res://addons/polaris_key/ui/model/view.gd")


## UI-KITS.md §1.2 and §3.4. The name: the integrator's, the presentation's, the bundle's, the
## slug. The accent: an integrator's colour (or `core`) wins; under `native` the host's; then the
## presentation's; then the icon's; then ink, never violet. Godot and TV default to dark and to
## `spacious`; the terminal draws no icon.
##
##   options  {preset, colorScheme, accent, density, motion, ambient, product, poweredBy, platform}
##   ctx      {kit, presentation (null: none), bundle, platform, prefersDark, reducedMotion}
static func resolve_theme(options: Dictionary, ctx: Dictionary) -> Dictionary:
	var integrator := {}
	var product = options.get("product")
	if product is Dictionary:
		integrator = (product as Dictionary).duplicate()
	var wanted = options.get("accent")
	if wanted != null and not _is(wanted, "product") and not _is(wanted, "service"):
		integrator["accent"] = wanted
	var presentation = ctx.get("presentation")
	var p: Dictionary = presentation if presentation is Dictionary else {}
	var preset = View.first([options.get("preset"), "polaris-key"])
	var bundle = ctx.get("bundle")
	var b: Dictionary = bundle if bundle is Dictionary else {}
	var name = View.first([integrator.get("name"), p.get("name"), b.get("name"), b.get("slug"), ""])
	var has_icon := _is_true(integrator.get("icon")) or _is_true(p.get("icon"))
	var kit = ctx.get("kit")
	var icon := "none" if _is(kit, "terminal") else ("image" if has_icon else "monogram")
	var accent_source := "ink"
	if _is(integrator.get("accent"), "core"):
		accent_source = "core"
	elif integrator.get("accent") is String:
		accent_source = "integrator"
	elif _is(preset, "native"):
		accent_source = "host"
	elif p.get("accent") is String:
		accent_source = "product"
	elif has_icon:
		accent_source = "icon"
	var platform = ctx.get("platform")
	var plat: Dictionary = platform if platform is Dictionary else {}
	var tv_or_game := _is(kit, "godot") or _is(plat.get("formFactor"), "tv")
	var color_scheme = View.first([options.get("colorScheme"), "dark" if tv_or_game else "system"])
	var scheme = color_scheme
	if _is(color_scheme, "system"):
		scheme = "light" if ctx.get("prefersDark") is bool and ctx["prefersDark"] == false else "dark"
	var motion = View.first([options.get("motion"), "system"])
	var reduced := _is(motion, "none") or (_is(motion, "system") and View.truthy(ctx.get("reducedMotion"))) or _is(motion, "reduced")
	var wanted_platform = options.get("platform")
	return {
		"name": name,
		"accentSource": accent_source,
		"colorScheme": color_scheme,
		"icon": icon,
		"preset": preset,
		"scheme": scheme,
		"density": View.first([options.get("density"), "spacious" if tv_or_game else "comfortable"]),
		"motion": "reduced" if reduced else "full",
		"ambient": View.first([options.get("ambient"), not _is(preset, "native")]),
		"platform": wanted_platform if View.truthy(wanted_platform) and not _is(wanted_platform, "auto") else plat.get("os"),
	}


## The five fields ui-matrix.json's `theme` rows pin.
static func theme_summary(t: Dictionary) -> Dictionary:
	return {
		"name": t.get("name"),
		"accentSource": t.get("accentSource"),
		"colorScheme": t.get("colorScheme"),
		"icon": t.get("icon"),
		"preset": t.get("preset"),
	}


## One ui-matrix.json `theme` row's summary, exactly as ui-core's uiMatrix.test.ts builds it: the
## row's preset, colorScheme and integrator (as `product`) are the options; its kit, its
## presentation (`null` stays null; absent takes `vocabulary.defaults`), its bundle and its platform
## (absent or null take the defaults) are the context.
static func summary_for_row(input: Dictionary, defaults: Dictionary) -> Dictionary:
	var options := {}
	if input.has("preset"):
		options["preset"] = input["preset"]
	if input.has("colorScheme"):
		options["colorScheme"] = input["colorScheme"]
	if input.has("integrator"):
		options["product"] = input["integrator"]
	var ctx := {
		"kit": input.get("kit"),
		"presentation": input["presentation"] if input.has("presentation") else defaults.get("presentation"),
		"bundle": View.first([input.get("bundle"), defaults.get("bundle")]),
		"platform": View.first([input.get("platform"), defaults.get("platform")]),
	}
	return theme_summary(resolve_theme(options, ctx))


# ── Colours ──────────────────────────────────────────────────────────────────────────────────


## The brand's four surfaces of a scheme ("dark" or "light"), page first.
static func brand_grounds(scheme: String) -> Array:
	return PKeyAccent.surfaces(scheme == "dark")


## The colours a kit paints with the product's accent in one scheme (UI-KITS.md §3.3, DL13), for
## `accent` (a "#rrggbb", or null / "" for ink) through PKeyAccent.resolve on the brand's surfaces:
## {scheme, primary, onPrimary (>= 4.5:1 on primary), accentText (>= 4.5:1 on every ground),
## subtle, focus (>= 3:1 on every ground, never a fixed violet once a product accent is set),
## grounds}.
static func resolve_kit_colors(accent: Variant, scheme: String) -> Dictionary:
	var dark := scheme == "dark"
	var grounds := brand_grounds(scheme)
	var r: Dictionary = PKeyAccent.resolve(accent, dark) if accent is String and accent != "" else {}
	if r.is_empty():
		# Ink: `text-strong` fill, the page as its label (UI-KITS.md §1.2 "with no icon").
		var strong := _hex(PKeyBrand.Dark.TEXT_STRONG if dark else PKeyBrand.Light.TEXT_STRONG)
		return {
			"scheme": scheme,
			"primary": strong,
			"onPrimary": grounds[0],
			"accentText": strong,
			"subtle": grounds[3],
			"focus": strong,
			"grounds": grounds,
		}
	return {
		"scheme": scheme,
		"primary": r["solid"],
		"onPrimary": r["on"],
		"accentText": r["fg"],
		"subtle": r["subtle"],
		"focus": r["focus"],
		"grounds": grounds,
	}


## Every contrast promise of `colors`: [{pair, ratio, min}]. A test and a kit's dev check read it;
## a value under its minimum is a bug.
static func contrast_report(colors: Dictionary) -> Array:
	var out := [{
		"pair": "onPrimary on primary",
		"ratio": PKeyAccent.contrast(colors["onPrimary"], colors["primary"]),
		"min": PKeyAccent.TEXT,
	}]
	for g in colors["grounds"]:
		out.append({"pair": "primary on %s" % g, "ratio": PKeyAccent.contrast(colors["primary"], g), "min": PKeyAccent.UI})
		out.append({"pair": "accentText on %s" % g, "ratio": PKeyAccent.contrast(colors["accentText"], g), "min": PKeyAccent.TEXT})
		out.append({"pair": "focus on %s" % g, "ratio": PKeyAccent.contrast(colors["focus"], g), "min": PKeyAccent.UI})
	return out


## Polaris violet, only when the integrator asks for it (`accent: "core"`).
static func core_accent(scheme: String) -> String:
	return _hex(PKeyBrand.service_accent("core", scheme == "dark"))


# ── ProductIdentity ──────────────────────────────────────────────────────────────────────────


## UI-KITS.md §1.2's resolution, synchronously over what is known now: the integrator, then the
## presentation (`source.current()`), then the bundle; the accent from an explicit colour, `core`,
## the presentation's `accent` / `accentDark`, the colour derived from the icon's pixels, then ink.
##
##   o  {integrator, accent, preset, source (a PKeyPresentationSource or anything with current()),
##       bundle {slug, name, developer, iconRgba}, presentationIconRgba}
##
## Answers {name, shortName, developer, accentSource, accent {light, dark}, icon, deviceCodeUrl};
## an accent of null is ink (or the host's own, under `native`). A source whose `current()` is
## empty reads as no presentation (GDScript has no try: a source must not fail).
static func resolve_product_identity(o: Dictionary) -> Dictionary:
	var i: Dictionary = o["integrator"] if o.get("integrator") is Dictionary else {}
	var p := {}
	var source = o.get("source")
	if source is Object and (source as Object).has_method("current"):
		var current = source.current()
		if current is Dictionary:
			p = current
	var b: Dictionary = o["bundle"] if o.get("bundle") is Dictionary else {}
	var name = View.first([i.get("name"), p.get("name"), b.get("name"), b.get("slug"), ""])
	var developer = View.first([i.get("developer"), p.get("developerName"), b.get("developer")])
	var presentation_icon := p.has("icon")
	var icon := _is_true(i.get("icon")) or presentation_icon or b.has("iconRgba")
	var base := {
		"name": name,
		"shortName": i.get("shortName"),
		"developer": developer,
		"icon": icon,
		"deviceCodeUrl": i.get("deviceCodeUrl"),
	}
	var a = o.get("accent")
	var explicit = a if a != null and not _is(a, "product") and not _is(a, "service") else null
	var wanted = View.first([explicit, i.get("accent")])
	if _is(wanted, "core"):
		return _identity(base, "core", core_accent("light"), core_accent("dark"))
	var light = View.first([_strict_hex(wanted), null if View.truthy(explicit) else _strict_hex(i.get("accent"))])
	var dark = View.first([_strict_hex(explicit) if View.truthy(explicit) else _strict_hex(i.get("accentDark")), light])
	if light != null or dark != null:
		return _identity(base, "integrator", View.first([light, dark]), View.first([dark, light]))
	if _is(o.get("preset"), "native"):
		return _identity(base, "host", null, null)
	var pl = _strict_hex(p.get("accent"))
	var pd = _strict_hex(p.get("accentDark"))
	if pl != null or pd != null:
		# `accentDark` in the dark scheme when set (HA-11).
		return _identity(base, "product", View.first([pl, pd]), View.first([pd, pl]))
	var pixels = View.first([o.get("presentationIconRgba"), b.get("iconRgba")])
	if pixels is PackedByteArray or pixels is Array:
		var derived := PKeyAccent.derive(PackedByteArray(pixels))
		if derived != "":
			return _identity(base, "icon", derived, derived)
	elif presentation_icon:
		# The icon is known but not decoded yet: its accent arrives with its pixels.
		return _identity(base, "icon", null, null)
	return _identity(base, "ink", null, null)


## The accent to resolve for `scheme`, or null for ink (or the host's own, native).
static func accent_for(id: Dictionary, scheme: String) -> Variant:
	return id["accent"]["dark"] if scheme == "dark" else id["accent"]["light"]


# ── Helpers ──────────────────────────────────────────────────────────────────────────────────


static func _identity(base: Dictionary, source: String, light: Variant, dark: Variant) -> Dictionary:
	var out := base.duplicate()
	out["accentSource"] = source
	out["accent"] = {"light": light, "dark": dark}
	return out


## TS `v === s` for a string `s`, without GDScript's error on comparing a non-string to one.
static func _is(v: Variant, s: String) -> bool:
	return (v is String or v is StringName) and String(v) == s


## TS `v === true`: only the boolean true.
static func _is_true(v: Variant) -> bool:
	return v is bool and v


## A "#rrggbb" string lower-cased, else null (TS `hex()`: exactly six hex digits, never "#rgb").
static func _strict_hex(v: Variant) -> Variant:
	if not (v is String) or (v as String).length() != 7 or not (v as String).begins_with("#"):
		return null
	for c in (v as String).substr(1):
		if not "0123456789abcdefABCDEF".contains(c):
			return null
	return (v as String).to_lower()


static func _hex(c: Color) -> String:
	return "#" + c.to_html(false)
