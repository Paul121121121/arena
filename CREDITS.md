# Asset credits

Every model in `public/models/` is CC0 (public domain). **No attribution is
legally required** - this file exists because crediting people who give work
away is the decent thing to do, and because future-you will want to know where
these came from.

Sourced via [awesome-cc0](https://github.com/madjin/awesome-cc0), from the
[Retro3D Graphics Collection](https://github.com/Miziziziz/Retro3DGraphicsCollection)
(mirrored at [M3-org/retro3d-assets](https://github.com/M3-org/retro3d-assets)).

| In game | Source model | Original |
|---|---|---|
| AR-15 viewmodel | M4A1 | Low-Poly M4A1, OpenGameArt |
| MP5-K viewmodel | AK-47 from the "You see Ivan" pack | [ace-x6, Modern Weapons PS1 Style](https://ace-x6.itch.io/modern-weapons-ps1-style) |
| M40 Scout viewmodel | Sniper from the same pack | ace-x6 |
| M870 viewmodel | Double Barrel Shotgun | Retro3D collection |
| P226 viewmodel | Low-poly Glock | Retro3D collection |
| Barrel prop | Barrel | [scoppio, forklift chain hook and barrel](https://scoppio.itch.io/forklift-chain-hook-and-barrel) |

The in-game names do not match the real models exactly - the MP5-K slot is
wearing an AK, for instance. Swapping in a closer model is a one-line change in
the manifest at the top of `public/assets.js`.

## Libraries

- [three.js](https://threejs.org) r128 - MIT. Vendored into `public/vendor/`
  rather than loaded from a CDN, so the game starts with no internet.

## Rebuilding the models

The `.glb` files are committed, so you do not need to do this. If you want to
swap a model or change a texture size:

```
git clone --depth 1 https://github.com/M3-org/retro3d-assets
python3 tools/build-assets.py retro3d-assets
```

Needs `assimp` (`apt install assimp-utils`) and Pillow (`pip install pillow`).
The script converts each source to glTF, repairs the texture path (exporters
bake in absolute paths from the artist's own machine), shrinks the texture to
512px, and packs everything into one self-contained `.glb`.
