#!/usr/bin/env python3
"""
build-assets.py

Turns the CC0 source models into single-file .glb assets the browser can load
directly. Three things need doing to each one:

  1. Convert to glTF. Most of the good models are FBX, which needs an extra
     loader in the browser and is slower to parse.
  2. Fix the texture reference. Exporters bake in absolute paths from whatever
     machine the artist used - "C:\\Users\\Mike\\Desktop\\..." - which is a dead
     link everywhere else.
  3. Embed the texture in the file and shrink it. These are PS1-style models;
     a 512px texture is plenty, and one file per model means one request.

Run it from the project root with the source collection checked out:
    python3 tools/build-assets.py <path-to-retro3d-assets>
"""

import io
import json
import os
import struct
import subprocess
import sys
from PIL import Image

MAX_TEXTURE = 512          # PS1-style art gains nothing from more than this


# Which source files become which game assets.
# `texture` is the diffuse map the source ships alongside the mesh.
ASSETS = [
    # --- weapons (viewmodels) ---
    {"out": "weapon_rifle.glb",   "src": "Weapons/M4A1/M4A1.fbx",
     "texture": "Weapons/M4A1/M4A1Diffuse.png"},
    # The shotgun file also contains loose shells modelled off to one side,
    # which wreck the bounding box the client uses to fit the model.
    {"out": "weapon_shotgun.glb", "src": "Weapons/DoubleBarrelShotgun/DoubleBarrelShotgun.fbx",
     "texture": "Weapons/DoubleBarrelShotgun/DoubleBarrel.png", "drop": ["shell"]},
    {"out": "weapon_pistol.glb",  "src": "Weapons/low-poly-glock/glock.obj",
     "texture": "Weapons/low-poly-glock/glock.png"},

    # --- props ---
    {"out": "prop_barrel.glb",    "src": "Boxes_Barrels_Crates/barrel/barrel.glb",
     "texture": "Boxes_Barrels_Crates/barrel/barrel.jpeg"},
]

# The "You see Ivan" pack is a single FBX holding several guns. Each one is a
# separate node, so we can split them out.
# The "You see Ivan" pack is a single FBX holding several guns. The nodes are
# all called "Cube", but the materials are named properly, so split on those.
PACK_SPLITS = [
    {"out": "weapon_smg.glb", "src": "Weapons/Guns/You see Ivan Pack/weapon pack.fbx",
     "material": "ak47", "texture": "Weapons/Guns/You see Ivan Pack/textures/ak74.png"},
    {"out": "weapon_dmr.glb", "src": "Weapons/Guns/You see Ivan Pack/weapon pack.fbx",
     "material": "sniper", "texture": "Weapons/Guns/You see Ivan Pack/textures/sniper.png"},
]


def run_assimp(src, dst):
    r = subprocess.run(["assimp", "export", src, dst],
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(dst):
        raise RuntimeError(f"assimp failed on {src}: {r.stderr.strip()[:200]}")


def read_glb(path):
    data = open(path, "rb").read()
    if data[:4] != b"glTF":
        raise RuntimeError(f"{path} is not a GLB")
    json_len = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + json_len])
    rest = data[20 + json_len:]
    bin_data = b""
    if len(rest) >= 8:
        bin_len = struct.unpack("<I", rest[0:4])[0]
        if rest[4:8] == b"BIN\x00":
            bin_data = rest[8:8 + bin_len]
    return gltf, bytearray(bin_data)


def write_glb(path, gltf, bin_data):
    while len(bin_data) % 4:
        bin_data.append(0)
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    while len(json_bytes) % 4:
        json_bytes += b" "
    total = 12 + 8 + len(json_bytes) + (8 + len(bin_data) if bin_data else 0)
    with open(path, "wb") as f:
        f.write(b"glTF")
        f.write(struct.pack("<I", 2))
        f.write(struct.pack("<I", total))
        f.write(struct.pack("<I", len(json_bytes)))
        f.write(b"JSON")
        f.write(json_bytes)
        if bin_data:
            f.write(struct.pack("<I", len(bin_data)))
            f.write(b"BIN\x00")
            f.write(bytes(bin_data))


