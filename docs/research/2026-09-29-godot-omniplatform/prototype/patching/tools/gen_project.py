#!/usr/bin/env python3
"""Generate a synthetic but realistic Godot 4.7 project (v1) for patching experiments.

Mix: lossless-imported PNG icons, VRAM-compressed PNG textures (512/1024/2048, mipmaps),
OGG music, WAV sfx, JSON data, TTF fonts, .tres materials + data resources, .tscn scenes,
a translation CSV and a PO file, plus a couple of scripts (so the base pack has code).
"""
import json, math, os, random, shutil, sys
import numpy as np
from PIL import Image
import soundfile as sf

OUT = sys.argv[1]
SEED = int(sys.argv[2]) if len(sys.argv) > 2 else 1234
# Directory holding DMMono-Regular.ttf and IBMPlexSerif-Regular.ttf (both SIL OFL, from Google Fonts).
FONTS_DIR = os.environ.get("FONTS_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fonts")
rng = np.random.default_rng(SEED)
random.seed(SEED)

def mkd(p):
    os.makedirs(os.path.join(OUT, p), exist_ok=True)

def value_noise(size, octaves=5, base=4):
    img = np.zeros((size, size), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        n = base * (2 ** o)
        g = rng.random((n + 1, n + 1)).astype(np.float32)
        # bilinear upsample
        xs = np.linspace(0, n, size, endpoint=False)
        x0 = xs.astype(int); fx = (xs - x0)[None, :]; fy = (xs - x0)[:, None]
        a = g[np.ix_(x0, x0)]; b = g[np.ix_(x0, x0 + 1)]
        c = g[np.ix_(x0 + 1, x0)]; d = g[np.ix_(x0 + 1, x0 + 1)]
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
        img += amp * ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy)
        tot += amp; amp *= 0.5
    return img / tot

