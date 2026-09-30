#!/usr/bin/env python3
"""Derive v2 from a copy of v1: ~6% of source files modified, a few added and removed."""
import json, os, random, sys
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(__file__))
import gen_project as G

P = sys.argv[1]
G.OUT = P
G.rng = np.random.default_rng(999)
random.seed(999)
j = lambda *a: os.path.join(P, *a)

def local_edit(rel, frac=0.12):
    im = Image.open(j(rel)); w, h = im.size
    s = int(w * frac)
    x, y = random.randint(0, w - s), random.randint(0, h - s)
    ImageDraw.Draw(im).ellipse([x, y, x + s, y + s], fill=(250, 20, 20) + ((255,) if im.mode == "RGBA" else ()))
    im.save(j(rel))

def global_tweak(rel):
    a = np.asarray(Image.open(j(rel))).astype(np.float32)
    a[..., :3] = np.clip(a[..., :3] * 1.05 + 3, 0, 255)
    Image.fromarray(a.astype(np.uint8)).save(j(rel))

changed = []
for rel in ["assets/tex1024/t1024_03.png", "assets/tex1024/t1024_07.png", "assets/tex512/t512_05.png", "assets/tex512/t512_17.png"]:
    local_edit(rel); changed.append(rel)
global_tweak("assets/tex2048/t2048_01.png"); changed.append("assets/tex2048/t2048_01.png")
for i in [10, 50, 90]:
    rel = f"assets/icons/icon_{i:03d}.png"; global_tweak(rel); changed.append(rel)
for i in [5, 17, 42, 77, 101]:
    rel = f"assets/data/level_{i:03d}.json"; d = json.load(open(j(rel)))
    d["difficulty"] = (d["difficulty"] % 10) + 1; d["spawns"][0]["hp"] += 17; d["loot"]["gold"] += 5
    json.dump(d, open(j(rel), "w"), indent=1); changed.append(rel)
G.music(j("assets/music/track_03.ogg"), 22); changed.append("assets/music/track_03.ogg")
for i in [5, 22]:
    G.sfx(j(f"assets/sfx/sfx_{i:02d}.wav"), 0.8); changed.append(f"assets/sfx/sfx_{i:02d}.wav")
import re
s = re.sub(r"roughness = [0-9.]+", "roughness = 0.123", open(j("assets/materials/mat_04.tres")).read())
open(j("assets/materials/mat_04.tres"), "w").write(s); changed.append("assets/materials/mat_04.tres")
s = open(j("assets/tables/table_02.tres")).read()
head, arr = s.split("PackedFloat32Array(", 1); arr, tail = arr.split(")", 1)
vals = arr.split(", ")
for k in random.sample(range(len(vals)), len(vals) // 20):
    vals[k] = f"{random.gauss(0, 1):.5f}"
open(j("assets/tables/table_02.tres"), "w").write(head + "PackedFloat32Array(" + ", ".join(vals) + ")" + tail); changed.append("assets/tables/table_02.tres")
rows = open(j("locale/strings.csv")).read().splitlines()
for k in [3, 150, 377]:
    rows[k + 1] = rows[k + 1].replace("English string", "Updated English string")
for k in range(400, 405):
    rows.append(f"STR_{k:04d},New string {k},Nouvelle chaine {k},Neuer Text {k}")
open(j("locale/strings.csv"), "w").write("\n".join(rows) + "\n"); changed.append("locale/strings.csv")
s = open(j("scenes/room_02.tscn")).read().replace("position = Vector2(40, 60)", "position = Vector2(44, 66)")
open(j("scenes/room_02.tscn"), "w").write(s); changed.append("scenes/room_02.tscn")
s = open(j("scripts/main.gd")).read().replace("VERSION := 1", "VERSION := 2")
open(j("scripts/main.gd"), "w").write(s); changed.append("scripts/main.gd")

added = []
for i in [110, 111]:
    rel = f"assets/icons/icon_{i:03d}.png"; G.write_tex(rel, 128, False); added.append(rel)
G.write_tex("assets/tex1024/t1024_14.png", 1024, True); added.append("assets/tex1024/t1024_14.png")
for i in [120, 121]:
    rel = f"assets/data/level_{i:03d}.json"; json.dump(G.level_json(i), open(j(rel), "w"), indent=1); added.append(rel)
G.music(j("assets/music/track_10.ogg"), 18); added.append("assets/music/track_10.ogg")

removed = ["assets/icons/icon_100.png", "assets/tex512/t512_39.png", "assets/data/level_119.json"]
for rel in removed:
    for p in [j(rel), j(rel + ".import")]:
        if os.path.exists(p):
            os.remove(p)
json.dump({"changed": changed, "added": added, "removed": removed}, open(j("..", "v2_changes.json"), "w"), indent=1)
print(len(changed), "changed", len(added), "added", len(removed), "removed")
