#!/usr/bin/env python3
"""Retargets the official iOS template's arm64 *device* libgodot.a to the arm64 *simulator* platform.

Godot 4.7.2's ios.zip ships an x86_64-only simulator slice, which cannot link for an arm64
simulator on Apple silicon. This patches LC_BUILD_VERSION's platform field in place (2 = iOS ->
7 = iOS simulator; same size, so no relayout; vtool refuses these objects for lack of header
padding) on every archive member and re-archives with libtool, so the same release engine code runs
natively in the simulator. Research-only: the simulator times the host CPU, not a phone.

usage: ios-sim-retarget.py <exported Xcode dir> (e.g. build/ios; the <name>.xcframework inside)
"""
import os, plistlib, shutil, struct, subprocess, sys, tempfile


def retarget(obj: bytearray) -> None:
    magic, _cpu, _sub, _ft, ncmds, _size, _flags, _res = struct.unpack_from("<IiiIIIII", obj, 0)
    assert magic == 0xFEEDFACF, "not a 64-bit Mach-O object"
    off, seen = 32, False
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", obj, off)
        if cmd == 0x32:  # LC_BUILD_VERSION: cmd, cmdsize, platform, minos, sdk, ntools
            assert struct.unpack_from("<I", obj, off + 8)[0] == 2, "expected platform 2 (iOS)"
            struct.pack_into("<I", obj, off + 8, 7)
            seen = True
        assert cmd != 0x25, "LC_VERSION_MIN_IPHONEOS needs a real rewrite"
        off += cmdsize
    assert seen, "no LC_BUILD_VERSION"

xdir = sys.argv[1]
fw = next(os.path.join(xdir, d) for d in os.listdir(xdir) if d.endswith(".xcframework") and not d.startswith(("libgodot_", "MoltenVK")))
dev = os.path.join(fw, "ios-arm64", "libgodot.a")
sim_dir = os.path.join(fw, "ios-arm64_x86_64-simulator")
tmp = tempfile.mkdtemp(prefix="s04-retarget-")
data = open(dev, "rb").read()
assert data[:8] == b"!<arch>\n", "not an ar archive"
off, n, members = 8, 0, []
while off < len(data):
    hdr = data[off : off + 60]
    name, size = hdr[:16].decode().strip(), int(hdr[48:58].decode().strip())
    body = data[off + 60 : off + 60 + size]
    if name.startswith("#1/"):  # BSD long name stored at the start of the body
        ln = int(name[3:])
        name, body = body[:ln].rstrip(b"\0").decode(), body[ln:]
    if not name.startswith("__.SYMDEF"):
        n += 1
        p = os.path.join(tmp, f"{n:05d}_{name}")
        obj = bytearray(body)
        retarget(obj)
        open(p, "wb").write(obj)
        members.append(p)
    off += 60 + size + (size & 1)
out = os.path.join(tmp, "libgodot.a")
subprocess.run(["libtool", "-static", "-no_warning_for_no_symbols", "-o", out, *members], check=True)
shutil.copy(out, os.path.join(sim_dir, "libgodot.a"))
info = os.path.join(fw, "Info.plist")
pl = plistlib.load(open(info, "rb"))
for lib in pl["AvailableLibraries"]:
    if lib.get("SupportedPlatformVariant") == "simulator":
        lib["SupportedArchitectures"] = ["arm64"]
plistlib.dump(pl, open(info, "wb"))
shutil.rmtree(tmp)
print(f"retargeted {len(members)} objects into {sim_dir}/libgodot.a (arm64 simulator)")
