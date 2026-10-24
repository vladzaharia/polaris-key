"""SP-52b: the footprint breakdown behind measure-ios-footprint.sh.

  python3 -I footprint-report.py <out.json> <tag> <baseline-dir> <current-dir>

Each directory holds app.ipa and linkmap.txt. Writes footprint.json: per tree the compressed
bytes of every payload part, and the linked bytes per module (target) and per section from the
link map, plus the totals, the 25% target in bytes and the baseline-to-current delta.
"""

import collections
import json
import os
import re
import sys
import zipfile


def parts(ipa):
    """Compressed bytes (deflate stream + local header) per payload part."""
    groups = collections.Counter()
    with zipfile.ZipFile(ipa) as z:
        for i in z.infolist():
            if i.filename.endswith("/"):
                continue
            m = re.match(r"Payload/[^/]+\.app/(.*)", i.filename)
            rel = m.group(1) if m else i.filename
            if "/" not in rel:
                key = "binary" if rel == "SizeApp" else rel
            elif ".bundle/" in rel:
                bundle, rest = rel.split(".bundle/", 1)
                if ".lproj/" in rest:
                    key = bundle + ".bundle/*.lproj"
                elif rest.startswith("Brand/fonts/"):
                    key = bundle + ".bundle/Brand/fonts/" + os.path.basename(rest)
                else:
                    key = bundle + ".bundle/" + rest.split("/")[0]
            else:
                key = rel.split("/")[0]
            groups[key] += i.compress_size + 30 + len(i.filename)
    return dict(sorted(groups.items(), key=lambda kv: -kv[1]))


def module_of(path):
    m = re.match(r"(.*/)?([^/]+\.a)\(", path)
    if m:
        return m.group(2)
    base = os.path.basename(path)
    return re.sub(r"\.(o|tbd|dylib)$", "", base)


def linkmap(path):
    """Linked bytes per module and per section, from the symbol and section tables."""
    objs, sections, sizes = {}, collections.Counter(), collections.Counter()
    mode = None
    with open(path, errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith("# Object files:"):
                mode = "o"
            elif line.startswith("# Sections:"):
                mode = "s"
            elif line.startswith("# Symbols:"):
                mode = "y"
            elif line.startswith("# Dead Stripped"):
                break
            elif mode == "o":
                m = re.match(r"\[\s*(\d+)\]\s+(.*)", line)
                if m:
                    objs[int(m.group(1))] = m.group(2)
            elif mode == "s":
                m = re.match(r"0x[0-9A-Fa-f]+\s+0x([0-9A-Fa-f]+)\s+(\S+)\s+(\S+)", line)
                if m:
                    sections[m.group(2) + "," + m.group(3)] += int(m.group(1), 16)
            elif mode == "y":
                m = re.match(r"0x[0-9A-Fa-f]+\s+0x([0-9A-Fa-f]+)\s+\[\s*(\d+)\]", line)
                if m:
                    sizes[int(m.group(2))] += int(m.group(1), 16)
    modules = collections.Counter()
    for idx, n in sizes.items():
        modules[module_of(objs.get(idx, "unknown"))] += n
    def ordered(c):
        return dict(sorted(((k, v) for k, v in c.items() if v), key=lambda kv: -kv[1]))
    return ordered(modules), ordered(sections)


def tree(d):
    ipa = os.path.join(d, "app.ipa")
    modules, sections = linkmap(os.path.join(d, "linkmap.txt"))
    return {
        "ipaBytes": os.path.getsize(ipa),
        "parts": parts(ipa),
        "linkedBytesByModule": modules,
        "linkedBytesBySection": sections,
    }


def main(out, tag, base_dir, cur_dir):
    base, cur = tree(base_dir), tree(cur_dir)
    doc = {
        "baselineTag": tag,
        "targetBytes": base["ipaBytes"] * 75 // 100,
        "deltaBytes": cur["ipaBytes"] - base["ipaBytes"],
        "deltaPercent": round((cur["ipaBytes"] - base["ipaBytes"]) * 100 / base["ipaBytes"], 1),
        "baseline": base,
        "current": cur,
    }
    with open(out, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    for label, t in (("baseline", base), ("current", cur)):
        print(f"{label}: ipa {t['ipaBytes']:,} B")
        for k, v in list(t["parts"].items())[:6]:
            print(f"  part    {v:>10,}  {k}")
        for k, v in list(t["linkedBytesByModule"].items())[:8]:
            print(f"  linked  {v:>10,}  {k}")


if __name__ == "__main__":
    main(*sys.argv[1:5])
