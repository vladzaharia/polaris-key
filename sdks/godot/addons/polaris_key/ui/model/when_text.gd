extends RefCounted
## A moment as a short, worded phrase for "Saved {when}": a relative day and the time ("today, 10:42",
## "yesterday, 21:40"), else the short date with no year inside the current year ("Oct 30, 10:12"), and the
## year only for another year. Lower case inside a sentence. The same rule as the other kits' platform
## formatters (Intl, DateFormatter, java.time); Godot has none, so the nine launch locales' words live here.

## Per locale: today, yesterday, the 12 month names, and the date pattern. `{m}` the month name, `{d}` the day,
## `{n}` the month number, `{y}` the year.
const LOCALES := {
	"en": {"today": "today", "yesterday": "yesterday", "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], "date": "{m} {d}", "dated": "{m} {d}, {y}"},
	"de": {"today": "heute", "yesterday": "gestern", "months": ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."], "date": "{d}. {m}", "dated": "{d}. {m} {y}"},
	"es": {"today": "hoy", "yesterday": "ayer", "months": ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"], "date": "{d} {m}", "dated": "{d} {m} {y}"},
	"fr": {"today": "aujourd’hui", "yesterday": "hier", "months": ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."], "date": "{d} {m}", "dated": "{d} {m} {y}"},
	"it": {"today": "oggi", "yesterday": "ieri", "months": ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"], "date": "{d} {m}", "dated": "{d} {m} {y}"},
	"pt-BR": {"today": "hoje", "yesterday": "ontem", "months": ["jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."], "date": "{d} de {m}", "dated": "{d} de {m} de {y}"},
	"ja": {"today": "今日", "yesterday": "昨日", "months": [], "date": "{n}月{d}日", "dated": "{y}年{n}月{d}日"},
	"ko": {"today": "오늘", "yesterday": "어제", "months": [], "date": "{n}월 {d}일", "dated": "{y}년 {n}월 {d}일"},
	"zh-Hans": {"today": "今天", "yesterday": "昨天", "months": [], "date": "{n}月{d}日", "dated": "{y}年{n}月{d}日"},
}


## `saved_at` (epoch ms) worded for `locale` ("" resolves from `TranslationServer`); "" when it is not a number.
## `now_ms` (epoch ms, -1: the clock) and `bias_minutes` (the zone's offset, null: the system's) are for tests.
static func worded(saved_at: Variant, locale := "", now_ms := -1, bias_minutes: Variant = null) -> String:
	if not (saved_at is int or saved_at is float):
		return ""
	var loc: String = preload("res://addons/polaris_key/ui/model/copy_format.gd").resolve_locale(locale if locale != "" else TranslationServer.get_locale())
	var t: Dictionary = LOCALES.get(loc, LOCALES["en"])
	var bias: int = int(Time.get_time_zone_from_system()["bias"]) if bias_minutes == null else int(bias_minutes)
	var now_s: int = int(Time.get_unix_time_from_system()) if now_ms < 0 else now_ms / 1000
	var at_s := int(saved_at) / 1000
	var d := Time.get_datetime_dict_from_unix_time(at_s + bias * 60)
	var n := Time.get_datetime_dict_from_unix_time(now_s + bias * 60)
	var days_apart: int = int(floor((now_s + bias * 60) / 86400.0)) - int(floor((at_s + bias * 60) / 86400.0))
	var clock := "%02d:%02d" % [int(d["hour"]), int(d["minute"])]
	var day := ""
	if days_apart == 0:
		day = t["today"]
	elif days_apart == 1:
		day = t["yesterday"]
	else:
		var months: Array = t["months"]
		var m: String = months[int(d["month"]) - 1] if not months.is_empty() else ""
		day = String(t["date"] if int(d["year"]) == int(n["year"]) else t["dated"]).format({"m": m, "d": int(d["day"]), "n": int(d["month"]), "y": int(d["year"])})
	return "%s, %s" % [day, clock] if loc not in ["ja", "ko", "zh-Hans"] else "%s %s" % [day, clock]
