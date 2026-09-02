# Credits & Licenses

Castle Clash uses character and weapon art from the **Universal LPC Spritesheet
Generator** project. That art is **not public domain** - it is released under
Creative Commons Attribution-ShareAlike and the GPL. This project credits every
artist below and, because of ShareAlike, the sprite art in `public/sprites/`
carries the same licenses (see "What this means for you").

The 3D engine, game code, network code, bots, and level are original to this
project.

---

## Art assets (LPC)

All of the following are adapted from the LPC (Liberated Pixel Cup) asset
collection, via the Universal LPC Spritesheet Generator
(https://github.com/kibotu/Universal-LPC-Spritesheet-Character-Generator).

The sprite atlases in `public/sprites/` are composited and re-packed from these
sources by `tools/build-sprites.py`.

### Character bodies

- **Authors:** bluecarrot16,JaidynReiman,Benjamin K. Smith (BenCreating),Evert,Eliza Wyatt (ElizaWy),TheraHedwig,MuffinElZangano,Durrani,Johannes Sjölund (wulax),Stephen Challener (Redshrike)
  **License:** OGA-BY 3.0,CC-BY-SA 3.0,GPL 3.0
  https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles,https://opengameart.org/content/lpc-medieval-fantasy-character-sprites,https://opengameart.org/content/lpc-male-jumping-animation-by-durrani,https://opengameart.org/content/lpc-runcycle-and-diagonal-walkcycle,https://opengameart.org/content/lpc-revised-character-basics,https://opengameart.org/content/lpc-be-seated,https://opengameart.org/content/lpc-runcycle-for-male-muscular-and-pregnant-character-bases-with-modular-heads,https://opengameart.org/content/lpc-jump-expanded,https://opengameart.org/content/lpc-character-bases


### Wound overlays (ribs, brain, eye)

- **Authors:** Benjamin K. Smith (BenCreating),Sander Frenken (castelonia)
  **License:** CC-BY-SA 3.0,GPL 3.0
  https://opengameart.org/content/lpc-zombie

- **Authors:** JaidynReiman,Benjamin K. Smith (BenCreating),Sander Frenken (castelonia)
  **License:** CC-BY-SA 3.0,GPL 3.0
  https://opengameart.org/content/lpc-zombie


### Hair - long

- **Authors:** JaidynReiman,Manuel Riecke (MrBeast)
  **License:** CC-BY-SA 3.0,GPL 3.0
  https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles,https://opengameart.org/content/lpc-expanded-hair


### Hair - messy

- **Authors:** JaidynReiman,Manuel Riecke (MrBeast)
  **License:** CC-BY-SA 3.0,GPL 3.0
  https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles,https://opengameart.org/content/lpc-expanded-hair


### Leather armour

- **Authors:** Johannes Sjölund (wulax)
  **License:** OGA-BY 3.0,CC-BY-SA 3.0,GPL 3.0
  https://opengameart.org/content/lpc-medieval-fantasy-character-sprites,http://opengameart.org/content/lpc-clothing-updates


### Plate armour

- **Authors:** JaidynReiman, bluecarrot16, Michael Whitlock (bigbeargames), Johannes Sjölund (wulax)
  **License:** OGA-BY 3.0,CC-BY-SA 3.0,GPL 3.0
  https://opengameart.org/content/lpc-medieval-fantasy-character-sprites,https://opengameart.org/content/lpc-combat-armor-for-women


### Chainmail

- **Authors:** Johannes Sjölund (wulax)
  **License:** OGA-BY 3.0,CC-BY-SA 3.0,GPL 3.0
  https://opengameart.org/content/lpc-medieval-fantasy-character-sprites


### War axe

- **Authors:** Benjamin K. Smith (BenCreating),bluecarrot16,Sander Frenken (castelonia)
  **License:** CC-BY-SA 3.0,GPL 3.0
  https://opengameart.org/content/lpc-medieval-weapons


### Spear

- **Authors:** Pierre Vigier (pvigier),Johannes Sjölund (wulax),Inboxninja
  **License:** CC-BY-SA 3.0
  https://opengameart.org/content/lpc-medieval-fantasy-character-sprites,https://opengameart.org/content/lpc-spear-and-shovel-reworked


### Recurve bow

- **Authors:** Daniel Eddeland (daneeklu),gr3yh47,Johannes Sjölund (wulax),Pierre Vigier (pvigier)
  **License:** CC-BY-SA 3.0
  https://opengameart.org/content/lpc-weapons-two-bows-a-spear-and-a-trident,https://opengameart.org/content/lpc-walk-animations-for-bows


### Crossbow

- **Authors:** bluecarrot16,drjamgo@hotmail.com
  **License:** CC0
  https://opengameart.org/content/lpc-crossbow-final


### Arming sword

- **Authors:** ElizaWy; walk and down by JaidynReiman
  **License:** OGA-BY 3.0
  https://github.com/ElizaWy/LPC/tree/main/Characters/Props/Sword%2001%20-%20Arming%20Sword,https://opengameart.org/content/lpc-expanded-sit-run-jump-more


### Character shadow

- **Authors:** drjamgo@hotmail.com
  **License:** CC0
  https://opengameart.org/content/shadow-for-lpc-sprite

---

## What this means for you

The LPC art above is licensed under some combination of **CC-BY-SA 3.0**,
**GPL 3.0**, **OGA-BY 3.0**, and **CC0**, depending on the asset. The most
restrictive terms that apply to the combined sprite sheets are **CC-BY-SA 3.0**
and **GPL 3.0**. In practice, if you distribute or modify this game:

1. **Keep this credits file** with the art. Attribution is required for every
   CC-BY-SA, OGA-BY, and GPL asset.
2. **Share alike.** Modifications to the sprite art must be released under the
   same CC-BY-SA / GPL terms.
3. The **original code** in this repository (engine, server, client, bots,
   tests) is yours to use freely, but the bundled **art** carries the licenses
   above.

Full license texts:
- CC-BY-SA 3.0: https://creativecommons.org/licenses/by-sa/3.0/
- GPL 3.0: https://www.gnu.org/licenses/gpl-3.0.html
- OGA-BY 3.0: https://static.opengameart.org/OGA-BY-3.0.txt
- CC0: https://creativecommons.org/publicdomain/zero/1.0/

## Engine

- **three.js** (r128) - MIT License - https://threejs.org
  Vendored locally at `public/vendor/three.min.js` and `GLTFLoader.js`.

---

## Audio

### Music (`public/audio/music/`)
Background tracks, re-encoded to MP3 for streaming:

- **menu.mp3** - "So Happy With My 8 Bit Game" by djartmusic
- **battle1.mp3** - "Battle Time" by lesiakower
- **battle2.mp3** - "I Fear For My Soul" by brutaldesign
- **battle3.mp3** - "Arcade Rush" by kissan4
- **battle4.mp3** - "Return To The 8 Bit Past" by djartmusic

These were supplied for this project. If you distribute the game, verify each
track's license with its source (most such tracks are royalty-free with
attribution) and keep these credits.

### Sound effects (`public/audio/sfx/`)
From the **FreeSFX / GameSFX** retro sound library, converted to OGG. Used for
footsteps, jumps, melee swings, weapon hits, bow/crossbow release, blocks,
pickups, healing, deaths, flag events, captures, and match results. Keep the
library's own license terms with any redistribution.