def texture(size, alpha=False, shapes=6):
    n = value_noise(size, octaves=min(7, int(math.log2(size)) - 2))
    c1 = rng.random(3) * 255; c2 = rng.random(3) * 255
    rgb = (c1[None, None, :] * (1 - n[..., None]) + c2[None, None, :] * n[..., None])
    im = Image.fromarray(rgb.clip(0, 255).astype(np.uint8), "RGB")
    from PIL import ImageDraw
    dr = ImageDraw.Draw(im)
    for _ in range(shapes):
        x, y = rng.integers(0, size, 2); r = int(rng.integers(size // 16, size // 4))
        col = tuple(int(v) for v in rng.integers(0, 255, 3))
        if rng.random() < 0.5:
            dr.ellipse([x - r, y - r, x + r, y + r], fill=col)
        else:
            dr.rectangle([x - r, y - r // 2, x + r, y + r // 2], fill=col)
    if alpha:
        a = (value_noise(size, 3) * 255).astype(np.uint8)
        im.putalpha(Image.fromarray(a))
    return im

VRAM_IMPORT = """[remap]

importer="texture"
type="CompressedTexture2D"

[params]

compress/mode=2
mipmaps/generate=true
detect_3d/compress_to=0
"""

def write_tex(rel, size, vram, alpha=False):
    p = os.path.join(OUT, rel)
    texture(size, alpha).save(p, optimize=False, compress_level=6)
    if vram:
        with open(p + ".import", "w") as f:
            f.write(VRAM_IMPORT)

def music(path, seconds, sr=44100):
    t = np.arange(int(seconds * sr)) / sr
    root = 110 * 2 ** (rng.integers(0, 12) / 12)
    sig = np.zeros_like(t)
    beat = 60 / rng.integers(80, 140)
    for i, ratio in enumerate([1, 1.25, 1.5, 2, 3]):
        env = 0.5 + 0.5 * np.sin(2 * np.pi * t / (beat * (i + 2)))
        sig += env * np.sin(2 * np.pi * root * ratio * t) / (i + 1)
    sig += 0.05 * rng.standard_normal(len(t)) * (np.sin(2 * np.pi * t / beat) > 0.9)
    sig = 0.3 * sig / np.abs(sig).max()
    st = np.stack([sig, np.roll(sig, 300)], 1).astype(np.float32)
    sf.write(path, st, sr, format="OGG", subtype="VORBIS")

def sfx(path, seconds, sr=22050):
    t = np.arange(int(seconds * sr)) / sr
    f0 = rng.integers(200, 1200)
    sig = np.sin(2 * np.pi * f0 * t * (1 - 0.5 * t / seconds)) * np.exp(-4 * t / seconds)
    sig += 0.2 * rng.standard_normal(len(t)) * np.exp(-10 * t / seconds)
    sf.write(path, (0.5 * sig / np.abs(sig).max()).astype(np.float32), sr, format="WAV", subtype="PCM_16")

def level_json(i):
    r = random.Random(i)
    return {
        "id": f"level_{i:03d}", "name": f"Level {i}", "biome": r.choice(["forest", "cave", "desert", "snow", "magma"]),
        "difficulty": r.randint(1, 10), "seed": r.randint(0, 2**31),
        "spawns": [{"enemy": r.choice(["orc", "slime", "bat", "golem"]), "x": r.uniform(-50, 50), "y": r.uniform(-50, 50),
                     "wave": r.randint(1, 5), "hp": r.randint(10, 200)} for _ in range(r.randint(20, 400))],
        "tiles": [[r.randint(0, 15) for _ in range(32)] for _ in range(r.randint(8, 64))],
        "loot": {k: r.randint(0, 99) for k in ["gold", "gems", "keys", "potions", "scrolls"]},
    }

def uid(tag):
    r = random.Random(tag)
    return "uid://" + "".join(r.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))

def tres_material(i):
    c = rng.random(3)
    return f"""[gd_resource type="StandardMaterial3D" format=3 uid="{uid(f'mat{i}')}"]

[resource]
resource_name = "mat_{i}"
albedo_color = Color({c[0]:.4f}, {c[1]:.4f}, {c[2]:.4f}, 1)
metallic = {rng.random():.3f}
roughness = {rng.random():.3f}
emission_enabled = {str(rng.random() < 0.3).lower()}
"""

def tres_curve_data(i, n=20000):
    vals = ", ".join(f"{v:.5f}" for v in rng.standard_normal(n))
    return f"""[gd_resource type="Resource" format=3 uid="{uid(f'table{i}')}"]

[resource]
metadata/table_{i} = PackedFloat32Array({vals})
metadata/name = "table_{i}"
"""

def tscn(i, tex_paths):
    subs = "\n".join(f'[ext_resource type="Texture2D" path="res://{p}" id="{k+1}"]' for k, p in enumerate(tex_paths))
    nodes = "\n".join(f'[node name="S{k}" type="Sprite2D" parent="." unique_id={1000*(i+1)+k+1}]\nposition = Vector2({k*40}, {i*30})\ntexture = ExtResource("{k+1}")\n' for k in range(len(tex_paths)))
    return f"""[gd_scene format=3 uid="{uid(f'room{i}')}"]

{subs}

[node name="Room{i}" type="Node2D" unique_id={1000*(i+1)}]

{nodes}"""

def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    for d in ["assets/icons", "assets/tex512", "assets/tex1024", "assets/tex2048", "assets/music", "assets/sfx",
              "assets/data", "assets/fonts", "assets/materials", "assets/tables", "scenes", "locale", "scripts"]:
        mkd(d)
    # project + preset
    open(os.path.join(OUT, "project.godot"), "w").write("""config_version=5

[application]

config/name="patchlab"
run/main_scene="res://scenes/main.tscn"

[internationalization]

locale/translations=PackedStringArray("res://locale/strings.en.translation", "res://locale/strings.fr.translation", "res://locale/strings.de.translation", "res://locale/extra_fr.po")
""")
    icons = []
    for i in range(110):
        rel = f"assets/icons/icon_{i:03d}.png"; write_tex(rel, random.choice([64, 128, 128, 256]), False, alpha=(i % 3 == 0)); icons.append(rel)
    for i in range(40):
        write_tex(f"assets/tex512/t512_{i:02d}.png", 512, True, alpha=(i % 4 == 0))
    for i in range(14):
        write_tex(f"assets/tex1024/t1024_{i:02d}.png", 1024, True, alpha=(i % 5 == 0))
    for i in range(3):
        write_tex(f"assets/tex2048/t2048_{i:02d}.png", 2048, True)
    for i in range(10):
        music(os.path.join(OUT, f"assets/music/track_{i:02d}.ogg"), random.uniform(15, 35))
    for i in range(40):
        sfx(os.path.join(OUT, f"assets/sfx/sfx_{i:02d}.wav"), random.uniform(0.3, 1.5))
    for i in range(120):
        json.dump(level_json(i), open(os.path.join(OUT, f"assets/data/level_{i:03d}.json"), "w"), indent=1)
    for i, fn in enumerate(["DMMono-Regular.ttf", "IBMPlexSerif-Regular.ttf"]):
        shutil.copy(os.path.join(FONTS_DIR, fn), os.path.join(OUT, "assets/fonts", fn))
    for i in range(12):
        open(os.path.join(OUT, f"assets/materials/mat_{i:02d}.tres"), "w").write(tres_material(i))
    for i in range(6):
        open(os.path.join(OUT, f"assets/tables/table_{i:02d}.tres"), "w").write(tres_curve_data(i))
    for i in range(6):
        open(os.path.join(OUT, f"scenes/room_{i:02d}.tscn"), "w").write(tscn(i, icons[i * 5:(i + 1) * 5]))
    open(os.path.join(OUT, "scenes/main.tscn"), "w").write("""[gd_scene format=3 uid="uid://bmainscene001"]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]

[node name="Main" type="Node" unique_id=1]
script = ExtResource("1")
""")
    open(os.path.join(OUT, "scripts/main.gd"), "w").write("extends Node\n\nconst VERSION := 1\n\nfunc _ready() -> void:\n\tprint(\"patchlab v\", VERSION)\n")
    open(os.path.join(OUT, "scripts/util.gd"), "w").write("class_name PatchUtil\nextends RefCounted\n\nstatic func double(x: int) -> int:\n\treturn x * 2\n")
    # translations
    rows = ["keys,en,fr,de"]
    for i in range(400):
        rows.append(f"STR_{i:04d},English string {i},Chaine francaise {i},Deutscher Text {i}")
    open(os.path.join(OUT, "locale/strings.csv"), "w").write("\n".join(rows) + "\n")
    po = ['msgid ""', 'msgstr ""', '"Language: fr\\n"', '"Content-Type: text/plain; charset=UTF-8\\n"', ""]
    for i in range(200):
        po += [f'msgid "Extra {i}"', f'msgstr "Supplement {i}"', ""]
    open(os.path.join(OUT, "locale/extra_fr.po"), "w").write("\n".join(po))
    # export presets (pck base, patch w/o delta, patch with delta, zip)
    open(os.path.join(OUT, "export_presets.cfg"), "w").write(PRESETS)

PRESET_T = """[preset.{n}]

name="{name}"
platform="Linux"
runnable={runnable}
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter="*.json"
exclude_filter=""
export_path="build/{name}.pck"
patches=PackedStringArray()
patch_delta_encoding={delta}
patch_delta_compression_level_zstd=19
patch_delta_min_reduction=0.1
patch_delta_include_filters="*"
patch_delta_exclude_filters=""
encryption_include_filters=""
encryption_exclude_filters=""
seed=0
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.{n}.options]

binary_format/embed_pck=false
binary_format/architecture="x86_64"
texture_format/s3tc_bptc=true
texture_format/etc2_astc=false
"""
PRESETS = PRESET_T.format(n=0, name="Linux", runnable="true", delta="false") + "\n" + PRESET_T.format(n=1, name="LinuxDelta", runnable="false", delta="true")

if __name__ == "__main__":
    main()
