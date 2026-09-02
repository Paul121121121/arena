#!/usr/bin/env python3
"""
build-sprites.py

Packs the layers we need out of the Universal LPC Spritesheet Generator into
one atlas per layer-option, so the browser fetches ~30 files instead of ~300.

LPC ships one PNG per animation. Each is a grid of 64x64 frames, four rows -
north, west, south, east - except `hurt`, which only has one. We stack the
animations we use into a single 832x832 sheet with a fixed layout, so the
client only needs one constant to find any frame:

    y   0..255   walk    9 frames
    y 256..511   slash   6 frames
    y 512..767   shoot  13 frames
    y 768..831   hurt    6 frames (one row)

Usage:  python3 tools/build-sprites.py <path-to-lpc-repo>
"""

import os
import sys
import json
from PIL import Image

FRAME = 64
COLS = 13
SHEET_W = FRAME * COLS          # 832
# Four semantic slots. What fills each one differs per layer, because LPC
# names its animations after the motion, not the purpose: a war axe has
# `attack_slash`, a spear has `thrust`, a bow has `shoot`, and the arming
# sword only ships `combat_idle`. Each entry below lists candidates in
# preference order and we take the first that exists.
BLOCKS = [                      # (slot, rows, y offset in frames)
    ("carry",  4, 0),
    ("attack", 4, 4),
    ("shoot",  4, 8),
    ("hurt",   1, 12),
]

CHARACTER_ANIMS = {
    "carry":  ["walk"],
    "attack": ["slash"],
    "shoot":  ["shoot"],
    "hurt":   ["hurt"],
}
SHEET_H = FRAME * 13            # 832

# Every layer we ship. `path` is a template; {anim} is filled per block.
# Layers are drawn in this order, so `z` decides what covers what.
LAYERS = [
    # --- bodies (3 skin tones) ---
    ("body_light",  "body/bodies/male/{anim}/light.png",  10),
    ("body_brown",  "body/bodies/male/{anim}/brown.png",  10),
    ("body_dark",   "body/bodies/male/{anim}/black.png",  10),

    # --- armour ---
    ("torso_chain", "torso/chainmail/male/{anim}/gray.png",         30),
    ("torso_plate", "torso/armour/plate/male/{anim}/steel.png",     30),
    ("torso_leather", "torso/armour/leather/male/{anim}/leather.png", 30),

    # --- hair ---
    ("hair_messy",  "hair/messy1/adult/{anim}/dark_brown.png",  40),
    ("hair_long",   "hair/long/adult/{anim}/dark_brown.png",    40),
    ("hair_bald",   None,                                       40),

    # --- team capes ---
    ("cape_red",    "cape/solid/male/{anim}/red.png",   20),
    ("cape_blue",   "cape/solid/male/{anim}/blue.png",  20),

    # --- wounds, drawn over everything ---
    ("wound_ribs",  "body/wound/{anim}/ribs.png",       60),
    ("wound_brain", "body/wound/{anim}/brain.png",      60),
    ("wound_eye",   "body/wound/{anim}/eye_left.png",   60),
]

# Weapons come in a foreground and a background piece (in front of / behind the
# character). File naming is inconsistent across weapon types, so each gets its
# own pair of templates and we take whichever exists.
WEAPONS = [
    ("sword",
     ["weapon/sword/arming/universal/fg/{anim}/steel.png",
      "weapon/sword/arming/universal/{anim}/fg.png"],
     ["weapon/sword/arming/universal/bg/{anim}/steel.png",
      "weapon/sword/arming/universal/{anim}/bg.png"],
     {"carry": ["walk"], "attack": ["combat_idle", "idle"],
      "shoot": ["combat_idle"], "hurt": ["hurt"]}),

    ("axe",
     ["weapon/blunt/waraxe/{anim}/waraxe.png"],
     ["weapon/blunt/waraxe/behind/{anim}/waraxe.png"],
     {"carry": ["walk"], "attack": ["attack_slash"],
      "shoot": ["attack_slash"], "hurt": ["hurt"]}),

    ("spear",
     ["weapon/polearm/spear/{anim}/foreground.png"],
     ["weapon/polearm/spear/{anim}/background.png"],
     {"carry": ["walk"], "attack": ["thrust"],
      "shoot": ["thrust"], "hurt": ["hurt"]}),

    ("bow",
     ["weapon/ranged/bow/recurve/universal/{anim}/foreground.png"],
     ["weapon/ranged/bow/recurve/universal/{anim}/background.png"],
     {"carry": ["shoot"], "attack": ["shoot"],
      "shoot": ["shoot"], "hurt": ["hurt"]}),

    ("crossbow",
     ["weapon/ranged/crossbow/{anim}/crossbow.png"],
     ["weapon/ranged/crossbow/background/{anim}/crossbow.png"],
     {"carry": ["walk"], "attack": ["thrust"],
      "shoot": ["thrust"], "hurt": ["walk"]}),
]


