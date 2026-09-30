extends RefCounted
## What can be loaded from loose files in user:// without the import pipeline? Returns printable lines.
const L = preload("res://lib.gd")
const D := "user://loose/"

static func _t(lines: Array, name: String, f: Callable) -> void:
	var t := L.now_ms()
	var r = f.call()
	lines.append("%-46s %-58s %7.2f ms" % [name, str(r).left(58), L.now_ms() - t])

static func run(pack_for_scene := "") -> Array:
	var lines := []
	_t(lines, "JSON (FileAccess + JSON.parse_string)", func(): return JSON.parse_string(FileAccess.get_file_as_string(D + "level_005.json")).id)
	_t(lines, "PO via ResourceLoader.load -> Translation", func():
		var tr: Translation = ResourceLoader.load(D + "extra_fr.po")
		if tr == null: return "FAIL"
		TranslationServer.add_translation(tr)
		TranslationServer.set_locale("fr")
		return "%s msgs=%d tr('Extra 5')=%s" % [tr.locale, tr.get_message_count(), TranslationServer.translate("Extra 5")])
	_t(lines, "CSV parsed in GDScript -> Translation", func():
		var f := FileAccess.open(D + "strings.csv", FileAccess.READ)
		var hdr := f.get_csv_line()
		var trs := {}
		for i in range(1, hdr.size()):
			var t := Translation.new(); t.locale = hdr[i]; trs[hdr[i]] = t
		while not f.eof_reached():
			var row := f.get_csv_line()
			if row.size() < hdr.size(): continue
			for i in range(1, hdr.size()):
				trs[hdr[i]].add_message(row[0], row[i])
		for k in trs: TranslationServer.add_translation(trs[k])
		TranslationServer.set_locale("de")
		return "de STR_0401=%s" % TranslationServer.translate("STR_0401"))
	_t(lines, "exported .translation via ResourceLoader", func():
		var tr = ResourceLoader.load(D + "strings.fr.translation"); return "%s %s STR_0003=%s" % [tr.get_class(), tr.locale, tr.get_message("STR_0003")] if tr else "FAIL")
	_t(lines, "OGG: AudioStreamOggVorbis.load_from_file", func():
		var s := AudioStreamOggVorbis.load_from_file(D + "track_03.ogg"); return "len=%.2fs" % s.get_length() if s else "FAIL")
	_t(lines, "WAV: AudioStreamWAV.load_from_file", func():
		var s := AudioStreamWAV.load_from_file(D + "sfx_05.wav"); return "len=%.2fs fmt=%d" % [s.get_length(), s.format] if s else "FAIL")
	_t(lines, "PNG 1024: Image.load_from_file + ImageTexture", func():
		var img := Image.load_from_file(D + "t1024_03.png")
		if img == null: return "FAIL"
		var tex := ImageTexture.create_from_image(img); return "%dx%d fmt=%d" % [tex.get_width(), tex.get_height(), img.get_format()])
	_t(lines, "PNG 1024: + generate_mipmaps + compress(S3TC)", func():
		var img := Image.load_from_file(D + "t1024_03.png")
		img.generate_mipmaps()
		var e := img.compress(Image.COMPRESS_S3TC)
		return "err=%d compressed=%s fmt=%d" % [e, img.is_compressed(), img.get_format()])
	_t(lines, "PNG 1024: compress(BPTC)", func():
		var img := Image.load_from_file(D + "t1024_03.png")
		var e := img.compress(Image.COMPRESS_BPTC)
		return "err=%d compressed=%s" % [e, img.is_compressed()])
	_t(lines, "PNG 1024: compress(ETC2)", func():
		var img := Image.load_from_file(D + "t1024_03.png")
		var e := img.compress(Image.COMPRESS_ETC2)
		return "err=%d compressed=%s" % [e, img.is_compressed()])
	_t(lines, "TTF: FontFile.load_dynamic_font", func():
		var ff := FontFile.new(); var e := ff.load_dynamic_font(D + "DMMono-Regular.ttf"); return "err=%d name=%s" % [e, ff.get_font_name()])
	_t(lines, "imported .s3tc.ctex via ResourceLoader", func():
		var t = ResourceLoader.load(D + "t1024_03.png-8a9ac9148b29bec6ecba01a56274bb69.s3tc.ctex"); return "%s %dx%d" % [t.get_class(), t.get_width(), t.get_height()] if t else "FAIL")
	_t(lines, "imported lossless .ctex via ResourceLoader", func():
		var t = ResourceLoader.load(D + "icon_010.png-052dcb5f7a591d230e7909a7f6ff454f.ctex"); return "%s %dx%d" % [t.get_class(), t.get_width(), t.get_height()] if t else "FAIL")
	_t(lines, "imported .oggvorbisstr via ResourceLoader", func():
		var s = ResourceLoader.load(D + "track_03.ogg-71ecf1a990ff2996400ed0aa28cb513a.oggvorbisstr"); return "%s len=%.2f" % [s.get_class(), s.get_length()] if s else "FAIL")
	_t(lines, "imported .sample via ResourceLoader", func():
		var s = ResourceLoader.load(D + "sfx_05.wav-abd88a8672e239f80bf95fd2b22be3a7.sample"); return "%s len=%.2f" % [s.get_class(), s.get_length()] if s else "FAIL")
	_t(lines, "imported .fontdata via ResourceLoader", func():
		var s = ResourceLoader.load(D + "DMMono-Regular.ttf-7c4030dab7a78f6b0d3f7fd4995822cb.fontdata"); return "%s %s" % [s.get_class(), s.get_font_name()] if s else "FAIL")
	_t(lines, "exported binary .res via ResourceLoader", func():
		var r = ResourceLoader.load(D + "export-c725813e342ee6d0f70302a5f849b8dd-table_02.res"); return "%s metas=%d" % [r.get_class(), r.get_meta_list().size()] if r else "FAIL")
	if pack_for_scene != "":
		ProjectSettings.load_resource_pack(pack_for_scene)
	_t(lines, "exported .scn (deps in res://) via ResourceLoader", func():
		var r = ResourceLoader.load(D + "export-cff30e6ea5c3d8366502a558617cc5d7-room_02.scn")
		if r == null: return "FAIL"
		var n: Node = r.instantiate(); var s := "%s children=%d tex0=%s" % [n.name, n.get_child_count(), n.get_child(0).texture != null]; n.free(); return s)
	return lines