def shrink_texture(path):
    img = Image.open(path).convert("RGB")
    if max(img.size) > MAX_TEXTURE:
        scale = MAX_TEXTURE / max(img.size)
        img = img.resize((max(1, int(img.width * scale)),
                          max(1, int(img.height * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), img.size


def embed_texture(gltf, bin_data, png_bytes):
    """Put the PNG inside the GLB and point every image at it."""
    while len(bin_data) % 4:
        bin_data.append(0)
    offset = len(bin_data)
    bin_data.extend(png_bytes)

    gltf.setdefault("bufferViews", []).append({
        "buffer": 0, "byteOffset": offset, "byteLength": len(png_bytes)
    })
    view_index = len(gltf["bufferViews"]) - 1

    image = {"bufferView": view_index, "mimeType": "image/png"}
    gltf["images"] = [image]

    gltf.setdefault("samplers", [{"magFilter": 9729, "minFilter": 9987,
                                  "wrapS": 10497, "wrapT": 10497}])
    gltf["textures"] = [{"sampler": 0, "source": 0}]

    for mat in gltf.setdefault("materials", [{}]):
        pbr = mat.setdefault("pbrMetallicRoughness", {})
        pbr["baseColorTexture"] = {"index": 0}
        pbr.setdefault("baseColorFactor", [1, 1, 1, 1])
        pbr["metallicFactor"] = 0.0
        pbr["roughnessFactor"] = 0.85

    # The buffer has grown
    if gltf.get("buffers"):
        gltf["buffers"][0]["byteLength"] = len(bin_data)
        gltf["buffers"][0].pop("uri", None)
    else:
        gltf["buffers"] = [{"byteLength": len(bin_data)}]

    return bin_data


def keep_only_material(gltf, wanted):
    """Trim a multi-weapon pack down to the one gun we want.

    The nodes in these packs are all called "Cube", but the materials carry
    the real names ("sniper", "ak47", "shotgun"), so split on those.
    """
    wanted = wanted.lower()
    mats = {i: (m.get("name") or "").lower() for i, m in enumerate(gltf.get("materials", []))}
    match = [i for i, name in mats.items() if wanted in name]
    if not match:
        raise RuntimeError(f"no material matching '{wanted}' - have {list(mats.values())}")

    keep = []
    for i, n in enumerate(gltf.get("nodes", [])):
        if "mesh" not in n:
            continue
        prims = gltf["meshes"][n["mesh"]]["primitives"]
        if any(p.get("material") in match for p in prims):
            keep.append(i)
    if not keep:
        raise RuntimeError(f"material '{wanted}' is not used by any mesh")

    gltf.setdefault("scenes", [{"nodes": []}])[0]["nodes"] = keep
    # Only one material survives, and embed_texture rewrites index 0
    for i in keep:
        for p in gltf["meshes"][gltf["nodes"][i]["mesh"]]["primitives"]:
            p["material"] = 0
    gltf["materials"] = [gltf["materials"][match[0]]]
    return len(keep)


def drop_materials(gltf, needles):
    """Strip out every primitive whose material matches one of these names.

    Works on the mesh list rather than walking the scene graph, because these
    exporters nest everything under a RootNode and a shallow pass misses it.
    """
    needles = [n.lower() for n in needles]
    bad = {i for i, m in enumerate(gltf.get("materials", []))
           if any(n in (m.get("name") or "").lower() for n in needles)}
    if not bad:
        return 0
    removed = 0
    for mesh in gltf.get("meshes", []):
        before = len(mesh["primitives"])
        mesh["primitives"] = [p for p in mesh["primitives"] if p.get("material") not in bad]
        removed += before - len(mesh["primitives"])
    # Drop any mesh left with nothing in it, and the nodes pointing at it
    empty = {i for i, m in enumerate(gltf.get("meshes", [])) if not m["primitives"]}
    for n in gltf.get("nodes", []):
        if n.get("mesh") in empty:
            n.pop("mesh", None)
    return removed


def build(entry, root, outdir, split=None):
    src = os.path.join(root, entry["src"])
    if not os.path.exists(src):
        return f"SKIP  {entry['out']}  (source missing)"

    tmp = os.path.join("/tmp", "raw_" + entry["out"])
    if src.lower().endswith(".glb"):
        import shutil
        shutil.copy(src, tmp)
    else:
        run_assimp(src, tmp)

    gltf, bin_data = read_glb(tmp)

    note = ""
    if split:
        n = keep_only_material(gltf, split)
        note = f", kept {n} mesh(es) with material '{split}'"

    if entry.get("drop"):
        removed = drop_materials(gltf, entry["drop"])
        if removed:
            note += f", dropped {removed} node(s) ({', '.join(entry['drop'])})"

    tex = os.path.join(root, entry["texture"])
    if os.path.exists(tex):
        png, size = shrink_texture(tex)
        bin_data = embed_texture(gltf, bin_data, png)
        note += f", texture {size[0]}x{size[1]}"
    else:
        note += ", NO TEXTURE FOUND"

    gltf["asset"] = {"version": "2.0", "generator": "arena build-assets.py"}

    out = os.path.join(outdir, entry["out"])
    write_glb(out, gltf, bin_data)
    kb = os.path.getsize(out) / 1024
    return f"ok    {entry['out']}  {kb:.0f} KB{note}"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    root = sys.argv[1]
    outdir = os.path.join("public", "models")
    os.makedirs(outdir, exist_ok=True)

    for entry in ASSETS:
        try:
            print(build(entry, root, outdir))
        except Exception as e:
            print(f"FAIL  {entry['out']}  {e}")

    for entry in PACK_SPLITS:
        try:
            print(build(entry, root, outdir, split=entry["material"]))
        except Exception as e:
            print(f"FAIL  {entry['out']}  {e}")


if __name__ == "__main__":
    main()