def first_existing(root, templates, anim):
    for t in templates:
        p = os.path.join(root, "spritesheets", t.format(anim=anim))
        if os.path.exists(p):
            return p
    return None


def pack(root, templates, anims=None):
    """Build one 832x832 atlas from the per-animation sheets.

    Not every layer has every animation - a sword has no `shoot`, a bow has no
    `slash`. Rather than leave those blocks empty (which would make the weapon
    disappear the moment you used it), any missing block is filled with the
    walk pose. The weapon then simply does not animate for that action, which
    is a far better failure than vanishing.
    """
    sheet = Image.new("RGBA", (SHEET_W, SHEET_H), (0, 0, 0, 0))
    anims = anims or CHARACTER_ANIMS
    have = {}
    for slot, rows, y_frames in BLOCKS:
        src = None
        for candidate in anims.get(slot, [slot]):
            src = first_existing(root, templates, candidate)
            if src:
                break
        if not src:
            continue
        img = Image.open(src).convert("RGBA")
        w = min(img.width, SHEET_W)
        h = min(img.height, rows * FRAME)
        crop = img.crop((0, 0, w, h))
        sheet.paste(crop, (0, y_frames * FRAME))
        have[slot] = crop

    found = len(have)
    filler = have.get("carry") or (list(have.values())[0] if have else None)
    filled = []
    if filler is not None:
        for slot, rows, y_frames in BLOCKS:
            if slot in have:
                continue
            # Repeat the first frame of each direction across the block
            for row in range(min(rows, filler.height // FRAME)):
                src_frame = filler.crop((0, row * FRAME, FRAME, (row + 1) * FRAME))
                for col in range(COLS):
                    sheet.paste(src_frame, (col * FRAME, (y_frames + row) * FRAME))
            filled.append(slot)
    return sheet, found, filled


def save(sheet, out_path):
    # Quantise to a palette: this is pixel art, it does not need 24-bit colour,
    # and it roughly halves the download.
    alpha = sheet.getchannel("A")
    quant = sheet.convert("RGB").quantize(colors=200, method=Image.MEDIANCUT)
    quant = quant.convert("RGBA")
    quant.putalpha(alpha)
    quant.save(out_path, format="PNG", optimize=True)
    return os.path.getsize(out_path) / 1024


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    root = sys.argv[1]
    outdir = os.path.join("public", "sprites")
    os.makedirs(outdir, exist_ok=True)

    manifest = {"frame": FRAME, "cols": COLS, "blocks": {}, "layers": {}, "weapons": {}}
    for slot, rows, y in BLOCKS:
        manifest["blocks"][slot] = {
            "row": y, "rows": rows,
            "frames": {"carry": 9, "attack": 6, "shoot": 13, "hurt": 6}[slot]}

    total = 0
    for name, template, z in LAYERS:
        if template is None:                    # e.g. "bald" is simply no layer
            manifest["layers"][name] = {"file": None, "z": z}
            print(f"ok    {name:16} (no sprite - intentionally empty)")
            continue
        sheet, found, filled = pack(root, [template])
        if not found:
            print(f"SKIP  {name:16} (no source files matched)")
            continue
        out = os.path.join(outdir, name + ".png")
        kb = save(sheet, out)
        total += kb
        manifest["layers"][name] = {"file": f"/sprites/{name}.png", "z": z}
        note = f"  filled: {','.join(filled)}" if filled else ""
        print(f"ok    {name:16} {kb:5.0f} KB  ({found}/4 animations){note}")

    for name, fg, bg, anims in WEAPONS:
        for suffix, templates, z in (("fg", fg, 50), ("bg", bg, 5)):
            sheet, found, filled = pack(root, templates, anims)
            if not found:
                print(f"SKIP  weapon_{name}_{suffix} (no source)")
                continue
            key = f"weapon_{name}_{suffix}"
            out = os.path.join(outdir, key + ".png")
            kb = save(sheet, out)
            total += kb
            manifest["weapons"].setdefault(name, {})[suffix] = {
                "file": f"/sprites/{key}.png", "z": z}
            note = f"  filled: {','.join(filled)}" if filled else ""
            print(f"ok    {key:16} {kb:5.0f} KB  ({found}/4){note}")

    with open(os.path.join(outdir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\ntotal {total/1024:.1f} MB across {len(os.listdir(outdir))} files")


if __name__ == "__main__":
    main()
